# CLI and MCP: security contract for staged delivery

Status: design requirement, reconciled 2026-10-02; not an implemented or verified security
claim. Applies to every work package in [#254](https://github.com/snaraj/obsync/issues/254)
and the [CLI/MCP design](../design/cli-mcp-v1.1.6.md). Extends, and cannot weaken,
the [product threat model](../threat-model.md) and repository requirements.
The baseline is released 1.1.5 at `03d108505d3993bddff276d70c814a6547222339`.
The current milestone delivers offline CLI, management auth, existing-server
native setup/device lifecycle and MCP observe. Storage/deployment/full recovery
requirements remain here for the deferred #259/#260 scope; they are neither
implemented nor waived.

## 1. Security takes precedence

The CLI is part of obsync's security boundary, not a convenience wrapper outside
it. MCP exposes that same boundary to a less predictable caller. Security,
confidentiality and recoverability take precedence over fewer setup steps,
performance targets and the release date. If a capability cannot meet this
contract, leave it unavailable and narrow the advertised scope explicitly; do
not ship a bypass, permissive fallback or reassuring but unverified status.

No flag, environment variable, configuration entry, agent instruction or MCP
annotation may disable authentication, authenticated origin checks, replay
protection, content encryption, integrity checks, durability or fail-closed
behavior. `--yes`, unattended mode and a plan digest are not authority.
Tests establish implementation evidence; only observed live outcomes satisfy
the corresponding [security acceptance gates](../validation-plans/cli-mcp-v1.1.6.md#security-acceptance-gates).

Before implementation, independently review the management-authentication
protocol, runtime/installer choice, trust boundaries and operation permission
matrix. Before release, the repository's independent adversarial review and
live evidence must both pass. The selected runtime is pinned Node built-ins with
zero npm runtime packages; the first CLI artifact PR must record that narrow
exception in AGENTS requirement 5. This document grants no live infrastructure,
production deployment or destructive-test authority.

## 2. Assets, actors and trust boundaries

Protect content keys and plaintext; management and deployment credentials;
device/grant identities; stored ciphertext, history and revocation state;
approved plans; installation/update integrity; and the availability of ordinary
sync. Administrative metadata, backups and diagnostic evidence are private too.

| Boundary | Required property |
| --- | --- |
| Agent/model to CLI or MCP | Treat requested actions, tool results and workspace material as untrusted input; only independently granted permissions authorize effects |
| CLI to server | Authenticate the configured HTTPS origin and expected server instance; enforce scopes, target, expiry and replay rules on the server for every operation |
| Management to content-owning plugin | Management authority supplies no content key or pairing approval; the explicitly selected native client retains the trust decision |
| CLI to local files and deployment adapter | Independently granted local authority, exact owned targets and typed operations; a server grant never supplies host, container-engine or cluster privileges |
| Installer to runtime and helpers | Authenticated publisher provenance, verified bytes and supported runtime; no execution selected by workspace or server data |
| Backup to restored deployment | Integrity, trusted provenance and credential fencing before reachability; restore never silently broadens authority |

Consider mistaken or manipulated agents, untrusted repository/configuration
files, misleading device labels/logs, invalid or revoked grants, other local
users, untrusted network peers and interrupted operations. The trusted computing
base includes the selected OS account, runtime, executable and approved native
plugins. The server and TLS terminator remain trusted for enforcement and
metadata under the existing threat model; a compromised server administrator
can defeat server-side authorization and local audit. Server blindness protects
content keys, not availability or every metadata fact.

**Local stdio is not a sandbox.** An agent with unrestricted shell/file access
under the credential-owning OS user can access that user's files outside MCP.
Mode 0600, Windows ACLs, hidden tools and an MCP allowlist do not isolate the
owner from that agent. Do not advertise that guarantee. Stronger AI workload
isolation requires a separate OS/container/VM identity, restricted mounts and
only its scoped credential; no vault directory, owner credential store,
container-engine socket or ambient cluster credentials. Host administrators
remain trusted. Prove each advertised isolation recipe on its actual platform.

## 3. Secure defaults and permission enforcement

Default MCP is metadata-only for one explicit context. Fresh workloads receive
short-lived, least-privilege server grants with no deployment authority. A
write-capable process is a separate explicit choice; selecting a profile does
not grant credentials or widen a server grant. Enforce authorization inside the
shared dispatcher and again at the authoritative server/plugin/adapter boundary,
not only by hiding commands or tools. Deny undeclared operations and fields.

Each catalog operation must name its exact resource, required server and local
permissions, secret classification, destructive effect, approval class, expiry,
retry/cancellation rules and verification evidence. Authorization covers nested
effects too: a setup workflow cannot smuggle a grant or deployment mutation into
an otherwise permitted read. Inventory and private-detail projections require
their own scopes; failed authentication returns no private inventory.

Workload delegation cannot increase the parent's scopes, target or lifetime.
Revocation and expiry cascade through derived grants, enrollment handles and
sessions. Independent service grants require separate owner authorization,
not an automatic promotion when the approving device disappears. Rotation
has a bounded overlap and does not silently extend the old credential.
Running jobs recheck authority before each uncommitted privileged phase;
report already committed effects and cancellation limitations honestly.

Last-device, backup, restore, retention reduction, detachment and purge approvals
identify the approving principal, exact target/effect, plan digest, bounds and
expiry. Persist approval at a trusted authority the restricted agent cannot
edit. Tool-result text, workspace files and `approved: true` arguments cannot
create approval. A shared owner OS account cannot enforce a pretend external
approval boundary; require native/server authorization or an isolated operator
channel for owner-only actions. Avoid undifferentiated "allow all" setup.

## 4. Credential and connection custody

Never place credentials, vault keys, setup tokens or recovery material in model
context, argv, ordinary URLs, browser history, shell history, MCP configuration,
logs or public evidence. Config contains opaque references, not secret values.
Use exact owned OS credential entries where supported; otherwise document the
protected-file boundary, validate parent permissions and fail if protection
cannot be established. Do not claim encryption merely because a file is private.
Avoid persistent credential copies for ephemeral workloads; close protected
handles and remove owned temporary state after its documented lifetime.

Do not enumerate unrelated credential stores or infer trust from available
credentials. An adapter receives only its explicit credential references and
required handles. OS/runtime limitations on memory erasure must be documented;
do not promise guaranteed zeroization in a managed runtime. Support bundles and
failure paths use the same source-level redaction as normal output.

Browser/native enrollment binds initiating process, server, requested scopes,
nonce, expiry and one-time completion. Any local callback requires an explicit
transport/origin design and independent review; do not add a general listener
or assume loopback is authenticated. An agent's statement that a browser
approved the request is not proof. Bootstrap secret transfer must use a reviewed
protected channel or explicit native owner input. An unsupported safe handoff
returns `needs_action`; it never copies the setup token into automation output.
WP2/WP3 must provide a reviewed browser bootstrap path meeting this rule: the
existing dashboard's token-bearing sign-in URL is not such a path. Manual entry
alone does not prove that a subsequent request or browser history is secret-free.
Check the actual handoff, browser history and diagnostics; do not silently reuse
the legacy route for the new CLI enrollment ceremony.

Require verified HTTPS to the selected origin, including private deployments
with explicitly configured trust roots. Do not disable TLS checks for private
LANs or self-hosting. Bind grants to the intended server instance; unexpected
origin/identity changes require a new explicit context decision. Never forward
credentials across redirects or to metadata-supplied endpoints. Bound responses,
timeouts and redirects before processing; remote data cannot choose local
files, executable paths or credential references. The trusted terminator-to-
server hop retains the product's separate deployment protections.

## 5. Installation, execution and configuration

Verify release signatures/provenance against an independently established trust
anchor before executing installers, binaries, runtime bundles or updates. A
hash downloaded beside an artifact proves byte agreement, not publisher
authenticity. Bind version, OS/architecture and all executable components to
the release evidence. Refuse altered, untrusted or incompatible artifacts and
retain the previous usable installation. Downgrade requires an explicit supported
rollback plan and security/format compatibility check, never automatic fallback.

Before publication, candidate execution uses an explicitly trusted staging
build/signing path bound to source SHA and artifact hashes. Candidate provenance
does not impersonate the production publisher. V19 verifies production release
provenance and correspondence to the tested candidate; a rebuild with materially
different bytes requires reconciliation and affected live revalidation.

This new pre-execution verification guarantee covers the CLI/MCP package and its
managed executable components. Obsidian's Community Plugins installer does not
document verification of obsync's signed evidence. Native plugin installation
retains that separately disclosed trust model and the person's plugin-trust
decision; version/hash inspection afterward is not pre-execution verification.
If stronger plugin provenance is advertised, WP3 must first prove a supported
pre-enable verification path. Otherwise mark that guarantee unavailable, without
inventing an Obsidian API or bypassing native trust prompts.

The runtime decision must specify supported versions, security-update policy,
verification, launch environment and end-of-support behavior. Zero npm packages
does not remove runtime or installer risk. Do not introduce new cryptographic
primitives or a home-grown TLS protocol to avoid a dependency decision.

Resolve installed helpers and the runtime to verified explicit paths. Use typed
argument arrays without a shell; allowlist child environment and inherited
descriptors. Refuse unsupported runtime preload/hooks. Deployment children get
only selected context and required authority, not the parent's entire credential
environment. Explicitly supported proxy/trust settings retain HTTPS checks.

Do not automatically load configuration or instructions from the current working
directory. Explicit input files use closed, bounded schemas and remain data.
They cannot grant permissions, choose privileged executables, redirect credential
references or invent approval records. Trusted user-level configuration has its
own ownership checks and explicit change path. Importing it is a reviewed diff,
not execution. Server metadata and downloaded examples never become commands.

All local writes have exact targets: credentials, MCP client entries, operation
state, backups and restore/purge destinations. Validate protected parent
directories, ownership, link/reparse behavior and atomic replacement; preserve
unrelated entries. Canonicalizing a path string alone does not prove confinement
against concurrent filesystem changes. Define and test OS-specific guarantees,
including Windows semantics, and refuse an unsupported protection rather than
overclaiming. The existing native filesystem residuals remain documented.

## 6. Integrity, recovery and availability

Apply binds target identity, revision, values, digest and expiry under the
operation lock. Changes invalidate the plan. Durable operation/idempotency
records survive restart; expired plans never become fresh work when records
are compacted. A lost response means `unknown` until reconciled. Cancellation
does not imply rollback; report partial effects and safe next checks.

Backups contain private authentication and recovery state even when content is
ciphertext. Separate protected recovery material from ordinary inventory and
export. Authenticate backup provenance against a trust record outside the
archive; internal hashes alone cannot authenticate a replaced manifest. Verify
origin, snapshot identity, completeness, integrity and compatible restore
format. Imported configuration cannot select new destinations or execute hooks.

Restore stays isolated until a trusted newer revocation fence is applied, or
restored credentials are invalidated and trusted re-enrollment is established.
Credentials revoked after a backup must remain denied after cutover and restart.
Archive verification is not proof of native plaintext recovery. Preserve source,
backup and unrelated data on refusal; no automatic destructive cleanup.
An explicitly approved earlier recovery point cannot promise later data absent
from both surviving clients and other backups. Declare that loss/limitation
before cutover; never label it lossless recovery or discard available newer data.

Bound input bytes/depth, output, enrollment attempts, grant/job counts, concurrency,
polling, audit/operation retention and cancellation time. Define admission
budgets before implementation; metadata limits do not impose new content-size
limits. Administrative work must preserve ordinary sync capacity, device nonce
fairness and single-writer/storage admission rules. No timing test disables
authentication, replay checks, TLS, integrity, durability or audit requirements.

## 7. Human interfaces, logs and instructions

Use shipped, versioned catalog text for tool descriptions and next actions.
Remote labels, logs and error details are inert data, not privileged instructions,
approval requests or executable links. Bound and safely render control and bidi
characters; preserve clear JSON data boundaries. Human views label the actual
server/target and effect before approval; icons, familiar branding and a green
check must never impersonate trust or conceal `unknown`/partial outcomes.

Redact before data reaches output, telemetry-free diagnostics or agent-visible
streams. Do not rely on a model to remove secrets later. Record bounded,
structured event codes, decision, actor class, target alias, operation correlation
and duration without tokens, note paths, content or raw parser input. Private
detail requires explicit scope and selection. Human text and machine fields
describe the same event; neither implies stronger verification than observed.

Security-relevant mutations have a durable audit relationship to their effects.
Persist an authorized intent before dispatch and a result or reconcilable unknown
afterward; same-server effects should commit with their audit record. Refuse new
privileged work when required audit persistence is unavailable. For an already
dispatched external effect, retain the intent and report reconciliation needed,
not an unaudited success or invented rollback. Define retention and access;
ordinary server-local logs are not tamper-proof against a host administrator.

## 8. Ownership and release gates

Security is acceptance work inside every package. The table follows the staged
[delivery slices](../design/cli-mcp-v1.1.6.md#10-work-packages-and-documentation-delivery).
For each slice, take its live rows, these S rows and the budgets named by those
rows; the [computed unions](../validation-plans/cli-mcp-v1.1.6.md#delivery-slices-and-gate-unions)
name partial scenario boundaries. S08 and V10 rerun whenever a slice adds a
mutator, including local setup/client-configuration writes. P10 applies whenever
plugin or server behavior changes. A partial early receipt cannot close the
whole gate for a later capability.

| Package | Security responsibility | Live security gates |
| --- | --- | --- |
| WP1 #255, offline | Trusted runtime/install, closed local catalog/context/config and filesystem writes; network auth arrives in WP2 | S01, S02 (local target binding), S08 (context/config and offline export destination writes), S09 |
| WP2 #256 | Independently reviewed auth state model; least privilege, custody, grants, approvals, replay/expiry, logout and durable audit | S02, S03, S05, S07, S08 |
| WP3 #257 | Existing-server identity, native vault binding, protected bootstrap/bridge, 1.1.5 content-owner pairing and local credentials | S02, S04–S06, S08 |
| WP4 #258 | Effective revoke/expiry, grant cascades, existing archive/recovery guards and truthful policy state | S03, S06–S08 |
| WP5 #259, deferred | Independent deployment authority, exact storage confinement, admission and bounded maintenance | S03, S08, S10, S12 |
| WP6 #260, deferred | Trusted backups, recovery custody, restore fencing, safe lifecycle and purge | S01, S08, S10–S12 |
| WP7 #261, observe | Restricted read-only MCP processes, inert untrusted data, private diagnostics and safe local client configuration | S02–S05, S08, S09, S12 |
| WP8 #262 | Independent candidate security receipts, native platform coverage and published-byte verification | S01–S12 and V19 |

All packages also inherit every applicable cross-cutting requirement above.
For each security denial, observe the refusal and independently inspect the
protected state; absent tools or a nonzero exit code do not prove enforcement.
Required security evidence that is missing, ambiguous or stale is
`NOT_RUN`/`UNKNOWN` and blocks the affected advertised capability.

Non-waivable release invariants: no unauthorized effect or privilege widening;
no wrong-target mutation or secret disclosure; no management-only approval of
content access; no loss of acknowledged data during normal operation or
unapproved recovery-point regression during restore; no restored denied credential;
no false success; no install trust bypass; and no weakened product protections.
Performance exceptions cannot waive these invariants. Source tests, review,
candidate live behavior and post-publication verification remain distinct facts.

## Design references

Use the current [MCP security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
for transport-specific boundaries and minimal permissions; remote HTTP/OAuth
MCP remains outside this scope. The
[OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
supports deny-by-default, least privilege and checks at authoritative boundaries;
the [logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
informs sensitive-data exclusion and bounded diagnostic handling. These are
design inputs, not certifications or evidence that this proposal is implemented.
