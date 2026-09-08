//! The in-memory index: what the journal replays into and what queries read.
//!
//! docs/architecture.md §6.1: the journal is the source of truth and the
//! index is derived. Every mutation therefore goes through [`Index::apply`],
//! on the live path and on the replay path alike, so a replayed store and a
//! running store cannot drift: there is only one implementation of each rule.
#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::collections::VecDeque;

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
#[derive(Clone, Debug)]
pub(crate) struct FileEntry {
    pub(crate) domain_id: DomainId,
    pub(crate) heads: Vec<VersionId>,
    pub(crate) conflicted: bool,
    pub(crate) versions: Vec<VersionRecord>,
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
    /// Start of the current scrub pass: chunks verified before it are pending.
    pub(crate) scrub_cursor: UnixMs,
}

impl Index {
    /// Apply one journal record. This is the only way the index changes.
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
            } => {
                self.account = Some(AccountRecord {
                    account_id: *account_id,
                    name: name.clone(),
                    created: *created,
                    quota_bytes: *quota_bytes,
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
                        crate::storage::types::SeenKind::Heartbeat => {}
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
                for (file_id, version_id) in pruned {
                    self.prune_version(file_id, version_id);
                }
                // The chunks go from the index with the frame that records
                // them, so a replay reaches the same state as the run did
                // even though chunks are otherwise learnt from the volume.
                for sid in sids {
                    self.forget_chunk(sid);
                }
                self.last_gc = Some(summary.clone());
            }
            Frame::Scrub { summary } => {
                for sid in &summary.quarantined {
                    self.forget_chunk(sid);
                }
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
        entry.versions.push(version);
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

    /// Drop one version, and the file when its last version goes.
    fn prune_version(&mut self, file_id: &FileId, version_id: &VersionId) {
        let empty = match self.files.get_mut(file_id) {
            Some(entry) => {
                entry.versions.retain(|v| v.version_id != *version_id);
                entry.heads.retain(|head| head != version_id);
                entry.conflicted = entry.heads.len() > 1;
                entry.versions.is_empty()
            }
            None => false,
        };
        if empty {
            self.files.remove(file_id);
        }
        self.feed.retain(|(_, feed_file, feed_version)| {
            feed_file != file_id || feed_version != version_id
        });
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
        let mut versions: Vec<VersionRecord> = entry.versions.iter().rev().cloned().collect();
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
            .cloned()
    }

    /// One page of the file listing, ordered by file id.
    pub(crate) fn files_page(
        &self,
        after: Option<&FileId>,
        limit: usize,
    ) -> (Vec<FileSummary>, Option<FileId>) {
        let mut page: Vec<FileSummary> = Vec::new();
        let mut next = None;
        for (file_id, entry) in &self.files {
            if after.is_some_and(|a| file_id <= a) {
                continue;
            }
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
        let truncated = window.len() > limit;
        let mut changes = Vec::new();
        for (_, file_id, version_id) in window.iter().take(limit) {
            let Some(entry) = self.files.get(file_id) else {
                continue;
            };
            let Some(version) = entry.versions.iter().find(|v| v.version_id == *version_id) else {
                continue;
            };
            changes.push(Change {
                version: version.clone(),
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
