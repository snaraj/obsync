# 2026-09-29 Revoked devices: the fold, and forgetting one (#247)

Agent-operated, for the user, on the user's computer, with a disposable
server and disposable vaults. None of the user's own vaults or devices took part.

## Why this shape

The shape was chosen against user voice, not taste: 17 data points from
Syncthing, Nextcloud, Plex, Microsoft, Apple, Dropbox and 1Password forums and
issue trackers, of which 12 ask for a per-row "forget"/"remove", 4 for devices
to expire on their own, 1 for inactive devices to be hidden, and 1 for a kept
audit history. None asked for revoked devices to stay in the one list. So the
fold answers the 1 and the 12 get **Forget**, which — because 1 asked for the
history — archives rather than destroys.

Three tests pin what a revoked device is answered, so no part of this could
quietly turn "forgotten" into "allowed":
`a_revoked_device_is_refused_from_that_moment` and
`a_revoked_or_pending_device_id_is_not_a_credential` carried it before this
change, and `an_archived_device_is_still_refused_as_revoked_and_still_named`
walks one device through revoke → `403 device_revoked` → archive → `403
device_revoked` again, with its name still on the list.

## Build and devices

- Source: the 1.1.5 train, lane E, branched from `afbf7e7` (release 1.1.4).
- Server: `obsyncd` built from this lane's head, SHA-256
  `60a1569d18aa6ce0…`, and, for the before-run and the compatibility run, the
  1.1.4 server at `afbf7e7`, SHA-256 `028611b6267b30f0…`. Both ran on this
  computer's loopback address over plain HTTP with `OBSYNC_EDGE=none`, on
  disposable journal and blob volumes, and each build opened the volumes the
  other had written.
- Plugin: 1.1.4 for the before-run, `main.js` SHA-256 `19d3202059551d72…`;
  this lane's head for the after-run, `main.js` SHA-256
  `6686f17bcdf5e7c77211b23003c4ef4ca563257ab0155c3ebbb0fc49a62923f4`.
  Installed by copying the three files into the vault and reloading the
  plugin, which is not a production-path install.
- Devices: two isolated Obsidian 1.13.4 instances on macOS 27 (Apple
  silicon), each with its own profile beside the user's own, and the
  dashboard in a `<webview>` on one of them, signed in with a one-time link
  the plugin minted.

## The list this run was recorded against

Built by the real flows, not by writing records: one device set up, then a
second device paired and used **Leave this server** twelve times, then paired
and abandoned twice, then paired once more. That left the shape the Android
record of 2026-09-27 found: **4 devices that sync, 12 revoked**.

## Before (1.1.4 build)

| Surface | Width | What a person saw |
| --- | --- | --- |
| Settings → Devices | 900 px | 4 working rows, then 12 revoked rows, then the summary. |
| Settings → Devices | 375 px | The same: the Devices group is 1964 px tall, 1164 px of it revoked rows between the working devices and **Device list**. |
| Dashboard → Devices | 1280 px | 16 rows, 12 struck through and tagged REVOKED. |
| Dashboard → Devices | 375 px | The same as cards, page 10389 px tall. |

## After (this lane's head)

| Surface | Width | Measured |
| --- | --- | --- |
| Settings → Devices, folded | 900 px | 7 rows shown of 19 (4 working, the fold, the summary, the heading); the 12 revoked rows measure 0 px. Group 494 px. |
| Settings → Devices, open | 900 px | 19 rows, the revoked ones 912 px. Group 1412 px. |
| Settings → Devices, folded | 375 px | Group 959 px, against 1964 px before: the whole group fits without scrolling past anything revoked. |
| Settings → Devices, open | 375 px | Group 2840 px, the revoked rows 1884 px, each with **Forget**. |
| Dashboard → Devices, folded | 1024 px | 3 working rows, `N revoked devices` and **Show**; page 900 px. |
| Dashboard → Devices, open | 1024 px | Every revoked row carries **History** and **Forget** and no **Revoke**; page 1404 px. |
| Dashboard → Devices, folded | 375 px | Page 2311 px, against 7366 px open; horizontal overflow 0 px either way. |

Keyboard and screen reader, on the real app: the fold's control is a button
that carries `aria-expanded`. Focused and driven with Enter twice, it read
`Show`/`false` → `Hide`/`true` (12 revoked rows shown) → `Show`/`false` (0
shown), and the focus stayed on the control across the tab's redraw. On the
dashboard the toggle carries `aria-controls="revoked-body"` and the same
`aria-expanded` and label change.

## Forgetting a device

A person presses **Forget**; the server ARCHIVES that device (`POST
/v1/devices/{id}/archive`). Nothing is destroyed, which is the point of the
runs below.

