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
holds no vault content. The phase-2 X25519 pairing agreement (section 4.4)
is the fix for the pairing half and is first in line: after it the terminator
sees only public values there. Nothing removes a terminator from the session
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

v1: a paired device mints a single-use dashboard link (`POST
/v1/dashboard/login-link`). The setup token from §4.1 remains the recovery
sign-in, valid for the life of the server and stored only on the journal
volume.
Sessions are `HttpOnly`, `SameSite=Strict` cookies with a double-submit
CSRF header. Phase 2 adds passkeys (WebAuthn): the server gains ECDSA P-256
verification and a CBOR/COSE subset in `obsync-core`, verify-only, tested
against the WebAuthn test vectors. YubiKeys are passkeys.

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
decrypts it on a device that holds the key. It is the same binary and touches the server's
data read-only.

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

Every other deployment differs from it in two values and nothing else, the
terminator and the edge mode:

| Deployment | `OBSYNC_EDGE` | TLS terminator | Trusts forwarded addresses from | Proven by |
| --- | --- | --- | --- | --- |
| Reference (pie5) | `cloudflare` | Cloudflare Tunnel, Access in front | the edge's own headers, required on every request | the deployment; `docs/validation.md` V1-V14 |
| Compose (any network, no provider) | `none` | Caddy, `deploy/compose`, reachable only on the bind address you choose | `OBSYNC_TRUSTED_PROXY_CIDRS`, the compose network only | `scripts/ci/compose-smoke.sh`, in the PR gate |

The Compose row is the one a stranger can run: a private name, a certificate
authority Caddy generates, and no account with any provider. Reachability is
the deployer's own decision and is made once, in `OBSYNC_BIND_ADDRESS`: the
name and the certificate authority settle what the service is called and
which devices trust it, while the host address 80 and 443 are published on
settles who can open them. The compose file requires that variable and
defaults it to nothing. `README.md`, "Any network, no provider", is its
install path.

## 11. Phases

1. **v0.1.x — MVP:** core primitives, server (storage, journal, API, feed,
   GC, scrub, dashboard v1, CLI), plugin (watch, chunk, encrypt, push, pull,
   conflicts, policy, pairing, version notice), chart, CI, release path,
   three device validation, first benchmark table.
2. **v0.2.x:** X25519 pairing, passkeys, signed plugin updates against a
   pinned key, Cloudflare Access JWT verification from a mounted JWKS,
   `VRK` rotation, QR pairing codes, and recipients under the section 5
   acceptance criteria.
3. **v0.3.x:** replica server mode, size padding option, text compression
   opt-in, multi-account.
