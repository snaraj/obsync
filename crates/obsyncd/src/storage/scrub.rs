//! Which chunks the next scrub step should re-hash.
//!
//! docs/storage.md, "Integrity": the scrub re-hashes blobs at
//! `OBSYNC_SCRUB_RATE`, oldest-verified first. A pass is bounded by a byte
//! budget so the background thread never competes with serving; the store
//! does the reading, this module only decides the order.
#![forbid(unsafe_code)]

use crate::storage::index::Index;
use crate::types::Sid;

/// The chunks to verify next, oldest-verified first, within `budget` bytes.
///
/// Always returns at least one chunk when any is pending, even when that
/// chunk alone exceeds the budget: a chunk larger than one step's budget
/// must still be verified eventually, and a budget that could stall the pass
/// forever would be an integrity check that silently stops.
pub(crate) fn candidates(index: &Index, budget: u64) -> Vec<(Sid, u64)> {
    let mut pending: Vec<(&Sid, u64, u64)> = index
        .chunks
        .iter()
        .filter(|(_, meta)| meta.last_verified < index.scrub_cursor)
        .map(|(sid, meta)| (sid, meta.last_verified.0, meta.len))
        .collect();
    pending.sort_by_key(|(sid, verified, _)| (*verified, **sid));

    let mut chosen = Vec::new();
    let mut used = 0u64;
    for (sid, _, len) in pending {
        if !chosen.is_empty() && used.saturating_add(len) > budget {
            break;
        }
        chosen.push((*sid, len));
        used = used.saturating_add(len);
        if used >= budget {
            break;
        }
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::UnixMs;

    fn sid(n: u8) -> Sid {
        Sid::new([n; 32])
    }

    fn index_with(chunks: &[(u8, u64, u64)], cursor: u64) -> Index {
        let mut index = Index::default();
        for (n, len, verified) in chunks {
            index.add_chunk(sid(*n), *len, UnixMs(0));
            if let Some(meta) = index.chunks.get_mut(&sid(*n)) {
                meta.last_verified = UnixMs(*verified);
            }
        }
        index.scrub_cursor = UnixMs(cursor);
        index
    }

    #[test]
    fn the_least_recently_verified_chunk_goes_first() {
        let index = index_with(&[(1, 10, 500), (2, 10, 100), (3, 10, 300)], 1_000);
        let picked = candidates(&index, 100);
        assert_eq!(picked, vec![(sid(2), 10), (sid(3), 10), (sid(1), 10)]);
    }

    #[test]
    fn the_budget_bounds_the_step() {
        let index = index_with(&[(1, 40, 1), (2, 40, 2), (3, 40, 3)], 1_000);
        let picked = candidates(&index, 100);
        assert_eq!(picked.len(), 2, "two chunks fit, the third does not");
        assert_eq!(picked.iter().map(|(_, len)| len).sum::<u64>(), 80);
    }

    #[test]
    fn a_chunk_larger_than_the_budget_is_still_verified() {
        let index = index_with(&[(1, 5_000, 1)], 1_000);
        assert_eq!(
            candidates(&index, 10),
            vec![(sid(1), 5_000)],
            "a budget must not stall the pass forever"
        );
    }

    #[test]
    fn a_chunk_verified_since_the_pass_started_is_not_repeated() {
        let index = index_with(&[(1, 10, 2_000), (2, 10, 10)], 1_000);
        assert_eq!(candidates(&index, 1_000), vec![(sid(2), 10)]);
        let index = index_with(&[(1, 10, 2_000)], 1_000);
        assert!(
            candidates(&index, 1_000).is_empty(),
            "a finished pass has nothing pending"
        );
    }
}
