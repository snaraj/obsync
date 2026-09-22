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
   to be on that network, and the name has to resolve there — see
   [`server.md`](server.md#reaching-it-from-outside-your-lan).
5. Check the server: `GET /readyz` answers `{"ready":true,"seq":<n>}` when it
   is serving. If it answers `not_ready`, read the volume section of
   [`storage.md`](storage.md) — the server refuses readiness rather than lying
   about it.

## "A server with the specified hostname could not be found"

**Symptom.** On a phone or tablet, on your OWN Wi-Fi, obsync reports that the
hostname could not be found — while a laptop on the same network syncs, and
the same phone works over cellular or over the VPN.

**Cause.** The router's DNS-rebinding protection. Many home routers drop a DNS
answer that points at a private address (`192.168.…`, `10.…`, `172.16–31.…`)
when it comes back from a public zone, because that pattern is also how a
rebinding attack works. Your name is exactly that shape: a public name whose
answer is a private address. The device is not told the answer was filtered,
so it reports the name as not existing at all.

**Fix,** any one of these, and the first is usually the least work:

1. **Point the device at a public resolver** rather than at the router — a
   phone's Wi-Fi settings can set DNS per network, and the answer is then
   never filtered on the way in.
2. **Use the VPN's resolver**, which is where a split-DNS or overlay name is
   answered anyway, and is the route that also works away from home.
3. **Allow the name in the router's rebinding protection.** Most routers that
   filter offer an exception list, by name; that is the setting to look for,
   and it is worded differently on every one.
4. **Confirm the diagnosis before changing anything:** on cellular, with the
   VPN up, the same name resolves and syncs. That is the whole test, and it
   takes ten seconds.

This is not the server, the certificate or the plugin — nothing reaches obsync
at all — so nothing in the deployment needs changing to fix it. The shape to
recognise is narrow: the router answers the name with nothing, the device
reports it as not existing, and the same name resolves the moment the device
asks a resolver that does not filter private answers.

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

[`server.md`](server.md#trust-the-certificate-authority-once-per-device) has
the exact commands for the Compose route.

## "A TLS error caused the secure connection to fail"

**Symptom.** On a phone, behind an access-controlled edge (a Zero Trust proxy,
a tunnel with an access policy in front of it), every request fails with a TLS
error. The same name works from a computer, or from the same phone on another
network, and the certificate itself is in date and trusted.

**Cause.** Usually the edge's own decision rather than the certificate — and
there are THREE of those decisions that look identical from the device, because
each of them resets the TCP flow while the handshake is still in progress. A
client that never completed a handshake can only report a TLS failure, so the
message names the layer the failure surfaced at and never the decision that
caused it:

1. **A device-posture policy this device no longer passes.** An enrolment that
   lapsed, a posture check that is failing, a rule that admits the user but not
   this device.
2. **An allow policy that demands the identity be re-authenticated.** An edge
   that enforces re-authentication on a cadence (weekly is a common setting)
   stops admitting a device whose session has aged out. Its log shows the flow
   matching the allow rule with the action taken recorded as `authenticate`
   rather than as an allow.
3. **The certificate really has expired** — the one cause that is not the edge,
   and the one that fails every device at once rather than one at a time.

**Fix.** Read the edge policy for THAT device first. It is what separates the
three, and it is the one thing the device cannot tell you:

1. **Read the edge's own log for that device.** It names the decision the phone
   cannot see: the matched rule, the action taken, the device identity. An
   action of `authenticate` is cause 2; a rule that stopped matching this
   device, or a posture check reported as failing, is cause 1.
2. **Do what that entry says.** For cause 2, re-authenticate the edge client on
   that device — sign in again in the client app rather than merely
   reconnecting it, which costs a tap. For cause 1, repair the enrolment or the
   posture the rule requires; nothing on the device's own network settings will
   help.
3. **Only then look at the certificate**, which is quickest to rule out from a
   computer on the same route: if a browser there is happy with it, the
   certificate is not what the phone is failing on. A certificate expires for
   every device at once; an edge decision refuses one device at a time, which
   is why the policy is what you read first.

Causes 1 and 2 are written down separately because they are separate
decisions that produce the identical message, and an edge can take both within
the same hour: fixing one does not tell you the other was not also true.

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
If this appeared after pointing the device at a DIFFERENT server, its stored
credential belongs to the old one: **This device** → **Leave this server** →
**Switch server** (["moving this vault to a different
server"](recovery.md#moving-this-vault-to-a-different-server)).

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

**Fix.** Check the folder selection under **Sync folders on this device**.
Adding the file's folder there and selecting **Save** brings in both halves:
the local files under it are published, and whatever the server already
holds under it is pulled by replaying the history this device skipped. On a
vault with long history that replay takes a while; the local log records the
cursor it rewound from.

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

## Two folders that differ only in capitalisation

One device shows two folders whose names differ only in capitalisation --
`team docs` with your current notes and `Team docs` with copies that no
longer change -- while another device shows one. A filesystem either folds
case, and then the two spellings are ONE folder, or it does not, and then
they are two; a version before 1.1.0 could publish a capitalisation-only
rename made on a folding device as NEW notes instead of as the rename it
was, so a device that keeps the two apart received the new spelling and was
never told to retire the old one. From 1.1.0 a capitalisation-only rename is
published as a rename: the FOLDER's own record carries the new spelling and is
published before the notes under it move, and the device receiving it renames
the directory entry itself and carries its records along. That is the only
thing that can re-case a folder on a device that folds case, because renaming
a note inside a folder cannot change how the folder is spelled -- the
operating system finds the folder by either spelling and leaves the name it
keeps alone.

**If the other device is still on 1.0.x**, it sends no folder record, so this
device sees notes asking for a folder spelled a way it does not show. It
refuses those moves, changes nothing at all, and tells you once per folder.
Update that device, or rename the folder here to match, and the two agree
again. While they disagree, edits made under that folder on the older device
do not arrive here.

**Do not delete the stale folder first.** A deletion is published as a
tombstone, and every device obeys a tombstone. On a device that folds case,
the old spelling IS the live note's own directory entry, so a tombstone for
it -- arriving at a device that still has the old names in its records --
deletes the notes you are trying to keep, everywhere. The order below exists
for exactly that reason.

1. **Update every device** to 1.1.0 or later, open each one, and let it sync
   once. On a device that folds case the startup scan drops the records that
   still name the old spelling, publishes nothing, removes nothing, and says
   so once in a notice. That is what disarms the tombstone.
2. **Check the stale folder** on the device that shows two. Its notes should
   be the ones you renamed away from. Anything you edited there after the
   rename exists only there: move it into the live folder first, under a
   name of its own.
3. **Delete the stale folder on that one device.** Its tombstones retire the
   abandoned copies on every device and touch nothing live.
4. An EMPTY folder under the old spelling can stay or go as you like.
   Nothing in this version deletes a folder, and an empty one holds no
   notes.

The plugin does not do step 3 for you. A device can prove what its own
records say; it cannot prove that every other device has already been
updated and rescanned, and publishing that tombstone one sync too early is
the loss this order avoids. Nor can it tell the two apart later: a rename
leaves a file's size and modification time exactly as they were, so the
record for the abandoned copy and the record for the live note describe the
same bytes.

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
