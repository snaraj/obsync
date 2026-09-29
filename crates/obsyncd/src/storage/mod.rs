//! The storage engine: blobs, mirrors, journal, index, GC and scrub.
//!
//! `docs/storage.md` is the contract this module implements. The engine owns
//! every durability rule: temp-write, fsync, rename, directory fsync before
//! any acknowledgement; sid verification on every write and every scrub;
//! refusal below the free-space watermark. None of that is configurable
//! (AGENTS.md requirement 4).
//!
//! Concurrency: one mutex over the journal writer, one over the index, and a
//! condition variable on the index for the long-poll change feed. Writes take
//! the journal first and then the index, always in that order; reads take the
//! index alone. A write holds the journal for its whole life -- validate,
//! append, fsync, apply -- and the index only to validate and to apply, never
//! across the volume, so one writer's fsync stalls the next writer and no
//! reader. Version posts that queue behind an fsync are made durable by the
//! next one together (`Store::append`, group commit), so a burst of posts
//! costs one fsync per turn of the journal rather than one each. A fixed
//! table of SID locks serializes chunk mutation before either lock; GC takes
//! the table in order. Streaming and hashing hold only a SID lock, so a slow
//! upload never blocks the feed.
//!
//! Free space: the standard library exposes no `statvfs`, and running `df`
//! from library code would make the server depend on a shell. The watermark
//! is therefore evaluated against declared capacity (`OBSYNC_BLOBS_CAPACITY`,
//! `OBSYNC_JOURNAL_CAPACITY`) minus tracked usage, and both numbers are on
//! the startup line so an operator can see what they are being measured
//! against.
#![forbid(unsafe_code)]

mod blobs;
mod gc;
mod index;
mod journal;
pub mod posture;
mod scrub;
pub mod types;

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod testutil;

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use obsync_core::hex;
use obsync_core::hkdf::hkdf_sha256;
use obsync_core::sha256::Sha256;

use crate::config::StorageConfig;
use crate::log::{Log, Val};
use crate::types::{AccountId, DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId};

use self::blobs::Blobs;
use self::index::Index;
use self::journal::{Frame, Journal, Record};

pub use self::index::FILE_MAX_HEADS;
pub use self::posture::{Decision, Outcome, PathClass, Posture};
pub use self::types::{
    AccountRecord, AppendDecision, AppendOutcome, Change, Changes, DevicePolicy, DeviceRecord,
    DeviceState, FileRecord, FileSummary, GcSummary, NewDevice, NewVersion, PutOutcome,
    ScrubSummary, SeenEvent, SeenKind, StoreError, VersionRecord, VolumeStatus,
};

/// The domain separator device secrets rest under
/// (docs/architecture.md §3.6).
const WRAP_SALT: &[u8] = b"obsync/v1/wrap";

/// The most posts one group commit carries (`Store::append_grouped`), and
/// the most bytes of manifest and chunk list it adds up before it stops
/// taking more: a batch's frames are encoded into one buffer, which this
/// keeps near one ordinary post's size however many connections queue. The
/// first post of a turn is always taken, whatever its size.
const GROUP_MAX_POSTS: usize = 64;
const GROUP_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One version post waiting for the journal.
struct Queued {
    v: NewVersion,
    accept_existing: bool,
    edit: Option<SeenEvent>,
}

impl Queued {
    /// What this post adds to a batch's frame buffer, roughly: its manifest
    /// and its id lists.
    fn weight(&self) -> usize {
        self.v.manifest_ct.len() + 32 * (self.v.sids.len() + self.v.parents.len())
    }
}

/// A post's answer, and how many posts the fsync that answered it carried.
type Answer = (Result<AppendOutcome, StoreError>, usize);

/// The group commit's shared state (`Store::append_grouped`): posts waiting
/// for a turn of the journal, in arrival order, each under its ticket, and
/// the answers a leader has made that their threads have not collected.
#[derive(Default)]
struct VersionQueue {
    next: u64,
    waiting: VecDeque<(u64, Queued)>,
    answered: HashMap<u64, Answer>,
}

impl VersionQueue {
    fn enqueue(&mut self, post: Queued) -> u64 {
        let ticket = self.next;
        self.next += 1;
        self.waiting.push_back((ticket, post));
        ticket
    }

    /// The next batch: waiting posts in arrival order, at most one per file
    /// and within the caps. A post whose file an EARLIER waiting post names
    /// stays queued, in its place, for a later turn -- whether that earlier
    /// post was taken or itself left for the caps -- so one file's posts are
    /// always made durable in the order they arrived.
    fn batch(&mut self) -> Vec<(u64, Queued)> {
        let mut files = HashSet::new();
        let mut batch: Vec<(u64, Queued)> = Vec::new();
        let mut weight = 0;
        let mut rest = VecDeque::new();
        for (ticket, post) in self.waiting.drain(..) {
            let first_of_file = files.insert(post.v.file_id);
            let fits = batch.is_empty()
                || (batch.len() < GROUP_MAX_POSTS && weight + post.weight() <= GROUP_MAX_BYTES);
            if first_of_file && fits {
                weight += post.weight();
                batch.push((ticket, post));
            } else {
                rest.push_back((ticket, post));
            }
        }
        self.waiting = rest;
        batch
    }
}

/// How long a newly registered recovery key keeps the account's last active
/// device from being revoked: seven days (`docs/recovery.md`).
///
/// The server cannot tell a verifier the vault key produced from one it did
/// not: any device credential may register the first one. The key's own
/// devices meet a key they did not register as `409 recovery_mismatch` at
/// their next start and say so, and this hold is the time that warning has to
/// be read and acted on before the last device can go. A constant, not a
/// setting: a security hold an operator could shorten is one an attacker's
/// instructions could shorten too (AGENTS.md requirement 4).
pub const RECOVERY_HOLD_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// A crash point, armed by a test so recovery can be proven rather than
/// argued (AGENTS.md, "Testing doctrine": injected fault points).
///
/// Compiled only into the test build: a switch that could skip an `fsync` in
/// the shipped binary would be exactly the toggle requirement 4 forbids.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub(crate) enum Fault {
    /// No crash point armed.
    #[default]
    None,
    /// Die after the chunk body is written, before it is fsynced.
    ChunkBeforeFsync,
    /// Die after the chunk is fsynced, before it is renamed into place.
    ChunkBeforeRename,
    /// Die part way through appending a journal frame.
    JournalMidAppend,
    /// Die with the frames durable and not yet applied: the moment between
    /// the fsync and the answer.
    JournalCrashAfterSync,
    /// Die part way through writing a snapshot: half of it is in the
    /// temporary file, and nothing after that runs.
    SnapshotTorn,
    /// Write the final journal frame with a corrupt payload.
    JournalTornFrame,
    /// A real filesystem errno at the journal append. The process does NOT
    /// die: the error returns and the journal must recover from it, which
    /// is what separates this from [`Fault::JournalMidAppend`].
    JournalAppendErrno {
        /// The `errno` the write or the fsync returns.
        code: i32,
        /// Which half of the append fails.
        at: AppendPhase,
    },
    /// The append fails at `at` AND the rollback that would undo it fails at
    /// `rollback`: the two failures that put the journal in the faulted
    /// state. One armed value, because the second failure only exists as a
    /// consequence of the first.
    JournalRecoveryFails {
        /// The `errno` the failing append returns.
        code: i32,
        /// Which half of the append fails.
        at: AppendPhase,
        /// Which half of the rollback fails.
        rollback: RollbackPhase,
    },
    /// A real filesystem errno at one phase of a chunk write. Each phase
    /// leaves a different residue, and the test says which.
    BlobErrno {
        /// Where in the write the errno surfaces.
        phase: BlobPhase,
        /// The `errno` returned there.
        code: i32,
    },
    /// A refused journal usage survey, including metadata reads.
    JournalSurveyErrno { code: i32 },
    /// Force a pre-existing quarantine temporary name, testing exclusive
    /// creation and cleanup ownership without depending on random collisions.
    QuarantineTempCollision,
}

/// Which half of a journal append a fault surfaces in.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum AppendPhase {
    /// The `write`: half the frame lands, then the errno. The segment is
    /// left longer than the journal's durable length.
    Write,
    /// The `fsync`: the whole frame is on disk and none of it is durable.
    Sync,
}

/// Which half of the rollback after a failed append a fault surfaces in.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RollbackPhase {
    /// The `set_len` back to the durable length.
    Truncate,
    /// The `fsync` that makes that truncation durable. Truncating without
    /// it leaves the journal believing a rollback that a power cut can
    /// still undo.
    Sync,
}

/// Which phase of a chunk write a fault surfaces in (docs/storage.md,
/// durability rule 1). The residue differs per phase and the test says so.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum BlobPhase {
    /// The stream into the temp file.
    Stream,
    /// The `fsync` of the temp file.
    Sync,
    /// The `rename` into place.
    Rename,
    /// Copying into a quarantine-local temporary file.
    QuarantineCopy,
    /// The quarantine copy's file fsync.
    QuarantineFileSync,
    /// Publishing the quarantine-local temporary file.
    QuarantinePublish,
    /// The quarantine directory's fsync after publication.
    QuarantineSync,
    /// Persisting the quarantine directory's name in its parent.
    QuarantineParentSync,
    /// Removing the primary, after the quarantine copy is durable.
    QuarantineRemove,
    /// Persisting removal from the primary directory.
    QuarantineSourceSync,
    /// A failed partial copy whose temporary-file cleanup also fails.
    QuarantineCleanup,
}

