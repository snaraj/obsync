# obsync wire protocol v1

*Internals, for contributors and reviewers.*

Dated 2026-09-07. HTTP/1.1, JSON request and response bodies unless a chunk
body is named, UTF-8, no cookies on the device API. Every path is prefixed
`/v1`. Errors are `{"error":"<snake_case_code>","detail":"<human text>"}`
with the status codes listed. Times are unix milliseconds unless the field
says seconds. Hex is lowercase.

## Authentication

Device endpoints require four headers:

| Header | Value |
| --- | --- |
| `X-Obsync-Device` | device id, 32 hex chars |
| `X-Obsync-Ts` | unix seconds, decimal |
| `X-Obsync-Nonce` | 32 hex chars, fresh per request |
| `X-Obsync-Sig` | hex HMAC-SHA-256 (see below) |

```
sig = HMAC-SHA-256(device_secret,
        "obsync/v1\n" + METHOD + "\n" + path_and_query + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(body)))
```

`path_and_query` is the request target exactly as sent (`/v1/changes?since=7`).
An empty body hashes as SHA-256 of zero bytes. Rejections: `401
bad_signature`, `401 stale_timestamp` (outside ±300 s), `401 replayed_nonce`
(seen within 600 s, and the 600 s survives a restart: accepted nonces rest on
the journal volume and are fsynced before the request is answered), `503
nonce_cache_full` (the replay cache is at its ceiling; refusing beats
forgetting a nonce still inside its window), `503 nonce_share_full` (this
device holds its whole share of that cache, 50,000 nonces, a quarter of it;
only this device is refused), `503 nonce_log_unavailable`
(the volume would not take that record), `403 device_revoked` (answered from the device
record before the signature is checked, because revocation destroys the
wrapped secret and leaves nothing to check it against; archiving that device
does not change this answer, because it does not remove the record),
`403 device_pending`
(a claimed device that has not yet collected the envelope its creator
approved, answered only AFTER its signature verifies; only that pairing's
envelope endpoint admits it, with `409 not_approved` until the approval).
Pairing claim and envelope fetch are the only device endpoints with their own
rules (below). Admin endpoints use the dashboard session cookie plus
`X-Obsync-Csrf`.

In `OBSYNC_EDGE=cloudflare` mode every request must also carry the edge's
connecting-address and request-id headers, once each, from a peer inside
`OBSYNC_TRUSTED_PROXY_CIDRS`, or it is refused with `421 edge_required`.

## Idempotence

A nonce is spent by being sent, so a retry that reuses the headers of a lost
request is answered `401 replayed_nonce` — a refusal the client manufactured
for itself. **Every retry is signed afresh**, with a new timestamp and a new
nonce.

That makes the question "may this request happen twice?" the client's to
answer before it retries at all, so every route states it here. **Repeatable**
means a second send leaves the server where one send would have left it and
answers the same.

| Route | Repeatable | Why |
| --- | --- | --- |
| `GET /livez`, `GET /readyz` | yes | reads |
| `GET /v1/account` | yes | read |
| `POST /v1/setup` | **no** | creates or recovers the account and mints a credential |
| `POST /v1/account/recovery` | **no** | explicit registration acknowledgement; a lost response is surfaced |
| `POST /v1/pairing` | **no** | mints a pairing and an enroll token |
| `POST /v1/pairing/{id}/claim` | **no** | mints a device credential |
| `GET /v1/pairing/{id}` | yes | read |
| `POST /v1/pairing/{id}/approve` | **no** | consumes the pairing |
| `POST /v1/pairing/{id}/reject` | **no** | destroys the pending device; refuses an approved pairing |
| `GET /v1/pairing/{id}/envelope` | **no** | single use; then `410 envelope_consumed` |
| `GET /v1/devices` | yes | read |
| `PATCH /v1/devices/{id}` | **no** | write |
| `POST /v1/devices/{id}/revoke` | **no** | write, and one-way |
| `POST /v1/devices/{id}/archive` | **no** | write; a second send leaves the same state and answers `204` |
| `POST /v1/devices/heartbeat` | **no** | write |
| `POST /v1/chunks/exists` | yes | a read; POST only because the sid list is long |
| `POST /v1/chunks/get` | yes | a read; same reason |
| `PUT /v1/chunks/{sid}` | yes | the sid IS the body's hash |
| `GET /v1/chunks/{sid}` | yes | read |
| `POST /v1/files/{id}/versions` | **no** | appends a version and moves the heads; may answer with an identical version's id |
| `GET /v1/files…`, `GET /v1/changes` | yes | reads |
| `POST /v1/dashboard/login-link` | **no** | mints a single-use token |

A client that loses the answer to a **no** row must not re-send it. The
outcome is unknown, not failed: the request may already have been applied.
Settle it by reading what the server holds — the file record for a version
post, the device list for a revoke or an archive — or tell the user, with the reason, that
it is unknown. The plugin's table is `ROUTES` in `plugin/src/transport.ts`
and a test asserts every route it emits appears there.

## Health

- `GET /livez` → `200 ok` while the process runs.
- `GET /readyz` → `200 {"ready":true}` when volumes are writable,
  the journal is replayed and its usage is verified, and no shutdown is in
  progress; else `503 not_ready`. A journal whose usage survey was refused is
  re-surveyed by this probe, so a fixed volume answers `200` again without any
  write.

## Setup and account

- `POST /v1/setup` (no device auth; the token is the credential)
  `{"setup_token":"…","account_name":"…","device":{"name":"…","platform":
  "…","app_version":"…"}}` → `201 {"account_id":"…","device_id":"<32hex>",
  "device_secret":"<64hex>"}`: creates the account and enrols the first
  device in one step, since pairing requires a paired device. Without recovery
  proof, `409 already_set_up` afterwards; `401 bad_setup_token` otherwise. The
  token is compared FIRST, so both refusals are reachable only in that
  order: a caller holding the token learns the account exists, and a caller
  without it learns nothing about whether the server is claimed.
