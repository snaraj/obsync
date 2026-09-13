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

The reference deployment uses the first (section 10): private connectivity,
no public hostname, and therefore no third party on the path at all. A tunnel
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
device, returning its device credential, because every later enrolment
goes through pairing and pairing needs an already-paired device. The
plugin then generates `VRK` locally. The token is consumed for setup once,
but it is not discarded: it remains the dashboard's recovery sign-in for
the life of the server (§4.5), so its custody equals the recovery
phrase's. The user is shown the
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
3. The paired device polls the pairing, shows "Approve <name> on
   <platform>?", and on approval encrypts `{VRK}` with `K_pair =
   HKDF(PS, "obsync/v1/pair", pairing_id)` under AES-GCM and posts the
   envelope. The server stores it for one fetch.
4. The new device fetches the envelope (a signed request), decrypts it with
   `PS`, and persists `VRK` through the native secret store before sync starts. Approval
   is what activates the device; rejection, or expiry of an unapproved
   pairing, destroys the pending credential.

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

Obsidian 1.12.4 or newer is required; the vendored official API package is
pinned separately to 1.12.3. The plugin uses only the public SecretStorage
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
and [API baseline](../plugin/vendor/obsidian/README.md).

### 4.3 Revocation and recovery

The dashboard and any paired device can revoke a device; the server drops
its wrapped secret and every request from it fails from that moment. Data
already on a revoked device stays readable there; rotating `VRK` after a
device compromise is a phase-2 operation (re-encrypt manifests and
re-derive domain keys; chunks under a domain whose key is rotated are
re-uploaded lazily).

### 4.4 Credential transport trade-off

The device secret crosses the TLS terminator at setup or pairing, so the
terminator is trusted for credentials. A key-agreement enrollment protocol
is deferred and requires its own protocol and cryptographic review; it is
not part of the current authentication path.

### 4.5 Dashboard sign-in

v1: a paired device mints a single-use dashboard link (`POST
/v1/dashboard/login-link`). The setup token from §4.1 remains the recovery
sign-in, valid for the life of the server and stored only on the journal
volume.
Sessions are `HttpOnly`, `SameSite=Strict` cookies with a double-submit
CSRF header. Passkey sign-in is deferred; the current dashboard does not
register or authenticate WebAuthn credentials.

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
   vault operation, and the desktop writer proves the boundary on the
   filesystem, not on the string: every path component from the vault root
   down is checked with a no-follow stat and must be a real directory,
   never a symlink; the temp file is opened exclusive-create and verified
   by descriptor before writing and after the rename. Hidden folders
   (`.obsidian`, `.git`) and symlinked folders are excluded from sync in
   both directions in v0.1; syncing them is a later opt-in.

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
4. **Conflicts.** Two heads on a text file with a reachable common ancestor
   → a homegrown three-way line merge; a clean merge posts a new version
   with both heads as parents. Anything else (binary, no ancestor,
   delete-versus-edit, overlapping hunks) keeps BOTH: the foreign head is
   written as `<name> (conflict from <device>, <date>).<ext>` and the user
   is told. obsync never silently discards an edit.

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
subtree. Remote manifests, remembered sources for rename/delete/conflict,
on-demand downloads and merge ancestors must all be in scope. Excluded
remote changes are logged and skipped without fetching content, touching
the filesystem or adding a remote-only entry; the feed continues.

Saving waits for current transfers and manual downloads to finish, stops
queued work, persists the selection, then rescans. Excluded files, history
and local records stay intact; their absence from a scoped scan cannot
create a tombstone. An unposted rename retains a dirty record for the next
scan. A local move across the boundary is a deletion from the selected
source or creation at the selected destination; it never transfers a
remembered excluded file identity into the selection.

Unloading the plugin invalidates pending startup and scope-change
continuations. A cancelled folder change cannot restart sync or replace a
newer load's engine or state. A local data write already issued may still
finish; cancellation asks the user to check the saved selection after
restart, without claiming either a successful change or an undone write.

**No blind history replay.** Once this device has sync history, its
selection may only narrow. Adding folders or returning to whole-vault mode
is refused with an explanation: the skipped history has not been applied,
and rewinding the chronological feed could overwrite newer local notes.
To add local content within the same vault, move it into a folder already
selected and run **Sync now**. For a staged first sync, select the final
folder before pairing, keep personal files in an excluded staging folder
within the vault, validate disposable files inside the selected folder,
then move in the personal files. A different selection for an existing
shared vault needs a fresh local vault configured before pairing; deleting
plugin state or re-pairing over existing files is not a safe resync recipe.
Automatic reconciliation of current heads on expansion is not implemented.

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

## 10. Reference deployment (the reference node)

**Private and owner-only** (owner ruling 2026-09-07). A single-node cluster
reached over private connectivity, LAN or VPN: no public hostname, no public
access application, no public route. A tunnel provider is an option this
deployment has not taken.

Namespace `obsidian`; one Deployment (single replica, `Recreate`), one
Service on 8080, one default-deny NetworkPolicy admitting ingress from one
peer only; two static local PersistentVolumes on `local-pie-ssd` (blobs 250
GiB, journal 4 GiB), growable to 500 GiB; `OBSYNC_SERVER_KEY` from a
SOPS-managed Secret. Edge mode follows the posture: `OBSYNC_EDGE=none` while
nothing but private connectivity reaches it, so a forwarded address is
trusted only from `OBSYNC_TRUSTED_PROXY_CIDRS` (section 9).

Publishing a hostname later is a configuration change, not a redesign: a
per-app Cloudflare Tunnel for one hostname (`sync.example.org` standing in
for the deployer's own) with Cloudflare Access in front -- identity policy
for the dashboard paths, service-token policy for `/v1/*` -- and
`OBSYNC_EDGE=cloudflare`, which makes the edge's connecting-address and
request-id headers mandatory on every request and refuses one that lacks
them. `docs/platform-onboarding.md` lists the platform-repository changes.

Every other deployment differs from it in the terminator and in which
proxies, if any, may speak for a client's address; the edge mode is `none`
wherever nothing but private connectivity reaches the server:

| Deployment | `OBSYNC_EDGE` | TLS terminator | Trusts forwarded addresses from | Proven by |
| --- | --- | --- | --- | --- |
| Reference (pie5) | `none` | an in-cluster TLS terminator the platform trusts, in front of the pod; the deployment's own tuple lives in the platform runbook | `OBSYNC_TRUSTED_PROXY_CIDRS`, empty at activation: no forwarded address is trusted until a reviewed change names a proxy | planned, not yet proven: `docs/validation.md` V1-V14 by hand once the deployment is live |
| Compose (any network, no provider) | `none` | Caddy, `deploy/compose`, reachable only on the bind address you choose | `OBSYNC_TRUSTED_PROXY_CIDRS`, the compose network only | `scripts/ci/compose-smoke.sh`, in the PR gate |

The Compose row is the one a stranger can run: a private name, a certificate
authority Caddy generates, and no account with any provider. Reachability is
the deployer's own decision, in `OBSYNC_BIND_ADDRESS` and in the firewall
and routing around the host: the name and the certificate authority settle
what the service is called and which devices trust it; the bind address
settles which interface accepts connections and nothing about their source,
since routed, VPN or forwarded traffic arriving at a LAN address is accepted
unless a firewall or the router's forwarding rules refuse it. The compose file requires that variable and
defaults it to nothing. `README.md`, "Any network, no provider", is its
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
