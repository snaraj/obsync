//! The in-memory index: what the journal replays into and what queries read.
//!
//! docs/architecture.md §6.1: journalled metadata is derived through
//! [`Index::apply`] on both the live and replay paths. Chunk inventory is
//! derived from primary-volume files, updated with each physical mutation
//! under the SID lock and rebuilt by the startup scan, not by scrub summaries.
#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::ops::Bound;
use std::sync::Arc;

use crate::storage::journal::{Frame, Record};
use crate::storage::types::{
    AccountRecord, Change, Changes, DeviceRecord, DeviceState, FileRecord, FileSummary, GcSummary,
    ScrubSummary, SeenEvent, StoreError, VersionRecord,
};
use crate::types::{AccountId, DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId};

/// How many activity events one device keeps. Retention days bound them too;
/// this bounds memory when a device heartbeats far more often than expected.
pub(crate) const SEEN_HISTORY: usize = 256;

/// Most heads one file may hold.
///
/// Equal to the parents one version may declare
/// (`api::files::VERSION_MAX_PARENTS`), so no conflict a file can reach is
/// beyond one merge naming every head; a smaller number here would leave a
/// file that only a chain of partial merges could resolve. Heads also ride in
/// every file record and every change entry, so this is what bounds the head
/// list a response carries (`docs/protocol.md`, "Limits and headers").
pub const FILE_MAX_HEADS: usize = 64;

/// A parent list as the set it means: two posts naming the same parents in a
/// different order, or one of them twice, are one position in the graph.
fn parent_set(parents: &[VersionId]) -> Vec<VersionId> {
    let mut ids = parents.to_vec();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// A device, its wrapped secret, and its recent activity.
#[derive(Clone, Debug)]
pub(crate) struct DeviceEntry {
    pub(crate) record: DeviceRecord,
    /// The device secret, one-time-padded under the server key. The plain
    /// secret is never stored (docs/architecture.md §3.6).
    pub(crate) wrapped: [u8; 32],
    pub(crate) seen: VecDeque<SeenEvent>,
}

/// A file: its domain, its heads, and every version the store still holds,
/// oldest first.
///
/// There is no `Default`: a file exists because a version created it, and
/// that version is the only thing that can say which domain the file is in
/// (`docs/architecture.md` 5.1 item 4). A default-constructed entry would
/// have to invent one.
///
/// A stored version never changes, so it is shared rather than owned: the
/// copy a snapshot is written from costs a pointer per version, not the
/// version again.
#[derive(Clone, Debug)]
pub(crate) struct FileEntry {
    pub(crate) domain_id: DomainId,
    pub(crate) heads: Vec<VersionId>,
    pub(crate) conflicted: bool,
    pub(crate) versions: Vec<Arc<VersionRecord>>,
}

/// What the store knows about one stored chunk.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ChunkMeta {
    pub(crate) len: u64,
    /// When this process first saw the chunk. Newborn chunks are protected
    /// from collection for 24 h (docs/storage.md, "Garbage collection").
    pub(crate) first_seen: UnixMs,
    /// When the scrub last re-hashed it.
    pub(crate) last_verified: UnixMs,
}

/// Everything the server serves from memory.
#[derive(Debug, Default)]
pub(crate) struct Index {
    pub(crate) account: Option<AccountRecord>,
    pub(crate) devices: BTreeMap<DeviceId, DeviceEntry>,
    pub(crate) files: BTreeMap<FileId, FileEntry>,
    pub(crate) chunks: BTreeMap<Sid, ChunkMeta>,
    /// Version frames in journal order: the change feed.
    pub(crate) feed: Vec<(Seq, FileId, VersionId)>,
    pub(crate) seq: Seq,
    pub(crate) used_bytes: u64,
    pub(crate) last_gc: Option<GcSummary>,
    pub(crate) last_scrub: Option<ScrubSummary>,
}

