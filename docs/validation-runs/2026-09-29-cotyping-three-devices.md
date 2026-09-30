# Two typists and a third device — 2026-09-29

Issue #227: two people typing in one open note on different lines could lose
one typist's last words to a conflict copy on a busy machine. This run
reproduces it on real Obsidian at origin/main, finds the two defects behind
it, and checks the fix beside origin/main, run by run, under the same load.

## Setup

- Host: one Mac (10 cores, macOS 27), shared with other work: load averages
  between 17 and 248 across the runs, six CPU burners (`node -e 'for(;;){}'`)
  added during each run.
- Devices: three desktop Obsidian 1.13.4 profiles, each with its own
  `--user-data-dir` and disposable vault, paired to one obsyncd on loopback
  (plain HTTP), driven over their DevTools ports.
- Driver: `scripts/validation/cotype-live.mjs`, standard `60000 200 60000`:
  a new note each run; one desktop types `A001 A002 …` on the last line and
  the other ` B001 B002 …` at the end of line 1, a keystroke every 200 ms each
  through DevTools `Input.insertText` (a trusted beforeinput, which obsync
  counts as typing), for a minute, then a minute of nobody typing. A run
  passes only when every disk holds exactly the expected text, every open
  editor shows its disk, and no conflict copy of the note exists. In the
  three-device runs the third profile types nothing and shows the note.
- Bundles (`main.js` SHA-256):
  - origin/main `afbf7e7`: `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`;
  - this lane's head: `f6293e8b96b1903b10a4116c53f31d01aaa3b6b14a529aed2fcdd75e5ff11909`;
  - origin/main with diagnostic logging (merge inputs, posts, host writes),
    for tracing only: `bf11298ca4ca99c37a59b2baeb63bf7e4adcfdf1e7422904ebaeb41e4a1f2781`.

## Reproduction at origin/main

These runs used the diagnostic bundle: origin/main's code with extra log
lines, so that a failure could be traced.

- Two desktops: 6 runs of 6 passed.
- Three devices, the note not shown on the third: 10 of 10 passed.
- Three devices, the note shown on the third: 1 run of 5 failed. Both
  desktops and the third ended identical, the editors matching their disks,
  and `B043` to `B053` were missing: they were in
  `Both-mun2v77v (conflict from …).md`.

The trace of that run, in order:

1. The third device merged every arrival while both typed (41 merges), each
   against a base inside the ten versions the server lists, so it never
   walked the version graph.
2. Pushes took up to 17 s at that load. Ten seconds after the typing
   stopped, each typist resolved the fork holding a save its push had not
   sent yet, and posted a merge carrying that save while naming the older
   recorded version as its parent.
3. The third device merged one typist's older version; that typist merged
   the third device's previous merge with its newer typing. The two
   heads shared two newest ancestors, and their base lay across the whole
   history of the other typist's line.
4. The third device read that history a version at a time:
   `refused reason=merge_ancestry_limit reads=64`, then
   `unmerged reason=overlap`, then `converged reason=unmerged role=keep`:
   it kept its own head, which lacked one typist's last words, and put them
   into the copy. Every device then took the kept head.

The CI failures of the 1.1.4 train (`A0A015` at 85fd32d, `A01012` at
f63dd25) are the same first defect at the unit level: their logged decisions
climb `criss_cross` one level a round to three, then `unmerged
reason=overlap` and settlement by rule. On six contended runs of the two
fake co-typing sessions at `afbf7e7`, 9 pairs of parents got two different
merges, and each of those merges carried text its device had not sent. With
the first rule below, the same six runs gave none.

## The fix

- A merge holds its two parents and nothing typed since: a note holding text
  its recorded version does not is sent first, on that version, and the fork
  is merged from what is sent. Two devices resolving one fork post the same
  bytes; the server keeps one version.
- Every version a resolution is shown is remembered, as a read one already
  was: the third device's base costs no read.

## Interleaved A/B, same load

