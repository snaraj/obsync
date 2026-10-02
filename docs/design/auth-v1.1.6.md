# Management authentication: state and bootstrap design

Status: proposed implementation contract, 2026-10-02. No implementation or live
security claim. [#256](https://github.com/snaraj/obsync/issues/256), following the
[CLI/MCP design](cli-mcp-v1.1.6.md) and its
[security contract](../security/cli-mcp-v1.1.6.md). Independently review this model
before code depends on it. The source baseline is released 1.1.5,
`03d108505d3993bddff276d70c814a6547222339`.

## 1. Scope and existing contracts

PR-3b adds management principals, browser enrollment, one level of workload
delegation, login/status/logout, exact credential custody and durable grant
audit. Existing-account browser enrollment is V03. Native first-account
integration is V06 in PR-4a; its ordering and authority are specified here.
Device policy/revoke commands follow in PR-4b. Storage, deployment, backup,
restore, remote MCP, note APIs and content-key access remain out of scope.

| Shipped source | Contract to preserve |
| --- | --- |
| `api/auth.rs`, `api/nonce_log.rs` | HMAC-SHA256, constant-time comparison, ±300-second timestamp window, 600-second durable nonce memory; no response before nonce fsync; bounded admission and explicit fault/full refusals |
| `api/unverified.rs` | Unverified bodies remain under the shared 64 MiB reservation through parsing and credential verification; token bodies are at most 16 KiB and reserve their parser footprint |
| `api/admin.rs` | Secure `__Host-` session/CSRF cookies; header, cookie and session CSRF agreement; 12-hour absolute/1-hour idle expiry; sessions and login links are memory-only |
| `api/setup.rs`, `storage/mod.rs` | Native setup owns the vault key. Account/recovery registration and device enrollment are separate durable transitions; a lost response cannot be assumed to have done nothing |
| `storage/mod.rs`, `storage/journal.rs`, `storage/index.rs` | Writers validate under journal/index locks, release the index during append/fsync, then apply durable records to the index; replay uses the same application path |
| `docs/security/dashboard.md` | Existing token-bearing login URLs may enter app logs/history. The bounded request log is not durable audit. Neither supplies the new management ceremony |

All code paths below retain TLS, replay protection, integrity, storage admission,
fsync and the blind-server boundary. No management credential is a device secret,
dashboard cookie, setup token, vault key or recovery proof.

## 2. Identities, bounds and stored state

A management principal is a separate typed identity. The server generates its
128-bit random grant ID (32 lowercase hex characters) at approval; clients cannot select or reuse that ID, and
device authentication never accepts it. Each grant binds one canonical HTTPS
origin, one server instance, a closed scope set, resource bounds, creation and
expiry times, approving provenance and a revision. The server enforces these
fields; CLI/MCP filtering is presentation only.

Use the existing server key to derive a stable nonsecret instance fingerprint:
HMAC-SHA256 with the distinct literal domain `obsync/management/v1/instance`,
encoded as 64 lowercase hex characters.
This adds no content-key access or new primitive. A copied server key also copies
that identity: this is instance continuity, not protection against a cloned host.
Changed key/origin requires explicit context enrollment; never silently retarget.
Management enrollment requires a configured canonical HTTPS `OBSYNC_PUBLIC_URL`;
missing or invalid configuration leaves it unavailable, without changing config.
Stored and signed origins use the ASCII HTTPS origin serialization from the
[URL Standard](https://url.spec.whatwg.org/#concept-url-origin):
`https://host[:port]`, with lowercase host, no trailing slash and no port for
443. Accept DNS ASCII labels (international names must already use their
`xn--` form), canonical dotted-decimal IPv4 or canonical bracketed IPv6.
DNS labels must be nonempty, at most 63 bytes, and contain only letters,
digits and internal hyphens; the hostname is at most 253 bytes. Ports are
decimal 1–65535 with no leading zero. No userinfo, whitespace/control byte,
backslash, percent escape, zone ID, trailing DNS dot, query, fragment or path
beyond one optional `/` is admitted.

At the input boundary only host lettercase, explicit `:443` and that one `/`
may normalize. After those three changes, input must equal the serialized
origin byte for byte; do not accept alternate numeric IP spellings or other
parser repairs. Already stored/signed fields must be canonical. The CLI and
server use the same vectors before enrollment is enabled: `https://EXAMPLE.com:443/`
becomes `https://example.com`; `https://example.com:8443` and `https://[::1]`
stay unchanged; `https://127.1`, `https://example.com.`, a zero-padded port,
expanded IPv6, userinfo and escaped host characters refuse. This freezes the
wire representation without requiring the server to implement a general URL parser.

The client generates a fresh 128-bit request ID (32 lowercase hex characters)
and 32-byte management secret with the
runtime CSPRNG and protects both **before** requesting enrollment. At approval,
the server wraps the secret using the existing HKDF/XOR custody construction,
with the separate salt
`obsync/management/v1/wrap` and grant ID as info. Never reuse the device wrapping
domain. The grant is not accepted until independently approved. Approval returns
metadata; there is no one-time secret response to lose.

| Object | Required contents and lifetime |
| --- | --- |
| Pending enrollment | Client request ID, candidate secret in process memory, closed request descriptor and its digest, five-minute absolute deadline; bounded in memory, cancelled by restart unless approval already committed |
| Grant | Server-generated ID, client request ID, wrapped secret, instance/origin, scopes/resource bounds, expiry, root provenance, optional parent grant, revision and active/revoked state; durable journal and snapshot state |
| Grant operation | Exact plan ID/digest, principal, targets, expected revisions, absolute deadline, committed result and audit facts; a lost response is reconciled by this record |
| Client entry | Exact context, request ID, protected secret reference, immutable request descriptor/deadline, approved grant ID and pending/active state; no plugin state or unrelated credential lookup |

Freeze admission constants before implementation: 32 pending enrollments, 128
live grants, one child level, 16 KiB enrollment/mutation bodies, one-hour default
grant lifetime, 24-hour maximum and five-minute approval/operation plans. Children
expire no later than their parent.
These are upper bounds, not optional security settings. An explicitly enrolled
service grant has recovery-session provenance and no device parent; it still
expires within 24 hours and has no silent renewal.

Initial delegation serves one actual workflow: a separately scoped metadata
reader for an unattended CLI/MCP process. A child cannot hold `grants:manage` or
create grandchildren. Parent bounds are the ceiling, not the child's default.
A later recursive delegation scheme would require another design.

## 3. Enrollment and browser approval

The fixed browser page is `/management/authorize`. Opening it carries no token,
request proof or secret in its URL. The CLI displays a nonsecret request ID/code
separately. The user selects that request on the page and compares its origin,
instance, purpose, scope/resource bounds, expiry and digest with the CLI.
Rendered labels are inert text; an ID is never authority.

1. The client validates its exact context and credential destination, persists
   its new pending entry, then submits the bounded enrollment descriptor and
   candidate secret over verified HTTPS. Secret fields are excluded from all
   output, diagnostics and request logging before serialization.
2. The server admits a pending request without creating an account, device or
   grant. Repeating identical input with proof of that candidate secret reads
   the same request; changed input or candidate secret cannot edit an existing
   request. An approved request reads its durable receipt rather than creating
   another grant. No account inventory is disclosed. A pinned expected instance
   must match internally.
3. The browser authenticates through the safe ceremony below. It reads a frozen
   approval plan for the request. Approval is a same-origin POST with the live
   session, double-submit CSRF, exact plan digest/revisions and deadline.
4. Under the writer lock, recheck the approving device/session or recovery
   provenance, scope/resource bounds and pending deadline. Journal the active
   grant and request-ID mapping, consumed approval, operation result and audit
   as one logical effect;
   only after fsync may the index expose it or the browser receive success.
5. The client proves possession of its previously stored secret on the fixed
   enrollment-status route. Approved metadata includes instance, origin, exact
   granted bounds and expiry. It pins those values, then proves an allowed read
   in a new process before calling login complete. No credential is returned.

For first enrollment, the approved receipt and matching browser display establish
the instance binding over the already verified origin. Existing contexts refuse
an unexpected instance. No redirect forwards a proof, cookie or credential;
noninteractive mode never opens a browser or supplies consent.

### Safe browser sign-in

An already live dashboard session may authorize a management plan; it never
becomes the CLI credential. The new flow must not create or navigate to the
legacy `/login?token=…` route.

When no session exists, the fixed page accepts the standing setup/recovery token
in a password field and submits it in a same-origin JSON POST to a dedicated
session endpoint. This is explicit user input in the browser, never agent chat,
CLI stdin/stdout or generated configuration. A sessionless, short-lived CSRF
challenge binds page cookie, response and request header; require the exact
configured Origin, closed content type/schema and no CORS. Verify the challenge
before accepting the secret, and compare the secret under the existing reserved
body boundary. Success rotates both session and CSRF values, clears the input
and returns no token. Apply the existing security headers and cookie lifetimes.

The TLS terminator and browser remain trusted for credentials. POST does not
make a recorded request body safe: no body/header capture, URL interpolation,
form resubmission storage or diagnostic dump may retain the secret. V03/S05
inspect the actual browser history, app output and campaign-owned diagnostics.
If the supported browser path cannot meet this, return `needs_action` and keep
enrollment unavailable; manual entry alone is not evidence of safe handling.

A safe native device-to-browser token handoff belongs to PR-4a's plugin bridge.
It must preserve device provenance and the existing single-use five-minute
lifetime without putting the token in a URL. PR-3b can use direct recovery-session
sign-in and independently established live device sessions; it cannot advertise
a native handoff before that path is implemented and observed.

### State and interruption outcomes

| Prior state + event | Result |
| --- | --- |
| No local entry; custody fails | No enrollment request; explicit unsupported/permission error |
| Protected pending entry; request accepted | Pending only; no management permission |
| Unapproved pending request; user rejects/cancels, deadline passes or server restarts | No grant; exact request becomes cancelled/expired/unknown; a new request requires new secret/ID and approval |
| Pending; approval commits, response disappears | Active grant remains durable; the saved client secret reads that same receipt; never mint another grant as a retry |
| Pending; append/fsync refuses | No acknowledged grant; return the storage refusal; reconcile an ambiguous connection outcome before another approval |
| Active; local finalization/restart fails | Protected pending entry still identifies the grant; resume its receipt and readback, without re-enrollment |
| Any state; descriptor/digest/revision/instance changes | Refuse before effects; produce a new plan for explicit approval |

The enrollment-status proof has its own HMAC domain and may only read/cancel its
own pending request or read its own approved receipt. It cannot call management
operations. After approval it obeys grant expiry/revocation. Closing a browser
or CLI process does not undo a durable approval.

## 4. First-account bootstrap on an existing server

The native client must create the first content account **before** any management
grant can be approved. A server that is ready but has no account is not an
administrator and must not acquire a synthetic content device for the CLI.

1. The user provides the existing server's setup token through the protected
   native input/handoff in PR-4a. The plugin generates and durably keeps the
   vault key, then performs the existing setup/recovery exchange.
2. Observe native credential persistence and the exact active device. The
   source's account and device writes are separate, so interrupted first setup
   may leave an account without a completed client. Preserve the key already
   kept by the plugin and reconcile from independently authenticated state.
3. If a one-time device credential never reached native storage, return
   `needs_action` and identify the exact orphan. Under explicit native recovery
   approval, make one replacement enrollment through the existing setup-token
   plus vault-proof recovery route. Verify the replacement's native credential
   persistence, restart and heartbeat, then ordinarily revoke the exactly bound
   orphan. Two active devices is partial progress; completion requires one active
   replacement and a revoked orphan. If the replacement response is also lost,
   stop in `needs_action` for reconciliation without another enrollment. Never
   guess an orphan from a display name.
4. Once native first-account setup is confirmed, perform management enrollment
   through V03. Management authority never supplies pairing approval or a vault
   key. Account recovery unavailable or an unidentifiable orphan stops safely.

This design adds no remote `recovery reset`, deployment adapter or token reader.
The offline operator reset, last-device guard and seven-day recovery-age guard
retain their current authority. Replacement-first recovery uses ordinary setup
and revoke; it adds no special atomic-replacement route or guard exception.
V06/PR-4a must prove both lost-response boundaries, exact orphan attribution,
native restart, one active replacement at completion and an independent peer
round trip. Released 1.1.5 supplies recovery enrollment; durable orphan attribution
and this coordinated completion remain PR-4a work.

## 5. Management requests and authority

Use a distinct management header/route namespace. Reject mixed device,
management and browser credential forms. Grant IDs, instance IDs and origin
are explicit signed fields; paths/queries are signed exactly as transmitted.
The management canonical input consists of newline-separated protocol domain
`obsync/management/v1`, instance fingerprint, canonical origin, grant ID, method,
request target, timestamp, fresh nonce and lowercase SHA-256 body digest.
Use HMAC-SHA256 and constant-time comparison from the existing primitives.
Enrollment proofs use, in this exact order: `obsync/management-enrollment/v1`,
the frozen descriptor's expected instance fingerprint or literal `-` for a
first enrollment without a pin, canonical origin, request ID, method, exact
request target, timestamp, fresh nonce and lowercase SHA-256 body digest.
Encode each input as UTF-8 fields separated by one LF, with no final LF;
reject CR/LF in every field. This framing also applies to management requests.
Timestamps are unpadded decimal Unix seconds; nonces are 16 random bytes as
32 lowercase hex characters. IDs and fingerprints retain their closed wire
formats. The server must verify method/target before applying status or cancel:
only `GET /management/enrollments/<request-id>` and
`POST /management/enrollments/<request-id>/cancel` accept this proof, with no
query. A cancel cannot change an already approved grant.

The signed expected-instance field must equal the immutable enrollment
descriptor. A present pin must match the serving instance before admission,
approval or receipt lookup. The `-` marker is permitted only for the initial
enrollment's own pending state/receipt, under the verified origin and candidate
secret; it supplies no general management authority. The browser approval
displays the serving instance. After receipt readback, the client pins that
instance and uses the ordinary grant protocol for all management operations;
that protocol never accepts `-`. Lost responses reuse the same frozen request,
not a new unbound enrollment.

Preserve the ±300-second window and 600-second replay lifetime. Every attempt
has a fresh nonce. Use the existing nonce-log mechanism with a separate bounded
management namespace/file, rather than mixing grant IDs into device-only state.
Enrollment status/cancel consumes the same durable replay service after proof
verification and before any result or effect, including reads. Keys are typed
`enrollment:<request-id>:<nonce>` or `grant:<grant-id>:<nonce>`; the candidate
secret is obtained from pending state or its approved grant, never a device
credential. Unknown or expired pending requests, and expired/revoked approved
grants, refuse. An approval committed before its five-minute deadline remains
readable through its approved grant's lifetime; receipt reads cannot extend
that lifetime or create another grant. Initial unauthenticated
enrollment admission stays within the pending-request/body bounds in §2 and
creates no authority. The replay service has one shared 4,096-entry ceiling
and a 1,024-entry share per typed request/grant principal. Account its
file and compaction bytes separately in the journal-volume total; never let two
absolute byte counters overwrite each other. Reuse group fsync and fail-closed
full/unavailable/faulted behavior. A valid proof with unpersisted replay state
cannot execute even a read. No extra daemon or idle polling loop is introduced.

Authenticate before private path/resource validation. Then check current grant
state, deadline, origin/instance, required scopes and resource bounds. For a
child also check its parent's current state, bounds and expiry, and that the root
approving device is still active where present. At a mutation's serialization
point, repeat the authority/revision checks before the durable effect. Thus
revocation committed first prevents a later queued mutation; a mutation committed
first remains an honestly reported earlier effect. Long work rechecks before each uncommitted
privileged stage. No cached parent decision can survive a committed revocation.

| Operation | Authority and boundary |
| --- | --- |
| Offline discovery/context/doctor/export open | Explicit local authority only; no server credential, no MCP content access |
| Own auth status/receipt and logout | Proof of the exact principal; status exposes only its metadata; local logout alone has no server effect |
| Server metadata | `server:read`, one bound instance/origin; no private inventory before authentication |
| Grant list/get/plan/create/revoke | `grants:manage` and exact grant-resource bounds; trusted browser session may administer that server's grants; children cannot delegate |
| Device/log/audit reads | `devices:read`, `logs:read` or `audit:read`, implemented endpoint and explicit resource bounds; private-detail projection separately permitted |
| Device rename/policy/revoke | Reserved for PR-4b's implemented operations and `devices:write`/`devices:revoke`; no content approval or folder-selection authority |
| Storage, deployment, backup/restore/purge | Unsupported; server grants supply none of these local permissions |

Unimplemented scopes/operations cannot be granted or advertised. Default grants
contain only the implemented metadata reads the user approves. Resource bounds
are one server plus explicit device/grant IDs or an explicitly approved all-device
read bound. Grant creation/revoke may instead bind the principal and its direct
children, so an approved child can receive its server-generated ID; this supplies
no authority over unrelated grants. A child's scopes and resource bounds cannot
exceed its parent's. Future
devices are not silently added to an exact-ID set. Management API handlers enforce
the same operation map as CLI; owner-device middleware cannot serve as a broad
fallback.

## 6. Delegation, revoke, logout and rotation

A workload generates and protects its own secret, then submits a pending
request. The parent reads the frozen request's metadata; the parent's authorized
approval activates that child with the same candidate secret. No grant
creation command prints a child secret. Protected inherited descriptors support
an ephemeral workload; any explicit transfer uses an exact secret-store/file
reference, never argv, MCP results or environment-token discovery.

Revocation is a durable terminal grant state and destroys the wrapped secret.
A parent's revocation disables its child; expiry also disables both immediately.
The root device's durable revocation disables its grants and descendants even
before their cleanup records are written. Each authorization follows that root;
archiving a device cannot change the result. Recovery-session service grants are
independently approved and do not inherit an unrelated device's lifetime.

`auth logout` removes only the selected local credential and reports that fact.
`--revoke` first requests server revocation, then removes the local credential.
If the response is lost, report local removal separately and remote revocation
as unknown until a separately authorized observer reads the exact grant/operation.
Never interpret authentication failure alone as proof of a successful revoke.

Rotation creates a fresh ID/secret within approved bounds, proves it in a new
process, then revokes the old grant. Its overlap ends no later than the old
expiry. A child cannot rotate past its parent's deadline. A failed replacement
cannot extend either original deadline; longer service enrollment requires
fresh independent approval.

## 7. Durable effects, compaction and compatibility

Store a grant effect and its audit/operation result in one journal record, with
closed fields and bounded lengths. Approval binds actor/root provenance, origin,
instance, exact scope/resource set, relevant revisions, input digest and absolute
plan deadline. A repeated apply returns the original result only for that exact
input/actor/target; changed input refuses. Expired plans always refuse, including
after receipt compaction. Replanning reads actual state and requires fresh authority.

Use the existing writer-lock/append/fsync/index sequence. No separate request-log
write substitutes for audit, and no in-memory grant can precede its durable record.
A failed required append refuses new privileged work. Future management device
mutations must put their effect and audit in one logical durable record as well.
Do not claim multiple adjacent frames are crash-atomic merely because they share
one fsync; the current replay can encounter a partial final append.

Snapshots preserve active grants, terminal states still needed for denial,
provenance, revisions, operation deadlines/results and the bounded audit history.
Retain revoked/expired grant receipts through their original expiry plus the
600-second replay window, and plan receipts through their deadline plus that
window. An absent/compacted record never grants permission. A new enrollment
requires a fresh independently approved descriptor; an old approval cannot extend
its absolute deadline or recreate its effect.

Keep at most 4,096 audit entries for at least 30 days. Reserve bounded capacity
for revoking the live grants before admitting more creations; if required history
cannot fit, refuse new grants rather than evict unexpired denial/audit state.
Physical storage failure remains a visible refusal; short grant expiry does not
pretend a failed revoke succeeded. Measure audit growth and nonce/journal bytes.

New management frame types are a storage compatibility boundary. Current 1.1.5
refuses unknown journal types, but can ignore extra snapshot fields: adding only
optional grant fields is insufficient. The implementation must mark managed
snapshots with a distinct required type and retain an incompatible format record
at the beginning of every managed journal segment. Before the first management
effect, roll to such a segment and durably establish that record; preserve the
boundary on every later roll and prune. Test the pinned 1.1.5 binary
against state both before and after snapshot/segment pruning: it must refuse
before serving. No downgrade or managed-state rollback is advertised. The later
restore design still owes V15 fencing; copying an old volume is not a supported
way to undo a grant revocation.

## 8. Local custody and review gates

POSIX persistence requires an exact owned 0700 parent and 0600 file, exclusive
creation, no links, durable atomic replacement and validation of the handles
actually written. Failure leaves no reusable credential and reports the exact
permission/capability gap. A protected file is not OS-encrypted storage. Do not
search Keychain, other stores, plugin secrets or unrelated files.

Windows requires equivalent exact-entry ACL and reparse/race protection, proved
on native Windows. Node's POSIX mode argument is not that proof. Any OS helper
must be a declared, verified absolute executable invoked with typed arguments
and a minimal environment, never a shell or workspace-selected executable.
Until a reviewed implementation can establish those protections, persistent
Windows custody remains unsupported; a protected inherited descriptor supports
ephemeral use only when its actual host path is proven. This is a shipping gate,
not permission to substitute a plaintext config token.

Runtime erasure is best effort; same-user shell access and host administrators
remain trusted. Close exact inherited handles and delete only owned temporary
entries. No recovery phrase, setup token or credential reaches an agent transcript,
URL, config entry, ordinary output, log or support bundle.

PR-3b's gates are V03, V04, V09 management logout and V10 grant mutations;
S02/S03/S05/S07/S08; P03/P07/P08/P10. V06's native integration remains PR-4a.
Real MCP-host halves run in PR-4c; before then they stay explicitly unrun.

Acceptance must independently observe: allowed reads; denied cross-scope/resource/
origin operations with unchanged state and a working control; lost approval and
apply responses; restart/compaction without grant revival; parent/device revoke
races; expiry/rotation; bounded ordinary concurrent requests; protected native OS
custody; and browser history/output/residue without secrets. Source fault injection
must cover nonce and grant/audit fsync boundaries. Measure authentication overhead
and sync latency with every protection enabled. A green unit suite, successful
login or hidden MCP tool does not complete these gates.