impl Index {
    /// Apply one journal record to the derived metadata.
    pub(crate) fn apply(&mut self, record: &Record) {
        if record.seq > self.seq {
            self.seq = record.seq;
        }
        match &record.frame {
            Frame::Account {
                account_id,
                name,
                created,
                quota_bytes,
                recovery_verifier,
                recovery_registered,
                recovery_cleared,
            } => {
                self.account = Some(AccountRecord {
                    account_id: *account_id,
                    name: name.clone(),
                    created: *created,
                    quota_bytes: *quota_bytes,
                    recovery_verifier: recovery_verifier.clone(),
                    recovery_registered: *recovery_registered,
                    recovery_cleared: *recovery_cleared,
                    used_bytes: 0,
                });
            }
            Frame::Device {
                record: device,
                wrapped,
            } => {
                self.devices.insert(
                    device.device_id,
                    DeviceEntry {
                        record: device.clone(),
                        wrapped: *wrapped,
                        seen: VecDeque::new(),
                    },
                );
            }
            Frame::DeviceUpdate {
                device_id,
                name,
                policy,
                app_version,
                archived,
            } => {
                if let Some(entry) = self.devices.get_mut(device_id) {
                    if let Some(name) = name {
                        entry.record.name = name.clone();
                    }
                    if let Some(policy) = policy {
                        entry.record.policy = *policy;
                    }
                    if let Some(version) = app_version {
                        entry.record.app_version = version.clone();
                    }
                    // Only a revoked device is ever archived, and the guard
                    // is here as well as in the store: a replay must not be
                    // able to hide a device that syncs (issue #247).
                    if let Some(flag) = archived
                        && entry.record.state == DeviceState::Revoked
                    {
                        entry.record.archived = *flag;
                    }
                }
            }
            Frame::DeviceActivate { device_id } => {
                if let Some(entry) = self.devices.get_mut(device_id)
                    && entry.record.state == DeviceState::Pending
                {
                    // Pending is the only state activation may leave: a
                    // revoked device whose wrapped secret is already zeroed
                    // must never come back as a live credential.
                    entry.record.state = DeviceState::Active;
                }
            }
            Frame::DeviceRevoke { device_id } => {
                if let Some(entry) = self.devices.get_mut(device_id) {
                    entry.record.state = DeviceState::Revoked;
                    // The wrapped secret is destroyed, not just flagged: a
                    // revoked device's requests can never be authenticated
                    // again, even by a later bug (docs/architecture.md §4.3).
                    entry.wrapped = [0u8; 32];
                }
            }
            Frame::DeviceDelete { device_id } => {
                self.devices.remove(device_id);
            }
            Frame::Version(version) => self.apply_version(version.clone()),
            Frame::Seen { device_id, event } => {
                if let Some(entry) = self.devices.get_mut(device_id) {
                    match event.kind {
                        crate::storage::types::SeenKind::SignIn => {
                            entry.record.last_sign_in = Some(event.ts);
                        }
                        crate::storage::types::SeenKind::Edit => {
                            entry.record.last_edit = Some(event.ts);
                        }
                        crate::storage::types::SeenKind::Heartbeat => {
                            entry.record.last_heartbeat = Some(event.ts);
                        }
                    }
                    entry.record.last_seen = Some(event.ts);
                    if event.address.is_some() {
                        entry.record.address = event.address.clone();
                    }
                    if event.country.is_some() {
                        entry.record.country = event.country.clone();
                    }
                    entry.seen.push_back(event.clone());
                    while entry.seen.len() > SEEN_HISTORY {
                        entry.seen.pop_front();
                    }
                }
            }
            Frame::Gc {
                sids,
                pruned,
                summary,
            } => {
                self.prune_versions(pruned);
                // The chunks go from the index with the frame that records
                // them, so a replay reaches the same state as the run did
                // even though chunks are otherwise learnt from the volume.
                for sid in sids {
                    self.forget_chunk(sid);
                }
                self.last_gc = Some(summary.clone());
            }
            Frame::Scrub { summary } => {
                // A summary records what that pass completed. Inventory is
                // changed under the SID lock with the physical operation,
                // and rebuilt from the blob volume on startup. Forgetting
                // here could discard a reupload that beat this later frame.
                self.last_scrub = Some(summary.clone());
            }
        }
    }

    /// Head logic, docs/architecture.md §6.1 and docs/protocol.md.
    ///
    /// A version replaces the heads it names as parents and becomes a head
    /// itself. Parents equal to the heads therefore leave one head and no
    /// conflict; anything else leaves the untouched heads beside the new one,
    /// which is what "conflicted" means. A merge naming both heads resolves
    /// the conflict by the same rule, with no special case.
    fn apply_version(&mut self, version: VersionRecord) {
        // The first version of a file fixes its domain; every later version
        // repeats it, and `Store::append_version` refuses one that does not,
        // so replay never has to choose between two answers.
        let entry = self
            .files
            .entry(version.file_id)
            .or_insert_with(|| FileEntry {
                domain_id: version.domain_id,
                heads: Vec::new(),
                conflicted: false,
                versions: Vec::new(),
            });
        if entry
            .versions
            .iter()
            .any(|v| v.version_id == version.version_id)
        {
            return;
        }
        entry.heads.retain(|head| !version.parents.contains(head));
        entry.heads.push(version.version_id);
        entry.conflicted = entry.heads.len() > 1;
        self.feed
            .push((version.seq, version.file_id, version.version_id));
        entry.versions.push(Arc::new(version));
    }

