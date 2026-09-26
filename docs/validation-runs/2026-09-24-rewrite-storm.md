# Rewrite-storm validation — 2026-09-24

Issue #179 is exercised by two real sync engines over the strict fake server,
with the host plugin from S89 represented by a one-second debounced front
matter rewrite. `stamper.test.mjs` covers both explicit Resume orders, an
editor receiving twenty keystrokes while the hold propagates, sequential
background answers, and a fixed-width rewrite that leaves modification time
and size unchanged. The paused note stops publishing on both updated devices;
each device gives one pause notice, and the main note contains every typed
character after Resume. The tests also cover ordinary two-editor typing,
restart persistence, failed resume, and the status dialog's actual Resume
button. `pause.test.mjs` checks control binding, replay, deduplication,
concurrent opposite controls, and the guards that preserve held content.

The opening results are automated engine and dialog evidence. Native desktop
observations follow below; no iPhone S89 result is inferred from them.

## Native finding and correction

Two unmodified Obsidian 1.13.7 instances used isolated synthetic vaults and a
locally installed fixture plugin calling `processFrontMatter` once per second.
Twenty letters were typed through the native editor while both stampers ran.
Both devices paused the note. During a measured five-minute hold, the server
received no further note-version POST, the note's stored record stayed fixed,
and the local stampers continued changing their timestamps. All twenty typed
letters remained in the main note.

After both stampers were disabled through Community plugins, Resume was
pressed on the first device and then the second. The main note converged with
all twenty letters, but **two conflict copies remained**, exceeding S89's
one-copy limit. One copy preserved the other device's earlier server head;
the second preserved its later held timestamp. Another five-minute quiet
window showed stable records and copies. This is a failed copy-count result,
not a native pass inferred from the automated suite.

The reproduction is now included in the follow-up work, covering both Resume
orders, an upload already in flight at pause, and stampers that continue
locally during the five-minute hold. The final corrected desktop rerun is
recorded below; these earlier failed observations are retained.

A subsequent native run on bundle
`7557e642f146659c8dfe3cf0e974f405d8ca904d6364898102ddaf5a92d3efed` found a
second case before the final acceptance run: both devices had the target note
open, but only the first person typed. Both timestamp fixtures were verified
enabled. The note did not pause, its main file held sixteen of the twenty
letters, and six conflict copies remained. Complete twenty-letter text
survived in four copies, so the observation is not total text loss; it still
fails the common-main-note and one-copy conditions. The fixtures were then
disabled and every file retained for diagnosis. The detector's open-editor
exemption was corrected to distinguish actual input from a passive view.

## Final native desktop rerun

Bundle SHA-256
`bd68df43b5ab64beaffc13803bcc6d95bfafea2ccf96664414c6102afc879fc1`
passed the desktop reproduction on a fresh target note with no pre-existing
conflict copy. Two isolated profiles of unmodified Obsidian 1.13.7 on one
macOS 27 laptop used the one-second front-matter fixture. Both editors were
open. Native key presses entered `ABCDEFGHIJKLMNOPQRST`, with a 500 ms delay
after each key, into the first editor while both fixtures were enabled.

Both clients held the note. All twenty characters stayed together in the
first main note, and no conflict copy appeared during the hold. Eleven samples
over **300.22 seconds** showed zero new note-version POSTs and unchanged
stored file records while the local timestamp fixtures continued rewriting.

Both fixtures were then disabled through Community plugins and their disabled
state verified. One **Sync now** on B, followed by one on A, cleared both
holds. Both main notes contained all twenty characters; both devices held
exactly one identical conflict copy preserving B's held text. The main-note
SHA-256 on both was
`762f3a9e222fdcfee0d0776e9830591c94d95ebd2a8b73e63fb52ceb44220d79`;
the copy was
`3d03c59cd3da366bf52bdfa40ccbb8d2343437fe7313106b93d7a350a3bc43dd`.
Eleven further samples over **300.32 seconds** found zero new note-version
POSTs, unchanged main notes and file records, one copy each, and no hold.
Both native status bars were idle.

