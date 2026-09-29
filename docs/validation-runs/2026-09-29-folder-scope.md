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

## Round 2: #264, #265, #266 and the expected refusals

Same three desktops, vault and selection as above, each run on a fresh server
and fresh profiles. Builds (`main.js` SHA-256): release 1.1.4 as above;
`7e9b45b`, this branch with #264 but before #265 and #266,
`0bc7e387bbd6c919973bd38e4900540e031fd78df6538e1613d25ee8e69ec709`; and this
branch's head, `c4a307b`,
`b0e02369a7ed1540c3b901e47cb75645b7db70c5b326fc21d527b995e86d71c1`. Two
lab-only hooks, in the rig window only: A's note posts (versions with
content) held for a set time, so a drain stays busy or a folder record
reaches the server before the moves beside it; and on C, every folder
removal call recorded with its error.

### #264: a note queued under a folder's old capitals

A holds 40 new notes' posts for 1.5 s each, edits `W201/Case Docs/Case
One.md` while they wait, so the edit waits in the queue under the old
capitals, then renames `W201/Case Docs` to `W201/case docs`.

1. **Release 1.1.4: fails (reproduces #264).** With 29 entries queued, the
   edit went out as the move, journaled at seq 122, before the folder's new
   record at seq 124. B (macOS, folding case) logged `pull path_class=file
   decision=case_move_refused reason=folder_case ... seq=122` and `pull
   path_class=folder decision=notified reason=folder_case
   sender=not_older`, the "another device spells the folder ... with
   different capitalisation" notice, then `case_renamed files=2` and
   `heads_refetched records=2 applied=1 failed=0`, which brought the edit
   over. The notes converged with the same file ids; the person was told
   about a disagreement that was never there. (The `notified` line is the
   plugin's own record of that notice; the rig's notice hook of the time
   missed a toast arriving inside a new container, and was corrected before
   the run below.)
2. **This branch: passes.** The edit waited under the old capitals (33
   entries in the queue) and went out behind the folder's new record: B
   logged `kept reason=not_empty items=2 seq=120`, `case_renamed files=2
   folders=0 seq=122` and `heads_refetched records=2 applied=0 failed=0`;
   no `case_move_refused`, no `notified` line and no notice on B. The edit
   is on B under `W201/case docs/Case One.md`, both notes keep their file
   ids, and the old folder's record ends in a tombstone.

### #265: a renamed selected folder's removal that could not be sent at once

The server is stopped, A renames `W201 sel` to `W201 sel 2026`, obsync is
disabled and enabled again on A while the server is still down, then the
server comes back and **Sync now** runs on A.

1. **`7e9b45b`: fails (reproduces #265).** No removal was attempted before
   the reload, and nothing survived it (the state has no such field). After
   **Sync now** A logged `watch path_class=folder decision=not_synced
   reason=outside_sync_scope event=reconcile_folder_state` for `W201 sel`
   and `W201 sel/Inner` (`folders_skipped=2`). B kept `W201 sel` with its
   record, and the server held the old folder's record live; C, paired
   afterwards, created `W201 sel` and an empty `W201 sel/Inner`.
2. **This branch: passes.** While the server was down A wrote both
   removals down, `{"W201 sel": ["W201", "W201 sel"], "W201 sel/Inner":
   ["W201", "W201 sel"]}`, and they were still there after the reload. The
   reloaded engine started once the server answered, and its first pass
   queued them with the new name's two records (`folders_queued=4`,
   `published reason=deleted` twice); by **Sync now** A owed nothing and
   its pass had nothing left to queue (`folders_queued=0
   folders_skipped=0`). B holds no `W201 sel` and no record for it, the
   three notes are under `W201 sel 2026`, and the server's old record ends
   in a tombstone. C, paired afterwards, has no `W201 sel`: see below.

### #266: a computer paired later replays a folder renamed and renamed back

A's note posts are held 0.8 s, so each folder record reaches the server
before the moves beside it; A renames `W201/Sub` to `W201/Sub2` and back;
then C is paired.

1. **Release 1.1.4: fails (reproduces #266).** C's removal of `W201/Sub2`
   went through `adapter.rmdir("W201/Sub2", false)` (Obsidian had not listed
   the folder yet), which threw `ERR_FS_EISDIR`; C logged `feed
   decision=retry reason=Path is a directory: rm returned EISDIR (is a
   directory) /Users/<name>/.../rig-C/W201/Sub2 status=feed retry_ms=5000`
   and kept an empty `W201/Sub2` with no record. One C line named an
   absolute path.
2. **`7e9b45b`:** the replay did not reach that branch this time (every
   removal found the folder listed; 6 removal calls, none failed): the
   defect needs Obsidian's index to lag the pull path, which a loaded
   machine does not always give.
3. **This branch: passes.** Two checks.
   - The host's removal itself, made certain: on one rig with no server,
     an empty folder is made on disk and removed through the plugin host's
     own `trashFolder` in the same task, before Obsidian lists it. Release
     1.1.4: 3 of 3 threw `ERR_FS_EISDIR` and left the folder. This branch:
     3 of 3 removed it, with nothing kept and no error.
   - The replay: C, paired after the rename and the rename back, holds no
     `W201/Sub2` and no empty folder, made 9 folder removals with none
     failing, logged no feed retry, and no C line names an absolute path.
     As at `7e9b45b`, every removal in this replay found its folder listed
     (`fileManager.trashFile`); the first check is what reaches the branch
     the fix changes.

### Expected refusals

On this branch A's first setup logged `http GET /v1/files/<map>
status=404 decision=expected code=unknown_file`, and B, waiting for its
approval, `http GET /v1/pairing/<id>/envelope status=409
decision=expected code=not_approved` and then `status=200 decision=ok`.
Neither console held a warning for either; release 1.1.4 logged both as
`decision=refused` warnings (sweep above).

### Whole-app sweep (A, B and C, this branch)

- The status item reads `obsync: idle` with the check mark on A, B and C;
  **Show sync status**: idle, 47 files tracked, remote only 0, feed
  sequence 163 on each. B and C also show `Recovery phrase Not confirmed`.
- Settings on A reads `Syncing now: W201, W201 sel 2026.`; B and C sync the
  whole vault.
- Notices: on A the two pairing confirmations (`The new device, "Mac …",
  is paired: it holds the vault key now.`), and on every device the answer
  to **Sync now** (`obsync: nothing to send; this device is up to date.`).
  No notice about a folder or its capitals anywhere.
- Console warnings: C none. B one, the feed giving up while the server was
  stopped (`ERR_CONNECTION_REFUSED ... gave_up`). A only those of the #265
  run: the posts refused while the server was stopped, and after the
  reload the previous session's requests (finding 1) and its `state
  decision=refused reason=superseded`. No `unknown_file` or `not_approved`
  warning on any device.

### Findings (not changed by this branch)

1. After obsync is disabled and enabled again, a request the previous
   session had in flight keeps retrying in its backoff, every attempt
   refused on the device (`network=The previous plugin session is
   inactive.`), for 85 s and 109 s here, and its last line, `push
   path_class=folder decision=deferred reason=stopped attempt=1`, reached
   the console almost two minutes after the new session had sent that very
   removal. Nothing is sent twice and nothing is lost; the lines mislead.
