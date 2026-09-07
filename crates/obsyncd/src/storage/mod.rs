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
//! index alone. Streaming a chunk body and hashing during a scrub happen with
//! no lock held, so a slow upload never blocks the feed.
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
mod scrub;
pub mod types;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod testutil;

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use obsync_core::hex;
use obsync_core::hkdf::hkdf_sha256;
use obsync_core::sha256::Sha256;

use crate::config::StorageConfig;
use crate::log::{Log, Val};
use crate::types::{AccountId, DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId};

use self::blobs::Blobs;
use self::index::Index;
use self::journal::{Frame, Journal, Record};

pub use self::types::{
    AccountRecord, AppendOutcome, Change, Changes, DevicePolicy, DeviceRecord, DomainRecord,
    FileRecord, FileSummary, GcSummary, NewDevice, NewVersion, PutOutcome, ScrubSummary, SeenEvent,
    SeenKind, StoreError, VersionRecord, VolumeStatus,
};

/// The domain separator device secrets and escrowed domain keys rest under
/// (docs/architecture.md §3.6).
const WRAP_SALT: &[u8] = b"obsync/v1/wrap";

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
    /// Write the final journal frame with a corrupt payload.
    JournalTornFrame,
}

/// The storage engine. One per process, shared by every request thread.
pub struct Store {
    cfg: StorageConfig,
    server_key: [u8; 32],
    log: Log,
    blobs: Blobs,
    journal: Mutex<Journal>,
    index: Mutex<Index>,
    changed: Condvar,
}