The local evidence files are `179-overlap-typing-times.json`,
`179-overlap-five-minute-hold.json`, `179-overlap-resume-result.json`, and
`179-overlap-five-minute-quiet.json`. The [repair record](2026-09-24-rewrite-editor-overlap.md)
explains the editor-overlap guard and its mutations. Both Resume orders pass
the automated suite; this native rerun exercised B first only. Two application
instances on one laptop do not establish two physical computers or the
required iPhone S89 result. The subsequent [desktop and phone run](2026-09-24-phone-1.1.3.md#rewrite-hold-on-desktop-and-phone) completes that case on the final candidate.

## Older-client compatibility

The unchanged `1.1.1` source at
`f420d4d6e0f3071fc2f897ca30d86446fda254e6` was built under Node 26.8.2 and the
pinned TypeScript compiler. Its engine received a v3 pause control followed
by an ordinary note. The control was refused with `reason=version`, no file
was written at the control's path, the later note was applied, and the feed
cursor advanced to 3 (control sequence 2, note sequence 3). The check runs
through the old engine and old decoder, not through a replacement decoder in
the new client.

Reproduce from this checkout, using a fresh scratch directory:

```sh
legacy_dir="$(mktemp -d)"
git archive 1.1.1 plugin/src plugin/tsconfig.json plugin/vendor plugin/test/fake.mjs | tar -x -C "$legacy_dir"
plugin/node_modules/.bin/tsc -p "$legacy_dir/plugin/tsconfig.json"
node plugin/test/legacy-pause-check.mjs "$legacy_dir/plugin"
```

The receipt is:

```json
{"client":"1.1.1","controlSequence":2,"laterSequence":3,"cursor":3,"unsupportedControl":"refused","followingNote":"applied","feed":"advanced"}
```

Old clients keep syncing ordinary notes and do not participate in the shared
hold. All devices must update to stop a rewrite storm everywhere.

## Mutation equivalence

M567 was considered, then omitted before the mutation run: deleting only
`recorded.deleted ||` from the resume fallback condition is equivalent.
`decryptRecordManifest` first invokes `bindManifestToRecord`, which refuses
a deleted manifest unless `chunks.length === 0` and `size === 0`.
Consequently every validated tombstone necessarily satisfies the same
fallback's remaining `recorded.chunks.length !== 1` condition. No accepted
input can distinguish that deletion. It is not counted as a killed mutant.
The deleted, moved and multi-chunk baseline cases remain covered explicitly
by `pause.test.mjs`; the independent path and chunk-count conditions have
behavioral probes.

## Initial executor verification

Node 26.8.2 and TypeScript 5.9.3: the initial restored build passed, followed by **994/994 plugin tests**, with zero failures, cancellations or skips. The inherited worktree baseline passed 966/966. The final composed candidate subsequently passed `make check`, including **1,100/1,100 plugin tests**, 144 core tests, 375 server tests, two CLI tests, 70 dashboard tests, 767 contract tests, 94.73% Rust line coverage, and both secret scans. One core benchmark is intentionally ignored. The evidence is `final-overlap-make-check.log`. The complete final mutation matrix is recorded separately; the original focused counts below are not presented as its result.

All **69 non-equivalent behavioral probes** compile and fail directly relevant tests through `plugin/test/mutants/run.sh`. M484/M485 were recut to current source context; M555 onward was rerun after replacing an inherited shared compiler symlink with isolated pinned dependencies. No patch failure or compiler failure is counted. The table separates relevant failing tests from collateral failures observed in the parked-note and upgraded-device tests during some mutation runs; the final unmutated full suite is clean.

| Probe | Relevant failures | Collateral failures |
|---|---:|---:|
| M480 | 5 | 0 |
| M481 | 5 | 0 |
| M482 | 4 | 0 |
| M483 | 1 | 0 |
| M484 | 1 | 0 |
| M485 | 1 | 1 |
| M486 | 2 | 0 |
| M487 | 5 | 0 |
| M488 | 1 | 0 |
| M489 | 2 | 0 |
| M490 | 5 | 0 |
| M491 | 3 | 0 |
| M492 | 1 | 0 |
| M493 | 1 | 0 |
| M494 | 4 | 0 |
| M495 | 3 | 0 |
| M496 | 5 | 0 |
| M497 | 8 | 0 |
| M498 | 1 | 0 |
| M499 | 1 | 0 |
| M530 | 4 | 0 |
| M531 | 4 | 0 |
| M532 | 6 | 0 |
| M533 | 1 | 0 |
| M534 | 2 | 0 |
| M535 | 2 | 1 |
| M536 | 1 | 0 |
| M537 | 1 | 0 |
| M538 | 1 | 0 |
| M539 | 1 | 0 |
| M540 | 1 | 0 |
| M541 | 1 | 0 |
| M542 | 1 | 0 |
| M543 | 1 | 0 |
| M544 | 1 | 0 |
| M545 | 1 | 1 |
| M546 | 1 | 0 |
| M547 | 1 | 1 |
| M548 | 1 | 0 |
| M549 | 1 | 1 |
| M550 | 2 | 1 |
| M551 | 1 | 0 |
| M552 | 5 | 0 |
| M553 | 1 | 0 |
| M554 | 2 | 0 |
| M555 | 1 | 0 |
| M556 | 6 | 0 |
| M557 | 1 | 0 |
| M558 | 1 | 1 |
| M559 | 1 | 0 |
| M560 | 1 | 0 |
| M561 | 1 | 1 |
| M562 | 1 | 0 |
| M563 | 2 | 0 |
| M564 | 2 | 0 |
| M565 | 1 | 0 |
| M566 | 1 | 2 |
| M568 | 1 | 1 |
| M569 | 1 | 0 |
| M570 | 1 | 0 |
| M571 | 1 | 0 |
| M572 | 1 | 0 |
| M573 | 2 | 0 |
| M574 | 1 | 0 |
| M575 | 1 | 0 |
| M576 | 1 | 0 |
| M577 | 1 | 1 |
| M578 | 1 | 0 |
| M579 | 1 | 0 |
