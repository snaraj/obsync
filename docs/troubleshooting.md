# Troubleshooting

Every failure below is one the plugin or the server states out loud. Find the
symptom, read the cause, apply the fix. If none of them match, the last section
says how to collect a report worth sending.

The status bar is the first thing to read: `obsync: not paired` before setup,
`obsync: idle` when there is nothing to do, `obsync: syncing <n>` while `n`
files are in flight, `obsync: offline` when the server cannot be reached, and
`obsync: error — <reason>` when sync has stopped on purpose.

## The status bar says `offline`

**Symptom.** `obsync: offline`, and nothing syncs in either direction.

**Cause.** The device cannot reach the server at the **Server URL** in
settings, or reaches something that is not it.

**Fix,** in the order that finds it fastest:

1. Open that URL in a browser on the SAME device. A dashboard sign-in page
   means the address and the certificate are fine and the problem is elsewhere.
2. Check the port. A server published on a port other than 443 must carry it in
   the Server URL: `https://name:8443`.
3. Check the scheme. Obsidian on iOS and Android speaks HTTPS only and refuses
   plain HTTP outright.
4. Check the route. If the server is on a LAN or behind a VPN, the device has
   to be on that network, and the name has to resolve there — see the README's
   "Reaching it from outside your LAN".
5. Check the server: `GET /readyz` answers `{"ready":true,"seq":<n>}` when it
   is serving. If it answers `not_ready`, read the volume section of
   [`storage.md`](storage.md) — the server refuses readiness rather than lying
   about it.

## The certificate is not trusted on this device

**Symptom.** `obsync: offline` on one device while another syncs, or a browser
on that device warning about the certificate.

**Cause.** The deployment uses a private certificate authority and this device
has never been told to trust it. Trust is per device, and on iOS it is two
steps rather than one.

**Fix.** Install the root certificate, then confirm trust:

- **macOS:** add it to the System keychain and mark it trusted.
- **iOS and iPadOS:** install the profile, THEN turn the certificate on under
  Settings, General, About, Certificate Trust Settings. Obsidian fails until
  that second step is done.
- **Android:** install it as a CA certificate under Settings, Security,
  Encryption & credentials. Android keeps user-installed authorities separate
  from the system ones and an app may decline them; if Obsidian still refuses,
  the answer is a publicly trusted certificate.
- **Windows:** `certutil -addstore -f Root <file>` from an Administrator
  prompt.
- **Linux:** the distribution's CA anchors directory, then `update-ca-trust` or
  `update-ca-certificates`.

The README's "Trust the certificate authority, once per device" has the exact
commands for the Compose route.

## The plugin says this device is not paired

**Symptom.** `obsync: not paired`, or an error naming `not_paired`.

**Cause.** This device holds no credential: setup was never completed here, or
its stored credential was removed.

**Fix.** On the first device, complete **First-time setup** with the server's
setup token. On every other device, run **Pair a new device** on a device that
already syncs, enter the code here within ten minutes, and approve the new
device back on the first one. A device with a lost credential is paired again
as a new device; it is never repaired by repeating setup.

## `device_pending`

**Symptom.** Requests refused with `403 device_pending`.

**Cause.** The pairing code was accepted and nobody has approved this device
yet. Until approval it holds a secret and no authority.

**Fix.** Approve it on the device you paired from, by the name it shows. A
pairing that expires before approval leaves nothing behind: pair again.

## `device_revoked`

**Symptom.** Requests refused with `403 device_revoked`.

**Cause.** This device was revoked, from the dashboard or from another device's
Devices list. Its wrapped secret is destroyed by the revocation.

**Fix.** Revocation is final by design. Pair the device again as a new device.

## `stale_timestamp` — the clock

**Symptom.** Requests refused with `401 stale_timestamp`.

**Cause.** Every request is signed over its own timestamp, and the server
accepts a window of ±300 seconds. This device's clock, or the server's, is
outside it. The window is a constant, not a setting, and nothing in the plugin
can widen it.

**Fix.** Turn automatic time back on, on whichever of the two is wrong. A
server on a machine that has been suspended for a long time is the usual
culprit; so is a phone with time set by hand.

## `edge_required`

