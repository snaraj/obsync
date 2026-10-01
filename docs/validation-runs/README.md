# Validation runs

*Internals, for contributors and reviewers.*

One file per device campaign, named `<date>.md` with the ISO date the run
STARTED: `2026-09-14.md`. A run record is the evidence behind a readiness
claim -- what was exercised, on which real devices, against which server, and
what it measured. `docs/validation.md` is the plan and does not change per
run; these files are the results and are append-only history. A claim that
appears in `CHANGELOG.md`, `README.md`, or a pull-request body and is not in a
run record here has no evidence behind it.

## Clients

What each client of the MVP set ([validation](../validation.md)) has so far. A
CI job is evidence that the plugin works inside the real application on that
system; it is not a device run, and only a record below is
([Your devices](../setup.md#your-devices)).

| Client | Recorded on a device | Proven in CI |
| --- | --- | --- |
| macOS | The runs below that name it; most recently [2026-09-30](2026-09-30-train-1.1.5.md) | `desktop-matrix.yml`, `obsidian-macos`: the official Obsidian app, two instances, through setup, pairing, notes both ways, a rename and folders, against the server behind Caddy; `plugin-tests` on macOS |
| iPhone | The runs below that name it; most recently [2026-09-30](2026-09-30-train-1.1.5.md) | Nothing: no CI job runs a phone |
| iPad | Not yet recorded | Nothing |
| Windows | [2026-09-27](2026-09-27-windows-11-vm.md): Windows 11 on ARM64 in a virtual machine, the 1.1.4 build; most recently [2026-09-30](2026-09-30-train-1.1.5.md), a 1.1.5 train build | `desktop-matrix.yml`, `obsidian-windows`: the same journeys, plus a case-only rename, the trash and a file another program holds open on NTFS; `plugin-tests` on Windows |
| Linux | Not yet recorded | `desktop-matrix.yml`, `obsidian-linux`: the same journeys with the official AppImage, the authority trusted in each instance's own NSS store, and a third instance without it refused |
| Android | [2026-09-27](2026-09-27-android-emulator.md): an Android 15 emulator, not a physical phone, the 1.1.4 build; most recently [2026-09-30](2026-09-30-train-1.1.5.md), the same emulator on the 1.1.5 train's builds | Nothing: no CI job runs a phone |

`desktop-matrix.yml` runs nightly and on pull requests that change the plugin
or its harnesses; a red leg there is a finding to read.

## The runs

Newest first. Each record identifies its build and separates what was
observed from what was still outstanding.

- [2026-09-30 the 1.1.5 train](2026-09-30-train-1.1.5.md): the train's
  closing run on three macOS desktops and an Android 15 emulator, with the
  coordinator's iPhone and Windows rows. J1 to J11 pass. final10 is the
  final build; final9 and final10 ran on the desktops only.
  - **#307:** closing a Settings window during a first sync stopped a
    desktop for good: 1 run of 5 on final3, and 1 of 5 on final4 at its
    start. final5 to final7 wedged 0 of 25 runs, through the start's retry
    and the feed's. final9, which awaits a disk change past the bound
    instead of letting it go, wedged 0 of 5.
  - **The bound's cost:** a Sync now press was 10 % slower on final5 and
    3 % on final6. final7 is inside noise at this sample, with a point
    estimate of +68 ms. final9 and final10 are inside noise against final8.
  - **#311:** a new device wrote every version the server keeps and trashed
    every note deleted elsewhere: on final9, 22 extra writes and 17 notes in
    its trash. final10 skips all 34 superseded versions, and its trash stays
    empty.
  - **#310:** an uploading desktop missed the sid of 473 of 2,000 new notes
    on final9 and read each back from the server, one a second. final10
    missed none.
  - **#308:** a phone's out-of-storage toast stood for hours after the
    server had room again. It now goes with the refusal.
  - **#309:** after Delete everywhere, Recent ended on the question. On
    final8 the answer is its own notice, "deleting N notes on your other
    devices too.", and the other desktop held none of the notes 0.8 s
    later.
  - **Not attempted:** a physical Android phone, the final build on the
    iPhone, Windows and the phone, and either reference route.
- [2026-09-30 1.1.5 beside 1.1.4](2026-09-30-version-skew.md): servers and
  devices on different versions, both ways round, on macOS desktops, and one
  device taken back to 1.1.4 and on to 1.1.5 again.
  - **Held as the CHANGELOG says:** pairing either way (`kex=legacy` with a
    1.1.4 side), notes, renames and deletes through either server, Forget
    and Leave against a 1.1.4 server, and a full disk faced by a 1.1.4
    device.
  - **Not reached:** the notes 1.1.5 was bringing back when the device went
    back (#281).
  - **Found:** going back to 1.1.5 met #302, a closed Settings window
    stopping a desktop's receiving, fixed in this train.
- [2026-09-29 a desktop feed that stops](2026-09-29-feed-wedge.md): #276 on
  two macOS desktops, not reproduced, the mechanism unconfirmed. None of
  these stalled:
  - on origin/main, 34 runs of the reported shape, 23 upload bursts and 60
    fuzz seeds;
  - at the 1.1.5 instrumentation, 20 bursts and 10 runs through a hop.

  With the pull chain held on purpose, origin/main stayed `idle` and silent.
  The instrumented build named the step it waited on, in the status and in
  one warning at 110 s.
- [2026-09-29 two typists and a third device](2026-09-29-cotyping-three-devices.md):
  #227, #278 and #279 on three desktop instances on one Mac, under load. At
  origin/main one typist's last words went into a conflict copy in 1 of 5
  runs with the note shown on the third device. The final head, alternated
  with origin/main:
  - renderers frozen: no copy in 10 runs, where origin/main made copies in
    2 of 10. The driver's verdict on the head, read with the windows
    hidden, failed in 9 on Obsidian's pending save; each held the whole
    text 90 s after the windows returned;
  - not frozen: 10 of 10 passed, and the third device's merge notices fell
    from 58 a run to 0.

  Two earlier heads each failed one run, one when the host starved all
  three instances. Not covered: phones, Windows, a device on 1.1.4 or
  earlier beside updated ones, more than one passive device.
- [2026-09-29 folder records](2026-09-29-folder-scope.md): #240, #264,
  #265, #266 and #272 on three desktop instances on one Mac, the third
  paired later, each reproduced before its fix and passed after. A renamed
  selected folder leaves no empty folder or live record behind; a queued
  edit waits for its folder's new capitals; removals written down while the
  server is down outlive a reload; after a reload, the old session's read
  ends in one line at +2.2 s instead of retrying until +77.4 s. #266's live
  replay did not reach the fixed branch; a direct removal of a folder
  Obsidian had not listed did, 3 of 3 removed against 1.1.4's 3 of 3
  `EISDIR`. #238's rename passes; its retry case is proven by the plugin
  suite only. Left as found, and harmless: one redundant folder version
  over a tombstone.
- [2026-09-29 a replay over a vault the device holds](2026-09-29-held-replay.md):
  #239, #241 and #281 on two desktop instances on one Mac, each reproduced
  before its fix and passed after, with no notice and no extra copy. A note
  moved out of the selection, edited meanwhile or not, comes back as one
  move when the whole vault is chosen. Pairing again over a kept vault posts
  no chunk and no version; a moved note's sequence reproduced 3 of 3 on
  1.1.4 and passed 5 of 5. A widening cut short by quitting Obsidian brings
  the note back at the next start. The first run also found a folder removal
  refused with `EISDIR`, fixed in the final build.
- [2026-09-29 one notice channel, and notice settings](2026-09-29-notices.md):
  two desktop instances on one Mac. Three merges drew 3 toasts a side at
  1.1.4 and, by default, 1 naming the note's title and the other device,
  with all three in Recent; Every time, Recent only and Only what needs me
  drew 3, 0 and 0, set through Settings, the command palette and Obsidian's
  command line. Show sync status asked for twice opens one dialog (#269). A
  second step, on 2026-09-30, drew 8 / 2 toasts where the train drew 25 / 2,
  twenty Sync now presses in 2 instead of 20; the security warning's server
  answer was simulated in the page. With room again after a full server,
  one run read `syncing 1 file` for 90 s with the refused file unsent,
  reported separately. Not run: a phone and Windows.
- [2026-09-29 what an inspecting network sees](2026-09-29-observer-proof.md):
  two desktop instances on one Mac, every byte of whole sessions recorded
  between the plugin and the server, as a TLS-inspecting proxy holds them.
  Four scans found no note content, file or folder name, vault key or key
  derived from it, recovery word or pairing secret, and a positive control
  on each capture failed as it should. One earlier scan failed on two single
  recovery words that are the protocol's own field names; the scanner now
  leaves such a word out and names it. A device secret alone can rename,
  limit and revoke devices, but never read, forge or silently alter a note.
  A server older than 1.1.5 is refused before any pairing code. A 1.1.4
  desktop's feed stopped in one run of five. Not covered: Windows, Linux,
  phones, a hop that rewrites traffic.
- [2026-09-29 phone paths](2026-09-29-phone-paths.md): #244, #245, #246,
  #248, #282 and #284 on an Android 15 emulator, not a physical phone, and a
  macOS desktop, the plugin copied in by hand. #244, #245 and #248 each
  failed at 1.1.4 and passed at the change. On 7,700 notes a Sync now with
  nothing changed took 757, 761 and 713 ms, reading no note, against 218.9,
  220.8 and 119.4 s on the train before it (2,170 to 24,272 ms under a
  second run's load), and the check whether a path may sync 144 ms against
  10,943 (#282). Where another app had put a folder in a synced note's
  place, the desktop's deletion of the note was refused and the folder kept
  (#284). Not validated: a physical Android phone, an iPhone or iPad, a stop
  Android makes itself, a reference route with TLS, a production-path
  install.
- [2026-09-29 what obsync writes is listed](2026-09-29-reconcile-listing.md):
  #253 and #267 on two desktop instances on one Mac, the receiver's file
  watchers closed. At 1.1.4 its listing reflected none of six changes after
  120 s; after, each was listed 1 to 4 ms after it reached the disk, and
  search found a listed note's new words 0.6 s after they landed, where the
  #253 build had not in 60 s. An open note's new words are still not in
  search after 15 s. A natural `fseventsd` overload slowed events without
  losing them, so it did not reproduce the report. Cost: 1 ms a note at the
  median, 1.5 s over 1,000 notes. Not covered here: Windows and Linux,
  where the CI journey runs.
- [2026-09-29 recovery key hold, warning and reset](2026-09-29-recovery-lockout.md):
  an author record, not an independent security verdict, on two and then
  three desktop instances on macOS. Leaving from the only device within the
  seven-day hold is refused (`409 recovery_too_new`) and it stays paired;
  every other revoke is unchanged. `obsyncd recovery reset` refuses while
  the server runs; stopped, it clears the key, rotates the setup token and
  arms one re-enrolment: the old token was refused and the new one
  re-enrolled the device in 2.4 s, while an account never reset refuses.
  The security warning's server answer was simulated in the page, and a
  1.1.4 snapshot dropping the key's time was not reached live. Not
  investigated: a pairing dialog left open after approval.
- [2026-09-29 revoked devices](2026-09-29-revoked-devices.md): #247 on two
  desktop instances on one Mac, the dashboard in one of them, against 4
  syncing and 12 revoked devices. Folded, Settings' Devices group at 375 px
  is 959 px tall against 1964 px. Forget archives: the device is still
  refused `403 device_revoked` and still named, a restart keeps it so, and a
  1.1.4 server serves that journal; against a 1.1.4 server the person is
  told to update and nothing changes. Not covered: a phone (375 px was
  Obsidian's mobile emulation), Windows, the reference routes, a standalone
  browser.
- [2026-09-29 speed](2026-09-29-speed.md): two desktop instances on one Mac
  at load averages up to 240, so absolute times are shapes. A typed word
  reached the other editor in 2.25 s, nine tenths of it Obsidian's own save
  delay. A first sync of 7,703 files wrote the plugin's state 211 to 253
  times (0.22 to 0.27 GB) where 1.1.4 wrote it 7,451 times, 9.29 GB (#274).
  A minimized window's timer throttling is lifted for each span of work
  (#283). A woken, pressed or focused device keeps its long poll and is not
  called offline (#288); a server's own `500` reads as syncing, a bare `502`
  still as offline (#298). One first download stalled for 18 minutes, cause
  open. Not covered: phones, Windows, Linux, several devices uploading on
  real hardware, a clean machine.
- [2026-09-29 a disk that fills before the watermark](2026-09-29-storage-full.md):
  #291, #292 and #295 on one desktop instance against the shipped image in
  Docker, its volumes smaller than they declare. Before, a full blob volume
  answered `500` and the device read offline, then synced with a note not on
  the server. Now it answers `507 storage_full` and the device says the
  server is out of storage from +6.1 s; with room again the note synced
  6.0 s after an edit, or by itself 246 s later. A full journal volume now
  says the same; a faulted nonce log or journal, played by a lab proxy, asks
  for a restart and Sync now, which then sent the note. The first build
  showed #293 on the way: `synced` over a note still unsent. #294 is proven
  by a server test only. Not attempted: a phone.
- [2026-09-28 an open note and the stale editor](2026-09-28-open-editor.md):
  #252 on the user's iPhone, the Android emulator and a macOS desktop. A
  starved file watcher left an open note stale behind "syncing 1". The first
  fix passed an idle editor both ways and failed when both devices typed at
  once (it read `TextFileView.data`, which follows every keystroke); the fix
  that replaced it passes all three on the iPhone, both devices typing into
  one note included, and ends exact on the emulator and the desktop.
- [2026-09-27 Android emulator and desktop](2026-09-27-android-emulator.md):
  the first Android record, an Android 15 emulator against a macOS desktop.
  J1 to J9 pass. J10 did not complete: #245 (a phone's stale file index), an
  operator interruption and #241's old-name copies each stopped it, and
  pairing again completed with nothing uploaded. #242: 2,400 files written
  with no empty version published, and the forced refusal passes, alone
  (E5), through a folder rename and deletions on the phone (E6), and for a
  merge the phone makes (E7).
  #234 and #235 are proven live.
- [2026-09-27 Windows 11 desktop](2026-09-27-windows-11-vm.md): the first
  Windows run, Windows 11 on ARM64 against a macOS desktop. 9 of 10 journeys
  pass: notes, a folder rename, case-only renames on NTFS, the trash, a
  linked folder refused, a restore and a conflict with exactly one copy each
  (#222), a 64 MiB file. A renamed selected folder leaves an empty folder on
  the other device (#240, 1.1.5).
- [2026-09-27 hidden-window uploads](2026-09-27-hidden-window.md): native
  desktop, window hidden over five minutes; obsync's clock kept time (ten
  chained 100 ms timers in 2.8 s) and a change uploaded in 1.5 s (#221).
- [2026-09-26 final native phone acceptance](2026-09-26-phone-final.md): exact
  candidate desktop/phone co-typing; reactive rewrite hold, Resume and
  542-second quiet window; automatic fresh-note sync; phone restart;
  vault rename/move; phone typing through remote deletion; scoped cleanup.
  Interrupted and imperfect attempts, unmeasured notice behavior, and the
  partial desktop process-restart scope are retained explicitly.
- [2026-09-26 release preparation](2026-09-26-release-preparation.md): native
  desktop with an emulated mobile peer over disposable HTTPS; exact phone
  archive prepared, native phone acceptance still outstanding.
- [2026-09-25 editor refusal and merge budget](2026-09-25-editor-budget.md):
  retained matched-build typing failure, refused-write accounting repair,
  1,200-test gate, nested mutation reporting repair and qualified desktop
  rewrite control; repaired phone acceptance and cleanup remain outstanding.
- [2026-09-25 three-device typing follow-up](2026-09-25-passive-peer-typing.md):
  adjacent-block and passive-receiver failures, their automated repairs,
  mixed-build native controls, and the final phone installation checkpoint.
- [2026-09-25 native editor-save follow-up](2026-09-25-native-editor-save.md):
  retained same-line failures, adjacent-line passes, and the active-editor
  retry repair with its automated evidence and outstanding native gate.
- [2026-09-24 native desktop checks](2026-09-24-native-1.1.3.md) for the 1.1.3
  candidate.
- [2026-09-24 account recovery](2026-09-24-account-recovery.md): setup token
  plus recovery phrase re-enrollment.
- [2026-09-24 pairing and delete-versus-edit](2026-09-24-pairing-and-deletion.md).
- [2026-09-24 delete-versus-edit decision](2026-09-24-delete-edit-research.md):
  the edit-wins behaviour chosen, and how other tools document it.
- [2026-09-24 repeated-rewrite recovery](2026-09-24-rewrite-storm.md), with
  follow-ups for [the Resume copies](2026-09-24-rewrite-storm-resume.md),
  [a passive open editor](2026-09-24-rewrite-passive-editor.md) and
  [the typing editor's hold](2026-09-24-rewrite-editor-overlap.md).
- [2026-09-24 native iPhone acceptance](2026-09-24-phone-candidate.md): current
  1.1.2 installation, identical first sync, two-way edits, offline restart and
  automatic recovery.
- [2026-09-24 phone candidate 1.1.3](2026-09-24-phone-1.1.3.md): separate
  candidate installation and current native acceptance scope, with its
  [timing and first-sync follow-up](2026-09-24-phone-timing-followup.md).
- [2026-09-24 replacement-build device follow-up](2026-09-24-replacement-device-followup.md):
  exact repaired 1.1.2 desktop with the final 1.1.3 phone, identical offline
  notes and automatic recovery.
- [2026-09-24 review regressions](2026-09-24-review-fixes.md): the automated
  checks behind two review repairs.
- [2026-09-24 co-typing with delayed receipts](2026-09-24-cotyping-delayed-ack.md):
  pristine-baseline failure, deterministic reproductions and repair;
  simulation boundaries stated.
- [2026-09-24 co-typing publication order](2026-09-24-cotyping-order.md):
  delayed uploads, loop-budget regressions and retained failed schedules.
- [2026-09-24 historical catch-up and typing repairs](2026-09-24-history-and-typing.md):
  bounded history replay, adjacent line edits, same-line appends and preserved
  safety witnesses.
- [2026-09-24 screenshot privacy repair](2026-09-24-screenshot-privacy.md):
  opaque masks, metadata removal and unchanged visible evidence.
- [2026-09-24 arrival timing and shared merge bases](2026-09-24-arrival-and-shared-base.md):
  background Resume roles, continued typing, shared-text duplication and
  retained failed schedules.
- [2026-09-24 scenario battery, first sitting](2026-09-24.md): an iPhone and a
  desktop on one network, plus isolated desktop instances; what bears on 1.1.2.
- [2026-09-23 same network, a laptop as the server](2026-09-23.md): the Compose
  route end to end for 1.1.1, the phone's certificate install included.
- [2026-09-21 user journeys on 1.0.3, then 1.0.4](2026-09-21.md): a day's
  vault work over a private route, and the in-app plugin update.
- [2026-09-20 private route](2026-09-20.md): pairing and both edit directions
  on the 1.0.0 server over a private route to a cluster.
- [2026-09-14 same network](2026-09-14.md): the 1.0.0 server on the Compose
  route.

## Required fields

`docs/validation.md` requires every run to record device models, OS versions,
app versions, the server commit, and timings. In practice that is this header
plus one row per scenario:

- **Date and operator role.** The ISO date, and the role that ran it
  (`user`), never a person's name.
- **Route.** Kubernetes or Compose, per `docs/validation.md` "Routes", and the
  CLASS of TLS terminator in front of the server. The deployment's own tuple
  (proxy, route, certificate) stays with the person who runs it, not here.
- **Server.** The released version under test and the exact source commit the
  running image was built from.
- **Plugin.** The plugin version, and how it arrived: Settings -> Community
  plugins -> Browse, or Community plugins -> Check for updates. A manual file
  copy is not a production-path install, and a record of one says so rather
  than counting as an install result.
- **Devices.** One line per device: model, operating-system version, and
  Obsidian version (1.13.0 or newer). Devices are identified by ROLE -- "first
  desktop", "phone", "tablet" -- never by a device name, serial, or account.
  A field the run did not capture is written `not recorded during the run`
  and left there. Reading it off the device afterwards records TODAY's state
  as though it were the run's, and a value deduced from something else is a
  deduction, not an observation: both are worse than the gap they fill.
- **Scenarios.** Every scenario in `docs/validation.md` with `pass`, `fail`,
  or `not attempted`; the measured timing wherever the pass condition names
  one; and one sentence of what was observed. Silence is not a pass.
  The user journeys of that plan are recorded in this same file, as `J` rows
  beside the `V` rows and to the same standard.
- **What was not validated.** The explicit list, closing the record. It is the
  half a later reader trusts the record for.

## Requirement 11 applies to every line

No address, hostname, live-deployment URL, certificate detail, device
identifier, serial, account name, pairing code, setup token, or recovery
phrase -- not in the prose, not in pasted command output, not in a capture
referenced from here. Redact by role. A record that needs a private fact to be
legible is naming the wrong fact: name the class instead.