/// The storage engine. One per process, shared by every request thread.
pub struct Store {
    cfg: StorageConfig,
    server_key: [u8; 32],
    log: Log,
    /// The exclusive lock on the journal, held for the life of the store.
    /// Dropping the store releases it.
    _lock: File,
    blobs: Blobs,
    /// Bounded SID serialization, including publication and inventory. A
    /// striped table avoids an unbounded map of locks controlled by uploads.
    chunk_locks: [Mutex<()>; 256],
    journal: Mutex<Journal>,
    /// Version posts waiting for the journal, and the answers of those a
    /// group commit has made durable (`Store::append`). Taken after the
    /// journal, never before it.
    versions: Mutex<VersionQueue>,
    index: Mutex<Index>,
    changed: Condvar,
    /// Set once the server is stopping: every long-poll answers at once
    /// rather than holding the drain for the rest of its wait.
    stopping: AtomicBool,
    /// Journal bytes no snapshot covers yet: the tail the next start
    /// replays. Moved under the index guard, with the frames it counts.
    grown: AtomicU64,
    /// The size of the newest snapshot: the one this start loaded, then each
    /// one it writes. A restart must not forget it, or its first snapshot
    /// would come due on the floor alone, however large the index.
    snapshot_bytes: AtomicU64,
    /// One snapshot at a time; nothing else takes it.
    snapshotting: Mutex<()>,
    /// Where the scrub is in its pass.
    scrub: Mutex<scrub::Pass>,
    /// When the store opened: the origin of the two write proofs below.
    opened: Instant,
    /// When a real write last became durable on the blob volumes and on the
    /// journal volume, as milliseconds after `opened` plus one; zero until
    /// one does, and zero again the moment one is refused.
    blobs_proof: AtomicU64,
    journal_proof: AtomicU64,
    #[cfg(test)]
    before_scrub_summary: Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    /// Called between a collection's durable frame and its first unlink.
    #[cfg(test)]
    before_gc_unlink: Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
}

impl Store {
    /// Open the volumes, replay the journal, and index the blobs.
    ///
    /// Creates the layout, removes temp leftovers, loads the newest readable
    /// snapshot, replays the frames after it, truncates a torn tail, and
    /// scans the blob volume. Every count reaches the SUMMARY line, so a
    /// crash that cost frames or left leftovers is visible at the next start
    /// (requirement 12).
    ///
    /// Everything below the roots works by name, so the [`Posture`] is
    /// required: it is the proof that the directories holding those names
    /// let nobody but root and this server rename them, and that the roots
    /// and credential files were measured. There is no way to open a store
    /// on volumes whose posture was never decided.
    pub fn open(
        cfg: &StorageConfig,
        server_key: [u8; 32],
        _posture: &Posture,
        log: Log,
    ) -> Result<Store, StoreError> {
        let lock = hold_journal(&cfg.journal_dir, &log)?;
        let started = log.start("store_open", cfg.journal_capacity);
        let mirror_paths: Vec<PathBuf> = cfg.mirrors.iter().map(|m| m.path.clone()).collect();
        let (blobs, leftovers) = Blobs::open(&cfg.blobs_dir, &mirror_paths)?;
        let mut journal = Journal::open(cfg, log.clone())?;
        let (snapshot, skipped) = journal.load_snapshot()?;
        let from_snapshot = snapshot.is_some();
        let (mut index, snapshot_bytes) = snapshot.unwrap_or_default();
        let replay = journal.replay(index.seq, &mut |record| index.apply(record))?;
        let (chunks, strays) = blobs.scan()?;
        let chunk_count = chunks.len() as u64;
        for (sid, len, first_seen) in chunks {
            index.add_chunk(sid, len, first_seen);
        }

        started.summary(
            &log,
            &[
                ("snapshot", Val::flag(from_snapshot)),
                ("snapshots_skipped", Val::count(skipped)),
                ("segments", Val::count(replay.segments)),
                ("frames", Val::count(replay.frames)),
                ("truncated_bytes", Val::bytes(replay.truncated_bytes)),
                ("tmp_removed", Val::count(leftovers)),
                ("chunks", Val::count(chunk_count)),
                ("strays", Val::count(strays)),
                ("bytes", Val::bytes(index.used_bytes)),
                ("seq", Val::seq(index.seq)),
            ],
        );
        if replay.truncated_bytes > 0 {
            log.warn(
                "journal_truncated",
                &[("bytes", Val::bytes(replay.truncated_bytes))],
            );
        }

        Ok(Store {
            cfg: cfg.clone(),
            server_key,
            log,
            _lock: lock,
            blobs,
            chunk_locks: std::array::from_fn(|_| Mutex::new(())),
            journal: Mutex::new(journal),
            versions: Mutex::new(VersionQueue::default()),
            index: Mutex::new(index),
            changed: Condvar::new(),
            stopping: AtomicBool::new(false),
            // The tail this start replayed is a tail the next start replays
            // too, until a snapshot covers it.
            grown: AtomicU64::new(replay.bytes),
            snapshot_bytes: AtomicU64::new(snapshot_bytes),
            snapshotting: Mutex::new(()),
            // Every chunk is pending verification when the process starts: a
            // scrub pass that only ever runs against this process's memory
            // would never re-check anything after a restart.
            scrub: Mutex::new(scrub::Pass::new(UnixMs::now())),
            opened: Instant::now(),
            blobs_proof: AtomicU64::new(0),
            journal_proof: AtomicU64::new(0),
            #[cfg(test)]
            before_scrub_summary: Mutex::new(None),
            #[cfg(test)]
            before_gc_unlink: Mutex::new(None),
        })
    }

    /// The logger this store was opened with.
    ///
    /// One process, one sink: the API lane and the storage engine write to
    /// the same place, and there is no second logger to configure
    /// differently by accident.
    pub fn log(&self) -> Log {
        self.log.clone()
    }

    fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().expect("index lock")
    }

    fn journal(&self) -> MutexGuard<'_, Journal> {
        self.journal.lock().expect("journal lock")
    }

    fn chunk_guard(&self, sid: &Sid) -> MutexGuard<'_, ()> {
        self.chunk_locks[usize::from(sid.as_bytes()[0])]
            .lock()
            .expect("chunk lock")
    }

    /// GC must never hold most stripes while waiting on one slow upload.
    /// Try once in order, releasing all acquired guards on contention.
    fn try_all_chunks(&self) -> Option<Vec<MutexGuard<'_, ()>>> {
        let mut guards = Vec::with_capacity(self.chunk_locks.len());
        for lock in &self.chunk_locks {
            match lock.try_lock() {
                Ok(guard) => guards.push(guard),
                Err(std::sync::TryLockError::WouldBlock) => return None,
                Err(std::sync::TryLockError::Poisoned(_)) => panic!("chunk lock poisoned"),
            }
        }
        Some(guards)
    }

    /// The one-time pad a device secret rests under.
    ///
    /// XOR with an HKDF output: applying it twice returns the original, so
    /// this is both the wrap and the unwrap.
    fn wrap(&self, info: &[u8], secret: &[u8; 32]) -> [u8; 32] {
        let pad = hkdf_sha256(&self.server_key, WRAP_SALT, info, 32);
        let mut out = [0u8; 32];
        for (slot, (byte, mask)) in out.iter_mut().zip(secret.iter().zip(pad.iter())) {
            *slot = byte ^ mask;
        }
        out
    }

    // -- chunks ------------------------------------------------------------

    /// Whether the store holds this chunk.
    pub fn chunk_exists(&self, sid: &Sid) -> bool {
        self.index().chunks.contains_key(sid)
    }

    /// Which of `sids` the store does not hold, in the order given.
    pub fn missing_chunks(&self, sids: &[Sid]) -> Vec<Sid> {
        let index = self.index();
        sids.iter()
            .filter(|sid| !index.chunks.contains_key(*sid))
            .copied()
            .collect()
    }

    /// The stored length of a chunk.
    pub fn chunk_len(&self, sid: &Sid) -> Option<u64> {
        self.index().chunks.get(sid).map(|meta| meta.len)
    }

    /// Open a chunk for reading, with its length.
    pub fn open_chunk(&self, sid: &Sid) -> Result<(File, u64), StoreError> {
        self.blobs.open_chunk(sid)
    }

    /// Where a chunk rests on the primary volume, for a response that opens
    /// it only when its stream reaches it (`api::chunks::batch_get`). Never
    /// logged: it is a location (requirement 6).
    pub fn chunk_path(&self, sid: &Sid) -> PathBuf {
        self.blobs.path(sid)
    }

    /// Store one chunk, verifying it as it streams.
    ///
    /// Refusals happen before any byte is published: over the watermark, over
    /// the quota, a body that does not hash to `sid`, a body whose length is
    /// not the declared one. A chunk the store already holds is still read
    /// and verified, then discarded, so the answer to a forged body does not
    /// depend on whether the sid happened to be known.
    pub fn put_chunk(
        &self,
        account: &AccountId,
        sid: &Sid,
        declared_len: u64,
        body: &mut dyn Read,
    ) -> Result<PutOutcome, StoreError> {
        let timed = self.log.timed("chunk_put");
        let mut fields = vec![("sid", Val::sid(sid)), ("bytes", Val::bytes(declared_len))];
        match self.put_chunk_inner(account, sid, declared_len, body) {
            Ok(outcome) => {
                fields.push((
                    "decision",
                    Val::word(match outcome {
                        PutOutcome::Created => "created",
                        PutOutcome::Existed => "existed",
                    }),
                ));
                timed.done(&fields);
                Ok(outcome)
            }
            Err(e) => {
                fields.push(("decision", Val::word(e.code())));
                fields.extend(error_fields(&e));
                timed.refused(&fields);
                Err(e)
            }
        }
    }

    fn put_chunk_inner(
        &self,
        account: &AccountId,
        sid: &Sid,
        declared_len: u64,
        body: &mut dyn Read,
    ) -> Result<PutOutcome, StoreError> {
        let _chunk = self.chunk_guard(sid);
        {
            let index = self.index();
            let stored = index.account().ok_or(StoreError::NotSetUp)?;
            if stored.account_id != *account {
                return Err(StoreError::NotSetUp);
            }
            if index.chunks.contains_key(sid) {
                drop(index);
                match self.blobs.open_chunk(sid) {
                    Ok(_) => {
                        self.blobs.drain(sid, declared_len, body)?;
                        return Ok(PutOutcome::Existed);
                    }
                    Err(StoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                        // A prior unlink whose directory fsync failed retains
                        // conservative inventory. Never drain recovery bytes
                        // against it: persist the absence before replacing it.
                        self.blobs.sync_absence(sid)?;
                        self.index().forget_chunk(sid);
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        {
            let index = self.index();
            let stored = index.account().ok_or(StoreError::NotSetUp)?;
            let watermark = self.cfg.free_watermark.bytes_for(self.cfg.blobs_capacity);
            let free = self.cfg.blobs_capacity.saturating_sub(index.used_bytes);
            if free.saturating_sub(declared_len) < watermark {
                return Err(StoreError::VolumeFull { free, watermark });
            }
            if let Some(quota) = stored.quota_bytes {
                let used = index.used_bytes.saturating_add(declared_len);
                if used > quota {
                    return Err(StoreError::QuotaExceeded { used, quota });
                }
            }
        }
        let written = self.blobs.write(sid, declared_len, body);
        self.prove(&self.blobs_proof, written.as_ref().map(|_| ()));
        written?;
        self.index().add_chunk(*sid, declared_len, UnixMs::now());
        Ok(PutOutcome::Created)
    }

    // -- versions ----------------------------------------------------------

    /// Append one version, or recognise a repost of one already stored.
    ///
    /// The posted `version_id` is checked against the server's own
    /// recomputation before anything else is trusted, so a client cannot name
    /// a version whose content it did not supply.
    pub fn append_version(&self, v: NewVersion) -> Result<AppendOutcome, StoreError> {
        self.append(v, false, None)
    }

    /// A device's version post: the version, and the `edit` activity event
    /// an accepted post records, made durable by ONE fsync.
    ///
    /// Both frames are the ones a post has always journalled, in the same
    /// order at consecutive seqs, so every server that replays this journal
    /// derives the same device activity from it; only the second fsync is
    /// gone. A post answered with a version the store already held writes
    /// neither.
    pub fn post_version(
        &self,
        v: NewVersion,
        accept_existing: bool,
        edit: SeenEvent,
    ) -> Result<AppendOutcome, StoreError> {
        self.append(v, accept_existing, Some(edit))
    }

    /// The same, for a caller that will store the version id the answer
    /// names.
    ///
    /// A post that says exactly what a version this store already holds
    /// says -- the same parent set, the same chunk list, the same tombstone
    /// flag -- is answered with THAT version's id and its seq, and no frame
    /// is written (issue #114). Two entry points rather than a field on
    /// [`NewVersion`], because the promise is the CALLER's: a client that
    /// keeps the id it computed must use [`Store::append_version`], or it
    /// would remember a version this store never held and reconcile its
    /// next edit against nothing.
    pub fn append_version_idempotent(&self, v: NewVersion) -> Result<AppendOutcome, StoreError> {
        self.append(v, true, None)
    }

    fn append(
        &self,
        v: NewVersion,
        accept_existing: bool,
        edit: Option<SeenEvent>,
    ) -> Result<AppendOutcome, StoreError> {
        let timed = self.log.timed("version_append");
        let mut fields = vec![
            ("file", Val::file(&v.file_id)),
            ("domain", Val::domain(&v.domain_id)),
            ("device", Val::device(&v.device_id)),
            ("bytes", Val::bytes(v.bytes)),
            ("chunks", Val::count(v.sids.len() as u64)),
        ];
        let (answer, batch) = self.append_grouped(v, accept_existing, edit);
        match answer {
            Ok(outcome) => {
                fields.push(("seq", Val::seq(outcome.seq)));
                fields.push(("conflicted", Val::flag(outcome.conflicted)));
                fields.push(("decision", Val::word(outcome.decision.as_str())));
                if outcome.decision == AppendDecision::Deduplicated {
                    // The id the caller did NOT post, and the one it is now
                    // expected to store: the only line that states it.
                    fields.push(("version", Val::version(&outcome.version_id)));
                }
                if outcome.decision == AppendDecision::Appended {
                    // How many posts the one fsync that made this one durable
                    // carried: the group commit, visible on every post.
                    fields.push(("batch", Val::count(batch as u64)));
                }
                timed.done(&fields);
                Ok(outcome)
            }
            Err(e) => {
                fields.push(("decision", Val::word(e.code())));
                fields.extend(error_fields(&e));
                timed.refused(&fields);
                Err(e)
            }
        }
    }

    /// Queue one post for the journal and wait for its answer: GROUP COMMIT.
    ///
    /// Posts that arrive while an fsync is in flight are made durable by the
    /// next one, together. The journal mutex elects the leader: whoever holds
    /// it takes the queued posts (at most one per file, in arrival order),
    /// checks each against the index as it stands, writes the frames of every
    /// one that appends, fsyncs ONCE, applies them, and leaves every member
    /// its answer. A member reads its answer only while it holds the journal
    /// mutex, and the leader keeps that mutex until the fsync has returned and
    /// the index shows the frames: no post is answered before it is durable,
    /// and no reader sees a frame that is not (`docs/storage.md`, durability
    /// rule 6). A batch the volume refuses is rolled back whole by the
    /// journal, and each member is then tried alone.
    ///
    /// Batched posts name DISTINCT files, which is what makes checking them
    /// together the same as checking them one after another: a post reads its
    /// own file's graph, the device, the account and the chunk inventory, and
    /// its frames change only its own file's graph and the device's activity,
    /// so no member's check can depend on another member's frames. A second
    /// post for a file already in the batch waits for the next turn, and sees
    /// the first.
    ///
    /// Returns the answer and how many posts its fsync carried.
    fn append_grouped(
        &self,
        v: NewVersion,
        accept_existing: bool,
        edit: Option<SeenEvent>,
    ) -> Answer {
        let expected = version_id_of(&v.file_id, &v.parents, &v.manifest_ct, &v.sids);
        if expected != v.version_id {
            let actual = v.version_id;
            return (Err(StoreError::VersionIdMismatch { expected, actual }), 0);
        }
        let ticket = self.versions().enqueue(Queued {
            v,
            accept_existing,
            edit,
        });
        let mut journal = self.journal();
        loop {
            let batch = {
                let mut queue = self.versions();
                if let Some(answer) = queue.answered.remove(&ticket) {
                    return answer;
                }
                queue.batch()
            };
            // Never empty: this post has no answer, and while this thread
            // holds the journal no other leader is part way through a batch,
            // so the post is still queued and a batch takes the oldest post.
            assert!(!batch.is_empty(), "an unanswered post left the queue");
            let answers = self.commit_batch(&mut journal, batch);
            self.versions().answered.extend(answers);
        }
    }

    fn versions(&self) -> MutexGuard<'_, VersionQueue> {
        self.versions.lock().expect("version queue lock")
    }

    /// Posts waiting for the journal right now. Tests only.
    #[cfg(test)]
    pub(crate) fn queued_versions(&self) -> usize {
        self.versions().waiting.len()
    }

    /// One turn of the journal: check every member, make the frames of those
    /// that append durable with one fsync, and answer them all.
    fn commit_batch(&self, journal: &mut Journal, batch: Vec<(u64, Queued)>) -> Vec<(u64, Answer)> {
        let index = self.index();
        let mut answers = Vec::with_capacity(batch.len());
        let mut writers = Vec::new();
        for (ticket, post) in batch {
            match Self::check_version(&index, &post.v, post.accept_existing) {
                Ok(None) => writers.push((ticket, post)),
                Ok(Some(held)) => answers.push((ticket, (Ok(held), 0))),
                Err(e) => answers.push((ticket, (Err(e), 0))),
            }
        }
        if writers.is_empty() {
            return answers;
        }
        match self.write_versions(journal, index, &writers) {
            Ok(outcomes) => {
                let carried = writers.len();
                answers.extend(
                    writers
                        .into_iter()
                        .zip(outcomes)
                        .map(|((ticket, _), outcome)| (ticket, (Ok(outcome), carried))),
                );
            }
            // A batch refused -- by the watermark, by the volume -- was
            // rolled back whole (durability rule 3). Each post is then tried
            // alone, as it would have been without a batch: refused only when
            // its OWN frames do not fit, told its OWN failure, and a journal
            // the refusal faulted refuses each at once without touching the
            // volume again.
            Err(_) if writers.len() > 1 => {
                for member in writers {
                    answers.extend(self.commit_batch(journal, vec![member]));
                }
            }
            Err(e) => {
                let (ticket, _) = writers.pop().expect("one writer");
                answers.push((ticket, (Err(e), 0)));
            }
        }
        answers
    }

    /// Append the checked posts' frames with one fsync for all of them, and
    /// read their outcomes from the index they were then applied to.
    fn write_versions(
        &self,
        journal: &mut Journal,
        index: MutexGuard<'_, Index>,
        writers: &[(u64, Queued)],
    ) -> Result<Vec<AppendOutcome>, StoreError> {
        let now = UnixMs::now();
        let first = self.commit(journal, index, |first| {
            let mut seq = first;
            let mut frames = Vec::with_capacity(writers.len() * 2);
            for (_, post) in writers {
                let v = &post.v;
                frames.push(Frame::Version(VersionRecord {
                    file_id: v.file_id,
                    domain_id: v.domain_id,
                    version_id: v.version_id,
                    parents: v.parents.clone(),
                    sids: v.sids.clone(),
                    bytes: v.bytes,
                    manifest_ct: v.manifest_ct.clone(),
                    manifest_nonce: v.manifest_nonce,
                    device_id: v.device_id,
                    ts: now,
                    deleted: v.deleted,
                    seq,
                }));
                seq = seq.next();
                if let Some(event) = &post.edit {
                    frames.push(Frame::Seen {
                        device_id: v.device_id,
                        event: event.clone(),
                    });
                    seq = seq.next();
                }
            }
            frames
        })?;
        let index = self.index();
        let mut seq = first;
        let outcomes = writers
            .iter()
            .map(|(_, post)| {
                let entry = index
                    .files
                    .get(&post.v.file_id)
                    .expect("the version's file");
                let outcome = AppendOutcome {
                    seq,
                    version_id: post.v.version_id,
                    heads: entry.heads.clone(),
                    conflicted: entry.conflicted,
                    decision: AppendDecision::Appended,
                };
                seq = Seq(seq.0 + if post.edit.is_some() { 2 } else { 1 });
                outcome
            })
            .collect();
        drop(index);
        self.changed.notify_all();
        Ok(outcomes)
    }

    /// Whether one post may append against the index as it stands:
    /// `Ok(None)` when it may, `Ok(Some(_))` for a version the store already
    /// holds (or, for a caller that accepts one, its twin), and the refusal
    /// otherwise. Reads nothing a version frame of ANOTHER file changes
    /// (`Store::append_grouped`).
    fn check_version(
        index: &Index,
        v: &NewVersion,
        accept_existing: bool,
    ) -> Result<Option<AppendOutcome>, StoreError> {
        match index.account_id() {
            Some(id) if id == v.account_id => {}
            _ => return Err(StoreError::NotSetUp),
        }
        let device = index
            .devices
            .get(&v.device_id)
            .ok_or(StoreError::UnknownDevice)?;
        // Only an active device writes. Authentication refuses a pending or
        // revoked device first; this is the second wall, so a future caller
        // that forgets the first cannot append on an unapproved credential.
        match device.record.state {
            DeviceState::Active => {}
            DeviceState::Pending => return Err(StoreError::DevicePending),
            DeviceState::Revoked => return Err(StoreError::DeviceRevoked),
        }
        // A file never changes domain (`docs/architecture.md` 5.1 item 4).
        // Allowing it would let one version move a file into or out of a
        // domain somebody had been granted, which is the whole authorization
        // decision phase 2 will make.
        if let Some(entry) = index.files.get(&v.file_id)
            && entry.domain_id != v.domain_id
        {
            return Err(StoreError::DomainMismatch {
                expected: entry.domain_id,
                actual: v.domain_id,
            });
        }
        if let Some(existing) = index.version(&v.file_id, &v.version_id) {
            let entry = index.files.get(&v.file_id).expect("the version's file");
            return Ok(Some(AppendOutcome {
                seq: existing.seq,
                version_id: v.version_id,
                heads: entry.heads.clone(),
                conflicted: entry.conflicted,
                decision: AppendDecision::Existed,
            }));
        }
        // A DIFFERENT ID FOR A POSITION THE GRAPH ALREADY HOLDS.
        //
        // Two devices resolving the same conflict to the same bytes post the
        // same parents and the same chunks under two ids, because the id
        // covers the encrypted manifest and its nonce: the file forks, and
        // closing it costs another version (issue #114). The second post is
        // answered with the first version's id instead, and no frame is
        // written. Only for a caller that said it will store the id it is
        // given (`Store::append_version_idempotent`): one that keeps its own
        // id would remember a version this store never held.
        if accept_existing
            && let Some((seq, version_id)) = index.twin(&v.file_id, &v.parents, &v.sids, v.deleted)
        {
            let entry = index.files.get(&v.file_id).expect("the twin's file");
            return Ok(Some(AppendOutcome {
                seq,
                version_id,
                heads: entry.heads.clone(),
                conflicted: entry.conflicted,
                decision: AppendDecision::Deduplicated,
            }));
        }
        let missing: Vec<Sid> = v
            .sids
            .iter()
            .filter(|sid| !index.chunks.contains_key(*sid))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(StoreError::MissingChunks(missing));
        }
        // A version becomes a head, and every head rides in every response
        // that names the file. The ceiling is decided here, in the function
        // that would otherwise write the frame, so nothing already stored
        // moves when it is reached: the refusal is the whole effect
        // (`docs/protocol.md`, "Limits and headers").
        let heads = index.heads_after(&v.file_id, &v.parents);
        if heads > FILE_MAX_HEADS {
            return Err(StoreError::TooManyHeads {
                heads,
                max: FILE_MAX_HEADS,
            });
        }
        Ok(None)
    }

    /// A file with its heads and its retained versions, newest first.
    pub fn file(&self, file_id: &FileId) -> Option<FileRecord> {
        self.index()
            .file(file_id, self.cfg.retention_versions as usize)
    }

    /// One version of one file.
    pub fn version(&self, file_id: &FileId, version_id: &VersionId) -> Option<VersionRecord> {
        self.index().version(file_id, version_id)
    }

    /// One page of the file listing, ordered by file id.
    pub fn files_page(
        &self,
        after: Option<&FileId>,
        limit: usize,
    ) -> (Vec<FileSummary>, Option<FileId>) {
        self.index().files_page(after, limit)
    }

    /// The change feed after `since`.
    pub fn changes(&self, since: Seq, limit: usize) -> Result<Changes, StoreError> {
        self.index().changes(since, limit)
    }

    /// When each version after `since` landed, at most `limit` of them.
    pub fn version_times(&self, since: Seq, limit: usize) -> Vec<UnixMs> {
        self.index().version_times(since, limit)
    }

    /// The journal head.
    pub fn head_seq(&self) -> Seq {
        self.index().seq
    }

    /// Retained versions and files, as the index already counts them.
    ///
    /// The dashboard overview states both on every page load, so it reads two
    /// lengths under the index lock rather than walking the vault.
    pub fn counts(&self) -> (u64, u64) {
        let index = self.index();
        (index.feed.len() as u64, index.files.len() as u64)
    }

    /// Block until the head passes `since`, until `timeout` elapses, or until
    /// the server is stopping.
    pub fn wait_for_change(&self, since: Seq, timeout: Duration) -> Seq {
        let index = self.index();
        let (index, _) = self
            .changed
            .wait_timeout_while(index, timeout, |index| {
                index.seq <= since && !self.stopping.load(Ordering::SeqCst)
            })
            .expect("index lock");
        index.seq
    }

    /// Answer every long-poll now, and every later one at once: the server
    /// is stopping, and a poll left waiting holds the drain for the rest of
    /// its 55 s. The flag is set before the index guard is taken, so a poll
    /// either sees it or is already waiting when the wake arrives.
    pub fn release_waiters(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        drop(self.index());
        self.changed.notify_all();
    }

    // -- account and devices ----------------------------------------------

    /// Create the one account. Valid once (docs/protocol.md, `/v1/setup`).
    pub fn setup(&self, name: &str) -> Result<AccountId, StoreError> {
        self.setup_with_recovery(name, None, UnixMs::now())
    }

    /// Create an account and its optional recovery verifier in one durable
    /// frame; a verifier is registered at `now`.
    ///
    /// # Errors
    /// An existing account, randomness failure, or a refused journal append.
    pub fn setup_with_recovery(
        &self,
        name: &str,
        recovery_verifier: Option<String>,
        now: UnixMs,
    ) -> Result<AccountId, StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        if index.account.is_some() {
            return Err(StoreError::AlreadySetUp);
        }
        let account_id = AccountId::new(random_bytes::<16>()?);
        self.commit(&mut journal, index, |_| {
            vec![Frame::Account {
                account_id,
                name: name.to_string(),
                created: UnixMs::now(),
                quota_bytes: None,
                recovery_registered: recovery_verifier.as_ref().map(|_| now),
                recovery_verifier,
                recovery_cleared: None,
            }]
        })?;
        self.log
            .info("setup", &[("account", Val::account(&account_id))]);
        Ok(account_id)
    }

    /// Register recovery once, at `now`; a different verifier cannot replace
    /// the original. Only the operator's reset clears it
    /// ([`Store::reset_recovery`]). Registering spends the re-enrolment that
    /// reset armed, whoever registers.
    ///
    /// # Errors
    /// An absent account or a refused journal append.
    pub fn register_recovery(&self, verifier: &str, now: UnixMs) -> Result<bool, StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        let account = index.account.clone().ok_or(StoreError::NotSetUp)?;
        if let Some(existing) = &account.recovery_verifier {
            return Ok(obsync_core::ct::eq(
                existing.as_bytes(),
                verifier.as_bytes(),
            ));
        }
        self.commit(&mut journal, index, |_| {
            vec![account_frame(
                account,
                Some(verifier.to_string()),
                Some(now),
                None,
            )]
        })?;
        // Once per account: the request line beside it names the device.
        self.log.info(
            "recovery_registered",
            &[("decision", Val::word("registered")), ("at", Val::ts(now))],
        );
        Ok(true)
    }

    /// Forget the account's recovery verifier and arm one re-enrolment, at
    /// `now`: the operator's reset (`obsyncd recovery reset apply`,
    /// `docs/recovery.md`), which rotates the setup token before it calls this.
    /// Reachable from the server's own volumes only, never over HTTP.
    /// Afterwards the account's last active device cannot be revoked, and the
    /// first registration of a verifier spends the arm: a device that opens
    /// the vault, or one recovery with the new token (`api::setup::create`).
    ///
    /// Returns whether there was a verifier to forget.
    ///
    /// # Errors
    /// `NotSetUp`, or a refused journal append.
    pub fn reset_recovery(&self, now: UnixMs) -> Result<bool, StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        let account = index.account.clone().ok_or(StoreError::NotSetUp)?;
        let had = account.recovery_verifier.is_some();
        self.commit(&mut journal, index, |_| {
            vec![account_frame(account, None, None, Some(now))]
        })?;
        Ok(had)
    }

    /// The account, with the usage the volumes actually hold.
    pub fn account(&self) -> Option<AccountRecord> {
        self.index().account()
    }

    /// Pair a device. The secret is wrapped before it reaches the journal.
    pub fn create_device(&self, d: NewDevice) -> Result<DeviceRecord, StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        match index.account_id() {
            Some(id) if id == d.account_id => {}
            _ => return Err(StoreError::NotSetUp),
        }
        let device_id = DeviceId::new(random_bytes::<16>()?);
        let record = DeviceRecord {
            device_id,
            account_id: d.account_id,
            name: d.name,
            platform: d.platform,
            app_version: d.app_version,
            created: UnixMs::now(),
            last_seen: None,
            last_sign_in: None,
            last_edit: None,
            address: None,
            country: None,
            policy: DevicePolicy::default(),
            state: d.state,
            archived: false,
        };
        let wrapped = self.wrap(device_id.as_bytes(), &d.secret);
        let stored = record.clone();
        self.commit(&mut journal, index, |_| {
            vec![Frame::Device {
                record: stored,
                wrapped,
            }]
        })?;
        self.log.info(
            "device_created",
            &[
                ("device", Val::device(&device_id)),
                ("state", Val::word(d.state.as_word())),
            ],
        );
        Ok(record)
    }

    /// One device.
    pub fn device(&self, id: &DeviceId) -> Option<DeviceRecord> {
        self.index().devices.get(id).map(|e| e.record.clone())
    }

    /// The device's secret, or `None` when it is unknown or revoked.
    ///
    /// Revocation destroys the wrapped secret, so this returning `None` is
    /// the same fact as the secret no longer existing.
    pub fn device_secret(&self, id: &DeviceId) -> Option<[u8; 32]> {
        let index = self.index();
        let entry = index.devices.get(id)?;
        if entry.record.revoked() {
            return None;
        }
        Some(self.wrap(id.as_bytes(), &entry.wrapped))
    }

    /// Every device, in id order.
    pub fn devices(&self) -> Vec<DeviceRecord> {
        self.index()
            .devices
            .values()
            .map(|e| e.record.clone())
            .collect()
    }

    /// How many devices can sync: the active ones and those still pairing.
    /// A revoked device, archived or not, is kept as a record and is not one
    /// of them (issue #268).
    pub fn working_device_count(&self) -> u64 {
        let index = self.index();
        let working = index
            .devices
            .values()
            .filter(|e| e.record.state != DeviceState::Revoked)
            .count();
        working as u64
    }

    /// Change a device's name, policy or reported version.
    pub fn update_device(
        &self,
        id: &DeviceId,
        name: Option<String>,
        policy: Option<DevicePolicy>,
        app_version: Option<String>,
    ) -> Result<DeviceRecord, StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        if !index.devices.contains_key(id) {
            return Err(StoreError::UnknownDevice);
        }
        self.commit(&mut journal, index, |_| {
            vec![Frame::DeviceUpdate {
                device_id: *id,
                name,
                policy,
                app_version,
                archived: None,
            }]
        })?;
        Ok(self.index().devices[id].record.clone())
    }

    /// Activate a pending device: the pairing's creator approved it
    /// (docs/architecture.md §4.2). Activating an already active device is a
    /// no-op, so a repeated approval is harmless.
    ///
    /// # Errors
    /// `UnknownDevice` when there is no such device, `DeviceRevoked` when it
    /// is revoked: revocation destroys the wrapped secret and no approval
    /// brings it back.
    pub fn activate_device(&self, id: &DeviceId) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        let state = index
            .devices
            .get(id)
            .map(|entry| entry.record.state)
            .ok_or(StoreError::UnknownDevice)?;
        match state {
            DeviceState::Active => return Ok(()),
            DeviceState::Revoked => return Err(StoreError::DeviceRevoked),
            DeviceState::Pending => {}
        }
        self.commit(&mut journal, index, |_| {
            vec![Frame::DeviceActivate { device_id: *id }]
        })?;
        self.log.info(
            "device_activated",
            &[
                ("device", Val::device(id)),
                ("decision", Val::word("approved")),
            ],
        );
        Ok(())
    }

    /// Revoke a device -- every later request from it fails -- unless it is
    /// the account's only ACTIVE one.
    ///
    /// The count and the append happen under ONE hold of the index lock, so
    /// the refusal cannot be raced. An API-level check could not: it reads
    /// the device list, releases the lock, and decides against a count that
    /// another request has already changed, so two devices revoking each
    /// other concurrently both saw two and both wrote. What that leaves is
    /// permanent -- `POST /v1/setup` answers `409 already_set_up` forever
    /// and only a paired device can open a pairing, so an account with no
    /// active device can never sync again (`docs/recovery.md`). There is
    /// deliberately no unguarded revoke beside this one, and no unguarded
    /// delete either: [`Store::delete_device`] takes a PENDING device only,
    /// so the rejected-claim path cannot reach a paired one (issue #88).
    /// [`Store::archive_device`] destroys nothing at all.
    ///
    /// A device waiting for pairing approval is not a way out of the
    /// refusal: it holds no vault key and cannot pair a replacement.
    ///
    /// A registered recovery key lifts the refusal, because the setup token
    /// and the vault's phrase re-enrol a device (`docs/recovery.md`) -- but
    /// not for [`RECOVERY_HOLD_MS`] after it was registered, measured against
    /// `now`. Any device credential can register the first key, and one the
    /// vault key never produced must not be able to end every credential the
    /// key's own devices hold before they have said so (`409
    /// recovery_mismatch` at their next start). A key with no registration
    /// time was registered before 1.1.5 and keeps the older rule: the hold
    /// guards an account that had NO key, and every key such an account gets
    /// from 1.1.5 on carries its time. A clock behind the registration reads
    /// as age zero, so a clock stepped back holds longer, never shorter.
    ///
    /// # Errors
    /// `UnknownDevice` when there is no such device, `LastActiveDevice` when
    /// it is the only active one and no recovery key is registered,
    /// `RecoveryTooNew` when that key is younger than the hold.
    pub fn revoke_device_unless_last(&self, id: &DeviceId, now: UnixMs) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        let target_is_active = index
            .devices
            .get(id)
            .ok_or(StoreError::UnknownDevice)?
            .record
            .active();
        let active = index.devices.values().filter(|e| e.record.active()).count();
        if target_is_active && active <= 1 {
            let account = index.account.as_ref();
            if account.is_none_or(|a| a.recovery_verifier.is_none()) {
                return Err(StoreError::LastActiveDevice);
            }
            if let Some(registered) = account.and_then(|a| a.recovery_registered) {
                let age = now.0.saturating_sub(registered.0);
                if age < RECOVERY_HOLD_MS {
                    self.log.warn(
                        "device_revoke_refused",
                        &[
                            ("device", Val::device(id)),
                            ("decision", Val::word("refused")),
                            ("reason", Val::word("recovery_too_new")),
                            ("recovery_age_ms", Val::ms(age)),
                            ("budget_ms", Val::ms(RECOVERY_HOLD_MS)),
                        ],
                    );
                    return Err(StoreError::RecoveryTooNew);
                }
            }
        }
        self.commit(&mut journal, index, |_| {
            vec![Frame::DeviceRevoke { device_id: *id }]
        })?;
        self.log.info(
            "device_revoked",
            &[
                ("device", Val::device(id)),
                ("decision", Val::word("revoked")),
            ],
        );
        Ok(())
    }

    /// Delete a device outright: a claim nobody approved, and nothing else.
    ///
    /// THE SECOND WALL. Deletion destroys the record, which is not what
    /// revocation does: `revoke_device_unless_last` keeps the row, zeroes the
    /// wrapped secret and refuses the last active device, so an account can
    /// never be left with nothing that syncs. A delete carries none of that,
    /// so the state check belongs here as well as in the pairing table that
    /// reaches it: a reject arriving after the approval used to delete a
    /// paired, syncing device (issue #88), and every caller this store has --
    /// a rejected claim, an expired claim, a claim whose pairing did not
    /// survive a restart -- names a PENDING device by construction. Anything
    /// else is refused, under the same hold of the index lock as the append,
    /// so the state a delete was decided on cannot change underneath it.
    ///
    /// # Errors
    /// `UnknownDevice` when there is no such device, `DeviceNotPending` when
    /// it is active or revoked.
    pub fn delete_device(&self, id: &DeviceId) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        let state = index
            .devices
            .get(id)
            .map(|entry| entry.record.state)
            .ok_or(StoreError::UnknownDevice)?;
        if state != DeviceState::Pending {
            return Err(StoreError::DeviceNotPending);
        }
        self.commit(&mut journal, index, |_| {
            vec![Frame::DeviceDelete { device_id: *id }]
        })?;
        self.log.info(
            "device_deleted",
            &[
                ("device", Val::device(id)),
                ("decision", Val::word("deleted")),
            ],
        );
        Ok(())
    }

    /// Archive a REVOKED device: it leaves the routine device lists, and
    /// everything else about it stays (issue #247).
    ///
    /// NOTHING IS DESTROYED. The record is what answers that device `403
    /// device_revoked` rather than the answer an unknown id gets, and it is
    /// what names the versions it wrote wherever history is read, so a device
    /// list without it is a shorter list and not a shorter memory. The flag
    /// rides the ordinary `DeviceUpdate` frame, fsynced with every other
    /// write before the answer, and a server that predates the flag replays
    /// that frame as the no-op update it reads.
    ///
    /// Only a revoked device, decided under the same hold of the index lock
    /// as the append: a device that still syncs is revoked first, so a person
    /// can never tidy away a device that is still allowed in, and a pending
    /// one is a claim its pairing removes.
    ///
    /// # Errors
    /// `UnknownDevice` when there is no such device, `DeviceNotRevoked` when
    /// it is active or pending.
    pub fn archive_device(&self, id: &DeviceId) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        let state = index
            .devices
            .get(id)
            .map(|entry| entry.record.state)
            .ok_or(StoreError::UnknownDevice)?;
        if state != DeviceState::Revoked {
            return Err(StoreError::DeviceNotRevoked);
        }
        self.commit(&mut journal, index, |_| {
            vec![Frame::DeviceUpdate {
                device_id: *id,
                name: None,
                policy: None,
                app_version: None,
                archived: Some(true),
            }]
        })?;
        Ok(())
    }

    /// Record a device sign-in, edit or heartbeat.
    pub fn record_seen(&self, id: &DeviceId, ev: SeenEvent) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        if !index.devices.contains_key(id) {
            return Err(StoreError::UnknownDevice);
        }
        self.commit(&mut journal, index, |_| {
            vec![Frame::Seen {
                device_id: *id,
                event: ev,
            }]
        })?;
        Ok(())
    }

    /// A device's recent activity, newest first.
    pub fn seen_history(&self, id: &DeviceId, limit: usize) -> Vec<SeenEvent> {
        let index = self.index();
        match index.devices.get(id) {
            Some(entry) => entry.seen.iter().rev().take(limit).cloned().collect(),
            None => Vec::new(),
        }
    }

    // -- domains -----------------------------------------------------------

    /// Whether any file the store holds is in this domain.
    ///
    /// A domain exists because a file is in it: file records carry the domain
    /// (`docs/architecture.md` 5.1 item 4), so a separate ledger of declared
    /// domains would be a second answer to one question.
    pub fn domain_exists(&self, id: &DomainId) -> bool {
        self.index()
            .files
            .values()
            .any(|entry| entry.domain_id == *id)
    }

    // -- volumes, collection, integrity ------------------------------------

    /// Usage and thresholds for every volume.
    pub fn volumes(&self) -> Vec<VolumeStatus> {
        let used = self.index().used_bytes;
        let watermark = self.cfg.free_watermark.bytes_for(self.cfg.blobs_capacity);
        let mut all = vec![VolumeStatus {
            role: "blobs".to_string(),
            path: self.cfg.blobs_dir.clone(),
            class_label: self.cfg.blobs_class.clone(),
            bytes_total: self.cfg.blobs_capacity,
            bytes_used: used,
            bytes_free: self.cfg.blobs_capacity.saturating_sub(used),
            watermark_bytes: watermark,
            // The blob volume's usage is the index's own running total, which
            // is read from memory and cannot refuse.
            usage_unverified: false,
        }];
        for mirror in &self.cfg.mirrors {
            all.push(VolumeStatus {
                role: "mirror".to_string(),
                path: mirror.path.clone(),
                class_label: mirror.label.clone(),
                bytes_total: self.cfg.blobs_capacity,
                bytes_used: used,
                bytes_free: self.cfg.blobs_capacity.saturating_sub(used),
                watermark_bytes: watermark,
                usage_unverified: false,
            });
        }
        // The journal's own accounting, not a walk of the volume: it is the
        // number the journal watermark refuses against, and a dashboard that
        // showed a different one would disagree with the refusal.
        // One guard for both, so the figure and the word that qualifies it
        // are read from the same state: a total taken before a failed survey
        // and a flag taken after it would say the number is trustworthy when
        // it is not.
        let journal = self.journal();
        let journal_used = journal.tracked_bytes();
        let journal_unverified = journal.unverified().is_some();
        drop(journal);
        all.push(VolumeStatus {
            role: "journal".to_string(),
            path: self.cfg.journal_dir.clone(),
            class_label: self.cfg.journal_class.clone(),
            bytes_total: self.cfg.journal_capacity,
            bytes_used: journal_used,
            bytes_free: self.cfg.journal_capacity.saturating_sub(journal_used),
            watermark_bytes: self.cfg.free_watermark.bytes_for(self.cfg.journal_capacity),
            // The journal surveys a real directory, so its total is the one
            // that can go stale: while this is true the figure beside it is
            // the last one that was read successfully, and writes are being
            // refused with `journal_unverified` until a survey succeeds.
            usage_unverified: journal_unverified,
        });
        all
    }

    /// Collect chunks no retained version references (docs/storage.md).
    ///
    /// The plan is decided, journalled and applied while every SID stripe,
    /// the journal and the index are held, so a version that lands first is
    /// always respected and no upload can be told a doomed chunk exists.
    /// Then everything is released and each chunk is unlinked under its own
    /// stripe alone, so the volume work stalls nobody but an upload of that
    /// same chunk. That unlink is decided again under the stripe: a chunk
    /// the index holds once more was re-uploaded after the frame forgot it,
    /// and the file standing under its name is that upload, not garbage.
    pub fn gc_run(&self, now: UnixMs) -> GcSummary {
        // Budget zero: collection is bounded by what retention releases, not
        // by bytes, and the SUMMARY line carries the duration it took.
        let started = self.log.start("gc", 0);
        let mut summary = GcSummary {
            started: now,
            duration_ms: 0,
            chunks_collected: 0,
            bytes_collected: 0,
            chunks_retained: 0,
        };
        let collect = {
            let Some(_chunks) = self.try_all_chunks() else {
                self.log
                    .info("gc_skipped", &[("decision", Val::word("chunks_busy"))]);
                summary.duration_ms = started.elapsed_ms();
                summary.chunks_retained = self.index().chunks.len() as u64;
                return summary;
            };
            let mut journal = self.journal();
            let index = self.index();
            let plan = gc::plan(&index, &self.cfg, now);
            summary.chunks_retained = plan.retained_chunks;
            let frame_summary = GcSummary {
                chunks_collected: plan.collect.len() as u64,
                bytes_collected: plan.bytes,
                ..summary.clone()
            };
            let collect = plan.collect.clone();
            if let Err(e) = self.commit(&mut journal, index, |_| {
                vec![Frame::Gc {
                    sids: plan.collect,
                    pruned: plan.pruned,
                    summary: frame_summary.clone(),
                }]
            }) {
                let mut fields = vec![("decision", Val::word(e.code()))];
                fields.extend(error_fields(&e));
                self.log.error("gc_failed", &fields);
                return summary;
            }
            summary = frame_summary;
            collect
        };
        #[cfg(test)]
        if let Some(hook) = self.before_gc_unlink.lock().expect("gc hook").clone() {
            hook();
        }
        let mut failed = 0;
        let mut reuploaded = 0;
        for sid in &collect {
            let _chunk = self.chunk_guard(sid);
            if self.index().chunks.contains_key(sid) {
                reuploaded += 1;
                continue;
            }
            if let Err(e) = self.blobs.remove(sid) {
                failed += 1;
                let mut fields = vec![("sid", Val::sid(sid)), ("decision", Val::word(e.code()))];
                fields.extend(error_fields(&e));
                self.log.warn("gc_unlink_failed", &fields);
            }
        }
        summary.duration_ms = started.elapsed_ms();
        started.summary(
            &self.log,
            &[
                ("chunks", Val::count(summary.chunks_collected)),
                ("bytes", Val::bytes(summary.bytes_collected)),
                ("retained", Val::count(summary.chunks_retained)),
                ("unlink_failed", Val::count(failed)),
                ("reuploaded", Val::count(reuploaded)),
            ],
        );
        summary
    }

    /// Re-hash up to `budget_bytes` of pending chunks, resuming the pass
    /// where the last step left it.
    ///
    /// A chunk whose content no longer matches its sid is repaired from a
    /// mirror when one holds a good copy, and quarantined when none does. The
    /// hashing holds only the SID lock, never the journal or index lock.
    ///
    /// A step is journalled only when it found something -- a mismatch and
    /// what became of it -- or completed the pass; everything else is the
    /// walk's one START and one SUMMARY line. A completed pass rests until
    /// `scrub::PASS_INTERVAL_MS` after it began, or until one is asked for
    /// ([`Store::request_scrub`]); a resting step reads nothing.
    pub fn scrub_step(&self, budget_bytes: u64) -> ScrubSummary {
        let at = Instant::now();
        let now = UnixMs::now();
        let mut pass = self.scrub.lock().expect("scrub pass");
        let mut summary = ScrubSummary {
            started: now,
            duration_ms: 0,
            chunks_verified: 0,
            bytes_verified: 0,
            mismatches: 0,
            quarantined: Vec::new(),
            complete_pass: false,
        };
        if pass.rests(now) {
            return summary;
        }
        if pass.run.is_none() {
            let inventory = self.index().used_bytes;
            pass.run = Some((self.log.start("scrub", inventory), scrub::Totals::default()));
        }
        let (candidates, walked) = scrub::candidates(&self.index(), &pass, budget_bytes);

        let mut verified = 0;
        let mut bytes = 0;
        let mut mismatches = 0;
        let mut repaired = 0;
        let mut failed = false;
        let mut quarantined = Vec::new();
        for (sid, _) in candidates {
            pass.after = Some(sid);
            let _chunk = self.chunk_guard(&sid);
            if !self.index().chunks.contains_key(&sid) {
                continue;
            }
            match self.blobs.verify_primary_measured(&sid) {
                Ok(Some((true, len))) => {
                    verified += 1;
                    bytes += len;
                    self.mark_verified(&sid);
                }
                Ok(Some((false, len))) => {
                    mismatches += 1;
                    bytes += len;
                    match self.repair(&sid) {
                        Ok(true) => {
                            repaired += 1;
                            self.mark_verified(&sid);
                        }
                        Ok(false) => quarantined.push(sid),
                        Err(e) => {
                            failed = true;
                            let mut fields =
                                vec![("sid", Val::sid(&sid)), ("decision", Val::word(e.code()))];
                            fields.extend(error_fields(&e));
                            self.log.error("scrub_repair_failed", &fields);
                        }
                    }
                }
                // A failed primary-directory fsync can leave an absent name
                // conservatively indexed. Make that absence durable before
                // forgetting it. This is recovery of a missing chunk, not a
                // claim that an earlier failed quarantine succeeded.
                Ok(None) => match self.blobs.sync_absence(&sid) {
                    Ok(()) => {
                        self.index().forget_chunk(&sid);
                        self.log.error("chunk_missing", &[("sid", Val::sid(&sid))]);
                    }
                    Err(e) => {
                        failed = true;
                        let mut fields = vec![("sid", Val::sid(&sid))];
                        fields.extend(error_fields(&e));
                        self.log.error("scrub_missing_failed", &fields);
                    }
                },
                Err(e) => {
                    failed = true;
                    let mut fields =
                        vec![("sid", Val::sid(&sid)), ("decision", Val::word(e.code()))];
                    fields.extend(error_fields(&e));
                    self.log.error("scrub_read_failed", &fields);
                }
            }
        }

        #[cfg(test)]
        if let Some(hook) = self
            .before_scrub_summary
            .lock()
            .expect("scrub hook")
            .clone()
        {
            hook();
        }

        summary.chunks_verified = verified + repaired;
        summary.bytes_verified = bytes;
        summary.mismatches = mismatches;
        summary.quarantined = quarantined;
        pass.failed |= failed;
        let mut journal = self.journal();
        summary.complete_pass = walked && !pass.failed && journal.unverified().is_none();
        summary.duration_ms = u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX);
        if summary.complete_pass || summary.mismatches > 0 {
            let frame = summary.clone();
            let index = self.index();
            if let Err(e) = self.commit(&mut journal, index, |_| {
                vec![Frame::Scrub { summary: frame }]
            }) {
                let mut fields = vec![("decision", Val::word(e.code()))];
                fields.extend(error_fields(&e));
                self.log.error("scrub_failed", &fields);
            }
        }
        drop(journal);

        let (run, totals) = pass.run.as_mut().expect("a walk has its START");
        totals.steps += 1;
        totals.chunks += summary.chunks_verified;
        totals.bytes += summary.bytes_verified;
        totals.mismatches += summary.mismatches;
        totals.quarantined += summary.quarantined.len() as u64;
        totals.repaired += repaired;
        totals.worked_ms += summary.duration_ms;
        if walked {
            run.summary(
                &self.log,
                &[
                    ("steps", Val::count(totals.steps)),
                    ("chunks", Val::count(totals.chunks)),
                    ("bytes", Val::bytes(totals.bytes)),
                    ("mismatches", Val::count(totals.mismatches)),
                    ("quarantined", Val::count(totals.quarantined)),
                    ("repaired", Val::count(totals.repaired)),
                    ("worked_ms", Val::ms(totals.worked_ms)),
                    ("complete", Val::flag(summary.complete_pass)),
                ],
            );
            pass.run = None;
            // A complete pass rests. An incomplete one walks again over what
            // is still pending -- the chunks it could not verify -- under the
            // same start, so nothing it did verify is hashed twice.
            if summary.complete_pass {
                pass.resting = true;
                pass.asked = false;
            } else {
                pass.after = None;
                pass.failed = false;
            }
        }
        summary
    }

    /// Install the hook a scrub step calls before its summary. Tests only.
    #[cfg(test)]
    pub(crate) fn set_before_scrub_summary(&self, hook: std::sync::Arc<dyn Fn() + Send + Sync>) {
        *self.before_scrub_summary.lock().expect("scrub hook") = Some(hook);
    }

    /// Ask for a scrub pass now: a resting scrub begins one at its next step
    /// rather than waiting out the interval. A pass already running
    /// satisfies the request.
    pub fn request_scrub(&self) {
        self.scrub.lock().expect("scrub pass").asked = true;
    }

    /// Called while the SID lock still excludes a replacement upload.
    fn mark_verified(&self, sid: &Sid) {
        if let Some(meta) = self.index().chunks.get_mut(sid) {
            meta.last_verified = UnixMs::now();
        }
    }

    /// Repair one bad chunk from a mirror, or quarantine it. The caller holds
    /// the SID lock through this operation and its inventory update.
    fn repair(&self, sid: &Sid) -> Result<bool, StoreError> {
        if self.blobs.repair_from_mirror(sid)? {
            self.log.warn(
                "chunk_repaired",
                &[("sid", Val::sid(sid)), ("decision", Val::word("repaired"))],
            );
            return Ok(true);
        }
        // One journal guard spans admission, the copy/removal and accounting.
        // Re-measure on every exit, including temporary residue and a failed
        // destination sync. A refused survey marks the usage unverified; an
        // unreadable name must never be mistaken for zero bytes.
        let mut journal = self.journal();
        let quarantine = journal.quarantine_dir();
        let (mut source, len) = self.blobs.open_chunk(sid)?;
        self.index().resize_chunk(sid, len);
        journal.admit_quarantine(len)?;
        let outcome = self.blobs.quarantine(sid, &mut source, &quarantine);
        let measured = journal.resurvey("quarantine_after");
        // Inventory follows the blob volume, independently of whether the
        // journal can record the later summary. A successful reupload must
        // not be discarded because that summary failed to append.
        if outcome.is_ok() {
            self.index().forget_chunk(sid);
        }
        drop(journal);
        outcome?;
        measured?;
        self.log.error(
            "chunk_quarantined",
            &[
                ("sid", Val::sid(sid)),
                ("decision", Val::word("quarantined")),
            ],
        );
        Ok(false)
    }

    /// Write an index snapshot so the next start replays less.
    ///
    /// The index is copied under its guard and nothing else -- a copy that
    /// shares every version rather than repeating it -- and the copy is
    /// encoded, written, fsynced and renamed with no guard held, so writers,
    /// readers and the feed go on while it lands. The journal guard is taken
    /// twice and briefly: to start counting the snapshot's bytes toward the
    /// volume as they land, and to drop what it supersedes afterwards.
    pub fn snapshot(&self) -> Result<(), StoreError> {
        let _one = self.snapshotting.lock().expect("snapshot");
        // Budget zero: a snapshot is as large as the index is.
        let started = self.log.start("snapshot", 0);
        let (copy, covered) = {
            let index = self.index();
            (index.snapshot_copy(), self.grown.load(Ordering::SeqCst))
        };
        let slot = self.journal().admit_snapshot();
        let written = slot.write(&copy);
        let bytes = self.journal().finish_snapshot(copy.seq, written)?;
        self.grown.fetch_sub(covered, Ordering::SeqCst);
        self.snapshot_bytes.store(bytes, Ordering::SeqCst);
        started.summary(
            &self.log,
            &[
                ("seq", Val::seq(copy.seq)),
                ("bytes", Val::bytes(bytes)),
                ("covered", Val::bytes(covered)),
            ],
        );
        Ok(())
    }

    /// Journal bytes no snapshot covers yet: what the next start replays.
    pub fn journal_growth(&self) -> u64 {
        self.grown.load(Ordering::SeqCst)
    }

    /// Whether the journal has grown enough since the last snapshot to be
    /// worth a new one: by `floor` bytes, and by at least as much as the
    /// last snapshot weighed, so writing snapshots never costs more than
    /// the journal they replace and a start never replays more than about
    /// twice the index.
    pub fn snapshot_due(&self, floor: u64) -> bool {
        self.journal_growth() >= floor.max(self.snapshot_bytes.load(Ordering::SeqCst))
    }

    /// Record the outcome of a real write on the volume `proof` stands for.
    /// Only the volume's own refusal takes a proof away; a body that did not
    /// hash to its sid says nothing about the disk.
    fn prove(&self, proof: &AtomicU64, written: Result<(), &StoreError>) {
        match written {
            Ok(()) => {
                let since = u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX);
                proof.store(since.saturating_add(1), Ordering::SeqCst);
            }
            Err(StoreError::Io(_)) => proof.store(0, Ordering::SeqCst),
            Err(_) => {}
        }
    }

    /// Whether a real write became durable on the blob volumes, and on the
    /// journal volume, within `window`, with no refusal since.
    ///
    /// Readiness asks whether the volumes take a write (AGENTS.md
    /// requirement 7). A request that just made one durable answered that
    /// with the data path itself, so the synthetic probe need not repeat it;
    /// the moment a real write is refused, the probe is back.
    pub fn written_within(&self, window: Duration) -> (bool, bool) {
        let window = u64::try_from(window.as_millis()).unwrap_or(u64::MAX);
        let now = u64::try_from(self.opened.elapsed().as_millis()).unwrap_or(u64::MAX);
        let fresh = |proof: &AtomicU64| match proof.load(Ordering::SeqCst) {
            0 => false,
            at => now.saturating_add(1).saturating_sub(at) < window,
        };
        (fresh(&self.blobs_proof), fresh(&self.journal_proof))
    }

    /// The last collection run.
    pub fn last_gc(&self) -> Option<GcSummary> {
        self.index().last_gc.clone()
    }

    /// The last scrub step.
    pub fn last_scrub(&self) -> Option<ScrubSummary> {
        self.index().last_scrub.clone()
    }

    /// Re-hash every inventoried or retained-version chunk (`obsyncd check`).
    ///
    /// Returns how many chunks were read, how many bytes, and which failed.
    pub fn verify_chunks(&self) -> Result<(u64, u64, Vec<Sid>), StoreError> {
        let chunks: BTreeSet<Sid> = {
            let index = self.index();
            // One SID per distinct chunk already described by the store;
            // repeated references do not multiply hashing or memory. Include
            // non-head history: absence from the volume is not proof that a
            // retained version no longer needs its ciphertext.
            index
                .chunks
                .keys()
                .copied()
                .chain(
                    index
                        .files
                        .values()
                        .flat_map(|file| &file.versions)
                        .flat_map(|version| version.sids.iter().copied()),
                )
                .collect()
        };
        let mut count = 0;
        let mut bytes = 0;
        let mut bad = Vec::new();
        for sid in chunks {
            match self.blobs.verify_primary_measured(&sid)? {
                Some((true, len)) => {
                    count += 1;
                    bytes += len;
                }
                Some((false, _)) | None => bad.push(sid),
            }
        }
        Ok((count, bytes, bad))
    }

    /// Verify every journal frame's CRC (`obsyncd check`).
    ///
    /// Returns segments read, frames that decode, and frames that do not.
    pub fn verify_journal(&self) -> Result<(u64, u64, u64), StoreError> {
        self.journal().verify()
    }

    /// Re-survey the journal volume, for a start-time write that landed on
    /// it after this store opened.
    ///
    /// # Errors
    /// The volume.
    pub fn resurvey_journal(&self) -> Result<(), StoreError> {
        self.journal().resurvey("start")
    }

    /// The handle the nonce log reports its own size on the journal volume
    /// through (`api/nonce_log.rs`).
    ///
    /// That file is written on every authenticated request, so its bytes
    /// cannot wait for the journal's next survey and cannot be counted by
    /// taking the journal's mutex per request either. It owns its number and
    /// publishes it here.
    pub(crate) fn nonce_bytes(&self) -> std::sync::Arc<std::sync::atomic::AtomicU64> {
        self.journal().nonce_bytes()
    }

    /// The kind of the failure that faulted the journal, if it is faulted.
    ///
    /// A faulted journal takes no more frames until a restart replays and
    /// truncates its tail, so readiness must answer false while it is set:
    /// the volumes can still take a probe write on a server that can no
    /// longer acknowledge anything (AGENTS.md requirement 7).
    pub fn journal_faulted(&self) -> Option<std::io::ErrorKind> {
        self.journal().faulted()
    }

    /// The kind of the failure that refused the journal's last survey, if its
    /// usage figure has not been re-read successfully since.
    ///
    /// Read-only: what readiness reports once [`Store::verify_journal_usage`]
    /// has had its attempt, and what the dashboard shows beside the figure.
    pub fn journal_usage_unverified(&self) -> Option<std::io::ErrorKind> {
        self.journal().unverified()
    }

    /// Re-survey the journal volume IF its usage is unverified, and say
    /// whether it is verified now.
    ///
    /// The recovery path that needs no write. A journal whose survey was
    /// refused admits nothing until a survey succeeds, and until this exists
    /// the only thing that could retry that survey was an append -- so an
    /// operator who fixed the volume had no way to see the server come back
    /// except by sending a write and watching it be accepted. Readiness calls
    /// this, so a fixed volume shows up as `200` on the next probe.
    ///
    /// A no-op when the usage is verified, which is the ordinary case: this
    /// is on an unauthenticated path, and it may not walk the volume on every
    /// probe. When it does walk, the readiness cache bounds how often, and
    /// only a COMPLETE survey clears the state.
    pub fn verify_journal_usage(&self) -> Result<(), std::io::ErrorKind> {
        let mut journal = self.journal();
        if journal.unverified().is_none() {
            return Ok(());
        }
        let outcome = journal.resurvey("readiness");
        match outcome {
            Ok(()) => Ok(()),
            // The kind the survey recorded, which is the one that refused the
            // walk just now rather than whatever refused an earlier one.
            Err(_) => Err(journal.unverified().unwrap_or(std::io::ErrorKind::Other)),
        }
    }

    /// Whether this store's journal mutex is currently held.
    ///
    /// Tests only, and true of a caller that holds it itself: `Mutex` is not
    /// reentrant, so a `try_lock` from inside a guarded region fails. That is
    /// what makes it a proof that a region spans what it claims to.
    #[cfg(test)]
    pub(crate) fn journal_guard_held(&self) -> bool {
        self.journal.try_lock().is_err()
    }

    /// Arm a crash point. Tests only.
    #[cfg(test)]
    pub(crate) fn set_fault(&self, fault: Fault) {
        self.blobs.set_fault(fault);
        self.journal().set_fault(fault);
    }
}

