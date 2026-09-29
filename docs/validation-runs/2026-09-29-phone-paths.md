# 2026-09-29 Android emulator: phone paths (#244, #245, #248; #246 measured)

Agent-operated, for the owner, on the owner's computer, with a disposable
server and disposable vaults. No owner vault and no owner device took part.
The phone is an **emulator**, not a physical Android phone. Each journey ran
at the 1.1.4 release and again at this change, on the same devices and the
same server.

## Build and devices

- Source: base `afbf7e7` (release 1.1.4) and the 1.1.5 lane C change.
- Server: `obsyncd` 1.1.4 built from the base tree (the change touches no
  Rust), SHA-256 `028611b6267b30f0…`, with disposable volumes, on this
  computer's loopback address over plain HTTP, `OBSYNC_EDGE=none`.
- Plugin `main.js` SHA-256, on both devices: `19d3202059551d72…` at
  `afbf7e7`; `8156b2af6e618055…` for the change as committed (the L244,
  second L245 and second L248 rows); two earlier builds of the change for
  the first L245 and L248 rows: `71bffffd5795ddf2…` and `ab859116ded41bba…`.
  They differ from the committed build in one log word
  (`reason=pull_lock`) and in where Sync now's content check runs, which
  those journeys do not reach before their verdict. Each copy was installed
  by a manual file copy and a reload, not a production-path install.
- Desktop: a macOS 27 laptop (Apple silicon), Obsidian 1.13.4, in an isolated
  profile beside the owner's own.
- Phone: an Android 15 emulator (system image `android-35`, Google APIs,
  arm64-v8a; emulator 37.1.11), Obsidian 1.13.8 from the official release
  APK, versionCode 367, the vault in Device storage.
- Load: seven other lanes' tests ran on this computer meanwhile; the load
  average stood between 20 and 195.

## Route

Neither reference route. The emulator reached the loopback server through
`adb reverse`, the desktop reached it directly. No TLS terminator, no
certificate on the phone.

## Journeys

The driver is page JavaScript over each app's DevTools socket. A version the
phone published is a `POST /v1/files/{file_id}/versions` from the phone's
device id answered 201, read from the server's own request log.

