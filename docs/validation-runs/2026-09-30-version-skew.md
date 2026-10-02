# 1.1.5 beside 1.1.4: servers and devices on different versions — 2026-09-30

> **Superseded in part, 2026-10-01.** The pairing this run saw between a
> 1.1.5 device and a 1.1.4 one (`kex=legacy`, with a warning) no longer
> happens: 1.1.5 now refuses a device older than 1.1.5 in either role, and
> the creator's key crosses in `POST /v1/pairing/{id}/reveal`, not with the
> approval ([2026-10-01 pairing with a commitment](2026-10-01-pairing-commitment.md)).
> Everything else below stands as observed.

Run by an agent for the user, on the user's computer, with disposable
servers, disposable vaults and isolated Obsidian profiles. None of the user's own
vaults or devices took part.

People update the server and their devices at different times, so for a while
a 1.1.4 device syncs through a 1.1.5 server, or the other way round. The 1.1.5
CHANGELOG says what such a pair does. This run tries each of those claims in
both directions, and also going back from 1.1.5 to 1.1.4 on one device.

## Builds

- **1.1.5**: the train head `ffec3fb4`, built for this run.
  - `obsyncd` SHA-256 `8b4d13c38a8accd0ba8ee0ec769e25d8f1f46a30ed2943cdd90e717aef44f5d5`.
  - Plugin `main.js` SHA-256 `68a4e38e3fd8f89b015d91b8cdc014ca51b6cc45aed95efee962e97151c0dcd6`, `manifest.json` `ed84bd8d8d6f4e31…`, `styles.css` `43dd0db8ccce20e8…`.
  - Byte for byte the same as a second, independent build of the same head. The server reports `version=1.1.5`.
- **1.1.4**: built from the released 1.1.4 source.
  - `obsyncd` `cf8811cfe469f947…`.
  - Plugin `main.js` `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`, byte for byte the published 1.1.4 asset; `manifest.json` `7d6b4a71ec78f6f8…`; `styles.css` the same file as 1.1.5's.
  - The server reports `version=1.1.4`.
- **Servers**: on this computer's loopback address, plain HTTP, `OBSYNC_EDGE=none`. Each row started on fresh volumes, declared as 20 GiB of blobs and 8 GiB of journal.
- **Devices**: isolated Obsidian 1.13.4 instances on macOS 27.0 (Apple silicon), each with its own `--user-data-dir`, its own `HOME` and a fresh disposable vault holding sentinel text only, driven through its DevTools port. Twelve devices took part in all, never more than five at once.
  - The plugin was installed by copying its three files into the vault and reloading it in place. That is how a Community Plugins update lands, minus the download.
  - Obsidian 1.13.4 opens Settings as a window of its own; that matters for the finding at the end.

Match codes and pairing codes were compared inside the pages, never printed. Every quoted dialog below has its six-digit code masked as `•••`.

## Results

