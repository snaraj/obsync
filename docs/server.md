# Run the server

*For people running an obsync server.*

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

This page is the simple path and the one most deployments should take: one
host, one `docker` or `docker compose` command, volumes you can back up with a
copy. [Kubernetes](kubernetes.md) is the advanced path — a cluster, a chart, a
certificate you renew — and
[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
is that chart's own reference: the `helm install` command against the signed
OCI chart, the one command that creates the `OBSYNC_SERVER_KEY` Secret, and the
four values every cluster must override before a pod can run. The shape the
chart is written for -- a single-node cluster reached over private
connectivity, with no public hostname -- is described in
[platform onboarding](platform-onboarding.md) and
[architecture](architecture.md) section 10.

## Bring your own network and hosting

A homelab needs no provider-specific integration. Use the Compose example below
for a new host, or put the bare server behind the HTTPS reverse proxy you
already operate. A VPN supplies a route to that endpoint; it does not remove
the plugin's HTTPS requirement. With your own proxy, use `OBSYNC_EDGE=none`
and trust forwarded addresses only from that proxy's actual network. Leave
**Custom request headers** empty unless your chosen front end requires them.

The server does not provision your DNS, VPN, router, certificate or firewall.
Choose those independently. Keep its plain-HTTP port private to the trusted
TLS terminator, preserve request methods, paths, bodies and authentication
headers, and allow the long-polling and upload budgets described below.
A third-party TLS terminator sees authentication traffic; put the terminator
on hardware you control when that trust boundary matters to you.

For upstream network details, see [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
and the [WireGuard quick start](https://www.wireguard.com/quickstart/).
A published bind address selects the receiving interface; routing and firewall
policy still decide which clients can reach it.

## Already have a TLS terminator: Docker

Deploy by digest, never by tag. The image and chart are signed keyless by
this repository's publisher. New releases carry
`obsync-X.Y.Z-release-manifest.json`, which names their digests and the
SHA-256 of the plugin bundle and each native installation file. Verify the
signature with cosign, read the digest from the verified payload (it must match
the manifest on the Release page), and run exactly that digest. Replace
`vX.Y.Z` below with the release you are installing, the newest tag on the
[Releases page](https://github.com/snaraj/obsync/releases/latest):

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  -e OBSYNC_TRUSTED_PROXY_CIDRS=172.17.0.1/32 \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

`GET /readyz` answers `{"ready":true,"seq":<n>}` once the server is serving.
`OBSYNC_TRUSTED_PROXY_CIDRS` is the address your proxy reaches the container
from (on Docker's default bridge, its gateway `172.17.0.1`). The server reads
the standard `X-Forwarded-For` and `Forwarded` headers only from there, so the
dashboard shows each device's address instead of the proxy's; a header from
anywhere else is ignored. Have the proxy set `X-Forwarded-For` to the address
that connected to it, and clear any `Forwarded` header a client sent (or the
reverse). When both arrive and disagree, the server believes neither.
`deploy/proxies/` has configurations for Caddy, nginx, Traefik and HAProxy that
do exactly this.

The image is built for 64-bit Linux, `linux/amd64` and `linux/arm64`. There is
no 32-bit ARM build: on a Raspberry Pi, run the 64-bit Raspberry Pi OS.

### How much memory it needs

Memory follows how many versions of your notes the server keeps, not how big
your vault is. The server keeps a short record of each kept version in memory,
about 1.3 KiB for a note, and never the notes themselves. 64 MiB is enough for
about 45,000 kept versions, for example 4,500 notes with ten versions each,
and 300 MiB for about 200,000. A restart needs about what the server uses at
rest. Retention decides how many versions are kept
(`OBSYNC_RETENTION_VERSIONS` and `OBSYNC_RETENTION_DAYS`), so a long history
costs memory only while retention keeps it. The Kubernetes chart requests
128 MiB and allows up to 1 GiB. If you cap a container's memory, give it at
least what your history needs; the measurements are in
[storage](storage.md#memory).

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
the dashboard and revoke devices. Ask the running server for it. The command
runs the server's own binary inside its container, so it needs no helper image
and no shell on either side, and works the same from PowerShell, Command
Prompt or any other shell:

```sh
docker exec obsync obsyncd setup-token
```

Standard output is the token and a newline, and nothing else; diagnostics go
to standard error. A stopped container cannot be asked, so read the file off
its volume instead, from a POSIX shell (macOS, Linux, or WSL on Windows):

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

On Kubernetes, `kubectl exec deploy/obsync --namespace <namespace> -- obsyncd
setup-token` asks the running pod the same way. `kubectl cp` cannot read the
file, because the image has no `tar`, so
[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
gives the read for a pod that is not running. The journal volume also carries
the journal itself and, when `OBSYNC_SERVER_KEY` is not supplied, the generated
server key: back it up as the sensitive volume it is.

## Any network, no provider: Compose with Caddy

The section above assumes you already have a TLS terminator. If you have none
-- a LAN, a Pi or a NUC at home, no account with anybody -- `deploy/compose` is
the whole deployment: the same digest-pinned server with **no published port at
all**, and a terminator of your own in front of it.

Verify the signature exactly as above, then, from a checkout of this
repository:

<!-- ci: compose-up -->
```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  OBSYNC_BLOBS_CAPACITY=200GiB \
  OBSYNC_JOURNAL_CAPACITY=4GiB \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

The two capacities are the space each volume may use, and compose refuses to
start without them. The server cannot measure free space, so it refuses writes
against these numbers: give what the disk under Docker's volumes can really
spare, not the size of a disk it shares with the system and everything else.
On a Pi's SD card that is far less than 200 GiB.

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

On a Mac with Docker Desktop, publishing ports 80 and 443 fails with "Ports are not
available ... not allowed as current user" unless **Enable privileged port
mapping** is on in Docker Desktop's Advanced settings. Either turn it on, or set
`OBSYNC_HTTP_PORT=8080` and `OBSYNC_HTTPS_PORT=8443` and give the plugin
`https://name:8443`.

That holds while devices arrive at THIS host's port. If another reverse proxy
sits in front — holding 443 on this machine, which is the usual reason to move
these ports at all — then devices still arrive at `https://name`, and the
deployment has to be told: add `OBSYNC_PUBLIC_URL=https://name` to the compose
command. An explicit value always wins over the file's default, and it is the
address the plugin checks a generated link against, so it must be the address
your devices actually use.

The setup token is read the same way as above, from the container compose
created. Compose names it `obsync-obsync-1` because the file fixes the project
name, so this needs neither the compose file nor the variables of the `up`:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

With the container stopped, from a POSIX shell:

<!-- ci: compose-setup-token -->
```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

`scripts/ci/compose-smoke.sh` brings this exact file up on every pull request
and proves the path end to end: the bind address required before anything
starts, TLS through the proxy, `/readyz` truthful, the server itself with no
published port, 80 and 443 published on the chosen address and on nothing
else, the redirect off port 80 keeping the port you published, the token
readable, both containers hardened.

`.github/workflows/compose-e2e.yml` then proves THIS PAGE, on an amd64 and an
arm64 runner. It builds the image from the commit under test and runs the three
commands above — the `up`, the `docker cp` setup-token read, the
root-certificate export — by READING THEM OUT OF THIS FILE rather than out of a
copy, substituting only the digest, the hostname and the bind address a reader
supplies for themselves. The `docker exec` read is proven in the shipped image
by `scripts/ci/image-smoke.sh`, on every pull request, against the token the
volume holds.
It then does what the token is for: signs in to the dashboard with it, creates
the account, pairs a SECOND device through the API, pushes one file and reads
it back on that second device, and is refused by name for a request that is
unsigned, altered, stale or replayed. Finally it restarts the stack and finds
the account, both devices and the file still there — which is the promise the
two volumes above are really making. An edit to those blocks that nobody
carries into the gate fails the build:
`scripts/ci/test_selfhosting_contract.py` holds the coupling, and
`scripts/ci/docs_blocks.py` refuses a page whose text no longer matches what
the run substitutes.

### Trust the certificate authority, once per device

`deploy/compose/Caddyfile` issues certificates from an authority Caddy
generates on first start, so nothing needs to be reachable from the internet
and you need no domain. The price is that each device must be told to trust
that authority once -- the Obsidian plugin speaks HTTPS only, and on phones
there is no "continue anyway". Export the root certificate:

<!-- ci: compose-root-certificate -->
```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - \
  | tar -xO > obsync-root.crt
```

**What trusting it allows.** The authority can sign a certificate for any
name, not only yours, and Caddy
cannot limit it: the pinned version has no name-constraint option for its
local authority. A device that trusts the root therefore trusts every
certificate made with its key, for your bank's name as much as for your
server's. The key lives in the `caddy-data` volume, so anyone who can read that
volume, or a copy of it, can intercept HTTPS on every device that trusts the
root. Keep it safe:

- Mount `caddy-data` into nothing but this Caddy container, and back it up only
  where you keep the journal backup.
- Anything that can reach the Docker socket on this host can read every
  volume. Treat that access as access to the key.
- Remove the certificate from a device you retire, and from every device when
  you move to a public certificate.
- If the key may have leaked, stop the stack, delete the `caddy-data` volume
  (Caddy makes a new authority on its next start), remove the old root from
  every device, and install the new one.

Copy `obsync-root.crt` to each device and install it:

- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k
  /Library/Keychains/System.keychain obsync-root.crt`
- **Windows** (an Administrator prompt): `certutil -addstore -f Root
  obsync-root.crt`
- **Linux:** Obsidian, like every Chromium-based app, reads the authorities
  you add from your own NSS database, `~/.pki/nssdb`, and not from the system
  store `update-ca-certificates` writes. As the user who runs Obsidian, with
  `certutil` installed (`libnss3-tools` on Debian and Ubuntu, `nss-tools` on
  Fedora): `certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n 'obsync root' -i
  obsync-root.crt`, then restart Obsidian. With no database there yet, create
  it first: `mkdir -p ~/.pki/nssdb`, then `certutil -d sql:$HOME/.pki/nssdb -N
  --empty-password`. This is the trust CI gives the official AppImage
  (`scripts/ci/obsidian-e2e.sh`), and an instance without it is refused.
  Command-line tools such as `curl` read the system store instead: on Debian
  and Ubuntu, `sudo cp obsync-root.crt /usr/local/share/ca-certificates/`, then
  `sudo update-ca-certificates`; on Fedora the directory is
  `/etc/pki/ca-trust/source/anchors/` and the command is `update-ca-trust`.
- **iOS and iPadOS:** send the file to the device by AirDrop, mail or the
  Files app, then open it. If AirDrop saved it to Files without asking
  anything, open it from the Files app. When iOS asks which device should
  install it, choose the phone. Then Settings, General, VPN & Device
  Management, the downloaded profile, Install. Trust is a SECOND step and
  Obsidian fails without it: Settings, General, About, Certificate Trust
  Settings, and turn the certificate on. Every screen is in
  [Same network, step by step](same-network.md#trust-the-certificate-on-the-phone).
- **Android:** Settings, Security, Encryption & credentials, Install a
  certificate, CA certificate. Android keeps user-installed authorities
  separate from the system ones and an app may decline to trust them; if
  Obsidian on Android refuses to connect, that is what happened. The answer
  is a publicly trusted certificate, and it needs no open port: issue it over
  the DNS-01 challenge, which a DNS record answers instead of a connection, so
  the name can still resolve only on your own network. It needs a domain and
  a DNS provider credential. [Kubernetes](kubernetes.md#4-a-tls-front-inside-the-cluster)
  walks through the ceremony with the lego ACME client, and
  `deploy/compose/Caddyfile` says what Caddy needs to do it itself (a Caddy
  build carrying your DNS provider's module). The public-ACME block in that file is
  the other way: it needs ports 80 and 443 reachable from the internet.
  Nothing else changes.

## Without a container: the static binary

From 1.1.4 every Release also carries `obsync-server-X.Y.Z-linux-amd64.tar.gz`
and `obsync-server-X.Y.Z-linux-arm64.tar.gz`: the static binary the image
runs, the dashboard and plugin files it serves, a hardened systemd unit, and
the licence. Verify the one for your machine before you unpack it:

```sh
gh attestation verify obsync-server-X.Y.Z-linux-amd64.tar.gz --repo snaraj/obsync \
  --cert-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --cert-oidc-issuer https://token.actions.githubusercontent.com
```

Then, as root: a user of its own, the files owned by root so the server cannot
rewrite its own program, the two capacities, and the unit.

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin obsync
install -d -m 0755 /opt/obsync
tar -xzf obsync-server-X.Y.Z-linux-amd64.tar.gz -C /opt/obsync --strip-components=1
install -d -m 0700 /etc/obsync
install -m 0600 /dev/null /etc/obsync/obsyncd.env
printf 'OBSYNC_BLOBS_CAPACITY=100GiB\nOBSYNC_JOURNAL_CAPACITY=4GiB\n' > /etc/obsync/obsyncd.env
cp /opt/obsync/obsyncd.service /etc/systemd/system/obsyncd.service
systemctl daemon-reload
systemctl enable --now obsyncd
```

Set the two capacities to the space you set aside on that disk, never more:
free space is capacity minus what the server wrote, and the server does not
start without them. The unit creates `/var/lib/obsync/blobs` and
`/var/lib/obsync/journal`, mode 0700, owned by `obsync`; those are the two
volumes to back up below, and the setup token is
`/var/lib/obsync/journal/v1/setup-token`. The server listens on
`127.0.0.1:8080` only and believes forwarded addresses only from loopback, so
the TLS terminator runs on the same host and proxies to that address
(`reverse_proxy 127.0.0.1:8080` in a Caddyfile). To upgrade, verify the new
archive, stop the service, replace `/opt/obsync` with its contents, and start
it again; the volumes are untouched.

## Back up the two volumes

Two volumes hold everything: `obsync-blobs` is every encrypted chunk, and
`obsync-journal` is the manifest journal, the setup token and — unless you
supplied `OBSYNC_SERVER_KEY` yourself — the generated server key. Lose the
first and your vaults are gone from the server; lose the second and the
devices you paired can never be unwrapped again, which is a rebuild and a
fresh pairing of every device ([recovery](recovery.md)).

Copy them out of the container itself, with no second image on the path and
no write access to either volume. Stop the server first, so the copy is not
taken mid-write:

```sh
docker stop obsync
docker cp obsync:/data/blobs - > blobs-backup.tar
docker cp obsync:/data/journal - > journal-backup.tar
docker start obsync
```

On the Compose route the container is `obsync-obsync-1` and the pair is
`docker compose -f deploy/compose/docker-compose.yml stop` and `… start`
around the same two copies. Store `journal-backup.tar` the way you store the
recovery phrase: it carries a credential that signs in to the dashboard.
Restoring is the same copy in reverse, into a server that is stopped, and the
volume must arrive owned by uid 65532 — see "Volume ownership" above, which is
the one rule a restored deployment gets wrong.

A stop answers every open change-feed poll at once and lets requests still in
flight finish for up to 20 seconds. With devices merely connected that takes
about a second. The Compose file allows 30 seconds (`stop_grace_period`), the
chart's grace period as well, because Docker's default of 10 would kill a stop
that a large upload is still using; give `docker stop -t 30 obsync` the same. A
stop cut short loses nothing acknowledged: every answered write is already in
the journal.

## Upgrade by digest

An upgrade is one number. Read the new release's digest off its Release page,
verify the signature exactly as at the top of this page — a new digest is a new
decision, so the verification is not optional the second time — and start the
same deployment on the new digest:

- **Docker:** `docker stop obsync && docker rm obsync`, then the `docker run`
  command above with the new digest. The two named volumes are untouched by
  the removal, so the server comes back to the same data and the same devices.
- **Compose:** the `docker compose … up -d` command above with the new
  `OBSYNC_IMAGE`. Compose recreates the one container whose image changed and
  leaves the volumes alone.

Rolling back is the same command with the previous digest, which is why the
digest you are running is worth keeping beside the backup: a tag would not
tell you which bytes were running. Take the backup above BEFORE an upgrade.
That is what makes a roll-back safe whatever the newer release wrote to the
volumes, and it costs one copy.

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
  afterwards lives in Settings, Obsidian. It is one of the steps only a person
  at the device can answer.
- **The host firewall admitting the HTTPS port from the route.** A bind
  address decides which interface accepts connections; the firewall decides
  which sources do. An overlay's addresses are a new source.

**Slow links.** The server accepts a request body as slow as 16 KiB/s (about
128 kbit/s), so a phone on weak mobile data can still send a large file: one
8 MiB piece may take up to about nine minutes. Connections that trickle stay
bounded by the connection limit (`OBSYNC_MAX_CONNECTIONS`, 256 by default)
and the 10-second header timeout, which closes a connection that has not
finished its request head, and the bodies no credential has verified yet
share one 64 MiB reservation.

What has actually been proved is the LAN: the recorded run
([`docs/validation-runs/2026-09-14.md`](validation-runs/2026-09-14.md))
carried setup, pairing and two-way sync between a macOS desktop and an iOS
phone over the Compose route, on one local network. Sync from off that LAN is
not a proven result in any release so far, on either route.

## Next

- [Quickstart](quickstart.md): install the plugin and pair two devices.
- [The dashboard](dashboard.md): what the server shows you about itself.
- [Storage and durability](storage.md): volumes, retention, scrub, and every
  refusal the server can raise at startup.
