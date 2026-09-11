# Device validation plan

Dated 2026-09-07. The MVP is validated when every step below passes on
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
Compose-plus-Caddy route (`deploy/compose`, README.md "Any network, no
provider") is the template for that path -- a private name, a private
certificate authority exported once and installed on each device, HTTPS
because mobile Obsidian accepts nothing else. A tunnel, a public hostname, or
a publicly trusted certificate are optional conveniences layered on top; each
is validated only if it is actually deployed, and never as a condition of
readiness.

## Install through the production path

On each required platform, open the intended vault and use Settings →
Community plugins → Browse → Private Sync → Install → Enable. Record the installed
version and match it to the reviewed, immutable release. Directory acceptance
is a prerequisite; a manual file copy, development preview or local archive
check does not satisfy this installation result. Use normally trusted HTTPS
for the production device campaign, with private connectivity when deployed.

Before setup or pairing, save the final **Sync folders on this device**
selection independently on each device. For a staged first sync in one
vault, keep personal files in an excluded staging folder and validate only
disposable notes inside the selected folder. After acceptance, move the
personal files into that selected folder and run **Sync now**. This needs
no expansion, state reset or re-pairing over existing files. Narrowing a
used selection is supported; expansion requires safe current-head resync,
which this version does not implement.

Validate a subsequent update using Community plugins → Check for updates.
Confirm the installed version, preserved pairing and folder selection, then
repeat bidirectional note sync. Local bundle equality is not native-update
evidence.

## Scenarios

| # | Scenario | Pass condition |
| --- | --- | --- |
| V1 | Setup on the first desktop; recovery phrase shown and confirmed | account visible in dashboard |
| V2 | Pair iPhone, iPad, Windows from the desktop | each shows in Devices with platform and country |
| V3 | Type in a note on iPhone | appears on the other three within 3 s |
| V4 | Rename and move a folder on Windows | mirrored everywhere, no duplicates |
| V5 | Edit the same note offline on two devices, reconnect | clean merge or a visible conflict copy, never a lost edit |
| V6 | Add a 2 GiB image on macOS | syncs to Windows; iPhone lists it as remote-only under the per-file ceiling |
| V7 | Add a 20 GiB archive on macOS over LAN; kill Obsidian mid-upload; reopen | resumes; fewer than 8 MiB re-sent |
| V8 | Delete a file on iPad | tombstone everywhere; restorable from history within retention |
| V9 | Revoke the iPad from the dashboard | its next request fails; other devices unaffected |
| V10 | Restart the server pod mid-sync | clients resume; `/readyz` truthful during replay |
| V11 | Fill the blob volume to the watermark | uploads refused with a visible message; nothing corrupted |
| V12 | Scrub with one blob corrupted by hand on the host | chunk quarantined, dashboard alert, client re-uploads |
| V13 | Off-LAN sync from iPhone over cellular, over the private path (VPN back to the network, or the deployed tunnel if one exists) | edits sync both ways with no public route in use |
| V14 | Dashboard from a phone browser | usable at 390 px wide |
| V15 | Compose path from scratch on a second machine: `deploy/compose` up, root certificate exported and installed, iPhone paired over the LAN | sync works with no provider, no public hostname, and no port reachable from the internet |

For V8, after verifying the original tombstone on the required devices, use
the native **Restore from history** command, find a retained content version
of that deleted note, and select **Restore a copy**. Verify the recovered
bytes under its new sibling name locally and after ordinary sync on the
other devices. Preserve and compare any current unsynced original before
and after the action. The deletion marker and original history must remain
unchanged. A local-copy notice or an operator API script alone does not
satisfy this native-device evidence.

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
commit, and timings in `docs/validation-runs/<date>.md`. Captures for the
README come from V2 and V3.
