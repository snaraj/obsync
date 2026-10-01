# What an inspecting network sees — 2026-09-29

The user's requirement: a person using Obsidian on a work laptop, behind an
employer's VPN, must not expose their notes. This run proves, on a byte
capture of a real session, that an employer's TLS inspection or a VPN that
terminates TLS sees only metadata and ciphertext — never note content, file or
folder names, the vault key or the recovery words — and audits what a party who
DOES capture a device secret at setup or pairing can do without the vault key.

## Setup

- Obsidian 1.13.4 (Electron 43.1.1, Chromium 150), macOS 27.0 on Apple
  silicon, two isolated desktop profiles (rig A, rig B) each with its own
  `--user-data-dir` and disposable vault.
- Server: a disposable loopback `obsyncd` on `127.0.0.1:18801`, `OBSYNC_EDGE=none`,
  plain HTTP; the build at `afbf7e7` (release 1.1.4, this train's base).
- Run 1 (the scan and audit below): plugin `main.js` SHA-256
  `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`, built
  from `afbf7e7`. Run 2 ("Pairing v2, live"): plugin and `obsyncd` built from
  `26361c8`, the pairing key exchange (`main.js`
  `72cd7378b81f908b88b34c25fbb104d054f85f6b73ae232c4ada05be620e60ed`,
  `obsyncd` `c13a018e7b54b91e2dc0ed81336dd13d48cb5a58ce85ae3ad697a823ae69f12a`),
  with the `afbf7e7` builds on one side for the version-skew legs. Run 3
  (the final head, `64abf24`): the plugin rebuilt (`main.js`
  `5a856ea67dcb613ef997e683199ce01895d2c68b51afbad4e541e71ef6a8c1ff`), the
  same `obsyncd` (no server change after `26361c8`). Run 4 (the user's
  ruling, `e6b19a7`): the plugin rebuilt (`main.js`
  `3f8e51114c831484ceeefd534676231fe16047f747a60e94f4c39402282ff73e`), the
  same `obsyncd`, and a bundle whose `manifest.json` says 1.1.5, as the
  release's will (no version is bumped in this change). Every rig ran with a
  HOME of its own, so Obsidian's CLI socket was the rig's; the check after
  each launch found it under the rig's HOME.
- The recording hop `scripts/ci/observer.mjs` sat between the plugin and the
  server: both rigs pointed their Server URL at the hop
  (`127.0.0.1:18802`), which recorded every byte in each direction and
  forwarded to the server. The captured bytes are exactly what a
  TLS-inspecting proxy holds after it decrypts — TLS is only the envelope
  around them (`docs/threat-model.md` residual risk 4, the terminator→server
  hop is itself plain HTTP).
- Lab and scripts: `/Users/samuel/.claude/jobs/fd5a687c/tmp/lab-G/`.

## What the session did (all through the hop)

First-device setup with the recovery phrase; pairing of a second device with
its match code; notes with sentinel CONTENT and sentinel FILE and FOLDER names
in ASCII and Unicode; a binary attachment; a rename/move; a delete; edits both
ways; divergent (fork) edits; a dashboard login-link mint; then Leave on the
second device (a device revoke) and pair it again (a second pairing envelope).
17 TCP connections, 152 requests and 150 responses were captured.

## The scan

`scripts/ci/observer.mjs scan` reassembled the capture into HTTP exchanges
(bodies de-chunked and decompressed, targets percent-decoded, JSON walked and
every base64/hex string decoded a level deeper, all header values searched) and
searched every view for 27 needles in 342 encodings: the 14 session sentinels;
the vault key read from rig A into a `0600` file; the domain-map, domain and
manifest keys derived from it; the 24-word recovery phrase (derived from the
vault key with the shipped BIP-39 list); and a captured pairing code with the
pairing secret decoded from it. Needle values were never printed.

## Observed

1. **Zero leaks.** `DECISION PASS (zero needle hits)`. No sentinel content or
   name, in UTF-8 (NFC/NFD), UTF-16LE/BE, hex, base64, base64url, base32,
   percent-encoding or a JSON `\u` escape, and no vault key, derived key,
   recovery word or pairing secret, appears anywhere in the capture.
2. **The scan is not vacuous on this capture.** A positive control that
   searched the SAME capture for values that ARE present as metadata — the
   platform word `macos` and the user-agent `obsidian/1.13.4` — returned
   `FAIL`, catching both (the second only after the scanner was fixed to search
   header values, not just the request line). So a leak, had there been one,
   would have been caught here.
3. **What IS visible to the hop**, and matches `docs/threat-model.md`: the
   routes (`POST /v1/setup`, `/v1/pairing…`, `/v1/files/{id}/versions`,
   `/v1/chunks/…`, `/v1/changes`, `/v1/devices…`, `/v1/dashboard/login-link`,
   `/v1/account/recovery`, …), request and response header names, JSON field
   names, message sizes, timing and counts, the device names, platforms, app
   versions and addresses, and the user agent. The credentials that cross in
   clear: the device HMAC signature on every request, the `device_secret` in
   the setup and claim RESPONSES, the setup/enroll token in the setup and claim
   REQUESTS, and the dashboard login-link URL (which carries a token).
4. **Whole-app visual sweep.** With the hop up, both rigs' status item read
   `obsync: idle` / state `synced`, fixed-width icon-only, no text jitter, and
   each vault held the synced sentinel files. Zero open notices on either rig.
   With the hop taken down, both status items truthfully read
   `obsync: offline — retrying` (state `offline`) and returned to `idle` when
   the hop came back — the status is honest about reachability. No stacked,
   stale, contradictory or alarming UI. Guarded settings screenshots:
   `lab-G/logs/sweep-A-settings.png`, `sweep-B-settings.png`.

## The device-secret integrity audit (live)

A separate clean disposable server (`127.0.0.1:18811`) and a stdlib probe
(`lab-G/scripts/integrity_probe.py`) minted an ACTIVE device via `/v1/setup` —
the secret an inspecting proxy captures at setup — enrolled a victim device
through pairing (no vault key needed; the server stores opaque envelope bytes),
and then, acting as the attacker with the setup device's secret ALONE and no
vault key, exercised each device-authenticated route:

| Attempt (device secret only, no vault key) | Result | Class |
| --- | --- | --- |
| Rename any device (`PATCH /v1/devices/{id}`) | `200` | account control (recoverable) |
| Shrink any device's mobile ceiling / budget | `200` | DoS of that device's uploads (recoverable) |
| Tombstone another device's file (garbage manifest) | `201` new head | clutter / forced-conflict on the server; a keyed device REFUSES it as `undecryptable` and keeps its note (`plugin/test/vault-identity.test.mjs`) |
| Revoke another device (documented: any paired device may) | `204` | that device must pair again (recoverable) |

The account-recovery routes also accept a device secret alone. At 1.1.4 one
combination of them could keep the owner out of their own account; it was
reported privately and is fixed in 1.1.5, and its steps are deliberately not
recorded here. The residual after the fix is in `docs/threat-model.md`.

The confidentiality counterpart holds by construction: a change not sealed with
the vault key is refused by every keyed device (`undecryptable`), the note is
left untouched, and the user is told which device sent it
(`plugin/test/vault-identity.test.mjs`). So a device-secret-only party can
disrupt availability and control the account, but can never read, forge, or
silently alter a note.

## Pairing v2, live (1.1.5)

The same two rigs and the same recording hop, on the `26361c8` builds.

1. **Both 1.1.5.** Setup, the sentinel notes, and a pairing: the approval
   question and the new device showed the same match code (429 636) and no
   warning. Then a rename and an edit on B, a delete on A, a dashboard
   login-link, Leave on B, and a second pairing (986 387 on both screens). The
   capture: 8 connections, 124 requests, 122 responses. The scan searched it
   for 25 needles in 312 encodings (the 14 sentinels, the vault key and its
   derived keys, the recovery phrase, and BOTH pairing codes with the pairing
   secret decoded from each): `DECISION PASS (zero needle hits)`. The positive
   control on the same capture (`macos`, `obsidian/1.13.4`) returned `FAIL`.
   The two exchange keys crossed as JSON fields `claimant_pub` (claim) and
   `creator_pub` (approve, and once with the envelope); no pairing secret did.
2. **1.1.5 creator, 1.1.4 new device** (server `26361c8`). The approval
   question read "… Approve only if the new device shows the code 717 607.
   That device runs an older obsync; update it so pairing can protect the code
   you shared. …", the new device showed 717 607, the creator logged
   `kex=legacy`, and a note synced each way. Leg 4 showed the same words when
   the SERVER was the older side; run 3 widened them to "That device, or your
   obsync server, …", and run 4 narrowed them back, because since the ruling
   an older server is refused before any code exists.
3. **1.1.4 creator, 1.1.5 new device** (server `26361c8`). The new device's
   screen read "Waiting for approval on the other device. Its prompt shows the
   code 751 374: … That device runs an older obsync; update it so pairing can
   protect the code you shared.", the creator showed 751 374, and both paired.
   In the first of five runs of this leg, rig A's (1.1.4) change feed stopped
   applying after its own first upload and the note from B never arrived; the
   other four runs synced both ways. See "Found on the way".
4. **Both 1.1.5 on a 1.1.4 server** (server `afbf7e7`). The old server drops
   both key fields. The creator showed the legacy code 616 320 with the
   warning; the new device, which read the 1.1.5 marker in its code, showed
   183 406. Approved anyway, the new device refused the envelope ("This device
   could not open the vault key it was sent: … Nothing was shared."), removed
   itself (`device_revoked … by_device=<itself>`), and stayed unpaired: it
   failed closed, but late, and the creator still announced it as paired.
   The user's ruling moved the refusal before any code (run 4, below).
5. **The final head** (`64abf24`, run 3). Leg 1 again: 170 940 and then
   462 718 on both screens, no warning; the scan: 10 connections, 100
   requests, 98 responses, 26 needles in 325 encodings,
   `DECISION PASS (zero needle hits)`; the positive control `FAIL`. Leg 4
   again: the creator's question now read "… Approve only if the new device
   shows the code 670 130. That device, or your obsync server, runs an older
   obsync; update it so pairing can protect the code you shared. …", the new
   device showed 403 072, and an approval anyway ended as before (refused,
   removed, unpaired). An earlier scan at this head FAILED on two single
   recovery words, each of which is a field name of the device list the
   server returns (checked against the scan's own list of visible field names;
   the words are not recorded here). The scanner now leaves out a single
   recovery word that is the protocol's own vocabulary in that capture and
   names it; the whole phrase stays a needle, and a word that is not
   vocabulary is still caught (`scripts/ci/test_observer.py`).
6. **Visual sweep** (rigs of leg 2): status items `obsync: idle` / `synced` on
   both, zero notices, Show sync status complete on both (the new device also
   lists its unconfirmed recovery phrase), Settings rendered; each rig's
   starter window was closed after the vault opened and each Settings window
   after use. Guarded captures: `lab-G/results/sweep-b1/`.

What the unit tests prove and this run does not: that the pairing secret
alone does not open a v2 envelope, that a substituted or stripped exchange key
changes the match code, and that a malformed key is refused
(`plugin/test/pairing-v2.test.mjs`, mutants M3510-M3513).

## The user's ruling, live (run 4)

The ruling: a server older than 1.1.5 is refused before any code exists
("fail closed, say it early"), and the creator says "paired" only once the new
device kept the key.

1. **1.1.5 creator on a 1.1.4 server** (server `afbf7e7`, whose bundle
   reports 1.1.4). **Pair a new device** showed only "Your obsync server runs
   a version older than 1.1.5, or does not say which, so no code was made.
   Update your obsync server to 1.1.5 or later, then pair again -- see
   Troubleshooting, "Pairing says to update your obsync server"." No code on
   screen, `POST /v1/pairing` 0 times in the server log, and the creator
   logged `pairing role=creator decision=refused reason=server_too_old
   server=1.1.4`. Capture (no code on screen, proved before capturing):
   `lab-G/results/sweep-r3/b3-refused-A.png`.
2. **The creator's word matches the new device's outcome** (both 1.1.5, server
   `e6b19a7`). B held a note the server lacked, so it asked before keeping
   the key. B answered Cancel: B said "Pairing cancelled: nothing was
   uploaded, and this device was removed from the server again." and the
   creator said "The new device did not keep the vault key and removed itself
   from the server: …" with no paired notice (`decision=failed
   reason=key_not_kept polls=1`). Paired again, B answered Pair and upload:
   the creator said "The new device, "Mac 5Q67", is paired: it holds the vault
   key now." after B's first sync (`decision=paired polls=1`), and a note
   crossed each way.
3. **Both 1.1.5 on a 1.1.5 server, with the scan.** Leg 1 again: 961 490 and
   then 614 484 on both screens, no warning, both rigs `idle` / `synced` with
   zero notices; the scan: 10 connections, 106 requests, 104 responses, 22
   needles in 277 encodings, `DECISION PASS (zero needle hits)`; the positive
   control `FAIL`.

## Found on the way

- **A byte-identical conflict copy after Leave and pairing again** (run 2, leg
  1): `OBSGSENTINELrenamedzzz (conflict from Mac ZJBQ, 2026-09-29 1352).md`
  beside `OBSGSENTINELrenamedzzz.md` on both rigs, same SHA-256. The same
  sequence did not reproduce it on `afbf7e7` (one run), on `26361c8` (one
  more run) or on `64abf24` (one run whose listing was kept; a second run
  there tracked four files where three are expected, but its listing was not
  kept).
- **A 1.1.4 desktop's change feed stopped** (leg 3, one run of five, machine
  load average ~115 on 10 cores): its long poll returned its own new version
  at the same millisecond as the upload's answer, and from then on the feed
  never asked again (engine running, no poll outstanding, cursor one change
  behind, Sync now still waiting after 15 s). The feed code is unchanged in
  1.1.5.

## Not covered here

- The recording hop is not yet wired into the CI real-Obsidian run
  (`desktop-matrix.yml`); the scanner's per-encoding coverage IS proven every
  PR by `scripts/ci/test_observer.py`. A recipe to add the live leg is in the
  lane hand-off.
- Windows, Linux and phones: the plugin's encryption is platform-identical
  (`plugin/src/crypto.ts`), unmeasured on those devices in this run.
- The account-recovery finding above is fixed by another change in this
  release and proven in its own record.
- Pairing v2 against an interceptor that rewrites traffic: covered by the unit
  tests and mutants named above, not by a live leg.
