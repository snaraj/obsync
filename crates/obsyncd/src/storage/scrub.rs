//! Which chunks the next scrub step should re-hash, and where a pass stands.
//!
//! docs/storage.md, "Integrity": the scrub re-hashes blobs at
//! `OBSYNC_SCRUB_RATE`, one pass at a time, walking the inventory in sid
//! order. A step is bounded by a byte budget so the background thread never
//! competes with serving, and resumes where the last one stopped rather than
//! re-sorting the inventory. A completed pass rests until [`PASS_INTERVAL_MS`]
//! after it began: every chunk is re-hashed at least that often, and a store
//! smaller than one step is not re-hashed whole every few seconds. The store
//! does the reading; this module only decides the order.
#![forbid(unsafe_code)]

use std::ops::Bound;

use crate::log::Started;
use crate::storage::index::Index;
use crate::types::{Sid, UnixMs};

/// The shortest time from the start of one pass to the start of the next.
///
/// A day. A bad chunk is only worth finding while something can still repair
/// it: a mirror, or a device that still holds the file (`docs/architecture.md`
/// 6.2.3). The shortest horizon the storage contract gives either of those is
/// a day -- `OBSYNC_RETENTION_DAYS` is at least 1 and a newborn chunk is
/// protected for 24 h -- so re-hashing everything at least daily finds rot
/// inside every window the contract promises. A store too large to hash in a
/// day is simply scrubbed continuously at its pace. A constant,
/// not a setting: an interval that could be stretched without bound would
/// be a switch that turns integrity verification off (AGENTS.md
/// requirement 4). The rate is the operator's knob; the interval is not.
pub(crate) const PASS_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

/// Where the scrub is in its pass. One per store.
pub(crate) struct Pass {
    /// When the pass began: a chunk last verified before it is pending.
    pub(crate) began: UnixMs,
    /// The walk resumes after this sid.
    pub(crate) after: Option<Sid>,
    /// A chunk this walk could not verify: the walk runs again, over what is
    /// still pending, before the pass may count as complete.
    pub(crate) failed: bool,
    /// The pass completed and the next one waits for [`PASS_INTERVAL_MS`].
    pub(crate) resting: bool,
    /// A pass was asked for: the next step begins one even while resting.
    pub(crate) asked: bool,
    /// This walk's START line and running totals, for its SUMMARY.
    pub(crate) run: Option<(Started, Totals)>,
}

/// What one walk has done so far.
#[derive(Clone, Copy, Default)]
pub(crate) struct Totals {
    pub(crate) steps: u64,
    pub(crate) chunks: u64,
    pub(crate) bytes: u64,
    pub(crate) mismatches: u64,
    pub(crate) quarantined: u64,
    pub(crate) repaired: u64,
    /// Time the steps spent working, rests excluded: the SUMMARY's own
    /// duration is the pass's wall time, so the two show its pace.
    pub(crate) worked_ms: u64,
}

impl Pass {
    /// A pass that begins now, with every chunk pending.
    pub(crate) const fn new(now: UnixMs) -> Pass {
        Pass {
            began: now,
            after: None,
            failed: false,
            resting: false,
            asked: false,
            run: None,
        }
    }

    /// Whether a step at `now` has nothing to do: the last pass completed
    /// less than [`PASS_INTERVAL_MS`] after it began, and nobody asked for
    /// another. Otherwise a resting pass gives way to a new one.
    pub(crate) fn rests(&mut self, now: UnixMs) -> bool {
        if !self.resting {
            return false;
        }
        if !self.asked && now.0 < self.began.0.saturating_add(PASS_INTERVAL_MS) {
            return true;
        }
        *self = Pass::new(now);
        false
    }
}

