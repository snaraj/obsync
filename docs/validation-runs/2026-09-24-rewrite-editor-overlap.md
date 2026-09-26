# S89: hold before replacing the typing editor

Scope: issue #179, following the native n14 failed run. Its main note held
`ABCDIJKLMNOPQRST`, its existing copy held `ABCDEFGH`, and a later Resume
made a second copy. That run remains a failure: the issue requires all twenty
characters together in the main note after Sync now, not merely a union of
files. No timestamp field or note body is discarded to meet the copy bound.

## Repair

A device can receive the other device's authenticated `answer: true` branch
before the background author sees its competing edit. When the attempted
merge overlaps and this device has recent trusted editor input, it now holds
before the ordinary conflict rule can replace the editor's saved text. Clean
merges still complete, and two actual typists without the background flag do
not take this path. The editor-side role is persisted and the existing v3
control is published. The recipient uses its own current answer proof for the
exact target file to retain the background-author Resume role. A same-name
local file of another identity cannot supply that proof. The control still
deduplicates; the wire format and server API do not change.

Background Resume first durably advances the proven copy to its latest held
bytes, retaining the baseline in that copy's history. It can then adopt the
single current peer branch instead of running the ordinary fork rule and
making a second copy of that peer. Multiple, missing and local-author heads
are left for ordinary reconciliation. Moved, deleted and multi-chunk peer
heads are refused. A save during the peer download leaves the main note and
hold intact. Existing independent-edit and split-copy refusals remain in force.

## Reproduction and checks

Pinned Node 26.8.2 and TypeScript 5.9.3. The directed fixture publishes real
encrypted A/B siblings in the native order: common `ABCD`, A's typed `EFGH`,
then B's automatic stamp of the older `ABCD`. Before the fix, both fixture
orders made the first copy instead of holding. It then runs both engines,
both stampers and both open editors, appends `IJKLMNOPQRST`, and lets the
stampers run for five virtual minutes while paused. After one Sync now per
device, in both orders, both main notes hold `ABCDEFGHIJKLMNOPQRST`, exactly
one copy holds B's latest paused snapshot, both engines are idle with no
pending or in-flight work, and another quiet interval adds no journal frames.
The fixture controls delivery order before starting the hold interval; native
Obsidian validation is separate and is not claimed by this receipt.

- Clean full plugin suite: **1,100/1,100**, zero failures/skips,
  112071.651083 ms (`179-overlap-restored-full.log`). This includes #135
  co-typing, both editor states, both existing and new Resume orders, same-size
  rewrites, copy-edit refusals, and the legacy decoder compatibility checks.
- New focused guards: 18/18 after restoring all mutations
  (`179-overlap-final-guards.log`).
- M690–M709: 20 compiled; all 20 killed by 36 focused test failures.
- Recut M413, M480, M496, M533, M535, M560, M563, M568–M571, M579 and
  M620: 13 compiled; all 13 killed by 34 focused failures. The recuts change
  context, not the old hostile substitutions. M413's first focused filter
  missed its overlapping branch; a direct unpushed same-line regression now
  kills it. No timing collateral is counted.
- All 654 patches apply with `patch -F0 --dry-run`; no fuzzy application.
- Raw logs and final `summary.json` are in local evidence
  `179-overlap-mutants/`; earlier focused results are retained in `first-run/`.
  Focused counts are not full-suite mutation counts. The coordinator owns the
  final complete matrix and native desktop/phone acceptance.

## New mutation results

| Mutant | Target | Focused failures |
| --- | --- | --- |
| M690 | the typing peer makes a conflict copy before holding | 3 |
| M691 | ordinary user edits are treated as automatic answers | 2 |
| M692 | a passive editor originates the typing-side hold | 1 |
| M693 | the active editor resumes as the background rewriter | 3 |
| M694 | the editor-side hold is not persisted | 1 |
| M695 | the editor-side hold is not shared | 1 |
| M696 | the typing-side hold still falls through to conflict copying | 2 |
| M697 | parallel typing-side detection emits duplicate notices | 1 |
| M698 | the received control classifies its own id instead of the note | 1 |
| M699 | the answer author resumes as a remote editor | 1 |
| M700 | background Resume restores the stale local branch before reconciling | 5 |
| M701 | background Resume guesses one branch from several peer heads | 1 |
| M702 | a local in-flight head is mistaken for the peer editor | 1 |
| M703 | Resume selects an unrelated historical version instead of the peer head | 5 |
| M704 | Resume records the peer head over restored local bytes | 2 |
| M705 | Resume records the old version over the peer bytes | 1 |
| M706 | Resume writes the peer under a different path | 1 |
| M707 | Resume admits a deleted or oversized peer head | 2 |
| M708 | the peer answer pauses even a clean nonoverlapping merge | 1 |
| M709 | the control claims another file at the same path is its author | 1 |

The one-chunk shape guard also refuses deletion: the validated manifest
contract gives deleted versions zero chunks. It does not need a second,
redundant deleted-field predicate.

## Native rerun and remaining acceptance boundary

The coordinator's fresh n15 native rerun passed on the final bundle: both
main notes retained all twenty characters, exactly one copy remained after
one Sync now per device (B first), and five-minute hold and post-Resume
observations each added zero note-version POSTs. The [desktop receipt](2026-09-24-rewrite-storm.md#final-native-desktop-rerun)
records the bundle and matching file hashes. The iPhone S89 result remains
unproven. This change prevents the first split; it does not infer how to
recombine the old n14 conflict history. The retained n14 failure and its
screenshots remain useful evidence. No native app, vault, coordinator source,
version lock, reviewer or watcher was changed in the executor lane.
