# 2026-09-27 Android emulator and desktop, 1.1.4 candidate

Agent-operated, for the user, on the user's computer, with a disposable
server and disposable vaults. None of the user's own vaults or devices took part.
This is the first Android record: the phone is an **emulator**, not a physical
Android phone, and every line below says so where it matters.

## Build and devices

- Source: the 1.1.4 train. J1 to J9 ran on the build at `c6ce1d2`. J10 ran
  in parts, at `90d2042` and `d62f201`, E5 and E6 at `8126fdf`, and E7 with
  E5 and E6 again at `3045dcf`: see their rows.
- Server: `obsyncd` 1.1.4 built at `48334a5`, SHA-256 `14b07141c78ae123…`
  (no server change after it), with disposable journal and blob volumes. It
  ran on this computer's loopback address over plain HTTP, with
  `OBSYNC_EDGE=none`.
- Plugin: 1.1.4, `main.js` SHA-256 `82a7576665307fcb…` at `c6ce1d2` and
  `098ac74dd59daeac…` at `90d2042` on both devices. The later builds went to
  the phone alone: `03d9388872387d9e…` at `d62f201`, `ab3c52324c0ca956…`
  at `5a53c7a`, `140cf8fabc5c66d3…` at `f1143ea` and `9fa500caf979d5f2…` at
  `8126fdf`, while the desktop kept `098ac74d…`. At `3045dcf` both devices
  ran `00f0faf03cd9d965…`.
  Their changes act where a write lands empty, which is the phone. Every copy
  was installed by a manual file copy and a reload, which is not a
  production-path install.
- Desktop: a macOS 27 laptop (Apple silicon), Obsidian 1.13.4, in an isolated
  profile beside the user's own.
- Phone: an Android 15 emulator (system image `android-35`, Google APIs,
  arm64-v8a; emulator 37.1.11), running Obsidian 1.13.8 from the official
  release APK, versionCode 367. The vault is in Device storage, which folds
  capitals, like a phone's shared storage.

## Route

