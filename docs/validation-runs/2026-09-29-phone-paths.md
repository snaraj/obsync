# 2026-09-29 Android emulator: phone paths (#244, #245, #248, #246, #282, #284)

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

## Sync now on a large phone vault (#246, measured before the change)

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
  7,720 files, inside every Sync now on this vault (#282, below).
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

## Sync now on a phone asks its storage (#246, #282, #284; after the change)

Two more runs on the same kind of emulator, each on a fresh AVD and a
fresh vault. Each vault held 7,700 generated notes in 79 folders
(15.2 MiB), synced from the desktop rig to the phone, and both devices
were idle before each timing. The desktop's window was kept visible during
the upload; a hidden one uploads several times slower (above).

- **First run.**
  - It compared the 1.1.5 train head `6e0b0dd` (plugin `main.js`
    SHA-256 `d5988aa1…`) with an early build of the change (`1fab0a3c…`).
  - The server was built at `6e0b0dd` (`2883d9c6…`).
  - The 7,700 notes reached the phone in 823 s.
  - Load average 14 to 29, with no test batch of this lane running during
    a timing.
- **Second run**, later the same day.
  - Plugin `cdfc140d…`, built from the composed train head `9963bf0` plus
    #284's change, which touches only a phone's removal. Server
    `17c03e0d…`.
  - The notes reached the phone in 488 s.
  - Another test lane on this computer ran six CPU-burning processes on
    and off throughout, and the load average stood between 17 and 51.
  - The emulator's own storage bridge was 23 to 31 times slower than in
    the earlier runs: one `readdir` of the 78 listed folders, with no
    plugin code, took 19,974 and 14,789 ms, against 640 ms measured above.

Times are the engine's own `duration_ms`, from its `sync_now decision=…`
line.

| What | `6e0b0dd` | This change |
| --- | --- | --- |
| `syncable()` over 7,700 notes (#282) | 10,943 ms | 144 ms |
| Sync now, nothing changed | 218.9, 220.8 and 119.4 s, reading every note | 757, 761 and 713 ms (first run); 2,170 to 24,272 ms over nine presses under the second run's load |
| What a no-change press asks and reads | every file's contents | `listing=readdir folders=77 files=7700 differing=0 read=0 bytes=0 budget_ms=10000` (78 and 7,701 in the second run) |
| Status words, mid-press | "syncing 470 files", with nothing changed | Verify all files: "checking 5082 files for changes"; Show sync status: "checking 6056 files for changes" |

The press asks only folders that hold a listed note: 77 of the first run's
79 folders held one.

- **Another app's edit that Obsidian missed.**
  - Obsidian 1.13.8 noticed an `adb` write within 3 s on its own. The lab
    therefore silenced its adapter's change callbacks for that one note
    while `adb` appended a line: the index then said 2,878 bytes and the
    storage 2,919.
  - One Sync now: `differing=1 read=1 bytes=2919`, 2,976 ms. One version
    was pushed, and the desktop held the line 1 s later.
  - In two runs without the silencing, Obsidian's own watcher reported the
    write and obsync sent it before any press.
- **A readdir answer short of a date.** The lab stripped `mtime` from every
  entry.
  - The press fell back to the index and a stat per suspect, and said so
    once per session: `sync_now decision=fallback reason=entry_shape`.
  - First run: two presses of 507 and 376 ms.
  - Second run: two presses of 9,481 and 5,402 ms, then 19,308 ms with
    readdir restored.
  - A forced `no_readdir`, made by deleting the adapter's `fs`, also broke
    Obsidian's own `stat`, which uses it. Two pushes failed with "Cannot
    read properties of undefined (reading 'stat')". That state cannot occur
    in a working Obsidian, so it proves nothing: that path is pinned by the
    fake-vault tests only.
- **A computer's Sync now is unchanged.**
  - First run: 3,034 ms, `listing=index read=7700 bytes=15989228`. The
    status read "checking 3 files for changes" and then "checking 4 files
    for changes", where 1.1.4 said "syncing".
  - Second run: 15,725 ms with its window visible. See the sweep for the
    minimized window.
- **A note whose name a folder has taken since (#284).** The desktop synced
  a note, `LaneC/Box284-r3.md`, to the phone. With Obsidian's change
  callbacks silenced for that name, `adb` replaced it on the phone with a
  folder of the same name holding `Inside.md`. The desktop then deleted the
  note.
  - The phone logged `pull path_class=manifest decision=refused
    reason=not_a_file file=… seq=15575` and no removal line.
  - It showed the refusal notice once (below).
  - The folder and `Inside.md` stayed, and the note's record stayed.
  - A Sync now then changed nothing (`differing=0`): a press compares the
    sizes and dates of what Obsidian's index lists, and a vanished note
    goes the usual way, through Obsidian's own report.
  - Once Obsidian restarted and indexed the folder, the phone published
    three things: the folder; its own deletion of the note, which the
    server answered `decision=deduplicated` at the desktop's own sequence
    number, so it was the same version; and `Inside.md`, which reached the
    desktop.
  - At `9963bf0`, the same situation trashed the folder in the fake-vault
    test.

### Notices seen (second run)

Every obsync notice either device showed, by text and count:

- Phone: "obsync refused a change from another device: it does not name a
  file or folder this device can write inside this vault (not_a_file).
  Nothing was written. File id …" once, in the #284 journey.
- Phone: "obsync: nothing to send; this device is up to date." once, for
  the sweep's Sync now.
- Desktop: "obsync: nothing to send; this device is up to date." once,
  for the sweep's Sync now.

The timed presses called the engine directly, and that shows no notice.

### Visual sweep (second run, at `cdfc140d…`)

- **Phone:**
  - Sync now to idle took 38.2 s under the load above.
  - The status item is a green check, and Show sync status reads idle,
    with 7,701 files tracked and 15.2 MiB.
  - The obsync settings tab renders.
  - Console warnings:
    - One `feed decision=stalled waited_ms=133160 budget_ms=110000`.
    - The forced `sync_now decision=fallback reason=entry_shape`.
  - The status read "offline — retrying" once at the sweep's end (below).
- **Desktop:**
  - The rig's window was found minimized, and the sweep's Sync now took
    239.1 s to idle (225,132 ms in the engine; a hidden window's timers
    are throttled, #283).
  - The window was restored, and the timing above was taken.
  - The settings tab opened as a separate window and was closed after its
    capture.
  - Console warnings:
    - Two `feed decision=stalled` lines, held by passes of 59 and 80 s.
    - One `pairing role=creator decision=failed reason=key_unconfirmed
      polls=300` (below).

### Also observed in the second run

- **"offline — retrying" for a moment on both devices while the server
  answered.** Each time, `engine decision=offline reason=unanswered` was
  logged without naming the request left unanswered, and `online
  reason=answered` followed within a second. The server answered
  `/readyz` in 48 ms. It happened beside the long polls a Sync now or a
  focus drops (`dropped_poll=1`). It was not seen in the first run.
- **The desktop's pairing dialog raised a false alarm.** The lab's pairing
  script left it open. Ten minutes later it read "The new device collected
  the vault key but has not started syncing within ten minutes", while the
  phone had paired and was syncing the 7,700 notes.

### Not validated (these runs)

- iOS and a physical Android phone. On an iPhone, the feature check
  decides: a readdir of the right shape is used, and anything else falls
  back and says so once.
- A same-size, same-date rewrite by another app. That is left to **Verify
  all files** by design (Troubleshooting).
- A timing of the change on an unloaded computer in the second run.