- First setup may include `recovery_verifier:<64hex>`, committed in the same
  durable account frame. Existing accounts may be re-entered through the same
  `POST /v1/setup` with the setup token and `recovery_proof:<64hex>`; the response
  also has `recovered:true`. The proof is 32 bytes from
  `HKDF-SHA-256(VRK, salt=utf8("obsync/v1/account-recovery"), info="", L=32)`.
  The verifier is lowercase hex `SHA-256(proof)`. The server compares hashes
  in constant time, never receives VRK or a content decryption key, and returns
  `403 bad_recovery_proof` for a wrong proof. An account with no verifier
  answers `409 recovery_unavailable`, whatever the proof, unless the
  operator's offline `obsyncd recovery reset apply` has armed it since. That
  step rotates the setup token and arms exactly one re-enrolment: a
  `recovery_proof` then registers the verifier it derives (timed, so the
  last-device hold applies from then) and enrols. The server has nothing to
  check that proof against, so the authority is the offline reset and the new
  token only it hands out; the proof only chooses the verifier. The first
  verifier registered after the reset spends the arm, by this route or by a
  device's `POST /v1/account/recovery`, and a later recovery is proved against
  it. No device-authenticated request can clear a verifier or arm this.
  A valid recovery enrolls a new active device on the same account, without
  renaming it, replacing content or reviving revoked credentials. It is never
  auto-retried. A server before 1.1.5 answers `409 recovery_unavailable`
  instead of re-enrolling.
- `POST /v1/account/recovery` (device auth)
  `{"recovery_verifier":"<64hex>"}` → `204`. Register once after the client has
  successfully opened its vault. Repeating the same verifier is harmless;
  `409 recovery_mismatch` refuses replacement. Invalid shape is `400` before
  storage changes. The verifier survives journal replay and snapshots but is
  omitted from account responses. Old accounts without the field remain
  readable and retain their last-device safeguard. Since 1.1.5 the server
  also records when the verifier was registered, and nothing but the
  operator's offline `obsyncd recovery reset apply` removes a verifier; no
  route does.
- `GET /v1/account` (device auth) → `{"account_id","name","created",
  "quota_bytes","used_bytes","device_count"}`. `device_count` is how many
  devices can sync: the active ones and those still pairing. A revoked
  device, archived or not, stays a record and is not counted. A server
  before 1.1.5 counted every record, revoked ones included; the field kept
  its name because the one client that shows it prints "N device(s)", and
  the devices that can sync is what that sentence means. The dashboard's
  overview carries the same `account` object.

## Pairing

Since 1.1.3, a claim may include `vault: {"envelope":"<base64>","nonce":"<24hex>"}`.
It seals UTF-8 JSON `{"name":"<vault name>","notes":<Markdown note count>}` with
AES-256-GCM, a random 12-byte nonce, and the pairing ID as additional data.
The key is `HKDF(PS, "obsync/v1/pair-vault", pairing_id)` (32 bytes), distinct
from the vault-key envelope key. Names are 1–256 JavaScript string units with
no control or bidi formatting characters; counts are nonnegative safe integers.
The server accepts only a valid base64 envelope of at most 2048 characters
and at least 16 decoded bytes, plus a 24-character hexadecimal nonce. It
validates before enrolling, retains only those two fields in the in-memory
pairing, and returns them inside `claimant.vault` to the creator alone.
No clear vault name or note count reaches storage or logs. The approving device
must authenticate and validate present details before offering approval.
Absent details preserve pairing with older clients or servers; an old server
ignores the optional field, so its approval prompt cannot name the new vault.


- `POST /v1/pairing` (device auth) → `201 {"pairing_id":"<32hex>",
  "enroll_token":"<64hex>","expires":<unix_s>}`.
- `POST /v1/pairing/{id}/claim` (no device auth; body carries the token)
  `{"enroll_token":"…","name":"…","platform":"ios|ipados|android|macos|
  windows|linux","app_version":"…"}` → `201 {"device_id":"<32hex>",
  "device_secret":"<64hex>"}`. `404 unknown_pairing`, `410 pairing_expired`,
  `409 already_claimed`. The device is created in state `pending`: it holds a
  credential, but every device-authenticated route refuses it until it
  collects the envelope the creator approved. Since 1.1.4 an expired pairing
  still answers `410 pairing_expired` for an hour to a claim carrying its
  token (the server remembers at most 256), while any other token reads `404
  unknown_pairing`, as it would for a live pairing. Since 1.1.5 the claim may
  carry `claimant_pub` (the pairing v2 key exchange, below); the server
  validates its shape and returns it to the creator verbatim.
- `GET /v1/pairing/{id}` (device auth, creator only) → `{"state":"open|
  claimed|approved|consumed|expired","claimant":{"device_id","name",
  "platform","app_version","claimant_pub"?}|null}`. For the same hour after
  expiry the creator reads `expired` or, if the key was collected, `consumed`,
  with a `null` claimant.
- `POST /v1/pairing/{id}/approve` (device auth, creator only)
  `{"envelope":"<base64 AES-GCM ciphertext>","nonce":"<24hex>","creator_pub"?}`
  → `204`. Approval activates nothing by itself (1.1.4; earlier servers
  activated the claimant here). `creator_pub` is the pairing v2 key exchange
  (below), returned once with the envelope.
