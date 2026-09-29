//! The durable half of replay protection (`docs/protocol.md`,
//! "Authentication").
//!
//! A nonce is remembered for 600 s, and a memory that a restart empties does
//! not keep that promise: a request captured 299 s before a rolling restart
//! is still inside its window a second after it, against a server that has
//! forgotten every nonce it ever saw. The window is a statement about
//! wall-clock time, so what enforces it has to outlive the process.
//!
//! The state is one append-only file, `nonces`, under the journal root. It
//! holds no credential — a device id and a nonce are public request values
//! that open nothing and are only ever compared — so it is server state like
//! the journal segments beside it, created 0600 under the 0700 root the
//! posture pass has already measured, and it adds no class to that pass and
//! no line to `obsyncd check`.
//!
//! Every accepted nonce is appended and fsynced BEFORE the request it
//! authenticates is answered, for the reason a journal frame is
//! (`docs/storage.md`, durability rule 6): a nonce the server has already
//! acted on but not written down is a nonce a crash makes replayable. The
//! nonces of requests that arrive together are written as one batch and made
//! durable by one fsync (`super::auth::NonceCache`): the promise is per
//! request, and the fsync is shared.
#![forbid(unsafe_code)]

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(test)]
use std::sync::Mutex;
#[cfg(test)]
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use std::time::{Duration, Instant};

use crate::log::{Log, Val};
use crate::storage::{PathClass, StoreError};

use super::auth::NONCE_TTL_SECS;
use super::is_hex;

/// The file, beside the journal segments on the journal volume.
const FILE_NAME: &str = "nonces";
/// Where a compaction assembles the replacement before it takes the name.
const TMP_NAME: &str = "nonces.tmp";
/// Server state its own user reads and writes, and nobody else sees.
const FILE_MODE: u32 = 0o600;

/// One remembered request: the device that sent it and the nonce it carried,
/// both 32 hex characters.
pub type Nonce = (String, String);

/// A crash point in the nonce log, armed by a test so the volume's own
/// refusals can be proven rather than argued (AGENTS.md, "Testing doctrine").
///
/// Compiled only into the test build, like the storage engine's `Fault`: a
/// switch that could skip a write or an fsync in the shipped binary is
/// exactly the toggle requirement 4 forbids.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum NonceFault {
    /// No crash point armed.
    #[default]
    None,
    /// Half the line lands, then the errno: what a full volume does to a
    /// write that does not fit.
    ShortWrite {
        /// The `errno` the write returns.
        code: i32,
    },
    /// The whole line lands and the fsync refuses, so the bytes are on the
    /// volume and none of them is durable.
    SyncFails {
        /// The `errno` the fsync returns.
        code: i32,
    },
    /// The fsync takes `ms` longer than the volume would, then succeeds: the
    /// window in which an answer sent early would show.
    SlowSync {
        /// The extra time.
        ms: u64,
    },
    /// Slow, then refused: every request that queued behind the flush joins
    /// the next batch, and that batch fails as one.
    SlowSyncFails {
        /// The extra time.
        ms: u64,
        /// The `errno` the fsync returns.
        code: i32,
    },
    /// The batch is durable and the process dies before anyone is answered.
    CrashAfterSync,
    /// Slow and successful, as `SlowSync`, and then the NEXT batch's flush
    /// panics: a bug in the flush, landing on a batch whose members all
    /// queued behind this one.
    SlowSyncThenPanic {
        /// The extra time.
        ms: u64,
        /// Whether the panic comes while the flush holds the cache's mutex
        /// (deciding on a compaction) or half way through the write.
        locked: bool,
    },
    /// Half the batch lands, then the flush panics. Once.
    PanicMidWrite,
    /// The flush panics while it holds the cache's mutex. Once.
    PanicUnderLock,
    /// Half the batch lands, the write refuses, and so does the cut that
    /// would take it back off the volume.
    ShortWriteStuck {
        /// The `errno` the write returns.
        code: i32,
    },
}