| # | Mixed pair | Outcome | What the screens said |
| --- | --- | --- | --- |
| 1a | 1.1.5 server; a **1.1.4** device sets up first, then makes the code; a 1.1.5 device claims it | pass: set up in 2.5 s, paired in 13.8 s | 1.1.4 creator: "Approve "Mac 3HVR" (Mac, obsync 1.1.5), asking since 07:38? Approve only if the new device shows the code •••. It will sync vault "rig-A5" (0 notes) with this server's vault." It says nothing about versions, and cannot. 1.1.5 claimant: "Waiting for approval on the other device. Its prompt shows the code •••: if it shows another, choose Reject there. That device runs an older obsync; update it so pairing can protect the code you shared." Afterwards, on the 1.1.4 device: "The new device, "Mac 3HVR", is paired: it holds the vault key now." |
| 1b | 1.1.5 server; a **1.1.5** device sets up first, then makes the code; a 1.1.4 device claims it | pass: set up in 2.3 s, paired in 8.7 s, logged `kex=legacy` | 1.1.5 creator: "Approve "Mac GQ2M" (Mac, obsync 1.1.4), asking since 07:43? Approve only if the new device shows the code •••. That device runs an older obsync; update it so pairing can protect the code you shared. It will sync …" Then: "approved "Mac GQ2M": it finishes pairing by itself, and obsync tells you here when it has." and ""Mac GQ2M" is paired: it holds the vault key now." 1.1.4 claimant: the code line without the version sentence, then "This device is paired. The first sync is running." |
| 1c | Control: two 1.1.5 devices through the 1.1.5 server | pass, logged `kex=v2` | Neither screen carries the version sentence. |
| 1d | Notes both ways, an edit, a rename each way, a delete, a folder rename each way, in 1a's pair and in 1b's | pass, 2 runs + 1 run | A note arrived 1.40–1.43 s after it was written and an edit 1.41–1.43 s. A rename arrived in 0.41–0.57 s, a delete in 0.90–0.91 s, and a folder rename in 0.53–0.58 s, or 2.0 s counting the note first written into it. Timed from the act, a write through Obsidian's vault API, to the file on the other device's disk. |
| 1e | Device count with one revoked device, on the 1.1.5 server | pass: 2 | Check on 1.1.5: "reached "obsync", 2 devices." Check on 1.1.4: "Reached "obsync", 2 device(s)." Before the revoke both said 3. The dashboard's Overview read Devices 2, and its Devices page listed the two working devices and "1 revoked device". |
| 1f | **Forget** from the 1.1.5 device; the 1.1.4 device's list | pass | Confirmation: "Forget Mac VWQW? Mac VWQW leaves this list for good. It already cannot sync, and it goes on saying so if somebody opens it; …". Then "Mac VWQW is forgotten." (archive 14 ms at the server). The 1.1.4 device, after pressing Refresh, still lists "Mac VWQW (revoked)" with "2 devices on this account, and 1 revoked.": on the wire the device is `"revoked":true,"archived":true`, and 1.1.4 does not read `archived`. The dashboard: "1 forgotten device is not listed. The server keeps each record to refuse that device by, and to name the versions it wrote." |
| 1g | The revoked and then forgotten device itself (1.1.4) | pass | Before and after the forget: "This device was removed from your server. Your notes and vault key are safe here. Pair it again from a device that still syncs: obsync settings, Pair this device." It learnt of the revoke at its next long poll, 41.5 s later. |
| 1h | A 1.1.4 device, told by a 1.1.5 server about the newer plugin | pass | "Self Hosted Private Sync 1.1.5 is available (this device runs 1.1.4). Open Settings → Community plugins → Check for updates." |
| 2a | 1.1.4 server; a **1.1.5** device sets up first | pass: set up in 2.4 s, a note written, the recovery phrase confirmed | Check: "reached "obsync", 1 device." Recent: "set up your server's vault; this device syncs with it." |
| 2b | 1.1.4 server; **Pair a new device** on a 1.1.5 device | pass: no code made, answered in 0.7 s, and the server logged no `POST /v1/pairing` from it | "Your obsync server runs a version older than 1.1.5, or does not say which, so no code was made. Update your obsync server to 1.1.5 or later, then pair again -- see Troubleshooting, "Pairing says to update your obsync server"." The device logged `pairing role=creator decision=refused reason=server_too_old server=1.1.4`. The same on a second device. |
| 2c | 1.1.4 server; a 1.1.4 device sets up first and makes codes for two 1.1.5 devices | pass: both paired, legacy | Each 1.1.5 claimant: the code line and "That device runs an older obsync; update it so pairing can protect the code you shared." |
| 2d | Notes both ways, rename, delete, folder renames through the 1.1.4 server: 1.1.5 with 1.1.4, and 1.1.5 with 1.1.5 | pass, 1 run each | A note arrived in 1.39–1.53 s, a rename in 0.45–0.51 s, a delete in 0.89–0.92 s, and a folder rename in 0.57–0.62 s (2.0–2.1 s counting the note first written into it). |
| 2e | Device count with one revoked device, on the 1.1.4 server | as claimed: the revoked device still counts | Check on 1.1.5: "reached "obsync", 3 devices." Check on 1.1.4: "Reached "obsync", 3 device(s)." The dashboard's Overview read Devices 3, and its Devices page listed the revoked device with REVOKED. Settings on the 1.1.5 device folded it: "2 devices on this account, and 1 revoked." |
| 2f | **Forget** on the 1.1.5 device, against the 1.1.4 server | pass: nothing changed | "Mac A7X3 was not forgotten: your server is too old to forget devices. Update it to obsync 1.1.5 or later, then try again." The server answered `404 not_found` and the device logged `device decision=refused action=forget reason=not_found duration_ms=3`. The row, the fold and the wire (`"revoked":true`, no `archived`) were unchanged. |
| 2g | **Leave** on the only device (1.1.5) of a 1.1.4 server, right after setup registered its recovery key | pass: no seven-day hold | "this device left the server; every note is still in this vault." |
| 3a | A 1.1.5 device switched to 1.1.4 in place: disabled, files swapped, enabled | pass: it loaded paired, with its credential, and read `idle` within 6 s | |
| 3b | …does it keep syncing | pass | 1.1.5 → it: 1.50 s. It → 1.1.5: 1.50 s. An edit from it: 1.40 s. |
| 3c | …the notification settings | ignored, and erased | Set to "Only what needs me" and "Recent only" on 1.1.5. 1.1.4 shows no Notifications rows. Its first save removed `notices` from the data file, together with `folderRemovals`, `departed` and `replaying`. Back on 1.1.5, Settings read "Everything useful" and "Once per note" (W3). |
| 3d | …a renamed Sync folder's removal not yet sent (#265) | dropped, as claimed | The device synced only `Proj` and `Shared`. Control, staying on 1.1.5: `Proj` was renamed to `Proj2` with the server stopped, the removal was written down (`{"Proj":["Proj","Shared"]}`), and after the restart and Sync now the empty `Proj` left both other devices (1.1.5 and 1.1.4). Treatment: `Proj2` renamed to `Proj3` with the server stopped, owed the same way, then switched to 1.1.4. `Proj3/p.md` reached both devices and the empty `Proj2` stayed on both. It went 100 s later, only when the 1.1.4 device widened its folders to the whole vault: 1.1.4's own reconcile then published the folder's deletion. |
| 3e | …where a note went while outside Sync folders (#239) | as claimed: published as a new note | On 1.1.5 the device moved `Shared/n.md` to `Out/n.md`, outside its folders, and recorded where it went. Switched to 1.1.4 and widened to the whole vault there, it published `Out/n.md` as a new note. Every device then held both `Shared/n.md` and `Out/n.md`. |
| 3f | …notes 1.1.5 was still bringing back (#281) | not reached | See below. |
| 3g | Back to 1.1.5 in place, same way | loads, paired, synced; it sent to the others; it then stopped receiving | That was the Settings-close stall (W1), met here first and later reproduced with no version change at all. After a restart of Obsidian it caught up and converged. |
| 4a | The 1.1.5 server's blob disk full (a filler on a 48 MB volume declared as 20 GiB): `507 storage_full`, faced by a 1.1.4 device | pass | 1.1.4: "Your server is out of storage, so it refuses new changes. Free space on the server or raise its quota. Sync resumes by itself." with the attention icon, from +5 s for 65 s. With room back and nothing pressed, its 3 MB note went up 204 s later. For comparison, 1.1.5: "… then select Sync now.", and it too went up by itself, 235 s later. |
| 4b | The 1.1.5 server's journal disk full (`507 storage_full` for every signed request) | not reached | The 16 KB left on the journal volume was never used up in 71 s: no request was refused. |
| 4c | A chunk upload answered `500 io_error` by the lab's hop, faced by a 1.1.4 device | 1.1.4 as it always was | 1.1.4 alternated between "offline — retrying" and "syncing 1 file" for 94 s, gave up after 8 attempts (`decision=gave_up attempts=8`), and logged `reason=500 unreachable`. For comparison, 1.1.5 read "syncing 1 file" and then, at +94 s: "Your server refused the change to "coded500-from-E5". obsync sends it again within five minutes, or at once when you select Sync now; if this stays, check your server's log." With the hop disarmed and nothing pressed, both notes arrived 90 s later. |

Two notes on row 4.

- Both devices reached this server through the lab's own Node HTTP hop, which forwards everything while no fault is armed. The server answered the 3 MB chunk `507` before reading its body and closed the connection. On the 1.1.5 device's first two attempts, the hop's upstream write failed with `EPIPE` and it answered a bare `502` instead, which 1.1.5 rightly reads as a proxy answering for a server that is gone: "offline — retrying" for 62 s before the 507 got through (W2). The 1.1.4 device's first attempt got the 507.
- Row 4 used only the 1.1.5 server. What a 1.1.4 server answers for a full disk (`500 io_error`, #291) is 1.1.4's own behaviour and not a mixed-version question.

## Whole-app sweep

Every rig was swept at the end of its row: A4, A5, B4, B5, B5b, BV, C5, D4, D5, D5b, E4 and E5. The sweep covers the notices on screen, the status item, **Sync now**, **Show sync status**, the obsync settings tab top and bottom, and the rig's console from launch.

- **Status item:** icon only on every rig, with its words in the tooltip. `synced` on the working devices. `attention` on the two revoked devices, each carrying "This device was removed from your server…". The status and **Show sync status** agreed on every rig.
- **Notices:** none left standing, except the revoked device's own notice after its **Sync now**.
- **Settings:** every group drew. The 1.1.4 rigs have no Notifications group, and the 1.1.5 rigs have one.
- **Console:** no error-level line on any rig. Every warning was one this run provoked: a rejected pairing, the server stopped on purpose, a revoked device's refusals, the refused Forget. There was also 1.1.4's own `GET /v1/files/… 404 unknown_file` at a first setup, which it shows against a 1.1.4 server too; 1.1.5 no longer does. `Uncaught "illegal access"` appeared only at a Settings-window close: on the rigs where W1 was probed (B5, B5b, and B4 on 1.1.4), and once more at the end of row 4's sweep, 3 on E4 (1.1.4) and 3 on E5 (1.1.5). After that one close, E4 still received a note in 0.7 s; E5 did not within 30 s.

Captures: masked, kept with the lab, not committed.

## Findings

- **W1 — a desktop that closes obsync's Settings window can stop receiving changes while it reads synced (#302). Blocks the release.**
  - On 1.1.5 with Obsidian 1.13.4, closing the Settings window with the window focused hands focus to the main window. That starts a disk walk (`scan decision=walk reason=focus`), and 3–4 `Uncaught "illegal access"` exceptions are raised in the same millisecond. The walk's reads never settle, and the engine's chain stays held (`holder=pass` or `holder=sweep`, `hostPasses=1`, `behind=1`).
  - The long poll still answers, but the page it brings waits behind the chain. Nothing more is applied. The status item keeps the check mark. After **Sync now** it reads "checking for changes, waiting for a check of this vault's files". The log warns at 110 s (`feed decision=stalled … chain=pass:110001`) and at 120 s. It stayed so for over ten minutes. A restart of Obsidian recovers it, and nothing was lost.
  - Counts: 9 of 15 such closes on 1.1.5 stalled, 0 of 4 on 1.1.4. 1.1.4 raised the same exceptions but kept receiving: its pulls do not wait behind the walk. Row 4's sweep added a tenth stall on 1.1.5 and a fifth receive on 1.1.4, from one close each.
  - A controlled series followed for the fix candidates. Each probe started a fresh Obsidian and counted only if the Settings window was focused at the close and the focus walk ran.
    - The train head stalled in 6 of 9.
    - A candidate that bounds every read of the walk at 15 s stalled in 0 of 8. Three of those eight met the same exceptions, logged `scan decision=stalled call=lstat duration_ms=15001 budget_ms=15000`, failed that walk, and received the note 13.5–13.6 s after it was written. The other five received in 1.2–1.5 s.
- **W2 — through the lab's hop, an early `507` on a chunk upload came back as a bare `502` (row 4). Does not block.** A 1.1.5 device read that as "offline — retrying" for about a minute. Whether nginx, Caddy or cloudflared do the same with a server that answers before it has read the body is still to be checked.
- **W3 — wording. Does not block.** Going back to 1.1.4 does not only ignore the notification settings: it erases them, so a return to 1.1.5 starts from the defaults. Suggested: "…ignores the new notification settings, and they are back at their defaults when you update again."
- **W4 — cosmetic. Does not block.** The refusal on an older server shows a literal `--` ("then pair again -- see Troubleshooting"), in the dialog and in its troubleshooting entry.

## Not covered

- **#281**: notes 1.1.5 was still bringing back after a Sync folder was added, when the device goes back to 1.1.4. It needs a replay caught mid-way, which this run did not arrange.
- **A full journal disk** (row 4b), and 1.1.4 facing `503 nonce_log_faulted` or `journal_faulted`. Those need a fault hook, and this run used none for them.
- **A recovering device on 1.1.4** after a server-side recovery reset.
- **Phones, Windows and Linux.** Also the reference deployment's terminator: every server here was reached on loopback, directly or through the lab's hop.
- **A real Community Plugins update.** The swap in rows 3a and 3g copies the same three files and reloads the plugin as Obsidian does, without the download.
- **1.1.3.** Every device and server here ran 1.1.4 or 1.1.5.

- Opus5.5