    /// How many heads this file would hold if a version naming `parents`
    /// were applied.
    ///
    /// The same arithmetic [`Index::apply_version`] performs: a version
    /// replaces the heads it names and becomes one itself, so the answer is
    /// the heads it does not name, plus itself. The store asks before it
    /// writes the frame; replay never does, because the journal is the
    /// source of truth and a frame it already holds is not a decision to
    /// take again (`docs/architecture.md` 6.1).
    pub(crate) fn heads_after(&self, file_id: &FileId, parents: &[VersionId]) -> usize {
        let kept = match self.files.get(file_id) {
            Some(entry) => entry
                .heads
                .iter()
                .filter(|head| !parents.contains(head))
                .count(),
            None => 0,
        };
        kept + 1
    }

    /// The version of this file that already says what a post is about to
    /// say: the same parent set, the same chunk list in the same order, and
    /// the same tombstone flag.
    ///
    /// Two devices that merge the same heads to the same bytes produce the
    /// same parents and the same content-addressed chunk list, and two
    /// DIFFERENT version ids, because the id covers the encrypted manifest
    /// and its nonce (`docs/architecture.md` 6.1). The second frame adds
    /// nothing to the graph: it names the same position and the same
    /// content, and writing it forks the file into two heads that another
    /// merge then has to close (issue #114).
    ///
    /// Parents are a SET -- order is not part of what a version says -- and
    /// sids are a LIST, because their order is the file's byte order. The
    /// tombstone flag is part of the key: a delete and an empty file both
    /// carry no chunks, and answering one with the other would lose the
    /// difference. Stored order is oldest first, so repeated posts all
    /// converge on the id that landed first.
    pub(crate) fn twin(
        &self,
        file_id: &FileId,
        parents: &[VersionId],
        sids: &[Sid],
        deleted: bool,
    ) -> Option<(Seq, VersionId)> {
        let entry = self.files.get(file_id)?;
        let wanted = parent_set(parents);
        entry
            .versions
            .iter()
            .find(|v| {
                v.deleted == deleted
                    && parent_set(&v.parents) == wanted
                    && v.sids.as_slice() == sids
            })
            .map(|v| (v.seq, v.version_id))
    }

    /// Drop versions, and each file whose last version goes.
    ///
    /// As one set: each touched file is visited once and the feed is walked
    /// once, rather than once per pruned version, which made a mass deletion
    /// quadratic -- at collection and again at every replay of its frame.
    fn prune_versions(&mut self, pruned: &[(FileId, VersionId)]) {
        if pruned.is_empty() {
            return;
        }
        let mut by_file: BTreeMap<FileId, BTreeSet<VersionId>> = BTreeMap::new();
        for (file_id, version_id) in pruned {
            by_file.entry(*file_id).or_default().insert(*version_id);
        }
        for (file_id, gone) in &by_file {
            let Some(entry) = self.files.get_mut(file_id) else {
                continue;
            };
            entry.versions.retain(|v| !gone.contains(&v.version_id));
            entry.heads.retain(|head| !gone.contains(head));
            entry.conflicted = entry.heads.len() > 1;
            if entry.versions.is_empty() {
                self.files.remove(file_id);
            }
        }
        self.feed.retain(|(_, file_id, version_id)| {
            by_file
                .get(file_id)
                .is_none_or(|gone| !gone.contains(version_id))
        });
    }

    /// The part of the index a snapshot records, copied so that it can be
    /// encoded and written with no guard held. Chunk inventory and the feed
    /// are left out: the first is learnt from the blob volume at every start,
    /// and the second is rebuilt from the versions.
    pub(crate) fn snapshot_copy(&self) -> Index {
        Index {
            account: self.account.clone(),
            devices: self.devices.clone(),
            files: self.files.clone(),
            seq: self.seq,
            last_gc: self.last_gc.clone(),
            last_scrub: self.last_scrub.clone(),
            ..Index::default()
        }
    }

    /// Record a chunk that exists on the volume.
    pub(crate) fn add_chunk(&mut self, sid: Sid, len: u64, now: UnixMs) {
        if let Some(existing) = self.chunks.insert(
            sid,
            ChunkMeta {
                len,
                first_seen: now,
                last_verified: UnixMs(0),
            },
        ) {
            self.used_bytes = self.used_bytes.saturating_sub(existing.len);
        }
        self.used_bytes += len;
    }

    /// Forget a chunk the store no longer holds.
    pub(crate) fn forget_chunk(&mut self, sid: &Sid) {
        if let Some(meta) = self.chunks.remove(sid) {
            self.used_bytes = self.used_bytes.saturating_sub(meta.len);
        }
    }