| # | Act | Outcome |
| --- | --- | --- |
| F1 | **Forget** on a revoked row in Settings | Asks first: "Forget Mac QNHZ · 4a291e6e?" naming that row, and saying it already cannot sync, goes on saying so, and keeps its name on what it wrote. Confirmed: the row is gone, the count and the summary follow, and the notice reads "Mac QNHZ · 4a291e6e is forgotten." |
| F2 | More, in Settings | The count fell one at a time, one notice each, 52 ms and 56 ms from the click to the notice. |
| F3 | A device revoked, then forgotten, watched on that device | Revoked, it read "This device was removed from your server…" and its request was refused `403 device_revoked`. Forgotten, it reads **the same**, and its request is **still** `403 device_revoked`: archiving keeps the record that answers it. Its note was still in its vault, and its Show sync status offered **Pair again**. |
| F4 | The other devices' lists, after F3 | That device was gone from Settings (10 rows listed of 11 on the wire) and from the dashboard, which said "1 forgotten device is not listed…". `GET /v1/devices` still carried it: `"revoked":true`, `"state":"revoked"`, `"archived":true`, `"name":"Mac 6V6W"` — so a 1.1.4 client, which does not read `archived`, still sees the revoked device it always saw, and history still has an author for what it wrote. |
| F5 | **Forget** on the dashboard | Asks first; **Confirm forget** sends one `POST /v1/admin/devices/{id}/archive`, the status line reads "Mac QNHZ is forgotten.", the row goes, the count follows, no error banner. |
| F6 | The 1.1.5 plugin against the 1.1.4 server | The route does not exist there (`404 not_found`). The person is told: "Mac QNHZ · 3f90cb13 was not forgotten: your server is too old to forget devices. Update it to obsync 1.1.5 or later, then try again." Nothing changed: the device stayed revoked and listed. |
| F7 | Server restart after archiving | Stopped and started again on the same volumes: 11 records, 3 archived, every archived one still `revoked` and still named. Nothing came back into the lists, and nothing was lost. |
| F8 | The 1.1.4 server on a journal holding archives | Started, replayed and served that journal: the flag rides the `device_update` frame 1.1.4 already applies, so it reads the frame as the no-op update it understands and keeps serving. |

The server logged one line per archive, e.g. `event=device_archived
device=985f4330 by_device=2b5667e8 decision=archived reason=revoked
duration_ms=10`, and the dashboard's carries `by=dashboard`. Across the runs
the durable write measured 5–16 ms and the whole request 13–37 ms.

## Whole-app sweep

On both instances at the end: 0 notices standing, the status item icon-only
with its words in the tooltip (`synced` on the device that syncs, `attention`
on the archived one), **Show sync status** saying the same thing as the status
item on both, the obsync settings tab drawing every group, and the plugin's own
warn lines limited to refusals this run provoked on purpose (the two
`action=forget reason=not_found` lines of F6, and the archived device's
`code=device_revoked`). No stacked, stale or contradictory surface.

One artefact of the driver, not of the product: running the sweep repeatedly
left three **Sync status** dialogs stacked, and the oldest still showed the
message the status had when it was opened. Opened once, the dialog says what
the status item says.

## The recovery capture, again

[Recovery](../recovery.md) showed a recovered device beside its revoked
predecessor in one list; with the fold, the predecessor is behind **1
revoked device**. The capture was taken again by the journey that page
describes, on one isolated instance and a disposable loopback server built
from this lane's later head (`obsyncd` SHA-256 `bba35b68a79e2e2e…`,
`main.js` SHA-256 `e02dea26a7b5bf5e…`):

1. Set up on an empty server; the recovery phrase confirmed in the dialog, so
   recovery was registered.
2. The device named **Laptop** by its **Name** row and **Save**.
3. **Revoke** on its own row: the dialog read "Revoke Laptop?", the server
   accepted revoking the only device because recovery was registered, and
   the plugin offered **Set up or recover**.
4. **Set up or recover** with the server's setup token and the vault key the
   vault kept: re-enrolled under a new device id (`event=account_recovered`
   on the server), and the status returned to idle.
5. Settings → **Devices**, **Show** on the fold, framed at 900 × 700 at the
   device's 1× scale, as the capture it follows was.

The two rows share the name Laptop and are told apart by "(this device)"
and "(revoked)", so no id is drawn and nothing needed covering. Read pixel by
pixel against the capture rules: no address, token, phrase, identifier or
note content; the window title names the disposable vault. The server logged
no sign-in and no dashboard link, and the rig's guard recorded nothing opened.
The file is `142-recovered-device-fold.png`, beside the capture it follows:
that one stays, because the [2026-09-24 record](2026-09-24-account-recovery.md)
shows the build it observed.

## Not covered

A phone (the settings tab was driven at 375 px through Obsidian's own mobile
emulation, not on a physical phone), Windows, and the reference deployment
routes. The dashboard was read in an Obsidian `<webview>` — Chromium, the
same engine this project's dashboard tests target — not in a standalone
browser.

- Opus5.5
