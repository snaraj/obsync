# Device validation plan

Dated 2026-09-12. The MVP is validated when every step below passes on
iPhone, iPad, Windows, and macOS against the reference deployment, plus the
LAN path from a desktop.

## What readiness means (owner ruling, 2026-09-07)

The reference deployment is PRIVATE and owner-only: no public application,
no public DNS record, no public route. Readiness is real sync between the
owner's own devices -- including OFF-LAN connectivity over a private path --
together with the authentication, revocation, isolation and recovery checks
below. **Public reachability is not an acceptance criterion**, and no
scenario here passes or fails on whether this server can be reached from the
internet.

So the private path is validated FIRST: the devices reach the server over the
LAN, or over a VPN back to it, with a certificate the phone trusts. The
Compose-plus-Caddy route (`deploy/compose`, `docs/server.md` "Any network, no
provider") is the template for that path -- a private name, a private
certificate authority exported once and installed on each device, HTTPS
because mobile Obsidian accepts nothing else. A tunnel, a public hostname, or
a publicly trusted certificate are optional conveniences layered on top; each
is validated only if it is actually deployed, and never as a condition of
readiness.

## Install through the production path

On each required platform, open the intended vault and use Settings →
Community plugins → Browse → Self Hosted Private Sync → Install → Enable. Record the installed
version and match it to the reviewed, immutable release. Directory acceptance
is a prerequisite; a manual file copy, development preview or local archive
check does not satisfy this installation result. Use normally trusted HTTPS
for the production device campaign, with private connectivity when deployed.

Before setup or pairing, save the final **Sync folders on this device**
selection independently on each device. For a staged first sync in one
vault, keep personal files in an excluded staging folder and validate only
disposable notes inside the selected folder. After acceptance, move the
personal files into that selected folder and run **Sync now**. Both
directions are supported afterwards: narrowing keeps the local files and the
cursor, and widening replays the history this device skipped so the files
under a newly selected folder arrive. Neither needs a state reset or
re-pairing.

Validate a subsequent update using Community plugins → Check for updates.
Confirm the installed version, preserved pairing and folder selection, then
repeat bidirectional note sync. Local bundle equality is not native-update
evidence.

## Scenarios

| # | Scenario | Pass condition |
| --- | --- | --- |
| V1 | Setup on the first desktop; recovery phrase shown and confirmed | account visible in dashboard |
| V2 | Pair iPhone, iPad, Windows from the desktop | each shows in Devices with platform; country is shown only when supplied by the deployed edge (a dash is expected with `OBSYNC_EDGE=none`) |
| V3 | Type in a note on iPhone | appears on the other three within 3 s |
| V4 | Rename and move a populated folder on Windows, including a folder that IS a selected sync folder on that device | mirrored everywhere, no duplicates, no deletions in the journal; the selection names the new path. The note-level half is proven: [issue #96](https://github.com/snaraj/obsync/issues/96) shipped in 1.0.4, and the [2026-09-21 run](validation-runs/2026-09-21.md) renamed a synced note in BOTH directions with both devices on 1.0.4 and saw a move, not a deletion. The Windows folder scenario itself is still `not attempted`: no run has been made on Windows |
| V5 | Edit the same note offline on two devices, reconnect | clean merge or a visible conflict copy, never a lost edit |
| V6 | Add a 2 GiB image on macOS | syncs to Windows; iPhone lists it as remote-only under the per-file ceiling |
| V7 | Add a 20 GiB archive on macOS over LAN; kill Obsidian mid-upload; reopen | resumes; fewer than 8 MiB re-sent |
| V8 | Delete a file on iPad | tombstone everywhere; restorable from history within retention |
| V9 | Revoke the iPad from the dashboard | its next request fails; other devices unaffected |
| V10 | Restart the server pod mid-sync | clients resume; readiness is unavailable during startup replay and becomes successful only after replay completes |
| V11 | Fill the blob volume to the watermark | uploads refused with a visible message; nothing corrupted |
| V12 | Scrub with one blob corrupted by hand on the host | chunk quarantined, dashboard alert, client re-uploads |
| V13 | Off-LAN sync from iPhone over cellular, over the private path (VPN back to the network, or the deployed tunnel if one exists) | edits sync both ways with no public route in use |
| V14 | Dashboard from a phone browser | usable at 390 px wide |
| V15 | Compose path from scratch on a second machine: `deploy/compose` up, root certificate exported and installed, iPhone paired over the LAN | sync works with no provider, no public hostname, and no port reachable from the internet |
| V16 | Native credential persistence on each required platform, after fresh setup and after upgrading legacy paired state | restart Obsidian; the same device resumes bidirectional sync without setup or re-pairing, preserving folder selection |
| V17 | Create an EMPTY folder on the desktop | it appears on the phone within 3 s, still empty, and no file is created inside it |
| V18 | Create an empty folder on the phone | it appears on the desktop; the same result in the other direction |
| V19 | Create a nested empty chain (`A/B/C`) on one device | all three appear on the other, in one tree |
| V20 | Delete a folder holding notes on the desktop, one level and then a three-level nest | the notes and the whole empty tree are gone on the phone; a sibling folder that still holds a note is untouched |
| V21 | Delete a folder on the phone | it is gone on the desktop; the same result in the other direction |
| V22 | Rename a folder holding notes on one device | renamed on the other, notes inside keep their content and their history, no duplicate folder under either name |
| V23 | Rename an EMPTY folder on one device | renamed on the other; the old name is gone |
| V24 | On device A put an extra file into a folder that device B then deletes | B's deletion removes the notes; A keeps the folder AND the extra file, and says so in the log (`folder … decision=kept reason=not_empty`) |
| V25 | Two devices already holding a vault made before 1.1.0, both updated, both restarted | every existing folder converges without the user doing anything; the folders each device already had appear on the other |
| V26 | A third device left on 1.0.4 while the other two are on 1.1.0 | it shows one refusal notice per folder and keeps syncing NOTES normally; no file is created at any folder's path; no tombstone is published for anything; updating it makes the folders appear and the notices stop |
| V27 | On the 1.0.4 device, delete the last note out of a folder and KEEP the folder | the 1.1.0 devices delete the note and keep the folder: a device that says nothing about a folder never deletes it |

V17-V27 are the folder-sync scenarios for 1.1.0 (issue #104). Run each in
BOTH directions — desktop to phone and phone to desktop — and record which
device originated each one, because the two platforms use different host
primitives: desktop makes and removes folders through Node's filesystem after
the component walk, mobile through the vault adapter. For V20 and V24, record
what the file explorer shows on the receiving device AFTER a restart of
Obsidian as well, since a stale explorer pane is not a sync result. For V26 and V27,
record the exact notice text, the plugin version on each device, and that the
old device's own notes still sync in both directions while it is refusing.

V4 covers renames wholly inside the selection; the same rename seen from a
second device is J4 below, and a move that leaves the selection is J6.

For V16, record the Obsidian version (at least 1.13.0), plugin version and redacted before/after device identity. Confirm native secret storage is available and ordinary plugin metadata contains references, not the vault key, device secret or edge-token values. Do not enumerate native secret entries or record their contents. Local host stubs prove migration and failure handling only; they do not satisfy native application restart persistence.

V7 and V12 remain unproven acceptance requirements. The configured concurrent uploads do not establish the V7 retransmission bound. The client repair implemented for [issue #51](https://github.com/snaraj/obsync/issues/51) must pass the isolated scrub and required native-device scenarios below before V12 can pass; local synthetic tests alone do not establish that result.

For V8, after verifying the original tombstone on the required devices, use
the native **Restore from history** command, find a retained content version
of that deleted note, and select **Restore a copy**. Verify the recovered
bytes under its new sibling name locally and after ordinary sync on the
other devices. Preserve and compare any current unsynced original before
and after the action. The deletion marker and original history must remain
unchanged. A local-copy notice or an operator API script alone does not
satisfy this native-device evidence.

For V12, use an isolated disposable file and an explicitly authorized storage
fault; never alter an owner's existing blob merely to exercise this scenario.
Record whether a healthy mirror repaired the chunk or the server quarantined
it and removed its SID from inventory. To prove client restoration, keep a
matching, already synchronized local copy unchanged, observe its automatic
repair, and verify the restored bytes from another device. Compare the file
identity, heads, version history and deletion state before and after. Retain
the scrub/quarantine evidence. A source that is absent or edited must remain
an explicit unresolved result, not a successful repair.

The background client walk checks one bounded unit per second and rests five
minutes between walks; **Sync now** advances one unit. Desktop range reads can
repair chunks of large files. The non-streaming Obsidian adapter, including
mobile, refuses automatic content reads when the whole local file exceeds
8 MiB and reports that it needs a matching source on a device with safe range
reads. Record that capability limitation explicitly; it does not satisfy
large-file restoration using only non-streaming devices, and it does not
waive V12 or replace real-device results with a synthetic test.

## User journeys

The scenarios above prove the protocol. The 2026-09-20 device run showed what
they leave out: the journeys a person performs on day one -- the first note,
the first folder rename, the first relaunch -- were not in the plan at all, so
a run could pass every V row and still ship a plugin that loses a folder the
first time someone reorganises one. The journeys below are that half. They are
written for a stranger with no knowledge of any particular deployment: each
needs two real devices in one account, one desktop and one phone, and nothing
else. The acting device is named first.

| # | Journey | Pass condition | Devices |
| --- | --- | --- | --- |
| J1 | Create a note on the phone | the desktop shows the note under the same name with the same bytes, with no action taken on the desktop | phone acts, desktop observes |
| J2 | Create a note on the desktop | the phone shows the note under the same name with the same bytes, with no action taken on the phone | desktop acts, phone observes |
| J3 | Rename the vault folder on the desktop, then reopen that vault | the plugin is still paired: no setup token, no pairing code, the same one device in Devices, the same folder selection; an edit made after the reopen reaches the phone | desktop acts, phone observes |
| J4 | Rename a selected folder on one device | the other device lists that folder under its new name holding the same file names and the same bytes; the file count matches; nothing is deleted and nothing lands in trash | either device acts, the other observes |
| J5 | Move a note between two selected folders | the other device shows exactly one copy, under the destination folder only, with the same bytes | either device acts, the other observes |
| J6 | Move a note out of the selected folders | the plugin asks before the move takes effect and names the consequence for the other device in that prompt; the answer given is the outcome observed, and nothing is removed anywhere without it | either device acts, the other observes |
| J7 | Create a new top-level folder after pairing, then add it to the selection on that same device | the folder is offered in **Sync folders on this device** and the saved selection survives a restart; its notes then sync, or the plugin states in the UI why an expanded selection is refused. Either way every already-selected folder keeps every file | either device acts, the other observes |
| J8 | Quit and relaunch Obsidian on both devices | each device returns to idle on its own, with no tap, no **Sync now**, and no setup or pairing prompt; record the time each took | both devices act |
| J9 | Open a vault that also holds a large non-note folder tree (record the file count and total size) | the vault opens and the plugin reaches idle within a recorded time, or it says why not in one visible line naming the budget it exceeded and what it skipped (requirement 12); silence, a hang, or an unexplained partial scan is a fail | desktop acts, phone observes |
| J10 | Unpair the device, then pair the same vault again | every local note is still on disk with unchanged bytes, the device appears exactly once in Devices, and sync resumes both ways; no duplicate note and no conflict copy | either device acts, the other observes |

Every release whose range touches `plugin/` or the server's sync path -- the
chunk, change, and file handlers in `crates/obsyncd/src/api/` and the storage
they call -- runs the affected journeys on real devices before it ships and
records their outcomes in [`docs/validation-runs/`](validation-runs/README.md),
in the existing format: one row per journey with `pass`, `fail`, or
`not attempted`, the measured time wherever the pass condition names one, and
one sentence of what was observed. Silence is not a pass here either.

Requirement 11 governs those rows as it governs every other line of a run
record. A journey row names CLASSES -- "desktop", "phone", an operating-system
version, a plugin version, a folder count -- and never a device name, serial,
account, hostname, address, vault name, or note title from anybody's real
vault. A journey that needs a private fact to be legible is naming the wrong
fact: use disposable notes and name the class.

## Routes

Two independent routes to a validated MVP, and either one alone satisfies
readiness for the scenarios it covers:

| Route | Terminator | Reachability | Proven continuously by |
| --- | --- | --- | --- |
| Reference (pie5) | an in-cluster TLS terminator the platform trusts, in front of the pod; `OBSYNC_EDGE=none`. The deployment's own tuple (proxy, route, certificate) lives in the platform runbook, not here | private, owner-only: the LAN, or the owner's private route back to it; no public application, no access broker | the deployment itself; V1-V14 by hand |
| Compose path | Caddy in `deploy/compose`, `OBSYNC_EDGE=none` | private name, private CA, published only on the chosen `OBSYNC_BIND_ADDRESS` | `scripts/ci/compose-smoke.sh`, on every pull request |

The Compose path is the no-provider route: it needs no account with anybody
and nothing reachable from the internet, and unlike the reference deployment
its serving path is re-proven on every pull request rather than by hand. Its
"no public exposure" is an assertion and not a hope: the smoke reads back the
`HostIp` Docker published 80 and 443 on and refuses any address but the one
`OBSYNC_BIND_ADDRESS` selected, and refuses the compose file itself if that
variable is optional. V15 is where a person confirms on real devices what
that smoke proves on a runner.

Every run records device models, OS versions, app versions, the server
commit, and timings in one file per run under
[`docs/validation-runs/`](validation-runs/README.md), named `<date>.md` for
the date the run started; that README holds the required fields and the
redaction rules. The README's five captures are taken during the run -- 01 from
the production-path install above, 02 and 03 from V1, 04 from V2, 05 from V3
-- and are committed under [`docs/captures/`](captures/README.md) by
the convention recorded there.
