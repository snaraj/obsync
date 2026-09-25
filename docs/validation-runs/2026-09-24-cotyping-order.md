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
