# v1.1.6 design: obsync for people and agents

Status: proposed scope, 2026-09-29. Tracked in [#254](https://github.com/snaraj/obsync/issues/254).
These commands, management APIs and MCP tools are not implemented by this
document. The [live acceptance plan](../validation-plans/cli-mcp-v1.1.6.md)
defines the evidence required to ship them. Existing behavior below was checked
against protected source `afbf7e7d81ecdfc66af8cb083d52f6b098e8875c` (1.1.4).
Reconcile the design with the completed 1.1.5 train before implementation.

## 1. Product outcome and release boundary

Security is the primary product requirement. The
[CLI/MCP security contract](../security/cli-mcp-v1.1.6.md) governs every package:
least privilege, trusted installation, credential custody, explicit authority,
recoverability and independently observed denial. Convenience, performance and
the release date cannot override it. Unsupported safe behavior is a visible
capability gap, never a bypass or permissive fallback.

Give a person or an agent one entry point, `obsync setup`, to connect a server,
prepare storage, configure an explicitly selected Obsidian vault and prove sync
with another device. The same client manages devices, credentials, storage,
maintenance, backup, recovery and the obsync deployment after setup.

Ship one management client, `obsync`, with `obsync mcp serve` as another entry
point into the same operations. Keep `obsyncd` as the server and offline recovery
program. An agent should need the installed help and schemas, not source code,
private runbooks, guessed flags or a particular model vendor.

The proposed 1.1.6 deliverable is the complete application administration path
in sections 3–9 plus its live evidence. Work packages can be developed separately;
they are not separate version reservations. Artifact changes for 1.1.6 must be
composed after protected 1.1.5, under the repository's release-step rule. A
documentation-only plan changes no version locks and makes no release claim.

Included: local stdio MCP, headless CLI administration, native desktop Obsidian
onboarding, mobile handoff, server/storage lifecycle through supported deployment
adapters, and explicit proof of resulting state. Profiles may target several
servers; each server keeps the existing single-account model.

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

| Capability | Present in 1.1.4 | New work needed |
| --- | --- | --- |
| Host CLI | `serve`, `check`, `setup-token`, `export`, version | Remote management client, installation, contexts, discovery, MCP |
| Administration | Dashboard cookies and CSRF | Scoped machine identities and management API |
| Device authentication | Account-wide owner HMAC credentials | Separate, revocable administration grants with no vault key |
| Obsidian setup | Native plugin UI, pairing URI, SecretStorage | Supported configuration handoff, status and completion receipts |
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

The CLI and MCP call a shared operation dispatcher. Each operation declares its
target, schema, required permission, effect, preconditions, retry rules and proof
of completion. Adapters are small and typed: management HTTPS, local Obsidian,
Compose, Helm/GitOps, and operator-run host recovery. There is no generic shell,
JavaScript-evaluation or arbitrary HTTP tool in MCP.

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

### Decisions to settle before product implementation

| Decision | Recommended design | Gate |
| --- | --- | --- |
| Client HTTPS and MCP runtime | Companion JavaScript client using Node built-ins, zero npm runtime packages; share its operation layer between CLI and MCP | Owner must approve a narrow client-runtime exception to AGENTS requirement 5. Node is currently build tooling, not an approved product runtime |
| Alternatives if that is refused | Separately review a client-only platform TLS/packaging dependency, or narrow the release scope explicitly | Rust std alone supplies no HTTPS. Do not add a TLS crate, curl runtime, SDK or FFI silently, or invent TLS |
| Distribution | Signed/checksummed release bundle and launchers, documented runtime prerequisite, pinned reproducible install; optional registry wrapper only after publisher verification | Clean-machine install on every advertised platform. A future self-contained executable needs a separately checked packaging decision |
| Configuration authority | Deployment owns retention, watermarks, paths, mirrors and capacities; API owns quota, management grants and jobs | No competing runtime override over Helm/env in 1.1.6 |
| MCP transport | Local stdio; remote workload runs CLI or stdio beside its agent and uses HTTPS to obsync | Remote HTTP MCP requires separate auth/hosting scope |
| Backup baseline | Stop the selected server, take complete coherent copies, restart; coordinated snapshots only where a supported adapter proves consistency | No generic live directory copy presented as a consistent backup |

These are planning recommendations, not approved changes to the dependency
contract. Resolve the runtime and install decision before promising a one-command
binary install. Server Rust and plugin dependency constraints remain in force.

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

These are proposed command forms. `--context NAME` selects a server explicitly;
every result identifies that context and the verified server instance. A context
contains an origin, expected instance, deployment kind and credential reference,
not a vault key. It must not silently retarget after a redirect or config edit.

| Command family | Required operations and outcomes |
| --- | --- |
| `obsync setup` | Resumable new-server or existing-server onboarding; explicit local vault and storage choice; final verification |
| `obsync cli search QUERY` | Bounded offline operation matches, scope/effect and schema lookup hint |
| `obsync schema OPERATION` | Exact versioned inputs, output, effect, scopes, retry policy and examples |
| `obsync capabilities` | Local capabilities plus authenticated server/plugin/deployment capability intersection |
| `obsync context list/get/add/use/remove` | Manage named targets; removing one removes its local association, not a server |
| `obsync auth login/status/logout` | Browser-assisted management login, identity/scope/expiry, local logout with explicit server-revoke option |
| `obsync auth grants list/get/create/revoke` | Owner-authorized workload grants, bounded scopes/expiry, metadata readback; secure credential delivery |
| `obsync server get/health` | Version, identity, readiness and layer-specific health evidence |
| `obsync server config get/plan` | Effective and desired configuration, authority, change/restart impact |
| `obsync server deploy/upgrade/restart/stop plan` | Compose/Helm or GitOps plan against explicit deployment; health and version checks afterward |
| `obsync server remove plan` | Stop/remove deployment while retaining data by default; distinct volume purge plan |
| `obsync obsidian status/install/configure/open` | Native plugin availability/version/enabled state; selected-vault settings plan and handoff |
| `obsync devices list/get/rename` | Bounded inventory; exact IDs for mutation; display labels never disambiguate writes |
| `obsync devices enroll/status/cancel` | Guide native pairing, observe pending/active/failed; content-key approval stays on paired client |
| `obsync devices policy get/plan` | Desired versus effective limits and revision; offline device explicitly pending |
| `obsync devices revoke plan` | Named device, sessions/links affected, last-device guard and readback |
| `obsync devices remove plan` | Revoke then archive/hide entry; retain server denial and historical attribution |
| `obsync obsidian disconnect plan` | Local credential detach through plugin, preserve notes, state server revocation separately |
| `obsync storage list/get/usage` | Roles, tracked usage, declared/physical capacity, freshness, integrity and quota |
| `obsync storage quota/retention/watermark plan` | Quota API or deployment changes; no implicit data deletion |
| `obsync storage volume/mirror plan` | Provision/attach/expand/migrate/drain supported storage, exact adapter capabilities and external steps |
| `obsync storage gc/scrub plan` | Maintenance scope, retention impact and correlated job outcome |
| `obsync storage quarantine list/get` | Metadata, integrity evidence and documented restore options |
| `obsync backup create/restore plan` | Complete backup or isolated restore with quiescence, identity and credential policy |
| `obsync backup list/get/verify` | Manifest metadata, checksum inspection and separate live recovery result |
| `obsync plans get/apply` | Apply exact reviewed plan, with digest, revision and target checks |
| `obsync operations get/list/watch/cancel` | Durable progress and bounded waits; cancel only where supported |
| `obsync sync status/verify` | Local plugin status and explicit sentinel-based round trip; observe device evidence |
| `obsync doctor` | Read-only layered diagnosis, freshness and exact next actions; repairs are separate plans |
| `obsync logs list/watch`, `obsync audit list` | Bounded operational and administration events, filters and cursor |
| `obsync agent instructions` | Small installed guide, version/capability-aware, also available offline |
| `obsync mcp serve/config/doctor` | stdio adapter, explicit client-config preview/apply, actual integration checks |

Common verbs mean the same thing throughout: `get` reads one, `list` pages a
collection, `plan` calculates effects, `apply` performs an authorized plan,
`verify` collects proof. Preserve existing `obsyncd` command semantics; do not
alias `doctor` to its mutating offline `check`.

### First-session experience

Human: `obsync setup --output human`. Ask only for unresolved choices: existing
or new server, explicit vault, whole-vault or selected folders, and storage size
when creating storage. Show one combined plan. Reuse valid existing state and
resume interruptions rather than enrolling duplicate devices.

Agent: read `obsync --help`, search the local catalog, inspect the operation
schema, inspect capabilities, then submit a structured plan with
`--input @setup.json --non-interactive`. Unknown fields are refused. The input
contains settings and secret references only. Missing authorization or native
trust action yields `needs_action` with a resumable operation ID.

Illustrative flow, not executable instructions for current releases:

```text
obsync cli search "connect Obsidian and configure storage"
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
Initial scopes: `server:read`, `devices:read`, `devices:write`, `devices:revoke`,
`storage:read`, `storage:quota`, `maintenance:run`, `logs:read`, `audit:read`,
`grants:manage`. Deployment operations additionally need explicit local authority
for the named deployment. A server grant cannot supply cluster or host rights.

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

1. CLI creates a short-lived authorization request bound to its generated public
   request identity, exact server, requested scopes and random client-held proof.
2. Human opens the fixed server authorization page, authenticates using the
   supported dashboard path, verifies the matching request code and approves
   scopes. Neither the setup token nor a dashboard cookie is copied into CLI.
3. CLI polls using its private request proof, then stores a management credential
   in the protected local credential store. Agent output contains metadata only.
4. Credential proof uses a separately specified HMAC domain and principal ID,
   preserving timestamp/nonce/durability guarantees. Enrollment must bind its
   secret delivery to the request proof and expire/reject abandoned attempts.
5. Headless bootstrap uses an owner-created scoped grant delivered through an
   inherited descriptor or explicitly configured secret file/store. It must not
   print credentials to MCP results, command arguments or generated config.

Specify and independently review this wire exchange before implementation;
it is not a claim to implement OAuth or a reason to add custom asymmetric crypto.
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

Cold-server bootstrap is a distinct stage because no dashboard session or paired
device exists yet. An explicitly authorized local deployment adapter retrieves
the standing setup token into a protected process-to-process channel, bound to
the new server instance and selected native installation. It hands recovery sign-in
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
native recovery approval revoke that orphan through the trusted recovery session,
then enroll through the existing setup-token plus vault-proof recovery flow.
The plugin retains the vault key it saved before setup. There is never a second
active identity for the abandoned installation; the revoked orphan stays in audit
history. If the orphan cannot be identified or account recovery is unavailable,
stop for owner recovery rather than guess or repeat enrollment. WP3 must implement
this outcome before interrupted first setup can pass acceptance.

Onboarding stages are `prerequisites → target → storage → management-auth →
plugin-installed → plugin-configured → content-device-active → sync-verified`.
Stages may reuse established state. The receipt lists evidence per stage and
the exact remaining human action. Claim completion only after the plugin has
durably saved its configuration/credential, survived restart, and completed the
selected cross-device verification. A new server can first become ready without
having a content account; never invent a management device to create a vault.

### Device lifecycle

Lists show active and pending devices by default, with revoked/archived filters
and counts. Integrate 1.1.5 issue [#247](https://github.com/snaraj/obsync/issues/247)
without creating a second device-state model. `remove` means revoke then archive
from routine lists. Historical authorship and denial records survive; there is
no claim of wiping notes from an offline device or undoing downloaded knowledge.

Revocation previews the exact ID/name, linked sessions, recovery guard and effect
on the current connection. Confirm durable denial using a fresh request from
the test device during acceptance. In normal use, distinguish server-confirmed
revocation from a device that has not attempted another request.

Policy writes have requested, acknowledged and effective revisions. The plugin
fetches and validates the requested revision, applies it, and reports the result;
heartbeat must not overwrite desired state. Offline/unsupported clients stay
`pending_device`. Narrowing limits preserves existing local notes. Folder
selection is local-only, changed through an authorized local plugin action,
and never described as a server access permission.

## 7. Storage and the complete server lifecycle

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
Automatic arbitrary online rebalancing is outside 1.1.6.

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

Start with `obsync mcp serve --context NAME --profile observe`. No daemon, public
listener or hosted service is needed. `observe` exposes reads; `manage-devices`
and `admin` expose selected additional operations only when the underlying
credential and local policy permit them. Each process is bound to one context;
a tool call cannot switch it to another privileged profile.

Expose a compact core and domain-specific typed tools from the shared catalog:

| MCP tool | Purpose |
| --- | --- |
| `obsync_search`, `obsync_schema` | Offline discovery and bounded exact operation schema |
| `obsync_status`, `obsync_doctor` | Layered current state and diagnosis |
| `obsync_setup_plan`, `obsync_setup_apply` | Complete setup with explicit plan-bound authority |
| `obsync_devices_list`, `obsync_device_get` | Authorized inventory and exact device state |
| `obsync_device_enroll`, `obsync_device_revoke` | Native enrollment handoff; approved revoke plan |
| `obsync_storage_get`, `obsync_storage_plan`, `obsync_storage_apply` | Storage model and authorized changes |
| `obsync_server_plan`, `obsync_server_apply` | Explicit deployment lifecycle adapter |
| `obsync_backup_plan`, `obsync_backup_apply` | Backup/restore plan and job |
| `obsync_sync_verify`, `obsync_operation_get`, `obsync_operation_cancel` | Observed outcomes and controlled interruption |
| `obsync_logs_list`, `obsync_audit_list` | Bounded diagnostic and administrative evidence |

Additional device-policy, grant and maintenance tools use the same typed catalog
as their CLI counterparts. Keep discovery small with profile filtering and
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

As checked on 2026-09-29, [MCP latest](https://modelcontextprotocol.io/specification/latest)
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

| Package | Deliverable | Depends on | Live proof |
| --- | --- | --- | --- |
| [WP1 #255](https://github.com/snaraj/obsync/issues/255) | Runtime/install decision, shared catalog, CLI/output/context contract, capabilities and durable operation foundation | Design decision | V01, V02, V10 |
| [WP2 #256](https://github.com/snaraj/obsync/issues/256) | Management enrollment, scoped grants, credential custody, authorization and audit | WP1 | V03, V04, V15 |
| [WP3 #257](https://github.com/snaraj/obsync/issues/257) | Native plugin bridge, first setup, pairing and local disconnect | WP1–2 | V05–V08, V16 |
| [WP4 #258](https://github.com/snaraj/obsync/issues/258) | Device inventory, rename, policy acknowledgement, revoke/archive | WP1–3; 1.1.5 #247 | V07–V09 |
| [WP5 #259](https://github.com/snaraj/obsync/issues/259) | Storage/quota/maintenance and explicit deployment adapters | WP1–2 | V11–V13 |
| [WP6 #260](https://github.com/snaraj/obsync/issues/260) | Complete backup, isolated restore, credential fencing, upgrade/removal lifecycle | WP2, WP5 | V14–V15, V18 |
| [WP7 #261](https://github.com/snaraj/obsync/issues/261) | stdio MCP, client adapters, agent instructions, shared human/machine presentation | WP1–6 catalog surfaces | V02, V10, V16–V17 |
| [WP8 #262](https://github.com/snaraj/obsync/issues/262) | Independent live campaign, latency/resource evidence and final distribution checks | All shipped packages | All applicable scenarios |

WP1 can establish the contract while WP2/3/5 designs proceed in parallel. Auth
and operation durability precede mutation tools. Compose the finished work for
one release; respect the three-PR budget rather than opening eight artifact PRs.

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

Resolve the existing repair-schedule discrepancy while updating validation:
architecture §6.2.3 describes six hours between completed repair walks and five
minutes after a failed step, while validation still describes five-minute walks.
Measure the candidate and make its docs agree; do not choose a timing claim from
the more convenient sentence.

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
