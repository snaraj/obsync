//! Ciphertext-only portable exports. Format: `docs/export.md`.
#![forbid(unsafe_code)]

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{Posture, Store, StoreError, load_or_create_server_key};
use crate::types::{DomainId, FileId, Seq, Sid};
use obsync_core::json::{self, Value};
use obsync_core::sha256::{Sha256, sha256};
use obsync_core::{base64, hex};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MAGIC: &[u8] = b"OBSYNC-EXPORT-1\n";
const INDEX_MAX: usize = 64 * 1024 * 1024;

/// Counts for the verified selection; missing chunks prevent publication.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExportReport {
    /// Selected file identities, including control records and deletions.
    pub files: u64,
    /// Selected versions.
    pub versions: u64,
    /// Unique ciphertext chunks copied.
    pub chunks: u64,
    /// Ciphertext bytes copied.
    pub bytes: u64,
    /// Required chunks that could not be opened.
    pub missing: Vec<Sid>,
}
impl ExportReport {
    /// A missing chunk never produces a published archive.
    pub fn ok(&self) -> bool {
        self.missing.is_empty()
    }
    /// An unkeyed digest proves integrity only, never completeness.
    pub fn print(&self) {
        println!(
            "files: {} versions: {} chunks: {} bytes: {}",
            self.files, self.versions, self.chunks, self.bytes
        );
        for sid in &self.missing {
            println!("missing chunk: {sid}");
        }
        println!("content: ciphertext; completeness and freshness: not authenticated by a device");
        println!(
            "result: {}",
            if self.ok() {
                "ok"
            } else {
                "FAILED; no archive published"
            }
        );
    }
}

/// Export all current heads, or all retained versions when explicitly requested.
/// Opening the store holds its existing exclusive offline lock throughout.
pub fn run(
    cfg: &Config,
    domain: &DomainId,
    out: &Path,
    history: bool,
) -> Result<ExportReport, StoreError> {
    let log = Log::new(cfg.log_level);
    let storage = cfg.storage();
    let posture = Posture::enforce(&storage, &log)?;
    let server_key =
        load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, &log)?;
    let store = Store::open(&storage, server_key, &posture, log.clone())?;
    if !store.domain_exists(domain) {
        return Err(StoreError::UnknownDomain);
    }
    let started = log.start("export", INDEX_MAX as u64);
    let result = write_archive(&store, domain, out, history);
    started.summary(
        &log,
        &[
            (
                "decision",
                Val::word(match &result {
                    Ok(report) if report.ok() => "ok",
                    _ => "refused",
                }),
            ),
            ("payload", Val::word("ciphertext")),
            ("index_budget", Val::bytes(INDEX_MAX as u64)),
        ],
    );
    result
}