    /// A scrub observes the actual length, which corruption may have changed.
    /// Keep age and verification history while correcting usage even if the
    /// subsequent quarantine is refused.
    pub(crate) fn resize_chunk(&mut self, sid: &Sid, len: u64) {
        if let Some(meta) = self.chunks.get_mut(sid) {
            self.used_bytes = self.used_bytes.saturating_sub(meta.len).saturating_add(len);
            meta.len = len;
        }
    }

    /// The account, with usage filled in from the chunks actually stored.
    pub(crate) fn account(&self) -> Option<AccountRecord> {
        self.account.as_ref().map(|account| AccountRecord {
            used_bytes: self.used_bytes,
            ..account.clone()
        })
    }

    /// The account id, when setup has run.
    pub(crate) fn account_id(&self) -> Option<AccountId> {
        self.account.as_ref().map(|a| a.account_id)
    }

    /// A file with its versions newest first, capped at `keep` plus every head.
    pub(crate) fn file(&self, file_id: &FileId, keep: usize) -> Option<FileRecord> {
        let entry = self.files.get(file_id)?;
        let mut versions: Vec<VersionRecord> =
            entry.versions.iter().rev().map(|v| (**v).clone()).collect();
        if versions.len() > keep {
            let heads = &entry.heads;
            versions = versions
                .into_iter()
                .enumerate()
                .filter(|(index, version)| *index < keep || heads.contains(&version.version_id))
                .map(|(_, version)| version)
                .collect();
        }
        Some(FileRecord {
            file_id: *file_id,
            domain_id: entry.domain_id,
            heads: entry.heads.clone(),
            conflicted: entry.conflicted,
            versions,
        })
    }

    /// One version.
    pub(crate) fn version(
        &self,
        file_id: &FileId,
        version_id: &VersionId,
    ) -> Option<VersionRecord> {
        self.files
            .get(file_id)?
            .versions
            .iter()
            .find(|v| v.version_id == *version_id)
            .map(|v| (**v).clone())
    }

    /// One page of the file listing, ordered by file id. The walk starts AT
    /// the cursor rather than at the first file, so paging through a vault
    /// costs each page its own length, not every page before it.
    pub(crate) fn files_page(
        &self,
        after: Option<&FileId>,
        limit: usize,
    ) -> (Vec<FileSummary>, Option<FileId>) {
        let mut page: Vec<FileSummary> = Vec::new();
        let mut next = None;
        let start = after.map_or(Bound::Unbounded, |a| Bound::Excluded(*a));
        for (file_id, entry) in self.files.range((start, Bound::Unbounded)) {
            if page.len() == limit {
                // The cursor is the last id INCLUDED, because `after` is
                // exclusive: handing back the first excluded id would skip it.
                next = page.last().map(|summary| summary.file_id);
                break;
            }
            page.push(FileSummary {
                file_id: *file_id,
                domain_id: entry.domain_id,
                heads: entry.heads.clone(),
                conflicted: entry.conflicted,
                latest_ts: entry.versions.last().map(|v| v.ts).unwrap_or_default(),
            });
        }
        (page, next)
    }

    /// The change feed from `since`, exclusive.
    pub(crate) fn changes(&self, since: Seq, limit: usize) -> Result<Changes, StoreError> {
        if since > self.seq {
            return Err(StoreError::SeqAhead {
                requested: since,
                head: self.seq,
            });
        }
        let start = self.feed.partition_point(|(seq, _, _)| *seq <= since);
        let window = &self.feed[start..];
        let mut truncated = window.len() > limit;
        let mut changes = Vec::new();
        let mut bytes = 0usize;
        for (_, file_id, version_id) in window.iter().take(limit) {
            let Some(entry) = self.files.get(file_id) else {
                continue;
            };
            let Some(version) = entry.versions.iter().find(|v| v.version_id == *version_id) else {
                continue;
            };
            // The page stops at its byte budget, never before its first
            // entry: a client asks for the rest from the cursor this page
            // hands back, exactly as it does after a full count.
            let cost = wire_bytes(version, &entry.heads);
            if !changes.is_empty() && bytes + cost > CHANGES_PAGE_BYTES {
                truncated = true;
                break;
            }
            bytes += cost;
            changes.push(Change {
                version: (**version).clone(),
                heads: entry.heads.clone(),
                conflicted: entry.conflicted,
            });
        }
        // When the page covers everything, the cursor is the journal head, so
        // a client that only reads versions still skips the frames it will
        // never be shown rather than re-scanning them on every poll.
        let seq = if truncated {
            changes.last().map(|c| c.version.seq).unwrap_or(since)
        } else {
            self.seq
        };
        Ok(Changes {
            seq,
            head_seq: self.seq,
            changes,
        })
    }