- `POST /v1/pairing/{id}/reject` (device auth, creator only) → `204`; the
  pending device and its wrapped secret are destroyed. Only a CLAIMED pairing
  is rejectable: an unclaimed one is `409 not_claimed` and one the creator
  already approved is `409 already_approved` and changes nothing, because the
  claimant is a paired device by then and deletion carries no last-active
  guard. A paired device is taken away with
  `POST /v1/devices/{id}/revoke`. Expiry of a pairing whose claimant never
  collected the envelope, approved or not, destroys them the same way, and
  so does a restart: pairings live in memory, so a claim that does not
  survive one leaves a device nobody can approve, and the start destroys it.
  The claimant pairs again.
- `GET /v1/pairing/{id}/envelope` (device auth, claimant only) →
  `409 not_approved` until the creator approves (the claimant polls this),
  then `{"envelope","nonce","creator_pub"?}` exactly once; `410
  envelope_consumed` afterwards, and `410 pairing_expired` once the ten
  minutes have passed. Collecting it moves the device to state `active`: the
  activation is journaled before the envelope is answered, and a refused
  journal write consumes nothing.

The approval prompt and the waiting claimant show the same six-digit match
code (1.1.4), which neither side sends: each computes
`HKDF(PS, "obsync/v1/pair-match", pairing_id + ":" + device_id)`, reads its
first four bytes as a big-endian integer modulo 1,000,000 and shows it as
`ddd ddd` -- the creator from the claimant id the pairing poll names, the
claimant from the id its claim returned. The server, which never holds `PS`,
cannot make two screens agree, and a second device claiming a leaked code
holds another id and shows another code. A 1.1.3 device shows no code and
ignores one; either side pairs as before.

### Pairing v2: the key exchange (plugin 1.1.5)

The code carries the pairing secret `PS`. In legacy pairing `PS` alone seals
the vault-key envelope, so the code must travel only over a channel the person
trusts. Pairing v2 adds an ephemeral P-256 ECDH exchange between the two
devices and seals the envelope under a key derived from BOTH the exchange AND
`PS`, so a copy of the code alone no longer opens the envelope.

- **Keys on the wire.** Each side generates an ephemeral P-256 key pair whose
  private key is non-extractable and never leaves the device. The public key
  crosses raw-uncompressed (65 bytes, `0x04` prefix) as base64url: the
  claimant's as `claimant_pub` in the claim, the creator's as `creator_pub` in
  the approve and returned once with the envelope. The server validates the
  shape (87 base64url characters decoding to 65 bytes beginning `0x04`), holds
  the two fields verbatim with the in-memory pairing, never logs them and does
  no elliptic-curve mathematics on them.
- **Seal.** `K = HKDF-SHA-256(ikm = ECDH(claimant, creator), salt = PS,
  info = "obsync/v2/pair" || pairing_id)`; the envelope is AES-256-GCM over
  `{"vrk":…}` with a random 12-byte nonce and additional data
  `pairing_id || claimant_pub || creator_pub` (the raw 65-byte keys), so it
  cannot be replayed into another pairing or opened against a substituted key.
- **Match code v2.** `HKDF(PS, "obsync/v2/pair-match", pairing_id + ":" +
  device_id + ":" + claimant_pub)`, six digits as before. The creator derives
  it from the key it RECEIVED, the claimant from the key it SENT, so a
  substituted OR stripped key makes the two screens differ -- the signal not to
  approve.
- **Capability signal.** A creator-minted `PS` reserves a fixed 16-bit marker
  in its first two bytes (112 bits stay random; v2's confidentiality rests on
  the ECDH exchange). The claimant reads the marker from the code it was handed
  OUT OF BAND, never from the network, so a stripped `claimant_pub` cannot
  silently downgrade the exchange: the claimant already knows the creator is v2
  and shows a v2 code the stripped path cannot reproduce. The marker does not
  change the code's length, so a 1.1.4 device decodes a v2 code unchanged and
  pairs the legacy way.
- **The server first.** A 1.1.4 server drops both key fields, which no
  device can tell from a key stripped on the way. So before `POST
  /v1/pairing` a 1.1.5 creator reads `GET /v1/plugin/manifest` and makes no
  code unless the `version` it reports is 1.1.5 or later (`major.minor.patch`,
  a pre-release counts); an older version, a malformed one, or none (`404
  plugin_unavailable`, a server without its plugin bundle) is refused with
  one sentence: update the obsync server to 1.1.5 or later, then pair. The
  version is unauthenticated, and that is safe here: a forged or stripped
  answer can only cause the refusal, never a weaker pairing, because the
  marker and the strip detection above are unchanged.
- **Skew between devices.** Two 1.1.5 devices pair v2. A 1.1.5 claimant
  handed a 1.1.4 creator's code (no marker) pairs the legacy way and warns
  that the other device runs an older obsync. A 1.1.4 claimant sends no
  `claimant_pub`, so a 1.1.5 creator seals the legacy way and warns the same.
  A 1.1.4 creator's fully random `PS` carries the marker with probability
  2^-16; that one pairing then shows mismatched codes and is retried with a
  fresh code.
- **Paired means kept.** Collection (`consumed`) proves only that the envelope
  left the server: a claimant that cannot open it, or whose person cancels,
  revokes itself. So the creator says "paired" only once the claimant's row in
  `GET /v1/devices` is `active` with `last_seen` after `last_sign_in` -- the
  sign-in is its first request after collection (reading the server's vault
  before it keeps the key), and the later `last_seen` is the heartbeat of the
  sync a kept key starts. A row that is revoked or gone reads "did not keep
  the vault key"; neither within ten minutes reads "not confirmed".

## Devices

The plugin's `syncFolders` selection is local-only and is not a field of
device policy, heartbeat, pairing or the domain map. It grants no API
permission and cannot be expanded by another device; all paired devices
retain the account-wide authority described below.