**Symptom.** Every request refused with `421 edge_required`, including the
first pairing attempt.

**Cause.** The server is configured for an access-controlled edge
(`OBSYNC_EDGE=cloudflare`) and this request did not arrive through it: the
edge's connecting-address and request-id headers were absent. In that mode the
server refuses rather than guessing who the client is.

**Fix.** Reach the server through the edge, not around it — and if that edge
requires a service token, paste its headers into **Edge service-token headers**
in the plugin's settings, one per line as `Name: value`. A deployment with
nothing in front of it should be `OBSYNC_EDGE=none` instead.

## `replayed_nonce`

**Symptom.** An occasional `401 replayed_nonce`, or one of the nonce store's
two 503s beside it (`nonce_cache_full`, `nonce_log_unavailable`, below).

**Cause.** Every signed request carries a nonce the server remembers for 600
seconds, and a nonce is spent by being sent. A repeat means the same signed
request arrived twice: a proxy that retried it, or two copies of one device's
credential running at once.

**Fix.** The plugin never replays a request itself, so look for the duplicate
outside it: a retrying proxy, or the same credential restored onto two devices.
Two devices must each be paired.

## `last_device`

**Symptom.** `409 last_device` when revoking, from the plugin or from the
dashboard.

**Cause.** The only ACTIVE device cannot be revoked; doing so would leave an
account no device can reach, which is unrecoverable
([`recovery.md`](recovery.md)). Both routes refuse it, and revocation cannot
be undone.

**Fix.** Pair another device first, then revoke.

## The dashboard signs itself out on every page load

**Symptom.** `/login?token=…` redirects and looks fine, then every page says
the session is signed out.

**Cause.** The address is not one the browser treats as secure. The session
cookies are `Secure` and `__Host-` prefixed, and a browser silently discards
those. Nothing reaches the server to refuse, which is why there is no error
to read. Two cases look identical and are not:

- plain `http` to any IP address or LAN name that is not loopback: no
  browser keeps the cookies;
- plain `http` to `localhost` or `127.0.0.1` **in Safari**: Chrome and
  Firefox treat loopback as secure and keep them, WebKit does not.

**Fix.** Reach the dashboard through its TLS terminator by name. On the host
itself, Chrome and Firefox will also take plain `http://localhost`
([`security/dashboard.md`](security/dashboard.md)).

## Repeated `dashboard_login_refused` lines

**Symptom.** `event=dashboard_login_refused decision=bad_login_token` in the
log, or on the dashboard's Logs page, from an address you do not recognise.

**Cause.** Something is trying sign-in tokens. The route refuses each one
against a 256-bit constant-time compare and there is no attempt limit in
front of it on purpose: a limit keyed by request source would refuse every
visitor at once behind a shared proxy, which is how the recovery login would
be denied to you ([`security/dashboard.md`](security/dashboard.md)).

**Fix.** Nothing is required — no attempt can succeed without the token. If
the volume is unwelcome, keep the dashboard off any public address, and
rotate the setup token if you believe it was ever exposed
([`recovery.md`](recovery.md)).

## `missing_auth` and `bad_signature`

**Symptom.** `401 missing_auth` or `401 bad_signature`.

**Cause.** `missing_auth` means the request carried no device, timestamp, nonce
or signature at all — the shape a device that was never enrolled sends.
`bad_signature` means the server has no device with that id, or the signature
does not verify against the secret it holds: a rebuilt server, or a journal
volume restored from a backup older than this pairing.

**Fix.** Both are the same repair: pair this device again. If the server was
rebuilt or restored, see [`recovery.md`](recovery.md) before pairing anything,
because the server key decides whether existing devices can be kept at all.

## Other refusals a device can show

The plugin prints the server's refusal as `<status> <code>: <detail>`, so any
code below appears in the status bar or in a notice exactly as it is spelled
here. These are the ones left after the sections above; none of them is a
reason to repeat setup.

