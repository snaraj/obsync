# Troubleshooting

*For people using obsync.*

Find what you see in the list below and follow its link. Every entry has the
same three parts: **what you see**, **why it happens**, and **how to fix it**.
If nothing matches, [collect a report](#how-to-collect-a-report) and ask.

Your notes stay on your devices through every problem on this page. None of
the fixes below asks you to delete a vault, and none needs you to set up the
server again unless the entry says so.

## What you see

**Connecting to your server**

| What you see | Go to |
| --- | --- |
| The status bar icon is not the check mark | [Reading the status bar](#reading-the-status-bar) |
| The status bar shows a cloud with a line through it, and nothing syncs | [The device cannot reach the server](#the-device-cannot-reach-the-server) |
| "Use your server's https address", or on a phone "Mobile Obsidian only reaches HTTPS servers" | [Obsidian asks for an https address](#obsidian-asks-for-an-https-address) |
| **Check** takes about a minute, then says the server is unreachable | [Check says the server cannot be reached](#check-says-the-server-cannot-be-reached) |
| One device connects and another does not, or a browser warns about the certificate | [The certificate is not trusted on this device](#the-certificate-is-not-trusted-on-this-device) |
| **Check** says nothing answered while the server runs, and a browser says the certificate is not valid for this name | [The certificate is for another name](#the-certificate-is-for-another-name) |
| A phone says "A server with the specified hostname could not be found" at home | ["A server with the specified hostname could not be found"](#a-server-with-the-specified-hostname-could-not-be-found) |
| A phone says "A TLS error caused the secure connection to fail" | ["A TLS error caused the secure connection to fail"](#a-tls-error-caused-the-secure-connection-to-fail) |
| **Check** answers `403` and a message from your proxy | [Your proxy or access service refuses the plugin](#your-proxy-or-access-service-refuses-the-plugin) |
| `421 edge_required` | [`edge_required`](#edge_required) |

**Setting up and pairing**

| What you see | Go to |
| --- | --- |
| `obsync: not paired` | [The plugin says this device is not paired](#the-plugin-says-this-device-is-not-paired) |
| Setup says the setup token does not match | [Setup says the setup token does not match](#setup-says-the-setup-token-does-not-match) |
| Pairing says the code is not valid | [Pairing says the code is not valid](#pairing-says-the-code-is-not-valid) |
| Pairing says the code expired, or was already used | [Pairing says the code expired or was already used](#pairing-says-the-code-expired-or-was-already-used) |
| The new device keeps waiting for approval | [The new device waits for approval](#the-new-device-waits-for-approval) |
| You closed the recovery phrase without writing it down | [You closed the recovery phrase without checking it](#you-closed-the-recovery-phrase-without-checking-it) |
| You use Linux without a keyring, and want to know how obsync's keys are kept | [On Linux, the keys may not be in a keyring](#on-linux-the-keys-may-not-be-in-a-keyring) |

**Your notes and folders**

| What you see | Go to |
| --- | --- |
| A note came back as a conflict copy | [A conflict copy appeared](#a-conflict-copy-appeared) |
| A note or file never arrives on another device | [A file is not syncing](#a-file-is-not-syncing) |
| On a computer, a change made while Obsidian's window is minimized or behind other windows arrives minutes later | [Changes wait while Obsidian is in the background](#changes-wait-while-obsidian-is-in-the-background) |
| A large file is missing on a phone | [A large file did not arrive on a phone](#a-large-file-did-not-arrive-on-a-phone) |
| A photo or PDF from a phone on a weak connection never arrives on the other devices | [A photo or PDF from my phone never arrives on my other devices](#a-photo-or-pdf-from-my-phone-never-arrives-on-my-other-devices) |
| Notes you deleted on one device disappeared everywhere | [Notes deleted on one device disappeared everywhere](#notes-deleted-on-one-device-disappeared-everywhere) |
| A folder deleted on another device stays on a Mac | [A deleted folder stays on a Mac](#a-deleted-folder-stays-on-a-mac) |
| An empty folder appeared where another device has a linked folder | [A linked folder shows up empty on other devices](#a-linked-folder-shows-up-empty-on-other-devices) |
| Two folders whose names differ only in capitals | [Two folders that differ only in capitalisation](#two-folders-that-differ-only-in-capitalisation) |
| A note or folder you renamed has another device's name | [A note or folder took the other device's name](#a-note-or-folder-took-the-other-devices-name) |
| **Restore a copy** fails on a USB stick or memory card | [Restoring a copy fails on a USB stick or memory card](#restoring-a-copy-fails-on-a-usb-stick-or-memory-card) |
| I copied or renamed my vault, and obsync says it is a copy (up to 1.1.3: that credential storage could not be verified) | [A copied or renamed vault says it is a copy](#a-copied-or-renamed-vault-says-it-is-a-copy) |

**Sync stopped**

| What you see | Go to |
| --- | --- |
| `obsync: error` and a reason | [Sync stopped with an error](#sync-stopped-with-an-error) |
| The reason mentions the clock or `stale_timestamp` | [The clock is wrong](#the-clock-is-wrong) |
| "This server no longer recognises this device" | [The server no longer recognises this device](#the-server-no-longer-recognises-this-device) |
| My server says its storage is full | [The server has run out of storage](#the-server-has-run-out-of-storage) |
| Another code, such as `409 missing_chunks` | [Other refusals a device can show](#other-refusals-a-device-can-show) |

**Running the server and its dashboard**

| What you see | Go to |
| --- | --- |
| The server stops as it starts, its last line `listen_failed` | [The server cannot listen on its address](#the-server-cannot-listen-on-its-address) |
| The dashboard signs you out on every page | [The dashboard signs itself out on every page load](#the-dashboard-signs-itself-out-on-every-page-load) |
| Repeated `dashboard_login_refused` lines in the log | [Repeated `dashboard_login_refused` lines](#repeated-dashboard_login_refused-lines) |
| An occasional `replayed_nonce` | [A request arrived twice](#a-request-arrived-twice) |
| `409 last_device` when revoking | [The last device cannot be revoked](#the-last-device-cannot-be-revoked) |

## Reading the status bar

From 1.1.4 the status bar shows one icon, always the same width. Hover over
it on a computer to read its words; click it, or tap it in a phone's note
header, for **Show sync status**. The icons below were captured from a
desktop status bar in the dark theme; yours follow your theme's colours.

| Icon | Its words | What it means | What to do |
| --- | --- | --- | --- |
| <img src="assets/status-synced.png" alt="check mark" width="36" height="31"> | `obsync: idle` | Everything is in sync | Nothing |
| <img src="assets/status-syncing.png" alt="turning wheel" width="36" height="31"> | `obsync: syncing 3` | Files are uploading or downloading; the number counts them | Nothing. A large file can take a while; **Show sync status** names the file that is moving |
| <img src="assets/status-offline.png" alt="cloud with a line through it" width="36" height="31"> | `obsync: offline — retrying` | The device cannot reach the server; it keeps trying on its own | [The device cannot reach the server](#the-device-cannot-reach-the-server) |
| <img src="assets/status-error.png" alt="alert sign" width="36" height="31"> | `obsync: error — <reason>` | Sync stopped and needs you | [Sync stopped with an error](#sync-stopped-with-an-error) |
| <img src="assets/status-paused.png" alt="pause sign" width="36" height="31"> | `obsync: paused — <note>` | One note is held because something on this device keeps rewriting it; every other note keeps syncing | [Stop repeated rewrites](daily-use.md#stop-repeated-rewrites) |
| <img src="assets/status-quiet.png" alt="faint cloud" width="36" height="31"> | `obsync: not paired`, or `obsync: idle — syncing no folders` | This device is not paired yet, or **Selected folders** is empty | [The plugin says this device is not paired](#the-plugin-says-this-device-is-not-paired), or choose folders in the plugin's settings |

The wheel appears only when syncing lasts longer than half a second, so a
note that saves and syncs while you type leaves the check where it is. With
Reduce Motion on, the wheel stands still.

**Show sync status**, in the command palette, always says in words what sync is
doing and why it is not doing more.

<a id="the-status-bar-says-offline--retrying"></a><a id="the-status-bar-says-offline-retrying"></a>

## The device cannot reach the server

**What you see.** The status bar shows a cloud with a line through it, whose
words read `obsync: offline — retrying` (up to 1.1.3 the bar shows those words
themselves), and nothing syncs in either direction.

**Why it happens.** The device cannot reach the server at the **Server URL** in
settings, or reaches something that is not the server. The plugin keeps trying
by itself: 5 seconds apart at first, then less often, up to every 5 minutes,
and again the moment the device reports its network is back. A device that is
simply away from a home-only or VPN-only server resumes on its own when it
returns, with nothing to press. In a test on a desktop, sync resumed about ten
seconds after the server came back.

**How to fix it,** when the device stays offline on a network the server IS on:

1. Select **Sync now** in the command palette, to try again at once.
2. Open the Server URL in a browser on the SAME device. A dashboard sign-in
   page means the address and the certificate are fine.
3. Check the port. A server on a port other than 443 needs it in the Server
   URL: `https://name:8443`.
4. Check the scheme: the address must start with `https://`
   ([Obsidian asks for an https address](#obsidian-asks-for-an-https-address)).
5. Check the route. If the server is at home or behind a VPN, the device has to
   be on that network, and the name has to work there
   ([Reaching it from outside your LAN](server.md#reaching-it-from-outside-your-lan)).
6. If you run the server, check it is serving: `https://<your name>/readyz` in
   a browser shows `{"ready":true,...}`. If it shows `not_ready`, the server's
   log names the volume that is the problem ([Storage](storage.md)).
7. If the Server URL ends in `trycloudflare.com`, it is a Cloudflare quick
   tunnel. Its address stops working when the tunnel restarts or loses its
   connection, and the new tunnel gets a different address, so every device
   stays offline until you paste the new one into **Server URL**. A quick
   tunnel has no access policy either: it is for a short test with a
   throwaway vault. For daily use, pick a shape in [Cloudflare](cloudflare.md)
   or [reach the server another way](server.md#reaching-it-from-outside-your-lan).

## Obsidian asks for an https address

**What you see.** A notice as you type the **Server URL**. On a computer:

> Use your server's https address. Plain HTTP would send the setup token and every request unencrypted; it is accepted only for this computer itself (localhost or 127.0.0.1).

On a phone or tablet:

> Mobile Obsidian only reaches HTTPS servers.

**Why it happens.** The address starts with `http://`. Plain HTTP would send
your credentials unencrypted, so the plugin accepts it only for a server on the
same computer, and never on a phone.

**How to fix it.**

1. Type the address with `https://`, the way your devices reach the server:
   `https://sync.example.org`, or `https://sync.example.org:8443` with a port.
2. The server needs HTTPS in front of it. [Run the server](server.md) shows
   the simplest way, with nothing else to sign up for.

## Check says the server cannot be reached

**What you see.** You select **Check** under **Connection**, and within about
ten seconds a notice says:

> Nothing answered at &lt;your Server URL&gt;. Check the Server URL, port included; if it has worked before, your server may be switched off or out of this network's reach.

If something answered but this device does not trust its certificate, the
notice reads "This device does not trust your server's certificate, so it
refused the connection." instead. Up to 1.1.3, **Check** waits about a minute
and reads `0 unreachable: network=net::ERR_CONNECTION_REFUSED` when nothing
answers at that address and port, and
`0 unreachable: network=net::ERR_CERT_AUTHORITY_INVALID` when the certificate
is not trusted.

**Why it happens.** The device could not open a connection to the Server URL,
or it did and refused the certificate it was shown.

**How to fix it.**

1. Nothing answered (`ERR_CONNECTION_REFUSED` up to 1.1.3): check the address
   and the port in the Server URL, and that the server is running.
2. The certificate is not trusted (`ERR_CERT_AUTHORITY_INVALID` up to 1.1.3):
   trust the server's certificate on this device
   ([The certificate is not trusted on this device](#the-certificate-is-not-trusted-on-this-device)).
3. Anything else: work through
   [The device cannot reach the server](#the-device-cannot-reach-the-server).

## "A server with the specified hostname could not be found"

**What you see.** On a phone or tablet, on your OWN Wi-Fi, obsync reports that
the hostname could not be found, while a laptop on the same network syncs and
the same phone works over mobile data or over the VPN.

**Why it happens.** Your router's DNS-rebinding protection. Many home routers
drop a DNS answer that points at a private address (`192.168.…`, `10.…`,
`172.16–31.…`) when it comes from a public name, because that pattern is also
how a rebinding attack works. Your name is exactly that shape. The phone is not
told the answer was dropped, so it reports that the name does not exist.

**How to fix it,** any one of these; the first is usually the least work:

1. **Confirm it first:** with mobile data and the VPN on, the same name works.
   That takes ten seconds.
2. **Point the phone at a public DNS resolver** instead of the router. A
   phone's Wi-Fi settings can set DNS per network.
3. **Use the VPN's resolver,** which also works away from home.
4. **Allow the name in the router's rebinding protection.** Most routers that
   filter have an exception list; it is worded differently on every one.

Nothing in obsync or the server needs to change for this.

## The certificate is not trusted on this device

**What you see.** One device connects and another does not. **Check**, the
status and **Show sync status** on the failing device say:

> This device does not trust your server's certificate, so it refused the connection. Trust that certificate on this device -- see Troubleshooting, "The certificate is not trusted on this device".

Up to 1.1.3, **Check** ended with `net::ERR_CERT_AUTHORITY_INVALID` instead. A
browser on that device warns about the certificate too.

**Why it happens.** The server uses its own certificate authority, and this
device has never been told to trust it. Trust is set once per device, and on
iPhone and iPad it takes two steps.

**How to fix it.** Install the server's root certificate on this device, then
turn trust on:

- **iPhone and iPad:** install the profile, THEN turn it on in Settings →
  General → About → Certificate Trust Settings. Obsidian fails until that
  second step is done. Every screen is in
  [Same network, step by step](same-network.md#trust-the-certificate-on-the-phone).
- **Android:** Settings → Security → Encryption & credentials → Install a
  certificate → CA certificate. Android keeps certificates you install
  separate from the built-in ones, and an app may ignore them; if Obsidian
  still refuses, the server needs a publicly trusted certificate. Issued over
  the DNS-01 challenge it needs no open port and no public address
  ([how](server.md#trust-the-certificate-authority-once-per-device)).
- **macOS, Windows, Linux:** the one command for each is in
  [Trust the certificate authority](server.md#trust-the-certificate-authority-once-per-device).

**On Linux, trusted and still refused.** Obsidian reads the authorities you
add from your own NSS database, `~/.pki/nssdb`, not from the system store
`update-ca-certificates` writes. So `curl` on that computer can accept the
server while Obsidian refuses it. Add the root to that database as the user
who runs Obsidian, with the `certutil` command in
[Trust the certificate authority](server.md#trust-the-certificate-authority-once-per-device),
then restart Obsidian. CI proves that command with the official AppImage, and
proves an instance without it is refused.

## The certificate is for another name

**What you see.** **Check** under **Connection** ends within about ten seconds
with "Nothing answered at" your Server URL, and the status bar shows the cloud
with a line through it, although the server is running. A browser on the same
device, given the same address, says the certificate is not valid for this
name (Chromium browsers show `NET::ERR_CERT_COMMON_NAME_INVALID`). On a
computer the plugin's log names it too: `network=net::ERR_CERT_COMMON_NAME_INVALID`.
Up to 1.1.3, **Check** itself reads
`0 unreachable: network=net::ERR_CERT_COMMON_NAME_INVALID`.

**Why it happens.** A certificate lists the names it is valid for, and the
device refuses one that does not list the name in the **Server URL**. Usually
the Server URL is not the name the certificate was made for:

- it uses the server's address, such as `https://192.168.1.10`, and the
  certificate names only the host name (the Compose setup's certificate is for
  `OBSYNC_HOST` alone);
- it uses a short name, such as `https://nas`, and the certificate names the
  full one, or the other way round;
- the name changed, on the devices or on the server, and the other side still
  uses the old one;
- something in front of the server, such as a reverse proxy or a Zero Trust
  service, shows its own certificate for another name.

**How to fix it.**

1. Put the exact name the certificate is for in the **Server URL**, with
   `https://`, and the port when it is not 443. For the Compose setup that is
   the `OBSYNC_HOST` you started it with.
2. Not sure which names it lists? Open the Server URL in a browser on a
   computer and view the certificate: its Subject Alternative Name field lists
   them.
3. Changed the name on purpose? Start Compose again with the new
   `OBSYNC_HOST`; Caddy makes a certificate for it as it starts, from the same
   authority, so the devices need no new root. Then change the Server URL on
   every device.
4. Do not turn certificate checks off to get past this. The name check is
   what keeps another machine from answering in your server's place.

## "A TLS error caused the secure connection to fail"

**What you see.** On a phone, behind an access-controlled proxy (a Zero Trust
service, or a tunnel with an access policy in front), every request fails with
this TLS error. The same name works from a computer, or from the same phone on
another network, and the certificate is valid.

**Why it happens.** Usually the access service's own decision, not the
certificate. Three different decisions look identical on the phone, because
each one cuts the connection before it is set up:

1. The phone no longer passes a **device check** the policy requires (an
   enrolment that lapsed, a failing posture check).
2. The policy wants you to **sign in again** (many services ask weekly).
3. The **certificate really expired**, which fails every device at once.

**How to fix it.**

1. Read the access service's own log for THAT device. It names the rule and
   the action; an action of "authenticate" means cause 2, a failing check
   means cause 1.
2. For cause 2, sign in again in the access client app on the phone; just
   reconnecting is not enough. For cause 1, repair the enrolment or the check
   the rule requires.
3. Only then look at the certificate: if a browser on a computer on the same
   route accepts it, the certificate is not the problem.

## Your proxy or access service refuses the plugin

**What you see.** **Check**, or the status bar's words, say:

> Something between this device and your server, such as a proxy or an access policy, answered instead of obsync. Check the Server URL and the Custom request headers in obsync settings; sync retries by itself.

A proxy that answers in obsync's own format can instead produce "Your server
refused this request; the obsync log names the reason." Up to 1.1.3, **Check**
answers `403` followed by your proxy's own message, for example
`403 error: access denied`.

**Why it happens.** Your server sits behind a proxy or access service that
wants a header, such as a service token, and the header is missing or its
value is wrong: the box under **Custom request headers** is empty, or holds
another value than the one your proxy expects. Up to 1.1.3, a header pasted
from a command line with `-H` and quotes, or a value with curly quotes (`“…”`)
that a text editor added, failed the same way. From 1.1.4 obsync removes a
pasted `-H` and the quotes around a line by itself, and says so, and refuses
to save a line it cannot send, naming the line and the character.

**How to fix it.**

1. Open **Custom request headers** in the plugin's settings.
2. Write one header per line, as `Name: value`, with no `-H` and no quotes:
   `CF-Access-Client-Id: <the client id>`, not
   `-H "CF-Access-Client-Id: <the client id>"`.
3. If obsync says a line was not saved, correct what it names there, such as a
   curly quote, and leave the box again.
4. Select **Check** again. On a device that is not paired yet, success reads
   "Reached your obsync server."

<a id="device_pending"></a>

## The new device waits for approval

**What you see.** The new device's pairing dialog stays at "Waiting for
approval on the other device…". A request from it may be refused with
`403 device_pending`.

**Why it happens.** The pairing code was accepted and nobody has approved the
new device yet. Until the new device collects the vault key you approve, it has
no access of any kind.

**How to fix it.**

1. On the device you made the code on, keep **Pair a new device** open.
2. It asks whether to approve the new device, by name and vault, and shows a
   match code. Approve only if the name and vault are right and the new
   device's screen shows the same match code; otherwise select **Reject**.
3. A pairing that ends before the new device collects the key (rejected, or
   past its ten minutes, approved or not) leaves nothing behind: pair again
   with a new code.

<!-- CAPTURE(1.1.4): the approval question with the pairing match code -->

## The plugin says this device is not paired

**What you see.** A faint cloud in the status bar whose words read
`obsync: not paired`, or an error naming `not_paired`.

**Why it happens.** This device holds no credential: setup was never completed
here, or its stored credential was removed.

**How to fix it.**

1. On your first device, use **Setup or recover** with the server's setup
   token ([Quickstart](quickstart.md)).
2. On every other device, run **Pair a new device** on a device that already
   syncs, enter the code here within ten minutes, and approve the new device
   there.
3. A device that lost its credential is paired again as a new device; setting
   the server up again does not repair it.

## Setup says the setup token does not match

**What you see.** After **Set up or recover**, a notice:

> obsync: This server did not accept that setup token. Check that it is this server's token (obsyncd setup-token prints it) and paste it again.

Up to 1.1.3 it reads
`obsync: 401 bad_setup_token: setup token does not match`.

**Why it happens.** The token that arrived is not this server's: it came from
a different server, an older copy of this one, or only part of it was copied.
From 1.1.4, quotes around the token and spaces or line breaks inside it, as a
terminal window adds when it wraps a long line, are ignored. Up to 1.1.3 each
of those gave the same refusal.

**How to fix it.**

1. Read the token again from the server
   ([Read the setup token](server.md#read-the-setup-token)).
2. Copy it as one piece, without quotes or spaces.
3. Clear the **Setup token** field, paste it, and select **Set up or recover**
   again.
4. Keep the token private: anyone holding it can sign in to your dashboard.

<!-- CAPTURE(1.1.4): the Setup or recover row with its masked Setup token field -->

## Pairing says the code is not valid

**What you see.** After **Pair**, a notice:

> That is not a pairing code. Paste the code, or the link, exactly as your other device shows it under Pair a new device.

or, when only part of it arrived, "That pairing code is incomplete. Copy all of
it again from your other device, or use its Copy link." Up to 1.1.3 it reads
`base32: invalid character`.

**Why it happens.** Something other than the whole code went into the
**Pairing code** field. Up to 1.1.3 the usual one was the whole pairing link
(`obsidian://obsync-private-sync/pair?code=…`), which **Copy link** puts on the
clipboard, pasted where the code goes; from 1.1.4 the link is accepted there
too.

**How to fix it.**

1. On the device that made the code, select **Copy code** rather than **Copy
   link**, and paste that.
2. Or open the link itself on the new device: it opens **Pair this device**
   with the code already filled in.

## Pairing says the code expired or was already used

**What you see.** After **Pair**, one of these notices:

> That code has expired: codes last ten minutes. Make a new one on your other device with Pair a new device.

> Another device already used that code. Make a new one on your other device with Pair a new device. If none of your devices used it, choose Reject when the other device asks.

A code this server does not know reads "That code does not match a pairing on
this server. Check that you copied all of it and that this device uses the
same server. Make a new one on your other device with Pair a new device." Up
to 1.1.3, a code claimed after its ten minutes reads
`404 unknown_pairing: no such pairing`, and a code another device already
claimed reads `409 already_claimed: the pairing is already claimed`.

**Why it happens.** Each code works once, for ten minutes, for one device.

**How to fix it.**

1. On a device that already syncs, run **Pair a new device** again for a fresh
   code.
2. Enter it on the new device within ten minutes.
3. If another device claimed the old code by mistake, reject it when asked,
   or revoke it later in **Devices**.

## You closed the recovery phrase without checking it

**What you see.** Nothing at first. After first-time setup, the recovery
phrase dialog asks for three of the 24 words. If you close it instead, setup
still succeeds. From 1.1.4, the next time Obsidian starts, one notice says
"obsync: your 24-word recovery phrase is not confirmed. Without it and without
a paired device this vault cannot be recovered. Open obsync's settings, Vault
key, and choose Show and confirm.", and until you confirm, the **Recovery
phrase** row in Settings and in **Show sync status** reads "Not confirmed —
Show and confirm". Up to 1.1.3 nothing reminds you later.

**Why it happens.** The phrase is the only way back into your vault if every
device is lost. The server never has it and cannot give it back.

**How to fix it.**

1. On a device that syncs, open **Settings → Self Hosted Private Sync →
   Vault key → Recovery phrase → Show**, or run **Show recovery phrase**.
2. Write the 24 words down and keep them somewhere other than this device.
3. Check them word by word. Never type them into a screenshot, a chat or an
   issue.

![The Recovery phrase row reading Not confirmed, with Show and confirm and Restore or create](assets/settings-vault-key.png)

## On Linux, the keys may not be in a keyring

**What you see.** Nothing. On a Linux desktop with no keyring running, such
as a minimal window manager or a container, setup and pairing work as they do
anywhere else, and neither Obsidian nor obsync warns you.

**Why it happens.** obsync keeps the vault key and this device's secret in
Obsidian's secret storage
([Where your keys are kept](community-plugin.md#where-your-keys-are-kept)).
On Linux that storage relies on the desktop's keyring, such as GNOME Keyring
or KWallet. Without one, Obsidian still accepts and keeps the keys (seen with
Obsidian 1.13.7), and they are then protected only by your home folder's
permissions. Obsidian does not tell plugins which storage it uses, so obsync
cannot tell you which case you are in.

**How to fix it.**

1. Before you set up or pair a Linux device, run a desktop that provides a
   keyring, or install GNOME Keyring or KWallet and have it unlocked when you
   sign in.
2. On a device that already syncs, use **Leave this server**, then pair it
   again while the keyring runs, so the keys are written again. Have your
   recovery phrase or another syncing device at hand.
3. If this device cannot run a keyring, keep its home folder private:
   full-disk encryption, and no other person or untrusted program with access
   to your account. Whoever can read Obsidian's files there may be able to
   read the vault key.

<a id="device_revoked"></a>

## This device was revoked

**What you see.** Within a few seconds of the revocation, the alert icon, and
its words read:

> obsync: error — This device was removed from your server. Your notes and vault key are safe here. Pair it again from a device that still syncs: obsync settings, Pair this device.

Up to 1.1.3 it shows the same message as
[The server no longer recognises this device](#the-server-no-longer-recognises-this-device),
and a request may be refused with `403 device_revoked`.

**Why it happens.** This device was revoked, from the dashboard or from another
device's **Devices** list. Revocation is final by design.

**How to fix it.** Pair the device again as a new device. Its notes stay in its
vault.

<a id="stale_timestamp--the-clock"></a><a id="stale_timestamp-the-clock"></a>

## The clock is wrong

**What you see.** The alert icon, the first time the server refuses the
device, and its words read:

> obsync: error — This device's clock is more than five minutes off, so your server refuses it. Set the date and time to update automatically; sync resumes by itself.

Up to 1.1.3 it reads `obsync: error — 401 stale_timestamp: timestamp is outside
the ±300 s window`, and only after Obsidian restarts; before that, edits from
that device quietly stop reaching the server.

**Why it happens.** Every request is signed with the time it was made, and the
server accepts five minutes either way. This device's clock, or the server's,
is further off than that. The window is fixed; no setting widens it.

**How to fix it.**

1. Turn automatic date and time back on, on whichever of the two is wrong.
2. A server that was suspended for a long time, and a phone with its time set
   by hand, are the usual culprits.
3. Select **Sync now**, or restart Obsidian.

## `edge_required`

**What you see.** Every request refused with `421 edge_required`, including
the first pairing attempt. Up to 1.1.3 a device that was already running reads
offline instead, and after a restart shows
`obsync: error — 421 edge_required: edge connecting-address header missing`
(TODO(1.1.4-text)).

**Why it happens.** The server is set up for Cloudflare's edge
(`OBSYNC_EDGE=cloudflare`), and this request did not come through it, or it
came through a connector at an address the server has not been told to trust.
In that mode the server refuses any request it cannot trace back through the
edge.

**How to fix it.**

1. Reach the server through the edge, not around it: use the edge's hostname in
   the **Server URL**.
2. If the edge requires a service token, paste its headers into **Custom
   request headers**, one per line as `Name: value`.
3. A server with nothing like that in front should run with `OBSYNC_EDGE=none`.
4. If every request is refused even when it goes through the edge, the edge's
   connector reaches the server from an address outside the private networks
   the server trusts by default. On the server, add the connector's network to
   `OBSYNC_TRUSTED_PROXY_CIDRS` and restart it.

<a id="replayed_nonce"></a>

## A request arrived twice

**What you see.** An occasional `401 replayed_nonce`, or one of the two
related `503` codes in [Other refusals](#other-refusals-a-device-can-show).

**Why it happens.** Every signed request can be used once. A repeat means the
same request reached the server twice: a proxy retried it, or two devices are
running with one device's credential.

**How to fix it.**

1. The plugin never repeats a request itself, so look outside it: turn off
   request retries in your proxy.
2. Do not copy one device's plugin data onto another. Pair each device on its
   own.

<a id="last_device"></a>

## The last device cannot be revoked

**What you see.** `409 last_device` when revoking, from the plugin or the
dashboard.

**Why it happens.** It is the only ACTIVE device, and the account has no
recovery registered, so revoking it would leave an account nobody can reach.
Since 1.1.3 an account registers recovery at setup, and there the last device
can be revoked; the dialog asks you to keep the setup token and the recovery
phrase first. Older accounts and servers still refuse.

**How to fix it.** Pair another device first, then revoke. Or update the
server and every device, so the account can register recovery.

## The dashboard signs itself out on every page load

**What you see.** `/login?token=…` looks fine, then every page says you are
signed out.

**Why it happens.** The address is not one the browser treats as secure. The
dashboard's cookies are marked `Secure`, and the browser silently drops them:

- over plain `http` to any IP address or network name that is not this
  computer: every browser drops them;
- over plain `http` to `localhost` or `127.0.0.1` in **Safari**: Chrome and
  Firefox keep them there, Safari does not.

**How to fix it.** Open the dashboard through its HTTPS address, by name. On
the server's own computer, Chrome and Firefox also accept plain
`http://localhost` ([the dashboard's security](security/dashboard.md)).

## Repeated `dashboard_login_refused` lines

**What you see.** `event=dashboard_login_refused decision=bad_login_token` in
the server's log, or on the dashboard's **Logs** page, from an address you do
not recognise.

**Why it happens.** Something is guessing sign-in tokens. None can succeed
without the real token. There is deliberately no attempt limit: a limit keyed
to the caller's address would lock you out too, behind a shared proxy
([the dashboard's security](security/dashboard.md)).

**How to fix it.** Nothing is required. If the noise bothers you, keep the
dashboard off any public address, and rotate the setup token if you think it
was ever exposed ([Recovery](recovery.md)).

## The server cannot listen on its address

**What you see.** The server stops as it starts. Its last line is
`event=listen_failed decision=exit addr=[::]:8080 io=AddrInUse`, with your
address, port and reason. Up to 1.1.3 the line did not name the address.

**Why it happens.** The server could not open the address and port the line
names. The `io` word says why:

- `AddrInUse`: something already listens on that port, often a second copy
  of the server or another service.
- `AddrNotAvailable`: this machine has no such address, a typing mistake or
  another machine's address.
- `PermissionDenied`: a port below 1024, which the unprivileged server may
  not open.
- Before it, a `listen_ipv4_only` line: this machine or container has no
  IPv6, so the server tried the same port on IPv4 (`0.0.0.0`), and the
  failure is about that address.

**How to fix it,** on the server: stop whatever holds the port, or set
`OBSYNC_LISTEN` to a free address and port above 1024 (the default is
`[::]:8080`), and point your proxy at it. Then start the server again. Your
devices wait and resume on their own.

<a id="missing_auth-and-bad_signature"></a>

## The server no longer recognises this device

**What you see.** Sync stops with this message, the same in 1.1.3 and 1.1.4,
a few seconds after the server stopped accepting the device:

> obsync: error — This server no longer recognises this device. Your local notes and vault key are safe. In obsync settings, pair from a syncing device, or use Setup or recover with this server's setup token and this vault's recovery phrase.

Earlier versions showed `401 missing_auth` or `401 bad_signature`.

**Why it happens.** The server has no record of this device, or the record
does not match: the device was revoked, the server was rebuilt, or the server
was restored from a backup older than this pairing.

**How to fix it.**

1. Check the **Server URL** is the server you mean.
2. Pair from a device that still syncs. Or, with no syncing device left, use
   **Setup or recover** with the server's setup token, after restoring the
   24-word phrase if this is a new installation. Local notes are kept.
3. An empty, rebuilt server can simply be set up again. An existing account
   needs recovery to have been registered before the credentials were lost:
   [Recovery](recovery.md) explains the limits, and
   [moving to a different server](recovery.md#moving-this-vault-to-a-different-server).

## The server has run out of storage

**What you see.** The alert icon, and its words read:

> obsync: error — Your server is out of storage, so it refuses new changes. Free space on the server or raise its quota; sync resumes by itself.

A phone also says it once in a notice. New and changed notes stay on the
device, and the alert clears once the server accepts a change again. Up to
1.1.3, a device that is already running shows it is offline and keeps
retrying. The server's log and its dashboard show `volume_full` or
`journal_full`.

**Why it happens.** The server refuses to write below a reserve of free space
on its volumes, rather than fill the disk. The limit is the size you declared
for each volume, minus what is already stored.

**How to fix it,** on the server:

1. Free space on the volume the refusal names, or grow the volume.
2. If you grew it, raise the declared size to match (`OBSYNC_BLOBS_CAPACITY`
   or `OBSYNC_JOURNAL_CAPACITY`, or the chart's claim sizes), then restart the
   server.
3. Nothing is lost on the devices: they send what they hold once the server
   accepts writes again. [Storage](storage.md) explains the reserve.

## Other refusals a device can show

Setup and pairing say what happened and what to do in words (1.1.4), and the
code stays in the log. Elsewhere the plugin prints the server's refusal as
`<status> <code>: <detail>`, so any code below appears in the status bar or in
a notice exactly as it is spelled here. These are the ones left after the
entries above; none of them is a reason to repeat setup.

| Code | What it means | What to do |
| --- | --- | --- |
| `409 already_claimed` | the pairing code has already been claimed by another device | mint a new one with **Pair a new device** |
| `410 pairing_expired` | the code was not claimed, or its key not collected, within its ten minutes; answered for an hour afterwards, then `404 unknown_pairing` | mint a new one |
| `409 missing_chunks` | a version was posted naming chunks the server does not hold, so it refused to record it rather than record a file it cannot serve | let sync run again; it re-uploads what is missing. A repeat is worth a report |
| `409 too_many_heads` | one file has accumulated more unmerged heads than the server will carry | resolve the conflict copies for that file, which retires its heads |
| `503 nonce_cache_full` | the replay cache is full | transient by construction: a repeatable request retries itself with backoff, and the next sweep clears it |
| `503 slow_body` | this device's connection sent a request more slowly than the server accepts; the server and its storage are fine | nothing: it retries by itself. If a large file from a phone never arrives, move the phone to a stronger connection or to Wi-Fi |
| `503 body_incomplete` | a request's body ended or its connection broke before the whole body arrived: the device went offline mid-request, or a proxy in front of the server gave up on it; the server and its storage are fine | nothing: it retries by itself. If it repeats, check the proxy's body-size and timeout settings |
| `503 nonce_share_full` | this one device has sent more signed requests in the last ten minutes than its share of the replay cache holds; other devices are unaffected | transient: its requests retry with backoff as its older ones age out. A device that keeps hitting it is misbehaving: update or revoke it |
| `503 nonce_log_unavailable` | the server could not record replay state, so it refused the request rather than accept one it cannot prove is not a replay | the server's own log names the I/O error; treat it as a storage problem |

## Sync stopped with an error

**What you see.** The alert icon, whose words read `obsync: error — <reason>`.
From 1.1.4 the reason is a sentence that says what happened and what to do,
and **Show sync status** repeats it on its **State** row. What it names does
not move until it is resolved.

**Why it happens.** The plugin stops rather than guessing. The reason names
it, and **Show sync status** repeats it.

A running device names a refusal the first time the server makes it -- a
full volume, a revoked device, a clock too far off, something in front of the
server answering instead of it -- in words, and the words clear themselves
once the server accepts again (issue #155). Only a server that does not answer
reads `offline — retrying`. The code below is in the obsync log line.

**How to fix it,** by what the reason says:

| Reason | What it means | What to do |
| --- | --- | --- |
| `volume_full` or `journal_full` (HTTP 507) | the server's free-space watermark refused the write | free space on that volume, or grow it and the claim together |
| `quota_exceeded` (HTTP 507) | the account quota is exhausted | raise the quota, or remove files and let retention expire |
| `not_obsync` | a proxy, access policy or sign-in page answered instead of obsync | check the Server URL, and the custom request headers in obsync settings |
| `not_ready` (HTTP 503) | the server is not serving: a volume is unwritable, or it is replaying its journal | read the server's own log line, which names the volume and the I/O error |
| `journal_faulted` (HTTP 503) | a journal write failed and the server refuses to acknowledge anything it cannot durably record | the server log names the cause; the volume is the place to look |
| a credential-storage failure | Obsidian's secret storage is unavailable or unverified | reload Obsidian; if it keeps happening, reinstall obsync and pair this device again, with the recovery phrase or another syncing device at hand ([Where your keys are kept](community-plugin.md#where-your-keys-are-kept)); do not repeat server setup |

<a id="a-copied-or-renamed-vault-shows-a-storage-error"></a>

## A copied or renamed vault says it is a copy

**What you see.** In obsync's settings: "This vault is a copy, or its folder
was renamed. It will not sync as the original. Pair it as a new device, or
start fresh." Up to 1.1.3 the plugin failed to load instead, with "Credential
storage could not be verified (missing_secret)".

**Why it happens.** Obsidian keeps each vault's secrets under that vault's own
identity. A vault copied with its `.obsidian` folder, or a vault folder renamed
while Obsidian was closed, is a new vault to Obsidian, so the copy holds none
of the original's keys. obsync never syncs it as the original. Your notes are
untouched.

**How to fix it.**

1. To keep this vault syncing, select **Pair this device** and pair it from a
   device that still syncs. It joins as a new device.
2. To use it as a separate vault, select **Start fresh**. This also forgets
   the server address the copy brought with it.
3. Once it is paired, the device the vault was before stays in the **Devices**
   list under its old name. Revoke that entry once the original vault is gone,
   never while the original still syncs.
4. To add a device, pair it. Copying a vault by hand, or renaming its folder,
   is not a way to add one.

<!-- CAPTURE(1.1.4): Settings on a copied vault: the copy notice with Pair this device and Start fresh -->

## A file is not syncing

**What you see.** One file never appears on the other device, and nothing
reports an error.

**Why it happens.** It is left out by design. Hidden folders (`.obsidian`,
`.git`), linked (symlinked) folders, the files Windows writes into folders by
itself (`Thumbs.db`, `desktop.ini`), and anything outside this device's folder
selection are not synced in either direction.

**How to fix it.**

1. Check **Sync folders on this device** in the plugin's settings.
2. Add the file's folder there and select **Save**. The files already on this
   device under it are sent, and whatever the server holds under it is brought
   down. On a vault with a long history this takes a while.

![The Sync folders on this device section: Folder selection set to Whole vault, the Selected folders box, and the Save button](assets/settings-sync-folders.png)

## Changes wait while Obsidian is in the background

**What you see.** On a computer, a note you change while Obsidian's window is
minimized, behind other windows or on another desktop reaches your other
devices minutes later, often only once you bring the window forward.

**Why it happens.** A hidden Obsidian window slows its own timers to about one
a minute, and obsync up to 1.1.3 waited on those timers before each upload.
From 1.1.4 obsync keeps time in a small background worker that a hidden window
does not slow.

**How to fix it.**

1. Update obsync to 1.1.4 or later: **Settings → Community plugins → Check for
   updates**.
2. If it still happens, look in [the plugin's own log](#how-to-collect-a-report)
   for a warning that starts with `obsync timers decision=fallback`. It means
   Obsidian on this computer did not let obsync start its worker, so a change
   made in the background can again take minutes, and uploads at once when the
   window comes forward. Open an issue with that line.

## A large file did not arrive on a phone

**What you see.** A file syncs between computers but is missing on a phone,
and **Show remote-only files** lists it.

![The Remote only dialog listing a 2 MiB file above this device's per-file ceiling, with a Fetch button](assets/remote-only-files.png)

**Why it happens.** It is above that device's limits: **Largest file to
download** (512 MiB on a phone by default) or **Total to keep on this device**
(50 GiB). A phone that runs out of memory loses the whole sync pass, so these
limits exist. Computers have none by default.

**How to fix it.**

1. Run **Show remote-only files** on that device.
2. Select **Fetch** beside the file you need.
3. Or raise the limit in settings, if the device has room.

## Notes deleted on one device disappeared everywhere

**What you see.** You deleted a folder or many notes on one device, and they
are gone from every other device too. From 1.1.4, deleting five or more notes
at once asks first, in one notice:

> obsync: you deleted 20 notes (in Notes). Delete them on your other devices too? They stay there until you choose.

with **Delete everywhere** and **Restore here**. The question also waits in
obsync's settings under **Deletions held back**. Fewer than five deletions, and
the ones you confirm, reach the other devices within seconds. Up to 1.1.3
there is no warning: in a test, 20 notes deleted as one folder left the other
device two seconds later.

**Why it happens.** A deletion syncs like any other change. The server keeps
every deleted note's content for 30 days by default.

**How to fix it.**

1. If the question is still open, choose **Restore here**: the notes come back
   on this device exactly as they were, with no copies, and nothing is deleted
   anywhere.
2. Otherwise, on any device, open **Restore from history** in the command
   palette.
3. Select **Load next**, and **Restore a copy** beside each note you want back
   ([Restore a retained version](daily-use.md#restore-a-retained-version)).
4. Each note comes back as a copy with a new name; rename it if you like.

## A deleted folder stays on a Mac

**What you see.** A folder you deleted on another device is still on a Mac,
even after **Sync now** and a restart. From 1.1.4 obsync says so once:

> obsync kept the folder "&lt;folder&gt;" here although &lt;device&gt; deleted it: it still holds 1 item that is not a synced note -- a hidden file, another app's data, or a note not sent yet -- and a folder is only removed when it is empty. Nothing in it was deleted. Delete the folder here if you no longer need what is in it.

Up to 1.1.3 the folder stays, empty, with no word.

**Why it happens.** obsync never deletes a folder that still holds something it
did not put there. Up to 1.1.3 that included the hidden `.DS_Store` file Finder
leaves in a folder it opened. From 1.1.4 the files the operating system writes
by itself (`.DS_Store`, `._` files and a custom folder icon on a Mac;
`Thumbs.db` and `desktop.ini` on Windows) go with the folder, so a folder is
kept only for something else.

**How to fix it.** Look inside the folder on that device. If you no longer need
what is in it, delete the folder there, in Obsidian or in Finder.

## A linked folder shows up empty on other devices

**What you see.** Up to 1.1.3, on other devices, an empty folder appears with
the name of a folder that is a link (a symlink) on one device, and nothing in
it ever arrives. Tested with a linked folder inside another folder. From
1.1.4, the device with the link says once:

> obsync doesn't sync linked folders: "&lt;folder&gt;" is a link, so it stays on this device only. Nothing in it is sent to your other devices, and nothing from them is written into it. To sync it, move the folder itself into the vault instead of linking to it.

and the empty folders an earlier version made on the other devices go at its
next start.

**Why it happens.** obsync never syncs what is inside a linked folder: the
link points outside the vault. Up to 1.1.3 it still sent the folder's name, so
the other devices made a real, empty folder.

**How to fix it.**

1. If you want those files synced, move them into the vault as a real folder,
   instead of linking to them.
2. Otherwise, delete the empty folder on the other devices.

## Restoring a copy fails on a USB stick or memory card

**What you see.** Up to 1.1.3, **Restore a copy** says a restored copy "may
exist" at a name, and no copy appears; a conflict copy can fail the same way.
From 1.1.4 both work on these drives, and this notice appears only if a copy
could not be confirmed for another reason. The notice reads:

> A restored copy may exist at "&lt;note&gt; (restored-&lt;id&gt;).md". Check that path before retrying; no existing file was overwritten.

**Why it happens.** The vault is on a drive formatted FAT32 or exFAT, as most
USB sticks and memory cards are. obsync creates these copies with a file-system
feature those formats do not have, so that a copy can never replace a file by
accident. Ordinary syncing works on these drives; only these copies fail.

**How to fix it.**

1. Nothing was overwritten. Check the named path; there is usually nothing
   there.
2. Update obsync to 1.1.4 or later on this device, and try again.
3. If it still fails, keep the vault on the computer's own drive, or on a drive
   formatted for your system (APFS on a Mac, NTFS on Windows, ext4 on Linux),
   and send the lines the obsync log shows for that copy
   ([How to collect a report](#how-to-collect-a-report)).

## A photo or PDF from my phone never arrives on my other devices

**What you see.** On a phone with a weak connection, a photo, a PDF or another
large file stays unsynced and keeps retrying. Short notes still sync.

**Why it happens.** Before 1.1.4 the server gave each piece of a large file a
fixed time to arrive. On a slow upload link (below roughly half a megabit per
second: weak mobile data, a busy hotspot) a big piece never made it in time,
so every retry failed the same way. The server's answer blamed its storage,
but nothing was wrong with it: the connection was simply too slow, and from
1.1.4 the answer says so (`slow_body`).

**How to fix it.**

1. Update your server to 1.1.4 or later.
2. Give it time on a slow link: a large file sends more slowly, but it
   arrives.
3. If it still does not arrive, move the phone to Wi-Fi or a stronger
   connection.

## Notes I deleted are still on my other devices

**Symptom.** You deleted five or more notes at once, or a folder, and a notice
asks "Delete them on your other devices too?". The notes are still on your
other devices.

**Cause.** obsync holds a bulk deletion until you answer, so a folder deleted
by mistake is never deleted everywhere at once. The question survives a
restart; smaller deletions go at once.

**Fix.** Choose **Delete everywhere** to delete them on every device, or
**Restore here** to put them back on this device. Both answers are also under
Settings, obsync, **Deletions held back**.

## A conflict copy appeared

That is obsync refusing to throw away an edit, not a failure. See
[Conflicts](conflicts.md).

## A note or folder took the other device's name

**What you see.** A note or folder you renamed now has the name another device
gave it, and a notice says it `was renamed differently on two devices`.

**Why it happens.** Two devices renamed the same note or folder differently
before either of them synced. So that every device ends with the same name,
each one picks the same one of the two names, by the same fixed rule, moves the
notes there, and says in the notice which name it kept. Edits made under either
name are kept. Nothing is copied or deleted.

**How to fix it.** Nothing needs fixing. If you prefer the other name, rename
the note or folder again on any one device and let it sync.

## Two folders that differ only in capitalisation

**What you see.** One device shows two folders whose names differ only in
capitals, `team docs` with your current notes and `Team docs` with copies that
no longer change, while another device shows one.

**Why it happens.** A Mac, a Windows computer and an Android phone or tablet
normally treat `Team docs` and `team docs` as ONE folder; Linux, an iPhone and
an iPad keep them as two. A version before 1.1.0 could send a capitals-only
rename as NEW notes instead of a rename, so a device that keeps the two apart
kept both. From 1.1.0 a capitals-only rename is sent as a rename, and devices
that fold capitals rename the folder itself.

**Renaming by capitals alone on Android.** Obsidian on Android cannot rename a
note or folder by capitals alone: it answers "Destination file already
exists". Rename it on another device, or rename it here to a different name
first and then to the one you want; obsync carries the rename everywhere. From
1.1.4 an Android device RECEIVES such a rename from your other devices. If it
ever cannot, it says "obsync could not change the capitals of ..." and keeps
the old name; the same two renames on that device fix it.

**If the other device is still on 1.0.x,** this device refuses the moves it
asks for and tells you once per folder; nothing of yours is written over,
moved or deleted. A note CREATED there meanwhile arrives in the folder this
device shows. Update that device, or rename the folder here to match, and the
two agree again.

**If a device syncs only some folders,** a capitals-only rename of its
selected folder is followed, on a device that folds capitals. **A device that
keeps the two spellings apart does not follow it:** it keeps its folder under
the old spelling and stops receiving what you put in that folder elsewhere.
Nothing is lost. Rename the folder on that device to the new spelling (or
select it again under the new name in **Sync folders on this device**), let it
sync once, and the two agree again.

**"Another device published a folder called ... and this device syncs ..."**
is the notice for a folder on ANOTHER device that differs from yours only in
capitals and is not a rename of it: that device has both folders. This device
keeps syncing the folder you chose. Open the device that has both, move the
notes out of the one you do not want and delete it (following the order
below), and let each device sync once.

**Two devices renaming the same folder to two different capitalisations at
once** end with copies of its notes on both. Nothing is lost: rename the
folder on ONE device, let every device sync once, then delete the copies you
do not want. Two different NAMES settle on one name by themselves: see
[A note or folder took the other device's name](#a-note-or-folder-took-the-other-devices-name).

**How to fix it: do not delete the stale folder first.** On a device that
folds capitals, the old spelling IS the live folder, so deleting it too early
deletes the notes you are trying to keep, everywhere. Follow this order:

1. **Check that every device runs 1.1.0 or later,** and update any that does
   not: **Devices** in obsync's settings shows each device's version. Open each
   one and let it sync once. A device that folds capitals then forgets the old
   spelling and says so once in a notice. That is what makes the next steps
   safe.
2. **Check the stale folder** on the device that shows two. Its notes should
   be the ones you renamed away from. Anything you edited there after the
   rename exists only there: move it into the live folder first, under a name
   of its own.
3. **Delete the stale folder on that one device.** That removes the abandoned
   copies on every device and touches nothing live.
4. An EMPTY folder under the old spelling can stay or go as you like.

The plugin does not do step 3 for you: it cannot know that every other device
has already been updated, and deleting one sync too early is exactly the loss
this order avoids.

## How to collect a report

1. **The plugin's own log.** On a computer, open Obsidian's developer console
   (`Cmd`+`Option`+`I` on macOS, `Ctrl`+`Shift`+`I` on Windows and Linux) and
   filter for `obsync`. Problems are at the warning level; routine decisions
   are at the verbose level, which the console hides until you turn it on.
   Every refusal names the request, the status and the code, never the content.
2. **Show sync status**, from the command palette: what sync is doing and why
   it is not doing more. Its first row is this device's **Server** address;
   leave that row out, for the reason the list below gives.
3. **The server's log,** if you run the server. One line per decision. The
   useful ones: `event=request … status=<code> decision=<what it decided>`,
   `event=readiness decision=not_ready volume=<which> io=<error>`, and the
   START and SUMMARY lines of journal replay, garbage collection and scrub.
4. **Versions.** The plugin version from Settings → Community plugins, the
   server version from `obsyncd version`, and the Obsidian version.

**What never goes into a report,** whether it is an issue, a discussion or a
message to anybody:

- the setup token, a pairing code, or a dashboard sign-in link;
- the 24-word recovery phrase, or any part of it;
- the value of a custom request header;
- your server's hostname or address, if it is not one you publish;
- file names or note content that are not disposable.

A log line from this project is safe to paste by construction: the server
never logs a key or a path, and the plugin never logs a request body. A
screenshot of the settings or the dashboard is not: read every pixel first.