impl Store {
    /// Open the volumes, replay the journal, and index the blobs.
    ///
    /// Creates the layout, removes temp leftovers, loads the newest readable
    /// snapshot, replays the frames after it, truncates a torn tail, and
    /// scans the blob volume. Every count reaches the SUMMARY line, so a
    /// crash that cost frames or left leftovers is visible at the next start
    /// (requirement 12).
    pub fn open(cfg: &StorageConfig, server_key: [u8; 32], log: Log) -> Result<Store, StoreError> {
        let started = log.start("store_open", cfg.journal_capacity);
        let mirror_paths: Vec<PathBuf> = cfg.mirrors.iter().map(|m| m.path.clone()).collect();
        let (blobs, leftovers) = Blobs::open(&cfg.blobs_dir, &mirror_paths)?;
        let mut journal = Journal::open(&cfg.journal_dir)?;
        let (snapshot, skipped) = journal.load_snapshot()?;
        let from_snapshot = snapshot.is_some();
        let mut index = snapshot.unwrap_or_default();
        let replay = journal.replay(index.seq, &mut |record| index.apply(record))?;
        let (chunks, strays) = blobs.scan()?;
        let chunk_count = chunks.len() as u64;
        for (sid, len, first_seen) in chunks {
            index.add_chunk(sid, len, first_seen);
        }
        // Every chunk is pending verification when the process starts: a
        // scrub pass that only ever runs against this process's memory would
        // never re-check anything after a restart.
        index.scrub_cursor = UnixMs::now();

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
            blobs,
            journal: Mutex::new(journal),
            index: Mutex::new(index),
            changed: Condvar::new(),
        })
    }

    fn index(&self) -> MutexGuard<'_, Index> {
        self.index.lock().expect("index lock")
    }

    fn journal(&self) -> MutexGuard<'_, Journal> {
        self.journal.lock().expect("journal lock")
    }

    /// The one-time pad a device secret or escrowed key rests under.
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
        {
            let index = self.index();
            let stored = index.account().ok_or(StoreError::NotSetUp)?;
            if stored.account_id != *account {
                return Err(StoreError::NotSetUp);
            }
            if index.chunks.contains_key(sid) {
                drop(index);
                self.blobs.drain(sid, declared_len, body)?;
                return Ok(PutOutcome::Existed);
            }
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
        self.blobs.write(sid, declared_len, body)?;
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
        let timed = self.log.timed("version_append");
        let mut fields = vec![
            ("file", Val::file(&v.file_id)),
            ("device", Val::device(&v.device_id)),
            ("bytes", Val::bytes(v.bytes)),
            ("chunks", Val::count(v.sids.len() as u64)),
        ];
        match self.append_version_inner(v) {
            Ok(outcome) => {
                fields.push(("seq", Val::seq(outcome.seq)));
                fields.push(("conflicted", Val::flag(outcome.conflicted)));
                fields.push((
                    "decision",
                    Val::word(if outcome.existed {
                        "existed"
                    } else {
                        "appended"
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

    fn append_version_inner(&self, v: NewVersion) -> Result<AppendOutcome, StoreError> {
        let expected = version_id_of(&v.file_id, &v.parents, &v.manifest_ct, &v.sids);
        if expected != v.version_id {
            return Err(StoreError::VersionIdMismatch {
                expected,
                actual: v.version_id,
            });
        }
        let mut journal = self.journal();
        let mut index = self.index();
        match index.account_id() {
            Some(id) if id == v.account_id => {}
            _ => return Err(StoreError::NotSetUp),
        }
        let device = index
            .devices
            .get(&v.device_id)
            .ok_or(StoreError::UnknownDevice)?;
        if device.record.revoked {
            return Err(StoreError::DeviceRevoked);
        }
        if let Some(existing) = index.version(&v.file_id, &v.version_id) {
            let entry = index.files.get(&v.file_id).expect("the version's file");
            return Ok(AppendOutcome {
                seq: existing.seq,
                heads: entry.heads.clone(),
                conflicted: entry.conflicted,
                existed: true,
            });
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
        let now = UnixMs::now();
        let file_id = v.file_id;
        let seq = append(&mut journal, &mut index, |seq| {
            Frame::Version(VersionRecord {
                file_id: v.file_id,
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
            })
        })?;
        let entry = index.files.get(&file_id).expect("the version's file");
        let outcome = AppendOutcome {
            seq,
            heads: entry.heads.clone(),
            conflicted: entry.conflicted,
            existed: false,
        };
        drop(index);
        self.changed.notify_all();
        Ok(outcome)
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

    /// Block until the head passes `since`, or until `timeout` elapses.
    pub fn wait_for_change(&self, since: Seq, timeout: Duration) -> Seq {
        let index = self.index();
        if index.seq > since {
            return index.seq;
        }
        let (index, _) = self
            .changed
            .wait_timeout_while(index, timeout, |index| index.seq <= since)
            .expect("index lock");
        index.seq
    }

    // -- account and devices ----------------------------------------------

    /// Create the one account. Valid once (docs/protocol.md, `/v1/setup`).
    pub fn setup(&self, name: &str) -> Result<AccountId, StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if index.account.is_some() {
            return Err(StoreError::AlreadySetUp);
        }
        let account_id = AccountId::new(random_bytes::<16>()?);
        append(&mut journal, &mut index, |_| Frame::Account {
            account_id,
            name: name.to_string(),
            created: UnixMs::now(),
            quota_bytes: None,
        })?;
        self.log
            .info("setup", &[("account", Val::account(&account_id))]);
        Ok(account_id)
    }

    /// The account, with the usage the volumes actually hold.
    pub fn account(&self) -> Option<AccountRecord> {
        self.index().account()
    }

    /// Pair a device. The secret is wrapped before it reaches the journal.
    pub fn create_device(&self, d: NewDevice) -> Result<DeviceRecord, StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
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
            revoked: false,
        };
        let wrapped = self.wrap(device_id.as_bytes(), &d.secret);
        let stored = record.clone();
        append(&mut journal, &mut index, |_| Frame::Device {
            record: stored,
            wrapped,
        })?;
        self.log
            .info("device_created", &[("device", Val::device(&device_id))]);
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
        if entry.record.revoked {
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

    /// Change a device's name, policy or reported version.
    pub fn update_device(
        &self,
        id: &DeviceId,
        name: Option<String>,
        policy: Option<DevicePolicy>,
        app_version: Option<String>,
    ) -> Result<DeviceRecord, StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if !index.devices.contains_key(id) {
            return Err(StoreError::UnknownDevice);
        }
        append(&mut journal, &mut index, |_| Frame::DeviceUpdate {
            device_id: *id,
            name,
            policy,
            app_version,
        })?;
        Ok(index.devices[id].record.clone())
    }

    /// Revoke a device: every later request from it fails.
    pub fn revoke_device(&self, id: &DeviceId) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if !index.devices.contains_key(id) {
            return Err(StoreError::UnknownDevice);
        }
        append(&mut journal, &mut index, |_| Frame::DeviceRevoke {
            device_id: *id,
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

    /// Delete a device outright (a rejected pairing).
    pub fn delete_device(&self, id: &DeviceId) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if !index.devices.contains_key(id) {
            return Err(StoreError::UnknownDevice);
        }
        append(&mut journal, &mut index, |_| Frame::DeviceDelete {
            device_id: *id,
        })?;
        Ok(())
    }

    /// Record a device sign-in, edit or heartbeat.
    pub fn record_seen(&self, id: &DeviceId, ev: SeenEvent) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if !index.devices.contains_key(id) {
            return Err(StoreError::UnknownDevice);
        }
        append(&mut journal, &mut index, |_| Frame::Seen {
            device_id: *id,
            event: ev,
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

    /// Every domain, in id order.
    pub fn domains(&self) -> Vec<DomainRecord> {
        self.index().domains.values().map(|e| e.record).collect()
    }

    /// Declare a domain. Declaring one twice changes nothing.
    pub fn create_domain(&self, id: DomainId) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if index.domains.contains_key(&id) {
            return Ok(());
        }
        append(&mut journal, &mut index, |_| Frame::Domain {
            domain_id: id,
            created: UnixMs::now(),
        })?;
        Ok(())
    }

    /// Escrow a domain key, or withdraw the escrow with `None`.
    ///
    /// An escrowed key rests wrapped exactly as a device secret does, so a
    /// stolen journal without the server key still yields nothing.
    pub fn set_escrow(&self, id: &DomainId, key: Option<[u8; 32]>) -> Result<(), StoreError> {
        let mut journal = self.journal();
        let mut index = self.index();
        if !index.domains.contains_key(id) {
            return Err(StoreError::UnknownDomain);
        }
        let wrapped = key.map(|key| self.wrap(id.as_bytes(), &key));
        append(&mut journal, &mut index, |_| Frame::Escrow {
            domain_id: *id,
            wrapped,
        })?;
        self.log.info(
            "escrow",
            &[
                ("domain", Val::domain(id)),
                (
                    "decision",
                    Val::word(if key.is_some() { "stored" } else { "withdrawn" }),
                ),
            ],
        );
        Ok(())
    }

    /// An escrowed domain key, unwrapped.
    pub fn escrow_key(&self, id: &DomainId) -> Option<[u8; 32]> {
        let index = self.index();
        let wrapped = index.domains.get(id)?.wrapped?;
        Some(self.wrap(id.as_bytes(), &wrapped))
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
            });
        }
        let journal_used = dir_bytes(&self.cfg.journal_dir);
        all.push(VolumeStatus {
            role: "journal".to_string(),
            path: self.cfg.journal_dir.clone(),
            class_label: self.cfg.journal_class.clone(),
            bytes_total: self.cfg.journal_capacity,
            bytes_used: journal_used,
            bytes_free: self.cfg.journal_capacity.saturating_sub(journal_used),
            watermark_bytes: self.cfg.free_watermark.bytes_for(self.cfg.journal_capacity),
        });
        all
    }

    /// Collect chunks no retained version references (docs/storage.md).
    ///
    /// The plan is decided, journalled and applied under the same locks, so a
    /// version that lands first is always respected; the deletions follow
    /// under the index lock, so a chunk cannot be re-registered by a
    /// concurrent upload between the decision and the unlink.
    pub fn gc_run(&self, now: UnixMs) -> GcSummary {
        // Budget zero: collection is bounded by what retention releases, not
        // by bytes, and the SUMMARY line carries the duration it took.
        let started = self.log.start("gc", 0);
        let mut journal = self.journal();
        let mut index = self.index();
        let plan = gc::plan(&index, &self.cfg, now);
        let mut summary = GcSummary {
            started: now,
            duration_ms: 0,
            chunks_collected: plan.collect.len() as u64,
            bytes_collected: plan.bytes,
            chunks_retained: plan.retained_chunks,
        };
        let frame_summary = summary.clone();
        let collect = plan.collect.clone();
        if let Err(e) = append(&mut journal, &mut index, |_| Frame::Gc {
            sids: plan.collect,
            pruned: plan.pruned,
            summary: frame_summary,
        }) {
            self.log
                .error("gc_failed", &[("decision", Val::word(e.code()))]);
            summary.chunks_collected = 0;
            summary.bytes_collected = 0;
            return summary;
        }
        let mut failed = 0;
        for sid in &collect {
            if let Err(e) = self.blobs.remove(sid) {
                failed += 1;
                self.log.warn(
                    "gc_unlink_failed",
                    &[("sid", Val::sid(sid)), ("decision", Val::word(e.code()))],
                );
            }
        }
        drop(index);
        drop(journal);
        summary.duration_ms = started.elapsed_ms();
        started.summary(
            &self.log,
            &[
                ("chunks", Val::count(summary.chunks_collected)),
                ("bytes", Val::bytes(summary.bytes_collected)),
                ("retained", Val::count(summary.chunks_retained)),
                ("unlink_failed", Val::count(failed)),
            ],
        );
        summary
    }

    /// Re-hash up to `budget_bytes` of chunks, oldest-verified first.
    ///
    /// A chunk whose content no longer matches its sid is repaired from a
    /// mirror when one holds a good copy, and quarantined when none does. The
    /// hashing happens with no lock held.
    pub fn scrub_step(&self, budget_bytes: u64) -> ScrubSummary {
        let started = self.log.start("scrub", budget_bytes);
        let now = UnixMs::now();
        let candidates = scrub::candidates(&self.index(), budget_bytes);

        let mut verified = 0;
        let mut bytes = 0;
        let mut mismatches = 0;
        let mut repaired = 0;
        let mut quarantined = Vec::new();
        let mut good = Vec::new();
        for (sid, len) in candidates {
            match self.blobs.verify_primary(&sid) {
                Ok(Some(true)) => {
                    verified += 1;
                    bytes += len;
                    good.push(sid);
                }
                Ok(Some(false)) => {
                    mismatches += 1;
                    bytes += len;
                    match self.repair(&sid) {
                        Ok(true) => {
                            repaired += 1;
                            good.push(sid);
                        }
                        Ok(false) => quarantined.push(sid),
                        Err(e) => {
                            self.log.error(
                                "scrub_repair_failed",
                                &[("sid", Val::sid(&sid)), ("decision", Val::word(e.code()))],
                            );
                            quarantined.push(sid);
                        }
                    }
                }
                // Gone from the volume: either a collection took it while the
                // hashing ran, or it never landed. The index reconciles below.
                Ok(None) => {}
                Err(e) => self.log.error(
                    "scrub_read_failed",
                    &[("sid", Val::sid(&sid)), ("decision", Val::word(e.code()))],
                ),
            }
        }

        let mut summary = ScrubSummary {
            started: now,
            duration_ms: 0,
            chunks_verified: verified + repaired,
            bytes_verified: bytes,
            mismatches,
            quarantined: quarantined.clone(),
            complete_pass: false,
        };
        let mut journal = self.journal();
        let mut index = self.index();
        for sid in good {
            if let Some(meta) = index.chunks.get_mut(&sid) {
                meta.last_verified = UnixMs::now();
            }
        }
        summary.complete_pass = scrub::candidates(&index, budget_bytes).is_empty();
        if summary.complete_pass {
            index.scrub_cursor = UnixMs::now();
        }
        summary.duration_ms = started.elapsed_ms();
        let frame = summary.clone();
        if let Err(e) = append(&mut journal, &mut index, |_| Frame::Scrub {
            summary: frame,
        }) {
            self.log
                .error("scrub_failed", &[("decision", Val::word(e.code()))]);
        }
        drop(index);
        drop(journal);
        started.summary(
            &self.log,
            &[
                ("chunks", Val::count(summary.chunks_verified)),
                ("bytes", Val::bytes(summary.bytes_verified)),
                ("mismatches", Val::count(summary.mismatches)),
                ("quarantined", Val::count(quarantined.len() as u64)),
                ("repaired", Val::count(repaired)),
                ("complete", Val::flag(summary.complete_pass)),
            ],
        );
        summary
    }

    /// Repair one bad chunk from a mirror, or quarantine it.
    fn repair(&self, sid: &Sid) -> Result<bool, StoreError> {
        if self.blobs.repair_from_mirror(sid)? {
            self.log.warn(
                "chunk_repaired",
                &[("sid", Val::sid(sid)), ("decision", Val::word("repaired"))],
            );
            return Ok(true);
        }
        let quarantine = self.journal().quarantine_dir();
        self.blobs.quarantine(sid, &quarantine)?;
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
    pub fn snapshot(&self) -> Result<(), StoreError> {
        // Budget zero: a snapshot is as large as the index is.
        let started = self.log.start("snapshot", 0);
        let mut journal = self.journal();
        let index = self.index();
        journal.snapshot(&index)?;
        let seq = index.seq;
        drop(index);
        drop(journal);
        started.summary(&self.log, &[("seq", Val::seq(seq))]);
        Ok(())
    }

    /// The last collection run.
    pub fn last_gc(&self) -> Option<GcSummary> {
        self.index().last_gc.clone()
    }

    /// The last scrub step.
    pub fn last_scrub(&self) -> Option<ScrubSummary> {
        self.index().last_scrub.clone()
    }

    /// Re-hash every stored chunk (`obsyncd check`).
    ///
    /// Returns how many chunks were read, how many bytes, and which failed.
    pub fn verify_chunks(&self) -> Result<(u64, u64, Vec<Sid>), StoreError> {
        let chunks: Vec<(Sid, u64)> = self
            .index()
            .chunks
            .iter()
            .map(|(sid, meta)| (*sid, meta.len))
            .collect();
        let mut count = 0;
        let mut bytes = 0;
        let mut bad = Vec::new();
        for (sid, len) in chunks {
            match self.blobs.verify_primary(&sid)? {
                Some(true) => {
                    count += 1;
                    bytes += len;
                }
                Some(false) | None => bad.push(sid),
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

    /// Arm a crash point. Tests only.
    #[cfg(test)]
    pub(crate) fn set_fault(&self, fault: Fault) {
        self.blobs.set_fault(fault);
        self.journal().set_fault(fault);
    }
}

/// Append a frame at the next sequence and apply it to the index.
///
/// Journal first, index second, always: the index may only hold what the
/// journal already made durable (docs/storage.md, durability rule 4).
fn append(
    journal: &mut Journal,
    index: &mut Index,
    frame: impl FnOnce(Seq) -> Frame,
) -> Result<Seq, StoreError> {
    let seq = index.seq.next();
    let record = Record {
        seq,
        account_id: index.account_id(),
        frame: frame(seq),
    };
    journal.append(&record)?;
    index.apply(&record);
    Ok(seq)
}

/// `version_id = SHA-256(file_id || sorted parents || manifest_ct || sids)`
/// (docs/architecture.md §3.4). Parents are sorted by their bytes so two
/// devices that name the same parents in a different order agree.
fn version_id_of(
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
fn error_fields(e: &StoreError) -> Vec<(&'static str, Val)> {
    match e {
        StoreError::VolumeFull { free, watermark } => vec![
            ("free", Val::bytes(*free)),
            ("watermark", Val::bytes(*watermark)),
        ],
        StoreError::QuotaExceeded { used, quota } => {
            vec![("used", Val::bytes(*used)), ("quota", Val::bytes(*quota))]
        }
        StoreError::LengthMismatch { declared, actual } => vec![
            ("declared", Val::bytes(*declared)),
            ("actual", Val::bytes(*actual)),
        ],
        StoreError::MissingChunks(sids) => vec![("missing", Val::count(sids.len() as u64))],
        StoreError::SeqAhead { requested, head } => vec![
            ("requested", Val::seq(*requested)),
            ("head", Val::seq(*head)),
        ],
        StoreError::Io(e) => vec![("io", Val::io(e))],
        _ => Vec::new(),
    }
}

/// Random bytes from the kernel. The one source of randomness in the server.
fn random_bytes<const N: usize>() -> Result<[u8; N], StoreError> {
    let mut file = File::open("/dev/urandom")?;
    let mut out = [0u8; N];
    file.read_exact(&mut out)?;
    Ok(out)
}

/// Bytes occupied under a directory, for volume usage.
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += dir_bytes(&path);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// The server key: the configured one, the one on the journal volume, or a
/// fresh one written there with mode 0600 (AGENTS.md, security invariants).
///
/// The key itself never reaches a log line: only where it came from does.
pub fn load_or_create_server_key(
    journal_dir: &Path,
    configured: Option<[u8; 32]>,
    log: &Log,
) -> Result<[u8; 32], StoreError> {
    if let Some(key) = configured {
        log.info("server_key", &[("source", Val::word("configured"))]);
        return Ok(key);
    }
    let root = journal_dir.join("v1");
    if !root.is_dir() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)?;
    }
    let path = root.join("server.key");
    if let Ok(text) = fs::read_to_string(&path) {
        let key = hex::decode_array::<32>(text.trim()).map_err(|_| {
            StoreError::Corrupt("the stored server key is not 64 hex characters".to_string())
        })?;
        log.info("server_key", &[("source", Val::word("volume"))]);
        return Ok(key);
    }
    let key = random_bytes::<32>()?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(hex::encode(&key).as_bytes())?;
    file.sync_all()?;
    drop(file);
    File::open(&root)?.sync_all()?;
    log.info("server_key", &[("source", Val::word("generated"))]);
    Ok(key)
}

#[cfg(test)]
impl Store {
    /// The secret as it rests in the index, so a test can prove it is wrapped.
    fn wrapped_secret(&self, id: &DeviceId) -> Option<[u8; 32]> {
        self.index().devices.get(id).map(|entry| entry.wrapped)
    }
}
