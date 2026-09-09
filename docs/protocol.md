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
(the volume would not take that record), `403 device_revoked`, `403
device_pending` (a claimed device that the creator has not yet approved;
only that pairing's envelope endpoint answers it, with `409 not_approved`).
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
| `POST /v1/pairing/{id}/reject` | **no** | destroys the pending device |
| `GET /v1/pairing/{id}/envelope` | **no** | single use; then `410 envelope_consumed` |
| `GET /v1/devices` | yes | read |
| `PATCH /v1/devices/{id}` | **no** | write |
| `POST /v1/devices/{id}/revoke` | **no** | write, and one-way |
| `POST /v1/devices/heartbeat` | **no** | write |
| `POST /v1/chunks/exists` | yes | a read; POST only because the sid list is long |
| `POST /v1/chunks/get` | yes | a read; same reason |
| `PUT /v1/chunks/{sid}` | yes | the sid IS the body's hash |
| `GET /v1/chunks/{sid}` | yes | read |
| `POST /v1/files/{id}/versions` | **no** | appends a version and moves the heads |
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
  `409 already_set_up` afterwards; `401 bad_setup_token` otherwise.
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
  pending device and its wrapped secret are destroyed. Expiry of an
  unapproved pairing destroys them the same way, and so does a restart:
  pairings live in memory, so a claim that does not survive one leaves a
  device nobody can approve, and the start destroys it. The claimant pairs
  again.
- `GET /v1/pairing/{id}/envelope` (device auth, claimant only) →
  `409 not_approved` until the creator approves (the claimant polls this),
  then `{"envelope","nonce"}` exactly once; `410 envelope_consumed`
  afterwards. Approval moves the device to state `active`.

## Devices

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
  ≤ 8 MiB. The server hashes while streaming to a temp file and refuses
  with `422 sid_mismatch` if `SHA-256(body) ≠ sid`, `507 volume_full` below
  the watermark, `507 quota_exceeded` over the account quota. Success `201`
  (new) or `200` (already present). Idempotent.
- `GET /v1/chunks/{sid}` → raw ciphertext with `Content-Length`; honors
  `Range` (single range) → `206`. `404 unknown_chunk`.
- `POST /v1/chunks/get` `{"sids":[…]}` (≤ 64) → `multipart/mixed`, one
  part per sid in request order, each with `X-Obsync-Sid` and
  `Content-Length`; a missing sid yields a zero-length part with
  `X-Obsync-Missing: 1`. Cuts request count over a proxied hop.

## Files and versions

- `POST /v1/files/{file_id}/versions`
  `{"version_id":"<64hex>","parents":["<64hex>",…],"sids":["<64hex>",…],
  "bytes":<n>,"domain_id":"<32hex>","manifest_ct":"<base64>",
  "manifest_nonce":"<24hex>","deleted":false}` → `201 {"seq":<n>,
  "heads":["<64hex>",…],"conflicted":false}`. Rules: every sid must exist
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
`obsync_csrf` cookie.

- `POST /v1/dashboard/login-link` (device auth) → `{"url":"…/login?
  token=…","expires"}`; single use, 5 minutes.
- `GET /login?token=…` → sets the session cookie, redirects to `/`.
- `POST /v1/admin/logout` → `204`.
- `GET /v1/admin/overview` → `{"account":{…as GET /v1/account},
  "edge":"none|cloudflare","public_url":"…"|null,"volumes":[<volume>…],
  "versions":{"total":<n>,"files":<n>},"activity":{"versions_per_hour":
  [{"hour":<unix_s>,"count":<n>}]} (24 entries, oldest first),
  "last_gc":<gc>|null,"last_scrub":<scrub>|null}` where `<volume>` =
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
- `POST /v1/admin/devices/{id}/revoke` → `204`.
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
- `GET /v1/plugin/bundle` → `main.js`; `GET /v1/plugin/styles` →
  `styles.css`. Unauthenticated: the bundle is public source. These are a
  convenience copy for the Install page; the trusted source of plugin code
  is the GitHub Release whose evidence manifest carries the bundle's
  SHA-256. The plugin never fetches code from this endpoint.

## Limits and headers

- Request headers ≤ 16 KiB; JSON bodies ≤ 4 MiB; chunk bodies ≤ 8 MiB.
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
- Every response carries `X-Obsync-Seq` (journal head), `Cache-Control:
  no-store`, and the security headers listed in `AGENTS.md`.
- Every request logs one line: `ts method path_class device status bytes
  duration_ms decision`.
