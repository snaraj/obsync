# obsync architecture

Dated 2026-09-07. This is the design every lane builds from. Where a number
here is a default, `docs/protocol.md` and `docs/storage.md` carry the exact
contract; where it is a benchmark target, `docs/benchmarks.md` does.

## 1. What obsync is

Two programs and one contract between them:

- **`obsyncd`** — one static Rust binary (standard library only). It stores
  ciphertext chunks and encrypted file manifests on local volumes, serves the
  sync API, the dashboard, and its own plugin bundle, and runs garbage
  collection and integrity scrubbing in the background. It speaks plain
  HTTP/1.1 on one port and is always deployed behind a TLS terminator.
- **The Obsidian plugin** — TypeScript compiled to one `main.js`, zero
  runtime dependencies, WebCrypto for all cryptography. It watches the
  vault, chunks and encrypts changed files on the device, uploads what the
  server does not have, follows the server's change feed, and writes other
  devices' changes into the vault. It runs on every Obsidian platform.
- **The wire protocol** (`docs/protocol.md`) — a small HTTP+JSON API with
  per-device HMAC request authentication and a long-poll change feed.

LiveSync (CouchDB replication, base64 binaries, per-chunk compression, manual
garbage collection) is the reference to beat on fidelity, speed,
reliability, and resource use; `docs/benchmarks.md` pins the numbers.

## 2. Trust model (decided 2026-09-07)

**Blind server.** The server never holds the vault key and cannot decrypt
anything. What it learns is exactly: device identities and their activity,
opaque file identifiers, ciphertext chunk hashes and sizes, version graph
shape, and timestamps. What it never learns: file names, paths, contents,
or which plaintext two chunks share.

**Why this default.** The product must be trustworthy to strangers who run
it on hardware they do not fully control, and it must match a privacy-first,
zero-trust operator. A server-readable mode would be simpler to integrate
and impossible to make safe against a stolen disk or a curious co-tenant.
Sharing with other cluster workloads and manual access on the host are
therefore solved with keys, not with plaintext on the server (section 5).

**What the edge sees.** On the reference deployment the TLS terminator is
Cloudflare's edge. It sees request metadata and the ciphertext bodies, like
any HTTPS terminator would, and it sees the device secret once at pairing
(section 4.4 records the phase-2 fix). It never sees vault content.

## 3. Cryptography

All device-side primitives are WebCrypto (`crypto.subtle`): AES-256-GCM,
HMAC-SHA-256, HKDF-SHA-256, SHA-256, and `crypto.getRandomValues`. The
server needs only SHA-256, HMAC-SHA-256, HKDF-SHA-256, and constant-time
comparison, implemented in `crates/obsync-core` against published test
vectors. The server performs no AES and no asymmetric operation in v1.

### 3.1 Keys

| Key | Size | Where it lives | Derived how |
| --- | --- | --- | --- |
| Vault root key `VRK` | 32 B random | Every paired device; recovery phrase | Created by the first device |
| Domain key `K_d` | 32 B | Devices; optionally escrowed for sharing | `HKDF(VRK, salt="obsync/v1/domain", info=domain_id)` |
| Manifest key `K_m` | 32 B | Devices | `HKDF(VRK, salt="obsync/v1/manifest", info="")` |
| Chunk key `K_c` | 32 B | Transient on the device | `HKDF(K_d, salt="obsync/v1/chunk", info=cid)` |
| Device secret | 32 B | The device; wrapped at rest on the server | Issued by the server at pairing |
| Server key | 32 B | `OBSYNC_SERVER_KEY` or generated once | Random |

A **domain** is a set of paths that share `K_d`. The default vault has one
domain covering everything. The user may declare a folder as its own domain
(random `domain_id`, recorded in the encrypted vault metadata); that is the
unit of sharing and escrow. Renaming the folder updates metadata, not keys.

### 3.2 Chunk encryption (deterministic, deduplicating, blind)

For plaintext chunk `P` in domain `d`:

1. `cid = HMAC-SHA-256(K_d, P)` — a keyed content id, never sent anywhere.
2. `K_c = HKDF(K_d, "obsync/v1/chunk", cid)`; `nonce = HKDF(K_c,
   "obsync/v1/nonce", "")[0..12]`. One key per distinct plaintext, one
   message per key, so the derived nonce is safe.