impl Store {
    /// Append frames at the next sequences, make them durable, then apply
    /// them. Returns the first frame's seq; a caller that reads the result
    /// back takes the index again while it still holds the journal guard, so
    /// what it reads is what these frames left.
    ///
    /// The caller holds the journal guard for the whole call, and every
    /// journalled change is made under that guard, so the seqs allocated
    /// here are the next ones the journal writes and the next ones the index
    /// applies: seq order, append order and apply order are one order. The
    /// index guard the caller validated under is released for the write and
    /// the fsync and taken again to apply, so a slow volume stalls the next
    /// writer and nothing else -- readers, the feed and authentication go on
    /// answering from the index as it stood. Journalled metadata changes only
    /// after the record is durable (docs/storage.md, durability rule 6), and
    /// what a writer validated cannot change meanwhile: nothing it reads is
    /// written without the journal guard. Chunk inventory is the exception,
    /// and follows the blob volume as it always has.
    fn commit(
        &self,
        journal: &mut Journal,
        index: MutexGuard<'_, Index>,
        frames: impl FnOnce(Seq) -> Vec<Frame>,
    ) -> Result<Seq, StoreError> {
        let first = index.seq.next();
        let account_id = index.account_id();
        let records: Vec<Record> = frames(first)
            .into_iter()
            .zip(first.0..)
            .map(|(frame, seq)| Record {
                seq: Seq(seq),
                account_id,
                frame,
            })
            .collect();
        drop(index);
        let written = journal.append_all(&records);
        self.prove(&self.journal_proof, written.as_ref().map(|_| ()));
        let bytes = written?;
        let mut index = self.index();
        for record in &records {
            index.apply(record);
        }
        self.grown.fetch_add(bytes, Ordering::SeqCst);
        Ok(first)
    }
}

