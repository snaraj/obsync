# Folder records: a renamed selected folder and a retried record — 2026-09-29

Issue #240: renaming a folder that is one of a device's **Sync folders on this
device** left an empty folder with the old name on every other device. Issue
#238: a folder record retried after a duplicate report could be sent after the
moves inside it. This run reproduces #240 on the release build, checks the fix
on three real Obsidian desktops, and checks #238's rename on the same rig.

## Setup

- Three desktops: Obsidian 1.13.4 on macOS 27.0, each an isolated profile
  with its own disposable vault, driven through its DevTools port. A and B
  from the start; C paired afterwards.
- Server: obsyncd from this branch (no server change) on the Mac's loopback,
  `OBSYNC_EDGE=none`.
- Builds (`main.js` SHA-256): release 1.1.4 (`afbf7e7`)
  `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`; this
  branch (`6e51e49`)
  `7ef62fbce124a2f70918c9bf90ad2cf9836fbaef4ba3a7b40c03e4ad4f8ff971`.
- A saved its selection before setup, as `docs/validation.md` asks: `W201`
  and `W201 sel`. B and C sync the whole vault.
- Vault on A: `W201/Root note.md`, `W201/Sub/Deep.md`,
  `W201/Case Docs/Case One.md`, `W201/Case Docs/Case Two.md`,
  `W201 sel/Sel one.md`, `W201 sel/Sel two.md`, `W201 sel/Inner/Inner.md`,
  and `Outside/Not synced.md` outside the selection.
- Every rename was made on A through Obsidian's own `FileManager.renameFile`,
  as the file explorer makes it. Each result was read about 35 s after the
  moved notes reached B: folders on disk, folder records, notes and file ids,
  obsync's decision lines, notices, and whether the server still held the old
  folder's record live (the device's own signed read of that file).

## Release 1.1.4

1. **Rename `W201 sel` to `W201 sel 2026`: fails (reproduces #240).** The
   notes moved on B with the same file ids and A's selection followed, but A
   logged `push path_class=file decision=not_synced reason=outside_sync_scope`
   twice, for the folder and for `Inner`. B kept `W201 sel` and an empty
   `W201 sel/Inner` with their records, and the server held the old folder's
   record live.
2. **C paired afterwards** created an empty `W201 sel` and `W201 sel/Inner`.
3. **Rename `W201/Case Docs` to `W201/case docs` (capitals only)** passed: B
   logged `kept reason=not_empty items=2`, `case_renamed files=2`,
   `heads_refetched records=2 applied=0 failed=0`, and showed no notice.

## This branch

1. **Rename `W201 sel` to `W201 sel 2026`: passes.** B holds no `W201 sel`,
   no record for it and no empty folder; the three notes are under the new
   name with the same file ids on A and B. A holds no old record, its
   selection is `W201, W201 sel 2026`, and it logged
   `folder path_class=folder decision=published reason=deleted` for the folder
   and for `Inner`. The server's record for the old folder ends in a
   tombstone. No notice on either device. The old folder's tombstone reached
   the server before the moves, which go out beside it: B kept the folder
   (`kept reason=not_empty items=3`), forgot its record, and removed it once
   the moves had emptied it (`removed reason=empty_parent`), exactly as it
   does for the ordinary subfolder in step 3.
2. **Rename it back to `W201 sel`: passes,** with the same checks; the
   selection is `W201, W201 sel`. B's pulled moves made the directories before
   A's records reached it, and B published a version of each of the two
   folders itself (`published reason=recreated`), which A and C applied as
   `created`. Nothing else changed; see finding 2.
3. **Control, a subfolder inside a selected folder, `W201/Sub` to `W201/Sub2`
   and back: passes** both ways (`kept`, then `removed reason=empty_parent`).
4. **Rename `W201/Case Docs` to `W201/case docs` (#238's rename): passes.** B
   logged `kept reason=not_empty items=2`, `case_renamed files=2 folders=0`,
   `start reason=heads_refetch`, `heads_refetched records=2 applied=0
   failed=0`; no `case_move_refused` and no notice. The case #238 fixes, a
   duplicate report followed by a failed post, cannot be timed on a real
   vault and is proven by the plugin suite.
5. **C paired afterwards** has no `W201 sel 2026`: the renamed selected
   folder left nothing behind for a device paired later. See finding 1 for
   what C made of the subfolder in step 3.

## Findings (not changed by this branch)

1. C, replaying the subfolder's rename and its reversal from the start of the
   history, logged `feed decision=retry reason=Path is a directory: rm
   returned EISDIR (is a directory) <absolute path>` for `W201/Sub2` (and once
   for `W201 sel 2026/Inner`, which then converged), retried after 5 s, and
   kept an empty `W201/Sub2` with no record. Its next **Sync now** recorded
   that folder again and said `obsync: sent 1 change.`; the server already
   held that version and wrote nothing, so no other device changed.
2. A receiver whose pulled moves make a folder before the folder's own record
   arrives publishes that folder itself; over a tombstone it posts one
   redundant version (step 2). Harmless, one request and one frame each.

## Whole-app sweep (A, B and C, both builds)

- The status item reads `obsync: idle` with the check mark on every device;
  the only notices are the answers to **Sync now** (`obsync: nothing to send;
  this device is up to date.`, and C's `sent 1 change.` from finding 1).
- **Show sync status**: idle, 7 files tracked, remote only 0. B and C, the
  paired devices, also show `Recovery phrase Not confirmed`.
- Settings on A reads `Syncing now: W201, W201 sel` after the rename back.
- Console warnings, identical on both builds: on A, the first device's setup
  logs `GET /v1/files/<id> status=404 decision=refused code=unknown_file`
  while it looks for a domain map that does not exist yet; on B and C,
  `GET /v1/pairing/<id>/envelope status=409 decision=refused
  code=not_approved` while they wait for approval.
