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
//! acted on but not written down is a nonce a crash makes replayable.
#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

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
    /// Lines the file holds, live and expired alike: what the caller's
    /// compaction threshold is measured against.
    lines: usize,
    /// Appends since the last sweep summary.
    appended: u64,
    /// Durability steps taken. `fsync` leaves nothing a hermetic test can
    /// observe, so what a test can pin is that the step runs, once per
    /// accepted request; the count rises in exactly one place.
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
            NonceLog {
                root,
                file,
                lines,
                appended: 0,
                syncs: 0,
            },
            entries,
        ))
    }

    /// Write one accepted nonce down and make it durable.
    ///
    /// # Errors
    /// The volume. The caller refuses the request it came from: a request
    /// answered without its nonce recorded is one a crash makes replayable.
    pub fn append(&mut self, ts: u64, entry: &Nonce) -> io::Result<()> {
        self.file.write_all(line(ts, entry).as_bytes())?;
        self.fsync()?;
        self.lines += 1;
        self.appended += 1;
        Ok(())
    }

    /// Rewrite the file with the entries still inside the window.
    ///
    /// The shape of a snapshot (`docs/storage.md`, durability rule 5): a
    /// temporary file, fsynced, renamed onto the name, and the directory
    /// fsynced after it. A crash leaves the file it had or the file it was
    /// given, never half of either, so a compaction can never be the reason
    /// a nonce inside its window is forgotten.
    ///
    /// # Errors
    /// The volume.
    pub fn compact(&mut self, live: &HashMap<Nonce, u64>) -> io::Result<()> {
        let mut body = String::new();
        for (entry, expiry) in live {
            body.push_str(&line(expiry.saturating_sub(NONCE_TTL_SECS), entry));
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
        self.lines = live.len();
        self.syncs += 1;
        Ok(())
    }

    /// Lines the file holds, for the caller's compaction threshold.
    pub const fn lines(&self) -> usize {
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
        self.file.sync_all()?;
        self.syncs += 1;
        Ok(())
    }

    /// How many times the log has been made durable, for the test that pins
    /// that every accepted request pays for one.
    #[cfg(test)]
    pub const fn syncs(&self) -> u64 {
        self.syncs
    }
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