/// `version_id = SHA-256(file_id || sorted parents || manifest_ct || sids)`
/// (docs/architecture.md §3.4). Parents are sorted by their bytes so two
/// devices that name the same parents in a different order agree.
pub(crate) fn version_id_of(
    file_id: &FileId,
    parents: &[VersionId],
    manifest_ct: &[u8],
    sids: &[Sid],
) -> VersionId {
    let mut sorted: Vec<[u8; 32]> = parents.iter().map(|p| *p.as_bytes()).collect();
    sorted.sort_unstable();
    let mut hasher = Sha256::new();
    hasher.update(file_id.as_bytes());
    for parent in &sorted {
        hasher.update(parent);
    }
    hasher.update(manifest_ct);
    for sid in sids {
        hasher.update(sid.as_bytes());
    }
    VersionId::new(hasher.finalize())
}

/// The numbers a refusal was decided on, for its log line (requirement 12).
///
/// Every line that states a `StoreError` extends its fields with this, so the
/// facts a refusal was decided on are stated in exactly one grammar and no
/// site can quietly state fewer. `StoreError::Io` maps to the closed
/// `io::ErrorKind` name and nothing else: a message can carry a path, a kind
/// cannot (requirement 6, `Val::io`).
pub(crate) fn error_fields(e: &StoreError) -> Vec<(&'static str, Val)> {
    match e {
        StoreError::VolumeFull { free, watermark }
        | StoreError::JournalFull { free, watermark } => vec![
            ("free", Val::bytes(*free)),
            ("watermark", Val::bytes(*watermark)),
        ],
        StoreError::JournalFaulted { io, rollback_io } => vec![
            ("io", Val::io_kind(*io)),
            ("rollback_io", Val::io_kind(*rollback_io)),
        ],
        StoreError::JournalUnverified { io } => vec![("io", Val::io_kind(*io))],
        StoreError::QuotaExceeded { used, quota } => {
            vec![("used", Val::bytes(*used)), ("quota", Val::bytes(*quota))]
        }
        StoreError::LengthMismatch { declared, actual } => vec![
            ("declared", Val::bytes(*declared)),
            ("actual", Val::bytes(*actual)),
        ],
        StoreError::MissingChunks(sids) => vec![("missing", Val::count(sids.len() as u64))],
        StoreError::TooManyHeads { heads, max } => vec![
            ("heads", Val::count(*heads as u64)),
            ("max", Val::count(*max as u64)),
        ],
        StoreError::SeqAhead { requested, head } => vec![
            ("requested", Val::seq(*requested)),
            ("head", Val::seq(*head)),
        ],
        StoreError::Io(e) => vec![("io", Val::io(e))],
        _ => Vec::new(),
    }
}

