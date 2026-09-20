# Self Hosted Private Sync

Self-hosted, end-to-end encrypted live sync for [Obsidian](https://obsidian.md):
one dependency-free Rust binary with a built-in dashboard, plus an Obsidian
plugin. Files of any size, bounded only by your disk. No subscription, no
third-party service, no crates, no npm packages.

1.1.0, in Obsidian's community plugin directory as **Self Hosted Private
Sync** (plugin id `obsync-private-sync`): install it from Settings → Community
plugins → Browse, on every platform Obsidian runs on. The device run behind
1.0.0 is [`docs/validation-runs/2026-09-14.md`](docs/validation-runs/2026-09-14.md):
it proved setup, pairing and two-way sync between a Mac and an iPhone on one
LAN, and nothing about iPad, Windows, or reaching the server from off that LAN.

**Full documentation: [snaraj.github.io/obsync](https://snaraj.github.io/obsync/)**, built from [`docs/`](docs/).

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

## What it does

- Syncs one vault across every Obsidian platform (macOS, Windows, Linux, iOS,
  iPadOS, Android) through a plugin that talks to your own server.
- Encrypts every chunk and every manifest on the device. The server stores
  ciphertext only and never learns the vault key or a single file name.
- Handles large files by content-defined chunking with resumable, deduplicated
  uploads: a 100 GB video and a 2 KB note follow the same path.
- Keeps 30 days of versions and never silently discards a conflicting edit.
- Ships a dashboard: account, devices, storage per volume, scrub and
  garbage-collection state, pairing, and installation guidance.
- Runs as one static binary: Docker, Kubernetes, or a bare host.

<!-- README screenshot rule (AGENTS.md): this section leads with captures of
     the plugin and the dashboard. The five files below are committed PNGs from
     a validated device run; docs/captures/README.md holds the convention and
     the redaction rules. A change to what either surface renders asks the
     owner for fresh captures. -->

## Get synced in five steps

The path this release was validated on, from an empty vault to two devices in
sync. All five assume your own server is already running, which is the section
below, and each is written out in full in the [quickstart](docs/quickstart.md).

1. **Install from Community plugins.** In Settings → Community plugins →
   Browse, search for **Self Hosted Private Sync**, then Install and Enable —
   the same way every other Obsidian plugin arrives, on every platform.

   ![Obsidian's Community plugins browser showing Self Hosted Private Sync with its Install button](docs/captures/01-install-from-directory.png)

2. **Point it at your server and set it up.** Open the plugin's settings tab,
   set **Server URL** to your own server, choose which folders this device
   syncs, then paste your setup token under **First-time setup**.

   ![The plugin settings tab scrolled to the folder selection, Pairing, and the First-time setup token field](docs/captures/02-first-time-setup.png)

3. **Keep the recovery phrase.** Setup generates the vault key on this device
   and shows a 24-word phrase once: write it down and keep it off this device,
   because the server holds ciphertext only and cannot recover a vault for you.

   ![The recovery-phrase dialog shown after first-time setup, its words obscured](docs/captures/03-recovery-phrase.png)

4. **Pair a second device with a one-time code.** Run **Pair a new device** on
   the first, enter the code on the second within ten minutes, and approve by
   name — the vault key travels encrypted under a secret the server never sees.

   ![The Pair a new device dialog on the first device, its one-time code obscured](docs/captures/04-pair-a-new-device.png)

5. **Edit on either device and watch it land.** Type in a note on one device
   and it appears on the other within seconds, in both directions, with the
   status bar showing what sync is doing.

   ![The disposable note carrying both devices' edits, with the sync status bar visible](docs/captures/05-sync-both-ways.png)

The dashboard's device list and revoke button are in
[the dashboard guide](docs/dashboard.md): not exercised in the device run recorded in
[docs/validation-runs/2026-09-14.md](docs/validation-runs/2026-09-14.md).

## Get syncing

Run your own server, then install the plugin from Obsidian's Community Plugins
browser on each device and pair them. Signing in to Obsidian does not authorize
self-hosted sync, and there is no subscription or hosted account. Two ways to
start the server, in full under [run the server](docs/server.md), with Kubernetes.

**Already have a TLS terminator.** Deploy by digest, never by tag: verify the
signature, read the digest from the verified payload, and run exactly that
digest. The tag below is the release you are installing.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.1.0 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

At first boot the server mints a setup token, mode 0600 and never logged, on
the journal volume. The token creates the account once, and it then
remains the dashboard's recovery sign-in for the life of the server, so keep it
as carefully as the recovery phrase: anyone holding it can sign in to the
dashboard and revoke devices. Read it with no helper image, from the volume:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

**No terminator, no provider, no domain.** `deploy/compose` is the whole
deployment: the same digest-pinned server with no published port of its own,
behind a Caddy terminator issuing certificates from an authority it generates
and each device trusts once. From a checkout of this repository:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is the name your devices will use and needs no public existence.
`OBSYNC_BIND_ADDRESS` is the host address ports 80 and 443 are published on:
Compose refuses to start until you have chosen. They answer different
questions: a bind address limits the destination interface, not the source, so
a LAN bind accepts anything routed to that address and a firewall is what
limits who reaches it. The token is read the same way, from compose's container:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

## What this plugin talks to

- **Your own server, and nothing else.** Every sync request goes to the
  **Server URL** you type into the plugin's settings. There is no obsync
  service, no analytics, no advertising, no crash reporter, and no
  third-party host anywhere in the sync path.
- **An account on that server is required**, and you create it: the first
  device uses the setup token your server wrote at first boot, and every other
  device is paired from a device that already syncs. Signing in to Obsidian
  does not enroll anything.
- **Obsidian's own directory and GitHub**, for installation and updates only.
  Obsidian downloads the release's `main.js`, `manifest.json` and `styles.css`
  from this repository's GitHub Releases when you install or update. The
  plugin never fetches or executes code from the sync server. Each Release
  also carries the plugin ZIP and the evidence manifest, for people deploying
  the server; Obsidian ignores both.
- **Your edge, if you put one there.** If an access-controlled proxy sits in
  front of your server, the headers you paste under **Edge service-token
  headers** are sent to it, because it is on the path to your server.
- **Your vault's file list, and the files you chose to sync.** The plugin
  lists every file in the vault to decide what is in scope, reads the ones
  inside your folder selection, and writes what other devices changed.
- **The clipboard, only when you press Copy.** The two Copy buttons in **Pair
  a new device** write the pairing code or link; nothing is ever read from it.

What the server can and cannot see is in
[`SECURITY.md`](SECURITY.md) and [`docs/threat-model.md`](docs/threat-model.md).

## Documentation

Every page below is a file in this repository; the site is `docs/` rendered.

- **Start:** [quickstart](docs/quickstart.md) · [run the server](docs/server.md) ·
  [Kubernetes chart](chart/README.md) ·
  [install and update the plugin](docs/community-plugin.md)
- **Use:** [daily use](docs/daily-use.md) · [dashboard](docs/dashboard.md) · [settings](docs/settings.md) ·
  [conflicts](docs/conflicts.md) · [troubleshooting](docs/troubleshooting.md) · [recovery](docs/recovery.md)
- **Trust:** [threat model](docs/threat-model.md) ·
  [security policy](SECURITY.md) · [storage and durability](docs/storage.md)
- **Operate:** [device validation](docs/validation.md) ·
  [releases](docs/release.md) · [CI map](docs/ci-map.md) · [changelog](CHANGELOG.md)
- **Build on it:** [architecture](docs/architecture.md) ·
  [protocol](docs/protocol.md) · [benchmarks](docs/benchmarks.md) ·
  [contributing](CONTRIBUTING.md) · [the repository contract](AGENTS.md)

## Questions, bugs, and security

- **A question, or something you are not sure is a bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **A bug:** [open an issue](https://github.com/snaraj/obsync/issues/new/choose)
  with the bug-report template and the report described in
  [`docs/troubleshooting.md`](docs/troubleshooting.md). Include no token, no
  recovery phrase, and no address you would not publish.
- **A suspected vulnerability:** privately, through
  [`SECURITY.md`](SECURITY.md) — never a public issue.

## License

MIT. See [`LICENSE`](LICENSE).
