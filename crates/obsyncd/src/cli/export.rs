//! `obsyncd export`: reconstruct a domain's data from the volumes.
//!
//! **What this does in v0.1, plainly.** It exports CIPHERTEXT. For each file
//! the store holds it writes `<out>/<file_id>.bin.enc`, the newest head's
//! chunks concatenated in order, plus `<out>/manifest.json` listing every
//! retained version with its sids and its encrypted manifest.
//!
//! It DOES filter by domain: a file record carries its domain in clear
//! (docs/architecture.md §5.1 item 4), so `--domain` exports that domain's
//! files and no others. Which PATHS a domain covers is still owner-only and
//! still invisible here; the server needs only the label.
//!
//! It does not write plaintext. That needs AES-256-GCM, which the server
//! deliberately does not implement (docs/architecture.md §3: "The server
//! performs no AES and no asymmetric operation in v1"). Plaintext export
//! lands with that primitive in a later version; until then the operator
//! decrypts the exported ciphertext on a device that holds the key, and the
//! `--key` argument is accepted so the command line does not change when
//! that lands.
#![forbid(unsafe_code)]

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use obsync_core::hex;
use obsync_core::json::{self, Value};

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{Posture, Store, StoreError, load_or_create_server_key};
use crate::types::{DomainId, Sid};

/// What one export wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportReport {
    /// Files written.
    pub files: u64,
    /// Versions listed in the manifest.
    pub versions: u64,
    /// Chunks assembled.
    pub chunks: u64,
    /// Ciphertext bytes written.
    pub bytes: u64,
    /// Chunks a version named that the volume no longer holds.
    pub missing: Vec<Sid>,
}

impl ExportReport {
    /// Print the counts for an operator.
    pub fn print(&self) {
        println!("files written:  {}", self.files);
        println!("versions:       {}", self.versions);
        println!("chunks:         {}", self.chunks);
        println!("bytes:          {}", self.bytes);
        println!("missing chunks: {}", self.missing.len());
        for sid in &self.missing {
            println!("  {sid}");
        }
        println!("content: ciphertext (plaintext export lands with AES-GCM)");
    }
}

/// Export every file's newest head as ciphertext, with a manifest beside it.
pub fn run(
    cfg: &Config,
    domain: &DomainId,
    key: &[u8; 32],
    out: &Path,
) -> Result<ExportReport, StoreError> {
    // Accepted so the command line is stable when decryption lands; the
    // server holds no AES implementation to use it with today.
    let _ = key;

    let log = Log::new(cfg.log_level);
    let storage = cfg.storage();
    let posture = Posture::enforce(&storage, &log)?;
    let server_key =
        load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, &log)?;
    let store = Store::open(&storage, server_key, &posture, log.clone())?;
    if !store.domain_exists(domain) {
        return Err(StoreError::UnknownDomain);
    }
    let started = log.start("export", storage.blobs_capacity);
    fs::create_dir_all(out)?;

    let mut report = ExportReport {
        files: 0,
        versions: 0,
        chunks: 0,
        bytes: 0,
        missing: Vec::new(),
    };
    let mut entries: Vec<Value> = Vec::new();
    let mut after = None;
    loop {
        let (page, next) = store.files_page(after.as_ref(), 256);
        if page.is_empty() {
            break;
        }
        for summary in page {
            if summary.domain_id != *domain {
                continue;
            }
            let Some(record) = store.file(&summary.file_id) else {
                continue;
            };
            let head = record
                .versions
                .iter()
                .find(|v| record.heads.contains(&v.version_id));
            let mut versions: Vec<Value> = Vec::new();
            for version in &record.versions {
                report.versions += 1;
                versions.push(json::obj(vec![
                    ("version_id", Value::Str(version.version_id.to_string())),
                    (
                        "sids",
                        Value::Array(
                            version
                                .sids
                                .iter()
                                .map(|sid| Value::Str(sid.to_string()))
                                .collect(),
                        ),
                    ),
                    ("bytes", Value::Int(version.bytes as i64)),
                    ("deleted", Value::Bool(version.deleted)),
                    ("manifest_ct", Value::Str(hex::encode(&version.manifest_ct))),
                    (
                        "manifest_nonce",
                        Value::Str(hex::encode(&version.manifest_nonce)),
                    ),
                ]));
            }
            entries.push(json::obj(vec![
                ("file_id", Value::Str(summary.file_id.to_string())),
                (
                    "heads",
                    Value::Array(
                        record
                            .heads
                            .iter()
                            .map(|id| Value::Str(id.to_string()))
                            .collect(),
                    ),
                ),
                ("conflicted", Value::Bool(record.conflicted)),
                ("versions", Value::Array(versions)),
            ]));

            if let Some(head) = head.filter(|head| !head.deleted && !head.sids.is_empty()) {
                let path = out.join(format!("{}.bin.enc", summary.file_id));
                let mut file = File::create(&path)?;
                for sid in &head.sids {
                    match store.open_chunk(sid) {
                        Ok((mut chunk, len)) => {
                            io::copy(&mut chunk, &mut file)?;
                            report.chunks += 1;
                            report.bytes += len;
                        }
                        Err(_) => report.missing.push(*sid),
                    }
                }
                file.sync_all()?;
                report.files += 1;
            }
        }
        after = next;
        if after.is_none() {
            break;
        }
    }

    let manifest = json::obj(vec![
        ("v", Value::Int(1)),
        ("domain", Value::Str(domain.to_string())),
        ("payload", Value::Str("ciphertext".to_string())),
        ("files", Value::Array(entries)),
    ]);
    let mut file = File::create(out.join("manifest.json"))?;
    file.write_all(manifest.to_json().as_bytes())?;
    file.sync_all()?;

    started.summary(
        &log,
        &[
            ("files", Val::count(report.files)),
            ("versions", Val::count(report.versions)),
            ("chunks", Val::count(report.chunks)),
            ("bytes", Val::bytes(report.bytes)),
            ("missing", Val::count(report.missing.len() as u64)),
            ("decision", Val::word("ciphertext")),
        ],
    );
    Ok(report)
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

    const KEY: [u8; 32] = [5u8; 32];
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
        let report = run(&cfg, &ONE, &KEY, &out).expect("export runs");
        assert_eq!(report.files, 1, "one file is in this domain");
        assert_eq!(report.versions, 1);
        assert!(report.missing.is_empty());
        assert!(out.join(format!("{first}.bin.enc")).is_file());
        assert!(
            !out.join(format!("{second}.bin.enc")).exists(),
            "the other domain's file was not written"
        );
        let manifest = fs::read_to_string(out.join("manifest.json")).expect("manifest");
        assert!(manifest.contains(&ONE.to_string()));
        assert!(manifest.contains(&first.to_string()));
        assert!(
            !manifest.contains(&second.to_string()),
            "and it is not listed either"
        );

        // The other domain exports its own file, and nothing else.
        let other = dir.path().join("out-two");
        let report = run(&cfg, &TWO, &KEY, &other).expect("export runs");
        assert_eq!(report.files, 1);
        assert!(other.join(format!("{second}.bin.enc")).is_file());
        assert!(!other.join(format!("{first}.bin.enc")).exists());
    }

    #[test]
    fn a_domain_no_file_is_in_is_refused_before_anything_is_written() {
        let dir = TempDir::new("export-unknown-domain");
        let cfg = config(&dir);
        seed(&cfg);
        let out = dir.path().join("out");
        assert!(matches!(
            run(&cfg, &ABSENT, &KEY, &out),
            Err(StoreError::UnknownDomain)
        ));
        assert!(!out.exists(), "a refused export creates no directory");
    }
}
