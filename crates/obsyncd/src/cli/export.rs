//! `obsyncd export`: reconstruct a domain's data from the volumes.
//!
//! **What this does in v0.1, plainly.** It exports CIPHERTEXT. For each file
//! the store holds it writes `<out>/<file_id>.bin.enc`, the newest head's
//! chunks concatenated in order, plus `<out>/manifest.json` listing every
//! retained version with its sids and its encrypted manifest.
//!
//! It does not write plaintext, and it does not filter by domain. Both need
//! AES-256-GCM, which the server deliberately does not implement
//! (docs/architecture.md §3: "The server performs no AES and no asymmetric
//! operation in v1"), and domain membership lives inside the encrypted
//! manifest, so the server cannot even tell which files belong to the domain
//! being asked for. Plaintext export lands with the AES-GCM primitive in a
//! later version; until then the operator decrypts the exported ciphertext
//! on a device that holds the key, and the `--key` argument is accepted so
//! the command line does not change when that lands.
#![forbid(unsafe_code)]

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use obsync_core::hex;
use obsync_core::json::{self, Value};

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{Store, StoreError, load_or_create_server_key};
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
    let server_key = load_or_create_server_key(&storage.journal_dir, cfg.server_key, &log)?;
    let store = Store::open(&storage, server_key, log.clone())?;
    if !store.domains().iter().any(|d| d.domain_id == *domain) {
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
