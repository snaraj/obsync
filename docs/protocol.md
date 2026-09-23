# obsync wire protocol v1

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
forgetting a nonce still inside its window), `503 nonce_log_unavailable`
(the volume would not take that record), `403 device_revoked` (answered from the device
record before the signature is checked, because revocation destroys the
wrapped secret and leaves nothing to check it against), `403 device_pending`
(a claimed device that the creator has not yet approved, answered only AFTER
its signature verifies; only that pairing's envelope endpoint admits it, with
`409 not_approved`).
Pairing claim and envelope fetch are the only device endpoints with their own
rules (below). Admin endpoints use the dashboard session cookie plus
`X-Obsync-Csrf`.

In `OBSYNC_EDGE=cloudflare` mode every request must also carry the edge's
connecting-address and request-id headers or it is refused with `421
edge_required`.

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
| `POST /v1/setup` | **no** | creates the account and mints a credential |
| `POST /v1/pairing` | **no** | mints a pairing and an enroll token |
| `POST /v1/pairing/{id}/claim` | **no** | mints a device credential |
| `GET /v1/pairing/{id}` | yes | read |
| `POST /v1/pairing/{id}/approve` | **no** | consumes the pairing |
| `POST /v1/pairing/{id}/reject` | **no** | destroys the pending device; refuses an approved pairing |
| `GET /v1/pairing/{id}/envelope` | **no** | single use; then `410 envelope_consumed` |
| `GET /v1/devices` | yes | read |
| `PATCH /v1/devices/{id}` | **no** | write |
| `POST /v1/devices/{id}/revoke` | **no** | write, and one-way |
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
post, the device list for a revoke — or tell the user, with the reason, that
it is unknown. The plugin's table is `ROUTES` in `plugin/src/transport.ts`
and a test asserts every route it emits appears there.

## Health

- `GET /livez` → `200 ok` while the process runs.
- `GET /readyz` → `200 {"ready":true,"seq":<n>}` when volumes are writable,
  the journal is replayed and its usage is verified, and no shutdown is in
  progress; else `503 not_ready`. A journal whose usage survey was refused is
  re-surveyed by this probe, so a fixed volume answers `200` again without any
  write.

## Setup and account

- `POST /v1/setup` (no device auth; the token is the credential)
  `{"setup_token":"…","account_name":"…","device":{"name":"…","platform":
  "…","app_version":"…"}}` → `201 {"account_id":"…","device_id":"<32hex>",
  "device_secret":"<64hex>"}`: creates the account and enrols the first
  device in one step, since pairing requires a paired device. Valid once;
  `409 already_set_up` afterwards; `401 bad_setup_token` otherwise. The
  token is compared FIRST, so both refusals are reachable only in that
  order: a caller holding the token learns the account exists, and a caller
  without it learns nothing about whether the server is claimed.
- `GET /v1/account` (device auth) → `{"account_id","name","created",
  "quota_bytes","used_bytes","device_count"}`.

## Pairing

- `POST /v1/pairing` (device auth) → `201 {"pairing_id":"<32hex>",
  "enroll_token":"<64hex>","expires":<unix_s>}`.
- `POST /v1/pairing/{id}/claim` (no device auth; body carries the token)
  `{"enroll_token":"…","name":"…","platform":"ios|ipados|android|macos|
  windows|linux","app_version":"…"}` → `201 {"device_id":"<32hex>",
  "device_secret":"<64hex>"}`. `404 unknown_pairing`, `410 pairing_expired`,
  `409 already_claimed`. The device is created in state `pending`: it holds a
  credential, but every device-authenticated route refuses it until the
  creator approves.
- `GET /v1/pairing/{id}` (device auth, creator only) → `{"state":"open|
  claimed|approved|consumed|expired","claimant":{"device_id","name",
  "platform","app_version"}|null}`.
- `POST /v1/pairing/{id}/approve` (device auth, creator only)
  `{"envelope":"<base64 AES-GCM ciphertext>","nonce":"<24hex>"}` → `204`.
- `POST /v1/pairing/{id}/reject` (device auth, creator only) → `204`; the
  pending device and its wrapped secret are destroyed. Only a CLAIMED pairing
  is rejectable: an unclaimed one is `409 not_claimed` and one the creator
  already approved is `409 already_approved` and changes nothing, because the
  claimant is a paired device by then and deletion carries no last-active
  guard. A paired device is taken away with
  `POST /v1/devices/{id}/revoke`. Expiry of an
  unapproved pairing destroys them the same way, and so does a restart:
  pairings live in memory, so a claim that does not survive one leaves a
  device nobody can approve, and the start destroys it. The claimant pairs
  again.
- `GET /v1/pairing/{id}/envelope` (device auth, claimant only) →
  `409 not_approved` until the creator approves (the claimant polls this),
  then `{"envelope","nonce"}` exactly once; `410 envelope_consumed`
  afterwards. Approval moves the device to state `active`.

## Devices

The plugin's `syncFolders` selection is local-only and is not a field of
device policy, heartbeat, pairing or the domain map. It grants no API
permission and cannot be expanded by another device; all paired devices
retain the account-wide authority described below.

