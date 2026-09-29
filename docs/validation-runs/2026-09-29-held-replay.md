# A replay over a vault the device holds — 2026-09-29

A device reads the whole feed again when it widens its Sync folders or pairs
again over the vault it kept. Issue #239: a note moved out of the selection
came back at its old name after the widening, so a device held two copies of
it. Issue #241: a note renamed before the device left was written at its old
name when it paired again, then posted again under a new id. This run
reproduces both on the 1.1.4 build and checks the fix on two computers.

## Setup

- Two isolated Obsidian 1.13.4 profiles on macOS 27.0 (A and B), each with its
  own disposable vault, driven through their DevTools ports.
- Server: obsyncd from this branch on the Mac's loopback, its state deleted
  before every journey. Every journey starts with new vaults: A sets up, B
  pairs.
- Builds (`main.js` SHA-256):
  - 1.1.4 (main at `afbf7e7`):
    `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`;
  - this branch, first run:
    `e173d1f15d555a7b70213eb933f8c92450cad274bd1b7b965ecb138c4091cd29`;
  - this branch, final:
    `3cabd34e58d3747db04b2a62022f46ca4ba0f2843feb6b0865eb6b384aaeabee`.
    It differs from the first run only in how a computer removes a folder
    Obsidian has not listed yet (below).

## Issue #239: a note moved out of the selection, then the whole vault

A syncs the folder `Sel` only; B syncs the whole vault. A creates
`Sel/Moved.md`, B receives it, and A moves it to `Out/Moved.md` in Obsidian.
Then A chooses **Whole vault** and saves.

1. **At 1.1.4: reproduced.** B held two copies: `Sel/Moved.md` under the
   note's own id and `Out/Moved.md`, which A had posted as a new note. A held
   one. The note's own history on the server still said `Sel/Moved.md`.
2. **At this branch: passed, both runs.** A logged
   `published_move reason=left_selection` for the note. A and B each held one
   copy, `Out/Moved.md`, under the note's own id, and its history on B showed
   two versions by A: the note, and its move.

The same with an edit meanwhile: A creates `Sel/Edited.md` and moves it to
`Out/Edited.md`; then B changes the note at its old name, `Sel/Edited.md`;
then A chooses **Whole vault** again.

1. **At 1.1.4: reproduced.** B's edit came back to A at `Sel/Edited.md`
   before the widening, and the widening posted `Out/Edited.md` as a new
   note: both devices held both copies, one with each text.
2. **At this branch: passed, both runs.** A never wrote B's edit at the old
   name (`pull decision=skipped reason=left_selection`). The widening posted
   the move on the version A held, B's edit met it by the rule for a rename
   meeting an edit, and both devices ended with one note, `Out/Edited.md`,
   holding B's text, under the note's own id: four versions, one head. In
   the final run B's edit reached A only during the widening's replay, and
   ended the same way.

## Issue #241: pairing again after a folder rename

A creates three notes in `J10/Old`, B receives them, and A renames the folder
to `J10/New`. B receives the rename, then leaves the server (**Leave this
server**, keeping its notes) and pairs again.

1. **At 1.1.4: reproduced.** B wrote the three notes at `J10/Old` first, then
   met the move with its own notes at `J10/New`: it posted all three again
   under new ids (three chunks, three versions), and A replaced its notes with
   those and deleted the originals. Every device kept one copy of each, and
   the notes' histories ended.
2. **At this branch: passed.** B skipped the three older versions
   (`pull decision=skipped reason=behind_held`), wrote nothing at `J10/Old`,
   and took each note where it stands (`adopted reason=identical_bytes`).
   The re-pair posted no chunk and no note version, the server's feed ended
   at the same entry as before it, and both devices kept the notes' own ids.

The first run of this branch showed a second defect on the way: B's status
read "Changes from your server could not be read" for five seconds. The
replay had made the folder `J10/Old` and then applied its deletion before
Obsidian had listed it. For a folder Obsidian has not listed, obsync used
Obsidian's own removal, which on a computer is `fs.rm` without `recursive`
and refuses every directory (`EISDIR`); the retry five seconds later found
the folder listed and removed it. This branch removes such a folder itself
(`rmdir`, which takes only an empty directory). At the final build the folder
went at the first attempt, and B's status went straight to idle.

### The same, with the note moved by the device that leaves

Another run on this train had once left a byte-identical conflict copy of a
moved note on both devices after pairing again. Its sequence, repeated here
on fresh vaults: A creates a note in a folder, a second note and an
attachment; B pairs, moves the first note to the vault's root and edits the
second; A deletes the attachment; B leaves and pairs again.

1. **At 1.1.4, three runs: reproduced each time.** Pairing again, B wrote
   the moved note's first version at its old name, then met its own kept
   note with the move: it kept the incoming copy beside it
   (`applied_beside`) and posted the note again under a new id. No conflict
   copy was left at the end of these runs; the kept copy is that same step
   finishing differently.
2. **At this branch, five runs: passed each time.** B skipped the moved
   note's first version (`behind_held`) and took the kept note as its move
   (`adopted reason=identical_bytes`): no conflict copy, nothing at the old
   name, no version posted, and one copy of the note, with the same bytes,
   on both devices.

## Visual sweep

After each journey at the final build, on both devices: the status item read
`obsync: idle` with the synced icon; no notice was on screen; **Show sync
status** showed the server, the device, idle, three notes tracked and nothing
remote-only; the obsync settings tab showed the connection idle and the
folder selection as saved. The only warning lines were the expected ones: A's
first read of a vault map that did not exist yet (`404 unknown_file`), and
B's wait for approval while pairing (`409 not_approved`).

## Timing

The first run of this branch widened in the time 1.1.4 took: the move was
decided in 1 ms, and each part of the #239 journey took 17 s end to end, as
at 1.1.4. The final run shared the Mac with other test runs (load average
above 100): the same steps then took minutes, and obsync's own steps
(`scope decision=saved` at up to 33 s, the note's move at 458 ms) were slow
in the same proportion as every other process. The outcomes did not change.
The eight runs of the second #241 sequence ran at load average 18 to 34, in
about two minutes each.

## Result

Both issues reproduced on 1.1.4 and passed at this branch, with no notice and
no extra copy on either device. Pairing again over a kept vault now posts
nothing, and a note moved out of the selection is published as one move when
the selection covers it again.