3. `C = AES-256-GCM(K_c, nonce, P, aad = "obsync/v1/chunk")`.
4. `sid = SHA-256(C)` (hex) is the storage id the server addresses, verifies
   on upload, and reports in the change feed.

Identical plaintext in the same domain yields identical `C` and `sid` on
every device, so deduplication works across devices without the server
learning anything about `P`. The server verifies `sid` on every upload and
on every scrub, so a corrupted or forged chunk is refused or quarantined.

No compression in v1. LiveSync's own measurements show a 9 % storage gain
for a 2× wall-time and 6× CPU cost, and the target workload (video, images,
archives) is incompressible. Text-only opt-in compression is a later
decision, not a default.

### 3.3 Chunking

Files up to 8 MiB are one chunk. Larger files use content-defined chunking
(gear-hash rolling window, homegrown, identical constants on both sides):
minimum 1 MiB, target 4 MiB, maximum 8 MiB. Editing the middle of a 20 GB
archive re-uploads a handful of chunks, not the file. The chunk cap keeps
every request far below the 100 MB body limit a free Cloudflare zone
imposes and bounds memory on mobile.

### 3.4 File manifests and versions

A file has a random 16-byte `file_id` chosen by the device that created it.
Each version carries a manifest, JSON encrypted under `K_m` with a random
12-byte nonce:

```json
{"v":1,"path":"Notes/Ideas.md","size":1234,"mtime":1757200000000,
 "domain":"<domain_id>",
 "chunks":[{"cid":"<hex keyed content id>","sid":"<hex>","len":1234}],
 "sha256":"<hex of plaintext, single-chunk files only>","deleted":false}
```

`cid` is the keyed content id from §3.2: a puller needs it to derive the
chunk key, and it never leaves the encrypted manifest. `sha256` is the
plaintext digest for single-chunk files; multi-chunk files carry no
whole-file digest because WebCrypto has no streaming digest and the plugin
implements no hash of its own. Their integrity is per chunk: AES-GCM
authenticates each chunk under a key derived from its `cid`, and the puller
recomputes `cid` from the decrypted bytes before writing anything.

The manifest's AAD is `file_id || content_version_id` where
`content_version_id = SHA-256(file_id || parents sorted || sids in order)`,
the version preimage minus the ciphertext itself, so the manifest is bound
to its file, its parents, and its chunk list without a circular reference.

The server-visible version record is `{file_id, version_id, parents[],
sids[], bytes, manifest_ct, manifest_nonce, device_id, ts}`.
`version_id = SHA-256(file_id || parents sorted || manifest_ct || sids)`,
recomputed by the server, so two devices producing the same version
collide harmlessly. Paths live only inside `manifest_ct`.

### 3.5 Request authentication

Every API request carries `X-Obsync-Device`, `X-Obsync-Ts` (unix seconds),
`X-Obsync-Nonce` (16 random bytes, hex), and `X-Obsync-Sig` =
`HMAC-SHA-256(device_secret, "obsync/v1\n" + METHOD + "\n" + path_and_query
+ "\n" + ts + "\n" + nonce + "\n" + SHA-256(body))`. The server rejects
timestamps outside ±300 s and nonces seen in the last 600 s. Chunk uploads
already know their body hash: it is the `sid`.

This gives integrity and authentication even on a hop without TLS (the
in-cluster connector-to-pod leg, or a LAN transfer), on top of the content
encryption that makes such a hop carry only ciphertext.

### 3.6 Device secrets at rest

The server stores `wrapped = device_secret XOR HKDF(server_key,
"obsync/v1/wrap", device_id)` — a one-time pad from a per-device HKDF
output. A stolen journal without the server key yields nothing; the server
key is a Kubernetes Secret on the reference deployment, or a first-boot
file with mode 0600 elsewhere.

## 4. Devices, pairing, identity

Obsidian has no identity API, so "signed in" means "this device is paired."

### 4.1 First device

`obsyncd` prints a one-time setup token at first boot. The first plugin
instance consumes it: `POST /v1/setup` creates the account AND enrols that
device, returning its device credential, because every later enrolment
goes through pairing and pairing needs an already-paired device. The
plugin then generates `VRK` locally. The user is shown the
recovery phrase (the `VRK` as 24 words from a fixed 2048-word list, with a
checksum) once and must confirm it. Without any paired device and without
that phrase the vault is unrecoverable by design.

