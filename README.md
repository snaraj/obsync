# obsync

Self-hosted, end-to-end encrypted live sync for [Obsidian](https://obsidian.md).
One dependency-free Rust binary with a built-in dashboard, plus an Obsidian
plugin. Files of any size, bounded only by your disk. No subscription, no
third-party service, no crates, no npm packages.

> Status: pre-release. The first validated release is `v0.1.0`.

<!-- README screenshot rule (AGENTS.md): this section leads with captures of
     the dashboard and the plugin once they render. Placeholders until then. -->

## Screenshots

_Dashboard overview, devices table, and the plugin's sync status will appear
here on the first release._

## Get syncing

The whole path from nothing to a phone and a computer live-syncing the same
vault. Ten minutes; every step is manual by design, and nothing here needs an
account with anyone but yourself.

### 1. Run the server

The server speaks plain HTTP on port 8080 and must sit behind a TLS
terminator: Obsidian on iOS and Android refuses plain HTTP. Which terminator
is your choice, and it is the one deployment decision that changes who else
is on the path:

| Where you put it | Good for | Notes |
| --- | --- | --- |
| LAN or VPN, with a certificate your devices trust | everything, and the right place for a bulk first sync | HTTPS is required on mobile, so the trusted certificate is not optional |
| An HTTPS reverse proxy on hardware you own | a permanent public endpoint | you own the terminator, so you own its terms |
| A tunnel provider on a public hostname | reaching the server with no inbound port | read the provider's terms on sustained large transfers, and do the bulk first sync on the LAN |

A tunnel is one supported transport, not the foundation. Whatever terminates
TLS reads your credentials -- the device secret at pairing, the dashboard
session cookie -- and never your notes: every chunk and manifest is encrypted
on the device, and no key that decrypts them ever crosses the wire
(`docs/architecture.md` section 2.1). "Files of any size" is a promise about
this server; a provider on the path has its own terms.

Deploy by digest, never by tag. Every Release is signed keyless by this
repository's publisher and carries `obsync-vX.Y.Z-release-manifest.json`,
which names the image digest, the chart digest, and the plugin bundle's
SHA-256. Verify the signature with cosign, read the digest from the verified
payload (it must match the manifest on the Release page), and run exactly
that digest:

```sh
cosign verify ghcr.io/snaraj/obsync:v0.1.0 \
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

On Kubernetes, install the chart with your storage classes, claim sizes, and
a Secret for `OBSYNC_SERVER_KEY`; the reference deployment (a single-node
cluster on a Raspberry Pi, reached over private connectivity with no public
hostname) is described in `docs/platform-onboarding.md` and
`docs/architecture.md` section 10.

At first boot the server mints a setup token and writes it, mode 0600 and
never logged, to `v1/setup-token` on the journal volume. The token creates
the account once, and it then remains the dashboard's recovery sign-in for
the life of the server (`docs/architecture.md` section 4.5), so keep it
with the same care as the recovery phrase: anyone holding it can sign in to
the dashboard and revoke devices. Read it without any helper image, from the
container's own volume, running or stopped:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

On Kubernetes, read `v1/setup-token` from the journal volume on the node
that holds it. The journal volume also carries the journal itself and, when
`OBSYNC_SERVER_KEY` is not supplied, the generated server key: back it up as
the sensitive volume it is.

`GET /readyz` answers `{"ready":true}` once the server is serving.

### 1b. Any network, no provider: Compose with Caddy

Step 1 assumes you already have a TLS terminator. If you have none -- a LAN, a
Pi or a NUC at home, no account with anybody -- `deploy/compose` is the whole
deployment: the same digest-pinned server with **no published port at all**,
and a terminator of your own in front of it.

Verify the signature exactly as in step 1, then, from a checkout of this
repository:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is the name your devices will use, and it needs no public
existence at all: a name in your own DNS, a router entry, or a hosts file is
enough, because it only has to resolve on the networks you sync from -- your
LAN, or a VPN back to it. What it DOES need is HTTPS, without exception:
Obsidian on iOS and Android refuses plain HTTP and the plugin speaks nothing
else. Two ways to get a certificate a phone will accept for a private name,
neither of which exposes this server to the internet:

- **the private authority below**, exported once and installed on each
  device. This is what the compose file does out of the box, and it is the
  route with no prerequisites of any kind.
- **a public certificate issued over DNS-01**, where the challenge is
  answered by a DNS record instead of by a connection, so the name may resolve
  only on your own network. Caddy answers DNS-01 only in a build carrying your
  DNS provider's module, which the stock image pinned here does not have: that
  is a deliberate substitution of the `caddy` image, not something this file
  does for you.

A public hostname, a reachable port 80 and 443, or a tunnel provider are one
optional way to reach this server from outside your own network. None of them
is a requirement, and nothing below assumes them.

`deploy/compose/docker-compose.yml` gives the server
`OBSYNC_EDGE=none` and trusts forwarded addresses only from the compose
network's own range, which is written in that file beside the network it
belongs to. Ports 80 and 443 on this host are the only ones opened.

The setup token is read the same way as in step 1, from the container compose
created:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

`scripts/ci/compose-smoke.sh` brings this exact file up on every pull request
and proves the path end to end: TLS through the proxy, `/readyz` truthful, no
published port, the token readable, both containers hardened.

#### Trust the certificate authority, once per device

`deploy/compose/Caddyfile` issues certificates from an authority Caddy
generates on first start, so nothing needs to be reachable from the internet
and you need no domain. The price is that each device must be told to trust
that authority once -- the Obsidian plugin speaks HTTPS only, and on phones
there is no "continue anyway". Export the root certificate:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - \
  | tar -xO > obsync-root.crt
```

Copy `obsync-root.crt` to each device and install it:

- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k
  /Library/Keychains/System.keychain obsync-root.crt`
- **Windows** (an Administrator prompt): `certutil -addstore -f Root
  obsync-root.crt`
- **Linux** (Debian, Ubuntu): `sudo cp obsync-root.crt
  /usr/local/share/ca-certificates/obsync-root.crt`, then `sudo
  update-ca-certificates`. On Fedora and its relatives the directory is
  `/etc/pki/ca-trust/source/anchors/` and the command is `update-ca-trust`.
- **iOS and iPadOS:** mail or AirDrop the file to the device, open it, then
  Settings, Profile Downloaded, Install. Trust is a SECOND step and Obsidian
  fails without it: Settings, General, About, Certificate Trust Settings,
  and turn the certificate on.
- **Android:** Settings, Security, Encryption & credentials, Install a
  certificate, CA certificate. Android keeps user-installed authorities
  separate from the system ones and an app may decline to trust them; if
  Obsidian on Android refuses to connect, that is what happened, and the
  answer is the public-ACME block documented in
  `deploy/compose/Caddyfile` -- a real domain, ports 80 and 443 reachable,
  and a certificate every device already trusts. Nothing else changes.

### 2. Set up this computer (the first device)

1. Download `obsync-plugin-v0.1.0.zip` from the matching GitHub Release and
   unzip its three files (`main.js`, `manifest.json`, `styles.css`) into
   `<your vault>/.obsidian/plugins/obsync/`.
2. In Obsidian: Settings, Community plugins, turn off Restricted mode, enable
   **obsync**.
3. Open the obsync settings tab. Set **Server URL** to your public URL. If an
   access-controlled edge sits in front of the server, paste its headers
   under **Edge service-token headers**, one per line as `Name: value`.
4. Under **First-time setup**, paste the setup token. The plugin creates the
   account and this device, generates the vault key on this computer, and
   shows the **recovery phrase** (24 words). Write it down and keep it off
   this machine: without any paired device and without this phrase, the vault
   is unrecoverable by design. The server never sees the key.
5. Sync starts. The status bar shows the state; the command **Sync now**
   forces a pass, and **Show sync status** explains what it is doing.

### 3. Pair your phone

1. Put the same three plugin files into the vault on the phone. iOS and
   iPadOS: the Files app, On My iPhone, Obsidian, your vault, `.obsidian`,
   `plugins`, create `obsync`, paste the files, restart Obsidian, enable the
   plugin. Android: any file manager, same folder. Set the same **Server
   URL** (and edge headers).
2. On the computer, run the command **Pair a new device** (also a button in
   the settings tab). It shows a one-time pairing code, valid ten minutes, and
   an `obsidian://obsync/pair?code=...` link you can send yourself.
3. On the phone, paste the code under **Pairing code** and tap **Pair this
   device**, or open the link.
4. Back on the computer, approve the device by its name when asked. The phone
   receives the vault key encrypted under a pairing secret that never touches
   the server; until you approve, the phone has no authority of any kind.
5. Edit a note on the phone. It appears on the computer within seconds, and
   the other way round. That is the whole loop.

### 4. See your devices

On any paired computer, run **Open dashboard**: it mints a one-time sign-in
link to the dashboard, where you see every device (type, address, country,
last sign-in, last edit), storage per volume, scrub and garbage-collection
state, and the install files with their hashes. Revoke a lost device there or
from the **Devices** list in the plugin settings.

### What syncs and what does not (v0.1)

- obsync syncs one person's vault across their own devices. Every device you
  pair is you, and v0.1 has no second person in it: giving anyone else
  access to part of a vault is phase 2 work, gated on the acceptance
  criteria in `docs/architecture.md` section 5.
- Hidden folders (`.obsidian`, `.git`) and symlinked folders are not synced
  in either direction.
- On phones, files above **Largest file to download** (512 MiB by default)
  stay on the server and are listed by **Show remote-only files** for
  on-demand fetch; **Total to keep on this device** defaults to 50 GiB. Both
  are settings. Computers have no ceiling.
- Every edit is kept as a version for 30 days and at least the last 10
  versions per file; conflicts never discard an edit (text merges cleanly or
  you get a conflict copy).
- Updates are manual: the plugin tells you when the server runs a newer
  version, and you install that Release the same way as the first time.

## What it does

- Syncs a vault across every Obsidian platform (macOS, Windows, Linux, iOS,
  iPadOS, Android) through a plugin that talks to your own server.
- Encrypts every chunk and every manifest on the device. The server stores
  ciphertext only and never learns the vault key or a single file name.
- Handles large files by content-defined chunking with resumable, deduplicated
  uploads: a 100 GB video and a 2 KB note follow the same path.
- Keeps versions and never silently discards a conflicting edit.
- Ships a dashboard: account, devices (type, address, country, last sign-in,
  last edit), storage per volume, scrub and garbage-collection status, pairing,
  and plugin install.
- Runs as one static binary: Docker, Kubernetes (Helm chart included), or a
  bare host.

## Layout

| Path | Contents |
| --- | --- |
| `crates/obsync-core` | Homegrown primitives: SHA-256, HMAC, HKDF, CRC32, encodings, JSON, HTTP/1.1 |
| `crates/obsyncd` | The server: storage engine, journal, sync API, dashboard, CLI |
| `plugin/` | The Obsidian plugin (TypeScript, WebCrypto, no runtime dependencies) |
| `dashboard/` | Static dashboard assets embedded into the server |
| `chart/` | Helm chart |
| `bench/` | Benchmark harness; LiveSync is the reference to beat |
| `docs/` | Architecture, protocol, storage, threat model, validation, onboarding |

Start with [`AGENTS.md`](AGENTS.md) (the contract) and
[`docs/architecture.md`](docs/architecture.md).

## License

MIT. See [`LICENSE`](LICENSE).
