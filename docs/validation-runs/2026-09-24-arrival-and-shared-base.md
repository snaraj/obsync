# Arrival timing and shared merge bases, 2026-09-24

This is an automated follow-up to the [history and typing repair](2026-09-24-history-and-typing.md), for existing issues #135 and #179. It uses the pinned Node 26.8.2/npm 11.19.1 and Rust 1.98.0 toolchains. Synthetic desktop/mobile hosts are simulations; this record does not establish native acceptance.

## Background-rewrite recovery

The repeated pristine baselines exposed a missing background verdict after a clean merge. Further diagnostics found two earlier windows: a waiting save was judged against a later arrival, and a host plugin could answer the incoming write before the engine recorded that arrival. The affected device could receive the editor's Resume role, or keep publishing beyond the existing version bound.

The repair records an authenticated ordinary-file arrival before its write can notify a host plugin. A pending save retains its verdict against the previous arrival, including a user's explicit non-background verdict. A clean merge carries a contributing background verdict onto its own resulting timestamp. Actual typing, unchanged remote content, missing files, replacement identities and unselected paths provide no such proof. Echoes, invalid manifests and nested-vault refusals cannot replace arrival evidence.

The original end-to-end assertions remain: both devices hold; the rewriting device has the background Resume role; every one of twenty typed characters ends in the main note; at most one copy is kept; the version bound and five-minute quiet windows hold in both Resume orders. Earlier failing runs remain failures, not mutation kills or alternate accepted outcomes.

## Continued typing and shared ancestors

A later full gate exposed copies and duplicated characters during same-line typing. A trace showed continued typing before a suffix already received from the peer. That preserves the original characters but is no longer a simple append. Bounded code-point alignment now merges these additions in separate gaps when every original character remains in order and the beginning is unchanged. Competing prefixes, replacements and deletions remain conflicts. Character alignment uses the existing 4,000,000-cell ceiling.

A deterministic encrypted-graph witness separately reproduced duplicated shared text: two merge heads based on both `abL` and `abR` became `abLRxyR`. Combining the two common ancestors first gives `abLyRx`, with the shared `R` once. Shared bases are now resolved before even a clean-looking append. A missing, unresolvable or over-depth base is refused; it cannot fall back to one ancestor. The existing three-level limit and fourth-level refusal remain tested.

The first insertion repair incorrectly merged competing prefixes. The two existing conflict-preservation tests failed in every baseline and the full gate. The unchanged-beginning restriction repaired that regression; those assertions were retained. Six later runs all passed the rewrite and co-typing cases, but two reached an existing same-name rename assertion before the rename POST completed. That fixture now waits for the bounded follow-up publication before checking exactly one rename, its owning file ID, both notes, and subsequent two-way edits. None of these earlier failures is omitted from the evidence.

## Author checks

The production bundle SHA-256 at the preceding arrival/shared-base repair was
`74422fb18ce29e5b2d79e0213b55203c026cc81fcde49e343d3b2e63ed5f06c8`.
The preceding full gate passed 1,163 plugin tests. After three further negative witnesses and the rename wait correction, six isolated pristine copies each passed all **1,166** plugin tests. The final `make check` also passes: 1,166 plugin tests, 144 core + 375 server tests and two CLI tests, 70 dashboard tests, 767 contracts, 94.73% Rust line coverage, and both secret scans. The core benchmark remains intentionally ignored. Source and test hashes were unchanged throughout that run.

Fifty new or re-cut mutation controls apply with zero fuzz, compile and fail their intended tests: the 32 new controls M765–M796 plus 18 existing controls re-cut around the changed code. An initial focused selector omitted the parked/nested suites and one insertion witness; these were rerun against the actual relevant suites. Three surviving focused controls led to additional witnesses for an unselected old path and failure to resolve a shared base. All seven final rechecks fail behaviorally and pass after source restoration. Compilation errors and missing tests are not counted as kills.

All **741** catalog patches pass strict application preflight. Their complete 1,166-test mutation campaign is running as a separate measurement; the historical `MATRIX.md` is not its result.

### Mutation measurement follow-up, 2026-09-25

The partial campaign stopped at M148 because the old runner omitted Node's
cancellation count. Full TAP reproduces all 1,166 outcomes: 1,164 pass, one
loading-screen assertion fails, and the vault-listing test reaches its
60-second timeout and is reported as cancelled. The runner now retains all
summary counts, and the recorder displays cancellations separately from
assertion failures. Incomplete runs and compile failures remain unmeasured.

