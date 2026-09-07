//! `obsyncd check`: verify every blob hash and every journal frame.
//!
//! The offline half of the recovery path (docs/storage.md, "Replication and
//! propagation"). It opens the volumes read-only as far as content goes —
//! it writes nothing but the journal's own recovery truncation — re-hashes
//! every chunk, decodes every frame, and prints the counts.
#![forbid(unsafe_code)]

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{Store, StoreError, load_or_create_server_key};
use crate::types::Sid;

/// What one check found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckReport {
    /// Chunks whose content hashes to the sid they are stored under.
    pub chunks: u64,
    /// Bytes those chunks hold.
    pub bytes: u64,
    /// Chunks that failed: wrong content, or missing from the volume.
    pub bad_chunks: Vec<Sid>,
    /// Journal segments read.
    pub segments: u64,
    /// Frames that decoded.
    pub frames: u64,
    /// Frames that did not.
    pub bad_frames: u64,
}

impl CheckReport {
    /// Whether everything verified.
    pub fn ok(&self) -> bool {
        self.bad_chunks.is_empty() && self.bad_frames == 0
    }

    /// Print the counts for an operator, one fact per line.
    pub fn print(&self) {
        println!("chunks verified: {}", self.chunks);
        println!("bytes verified:  {}", self.bytes);
        println!("chunks failed:   {}", self.bad_chunks.len());
        for sid in &self.bad_chunks {
            println!("  {sid}");
        }
        println!("journal segments: {}", self.segments);
        println!("frames verified:  {}", self.frames);
        println!("frames failed:    {}", self.bad_frames);
        println!("result: {}", if self.ok() { "ok" } else { "FAILED" });
    }
}

/// Verify the volumes named by `cfg`.
///
/// Opening the store replays the journal first, so a torn tail is truncated
/// and reported exactly as it would be at boot; the check then re-hashes
/// what remains.
pub fn run(cfg: &Config, log: &Log) -> Result<CheckReport, StoreError> {
    let storage = cfg.storage();
    let server_key = load_or_create_server_key(&storage.journal_dir, cfg.server_key, log)?;
    let store = Store::open(&storage, server_key, log.clone())?;
    let started = log.start("check", storage.blobs_capacity);

    let (chunks, bytes, bad_chunks) = store.verify_chunks()?;
    let (segments, frames, bad_frames) = store.verify_journal()?;
    let report = CheckReport {
        chunks,
        bytes,
        bad_chunks,
        segments,
        frames,
        bad_frames,
    };
    started.summary(
        log,
        &[
            ("chunks", Val::count(report.chunks)),
            ("bytes", Val::bytes(report.bytes)),
            ("bad_chunks", Val::count(report.bad_chunks.len() as u64)),
            ("segments", Val::count(report.segments)),
            ("frames", Val::count(report.frames)),
            ("bad_frames", Val::count(report.bad_frames)),
            (
                "decision",
                Val::word(if report.ok() { "ok" } else { "failed" }),
            ),
        ],
    );
    Ok(report)
}
