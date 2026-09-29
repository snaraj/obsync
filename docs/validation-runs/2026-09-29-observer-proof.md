# What an inspecting network sees — 2026-09-29

The owner's requirement: a person using Obsidian on a work laptop, behind an
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
- Plugin `main.js` SHA-256 `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`,
  built from `afbf7e7`. This lane changes no `plugin/src`, so the plugin build
  is byte-identical before and after the lane's work.
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

## Not covered here

- The recording hop is not yet wired into the CI real-Obsidian run
  (`desktop-matrix.yml`); the scanner's per-encoding coverage IS proven every
  PR by `scripts/ci/test_observer.py`. A recipe to add the live leg is in the
  lane hand-off.
- Windows, Linux and phones: the plugin's encryption is platform-identical
  (`plugin/src/crypto.ts`), unmeasured on those devices in this run.
- The account-recovery finding above is fixed by another change in this
  release and proven in its own record.