/// The file the accepted nonces are written to, held open for the life of
/// the process.
///
/// The handle is the point: it is opened once, under a root that was
/// measured before anything was read or written through it, and every
/// append goes to that handle rather than to the name again.
pub struct NonceLog {
    /// The journal root, for the compaction's temporary file and rename.
    root: PathBuf,
    file: File,
    /// What this log occupies on the JOURNAL volume, published after every
    /// write so the volume's watermark and its dashboard see these bytes at
    /// the moment they land rather than at the journal's next survey. It is
    /// an absolute number, not a delta: a lost update cannot accumulate, and
    /// the journal's own survey leaves these two names alone
    /// (`storage/journal.rs`, `NONCE_FILE` and `NONCE_TMP`).
    reported: Arc<AtomicU64>,
    /// Lines the file holds, live and expired alike: what the caller's
    /// compaction threshold is measured against.
    lines: usize,
    /// Appends since the last sweep summary.
    appended: u64,
    /// The length the file has made durable. A refused batch is cut back to
    /// it: without the cut, the next batch would land after a torn line and
    /// the next start would refuse the whole file as corrupt.
    durable_len: u64,
    /// Set when that cut itself failed. Every later write refuses until a
    /// restart, which truncates the torn tail as `open` describes.
    faulted: Option<io::ErrorKind>,
    #[cfg(test)]
    fault: Mutex<NonceFault>,
    /// Raised while an armed slow fsync runs, so a test can act while a flush
    /// is in flight without taking any lock the flush might hold.
    #[cfg(test)]
    syncing: Arc<AtomicBool>,
    /// Every durable batch: when its fsync returned, and what it held.
    #[cfg(test)]
    flushed: Vec<(Instant, Vec<Nonce>)>,
    /// Durability steps taken. `fsync` leaves nothing a hermetic test can
    /// observe, so what a test can pin is that the step runs, once per
    /// flush; the count rises in exactly one place.
    syncs: u64,
}

impl NonceLog {
    /// Open the file and return the entries still inside the window.
    ///
    /// The whole file is read: compaction keeps it at roughly twice the
    /// cache's own ceiling, which is tens of megabytes at the shipped
    /// numbers, and this runs once at start.
    ///
    /// # Errors
    /// The volume, or [`StoreError::Corrupt`] for a complete line that is
    /// not an entry. The last line alone may be torn — a crash between an
    /// append and its fsync is the one way a partial line is written, and
    /// only the newest line can be the one that was in flight.
    pub fn open(
        journal_dir: &Path,
        now: u64,
        reported: Arc<AtomicU64>,
        log: &Log,
    ) -> Result<(NonceLog, Vec<(Nonce, u64)>), StoreError> {
        let root = PathClass::JournalRoot.path(journal_dir);
        let path = root.join(FILE_NAME);
        // A restored volume can arrive with this name already pointing at
        // another file the server may write -- the wrapping material beside
        // it, a journal segment -- and appending through it would put nonce
        // lines inside that file. The name is looked at once without
        // following a link, as `storage::posture` looks at a credential
        // file, and anything that is not a regular file refuses the start.
        //
        // That look is not paired with an inode identity check on the handle
        // the way posture's is: what posture defends against there is
        // someone re-pointing the name between the look and the open, and
        // whoever can do that inside this 0700 root can write the journal
        // itself. What arrives already planted is what this closes.
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Err(refuse(log, "not_a_regular_file")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .mode(FILE_MODE)
            .open(&path)?;
        let mut text = String::new();
        file.read_to_string(&mut text)?;

        let complete = text.rfind('\n').map_or(0, |at| at + 1);
        let torn = (text.len() - complete) as u64;
        let mut entries = Vec::new();
        let mut lines = 0usize;
        let mut expired = 0u64;
        for line in text[..complete].lines() {
            lines += 1;
            let Some((ts, entry)) = parse(line) else {
                return Err(refuse(log, "nonce_log_corrupt"));
            };
            // Only what the window still covers comes back. The rest stays
            // in the file until a compaction drops it, and is never a reason
            // to refuse a request.
            if ts + NONCE_TTL_SECS > now {
                entries.push((entry, ts + NONCE_TTL_SECS));
            } else {
                expired += 1;
            }
        }
        if torn > 0 {
            file.set_len(complete as u64)?;
            file.sync_all()?;
        }
        log.info(
            "nonce_log",
            &[
                (
                    "decision",
                    Val::word(if torn > 0 { "truncated" } else { "loaded" }),
                ),
                ("entries", Val::count(entries.len() as u64)),
                ("expired", Val::count(expired)),
                ("torn_bytes", Val::bytes(torn)),
            ],
        );
        Ok((
            {
                let log = NonceLog {
                    root,
                    file,
                    reported,
                    lines,
                    appended: 0,
                    durable_len: complete as u64,
                    faulted: None,
                    syncs: 0,
                    #[cfg(test)]
                    fault: Mutex::new(NonceFault::None),
                    #[cfg(test)]
                    syncing: Arc::new(AtomicBool::new(false)),
                    #[cfg(test)]
                    flushed: Vec::new(),
                };
                // What a restart inherits, said once before anything is
                // written: the journal's survey ran before this and left
                // these names to this number.
                log.publish();
                log
            },
            entries,
        ))
    }

    /// Arm a crash point for the next write. Tests only.
    #[cfg(test)]
    pub fn set_fault(&self, fault: NonceFault) {
        *self.fault.lock().expect("fault lock") = fault;
    }

    #[cfg(test)]
    fn armed(&self) -> NonceFault {
        *self.fault.lock().expect("fault lock")
    }

    /// The flag an armed slow fsync raises while it runs. Tests only.
    #[cfg(test)]
    pub fn syncing(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.syncing)
    }