| Code | What it means | What to do |
| --- | --- | --- |
| `409 already_claimed` | the pairing code has already been claimed by another device | mint a new one with **Pair a new device** |
| `410 pairing_expired` | the code was not claimed within its ten minutes | mint a new one |
| `409 missing_chunks` | a version was posted naming chunks the server does not hold, so it refused to record it rather than record a file it cannot serve | let sync run again; it re-uploads what is missing. A repeat is worth a report |
| `409 too_many_heads` | one file has accumulated more unmerged heads than the server will carry | resolve the conflict copies for that file, which retires its heads |
| `503 nonce_cache_full` | the replay cache is full | transient by construction: a repeatable request retries itself with backoff, and the next sweep clears it |
| `503 nonce_log_unavailable` | the server could not record replay state, so it refused the request rather than accept one it cannot prove is not a replay | the server's own log names the I/O error; treat it as a storage problem |

## Sync stopped with an error

**Symptom.** `obsync: error — <reason>`, and nothing moves until it is
resolved.

**Cause.** The plugin stops rather than guessing. The reason names it, and
**Show sync status** repeats it.

**Fix,** by what the reason says:

| Reason | What it means | What to do |
| --- | --- | --- |
| `volume_full` or `journal_full` (HTTP 507) | the server's free-space watermark refused the write | free space on that volume, or grow it and the claim together |
| `quota_exceeded` (HTTP 507) | the account quota is exhausted | raise the quota, or remove files and let retention expire |
| `not_ready` (HTTP 503) | the server is not serving: a volume is unwritable, or it is replaying its journal | read the server's own log line, which names the volume and the I/O error |
| `journal_faulted` (HTTP 503) | a journal write failed and the server refuses to acknowledge anything it cannot durably record | the server log names the cause; the volume is the place to look |
| a credential-storage failure | Obsidian's secret storage is unavailable or unverified | do not delete the credential or repeat setup; see [`community-plugin.md`](community-plugin.md) |

## A file is not syncing

**Symptom.** One file never appears on the other device, and nothing reports an
error.

**Cause.** It is excluded by design. Hidden folders (`.obsidian`, `.git`),
symlinked folders, and anything outside this device's saved folder selection
are not synced in either direction.

**Fix.** Check the folder selection under **Sync folders on this device**. A
used device's selection may only narrow: to bring more content in, move the
files into a folder that is already selected and run **Sync now**.

## A large file did not arrive on a phone

**Symptom.** A file syncs between computers but is missing on a phone.

**Cause.** It is above that device's ceiling — **Largest file to download**
(512 MiB by default) or the total budget (50 GiB by default). Mobile ceilings
are plugin policy, and they exist because a phone that runs out of memory loses
the whole sync pass.

**Fix.** Run **Show remote-only files** on that device and fetch the file on
demand, or raise the ceiling in settings if the device can take it.

## A conflict copy appeared

That is obsync refusing to discard an edit, not a failure. See
[`conflicts.md`](conflicts.md).

## How to collect a report

1. **The plugin's own log.** On desktop, open Obsidian's developer console
   (`Cmd`+`Option`+`I` on macOS, `Ctrl`+`Shift`+`I` on Windows and Linux) and
   filter for `obsync`. Refusals and failures are at the warning level;
   routine decisions are at the verbose level, which the console hides until
   you enable it. Every refusal names the request, the status and the code,
   and never the body.
2. **Show sync status**, from the command palette: what the engine is doing and
   why it is not doing more. Its first row is this device's **Server** address
   — leave that row out, for the same reason the list below gives.
3. **The server's log.** One structured line per decision. The useful ones:
   `event=request … status=<code> decision=<what it decided>`,
   `event=readiness decision=not_ready volume=<which> io=<error>`, and the
   START and SUMMARY lines of journal replay, garbage collection and scrub.
4. **Versions.** The plugin version from Settings → Community plugins, the
   server version from `obsyncd version`, and the Obsidian version.

**What never goes into a report,** whether it is an issue, a discussion or a
message to anybody:

- the setup token, a pairing code, or a dashboard sign-in link;
- the 24-word recovery phrase, or any part of it;
- the value of an edge service-token header;
- your server's hostname or address, if it is not one you publish;
- file names or note content that are not disposable.

A log line from this project is safe to paste by construction — the server
never logs a key or a path, and the plugin never logs a request body — but a
screenshot of the settings tab or the dashboard is not: read every pixel
first.
