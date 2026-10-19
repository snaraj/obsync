# The dashboard

*For people running an obsync server.*

The server ships its own dashboard: static HTML, CSS and JavaScript served by
the same binary, with no framework and no remote asset. It is where you see
every device that can reach your vault, what the volumes are doing, and where
you revoke a device you no longer trust.

The dashboard is an ADMINISTRATIVE surface, not a second way into your notes.
It never holds a key that decrypts anything: the server stores ciphertext only,
so the dashboard can tell you a file record has 12 versions and cannot tell you
what any of them say.

## How to launch it

On any paired computer, run the command **Open dashboard** from Obsidian's
command palette. The plugin asks the server for a single-use sign-in link
(`POST /v1/dashboard/login-link`), the server answers with a URL valid once,
for five minutes, and the plugin opens it in your browser. Obsidian may write
that URL to its own log; why that is bounded, and why five minutes, is in
[the dashboard's threat model](security/dashboard.md#6-accepted-residuals). Following the link
(`GET /login?token=…`) sets the session cookie and lands you on the overview.

The plugin opens that answer only when the address it resolves to is the
server's own. The link is resolved against the **Server URL** this device is
configured with, and a link that resolves to any other origin is refused by
name and not opened: the answer carries a dashboard sign-in token, and
resolving a server's answer without checking where it points is how that token
would reach somebody else's origin.

> **Capture slot** — `docs/captures/06-dashboard-sign-in.png`: the dashboard's
> sign-in page as a browser first reaches it, with the address bar redacted.

### Recovery sign-in with the setup token

If no paired device can mint a link — every device lost, or the plugin not
installed anywhere yet — the setup token the server wrote at first boot is the
way in. It created the account, and it then remains the dashboard's recovery
sign-in for the life of the server. Read it off the journal volume as
[Run the server](server.md#read-the-setup-token) describes, and sign in with it
on the dashboard's own sign-in page.

That is why the token is a standing credential and is kept with the same care
as the recovery phrase: anyone holding it can sign in to the dashboard and
revoke devices. It is stored only on the journal volume, mode 0600, and is
never written to a log.

## How to access it

The dashboard is served by the server, at the server's own address: there is
no separate host, port or account. Everything under `/` and `/v1/admin/*` is
the same process that answers sync requests, so whatever reaches the sync API
reaches the dashboard.

- **TLS is outside the process.** The server speaks plain HTTP and is always
  behind a terminator you trust ([Run the server](server.md)). Reach the
  dashboard over `https://`, the same address your devices use for sync.
- **A private route is the shape this is written for.** With no public
  hostname, the server is reached over LAN or VPN and so is its dashboard. A
  public hostname behind a tunnel provider with an access policy is an
  optional path, not the default.
- **Sessions are cookies the browser cannot read.** `HttpOnly`,
  `SameSite=Strict`, with a double-submit CSRF header (`X-Obsync-Csrf`) on
  every mutating call. The dashboard serves no inline script and every HTML
  response carries a `default-src 'self'` content-security policy.
- **`POST /v1/admin/logout` ends the session**, and the sign-in link that
  started it is spent the moment it is used.

Passkey sign-in is deferred; the current dashboard does not register or
authenticate WebAuthn credentials.

## What each page shows

| Page | What is on it |
| --- | --- |
| **Overview** | the account with how many devices can sync (revoked ones are on **Devices**, not in this figure), version and file counts, storage per volume with its class name, sync activity as versions per hour over the last 24 hours, and the last scrub and garbage-collection summaries |
| **Devices** | every device by name, platform, app version, first paired, last sign-in, last seen, last edit, connecting address and country — and the device-removal choices |
| **Pairing** | the pairing instructions; codes themselves are minted on a device, never here |
| **Storage** | usage against the declared capacity, the free-space watermark, retention, scrub state and rate, and the quarantine list |
| **Install** | the Community Plugins install steps, the updates path, the certificate requirement, and the plugin version this server is serving |
| **Logs** | the most recent request decisions, filtered by device |

The address comes from the edge's connecting-address header in `cloudflare`
edge mode, and from the peer address or a trusted proxy header in `none` mode.
The COUNTRY has one source only, the edge's country header, so in `none` mode
that column is empty rather than guessed. Device history retention defaults to
90 days.
[Protocol](protocol.md#dashboard-admin-api) is the exact shape of every
response behind these pages.

> **Capture slot** — `docs/captures/07-dashboard-devices.png`: the Devices
> page with two devices listed, their names, addresses and countries redacted.

> **Capture slot** — `docs/captures/08-dashboard-storage.png`: the Storage
> page showing usage against the declared capacity, the watermark, retention,
> and scrub state.

A volume whose `bytes_used` is the last figure read successfully rather than a
current one is shown as unverified, and writes are being refused with
`journal_unverified` while it is: that is a storage fault to act on, not a
display quirk ([Storage and durability](storage.md)).

## How to revoke a device

Device removal offers two choices. **Revoke access and rotate keys
(Recommended)** protects future updates with a fresh key, and must be
completed on a trusted Obsidian device. **Revoke server access only** blocks
the credential while leaving the vault key unchanged.

1. Open **Devices** and find the device by the name you gave it when you
   approved it.
2. Select **Remove device**. Both choices appear; neither is selected and
   nothing is sent. **Cancel** closes the choices and clears the selection.
3. For strong removal, select **Revoke access and rotate keys (Recommended)**.
   The dashboard says key rotation is unavailable here: **Continue on a trusted
   Obsidian device to rotate keys**. On a retained device, open obsync settings,
   find the device under **Devices**, select **Revoke**, then **Rotate key**.
   The dashboard sends no removal request, starts no pending rotation and
   never asks for a key or recovery backup. The plugin guides you through a new
   complete backup, re-encryption and restart; every retained device must pair
   again afterward. Keep both backups if you need old retained history.
4. To block only server access, explicitly select **Revoke server access only**
   and read the consequence: a device retaining its key can still decrypt later
   ciphertext encrypted with that same key if it obtains it elsewhere. Select
   **Confirm server access only** to send `POST /v1/admin/devices/{id}/revoke`.
   Selecting the choice alone or switching to the strong handoff sends nothing.
   The last active device cannot be revoked through this action.
5. The dashboard reports the server's response, says this action does not rotate
   keys, and reloads the list with a **revoked** tag. An error is a refusal, not
   completed removal. Explicitly pair the device again from a trusted device to
   restore server access.

Both choices leave previously downloaded notes and copied keys on the removed
device. Rotation protects future updates after the trusted client completes
the transition; it cannot erase old plaintext or make old history unreadable.

## How to forget a revoked device

A device that has been revoked stays in the list, refused, until it is
forgotten. The **Devices** page counts those on one row — **N revoked
devices** — and **Show** opens them; each carries **Forget** in place of
**Remove device**.

1. Select **Show** beside the count, and find the device.
2. Select **Forget**. As with revoking, nothing has happened yet: that button
   only reveals the confirmation.
3. Select **Confirm forget**. THIS is the click that sends
   `POST /v1/admin/devices/{id}/archive`. **Cancel** sends nothing.
4. The page says "<name> is forgotten." and the row is gone, and a line under
   the table counts what is no longer listed. Only the LIST changed: the
   server keeps that device's record, still refuses it with `403
   device_revoked`, and still names the versions it wrote. The flag is on the
   journal before the answer, so a restart shows the same list. Only a revoked
   device can be forgotten; the server refuses anything else with `409
   device_not_revoked`.
5. If that device was yours, pair it again from a device that still syncs. Its
   notes are still in its vault.

You can also remove a device from **Devices** in the plugin's settings.
**Revoke** opens the choice between **Rotate key** and **Block access**. Rotation
must run on a different retained device; blocking server access retains the
same-key consequence explained above.

If the device that is gone was your LAST one, revoking is not the problem to
solve — getting back in is. [Recovery](recovery.md) is that page.

> **Capture slot** — `docs/captures/09-dashboard-revoke.png`: the revoke
> choices and access-only confirmation for one device, its name and address redacted.

Those capture slots require a recorded run of the current dashboard
([`docs/validation-runs/`](validation-runs/README.md)). They are taken on a synthetic
vault against a throwaway server, and they obey the same redaction rules as
every other capture in this repository — no address, no device identifier, no credential
of any kind ([the screenshot conventions](captures/README.md)).

## Next

- [Recovery](recovery.md): a lost device, a lost server, a moved address.
- [Storage and durability](storage.md): what the Storage page is reporting.
- [Threat model](threat-model.md): what an attacker who reaches the dashboard
  can and cannot do.
