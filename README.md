# Self Hosted Private Sync

Read in your language: [English](README.md) • [العربية](docs/ar/README.md) • [Deutsch](docs/de/README.md) • [Español](docs/es/README.md) • [فارسی](docs/fa/README.md) • [Français](docs/fr/README.md) • [Bahasa Indonesia](docs/id/README.md) • [Italiano](docs/it/README.md) • [Nederlands](docs/nl/README.md) • [Polski](docs/pl/README.md) • [Português](docs/pt/README.md) • [Português (Brasil)](docs/pt-br/README.md) • [Русский](docs/ru/README.md) • [ไทย](docs/th/README.md) • [Türkçe](docs/tr/README.md) • [Українська](docs/uk/README.md) • [Tiếng Việt](docs/vi/README.md) • [日本語](docs/ja/README.md) • [한국어](docs/ko/README.md) • [中文简体](docs/zh-cn/README.md) • [中文繁體](docs/zh-tw/README.md)

Self-hosted, end-to-end encrypted live sync for [Obsidian](https://obsidian.md):
one dependency-free Rust server with a built-in dashboard that you run
yourself, plus this plugin. Files of any size, every Obsidian platform, no
subscription, no third party.

Install it from Settings → Community plugins → Browse as **Self Hosted Private
Sync** (plugin id `obsync-private-sync`), on Obsidian 1.13.0 or newer.

> [!IMPORTANT]
> - It syncs to a server **you** run: no hosted service, no account elsewhere.
> - Back up your vault first; keep the 24-word recovery phrase off the device that made it.
> - Never run it alongside another sync (Obsidian Sync, a cloud folder, another plugin) on one vault.
> - Young software: read the [`CHANGELOG.md`](CHANGELOG.md) entry for your version, update every device, and know what each [validation run](docs/validation-runs/) covered.

## What this plugin accesses

- **Your server, nothing else.** Every request goes to the **Server URL** you type; no telemetry, no third party.
- **An account on that server**, created from the setup token; your Obsidian account plays no part.
- **GitHub Releases, through Obsidian**, for install and update; Obsidian ignores the extra release assets.
- **Your vault's file list**, to decide what to sync; hidden (`.obsidian`, `.git`) and symlinked folders skipped.
- **The clipboard, written only** by **Copy code** and **Copy link** in **Pair a new device**, never read.

What the server can and cannot see: [`SECURITY.md`](SECURITY.md) and the [threat model](docs/threat-model.md).

## Get syncing

Five steps from nothing to two devices in sync. `v1.0.6` is the release this
page was written for; use the tag you are installing.

### 1. Start the server

Verify the signature, then run exactly the digest it printed:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The simple path is Compose with Caddy, from a checkout of this repository:
HTTPS on any network, no domain, no account anywhere.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is the name your devices will type; it need only resolve on
your own network. `OBSYNC_BIND_ADDRESS` is the address ports 80 and 443 are
published on: a bind address limits the destination interface, not the source,
so your firewall decides who reaches it. Compose refuses to start until you have chosen.

Already have HTTPS in front, from a proxy or tunnel you trust? Run the bare
server instead: [Run the server](docs/server.md).

### 2. Read the setup token

At first boot the server mints a setup token and writes it to its journal
volume, mode 0600, never logged. It creates your account once and
remains the dashboard's recovery sign-in: guard it like the recovery phrase.
Read it from the container:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Trust the certificate, once per device

Caddy signs with an authority it made on first start; each device must trust it
once. Export the root certificate and install it per platform as
[Run the server](docs/server.md#trust-the-certificate-authority-once-per-device)
shows; on iOS, trusting it is a second switch after installing.

### 4. Set up the first device

1. Settings → Community plugins → Browse → **Self Hosted Private Sync** →
   Install → Enable.
2. Set **Server URL** to your server (`https://sync.example.org`, port included
   unless 443), then choose **Whole vault** or **Selected folders only**; it
   can only narrow later.

   ![The plugin's settings tab: the Server URL field holding a demo host name, the edge headers box, and the Connection row with its Check and Open dashboard buttons](docs/assets/settings-server.png)

3. Paste the setup token under **First-time setup**, select **Set up**, and
   write down the 24-word recovery phrase.

   ![The This device section of the settings tab: the Pairing row with Pair this device and Pair a new device, the First-time setup row with the Setup token field and the Set up button, and the Vault key row](docs/assets/settings-setup.png)

### 5. Pair the second device

1. Install the plugin there with the same **Server URL**; on the first device
   run **Pair a new device** for a code valid ten minutes.

   ![The Pair a new device dialog on the first device, its code obscured, with Copy code and Copy link buttons and the line Waiting for the new device](docs/assets/pair-new-device.png)

2. On the second device open **Pair this device**, paste the code, and select
   **Pair**.
3. Back on the first device, approve it by name. Edit a note on either; it
   appears on the other within seconds.

   ![The first device asking whether to approve the new device by name, with Approve and Reject buttons](docs/assets/pair-approve.png)

![Animated: the pairing code shown on the first device, pasted on the second, approved on the first, and the first note arriving on the second](docs/assets/pairing.gif)

Trying it on one computer? `http://127.0.0.1:8080` reaches the bare server on
a desktop; Obsidian on iOS and Android refuses plain HTTP.

Phone screenshots are not in this repository yet; they are taken on the
maintainer's devices and added when a validation run records them.

Every step in full: [Quickstart](docs/quickstart.md).

## Advanced: Cloudflare

The reference deployment has no public hostname: a Cloudflare Tunnel and a
private route reach the server's network, and each device's Cloudflare One
client carries the Server URL there. A public hostname behind Cloudflare
Access, with a service token in **Edge service-token headers** and
`OBSYNC_EDGE=cloudflare`, also works. Both, step by step: [Cloudflare](docs/cloudflare.md).

## Other ways to reach your server

Whichever you choose, the plugin needs HTTPS with a certificate every device
trusts; the server stays on plain HTTP behind that terminator.

- **LAN only.** The Compose path above, reached only at home; no sync away.
- **WireGuard.** Your own VPN home: fastest, entirely yours; a peer configuration on every device.
- **Tailscale.** A managed WireGuard mesh: least setup; a third party coordinates it, on its plan's terms.
- **A reverse proxy with automatic TLS**, such as Caddy on a public name: reachable from the internet, yours to patch.
- **Cloudflare Tunnel.** Above. No inbound port; a provider on the path, on its terms.

What a roaming device needs (route, name, certificate, firewall, iOS local-network
prompt): [Reaching it from outside your LAN](docs/server.md#reaching-it-from-outside-your-lan).

## Troubleshooting

| Symptom | Likely cause | First thing to try |
| --- | --- | --- |
| `obsync: offline` | The device cannot reach the Server URL | Open the URL in a browser there; check port, HTTPS, route |
| A phone will not connect while a computer syncs | The phone distrusts the private certificate | Install the root certificate; on iOS also enable it under Certificate Trust Settings |
| `401 stale_timestamp` | A clock is off by more than 300 seconds | Turn on automatic time on the device or the server |
| `403 device_pending` | Nobody has approved it yet | Approve it by name on the device you paired from |
| A file never arrives | Outside the folder selection, or above a phone's size ceiling | Check **Sync folders on this device**; on the phone run **Show remote-only files** |

Every other symptom and error code, and how to report one: [Troubleshooting](docs/troubleshooting.md).

## Documentation

[Quickstart](docs/quickstart.md) · [Run the server](docs/server.md) ·
[Cloudflare](docs/cloudflare.md) · [Daily use](docs/daily-use.md) ·
[Settings](docs/settings.md) · [Troubleshooting](docs/troubleshooting.md) ·
[Recovery](docs/recovery.md) · [Changelog](CHANGELOG.md)

Everything else: [docs/README.md](docs/README.md).

## Questions, bugs, and security

- **A question, or not sure it is a bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **A bug:** [open an issue](https://github.com/snaraj/obsync/issues/new/choose) with the report [Troubleshooting](docs/troubleshooting.md) describes; no token, no phrase, no address you would not publish.
- **A suspected vulnerability:** privately, through [`SECURITY.md`](SECURITY.md), never a public issue.

## License

MIT. See [`LICENSE`](LICENSE).