- `GET /v1/devices` → `{"devices":[{"device_id","name","platform",
  "app_version","created","last_seen","last_sign_in","last_edit",
  "address","country","policy":{"per_file_max_bytes","total_budget_bytes"},
  "state":"pending|active|revoked","revoked":false}]}`. Only `active`
  devices count for the last-device rule.
- `PATCH /v1/devices/{id}` `{"name"?, "policy"?}` (self or any paired
  device) → `200` the device.
- `POST /v1/devices/{id}/revoke` → `204`. A device cannot revoke itself
  while it is the only device.
- `POST /v1/devices/heartbeat` `{"app_version","policy"}` → `204`; updates
  `last_seen` and the reported policy. Sent on start and hourly.

## Chunks

- `POST /v1/chunks/exists` `{"sids":["<64hex>",…]}` (≤ 4096) → `{"missing":
  ["<64hex>",…]}`.
- `PUT /v1/chunks/{sid}` body = raw ciphertext, `Content-Length` required,
  ≤ 8 MiB + 16 bytes (8 MiB plaintext plus the AES-GCM tag); larger
  declarations receive `413 body_too_large` before body storage. The server hashes while streaming to a temp file and refuses
  with `422 sid_mismatch` if `SHA-256(body) ≠ sid`, `507 volume_full` below
  the watermark, `507 quota_exceeded` over the account quota. Success `201`
  (new) or `200` (already present). Idempotent.
- `GET /v1/chunks/{sid}` → raw ciphertext with `Content-Length`; honors
  `Range` (single range) → `206`. `404 unknown_chunk`.
- `POST /v1/chunks/get` `{"sids":[…]}` (≤ 64) → `multipart/mixed`, one
  part per sid in request order, each with `X-Obsync-Sid` and
  `Content-Length`; a missing sid yields a zero-length part with
  `X-Obsync-Missing: 1`. The sum of stored ciphertext lengths must be
  ≤ 32 MiB, excluding multipart framing, or the response is `413 batch_too_large`.
  Clients budget by the ciphertext maximum: the plugin fetches at most three
  chunks per batch, while ordinary upload concurrency remains four on desktop.
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
  (`decision=deduplicated`).
- `GET /v1/files/{file_id}` → `{"file_id","domain_id","heads":[…],
  "conflicted","versions":[{"version_id","parents","sids","bytes",
  "manifest_ct","manifest_nonce","device_id","ts","deleted"}]}` newest
  first, capped at `OBSYNC_RETENTION_VERSIONS` plus every head. The domain
  is stated once on the file, because every version of a file is in it.
- `GET /v1/files/{file_id}/versions/{version_id}` → one version record.
- `GET /v1/files?after=<file_id>&limit=<n>` → `{"files":[{"file_id",
  "domain_id","heads","conflicted","latest_ts"}],"next":"<file_id>|null"}`.
  Used for initial reconciliation; the feed is the normal path.

A **tombstone** is a version with `"deleted":true` and no sids.

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
> The first record to arrive in that state takes it; anything else is refused
> as `decision=not_synced reason=outside_sync_scope`, with one notice naming
> both spellings.

The retirement is a STATE, not a clock. It lasts until a record is written for
that folder -- by the feed, by the re-case itself, or by this device's own
republication of that folder at its next start-up pass, which is what happens
when the tombstone was a DELETION and no rename follows it -- or until a
folder record takes it. Inside that window one record one capitalisation off
that folder is admitted, and the vault's own answer still decides what becomes
of it. The rule grants a sender no authority it did not have: a device that
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

## Change feed

- `GET /v1/changes?since=<seq>&wait=<seconds ≤ 55>&limit=<n ≤ 1000>` →
  `{"seq":<last_included>,"head_seq":<journal_head>,"changes":[{"seq",
  "file_id","domain_id","version_id","parents","sids","bytes","manifest_ct",
  "manifest_nonce","device_id","ts","deleted","heads","conflicted"}]}`. A
  feed entry arrives without its file, so it carries its own `domain_id`.
  With `wait`, the server holds the request until a new frame lands or the
  wait elapses, then returns whatever exists (possibly an empty list).
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
  target is the only ACTIVE device. Revocation also closes the dashboard
  sessions that device's links opened and drops the links it minted.
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

- Request headers ≤ 16 KiB; JSON bodies ≤ 4 MiB; chunk ciphertext
  bodies ≤ 8 MiB + 16 bytes.
- Heads per file record ≤ 64; versions per file record ≤
  `OBSYNC_RETENTION_VERSIONS` plus one per head; sids per version ≤ 65,536;
  parents per version ≤ 64; `manifest_ct` ≤ 1 MiB of base64.
- Response bound, enforced by `render`'s own test against the ceilings
  above: a full head list is under 8 KiB, so a 1000-entry `/v1/changes` page
  carries at most 64,000 head ids. The widest single version and the widest
  change entry are each under 6 MiB, so one file record stays under 450 MiB
  at the shipped retention of 10 and one full page under 6 GiB. The
  per-version ceilings, not the heads, are what set those two; a client that
  wants a smaller page sets `limit`.
- Idle connection timeout 60 s (long-poll requests excepted up to their
  `wait`); header read timeout 10 s; body read minimum rate 64 KiB/s.
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
