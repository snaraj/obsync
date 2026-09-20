# Run the server

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
([architecture](architecture.md) section 2.1). "Files of any size" is a
promise about this server; a provider on the path has its own terms.

On Kubernetes,
[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
is the whole standalone path: the `helm install` command against the signed OCI
chart, the one command that creates the `OBSYNC_SERVER_KEY` Secret, and the
four values a cluster that is not the owner's must override before a pod can
run. The reference deployment (a single-node cluster on a Raspberry Pi, reached
over private connectivity with no public hostname) is described in
[platform onboarding](platform-onboarding.md) and
[architecture](architecture.md) section 10.

## Already have a TLS terminator: Docker

Deploy by digest, never by tag. The image and chart are signed keyless by
this repository's publisher. New releases carry
`obsync-X.Y.Z-release-manifest.json`, which names their digests and the
SHA-256 of the plugin bundle and each native installation file. Verify the
signature with cosign, read the digest from the verified payload (it must match
the manifest on the Release page), and run exactly that digest. The tag below
is the release you are installing -- `v1.1.0` here, `vX.Y.Z` for whichever
release you took off the Releases page:

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

`GET /readyz` answers `{"ready":true,"seq":<n>}` once the server is serving.

### Volume ownership

The server takes ownership of nothing: each volume must be presented owned by
uid 65532 and writable by it, or already hold the server's `v1`, or the start is
refused with `reason=unwritable`. Static local volumes and `hostPath`
directories: create them as `65532:65532`, mode `0700`, with root-owned, closed
parents and no symlink on the path. A dynamic provisioner that presents a
root-owned or world-writable volume root: prepare the backing directory once as
the node administrator (`chown 65532:65532` and `chmod 0700`), then start. The
chart sets no `fsGroup`, because a group-writable volume is refused
([storage](storage.md), "Volume posture").

### Read the setup token

At first boot the server mints a setup token and writes it, mode 0600 and
never logged, to `v1/setup-token` on the journal volume. The token creates
the account once, and it then remains the dashboard's recovery sign-in for
the life of the server ([architecture](architecture.md) section 4.5), so keep
it with the same care as the recovery phrase: anyone holding it can sign in to
the dashboard and revoke devices. Read it without any helper image, from the
container's own volume, running or stopped:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

On Kubernetes the same file is on the journal volume, and
[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
gives the two ways to read it there — `kubectl exec` and `kubectl cp` are not
among them, because the image has no shell and no `tar` for either to use. The
journal volume also carries the journal itself and, when `OBSYNC_SERVER_KEY` is
not supplied, the generated server key: back it up as the sensitive volume it
is.

## Any network, no provider: Compose with Caddy

The section above assumes you already have a TLS terminator. If you have none
-- a LAN, a Pi or a NUC at home, no account with anybody -- `deploy/compose` is
the whole deployment: the same digest-pinned server with **no published port at
all**, and a terminator of your own in front of it.

Verify the signature exactly as above, then, from a checkout of this
repository:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is the name your devices will use, and it needs no public
existence at all: a name in your own DNS, a router entry, or a hosts file is
enough, because it only has to resolve on the networks you sync from -- your
LAN, or a VPN back to it. What it DOES need is HTTPS, without exception:
Obsidian on iOS and Android refuses plain HTTP and the plugin speaks nothing
else. Two ways to get a certificate a phone will accept for a private name,
neither of which needs this server reachable from the internet -- what it IS
reachable from is `OBSYNC_BIND_ADDRESS` below, not either of these:

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

### Which address it is published on

`OBSYNC_BIND_ADDRESS` is the host address ports 80 and 443 are published
on, and it is the answer to a question the two certificate options above do
not touch. The private name and the certificate authority decide what this
service is CALLED and which devices TRUST it; they decide nothing about who
can reach it -- a client from anywhere can pick the name itself and skip
certificate verification entirely. The bind address decides which of this
host's interfaces accepts connections: a bind address limits the destination
interface, not the source. `127.0.0.1` accepts only connections from this
machine, which is what you want when a VPN terminates here or another
reverse proxy sits in front. A LAN address of this host (`192.168.1.10`)
accepts every connection that arrives at that address, which is your LAN
and also anything routed to it: a VPN that routes into your LAN, another
subnet your router forwards, or a port forward you set up. So a non-loopback
bind assumes three things you own: your router forwards nothing from the
internet to this host on 80 or 443, a host firewall or router policy limits
sources to the networks you intend, and you know which VPNs route into the
LAN. `0.0.0.0` publishes on every interface this host has, and that IS the
decision to expose it wherever the host is reachable -- legitimate behind a
firewall or a NAT you control, and then the firewall is yours to get right.
Compose refuses to start until you have chosen, because there is no value
here that is safe for everybody.

### What the compose file does

`deploy/compose/docker-compose.yml` gives the server
`OBSYNC_EDGE=none` and trusts forwarded addresses only from the compose
network's own range, which is written in that file beside the network it
belongs to. Ports 80 and 443 on the address you chose are the only ones
opened, and `OBSYNC_HTTP_PORT` and `OBSYNC_HTTPS_PORT` move that pair of HOST
ports if something on this machine already holds them -- they default to 80 and
443, and the container ports, the certificate and the name never change with
them. A host port you moved has to appear everywhere a device names this
server: set the plugin's **Server URL** to `https://name:PORT`, and the
deployment's own generated links and its HTTP-to-HTTPS redirect carry the same
port without being told twice.

That holds while devices arrive at THIS host's port. If another reverse proxy
sits in front — holding 443 on this machine, which is the usual reason to move
these ports at all — then devices still arrive at `https://name`, and the
deployment has to be told: add `OBSYNC_PUBLIC_URL=https://name` to the compose
command. An explicit value always wins over the file's default, and it is the
address the plugin checks a generated link against, so it must be the address
your devices actually use.

The setup token is read the same way as above, from the container compose
created:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

`scripts/ci/compose-smoke.sh` brings this exact file up on every pull request
and proves the path end to end: the bind address required before anything
starts, TLS through the proxy, `/readyz` truthful, the server itself with no
published port, 80 and 443 published on the chosen address and on nothing
else, the redirect off port 80 keeping the port you published, the token
readable, both containers hardened.

### Trust the certificate authority, once per device

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

## Reaching it from outside your LAN

The server needs no public existence for this, and nothing below asks it to
become reachable from the internet. What has to be true is true on the ROAMING
DEVICE, and all five of these, because the first one that is missing is the
one that makes sync look broken:

- **A private route back to the server.** An overlay network the device joins:
  WireGuard, Tailscale, or a tunnel provider's private network with its client
  app. The route has to carry the HTTPS port, not only SSH or one service.
- **The same Server URL, resolving and routing on that device.** The plugin
  sends every request to the address you typed, so that name must resolve to
  an address the route reaches -- the overlay's own DNS, the device's hosts
  file, or a split-DNS entry. A name that resolves to a LAN address the device
  cannot route to fails exactly like an offline server.
- **The same private authority, trusted on that device.** Section above, once
  per device. A phone that trusts the certificate at home trusts it away from
  home; a device that never installed it does not.
- **On iOS, the local-network permission accepted.** iOS prompts once, the
  first time Obsidian reaches an address on a local network, and the answer
  afterwards lives in Settings, Obsidian. It is one of the steps the recorded
  device run answered by hand on the phone.
- **The host firewall admitting the HTTPS port from the route.** A bind
  address decides which interface accepts connections; the firewall decides
  which sources do. An overlay's addresses are a new source.

What has actually been proved is the LAN: the recorded run
([`docs/validation-runs/2026-09-14.md`](validation-runs/2026-09-14.md))
took a Mac and an iPhone through setup, pairing and two-way sync over the
Compose route, on one home network, with HTTPS on a non-default port. Sync
from off that LAN is not a proven result in any release so far, on either
route.

## Next

- [Quickstart](quickstart.md): install the plugin and pair two devices.
- [The dashboard](dashboard.md): what the server shows you about itself.
- [Storage and durability](storage.md): volumes, retention, scrub, and every
  refusal the server can raise at startup.