/// The account frame that records `account` with this recovery state and
/// every other field as it stands.
fn account_frame(
    account: AccountRecord,
    recovery_verifier: Option<String>,
    recovery_registered: Option<UnixMs>,
    recovery_cleared: Option<UnixMs>,
) -> Frame {
    Frame::Account {
        account_id: account.account_id,
        name: account.name,
        created: account.created,
        quota_bytes: account.quota_bytes,
        recovery_verifier,
        recovery_registered,
        recovery_cleared,
    }
}

/// Random bytes from the kernel. The one source of randomness in the server.
fn random_bytes<const N: usize>() -> Result<[u8; N], StoreError> {
    let mut file = File::open("/dev/urandom")?;
    let mut out = [0u8; N];
    file.read_exact(&mut out)?;
    Ok(out)
}

/// The name of the lock file on the journal root.
const LOCK_FILE: &str = "lock";

/// Hold the journal for this process alone: an exclusive advisory lock on
/// `v1/lock` of the journal volume, kept for the life of the store.
///
/// `ReadWriteOnce` keeps other nodes off a volume and nothing more: a
/// second pod on the same node mounts it too, and a second server on the
/// same journal is a second writer of frames that assume exactly one. The
/// lock is what makes "one writer" true. A second `obsyncd` on these
/// volumes — a second pod, or a `check` or `export` while `serve` runs —
/// refuses to start rather than share the journal, with one line saying
/// so. The lock goes with the process, so a crash leaves nothing to clean.
fn hold_journal(journal_dir: &Path, log: &Log) -> Result<File, StoreError> {
    let path = PathClass::JournalRoot.path(journal_dir).join(LOCK_FILE);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => {
            log.error(
                "store_open",
                &[
                    ("decision", Val::word("refused")),
                    ("reason", Val::word("journal_locked")),
                ],
            );
            Err(StoreError::Locked)
        }
        Err(TryLockError::Error(e)) => Err(e.into()),
    }
}

