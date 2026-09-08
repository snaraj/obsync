//! What garbage collection would do, decided as a pure function.
//!
//! docs/storage.md, "Garbage collection": refcounts come from the index, a
//! chunk is collectable when no retained version references it and it is
//! older than 24 h, and retention keeps at least `OBSYNC_RETENTION_VERSIONS`
//! versions per file plus everything younger than `OBSYNC_RETENTION_DAYS`.
//!
//! Separating the decision from the deletion is what makes the rules
//! testable without a filesystem, and what lets the store journal the plan
//! before it acts on it.
#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use crate::config::StorageConfig;
use crate::storage::index::Index;
use crate::types::{FileId, Sid, UnixMs, VersionId};

/// A newborn chunk is protected for this long, so an upload whose version
/// post has not landed yet is never collected out from under it.
pub(crate) const NEWBORN_MS: u64 = 24 * 60 * 60 * 1000;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// What one collection run should do.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Plan {
    /// Versions retention no longer keeps.
    pub(crate) pruned: Vec<(FileId, VersionId)>,
    /// Chunks no retained version references.
    pub(crate) collect: Vec<Sid>,
    /// Bytes those chunks occupy.
    pub(crate) bytes: u64,
    /// Chunks that survive.
    pub(crate) retained_chunks: u64,
}

