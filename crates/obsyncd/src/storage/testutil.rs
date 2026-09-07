//! Test scaffolding for the storage engine: a self-cleaning temp directory
//! and the fixtures the store tests build on. Hand-written, standard library
//! only (AGENTS.md, "Testing doctrine").
#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::storage::types::{DevicePolicy, DeviceRecord, DeviceState, VersionRecord};
use crate::types::{AccountId, DeviceId, DomainId, FileId, Seq, UnixMs, VersionId};

/// A directory under `std::env::temp_dir()` removed when the test ends,
/// including when the test fails: `Drop` runs on the unwind.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Create a uniquely named directory for `label`.
    pub(crate) fn new(label: &str) -> TempDir {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "obsync-test-{label}-{}-{n}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp directory is created");
        TempDir { path }
    }

    /// The directory.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// A device record with sentinel fields, for tests that do not care about them.
pub(crate) fn device_record() -> DeviceRecord {
    DeviceRecord {
        device_id: DeviceId::new([0xa1; 16]),
        account_id: AccountId::new([1u8; 16]),
        name: "sentinel device".to_string(),
        platform: "linux".to_string(),
        app_version: "0.1.0".to_string(),
        created: UnixMs(1_757_000_000_000),
        last_seen: None,
        last_sign_in: None,
        last_edit: None,
        address: None,
        country: None,
        policy: DevicePolicy {
            per_file_max_bytes: 0,
            total_budget_bytes: 0,
        },
        state: DeviceState::Active,
    }
}

/// A version record with sentinel content, at a chosen point in the graph.
pub(crate) fn version_record(
    file_id: FileId,
    version_id: VersionId,
    parents: &[VersionId],
    seq: Seq,
) -> VersionRecord {
    VersionRecord {
        file_id,
        domain_id: DomainId::new([0xd0; 16]),
        version_id,
        parents: parents.to_vec(),
        sids: Vec::new(),
        bytes: 0,
        manifest_ct: b"sentinel-ciphertext".to_vec(),
        manifest_nonce: [7u8; 12],
        device_id: DeviceId::new([0xa1; 16]),
        ts: UnixMs(1_757_000_000_000 + seq.0),
        deleted: false,
        seq,
    }
}