    /// Every durable batch so far, oldest first. Tests only.
    #[cfg(test)]
    pub fn flushed(&self) -> &[(Instant, Vec<Nonce>)] {
        &self.flushed
    }

    /// Publish what this log occupies on the journal volume.
    ///
    /// Two `stat`s: the open handle, and the compaction temporary by name.
    /// BOTH names, because a compaction that fails leaves the temporary
    /// behind and those bytes are on the volume exactly as the file's are.
    /// Called after every write, the failing ones included: bytes that
    /// landed before an error are still bytes, and a watermark that cannot
    /// see them is a watermark that admits a write onto a full volume.
    fn publish(&self) {
        let live = self.file.metadata().map_or(0, |m| m.len());
        let leftover = fs::symlink_metadata(self.root.join(TMP_NAME)).map_or(0, |m| m.len());
        self.reported
            .store(live.saturating_add(leftover), Ordering::Release);
    }

    /// Write a batch of accepted nonces down and make it durable with one
    /// fsync.
    ///
    /// A refusal cuts the file back to the length it had made durable before
    /// this batch, and fsyncs the cut, so no line of a refused batch outlives
    /// it and the next batch starts on a line boundary. A cut that fails as
    /// well faults the log: nothing more is written until a restart truncates
    /// the torn tail.
    ///
    /// # Errors
    /// The volume. The caller refuses every request in the batch: a request
    /// answered without its nonce recorded is one a crash makes replayable.
    pub fn append(&mut self, entries: &[(u64, Nonce)]) -> io::Result<()> {
        if let Some(kind) = self.faulted {
            return Err(io::Error::from(kind));
        }
        let text: String = entries.iter().map(|(ts, entry)| line(*ts, entry)).collect();
        #[cfg(test)]
        let wrote = match self.armed() {
            NonceFault::ShortWrite { code } | NonceFault::ShortWriteStuck { code } => self
                .file
                .write_all(&text.as_bytes()[..text.len() / 2])
                .and(Err(io::Error::from_raw_os_error(code))),
            NonceFault::PanicMidWrite => {
                let _ = self.file.write_all(&text.as_bytes()[..text.len() / 2]);
                self.set_fault(NonceFault::None);
                panic!("injected panic part way through a nonce batch");
            }
            _ => self.file.write_all(text.as_bytes()),
        };
        #[cfg(not(test))]
        let wrote = self.file.write_all(text.as_bytes());
        let outcome = wrote.and_then(|()| self.fsync());
        // A crash, not a refusal: nothing after the fsync runs in a process
        // that died there, so nothing is cut back either.
        #[cfg(test)]
        if outcome.is_ok() && self.armed() == NonceFault::CrashAfterSync {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "injected crash"));
        }
        if outcome.is_err()
            && let Err(e) = self.rollback()
        {
            self.faulted = Some(e.kind());
        }
        // Before the `?`: a cut that failed leaves bytes on the volume, and
        // the volume's accounting has to see them.
        self.publish();
        outcome?;
        #[cfg(test)]
        self.flushed.push((
            Instant::now(),
            entries.iter().map(|(_, entry)| entry.clone()).collect(),
        ));
        self.durable_len += text.len() as u64;
        self.lines += entries.len();
        self.appended += entries.len() as u64;
        Ok(())
    }

    /// A flush that unwound part way, which only a bug does: cut the file
    /// back to what it had made durable, as a refused batch is cut, so the
    /// next batch starts on a clean line and no start ever loads a line of a
    /// batch that was never answered. A cut that fails faults the log, as it
    /// does after a refusal.
    pub fn abandon(&mut self) {
        if let Err(e) = self.rollback() {
            self.faulted = Some(e.kind());
        }
        self.publish();
    }

    /// Cut a refused batch back off the volume, and make the cut durable.
    fn rollback(&mut self) -> io::Result<()> {
        #[cfg(test)]
        if let NonceFault::ShortWriteStuck { code } = self.armed() {
            return Err(io::Error::from_raw_os_error(code));
        }
        self.file.set_len(self.durable_len)?;
        self.file.sync_all()
    }

    /// Rewrite the file with the `lines` entries still inside the window,
    /// as [`window`] rendered them into `body`.
    ///
    /// The shape of a snapshot (`docs/storage.md`, durability rule 5): a
    /// temporary file, fsynced, renamed onto the name, and the directory
    /// fsynced after it. A crash leaves the file it had or the file it was
    /// given, never half of either, so a compaction can never be the reason
    /// a nonce inside its window is forgotten.
    ///
    /// # Errors
    /// The volume.
    pub fn compact(&mut self, body: &str, lines: usize) -> io::Result<()> {
        let outcome = self.compact_inner(body, lines);
        // A compaction that failed part way leaves the old file AND a
        // temporary beside it; both are on the volume and both are counted.
        self.publish();
        outcome
    }

    fn compact_inner(&mut self, body: &str, lines: usize) -> io::Result<()> {
        if let Some(kind) = self.faulted {
            return Err(io::Error::from(kind));
        }
        let tmp = self.root.join(TMP_NAME);
        // Whatever stands at the temporary name -- a file a crash left, or a
        // link a restored volume brought -- is removed by name, which never
        // follows a link, and the replacement is then created exclusively:
        // `O_EXCL` refuses an existing name of any kind, so nothing this
        // writes can land in a file that was already there.
        match fs::remove_file(&tmp) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut replacement = OpenOptions::new()
            .read(true)
            .append(true)
            .create_new(true)
            .mode(FILE_MODE)
            .open(&tmp)?;
        replacement.write_all(body.as_bytes())?;
        replacement.sync_all()?;
        fs::rename(&tmp, self.root.join(FILE_NAME))?;
        File::open(&self.root)?.sync_all()?;
        // The handle that wrote the bytes is the handle that appends to
        // them: the rename moved the object it holds open, so no name is
        // resolved again and there is no link left to follow.
        self.file = replacement;
        self.lines = lines;
        self.durable_len = body.len() as u64;
        self.syncs += 1;
        Ok(())
    }

    /// Lines the file holds, for the caller's compaction threshold.
    pub fn lines(&self) -> usize {
        #[cfg(test)]
        if self.armed() == NonceFault::PanicUnderLock {
            self.set_fault(NonceFault::None);
            panic!("injected panic while the flush holds the cache");
        }
        self.lines
    }

    /// Appends since the last call, for the sweep summary: what one sweep
    /// period of requests cost the journal volume (requirement 12).
    pub const fn take_appends(&mut self) -> u64 {
        let appended = self.appended;
        self.appended = 0;
        appended
    }

    /// The durability step, and the only place the count rises.
    fn fsync(&mut self) -> io::Result<()> {
        #[cfg(test)]
        match self.armed() {
            NonceFault::SyncFails { code } => return Err(io::Error::from_raw_os_error(code)),
            NonceFault::SlowSync { ms }
            | NonceFault::SlowSyncFails { ms, .. }
            | NonceFault::SlowSyncThenPanic { ms, .. } => {
                self.syncing.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(ms));
                self.syncing.store(false, Ordering::SeqCst);
                match self.armed() {
                    NonceFault::SlowSyncFails { code, .. } => {
                        return Err(io::Error::from_raw_os_error(code));
                    }
                    NonceFault::SlowSyncThenPanic { locked: true, .. } => {
                        self.set_fault(NonceFault::PanicUnderLock);
                    }
                    NonceFault::SlowSyncThenPanic { locked: false, .. } => {
                        self.set_fault(NonceFault::PanicMidWrite);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        self.file.sync_all()?;
        self.syncs += 1;
        Ok(())
    }

    /// How many times the log has been made durable, for the test that pins
    /// that a flush pays for one.
    #[cfg(test)]
    pub const fn syncs(&self) -> u64 {
        self.syncs
    }
}

/// What a compaction writes: one line per entry the window still covers,
/// stamped with the second it was accepted, and how many lines that is.
pub fn window<'a>(live: impl Iterator<Item = (&'a Nonce, &'a u64)>) -> (String, usize) {
    let mut body = String::new();
    let mut lines = 0;
    for (entry, expiry) in live {
        body.push_str(&line(expiry.saturating_sub(NONCE_TTL_SECS), entry));
        lines += 1;
    }
    (body, lines)
}

/// One refusal line and the error that stops the start (requirement 12).
/// The reason is a compile-time word, and no line states a location.
fn refuse(log: &Log, reason: &'static str) -> StoreError {
    log.error(
        "nonce_log",
        &[
            ("decision", Val::word("refused")),
            ("reason", Val::word(reason)),
        ],
    );
    StoreError::Corrupt(format!("the nonce log was refused: {reason}"))
}

/// One line: the second the nonce was accepted, the device, and the nonce.
fn line(ts: u64, entry: &Nonce) -> String {
    format!("{ts} {} {}\n", entry.0, entry.1)
}

/// Read one line back, or refuse it. Three fields, a decimal second, and two
/// 32-hex ids: anything else was not written by [`line`].
fn parse(text: &str) -> Option<(u64, Nonce)> {
    let mut fields = text.split(' ');
    let ts: u64 = fields.next()?.parse().ok()?;
    let device = fields.next()?;
    let nonce = fields.next()?;
    if fields.next().is_some() || !is_hex(device, 32) || !is_hex(nonce, 32) {
        return None;
    }
    Some((ts, (device.to_string(), nonce.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const NONCE: &str = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

    #[test]
    fn a_line_round_trips_and_anything_else_is_refused() {
        let entry = (DEVICE.to_string(), NONCE.to_string());
        let rendered = line(1_757_200_000, &entry);
        assert_eq!(rendered, format!("1757200000 {DEVICE} {NONCE}\n"));
        assert_eq!(
            parse(rendered.trim_end()),
            Some((1_757_200_000, entry.clone()))
        );

        // Every field is checked, so a half-written line cannot be read as a
        // whole one and a foreign line cannot be read at all.
        assert_eq!(parse(""), None);
        assert_eq!(parse(&format!("1757200000 {DEVICE}")), None);
        assert_eq!(parse(&format!("now {DEVICE} {NONCE}")), None);
        assert_eq!(parse(&format!("1757200000 {DEVICE} {NONCE} extra")), None);
        assert_eq!(
            parse(&format!("1757200000 {} {NONCE}", &DEVICE[..30])),
            None
        );
        assert_eq!(
            parse(&format!("1757200000 {DEVICE} {}", &NONCE[..30])),
            None
        );
    }
}