M15 separately survived all 1,166 tests. The newer publication lock keeps
uploads serial, but the existing joined-upload test did not exercise a burst
of requests. Its strengthened witness sends twelve overlapping requests while
the older upload is held, then checks both complete versions, the latest
record and exactly two note reads. Pristine reads the older and latest bytes
once each; M15 reads thirteen times and fails. M25 and M26 also still fail the
retained latest-edit assertion. All three controls apply, compile, fail the
focused witness and restore cleanly. No production code changed. Earlier
partial measurements are preserved; they are not the final matrix.

The complete gate passed after that witness change, but one of six fresh
baselines reached the phone-to-desktop case-only rename's log assertion before
the note-move receipts arrived. Its folder had already changed case, which
made the old path/stat condition look settled. Delaying those receipts by
400 ms reproduces the premature assertion. The fixture now keeps that delay
and waits for both note-move versions to be published, recorded on both
devices and consumed from the feed. All original path, identity, content,
no-tombstone, no-conflict and held-move assertions remain unchanged. The
targeted corrected test passes; this changes no production behavior.

A later six-run baseline retained both complete sequences and no conflict
copies, but one adjacent-line run left two server heads. Its original failure
is retained. Investigation also deterministically reproduced an identical-head
closure gap: a device holding the larger head adopted the smaller one without
closing the fork, depending on the other holder to be online. Either holder
now closes exactly the two authenticated, compared heads. Simultaneous
closures use the existing authenticated deduplication path and append one
frame. The original third-head and retired-head refusal cases still pass.
The positive control now exercises the smaller holder alone, larger holder
alone and both racing; M797 restores the dependency on the smaller holder.
The co-typing failure report now includes both local version IDs, current
heads and feed positions so a remaining fork can be distinguished from
unfinished feed consumption. The original adjacent-line failure did not recur
in twenty focused diagnostic repeats before the repair, so its exact timing
cause is not claimed as proven. After the deterministic closure repair, the
full local gate and six independent 1,168-test baselines pass. M797 applies,
compiles and produces two focused assertion failures with no cancellations;
restoration is verified. All 742 mutation patches pass exact-context preflight.
That campaign stopped after M165 survived all 1,168 tests. The co-typing
session checked each conflict copy's root-version count, but its successful
no-copy outcomes did not exercise concurrent publication of a preserved copy.
A new two-device witness creates an overlapping replacement and holds both
copy posts until each device has independently computed its preservation.
It checks one shared copy path, file ID, acknowledged version and server
head, exactly one stored copy version, both original texts and a closed main
fork. M165 withdraws the copy's deduplication offer: it applies and compiles,
then fails because two copy versions were stored (one assertion failure,
zero cancellations). Restored production code passes. This is a test-only
repair; the production bundle remains
`ddd6683f65ea001e833116f386606604b168b641e5ce995d6b19a28abb47480c`.
Earlier measurements are preserved. No final matrix or native acceptance
result is claimed.

The next campaign stopped when M164 survived all 1,169 tests. The earlier
history shortcut now handles a complete current-head view before the older
descendant guard runs. The stale-head witness retains that complete-view
case and adds an incomplete view: one unrelated head is unreadable, while
the incoming version's replacing descendant remains visible. Production
still skips the obsolete fork without writing or copying anything. Removing
the descendant guard with M164 creates a stale conflict copy and fails the
new case, with one assertion failure and zero cancellations. Both cases
pass after restoration. This also changes tests only.

Reproduce the focused behavior with the pinned toolchain:

```sh
npm --prefix plugin run build
node --test plugin/test/stamper.test.mjs plugin/test/rewrite-overlap.test.mjs \
  plugin/test/conflict.test.mjs plugin/test/cotyping.test.mjs \
  plugin/test/samename.test.mjs plugin/test/parked.test.mjs \
  plugin/test/nested-vault.test.mjs
```

The [phone timing follow-up](2026-09-24-phone-timing-followup.md) publishes two additional sanitized captures of an earlier build, with its failures and limitations intact. Neither those images nor the automated checks above substitutes for native fresh-pairing, typing and rewrite/Resume acceptance on this repaired bundle. Test-resource cleanup also remains outstanding until that validation finishes.
