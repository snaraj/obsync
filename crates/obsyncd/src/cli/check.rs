//! `obsyncd check`: verify every blob hash and every journal frame.
//!
//! The offline half of the recovery path (docs/storage.md, "Replication and
//! propagation"). It opens the volumes read-only as far as content goes —
//! it writes nothing but the journal's own recovery truncation and whatever
//! the posture pass has to correct — re-hashes every chunk, decodes every
//! frame, and prints the counts.
//!
//! The posture pass is the identical one a start runs (repair and report,
//! docs/storage.md), so an operator who runs this on a restored volume
//! leaves it correct rather than merely informed. A posture that cannot be
//! corrected refuses here exactly as it refuses a start, and the exit code
//! is non-zero.
#![forbid(unsafe_code)]

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{Decision, Outcome, Posture, Store, StoreError, load_or_create_server_key};
use crate::types::Sid;

/// What one check found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckReport {
    /// What the posture pass decided, one entry per volume root and
    /// credential file.
    pub posture: Vec<Outcome>,
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
        for outcome in &self.posture {
            let class = outcome.class.label();
            match outcome.decision {
                Decision::Ok { mode } => println!("posture {class}: ok {mode:04o}"),
                Decision::Repaired { from, to } => {
                    println!("posture {class}: repaired {from:04o} -> {to:04o}");
                }
                Decision::Absent => println!("posture {class}: absent"),
            }
        }
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
    let posture = Posture::enforce(&storage, log)?;
    let server_key =
        load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, log)?;
    let store = Store::open(&storage, server_key, &posture, log.clone())?;
    let started = log.start("check", storage.blobs_capacity);

    let (chunks, bytes, bad_chunks) = store.verify_chunks()?;
    let (segments, frames, bad_frames) = store.verify_journal()?;
    let report = CheckReport {
        posture: posture.outcomes().to_vec(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use crate::cli::testutil::config;
    use crate::log::LogLevel;
    use crate::storage::PathClass;
    use crate::storage::testutil::TempDir;

    /// Repair and report: an operator who runs `check` on a restored volume
    /// leaves it correct, and the report says what was corrected.
    #[test]
    fn a_check_on_a_restored_volume_corrects_it_and_reports_every_class() {
        let dir = TempDir::new("check-posture");
        let cfg = config(&dir);
        let journal_root = PathClass::JournalRoot.path(&cfg.journal_dir);
        fs::create_dir_all(&journal_root).expect("the journal root is restored");
        let token = PathClass::SetupToken.path(&cfg.journal_dir);
        fs::write(&token, "ab".repeat(32)).expect("the recovery login is restored");
        fs::set_permissions(&token, fs::Permissions::from_mode(0o644)).expect("weak mode");
        fs::set_permissions(&journal_root, fs::Permissions::from_mode(0o755)).expect("weak mode");

        let log = Log::buffered(LogLevel::Debug);
        let report = run(&cfg, &log).expect("the check runs");

        assert!(report.ok(), "a corrected volume is not a failed check");
        let classes: Vec<&str> = report
            .posture
            .iter()
            .map(|outcome| outcome.class.label())
            .collect();
        assert_eq!(
            classes,
            vec![
                "journal_mount",
                "blobs_mount",
                "blobs_root",
                "journal_root",
                "server_key",
                "setup_token"
            ],
            "every class is reported"
        );
        assert_eq!(
            report.posture[5].decision,
            Decision::Repaired {
                from: 0o644,
                to: 0o600
            },
            "the setup token"
        );
        assert_eq!(
            report.posture[3].decision,
            Decision::Repaired {
                from: 0o755,
                to: 0o700
            },
            "the journal root"
        );
        assert!(
            matches!(report.posture[0].decision, Decision::Ok { .. }),
            "a mount is reported at the mode it was read at and never corrected"
        );
        assert_eq!(
            fs::symlink_metadata(&token)
                .expect("the token")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "the volume is left correct, not merely described"
        );
        report.print();
    }

    /// A posture that cannot be corrected is a refusal here exactly as it is
    /// at a start: `cli::report` turns it into a non-zero exit.
    #[test]
    fn a_check_refuses_what_a_start_would_refuse() {
        let dir = TempDir::new("check-posture-refused");
        let cfg = config(&dir);
        fs::create_dir_all(PathClass::ServerKey.path(&cfg.journal_dir))
            .expect("a directory takes the name");
        let err = run(&cfg, &Log::buffered(LogLevel::Debug)).expect_err("the check refuses");
        assert_eq!(err.code(), "unsafe_posture", "{err}");
    }
}