    /// When each version after `since` landed, at most `limit` of them, in
    /// feed order: what the dashboard's activity graph counts, read without
    /// cloning a single version.
    pub(crate) fn version_times(&self, since: Seq, limit: usize) -> Vec<UnixMs> {
        let start = self.feed.partition_point(|(seq, _, _)| *seq <= since);
        self.feed[start..]
            .iter()
            .take(limit)
            .filter_map(|(_, file_id, version_id)| {
                let entry = self.files.get(file_id)?;
                let version = entry
                    .versions
                    .iter()
                    .find(|v| v.version_id == *version_id)?;
                Some(version.ts)
            })
            .collect()
    }
}

/// A change page stops before its entries pass this many bytes of JSON, and
/// always carries at least one. One entry is under 6 MiB at the protocol's
/// ceilings, so no page passes 8 MiB where a thousand maximal entries used to
/// make one about 6 GiB, on the server and on the phone that parses it
/// (`docs/protocol.md`, "Limits and headers").
pub(crate) const CHANGES_PAGE_BYTES: usize = 8 * 1024 * 1024;

/// What one change entry costs as JSON, rounded up: the base64 manifest, one
/// quoted id per sid, parent and head, and the fixed fields. An estimate that
/// never falls short is all the page cut needs, and it clones nothing.
fn wire_bytes(version: &VersionRecord, heads: &[VersionId]) -> usize {
    /// Every fixed field of one entry, keys and punctuation included.
    const FIXED: usize = 512;
    /// One id in a list: 64 hex characters, two quotes and a comma.
    const ID: usize = 67;
    let ids = version.sids.len() + version.parents.len() + heads.len();
    FIXED + version.manifest_ct.len().div_ceil(3) * 4 + ids * ID
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testutil::{device_record, version_record};

    fn record(seq: u64, frame: Frame) -> Record {
        Record {
            seq: Seq(seq),
            account_id: None,
            frame,
        }
    }

    fn file(n: u8) -> FileId {
        FileId::new([n; 16])
    }

    fn version(n: u8) -> VersionId {
        VersionId::new([n; 32])
    }

    #[test]
    fn a_linear_history_keeps_one_head() {
        let mut index = Index::default();
        index.apply(&record(
            1,
            Frame::Version(version_record(file(1), version(1), &[], Seq(1))),
        ));
        index.apply(&record(
            2,
            Frame::Version(version_record(file(1), version(2), &[version(1)], Seq(2))),
        ));
        let stored = index.file(&file(1), 10).expect("file exists");
        assert_eq!(stored.heads, vec![version(2)]);
        assert!(!stored.conflicted);
        assert_eq!(stored.versions.len(), 2);
        assert_eq!(stored.versions[0].version_id, version(2), "newest first");
    }

    #[test]
    fn concurrent_writers_conflict_and_a_merge_resolves_it() {
        let mut index = Index::default();
        index.apply(&record(
            1,
            Frame::Version(version_record(file(1), version(1), &[], Seq(1))),
        ));
        index.apply(&record(
            2,
            Frame::Version(version_record(file(1), version(2), &[version(1)], Seq(2))),
        ));
        index.apply(&record(
            3,
            Frame::Version(version_record(file(1), version(3), &[version(1)], Seq(3))),
        ));
        let stored = index.file(&file(1), 10).expect("file exists");
        assert_eq!(stored.heads, vec![version(2), version(3)]);
        assert!(stored.conflicted, "two heads is a conflict");

        index.apply(&record(
            4,
            Frame::Version(version_record(
                file(1),
                version(4),
                &[version(2), version(3)],
                Seq(4),
            )),
        ));
        let stored = index.file(&file(1), 10).expect("file exists");
        assert_eq!(stored.heads, vec![version(4)]);
        assert!(!stored.conflicted, "the merge resolves the conflict");
    }

    #[test]
    fn a_partial_merge_leaves_the_untouched_head() {
        let mut index = Index::default();
        for (seq, id, parents) in [
            (1u64, version(1), vec![]),
            (2, version(2), vec![version(1)]),
            (3, version(3), vec![version(1)]),
            (4, version(4), vec![version(2)]),
        ] {
            index.apply(&record(
                seq,
                Frame::Version(version_record(file(1), id, &parents, Seq(seq))),
            ));
        }
        let stored = index.file(&file(1), 10).expect("file exists");
        assert_eq!(stored.heads, vec![version(3), version(4)]);
        assert!(stored.conflicted);
    }

    #[test]
    fn reposting_a_version_changes_nothing() {
        let mut index = Index::default();
        let frame = Frame::Version(version_record(file(1), version(1), &[], Seq(1)));
        index.apply(&record(1, frame.clone()));
        index.apply(&record(2, frame));
        let stored = index.file(&file(1), 10).expect("file exists");
        assert_eq!(stored.versions.len(), 1);
        assert_eq!(index.feed.len(), 1);
    }

    #[test]
    fn the_file_view_caps_versions_but_never_drops_a_head() {
        let mut index = Index::default();
        // An orphan head written first, so the cap on the newest versions
        // would drop it if heads were not exempt.
        index.apply(&record(
            1,
            Frame::Version(version_record(file(1), version(9), &[], Seq(1))),
        ));
        for n in 1..=5u8 {
            let parents = if n == 1 { vec![] } else { vec![version(n - 1)] };
            index.apply(&record(
                u64::from(n) + 1,
                Frame::Version(version_record(
                    file(1),
                    version(n),
                    &parents,
                    Seq(u64::from(n) + 1),
                )),
            ));
        }
        let stored = index.file(&file(1), 2).expect("file exists");
        assert_eq!(stored.heads, vec![version(9), version(5)]);
        for head in &stored.heads {
            assert!(
                stored.versions.iter().any(|v| v.version_id == *head),
                "every head is in the view"
            );
        }
        assert_eq!(stored.versions.len(), 3, "the cap plus the older head");
        assert_eq!(stored.versions[0].version_id, version(5), "newest first");
    }

    #[test]
    fn changes_page_and_refuse_a_cursor_past_the_head() {
        let mut index = Index::default();
        for n in 1..=4u8 {
            index.apply(&record(
                u64::from(n),
                Frame::Version(version_record(file(n), version(n), &[], Seq(n.into()))),
            ));
        }
        let page = index.changes(Seq(0), 2).expect("first page");
        assert_eq!(page.changes.len(), 2);
        assert_eq!(page.seq, Seq(2), "truncated pages stop at the last change");
        assert_eq!(page.head_seq, Seq(4));

        let page = index.changes(page.seq, 100).expect("second page");
        assert_eq!(page.changes.len(), 2);
        assert_eq!(page.seq, Seq(4), "a complete page advances to the head");

        let page = index.changes(Seq(4), 100).expect("caught up");
        assert!(page.changes.is_empty());
        assert_eq!(page.seq, Seq(4));

        let err = index.changes(Seq(5), 10).expect_err("cursor past the head");
        assert!(
            matches!(
                err,
                StoreError::SeqAhead {
                    requested: Seq(5),
                    head: Seq(4)
                }
            ),
            "{err}"
        );
    }

    /// An index whose versions each carry a manifest of `manifest` bytes.
    fn wide_feed(count: u8, manifest: usize) -> Index {
        let mut index = Index::default();
        for n in 1..=count {
            let mut v = version_record(file(n), version(n), &[], Seq(n.into()));
            v.manifest_ct = vec![0x6d; manifest];
            index.apply(&record(u64::from(n), Frame::Version(v)));
        }
        index
    }

    /// The hostile page: a thousand maximal entries used to be one answer of
    /// about 6 GiB. A page now stops at its byte budget and hands back a
    /// cursor, and the next page resumes after it with nothing skipped or
    /// repeated.
    #[test]
    fn a_change_page_stops_at_its_byte_budget_and_resumes_after_it() {
        // 1 MiB manifests are about 1.4 MB each on the wire, so five fit in
        // 8 MiB and a sixth does not.
        let index = wide_feed(10, 1024 * 1024);
        let first = index.changes(Seq(0), 1000).expect("first page");
        assert_eq!(first.changes.len(), 5, "cut at the budget, not the count");
        assert_eq!(first.seq, Seq(5), "the cursor is the last entry included");
        assert_eq!(first.head_seq, Seq(10));
        let cost: usize = first
            .changes
            .iter()
            .map(|c| wire_bytes(&c.version, &c.heads))
            .sum();
        assert!(cost <= CHANGES_PAGE_BYTES, "{cost} bytes in one page");

        let second = index.changes(first.seq, 1000).expect("second page");
        let seqs: Vec<Seq> = second.changes.iter().map(|c| c.version.seq).collect();
        assert_eq!(seqs, (6..=10).map(Seq).collect::<Vec<_>>());
        assert_eq!(second.seq, Seq(10), "the last page reaches the head");
    }

    /// An entry wider than the whole budget still travels, alone: a page that
    /// could carry nothing would hand back its own cursor, and a client
    /// following it would ask for the same page forever.
    #[test]
    fn an_entry_wider_than_the_budget_still_moves_the_cursor() {
        let index = wide_feed(2, CHANGES_PAGE_BYTES);
        let first = index.changes(Seq(0), 1000).expect("first page");
        assert_eq!(first.changes.len(), 1);
        assert_eq!(first.seq, Seq(1));
        let second = index.changes(first.seq, 1000).expect("second page");
        assert_eq!(second.changes.len(), 1);
        assert_eq!(second.seq, Seq(2));
    }

    /// The cut runs on an estimate, so the estimate must never fall short of
    /// what a client is actually sent: for the narrowest entry, and for the
    /// widest the protocol admits (every list and the manifest at their
    /// ceilings). Measured on the rendering itself.
    #[test]
    fn the_page_estimate_never_falls_short_of_the_rendering() {
        use crate::api::files::{MANIFEST_CT_MAX, VERSION_MAX_SIDS};
        use crate::api::render;

        let mut narrow = version_record(file(1), version(1), &[], Seq(1));
        narrow.seq = Seq(u64::MAX);
        let heads: Vec<VersionId> = (0..FILE_MAX_HEADS)
            .map(|n| VersionId::new([n as u8; 32]))
            .collect();
        let mut wide = narrow.clone();
        wide.parents = heads.clone();
        wide.sids = (0..VERSION_MAX_SIDS)
            .map(|n| Sid::new([n as u8; 32]))
            .collect();
        wide.manifest_ct = vec![0xa5; MANIFEST_CT_MAX / 4 * 3];
        wide.bytes = u64::MAX;
        wide.ts = UnixMs(u64::MAX);
        for (version, heads) in [(narrow, Vec::new()), (wide, heads)] {
            let rendered = render::change(&Change {
                version: version.clone(),
                heads: heads.clone(),
                conflicted: true,
            })
            .to_json()
            .len();
            // One entry's share of a page: itself and the comma after it.
            assert!(
                wire_bytes(&version, &heads) > rendered,
                "estimated {} for {rendered} rendered",
                wire_bytes(&version, &heads)
            );
        }
    }

    #[test]
    fn version_times_reads_the_feed_tail_without_its_records() {
        let index = wide_feed(4, 16);
        assert_eq!(
            index.version_times(Seq(1), 2),
            vec![UnixMs(1_757_000_000_002), UnixMs(1_757_000_000_003)]
        );
        assert!(index.version_times(Seq(4), 10).is_empty());
    }

    #[test]
    fn files_page_walks_in_id_order() {
        let mut index = Index::default();
        for n in 1..=5u8 {
            index.apply(&record(
                u64::from(n),
                Frame::Version(version_record(file(n), version(n), &[], Seq(n.into()))),
            ));
        }
        let (page, next) = index.files_page(None, 2);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].file_id, file(1));
        assert_eq!(next, Some(file(2)), "the cursor is the last id included");

        let (page, next) = index.files_page(next.as_ref(), 2);
        assert_eq!(
            page[0].file_id,
            file(3),
            "and the next page resumes after it"
        );
        assert_eq!(page[1].file_id, file(4));
        assert_eq!(next, Some(file(4)));

        let (page, next) = index.files_page(next.as_ref(), 2);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].file_id, file(5), "no file is skipped or repeated");
        assert_eq!(next, None);
    }

    #[test]
    fn revoking_a_device_destroys_its_wrapped_secret() {
        let mut index = Index::default();
        let device = device_record();
        let id = device.device_id;
        index.apply(&record(
            1,
            Frame::Device {
                record: device,
                wrapped: [7u8; 32],
            },
        ));
        assert_eq!(index.devices[&id].wrapped, [7u8; 32]);
        index.apply(&record(2, Frame::DeviceRevoke { device_id: id }));
        assert!(index.devices[&id].record.revoked());
        assert_eq!(index.devices[&id].wrapped, [0u8; 32], "the secret is gone");
        index.apply(&record(3, Frame::DeviceDelete { device_id: id }));
        assert!(!index.devices.contains_key(&id));
    }

    #[test]
    fn approval_activates_a_pending_device_and_never_a_revoked_one() {
        let mut index = Index::default();
        let device = DeviceRecord {
            state: DeviceState::Pending,
            ..device_record()
        };
        let id = device.device_id;
        index.apply(&record(
            1,
            Frame::Device {
                record: device,
                wrapped: [7u8; 32],
            },
        ));
        assert_eq!(index.devices[&id].record.state, DeviceState::Pending);
        index.apply(&record(2, Frame::DeviceActivate { device_id: id }));
        assert_eq!(index.devices[&id].record.state, DeviceState::Active);

        index.apply(&record(3, Frame::DeviceRevoke { device_id: id }));
        index.apply(&record(4, Frame::DeviceActivate { device_id: id }));
        assert_eq!(
            index.devices[&id].record.state,
            DeviceState::Revoked,
            "activation must never bring a revoked device back"
        );
        assert_eq!(index.devices[&id].wrapped, [0u8; 32]);
    }

    /// Archiving is a property of a REVOKED device (issue #247), and the
    /// guard is here as well as in the store: no frame, however it was
    /// written or replayed, may take a device that syncs off the lists.
    #[test]
    fn a_replayed_archive_frame_never_hides_a_device_that_syncs() {
        let mut index = Index::default();
        let device = device_record();
        let id = device.device_id;
        index.apply(&record(
            1,
            Frame::Device {
                record: device,
                wrapped: [7u8; 32],
            },
        ));
        let archive = |flag: bool| Frame::DeviceUpdate {
            device_id: id,
            name: None,
            policy: None,
            app_version: None,
            archived: Some(flag),
        };
        index.apply(&record(2, archive(true)));
        assert!(
            !index.devices[&id].record.archived,
            "an ACTIVE device is never archived"
        );

        index.apply(&record(3, Frame::DeviceRevoke { device_id: id }));
        index.apply(&record(4, archive(true)));
        assert!(index.devices[&id].record.archived, "a revoked one is");
        assert!(index.devices[&id].record.revoked(), "and stays revoked");
        assert_eq!(
            index.devices[&id].record.name, "sentinel device",
            "with its name, so its versions still have an author"
        );

        // An ordinary rename leaves the flag where it was, both ways.
        index.apply(&record(
            5,
            Frame::DeviceUpdate {
                device_id: id,
                name: Some("renamed".to_string()),
                policy: None,
                app_version: None,
                archived: None,
            },
        ));
        assert!(index.devices[&id].record.archived);
        index.apply(&record(6, archive(false)));
        assert!(!index.devices[&id].record.archived, "and it can come back");
    }

    #[test]
    fn one_collection_frame_prunes_versions_across_files_and_the_feed_follows() {
        let mut index = Index::default();
        let mut seq = 0;
        for f in 1..=3u8 {
            for n in 1..=3u8 {
                seq += 1;
                let id = VersionId::new([f * 10 + n; 32]);
                let parents = if n == 1 {
                    vec![]
                } else {
                    vec![VersionId::new([f * 10 + n - 1; 32])]
                };
                index.apply(&record(
                    seq,
                    Frame::Version(version_record(file(f), id, &parents, Seq(seq))),
                ));
            }
        }
        let v = |f: u8, n: u8| (file(f), VersionId::new([f * 10 + n; 32]));
        // File 4 is conflicted: two roots, both heads.
        for n in 1..=2u8 {
            seq += 1;
            index.apply(&record(
                seq,
                Frame::Version(version_record(file(4), v(4, n).1, &[], Seq(seq))),
            ));
        }
        assert!(index.file(&file(4), 10).expect("file 4").conflicted);
        // File 1 loses its two oldest, file 2 loses everything, file 3 none,
        // and file 4 one of its heads.
        index.apply(&record(
            seq + 1,
            Frame::Gc {
                sids: Vec::new(),
                pruned: vec![v(1, 1), v(2, 1), v(1, 2), v(4, 1), v(2, 2), v(2, 3)],
                summary: GcSummary {
                    started: UnixMs(0),
                    duration_ms: 0,
                    chunks_collected: 0,
                    bytes_collected: 0,
                    chunks_retained: 0,
                },
            },
        ));
        let one = index.file(&file(1), 10).expect("file 1 stays");
        assert_eq!(one.versions.len(), 1);
        assert_eq!(one.heads, vec![v(1, 3).1]);
        assert!(index.file(&file(2), 10).is_none(), "an emptied file goes");
        assert_eq!(
            index.file(&file(3), 10).expect("untouched").versions.len(),
            3
        );
        let four = index.file(&file(4), 10).expect("file 4 stays");
        assert_eq!(four.heads, vec![v(4, 2).1], "a pruned head is no head");
        assert!(!four.conflicted, "and one head is no conflict");
        let fed: Vec<(FileId, VersionId)> = index.feed.iter().map(|(_, f, v)| (*f, *v)).collect();
        assert_eq!(fed, vec![v(1, 3), v(3, 1), v(3, 2), v(3, 3), v(4, 2)]);
    }

    #[test]
    fn chunk_accounting_follows_adds_and_removals() {
        let mut index = Index::default();
        let sid = Sid::new([1u8; 32]);
        index.add_chunk(sid, 100, UnixMs(5));
        index.add_chunk(Sid::new([2u8; 32]), 50, UnixMs(5));
        assert_eq!(index.used_bytes, 150);
        index.add_chunk(sid, 100, UnixMs(6));
        assert_eq!(index.used_bytes, 150, "re-adding does not double count");
        index.forget_chunk(&sid);
        assert_eq!(index.used_bytes, 50);
        index.forget_chunk(&sid);
        assert_eq!(index.used_bytes, 50, "forgetting twice is harmless");
    }
}