/// Decide what to prune and collect, given the index as it stands.
pub(crate) fn plan(index: &Index, cfg: &StorageConfig, now: UnixMs) -> Plan {
    let horizon = now.0.saturating_sub(u64::from(cfg.retention_days) * DAY_MS);
    let keep_versions = cfg.retention_versions as usize;
    let mut pruned = Vec::new();
    let mut referenced: BTreeSet<Sid> = BTreeSet::new();

    for (file_id, entry) in &index.files {
        // A file whose only head is a tombstone older than the window goes
        // entirely: keeping an empty grave forever is not retention.
        let buried = entry.heads.len() == 1
            && entry
                .versions
                .iter()
                .find(|v| v.version_id == entry.heads[0])
                .is_some_and(|v| v.deleted && v.ts.0 < horizon);
        if buried {
            pruned.extend(entry.versions.iter().map(|v| (*file_id, v.version_id)));
            continue;
        }
        let newest_from = entry.versions.len().saturating_sub(keep_versions);
        for (position, version) in entry.versions.iter().enumerate() {
            let keep = position >= newest_from
                || version.ts.0 >= horizon
                || entry.heads.contains(&version.version_id);
            if keep {
                referenced.extend(version.sids.iter().copied());
            } else {
                pruned.push((*file_id, version.version_id));
            }
        }
    }

    let newborn_before = now.0.saturating_sub(NEWBORN_MS);
    let mut collect = Vec::new();
    let mut bytes = 0;
    for (sid, meta) in &index.chunks {
        if !referenced.contains(sid) && meta.first_seen.0 < newborn_before {
            collect.push(*sid);
            bytes += meta.len;
        }
    }
    Plan {
        retained_chunks: (index.chunks.len() - collect.len()) as u64,
        pruned,
        collect,
        bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Watermark;
    use crate::storage::index::Index;
    use crate::storage::journal::{Frame, Record};
    use crate::storage::testutil::version_record;
    use crate::types::Seq;
    use std::path::PathBuf;

    const NOW: UnixMs = UnixMs(1_800_000_000_000);

    fn cfg(days: u32, versions: u32) -> StorageConfig {
        StorageConfig {
            blobs_dir: PathBuf::from("/blobs"),
            journal_dir: PathBuf::from("/journal"),
            mirrors: Vec::new(),
            blobs_capacity: 1 << 30,
            journal_capacity: 1 << 30,
            blobs_class: "test-class".to_string(),
            journal_class: "test-class".to_string(),
            free_watermark: Watermark {
                percent: 5,
                bytes: 0,
            },
            retention_days: days,
            retention_versions: versions,
            scrub_rate_bytes_per_sec: 1 << 20,
        }
    }

    fn file(n: u8) -> FileId {
        FileId::new([n; 16])
    }

    fn version(n: u8) -> VersionId {
        VersionId::new([n; 32])
    }

    fn sid(n: u8) -> Sid {
        Sid::new([n; 32])
    }

    /// A chain of `count` versions on one file, each holding its own chunk.
    fn chain(index: &mut Index, count: u8, age_ms: u64) {
        for n in 1..=count {
            let parents = if n == 1 { vec![] } else { vec![version(n - 1)] };
            let mut record = version_record(file(1), version(n), &parents, Seq(n.into()));
            record.sids = vec![sid(n)];
            record.ts = UnixMs(NOW.0 - age_ms);
            index.apply(&Record {
                seq: Seq(n.into()),
                account_id: None,
                frame: Frame::Version(record),
            });
            index.add_chunk(sid(n), 10, UnixMs(NOW.0 - NEWBORN_MS - 1));
        }
    }

    #[test]
    fn retention_keeps_the_newest_versions_and_their_chunks() {
        let mut index = Index::default();
        chain(&mut index, 5, 90 * DAY_MS);
        let decided = plan(&index, &cfg(30, 2), NOW);
        // Versions 1..3 are older than the window and outside the newest two,
        // but version 5 is the head, so 4 and 5 stay: 1, 2 and 3 go.
        assert_eq!(decided.pruned.len(), 3);
        assert_eq!(decided.collect, vec![sid(1), sid(2), sid(3)]);
        assert_eq!(decided.bytes, 30);
        assert_eq!(decided.retained_chunks, 2);
    }

    #[test]
    fn nothing_inside_the_window_is_touched() {
        let mut index = Index::default();
        chain(&mut index, 5, 0);
        let decided = plan(&index, &cfg(30, 1), NOW);
        assert!(decided.pruned.is_empty(), "young versions stay");
        assert!(decided.collect.is_empty(), "their chunks stay");
        assert_eq!(decided.retained_chunks, 5);
    }

    #[test]
    fn a_newborn_chunk_is_protected_even_with_no_version() {
        let mut index = Index::default();
        index.add_chunk(sid(9), 100, UnixMs(NOW.0 - NEWBORN_MS + 1));
        index.add_chunk(sid(8), 100, UnixMs(NOW.0 - NEWBORN_MS - 1));
        let decided = plan(&index, &cfg(30, 10), NOW);
        assert_eq!(
            decided.collect,
            vec![sid(8)],
            "an upload whose version has not landed yet survives"
        );
        assert_eq!(decided.retained_chunks, 1);
    }

    #[test]
    fn an_old_tombstone_takes_its_whole_file() {
        let mut index = Index::default();
        chain(&mut index, 2, 90 * DAY_MS);
        let mut grave = version_record(file(1), version(3), &[version(2)], Seq(3));
        grave.deleted = true;
        grave.ts = UnixMs(NOW.0 - 90 * DAY_MS);
        index.apply(&Record {
            seq: Seq(3),
            account_id: None,
            frame: Frame::Version(grave),
        });
        let decided = plan(&index, &cfg(30, 10), NOW);
        assert_eq!(decided.pruned.len(), 3, "every version of the file goes");
        assert_eq!(decided.collect, vec![sid(1), sid(2)]);

        // A fresh tombstone is retained, and so is everything under it.
        let mut index = Index::default();
        chain(&mut index, 2, 0);
        let mut grave = version_record(file(1), version(3), &[version(2)], Seq(3));
        grave.deleted = true;
        grave.ts = NOW;
        index.apply(&Record {
            seq: Seq(3),
            account_id: None,
            frame: Frame::Version(grave),
        });
        let decided = plan(&index, &cfg(30, 10), NOW);
        assert!(decided.pruned.is_empty());
        assert!(decided.collect.is_empty());
    }

    #[test]
    fn an_old_head_survives_retention_and_keeps_its_chunk() {
        // A conflicted file: one head is old and far outside the version cap.
        // Retention may never prune a head, or the file loses its current
        // state while the server still calls it a head.
        let mut index = Index::default();
        let mut orphan = version_record(file(1), version(9), &[], Seq(1));
        orphan.sids = vec![sid(9)];
        orphan.ts = UnixMs(NOW.0 - 90 * DAY_MS);
        index.apply(&Record {
            seq: Seq(1),
            account_id: None,
            frame: Frame::Version(orphan),
        });
        index.add_chunk(sid(9), 10, UnixMs(NOW.0 - NEWBORN_MS - 1));
        chain(&mut index, 3, 90 * DAY_MS);

        let entry = index.files.get(&file(1)).expect("file");
        assert_eq!(entry.heads, vec![version(9), version(3)], "two heads");

        let decided = plan(&index, &cfg(30, 1), NOW);
        assert!(
            !decided
                .pruned
                .iter()
                .any(|(_, version_id)| *version_id == version(9)),
            "the old head is not prunable: {:?}",
            decided.pruned
        );
        assert!(
            !decided.collect.contains(&sid(9)),
            "and neither is the chunk it names"
        );
        assert_eq!(decided.pruned.len(), 2, "only versions 1 and 2 go");
    }

    #[test]
    fn a_chunk_shared_with_a_retained_version_survives() {
        let mut index = Index::default();
        for n in 1..=3u8 {
            let parents = if n == 1 { vec![] } else { vec![version(n - 1)] };
            let mut record = version_record(file(1), version(n), &parents, Seq(n.into()));
            record.sids = vec![sid(1)];
            record.ts = UnixMs(NOW.0 - 90 * DAY_MS);
            index.apply(&Record {
                seq: Seq(n.into()),
                account_id: None,
                frame: Frame::Version(record),
            });
        }
        index.add_chunk(sid(1), 10, UnixMs(NOW.0 - NEWBORN_MS - 1));
        let decided = plan(&index, &cfg(30, 1), NOW);
        assert_eq!(decided.pruned.len(), 2, "old versions go");
        assert!(
            decided.collect.is_empty(),
            "the chunk the head still names stays"
        );
    }
}