The two bundles alternate run by run (main, head, head, main, …) on the
same instances, so both builds see the same load, and a run's line reports
its bundle's hash.

### Two desktops, the standard run

From this series on, every instance was launched with Chromium's
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-background-timer-throttling`. That way another window covering one of
these could not starve it, as it did in three-device run 7 below. The driver
prints each side's hidden time (`hidden_ms`). It was 0, except about one
second on both sides in runs 19 to 21. The windows stayed on screen through
each run, because typing needs a focused editor, and were quit between series.

| Run | Bundle | Result | Copies | Exact | Editor = disk | Notices X / Y | Load at end (1 min) |
|---|---|---|---|---|---|---|---|
| 1\* | main `19d32020` | pass | 0 | true | true | 0 / 0 | 56.47 |
| 2\* | head `f6293e8b` | pass | 0 | true | true | 2 / 1 | 67.88 |
| 3 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 52.81 |
| 4 | main `19d32020` | pass | 0 | true | true | 0 / 1 | 42.88 |
| 5 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 46.65 |
| 6 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 52.69 |
| 7 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 63.30 |
| 8 | main `19d32020` | pass | 0 | true | true | 0 / 1 | 102.97 |
| 9 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 168.99 |
| 10 | head `f6293e8b` | pass | 0 | true | true | 1 / 0 | 106.11 |
| 11 | head `f6293e8b` | pass | 0 | true | true | 0 / 1 | 92.39 |
| 12 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 129.55 |
| 13 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 115.04 |
| 14 | head `f6293e8b` | pass | 0 | true | true | 1 / 0 | 66.47 |
| 15 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 59.19 |
| 16 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 33.07 |
| 17 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 64.74 |
| 18 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 39.16 |
| 19 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 57.17 |
| 20 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 106.75 |
| 21 | main `19d32020` | pass | 0 | true | true | 1 / 1 | 47.37 |
| 22 | head `f6293e8b` | pass | 0 | true | true | 1 / 1 | 60.68 |

\* Not counted: the third instance was still running and paired, and until it
was quit during run 2 it merged every arrival (102 versions at the server).
Counted: 10 runs of origin/main and 10 of this head, all passing, with load
averages between 33 and 169. Two desktops pass on both bundles, as the
reproduction found. The failure needs the third device.

### Three devices, the note shown on the third

Runs 1 to 8 came before the switches above. Runs 9 to 14 came after, with the
same instances relaunched with them.

| Run | Bundle | Result | Copies | Exact | Editor = disk | Notices X / Y / Z | Load at end (1 min) |
|---|---|---|---|---|---|---|---|
| 1 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 73.76 |
| 2 | head `f6293e8b` | pass | 0 | true | true | 0 / 0 / 58 | 72.41 |
| 3 | head `f6293e8b` | pass | 0 | true | true | 0 / 0 / 58 | 87.85 |
| 4 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 61.61 |
| 5 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 62.14 |
| 6 | head `f6293e8b` | pass | 0 | true | true | 0 / 0 / 58 | 55.23 |
| 7 | head `f6293e8b` | **fail** | 0 | false | false | 0 / 0 / 46 | 248.40 |
| 8 | main `19d32020` | not run | – | – | – | – | 71.63 |
| 9 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 53.81 |
| 10 | head `f6293e8b` | pass | 0 | true | true | 0 / 0 / 58 | 65.39 |
| 11 | head `f6293e8b` | pass | 0 | true | true | 0 / 0 / 58 | 48.86 |
| 12 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 28.11 |
| 13 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 26.46 |
| 14 | head `f6293e8b` | pass | 0 | true | true | 0 / 0 / 58 | 168.81 |

Run 8 never typed. After run 7 the plugin did not load on one typist within
the setup's wait, and the run was stopped. Counted: origin/main passed 6 of 6
and this head 6 of 7. origin/main's failure mode (a copy after
`merge_ancestry_limit`) came up in 1 of 5 runs of the reproduction (on the
diagnostic bundle) and in none of these 6. So these runs cannot tell the
bundles apart on that failure at this rate. The unit tests do: both of them fail 3 of 3 at origin/main and pass
here.

Run 7 failed at this lane's head. From 13:21:27, as the typing ended, the host
starved all three instances. None made a request for 267 to 282 s, except one
chunk read, and the typist's last keystrokes reached its disk 50 s late, with the
final two characters still unsaved at the verdict. They ran again at 13:26:09,
when the driver read its verdict. The load average was 55 at the start and 248 at
the end, on a machine other labs shared. When checked at 13:41, all three
pages reported themselves hidden, covered by other labs' windows. Two further
findings followed, both beyond this lane's change:

- At 13:21:42 the typist logged `pull decision=unmerged reason=overlap` for the
  third device's merge over its own `A048` version. The replay gave a clean merge
  (the product's `threeWayMerge`, with that base and that incoming text) with
  every text the typist saved as its side. So the note it read was none of its
  saves. It was most likely read while Obsidian was writing it.
- At 13:26:09 the same typist paused the note as a rewrite storm (#179). A
  parked change retried when the editing window closed re-stamps the arrival
  clock, and the late save fell within five seconds of it, with no recent
  keystroke. The pause went to every device. While paused, each device held its
  own text and there was no copy. Resume on each device then made the third
  device's merge the note, and each typist's last words (`A051 A052`, `B051 B052
  B`) went into its own copy.

Neither was fixed by the change above. Both were reported as #278, and are
addressed in "Run 7's conditions on purpose" below. The run counts as a
failure of this lane's head.

## Notices

Every notice either bundle showed in these runs had the same text:
`obsync merged concurrent edits to Both-<id>.md.`. That is the file name, not
the note's title, and it shows once for each merge the device announces.

- Two desktops, over the 20 counted runs: each typist showed 0 or 1 per run,
  once both had stopped typing. origin/main showed 18 in 10 runs (typist X 8,
  typist Y 10), and this head 17 (X 9, Y 8). The earlier two-desktop hunt at
  origin/main showed 1 on each side in all six runs.
- Three devices, the note shown on the third: the typists showed none on
  either bundle, because the third device merged first and the typists took
  its merges. The third device showed one for every merge it made: 58 in each
  of the 12 passing one-minute runs on both bundles, and 46 in run 7, which
  starved.
  Its "own" side was its previous merge, so every merge of the two typists'
  words was announced as if it held an edit made there. That was so before
  this change too. It was reported as #279, and is changed below.

This change does not change when a merge is announced. A typist that holds a
save not yet sent now sends it first and merges one round trip later, and
announces that merge once, as before. A criss-cross it no longer makes is a
repeat merge, and a notice, it no longer needs. The counts above do not move
between the bundles.

## The open-editor refresh (#252)

A note open and idle on one desktop, edited three times on the other. Nothing
was typed on the first. In each round its editor had to show the edit, its
disk had to hold it, and its status had to read idle.

- This head (`f6293e8b`): 3 of 3, in 1274, 1281 and 1275 ms.
- origin/main (`19d32020`): 3 of 3, in 1281, 1019 and 1310 ms.

`plugin/test/open-editor.test.mjs` passes as part of the suite.

## CI's real-Obsidian journey

`scripts/ci/obsidian-drive.mjs` was run locally against a disposable obsyncd.
Its new co-typing journey has two instances each type their own line of one
open note for 20 s. It passed with both bundles:

- this head (`f6293e8b`): 100 and 100 keystrokes, all of them on both disks and
  in both editors 10566 ms after the typing stopped, no copy. The journey took
  32.0 s and the whole driver 50.1 s.
- origin/main (`19d32020`): the same, 10564 ms, 31.7 s, 49.5 s.

On two instances origin/main passes too. The journey pins the common case in
CI, and the three-device, loaded case stays a live run.

## Visual sweep

All three instances were checked on this head after the last three-device run:
at rest, after Sync now, Show sync status, and obsync's settings tab, with
every console warning and error recorded meanwhile. On each: status `obsync:
idle`, no notice open, nothing parked, paused or held, and no console warning or
error. Show sync status read idle with 64 files tracked, 0 remote-only and
the same feed sequence. The settings tab showed the loopback server,
Connection idle and the whole vault. The other status-bar item beside
obsync's check mark is Obsidian's own core Sync ("Uninitialized"), not obsync.
The file list still holds the copies the failing runs made: the reproduction's
`Both-mun2v77v (conflict …)` and run 7's three after Resume.

## Run 7's conditions on purpose (#278, #279)

Run 7 starved the instances by accident. For #278 its conditions were made
on purpose, on origin/main and on `a2a17fea` (this lane's head with #278's
two changes and #279's), alternating run by run as above.

- The instances were relaunched without the three Chromium switches, so a
  hidden window is throttled as a user's is. The note was shown on all three.
- Standard typing. 40 s into it all three windows were minimized through
  Electron, which hides the pages (hidden about 74 s each). In the frozen
  runs all three renderer processes were also stopped (`SIGSTOP`) for 45 s,
  then continued. The driver read its verdict at the end of the idle minute,
  the windows still hidden. The windows then came back, and 90 s later each
  device was read: a pause, a copy, and whether every disk and editor held
  the one expected text ("n/r": not recorded by that series' script).

| Series | Run | Bundle | Verdict | Paused | Devices with copies | One text, editors = disks | Notices X / Y / Z | Hidden s X / Y / Z | Load at end (1 min) |
|---|---|---|---|---|---|---|---|---|---|
| minimized | 1 | main `19d32020` | pass | 0 | 0 | n/r | 0 / 0 / 47 | 77 / 75 / 74 | 18.46 |
| frozen | 1 | main `19d32020` | **fail** | 0 | 0 | n/r | 0 / 1 / 54 | 76 / 75 / 74 | 31.34 |
| frozen | 2 | head `a2a17fea` | **fail** | 0 | 3 | n/r | 0 / 0 / 0 | 103 / 102 / 101 | 30.21 |
| frozen | 3 | main `19d32020` | pass | 0 | 0 | yes | 1 / 2 / 52 | 75 / 74 / 73 | 13.14 |
| frozen | 4 | head `a2a17fea` | pass | 0 | 0 | yes | 1 / 1 / 0 | 75 / 74 / 73 | 7.69 |
| frozen | 5 | head `a2a17fea` | pass | 0 | 0 | yes | 1 / 1 / 0 | 75 / 75 / 74 | 16.49 |
| frozen | 6 | main `19d32020` | pass | 0 | 0 | yes | 2 / 2 / 53 | 75 / 74 / 73 | 23.06 |
| frozen | 7 | main `19d32020` | pass | 0 | 0 | yes | 1 / 2 / 53 | 75 / 74 / 73 | 46.87 |
| frozen | 8 | head `a2a17fea` | pass | 0 | 0 | yes | 1 / 1 / 0 | 75 / 75 / 74 | 14.97 |
| frozen | 9 | head `a2a17fea` | pass | 0 | 0 | yes | 1 / 1 / 0 | 75 / 74 / 73 | 17.11 |
| frozen | 10 | main `19d32020` | pass | 0 | 0 | yes | 2 / 1 / 53 | 75 / 75 / 74 | 14.13 |
| frozen | 11 | main `19d32020` | pass | 0 | 0 | yes | 2 / 1 / 53 | 75 / 74 / 73 | 22.83 |
| frozen | 12 | head `a2a17fea` | pass | 0 | 0 | yes | 1 / 1 / 0 | 75 / 74 / 73 | 32.90 |

Frozen run 1 failed its verdict because a typist was still saving; 90 s
later all three held the whole expected text, with no copy.

Counted: no run paused the note, on either bundle: 0 of 7 on origin/main and
0 of 6 on `a2a17fea`, so run 7's pause did not come back, but it did not come
back on origin/main either at these loads (7 to 47). `a2a17fea` made copies
in 1 of 6 frozen runs (run 2): both typists' last words, on all three devices.
origin/main made none in 7. That is a live failure of this head, and #278 is
not closed by it. The version graph of run 2 shows the typist whose pushes
went out 42 s after the renderers continued closing every fork by rule over
the third device's merge, four times, one of them over the other typist's
own merge: what a device does once its merge breaker has tripped. Its trace
of those minutes was overwritten by the next run. A cause that fits: while a
push is late, each arriving version is left for it (#227's rule), and each
such wait counts toward the breaker as a resolution that changed nothing.
Not counting every such wait conflicts with two existing tests, which pin
that a run of waits over a peer's answer to this device's output must trip
it. The narrower change in "Waits for this device's own publication" below
keeps them.

Notices (#279): the third device showed 47 to 54 per run on origin/main and
0 on `a2a17fea`, which shows a merge only when one side holds text typed
there. The typists' counts (0 to 2) did not move.

After the renderers were stopped and continued, every device on both bundles
read `obsync: offline — retrying` for over a minute while the server answered
(runs 3 to 12, 30 device-runs of 30): the long poll started on waking reached the server
20 s after it was sent, and the client's 70 s budget ran out 5 s before the
answer. It is reported as a separate defect.

## Waits for this device's own publication (#278)

The breaker now counts a resolution that waited for this device's upload
and started over once, as the fresh resolution, and does not count one left
for this device's push over a version that holds nothing of this device's
own. A wait over a peer's answer to this device's output still counts.

Same rigs and procedure as above. The server was rebuilt from the train with
this change (`obsyncd` `17c03e0d…`), and both bundles ran against it. Bundles:
origin/main `19d32020` and this head `505aeebe`
(`505aeebef7f1c6f779fcb7d04efc09908b26affb64e0db3bf0b0f54c3a6eddf0`), 10 each,
alternating run by run.

### Frozen, three devices

| Run | Bundle | Verdict | Paused | Devices with copies | One text, editors = disks | Notices X / Y / Z | Hidden s X / Y / Z | Load at end (1 min) |
|---|---|---|---|---|---|---|---|---|
| 1 | main `19d32020` | pass | 0 | 0 | yes | 3 / 3 / 48 | 79 / 79 / 79 | 12.64 |
| 2 | head `505aeebe` | pass | 0 | 0 | yes | 1 / 1 / 0 | 75 / 74 / 73 | 22.03 |
| 3 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 0 / 0 | 86 / 89 / 90 | 24.29 |
| 4 | main `19d32020` | pass | 0 | 0 | yes | 2 / 2 / 53 | 77 / 77 / 76 | 16.41 |
| 5 | main `19d32020` | **fail** | 0 | 0 | yes | 0 / 0 / 0 | 81 / 79 / 78 | 38.81 |
| 6 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 0 / 0 | 105 / 107 / 108 | 30.91 |
| 7 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 1 / 0 | 75 / 75 / 74 | 17.94 |
| 8 | main `19d32020` | **fail** | 0 | 0 | yes | 0 / 1 / 0 | 76 / 74 / 73 | 24.06 |
| 9 | main `19d32020` | **fail** | 0 | 3 | **no** | 0 / 0 / 0 | 76 / 75 / 74 | 26.24 |
| 10 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 0 / 0 | 78 / 80 / 79 | 18.09 |
| 11 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 1 / 0 | 75 / 75 / 74 | 15.60 |
| 12 | main `19d32020` | **fail** | 0 | 0 | yes | 0 / 3 / 46 | 79 / 78 / 77 | 16.46 |
| 13 | main `19d32020` | **fail** | 0 | 0 | yes | 0 / 0 / 44 | 76 / 75 / 73 | 31.38 |
| 14 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 0 / 0 | 79 / 77 / 77 | 39.46 |
| 15 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 1 / 0 | 77 / 80 / 83 | 22.31 |
| 16 | main `19d32020` | **fail** | 0 | 0 | yes | 0 / 0 / 46 | 78 / 78 / 76 | 17.75 |
| 17 | main `19d32020` | **fail** | 0 | 0 | yes | 0 / 1 / 44 | 84 / 83 / 82 | 15.17 |
| 18 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 0 / 0 | 76 / 76 / 73 | 17.11 |
| 19 | head `505aeebe` | **fail** | 0 | 0 | yes | 0 / 1 / 0 | 76 / 75 / 74 | 11.28 |
| 20 | main `19d32020` | **fail** | 0 | 3 | **no** | 0 / 1 / 50 | 76 / 75 / 75 | 19.12 |

- **Paused:** none, on either bundle.
- **Copies:** this head made none in 10 runs. After the windows came back, every run held the whole expected text on every disk and editor. origin/main made copies in 2 of 10 (runs 9 and 20), on all three devices. Both were #227's first defect, with the third device logging `refused reason=merge_ancestry_limit reads=64` and then `converged reason=unmerged`.
- **Breaker:** no device on either bundle logged `merge_storm`. In 9 of 10 of this head's runs a typist logged `merge_budget_refund`, up to 18 in one run (run 6, 2 `started_over` and 16 `own_push`).
- **Verdict:** the driver's verdict, read with the windows still hidden, failed in 9 of this head's 10 runs and in 7 of origin/main's 10. In every one, a typist's status read `waiting for unsaved changes`: its hidden editor had not yet saved keystrokes that arrived after the renderers continued. Obsidian's save was still pending, not obsync's. 90 s after the windows returned, every one of those runs held the whole text.
- **Notices:** the third device showed 0 in each of this head's 10 runs. On origin/main it showed 44 to 53 in 7 runs, and 0 in runs 5, 8 and 9.

### Unfrozen, three devices, the note shown on the third

The instances were relaunched with the three Chromium switches, as in the
first three-device series, and the standard run was used: 6 burners, no
hiding, no stopping.

| Run | Bundle | Result | Copies | Exact | Editor = disk | Notices X / Y / Z | Load at end (1 min) |
|---|---|---|---|---|---|---|---|
| 1 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 23.67 |
| 2 | head `505aeebe` | pass | 0 | true | true | 0 / 0 / 0 | 33.61 |
| 3 | head `505aeebe` | pass | 0 | true | true | 0 / 0 / 0 | 29.60 |
| 4 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 19.00 |
| 5 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 17.89 |
| 6 | head `505aeebe` | pass | 0 | true | true | 0 / 0 / 0 | 18.39 |
| 7 | head `505aeebe` | pass | 0 | true | true | 0 / 0 / 0 | 27.39 |
| 8 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 19.56 |
| 9 | main `19d32020` | pass | 0 | true | true | 0 / 0 / 58 | 15.98 |
| 10 | head `505aeebe` | pass | 0 | true | true | 0 / 0 / 0 | 12.80 |

All 10 passed: 5 of 5 on each bundle, `hidden_ms` 0 on every device, load
13 to 34. The third device showed 58 notices per run on origin/main and 0
on this head, and the typists 0 on both bundles.

Visual sweep on this head after the last run, on all three instances: at rest,
after Sync now, Show sync status and obsync's settings tab. Each read
`obsync: idle` with no notice open and nothing parked, paused or held, and
no console warning or error was raised during the sweep. Show sync status on
the third device read idle, 32 files tracked, 0 remote-only. The file list
holds the two copies origin/main made in frozen runs 9 and 20.

## Not covered here

Phones and Windows, a device on 1.1.4 or earlier
beside updated ones (it can still post a merge carrying its unsent typing),
and more than one passive device.
