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
There is no mode, flag, or endpoint that hands the server a content key:
access for anything but a paired device is solved with keys held elsewhere,
never with plaintext on the server (section 5).

**What the edge sees** is stated in full in 2.1 below, with the two other
trust choices this deployment makes.

### 2.1 Three trust choices, stated (2026-09-07)

Decisions, not oversights. Each says what this process sees, what it never
sees, and what somebody else is trusted with. All three are application-level
facts: what the cluster or the edge is configured to do belongs to whoever
runs it, and is not restated here as if this repository controlled it.

**1. Credentials cross the TLS terminator. Content never does.** Whatever
terminates TLS in front of this server -- a tunnel connector, a reverse
proxy, an ingress controller -- reads every request in clear after
termination. That is the device secret the server issues once at pairing
(section 4.4) and every credential-bearing request afterwards: the dashboard
session cookie, the CSRF value, the recovery sign-in link from section 4.5,
and each request's HMAC. The terminator is therefore inside the trust base
for CREDENTIALS and outside it for CONTENT. Chunk and manifest bodies are
ciphertext it cannot read, and no key that would decrypt them travels the
wire in either direction, so a terminator that recorded everything still
holds no vault content. A deferred X25519 pairing agreement (section 4.4)
could remove the terminator from that device-credential exchange; it is not
implemented by the current protocol. Nothing removes a terminator from the session
path; reading cookies is what terminating TLS means.

Strip the terminator entirely and the server's own authentication still
holds: every device request carries an HMAC over method, path, query,
timestamp, nonce and body hash, with a +/-300 s window and a 600 s nonce
cache, so a recorded request cannot be replayed and an altered one cannot be
presented. What plain HTTP loses is confidentiality of the metadata and of
the credential itself, never request integrity and never content. This cuts
the other way too, and it is the reason the private deployment is not a soft
one: **being on the LAN or the VPN grants nothing to this application.**
Reaching the port is not authorisation. Every request is still authenticated
per approved device, and a device that has not been paired and approved --
however local it is -- can do nothing but be refused.

**2. The hop from that terminator to this process is plain HTTP.** The server
listens on plain HTTP and never links TLS (requirement 7), so on the
reference deployment the connector-to-pod hop is unencrypted. What limits who
can reach it is a default-deny NetworkPolicy admitting exactly one peer and a
restricted Pod Security level, which withholds the capabilities a
neighbouring pod would need to read another pod's traffic. That is
reachability control, and calling it encryption would be the untrue sentence
this section exists to avoid. The options, with what each costs:

| Option | Cost | What it buys |
| --- | --- | --- |
| Plain hop, network-restricted (today) | none | nothing on the wire; rests on the cluster's isolation being what it claims |
| A TLS terminator as a sidecar in the same pod | one more container, and its certificates | the hop becomes loopback inside one pod, so no network path carries it |
| A service mesh | a mesh, and everything it brings | mutual TLS between every workload, of which this is one |

Choosing among them is a cluster decision. The application-level fact is
fixed: this process never encrypts that hop and never claims to.

**3. Transport is the deployer's choice; the size promise is the server's.**
"Files of any size" is a promise about this server. No code path carries a
per-file or per-vault limit, and the only refusals are the free-space
watermark and the account quota, both explicit, both HTTP 507 (requirement
8). It is not a promise about somebody else's network. A public hostname
served through a tunnel provider on a free plan is subject to that provider's
terms, which commonly discourage sustained large non-HTML transfers, and the
first sync of a vault with video in it is exactly that. The deployment
choices, and what each is for:

| Deployment | Good for | Notes |
| --- | --- | --- |
| LAN or VPN, with a certificate the devices trust | everything, and the only sound place for a bulk first sync | mobile Obsidian requires HTTPS, so the trusted certificate is required, not optional |
| An HTTPS reverse proxy on hardware the deployer owns | a permanent public endpoint | the deployer owns the terminator, so the deployer owns its terms |
| A tunnel provider on a public hostname | reaching the server with no inbound port | read the provider's terms; move a bulk first sync onto the LAN |

The shape in section 10 takes the first: private connectivity, no public
hostname, and therefore no third party on the path at all. A tunnel
is one supported transport, never the foundation: none of the three changes
what the server does, only who else is on the path.

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
| Domain key `K_d` | 32 B | Devices only; never sent to the server | `HKDF(VRK, salt="obsync/v1/domain", info=domain_id)` |
| Manifest key `K_m,d` | 32 B | Devices holding `K_d` | `HKDF(K_d, salt="obsync/v1/manifest", info=domain_id)` |
| Domain-map key `K_map` | 32 B | Devices holding `VRK`; owner only | `HKDF(VRK, salt="obsync/v1/domainmap", info="")` |
| Chunk key `K_c` | 32 B | Transient on the device | `HKDF(K_d, salt="obsync/v1/chunk", info=cid)` |
| Device secret | 32 B | The device; wrapped at rest on the server | Issued by the server at pairing |
| Server key | 32 B | `OBSYNC_SERVER_KEY` or generated once | Random |

A **domain** is a set of paths that share `K_d`, and it is the unit every
content key derives from: the chunk keys of its files and, since the manifest
key is derived from `K_d` rather than from `VRK`, its file names too. One
domain therefore hands over exactly one set of files and nothing about any
other. The default vault has one domain covering everything, declared as the
empty path prefix; a folder or a single file may be its own domain (random
`domain_id`). Which paths belong to which domain is owner-only metadata, and
5.1 states the format of that map, of the keys above, and of everything the
phase-2 grant will need. v0.1 uses exactly one domain and grants it to
nobody (section 5).

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
Each version carries a manifest, JSON encrypted under `K_m,d` — the manifest
key of the domain the file belongs to (5.1) — with a random 12-byte nonce:

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

### 3.4.1 Folder records (1.1.0)

