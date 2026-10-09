# Changelog

All notable changes to obsync are recorded here. The format follows
Keep a Changelog; versions follow SemVer. Every artifact-classified merge
advances exactly one SemVer step -- one patch, one minor, or one major
(AGENTS.md, requirement 10).

## 1.1.7 - Unreleased

### Fixed

- Two devices typing in one note, on the same line or at the same spot, now
  combine letter by letter, the way a shared document combines two people
  typing: every keystroke of both stays in the note, deleted text stays
  deleted, and text is never set apart into a conflict copy. Incoming text
  reaches an open editor as only the other device's change, so the cursor
  stays where you type and undo takes back only your own typing. A plugin
  rewriting a note right after a sync, at a place another device changed, is
  still held rather than joined. Encryption, the wire format and the server
  are unchanged (#339).
- Text deleted on one device no longer comes back from another. When a
  combined result came out exactly as the other device's text, that device's
  version was taken as is, and a deletion made here could come back for a
  moment, or for good when it had not been sent yet. The combined version is
  now sent instead, and an unsent deletion goes out first, even one made
  while the keystroke before it was still uploading (#339).
- Two people typing in one note for minutes no longer get a notice that
  obsync "stopped renaming" it when nobody renamed it. A device that really
  keeps giving a note a different name is still stopped and named (#339).
- Saved editor input can sync while typing continues. Incoming edits merge
  with acknowledged versions while newer local input stays queued as a child
  version. Save confirmation, unfinished composition and recent human input
  now have separate checks instead of sharing a ten-second delay (#325).
- Desktop editor refresh advances the native saved baseline before queued
  watcher reloads, preserving keystrokes and avoiding repeated external-change
  notices. Both the staged download and the editor's subsequent save are
  flushed before the write completes. Unsafe or unsupported editor states
  retain the native refresh fallback.
- Incoming parent snapshots prepare while native saving continues; a save in
  flight no longer abandons the publication turn and restarts that work.
  The base and parents share one bounded authenticated chunk request, with
  each input independently verified. Current editor and disk checks still
  guard the final write.
- Continuing to type before a just-delivered remote addition keeps fast saving
  active. Refresh confirmation no longer mistakes the already displayed
  addition for text that still needs to be merged.
- Confirmed local saves and remote refreshes update live-preview consumers, including the
  native word and character counts, without another save after callbacks.
- Live version history, including own echoes and superseded peer edits, stays
  in the existing bounded ancestry cache so long typing bursts do not spend
  historical-read budgets fetching records the device already received.
- Confirmed saved snapshots avoid a second mobile read that races subsequent
  typing. Obsolete concurrent edits can skip redundant disk and head checks
  when the served feed names the locally held version as a head or cached
  ancestry proves the obsolete edit cannot advance it. Known dirty editors
  refuse readiness before queuing another mobile read. Linear replay, moves,
  deletions, rewrite controls and uncertain ancestry retain their checks.
- Sync status uses a static icon, avoiding continuous SVG animation that
  delays native mobile file callbacks during typing.
- Ordinary merges remember the exact result of their authenticated parents,
  as saved-editor merges do, without enlarging history or memory budgets.
- History a device recalls or reads for a merge is put back in newest-first
  order before a base is chosen. Kept in the order it was reached, an older
  version could be taken as the newest, and keys typed where two people were
  typing left the note on both devices for a moment (#339).
- The other device's typing no longer appears twice, with a letter it
  deleted back, when you type the moment it arrives. A save landing just
  after its text appeared was taken for a replaced file: the text stayed in
  the note, but went out again as your own typing (#339).
- Push reconciliation reuses the head snapshot it just fetched when that
  snapshot contains both inputs, avoiding a second request that can chase
  a continuously advancing peer. Unrelated or incomplete snapshots still
  require a fresh graph.
- A live editor reaching the merge-history work limit waits for the peer's
  next merge instead of classifying the limit as overlapping text. Other
  notes continue syncing; the existing bounded retry and cold-history
  fallback remain.
- The container builder base advances to Rust 1.98.1 with its pinned image
  digest; the repository compiler remains pinned to Rust 1.98.0 (#336).

- A minimized desktop restores background throttling after unanswered network
  attempts, including while uploads remain queued for retry. An answer lifts
  it again while work remains. Logs distinguish calm, unanswered and stopped
  restoration (#283).
- The left-selection regression sets up its settled large-file state directly,
  avoiding an unrelated initial download under CI load while retaining byte and
  request checks (#319).
- CLI help and empty lists consistently describe saved servers. The unknown
  `status` command points to `doctor`, which checks local settings without
  contacting a server. Capability help states that same local-only boundary.
- On Linux, an unset, empty or relative `XDG_CONFIG_HOME` uses
  `$HOME/.config/obsync`. Unsafe absolute destinations and invalid explicit
  `--config-dir` paths remain refused.

## 1.1.6 - Unreleased

### Added

- A native Rust management CLI with kubectl-style command groups, readable
  human output, explicit JSON, schemas and offline capability discovery.
  Local contexts use bounded snapshots, exact plans and durable apply receipts.
  Default OS settings and `context add/list/use/remove` aliases shorten setup;
  terminal changes ask for confirmation, while agents retain exact plans.
- Verified native archives for Linux amd64/arm64, macOS arm64 and Windows amd64.
  Installation verifies a private immutable directory. After verified uninstall,
  a newer package can reuse the same path; uninstall preserves contexts.
  No Node runtime ships or is required.

Server authentication, native setup, device administration and MCP follow in
later slices. Export/open is deferred with #317 and returns unsupported.

## 1.1.5 - Unreleased

1.1.5 fixes the issues left open when 1.1.4 was released (#238 to #241, #244
to #248, #253) and those found while testing it on real computers and an
Android emulator. Two people typing in one note on a busy computer now keep
each other's words (#227). Pairing a new device gains a key exchange of its
own that a copy of the code cannot open or fake, and needs 1.1.5 on both
devices; your server keeps an account's only device for seven days after a
recovery key is registered. In testing, changes from other devices sometimes
stopped arriving on a computer while it read idle. One cause is found and
fixed: closing obsync's settings in Obsidian 1.13 (#302, #307). For any
other, 1.1.5 says what the changes wait for, so that a report can find it
(#276).

Update the server first, then every device. A 1.1.5 device keeps syncing
with a 1.1.4 server, and a 1.1.4 device with a 1.1.5 server; the notes below
say where a mixed pair behaves differently. Pairing is the exception: to pair
a new device, the server and both devices need 1.1.5.

### Before you update

- **Pairing needs 1.1.5 everywhere.** A 1.1.5 device pairs only with
  another 1.1.5 device, through a 1.1.5 server. It refuses a code made on an
  older device, and a claim from one, and says to update that device: the
  older pairing lets anyone who saw the code open your vault key. Devices
  already paired keep syncing across versions.
- **Volume sizes.** The server now refuses to start, naming the variable,
  when `OBSYNC_BLOBS_CAPACITY` or `OBSYNC_JOURNAL_CAPACITY` is not larger
  than its free-space reserve (`OBSYNC_FREE_WATERMARK`, by default the
  larger of 5% and 2 GiB). A 1 GiB or 2 GiB journal is the usual case.
  Declare more (the guides use `4GiB` for the journal, or
  `storage.journal.size: 4Gi` in the chart), or, with `docker run` or
  systemd, lower `OBSYNC_FREE_WATERMARK` below the size you declared; the
  chart and the Compose file do not expose it. Up to 1.1.4 such a server
  said it was ready and refused every write to that volume (#289).
- **Pairing** needs the server updated first. Through a server older than
  1.1.5, **Pair a new device** on a 1.1.5 device makes no code and says to
  update the server.
- **Forget and the new device count** need a 1.1.5 server. An older one says
  it is too old to forget and changes nothing, and still counts revoked
  devices. A device still on 1.1.4 lists a forgotten device as revoked
  (#247, #268).
- **Going back to 1.1.4** on a device erases the new notification settings,
  which are back at their defaults when you update again, and drops what
  1.1.5 had still to finish: a renamed Sync folder's removal
  not yet sent (#265); where a note went while it was outside Sync folders,
  so 1.1.4 publishes it as a new note, as it always did (#239); and notes
  1.1.5 was still bringing back after you added a Sync folder (#281).

### Your notes stay safe

**Two people typing in one note keep each other's words, even on a busy
computer and with a third device showing the note.** Up to 1.1.4 the last
words one person typed could land in a conflict copy. A device now sends
what you typed before it merges, remembers the history it has been shown,
and no longer counts the wait for its own late save toward giving up on
merging. With three Obsidian instances each frozen for 45 s while two of
them typed, runs that made a copy went from 2 in 10 to none (#227, #278).
obsync also times its guard against other plugins from a version it really
wrote into the note, so your own late save on a very busy computer no longer
pauses the note (#278). Update every device: one still on 1.1.4 can still
make such a copy. Words that went into one are in `<note> (conflict from …)`
beside it (Troubleshooting, "Words typed on two devices at once went into a
conflict copy").

**A phone stopped in the middle of a download never sends the empty file it
left.** Android can finish writing a downloaded note but leave it empty, and
obsync writes it again (#242). If Android closed the app between the two,
the next start sent the empty file: the note became empty on every device,
or an empty conflict copy appeared. The next start now recognises the
unfinished download and writes the version over it, so the other device's
text stays. A note you empty on purpose still syncs as empty. Seen on
Android (#248).

**A phone never trashes a folder for a note deleted elsewhere.** When
another device deleted a note and a phone held a folder under that note's
name, the phone moved the whole folder, and everything in it, to the trash.
It now refuses, as a computer does, says so once, and keeps the folder and
its notes. Android and iOS (#284).

**Notes from your other devices show in Obsidian at once, even on a busy
computer.** Up to 1.1.4, on a Mac whose file-event service was overloaded, a
note obsync downloaded could be on disk and synced but missing from
Obsidian's file list, search and quick switcher until a restart, and a note
renamed or deleted elsewhere could stay listed under its old name. obsync
now tells Obsidian itself about the notes and folders it writes, moves or
deletes, and search, backlinks and other plugins see a note's new words as
soon as they land. A note open in an editor shows them at once, and its
search entry catches up at your next edit there: obsync never reloads an
editor you are typing in. Computers only; nothing to do (#253, #267).

**Leave on a phone no longer counts notes your other devices already have.**
Obsidian on a phone can keep an old size for a file obsync downloaded, so
Leave listed synced notes as changes the server never received, and every
check read them again. The phone now asks its storage about such a file
(#245).

### Pairing, recovery and your devices

**Pairing a new device is safer, even if someone saw the code.** Besides
the pairing code, the two devices make a one-time key exchange, and your
vault key travels sealed under both, so a copy of the code alone no longer
opens it. The code also carries a fingerprint of the key the device that made
it will use, and the six-digit match code both screens show is made from
both devices' keys, so someone who saw the code and sits between your
devices and your server cannot make the two screens agree. Approve only when
they do. Both devices and your server need 1.1.5: a device running an older
obsync is refused with the words to update it, whichever device made the
code, because the older pairing lets the code alone open your vault key.
Keep typing the code into the other device rather than emailing or messaging
it. The device that made the
code says "paired" only once the new device has kept the key and started
syncing, and tells you plainly if it did not; a new device that starts
syncing the second it signs in is no longer reported, ten minutes later, as
not started (#290). Devices already paired are not affected.

**Your notes stay private on a network that inspects your traffic, and a
test now proves it.** On a work laptop, or behind a VPN that decrypts
traffic, that network can see that you sync, how big your files are and
when, but never your notes, their names, your vault key or your recovery
words. A new test records a whole session as such a network sees it and
finds nothing readable. A device's secret for your server does cross the
network when you set the device up or pair it, so do both on a network you
trust (Troubleshooting, "Pairing on a network you don't control").

**Your server keeps an account's only device for seven days after a
recovery key is registered,** including right after you set up a new
account. Leave on that device says why and offers **Leave on this device
only**; or pair another device first. Every other device leaves as before.
A recovery key registered before 1.1.5 keeps the older rule, and a 1.1.4
server applies no hold.

**A device that finds a different recovery key on your server warns you.**
The warning stays until you dismiss it, and at the top of **Show sync
status** and of obsync's settings until it is resolved. Revoke any device
you do not recognise, then ask whoever runs your server to run
`obsyncd recovery reset plan` and then `obsyncd recovery reset apply` with
the server stopped. Your device then registers its own key by itself, and
your notes stay encrypted throughout (Recovery, "Another device set a
different recovery key").

**The same reset lets an owner with no working device back in.** It also
replaces the setup token: the old one stops working, and `obsyncd
setup-token` prints the new one after the next start. With it and your 24
words restored on a device, **Setup or recover** enrols that device once.
Without a reset, an account with no recovery key still refuses, and its
message now names both ways in: pair from a device that syncs, or ask for
the reset. The recovering device may still run 1.1.4 (Recovery, "Getting
the owner back in after a clear").

**Revoked devices no longer crowd your device list.** In Settings, Devices,
and on the dashboard's Devices page, the devices that sync come first, and
the revoked ones wait behind one row, such as "12 revoked devices", that
**Show** opens. Each revoked device offers **Forget**, which asks first and
takes it off the list for good. Forgetting destroys nothing: the device
still cannot sync and says so, your notes stay, and the versions it wrote
keep its name. To bring it back, pair it again. The device count on the
dashboard's Overview and in **Check** now counts only devices that can sync
(#247, #268).

**A dashboard sign-in link still opens once, within five minutes.** Obsidian
may write the link it opens to its own log; the dashboard's security notes
now say so, and why a copy opens nothing once used or after five minutes
(#270).

### Notices and the status

**You choose how much obsync tells you.** In Settings, obsync,
**Notifications**, from the command palette, or with
`obsidian obsync-private-sync:notices` (Obsidian 1.12.2 or later): pick
**Everything useful** or **Only what needs me**, and whether combined edits
are announced once per note, every time, or only in Recent. By default a
note's combined edits are announced once, then not again until it goes five
minutes without one, and the notice names the note by its title and the
other device by its name. A burst of notices folds into one "N more"
notice, and **Show sync status** lists recent notices with a button to open
each note; asked for again, it comes to the front instead of opening twice
(#269). Questions and security warnings always show, whatever you choose.

**Every notice says what it is and what to do.** Each is a question, a
security warning, an error, a conflict, combined edits, information, or the
answer to something you pressed, and its kind decides how long it stays and
whether **Only what needs me** keeps it to Recent. A notice said again joins
the one on screen as "(20 times)" instead of stacking, in Recent too: twenty
**Sync now** presses in a row showed twenty notices and now show two. Notes
are named by title and devices by name, with no file ids or internal words.
While the security warning about your recovery key stands, the status bar
shows the alert icon. The pairing match code shows only on its own notice,
never in Recent, the command line or the log, and **Pair a new device**
closes once you approve; a notice says when the new device holds the vault
key. The reminder to confirm your recovery phrase is now a question that
stays until you act on it. On a phone, the notice that says what your server
refuses, such as "Your server is out of storage", goes as soon as the server
takes changes again; it stood for hours beside a synced check (#308).
**Delete everywhere** now says what it does, as **Restore here** already
did, so Recent no longer ends on a question you answered (#309).

**A device that only shows a note while two others type in it no longer
announces every merge.** It said "obsync merged concurrent edits to <note>."
for each one, 58 times in a one-minute test; now only edits made on that
device are announced (#279).

**The status no longer reads synced while work is waiting.** A change your
server refused no longer leaves the check mark over a note that exists only
on this device (#293). If the server keeps refusing it, the status names it
-- "Your server refused the change to "Plan"" -- until it is sent, deleted
or put back, and says it goes again within five minutes, or at once on
**Sync now** (#299). Changes
from another device that wait behind other work count too (#286). Each note
counts once: one looked at again while it was still being sent, or sent
while it waited for your typing, read "syncing 2 files" (#296). Files
obsync only reads to check them read "checking N files for changes", and
"syncing" counts changes only (#246).

**`offline — retrying` means your server did not answer.** A computer that
wakes, a window brought back to the front, or a **Sync now** press no longer
shows it for up to a minute while the server answers, and the log line now
names the request that went unanswered (#288). A server that answers with
an error of its own, such as a storage failure, is answering, so it no
longer reads offline either; only no answer, or a proxy or tunnel answering
for a server that is gone, does (#298). A run of such errors no longer piles
requests up on the device until it reads offline (#297). A server out of
room says "Your server is out of storage", and one that needs a restart says
so (#291, #292, #295, below). An action that is never repeated, such as
revoking a device, says when the server answered it with an error that it
may not have happened, instead of "the server never answered" (#299).

**When changes stop arriving, obsync says what they wait for.** Within
about twenty seconds of **Sync now**, the status names the step it waits
on, for example `checking for changes, waiting for the cleanup of
interrupted writes`, and after about two minutes the plugin's log has a
warning that names it. Changing Sync folders, switching servers or Leave no
longer wait forever on a check of this vault's files or on that cleanup;
anything else they wait on past ten seconds is logged as a warning
(Troubleshooting, "Changes from your other devices stop arriving"; #276,
#285, #287).

**Closing obsync's settings cannot stop a computer receiving changes.** In
Obsidian 1.13, Settings opens as a window of its own. Closing it can lose the
answer to a disk read or write obsync has just started. In testing, before
this fix, changes from your other devices then stopped arriving until
Obsidian restarted: while the status read idle, after a check of your vault's
files (#302), and in a first sync after pairing, at "syncing 300 files"
(#307). Every disk read now gives up after 15 seconds, and a second more for
each MiB it reads, and says so in the plugin's log. What it was part of runs
again, and sync carries on. A write is never given up on, since it may have
landed: one that runs past that time is noted in the log and waited for.

**Routine answers are no longer console warnings, and the log names no path
of yours.** A first setup finding no data yet, and a new device waiting for
approval, are logged as expected. After obsync is turned off and on or
reloaded, a request the old session still had waiting ends at its next
attempt with one line, instead of retrying for up to two minutes (#272). A
failed file operation no longer writes your vault's full path to the log
(#266).

**Check says when the address you typed was not saved.** An address
**Server URL** refuses, such as one that is not https:// on a phone, is not
saved. **Check** used to say to type an address first, while the field
showed one, or checked the address saved before it. It now says "Server URL
was not saved" and why, and asks no server until you correct it (#303).

### Folders and Sync folders

**Renaming a selected sync folder no longer leaves an empty folder
behind.** If a device syncs only some folders (**Sync folders on this
device**) and you rename one of them, your other devices now remove the
old, empty folder, and a device paired later no longer gets it. When that
removal cannot be sent at once, because the server does not answer or
Obsidian closes first, the device sends it once the server answers; it is
left over only if you narrow the folder selection before then. Your notes
always moved correctly. An empty folder left by an earlier version stays
until you delete it on a device that syncs the whole vault; every device
then follows (#240, #265).

**A folder whose capitals you change reaches your other devices before its
notes.** Rarely, when the folder's upload was interrupted, or a note in it
had been edited just before, another Mac, Windows or Android device refused
the notes inside with a message that the folder is spelled differently. An
Android phone taking such a rename from another device also no longer sends
it back as its own (#238, #264, #244).

**Adding Sync folders back sends a note you moved out as one move.** Every
device ends with one copy of the note, at its new name with its history,
instead of two. If you deleted it or moved it to a hidden or linked folder
meanwhile, it comes back under its old name, even if Obsidian quits part way
(#239, #281).

**Pairing again over the vault a device kept no longer writes renamed notes
back under their old names,** or sends them again as new notes (#241).

**A computer paired later no longer keeps an empty folder,** or shows
"Changes from your server could not be read" for a few seconds, when the
history it catches up on renamed a folder and back, or made and deleted one
(#266, #241).

### Faster

**Sync now on a phone reads only the files that changed.** It read every
file up to 8 MiB at each press; it now asks the phone's storage for each
file's size and date and reads only the files that differ. On an Android
emulator with 7,700 notes, a press with nothing changed took 757 ms instead
of 218.9 s; on a 1.1.5 build, an Android 15 emulator with 9,814 notes took
850–969 ms ([2026-09-30 run](docs/validation-runs/2026-09-30-train-1.1.5.md)).
A rewrite by another app that keeps a file's size and date is
left to **Verify all files**. Every check of the vault also asks each
folder, not each note, whether it is a vault of its own. Seen on Android;
not yet run on an iPhone or iPad. obsync first checks that the storage
answers as expected, and otherwise uses Obsidian's own file list and says
so once in its log. A computer still reads files up to 8 MiB (#246, #282).

**A minimized window keeps full speed while obsync has work.** On a
computer, a minimized or covered Obsidian window slows its own timers, and
sync slowed with it. obsync now asks the window to run at full speed while
it has changes to send or receive, and gives that back a few seconds after
it finishes. If Obsidian does not allow it, the log says
`host decision=throttle_unavailable` and sync runs as before. Tried on
macOS; Windows and Linux use the same call; phones are unchanged (#283).

**A device you pair writes each note once, as it is now, and its trash
stays empty.** A device that pairs, pairs again, or adds Sync folders
reads your server's history from the start. It used to write every
version your server keeps of a note, one over the other. It also wrote
each note deleted elsewhere in the last 30 days, then moved it to its
trash: a new laptop's Trash filled with notes you had already deleted.
It now skips a version a later one replaced, without downloading it,
whenever the note is not already on that device. A lab desktop paired
against 9,801 notes ended with 17 deleted notes in its trash before the
fix and none after it, and downloaded 8.3 MiB less
([2026-09-30 run](docs/validation-runs/2026-09-30-train-1.1.5.md), #311).

**A computer that sends a vault no longer reads a third of it back.** After
the device that set obsync up sent a 9,800-note vault, it asked the server
for about a third of those notes again, one a second for about an hour,
while it checked that the server still held them. It now remembers what
it sent. A lab desktop given 2,000 new notes read 290 of them back in the
five minutes after a restart before the fix, and none after it
([2026-09-30 run](docs/validation-runs/2026-09-30-train-1.1.5.md), #310).

**A first sync from a computer rewrites obsync's data file far less.** For
a 7,703-file vault, 7,451 writes of the file became 211 to 253 over three
runs, and the upload took 233 to 281 s instead of 302 s (#274). A new
note's upload also no longer looks through every note obsync knows for a
name that differs only in capitals.

**The server is faster where it spends its time.** When several devices
upload at once, their new versions now share the disk flush that makes them
safe instead of each waiting for its own: at 16 in flight on a Mac, 45
became 146 versions a second, each still answered only once it is on disk.
SHA-256 is faster, still without unsafe code, and downloads stream in
larger pieces, so moving 2 GiB up and down costs the server 42% less CPU on
Linux. `docs/benchmarks.md` records where the rest of a sync's time goes:
for typing, mostly Obsidian's own two-second delay before it saves a note.

### Running a server

**A full disk says so.** When the disk filled before the free-space reserve
did, because the declared size is larger than the disk or something else
used the space, the server answered `500 io_error` and devices showed they
were offline for minutes. It now answers `507 storage_full`, and devices say
"Your server is out of storage" (#291). The same holds for the journal
volume, which every signed request writes to first, reads included: it
answered `503 nonce_log_unavailable`, and now `507 storage_full`. It is
still a refusal: nothing is answered before its replay record is safely
written, and a refused request goes through once there is room. If the
server cannot take a refused record back out of the journal, it answers
`503 nonce_log_faulted` until it is restarted. A device whose own check for
changes was refused clears the alert at the next answered check (#292). The
words now end "Free space on the server or raise its quota, then select Sync
now.": once there is room, **Sync now** sends what waited at once, where
before a refused change waited up to five minutes for the next check
although the words promised that sync resumes by itself. Declare no more
than the disk really holds (Troubleshooting, "The server has run out of
storage").

**A power cut right after an upload no longer loses what the server
confirmed.** On a filesystem that does not save a new folder together with
the file inside it, a piece of a file that opened one of the server's new
storage folders could be lost with that folder. The server now makes each
new folder durable before it confirms the upload. That costs one more disk
flush for such a piece, which is most pieces while a store is young; on
Linux the benchmark's time did not change (#273). After a crash, the start
that makes those folders durable keeps the trace of the crash until it has,
so a start that fails part way repairs again at the next one, rather than
taking the folders as saved.

**A server that needs a restart says so.** When a write to the journal
fails and taking it back fails too, the server takes nothing more until it
is restarted. Devices now say "Your server hit a storage error and refuses
changes until it is restarted. Restart your obsync server, then select Sync
now." instead of reading offline and promising that sync resumes by itself,
and `/readyz` answers `503 not_ready` for it, so an orchestrator takes the
server out of service. The server logs the fault once, naming what the
failed take-back answered (#294, #295).

**A full server keeps saying so while the file it refused waits.** When
your server ran out of storage and refused a large file, a smaller note it
still took made the status drop "out of storage" and read "syncing 1 file",
with the large file still unsent. "Out of storage" now stays, in the status
bar and in **Show sync status**, until that file is sent or leaves the
vault, even while obsync tries to send it again. Deleting that file clears
it at once (#300, #305).

**The free-space reserve and an account's quota hold when uploads arrive
together.** Each chunk upload was checked against the space already counted
and counted only after it was written, so uploads of different chunks that
arrived at the same moment could all pass: a small declared volume took a
12.6 MB note past its 1 MiB reserve. Each upload is now measured against
what is stored plus every upload already admitted and still writing, and
holds its space until it lands; one that fails or is cut short gives it
back. The refusals are unchanged: `507 volume_full` and `507
quota_exceeded` (#301).

**Behind a proxy or tunnel, a full server says it is full.** A server that
refused a file of more than about 1 MiB for lack of room answered before it
had read the upload, and closed the connection on the rest. A proxy or
tunnel in front, still sending it, then told the device the server was gone,
and the device read "offline — retrying" for a minute before "out of
storage". The server now reads the refused upload to its end first, so the
device shows "Your server is out of storage" at once (#304).

### Behind the scenes

CI now types into one note on two real Obsidian instances and holds back
one instance's file events; the speed benchmark sends what the plugin sends
(#275); and the test tooling is stricter (#271, #277, #280).

Obsidian's list of installed plugins shows the author as Samuel Naranjo.

## 1.1.4 - 2026-09-29

1.1.4 fixes the issues that were open when its scope was set on
2026-09-27 -- found by people running obsync and by a review of the whole
plugin and server -- and those found while testing it on real computers,
phones and CI runners until then, with three found after (#242, #243, #252).
One is better but not fixed: two devices typing in one note for a long time
can still, on a very busy computer, move one person's line into a conflict
copy, which keeps it (#227, below). Issues found after the scope was set
wait for 1.1.5 (#238 to #241, #244 to #248, #253). Among them: on a Mac whose
file-event service is overloaded, Obsidian may not list a note obsync
downloaded until it catches up or restarts (`docs/troubleshooting.md`, "A
note that synced does not show in Obsidian").

Update the server and every device; each works with the other's 1.1.3
meanwhile, and the notes below say where a mixed pair behaves differently.

### Before you update

- **Docker Compose** asks how much space obsync may use:
  `OBSYNC_BLOBS_CAPACITY` (such as `200GiB`) and `OBSYNC_JOURNAL_CAPACITY`
  (such as `4GiB`). Until both are set, Compose refuses to start and names
  the missing one.
- **The Helm chart** no longer guesses your ingress peer or storage class. An
  install that relied on the old defaults sets `ingress.peers` and
  `storage.*.className`; until then it fails closed instead of deploying.
  The memory request rises from 64Mi to 128Mi (the limit stays 1Gi). Its
  two platform annotations (`<domain>/deployment-ready`,
  `<domain>/volume-capacity`) now appear only when you set
  `platform.annotationDomain`. A platform whose policy reads the keys
  releases up to 1.1.3 rendered sets it to their prefix,
  `platform.snaraj.dev`, in the same change that selects 1.1.4; the 1.1.3
  chart refuses the new key, so it cannot go in earlier.
- **If you copied the Kubernetes guide's TLS front**, give its `proxy_pass`
  name a trailing dot (`obsync.obsidian.svc.cluster.local.`): without it,
  nginx can fail to start where the cluster's search domains are tried
  first, as in an IPv6-only cluster. In a dual-stack or IPv6-only cluster,
  also uncomment its `listen [::]:8443 ssl;` line (#226).
- **Behind a proxy or tunnel**, the server believes forwarding headers only
  from addresses in `OBSYNC_TRUSTED_PROXY_CIDRS` (in `cloudflare` mode, the
  private networks when it is empty). A connector on a public address must be
  listed there, or every request answers 421. A `/0` entry stops the server at
  start.
- **If you copied obsync's nginx configuration**, copy it again, or make its
  two lines read `listen 8443 ssl http2;` and `error_log stderr;`. The old
  file does not start on nginx 1.24 (Ubuntu 24.04) or under systemd (#215).
- **`obsyncd export`** takes the key from `--key-file <file|->`, a regular file
  with mode 600. `--key` still works and warns; it goes in a later release.
- **Custom request headers** (formerly Edge service-token headers): a line
  saved by 1.1.3 that a request cannot carry now stops each request with a
  message naming it, instead of being dropped without a word (#183).
- **Pairing**: update the server as well as the plugins. Only a 1.1.4 server
  removes a device that was approved but never collected the vault key (#153).
- **Going back to 1.1.3** on a device drops two things 1.1.4 keeps in the
  plugin's data file: a pending folder selection (#185) and deletions held for
  your answer (#162). A held deletion is then published at the next start
  unless the share rule holds it.

### What the status bar tells you

**The status bar is one steady icon.** It no longer jumps while you type:
a check when this device is up to date, a turning wheel while it syncs, a
cloud struck through while the server does not answer, an alert when sync
needs you, and a pause sign for a paused note. Hover it for the words; click
it for **Show sync status**, which stays current and offers the next step.
Every command ends in "(obsync)", so the palette finds them all (#156).

**Phones and tablets show the same icon** in the header of the note you have
open; tap it for **Show sync status**. A problem that needs you is also said
once in a notice. Android, iOS, iPadOS (#209).

**The status tells you what is really going on.** Receiving or sending many
notes reads syncing with a count that goes down, a device starts on
"checking for changes", and "offline — retrying" clears as soon as the
server answers (#158).

**A note waiting for your typing is named.** "syncing 1 file" goes on
", waiting for unsaved changes in" and the note's name, and Show sync status
says its newer version follows once that typing is saved (#252).

**A refusal says what it is, the first time.** A removed device, a wrong
clock, a full server or a proxy answering instead of obsync each say what
happened and what to do, and clear by themselves once fixed; if Obsidian
started while one was so, it says to select Sync now once it is fixed,
because nothing tries a refused start again on its own. Repair no
longer sends you to check your network, and after a new vault key an unsent
edit is sent once under the new key with one notice (#155, #160, #177).

**Check, the device list and Sync now answer quickly and in plain words.**
No more `0 unreachable: network=…` after a minute's wait (#182).

**An untrusted server certificate is named as one.** Check, the status, Show
sync status, setup and pairing say "This device does not trust your server's
certificate, so it refused the connection" and point to the troubleshooting
entry with each device's steps. Sync keeps retrying and resumes once the
certificate is trusted. Seen on desktop; phones are matched by their own
wording for the same failure (#201).

**A certificate for another name, or out of date, is named too.** Check,
the status, Show sync status, setup and pairing say which it is and what
to do, instead of "nothing answered" and the struck-through cloud. Sync
keeps retrying. Seen on desktop; phones are matched by their platforms'
documented wording, not yet seen on a device (#229).

**A device kept out by your server's edge says so.** Before, only a first
pairing said why. The status, Show sync status and Check now say the
request did not come through the edge, and to check the Server URL, the
Custom request headers and the route to the server, in pairing's own
words (#228).

**Settings no longer shows an old outage, and your devices are named, not
numbered.** Each opening of Settings reads the device list itself, and "not
answering" goes by itself once the server answers. Show sync status and the
Pairing row name this device ("iPhone 5DMY"); the long device id stays,
smaller, in Show sync status for support (#152).

### Faster

**Sync picks up again the moment your network, the app or a new server
address comes back.** The next attempt goes at once instead of after a pause
of up to a minute, or five minutes for a VPN (#134, #186, #195).

**Your edits reach your other devices sooner.** A note you are typing in is
sent about 150 ms after the editor saves instead of 0.9 s (another app's
writes keep the longer wait), a small edit takes two requests instead of
three, and the start no longer waits for its report to the server (#195).

**A note you type while a big file moves now arrives in about a second.**
Uploads no longer move in lock-step batches, and note-sized pieces have room
of their own. Versions over 32 MiB download beside other changes and are
written only once complete and still the newest; Show sync status says
"Downloading <file>". On the test fakes, 58 s became 0.3 s up and 62 s
became 0.2 s down; on a real iPhone a note arrived ahead of a 128 MiB file's
first piece (#196).

**Large uploads run about twice as fast and do half the work.** A file is
read and encrypted once (256 MiB: 44% less CPU), and 32 MiB instead of 8 MiB
may be on the wire: 71 → 134 MiB/s at 20 ms round trip. On a link that is
itself the limit the gain is small (200 Mbit/s: 20 → 23 MiB/s). If Obsidian
closes in the middle of a large upload, it may send up to 33 MiB again when
it reopens (up from 8 MiB) (#196).

**Stopping sync no longer waits out a download.** Leave, Save and quitting
end at the next piece instead of after up to 24 MiB. Nothing half-downloaded
is written (#196).

**Adding a device to a large vault is many times faster.** A 10,000-note
first sync rewrote obsync's data file 10,010 times (13.8 GB of writes) and
took about four minutes on the test fakes; it now writes it 10 times and
takes about 7 s in 175 requests. A phone holds at most 8 MiB of prefetched
notes, a computer 32 MiB (#194).

**Copying a vault onto a new device no longer uploads it all again.** A
copied vault of 1,000 notes published 668 versions and 650 deletions; it now
publishes none. A note the server also names waits at most ten minutes for
the device to catch up (#194). A device paired again after your other
devices edited while it was away holds those notes as it last saw them;
pairing takes each as the earlier version it is and uploads nothing, so it no
longer asks whether to add them to the server's vault either. All platforms
(#194, #141).

**Attachments are recognised too, not uploaded again.** A device paired
again after Leave, or a vault copied onto a new device, recognised its
notes but not its files over 8 MiB, such as photos, PDFs and recordings: it
published each one again under a new id, and your other devices retired one
of the two, which could leave a file's history under the retired copy. Such
a file is now recognised by reading it once and comparing it, piece by
piece, with the version the server holds; nothing is uploaded or
downloaded. A file that differs by one byte is kept beside the other, as
before. On a phone, a file above its per-file limit is not read to check it
and is handled as before. All platforms (#232).

**An idle vault stays quiet.** 4 requests instead of 3,186 per idle hour at
10,000 notes: repair walks every 6 hours, and a computer walks its folders
every 5 minutes and when you return to Obsidian (#198).

**Changes made while Obsidian is in the background upload within
seconds.** On a computer, a note changed while Obsidian's window was
minimized, behind other windows or on another desktop could take minutes
to reach your other devices: a hidden window slows its own timers to about
one a minute, and obsync's uploads and its reconnects waited on them.
obsync now keeps time in a small background worker a hidden window does
not slow. If the worker cannot start, obsync says so once in its log
(`timers decision=fallback`) and works as before. Computers only; phones
are unchanged (#221).

**Sync now is quick, and Verify all files checks everything.** Sync now read
and encrypted every file in the vault to find the few that had changed; on a
phone that meant reading files of up to 512 MiB whole at every press. It now
sends what is waiting, fetches what the server has, retries what was held
back, and reads the contents of files up to 8 MiB, the size at which another
plugin can rewrite a note without changing its size or date. In a test vault
of 10,000 files with fifty 12 MiB attachments, a press read 20 MB instead of
1.9 GB. The new command **Verify all files** reads every file, however large,
sends the ones that changed, and says how many it checked. Desktop and
mobile (#197).

**A large download on a phone holds the file once, not twice.** A 512 MiB
download, the most a phone takes by default, held about 1 GiB at its peak by
the plugin's own count, enough for the phone to close the app; it now holds
520 MiB. Computers write downloads in pieces and were not affected (#197).

**Restore from history takes far fewer requests.** Each **Load next** made
twenty requests, and a search that reached a thousand versions back made a
thousand. Each now reads up to 100 versions in one request, and that search
takes about a dozen. Works with older servers. Desktop and mobile (#199).

**Small speed-ups you will not see.** Encryption keys are prepared once per
session, and uploaded pieces are hashed once instead of twice. What is
encrypted is byte for byte the same (#197).

### Your notes stay safe

**A phone no longer empties a note it has just received.** On Android,
Obsidian sometimes finished writing a downloaded file but left it empty. The
phone took the empty file for an edit and sent it back, so the note became
empty on every device, including the one that wrote it; its text stayed only
in the note's history. In a test, 4 of 1,600 files a desktop wrote came back
empty this way. A phone now writes such a file again, whether a download or
a merge of two devices' edits. If it stays empty, the phone names it in the
status, tries it again later, and never sends the empty file, wherever it is
moved, or its deletion. A note this already
emptied can be restored from history
([troubleshooting](docs/troubleshooting.md#a-note-became-empty-on-every-device)).
Mobile; seen on Android (#242).

**A note open on screen shows another device's change as soon as it
arrives.** On a busy computer, Obsidian could miss obsync writing a note
that was open and keep showing the old text. obsync took that old text for
unsaved typing and held every later version of the note, so the status read
"syncing 1" for as long as the note stayed open, and a keystroke there saved
the old text over the newer one. obsync now puts what it writes into the open
note itself, instead of waiting for Obsidian to notice the change. A note
holding unsaved typing still waits for it to be saved, and the newer version
is merged in.
On 1.1.3, closing the note's tab and opening it again clears it
([troubleshooting](docs/troubleshooting.md#a-note-stays-at-syncing-1-file)).
Desktop and mobile (#252).

**Two people typing in one note on two devices keep each other's
typing.** When both devices merged each other's changes at the same moment,
round after round, obsync stopped after three rounds and settled the note by
rule: one device's version stayed and the other's went into a conflict copy,
so words someone had just typed left the note they were still typing in
(they were in the copy). It was rare, and most likely on a busy computer or
phone. Each device now remembers the merges it has already worked out, so it
keeps combining both people's typing for as long as they type, with no copy.
Both typing devices need 1.1.4; a 1.1.3 device still settles by rule.
Desktop and mobile (#227).

**And when both type for a long time without a pause.** obsync writes the
other device's typing into a note only once the typing there pauses. When two
people typed without a pause for more than a few seconds, each device had to
look further back through the note's history than it allows, gave up, and
settled the note by rule: dozens of conflict copies, and one person's typing
was in them and not in the note. Each device now remembers the history it has
already read, so the note combines both people's typing as soon as they
pause, however long they typed. A device whose note lost that rule while
someone was typing in it also no longer sends its next save over the other
device's text. It can still happen on a computer too busy to keep up: in a
test of two desktops typing for a minute beside six busy processes, 2 runs in
11 moved one person's line into conflict copies, which kept it. Both typing
devices need 1.1.4. Desktop and mobile (#227, which stays open).

**Deleting many notes at once asks first, and Restore here puts them back.**
Five or more notes deleted in one go -- a multi-select, or the notes inside
a deleted folder -- stay on your other devices, and one notice asks: "You
deleted 20 notes (in Notes). Delete them on your other devices too?" with
**Delete everywhere** and **Restore here**. Restore here puts the notes back
on this device exactly as they were, from the server, with no copies and no
new versions. The question waits for you, across a restart, and stays under
Settings, obsync, **Deletions held back**. Fewer than five deletions go at
once, as before. A phone does not put back a note above its **Largest file
to download** (#162).

**A phone no longer stops syncing over a note it no longer has.** A note
deleted on a phone while obsync was not running, in the phone's Files app or
with Obsidian closed, and then deleted on another device, stopped that phone
for good: it could not move the note to the trash because it was already
gone, every attempt stopped at the same place, and the status read "Changes
from your server could not be read" while the server answered every request.
The deletion is now settled as done, the way a computer already settled it,
and sync goes on. iPhone, iPad and Android (#234).

**A note you deleted stays deleted when you add a folder to Sync folders.**
Adding a folder under **Sync folders on this device**, or going back to the
whole vault, makes the device read your vault's history again from the start.
A note another device wrote and this device then deleted came back on this
device alone, with the text it had before, while your other devices kept it
deleted; a folder deleted the same way came back too. Now the device finishes
its own deletion as the history reaches it, and sends nothing. The history is
still read in full, so such a note is downloaded once more and moved to the
trash again. A note that came back before you updated goes the next time you
add a folder; if you edited it meanwhile, your edit is kept everywhere.
Desktop and mobile (#237).

**A file you fetched past the download ceiling is never trashed when it
changes.** obsync keeps the copy you have, lists it under **Show remote-only
files** as "a newer version is on the server", and says so once with a
**Fetch** button; Fetch replaces your copy only if you have not edited it
(#161).

**Restoring a version and keeping a conflict copy work on Windows.** Every
restore reported an error there, and a conflict could leave up to 20 copies
before obsync gave up: Windows refuses to flush a folder to disk, and obsync
treated that as a failed copy. It now publishes the copy once and logs that
the folder could not be flushed; any other failure still stops the copy and
says why (#222).

**A conflict copy that could not be confirmed is still one copy.** When
saving a copy failed after it was already in place, obsync wrote it again
under the next name, up to twenty times. It now keeps the copy when it is
the right one, or takes it back before trying another name. It never
removes a file it did not make; when it cannot tell, it leaves the copy and
tries again later. Desktop and mobile (#225).

**On Windows, obsync no longer takes two files for one.** It tells files
apart by their id, and Windows ids can be larger than the numbers the
plugin held exactly; the whole id is compared now. Nothing changes on
macOS, Linux or phones (#224).

**Restoring a copy and keeping a conflict copy work on a USB stick or SD
card** formatted FAT32 or exFAT, still never replacing a file already at
that name. Desktop only; phones already worked (#176).

**A downloaded note survives a power cut.** obsync now flushes a downloaded
note to disk before giving it its name, and the folder after. That costs one
more flush per downloaded file, measured at about 12 ms per file on macOS.
Desktop only; the phone's storage call offers no flush (#202).

**obsync refuses oversized or mismatched answers** from whatever sits in
front of your server: every read has a size limit, and a batch of downloaded
pieces must name the pieces asked for, in order. Servers on 1.1.3 keep
working (#202).

**Sync notices name files that exist, once, and only for what this device
did.** A conflict notice waits up to ten seconds for a copy's name to settle,
a note that moved while its upload waited no longer flashes `obsync: error`,
and a first sync no longer announces merges it took no part in. Copies and
notices from a device paired a moment ago name it straight away (#164).

**A note renamed on one device and edited on another keeps its new name,**
holding every edit, with no copy; swapping two notes' names in one go ends
with both names on both devices (#151).

**A folder renamed to two different names on two devices ends under one
name.** Every device keeps the name that sorts first, moves every note
there, and says once which name it kept; nothing is copied or deleted (#174).

**Pairing again after Leave no longer copies a note you had edited before**
when its text matches the server's latest version (#163).

**Two notes given one name while a computer was offline get their names
sorted out when it reconnects,** at its next upload rather than its next
edit (#122).

**A note renamed a moment after you make it arrives once on your other
devices,** under its new name, instead of twice. A folder renamed while a
new note in it uploads takes the note with it (#213).

### Folders and capitals

**A folder whose capitals you change and change back follows on every
device,** and the notice about it tells you to update another device only
when it really runs an older obsync (#165).

**A device that follows a capitals-only rename no longer uploads a second
copy of every note** in that folder (#166).

**A rename of the folder you sync is not lost** when your disk refuses it
once, or when obsync stops half-way through it (#127).

**A folder deleted on another device no longer stays behind because Finder
or Explorer left a file in it.** `.DS_Store`, `._` files, a custom folder
icon, `Thumbs.db` and `desktop.ini` go with the folder; the two Windows files
are no longer synced at all. A folder holding anything else is kept, and
obsync says so once (#184).

**A linked folder's name no longer turns into an empty folder on your other
devices.** obsync says once: "obsync doesn't sync linked folders: "…" is a
link, so it stays on this device only." Desktop; phones have no such links
(#167).

**An Android device now takes a capitals-only rename made on another
device.** Renaming `Meeting notes.md` to `meeting notes.md`, or a folder the
same way, left Android on the old capitals for good while it showed synced:
Android's storage treats the two spellings as one name, and Obsidian there
refuses to rename by capitals alone. The phone now renames through a hidden
name in the same folder, with Obsidian's own rename twice, so nothing is
copied, sent back or deleted. If the phone stops between the two steps, the
next start puts the note back before anything else and the rename is made
again. Obsidian's file list on the phone shows the note once, under its new
capitals; an old-capitals entry it could briefly show is removed, and
deleting such an entry asks first instead of deleting the note on every
device. Obsidian on Android still cannot rename by capitals alone itself:
rename on another device, or to a different name first (#219).

### Pairing, setup and settings

**A computer shut down right after pairing no longer stops obsync for
good.** Obsidian keeps obsync's keys in storage that can reach the disk
after obsync's own settings file. A crash, forced quit or power cut in
between left the plugin refusing to load, with nothing to press. It now
starts unpaired, says so once at start, in Settings and in Show sync
status, and offers **Pair this device**. The keys it was saving are gone
and are never guessed; nothing on the device or the server is deleted.
The entry the device had stays in the Devices list for you to revoke once
it syncs again. The same on computers and phones (#230).

**The approval prompt tells your devices apart, and shows a code to check.**
A device names itself by what it is plus a short tag it makes itself, such
as "Mac 7KQ4", never by its computer name. The prompt shows six digits the
new device shows too, which both screens work out from the pairing code;
the server cannot make them agree. Older devices show no code and pair as
before (#152).

**Once you approve, the new device says so.** It compares the notes it
already holds with your server's vault before it syncs, which on a phone with
thousands of files took a minute, and all that time its dialog still read
"Waiting for approval on the other device". It now says it was approved and
is comparing, and that a large vault takes a minute. That comparison, and
the count **Leave** makes of edits not yet sent, now ask about each folder
once instead of once per file: on an Android emulator 300 files took 2.5 s
instead of 33.6 s, so a phone holding thousands of files no longer waits
minutes to leave a server. All platforms (#236, #198).

**A pairing that fails or is abandoned no longer says "paired" or leaves a
device without a key on your account.** A new device becomes active only
when it collects the vault key, and one that has not collected it when the
ten minutes end is removed. Update the server too for the removal (#153).

**Setup and pairing mistakes say what to do next instead of showing a server
code,** a pairing link from **Copy link** can be pasted into the code field,
and a setup token pasted with quotes or a line break is read as meant. **Pair
this device** is now in the command palette. Once the server holds a claim,
the one-time code leaves its field, and the prompt counts "1 note" and "7
notes" (#154).

**The Devices list says which devices are still pairing,** puts revoked ones
last, marked "(revoked)", and counts what is true, such as "3 devices on this
account, and 1 revoked." (#152)

**The setup token no longer stays on screen after a failed setup.** Its
fields are masked like a password, with an eye button, and empty after every
attempt and when Settings closes (#169).

**obsync remembers whether you confirmed your 24 recovery words, and reminds
you quietly** in Settings and Show sync status, and once at the next start
after you skip the check (#170).

**A copied vault, or one whose folder you renamed outside Obsidian, starts
unpaired instead of stopping with a storage error,** and Settings offers
**Pair this device** and **Start fresh** (#168).

**Proxy headers are checked as you enter them, and never replace obsync's
own.** The setting is now called **Custom request headers**. A header pasted
from a command line or wrapped in quotes is trimmed, with a word; a curly
quote, a character a header cannot carry, or a name obsync sets itself is
refused, naming the line (#183, #201).

**On a phone, the keyboard no longer learns your setup token, pairing code
or recovery words** (#208), and the proxy headers and folder boxes use the
whole width (#210).

**Leaving a server answers in seconds, and a device can always leave.** When
the server cannot remove this device, the dialog offers **Leave on this
device only** (#157).

**Leaving the server just after Obsidian opens leaves nothing running
behind.** **Leave this server** chosen while obsync was still starting, just
after Obsidian opened or the plugin was turned on, left the device unpaired
with sync still running: requests went on under the access it had just given
up, and it retried a server it no longer had every five seconds. Leave now
lets a start under way stop first, so once Leave says the device has left,
nothing of the old pairing runs or sends anything, and a late refusal from
the server you left no longer turns the status to an error. A folder
selection saved while obsync was still starting no longer leaves two copies
of sync running. The same on computers and phones (#233).

**Saving a folder selection during a big upload keeps your choice and takes
effect in about a second,** with **Cancel** beside the file it is stopping
(#185).

**On Linux without a keyring**, the docs now say that Obsidian keeps obsync's
keys unencrypted, protected only by your home folder's permissions, that
Obsidian says so with a notice from its next start, and what to do (#217).

### Running a server

**The readiness check no longer tells anyone how much you write.** `/readyz`
answered `{"ready":true,"seq":<n>}` to any caller, and `seq` is the count of
changes your server holds: anyone who could reach the server could watch it
grow and see when you write. The server already kept that number to devices
and dashboard sessions that proved themselves; readiness now answers
`{"ready":true}` and nothing else. A monitor of your own that read `seq` there
reads it no more; health probes and the chart's checks are unaffected (#235).

**Run obsync behind the reverse proxy you already have.** The server reads
the standard `Forwarded` header and every `X-Forwarded-For` line, as one
list from the proxy's end, only from addresses in
`OBSYNC_TRUSTED_PROXY_CIDRS`; a header from anywhere else is ignored and
logged, so a device cannot forge its address on the dashboard. Tested
configurations for Caddy, nginx, Traefik and HAProxy are in
`deploy/proxies/`. The server listens on IPv4 and IPv6 alike (#200, #214).

**The Helm chart fits more clusters**: several ingress peers or a network
block, a registry mirror (the digest still pins the bytes), pull secrets,
node selectors, tolerations, affinity and pod labels. It runs on Kubernetes
1.34 and later, and its defaults name no one's cluster (#200). A signed
**static server for 64-bit Linux** (amd64 and arm64) with a hardened systemd
unit ships with each release (#200).

**The dashboard opens a round trip sooner,** and its install steps name the
plugin as Community plugins lists it (#206).

**The server stays small in memory** when devices fetch large files or catch
up on a long history: attachment batches stream, and history pages hold at
most 8 MiB. **One misbehaving device can no longer lock the others out,** and
unverified request bodies share one fixed amount of memory (#193), each
held until its sender's credential checks out, parsing and waiting included.
**A long history of a very large file stays readable:** the plugin no longer
refuses a file record past 64 MiB, and the server never sends one past
450 MiB, keeping every head and the newest versions that fit. **Its
memory follows your history**: about 1.3 KiB per kept version, and a restart
no longer needs four times it; the chart now requests 128 MiB (#205).

**The server answers sooner when several devices sync at once,** with every
answer still on disk first: 200 posts at once, median wait 185 → 81 ms
(#191). **A quiet server stays quiet**: ten idle minutes went from 151 disk
flushes and about 300 log lines to none, and after 10,000 notes an idle
server uses 0.36 s of CPU a minute instead of 12.8 s (#192, #203, #216).
**Stopping takes about a second, not twenty**; with `docker stop`, pass
`-t 30` (#203). A request waiting on a save of the server's replay records
that crashed is now answered as intended, never with a 500 (#223).

**Large photos and PDFs upload from a phone on a slow connection.** The
server now requires at least 16 KiB/s, measured from its first read of the
body, so a slow disk on the server is never blamed on the device (#204,
#220). **An upload cut off halfway is retried** as `503 body_incomplete`
instead of refused for good as 413 (#211), and neither it nor a slow body is
logged as a server error (#212). **Behind HAProxy the log no longer shows a
refusal for nearly every request** (#212).

**`obsyncd export` reads its key from a file or standard input** (see Before
you update), and **the readiness check no longer writes through a symbolic
link** left at its file name (#202).

**When the server cannot open its port, the log says which address,** such as
`addr=[::]:8080 io=AddrInUse`, and the protocol states that an empty
change-feed page with a higher `seq` is normal (#218). The shipped **nginx
configuration** starts on nginx 1.24 and under systemd (#215).

**The Kubernetes guide says which `listen` lines its TLS front needs.** Its
example listened on IPv4 alone, so in an IPv6-only cluster the front
answered a port-forward and nothing else. The guide now shows the IPv6 line
to uncomment for dual-stack and IPv6-only clusters, says why the example
ships without it (nginx stops on a node whose kernel has no IPv6), and how
to tell which cluster you have. CI reaches the front through its Service in
an IPv4 and an IPv6 cluster (#226).

### The project

**The plugin directory's scorecard warnings are fixed.** A folder inside your
vault that is a vault of its own with obsync installed is now recognised
whatever its settings folder is called, not only `.obsidian`: Obsidian lets
you name that folder yourself. A vault name received while pairing is checked
for control characters without a regular expression that holds them, and the
plugin keeps its data-file lock on Obsidian's window rather than on
`globalThis`. A test over the plugin's source now refuses all three shapes.
A phone asks each folder for obsync where this vault keeps it, so on a phone
the folder inside must use the same settings-folder name as this vault; a
computer finds it whatever its name. Desktop and mobile (#243).

**Speed is measured.** A benchmark harness and a nightly CI run time a
10,000-note first sync, an edit reaching a listening device, a 2 GiB
transfer and an idle minute, reading the server's own CPU, memory, disk
writes and flushes, so a slowdown shows up as a number (#190). The release
tooling accepts a repository that protects main with more than one ruleset
(#43). The chart ships example volumes for one machine with its own disk
(#74). Three help pages no longer say a folder selection can only narrow
(#171).

**The setup guides work for your setup, not only the author's.** Reading
the setup token no longer needs a POSIX shell: `docker exec obsync-obsync-1
obsyncd setup-token` works from PowerShell, Command Prompt or any shell.
Linux desktops get the trust step Obsidian actually reads, its own NSS
store, with the `certutil` command CI runs. Android gets a publicly trusted
certificate over DNS-01 that needs no open port. The same-network guide has
one table per server system, and the setup and validation pages name every
route by what it is, say which CI job proves it, and say plainly which
clients have not been recorded on a real device. CI runs real Obsidian on
Linux with GNOME Keyring and without one, and restarts it on the keys it
kept. The chart no longer puts
one deployer's platform annotations on everyone's cluster (#201).

**Troubleshooting grew with this release**: every failure met while testing
1.1.4 -- an untrusted certificate, a quick tunnel whose address changed, a
Linux keyring, capitals on Android -- has its entry, and the status bar's six
icons are shown with their words. The README is now a short front door with
a directory of every guide, in all 20 languages.

**The build tools are current.** The plugin is built and tested on Node
26.10.0, with npm unchanged at 11.19.1 (#249). Code scanning runs CodeQL
action 4.38.2 (#250). The CI jobs that hand a built server to the next job
use download-artifact 8.0.1, which fails the run when the file's checksum
does not match (#251).

## 1.1.3 - 2026-09-26

**Turning obsync off and on during an upload no longer loses track of your
files, or deletes one.** When you turned obsync off and on again in Community
plugins while a big file was uploading, the session you turned off went on
waiting for its upload and, a minute or two later, saved its older records
over the new session's. obsync then uploaded files that were already synced as
if they were new, and a 1 GiB file vanished from the computer that made it,
while the other computer kept it. Now only the newest session writes obsync's
records; one that was turned off stops and writes nothing more. A file whose
record was lost anyway -- a phone force-quit in the middle of saving it -- is
recognised at the next start as the one this device already uploaded, with no
new copy on the server. And when another device settles two copies of one
file, a device still tracking the retired copy keeps the file if the kept
copy holds the same bytes. Devices before 1.1.3 still apply that settling as
an ordinary deletion. Same on desktop and mobile (#181).

**A server restored from a backup gets back what your devices did after it.**
When the server was rebuilt from a volume backup, the changes made after that
backup stayed on the devices that made or received them. A new or reinstalled
device got the old vault. The others read `idle`, then showed "Server repair
could not verify a retained file ... check connectivity" for good. Each device
now notices that the server went back in time, when it reconnects or when its
repair pass finds a version gone. It re-sends the notes, renames and deletions
the server lost, and says once: "The server was restored to an earlier state;
this device re-sent N changes." A note another device changed on the restored
server is merged or kept beside the re-sent one, never replaced. A deletion is
re-sent only by a device that made or received it; each remembers its last
1000. A change made before a device updated to 1.1.3 is re-sent only when the
server lost the whole note. Same on desktop and mobile. (#145)

**Moving or renaming a folder outside Obsidian no longer deletes its notes on
your other devices.** A folder renamed in Finder or another file manager while
Obsidian was open reached the other devices as deletions: its notes vanished
there and, when the new folder was still synced, came back a second later as
new files with their history left behind; when it was outside **Sync folders on
this device**, they stayed deleted, with no word on either device. A deletion
now waits half a second for the rest of what Obsidian reports. A note whose
bytes are in the vault under a new name inside the selection is published as
the move it is, history and all; one outside the selection stops syncing from
this device but stays on the others, and one notice says how many notes left.
The same holds for a folder moved while Obsidian was closed, which could delete
a small folder on the other devices or leave a "Deletions held back" warning
whose Confirm button would have deleted notes that were right there: that
warning no longer counts a note found in the vault under another name, lets go
of one that turns up again within 30 seconds, and Confirm never deletes one
found under another name. A note you really delete is still deleted everywhere, half
a second later. Same on desktop and mobile: the check compares the names,
sizes and times Obsidian already holds in memory, and never opens a file
outside your selection (#139).

**Held-back deletions wait for you, and a deletion is checked again before it is
re-sent.** On a device set to sync selected folders only, the "Deletions held
back" check counted every note the device had ever recorded, including notes
outside those folders, so 12 of 20 selected notes gone while Obsidian was closed
were deleted on your other devices without a question. It now counts only the
notes in the folders this device syncs, and the notice gives that number. Once
deletions are held back, **Sync now** no longer sends them when some of the notes
come back: notes that return are let go of, the rest wait for **Confirm
deletions**, and Sync now says they are still waiting. And a deletion whose first
send got no answer was sent again tens of seconds later without looking again, so
a note restored in the meantime, or brought back by another device's edit or
rename, was deleted anyway and left split in two on the server. It is now checked
against the vault first and dropped when the note is back, and the device that
deleted it says why the note came back. Your other devices no longer claim to
hold "changes this device has not uploaded yet" when a note was deleted
elsewhere from an older version: they say the version they have is already on
the server and kept. Same on desktop and mobile. (#172, #173)

**An edit that races a deletion stays as one current note.** The kept edit now
incorporates the deletion into its history instead of leaving the deletion as
a second current version forever. Later saves do not meet that deletion again,
and a successful settlement shows no notice. Startup upload and restoration of
the kept edit wait for each other, so their race cannot leave two versions of
the same edit. Another device's unseen edit is still preserved for the ordinary
conflict rule. Same on desktop and mobile. (#178)

**A note you are typing in stays when another device deletes it.** When a
note was deleted on another device while you typed in it here, it vanished
from under your cursor: the tab turned into "No file", neither device said a
word, and what you had typed in the last second or two, and everything you
typed after it, went nowhere. Now a deletion does not remove a note that is
open in an editor here while it holds typing that is not saved yet, or while
this device has sent an edit of it in the last 10 seconds. The note stays, is
sent again so it comes back on the device that deleted it, without a repeated notice; what you type next follows it everywhere. A note nobody has typed in
here for longer than that is deleted as before, open or not. The deletion remains in history and successful restoration is quiet. Same on desktop
and mobile. (#146)

**A note deleted on another device goes where your "Deleted files" setting
says.** Since 1.1.0, on a computer, a note deleted on another device was
removed for good: it was in neither Obsidian's `.trash` folder nor the system
Trash, whatever **Settings → Files and links → Deleted files** said (found in
the 2026-09-24 scenario run). It now goes, under its own name, to the system
Trash, to the vault's `.trash` folder, or away permanently, exactly as that
setting says; if the system Trash refuses it, it goes to `.trash`, never
nowhere. The same holds for the old copy obsync clears away when another
device renames a note or when two notes collide and one is moved aside, so
your bin can now hold a copy of a note that is still in the vault under its
new name. Phones and tablets were never affected. A note removed this way on
1.1.2 or earlier can be brought back with **Restore from history**: search for
its name and select **Restore a copy** on its last version.

**Two devices typing in one open note end up with the same note.** Typing in
one note on two devices at once used to merge once or twice, then save nearly
every version the other device sent as a conflict copy, stop merging with
"resolved it more than 5 times in a minute", and leave the two devices holding
different text under one name, with a dozen copies or more on each, while both
said `obsync: idle`. Now text typed on different lines is merged, and
both devices end on the same note holding both texts, with no conflict copy.
When both devices add text at the end of the same line, their shared addition
is kept once and the different additions are joined in the same order on both.
Continued typing before text received from the other device also merges while
keeping the line's original characters. Shared merge ancestors are combined
first so text already present on both sides is not added again.
Changes that replace the same existing text still conflict: every device keeps
the same version as the note, and the other goes into one conflict copy that every
device holds, named after the device that wrote it, the time in UTC and a short
id. Nothing typed is lost, and the two notes never stay apart. A save made
while another device's version is arriving is never written over, and the
status bar no longer reads `idle` while a note is still being settled. Incoming
updates wait while this note has unsaved text or you have typed in it during
the last ten seconds, then retry automatically. Other notes keep syncing.
Attempts refused while you type no longer consume the merge limit.
Overlapping attempts wait at that limit while the editor is busy.
This prevents Obsidian's own external-change merge from rewriting an editor
while obsync is reconciling the same text. Delayed
upload receipts no longer put an older version back into the device's records.
Merges and editor uploads wait for one another's receipts before choosing
parents, including an upload that finishes while a merge is being prepared.
Adjacent line edits no longer need an unchanged line between them to merge.
Continued additions to neighboring lines remain independent after a shared
merge. A third device receiving both people's edits tracks their progress
separately, so it does not mistake their typing for a rewrite loop.
A freshly paired device no longer recreates resolved historical conflicts
when the server's file view has trimmed older parent links. Older feed entries
do not consume the loop limit, and one person can stop
typing while the other continues an independent edit. Repeated replies to
obsync's own output still reach the same limit. Identical merged versions
share their own content as the base for your next edits. This
prevents slow connections from splitting newly typed text into false conflict
copies. Same on desktop and mobile. (#135)

**A note that split in two while one device still ran 1.1.1 becomes one note
again.** When two devices started with the same notes and one still ran 1.1.1,
a few of them stayed tracked twice, once per device. Every edit made on the
1.1.1 device then reached the other one as a `(conflict from another device,
…)` copy while its own note kept the old text, and updating the older device
did not stop it. Now the first edit of such a note settles it: the device whose
note still holds the text that edit started from takes the edit into that note
and retires its own duplicate on the server, with no copy and nothing lost.
Edits made on a 1.1.1 device settle this way as soon as the other device runs
1.1.3, and edits from either side once both do; an edit made first on the newer
device while the other still runs 1.1.1 meets 1.1.1's own rule, which keeps
the older device's previous text beside the note once. A note that already has
such a copy stays as it is: delete the note that kept the old text and rename
the copy to its name. Same on desktop and mobile; each settlement writes one
`decision=converged reason=edited_twin` line (#147).

**Two notes that trade names show the same names on every device.** Swapping
two notes' names in one go (Draft becomes Final and Final becomes Draft), or
renaming a note to a name another computer had just used while it was closed,
left that other computer showing the notes under the opposite names for good:
"Draft" on one was "Final" on the other, its next edit could undo the rename,
and both status bars showed "Server repair could not verify a retained file …
check connectivity". Now a note that arrives while its name is still taken
waits beside it and moves to its name as soon as the name is free: when the
other note's own rename arrives, and otherwise at the next scan, within 30
seconds -- when you free the name yourself, or when the swap also changed a
note's text. The move is a rename, never a write over anything, and a note
holding changes not sent yet is not moved. Two different notes that
want one name are settled the same way on both computers: one keeps the name
and the other takes the same conflict name on both. A phone, which cannot move
its own note aside, still keeps the two under different names until one of
them is renamed or deleted, and then they agree. (#149)

**A note that plugins keep rewriting after sync pauses on every updated
device instead of filling the vault with copies.** The pause survives a
restart, leaves local text untouched, and gives one notice with a way to
resume. Two people typing in open editors still sync normally. Stop the
plugin rewriting synced notes, then use **Sync now** or **Resume** in **Show
sync status** on the held devices: local typing is retained, and the
background rewrite is kept beside the note. **Sync now** also compares
content even when a plugin preserved both the note's size and modification
time. The merge-breaker notice no longer blames out-of-date devices. The
shared pause requires 1.1.3 on every device; older plugins safely skip its
encrypted control record and keep syncing. Same behavior on desktop and
mobile. (#179)

**A folder of a synced vault, opened as a vault of its own, no longer copies
the vault into itself.** Opening a folder such as `Sub` as its own vault and
pairing it with the same server filled every device, within seconds, with
`Sub/Sub/Sub/…` 98 levels deep, and nothing said a word. Now a vault that sits
inside a vault with obsync installed refuses to be set up, paired (by code or
by link) or started, before anything is sent: "This folder is inside the synced
vault … Open the outer vault instead, or use Selected folders there." A vault
paired before this release stops the same way, with one notice. The outer
vault, for its part, sends nothing from a folder that holds its own
`.obsidian/plugins/obsync-private-sync`, and writes, moves or removes nothing
in it; one notice names the folder. That stops the loop whichever vault was
paired first, on whichever computer. The notes in that folder stay as they
are; to sync them from the outer vault again, uninstall obsync in the inner
one. On a phone the outer vault's side works the same, while the inner vault's
check looks outside its own folder, which only a computer can do. (#180)

**Recover an account without a syncing device.** Setup now registers a
vault-key verifier; existing paired devices register it when both server and
plugin are updated. The server's setup token plus this vault's retained key or
24-word phrase can then enroll a replacement, even after the last device
leaves. Wrong words or a token alone cannot enroll. A device forgotten by a
rebuilt server now says so, stops retrying authentication, and exposes
**Setup or recover** without an uninstall. Local notes and the vault key stay.
Switching offers setup for an empty server or pairing with an existing vault;
the last device can leave normally once recovery is registered. Legacy
accounts that lost every credential before registration still cannot use this
route; the error and recovery guide say why. (#142)

**One server holds one vault, and nothing swaps a vault's key or a device's
identity without asking.** Pressing **Create a new vault key**, or restoring
another vault's 24 words, on one computer used to stop every other computer
from receiving anything, for good, under "offline — retrying"; pairing a second
vault from the first merged both vaults on every device without a word; and
**Pair this device**, or a pairing link, on a computer that already synced
replaced its identity, so its sync stopped and a stray device appeared. Now a
computer that meets changes it cannot read skips them, keeps receiving
everything else, and names the device to fix. **Create a new vault key** on a
server that holds a vault asks first, with Cancel as the default, and a phrase
that opens nothing there is refused before it replaces the key. A device joining
a vault asks before its first sync uploads notes that vault does not have (a
copy of the same vault still pairs without a question). The approving device
also shows the new device's vault name and Markdown note count. Those details
are sealed under the pairing code's secret: the server stores only bounded
ciphertext, and malformed details cannot offer an approval button. An older
server omits the details and keeps the existing device-only prompt. **Set up or recover** on a server that already holds a vault requires its
registered vault-key proof as well as the setup token; a different vault
cannot silently replace it. On a computer that syncs, **Pair this device** and pairing links claim
nothing and say to leave the server first, and leaving now works for a device
that was revoked or that the server no longer recognises. Same on desktop and
mobile. (#140, #141, #143)

**A plain `http` server address is refused on desktops too.** A desktop used to
accept an address starting `http://` and, in front of a server that redirects to
HTTPS, it even worked -- after sending the setup token and every request across
your network unencrypted first. Now the address must start `https://`, as on a
phone. The one exception is this computer itself (`localhost` or `127.0.0.1`),
the one-computer trial the README describes, where nothing crosses a network.
If a desktop of yours was set up with a plain `http://` address, change it to the
`https://` one, and rotate the recovery token as
[the dashboard's security notes](docs/security/dashboard.md) describe: it may
have crossed your network in the clear. (#136)

**A vault on a USB stick or memory card receives changes again, and a stopped
download leaves nothing behind.** On a drive formatted FAT32 or exFAT, a
computer refused every note another device sent, each time with a notice naming
`temp_identity`, left a file named like `note.md.obsync-1a2b3c4d5e6f.tmp`
beside the note, and then sent that file to your other devices. Quitting
Obsidian in the middle of a large download left the same kind of half-file,
which also reached every device. Now those drives receive notes like any other,
a download is written under a hidden name that is never synced, and a leftover
from a quit is removed the next time Obsidian starts. On such a drive a second
save of the same length made within two seconds of the first is also sent now;
before, it stayed on that computer until the next edit. Files like these that
1.1.2 already left or sent are ordinary synced files now, on every device, and
can be deleted by hand. Phones and tablets never wrote them. (#175, #159)

**One file this device cannot write no longer stops everything else from
arriving.** A note locked in Finder, a read-only folder, a full disk, or a file
whose data the server had lost while every device holding it was closed used to
stop this device from receiving any later change -- edits, new notes and
deletions, in every folder -- while the status bar read `offline — retrying` or
`idle` and nothing named the file. A full disk also downloaded the same file
again every few seconds: 5.5 GB in nine minutes for one 100 MiB attachment. Now
that one file waits and everything else keeps arriving. The status bar and
**Show sync status** name it and say why, for example `Cannot write
Notes/n17.md here: the file is locked`, and one notice says so once. It is
tried again by itself, first after a minute and then less and less often, up to
every half hour, and at once when Obsidian starts or when you run **Sync now**
after fixing the cause. It is remembered across restarts. If another device
changes the file in the meantime, the latest version is what arrives; if it
deletes it, the file is dropped and never downloaded again. On phones and
tablets a file whose data the server lost is handled the same way, but a write
the phone's own storage refuses still holds up later changes as before. (#144)

**Folder selection and download limits check what you type.** Under
**Selected folders**, a folder the vault does not have, or an empty list, was
saved with a plain "saved" while the status bar read `idle` and nothing synced.
On a Mac, a folder typed in the wrong case (`notes` for `Notes`) stopped sync
for that folder. A minute later that computer sent the folder's notes out again
as new files carrying its older text, so the other computer's newer edit ended
up in a conflict copy, followed by a lasting repair error. Now a folder the
vault does not have is asked about first, with Cancel as the default. A folder
typed in the wrong case is saved the way the vault spells it, and a notice says
so. An empty selection says that nothing will sync, and the status bar reads
`idle — syncing no folders`. A hidden folder is refused in plain words. A
computer never sends out a folder under a spelling the vault does not use. A
selection that 1.1.2 already saved in the wrong case syncs nothing from that
folder until you save it again. **Largest file to download** and **Total to
keep on this device** now accept `1 MB` and `2 GB` as well as `1 MiB`. A value
they cannot read is refused with a notice that lists the accepted forms.
Before, it stayed on screen unsaved and read "unlimited" after a restart.
Saving a folder selection no longer shows "Waiting for transfers…" for up to a
minute when nothing is transferring. Same on desktop and mobile, except that
only a computer ever sent a folder out under the wrong spelling. (#150)

**The server address takes what you paste, and says what to fix.** An address
copied from a browser -- `…/readyz`, or a dashboard sign-in link with its token --
is stored as the server's address alone, lower-cased, instead of failing every
request with "404 no route" and keeping a sign-in token in your settings. A
missing or wrong port now says that nothing answers at that address and port,
and that nothing was sent, instead of "cannot say whether it happened".
**Check** answers before setup too: it asks the server without a credential
instead of saying "not paired". A refused address is announced once, not once
per keystroke. (#137)

**Pressing Enter in a confirmation no longer does the thing it asks about.**
In obsync's confirmation dialogs -- revoking a device, and new in this release,
creating a new vault key, pairing a vault that holds notes the server's vault
lacks, and saving a folder the vault does not have -- the action was the button
Obsidian gave the focus to, so pressing Enter revoked the device or replaced
the key instead of cancelling. Cancel is now the first button and holds the
focus; the action takes a click or a tap. Same on desktop and mobile.

## 1.1.2 - 2026-09-23

**An old deleted twin cannot erase a newer note.** When catching up on history,
obsync checks that an identical note is still the server's current version
before retiring this device's independent copy. An edit arriving during that
check stays on its own identity. If a newer local identity arrives while that
check is waiting, it is kept too: the final identity check and replacement
now happen together, with no wait between them. The keeper's identity is saved before the
old identity is retired, so restarting preserves that decision. A full server
encountered during automatic chunk repair remains a visible error instead of
being reported as offline. (#131, #129)

**Sync resumes by itself when the server becomes reachable again.** Until now a
device that opened Obsidian while its server could not be reached -- a laptop
waking before Wi-Fi, a phone away from the home network, a server restarting --
stopped with `obsync: error` and stayed stopped until someone ran **Sync now**.
It now keeps trying on its own: 5 s after the failed start, doubling to every
5 minutes, for as long as Obsidian is open, and at once when the device reports
its network back. The status bar and the settings **Connection** row say
`obsync: offline — retrying` while it waits, and go back to `idle` the moment a
start gets through. Nothing needs pressing when you return; **Sync now** only
makes the next attempt happen now.

**The status bar says so from the first request that gets no answer.** A
device that could not reach its server used to read `obsync: idle` for about a
minute and a half, the time the plugin spends retrying one request, before
`offline — retrying` appeared; measured on real devices in the 2026-09-23 run.
It now switches at the first unanswered request and goes back to what it said
before at the next answered one. An error that needs you is never covered, and
a device that is not paired still reads `not paired`. The background repair
check no longer mistakes a missing server for damage either: while offline it
used to flash `error — Server repair could not verify…`, sending people to look
for a problem that was only the network; it now waits for the next check.

**Obsidian opens at once when the server cannot be reached.** Opening Obsidian
away from a server it could not reach held the whole app on "Loading plugins…"
for as long as the plugin kept trying to connect -- over three minutes on an
iPhone and 88 to 119 seconds on desktops in the 2026-09-24 run -- with
"Reload app in Restricted Mode", which turns every community plugin off, as the
highlighted way out. The plugin no longer makes Obsidian wait for the server:
the app opens, the status bar reads `offline — retrying`, and sync starts when
the server answers.

**Restarting Obsidian no longer deletes empty folders on your other devices.**
The plugin could start its first sync while Obsidian was still listing the
vault, compare against that empty listing, and conclude that everything was
gone: every empty folder was then deleted on your other devices (into their
trash), and every note was listed under **Deletions held back** with a
**Confirm** that would have deleted it everywhere. Notes were only saved by the
checks that hold back a mass deletion. This happened on 1.1.1 too, on some
restarts and not others, more often in bigger vaults. The first sync now waits
until Obsidian has finished listing the vault.

**The sync status window reads on a phone.** A long **State** line, such as an
error, squeezed the labels beside it to one letter per line; labels now break
only between words.

**A refusal at start is still a stop.** When Obsidian starts, a revoked or
unapproved device, a signature the server rejects, a clock too far off, a server
that has run out of space, or a vault key that does not open the vault's records
still show `obsync: error — <reason>` and are never retried by a timer: those
need you, and knocking again would not change the answer. The plugin tells the
two apart by what the server said, not by the wording of a message. A device
that is already running when one of these refusals arrives still reads
`offline — retrying` in this release; that is #155.

**Same on every platform.** Desktop and mobile use the same timer and the same
`online` event. On a phone, a pause that runs out while Obsidian is in the
background fires when the app returns to the foreground.

Each scheduled retry, each retry run, each resume and each stop writes one line
to the developer console (`engine decision=retry_scheduled ...`,
`decision=retrying`, `decision=resumed`, `decision=stopped reason=start_failed`),
so a device that is not syncing says why.

**Two devices that start with the same notes keep one of each.** A vault copied
to a second device by hand, or moved over from another sync tool, no longer
turns every note into a conflict copy of identical content at first sync. A note
whose bytes are the same on both devices, at the same name, settles on one file
with no copy, whatever order the two devices publish and pull in; a note that
differs by even one character is still kept twice, as a conflict copy
([Conflicts](docs/conflicts.md)). The comparison reads nothing and downloads
nothing: identical notes already share chunk ids. The files on disk are never
written, moved or deleted to settle the pair -- the duplicate is retired on the
server. A device older than 1.1.2 still copies identical content, so update
every device; the copy it makes can simply be deleted. Each settlement writes
one `decision=converged` line naming the id that kept the name and the id
retired (#131).

**Same network, step by step.** A new guide,
[Same network, step by step](docs/same-network.md), shows every screen of the
most common setup: one computer at home runs the server and the phone syncs
over the same Wi-Fi, with no tunnel, VPN or domain. It covers the computer's
firewall, and the iPhone certificate install screen by screen, which the old
one-line instruction got wrong: an AirDropped certificate lands in Files and
is installed from Settings, General, VPN & Device Management. It is the path
recorded in the [2026-09-23 run](docs/validation-runs/2026-09-23.md).

## 1.1.1 - 2026-09-23

**The setup guide is one press away, and it says which setups are proven.**

### Added

- **Setup guide**, the first row of the plugin's settings on every platform, and the
  command **Open the setup guide** open the project's guide in your browser. The
  address ships with the plugin and the plugin itself sends nothing there;
  Obsidian's help link for the plugin now opens the same page.
- [Choose your setup](docs/setup.md): every way to run and reach the server, what
  each needs, and whether CI or a recorded validation run proves it.

### Changed

- The README opens with the setup guide.

## 1.1.0 - 2026-09-22

**Folders sync now -- an empty one reaches your other devices, and a deleted
one leaves them. That is a new kind of record, so a device still on 1.0.x
refuses each folder with one notice and goes on syncing its notes. Update
every device that syncs the vault, and read "Two folders that differ only in
capitalisation" below if one of your devices shows two.**

This release also carries everything the 1.0.7 work fixed, which had not been
released on its own; those entries are further down, under "Also in this
release", unchanged except where 1.1.0 changed them.

### Folders

**An empty folder now reaches your other devices, and a deleted folder leaves
them.** Until now a folder existed on a device only because a note inside it
did: two empty folders made on a computer never appeared on a phone at all,
and deleting a folder removed its notes everywhere but left the empty tree
standing in every other device's file explorer. Folders are now synced in
their own right -- created, deleted and renamed, in both directions. The
server still cannot read any of it: a folder is stored the same way a note
is, as something only your devices can open.

**A folder is only ever removed when it is empty on that device**, and empty
means empty to the filesystem: a hidden file, a note you do not sync, or
another plugin's data all keep it, and no file is ever taken to make a folder
go. A folder obsync has a record for is removed only by its own deletion
arriving, so an empty folder you keep on purpose does not vanish when its last
note is deleted somewhere else.

**What a device still on 1.0.x does.** It does not know this kind of record,
so it refuses each one: one notice per folder, no file written, nothing
deleted, and its notes keep syncing throughout. On 1.0.6, the newest 1.0.x,
that notice reads "obsync refused a change from another device: it does not
name a plain file inside this vault (version). Nothing was written. File id
..." -- those are the words to search for if you see it. It stops as soon as
that device is updated. This was proved against the decoder shipped in 1.0.0
through 1.0.6, copied into the test suite from the released tag rather than
described; the function that does the refusing, `parseManifest`, is
byte-identical at all seven of those tags -- sha256
`8aa8a2df240bcd8ffba197fc9b2e238bb9b727ef0416007eb526a3082e8aa4de` of it at
each, which `plugin/test/fixtures/decoder-1.0.x.mjs` says how to re-derive.

**Two folders that differ only in capitalisation.** A folder renamed by
capitalisation alone -- `Team docs` to `team docs` -- was published as NEW
notes by versions before 1.1.0, because the computer that made the rename sees
one folder where a phone sees two. Devices that tell the two apart received
the new names and were never told to retire the old ones, so they ended up
showing both: one live folder and one that never changes again. From 1.1.0
such a rename is published as the rename it is, and the device receiving it
renames the folder itself.

**Be precise about what renames it, because that is what decides whether two
devices ever agree.** On a computer, `Team docs` and `team docs` are ONE
folder on the disk, and renaming a note inside it cannot change how the folder
itself is spelled -- the operating system finds the folder by either spelling
and leaves the name it keeps alone. So the folder's own record is what
re-cases it, and obsync publishes that record BEFORE the notes underneath
move. A device receiving it renames the directory, carries every note under it
with the rename, downloads nothing, and publishes nothing back. Before this
release the receiving device took the new spelling into its records while its
disk kept the old one; its next scan read that difference as a rename and
published it back, the other device did the same in reverse, and the two
traded one rename every thirty seconds, re-downloading every note under the
folder each time, for as long as both ran. If you saw a folder's notes gaining
versions endlessly, that was this.

**This works when the folder you renamed is the only one that device syncs,
and on the devices whose filesystem folds capitalisation.** If you chose
folders under "Sync folders on this device", the folder you selected is
published in its own right, so re-capitalising it reaches your other devices
as the one rename it is. That one shape -- the renamed folder IS the selected
folder, which is the usual shape on a phone -- was the one this release nearly
shipped broken: the rename went out as note moves with no folder record behind
them, every device that folds case refused them and told you to update a
device that was already up to date, and every later edit you made in that
folder was refused there too. A device RECEIVING such a rename for the folder
it syncs follows it -- on a Mac, on Windows, on an iPhone, where the two
spellings are one folder on the disk: it keeps syncing under the new
capitalisation and you do not have to select it again. On Linux and on
Android they are TWO folders, so that device does not follow the rename: it
keeps your folder under the old spelling and quietly stops receiving what you
put in it elsewhere, until you rename it there to match. Nothing is lost
either way, and Troubleshooting says how to settle it.

**And a folder that only LOOKS like that rename is left alone, with a
notice.** A device that keeps `Team docs` and `team docs` apart can hold both
-- which is exactly what a capitalisation-only rename made before this release
leaves behind -- and by the name alone, a device syncing just one of them
cannot tell that second folder from a rename of the one it syncs. obsync
follows such a folder only where it really is that rename, which is where the
other device retired the old name first; otherwise it leaves your folder and
your selection where they are, keeps syncing what you chose, and tells you
once, naming both spellings. Following it would have moved that device onto
the folder you did not choose: what the other device put in yours would have
stopped arriving, and your own edits would have come back there as conflict
copies.

**An empty folder re-capitalised while Obsidian was closed no longer
disappears.** obsync finds that rename when it next starts, and it used to
announce the new folder before announcing that the old one was gone -- so a
device that folds case renamed the folder and then obeyed the removal, which
on such a device names the very folder it had just renamed. Nothing was inside
it to keep it, so it was deleted there, and then here. The two records now go
out in the order the rename happened in, and no device removes a folder its
own vault spells differently from the record asking for it.

**If the server refuses the folder record, obsync says so.** The notes under a
folder being re-capitalised wait for that record, because no device can apply
them without it. obsync attempts the record three times; if all three fail it
tells you once, sends the notes anyway -- where the other device refuses them
and says why -- and publishes the folder again the next time it starts.
Nothing is lost and nothing is deleted while that is true.

**If the rename comes from a device still on 1.0.x**, there is no folder
record to send, so the notes arrive asking for a folder spelled a way this
device does not show. obsync refuses those moves rather than guessing: the
notes you already have stay exactly where they are -- nothing of yours is
written over, moved or deleted -- and you are told once per folder. A note
CREATED on the other device meanwhile is not a move and is not refused: it is
written here, in the folder this device shows, and the difference in spelling
is not published back. Update the other device, or rename the folder here to
match, and both devices agree again -- including the edits made there while
the two disagreed, which the folder record brings down with it as it settles
the spelling. Not letting one note's version rename a folder full of other
people's notes is what makes the refusal the safe answer meanwhile.

If a device of yours already shows both, there is a recovery, and its order
matters: **do not delete the stale folder first.** On a device that folds case
the old spelling IS the live note's own entry, so a deletion of it published
from elsewhere can take the notes you are keeping. Update every device, open
each one and let it sync once -- a device that folds case will quietly drop
the records naming the old spelling and tell you so once -- and only then
delete the stale folder, on the device that shows two. The full steps are
under "Two folders that differ only in capitalisation" in the troubleshooting
guide. The last step is yours on purpose: no device can prove the others have
been updated, and a rename leaves a note's size and date exactly as they were,
so nothing later can tell the abandoned copy from the live one.

**An empty folder left under an old spelling can stay or go as you like.**
Nothing in this version deletes a folder that holds anything.

### Notes, and the ways they were lost

**A note another device renames is renamed here too, instead of being
re-downloaded and thrown away.** Applying a rename used to write the note
under its new name and send the old name to the system trash -- so every
rename made on one device left a full copy of that note in every other
device's trash, which on a phone is somewhere you can barely reach. It is now
one rename: nothing is downloaded, nothing is trashed, and the note keeps its
identity. That is true of a rename that changes only capitalisation as well --
it used to rename the entry and then fetch and rewrite the whole note anyway,
which on a phone was the note's full size in data for a change of name. A
rename arriving over a note you have changed here and not yet uploaded is
still kept as two notes, exactly as before.

**obsync no longer tells your other devices to delete everything when it
loses sight of a folder.** If a folder you sync is renamed or moved from
outside Obsidian while Obsidian is closed, obsync sees every note it tracks
vanish at once. It used to publish a deletion for each of them, and every
other device obeyed -- while the notes themselves sat safely on the renaming
device under the new name. obsync now stops, publishes nothing, and tells you
what it found: that it can no longer see most of what it syncs here and that
nothing has been sent. Put the folder back, or select it under its new name,
and it picks up where it was. If you really did delete them, confirm it under
Settings → obsync → "Deletions held back" and they are published then. A small
deletion is untouched by any of this: the hold only happens when more than
half of everything obsync tracks here disappears in one go.

**A note that is still being copied into the vault is no longer published
half-written.** A large file arriving from a file manager or a download used
to be uploaded while it was still growing, so other devices received a
truncated copy -- a 916 MB file arrived as 376 MB. obsync now waits for the
file to hold still, and abandons an upload whose file changed under it rather
than publishing a version of something that is not finished.

**A note moved in from outside Obsidian converges in seconds rather than
minutes, and as a move.** obsync now compares the vault against its own record
every thirty seconds, reading the filesystem itself on a computer instead of
Obsidian's index. A note that vanished from one place and appeared in another
with the same size and date is recognised as the move it is, so your other
devices move their copy instead of deleting one note and downloading another.
That pass never publishes a deletion: it can only add work.

**A note another device deleted after you changed it comes back by itself.**
Keeping your text was already the rule; obsync now also publishes it again
straight away, so the note returns on every device rather than waiting for the
next time you touch it. If that upload cannot go out -- you are offline, or
the note is still being written -- you are told the weaker thing that is true
and the next sync carries it.

**A note whose name differs only in how an accent is stored is no longer
treated as a move.** On a Mac a folder can report `é` one way and Obsidian
another; obsync used to see that as a rename to the other spelling, and the
device applying it would write one and delete the other -- the same file on
most disks, so the note disappeared. It is recognised as one name now.

### Restoring, and getting set up

**Restore from history opens on the newest versions and has a search box.**
It used to page backwards from the oldest, which for a note with a long
history meant a lot of clicking to reach yesterday.

**A repair running in the background no longer interrupts a restore.** The two
used to collide and raise "Server repair could not verify a retained file" --
a message about connectivity, during a recovery, for a scheduling overlap. The
background work yields instead.

**The server can print its own setup token.** `obsyncd setup-token` runs the
image's own binary, so it works where copying a file out of the container does
not -- which is every Kubernetes deployment. The container still has no shell.

**A device can leave its server, or move to another one, without starting a
new vault.** Settings → obsync → This device → "Leave this server" or "Switch
server": the device is revoked where it can be, the server address and the
records go, and your vault key stays, so pairing again is the same vault
rather than a new one.

**The update notice names the plugin and opens the page that installs it.** It
also says which version you have and which the server has, and appears once
per session rather than on every check.

### The documents, and the mark

The documentation is a site now, built from the same files in the repository
and readable without it, and the guides in it are run by CI rather than copied
beside a script that drifts. The README is a short front door; the long pages
live under `docs/`, and the README and the Cloudflare guide exist in twenty
languages besides English. A new page, "Purging a server", covers wiping a
server's storage and re-pairing every device, which is the one operation with
no button and no way back. The plugin has a mark of its own, rendered from a
source file in `brand/` by one command.

**Which version you have.** The latest release is the newest tag on the
Releases page, and that is what Obsidian installs and updates to. `main` is
the edge: merged but unreleased work, for people building from source. There
is no beta channel and no pre-release tag.

### Known limitations in this release

- **A device offline exactly when two notes collide can keep the pair under
  different names** until its note is uploaded and edited again
  ([issue #122](https://github.com/snaraj/obsync/issues/122)). Both notes are
  on both devices throughout; only the names differ, and renaming either one
  yourself settles it.
- **Phones and tablets still settle no same-name pair themselves**, for the
  reason given under "On phones and tablets, obsync renames nothing at all"
  below. The computer publishes the rename and the phone follows it.
- **A save landing in one particular instant can still be lost**, described
  under "The one gap left, said plainly" below. Nothing about it changed here.
- **Folder support has not been driven on a real device yet, of any kind.**
  What exists is the test suite, including tests that drive the plugin's own
  desktop code against a real temporary folder on a real case-folding
  filesystem. The device pass in `docs/validation.md` -- macOS, Linux, a
  phone, and the Windows scenario -- is recorded as not attempted rather than
  claimed, and `docs/validation-runs/` holds no run of it.
- **A folder renamed by capitalisation alone on a phone is not proved.** The
  rename goes through Obsidian's own adapter there rather than through the
  filesystem, and only the device pass can say what that adapter does with a
  spelling it already holds. Until then the phone is covered by the same
  refusal as any other unprovable rename: it changes nothing and says so.
- **A device still on 1.0.x that renames a folder by capitalisation alone
  does not converge with this one** until it is updated, or until the folder
  is renamed here to match, as described under "Two folders that differ only
  in capitalisation". Nothing is lost on either side; the two simply spell the
  folder differently meanwhile, and the notes edited there arrive when the
  spelling is settled rather than while it is not.
- **Two devices renaming ONE folder to two different capitalisations at the
  same time end with copies of the notes under it on both**, the way two
  devices renaming one folder to two different NAMES at the same time already
  did, and more of them. Nothing is lost and nothing keeps changing: rename
  the folder on one device, let every device sync once, and delete the copies
  you do not want.
- **A note roughly 8 MB or larger is still not recognised as one the server
  already holds**, so on a restored vault it is copied beside itself rather
  than adopted -- a duplicate, never a missing note.

### Also in this release

The 1.0.7 work, which never shipped on its own. Everything below is as it was
written for that release, and the sentences 1.1.0 changed have been changed.

**Two notes, one name, settled once.** When two devices each made a note under
the same name while one of them was closed, 1.0.5 and 1.0.6 kept both -- which
is right -- and then left both of them wearing the one name, so every later
edit of either note arrived at a name that was taken and wrote another
`(conflict from ...)` copy. On real devices that was three copies of one note
within a few minutes, on both devices at once. Now the pair is told apart once
and for all: each note has an identity of its own, the note whose identity
sorts first keeps the name, and the device holding the other one renames its
note to the `(conflict from ...)` name and publishes that rename like any other
rename you would make yourself. Both devices work it out from the same two
identities, without asking each other, so both end up with the same two names
-- and from then on each note updates in place, wherever it is edited, instead
of being copied again.

**The exception, and it is a real one.** Working it out needs both identities,
and a note a device has never managed to upload has none. If a device is
offline exactly when it meets the collision, and its note would have sorted
second, that device can keep the pair under different names from the other
device's until its note is uploaded and edited again
([issue #122](https://github.com/snaraj/obsync/issues/122)). The same is true
of a phone or tablet whichever way the pair sorts, for the reason below. Both notes exist
on both devices the whole time; only the names differ, and renaming either one
yourself settles it. A note roughly 8 MB or larger is also never recognised as
one the server already holds (below), so on a restored vault it is copied
beside itself rather than adopted -- a duplicate, never a missing note.

**What you will see when you update.** On one of the two devices, the note that
device made changes name once, to the `(conflict from ...)` name, and obsync
tells you it has done it. Nothing is written over: both notes keep their text,
and both end up on both devices -- under the same two names, with the
exception above. Rename either of them afterwards as you would any note -- the
copy name is a starting point, not a fixture. If you already renamed one of the
pair yourself, there is no longer a collision and nothing here applies to it.

**If you are typing in that note at the moment it happens.** The note is left
exactly where it is, with the text you just typed, and obsync says so instead
of renaming it; the other device's note is kept beside it under a name of its
own, the way 1.0.6 kept it. That holds whether your editor saves into the note
or replaces it, and at every step of the rename -- because obsync never aims a
deletion at the name you are typing into. It moves the note aside first, to a
hidden name of its own; checks that what moved is the copy it made, and puts
it straight back if it is not; and only then clears that copy away, by the
hidden name. A note your editor recreates under the old name while this is
going on is kept as it is, and the pair is settled by keeping both instead.

**The one gap left, said plainly.** A save that lands in the instant between
obsync copying your note and moving it aside, AND leaves both the note's size
and its modification time (which the disk keeps to the second) exactly as they
were, cannot be told apart from no save at all -- so that text can be lost.
Every other moment is covered, including a save made through a file your
editor still has open while obsync is finishing: those bytes are read back
and kept under a name of their own. One more detail worth knowing: the copy
obsync clears away is deleted outright rather than sent to whatever your
"Deleted files" setting points at, because by then its text has already been
written beside it under the new name.

**And the same gap, for a note another device deleted.** obsync checks the
note against what it last uploaded before applying someone else's deletion,
and on a computer it also holds the note across the deletion itself. A phone,
and a few unusual disks and network drives, cannot hold it: there, a save
made in the instant between that check and the deletion is not caught.
Deleting the note anyway is the deliberate choice -- a deletion that is
refused on those devices would never be delivered again, and the note would
come back for everyone.

**On phones and tablets, obsync renames nothing at all.** Settling the pair
means moving one note aside, and moving a note means removing the old copy
once the new one is written. A computer can keep hold of that copy across the
removal and put it back if you typed into it at that moment; a phone cannot,
and neither can a few unusual disks and network drives on computers. Rather
than remove a note it could not give back, obsync keeps both notes on those
devices -- exactly as 1.0.6 did -- and lets the device that CAN do it safely
publish the rename. **What that costs is a name:** until then, that pair can
sit under different names on your phone than on your computer. Both notes are
on both devices the whole time, no text is ever lost, and renaming either one
yourself settles it everywhere. A note larger than that device's per-file
limit (512 MB unless you changed it) is left alone for the same reason.

**Two smaller things behind that.**

- A note a device has never uploaded is now uploaded before obsync decides
  anything about a name it shares. Without that, the device that had not
  uploaded its note yet could not tell the two apart at all, and the two
  devices would settle on different names and stay there -- each keeping its
  own note under the name and the other device's beside it.
- A note that is already exactly the version the server holds is now recognised
  as that version rather than copied beside itself. That is what a device meets
  after its vault folder is restored or replaced, where 1.0.6 would have made a
  conflict copy of every note in it. Recognising it means proving it, byte for
  byte, against the digest the version carries -- so it covers notes up to
  roughly 8 MB, which carry one, and not larger ones, which do not. A larger
  note is copied beside itself as before.

**Update every device that syncs the vault.** A device still on 1.0.x does not
know the rule, and for any pair it has not yet settled it goes on making copies
the way 1.0.6 did. In the case reproduced here -- two devices, one note each
under one name -- both notes survived on both devices and no note content was
lost.

### And the smaller fixes from the same work

**A note another device deleted is no longer deleted here if you have changed
it since.** Two devices can disagree about a note: one deleted it, the other
typed into it. obsync now keeps both sides of that disagreement, the way it
already did for two edits. A deletion arriving for a note whose text differs
from the last version this device uploaded is not applied: the note stays,
and your next sync uploads it again, so it comes back everywhere. That
matters most when you add a folder to the ones this device syncs: obsync then
replays everything that happened while the folder was out, including
deletions from years back, against notes you may have written in the
meantime. In the case reproduced here -- a note deleted on the phone and
edited on the computer while the computer was not syncing that folder -- the
edit was previously lost on both devices; it now survives on both.

**A note moved out of the synced folders while it was still uploading no
longer disappears from your other devices.** If you moved a note out of the
folders this device syncs at the moment obsync was uploading it, the finished
upload made this device start tracking the old location again, and the next
check decided the note had been deleted -- so it was removed from your other
devices, even though the file was sitting safely in its new folder here.
obsync now finishes such an upload without claiming to track a path it no
longer syncs. The version it uploaded stays published, so your other devices
keep the note and its latest text.

**A note you have just written is no longer left behind when you rename its
folder.** Renaming a synced folder carried every note obsync already knew
about, but a note created seconds earlier -- still waiting for obsync to pick
it up -- was left pointing at the old folder name and then ignored. It stayed
on that one device until something else prompted a full check. It now moves
with the folder like everything else in it.

**Two devices that edit one note to the same text no longer lose a rename.**
If one device renamed a note and edited it, and another device made the same
edit without renaming, the server could answer the second device with the
first one's version -- they look identical to a server that cannot read your
notes -- and the rename was then treated as something this device had already
done. The two devices kept two different names for one note with nothing left
to settle it. obsync now checks that the version it is offered really
describes what it just uploaded, and uploads its own version if it does not.

**A note obsync puts back is never written over a note you just saved.**
When obsync has to return a note it moved aside -- because you typed into it
at that moment -- it used to check that the name was free and then write
there, which is a gap another save can slip into. It now uses an operation
that cannot replace anything: if the name has been taken in the meantime, the
note is kept beside it under a numbered "(obsync kept)" name instead, and
both texts survive. And the copy obsync holds during a removal is released
only once its text is safely somewhere else -- including text an editor
writes through a file it still has open at the moment obsync is finishing.

**A note that arrives while obsync is checking the vault is no longer deleted
everywhere.** When obsync starts, and whenever you change which folders it
syncs, it lists the vault and compares that list against what it remembers --
which is how a note you deleted while Obsidian was closed reaches your other
devices. A note arriving from another device in the middle of that check was
in the record and not in the list, so obsync published it as a deletion and
removed a note that was sitting on the disk from every device. It now asks the
vault once more, at the moment it would publish the deletion, and a note that
is there is published as the note it is instead. This was found by this
release's own gate, on a machine slow enough to lose that race.

**A selected folder you rename keeps syncing, and renaming one no longer
deletes its notes elsewhere.** If you sync only some folders and then renamed
or moved one of them in Obsidian, the notes inside it left the selection the
moment they moved, and obsync published a deletion for every one of them: the
folder emptied on your other devices. Now the selection follows the folder --
rename `Work` to `Job` and `Job` is what is synced, without touching the
settings -- and a file that leaves the selection is dropped from syncing
instead of being published as a deletion, which is never done for a file that
is still there. The 1.0.7 notes said one case was not fixed -- a selected
folder renamed while Obsidian is CLOSED, which nothing is awake to see -- and
told you to rename selected folders with Obsidian open. **That case is
handled in this release**, further up: obsync still cannot see the move, but
it no longer believes the notes are gone. It stops, publishes nothing and
tells you what it found ([issue #123](https://github.com/snaraj/obsync/issues/123)).

**Adding a folder to your selection now brings its history down.** Widening
the selection used to leave the newly included folder empty on that device
until something changed inside it, because the device only ever asked for what
had happened since it last looked. A device that widens its selection now
replays the history it skipped, so the folder arrives.

**"Sync now" waits for the sync it asked for.** When a sync was already
running, the command returned immediately and reported done with your queue
still full. It now returns only once the queue it was asked to flush is empty,
including anything that arrived while it was working.

**A killed upload re-sends far less.** Quitting Obsidian mid-upload made the
next run re-send whole chunks it had already delivered; that re-sent volume is
now bounded. Three things to know: fewer bodies are in flight at once on
desktop, which can make a single very large first upload marginally slower; the
retry budget is measured against this release's own runs and NOT claimed as a
device-acceptance result; and a maximal chunk can still exceed the target by up
to 16 bytes, which is the authentication tag.

**Rejecting a pairing that was already approved no longer removes the device.**
On the pairing screen, a reject that arrived after the approval deleted a
device that was by then paired and syncing. That reject is now refused and
changes nothing; to remove a paired device, revoke it from the dashboard's
device list.

**Two devices that reach the same result stop making two versions of it.**
When two devices resolved one concurrent edit to exactly the same text, each
stored its own version of that result, which left the note looking forked until
another merge closed it. The server now recognises a version it already holds
at that position and answers with it, so both devices end up on ONE version.
This applies once BOTH the server and the device run 1.0.7: an older device
keeps the version it computed for itself, and is never answered with another
id. Renames are never treated this way -- what changed there is the name, which
the server cannot see -- so a rename always lands as a version of its own.

### A correction to what 1.0.3 promised

1.0.3 said "your vault, your devices and your pairing are untouched, and the
plugin does not change", which was broader than what had been established.
The plugin really did not change, and no note, key or pairing was touched.
Three behaviours a paired device can see DID change on purpose, and they are
the narrower guarantee that entry should have made
([issue #87](https://github.com/snaraj/obsync/issues/87)):

- Two devices revoking each other in the same instant no longer both succeed,
  so one of those two clicks now fails where before both went through.
- A request from a device that is pending or revoked is refused as that,
  before its signature is checked, rather than being classified by the shape
  of what it asked for.
- Sign-in links a device minted, and dashboard sessions opened from them, end
  when that device is revoked instead of outliving it by up to twelve hours.

## 1.0.6 - 2026-09-21

**Three things 1.0.5 got wrong, all found on real devices after it shipped, none
of them losing a note. Update every device that syncs the vault.** Two are
fixed here; the third is half fixed here and finished in 1.0.7, and this entry
says which is which.

**1. Editing the same note on two open devices could loop.** You would see a
stream of "obsync merged concurrent edits to ..." notices on both devices, one
a second or faster, and the note's version history growing without end. The
note's text was correct on both devices the whole time, and it never changed
again after the first pass. The cause: two devices combining the same pair of
versions produce the same text but two different version ids, so each saw the
other's result as something new to combine, forever. Now a device checks
whether the incoming version's content is the content it already has; if it is,
there is nothing to publish, both devices pick the same version to carry
forward by a rule they compute identically, and one of them publishes the
single entry that closes it. There is also a hard stop: more than five
resolutions of one note within a minute and the device stops combining that
note, keeps both versions side by side as it does for any conflict it cannot
merge, and tells you once. **Once both devices have 1.0.6, editing one note on
both settles in a single round.** When two devices did reach the same combined
text independently, one of them still publishes a single entry to close the
split -- that is deliberate, and it is one entry, not a stream. With more than
two devices editing at once, more than one of them can publish that closing
entry from the same starting point; in testing those settled too, without a
loop.

**2. Two notes created under one name kept making conflict copies — half fixed
here, finished in 1.0.7.** When two devices each created a note under the same
name while one was closed, 1.0.5 kept both, as it should, and then every later
edit wrote another `(conflict from ...)` copy on the other device. Part of that
was this: a copy already on disk was recognised by its size and timestamp
rather than by its content, so the same version could be copied twice under two
names, and a version could be announced as copied when it had not been written
at all. A copy is now recognised by its content, which a vault's own
bookkeeping cannot change, and that half is fixed in this release. One case
still makes a second copy on purpose: a note too large for obsync to carry a
single whole-file fingerprint -- roughly 8 MB and up -- cannot be compared that
way, so its copy takes the next free name rather than risk replacing something. The other
half is that the two notes still compete for the one name; giving them settled,
separate names on every device is planned for 1.0.7 and is not in this release.
**Until then: rename one of the two notes and the copies stop.**

**3. A hidden `.obsync-restore-<id>.tmp` file could be left in your vault.** On
desktop, after obsync wrote a conflict copy, the working file it used to write
that copy safely stayed behind next to the note. It is a plain copy of the
note's text, inside your vault folder, never uploaded, and Obsidian hides it.
Any left by 1.0.5 are safe to delete. 1.0.6 removes its own working file
whether the copy succeeds or fails.

**In every case seen, notes were safe.** In the loop as it was reproduced --
two devices, one note, one edit each -- every device ended up with the same
text, and no note content was lost in any of the three problems above. What the
loops filled was your server's history, and on a server with a storage limit
that could have used the limit up, which stops syncing for the whole vault
until space is freed. The extra history entries are ordinary versions and your
server's own retention removes them in time.

**Update every device that syncs the vault** — a single device left on 1.0.5
can still start a loop. If one is running right now, quit Obsidian on one of
the two devices: stopping one participant can allow outstanding work on the
other to drain. Update every device before resuming.

## 1.0.5 - 2026-09-21

**A note you wrote or edited while Obsidian was closed could be replaced by
another device's version when you opened it again. Update every device that
syncs this vault.** That is the whole release; nothing else changes.

**What happened.** In 1.0.0, 1.0.1, 1.0.2, 1.0.3 and 1.0.4, if you edited a
note while Obsidian was closed on one device, and the same note also changed on
another device in the meantime, opening Obsidian again replaced your version
with the other device's within a few seconds. Writing a NEW note while the app
was closed did the same when another device happened to create a different note
under that same name. No `(conflict from ...)` copy was written and nothing was
moved to the trash. A note that changed on only one device was never affected,
and a note you wrote while the app was closed with no counterpart on another
device was uploaded correctly.

**Content lost this way cannot be brought back.** This is not like 1.0.4's
deletions, where the note's content was still on the server and **Restore from
history** could return it. Here the replaced text had never left the device --
obsync had not uploaded it yet -- so the server never held it, and neither
**Restore from history** nor the dashboard nor your operator's backups can
produce something that was never sent. If Obsidian's own **File recovery**
(Settings, Core plugins) was on, its periodic snapshots of that note are the
one place left to look.

**What happens now.** When a version arrives from another device for a note
this device has changed and not yet uploaded, obsync keeps your file exactly as
it is, writes the other device's version beside it as
`<note> (conflict from <device>, <date>).md`, tells you it kept both, and then
uploads yours. Where the two sides only added lines in different places, they
are merged into one note, as concurrent edits always were. A conflict copy is
never written over something already at that name either, so a copy you have
opened and edited is kept and the new one takes the next free name.

obsync recognises a note you have changed by its **size and its modification
time**, compared with what it recorded when it last uploaded that note — the
same check it has always used at startup to decide what to upload. An edit that
leaves both of those exactly as they were is invisible to that check, on this
release and on every earlier one.

**Why every device.** The device that loses the edit is the one that was
closed, so updating one device protects only that device. Update them all.

**Known issues in this release, fixed in 1.0.6 and 1.0.7.** Editing one note on
two open devices could loop, and a hidden `.obsync-restore-<id>.tmp` file could
be left in the vault folder: both are fixed in 1.0.6. Two notes created under
one name kept making conflict copies: the copies are recognised correctly from
1.0.6, and giving the two notes settled, separate names is planned for 1.0.7;
until then, rename one of them. In every case seen, no note content was lost.
See the 1.0.6 entry above, and update every device.

## 1.0.4 - 2026-09-20

**Renaming a note or a folder could delete it, on every device. Update every
device that syncs this vault, and do not rename anything until you have.**
That is the whole release; nothing else changes.

**What happened.** In 1.0.0, 1.0.1, 1.0.2 and 1.0.3, renaming a note -- through
the inline title, through the file explorer, or by moving it into another
folder -- reached the other devices correctly as a MOVE, and then the device
that applied that move published a DELETION for the note it had just moved.
Every device obeys a deletion, the one that did the renaming included, so the
note left the vault everywhere within seconds of being renamed. Renaming a
folder did the same to every note inside it. A note nobody renamed was never
affected, and no note was ever deleted on its own.

**Your content is not lost, and the server never had it in the clear.** A
deletion here is a marker, not an erasure: the versions before it stay on the
server under the retention its operator set (by default at least ten versions
per file and everything from the last thirty days), and they are still
encrypted with your vault key. To bring a note back, run **Restore from
history** from the command palette on any paired device, find the note by its
path, pick the content version from before the deletion marker -- markers
themselves cannot be restored, which is why the list offers the version under
it -- and restore it. It comes back as a new file beside that path, named
`<note> (restored-...)`, and nothing existing is overwritten. A note Obsidian
moved to your system Trash or to your vault's `.trash` folder when it obeyed
the deletion is also still there, with its body intact.

**What was wrong.** Applying a remote rename means writing the note under its
new name and removing it under the old one. Obsidian reports that removal back
to this plugin exactly as it reports one you make yourself, and the plugin
published it: a deletion for a file that was alive the whole time, one name
over. The plugin already ignored the echo of its own writes; now it ignores the
echo of its own removals too, by the path it is about to remove, and it says so
in its log (`decision=echo_suppressed event=delete`). A deletion you actually
make is untouched by this and still reaches every device, including one you
make on a note that was just renamed elsewhere.

**Why every device.** The device that publishes the wrong deletion is the one
RECEIVING the rename, so a single device left on 1.0.0-1.0.3 can still delete a
note that a fully updated device renames. Update them all, then rename freely.

## 1.0.3 - 2026-09-20

Dashboard security: an independent review of 1.0.1, and a second pass that
exercised a running server rather than reading it. Your vault, your devices
and your pairing are untouched, and the plugin does not change.

**Nothing to do — unless you open the dashboard over plain `http`.** That
stops working after this update at any IP address or LAN name, and also at
`localhost` if your browser is Safari (first bullet below). One thing
everybody will notice: dashboard sessions opened before this update are
signed out once, so open the dashboard from **Open dashboard** on a paired
device again.

- **The dashboard needs a secure address now.** Its two cookies are `Secure`
  and host-bound, which is what stops one plaintext request from carrying
  your session in the clear or letting another host on your domain plant one.
  What that means for the address bar:
  - an `https` address works in every browser — this is the supported way in,
    and the one every install guide here already describes;
  - plain `http` to `localhost` or `127.0.0.1` works in Chrome and Firefox,
    which treat loopback as secure, but **not in Safari**, which sends no
    `Secure` cookie to a plaintext origin at all: on Safari the sign-in
    redirect appears to work and every page is then signed out;
  - plain `http` to any other IP address or LAN name works nowhere. If that
    is how you reach the dashboard today, put your TLS terminator in front of
    it and use its name.
- **Revoking a device now ends what it opened.** Revoking used to leave the
  sign-in link that device had just minted working, and any dashboard session
  opened from one of its links alive for up to twelve hours. Revoking a lost
  laptop while its browser was still signed in did not sign it out. It does
  now: the link stops working and the session ends in the same moment.
- **The dashboard can no longer revoke your last device.** The plugin has
  always refused that, because an account with no active device can never
  sync again and nothing re-enrols one; the dashboard's Revoke button had no
  such guard, so one click was permanent. It refuses now, and the confirm
  text says what revocation does and does not do.
- **Sessions end sooner, and you can end all of them.** A dashboard left open
  and untouched for an hour signs itself out; the twelve-hour limit still
  applies whatever you are doing. **Sign out everywhere** in the top bar ends
  every session the server holds at once, and cancels any sign-in link that
  was opened and never used — a machine you no longer have may be holding
  one, and it would have worked for its five minutes.
- **Two devices revoking each other at the same moment can no longer empty
  your account.** The check for "this is your last device" and the revocation
  itself now happen together, so two clicks that land in the same instant
  cannot both go through. Before, they could, and an account with no active
  device can never sync again: nothing re-enrols one.
- **The recovery token is treated as the break-glass credential it is.** A
  sign-in with it is logged as a warning, and the Overview page says so for
  as long as that session lasts, so a use you did not make is visible.
  `docs/recovery.md` has the three steps that rotate it, and how to tell it
  has been used. Every refused sign-in is logged as a warning too, and while
  the Logs page holds it you can see it. Be precise about what that promise
  is: a refused sign-in is unauthenticated traffic, so it lives in the
  smaller of the two rings below (200 lines) and other unauthenticated
  traffic can push it out of that one — what it can never do is push out the
  authenticated half (1000 lines), which is where your own devices' and your
  own dashboard's decisions are. Your server's stdout keeps every one of
  these lines whatever the page shows.
- **The Logs page can no longer be wiped by a stranger.** Anyone who could
  reach the server could push every decision out of it with about a thousand
  free health probes. Authenticated decisions and unauthenticated traffic now
  keep separate space, so a burst of probes pushes out only older probes.
  Three sync endpoints also used to check the shape of an address or a
  parameter before checking who was asking, which let an anonymous caller
  land a refusal in the authenticated half — a thousand malformed requests
  emptied it in about a second. Every endpoint that needs a credential now
  asks for one first, and knowing a revoked or unapproved device's id is no
  longer treated as knowing its key.
- **The server stops telling strangers how much you write — nearly.** Every
  response used to carry the journal position in a header, including answers
  to unauthenticated probes; polling it reconstructed when and how much you
  edit. The header now rides only a response to a caller whose credential the
  server actually verified. One opening is narrowed rather than closed, and
  it is worth knowing about: `GET /readyz` still states that same position in
  its body, because the readiness contract says it does and the release
  smokes read it. If your server is reachable by people you do not trust,
  `/readyz` is what they can still poll. Whether readiness should state a
  sequence at all is a decision for a later release.
- **Smaller hardening.** `object-src 'none'` and two cross-origin isolation
  headers on dashboard pages; a proper doctype on the page; and an
  unauthenticated caller with a wrong setup token can no longer tell a
  claimed server from an unclaimed one.
- **New page:** `docs/security/dashboard.md`, the dashboard's own threat
  model — what it holds, how you get in, what defends it, and what is
  deliberately left standing.

## 1.0.2 - 2026-09-20

- **Obsidian 1.13.0 or newer.** The floor moves from 1.12.4 because the
  settings tab is now declared to Obsidian rather than drawn by the plugin,
  which is what makes every row searchable from Settings and what the
  non-deprecated destructive button needs. Root `versions.json` keeps 1.0.1
  available to an Obsidian below 1.13.0; the wire protocol, the journal and
  pairing are unchanged, so a device on 1.0.1 and a device on 1.0.2 sync the
  same vault.
- **A shorter first run.** A host name typed alone in **Server URL** becomes
  `https://host`. **Set up** and **Pair this device** apply a folder selection
  that was typed but not yet saved, so the screen is what the device syncs.
  The account-name field is gone: the dashboard calls the one account a
  server holds `obsync`. Notices drop the `obsync:` prefix.
- **A clean community-directory scorecard.** The directory's automated scan
  reported 221 issues on 1.0.0; the same rules (`eslint-plugin-obsidianmd`
  0.4.2 with typescript-eslint's type-checked set) now report none. The
  vendored Obsidian API declaration sits under a `node_modules` path, the one
  name every linter skips, and is pinned at exactly the floor so the compiler
  refuses any member the floor lacks. In the plugin: 17 redundant casts, typed
  edge-header parsing, a history cleanup that no longer throws from `finally`,
  a control-character check that is a loop rather than a regular expression,
  `console.warn` for refusals and `console.debug` for routine decisions,
  sentence-case notices. In the stylesheets: no `columns`, no `clip-path`, no
  `!important`; the recovery phrase is a numbered list laid out as a grid.
- **Disclosures.** The README now states that the plugin lists every file in
  the vault to decide what is in scope, writes the clipboard only when you
  press Copy, talks to one host, and that each Release carries a plugin ZIP
  and an evidence manifest that Obsidian ignores.

## 1.0.1 - 2026-09-20

- **Open dashboard opens the configured server, or nothing.** The plugin used
  to open whatever the server answered with. The server builds that link from
  `OBSYNC_PUBLIC_URL`, which the chart leaves empty on purpose -- a private
  deployment advertises no address of its own -- so on the chart's path the
  answer is the relative `/login?token=…` and the command failed on every
  deployment that had not named itself; on the Compose path the value was
  there but dropped the port. The link is now resolved against the **Server
  URL** this device is configured with, and opened only when the
  resolved ORIGIN is that server's. A link to any other origin is refused by
  name and not opened: the answer carries a single-use dashboard sign-in token,
  and resolving a server's answer without checking where it points is how that
  token would reach somebody else's origin.
- **The Compose route hands out the port it publishes.** `OBSYNC_PUBLIC_URL`
  and the terminator's HTTP-to-HTTPS redirect both named the default HTTPS port
  while the deployment published `OBSYNC_HTTPS_PORT`, so a deployment that
  moved that port sent its own readers to a port nothing listens on. Both now
  carry the published port, and `scripts/ci/compose-smoke.sh` -- which already
  publishes a non-default pair -- reads back the redirect AND the address the
  server hands out. A deployment whose devices arrive somewhere else, because
  another reverse proxy holds 443 in front of it, sets `OBSYNC_PUBLIC_URL`
  itself: an explicit value wins, and the smoke proves that too.
- **A standalone Helm path.** `chart/README.md` carries the exact OCI install
  command, the Secret command for the server key, and a minimal `values.yaml`
  that produces a running pod outside the reference deployment's platform. No chart
  DEFAULT moved: `deploymentReady: false`, the reference StorageClasses and the
  reference ingress peer are fail-closed on purpose, and the new file is about
  which of them a stranger must replace with their own.
- **The README answers the questions a stranger asks first.** What this plugin
  talks to (your own server, and Obsidian's directory for installation — no
  telemetry, no third party, and no code ever fetched from the sync server);
  what it does, in six lines, above the fold; a Documentation table; and where
  a question, a bug and a vulnerability each go. Four new pages carry what the
  README used to imply: [`docs/troubleshooting.md`](docs/troubleshooting.md)
  (one heading per failure mode, the protocol refusals a device can show, and
  how to collect a report without pasting a credential),
  [`docs/settings.md`](docs/settings.md) (every setting, its default, and when
  to change it), [`docs/recovery.md`](docs/recovery.md) (a lost device, a lost
  server key, a restored volume, a rotated setup token, a moved address — and
  the plain statement that a vault with no device left has no supported way
  back in this version), and [`docs/conflicts.md`](docs/conflicts.md) (what a
  conflict copy is and what to do with it).
- **The Release page leads with what changed.** From this release the published
  notes carry that version's own changelog entry, then the line that installs
  or updates the plugin and the line that upgrades the server by digest, with
  the artifact table and the evidence digest folded underneath. Releases
  through 1.0.0 keep the body they published, byte for byte, because the
  read-only audit re-derives and compares it.
- **The plugin's directory entry says what it does.** The manifest description
  is an action ("Sync your vault across devices, end-to-end encrypted, through
  a server you run yourself.") rather than a product name nobody has heard, and
  a `helpUrl` points at the documentation table.
- **Documentation repairs found by auditing 1.0.0's install path.** The
  `cosign verify` example names the release being installed rather than
  `v0.1.0`; `SECURITY.md` states the private, owner-only posture the reference
  deployment has had since 2026-09-07 instead of a public tunnel with an access
  application; the README says how to reach the server from outside the LAN and
  what the recorded device run did and did not prove; the Kubernetes
  setup-token read is a command rather than a suggestion; the protocol refusals
  the plugin shows verbatim each have a sentence; the first-time-setup
  and pairing surfaces are named as they are labelled; and the two "may not be
  listed yet" hedges are gone, because it is.

## 1.0.0 - 2026-09-15

- First stable release. No behaviour changes with it: 1.0.0 is the point at
  which the guarantees below stop being intentions and start being the
  contract this project is judged against. Everything under "Known limits" is
  what 1.0.0 does NOT claim.
- **Dependency-free, by construction.** The server is one Rust binary built
  against the standard library alone -- no crates, no build script, no
  vendored code -- and the plugin has zero runtime dependencies, built by one
  pinned TypeScript compiler and a bundler in this repository. Cryptography is
  the platform's own WebCrypto on the device and an implementation checked
  against published test vectors on the server. `#![forbid(unsafe_code)]`
  holds everywhere but the one file that delivers SIGTERM.
- **A blind server.** No vault key, chunk key, plaintext chunk, or clear file
  path is sent to, stored by, or logged by the server; file names travel only
  inside encrypted manifests. The server cannot decrypt a vault because it
  holds no key material with which to try. The doctrine tests in
  `crates/obsyncd` refuse a handler, log line, or journal frame carrying a
  field named or shaped like a key or a path.
- **Fail-closed, with nothing to turn off.** No flag, environment variable,
  build feature, or configuration field disables encryption, request
  authentication, replay protection, fsync, integrity verification, probes, or
  the response header policy. The signing window (+/-300 s) and the nonce
  memory (600 s) are constants, not settings. A chart that has not been given
  a resolved image digest fails at pull time rather than deploying something
  unverified.
- **Any size, one path.** There is no per-file or per-vault size limit in
  server code. The only refusals are explicit, configurable and visible: the
  free-space watermark on a volume and the account quota, both HTTP 507.
  Device-side ceilings -- the mobile budget and the per-file mobile ceiling --
  are plugin policy, defaulted per platform and shown in the interface.
- **Native installation and updates.** The plugin installs and updates through
  Obsidian's own Settings -> Community plugins browser as Self Hosted Private
  Sync (`obsync-private-sync`). Root `versions.json` tells that installer which
  release each Obsidian version may take, so an older Obsidian is offered the
  newest release it can actually run instead of nothing. No supported path
  copies files by hand.
- **Two independent routes to a working deployment.** The reference route puts
  a TLS terminator the operator trusts in front of the pod on a private
  network, with `OBSYNC_EDGE=none`. The Compose route (`deploy/compose`) needs
  an account with nobody: Caddy, a private name, a private certificate
  authority, and nothing reachable from the internet;
  `scripts/ci/compose-smoke.sh` re-proves its serving path and its published
  address on every pull request. A tunnel on a public hostname is an optional
  convenience on top of either, never the foundation.

### Validated on real devices

The device campaign behind this release is recorded in
[`docs/validation-runs/2026-09-14.md`](docs/validation-runs/2026-09-14.md),
which carries every V1 through V16 outcome in its own row.

- Route: the Compose route (`deploy/compose`, validation.md V15) with a
  macOS laptop as the server: the 0.1.19 release image by digest behind Caddy
  `tls internal`, a private name and a privately trusted root on each device,
  reachable only on the local network. The reference route (Helm chart behind
  a WARP private route on the homelab) was not exercised in this run: the
  WARP client delivered SSH but not a second port to the same host.
- Devices, operating systems, Obsidian versions, plugin version, server
  commit: a MacBook Pro on macOS 26.6 with Obsidian 1.13.7 and plugin 0.1.18
  (paired first); an iPhone 15 Pro Max on iOS 26.6.1 whose Obsidian version
  was not recorded during the run, with plugin 0.1.19 installed from the
  community directory; server `obsyncd` 0.1.19 from release commit `e47e3d4`.
  The run was driven by the coordinator agent lane with the user at the
  keyboard for the passcode, the local-network prompt, the firewall changes,
  and one live edit.
- Passed: the production-path install on both devices; V1 first-time setup and
  device enrollment (setup token accepted, recovery phrase shown, device
  listed); V2 pairing the phone (one-time code pasted on the phone, approved
  by name on the desktop, sealed envelope delivered, about one minute end to
  end); V3 two-way live edits (a note created on the desktop appeared on the
  phone, a line appended on the phone appeared on the desktop, each within a
  few seconds as observed, not instrumented); V15 itself, since this run is
  that Compose route confirmed on two real devices with no provider, no public
  hostname, and no port reachable from the internet. Unsigned requests to
  every sync endpoint were refused (401/404/400) and the server log shows
  exactly the two enrolled devices.
- Not attempted: V4, V5, V6, V7, V8, V9, V10, V11, V12, V14, V16, and the
  native update 0.1.18 -> 0.1.19 on the desktop. Not applicable: V13, because
  a laptop server has no private route.
- Two findings, both about generated URLs on a non-default HTTPS port and
  neither affecting sync correctness or privacy: the dashboard link the plugin
  opens, and the terminator's HTTP-to-HTTPS redirect, both drop that port.
  Tracked as [issue #68](https://github.com/snaraj/obsync/issues/68).

### Known limits

- V7 (a 20 GiB archive, Obsidian killed mid-upload, fewer than 8 MiB re-sent)
  is unproven. Resumable uploads exist; the retransmission bound has never been
  measured on a real device.
- V12 (a blob corrupted by hand, quarantined by scrub, restored from a healthy
  client) is unproven on real devices. Hosts without bounded range reads refuse
  automatic repair from a local source above 8 MiB, so a matching source on a
  capable device is required; a synthetic test does not close it.
- iPad and Windows are not validated. `docs/validation.md` names them as
  required platforms for the full campaign and this release does not claim
  them.
- Off-LAN sync (V13) is unproven on either route.
- The selected-folder list may only narrow once a vault has history. Widening
  it needs a safe current-head resync, which this version does not implement.
- Public reachability is not, and has never been, an acceptance criterion
  here: the reference deployment is private and owner-only by ruling.

## 0.1.20 - Unreleased

- Upgrade the plugin build toolchain from Node 24.19.0 with npm 11.17.0 to
  exact Node 26.8.2 with npm 11.19.1, and pin the matching multi-architecture
  image digest in the container build.
- Upgrade the CodeQL Action initialization and analysis steps from 4.37.9 to
  4.38.0 at one immutable upstream commit.

## 0.1.19 - Unreleased

- Generalise the release rule from "exactly one patch" to exactly one SemVer
  step, so a minor (`X.Y+1.0`) and a major (`X+1.0.0`) advance are admissible
  from a protected base and 1.0.0 is reachable without editing the gate in the
  pull request the gate must pass. Every skip, reversion, mixed range, second
  boundary in one range, and step that leaves a lower field non-zero
  (`X.Y+1.1`, `X+1.0.1`) stays denied, and the refusal now names all three
  admissible versions.
- Add root `versions.json`, the ledger Obsidian's community-plugin installer
  reads to offer an older Obsidian the newest release it can actually run, and
  hold it as a release follower: the head row must carry exactly root
  `manifest.json`'s `minAppVersion`, the rows must ascend, and no row may name
  a version above the head. The recorded floors are the ones each published
  release's own manifest declared.
- Follow the vault's own "Deleted files" preference when sync removes a file,
  through `FileManager.trashFile`, instead of always using the operating
  system bin. The file lookup is file-only, so a folder standing where a
  remote manifest names a file is never deleted with its contents.
- Normalise the folder selection a person types in settings through the host's
  `normalizePath`, so a leading or trailing slash, a doubled separator or a
  backslash is a typo rather than a refusal that discards the whole selection.
  Paths that arrive from another device are still refused, never normalised.
- Schedule the engine's timers and the transport's backoff through
  `window`, the one spelling that means the same thing in Obsidian's desktop
  Electron runtime and on mobile.
- State the truth in `README.md`: the plugin is listed in Obsidian's community
  directory as Self Hosted Private Sync, installed from Settings → Community
  plugins → Browse. Add the commands and status-bar legend, a troubleshooting
  section, and the three callouts a self-hosted sync plugin owes a new reader.
- Add the repository conventions established plugins share: issue templates
  for a bug report and a feature request, `.editorconfig`, and a
  `CONTRIBUTING.md` that points at the contract.

## 0.1.18 - Unreleased

- Accept maximal encrypted chunks within the fixed 8 MiB plaintext plus
  16-byte authentication-tag upload ceiling. Budget pulls by ciphertext size
  so three maximal chunks fit the unchanged 32 MiB multipart payload ceiling.
  Preserve chunk identities, history and ordinary four-upload concurrency.

## 0.1.17 - Unreleased

- Automatically audit remembered selected-file chunks and restore missing
  ciphertext from an intact local copy after scrub quarantine. Authenticate
  the retained manifest, preserve chunk identity, and verify restored bytes
  without creating another file version or changing history or tombstones.
- Bound each repair step to 64 chunk entries and at most one chunk upload;
  share one tracked worker between the background timer and Sync now, cancel
  reads on stop, and drain already dispatched writes before replacement loads.
- Report unavailable or changed repair sources. Devices without bounded range
  reads refuse automatic reads of source files above 8 MiB; larger files need
  a matching source on a device with bounded range reads. Native-device V12
  acceptance remains a separate validation requirement.

## 0.1.16 - Unreleased

- Fix native provenance verification by using the exact certificate identity
  without the mutually exclusive workflow selector. Retain repository,
  source, signer, issuer, hosted-runner and SLSA constraints, with a real CLI
  argument regression alongside the publication model.

- Store device credentials, vault keys and edge headers in one owned native
  SecretStorage entry, keeping only a reference and bookkeeping in plugin
  data. Migrate existing settings after verified secret writes, retain a
  bounded prior credential record for interrupted updates, and stop sync on
  unavailable or unverified persistence. Bind recovery dialogs before phrase
  derivation and drain stopped engine work before replacement loads. Require
  Obsidian 1.12.4 or newer.
- Remove obsolete server plugin-code download endpoints. Native Community
  Plugins installation and updates remain the supported distribution path;
  packaged assets and historical release verification remain intact.
- Align current pairing, credential custody, recovery and installation
  guidance with the implemented behavior and remove numbered feature promises.

## 0.1.15 - Unreleased

- Let a new device wait for approval through its own envelope endpoint,
  preserving one-time collection and stopping when the pairing dialog closes.
- Encode device policy using the existing v1 API field names, so heartbeats
  and device-setting updates report both ceilings successfully to the server.
- Use Self Hosted Private Sync as the community plugin display name, preserving
  the installation ID and device pairing protocol.
- Publish GitHub Actions SLSA build provenance for the three native plugin
  assets and verify it against the authorized protected-main source before
  sealing the release. Revalidate that provenance in the read-only release
  audit while preserving historical releases and existing release evidence.
- Refuse publication when the dispatch workflow commit differs from the
  authorized source, so native provenance cannot name a different build.

## 0.1.14 - Unreleased

- Return a failed process status for incomplete check and export reports.
- Verify ciphertext references from every retained version during offline checks,
  including missing history-only chunks, and count each verified chunk once.

## 0.1.13 - Unreleased

- Use Private Sync as the community plugin display name and link the maintainer profile.
- Compile against the official Obsidian 1.7.2 API declarations and declare the same minimum application version.

## 0.1.12 - Unreleased

- Use the distinct `obsync-private-sync` installation and pairing-link identity
  while retaining the Obsync display name. Native installs keep their own
  settings; no other plugin folder or protocol action is adopted. Release
  verification preserves the original ID through 0.1.11 and requires the new
  ID thereafter.

## 0.1.11 - Unreleased

- Prepare native installation and updates through Obsidian's Community
  Plugins browser. Keep one root manifest, publish the three individual
  plugin files from the same build as the ZIP, and bind every asset in v2
  release evidence. New GitHub tags match the unprefixed plugin version;
  image tags retain their prefix. Existing immutable releases retain their
  original audit contract. Directory acceptance and device validation remain
  separate prerequisites for production use.
- Align the commit-signature validator with the documented GPT-6 lane while
  retaining exact-match, identity and trailer refusals.
- Add a folder selection saved only on this device. Existing dedicated
  vaults retain whole-vault sync; selected folders admit only descendants,
  and an explicit empty selection syncs no files. Scoped scans start at the
  selected folders. Push, pull, on-demand downloads, remembered rename and
  deletion sources, conflict copies and merge history obey the selection
  before file access. Invalid persisted selections refuse loading.
- Saving a narrower selection waits for active transfers, preserves files
  and state, and never rewinds the feed. Queued renames remain publishable
  after restart. Expansion after a device has sync history is refused;
  move local files into an already selected folder and run Sync now to add
  content within the same vault. The selection does not revoke access to
  previously shared content or sandbox Obsidian, its plugins or the local OS.
- Complete native folder-selection saves without returning a thenable UI
  component to a Promise continuation, including handled save failures.
- Disabling the plugin cancels pending startup and folder-change
  continuations, so a delayed transfer or local save cannot restart sync
  after unload. Stale startup results cannot replace a newer engine or its
  status; an already-issued local write may finish and must be checked after
  restart.
- Add **Restore from history** to the native command palette. It browses
  retained versions, including deleted notes, with a separate bounded read
  cursor and restores verified content as a new sibling file. Existing
  files, unsynced edits and original history are preserved; the new copy
  uses ordinary sync with a fresh identity. Folder selection and current
  device limits apply, including local bytes added during the download.
- History reads make one attempt at a time; cancellation discards late
  results and blocks replacement reads until the outstanding request
  settles. A dispatched local create is preserved and reported separately
  from remote sync. Desktop publishes without replacing a destination;
  mobile uses Obsidian's create-only API. Neither platform silently falls
  back to an overwriting write.
- Resume sync after a same-instance reload waits for prior history recovery
  and manual-download work, without loading state ahead of their saves.
- Quarantine damaged chunks across separate blob and journal mounts using
  a synced copy on the destination volume before removing the primary.
  Reserve peak copy space, account failed-copy residue, and retain failed
  operations for recovery without claiming quarantine or losing inventory.
  Recovery uploads and delayed scrub summaries cannot discard each other;
  concurrent GC skips a busy chunk pass without holding partial locks.

## 0.1.10 - Unreleased

- The chart's own defaults could not start the server, and both halves of
  that are fixed here. `chart/values.yaml` declares each claim as a
  Kubernetes quantity (`250Gi`, `4Gi`) and the Deployment renders it verbatim
  into `OBSYNC_BLOBS_CAPACITY` / `OBSYNC_JOURNAL_CAPACITY`, but the server's
  size grammar knew only `KiB`/`MiB`/`GiB`/`TiB` and lower-cased what it read,
  so `Gi` was not a size and the pod exited on its own chart's defaults. The
  Service is named `obsync`, so a kubelet with service links on also injected
  `OBSYNC_SERVICE_HOST`, `OBSYNC_SERVICE_PORT` and `OBSYNC_PORT_*` -- and an
  unknown `OBSYNC_*` name is a startup error by design, which is a second
  refusal on the same first boot.

- **Size grammar, one spelling per multiplier.** `parse_size` (and therefore
  `OBSYNC_BLOBS_CAPACITY`, `OBSYNC_JOURNAL_CAPACITY`, `OBSYNC_SCRUB_RATE` and
  the size term of `OBSYNC_FREE_WATERMARK`) now accepts a bare byte count
  (`512`), `B`, the Kubernetes binary suffixes `Ki`, `Mi`, `Gi`, `Ti`, and
  their long forms `KiB`, `MiB`, `GiB`, `TiB`; `Gi` and `GiB` are the same
  multiplier. The suffix is matched case-sensitively after trimming.
  COMPATIBILITY, for both `OBSYNC_*_CAPACITY` and `OBSYNC_FREE_WATERMARK`:
  the single letters `k`, `m`, `g`, `t` and every lower- or upper-case
  spelling (`gib`, `GIB`, `4mib`, `512b`) are DROPPED and now refuse the
  start. A value using one must be rewritten -- `250g` becomes `250Gi`,
  `1%,2g` becomes `1%,2Gi`, `64m` becomes `64Mi`. Nothing in this repository,
  its charts, its compose file or its README used a dropped form. The reason
  they are gone is that Kubernetes reads a single letter as a power of a
  thousand, so keeping them binary made `250G`-shaped input ambiguous in
  exactly the direction that over-states a volume and makes the free-space
  watermark fire late. Decimal SI (`G`, `GB`) is refused for that reason;
  a fraction (`1.5Gi`) is refused for a different one, that the grammar
  deliberately admits whole units of one multiplier and nothing else -- the
  value is an exact byte count, it is simply not a spelling this grammar has.
  A whole-unit size whose product does not fit in 64 bits is refused rather
  than wrapped. The error text now names the accepted forms.

- **Chart.** `values.schema.json` admits only Kubernetes binary quantities
  for the claim sizes the server is told (`^[1-9][0-9]*(Ki|Mi|Gi|Ti)$`), so a
  decimal `250G` -- or the server's own `250GiB`, which the API server would
  refuse -- fails `helm lint` instead of rendering a pod that cannot start.
  The Deployment sets `enableServiceLinks: false` beside its existing
  `automountServiceAccountToken: false`; the Service keeps its name and the
  server's refusal of unknown `OBSYNC_*` names is unchanged and retested.

- **The gate now runs the chart against the binary.** `image-smoke.sh` gains
  a tenth property: `helm template` renders the deployment, the rendered
  environment is read from that render through the fail-closed YAML reader
  (`scripts/ci/chart_pins.py env` -- no variable name, value or mount path is
  typed into the smoke), and the SHIPPED image is started on exactly those
  values and must answer `/readyz`. `chart_pins.py environment` holds the
  render side: service links off, and every quantity either reader refuses is
  refused by the schema. The container job installs the pinned helm for it.

## 0.1.9 - Unreleased

- Two exact pins advance, each confirmed from its source before it was
  written rather than from the proposal text. The runtime base
  `gcr.io/distroless/static-debian13:nonroot` moves from `sha256:f7f8f729...`
  to `sha256:1c2c046b...`: `docker buildx imagetools inspect` resolves that
  tag today to index digest `sha256:1c2c046b...`, and an anonymous registry
  HEAD accepting only the index media types returns the same
  `docker-content-digest`. That digest is the multi-arch INDEX, which is what
  a `FROM` must name for both production platforms; the per-architecture
  manifests beneath it (`sha256:e754765a...` amd64, `sha256:9381e9b7...`
  arm64/v8, and four others) are different digests, and pinning one would
  break the other platform. `docker/setup-qemu-action` moves from `96fe6ef7`
  (v4.2.0) to `1f40c722` (v4.3.0) in the release publisher, with the version
  comment updated; the tag `v4.3.0` in that repository is a lightweight tag
  resolving to exactly that commit. The `library/node` major bump is held
  under issue #32 and the node stage is untouched here.

## 0.1.8 - Unreleased

- A dismissed alert GitHub has stamped `fixed_at` is skipped, counted and
  named instead of refusing the run. `Alert.historical` described exactly this
  case and then tested `most_recent_instance.state == "fixed"`, which the
  shape never satisfies, so the first live reconcile after v0.1.7 (push run
  34368935826 at `f229a46`) stopped on alert #90 with
  `was analysed on commit e4aa059…, not f229a46…` before writing anything:
  every later step was skipped, main kept its one covered open alert, and the
  publisher denied the version on the exact-SHA binding. The API partitions
  main's 78 dismissals exactly: 33 (#55–#90, `hard-coded-cryptographic-value`
  in `api/auth.rs` 583–1052, the auth nonce vectors v0.1.7 removed) carry
  `fixed_at` with their instance left on `e4aa059`, and the other 45 carry
  `fixed_at: null` with their instance on `f229a46`. The stamp is what earns
  the exemption and an old commit alone never does: an unstamped dismissal
  whose instance names another commit, and any OPEN alert that does, are still
  refused as superseded or foreign, and the ref and analysis-key bindings now
  hold in every state. The stamp is read for its presence, null or a non-empty
  string, and its syntax is not validated: the ref, the analysis key and the
  alert's own state are what guard the exemption. `fixed_at` can be read at face value because the job
  waits for `processing_status: complete` on both analyses before it lists
  anything, and on a pull request the base listing now requires the analysis
  record it selects per language to report an empty `error` — agreement on a
  commit is not evidence that the analysis of that commit succeeded, and there
  is no fallback to an older healthy record.

## 0.1.7 - Unreleased

- A journal append that fails is rolled back to the length the journal has
  made durable and the cut is fsynced, so the next frame starts clean and a
  write acknowledged after a failure can no longer be discarded by the next
  start's truncation; if that rollback itself fails the journal is faulted,
  every later append refuses with `journal_faulted`, `/readyz` answers 503
  with the reason to restart, and the line names both the append's and the
  rollback's error kinds.
- The journal volume has its own free-space watermark, refusing a frame with
  `507 journal_full` against `OBSYNC_JOURNAL_CAPACITY` minus everything the
  journal root holds, snapshots included; `VolumeStatus` reports that same
  number, and the image smoke gained a ninth property that exhausts a real
  blob volume and requires the server's `io=StorageFull` account, its 503,
  and its recovery when the space comes back.
- A journal accounting survey that is itself refused is now recorded as a
  fact of its own rather than dropped: the tracked total is marked unverified,
  a survey publishes both of its halves or neither, and while it stands the
  server is fail-closed — an append retries the survey once and otherwise
  refuses with `503 journal_unverified` having written nothing, so the
  watermark is never decided against a figure nothing has re-read. `/readyz`
  retries the survey too and answers `503 not_ready` with the kind that
  refused it, so a volume an operator has fixed comes back on the next probe
  with no write in between; `VolumeStatus` gained `usage_unverified` so the
  dashboard shows the figure as the last one read successfully. A faulted
  journal stays faulted however well the volume measures: that state is about
  the segment's contents and still clears only at a restart. The original
  operation error is unchanged and still what its caller gets.
- The `dispositions` reconciliation rewrites a stored justification with two
  writes, `state=open` then `state=dismissed`: GitHub refuses a `dismissed`
  write to an already-dismissed alert, which stopped the first live run on
  `main` with 78 rewrites planned. Each write announces its phase; either write
  failing is fatal to that run and blocks publication, and the next authorized
  run converges from whatever state was left. The offline step harness is now
  STATEFUL — it holds each alert's state, reason and comment, answers listings
  from them, and refuses a second dismissal the way the API does — so the
  single-write shape cannot pass the suite again.

## 0.1.6 - 2026-09-09

- CodeQL dispositions are code: `security/codeql-dispositions.json` records
  every accepted alert with its rule, its glob, its scope, one of CodeQL's
  three reasons and the issue carrying the reasoning, and a new `dispositions`
  job in `codeql.yml` waits for both analyses to be indexed and then fails any
  ref that carries an alert no entry covers — on a pull request that means the
  changed range AND the base branch, whose alerts a diff-informed pull-request
  analysis never shows and whose dismissed alerts count too, judged in the
  commit the base's analyses ran on. On a push to `main` the job first
  reconciles the alerts that are already quiet — a dismissal nothing covers is
  reopened, a stored justification that is not this file's is rewritten — then
  dismisses every covered open alert and requires `main` to hold zero, so
  nobody dismisses by hand, nothing is excluded from analysis, and a new real
  finding blocks the gate and the release chain until it is fixed or
  dispositioned in a reviewed pull request.
- An acceptance over product code now names what was reviewed: `line_is` (the
  exact source line) or `reviewed_sha256` (the file's bytes), verified on every
  run whether or not an alert touches the file, so an edit to accepted code
  cannot land without re-triage in the same pull request. Every judged alert
  must also name the commit it was analysed on and this workflow's analysis
  key, so a superseded or foreign record cannot supply a line number to a
  checkout that never produced it.

## 0.1.5 - 2026-09-09

- Every line that states a storage refusal now names the `io::ErrorKind`
  behind it (`io=StorageFull`, `io=PermissionDenied`, `io=NotFound`) through
  the one helper the request path already used, so the five fatal startup
  refusals, the collection, unlink and scrub lines, the snapshot retries, the
  expired-pairing sweep, the dropped `seen` event and the `check`/`export`
  refusal say WHICH I/O stopped them instead of `refusal=io_error` alone.
- The image smoke's `deny` adds the number behind that word: `df` of both
  volumes read from inside the compose path's digest-pinned throwaway image,
  and the daemon's own `docker system df`, both best-effort so neither can
  mask the refusal they explain.

## 0.1.4 - 2026-09-09

- The chart's `deploymentReady` gates the replica count instead of only
  annotating it. False, the shipped default, renders every object with
  zero application replicas, so the claims can bind their volumes and the
  TLS proxy can resolve the Service while no Pod waits on a volume or a
  Secret that does not exist yet; true is a scale from zero to one. The
  chart pins render both values and refuse a non-boolean.

## 0.1.3 - 2026-09-08

- The publisher attests with the URI form of the provenance type
  (`--type https://slsa.dev/provenance/v1`): the named `slsaprovenance1`
  makes cosign re-serialise the predicate through its typed struct and
  drop BuildKit's layer metadata, which is what the contract binds each
  platform through. The contract accepts the in-toto Statement v0.1 that
  cosign emits. v0.1.2's publisher run built, signed and attested its
  image, then refused its own attestation on both counts, so that tag
  carries no chart and no Release; nothing weaker was accepted.

## 0.1.2 - 2026-09-08

Tagged and its image published, signed and attested; the publisher's own
verification refused the attestation (statement type; predicate stripped of
its layer groups), so this version received no chart and no GitHub Release
(repaired in 0.1.3).


- The release publisher attests the image's SLSA v1 provenance onto the
  published digest with its own identity, one statement per platform,
  and proves it verifies with the consumer's command before the chart
  embeds the digest. v0.1.1's image carries BuildKit provenance but no
  signed attestation, which the platform's acquisition check requires.
  `scripts/ci/provenance_contract.py` decides, offline, what each
  statement binds: the BuildKit v1 shape naming this exact run, and one
  production platform, identified by the layer digests of that platform's
  manifest; every platform gets exactly one statement, on a fresh build
  and on a reused digest alike.

## 0.1.1 - 2026-09-08

- The release publisher checks the plugin bundle's listing for the names
  the archive holds. The first v0.1.0 publisher run exported a correct
  bundle and then failed its own check, looking for `./main.js` in a
  listing that said `main.js`; v0.1.0 keeps its tag, signed image and
  signed chart and received no Release.
- The nonce log's compaction recovery contract is published for operators
  (`docs/storage.md`, "Nonce log recovery"), and each of its sentences is
  pinned by a test that drives a real compaction over a real volume.

## 0.1.0 - 2026-09-08

Tagged, with its image and chart published and signed; it received no
GitHub Release because the publisher's bundle check failed after them
(repaired in 0.1.1).

### Added

- Repository contract, architecture, wire protocol, storage, threat model,
  benchmark, validation, and platform-onboarding documents.
- Start-time volume posture: `serve`, `check`, and `export` measure the type,
  owner, and mode of both volume roots and both credential files before
  anything is read or written through them. A weak mode is corrected and
  re-read; a link, a substituted type, or a foreign owner refuses the start.
- A ceiling on the heads one file may hold, equal to the parents one version
  may declare, so a conflicted file is always resolvable by one merge naming
  every head and the head list a response carries is bounded. The version
  that would pass it is refused with `409 too_many_heads` and nothing
  already stored changes; replay applies what the journal already holds.
- Replay protection that survives a restart: every accepted nonce is
  appended to `v1/nonces` on the journal volume and fsynced before its
  request is answered, and a start loads back what the 600 s window still
  covers. The file is rewritten once it passes twice the cache's ceiling, a
  torn final line costs only itself, and a volume that will not take the
  record refuses the request with `503 nonce_log_unavailable`, and a link
  standing where that file belongs refuses the start.
- Pending devices are reconciled against the pairing table on every start.
  A pairing lives in memory and the device a claim creates is journaled, so
  a restart used to leave an unapproved claimant nobody could approve and
  expiry could not reach, holding its wrapped secret for the life of the
  store. It is now destroyed down the path expiry uses, with one line
  stating the count.