/// The chunks to verify next: the pending ones after `after`, in sid order,
/// within `budget` bytes. Also says whether the walk reached the end of the
/// inventory, which is when a pass can be complete.
///
/// Always returns at least one chunk when any is pending, even when that
/// chunk alone exceeds the budget: a chunk larger than one step's budget
/// must still be verified eventually, and a budget that could stall the pass
/// forever would be an integrity check that silently stops.
pub(crate) fn candidates(index: &Index, pass: &Pass, budget: u64) -> (Vec<(Sid, u64)>, bool) {
    let from = pass.after.map_or(Bound::Unbounded, Bound::Excluded);
    let mut chosen = Vec::new();
    let mut used = 0u64;
    for (sid, meta) in index.chunks.range((from, Bound::Unbounded)) {
        if meta.last_verified >= pass.began {
            continue;
        }
        if !chosen.is_empty() && used.saturating_add(meta.len) > budget {
            return (chosen, false);
        }
        chosen.push((*sid, meta.len));
        used = used.saturating_add(meta.len);
    }
    (chosen, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(n: u8) -> Sid {
        Sid::new([n; 32])
    }

    fn index_with(chunks: &[(u8, u64, u64)]) -> Index {
        let mut index = Index::default();
        for (n, len, verified) in chunks {
            index.add_chunk(sid(*n), *len, UnixMs(0));
            if let Some(meta) = index.chunks.get_mut(&sid(*n)) {
                meta.last_verified = UnixMs(*verified);
            }
        }
        index
    }

    fn pass(began: u64, after: Option<u8>) -> Pass {
        Pass {
            after: after.map(sid),
            ..Pass::new(UnixMs(began))
        }
    }

    #[test]
    fn a_step_walks_in_sid_order_and_resumes_after_the_last_it_took() {
        let index = index_with(&[(3, 10, 0), (1, 10, 0), (2, 10, 0)]);
        assert_eq!(
            candidates(&index, &pass(1_000, None), 20),
            (vec![(sid(1), 10), (sid(2), 10)], false)
        );
        assert_eq!(
            candidates(&index, &pass(1_000, Some(2)), 20),
            (vec![(sid(3), 10)], true),
            "the next step starts after the last sid taken and reaches the end"
        );
    }

    #[test]
    fn the_budget_bounds_the_step() {
        let index = index_with(&[(1, 40, 1), (2, 40, 2), (3, 40, 3)]);
        let (picked, end) = candidates(&index, &pass(1_000, None), 100);
        assert_eq!(picked.len(), 2, "two chunks fit, the third does not");
        assert!(!end);
        assert_eq!(picked.iter().map(|(_, len)| len).sum::<u64>(), 80);
    }

    #[test]
    fn a_chunk_larger_than_the_budget_is_still_verified() {
        let index = index_with(&[(1, 5_000, 1)]);
        assert_eq!(
            candidates(&index, &pass(1_000, None), 10),
            (vec![(sid(1), 5_000)], true),
            "a budget must not stall the pass forever"
        );
    }

    #[test]
    fn a_chunk_verified_since_the_pass_began_is_not_repeated() {
        let index = index_with(&[(1, 10, 2_000), (2, 10, 10)]);
        assert_eq!(
            candidates(&index, &pass(1_000, None), 1_000),
            (vec![(sid(2), 10)], true)
        );
        let index = index_with(&[(1, 10, 2_000)]);
        assert_eq!(
            candidates(&index, &pass(1_000, None), 1_000),
            (Vec::new(), true),
            "a finished pass has nothing pending"
        );
    }

    #[test]
    fn a_completed_pass_rests_until_the_interval_unless_one_is_asked_for() {
        let began = 1_000;
        let mut resting = Pass {
            resting: true,
            ..pass(began, Some(9))
        };
        assert!(resting.rests(UnixMs(began + PASS_INTERVAL_MS - 1)));
        assert!(resting.resting, "still the pass that completed");

        resting.asked = true;
        assert!(
            !resting.rests(UnixMs(began + 1)),
            "an asked-for pass begins"
        );
        assert_eq!(resting.began, UnixMs(began + 1));
        assert_eq!(resting.after, None, "from the start of the inventory");
        assert!(!resting.asked && !resting.resting);

        let mut due = Pass {
            resting: true,
            ..pass(began, Some(9))
        };
        assert!(!due.rests(UnixMs(began + PASS_INTERVAL_MS)));
        assert_eq!(due.began, UnixMs(began + PASS_INTERVAL_MS));
    }
}