A folder syncs as a version of its own, so an EMPTY folder can exist on every
device and a deleted one can leave every device (issue #104). It is the same
mechanism a file uses with nothing in it:

```json
{"v":2,"kind":"directory","path":"Notes/Ideas","domain":"<domain_id>",
 "size":0,"chunks":[],"sha256":"","deleted":false}
```

The record it rides in has `sids: []` and `bytes: 0`, which is what the
server already accepts for a tombstone, so the server stores, retains and
feeds a folder exactly as it does a file and learns no more than it already
did. **No server change.**

`v: 2` is the compatibility boundary and the reason the field exists. A
device on 1.0.x decodes every manifest through one function that refuses any
`v` it does not know before it reads another field, so a folder record cannot
become a FILE written at the folder's path there; it is refused, logged, shown
to the user once per file id, and the feed moves on.

Two properties make a folder record safe to publish from anywhere:

- **Its file id is derived, not random:** the first 16 bytes of
  `HMAC(K_m,d, "obsync/v1/folder" || 0x0a || path)`. A file carries its
  identity through a rename because its CONTENT is what is tracked; a folder
  has no content, so its path is the only thing its record can be about. Two
  devices that create the same folder independently therefore arrive at ONE
  record. With two, deleting the folder would tombstone one and leave the
  other live, and the next device to read the feed would put the folder back.
- **Its manifest carries no timestamp, and its nonce is derived** the way the
  domain map's is (`HKDF(K_m,d, "obsync/v1/nonce", SHA-256(aad || plaintext))`).
  The bytes two devices produce for the same folder in the same state are
  then identical, so the `version_id` is identical and the second device's
  post is the `200` no-op `docs/protocol.md` already promises. The key is
  shared with the randomly-nonced file manifests and that costs nothing: a
  nonce derived by HKDF from the message is a pseudorandom 96-bit value, so
  the chance it meets a random one is the chance two random ones meet, and it
  repeats only for a message identical in both AAD and plaintext — whose
  ciphertext was already identical.

What the server additionally learns is that a folder deleted and recreated at
one path is the same opaque label, which is what a file id already tells it
across a rename. The path itself never leaves `manifest_ct`.

The same construction, under its own label, names the ONE conflict copy that
keeps the losing head of a fork that does not merge (plugin 1.1.3, section
6.2 item 4): its file id is the first 16 bytes of
`HMAC(K_m,d, "obsync/v1/conflict" || 0x0a || file_id || 0x0a || version_id)`,
where `file_id` is the forked file's and `version_id` its losing head's. Every
device that settles the fork derives the same id and posts the same first
version, so the server keeps one copy rather than one per device. It is an
ordinary file record: `v: 1`, a random nonce, the path only inside
`manifest_ct`. The server learns nothing new from the id. It is keyed by
`K_m,d`, which never reaches the server, so to the server it is an opaque
16-byte label exactly like a random file id -- it cannot compute it, cannot
tell it from a random one, and cannot link it to the file or the version it
came from. It is deterministic only for a device holding the key. What the
server does observe -- two devices posting a first version with the same
chunks and no parents, answered as one -- is what `accept_existing` already
shows it for any two devices writing identical content (`docs/protocol.md`,
"One position, one version"). A distinct label keeps the two derivations
apart: no folder path can produce a conflict copy's id, and no fork a
folder's.

### 3.5 Request authentication

Every API request carries `X-Obsync-Device`, `X-Obsync-Ts` (unix seconds),
`X-Obsync-Nonce` (16 random bytes, hex), and `X-Obsync-Sig` =
`HMAC-SHA-256(device_secret, "obsync/v1\n" + METHOD + "\n" + path_and_query
+ "\n" + ts + "\n" + nonce + "\n" + SHA-256(body))`. The server rejects
timestamps outside ±300 s and nonces seen in the last 600 s. Chunk uploads
already know their body hash: it is the `sid`.

The 600 s is wall-clock time, not process time, so the nonces are kept on
the journal volume rather than only in memory: every accepted nonce is
appended to `v1/nonces` and fsynced before its request is answered, and a
start loads back what the window still covers. Without that, a request
captured 299 s before a restart is replayable 1 s after it. The file is
compacted once it passes twice the cache's own ceiling, a torn final line
costs only itself, and a volume that will not take the record refuses the
request (`503 nonce_log_unavailable`): a request answered without its nonce
written down is one a crash makes replayable.

This gives integrity and authentication even on a hop without TLS (the
in-cluster connector-to-pod leg, or a LAN transfer), on top of the content
encryption that makes such a hop carry only ciphertext.

A nonce is spent by being sent, so replay protection and retries meet here.
The device signs every ATTEMPT afresh, never once per call: reusing a lost
attempt's headers would earn a `401 replayed_nonce` the client caused itself.
And a fresh signature is not licence to repeat, so `docs/protocol.md` states
per route whether a second send is the same request. A route that is not
repeatable is sent exactly once; when nothing answers it — a dropped
response, a timeout, a 5xx — the outcome is **unknown**, which is neither
success nor failure, and the caller settles it by READING what the server
holds (the file record for a version post, the device list for a revoke) or
by telling the user, with the reason, that it is unknown. Guessing either way
is worse than saying so: "it failed" about a revoke that worked leaves a lost
device trusted, and re-sending a version post that landed forks the file into
a conflict the user never made.

### 3.6 Device secrets at rest

The server stores `wrapped = device_secret XOR HKDF(server_key,
"obsync/v1/wrap", device_id)` — a one-time pad from a per-device HKDF
output. A stolen journal without the server key yields nothing; the server
key is a Kubernetes Secret on the reference deployment, or a first-boot
file with mode 0600 elsewhere.

## 4. Devices, pairing, identity

Signing in to Obsidian does not authorize the self-hosted server. Each device
explicitly pairs once; ordinary sync then runs automatically.

### 4.1 First device

`obsyncd` mints a setup token at first boot and writes it, mode 0600 and
never logged, to `v1/setup-token` on the journal volume. The first plugin
instance presents it: `POST /v1/setup` creates the account AND enrols that
device, returning its device credential. The plugin generates and durably
saves `VRK` before sending setup, then includes its account-recovery verifier.
Later enrollment uses pairing or the setup-token plus vault-proof recovery
route (§4.3). The token is not discarded: it remains the dashboard's recovery sign-in for
the life of the server (§4.5), so its custody equals the recovery
phrase's. An operator asks the server for it: `obsyncd setup-token` prints
it on standard output and nothing else, reading the same file through the
same measured volume pass a start uses and opening no journal, so
`kubectl exec deploy/obsync -- obsyncd setup-token` answers from a pod that
is serving and needs no shell in the image. Reading the file off the volume
remains the fallback for a server that is not running (`docs/recovery.md`).
The user is shown the
recovery phrase (the `VRK` as 24 words from a fixed 2048-word list, with a
checksum) once and must confirm it. Without any paired device and without
that phrase the vault is unrecoverable by design.

### 4.2 Pairing a new device

1. On a paired device the user opens "Pair a new device". The plugin calls
   `POST /v1/pairing`, receives `{pairing_id, enroll_token}` (10-minute
   expiry), generates a 16-byte pairing secret `PS` locally, and shows one
   code: `base32(pairing_id || enroll_token || PS)`, as text, as a copy
   button, and as an `obsidian://obsync-private-sync/pair?code=…` link. `PS` never
   reaches the server.
2. On the new device the user pastes or opens the code. The plugin claims
   the pairing (`POST /v1/pairing/{id}/claim` with the enroll token and
   `{name, platform, app_version}`), receiving `{device_id,
   device_secret}`. The device is PENDING: it can sign requests, but every
   device-authenticated route refuses it (`403 device_pending`) except
   polling this pairing's envelope (`409 not_approved`). A claimant has no
   authority of any kind until step 3.
   On current clients the claim also includes optional sealed `{name, notes}`
   for the claimant's vault. A separate `obsync/v1/pair-vault` HKDF label and
   AES-GCM binding to the pairing ID keep these details blind to the server;
   the creator decrypts them before showing approval (protocol: Pairing).
3. The paired device polls the pairing, shows "Approve <name> on
   <platform>?", and on approval encrypts `{VRK}` with `K_pair =
   HKDF(PS, "obsync/v1/pair", pairing_id)` under AES-GCM and posts the
   envelope. The server stores it for one fetch.
4. The new device fetches the envelope (a signed request), decrypts it with
   `PS`, and persists `VRK` through the native secret store before sync starts. Approval
   is what activates the device; rejection, or expiry of an unapproved
   pairing, destroys the pending credential. Rejection reaches a PENDING
   claimant only: once approved, the claimant is a paired device, so a
   reject that arrived after the approval is refused
   (`409 already_approved`) and the store refuses to delete anything but a
   pending device. Removing a paired device is revocation, which keeps the
   record, destroys the secret, and refuses the last active device only while
   account recovery is unregistered.

A pairing lives in memory and the device a claim creates is journaled, so a
restart between step 2 and step 3 leaves a pending device behind a pairing
that no longer exists: nobody can approve it, and the expiry sweep cannot
reach it, because the sweep only ever sees the table. Assembling the
application state therefore destroys every pending device no pairing is
holding, down the path expiry uses, and logs one line with the count. The
claimant is asked to pair again, which is the safe direction and the same
one an expiry takes.

The dashboard can display pairing instructions but cannot approve a device:
it holds no `VRK`. Approval is always from a paired Obsidian instance.

### Device-local credential custody

Obsidian 1.13.0 or newer is required; the vendored official API package is
pinned at exactly that version, so the compiler refuses any newer member. The plugin uses only the public SecretStorage
`getSecret` and `setSecret` operations for its exact owned entry. A validated,
random installation ID determines that entry's name. No secret inventory or
other plugin installation is read or imported.

The entry contains one versioned envelope with current and previous valid
credential records: vault root key, device secret and optional edge headers,
bound to the installation, server URL, device ID and a credential revision.
Plugin `data.json` holds that reference and nonsecret bookkeeping. Loading
selects only the record named by metadata with the matching server/device
identity; missing, malformed or mismatched data stops loading instead of
resetting identity or generating another key. Key-only recovery and
credential-only enrollment are preserved as incomplete states. Approval can
finish in an already-open pairing dialog. Its pairing code is not persisted,
so app restart does not resume that dialog. A recovery phrase can restore
the key after device approval; it does not authorize a pending device.

Existing plaintext settings migrate by writing and reading back the owned
entry before replacing metadata. Saves use detached snapshots and serialize
concurrent requests. Bookkeeping-only saves do not rewrite secret bytes.
Credential changes retain the previous valid record so failed metadata writes
can reload the prior identity; if metadata actually reached storage despite
an uncertain acknowledgement, reload selects its recorded new revision.
Only those two records are retained. Any failure stops the active engine,
blocks further transport and reports an actionable error until reload. Reload
waits for earlier metadata writes and migration to settle before reading a
new snapshot. A stopped engine’s drain remains owned across failure and
unload until its in-flight work and final save settle; a replacement load
waits for it even after the active engine reference is cleared. Recovery
dialogs bind their session when opened, before phrase derivation, and closing
a dialog invalidates its later UI continuation. Closing cannot undo a local
write already dispatched by the user’s action. Setup, pairing and key-recovery continuations are bound to the
state, transport, server URL and plugin session that started them; a
superseded response cannot overwrite a new session’s identity. Shutdown can
still lose a one-time server response. Closing a pairing dialog after an
envelope request was dispatched preserves a received key in the same active
session, without restarting sync or issuing another collection request.
An interrupted first migration can leave an unreferenced native entry;
the plugin never inventories or automatically deletes native secrets.

The public `setSecret` call is synchronous and documents no crash-durable
transaction with `saveData`. Immediate readback is verification of the host
API result, not proof of persistence across app or OS failure. Native app
restart checks remain required on supported platforms. SecretStorage is
vault-local and shared with other trusted plugins; this does not promise
universal OS encryption or isolation from those plugins or the local OS.
See the [official storage guide](https://docs.obsidian.md/plugins/guides/secret-storage)
and [API baseline](https://github.com/snaraj/obsync/blob/main/plugin/vendor/obsidian/README.md).

### 4.3 Revocation and recovery

The dashboard and any paired device can revoke a device; the server drops
its wrapped secret and every request from it fails from that moment. Data
already on a revoked device stays readable there; rotating `VRK` after a
device compromise is a phase-2 operation (re-encrypt manifests and
re-derive domain keys; chunks under a domain whose key is rotated are
re-uploaded lazily).

Account recovery uses a domain-separated 32-byte HKDF output from VRK,
`obsync/v1/account-recovery` as salt and empty info, solely as an authentication
proof. The server stores only its SHA-256 verifier in the account journal frame
and snapshot. An authenticated client registers it after a successful engine
start; initial setup writes it atomically with the account. Registration is
immutable: a different verifier is refused. Re-enrollment requires both the
standing setup token and the proof, creates a new credential, and retains the
same account and ciphertext. Accounts upgraded after losing every credential
have no verifier and cannot use this route. The server still refuses their
last active device's revocation while a credential remains.

A forgotten or revoked device stops its feed rather than retrying authentication.
The recovery action drains old work and clears its rejected identity, cursor
and sync records, retaining its vault key, address, access headers and all
local files. Setup responses are bound to the issuing session and key; the
setup action is single-flight. A lost response requires an explicit new action.

### 4.4 Credential transport trade-off

The device secret crosses the TLS terminator at setup or pairing; account
recovery also exposes its authentication proof and setup token there. The
proof cannot derive content keys, but with the token it authorizes enrollment. Thus the
terminator is trusted for credentials. A key-agreement enrollment protocol
is deferred and requires its own protocol and cryptographic review; it is
not part of the current authentication path.

### 4.5 Dashboard sign-in

v1: a paired device mints a single-use dashboard link (`POST
/v1/dashboard/login-link`). The setup token from §4.1 remains the recovery
sign-in, valid for the life of the server and stored only on the journal
volume.
Sessions are cookies named `__Host-obsync_session` and `__Host-obsync_csrf`:
`Secure`, `Path=/`, `SameSite=Strict`, no `Domain`, the session one
`HttpOnly` and the CSRF one readable by the page for the double-submit
header. The browser enforces that set because of the `__Host-` prefix, so
the dashboard must be reached at an `https` address -- or, in Chrome and
Firefox only, at plain `http://localhost` or `http://127.0.0.1`; Safari
sends no `Secure` cookie to a plaintext origin
([`security/dashboard.md`](security/dashboard.md)).

A session ends after 12 hours whatever it does, after 1 hour with no request
on it, on sign-out, on `POST /v1/admin/logout-all` (which drops unspent
login links with them), and when the device
whose link opened it is revoked -- a session and a link both remember which
device minted them, so revocation reaches the dashboard and not only the
sync API. `GET /login` has no attempt limit in front of its constant-time
compare, deliberately: a limit keyed by request source refuses every visitor
at once wherever that source is an untrusted proxy, which is the chart's own
default. Passkey sign-in is deferred; the current dashboard does not
register or authenticate WebAuthn credentials.
[`security/dashboard.md`](security/dashboard.md) is this surface's threat
model.

## 5. Sharing (phase 2)

**v0.1 ships owner-only sync.** Every paired device is the owner. There is
no recipient role, no domain-scoped or read-only credential, and the change
feed a device follows is unfiltered: a device that can authenticate sees
every version in the account. Domains exist as the key-scoping unit and v0.1
uses exactly one. Nothing in the API, the plugin, or the dashboard grants
anyone but the owner access to anything, and no wording in this repository
should suggest otherwise.

**Manual access on the host** is the only access path beyond a paired
device: `obsyncd export --domain <id> --key <hex> --out <dir>` reconstructs
that domain's stored ciphertext from the volumes -- file records carry their
domain in clear (5.1 item 4), so the filter is exact -- and the operator
decrypts it on a device that holds the key. It is the same binary; opening
storage performs the recovery and posture changes described in
[Offline check and recovery verdicts](storage.md#offline-check-and-recovery-verdicts).
Use a restored copy with the server stopped, preserving the pristine backup.

**Phase 2 adds recipients**, and ships only when both of these hold:

1. A recipient cannot read unshared content or filenames, cannot enumerate
   unrelated files, cannot write through a read-only grant, cannot acquire
   owner privileges.
2. The wire format for separate sharing scopes is defined, implemented and
   reviewed before any recipient identity exists: a path-to-domain map
   encrypted under an owner-only key, a per-domain manifest key, single-file
   domains, move semantics between domains, and revocation as rotation,
   which cannot recall copies already taken.

The second holds as of v0.1.0: 5.1 is that format, and it ships in the
genesis release. The first does not, so sharing is a design note and not a
feature: nothing invites anybody, and the acceptance criteria above are what
that changes on.

### 5.1 Sharing scopes: the format (decided 2026-09-07)

**The runtime stays owner-only; the format does not wait.** v0.1.0 is the
genesis release, so every vault that will ever exist is written by it or by
something later. A format change after the first vault means re-encrypting
every manifest on every device; a format change now costs nothing. What
follows is implemented and tested in v0.1. Only the grant is missing, and
until the acceptance criteria above pass, no code path creates one.

**What was wrong.** Until this section the manifest key was vault-wide,
`HKDF(VRK, "obsync/v1/manifest", "")`. That left phase 2 no move worth
making. A recipient handed one domain key could decrypt that domain's chunks
but not the manifests that name them, so the grant was useless; a recipient
handed the manifest key could read the name, size, path and chunk list of
every file in the vault, so the grant was catastrophic. With one vault-wide
key there is no third option, and the fix is a derivation, not a policy.

**1. A domain is a set of paths, and one file can be a domain.** A domain
owns exact paths and path prefixes; where two entries match a path, the
longest match wins. `Notes/Trip.md` may therefore be its own domain while
`Notes/` is another, so sharing one note never hands over its siblings —
the property that makes single-file sharing safe rather than approximate.
The default domain is the one holding the empty prefix, exactly one exists,
and it catches every path no other entry claims.

**2. The manifest key is per domain.** `K_m,d = HKDF(K_d,
salt="obsync/v1/manifest", info=domain_id)`. The vault-wide manifest key is
gone. A recipient of `K_d` derives `K_m,d` and reads that domain's names and
its chunks, and can derive neither for a domain it was not given, because
`K_d` is `HKDF(VRK, "obsync/v1/domain", domain_id)` and `VRK` never leaves
the owner's devices. The manifest AAD is unchanged (`file_id ||
content_version_id`), so a manifest still cannot be replayed onto another
file, another point in the version graph, or another chunk list.

**3. The path-to-domain map is owner-only, and it is synced.** Devices must
agree about which key a path belongs under, so the map is data, not local
configuration. It is one object encrypted under `K_map = HKDF(VRK,
salt="obsync/v1/domainmap", info="")`, which no recipient ever holds, and it
travels through the ordinary file mechanism: one reserved file id, ordinary
versions, the ciphertext in the manifest slot the server already cannot
read. Both reserved identifiers come from one `HMAC(K_map,
"obsync/v1/domain-map")`: the first 16 bytes are the file id, the last 16
are the domain id the file records itself under. Neither is guessable
without `VRK`, and to the server the object is one more opaque file.

The plaintext is
`{"v":1,"domains":[{"id":"<32 hex>","paths":["<prefix>",…]},…]}`, bounded by
the 1 MiB manifest ceiling. Its nonce is derived, not random —
`HKDF(K_map, "obsync/v1/nonce", SHA-256(aad || plaintext))[0..12]` — so two
devices that write the same map at the same moment produce the same bytes
and the same version id and collide harmlessly, exactly as two devices
producing the same chunk do (3.2). The key and nonce repeat only for a
message that is identical in both its plaintext and its AAD.

The map on the server is the authority. A device reads it at every start,
before it syncs anything: if it is absent the device writes one (v0.1's map
is a single default domain with the empty prefix), if it is present it
replaces whatever the device remembered, and if it cannot be read or has
more than one head the device refuses to sync and says so. Guessing which
map is current would mean writing a file under the wrong key, so this
refusal is fail-closed by construction (AGENTS.md requirement 4).

**4. File records carry `domain_id` in cleartext.** A version post names the
domain of its file, and the server records it on the file. This is what
phase 2 authorizes against: a change feed filtered per domain, and chunk
access allowed per domain, are both server-side decisions that need a
server-visible label. The id is random and means nothing to anyone without
the map, so it leaks no path, and it is the only new clear field. A file's
domain is set by its first version and is immutable: a later version naming
a different domain is refused (`409 domain_mismatch`), so a grant cannot be
widened, narrowed, or redirected under a recipient by a version post. The
server-side consequence is visible today, before any recipient exists:
`obsyncd export --domain` now exports that domain's files instead of every
file the store holds.

**5. Moving a path across a domain boundary is a delete and a create.**
Content encrypted under domain A cannot become content under domain B by
relabelling: `cid = HMAC(K_d, plaintext)` and the chunk key derive from
`K_d`, so the bytes must be re-chunked and re-encrypted under `K_B`, which
yields new cids, new sids and a new manifest under `K_m,B`. Because a file's
domain is immutable (item 4), the move is a tombstone for the old file id in
domain A and a new file id in domain B. The old chunks age out through
retention and garbage collection. Anyone who held domain A keeps every copy
they already downloaded; a move removes future access, never past access.

**6. Revocation is rotation, and rotation is a new domain.** To revoke a
recipient the owner points the same paths at a NEW `domain_id` in the map.
`K_d` for the new id is unrelated to the old one, files re-upload lazily
under it as they are next written, and the old domain's data ages out. The
recipient keeps what it already has: nothing in this design, or in any
end-to-end encrypted design, recalls a copy on somebody else's disk. That
limit is stated here so no interface ever implies otherwise.

**7. What phase 2 must prove.** A recipient cannot read unshared content or
filenames, cannot enumerate unrelated files, cannot write through a
read-only grant, cannot acquire owner privileges; and inviting anyone is not
presented as supported until those pass. The format above is the reason the
first two are achievable at all — the third and the fourth are the server's
authorization work, and none of it exists yet.

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
and lets devices resolve. It holds at most 64 heads per file, the same
number of parents one version may declare, so the file a device is asked to
resolve is always resolvable by one merge naming every head; the version
that would leave a 65th is refused with `409 too_many_heads` and nothing
already stored changes. Replay applies whatever the journal holds: the
ceiling is a decision taken where a version is accepted, not a rule
re-applied to history.

One thing the server does recognise: two devices that resolve the same
conflict to the same bytes post the same parents and the same
content-addressed chunk list under two version ids, because the id covers
the encrypted manifest and its nonce. The second post says nothing the
first did not, so a client that declares it will store the id it is
answered with (`accept_existing`, `docs/protocol.md`) is answered with the
first version's id and no frame is written. That is recognition, not
resolution: the comparison is over what the server already stores, the
same parents with other chunks still fork, and a client that keeps its own
computed id -- every 1.0.x client -- is stored as posted.

The **change feed** is the journal's version and tombstone frames, in
sequence order, exposed by `GET /v1/changes?since=<seq>&wait=<s>`.
`wait` long-polls up to 55 s (inside the edge's 100 s idle limit) and
returns immediately when a new frame lands.

### 6.2 Plugin loops

1. **Watcher.** `vault.on(create|modify|delete|rename)` plus a startup
   reconciliation that compares `(mtime, size)` per path against the local
   state and re-hashes anything that differs. Events are debounced 500 ms
   per path, and the growing-file guard then compares each stat with the one
   the previous recheck took, 400 ms earlier: a file that has been seen
   changing must hold still for 5 s before it is queued, and a push whose
   file moved between the start and the end of its read is abandoned before
   a version exists. A file still growing is retried, never uploaded torn.
   A volume that keeps a modification time to the whole second (FAT32 keeps
   it to the even second) can give a second save of the same size the same
   `(mtime, size)` as the first, so a push made less than one 2 s step from
   such a time pushes once more when the step has closed; the digest
   decides, and unchanged bytes post nothing (issue #175). For the same
   reason a change of a note of at most one chunk is read even when the record
   already describes its `(mtime, size)`, while another device's version of
   that note has just arrived -- remembered until the first pass after it is
   five seconds old: a plugin answering a sync can keep both numbers, a
   fixed-width stamp the size and a kept modified time the other (issue #179).
   Startup and periodic scans retain their metadata shortcut. Explicit
   **Sync now** re-chunks every admitted local file; unchanged digests publish
   nothing, and a silent same-metadata rewrite is uploaded even long after
   the arrival window expired. It uses the ordinary bounded streaming push
   and device budget policy rather than buffering the whole vault.
   Every 30 s the engine also compares its own listing of the vault against
   the local state. On desktop that listing is the filesystem, read directly,
   because Obsidian's index is never fresher than the events it emits: a
   note moved in from a file manager is in neither until the app notices.
   The periodic pass is ADDITIVE -- it queues work and it pairs a vanished
   recorded path with a new unrecorded one carrying the same `(mtime, size)`
   as a MOVE, keeping the file id -- and it never publishes a tombstone,
   because a listing this device took itself is the right thing to converge
   from and the wrong thing to delete on. Deletions stay with the watcher
   and with startup reconciliation, which read Obsidian's own index.

   THE SCAN READS RECORDS BEFORE THE LISTING, and that order carries one
   fact. A rename the plugin never heard as an event -- made while Obsidian
   was closed, or dropped by the host's index -- is a record whose path has
   left the listing and a listed path no record explains. Queued the other
   way round the second is published as a NEW file id before the first is
   recognised, which on a filesystem that FOLDS CASE is how `Team docs`
   renamed to `team docs` became two folders on every device that does not
   fold (issue #124). Two spellings of one name are paired as the rename
   they are when the listing holds exactly one of them and the host still
   answers for the spelling its own listing dropped -- an answer only a
   folding filesystem gives, and there the two spellings ARE one directory
   entry. A host that keeps them apart answers nothing for a file that is
   gone, so a deletion beside a genuinely different note whose name differs
   only in case still publishes its tombstone.
2. **Push.** Read, chunk, encrypt, batch-check existence (`POST
   /v1/chunks/exists`), upload missing chunks with bounded concurrency
   (4 on desktop, 2 on mobile) and resume by `sid`, then post the version.
   A rejected parent set means another device wrote first; the plugin pulls,
   reconciles, and retries.
3. **Pull.** Follow the change feed; for each version not authored here,
   download missing chunks, decrypt, assemble, verify the plaintext
   `sha256`, and write atomically (temp file plus rename on desktop via the
   Node filesystem; adapter write on mobile). Echoes of the device's own
   versions are recognized by `version_id` and skipped. A version whose path
   moved is applied as a MOVE, and from 1.1.0 that is the host's own atomic
   rename whenever the source still holds exactly the content the version
   carries (issue #108): nothing is downloaded and nothing is trashed. A
   source holding anything else takes the older path -- the new name is
   written and the old one trashed -- and so does a version this device holds
   under no name at all. Two spellings that differ only in CASE are one more
   case of the same rule, and the one place it can never be a write: that
   is one rename of one entry on every host and must never be a write and a
   removal, because on a folding filesystem the write lands in the file this
   device already has and the removal then takes it, while the same host
   answers the destination's lookup with the source's own file, which the
   same-name rule settles as a collision at the old spelling for good
   (issue #124). The host renames the entry instead, refusing when a
   DIFFERENT file wears the destination's exact name -- proved by inode on
   desktop and by the adapter's case-sensitive existence check on mobile --
   and that refusal is the real collision, which takes the same-name rule as
   before. A DIRECTORY'S CASE IS NOT A NOTE'S TO CHANGE, and that is the half
   an entry rename cannot do: `rename(2)` resolves the directory components
   of its destination, so a per-file rename whose difference lies above the
   last component renames nothing and reports success. The FOLDER record
   re-cases the directory entry itself and carries every record beneath it
   with it (`pull.ts`, `recaseFolder`), the sender publishes that record
   BEFORE the moves under it (`main.ts`), and a per-file move reaching a
   device whose directory still wears the old spelling is REFUSED rather than
   recorded: a record spelling a folder a way the vault does not show is what
   the scan reads as a rename and publishes back, which cost one version per
   note every `SCAN_MS` on both devices until the quota answered. The vault reports the ordinary move's removal back to this plugin like any
   other deletion, so the engine drops it once, by the path the pull path
   recorded before removing it. Without that gate a rename is republished as
   a tombstone and deletes the file on every device, which is what 1.0.4
   fixed (`plugin/src/sync/engine.ts`, ECHOES). A decrypted
   manifest is data from another device, not an instruction: its path is
   validated as a canonical relative vault path (no absolute path, no `..`
   or empty segment, no control character, no hidden segment) before any
   vault operation, and the desktop writer proves the boundary on the
   filesystem, not on the string: every path component from the vault root
   down is checked with a no-follow stat and must be a real directory,
   never a symlink; the temp file is a hidden name beside the target,
   opened exclusive-create and verified by descriptor before writing,
   before the rename and after it. The descriptor's identity is read at each
   check, because FAT32 and exFAT renumber a file when its first byte is
   written (issue #175). A hidden name is outside every listing and every
   publication, so a temp a quit leaves behind is never synced, and the next
   start removes it (issue #159).

   A write and a removal each report on themselves, because neither is
   atomic against the user. The metadata a writer answers with is the
   metadata of the bytes IT committed -- the descriptor's own stat, or the
   byte count handed to the adapter -- never a fresh look at the name, which
   after an in-place save describes another file under the same inode.

   A REMOVAL NEVER TARGETS THE LIVE NAME. A caller that removes a file names
   the content it is removing, and the desktop host first gives that file a
   second name with `link`, so the inode outlives whatever the vault's
   "Deleted files" preference does with the first -- including permanent
   deletion, which is an unlink of the name it is not holding. The vault name
   itself is then MOVED: one atomic `rename` into a hidden folder made for
   this removal in the same directory, keeping the note's own name, which
   takes whatever inode stands at that name in that instant and leaves the
   name FREE. No check can bind a path-based destructive call -- whatever a
   check found, the name can be replaced before the call
   reaches it -- so the check is moved to the far side of the rename, where
   it is about a file nothing else can reach. What MOVED is compared with
   what the caller copied: device and inode from the hold, size and
   modification time from the caller. A mismatch means the rename moved a
   REPLACEMENT -- an editor that saves by renaming a temp file over the note
   leaves a DIFFERENT file there -- so what moved is renamed back under the
   vault name, or kept beside it under a visible name when that name has
   been taken again, and the answer is `kept`. Only a match is handed to the
   vault's own deletion, FROM THE HIDDEN FOLDER, so the destructive call
   cannot reach a file an editor has since created at the vault name, and
   under the note's own name, because that is the name the user's bin shows.
   Obsidian indexes no dot-named path, so the host applies the "Deleted
   files" preference itself, as `FileManager.trashFile` would: the system
   bin, falling back to the vault's `.trash` when the system refuses; the
   vault's `.trash`; or a permanent deletion only when that is the setting
   (issue #138). Afterwards the hold still has the last word, because a
   rename does not close an editor's DESCRIPTOR: a program that still holds
   the file open writes through it wherever its name has gone, including
   between the proof and the removal, and including between this device's
   last look at the hold and the unlink that releases it. So the hold is
   OPENED before it is judged: the descriptor keeps the inode alive across
   its own unlink, which is what makes the unlink stop being the last word.
   A save that reached the inode before the release is put back by name; a
   save that lands after it is read back THROUGH that descriptor and written
   out under a name of its own. Either way nothing is released until the
   bytes are somewhere else: a restore that lands nowhere keeps the hidden
   name rather than dropping it.

   A RESTORE NEVER REPLACES WHAT TOOK THE NAME. Looking at a destination and
   then renaming onto it asks a question whose answer expires -- a save can
   create that name in between, and `rename` replaces it without a word --
   so `link` IS the check: it cannot replace anything, so a name taken in
   that instant fails the call instead of overwriting the note that took it.
   The alternatives are numbered (`(obsync kept)`, `(obsync kept 2)`, ...)
   because the name being competed for can be taken more than once, and a
   file the user cannot see is a file they have lost. One window
   remains, and it is stated rather than claimed away: an in-place write to
   the held inode, between the copy and the move, that leaves both the size
   and the whole-second modification time unchanged. A host that cannot make
   that second name at all -- every mobile device, and a filesystem that
   refuses `link` -- or cannot make that move, removes NOTHING, and the
   caller takes its non-destructive path instead, because a narrowed window
   is not a closed one. That is why the same-name rule
   settles a pair by renaming on a computer and by keeping both on a phone
   (`plugin/src/sync/pull.ts`, `VaultHost.bindsRemoval`), and the cost is a
   name rather than a note -- for as long as the name is held: a version
   kept beside its name records the name it carries and is moved there, by
   the same refusing rename, as soon as nothing holds it (`settleBeside`,
   issue #149). The name the moved file VACATES is taken with
   the create-only writer rather than a plain write, so a file an editor
   recreated there while the old one was being cleared away is kept and the
   pair is settled by keeping both instead. Hidden folders
   (`.obsidian`, `.git`) and symlinked folders are excluded from sync in
   both directions in v0.1; syncing them is a later opt-in. So is a folder
   holding its own `.obsidian/plugins/obsync-private-sync/`, a vault of its
   own that syncs with obsync, named once by a notice; and a desktop vault
   that sits inside such a vault refuses to be set up, paired or started.
   Synced from both sides, each pass copied the outer vault into the inner
   one a level deeper, on every device (issue #180).

   A DELETION IS A CHANGE LIKE ANY OTHER, and is answered with the same two
   questions. A tombstone whose parents do not include the version this
   device holds is one side of a fork: the graph says whether this device
   has already incorporated it (skip), whether it descends from what this
   device holds (apply), or neither, which is delete-versus-edit and keeps
   the edit live and the deletion in history. A live settlement names the held
   version and the deletion as parents, consuming the deletion head without
   consuming unseen live edits. Per-path publication is serialized so a startup
   push finishes before a revive selects its parents. Then the file at the
   path is proved against the record, so a
   note typed while Obsidian was closed -- or while its folder was outside
   the selection, which a widening replays the whole feed against -- is kept
   and republished rather than removed. So is a note open in an editor here
   when the tombstone's parent is the version this device holds, if the
   editor holds text its file does not or this device published an edit of
   it within `EDITING_WINDOW_MS` (10 s): its newest keystrokes are in the
   editor until Obsidian's two-second save. The removal itself is bound like
   every other: `expect` on a host that can bind one, and the unbound
   removal every device made before 1.0.7 where it cannot, because refusing
   there would drop a deletion the feed never delivers again.

   WHAT A PUSH RECORDS IS A PATH IT STILL SYNCS. Everything before the
   acknowledgement is asynchronous, so the file can leave the selection, or
   the vault, while the upload is in flight. The version stays published --
   other devices receive it -- but the record is written only if the path is
   still inside the selection and a file is still standing there. Writing it
   regardless put back a path the rename handler had deliberately forgotten,
   and the next scan read its absence as a deletion and took the note off
   every other device.

   AND A VERSION THIS DEVICE DID NOT COMPUTE IS PROVED BEFORE IT IS ADOPTED.
   The store answers a post that offers `accept_existing` with the version
   it already holds at that position, and its key -- `(file_id, parent set,
   sids, deleted)` -- cannot include the path, which lives inside a manifest
   the store cannot read. An ordinary edit and another device's rename-and-
   edit from the same parent to the same bytes are therefore the same key.
   The device reads that version back and adopts it only when its
   authenticated manifest describes the same operation (same path, same
   size, same deleted bit); otherwise it reposts with the offer withdrawn.
   Adopting blindly recorded the other device's path as this one's and
   marked its rename as this device's own echo, so the rename was lost on
   both sides.

   The record is the authority for what a version IS, and the manifest is
   bound to it field by field before policy, download, or a write. Decryption
   proves only that a device holding the vault key wrote the manifest; the
   record around it is what the server accounts, retains and will authorize
   on (3.4, 5.1). So the plugin refuses, before the first chunk request, any
   manifest whose ordered chunk sids are not exactly the record's `sids`,
   whose `domain` is not the record's `domain_id` and this engine's sole
   domain, whose `deleted` bit differs from the record's, or whose `size` is
   not both the record's `bytes` and the exact sum of its declared chunk
   lengths; and any chunk list that the chunker (3.3) could not have produced
   — a length above `CHUNK_MAX`, a zero length in a non-empty file, a
   non-final chunk below `CHUNK_MIN`, or a count that contradicts the size.
   Each declared length is then proved against the bytes as its chunk
   decrypts, so nothing unverified is written even when record and manifest
   agree, and one batched fetch is bounded by the chunk ceiling times the
   batch size rather than by lengths another device declared.

   ONE RECORD THIS DEVICE CANNOT WRITE NEVER HOLDS UP THE REST (issue #144).
   A write the host's filesystem refuses for that one file (`EPERM`, `EBUSY`,
   `EACCES`, `EROFS`, `ENOSPC`, `EDQUOT`, `ENAMETOOLONG`), or a chunk the
   server does not hold (`404 unknown_chunk`, or a missing part of a batch),
   PARKS the record: its file id, path and reason are persisted with the
   cursor that moves past it, the status and one notice name the file and the
   reason, and every later change keeps arriving. A parked file is retried
   against its CURRENT heads, so a later version or a deletion is what lands:
   one minute after it parks, doubling to half an hour, and at once at the
   next start and on **Sync now**; a later version of it that the feed
   applies settles it at once. A retry pass and the feed apply one at a time.
   Anything else -- the server out of reach, a refusal about this device, an
   I/O error -- is no fact about one record and keeps the feed's own retry.
   The filesystem causes are recognised on desktop only: the mobile adapter's
   errors carry no errno.
4. **Conflicts.** Two heads on a text file with a reachable common ancestor
   → a homegrown three-way line merge; a clean merge posts a new version
   with both heads as parents. Two heads that do not merge (binary, no
   ancestor, overlapping hunks) are settled by a rule every device computes
   alike without asking another: the head with the lower version id is the
   note on every device; the other is ONE conflict copy on every device, with
   a file id derived as `HMAC(K_m,d, "obsync/v1/conflict" || 0x0a || file_id
   || 0x0a || version_id)` and a name built from what the server says about
   that version -- `<name> (conflict from <author>, <UTC time>, <id prefix>)`
   -- so every device that settles the pair posts the same first version and
   the server keeps one; and one version naming both heads, holding the kept
   head's content, closes the fork. The device whose own head lost puts what
   its note holds beyond that head into the copy as its next version, and its
   note is replaced only if it is exactly as it was read. A head that a later
   version has replaced is settled against that version instead. Delete
   versus edit keeps BOTH, and so does a pair the rule cannot see (a rename
   against an edit, a copy name already taken): the foreign head is written
   as `<name> (conflict from <device>, <date>).<ext>` and the user is told.
   The status reads `syncing` while a note waits on this device's own push to
   settle a fork, and only while that push is in flight; a parked file is
   named before it. obsync never silently discards an edit.

   A version is written over a local file only when it DESCENDS from the
   version the device recorded for that file and the file still carries the
   size and modification time the device recorded for it. The version graph answers the first question,
   not the server's `conflicted` flag: that flag is the file's state when the
   version was journaled, so it says nothing about what this device has done
   since, and a device that obeys it discards its own merge. A version the
   recorded one already reaches is skipped; one that reaches the recorded one
   is a fast-forward across versions this device never applied. The file's own
   `(mtime, size)` against its record answers the second question, and that is
   the half NO server can see: a path with no record, a path recorded under a
   different file id, or a stat that has moved since the last push is local
   content that has never been uploaded, so materialising over it would
   replace bytes no version holds and no history can return. That second test
   is metadata, not content: an edit leaving both dimensions unchanged is
   invisible to it, exactly as it is to the startup scan that decides what to
   push. Three sites that destroy bytes are gated — the write at the incoming
   path, the removal at the old path when a version moves a file, and the
   conflict copy's own destination, whose name is derived and may already hold
   something, so it is published with a create-only writer that cannot replace
   and takes the next free name when it collides. A version that descends from
   the recorded one, arriving over local bytes, is left for the push: nothing
   is written or copied, the record is marked so the push cannot answer
   `unchanged`, and the push carries the local bytes with the parent the
   record names, which forks the file and makes the server see the conflict
   too; that fork is then merged or settled as above. Every write over the
   note looks at it again at the last moment, and a save that landed while a
   version or a merge was downloading is never written over.

   A merge is posted only when its result is new. Two devices resolving the
   same pair of heads produce the same TEXT and two different version ids,
   because a version id covers its manifest ciphertext and that carries a
   fresh nonce, so posting the second forks the file again and the other
   device merges that fork to the same bytes forever. A result equal to the
   local bytes therefore posts nothing and advances the record to the incoming
   version; a result equal to the incoming version's bytes is a fast-forward
   onto it. A device also stops merging one file after more than five
   resolutions of it in a row inside a minute with the note unchanged here in
   between -- a save starts the count again -- and says so once; the pair is
   then settled by the rule above, which only ever keeps a version that
   already exists. When two devices merged one pair differently (each holding
   keystrokes the other had not seen), the two heads share two newest
   ancestors, and their merge is the base; when those two were themselves
   merged differently, their base is found the same way one level down, to
   at most three levels, each one single-chunk text.

   A NOTE TWO PLUGINS KEEP REWRITING IS PAUSED (issue #179). A change within
   five seconds of a received version, without recent trusted Markdown editor
   input, is marked inside its encrypted manifest as a background answer.
   Merely showing a note is not input: a passive view can lag a file rewrite
   and appear unsaved. Captured keyboard and before-input events protect the
   note for ten seconds (including Obsidian's save debounce); an active IME
   composition stays protected until composition-end or focus-out. Input is
   bound to the view and file, including existing and newly opened popouts.
   Synthetic events cannot claim human input. The current input is checked
   again before holding a previously judged background answer.
   A collision involving such an answer, or two successive background
   answers, persists a hold before making a conflict copy. One encrypted v3
   control record per note propagates that hold to every updated device,
   including a device with the note open. Held notes neither publish nor
   apply; local text stays untouched, one notice describes the hold, and
   status remains paused after restart. Ordinary typing in two editors does
   not originate a hold. External editors, custom views and programmatic editor
   commands without trusted input are not observable as human typing and can
   trigger a conservative hold if they answer a
   sync on conflicting lines; the notice says another plugin *may* be involved.

   The device receiving an authenticated background answer can detect the
   overlap first while its own editor is being typed in. After trying a clean
   merge, it holds before conflict resolution could replace that editor's
   saved text. Otherwise the remaining keystrokes would extend an older
   branch and split one typed line between the note and a copy. The automatic
   answer's author recognises its own current answer when the control arrives;
   a same-name local file with a different identity cannot claim that role.

   Resume is explicit on each held device. The background author preserves its local
   background rewrite beside the note and takes the current note. A peer
   publishes the text its editor held while paused; foreign live heads are
   preserved before they are consumed, and a save during the upload leaves
   the hold in place. The control is cleared only after successful resume.
   After durably preserving its latest held text, the background author can
   adopt the sole peer head directly. This keeps a pre-hold fork from making
   another copy of the editor's branch when the background author resumes
   first. Multiple heads, missing versions and local-author heads do not
   qualify; a moved, deleted or multi-chunk peer is refused. A save while
   fetching the peer leaves the note and hold intact.
   Current heads, not historical feed frames, determine whether a received
   pause still applies. Identical controls do not add versions, even after
   restart; concurrent opposite controls retain both heads with pause winning
   until the next explicit Resume consumes them. See the wire contract's
   **Rewrite pause controls** for compatibility: v3 controls live under an
   opaque id of their own and an older decoder skips them without writing a
   file. All devices need 1.1.3 for the shared hold to stop a storm.

   A conflict copy is published with the create-only writer at the first
   derived name nothing holds, and an occupied name is reused only when its
   CONTENT hashes to the manifest's authenticated `sha256`: size and
   modification time are what a vault reports about a file, not what is in it,
   and a host chooses its own timestamps. The writer's owned temporary file is
   released on both outcomes, because the desktop publication links rather
   than renames and the temporary name would otherwise survive beside the copy.

   The base is the NEWEST version both heads reach, and neither head is its
   own ancestor. Newest matters: an older common ancestor replays edits both
   sides already agree on into the merge as spurious hunks. `GET
   /v1/files/{id}` renders versions newest first, so the base is the first id
   in that order that both heads reach. Both reachability sets are walked
   once and intersected — one walk per side, not one per candidate. The
   version graph is another device's to shape, the file a conflict lands on
   is the file with the longest history, and this runs on Obsidian's UI
   thread while the user waits.
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

### 6.2.0 Folder semantics (1.1.0)

Folders converge in both directions, and the whole of it is one record type
(3.4.1) plus one rule about when a folder may be removed.

**Publishing.** A vault `create` event for a folder publishes its record; a
`delete` event publishes a tombstone for it and for every folder record
beneath it; a `rename` tombstones the old path and publishes the new one, for
the folder and every record under it, while the files inside move as ordinary
per-file renames that keep their file ids. A folder whose record this device
already has is never republished, which makes the folder a pull just created
free. Startup reconciliation publishes a record for every folder that has
none and a tombstone for every record whose folder is gone, so a vault that
predates 1.1.0 converges once both devices update. It logs its budget as a
START line and its counts as a SUMMARY (requirement 12).

**Removal, and the rule that governs it.** A folder is removed only when it is
EMPTY on this device, and emptiness is asked of the FILESYSTEM, not of the
synced inventory: a hidden file, an unsynced note, another plugin's data all
keep it, and the file is never taken to make the folder go. Beyond that:

- a folder WITH a record is removed by its own tombstone and by nothing else,
  so an empty folder a user keeps does not vanish when its last note is
  deleted on another device;
- a folder with NO record is removed when a file leaving empties it, walking
  up to (never into) the sync root and stopping at the first folder it keeps.
  Nothing will ever tombstone such a folder, and it exists only to hold the
  file that is leaving.

ANOTHER DEVICE'S SILENCE IS NEVER A DELETION. A device on 1.0.x publishes no
folder record and no folder tombstone, ever, so a peer that emptied a folder
there has said nothing about the folder itself. The record rule above is what
answers that: this device gives a record to every folder it holds — startup
reconciliation to the ones it already had, the vault's own create event to the
ones a pull makes on its way to a file — so a folder this device holds survives
any number of files leaving it, and only a tombstone naming it removes it.

A folder tombstone that finds the folder occupied forgets the record and keeps
the folder: it is nobody's to manage now, and the empty-parent walk is what
will take it when it empties.

**Refusals.** A folder path takes the same vault-path rule and the same
desktop component walk a file path takes, so no folder is created through a
symlink or outside the vault. A folder record naming a path where a FILE
stands is refused and logged, and so is a file manifest naming a path where a
folder stands — on both platforms, since a folder can now arrive where a file
used to be. Every folder decision logs one line: `folder path_class=folder
decision=published|created|removed|kept|refused reason=… seq=…`.

**Per platform.** Desktop makes folders with Node's `mkdir` after the
component walk and reads the directory with `readdir` to decide emptiness;
mobile uses the vault adapter's `mkdir` and `list`. Both remove through
`FileManager.trashFile` when Obsidian's cache knows the folder, so the user's
own "Deleted files" preference decides where it goes, and through the
adapter's `rmdir` when it does not.

### 6.2.1 Device-local folder selection

Before pairing a vault that contains more than notes, select the folders
obsync may touch under **Sync folders on this device**. The optional
`syncFolders` field lives only in the local plugin data: missing keeps the
existing whole-vault behavior, `[]` syncs no files, and a list such as
`["Notes", "Attachments"]` syncs descendants of those relative folders.
The exact folder name is a directory, never an admitted file; `NotesExtra/`
does not match `Notes`. Absolute, traversing, hidden or otherwise malformed
entries are refused as a whole. A malformed persisted selection stops the
plugin loading instead of falling back to the whole vault.

The selection is independent of the domain map and download ceilings. It
never travels in pairing, the map, device policy or heartbeat, and a paired
device cannot change another device's selection. In selected mode the host
starts at the named cached folders rather than enumerating the vault. Both
the engine and host check scope before file operations; the desktop walk
may inspect selected directories and their ancestors, but no unrelated
subtree. One question alone is asked of the whole vault: before a note is
called deleted, whether a file carrying its size and modification time is in
the vault under another name (issue #139). It is answered from the names,
sizes and times Obsidian's own index already holds in memory -- no
filesystem access, no content, nothing logged or sent -- and it can only
withhold a deletion, never publish anything. Remote manifests, remembered sources for rename/delete/conflict,
on-demand downloads and merge ancestors must all be in scope. Excluded
remote changes are logged and skipped without fetching content, touching
the filesystem or adding a remote-only entry; the feed continues.

Saving waits for current transfers and manual downloads to finish, stops
queued work, persists the selection, then rescans. Excluded files, history
and local records stay intact; their absence from a scoped scan cannot
create a tombstone. An unposted rename retains a dirty record for the next
scan. A local move INTO the selection is a creation at the destination with
a fresh identity; a remembered excluded identity is never transferred in. A
local move OUT of it publishes nothing: the file is alive under its new
name, so the deletion this device would otherwise post is a tombstone every
other device obeys, the record is dropped so no later scan can infer that
deletion either, and the user is told once per move, with the count. That
holds however the move arrives: as Obsidian's rename, as the delete and
create a move made in a file manager is reported as, or as paths the
start-up pass finds gone with their bytes elsewhere in the vault (issue
#139). A delete event therefore waits 500 ms, with the rest of its burst,
before it is decided: the note's bytes found once inside the selection are
the MOVE of the same file id, found outside it are a note that left, and
found nowhere are the deletion it always was.

**A FOLDER RECORD's scope is the selected folder itself and everything inside
it**, which is where it differs from a file's: a folder record IS its path, so
the selected folder has one of its own, and that record is what carries its
creation, its removal and a rename of its capitalisation -- which no per-file
move can carry, because `rename(2)` resolves a destination's directory
components and renames only the last. File records keep the strict rule (a
selected folder is a directory, never a file wearing that exact name), and an
ANCESTOR of a selected folder stays a directory this device may walk and never
one it publishes. The rule holds on both paths: `folderCreated`,
`folderDeleted`, `folderRenamed`, `postManifest` and the start-up pass on the
push side; `applyFolder`, `removeFolder` and `recaseFolder` on the pull side.
One tolerance, for the receiving side: a record whose path differs from a
selected folder by the capitalisation of its LAST component alone -- an
ancestor spelled differently is a folder this device syncs in neither
direction, and `rename(2)` could not apply that difference in any case. The
tolerance exists for one thing, a rename of the selected folder made
elsewhere, and a string cannot tell that from a SECOND folder of that name on
a device whose filesystem keeps the two spellings apart; neither can the
vault, which on a volume that folds case answers "one directory entry" for
both by construction. So the record is admitted only in the state a rename
leaves on the wire: the tombstone for that folder's own record has been
applied, nothing has written a record for it since, and no other record has
already used that admission (`docs/protocol.md`, "The admission rule";
`sync/pull.ts`, `admitFolderRecord`; review round 4, finding 1). Admitted, it
is applied by asking the VAULT as before -- a host that keeps the two apart
holds nothing at that name and the record is refused as it always was.
Refused, it changes nothing and the user is told once, naming both spellings.
When a received record re-cases
the selected folder, the selection follows it, saved with the records that
move with it: a selection left at a spelling the vault no longer shows would
take every file under it out of scope in the same tick. A folder renamed to a
name this device syncs in neither direction publishes nothing and drops its
record, exactly as a file does -- the folder is alive under its new name, and
a tombstone for it is one every other device obeys.

Two shapes are deliberately outside that: a selected folder re-capitalised
or renamed from OUTSIDE Obsidian is not followed -- its notes are found
under the new name and leave the selection, told once, never deleted and
never held (issue #139); a bulk deletion is held (issue #123) only when the
bytes are nowhere in the vault -- and a
folder ABOVE a selected folder renamed on another device is outside what this
device syncs in either direction, so its record is skipped there and the moves
under it are refused with the folder-capitalisation notice.

Renaming or moving a folder that IS a selected folder, or that holds one,
moves the selection with it, in the parser's canonical form. Each file under
the folder is judged against the selection in force on EACH side of the
move — its old name against the selection before, its new name against the
selection after — so the files are published as renames and a record the
selection never covered is not brought in. What moves is everything the
device owes under that folder, not only the records: a note written moments
earlier is still in the debounce or the push queue with no record at all,
and leaving that work pointing at a name the folder no longer has left the
note on this device alone until something else triggered a reconciliation.
A destination this version syncs
in neither direction (hidden, malformed) cannot be followed: the selection
stays where it is and the files leave the scope unpublished.

Unloading the plugin invalidates pending startup and scope-change
continuations. A cancelled folder change cannot restart sync or replace a
newer load's engine or state. A local data write already issued may still
finish; cancellation asks the user to check the saved selection after
restart, without claiming either a successful change or an undone write.

**Widening replays the history this device skipped.** A selection that
gains a folder, or returns to whole-vault mode, rewinds this device's feed
cursor to 0; the restart then walks the change feed from the beginning, the
way a device syncing for the first time does, and the startup scan publishes
the newly covered local files. There is no "list the vault's files" call to
ask instead: for a file this device never covered, the feed is the only place
it exists. Narrowing keeps its cursor, because nothing new is covered.

The replay is safe because the pull path answers each record against what
this device holds NOW rather than against the order it arrives in: a version
this device authored is its own echo, a version its head already reaches is
`already_incorporated`, a tombstone for a file it no longer tracks is
skipped, and local content the server never received is kept beside the
incoming version instead of replaced (6.2 item 3). It is not free: replaying a file whose
history this device already holds spends one `GET /v1/files/{id}` per foreign
version older than its own head, and the decision line records the cursor it
rewound from. No
re-pairing, state reset or fresh vault is involved, and another device's
selection is untouched.

This limits obsync's file operations, not the Obsidian application, another
plugin, an OS process or a paired device's access to previously uploaded
content. It is not a recipient permission or an OS sandbox. Keep executable
administration files outside selected folders; a remote edit inside a
selected folder is still untrusted content. Desktop and mobile apply the
same selection; the existing platform filesystem and memory limits remain.

### 6.2.2 Native retained-history recovery

**Restore from history** reads the retained change feed with its own cursor,
never `State.lastSeq`, and never calls the feed application path. Each
click performs at most 20 serial, single-attempt requests with `wait=0` and
`limit=1`, stopping after five seconds plus the current request. One
contract-conforming response is under 6 MiB (at most 120 MiB cumulatively
per click); only one full response and 20 compact row descriptors are held.
The first response fixes the scan's head. Cursor progress is validated and
later records above that boundary are discarded. GC removes pruned versions
from the feed; retained content of deleted files remains browseable.

The selected version is fetched again by exact file/version id and checked
against the protocol id, authenticated manifest, domain and current folder
selection. A new sibling name is refused if occupied or remembered by local
file/remote-only state. Restore drains existing sync and manual downloads,
blocks competing starts/fetches/restores, and measures scoped local bytes
before download and again immediately before publication. Current policy
is checked again at the write boundary. External file writers can still
change usage between measurement and publication: this is device policy
admission, not an atomic filesystem quota.

Desktop creates an exclusive mode-0600 hidden sibling temporary file, streams
and verifies content, flushes it, and publishes with a same-directory hard
link that cannot replace a destination. It syncs the destination directory
and retains directory/inode confinement checks. Unsupported publication
primitives are errors; there is no overwriting fallback. Abort removes only
the attempt's temporary inode. A crash can leave a hidden temporary file;
it is excluded from sync, and recovery never automatically deletes unknown
temporary names. Mobile holds the completed file in memory and calls
`Vault.createBinary`, which rejects an existing destination. It exposes no
streaming writer or fsync primitive.

History operations are invalidated on modal close, unload, engine/identity
replacement and scope change. A same-instance reload waits for older
restore/manual-download settlement before loading state, then only the
current load generation resumes sync, including after publication errors.
Network cancellation detaches the waiter,
but a shared outstanding-request guard prevents another manual request
until the old one settles. `requestUrl` exposes neither abort nor streaming
or a pre-buffer byte ceiling; the size check runs before JSON parsing, after
Obsidian has buffered the response. A local publication already dispatched
must settle. It is never undone after cancellation: success is a local-copy
receipt, and an uncertain outcome names the path to check.

The copy is untracked and receives no pull echo marker. Ordinary watcher
ingestion/reconciliation gives it a fresh file id and posts its own history;
the original heads remain unchanged. Ordinary startup runs separately so
its retries cannot delay the local-copy receipt. That notice does not claim
remote sync. Native desktop/mobile validation and V8 evidence remain
separate from source and isolated tests.

### 6.2.3 Automatic restoration after scrub quarantine

After scrub quarantines a bad primary chunk without a healthy mirror, the
server removes that SID from its inventory. Each running client walks its
remembered, selected local versions independently of watcher events and
`(mtime, size)` reconciliation. It authenticates the exact retained version
and manifest, then asks which of its SIDs are absent. A healthy file requires
no local content read. A missing chunk is regenerated from its authenticated
offset and length only when the current local record, selection and stat
still match. Its CID and SID must match the retained manifest before the
signed, idempotent ciphertext PUT; an exact SID readback is required before
the client reports restoration. No version, tombstone, file identity, feed
cursor or selection is changed by this worker, and server quarantine evidence
is retained.

Work is incremental: at most one retained-version metadata read, 64 chunk
entries audited, and one chunk restored per step. The authenticated manifest
stays in memory across that file's batches. Steps run one second apart during
a walk, with five minutes between complete walks; **Sync now** advances one
step immediately. Completion time therefore depends on the number of files,
chunk batches, missing chunks and request latency. There is one repair worker
per engine, and stopping the engine cancels further work and drains an
already dispatched write before a replacement engine starts.

The host declares whether it can serve bounded ranges without buffering the
whole file. The native desktop filesystem host can; the Obsidian adapter
fallback, including mobile, cannot. Automatic repair on that fallback reads
only files whose entire size fits `CHUNK_MAX` (8 MiB). Larger missing-file
sources produce a visible capability refusal before any content read; a
synced desktop with range access is needed to supply them. This is a bound on
new background work, not a changed upload/download policy or an 8 MiB process
memory claim. Ordinary uploads retain their existing behavior. Automatic
repair of larger files using only non-streaming devices remains unsupported.

An absent, edited or unreadable source is not reconstructed or silently
marked healthy. The client reports an unresolved repair or a deferred
verification, without logging a clear path or content. A later walk can
retry after another matching source becomes available. This walk covers the
versions remembered by this device; it is not a global retained-history loss
audit. Server scrub/mirror results and actual native multi-device restoration
remain separate acceptance evidence.

### 6.2.4 A server restored from a backup (1.1.3)

A volume restore takes from the server every frame journaled after the
backup, and not from the devices: their records name versions the server no
longer holds, and the journal's next frames reuse seqs they have already read
past (issue #145). Two pieces of device state answer it, both in the plugin
data file, validated on load and dropped with a pairing.

**The feed mark** is the last change-feed entry the device consumed --
applied, skipped, echoed, or parked because this device could not write it
(6.2 item 3) -- with its seq, file and version ids and the server's `ts`. A
parked entry moves it like any other: left behind one, the mark would find
that entry in `(mark, cursor]` at the next start and read the journal as a
rebuilt one. A live journal never
reuses a seq, so the device asks for the mark again -- one
`GET /v1/changes?since=<mark-1>&limit=2&wait=0` at every start and after every
failed feed read. `416`, a head behind the cursor, another version at the
mark's seq, or a version where the device read none (`(mark, cursor]` held
none when it was read) prove a rebuild. When the mark's own entry is simply
gone, one `GET /v1/files/{id}/versions/{id}` decides: a version still held
elsewhere is a rebuild; a missing version younger than 24 h less the 300 s
signature window is one too; an older one is only suspected, since retention
may have pruned it. The age rule rests on three server facts: garbage
collection is the only thing that removes a version (`storage/index.rs`,
`prune_version`, reached only from a `Gc` frame); it keeps any version younger
than `OBSYNC_RETENTION_DAYS` whatever `OBSYNC_RETENTION_VERSIONS` says, and
buries a whole file only behind a sole tombstone older than that
(`storage/gc.rs`, `plan`); and `OBSYNC_RETENTION_DAYS` is at least 1
(`config.rs`). A device whose request verified is within 300 s of the
server's clock (`api/auth.rs`, `CLOCK_SKEW_SECS`). A server whose clock ran
more than a day ahead while its collector ran breaks the rule: a mark it
pruned then would read as a proved restore. A repair pass that gets
`404 unknown_version` for a recorded version raises the same question,
proved or suspected by the same age rule, and never the read-or-write error.
A device with no mark yet -- one updated from 1.1.2 -- sends no probe; its
first processed entry writes one.

**The graves** are the tombstones the device published or applied: file id,
tombstone version, path, folder flag, and the server `ts` once seen. They are
the only evidence a deletion is ever re-sent from; a record missing from the
state never deletes anything. At most 1000 are kept, oldest dropped first with
a logged `grave decision=dropped`, and recording the file id again drops its
grave.

**The check** (`sync/restore.ts`) lists `GET /v1/files` for every head, then
looks only at records and graves whose version is not a head. Each re-send
needs its own proof: `404 unknown_version` for the exact version recorded,
and versions the server still holds with `ts` at or before the mark's to name
as parents -- the processed heads -- none of them newer than the lost version.
A newer one means retention pruned a version under a record this device kept
behind on purpose (a refused move, an unselected destination), and it is left
alone. A file the server lacks entirely is re-sent with no parents, only on a
proved rebuild or for a version too young to have been collected. A record
with no `ts` -- written before 1.1.3, or a post of this device's whose echo it
never read -- is re-sent only in that case. A re-send
offers deduplication, so two devices re-sending one version publish one, and
a head written on the restored server stays: the re-send forks beside it and
the ordinary merge and keep-both rules decide. The check is bounded by 1000
reads and 10 minutes, logs `restore decision=start` with both budgets, one
line per candidate, and one `restore decision=summary` with the counts, the
skip reasons and `cut_short`. Every file id it decides is not re-raised by the
repair pass for the rest of the engine's life.

The probe is a read, like the long poll: it is not waited for by a stop, and
its answer after one is dropped. The check and the rewind that follows it are
writes, and run in the one pull slot a feed page and a parked record's retry
pass share, never beside either.

After a proved rebuild, or a check that re-sent anything, the device re-reads
the feed from zero with the mark flagged `replay`: an entry at or before the
mark by server `ts` (and by seq within one millisecond) is skipped, so
yesterday is not re-applied over today, and the first entry after it replaces
the mark and ends the replay. A version this device still records but the
server no longer holds as a head is never kept over an identical head the
server does hold (`pull.ts`, identical bytes). One notice per run that
re-sent: "The server was restored to an earlier state; this device re-sent N
changes."

The same code runs on desktop and mobile: reads through the ordinary
transport and re-sends through `pushFile`, so a file above the mobile ceiling
is sent the way it was first sent.

### 6.3 Updates

The plugin never installs code it fetched from the server: a server or a
TLS terminator that could replace both the bytes and the hash it serves
would otherwise gain the vault key at the next reload. The plugin
only compares its version with `GET /v1/plugin/manifest` on start and
tells the user when the server runs a newer one. Installation and updates
use Obsidian's Community Plugins browser, which downloads the three native
files from the matching GitHub Release. The server retains only
`GET /v1/plugin/manifest` for version metadata; the obsolete bundle and style
HTTP routes return 404. Packaged files remain build and release inputs. The release's v2 evidence binds
the individual files to the same ZIP and build as the server. The native
installer does not document verification of this project's Cosign evidence;
see `docs/community-plugin.md` for the actual client trust model. A separate
pinned-key verifier is not part of this installation path.

## 7. Storage, durability, replication

`docs/storage.md` is the contract. In brief: one blob volume, one journal
volume, each bound to whatever StorageClass the operator names -- the chart
ships a default name that every deployer replaces with a class their own
cluster offers; every write is
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
| `OBSYNC_PUBLIC_URL` | empty | The base every generated link is built on -- the dashboard sign-in link the plugin asks for, and the addresses the pairing and install pages show. Empty is the private default: the server then hands out a relative link and the device resolves it against the server address it is configured with. Set, it must carry the scheme, the host AND the port devices arrive on |
| `OBSYNC_SERVER_KEY` | empty | 64 hex chars; generated once if absent |
| `OBSYNC_FREE_WATERMARK` | `5%,2GiB` | Refuse writes below the larger of the two |
| `OBSYNC_RETENTION_DAYS` | `30` | Version and tombstone retention |
| `OBSYNC_RETENTION_VERSIONS` | `10` | Minimum versions kept per file |
| `OBSYNC_SCRUB_RATE` | `4MiB/s` | Background integrity budget |
| `OBSYNC_MAX_CONNECTIONS` | `256` | Concurrent connections (one thread each; long-polls are cheap) |
| `OBSYNC_LOG` | `info` | `error`, `info`, `debug` |

Sizes (`OBSYNC_BLOBS_CAPACITY`, `OBSYNC_JOURNAL_CAPACITY`, the size term of
`OBSYNC_FREE_WATERMARK`, `OBSYNC_SCRUB_RATE`) are binary and are spelled
exactly one way each: a bare byte count (`512`), `B`, the Kubernetes binary
suffixes `Ki`, `Mi`, `Gi`, `Ti`, or their long forms `KiB`, `MiB`, `GiB`,
`TiB`. `Gi` and `GiB` are the same multiplier, which is what lets the chart
hand the server the claim size an operator writes for Kubernetes. Everything
else is refused rather than guessed at: the decimal SI suffixes (`k`, `M`,
`G`, `GB`) because Kubernetes reads them as powers of a thousand, a fraction
(`1.5Gi`) because the grammar admits whole units only -- one form per
multiplier, deliberately, though the value itself is an exact byte count --
and any other spelling (`gi`, `GIB`) because one spelling per multiplier is
what keeps `250G` from ever meaning 250 GiB. A size whose whole-unit product
does not fit in 64 bits (`17179869184Gi`, exactly 2^64 bytes) is refused
rather than wrapped.

## 10. A reference shape, and what varies

This is the SHAPE the chart is written for, stated as guidance rather than as
an account of any particular installation. Any deployment's own values,
addresses, volumes and access decisions are the deployer's, and the one this
project is developed against is private (requirement 11).

A single-node cluster reached over private connectivity -- a LAN, or a VPN
back to it -- with no public hostname, no public access application and no
public route. A tunnel provider is an option this shape does not take.

One namespace of the deployer's choosing; one Deployment (single replica,
`Recreate`, because two writers cannot share these volumes); one Service on
8080; one default-deny NetworkPolicy admitting ingress from the one peer that
terminates TLS; two static local PersistentVolumes sized to the disk the node
actually has, the journal claim at or above the watermark floor
(`docs/storage.md`); and `OBSYNC_SERVER_KEY` from a Secret whose contents
never enter a repository. Edge mode follows the posture: `OBSYNC_EDGE=none`
while nothing but private connectivity reaches the deployment, so a forwarded
address is trusted only from `OBSYNC_TRUSTED_PROXY_CIDRS` (section 9).

Publishing a hostname later is a configuration change, not a redesign: a
tunnel for one hostname (`sync.example.org` standing in for the deployer's
own) with an access policy in front -- identity policy for the dashboard
paths, service-token policy for `/v1/*` -- and `OBSYNC_EDGE=cloudflare`, which
makes the edge's connecting-address and request-id headers mandatory on every
request and refuses one that lacks them. `docs/platform-onboarding.md` lists
what a GitOps platform repository has to add.

Every other deployment differs from it in the terminator and in which
proxies, if any, may speak for a client's address; the edge mode is `none`
wherever nothing but private connectivity reaches the server:

| Deployment | `OBSYNC_EDGE` | TLS terminator | Trusts forwarded addresses from | Proven by |
| --- | --- | --- | --- | --- |
| Cluster (private connectivity) | `none` | an in-cluster TLS terminator in front of the pod, as `docs/kubernetes.md` builds one | `OBSYNC_TRUSTED_PROXY_CIDRS`, empty until a reviewed change names a proxy | `.github/workflows/helm-e2e.yml`, which installs the chart and the terminator and runs a device flow through them |
| Compose (any network, no provider) | `none` | Caddy, `deploy/compose`, reachable only on the bind address you choose | `OBSYNC_TRUSTED_PROXY_CIDRS`, the compose network only | `scripts/ci/compose-smoke.sh`, in the PR gate |

The Compose row is the one a stranger can run: a private name, a certificate
authority Caddy generates, and no account with any provider. Reachability is
the deployer's own decision, in `OBSYNC_BIND_ADDRESS` and in the firewall
and routing around the host: the name and the certificate authority settle
what the service is called and which devices trust it; the bind address
settles which interface accepts connections and nothing about their source,
since routed, VPN or forwarded traffic arriving at a LAN address is accepted
unless a firewall or the router's forwarding rules refuse it. The compose file requires that variable and
defaults it to nothing. `docs/server.md`, "Any network, no provider", is its
install path.

## 11. Current and deferred scope

The implemented runtime provides owner-only encrypted sync, pairing,
version notices, device policy, history recovery, server storage and a local
dashboard. Native install/update, app-restart credential persistence and
multi-device acceptance are separate validation results in `docs/validation.md`.

Key-agreement enrollment, passkeys, vault-key rotation, recipient grants,
replica servers, size padding and multi-account support are deferred without
numbered release promises. Sharing remains subject to section 5's acceptance
criteria. Native Obsidian distribution owns client updates; a separate
server-fed updater is not part of this design.