### 4.2 Pairing a new device

1. On a paired device the user opens "Pair a new device". The plugin calls
   `POST /v1/pairing`, receives `{pairing_id, enroll_token}` (10-minute
   expiry), generates a 16-byte pairing secret `PS` locally, and shows one
   code: `base32(pairing_id || enroll_token || PS)`, as text, as a copy
   button, and as an `obsidian://obsync/pair?code=…` link. `PS` never
   reaches the server.
2. On the new device the user pastes or opens the code. The plugin claims
   the pairing (`POST /v1/pairing/{id}/claim` with the enroll token and
   `{name, platform, app_version}`), receiving `{device_id,
   device_secret}`. The device is PENDING: it can sign requests, but every
   device-authenticated route refuses it (`403 device_pending`) except
   polling this pairing's envelope (`409 not_approved`). A claimant has no
   authority of any kind until step 3.
3. The paired device polls the pairing, shows "Approve <name> on
   <platform>?", and on approval encrypts `{VRK, domains}` with `K_pair =
   HKDF(PS, "obsync/v1/pair", pairing_id)` under AES-GCM and posts the
   envelope. The server stores it for one fetch.
4. The new device fetches the envelope (a signed request), decrypts it with
   `PS`, and stores `VRK` in the plugin's data store. Sync starts. Approval
   is what activates the device; rejection, or expiry of an unapproved
   pairing, destroys the pending credential.

The dashboard can display pairing instructions but cannot approve a device:
it holds no `VRK`. Approval is always from a paired Obsidian instance.

### 4.3 Revocation and recovery

The dashboard and any paired device can revoke a device; the server drops
its wrapped secret and every request from it fails from that moment. Data
already on a revoked device stays readable there; rotating `VRK` after a
device compromise is a phase-2 operation (re-encrypt manifests and
re-derive domain keys; chunks under a domain whose key is rotated are
re-uploaded lazily).

### 4.4 Known v1 trade-off and its fix

The device secret crosses the TLS terminator once at pairing. Phase 2
replaces the issued secret with an X25519 agreement (WebCrypto on the
device, a homegrown constant-time X25519 in `obsync-core`) so the
terminator sees only public values.

### 4.5 Dashboard sign-in

v1: a paired device mints a one-time dashboard link (`POST
/v1/dashboard/login-link`); the setup token doubles as a recovery login.
Sessions are `HttpOnly`, `SameSite=Strict` cookies with a double-submit
CSRF header. Phase 2 adds passkeys (WebAuthn): the server gains ECDSA P-256
verification and a CBOR/COSE subset in `obsync-core`, verify-only, tested
against the WebAuthn test vectors. YubiKeys are passkeys.

## 5. Sharing, manual access, other workloads

- **Share a folder with a cluster app:** declare the folder a domain; export
  its `K_d` from a paired device; hand the consuming workload `K_d` plus a
  read-only device credential scoped to that domain. The consumer decrypts
  locally. The server still sees ciphertext.
- **Escrow a folder to the server** (optional, explicit, per domain): post
  `K_d` to `POST /v1/admin/domains/{id}/escrow`. The server can then serve
  that domain's files decrypted to authenticated dashboard users and to
  mounts. The dashboard lists every escrowed domain in red; revocation
  removes the key and the capability.
- **Manual access on the host:** `obsyncd export --domain <id> --key <hex>
  --out <dir>` reconstructs plaintext from the volumes with a key the
  operator supplies. It is the same binary and touches the server's data
  read-only.

## 6. Sync engine

### 6.1 Server model

An append-only **journal** of frames (`docs/storage.md`) is the source of
truth; an in-memory **index** (files, versions, devices, chunk refcounts)
is rebuilt from it at start and snapshotted periodically. Every accepted
write is journaled and fsynced before its response.

Each version append is checked against the file's current heads: if the
posted `parents` equal the current heads, the version becomes the sole
head; otherwise it becomes an additional head and the file is marked
`conflicted`. The server never resolves conflicts; it preserves every head
and lets devices resolve.

The **change feed** is the journal's version and tombstone frames, in
sequence order, exposed by `GET /v1/changes?since=<seq>&wait=<s>`.
`wait` long-polls up to 55 s (inside the edge's 100 s idle limit) and
returns immediately when a new frame lands.

### 6.2 Plugin loops

1. **Watcher.** `vault.on(create|modify|delete|rename)` plus a startup
   reconciliation that compares `(mtime, size)` per path against the local
   state and re-hashes anything that differs. Events are debounced 500 ms
   per path; a file still growing is retried, never uploaded torn.
2. **Push.** Read, chunk, encrypt, batch-check existence (`POST
   /v1/chunks/exists`), upload missing chunks with bounded concurrency
   (4 on desktop, 2 on mobile) and resume by `sid`, then post the version.
   A rejected parent set means another device wrote first; the plugin pulls,
   reconciles, and retries.
3. **Pull.** Follow the change feed; for each version not authored here,
   download missing chunks, decrypt, assemble, verify the plaintext
   `sha256`, and write atomically (temp file plus rename on desktop via the
   Node filesystem; adapter write on mobile). Echoes of the device's own
   versions are recognized by `version_id` and skipped. A decrypted
   manifest is data from another device, not an instruction: its path is
   validated as a canonical relative vault path (no absolute path, no `..`
   or empty segment, no control character, no hidden segment) before any
   vault operation, and the desktop writer proves the resolved absolute
   path stays below the vault root before every read, write, rename, or
   unlink. Hidden folders (`.obsidian`, `.git`) are excluded from sync in
   both directions in v0.1; syncing them is a later opt-in.
4. **Conflicts.** Two heads on a text file with a reachable common ancestor
   → a homegrown three-way line merge; a clean merge posts a new version
   with both heads as parents. Anything else (binary, no ancestor,
   delete-versus-edit, overlapping hunks) keeps BOTH: the foreign head is
   written as `<name> (conflict from <device>, <date>).<ext>` and the user
   is told. obsync never silently discards an edit.
5. **Policy.** Per device: `perFileMaxBytes` (desktop 0 = unlimited; mobile
   512 MiB, the practical whole-file read ceiling in a WebView) and
   `totalBudgetBytes` (mobile 50 GiB by owner ruling). Files above a
   ceiling are not downloaded; they appear in the plugin's "Remote only"
   view with an on-demand fetch. Every ceiling is visible in settings and
   in the dashboard's device table.
6. **Streaming on desktop.** Electron exposes Node's `fs`; the plugin
   reads, hashes, and encrypts in 8 MiB windows and never loads a large
   file whole. Mobile reads whole files through the adapter, which is why
   the mobile per-file ceiling exists. Both facts are stated in the
   settings UI.

### 6.3 Updates

The plugin never installs code it fetched from the server: a server or a
TLS terminator that could replace both the bytes and the hash it serves
would otherwise gain the vault key at the next reload. In v0.1 the plugin
only compares its version with `GET /v1/plugin/manifest` on start and
tells the user when the server runs a newer one; the user installs the
matching GitHub Release (whose evidence manifest carries the bundle's
SHA-256) by copying the three files into `.obsidian/plugins/obsync/`, as
on the first install. The server still serves the bundle at
`GET /v1/plugin/{manifest,bundle,styles}` as a convenience copy for the
Install page, with hashes to compare against the Release. Signed updates
verified against a key pinned in the installed plugin are a v0.2 item
that needs an owner decision on signing-key custody.

## 7. Storage, durability, replication

`docs/storage.md` is the contract. In brief: one blob volume, one journal
volume, each bound to whatever StorageClass the operator names (the
reference deployment uses `local-pie-ssd` for both today); every write is
temp-write, fsync, rename, directory fsync; chunks are verified by `sid` on
write and by a rate-limited scrub; unreferenced chunks are collected
automatically after a retention window; a free-space watermark refuses new
data before the disk fills. Replication is application-level: optional
mirror volumes today (write-all, read-primary, scrub cross-checks), a
replica server following the journal when a second node exists.

## 8. Dashboard

Static HTML, CSS, and JavaScript shipped beside the binary (read from
`OBSYNC_DASHBOARD_DIR`, served at `/`, `/app.css`, `/app.js`, `/lib.js`);
JSON under `/v1/admin/*` behind the dashboard session. Pages:

- **Overview:** account, versions, storage per volume with its class name,
  sync activity (versions per hour), last scrub and GC summaries.
- **Devices:** name, platform, app version, first paired, last sign-in,
  last seen, last edit at, connecting address and country; revoke.
- **Pairing:** the instructions; codes are minted on devices.
- **Storage:** usage, watermark, retention, scrub status and quarantine.
- **Sharing:** domains, escrow state, revoke.
- **Install:** plugin download and per-platform install steps.
- **Logs:** the last decisions, filtered by device.

Address and country: in `cloudflare` edge mode from the edge's
connecting-address and country headers; in `none` mode from the peer
address or a trusted proxy header. Device history retention defaults to 90
days. Multi-account operation is a backlog issue; every record already
carries an `account_id`.

## 9. Configuration

Environment only, so containers and charts need no config file:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OBSYNC_LISTEN` | `0.0.0.0:8080` | HTTP listener |
| `OBSYNC_BLOBS_DIR` | `/data/blobs` | Chunk volume |
| `OBSYNC_JOURNAL_DIR` | `/data/journal` | Journal, index snapshots, server key |
| `OBSYNC_BLOBS_MIRRORS` | empty | Comma-separated extra blob volumes |
| `OBSYNC_BLOBS_CAPACITY` / `OBSYNC_JOURNAL_CAPACITY` | required | Declared volume capacity (the claim size); free space = capacity − tracked usage, since std has no statvfs |
| `OBSYNC_BLOBS_CLASS` / `OBSYNC_JOURNAL_CLASS` | `host` | Display label for the volume's StorageClass in the dashboard |
| `OBSYNC_DASHBOARD_DIR` | `/opt/obsync/dashboard` | Dashboard static files |
| `OBSYNC_PLUGIN_DIR` | `/opt/obsync/plugin` | Plugin bundle (`main.js`, `manifest.json`, `styles.css`) |
| `OBSYNC_EDGE` | `none` | `none` or `cloudflare` |
| `OBSYNC_TRUSTED_PROXY_CIDRS` | empty | Forwarded-address trust in `none` mode |
| `OBSYNC_PUBLIC_URL` | empty | Shown in pairing and install pages |
| `OBSYNC_SERVER_KEY` | empty | 64 hex chars; generated once if absent |
| `OBSYNC_FREE_WATERMARK` | `5%,2GiB` | Refuse writes below the larger of the two |
| `OBSYNC_RETENTION_DAYS` | `30` | Version and tombstone retention |
| `OBSYNC_RETENTION_VERSIONS` | `10` | Minimum versions kept per file |
| `OBSYNC_SCRUB_RATE` | `4MiB/s` | Background integrity budget |
| `OBSYNC_MAX_CONNECTIONS` | `256` | Concurrent connections (one thread each; long-polls are cheap) |
| `OBSYNC_LOG` | `info` | `error`, `info`, `debug` |

## 10. Reference deployment (pie5)

Namespace `obsync`; one Deployment (single replica, `Recreate`), one
Service on 8080, one default-deny NetworkPolicy admitting ingress only from
the tunnel connector; two static local PersistentVolumes on `local-pie-ssd`
(blobs 250 GiB, journal 4 GiB), growable to 500 GiB; `OBSYNC_SERVER_KEY`
from a SOPS-managed Secret; `OBSYNC_EDGE=cloudflare`; a third per-app
Cloudflare Tunnel for one hostname with Cloudflare Access in front
(identity policy for the dashboard, service-token policy for `/v1/*`).
`docs/platform-onboarding.md` lists the platform-repository changes.

## 11. Phases

1. **v0.1.x — MVP:** core primitives, server (storage, journal, API, feed,
   GC, scrub, dashboard v1, CLI), plugin (watch, chunk, encrypt, push, pull,
   conflicts, policy, pairing, version notice), chart, CI, release path,
   three device validation, first benchmark table.
2. **v0.2.x:** X25519 pairing, passkeys, signed plugin updates against a
   pinned key, Cloudflare Access JWT verification from a mounted JWKS,
   `VRK` rotation, QR pairing codes.
3. **v0.3.x:** replica server mode, size padding option, text compression
   opt-in, multi-account.