- `GET /v1/devices` → `{"devices":[{"device_id","name","platform",
  "app_version","created","last_seen","last_sign_in","last_edit",
  "address","country","policy":{"per_file_max_bytes","total_budget_bytes"},
  "state":"pending|active|revoked","revoked":false,"archived":false}]}`. Only
  `active` devices count for the last-device rule. `archived` (server 1.1.5)
  is a property of a REVOKED device and never a state of its own: an archived
  device is still listed, still `"revoked":true`, and still named, so a client
  that does not read the field shows exactly what it showed before. A client
  that does read it leaves those devices out of the lists a person manages.
- `PATCH /v1/devices/{id}` `{"name"?, "policy"?}` (self or any paired
  device) → `200` the device.
- `POST /v1/devices/{id}/revoke` → `204`. A device cannot revoke itself
  while it is the only active device unless account recovery is registered:
  `409 last_device` without it, and since 1.1.5 `409 recovery_too_new` while
  the verifier is younger than seven days, a constant. A verifier registered
  before 1.1.5 carries no time and counts as older.
- `POST /v1/devices/{id}/archive` (server 1.1.5) → `204`: a REVOKED device is
  taken off the device lists a person manages. Nothing is destroyed: the
  record still answers that device `403 device_revoked`, and still names the
  versions it wrote. `409 device_not_revoked` for an active or pending device
  (revoke it first), `409 own_device` for the asking device, `404
  unknown_device`; a second archive of the same device answers `204`. The
  flag is on the journal before the `204`, inside the `device_update` frame,
  so a server that predates it replays that frame as the no-op update it
  reads rather than refusing the journal. A server before 1.1.5 answers `404
  not_found` (no route).
- `POST /v1/devices/heartbeat` `{"app_version","policy"}` → `204`; updates
  `last_seen` and the reported policy. Sent on start and hourly.

## Chunks

- `POST /v1/chunks/exists` `{"sids":["<64hex>",…]}` (≤ 4096) → `{"missing":
  ["<64hex>",…]}`.
- `PUT /v1/chunks/{sid}` body = raw ciphertext, `Content-Length` required,
  ≤ 8 MiB + 16 bytes (8 MiB plaintext plus the AES-GCM tag); larger
  declarations receive `413 body_too_large` before body storage. The server hashes while streaming to a temp file and refuses
  with `422 sid_mismatch` if `SHA-256(body) ≠ sid`, `507 volume_full` below
  the watermark, `507 quota_exceeded` over the account quota, `503 slow_body`
  when the body arrives more slowly than the minimum rate below. Success `201`
  (new) or `200` (already present). Idempotent.
- `GET /v1/chunks/{sid}` → raw ciphertext with `Content-Length`; honors
  `Range` (single range) → `206`. `404 unknown_chunk`.
- `POST /v1/chunks/get` `{"sids":[…]}` (≤ 64) → `multipart/mixed`, one
  part per sid in request order, each with `X-Obsync-Sid` and
  `Content-Length`; a missing sid yields a zero-length part with
  `X-Obsync-Missing: 1`. The sum of stored ciphertext lengths must be
  ≤ 32 MiB, excluding multipart framing, or the response is `413 batch_too_large`.
  Clients budget by the ciphertext maximum: the plugin fetches at most three
  chunks of one file per batch, while ordinary upload concurrency remains four
  on desktop. From plugin 1.1.4 it also asks for the single chunks of up to 64
  notes of one feed page at once, within 32 MiB (8 MiB on a phone) counted by
  the lengths their records declare, and refuses a larger answer.
  Cuts request count over a proxied hop.

## Files and versions

- `POST /v1/files/{file_id}/versions`
  `{"version_id":"<64hex>","parents":["<64hex>",…],"sids":["<64hex>",…],
  "bytes":<n>,"domain_id":"<32hex>","manifest_ct":"<base64>",
  "manifest_nonce":"<24hex>","deleted":false,"accept_existing":false}` →
  `201 {"seq":<n>,"version_id":"<64hex>",
  "heads":["<64hex>",…],"conflicted":false}`. `version_id` in the answer is
  the version the store holds for this post: the posted id, except on the one
  case below. Rules: every sid must exist
  (`409 missing_chunks` with the list); `version_id` must equal the server's
  recomputation (`422 version_id_mismatch`); `domain_id` is required and
  must equal the file's own (`409 domain_mismatch`), which its first version
  fixed for life; `parents` equal to the current heads → sole head;
  otherwise the version is added as a head and `conflicted:true`. A file
  holds at most 64 heads, the same number of parents a version may declare,
  so a conflict is always resolvable by one merge naming every head; a
  version whose acceptance would leave a 65th is refused with `409
  too_many_heads` and nothing already stored changes. Posting an
  existing `version_id` is a `200` no-op.
- **One position, one version.** Two devices that resolve the same conflict
  to the same bytes post the same parents and the same chunks under two
  version ids, because the id covers the encrypted manifest and its nonce;
  the file forks and closing it costs another version. A post carrying
  `"accept_existing":true` whose `(file_id, parents as a set, sids in order,
  deleted)` equals a version the store already holds is answered `200` with
  THAT version's `seq` and `version_id`, and no frame is written. The same
  sids under other parents, or the same parents with other sids, is a new
  version as before, and so is a tombstone over an empty file. The field is
  the client's promise to store the `version_id` it is answered with: a
  client that keeps the id it computed omits it (as every 1.0.x client does)
  and is never answered with another id, because it would otherwise remember
  a version this server never stored. The decision is logged
  (`decision=deduplicated`). Plugin 1.1.3 relies on it for a fork whose heads
  do not merge: every device that settles the fork posts the same closing
  version and the same first version of one conflict copy, under a file id
  derived from the fork (`docs/architecture.md` 3.4.1), and the server keeps
  one of each. No server change.
