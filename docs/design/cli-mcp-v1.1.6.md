# CLI and MCP design: staged delivery for people and agents

Status: planned capabilities, reconciled 2026-10-02. Tracked in
[#254](https://github.com/snaraj/obsync/issues/254). These commands, management
APIs and MCP tools are not implemented by this document. The
[live acceptance plan](../validation-plans/cli-mcp-v1.1.6.md) defines the evidence
required for each delivery slice. Existing behavior below was checked against
protected source `03d108505d3993bddff276d70c814a6547222339` (released 1.1.5).

## 1. Product outcome and release boundary

Security is the primary product requirement. The
[CLI/MCP security contract](../security/cli-mcp-v1.1.6.md) governs every package:
least privilege, trusted installation, credential custody, explicit authority,
recoverability and independently observed denial. Convenience, performance and
the release date cannot override it. Unsupported safe behavior is a visible
capability gap, never a bypass or permissive fallback.

Give a person or an agent one entry point, `obsync setup`, to connect an existing
server, configure an explicitly selected Obsidian vault and prove sync with
another device. Deliver offline discovery first, then management authentication,
native existing-server setup and device lifecycle, and an MCP observe profile.
Storage, new-server deployment, maintenance and full backup/restore follow in the
next milestone; their retained requirements below do not advertise availability.

Ship one management client, `obsync`, with `obsync mcp serve` as another entry
point into the same operations. Keep `obsyncd` as the server and offline recovery
program. An agent should need the installed help and schemas, not source code,
private runbooks, guessed flags or a particular model vendor.

Milestones describe scope and may span several releases. Every artifact PR takes
exactly one permitted SemVer step from current protected main. The first CLI
artifact release takes the minor step to **1.2.0**; later artifact PRs take their
step from the then-current main. Only one artifact PR is open at a time, so a
future slice does not reserve a stale version. Documentation-only changes advance
no locks. The usual three-PR budget may rise to four only when it blocks the
management-auth design or co-editing design PR; the one-artifact limit still holds.

Current scope: offline discovery/schema/context/doctor and local encrypted-export
opening; scoped management login/status; native desktop existing-server setup,
mobile handoff and device lifecycle; local stdio MCP **observe**; resulting-state
proof for each shipped capability. Profiles may target several servers; each
server keeps the existing single-account model.

Deferred to the next milestone: [#259](https://github.com/snaraj/obsync/issues/259)
storage administration/deployment adapters, [#260](https://github.com/snaraj/obsync/issues/260)
full backup/isolated restore, and setup's new-server and storage stages. MCP write
profiles are also outside this observe-only slice. The six wholly deferred live
gates are V11–V15 and V18; V06 retains its existing-server bootstrap/interruption
portion. Their security requirements remain binding when those features ship.

Scope is frozen: unrelated findings discovered during this milestone are tracked
in the deferred milestone. A regression introduced by the current milestone or
a review finding on a PR's own change stays with that PR; it cannot be deferred
to clear its gate.

Later work: hosted/remote HTTP MCP, arbitrary note reading or editing, recipient
sharing, vault-key rotation, multi-account hosting, replica servers, paid storage,
and arbitrary host/network administration. Their absence must appear in capability
discovery. Local agents already authorized to edit notes may use their existing
Obsidian workflow; the administration MCP does not grant content access.

## 2. Lessons from cf and the current gaps

Cloudflare's [cf launch](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)
describes generated API commands, JSON-first output and `cf cli search`. Adopt
those principles: one operation catalog, predictable nouns and verbs, small
search results, inspectable schemas, explicit targets and output filtering.
Search uses a shipped local index; it requires neither an account nor an AI
service. This is an interface reference, not a Cloudflare runtime dependency.

| Capability | Present in 1.1.5 | New work needed |
| --- | --- | --- |
| Host CLI | `serve`, `check`, `setup-token`, `recovery reset plan/apply`, key-taking ciphertext `export`, version | Management client; #317 removes key input from server export and adds native export/offline client opening |
| Administration | Dashboard cookies and CSRF | Scoped machine identities and management API |
| Device authentication | Account-wide owner HMAC credentials | Separate, revocable administration grants with no vault key |
| Obsidian setup | Native UI and SecretStorage; pairing v2 with reveal/key commitment, native match and key persistence confirmation | Typed configuration handoff and receipts preserving the shipped pairing protocol |
| Device lifecycle | Pending/active/revoked state, revoked-only archive flag, `last_heartbeat`, seven-day recovery guard | Scoped management access and truthful workflow receipts; reuse existing state and guards |
| Device policy | PATCH exists; local heartbeat can overwrite policy | Requested, acknowledged and effective revisions |
| Storage | Volumes, declared capacity, usage, retention, quarantine | Precise measurement provenance, plans and deployment convergence |
| Account quota | Enforced when present; no setter | Durable quota operation with explicit preconditions |
| GC and scrub | `202` plus latest summary | Correlated jobs and independently checked completion |
| Backup | Offline operations; ciphertext export | Coherent full backup, restore fencing and native recovery proof |
| Configuration | Startup environment/chart values | One declared authority and inspect/plan/apply/verify adapters |

Sources: [architecture](../architecture.md), [protocol](../protocol.md),
[storage contract](../storage.md), `crates/obsyncd/src/cli/mod.rs`,
`crates/obsyncd/src/api/{admin,devices}.rs`, `plugin/src/main.ts` and
`plugin/src/sync/engine.ts`. In particular, `check` and `export` open storage
and can repair its posture/recovery state. They are not read-only probes.

## 3. Architecture and implementation decisions

The CLI and MCP call a shared operation dispatcher. Each implemented operation
declares its target, schema, permission, effect, preconditions, retry rules and
completion proof. Current adapters are management HTTPS and local Obsidian;
Compose, Helm/GitOps and host recovery adapters belong to deferred work. Do not
build unused adapter frameworks in the offline slice. There is no generic shell,
JavaScript-evaluation, notes REST API or arbitrary HTTP tool in MCP.

The plugin owns content keys, local folder selection, sync records and native
secret entries. The management client never reads plugin secrets or edits its
private `data.json`. The server remains blind to vault paths and contents.
Management authorization does not authorize a new device to decrypt the vault.

Local stdio and tool allowlists are not an OS sandbox. An agent with unrestricted
same-user shell access can read that user's files outside MCP. Stronger workload
isolation needs separate OS/container authority and narrow mounts/credentials;
server-enforced scopes remain mandatory either way. Workspace inputs, remote
labels and tool results cannot grant authority, select privileged executables or
become instructions. Review these trust boundaries before implementation.

### Implementation decisions and remaining gates

| Decision | Recommended design | Gate |
| --- | --- | --- |
| Client HTTPS and MCP runtime | Approved direction: pinned Node built-ins and zero npm runtime packages; shared CLI/MCP operation layer | The first CLI artifact PR records the narrow exception in AGENTS requirement 5; server/plugin dependency constraints remain unchanged |
| Distribution | Signed/checksummed release bundle and launchers, documented runtime prerequisite, pinned reproducible install; optional registry wrapper only after publisher verification | Clean-machine install on every advertised platform. A future self-contained executable needs a separately checked packaging decision |
| Configuration authority | Deployment owns retention, watermarks, paths, mirrors and capacities; API owns management grants and their operations | Quota and maintenance APIs/adapters are deferred; no competing override over Helm/env |
| MCP transport | Local stdio; remote workload runs CLI or stdio beside its agent and uses HTTPS to obsync | Remote HTTP MCP requires separate auth/hosting scope |
| Deferred backup baseline | Stop the selected server, take complete coherent copies, restart; coordinated snapshots require proved consistency | #260 retains the full backup/fencing gates; encrypted export never substitutes for a backup |

The runtime direction is selected; installer provenance, platform custody and the
management-auth state model still need independent review before dependent code.
A proposed install command does not establish a self-contained binary or a tested
installation path.

### Shared catalog

One versioned catalog generates CLI discovery/help, input/output JSON schemas,
MCP tool definitions and reference documentation. Workflow operations can compose
several API calls, but their completion criteria remain explicit. Every entry has:

- Stable `operation`, summary, examples and `schema_version`.
- Input/output schemas, required fields, enums, units and byte/count ceilings.
- `execution_scope`: local, server, plugin or deployment; target identity.
- Required server capability, minimum versions and exact authorization scopes.
- `effect`: read, configure, enroll, revoke, maintenance, restore or delete.
- Repeatability, idempotency, revision preconditions, timeout and cancellation.
- Secret-field classification, privacy defaults and output projection rules.
- Evidence required for `completed` and for `verified`; documented errors.

CI checks catalog coverage against implemented handlers and documentation.
Schema discovery does not grant permission or prove a live capability.
Authenticated capabilities return server instance ID, API/schema versions,
implemented operations and effective scopes. Unauthenticated discovery returns
only the client's public catalog and generic health, not server inventory.

## 4. CLI surface

These are proposed command forms. Rows marked **deferred** remain unavailable in
the current slice; search/schema may describe them only as unsupported, never as
executable capabilities. `--context NAME` selects a server explicitly;
every result identifies that context and the verified server instance. A context
contains an origin, expected instance, deployment kind and credential reference,
not a vault key. It must not silently retarget after a redirect or config edit.

| Command family | Required operations and outcomes |
| --- | --- |
| `obsync setup` | Resumable existing-server onboarding, explicit local vault, native trust and final verification; new-server/storage stages deferred |
| `obsync cli search QUERY` | Bounded offline operation matches, scope/effect and schema lookup hint |
| `obsync schema OPERATION` | Exact versioned inputs, output, effect, scopes, retry policy and examples |
| `obsync capabilities` | Offline slice: local implemented capabilities only; later authenticated server/plugin intersection |
| `obsync context list/get/add/use/remove` | Manage named targets; removing one removes its local association, not a server |
| `obsync auth login/status/logout` | Browser-assisted management login, identity/scope/expiry, local logout with explicit server-revoke option |
| `obsync auth grants list/get/create/revoke` | Owner-authorized workload grants, bounded scopes/expiry, metadata readback; secure credential delivery |
| `obsync server get/health` | Version, identity, readiness and layer-specific health evidence |
| `obsync server config get/plan` **deferred** | Effective and desired configuration, authority, change/restart impact |
| `obsync server deploy/upgrade/restart/stop plan` **deferred** | Compose/Helm or GitOps plan against explicit deployment; health and version checks afterward |
| `obsync server remove plan` **deferred** | Stop/remove deployment while retaining data by default; distinct volume purge plan |
| `obsync obsidian status/install/configure/open` | Native plugin availability/version/enabled state; selected-vault settings plan and handoff |
| `obsync devices list/get/rename` | Bounded inventory; exact IDs for mutation; display labels never disambiguate writes |
| `obsync devices enroll/status/cancel` | Guide native pairing, observe pending/active/failed; content-key approval stays on paired client |
| `obsync devices policy get/plan` | Desired versus effective limits and revision; offline device explicitly pending |
| `obsync devices revoke plan` | Named device, sessions/links affected, last-device guard and readback |
| `obsync devices remove plan` | Revoke then archive/hide entry; retain server denial and historical attribution |
| `obsync obsidian disconnect plan` | Local credential detach through plugin, preserve notes, state server revocation separately |
| `obsync storage list/get/usage` **deferred** | Roles, tracked usage, declared/physical capacity, freshness, integrity and quota |
| `obsync storage quota/retention/watermark plan` **deferred** | Quota API or deployment changes; no implicit data deletion |
| `obsync storage volume/mirror plan` **deferred** | Provision/attach/expand/migrate/drain supported storage, exact adapter capabilities and external steps |
| `obsync storage gc/scrub plan` **deferred** | Maintenance scope, retention impact and correlated job outcome |
| `obsync storage quarantine list/get` **deferred** | Metadata, integrity evidence and documented restore options |
| `obsync backup create/restore plan` **deferred** | Complete backup or isolated restore with quiescence, identity and credential policy |
| `obsync backup list/get/verify` **deferred** | Manifest metadata, checksum inspection and separate live recovery result |
| `obsync plans get/apply` | Apply exact reviewed plan, with digest, revision and target checks |
| `obsync operations get/list/watch/cancel` | Durable progress and bounded waits; cancel only where supported |
| `obsync sync status/verify` | Local plugin status and explicit sentinel-based round trip; observe device evidence |
| `obsync doctor` | Offline slice: read-only local prerequisites/configuration diagnosis; authenticated server/plugin checks arrive with their slices; repairs remain separate plans |
| `obsync export open` | Explicit local #317 archive opening, offline; native export contains current notes by default, history only by choice; no MCP content access |
| `obsync logs list/watch`, `obsync audit list` | Bounded operational and administration events, filters and cursor |
| `obsync agent instructions` | Small installed guide, version/capability-aware, also available offline |
| `obsync mcp serve/config/doctor` | stdio adapter, explicit client-config preview/apply, actual integration checks |

Common verbs mean the same thing throughout: `get` reads one, `list` pages a
collection, `plan` calculates effects, `apply` performs an authorized plan,
`verify` collects proof. Preserve existing `obsyncd` command semantics; do not
alias `doctor` to its mutating offline `check`.

### First-session experience

Human: `obsync setup --output human`. Ask only for unresolved choices: existing
server, explicit vault, and whole-vault or selected folders. Show one combined
plan. New-server/storage requests return an explicit unsupported capability and
the documented external setup route. Reuse valid state and resume interruptions
without enrolling duplicate devices. Before the native setup slice ships, the
command itself reports unsupported.

Agent: read `obsync --help`, search the local catalog, inspect the operation
schema, inspect capabilities, then submit a structured plan with
`--input @setup.json --non-interactive`. Unknown fields are refused. The input
contains settings and secret references only. Missing authorization or native
trust action yields `needs_action` with a resumable operation ID.

Illustrative flow, not executable instructions for current releases:

```text
obsync cli search "connect Obsidian to an existing server"
obsync schema setup.plan
obsync setup --input @setup.json --non-interactive
obsync plans get PLAN_ID
obsync plans apply PLAN_ID --expect-digest DIGEST --non-interactive
obsync operations watch OPERATION_ID --timeout 120s
obsync sync verify --context personal --vault VAULT_ID --fixture small
```

`setup` assembles the plan and, for a human, offers the authorized apply step.
An agent can apply only within a previously granted scope. `--yes` may suppress
a redundant prompt; it never supplies missing authority or accepts a changed
plan. `sync verify` describes and requests any sentinel note creation/cleanup
through the selected plugin; it is not a read-only status command.

### Output, limits and exit contract

Default result output is JSON: indented on a TTY, compact through a pipe.
`--output human|json|jsonl` is explicit and stable. Guided prompts/progress go to
the terminal's diagnostic stream; noninteractive commands never open a browser,
read a prompt or choose a default consent. MCP stdout is protocol only.

Envelope fields: `schema_version`, `operation`, `target`, `state`, `data`,
`error`, `warnings`, `next_actions`, `operation_id`, `observed_at`,
`duration_ms`, `verification` and `pagination`. Schema defines nullability.
Timestamps are UTC RFC 3339; durations are integer milliseconds; byte counters
use decimal strings where they can exceed JavaScript's safe integer range.
IDs are opaque strings. An empty successful list is distinct from an unavailable
or partially collected inventory.

States: `not_started`, `needs_action`, `planned`, `accepted`, `running`,
`pending_device`, `completed`, `verified`, `refused`, `failed`, `cancelled`,
`partial`, `unknown`. A completed job is not necessarily verified. A timeout
after dispatch can be `unknown`; it never promises that nothing changed.

Lists default to 50 rows and cap at 500; output defaults to a 64 KiB page with
an explicit continuation cursor. `--fields` is a validated field projection,
not an expression interpreter. `--all` requires an explicit record/byte budget
or a file/JSONL sink; reaching a bound returns `truncated` and continuation,
never an apparently complete inventory. `logs watch` needs a duration or event
budget in noninteractive use. Each command has connection and total deadlines.

Exit classes: 0=requested contract satisfied, 2=invalid input/schema,
3=authentication required, 4=permission refused, 5=revision/conflict,
6=capability/prerequisite absent, 7=deadline or unresolved outcome,
8=verification failed, 9=service/transport unavailable, 10=human action needed.
An accepted asynchronous request can exit 0 only when submission was the requested
contract; `--wait verified` cannot. Errors still emit one valid JSON envelope.

## 5. Authentication and authorization

Create management principals, separate from content-bearing devices. Scopes are
enforced at the server, not only hidden from CLI help or MCP tool lists.
Current scopes: `server:read`, `devices:read`, `devices:write`, `devices:revoke`,
`logs:read`, `audit:read` and `grants:manage`, exposed only with their implemented
operations. `storage:read`, `storage:quota` and `maintenance:run` remain deferred.
Future deployment operations additionally need explicit local authority for the
named deployment. A server grant cannot supply cluster or host rights. The
permission matrix below retains requirements for those deferred operations.

| Sensitive operation | Required authority in addition to an exact plan |
| --- | --- |
| GC/scrub with current retention | `maintenance:run`; no backup/key access |
| Change retention/watermark/mirrors/capacity | `storage:read` plus selected deployment write authority; explicit approval for retention reduction/detach |
| Full backup | Separate local `backup:create` policy permission, named deployment stop/snapshot authority and protected backup destination access |
| Restore/cutover | Local `backup:restore`, named deployment authority and owner approval of recovery point and credential fence |
| Server upgrade/restart/stop/remove | Local `deployment:manage` for one named deployment; remove retains data |
| Purge | Separate owner-only local `storage:purge` permission and explicit irreversible target confirmation; absent from normal MCP profiles |
| Issue a grant | `grants:manage` within parent bounds or an independently authenticated owner approval |

Local policy permissions are not server scopes and cannot be minted by the
remote server. Backup authority includes access to sensitive recovery material;
ordinary maintenance and storage-read grants never imply it.

Default agent grant: metadata reads for one server, short expiry. Write scopes,
deployment access and retention/purge permissions require explicit enrollment
approval. Headless service grants have named purpose, expiry, resource bounds
and revocation; no default perpetual owner token. A grant cannot mint a broader
grant. Descendants inherit parent resource bounds and cannot outlive the parent;
parent expiry/revocation cascades. Record the approving principal and device or
recovery-session provenance. Revoking an approving device revokes grants rooted
in that device's authority. An independent long-lived service grant requires an
explicit owner enrollment, never silent renewal by its descendant. Existing owner
device permissions are unchanged and are not presented as
scoped workload identities.

### Human and workload enrollment

1. CLI generates and protects its request ID and management secret before
   submitting a short-lived authorization request bound to that identity, exact
   server and requested scopes.
2. Human opens the fixed server authorization page, authenticates using the
   supported dashboard path, verifies the matching request code and approves
   scopes. Neither the setup token nor a dashboard cookie is copied into CLI.
3. CLI polls using proof of its saved secret and records approved metadata,
   including the server-generated grant ID. Approval returns no new credential;
   a lost response reconciles the same durable receipt. Agent output contains
   metadata only.
4. Credential proof uses a separately specified HMAC domain and principal ID,
   preserving timestamp/nonce/durability guarantees. Enrollment binds approval
   to the saved candidate secret and expires/rejects abandoned attempts.
5. A headless workload protects its own secret through an inherited descriptor
   or explicitly configured secret file/store before requesting a scoped grant.
   Independent owner or authorized parent approval activates it. Credentials
   never reach MCP results, command arguments or generated config.

The [management authentication design](auth-v1.1.6.md) specifies this wire
exchange and requires independent review before implementation. It is not a claim
to implement OAuth or a reason to add custom asymmetric crypto.
Human URL/code may be shown; credential-bearing links/material remain out of
transcripts and logs. No credential-store inventory or fallback search.

Credential storage needs exact per-profile entries and tested ACL/mode protection
on each client OS. A protected file is not advertised as OS-encrypted storage.
Failure to establish exclusive protection refuses persistence. Explicit ephemeral
descriptor input supports unattended jobs. Agent-config files contain references,
never tokens. Origin changes, redirects and TLS trust failures cannot forward
credentials to another origin or downgrade HTTPS.

`auth logout` removes the local management credential; `--revoke` also ends the
server grant and reports that result independently. Revoking a management grant
affects subsequent CLI and MCP requests and in-progress jobs according to their
declared authorization boundary. High-impact jobs recheck authorization before
their irreversible phase. Device revoke, management logout, plugin disconnect
and archival are different operations with different explanations.

Management credential rotation enrolls a replacement within the same or narrower
bounds, verifies it from a new process, then revokes the old grant. Any overlap
has an explicit deadline and is visible in audit; failed replacement leaves the
old grant's original expiry unchanged. This is not vault-key rotation.

## 6. Seamless Obsidian onboarding without taking over its state

The [official Obsidian CLI](https://obsidian.md/help/cli) can target a vault and
install/enable/inspect a plugin through the desktop application. CLI registration
is opt-in and depends on the installed Obsidian version. Its `sync:*` commands
control Obsidian Sync, not obsync. There is no documented generic community-plugin
settings command or installation version pin; detect capabilities and verify the
actual installed version. Do not use arbitrary evaluation as a settings API.

`obsync obsidian install` uses that native path when supported; otherwise it
opens the [Community Plugins flow](https://obsidian.md/help/Extending+Obsidian/Community+plugins)
and gives the exact next action. The person makes Restricted Mode/plugin trust
choices. Do not install executable plugin code from the configured sync server.
Opening a link or an app is an intermediate event, not proof of installation.
The native installer does not document verification of obsync's signed evidence.
Disclose that trust boundary; checking installed bytes afterward does not prove
pre-execution verification. Any stronger promise needs a supported, live-proven
pre-enable verification path, not a guessed native API.

Build a narrow, versioned plugin handoff for obsync-owned actions: inspect status,
preview/apply server configuration and local folder selection, begin/observe
setup or pairing, request sync/verification and disconnect. The plugin validates
and serializes actions through existing transitions. Bind every request to the
selected vault/installation and request revision. Wrong-active-vault behavior is
a refusal, never a fallback.

Desktop baseline: an opt-in local IPC bridge using an OS-local channel, exact
installation authorization and typed messages. It must not add a network listener
to obsyncd. Protect the endpoint against other local users; same-user processes
and trusted Obsidian plugins remain in the local trust boundary. If the public
Obsidian APIs or platform cannot support a channel, use a native confirmation
handoff and state the reduced automation capability.

Mobile baseline: a short-lived QR/URI handoff carrying a nonsecret request handle,
with user confirmation in the target app. The existing pairing code carries secret
material and is shown only in the trusted pairing UI, never MCP output. A
configuration handoff uses a different type and must not be confused with that
code. The server can broker opaque status but receives no vault names, selections
or content keys. Any sensitive handoff payload is transferred through the local
client channel or client-encrypted envelope.

First-device setup generates the vault key inside Obsidian and confirms recovery
custody there. Additional-device approval and key wrapping stay with an already
paired Obsidian client. CLI/MCP can request, observe and cancel that workflow;
an administrator cannot approve content access by virtue of storage authority.
If no key-holding client is available, report the supported recovery steps.

First-account bootstrap on an already deployed empty server is a distinct stage:
no dashboard session or paired device exists yet. V06 tests this stage on an
operator-provisioned Compose server with trusted TLS; setup does not create the
server or storage. The standing setup token passes through an explicitly
authorized protected process-to-process channel bound to the existing server
instance and selected native installation. Automated retrieval by a deployment
adapter remains deferred. The current protected handoff delivers recovery sign-in
to a reviewed browser flow and setup input to the plugin; token bytes never pass
through tool results, shell arguments, generated config, normal stdout or logs.
Any short-lived handoff storage has exclusive permissions, expiry and an exact
owned cleanup target. Where that channel cannot be secured, the owner enters
the token directly in the native dashboard/plugin flow and the CLI reports the
specific action needed. It never asks for the token in agent chat. A lost first
setup response is reconciled from the plugin/server state; it is not blindly
re-sent or treated as permission to create a second identity. The standing token
remains in its existing protected server custody after the handoff expires.
The current token-bearing dashboard sign-in URL does not satisfy this new
handoff contract. WP2/WP3 must supply a safe browser ceremony and verify its actual
history/request/diagnostic behavior; manual entry alone does not establish that.

Reconciliation cannot recover a one-time credential that never reached native
storage. For that case, the new setup operation must durably identify the exact
orphan device without exposing its secret. Return `needs_action`; under explicit
native recovery approval make one replacement enrollment through the existing
setup-token plus vault-proof recovery flow, using the vault key the plugin saved
before setup. Verify the replacement's native credential persistence, restart
and heartbeat before ordinarily revoking the exactly bound orphan. The interim
two-active-device state is partial progress, not completion; the revoked orphan
stays in audit history. Preserve the existing last-device and recovery-age guards.
If the orphan cannot be identified, recovery is unavailable or the replacement
response is also lost, stop in `needs_action` for reconciliation; do not repeat
enrollment. WP3 must implement this outcome before interrupted first setup can
pass acceptance.

Current onboarding stages are `prerequisites → existing-target → management-auth →
plugin-installed → plugin-configured → content-device-active → sync-verified`.
On an empty existing server, native first-account bootstrap precedes management
authorization; it cannot require a dashboard identity that does not exist yet.
The independently reviewed auth design must fix that transition order before
implementation. New-server/storage stages are deferred. Stages may reuse state.
The receipt lists evidence per stage and
the exact remaining human action. Claim completion only after the plugin has
durably saved its configuration/credential, survived restart, and completed the
selected cross-device verification. A new server can first become ready without
having a content account; never invent a management device to create a vault.

### Device lifecycle

Lists show active and pending devices by default, with revoked/archived filters
and counts. Reuse the shipped 1.1.5 model from [#247](https://github.com/snaraj/obsync/issues/247):
`archived` is a flag on a revoked device, never another state. Account device
counts include active and pending devices and exclude revoked ones. `remove` means revoke then archive
from routine lists. Historical authorship and denial records survive; there is
no claim of wiping notes from an offline device or undoing downloaded knowledge.

Revocation previews the exact ID/name, linked sessions, recovery guard and effect
on the current connection. Confirm durable denial using a fresh request from
the test device during acceptance. In normal use, distinguish server-confirmed
revocation from a device that has not attempted another request.

Pairing retains 1.1.5's P-256 commitment/reveal and native match ceremony; neither
the management grant nor a bridge may downgrade it. Envelope consumption alone
is insufficient: native persistence plus active state and `last_heartbeat` prove
the kept key. Preserve the equal-timestamp behavior documented in the protocol.
Last-active revocation retains `last_device` and the seven-day `recovery_too_new`
guard. Offline `recovery reset` does not become a remote management operation.

Policy writes have requested, acknowledged and effective revisions. The plugin
fetches and validates the requested revision, applies it, and reports the result;
heartbeat must not overwrite desired state. Offline/unsupported clients stay
`pending_device`. Narrowing limits preserves existing local notes. Folder
selection is local-only, changed through an authorized local plugin action,
and never described as a server access permission.

## 7. Deferred storage and server lifecycle requirements

This section is the retained design for #259/#260 in the next milestone. It is
not current-slice implementation scope. The plan/durability rules also apply to
current grant, setup and device mutators; reuse their smallest required common
mechanism without prebuilding the deferred adapters.

### Tell the truth about storage

Report each blob, journal and mirror volume separately: role, opaque ID, class,
declared capacity, tracked usage, watermark, freshness and integrity. Physical
filesystem capacity/free space is a separate observation from a capable local
deployment adapter, with source and timestamp. If unavailable it is `unknown`,
not the server's declared number repeated as a measurement. Do not expose host
paths in remote output. There is no reservation system today; report that
capability absent instead of inventing allocatable space.

Account quota is distinct from physical capacity and device download budgets.
Add a journaled quota setter with revision checks and replay/snapshot support.
Refuse a limit below current accounted usage by default; offer an explicit plan
to retain existing data while refusing future growth if that policy is chosen.
Never delete content to make a quota request succeed.

### Configuration and deployment

Retention, watermarks, scrub rate, mount paths, mirror topology and capacities
stay deployment-owned. Plans render the chosen Compose environment or Helm values,
record their digest and effective-config hash, and show restart requirements.
For GitOps-managed deployments they produce a reviewable configuration artifact;
they do not edit the live resource behind its controller. Status distinguishes
`rendered`, `awaiting_external_apply`, `reconciling`, `effective` and `verified`.

Adapter scope is explicit. Compose may act on one named project; Helm on one
named release/namespace when directly managed. GitOps authority belongs to the
repository workflow. Plain host deployments can render a runbook and inspect an
operator-reported result; unsupported service managers are not silently invoked.
No arbitrary remote shell, filesystem formatting, provider billing, DNS or
firewall control is part of a storage command.

Volume add/expand/mirror/migration plans list physical support, capacity needed,
single-writer/quiescence requirement, integrity checks, downtime, recovery point
and partial-failure action. A PVC request or changed capacity variable is not an
expansion result: prove the backing volume, mounted filesystem, effective server
capacity and successful authenticated write. Unsupported expansion reports the
external action needed. Removing a mirror or migrating paths verifies every
required ciphertext copy before detaching anything; interrupted work is resumable.
Automatic arbitrary online rebalancing remains outside the proposed scope.

Upgrade pins the release and image/chart digest, checks compatibility and backup,
applies through the selected authority, then verifies readiness, version and a
client round trip. Restart/stop reports outstanding work and its handling.
Rollback requires explicit format compatibility; it is never the automatic answer
to a timeout. Server removal retains volumes by default. Purge is a separate
owner-only plan naming the exact server and volumes, backup state and irreversible
effect; omit it from normal MCP profiles.

### Durable operations and safe retry

Introduce bounded, persistent operation records before promising automation over
GC, scrub, quota, policy, backup or deployment changes. A record names initiator,
target, plan digest, revisions, stage, counters, elapsed time, budget, result and
evidence. Keep bounded terminal history and a documented retention period; an
expired handle says `operation_expired`, never "not run".

Server jobs persist in the server journal. Deployment/stop/backup/restore jobs
persist in a protected coordinator store on the CLI/adapter host, outside the
managed volumes. A fresh CLI or MCP process can resume that record using an
exclusive operation lock and reconcile the deployment independently while the
server is offline. No additional background daemon is required: work either
continues in a declared deployment job or pauses at a durable stage awaiting
resume. Losing both coordinator and server yields an explicit recovery procedure,
never a new operation guessed from an empty server history.

Plans bind server instance, operation, exact targets, proposed values, previous
revision, expiry and authorization requirements. Apply rechecks these under the
mutation's serialization boundary. Changed scope/state invalidates the plan.
An approval is recorded outside untrusted tool-result text; an MCP argument that
says `approved:true` cannot manufacture it.

An idempotency key binds principal, target and canonical input digest. Repeating
the same request returns its prior operation; reusing it with changed inputs is
refused. Keys are bound to an issued plan with an expiry, and deduplication records
live at least until that expiry. An expired plan/key is always refused, even after
its receipt is compacted. Repeating it cannot silently execute again. A new plan
requires fresh effect reconciliation and a new explicit request.
Durable dispatch and journaled effects must reconcile after a crash;
do not promise abstract exactly-once execution across a deployment tool. Each
stage either has an idempotent effect or an independent reconciliation read.
Existing nonrepeatable API calls remain nonrepeatable until upgraded explicitly.
Every signed attempt has a fresh nonce. Lost responses remain unknown until
resolved. Cancellation stops future safe stages and reports already-applied
changes; it never claims to undo a committed revoke or collected ciphertext.

Maintenance correlates completion to the requested run, never to an old summary.
GC preserves heads and retained history; a retention reduction previews affected
counts and cutoff before approval. Scrub reports complete versus partial passes,
quarantine, mirror recovery and unresolved client repair. An estimate accounts
for rate, scheduled pauses, queue and retry policy; otherwise show no ETA.

### Backup and restore

A backup contains a coherent journal, index, nonce/credential state, all required
retained ciphertext and the configuration needed to interpret them. Include
server-key custody through a protected backup channel when supplied outside the
volumes. Never return that material in CLI JSON/MCP or place it in a repository.
Ciphertext export of selected heads is not a backup. A checksum pass establishes
package integrity; only a native restore drill establishes recoverability.

Restore targets an isolated empty destination first, verifies capacity and
manifest completeness, and keeps the original backup immutable. Existing clients
ahead of the backup exercise the current replay/recovery behavior with their
newer notes preserved. The result states the recovery point and known losses.

Mandatory credential fencing: before a restored instance is reachable, reconcile
against a separately protected revocation ledger newer than the snapshot, or
invalidate all restored management/device/session credentials and require trusted
re-enrollment. Do not depend on a revocation record inside the same old backup.
Select and implement one supported fence in the recovery work package, including
accounts without registered recovery. If safe re-enrollment cannot be established,
restore remains isolated and needs owner action. Live proof must show that a
credential revoked after the backup stays refused after cutover.

## 8. MCP contract and agent setup

Ship `obsync mcp serve --context NAME --profile observe`. No daemon, public
listener or hosted service is needed. `observe` exposes implemented metadata
reads only. `manage-devices`, `admin` and all MCP mutation tools are deferred;
requesting them refuses explicitly. Each process is bound to one context; a tool
call cannot switch it to another privileged profile. CLI mutations do not
silently become tools when they enter the shared catalog.

Expose a compact core from the shared catalog. This table distinguishes the
current observe surface from the retained future tool design:

| MCP tool | Purpose |
| --- | --- |
| `obsync_search`, `obsync_schema` | Offline discovery and bounded exact operation schema |
| `obsync_status`, `obsync_doctor` | Layered current state and diagnosis |
| `obsync_setup_plan`, `obsync_setup_apply` **deferred** | Complete setup with explicit plan-bound authority |
| `obsync_devices_list`, `obsync_device_get` | Authorized inventory and exact device state |
| `obsync_device_enroll`, `obsync_device_revoke` **deferred** | Native enrollment handoff; approved revoke plan |
| `obsync_storage_get`, `obsync_storage_plan`, `obsync_storage_apply` **deferred** | Storage model and authorized changes |
| `obsync_server_plan`, `obsync_server_apply` **deferred** | Explicit deployment lifecycle adapter |
| `obsync_backup_plan`, `obsync_backup_apply` **deferred** | Backup/restore plan and job |
| `obsync_operation_get` | Read existing authorized operation metadata |
| `obsync_sync_verify`, `obsync_operation_cancel` **deferred** | Sentinel mutation and controlled interruption require a future write profile |
| `obsync_logs_list`, `obsync_audit_list` | Bounded diagnostic and administrative evidence |

Future device-policy, grant and maintenance tools use the same typed catalog as
their CLI counterparts; the current observe profile cannot invoke them. Keep discovery small with profile filtering and
pagination; do not require a host-specific dynamic-tool extension. No unbounded
`execute(code)` or arbitrary command string. Resources provide static instructions,
schemas and authorized operation/status metadata, for example
`obsync://instructions` and `obsync://operations/ID`. Optional prompts guide setup,
diagnosis and revocation but grant no authority.

Return a concise human summary and matching `structuredContent`, with an output
schema and truthful read-only/destructive/idempotent annotations. Domain errors
are tool errors with structured codes; protocol errors keep protocol semantics.
Annotations help presentation; the server and local policy enforce permissions.
Logs, device names and server descriptions are untrusted data, never instructions.
No prompts ask the user to paste a recovery phrase or credential into the agent.

As checked on 2026-10-02, [MCP latest](https://modelcontextprotocol.io/specification/latest)
is revision 2026-07-28, whose version/capability exchange differs from older
initialization-based revisions. Declare the implemented revision set; verify
2026-07-28 and the 2025-11-25 compatibility path only against clients that actually
support them. Do not assume every installed host implements latest. Unsupported
revisions get a clear refusal, not a guessed handshake. Optional task extensions
are unnecessary: ordinary tools can poll durable obsync operation IDs.

Follow [tool schemas](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
and [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).
Only protocol messages reach stdout, including during errors, updates and process
startup. Human diagnostics go to stderr. A stopped MCP client does not imply its
server operation was cancelled; reconnection reads the same operation record.

### Client installation and instructions

`mcp config --client CLIENT` renders the exact config change, executable absolute
path, arguments and credential reference. `--apply` writes only the selected
obsync entry after validating current config and retaining a recoverable backup.
Never overwrite unrelated servers or a user's custom entry; conflicts require an
explicit choice. Removal targets only the entry this installer owns.

Ship a generic stdio example, then independently tested adapters for Codex,
Claude Code/Desktop and at least one other MCP host. Record actual client versions
and protocol support; an unavailable host is not advertised as verified.
Headless environments get CLI and stdio recipes using scoped secret references.
No remote-only host is promised direct access to a local stdio process.

Publish small versioned agent instructions with: discover, inspect schema,
select context, verify authority, plan, apply, follow operation, check actual
result. Include recovery from `needs_action`, `pending_device`, stale plans and
`unknown`. Installation into any agent instruction/config directory is explicit;
the plugin does not add instructions to arbitrary vaults or machines.

## 9. Human language, branding and logs

Reuse the existing two-interlocked-rings identity from `brand/`; this task does
not redesign the logo. Use that mark consistently in plugin setup, dashboard,
MCP server metadata, install docs and product help. Supply supported light/dark
and small-size forms only where legible; plain text always works without icons.
Do not put logos or banners into machine streams.

| Machine state | Human label | Required explanation |
| --- | --- | --- |
| `needs_action` | Action needed | Typed reason, who must act, where and how to resume; use "Waiting for approval" only for an actual approval |
| `accepted` / `running` | Queued / Working | Stage, elapsed time, current progress and cancellation effect |
| `pending_device` | Waiting for this device | Desired setting, last contact and what remains unapplied |
| `completed` | Finished; verification pending | Which action completed and what has not been observed |
| `verified` | Checked | Exact outcome, observer and timestamp |
| `refused` | Change not allowed | Reason, whether anything changed and actionable remedy |
| `partial` / `unknown` | Needs attention | Known effects, uncertainty and next safe check |

Example human result: "Phone revoked. The server now refuses its credential.
Notes already downloaded on that phone remain there." If no device attempt was
observed, do not add "the phone has stopped syncing".

Every event has a stable code, severity, UTC time, operation/request ID, target
class, decision, duration and budget; long work adds START, bounded PROGRESS and
SUMMARY. Human logs translate the same event into a sentence plus a useful next
action. Machine logs use versioned JSONL and explicit units. Device addresses,
countries and user labels require an explicit private-detail projection and
permission; default diagnostics use safe aliases. Never log note paths, content,
keys, pairing secrets, authentication headers or arbitrary tool output.

Honor `NO_COLOR`, `TERM=dumb`, narrow terminals and ASCII fallback. Icons and
color supplement visible text; loaders do not imply success. Keyboard focus,
screen-reader labels, 200% text and light/dark contrast are acceptance criteria.
Device IDs remain distinguishable when names duplicate or truncate. Progress
states the denominator and measurement age; no invented percentage or ETA.

## 10. Work packages and documentation delivery

| Package | Delivery slice | Depends on | Live proof |
| --- | --- | --- | --- |
| [WP1 #255](https://github.com/snaraj/obsync/issues/255), PR-3a | Offline CLI/catalog/output/context/doctor, trusted install and #317 local export opening | PR-0 design; #317 native export format | V01, V02, V10 (local writes/interruption); #317 offline app-to-CLI round trip |
| [WP2 #256](https://github.com/snaraj/obsync/issues/256), PR-3b | Management enrollment, scoped grants, login/status/logout, custody and durable audit | Independently reviewed auth state model (PR-A); WP1 | V03, V04, V09 (management logout), V10 |
| [WP3 #257](https://github.com/snaraj/obsync/issues/257), PR-4a | Native bridge; existing-server first setup, pairing, folder selection and local disconnect | WP1–2 | V05–V10, V16 (local MCP config writes only) |
| [WP4 #258](https://github.com/snaraj/obsync/issues/258), PR-4b | Shared status, rename, policy acknowledgement, revoke/archive | WP1–3; shipped 1.1.5 device model | V08–V10 |
| [WP5 #259](https://github.com/snaraj/obsync/issues/259), deferred | Storage/quota/maintenance, new-server/storage setup and deployment adapters | WP1–2 | V06 (deployment portion), V11–V13 |
| [WP6 #260](https://github.com/snaraj/obsync/issues/260), deferred | Full backup, isolated restore, credential fencing and lifecycle | WP2, WP5 | V14–V15, V18 |
| [WP7 #261](https://github.com/snaraj/obsync/issues/261), PR-4c | stdio MCP observe, client configuration, agent instructions and presentation | WP1–2 implemented catalog; native-read capabilities only after WP3 | V02–V04 (MCP halves), V10 (read/reconnect/refusal), V16–V17 |
| [WP8 #262](https://github.com/snaraj/obsync/issues/262) | Evidence matrix, latency/resource measurements and public installation | Each shipped slice | All applicable scenarios; V19 after publication |

The [per-slice gate table](../validation-plans/cli-mcp-v1.1.6.md#delivery-slices-and-gate-unions)
is the union of these live rows and the security responsibility table, with each
partial row's boundary explicit. Every new mutator reruns V10/S08, including
grants, native setup apply and device policy/revoke. P10 applies to every plugin
or server change. Deferred gates remain named and unrun, never relabeled passed.

WP1 may proceed while the independently reviewed auth design is prepared. Auth
and durable operation enforcement precede mutation tools. Deliver one artifact
PR at a time with one release step per merge; do not compose the milestone into
one release. PR-4c can follow WP2 independently of WP3 only if unavailable native
reads are reported truthfully.

The first CLI artifact PR adds its package/build/test runner, a measured initial
CLI test floor and source provider-neutrality checks. If it adds Release assets,
update the release inventory, evidence manifest and publisher checks together;
the downstream release consumer must accept that exact inventory before merge.
Public install/provenance proof remains V19 after publication.

Each package owns the security requirements and S01–S12 live gates mapped in the
[security responsibility table](../security/cli-mcp-v1.1.6.md#8-ownership-and-release-gates).
No package can defer its enforcement or negative-state evidence to final polish.

Update these product instructions when implementation is available: README's
first-run entry; docs index; quickstart, setup, server, Kubernetes, settings,
dashboard, storage, recovery, troubleshooting, architecture, protocol, release,
validation and agent instructions. Add complete CLI and MCP references, client
compatibility, offline help, headless examples, uninstall/upgrade guidance and
an error-code map. Every command example comes from the versioned catalog and
is exercised through its real user path. Keep proposed design separate from
current installation instructions until release.

The 1.1.5 source/architecture distinguish six hours between completed ciphertext
repair walks, five minutes after a failed repair step, and a separate five-minute
filesystem reconciliation walk. V13 must measure the repair behavior when #259
ships; those timers cannot be substituted for one another or used as live proof.

## 11. Definition of done

All applicable security gates pass without weakening product protections.
Independent review and live receipts establish both permitted outcomes and
effective denial, including unchanged unauthorized state. Required unknown or
missing security evidence blocks the affected release claim; a timing exception
cannot waive a security invariant.

The release can claim CLI/MCP administration only when the live plan passes for
every advertised capability/platform, actual native outcomes meet frozen time
targets, human/AI outputs work in real clients, and distribution is checked after
publication. Existing sync/device acceptance remains required. Tests and schema
checks are prerequisites. A green test suite, a sent command or a queued job does
not establish that a person successfully configured Obsidian or recovered data.
