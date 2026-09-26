# Co-typing publication order follow-up, 2026-09-24

The pristine 1.1.3 baseline at `cba9eec` failed one of six full-suite lanes:
part of the peer's typed line remained in a conflict copy. Five lanes passed.
The final mutation run was paused; none of these failures counts as a
mutation kill. The physical phone run at that source remains evidence only
for its recorded input cadence.

## Reproductions and repair

Synthetic two-editor traces with delayed platform-crypto completion exposed
several related paths through the same failure:

- An editor upload could read a merge's newly written bytes before the merge
  receipt updated its parent. Merge writes now reserve the existing per-note
  publication queue before writing and retain it through the receipt.
- An upload could finish while a merge prepared its write, leaving no pending
  promise but a newer local parent. The merge now rechecks the version and
  retries from the current graph. The deterministic witness previously left
  two server heads even though every character was present on both devices.
- Obsolete feed entries consumed the merge-loop budget during catch-up. An
  incoming version with a retained descendant head is now skipped before
  counting. A missing graph entry is not treated as proof of supersession.
- One typist could stop while the peer continued its independent branch.
  Progress descending from the previous peer version, without incorporating
  this device's recorded output, starts a new count. Repeating one head,
  unrelated forks, and replies incorporating this device's output still
  reach the existing limit. Neither the five-resolution limit nor the
  three-level criss-cross bound increased.

A previous delayed-receipt regression held its receipt while awaiting another
merge. That schedule now waits behind the publication reservation. Its fixture
now directly installs the newer durable record while withholding the receipt,
retaining the original no-overwrite assertions and the M715 mutation witness.
The blocked exploratory run is retained as a fixture failure, not a pass.

## Evidence

Eight new controls apply and compile. Their focused witnesses are M716 (one),
M717 (two), M718 (one), M719 (one), M720 (two), M721 (one), M722 (one), and
M723 (one). The retained M715 also compiles and kills its delayed-record
regression. M151, M162 and M714 are mechanically re-cut to the same behavioral
changes after the surrounding code moved. All **668** current patches apply
with zero fuzz. The first M717 draft did not compile; its corrected compiling
run is the mutation evidence, and the compiler failure is not a kill.

Six isolated synthetic co-typing schedules, with crypto-completion delays of
5, 7, 10, 0, 5 and 7 milliseconds, all converge on one server head, identical
main notes containing both complete sentinel sequences and zero conflict
copies. Their local receipts are `cotyping-trace-94` through `-99`. Earlier
failed schedules remain alongside them. These synthetic scheduling controls
are not measurements of real network latency.

The candidate bundle SHA-256 is
`95b13f24ade8b4760a21216df10ef0cd9fb7b99c139e0b2e65cdd56e516e2e68`.
The final pinned `make check` passes **1,114 plugin tests**, Rust 144 core +
375 server + two CLI tests, 70 dashboard tests, 767 contracts, 94.73% line
coverage and both secret scans. One core benchmark remains intentionally
ignored. Six pristine matrix baselines, complete mutation measurement and
affected native follow-up remain pending. The existing matrix is historical until its
replacement is measured. No Ready or release claim follows from these focused
results.

## Final baseline follow-up

The subsequent six-lane baseline did not establish a clean final candidate.
One lane observed a case-rename fixture before its delayed note moves had
finished. Waiting for the folder alone was insufficient: its two note records
must match their latest server frames on both devices. A 400 ms transport
delay reproduces the old assertion failure; the corrected barrier retains
the two-version, identity, path and quiet-scan assertions.

A later baseline exposed a real pending-change race. A note can move before
Obsidian reports its rename, while an earlier change is still settling. The
missing old path went directly to deletion. It now enters the existing bounded
move-discovery path; an old path whose identity was already removed by a pulled
move is ignored. A deterministic withheld-rename test fails before this repair
and passes after it. M724 restores the direct deletion and fails that test;
M725 removes the stale-identity check and fails both pulled-move echo tests.
Both controls apply and compile.

Continued typing also produced a deeper crossed-merge chain in a diagnostic
full-suite run: one sequence survived only in a conflict copy. A successful
merge using a virtual criss-cross base now defers when the local bytes differ
from its authenticated recorded head. The normal push publishes the typing
on that parent before another merge, so both devices merge published inputs.
The regression requires no premature publication, intact typed bytes, then
complete combined text, one server head and no conflict copies. Removing this
deferral (M727) or reversing its digest comparison (M728) compiles and fails
the witness. The existing three-level graph and memory bounds remain intact.

Two other asynchronous fixture barriers now wait for their actual completion:
the nested-vault refusal before measuring notice quietness, and the new
engine's restore probe before asserting its count. Their original assertions
remain. Diagnostic traces and prior failures are retained outside the repo;
they are not mutation kills or final native acceptance.

The follow-up's pinned `make check` passes **1,117 plugin tests**, 144 core +
375 server + two CLI tests, 70 dashboard tests, 767 contracts and both secret
scans, with 94.73% Rust line coverage. This includes the predecessor's new
independent pull-persistence witness. Six separate pristine matrix lanes each
pass the same 1,117 tests. All **673** mutation patches apply with zero fuzz;
M152 retains its original crossed-base removal and M726 retains its save-only
removal after re-cutting their context. M724, M725, M727 and M728 have one,
two, one and three focused failing tests respectively, after successful builds.
The current bundle is
`530ca4aeb1fee893817f99110346226e7573714c542f3d303b45971e0f4b85aa`.
Complete mutation measurement and affected native acceptance remain pending.

The first final matrix stopped after **54 cases** because M133 survived its
complete 1,117-test run. Its ID-order-dependent witness is replaced as recorded
in [the review repair log](2026-09-24-review-fixes.md#deterministic-upload-content-witness).
The strengthened 1.1.3 suite passes **1,120 tests** in the pinned full gate;
Rust, dashboard, contract, coverage and secret-scan results remain passing.
Production source and the `530ca4ae` bundle are unchanged. The partial matrix
and its survivor are retained; the complete matrix must use the updated suite.