fn write_archive(
    store: &Store,
    domain: &DomainId,
    out: &Path,
    history: bool,
) -> Result<ExportReport, StoreError> {
    if out.symlink_metadata().is_ok() {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists).into());
    }
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut report = ExportReport::default();
    let mut files: BTreeMap<FileId, (Value, Vec<Value>)> = BTreeMap::new();
    let mut chunks = BTreeSet::new();
    let snapshot = store.head_seq();
    if snapshot.0 > 9_007_199_254_740_991 {
        return Err(io::Error::other("export sequence exceeds exact integer range").into());
    }
    let mut since = Seq(0);
    let mut metadata_bytes = 0;
    while since < snapshot {
        let page = store.changes(since, 256)?;
        for change in page.changes {
            let v = change.version;
            if v.domain_id != *domain || (!history && !change.heads.contains(&v.version_id)) {
                continue;
            }
            if v.bytes > 9_007_199_254_740_991 {
                return Err(io::Error::other("export size exceeds exact integer range").into());
            }
            let version = json::obj(vec![
                ("version_id", Value::Str(v.version_id.to_string())),
                (
                    "parents",
                    Value::Array(
                        v.parents
                            .iter()
                            .map(|p| Value::Str(p.to_string()))
                            .collect(),
                    ),
                ),
                (
                    "sids",
                    Value::Array(v.sids.iter().map(|s| Value::Str(s.to_string())).collect()),
                ),
                ("bytes", Value::Int(v.bytes as i64)),
                ("manifest_ct", Value::Str(base64::encode(&v.manifest_ct))),
                ("manifest_nonce", Value::Str(hex::encode(&v.manifest_nonce))),
                ("deleted", Value::Bool(v.deleted)),
            ]);
            metadata_bytes += version.to_json().len()
                + if files.contains_key(&v.file_id) {
                    1
                } else {
                    change.heads.len() * 67 + 150
                };
            if metadata_bytes > INDEX_MAX {
                return Err(io::Error::other("export metadata budget exceeded (64 MiB)").into());
            }
            chunks.extend(v.sids);
            let heads = Value::Array(
                change
                    .heads
                    .iter()
                    .map(|h| Value::Str(h.to_string()))
                    .collect(),
            );
            files
                .entry(v.file_id)
                .or_insert_with(|| (heads, Vec::new()))
                .1
                .push(version);
            report.versions += 1;
        }
        since = page.seq;
    }
    report.files = files.len() as u64;
    let index = json::obj(vec![
        ("v", Value::Int(1)),
        ("source", Value::Str("server".into())),
        (
            "scope",
            Value::Str(if history { "history" } else { "current" }.into()),
        ),
        ("snapshot", Value::Int(snapshot.0 as i64)),
        (
            "files",
            Value::Array(
                files
                    .into_iter()
                    .map(|(id, (heads, versions))| {
                        json::obj(vec![
                            ("file_id", Value::Str(id.to_string())),
                            ("domain_id", Value::Str(domain.to_string())),
                            ("heads", heads),
                            ("versions", Value::Array(versions)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
    .to_json();
    if index.len() > INDEX_MAX {
        return Err(io::Error::other("export metadata budget exceeded (64 MiB)").into());
    }
    // Kernel randomness names only this attempt; create_new is the ownership proof.
    let mut random = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let temporary = parent.join(format!(".obsync-export-{}", hex::encode(&random)));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(MAGIC)?;
        file.write_all(&(index.len() as u32).to_be_bytes())?;
        file.write_all(index.as_bytes())?;
        file.write_all(&sha256(index.as_bytes()))?;
        file.write_all(&[0u8; 32])?; // No device authenticator: this process has no content key.
        let mut buffer = [0u8; 64 * 1024];
        for sid in chunks {
            let (mut chunk, size) = match store.open_chunk(&sid) {
                Ok(chunk) => chunk,
                Err(StoreError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
                    report.missing.push(sid);
                    return Ok(report);
                }
                Err(e) => return Err(e),
            };
            if size > 8 * 1024 * 1024 + 16 {
                return Err(io::Error::other("export chunk exceeds protocol bound").into());
            }
            file.write_all(&(size as u32).to_be_bytes())?;
            let mut hash = Sha256::new();
            let mut copied = 0;
            loop {
                let n = chunk.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                copied += n as u64;
                if copied > size {
                    return Err(io::Error::other("export chunk changed").into());
                }
                hash.update(&buffer[..n]);
                file.write_all(&buffer[..n])?;
            }
            let actual = Sid::new(hash.finalize());
            if copied != size {
                return Err(StoreError::LengthMismatch {
                    declared: size,
                    actual: copied,
                });
            }
            if actual != sid {
                return Err(StoreError::SidMismatch {
                    expected: sid,
                    actual,
                });
            }
            report.chunks += 1;
            report.bytes += size;
        }
        file.sync_all()?;
        fs::hard_link(&temporary, out)?; // Never replaces an existing name.
        if let Err(error) = File::open(parent).and_then(|dir| dir.sync_all()) {
            fs::remove_file(out)?;
            return Err(error.into());
        }
        Ok(report)
    })();
    drop(file);
    fs::remove_file(&temporary)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::log::LogLevel;
    use crate::storage::testutil::TempDir;
    use crate::storage::types::{DeviceState, NewDevice, NewVersion};
    use crate::storage::version_id_of;
    use crate::types::FileId;
    use obsync_core::sha256::sha256;

    const ONE: DomainId = DomainId::new([0xd1; 16]);
    const TWO: DomainId = DomainId::new([0xd2; 16]);
    const ABSENT: DomainId = DomainId::new([0xd3; 16]);

    fn config(dir: &TempDir) -> Config {
        Config {
            blobs_dir: dir.path().join("blobs"),
            journal_dir: dir.path().join("journal"),
            server_key: Some([9u8; 32]),
            log_level: LogLevel::Error,
            ..Config::default()
        }
    }

    /// Two files, one per domain, each with one chunk.
    fn seed(cfg: &Config) -> (FileId, FileId) {
        let log = Log::new(LogLevel::Error);
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, &log).expect("volume posture");
        let store = Store::open(&storage, [9u8; 32], &posture, log).expect("store opens");
        let account = store.setup("sentinel account").expect("setup");
        let device = store
            .create_device(NewDevice {
                account_id: account,
                name: "sentinel device".to_string(),
                platform: "linux".to_string(),
                app_version: "0.1.0".to_string(),
                secret: [3u8; 32],
                state: DeviceState::Active,
            })
            .expect("device pairs")
            .device_id;
        let mut ids = Vec::new();
        for (n, domain) in [(1u8, ONE), (2u8, TWO)] {
            let body = format!("sentinel-ciphertext-{n}").into_bytes();
            let sid = Sid::new(sha256(&body));
            store
                .put_chunk(&account, &sid, body.len() as u64, &mut &body[..])
                .expect("chunk lands");
            let file_id = FileId::new([n; 16]);
            let manifest = format!("sentinel-manifest-{n}").into_bytes();
            store
                .append_version(NewVersion {
                    account_id: account,
                    file_id,
                    domain_id: domain,
                    version_id: version_id_of(&file_id, &[], &manifest, &[sid]),
                    parents: Vec::new(),
                    sids: vec![sid],
                    bytes: body.len() as u64,
                    manifest_ct: manifest,
                    manifest_nonce: [1u8; 12],
                    device_id: device,
                    deleted: false,
                })
                .expect("version lands");
            ids.push(file_id);
        }
        (ids[0], ids[1])
    }

    /// `docs/architecture.md` 5.1 item 4 made useful before any recipient
    /// exists: the clear `domain_id` on a file record is what lets the server
    /// separate one domain's data from another's.
    #[test]
    fn an_export_writes_one_domain_and_leaves_the_other_where_it_is() {
        let dir = TempDir::new("export-domains");
        let cfg = config(&dir);
        let (first, second) = seed(&cfg);

        let out = dir.path().join("out-one");
        let report = run(&cfg, &ONE, &out, false).expect("export runs");
        assert_eq!(report.files, 1, "one file is in this domain");
        assert_eq!(report.versions, 1);
        assert!(report.missing.is_empty());
        let archive = fs::read(&out).expect("archive");
        assert!(archive.starts_with(MAGIC));
        let n =
            u32::from_be_bytes(archive[MAGIC.len()..MAGIC.len() + 4].try_into().unwrap()) as usize;
        let manifest = std::str::from_utf8(&archive[MAGIC.len() + 4..MAGIC.len() + 4 + n]).unwrap();
        assert_eq!(
            &archive[MAGIC.len() + 4 + n..MAGIC.len() + 4 + n + 32],
            &sha256(manifest.as_bytes())
        );
        assert_eq!(
            &archive[MAGIC.len() + 4 + n + 32..MAGIC.len() + 4 + n + 64],
            &[0u8; 32]
        );
        assert!(manifest.contains(&ONE.to_string()));
        assert!(manifest.contains(&first.to_string()));
        assert!(
            !manifest.contains(&second.to_string()),
            "and it is not listed either"
        );

        // The other domain exports its own file, and nothing else.
        let other = dir.path().join("out-two");
        let report = run(&cfg, &TWO, &other, false).expect("export runs");
        assert_eq!(report.files, 1);
        let bytes = fs::read(&other).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains(&second.to_string()));
        assert!(!text.contains(&first.to_string()));
        let before = fs::read(&out).unwrap();
        assert!(
            run(&cfg, &ONE, &out, false).is_err(),
            "cannot replace an archive"
        );
        assert_eq!(fs::read(&out).unwrap(), before);
    }

    #[test]
    fn a_domain_no_file_is_in_is_refused_before_anything_is_written() {
        let dir = TempDir::new("export-unknown-domain");
        let cfg = config(&dir);
        seed(&cfg);
        let out = dir.path().join("out");
        assert!(matches!(
            run(&cfg, &ABSENT, &out, false),
            Err(StoreError::UnknownDomain)
        ));
        assert!(!out.exists(), "a refused export creates no directory");
    }
    #[test]
    fn every_head_is_exported_and_history_is_explicit() {
        let dir = TempDir::new("export-heads");
        let cfg = config(&dir);
        let (id, _) = seed(&cfg);
        let log = Log::new(LogLevel::Error);
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, &log).unwrap();
        let store = Store::open(&storage, [9u8; 32], &posture, log).unwrap();
        let original = store.file(&id).unwrap().versions[0].clone();
        let account_id = store.account().unwrap().account_id;
        for n in [3u8, 4] {
            let body = vec![n; 32];
            let sid = Sid::new(sha256(&body));
            store
                .put_chunk(&account_id, &sid, 32, &mut &body[..])
                .unwrap();
            let manifest = vec![n; 32];
            let parents = vec![original.version_id];
            store
                .append_version(NewVersion {
                    account_id,
                    file_id: id,
                    domain_id: ONE,
                    version_id: version_id_of(&id, &parents, &manifest, &[sid]),
                    parents,
                    sids: vec![sid],
                    bytes: 16,
                    manifest_ct: manifest,
                    manifest_nonce: [n; 12],
                    device_id: original.device_id,
                    deleted: false,
                })
                .unwrap();
        }
        assert_eq!(store.file(&id).unwrap().heads.len(), 2);
        drop(store);
        let current = run(&cfg, &ONE, &dir.path().join("current"), false).unwrap();
        assert_eq!((current.files, current.versions, current.chunks), (1, 2, 2));
        let history = run(&cfg, &ONE, &dir.path().join("history"), true).unwrap();
        assert_eq!((history.files, history.versions, history.chunks), (1, 3, 3));
    }

    #[test]
    fn unavailable_or_changed_ciphertext_never_publishes() {
        for missing in [true, false] {
            let dir = TempDir::new("export-unavailable");
            let cfg = config(&dir);
            let (id, _) = seed(&cfg);
            let log = Log::new(LogLevel::Error);
            let storage = cfg.storage();
            let posture = Posture::enforce(&storage, &log).unwrap();
            let store = Store::open(&storage, [9u8; 32], &posture, log).unwrap();
            let sid = store.file(&id).unwrap().versions[0].sids[0];
            let path = store.chunk_path(&sid);
            drop(store);
            if missing {
                fs::remove_file(path).unwrap();
            } else {
                let mut ciphertext = fs::read(&path).unwrap();
                ciphertext[0] ^= 1;
                fs::write(path, ciphertext).unwrap();
            }
            let out = dir.path().join("refused");
            let result = run(&cfg, &ONE, &out, false);
            assert!(result.is_err() || !result.unwrap().ok());
            assert!(!out.exists());
            assert!(!fs::read_dir(dir.path()).unwrap().any(|e| {
                e.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".obsync-export-")
            }));
        }
    }
}