- `GET /v1/files/{file_id}` → `{"file_id","domain_id","heads":[…],
  "conflicted","versions":[{"version_id","parents","sids","bytes",
  "manifest_ct","manifest_nonce","device_id","ts","deleted"}]}` newest
  first, capped at `OBSYNC_RETENTION_VERSIONS` plus every head, and at
  450 MiB of JSON ("Limits and headers"). The domain
  is stated once on the file, because every version of a file is in it.
- `GET /v1/files/{file_id}/versions/{version_id}` → one version record.
- `GET /v1/files?after=<file_id>&limit=<n>` → `{"files":[{"file_id",
  "domain_id","heads","conflicted","latest_ts"}],"next":"<file_id>|null"}`.
  Used for initial reconciliation, and by a device checking which of its
  versions a server rebuilt from a backup still holds (plugin 1.1.3,
  `docs/architecture.md` 6.2.4); the feed is the normal path.

A **tombstone** is a version with `"deleted":true` and no sids.

Since plugin 1.1.3, when a concurrent edit wins over a deletion, its live
settlement names both the locally held version and the tombstone as parents.
The deletion remains in version history but ceases to be a current head.
Only those observed versions are incorporated; an unseen concurrent live edit
remains a head for the ordinary merge rule. Identical settlements opt into
`accept_existing`, so two devices resolving the same position store one version.
A failed publication retains the local file and warns truthfully; a successful
settlement adds no deletion notice. Replaying the historical tombstone against
its live descendant changes nothing. This uses the existing version graph and
v1 manifest, so older servers accept it and older clients read the kept note
normally; they may still create a new unresolved deletion fork themselves.


A **retirement** (plugin 1.1.3) is a tombstone for a file id that duplicates
another id holding the same note at the same name. Its manifest adds
`"keeper":"<32hex>"`, the id that keeps the name. A receiver that still records
the retired id there, over a file whose bytes the keeper's live head holds,
records the name under the keeper and deletes nothing. A plugin before 1.1.3
ignores the field and applies an ordinary deletion. **No server change.**

### Folder records (plugin 1.1.0)

A folder is one more version on this same endpoint, with no chunks. The
server has no folder concept and needs none: `sids` is empty and `bytes` is
`0`, which it already accepts for a tombstone, and the manifest — which it
cannot read — says the rest. **No server change; a 1.0.x server serves this.**

Inside `manifest_ct`:

| Field | Value |
| --- | --- |
| `v` | `2` — a file manifest is `1` and is unchanged |
| `kind` | `"directory"` |
| `path` | the folder's canonical relative vault path |
| `domain` | the domain id, as a file manifest carries it |
| `size` | `0` |
| `chunks` | `[]` |
| `sha256` | `""` |
| `deleted` | `false` to create the folder, `true` to remove it |

There is no `mtime`: a folder has no content to be newer than, and leaving it
out is what makes the manifest two devices produce for one folder identical
(`docs/architecture.md` 3.4.1). With the file id derived from the path and the
nonce derived from the message, two devices publishing the same folder produce
the same `version_id`, so the second post is the `200` no-op this document
already specifies for a version the server holds.

That also makes a folder CREATED AGAIN where one was deleted -- a rename back
to an earlier spelling is one -- the folder's first version, which the server
holds and appends nothing for. So from plugin 1.1.4 a device that creates or
renames a folder here, and is answered with `heads` that do not include the
record it posted, posts it once more with those heads as its parents; every
device doing the same computes the same version. A device's start-up
publication of a folder it merely has no record for does not: a folder a
tombstone found occupied and kept is not brought back to the devices that
deleted it. A 1.1.3 device applies such a record as any other create.

**Whose folders a device publishes and receives records for.** A device that
syncs only some folders (`syncFolders`, local-only, above) publishes a folder
record for each SELECTED folder and for every folder inside it, and receives
the same. The selected folder itself is included because a folder record IS
its path: nothing else can carry that folder's own creation, removal or
rename. A folder ABOVE a selected one is never published, and a FILE record
keeps the stricter rule -- a selected folder is a directory, never a file
wearing that exact name.

A receiver additionally admits a folder record whose path differs from a
SELECTED folder by the capitalisation of its LAST component alone -- an
ancestor spelled differently is a folder it syncs in neither direction, and no
host could apply that difference anyway, because `rename(2)` resolves a
destination's directory components. That tolerance exists for one thing: a
rename of the folder this device selects, made elsewhere. It is admitted only
in the state that rename creates on the wire, and refused in every other:

> **The admission rule.** A folder record whose path differs from a selected
> folder by the capitalisation of its last component alone is admitted only
> when the tombstone for THAT folder's own record -- the record this device
> holds for it, by its file id -- has been applied, no record has been written
> for that folder since, and no folder record has already used that admission.
> The first record WRITTEN in that state takes it -- one the vault refuses, or
> one that fails and is retried, does not (plugin 1.1.4); anything else is
> refused as `decision=not_synced reason=outside_sync_scope`, with one notice
> naming both spellings.

The retirement is a STATE, not a clock. It lasts until a record is written for
that folder -- by the feed, by the re-case itself, or by this device's own
republication of that folder, which is what happens when the tombstone was a
DELETION that found the folder occupied and no rename follows it. That
republication waits until the feed has caught up past the tombstone (plugin
1.1.4): a start-up pass holds it, so a device stopped between the tombstone
and the rename's record still takes the rename when it starts. When the
tombstone REMOVED the directory, nothing republishes it and the retirement
stays armed but inert: a record it admits names a folder this vault no longer
holds, and the vault's answer refuses it. Inside the window one record one
capitalisation off that folder is admitted, and the vault's own answer still
decides what becomes of it. The rule grants a sender no authority it did not have: a device that
can publish a folder record can rename that folder in any case. What it takes
away is a SECOND device's folder being read as this device's rename.