This run took neither reference route. The emulator reached the loopback
server through `adb reverse`, and the desktop reached it directly. No TLS
terminator was in the path, and the phone did not see a certificate. The
Kubernetes and Compose routes are what CI proves on every pull request
([validation](../validation.md#routes)). A phone on either of them is the
iPhone record's job, not this one's.

## Journeys

Timings are on the host clock around the act and the observer's wait,
resolution about 0.1 s. The J8 and J9 relaunch times are the page's own clock
since its window loaded, read when the driver first saw idle, so they are
upper bounds. The driver is page JavaScript over each app's DevTools socket:
`lab/journeys.mjs` in the run's job folder. It uses Obsidian's own vault API
for the acts and the vault manager's own menu for J3.

| # | Journey | Outcome | Time | Observed |
| --- | --- | --- | --- | --- |
| J1 | pass | 1.2 s | A note made on the phone appeared on the desktop under the same name with identical bytes (49 bytes), nothing done there. |
| J2 | pass | 1.2 s | A note made on the desktop appeared on the phone under the same name with identical bytes (49 bytes), nothing done there. |
| J3 | pass | reopen to idle 2.3 s, edit 1.0 s | Renamed and reopened through Obsidian's vault manager: still paired, the same device id, 3 active devices (3 before), the folder selection unchanged, 0 prompts; an edit made after the reopen reached the phone in 1.0 s. The vault was renamed back afterwards. |
| J4 | pass | 0.9 s | A folder of 3 notes renamed on the phone is listed on the desktop under the new name with the same 3 names and bytes; the old name is gone; trash unchanged on both. |
| J5 | pass | 0.4 s | A note moved between two selected folders on the desktop shows on the phone as 1 copy, in the destination only, identical bytes. |
| J6 | pass | notice at once | The phone showed at once: "1 note(s) moved out of the folders this device syncs; they stay on your other devices. Nothing was deleted: they are still in this vault and the serve…"; the desktop still holds the note under its old path with identical bytes and got no copy under the new one; the phone keeps it where it was moved; trash unchanged on both; no deletion was published. |
| J7 | pass | 0.8 s save to both notes across | Before the save each side's note stayed off the other (as expected); Save returned "saved"; the phone brought in the desktop's note and sent its own in 0.8 s; the 0 files under J114 were all kept; after a restart the selection read "Syncing now: J114, J7 new 01b6" (kept). |
| J8 | pass | desktop 2.0 s, phone 6.6 s | Both apps quit and relaunched with no tap and no Sync now: the desktop idle by 2.0 s after its window loaded, 0 prompts, paired; the phone idle by 6.6 s after its window loaded, 0 prompts, paired (host clock, launch to both idle: 6.8 s, includes reattaching DevTools). |
| J9 | pass | phone 487.0 s, relaunch 1.9 s | A tree of 2000 non-note files (2.0 MiB, 40 folders) written on the desktop in 38.8 s; the phone held all 2000 after 487.0 s; after a relaunch with the tree present, the desktop was idle by 1.9 s after its window loaded (3.0 s on the host clock). |
| J10 | fail (#241) | pair to idle 49 s | Leave and pair again, repeated at the final builds, was not completed in one run. A clean run at `d62f201` left, and pairing again then asked about 3 notes the server did not hold: the phone's copies of notes under names their folders had before earlier renames (#241, 1.1.5). The journey stops there by design. At `90d2042` it stopped before Leave: the phone listed 4 files as holding unsent changes that the server already had (#245, below). Restarting Obsidian cleared that. The rerun's pairing was then interrupted by the operator installing a new build on the phone mid-run. That left the phone unpaired and asked about 2 notes the server did not hold, #241's old-name copies. **Cancel** uploaded nothing; the copies were trashed as the workaround says. Pairing again at `d62f201` (plugin `03d93888`) completed: the phone was idle 49 s after pairing (100 s from the pair command, beside a six-shard mutation run), created 0 versions (195 posts answered "already held"), uploaded 0 chunks, and every file present on both devices had identical bytes. |
| E5 | pass | 197.5 s to land | A probe made every write under a folder land empty on the phone, for a note new to it and for an edit of one it held (#242; review of `90d2042`). At `3045dcf` the phone refused both, skipped sending them 6 times, made 0 versions of any file, and with writes working again landed both on both devices, byte for byte (197.5 s). At `8126fdf` (937.5 s) the phone refused both after three writes and parked them as `write_dropped`, leaving both files at 0 bytes and removing nothing. It skipped sending them 6 times and made 0 versions of any file. With writes working again, Sync now landed both, byte for byte on both devices, with no conflict copy. The time is not this build's: the probe waits for the phone to hold no parked record at all, and the E6 run cut short before it had left two parked writes whose retry backoff reached 480 s, on a host running mutation batches. Earlier builds passed the same probe (`f1143ea`, 126.1 s; `5a53c7a`, 124.3 s; `d62f201`, 130.9 s; `90d2042`, 124.1 s). |
| E6 | pass | 311.1 s to land | E5's empty writes, then a folder rename and a deletion on the phone (review of `2e4cdca`). At `3045dcf` it passed again in 311.1 s: marks followed the rename, one tombstone was skipped, 0 posts of either note, 4 folder records, both texts intact on the desktop, no mark left. At `8126fdf` (1373.8 s) the phone refused both notes. It then renamed their folder, and both marks followed to the new name. A Sync now with writes still dropping had left a second empty copy of the held note under the old folder. The phone deleted the held note's empty file under the new folder and skipped its tombstone. It never posted either note: its 4 posts in the probe were folder records (#174). The desktop kept both texts throughout. With writes working again, both notes landed on the phone at their names on the server; the time is inflated as E5's is. The new note's empty file stayed under the renamed folder, marked; deleting that folder on the phone sent nothing for either note and left no mark. It also passed at `f1143ea` (199.9 s). **At `553f0b59`, between the two, a run on a host at load average ~30 was cut short by its driver, and it caught a race:** the phone's three writes of the new note took about 3 s, the watcher pushed the empty file between them, and it went out as a new, empty note, because the mark came only at the refusal. A folder rename then carried it to the other devices, and name clashes made conflict copies; the desktop's text survived in one of them. `8126fdf` marks the name before the first write. |
| E7 | pass | 183.9 s to converge | A merge the phone could not write (review of `c4668d4`; M3241). At `3045dcf` the phone edited a note's first line while its version post was held, and the desktop edited the last. The desktop's version reached the phone, and every write under the probe folder landed empty, so the phone's merge of the two did too: it refused a 96-byte write, the merged text's exact length with both edits, three times, and parked it as `write_dropped`. The note stood at 0 bytes with its own name marked. The watcher and Sync now skipped it 7 times, and the phone sent 0 versions of it. With writes working again, both devices held one note with both edits and no conflict copy, and the mark had ended. |

## Also observed during the run

- **#234, live.** Widening the phone's folder selection replayed its feed,
  and the phone stopped at a deletion of a note it no longer had. Its log
  repeated `feed decision=retry reason=The source object does not exist`
  every 5 s. The status read "Changes from your server could not be read"
  while the server answered every read with 200. With the fix installed
  (build `1443ad3`, the #234 commit) the phone went from sequence 2616 to
  7120 and was idle 13.3 s after the install. It logged
  `host path_class=file decision=absent` and then
  `pull path_class=tombstone decision=deleted seq=2626`.
- **A sleeping phone.** After 30 minutes the emulator's screen slept, and
  Android suspended Obsidian's WebView. While asleep the status read
  `offline — retrying`, and the server saw nothing from the phone for 19
  minutes. The first request after waking came 1.2 s after the wake key. That
  was on build `8216bbb`, before this run's build.
- **#235, live.** The server restarted at `48334a5` answered `/readyz` with
  `{"ready":true}`. On the builds before it, the same probe answered
  `{"ready":true,"seq":<n>}` to a caller with no credential.
- **Nine deletions published by the phone.** On the widened replay above,
  the phone found nine notes gone from its storage. They were residue of the
  earlier #219 capitalisation tests, deleted there outside obsync. It
  published their deletions. Nine of about 4,000 tracked notes is under
  half, so the startup pass sent them rather than holding them. That is the
  #139/#172 share rule working as designed, and it is recorded here because
  someone reading the log would ask.

- **Leave waited minutes on a phone (fixed in 1.1.4).** Counting the edits
  a phone had not sent asked every folder's nested-vault question once per
  file, a bridge call a level: 300 files four levels deep took 33.6 s, so
  Leave on this vault of about 2,000 files spent minutes before answering,
  and the first J10 attempt ran out of the driver's time. The count and the
  pairing survey now run in one host pass: 2.5 s for the same 300 files
  (#198, #236; commit `d37cbb0`).
- **A renamed note came back under its old name after pairing again (#241,
  1.1.5).** Pairing the phone again after Leave wrote `J114/J4 folder
  c8cb/Two.md`, a note J4 had renamed with its folder, under its old name
  beside the copy under the new one. The next pairing then asked about "1
  note the server's vault does not" hold; **Cancel** uploaded nothing and
  removed the device again, as designed. Reproduced at the fake level on
  this train and on 1.1.3: pre-existing, scoped to 1.1.5 by the user's scope cut.
- **A note moved out of the selection stayed missing after widening (#239,
  1.1.5).** J6 moved a note out of the phone's selected folders; when J10's
  setup widened the phone back to the whole vault, the note under its old
  name did not come back on the phone until it was paired again.
- **The phone published empty copies of notes it had just received (#242,
  fixed in 1.1.4).** An audit of the server's history after J10 found 16
  versions that emptied a note that had content, all published by the
  phone. Fifteen were J9 files, emptied 8 to 200 s after the desktop wrote
  them. The phone put their text back itself 30 minutes later; J9's row
  passed because its driver checked arrival and relaunch, not bytes. The
  sixteenth was a 270-byte conflict copy the phone downloaded while pairing
  again; it stayed empty on the desktop, the second desktop and the phone.
  Watching the phone's adapter showed the cause. Obsidian's `writeBinary`
  was handed 993 bytes and resolved in 19 ms, but every stat and read of the
  file over the next 18 s said 0 bytes, and nothing else wrote it. The
  plugin took the empty file for a save and published it. A probe, 400 files
  written on the desktop, found 4 of 1,600 published empty at `bae5bb3`.
  With the fix (write such a download again; refuse and park one that stays
  empty):
  - at `242b8c4`, 2,400 files over six rounds had 3 writes Android left
    empty; each was written again once, the phone published 0 versions, and
    it recorded 0 files empty;
  - at `d62f201`, `5a53c7a`, `f1143ea` and `8126fdf`, probe E5 forced the
    refusal path, and at `f1143ea` and `8126fdf` probe E6 followed it
    through a folder rename and deletions on the phone;
  - an E6 run at `553f0b59`, cut short under load, found the phone pushing a
    download's empty file between its writes, before the mark; `8126fdf`
    marks the name before the first write (the E5 and E6 rows above);
  - at `3045dcf`, probe E7 forced the same refusal on a merge the phone made
    of its own edit and the desktop's, which `8126fdf` did not mark early.
    The first attempt at `3045dcf` never started: the emulator had been
    restarted, which drops its `adb reverse` route, so the phone showed
    offline and the driver stopped at its idle check. Restoring the route
    and running again gave the rows above.
- **A phone's file index kept a size Android corrected later (#245, 1.1.5).**
  Four files that an E1 run emptied before the #242 fix held 993 bytes on disk
  and in their records. Obsidian's in-memory index still listed them at 0, and
  obsync reads that index on a phone. Leave therefore listed them as unsent,
  and J10 would not start. Restarting Obsidian rebuilt the index, after which
  Leave counted 0. The same run's Sync now had put their text back on the
  server: its content check sent the 993-byte files over the empty versions
  the old build had published.
- **Sync now on a large phone vault is slow.** Each press re-reads every file
  up to 8 MiB. On this vault of 7,682 files the emulator still read
  "syncing 2230 files" 90 s after the press, and one press took 63 s to drain.
  That is the existing per-press check, not a change in this run.
- **The 2,000-file tree arrived slowly.** J9's 2,000 small files took 487 s
  to reach the emulator (about 4 a second) while this computer also ran a
  Windows virtual machine and a mutation run; the relaunch with the tree
  present was idle in 1.9 s.

## What was not validated

- The busy-editor branch of a write again, live: it is pinned by the host
  tests only.
- A physical Android phone. The emulator's WebView, storage and sleep
  behaviour match a phone's, but its radio, battery policy and vendor skin do
  not.
- J11, account recovery in a fresh vault: not attempted in this run.
- Either reference route, a TLS terminator, and a certificate on the phone.
- A production-path install, through Community plugins, on either device.
- The phone's per-file and total download ceilings at their limits. The
  largest file here is 128 MiB, under its 512 MiB ceiling.
- Windows, Linux, iPhone and iPad. Those are other records, or CI evidence
  ([validation runs](README.md)).
