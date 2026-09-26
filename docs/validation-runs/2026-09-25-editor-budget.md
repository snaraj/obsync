# Editor refusal and merge-budget follow-up, 2026-09-25

This continues the [three-device typing campaign](2026-09-25-passive-peer-typing.md).
Final acceptance remains incomplete. The record below retains a failed
matched-build run, two passing diagnostic replays, a separately reproduced
accounting defect, and the resulting repair's automated checks.

## Matched-build typing failure

Both isolated desktop profiles and the physical phone ran Obsidian 1.13.7
with bundle SHA-256
`9cda676aa68087adf1e4f3eabe5b120c128fd490004fa84651ed279dd746c233`.
The server, private routes and manual-install boundaries were unchanged from
the preceding record. Two desktop profiles are still one physical computer.

The typing desktop's displayed content stopped updating while native
accessibility and saved files changed. Reopening that isolated app with
the temporary `--disable-gpu` launch option restored visible editor updates.
This is a QA environment qualification, not proof of a product cause or a
recommended user configuration. The owner's Obsidian app was untouched.
An earlier attempt placed the desktop caret on the wrong line; it is retained
locally and excluded from the intended adjacent-line acceptance schedule.

For the verified run, a temporary character confirmed the desktop insertion
point at the end of the first line. It was removed and the clean two-line
baseline was verified on both devices before measurement. Forty individual
native key events took 61.713 seconds, including a visual checkpoint after
the first ten letters on each device. Both sequences were correctly placed
at that checkpoint.

The final main note held all twenty desktop letters and only the first ten
phone letters. Six new conflict copies appeared. One copy held all twenty
phone letters: the input reached the device and was preserved, but the main
note did not merge as required. The phone visually matched the desktop's
incomplete main note. Read-only checksummed journal replay established one
server head and 125 stored versions for this synthetic note; a single head
does not make that result a pass.

Two later replays added temporary diagnostics only to the two QA desktop
installations. The diagnostics recorded merge inputs and budget decisions
for this named synthetic note, never credentials or other notes. Both passed
with complete main text and no additional copies. The first took 60.422
seconds; the second deliberately allowed a twenty-second midpoint interval.
They do not clear the uninstrumented failure. Its exact decision trace was
not captured, so linking it to the accounting defect below remains an
inference until repaired native acceptance is completed.

## Reproduced accounting defect and repair

A focused probe against the unchanged candidate established a false-conflict
path without timing assumptions. Two compatible branches were presented
repeatedly while the host refused the merged write with `EditorBusy`. Each
refusal consumed the loop budget. The sixth attempt created a conflict copy
although none of the preceding writes had completed; allowing writes again
left the main note incomplete.

The repair refunds only an editor-busy attempt. Other errors retain their
charge and the loop limit remains unchanged. Each new local edit or proven
independent peer advance starts a new accounting generation. A delayed
refusal cannot refund a charge from that later generation or erase another
completed resolution's charge. The refund has a structured diagnostic line.

Four regressions cover eight refused writes followed by successful
convergence, ordinary I/O failures, and concurrent successful resolutions
with and without a new local edit. The unchanged candidate failed two of
these cases. All four pass after the repair; the combined editor-retry,
co-typing and new regression run passes 53 tests.

Repaired bundle SHA-256:
`599770e0512d9222fa08810a03980bb690876d46977debc8bc201f2a65954aa3`.

The full `make check` passed with unchanged source and test hashes in
240.438 seconds: 1,200 plugin tests, 70 dashboard tests, 144 core tests,
375 server tests, two CLI tests, 767 repository contracts, 94.73% Rust line
coverage and both secret scans. One core benchmark is intentionally ignored.
Controls M825–M828 all apply and compile, fail behavioral assertions with
zero cancellations, and pass after restoration. Eight inherited controls
were recut without changing their defects and likewise fail their focused
witnesses after compilation.

## Mutation recording

The preceding 769-control campaign stopped when M518 reported 21 failures
but the output filter retained only eighteen names. Three failing nested
tests were indented and omitted by the filter. The final stopped snapshot
contains 285 completed sections, with all six source copies restored. It
is retained as partial evidence, not a complete matrix result.

The runner now retains indented failure lines and the recorder reads them.
All 773 current patches pass strict applicability without fuzz. Six pristine
copies each pass the 1,200-test suite before the new frozen-input campaign.
That campaign remains running; `MATRIX.md` is historical until completion.

## Earlier current-bundle desktop rewrite control

Before the editor-budget repair, the `9cda676a…` bundle passed a scoped
two-desktop rewrite hold lasting 303.457 seconds across eleven samples.
Both timestamp fixtures kept changing their local note while the server
stayed at four versions and one head, with no conflict copies.

After both fixtures were disabled, the passive desktop resumed first and
the typing desktop second. Both retained all twenty typed letters and one
identical preserved copy. Eleven post-Resume samples over 303.474 seconds
showed stable main and copy hashes, five stored versions, one server head,
no paused note and both fixtures disabled. Both isolated apps had been
gracefully reopened after UI-control timeouts before Resume; uninterrupted
app lifetime is not claimed. A later misdirected search-text insertion took
place after sampling ended and is excluded from these measurements.

This was a desktop control. It neither exercises the phone's rewrite
fixture nor establishes acceptance of the subsequent `599770e0…` bundle.
Its phone typing and rewrite/Resume checks, complete mutation campaign and
final removal of synthetic QA artifacts remain outstanding.