The rule is what a string comparison cannot be: a device whose filesystem
KEEPS the two spellings apart can hold `Team docs` and `team docs` at once, and
its record for the second one is indistinguishable, as a string, from a rename
of the first. Asking the vault does not settle it either -- a receiver that
folds case holds one directory entry for both BY CONSTRUCTION, so it answers
"one entry" for a folder it has never heard of. What settles it is that a
rename retires the old name: both senders of a capitalisation-only rename
publish the old spelling's tombstone before the new record (below), and a
second folder carries no tombstone at all. Admitted, the record is applied by
asking the vault as before: where the two spellings are one directory entry the
record names that device's selected folder, the entry is re-cased and the
selection follows the new spelling; where they are two, the record names a
folder that device does not sync and is skipped in the same words.

**Publication order, for a rename that changes case alone.** A folder rename
publishes a tombstone for the old path, a record for the new one, and a move
per file beneath it. For an ordinary rename the moves go FIRST, so the old
folder is empty on the receiving device by the time its tombstone arrives. For
a rename that changes only capitalisation the FOLDER RECORD goes first, and
that order is load-bearing rather than cosmetic: on a host that folds case the
two spellings are one directory entry, `rename(2)` resolves the directory
components of a destination and renames only its last component, so no
per-file move can re-case a directory. The folder record is the only record
entitled to, and a receiver applies it by renaming the directory entry itself
and carrying every record beneath it along.

**First on the WIRE, not first in a queue.** A sender drains its queue in
batches and posts each batch concurrently, so a record enqueued first can
still be journaled after one enqueued behind it. For this record that is not
good enough, and the guarantee is therefore stated as an order on the wire:
the sender waits for the server to acknowledge the folder record before it
sends any move under it, and a post that FAILS keeps that hold rather than
losing it -- the publication is put back in front of the moves it orders and
attempted up to three times in all. The hold also survives the SENDER: a
publication that has not been acknowledged is written into the device's own
state with the fact that it orders what follows it, so a device stopped
mid-drain -- quit, reloaded, closed -- restores it at the head of its queue
before it reconciles anything and before any file work, and the moves queue
behind it again. Every other folder record the next start owes is re-derived
by that pass from the vault's own listing, which publishes them before it
queues any file work for the same reason. At that bound the hold expires with one
logged decision (`push path_class=folder decision=expired reason=folder_post
attempt=3 budget=3`) and one notice, the moves go out and are refused by a
folding receiver in the usual words, and the sender's next start-up pass
republishes the record. The queue never waits forever and never gives the
hold up silently. A receiver that meets a per-file move whose only
difference lies in a directory component -- the shape a device older than
1.1.0 publishes, which sends no folder record at all -- REFUSES it
(`decision=case_move_refused reason=folder_case`, one notice per folder) and
changes nothing, because recording a spelling its own listing contradicts is
what makes two devices trade the same rename forever.

**A rename nobody reported has the same order.** A folder re-capitalised
while Obsidian was closed is found by the start-up pass, which publishes the
same two records in the same order -- the old record's tombstone first, the
new record behind it as the same wire barrier, and any moves the pass
publishes for the notes underneath behind that. The reverse order is what a
receiver cannot survive for an EMPTY folder: it re-cases the directory from
the record and then meets the tombstone for the spelling it has just left,
whose removal resolves to the one directory entry that rename produced.
Receivers therefore also refuse to remove a directory whose vault spelling
differs from the record asking for it (`folder path_class=folder
decision=kept reason=vault_spelling`), which holds whatever order a sender on
an earlier build used.

**A refusal is not a loss, and it is not permanent.** A version refused while
the two devices spelled the folder differently is never re-delivered by the
feed, which advances past it. So when the folder record does arrive and the
directory is re-cased, the receiver asks the server for the head of every
record that re-case carried -- one `GET /v1/files/{id}` per record, bounded by
the folder -- and applies each one through the ordinary path. A note edited on
the other device while the two disagreed arrives then, rather than waiting for
whatever touches it next.

**What a receiver writes for a NEW file under such a folder.** A move is
refused; a file id the receiver has never seen is not a move, and it is
written. It lands in the directory the vault shows, because creating a
directory that is already there changes nothing, and it is RECORDED at the
spelling the vault shows rather than the one the manifest carries. A record
that disagreed with its own vault was published back as a rename the sender
never made, which a folding device answers with a conflict copy.

**`v` is the compatibility contract.** A device that does not know a `v`
refuses the manifest before reading any other field, writes nothing, and lets
the feed advance. Plugins 1.0.0 through 1.0.6 -- every shipped 1.0.x -- do
exactly that with `v: 2`, so a folder record can never be written as a file at
the folder's path there. `parseManifest` is byte-identical at all seven of
those tags (sha256 `8aa8a2df240bcd8ffba197fc9b2e238bb9b727ef0416007eb526a3082e8aa4de`
of the function at each), and the copy the tests run against is
`plugin/test/fixtures/decoder-1.0.x.mjs`, which says how to re-derive both.
Any later record type must move `v` again for the same reason.

### Rewrite pause controls (plugin 1.1.3)

A hold is a separate encrypted manifest with `v: 3`, `kind: "pause"`, a
canonical file `path`, its 16-byte lowercase-hex `target` file id, boolean
`paused`, the engine's `domain`, and the constant fields `size: 0`,
`chunks: []`, `sha256: ""`, `deleted: false`. Its opaque file id is the first
16 bytes of `HMAC-SHA256(manifest_key, UTF8("obsync/v1/pause/" + target))`.
The receiver checks that binding and the ordinary domain/size/chunk/deletion
bindings before acting. Nothing about a hold travels in clear text.