| # | Build | Outcome | Observed |
| --- | --- | --- | --- |
| L245 | 1.1.4 | fail (#245) | Three synced files whose in-memory size or date Obsidian had kept from an earlier look (two at 0 bytes, one 5 s off): **Leave this server** listed all three as "changes the server never received" and offered "Discard 3 and leave". No log line said why. |
| L245 | change, twice | pass | The same three: Leave listed none. The phone asked its storage about the 3 files whose listing disagreed with their records, out of 7,719 and 7,730, and logged one `list decision=stale_index size_index=… size_disk=… mtime_index=… mtime_disk=…` line each and `list decision=confirmed suspects=3 stale=3 files=7730 duration_ms=8` (22 ms in the first run). Leave's whole count took 12.8 and 13.4 s on this vault. The dialog showed plain **Leave**. |
| L248 new note | 1.1.4 | fail (#248) | The phone's download of a desktop note landed empty, and Obsidian was stopped (`am force-stop`) 754 ms later, before the next save: the data file held no mark and no record for it. Started again, the phone published the empty file as a version of that note: the note is empty on both devices, and the desktop's text sits in "New note (conflict from Mac H5PB, …)". |
| L248 new note | change, twice | pass | Stopped right after the empty write (the delay went unrecorded in the first run) and 194 ms after it, same persisted state. Started again: 0 versions from the phone, the desktop's text in the note on both, no conflict copy. Its start logged `reconcile decision=held reason=unfinished_download files=1 unverified=0 budget_ms=5000 duration_ms=2037` and `…=1140`. |
| L248 existing note | 1.1.4 | fail (#248) | The same for a note the phone held (623 bytes on record), stopped 753 ms after the empty write. Started again, the phone published a 0-byte version (the server logged `bytes=0`); both devices then showed it as a conflict copy, "Existing note (conflict from Android V27T, …)", beside the desktop's text. |
| L248 existing note | change, twice | pass | Stopped 53 and 73 ms after the empty write. Started again: 0 versions from the phone, the desktop's text on both, one file; `…unfinished_download files=1 unverified=0 … duration_ms=307` and `…=306`. |
| L244 | 1.1.4 | fail (#244) | A folder `Team docs` (3 notes, one subfolder) renamed to `team docs` on the desktop. While the phone applied it, its adapter's `list` and `stat` answered 3 s late, and a pass was asked for at the start of that wait. The pass ran inside it (`moved=3`) and the phone published the three notes again, a deletion of the old folder and two folder records: the rename it had only applied, as its own. |
| L244 | change | pass | The same: the pass waited 3,530 ms for the pull (`reconcile decision=waited reason=pull_lock duration_ms=3530 budget_ms=5000`), ran after `case_renamed files=3`, and found `moved=0 removed=0`. The phone published no note and no deletion. It announced two folder records no device had recorded yet, the parent folder and `team docs/Sub` under its new name, as the 1.1.4 pass also did. The rename reached the phone 140.5 s after the desktop made it, against 4.1 s at 1.1.4: the desktop's window was minimized in this run and not in that one (see below). |

## Sync now on a large phone vault (#246, measured, not changed)

A vault of 7,715 files in 87 folders, 16.0 MB, all synced and idle: 7,700
generated notes of 120 to 4,000 bytes plus the journeys' files. Page-side
timing on the phone; the load average stood between 35 and 96.

| What | Time |
| --- | --- |
| Sync now, nothing changed, 1.1.4 | 194.6 s, reading all 7,715 files |
| Sync now, nothing changed, this change | 127.7 s and 401.6 s in two presses, the same reads; the comparison under the pull lock took 161 and 1,547 ms of them |
| Reading the 7,715 files alone | 71.0 s |
| Obsidian's index listing | 19 to 21 ms; 22 to 23 ms with the #245 check and no suspect |
| One `adapter.stat` per file | 38.9 s |
| One `adapter.list` per folder, names only | 1.3 s |
| One internal `adapter.fs.readdir` per folder, with size and date | 0.64 s |
| One save of the phone's data file (2.8 MB) | 118 to 304 ms |

The last row prices a save before every download (#248's first option):
up to 15 to 39 minutes over the 7,700 downloads of a vault this size.

## Notices seen

Every notice either device showed during the journeys and the sweep, by
text and count:

- "obsync: nothing to send; this device is up to date." once on the phone
  and once on the desktop, each answering a Sync now press.

No other notice appeared on either device, in any journey at either build.

## Visual sweep (at the committed build)

- Phone: status item a green check, "idle"; **Show sync status** lists the
  server, the device, 7,726 files tracked, 15.3 MiB, feed sequence 15755, and
  "Recovery phrase: Not confirmed", true for this lab vault; the obsync
  settings tab renders; no plugin warning or error in the console.
- Desktop: the same, 7,726 files, per-file ceiling unlimited; the settings
  tab opened as a separate window and was closed after its capture; no plugin
  warning or error. The red crossed-out sync icon beside obsync's check is
  Obsidian's own Sync core plugin, on by default in a fresh profile.

## Also observed during the run

- **A desktop whose window is hidden syncs far slower.** The desktop's
  upload of the 7,700 notes ran at 12 to 15 files a second with its window
  visible and 2 to 4 with it minimized (1.1.4 build). A folder rename took
  140.5 s to reach the phone from a minimized desktop against 4.1 s from a
  visible one. A Sync now in a hidden window took 937 s. Chromium throttles
  the timers of a hidden page; which of obsync's timers gate this is not yet
  known.
- **The phone asks every file a question meant for folders.** Checking
  whether a path may be synced asks, for a note too, whether the note itself
  holds a vault's config folder: one bridge call per file, 23.2 s over
  7,720 files, inside every Sync now on this vault.
- **The emulator's adb connection dropped once under load** (21:40 UTC),
  taking the DevTools forward and the server route with it. A lab guard put
  both back within 15 s and logged it; the Sync now press measured across it
  kept its result, read back from the page's console.

## What was not validated

- A physical Android phone, an iPhone or an iPad. The iPhone variants of
  #244 are pinned by the fake-vault tests only.
- A stop Android makes on its own. The journeys stop Obsidian with
  `am force-stop` right after the empty write; a low-memory kill ends the
  process the same way, but none was produced.
- A stale index as Android leaves it by itself (#245). The journey sets
  Obsidian's in-memory size and date for three synced files, as the
  2026-09-27 run found them; the storage and the records are real.
- Either reference route, a TLS terminator, and a certificate on the phone.
- A production-path install, through Community plugins, on either device.
