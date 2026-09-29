# What obsync writes is listed while file events are starved — 2026-09-29

Issue #253: on a Mac whose file-event service is overloaded, a note obsync
downloads is on the disk and synced, but Obsidian does not list it. This run
reproduces that on 1.1.4, checks the fix, and measures what the fix costs.

## Setup

- Two desktop rigs, A and B: Obsidian 1.13.4 on macOS 27.0 (APFS, which folds
  case), each an isolated profile with its own disposable vault, driven
  through its DevTools port. B is the receiving device throughout.
- Server: `obsyncd` from `origin/main` (`afbf7e7`) on the Mac's loopback.
- Builds (`main.js` SHA-256):
  - before, 1.1.4 (`afbf7e7`):
    `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`;
  - after, this change:
    `e40140bfb927239221c7ef76a526f5f3d534182b47d3dc44ff71e14d0c3244ae`.
- Starvation, two ways. Deterministic: B's own file watchers are closed from
  its window (`adapter.stopWatchPath`), after two notes have reached B and
  been listed with the watchers working. Natural: a churn of renames to fresh
  names across many directories outside any vault, until `fseventsd` runs
  above 100 % CPU (`ps`).
- Every change is made on A through Obsidian's own API, as a person's edit
  is. B is watched until the change is on its disk, then until Obsidian's
  listing agrees with the disk, for up to 120 s. B's version posts are
  counted from the server's own request log.

## Deterministic starvation

| Change made on A | Before: listing on B after 120 s | After: listed on B |
| --- | --- | --- |
| A new folder with a note, and a note at the root | none of the three listed | 1-2 ms after the note reached the disk |
| A listed note renamed | new name missing, old name still listed | 1-2 ms |
| A listed note deleted | still listed | 1 ms |
| An empty folder made | not listed | 1 ms |
| A listed folder holding a note renamed | new folder and its note missing | 2-4 ms |
| A note renamed by capitals alone | neither spelling listed | 1 ms |

Before, the note made on A was missing from B's file explorer (loaded and
shown), quick switcher, search and `getAbstractFileByPath` after 120 s.
After, it was in all four, and the file explorer agreed with the disk on all
eleven names the six changes touched. B posted no version in either build,
showed no notice, logged no warning, and read `idle`. Each after-run logged
one `vault … decision=listed` or `decision=unlisted` line per name it fixed.

A note obsync rewrites that Obsidian already lists was outside this change:
under the same starvation, search still found only its old words 10 s after
the new ones reached the disk, on both builds. Issue #267 covers it, below.

## Natural overload

The churn held `fseventsd` at 124-191 % CPU for four minutes (the machine's
load average reached 183 with other work beside it). Before, B's own watcher
still listed a new note 280 ms after it reached the disk, a rename 261 ms and
a deletion 258 ms: this lab's overload slowed the events without losing
them, so it did not reproduce the report's twenty minutes. After, each was
listed 1 ms after it reached the disk, and B posted nothing.

## Cost

B pulled 300, then 1,000, new notes made on A in one folder, with its watcher
working. The watcher had already listed 72 and 164 of them when obsync
looked; the rest took one reconcile each, 228 and 836: 1 ms at the median,
3 ms at the 95th percentile, 33 ms at most, 1.5 s in all for 1,000 notes. A
pulled note's whole apply took 48 ms at the median after the change and 63 ms
before it on the same loaded machine: the reconcile is lost in that noise.

## The CI journey

`scripts/ci/obsidian-drive.mjs` now closes the second instance's watchers and
checks that a note in a new folder, a rename and a deletion made on the first
are listed there. Run on this Mac against a disposable server: before, it
stopped at that step after 30 s (`DENY b lists what obsync changed on its
disk, with its watcher closed`); after, it passed, the note listed 2 ms after
it reached the disk, the step taking 2.3 s.

## Whole-app sweep (after)

On A and B after a starved run: no notice; the status item `idle`, synced;
Show sync status `idle`; the obsync settings tab unchanged; no warning or
error in either console. The new note is in B's file explorer and search.

## New words in a listed note (issue #267)

The same rigs, with B's watchers closed. Before is the #253 build above
(`e40140bf…`); after is the #267 change (`d80300d6…`, and `587be169…` for the
first run and the cost run, which is the same code before one doc-comment edit). A made three
notes. B listed them and found their old word in search while its watcher was
still working. B then opened one note in a tab and one in a split, and A edited
them.

| On B | Before | After |
| --- | --- | --- |
| A note in no view: core search for the new word | not found after 60 s; the old word still found; the cached size still the old one | found by the first search, 0.6 s after the text reached the disk; the old word gone |
| A note open and idle | the editor showed the new text 1 ms after it landed (#252); search did not find the new word in 15 s | the same: the editor 3-53 ms, search not in 15 s, the reconcile skipped (`reason=open_view`) |
| B typing 69 words over 14 s (trusted input) while A typed five on another line of the same note | the view was never reloaded while typing or unsaved; no notice; no word lost; both disks equal with every word 10.3 s after the typing stopped | the same, 10.3 s |

B posted no version for either received edit, in either build. The only posts
in the typing row were B's own saves of its own typing. After, 200 listed notes
edited on A with no view on B took one reconcile each: 1 ms at the median,
2 ms at the 95th percentile, 14 ms at most. Every cached size was right 3 ms
after the last note reached the disk, and B posted nothing. The machine's load
average was 35-203 during these runs.

The CI journey's starved step now also edits a listed note. Before, it stopped
there after 30 s (`DENY b's index reads the edit to a note it lists, with its
watcher closed`); after, it passed, with the index right 2 ms after the edit
reached the disk. The whole-app sweep of A and B afterwards showed the same as
above. B's search pane showed `No matches found` for the open note's new word,
which is the limit the table states.

## Not covered here

Windows and Linux: the CI journey above runs there in real Obsidian, and the
Windows VM run is the coordinator's.
