# 2026-09-24: PR #133 review regressions

This record distinguishes the first repair after `48b7fe7` from the later
asynchronous replacement race found at `6efe0a4`. It records automated checks.
The [native phone record](2026-09-24-phone-candidate.md) exercises the first
repair's `922744e3…` plugin bundle for identical first sync, two-way edits,
offline restart and automatic recovery. It predates the later race repair;
its screenshots do not prove that replacement bundle on a phone.

The pull path now checks the incoming identity's current server heads before
retiring an independent identical note. Historical live-plus-delete replay,
a concurrent fork, a local edit during lookup, and a replacement local record
all preserve the later note. The existing keeper save is checked by reloading
State before retirement and after settlement. Repair PUTs answered with real
HTTP 507 now produce the visible repair error instead of being classified offline.

Validation used Node 26.8.2/npm 11.19.1 and Rust 1.98.0:

- `make check`: Rust 144 + 367 passed; line coverage 94.65%; plugin 781/781;
  dashboard 70/70; contracts 767; both secret scans clear.
- `node --test plugin/test/review-133.test.mjs`: six passing regressions.
  Before the fixes, the historical replay and HTTP 507 cases failed.
- `sh plugin/test/mutants/run.sh plugin/test/mutants/M500.diff` through M505:
  all apply, compile, and fail the restored 781-test suite. M500 has two
  failing witnesses; M501–M505 each have one. The runner restores and rebuilds.
  M502 removes only the keeper save, independently of `setFile`.

The 149-entry `plugin/test/mutants/MATRIX.md` is the earlier 775-test
measurement, not a claim that all historical counts were remeasured here.
Its M25/M26 survivors remain inherited coverage gaps; M28 is equivalent on
1.1.2. The six new patches carry the independent review-fix measurements above.
No native setup action was performed in this review-fix pass, so there are no
new setup screenshots in this record.

## Later asynchronous replacement race

The delta review reproduced another window: the local record could change
inside the awaited second file check, after the identity comparison. Moving
only that comparison was insufficient because `recordAt` awaited a digest
before replacing the record too. A later tombstone of the wrongly adopted
identity could then delete the newer note.

The repair finishes the content recheck first, then compares and replaces the
expected identity in one synchronous turn. It uses the digest that was already
proved equal instead of calculating it again after the comparison. The record
is still saved before the old identity is retired. Two regressions install a
newer, independently published local identity at these separate boundaries,
replay its own frame, then replay the other identity's deletion. Both require
the live note, its identity, its durable record and its live server version
to survive. Both fail against the previous source and pass with the repair.

The pinned `make check` passes with **783 plugin tests**, 144 core tests,
367 server tests, two CLI tests, 70 dashboard tests and 767 contract tests.
Rust line coverage is **94.65%**; both secret scans are clear. The core suite
retains its one ignored benchmark. Focused controls M710 (restore the extra
awaited digest) and M711 (compare before the second check) compile and fail
one and two of the eight focused tests respectively. M503 and M504 are re-cut
without changing the behavior they remove. The complete 783-test suite also kills all 15 new or re-cut controls below.
All 157 current patches pass a strict `-F0` application preflight; the other
historical kill counts have not been remeasured.

| Control | Failing tests out of 783 |
| --- | ---: |
| M01 | 39 |
| M02 | 23 |
| M03 | 17 |
| M127 | 7 |
| M128 | 2 |
| M129 | 2 |
| M147 | 1 |
| M500 | 2 |
| M501 | 1 |
| M502 | 1 |
| M503 | 3 |
| M504 | 3 |
| M505 | 1 |
| M710 | 1 |
| M711 | 2 |

One initial M501 run also failed an unrelated deletion-publication test: it
waited for the server frame, then asserted the local record before that record
had necessarily been written. The barrier now waits for both, with every
assertion retained. The original log is preserved; the final M501 run has
only its intended HTTP 507 witness. The final full gate includes this test
repair and passes. No kill is attributed to that unrelated timing failure.

## Independent pull-side persistence witness

The review of `37c05bf` cleared the replacement race and identified a remaining
coverage gap: M128 removes both the pull-side keeper replacement and its save,
while M502 protects the separate push-side save. Removing only the pull-side
save still passed the prior suite.

The new regression persists the higher identity, applies its identical lower
identity through the real pull path, and reloads State from storage when the
higher identity's retirement is submitted. It requires the lower identity and
its version at that boundary, requires it again after settlement, and checks
the note remains intact and the predecessor was actually retired. M726 removes
only that persistence call. It applies, compiles, and fails this one witness
in the complete **784-test** suite: 783 pass and one fails. No production code
changed; the bundle remains `7a937b63cbcf8f7bb536a45a0c40b34aeb3c066bb57817dfa99a46acd3006848`.

The pinned full `make check` passes all 784 plugin tests, 144 core tests,
367 server tests, two CLI tests, 70 dashboard tests and 767 contracts. Coverage
remains 94.65%; the one core benchmark remains ignored; both secret scans pass.
The mutation scratch initially omitted the vendored Obsidian declarations and
could not compile. That setup failure is retained separately and is not a kill.
The historical matrix counts above are unchanged; only M726 was newly measured.