A note manifest can additionally carry `answer: true`: its author observed a
background write within five seconds of a received version without recent
trusted Markdown editor input (including an active IME composition). Merely
showing the note in a passive editor does not exempt the write. This advisory signal permits detection of sequential
rewrites as well as overlapping ones. It grants no additional authority.
An overlapping answer can be detected first by the device whose editor has
recent trusted input. It uses the same control, holding before the ordinary
conflict-copy rule can replace its saved text. A recipient with current
background-answer proof for that exact target retains its background Resume
role. These are local decisions; they add no manifest field or server API.

A pause control holds the target only if the control version is still a head;
an old pause replayed after Resume is ignored. Local pause state survives a
restart. Clearing the control does not resume another device automatically:
each held device explicitly resumes after its user stops the rewriting
plugin. Each publication parents every observed control head. Identical
controls are reused without another post. Opposite controls at one position
must never be deduplicated as the same operation: their `v`, `kind`, `target`
and `paused` fields participate in the client's adoption check. Concurrent
opposite posts can leave two heads; the current pause holds, and the next
explicit Resume parents both, leaving one cleared head. No polling loop
publishes new control versions. The existing server API needs no change.

Plugins before 1.1.3 reject `v: 3` as an unknown manifest version and advance
the feed. Because the control has its own file id, rejection cannot overwrite,
delete or replace the actual note or its history. Mixed versions keep syncing
ordinary notes, but all devices must update for a shared hold to stop the
rewrite storm. The unchanged 1.1.1 client is exercised by
`plugin/test/legacy-pause-check.mjs` against a control followed by a normal
note; the receipt records refusal, application and an advanced feed cursor.

## Change feed

- `GET /v1/changes?since=<seq>&wait=<seconds ≤ 55>&limit=<n ≤ 1000>` →
  `{"seq":<last_included>,"head_seq":<journal_head>,"changes":[{"seq",
  "file_id","domain_id","version_id","parents","sids","bytes","manifest_ct",
  "manifest_nonce","device_id","ts","deleted","heads","conflicted"}]}`. A
  feed entry arrives without its file, so it carries its own `domain_id`.
  With `wait`, the server holds the request until a new version lands or the
  wait elapses, then returns whatever exists (possibly an empty list).
  An empty page whose `seq` is above `since` is normal, and the client
  continues from that `seq`: frames the feed does not carry (devices,
  sign-ins, background work) move the head without waking a held request, so
  a poll that starts behind the head answers at once with it.
  `since` beyond `head_seq` → `416 seq_ahead`.

## Domains

A domain is the key-scoping unit (`docs/architecture.md` 3.1 and 5.1). It has
no endpoints: a domain exists because a file record names it, and which
PATHS it covers is owner-only metadata the server never sees. That metadata
is one encrypted object under a reserved file id, written and read through
the version endpoints above like any other file; the server cannot tell it
from a note, and there is no request on this API that hands the server a
content key.

## Dashboard (admin) API

Cookie session; every mutating call carries `X-Obsync-Csrf` equal to the
`__Host-obsync_csrf` cookie.