/// The server key: the configured one, the one on the journal volume, or a
/// fresh one written there with mode 0600 (AGENTS.md, security invariants).
///
/// Taking a [`Posture`] is the point: this file opens every stored device
/// credential, so there is no way to reach it without having decided what
/// the volume it rests on actually is. Whichever branch runs, the file is
/// measured and then read, so a mode is never claimed for a file that was
/// only written.
///
/// The key itself never reaches a log line: only where it came from, and the
/// mode the volume was found to hold, do.
pub fn load_or_create_server_key(
    journal_dir: &Path,
    configured: Option<[u8; 32]>,
    posture: &Posture,
    log: &Log,
) -> Result<[u8; 32], StoreError> {
    if let Some(key) = configured {
        log.info("server_key", &[("source", Val::word("configured"))]);
        return Ok(key);
    }
    let path = PathClass::ServerKey.path(journal_dir);
    let (source, mut key_file) = match posture.open_credential(PathClass::ServerKey, &path, log)? {
        Some(standing) => ("volume", standing),
        None => {
            let mut file = Posture::create(PathClass::ServerKey, &path)?;
            file.write_all(hex::encode(&random_bytes::<32>()?).as_bytes())?;
            file.sync_all()?;
            File::open(PathClass::JournalRoot.path(journal_dir))?.sync_all()?;
            ("generated", posture.adopt(PathClass::ServerKey, file, log)?)
        }
    };
    let text = key_file.read_to_string()?;
    let key = hex::decode_array::<32>(text.trim()).map_err(|_| {
        StoreError::Corrupt("the stored server key is not 64 hex characters".to_string())
    })?;
    log.info(
        "server_key",
        &[
            ("source", Val::word(source)),
            ("mode", Val::mode(key_file.mode())),
        ],
    );
    Ok(key)
}

#[cfg(test)]
impl Store {
    /// The secret as it rests in the index, so a test can prove it is wrapped.
    fn wrapped_secret(&self, id: &DeviceId) -> Option<[u8; 32]> {
        self.index().devices.get(id).map(|entry| entry.wrapped)
    }
}
