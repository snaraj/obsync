# Self Hosted Private Sync

Read in your language: [English](README.md) • [العربية](docs/ar/README.md) • [Deutsch](docs/de/README.md) • [Español](docs/es/README.md) • [فارسی](docs/fa/README.md) • [Français](docs/fr/README.md) • [Bahasa Indonesia](docs/id/README.md) • [Italiano](docs/it/README.md) • [Nederlands](docs/nl/README.md) • [Polski](docs/pl/README.md) • [Português](docs/pt/README.md) • [Português (Brasil)](docs/pt-br/README.md) • [Русский](docs/ru/README.md) • [ไทย](docs/th/README.md) • [Türkçe](docs/tr/README.md) • [Українська](docs/uk/README.md) • [Tiếng Việt](docs/vi/README.md) • [日本語](docs/ja/README.md) • [한국어](docs/ko/README.md) • [中文简体](docs/zh-cn/README.md) • [中文繁體](docs/zh-tw/README.md)

Self-hosted, end-to-end encrypted live sync for [Obsidian](https://obsidian.md):
one dependency-free Rust server with a built-in dashboard that you run
yourself, plus this plugin. Files of any size, every Obsidian platform, no
subscription, no third party.

Install it from Settings → Community plugins → Browse as **Self Hosted Private
Sync** (plugin id `obsync-private-sync`), on Obsidian 1.13.0 or newer.

> [!IMPORTANT]
> This plugin syncs to a server **you** run. There is no hosted service and no
> account with anyone but yourself: without your own `obsyncd` reachable over
> HTTPS, the plugin has nothing to sync to.

> [!IMPORTANT]
> Back up your vault before the first sync, and keep the 24-word recovery
> phrase somewhere other than the device that generated it. The server stores
> ciphertext only and cannot recover a vault for you.

> [!IMPORTANT]
> Do not run this plugin alongside another sync solution on the same vault —
> Obsidian Sync, a file-syncing cloud folder, or another sync plugin. Two
> writers on one vault produce conflicts neither of them can reconcile.

## Before you rely on it

This is young software that syncs the only copy of your notes.

- **[`CHANGELOG.md`](CHANGELOG.md) is the maintained list of what is known.**
  Read the entry for the version you are on, and the entries above it.
  Release pages keep the notes they were published with; later findings are
  added here.
- **Update every device that syncs a vault.** One device left on an older
  version can still act on the old behaviour and affect the others.
- **What was exercised on hardware** is recorded per run in
  [`docs/validation-runs/`](docs/validation-runs/), including what each run
  did not cover. A platform no run names is not proven.
- **A stream of "merged concurrent edits" notices** on two devices editing one
  note: quit Obsidian on one of them so the other can drain, update both, then
  resume.

## What this plugin accesses

Short and complete, so you can decide before you install.

- **One network destination: your own server.** Every request goes to the
  **Server URL** you type into the plugin's settings, and to nothing else.
  There is no telemetry, no analytics, no crash reporter, no advertising, and
  no third-party service anywhere in the sync path. The plugin never downloads
  or runs code from that server either.
- **An account on that server, which you create.** The first device uses the
  setup token your server wrote at first boot; every other device is paired
  from a device that already syncs. Your Obsidian account plays no part.
- **Obsidian and GitHub, for install and update only.** Obsidian itself
  downloads `main.js`, `manifest.json` and `styles.css` from this repository's
  GitHub Releases. Each Release also carries a plugin ZIP and a release
  manifest for people deploying the server; Obsidian ignores both.
- **Your edge, only if you configured one.** Headers you paste under **Edge
  service-token headers** ride on every request to the Server URL above,
  because the proxy that needs them is on the path to your server.
- **Your vault's file list.** The plugin lists every file in the vault to
  decide what is in scope, reads the files inside your folder selection, and
  writes what other devices changed. Hidden folders (`.obsidian`, `.git`) and
  symlinked folders are skipped.
- **The clipboard, written and never read.** Only the **Copy code** and
  **Copy link** buttons in **Pair a new device** write to it. Nothing in the
  plugin reads the clipboard.
- **Your browser, when you ask for the dashboard.** **Open dashboard** opens a
  sign-in link in your browser, and only when that link is on your server's
  own origin.
- **Obsidian's secret storage.** The vault key, the device secret and any edge
  header values live there, never in plain plugin data.

What the server can and cannot see is in [`SECURITY.md`](SECURITY.md) and
[`docs/threat-model.md`](docs/threat-model.md).

<!-- README screenshot rule (AGENTS.md): this section leads with captures of
     the plugin and the dashboard. The five files below are committed PNGs from
     a validated device run; docs/captures/README.md holds the convention and
     the redaction rules. A change to what either surface renders asks the
     owner for fresh captures. -->

## Get synced in five steps

The path this release was validated on, from an empty vault to two devices in
sync. All five assume your own server is already running, which is the section
below; each step is written out in full in the quickstart.

1. **Install from Community plugins.** In Settings → Community plugins →
   Browse, search for **Self Hosted Private Sync** and select Install, then
   Enable — the same way every other Obsidian plugin arrives, on every
   platform.

   ![Obsidian's Community plugins browser showing Self Hosted Private Sync with its Install button](docs/captures/01-install-from-directory.png)

2. **Point it at your server and set it up.** Open the plugin's settings tab,
   set **Server URL** to your own server, choose which folders this device
   syncs, then paste your setup token under **First-time setup**.

   ![The plugin settings tab scrolled to the folder selection, Pairing, and the First-time setup token field](docs/captures/02-first-time-setup.png)

3. **Keep the recovery phrase.** Setup generates the vault key on this device
   and shows a 24-word phrase once: write it down and keep it somewhere other
   than this device, because the server holds ciphertext only and cannot
   recover a vault for you.

   ![The recovery-phrase dialog shown after first-time setup, its words obscured](docs/captures/03-recovery-phrase.png)

4. **Pair a second device with a one-time code.** Run **Pair a new device** on
   the first device, enter the code it shows on the second within ten minutes,
   and approve the device by name — the vault key travels encrypted under a
   pairing secret the server never sees.

   ![The Pair a new device dialog on the first device, its one-time code obscured](docs/captures/04-pair-a-new-device.png)

5. **Edit on either device and watch it land.** Type in a note on one device
   and it appears on the other within seconds, in both directions, with the
   status bar showing what sync is doing.

   ![The disposable note carrying both devices' edits, with the sync status bar visible](docs/captures/05-sync-both-ways.png)

The dashboard's device list and its revoke button are described under
[See your devices](docs/daily-use.md#see-your-devices) and were not exercised
in the 1.0.0 device run recorded in
[docs/validation-runs/2026-09-14.md](docs/validation-runs/2026-09-14.md).

## Get syncing

The shortest correct path: one machine you own runs the server, every device
reaches it over HTTPS, and each device is paired once. Signing in to Obsidian
authorizes nothing here; the only account is the one on your server.

### 1. Start the server

Two ways to start it. Both run the exact bytes the publisher signed: verify
the signature, read the digest from the verified output, and run that digest.
`v1.0.6` is the release this page was written against; use the tag of the
release you are installing.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**No HTTPS yet?** `deploy/compose` starts the server behind its own TLS
terminator (Caddy), on any network, with no domain and no account with
anybody. From a checkout of this repository:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is the name your devices will type. It only has to resolve on
your own network. `OBSYNC_BIND_ADDRESS` is the address of this host that ports
80 and 443 are published on: a bind address limits the destination interface,
not the source, so your firewall is what decides who reaches it.
Compose refuses to start until you have chosen. Both are explained in
[Run the server](docs/server.md).

**Already have HTTPS in front** of the machine, from a reverse proxy or a
tunnel you trust? Run the bare server. It speaks plain HTTP on port 8080, and
your terminator forwards to it:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Read the setup token

At first boot the server mints a setup token and writes it to its journal
volume, mode 0600, never logged. The token creates your account once, and it
then remains the dashboard's recovery sign-in for the life of the server: keep
it with the same care as the recovery phrase. Read it from the container
itself, with no helper image. On the Compose path:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

On the bare-server path:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Trust the certificate, once per device (Compose path)

Caddy issued the certificate from an authority it generated on first start,
so each device has to be told to trust that authority once. Export the root:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Install `obsync-root.crt` on each device. The steps for macOS, Windows, Linux,
iOS and Android are in
[Trust the certificate authority, once per device](docs/server.md#trust-the-certificate-authority-once-per-device).
On iOS, trusting the certificate is a second switch after installing it.

### 4. Set up the first device

1. Settings → Community plugins → Browse → **Self Hosted Private Sync** →
   Install → Enable.
2. In the plugin's settings, set **Server URL** to your server, port included
   when it is not 443: `https://sync.example.org`.

   ![The plugin's settings tab: the Server URL field holding a demo host name, the edge headers box, and the Connection row with its Check and Open dashboard buttons](docs/assets/settings-server.png)

3. Choose **Whole vault** or **Selected folders only** now. Once a device has
   synced, its selection can only narrow.
4. Paste the setup token under **First-time setup** and select **Set up**.
   Write down the 24-word recovery phrase and keep it off this device.

   ![The This device section of the settings tab: the Pairing row with Pair this device and Pair a new device, the First-time setup row with the Setup token field and the Set up button, and the Vault key row](docs/assets/settings-setup.png)

### 5. Pair the second device

1. Install and enable the plugin there, set the same **Server URL**, and
   choose its folders.
2. On the first device, run **Pair a new device**. It shows a code that is
   valid for ten minutes.

   ![The Pair a new device dialog on the first device, its code obscured, with Copy code and Copy link buttons and the line Waiting for the new device](docs/assets/pair-new-device.png)

3. On the second device, open **Pair this device**, paste the code, and
   select **Pair**.

   ![The Pair this device dialog on the second device, with the empty Pairing code field and the Pair button](docs/assets/pair-this-device.png)

4. Back on the first device, approve the new device by name. Edit a note on
   either one; it appears on the other within seconds.

   ![The first device asking whether to approve the new device by name, with Approve and Reject buttons](docs/assets/pair-approve.png)

   ![The second device showing the note written on the first device, with the status bar reading obsync idle](docs/assets/first-sync.png)

The whole pairing exchange, in one short loop:

![Animated: the pairing code shown on the first device, pasted on the second, approved on the first, and the first note arriving on the second](docs/assets/pairing.gif)

Phone screenshots are not in this repository yet; they are taken on the
maintainer's own devices and added when a validation run records them.

Every step in full, with what each screen asks and why:
[Quickstart](docs/quickstart.md).

**Trying it on one computer?** On a computer the plugin also accepts a plain
`http://` address, so `http://127.0.0.1:8080` reaches the bare server above
without a terminator. Phones do not: Obsidian on iOS and Android refuses plain
HTTP.

## Advanced: Cloudflare

The reference deployment has **no public hostname**. A Cloudflare Tunnel
connects the server's private network to Cloudflare, a private route tells
Cloudflare which addresses live behind that tunnel, and the Cloudflare One
client on each device carries the Server URL there. Nothing is reachable from
the internet, and large first syncs are not proxied through a public hostname.
The other shape, a public hostname behind Cloudflare Access with a service
token in **Edge service-token headers** and `OBSYNC_EDGE=cloudflare` on the
server, is also supported. Both, step by step: [Cloudflare](docs/cloudflare.md).

## Other ways to reach your server

One line each, no tutorial. Whatever you choose, the plugin needs HTTPS with a
certificate every device trusts, and the server itself stays on plain HTTP
behind that terminator.

- **LAN only.** The Compose path above, reached only at home. Simplest; no
  sync away from home.
- **WireGuard.** Your own VPN back to your network. Fastest and entirely
  yours; you carry a peer configuration on every device and keep one endpoint
  reachable.
- **Tailscale.** A managed WireGuard mesh with its own names. Least setup on
  the devices; a third party coordinates the mesh, and its plan limits are
  yours to read.
- **A reverse proxy with automatic TLS**, such as Caddy on a public name. A
  publicly trusted certificate and a permanent address; the server is then
  reachable from the internet, and the proxy and its updates are yours to keep
  right.
- **Cloudflare Tunnel.** Above. No inbound port; a provider on the path with
  its own terms.

What a roaming device needs, whichever you pick (the route, the name, the
certificate, the iOS local-network prompt, the firewall):
[Reaching it from outside your LAN](docs/server.md#reaching-it-from-outside-your-lan).

## Troubleshooting

| Symptom | Likely cause | First thing to try |
| --- | --- | --- |
| `obsync: offline` | The device cannot reach the Server URL | Open the URL in a browser on the same device; check the port, HTTPS, and the route |
| A phone will not connect while a computer syncs | The private certificate is not trusted on the phone | Install the root certificate; on iOS also turn it on under Certificate Trust Settings |
| `401 stale_timestamp` | A clock is off by more than 300 seconds | Turn automatic time on, on the device or the server |
| `403 device_pending` | Nobody has approved the device yet | Approve it by name on the device you paired from |
| A file never arrives | It is outside the folder selection, or above a phone's size ceiling | Check **Sync folders on this device**; on the phone run **Show remote-only files** |

Every other symptom, every error code, and how to collect a report worth
sending: [Troubleshooting](docs/troubleshooting.md).

## Documentation

| Page | What it answers |
| --- | --- |
| [Quickstart](docs/quickstart.md) | The first device and the second one, every step in full |
| [Run the server](docs/server.md) | Docker, Compose with Caddy, certificates, backups, reaching it from outside your LAN |
| [Cloudflare](docs/cloudflare.md) | Tunnel with a private route and the Cloudflare One client, or a public hostname behind Access |
| [Kubernetes](chart/README.md) | Installing the server with the signed Helm chart |
| [Daily use](docs/daily-use.md) | Commands, the status bar, what syncs and what does not, restoring a version, the dashboard |
| [Settings](docs/settings.md) | Every setting, its default, and when to change it |
| [Troubleshooting](docs/troubleshooting.md) | Symptom, cause, fix, and how to collect a report |
| [Conflicts](docs/conflicts.md) | What a conflict copy is and what to do with it |
| [Recovery](docs/recovery.md) | A lost device, a lost server, a moved server, a rotated token |
| [Installing and updating](docs/community-plugin.md) | Obsidian's directory, updates, credential custody, the listing review |
| [Threat model](docs/threat-model.md) | What is defended, and what is not |
| [The dashboard's threat model](docs/security/dashboard.md) | Sessions, sign-in, revocation, residuals |
| [Architecture](docs/architecture.md) | How the whole system is built, and every environment variable |
| [Protocol](docs/protocol.md) | The wire contract between plugin and server |
| [Storage](docs/storage.md) | Volumes, durability, retention, scrub, and every refusal |
| [Validation](docs/validation.md) | The device validation plan and what "ready" means |
| [Releases](docs/release.md) | How a release is cut, signed, and audited |
| [Translations](docs/translations.md) | Which languages the guides exist in, and how they are kept current |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each version |
| [`SECURITY.md`](SECURITY.md) | Posture, supported versions, and how to report a vulnerability |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to work on this repository |

## Questions, bugs, and security

- **A question, or something you are not sure is a bug:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **A bug:** [open an issue](https://github.com/snaraj/obsync/issues/new/choose)
  with the bug-report template and the report described in
  [Troubleshooting](docs/troubleshooting.md). Include no token, no recovery
  phrase, and no address you would not publish.
- **A suspected vulnerability:** privately, through
  [`SECURITY.md`](SECURITY.md) — never a public issue.

## License

MIT. See [`LICENSE`](LICENSE).