The two cookies are `__Host-obsync_session` (`HttpOnly`) and
`__Host-obsync_csrf` (readable by the page's own script), both `Secure`,
`Path=/`, `SameSite=Strict`, with no `Domain`. The `__Host-` prefix makes
the browser enforce that set, so the dashboard must be reached at an origin
the browser treats as secure: an `https` address in any browser, or plain
`http` to `localhost`/`127.0.0.1` in Chrome and Firefox but not Safari, which
sends no `Secure` cookie to a plaintext origin. Plain HTTP to any other IP
address or LAN name is not a supported way to reach the dashboard
(`docs/security/dashboard.md`). A session ends after 12 hours, after 1 hour
with no request on it, on sign-out, on sign-out-everywhere, or when the
device whose link opened it is revoked.

- `POST /v1/dashboard/login-link` (device auth) → `{"url":"…/login?
  token=…","expires"}`; single use, 5 minutes. The link remembers the device
  that minted it.
- `GET /login?token=…` → sets the session cookies, redirects to `/`. Spends
  a link, or accepts the standing setup token as the recovery sign-in.
  `401 bad_login_token`. There is deliberately no attempt limit in front of
  the constant-time compare: one keyed by request source would refuse every
  visitor at once behind a proxy this deployment does not trust
  (`docs/security/dashboard.md`).
- `POST /v1/admin/logout` → `204`.
- `POST /v1/admin/logout-all` → `204`: closes EVERY dashboard session,
  including the one that asked, and drops every login link that has been
  minted and not yet spent. An unspent link is the same key to the same
  dashboard, so leaving one alive would hand back what the button took away.
  Its log line carries both counts.
- `GET /v1/admin/overview` → `{"account":{…as GET /v1/account},
  "edge":"none|cloudflare","public_url":"…"|null,"volumes":[<volume>…],
  "versions":{"total":<n>,"files":<n>},"activity":{"versions_per_hour":
  [{"hour":<unix_s>,"count":<n>}]} (24 entries, oldest first),
  "last_gc":<gc>|null,"last_scrub":<scrub>|null,
  "session":{"recovery":<bool>}}` (`recovery` is true when this session was
  opened with the setup token rather than a device's link) where
  `<volume>` =
  `{"role":"blobs|journal|mirror","path_class":"<StorageClass label or
  'host'>","bytes_total","bytes_used","bytes_free","watermark_bytes",
  "usage_unverified":<bool>}` (`usage_unverified` is true when `bytes_used`
  is the last figure read successfully rather than a current one; writes are
  being refused with `journal_unverified` while it is),
  `<gc>` = `{"ts","duration_ms","chunks_collected","bytes_collected",
  "chunks_retained"}`, `<scrub>` = `{"ts","duration_ms","chunks_verified",
  "bytes_verified","mismatches","quarantined":<count>,"complete_pass"}`.
- `GET /v1/admin/devices` → as `/v1/devices` plus `history:[{"ts","event":
  "sign_in|edit|heartbeat","address","country"}]` bounded by retention.
- `POST /v1/admin/devices/{id}/revoke` → `204`; `409 last_device` when the
  target is the only ACTIVE device and account recovery is unregistered, and
  `409 recovery_too_new` when it is registered and younger than seven days. Revocation also closes the dashboard
  sessions that device's links opened and drops the links it minted.
- `POST /v1/admin/devices/{id}/archive` → `204`; as `POST
  /v1/devices/{id}/archive`: a revoked device only (`409
  device_not_revoked`), `404 unknown_device`.
- `GET /v1/admin/storage` → `{"volumes":[<volume>…],"retention":{"days",
  "versions"},"watermark":{"spec":"5%,2GiB"},"gc":{"state":"idle|running",
  "last":<gc>|null},"scrub":{"state":"idle|running","rate_bytes_per_sec",
  "last":<scrub>|null},"quarantine":[{"sid","ts","bytes","reason"}]}`.
- `POST /v1/admin/gc/run`, `POST /v1/admin/scrub/run` → `202`.
- `GET /v1/admin/logs?device=<id prefix>&limit=<n ≤ 500>` → `{"lines":
  [{"ts","method","path_class","device":"<id>"|null,"status","bytes",
  "duration_ms","decision"}]}` newest first: the pinned request log line
  as JSON.

## Plugin distribution

- `GET /v1/plugin/manifest` → the plugin's `manifest.json` plus
  `{"bundle_sha256":"<64hex>","styles_sha256":"<64hex>"}`.
  This version metadata is unauthenticated.
- The retired `GET /v1/plugin/bundle` and `GET /v1/plugin/styles` routes
  return `404 not_found`. Native installation and updates use Obsidian's
  Community Plugins browser and the matching GitHub Release. Packaged native
  files and their ZIP remain build/release inputs; v2 release evidence binds
  their bytes. The plugin never fetches executable code from its server. The
  native installer does not document verification of this project's evidence.

## Limits and headers

- Request headers ≤ 16 KiB; JSON bodies ≤ 4 MiB, and the setup and
  pairing-claim bodies, which carry their token, ≤ 16 KiB; chunk ciphertext
  bodies ≤ 8 MiB + 16 bytes.
- Every JSON body is read before its credential verifies (a signature covers
  the body's hash; the setup and enrolment tokens ride inside it), so every
  such body holds a share of one 64 MiB reservation across every connection
  from before its first byte is read until its credential verifies, any wait
  for a lock included. A setup or claim body is parsed before its token
  verifies, so each reserves 4 MiB: the body and everything parsing 16 KiB
  can allocate (at most about 72 bytes a byte). A body that does not fit is
  answered with a bare `503` (no
  body, `Retry-After: 1`, `Connection: close`) before a byte of it is read,
  and a repeatable request retries.
- Heads per file record ≤ 64; versions per file record ≤
  `OBSYNC_RETENTION_VERSIONS` plus one per head; sids per version ≤ 65,536;
  parents per version ≤ 64; `manifest_ct` ≤ 1 MiB of base64.
- Response bound, enforced by `render`'s own test against the ceilings
  above: a full head list is under 8 KiB, so a 1000-entry `/v1/changes` page
  carries at most 64,000 head ids. The widest single version and the widest
  change entry are each under 6 MiB. One file record never passes 450 MiB:
  every head is in it (64 of the widest versions fit), and the other
  versions follow newest first until the next would pass it, so a long
  retention leaves older versions out of the record rather than growing it
  past what a client accepts. At the shipped retention of 10 nothing is left
  out; when something is, the server logs `event=file_record
  decision=trimmed`. A `/v1/changes` page also stops before its
  entries pass 8 MiB of JSON and always carries at least one, so no page
  passes 8 MiB; its `seq` is then below `head_seq`, and the next request from
  that cursor carries on. A client that wants a smaller page sets `limit`.
- Idle connection timeout 60 s (long-poll requests excepted up to their
  `wait`); header read timeout 10 s; body read minimum rate 16 KiB/s, measured
  from the server's first read of the body, so time the server spends before it
  (authentication waiting on a slow volume) is never charged to the sender. A
  body slower than that, on any route, is `503 slow_body`: the sender's link,
  not the server's storage, and a client retries it. A body that ends or breaks before
  it is whole is `503 body_incomplete`, retried the same way, and a chunked body
  whose framing is not HTTP is `400 bad_request`; `413 body_too_large` is only
  ever a body past its ceiling.
- Every response carries `Cache-Control: no-store` and the security headers
  listed in `AGENTS.md`. `X-Obsync-Seq` (journal head) rides only a response
  to a caller that proved a credential: it is write activity, and an
  unauthenticated caller polling it could reconstruct when the owner writes
  (`docs/security/dashboard.md`). "Proved" is a fact the server records where
  a credential VERIFIES -- a device signature, a dashboard session, a login
  or setup token -- never an inference from the route or the status. Every
  route that requires a credential authenticates before it validates
  anything, so a caller holding no credential is told nothing a refusal has
  to tell it: a missing, malformed, stale, replayed or unverifiable
  credential -- an unknown device id included -- is `401`, and a request that
  reaches an edge-fronted deployment without the edge's headers is `421
  edge_required`. One refusal is answered before verification, the `403
  device_revoked` above, and it is not an exception to this: revocation
  destroys the wrapped secret, so there is nothing left to verify the
  signature against, the refusal repeats only the device the caller itself
  named, and the server classes it as what it is -- answered without proof.
- Every request logs one line: `ts method path_class device status bytes
  duration_ms decision`.
