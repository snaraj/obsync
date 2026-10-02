# CLI and MCP: live acceptance for staged delivery

Status: proposed delivery gates, reconciled 2026-10-02; **no scenario in this document has
been executed by the planning task**. Design and work packages:
[CLI/MCP specification](../design/cli-mcp-v1.1.6.md),
[security contract](../security/cli-mcp-v1.1.6.md),
[#254](https://github.com/snaraj/obsync/issues/254).

The intended result must be observed on the running server, the selected
deployment and the native application that uses it, within a measured budget.
Unit/contract tests, mocks, compilation, HTTP success, a process exit code, a
queued operation or an "Up to date" label cannot substitute for that observation.
This plan extends [existing native validation](../validation.md) and
[benchmarks](../benchmarks.md); it does not waive any existing gate.

### Delivery slices and gate unions

V01–V19, S01–S12 and P01–P10 retain their original identifiers. The separate
scenarios in `docs/validation.md` are called **VAL V1–V28** here, and its journeys
J1–J11 keep their names. The current milestone spans releases; the first CLI
artifact release is 1.2.0, with every later artifact PR taking one allowed step
from its current protected base. No table row is a version reservation.

These unions derive from the [work-package live rows](../design/cli-mcp-v1.1.6.md#10-work-packages-and-documentation-delivery)
and [security responsibilities](../security/cli-mcp-v1.1.6.md#8-ownership-and-release-gates).
A parenthesized boundary is a partial scenario, not a pass for its other portions.
Each PR prints its union and explains any subcase outside its implemented scope.
Cross-cutting security requirements still apply even when absent from a package's
short responsibility list. A new mutator always adds V10/S08; any plugin/server
change adds P10. Physical-device gates remain required for affected native work.

| Slice | Live union and boundary | Security union | Budget union |
| --- | --- | --- | --- |
| PR-3a / WP1 offline | V01, V02 (offline implemented commands and truthful unsupported workflows), V10 (local writes/interruption); #317 offline app-to-CLI archive open | S01, S02 (local target binding; server handshake unrun), S08 (context/config and export destination writes), S09 | P01, P03, P08; P10 if plugin/server changes |
| PR-3b / WP2 auth | V03–V04 (CLI/browser; real MCP host follows in PR-4c), V09 (management logout), V10 (grant mutators) | S02, S03, S05, S07, S08 | P03, P07, P08, P10 |
| PR-4a / WP3 native setup | V05, V06 (existing-server bootstrap/interruption), V07, V08 (local folders), V09 (local disconnect), V10, V16 (local config writes) | S02, S04–S06, S08 | P01, P03–P05, P07–P08, P10 |
| PR-4b / WP4 device lifecycle | V08 (inventory/rename/policy), V09 (revoke/archive), V10 | S03, S06–S08 | P03, P07, P08, P10 |
| PR-4c / WP7 MCP observe | V02, V03–V04 (MCP-host halves), V10 (observe/reconnect and refusal of mutators), V16–V17 | S02–S05, S08 (local config writes), S09, S12 | P01–P03, P08; P10 if plugin/server changes |
| WP5 #259, next milestone | V06 (new deployment/storage), V10–V13 | S03, S08, S10, S12 | P03–P10 |
| WP6 #260, next milestone | V10, V14–V15, V18 | S01, S08, S10–S12 | P03, P06, P08–P10 |
| WP8 #262, each release | All shipped portions above; V19 after publication | Union of shipped capabilities | Union of shipped capabilities |

V11–V15 and V18 are wholly deferred. V06's deployment/storage portion is deferred;
its setup-token handoff and interrupted first-account setup on a server already
running under Compose with trusted TLS remain in PR-4a. The existing Kubernetes
CI jobs continue to prove their own deployment layers. No production cluster is
part of this campaign. Future MCP write-profile portions of V02/V04/V08–V10/V16
are also deferred; observe must prove refusal and unchanged state today.

PR-2's native encrypted/plain export and offline opening use #317's acceptance
and proposed VAL V29–V31 plus affected native journeys. PR-3a adds the same
archive's offline CLI opening. These are exports of current notes by default,
with history opt-in; neither claims the full backup/restore covered by V14–V15.
The evidence matrix must show each portion as PASS/FAIL/NOT_RUN/UNKNOWN and name
its exact artifact. A deferred row is unrun, not waived or counted as a pass.

## 1. What a result means

Keep these evidence levels separate:

| Level | Evidence |
| --- | --- |
| Implemented | Source, schema and relevant automated checks exist |
| Exercised | The actual candidate was invoked through the promised interface |
| Server verified | Fresh independent readback establishes the intended durable state |
| Device verified | Native Obsidian shows the intended behavior and sentinel bytes agree |
| Performance verified | Recorded measurements meet the predeclared profile's budgets |
| Distribution verified | Public installation/update path installs the identified released artifacts |

Each scenario verdict is `PASS`, `FAIL`, `NOT_RUN` or `UNKNOWN`, with its evidence
levels listed. Missing hardware, an unreadable log or an interrupted observation
is not a pass. "Implemented" does not become "verified" because its test suite
passed. Baseline defects and regressions are named individually; no averaged score
can conceal lost data, unauthorized changes or false success.

Before testing, freeze the scenario set, platform matrix, fixture manifests,
network profiles, timing targets and observers. Revisions require a dated reason
and a new run; preserve the failed run. Do not lengthen a budget after observing
a failure merely to pass the same result.

## 2. Safety, environment and ownership

The implementation campaign uses approved disposable servers, accounts, volumes,
grants and vaults. Desktop and emulator fixture pairing may be driven through
the isolated lab; the user enters all physical-phone pairing codes. Physical
phone availability is not yet confirmed, so those rows remain NOT_RUN until an
identified physical device participates. Emulator results cannot close them.
Bounded stage-split and CLI-latency measurement on an isolated representative
arm64 server is in scope through documented access. It authorizes no production
deployment, restart or configuration change. Host privilege, destructive fault
injection and owner merges retain their separate authorization boundaries.

Create an inventory of exact campaign-owned targets before setup and cleanup.
No personal notes, existing paired devices or unrelated application settings are
test fixtures. Set maximum fixture bytes and storage use up front. Keep portable
harness source in the repository, but configure fixture/run roots outside it.
Generated vaults, datasets, raw run output and backups are never committed.
Public records contain only sanitized observations, commands and checksums;
private evidence has controlled access and a retention date. Reusable synthetic
fixtures may remain in an explicitly recorded external fixture root. Remove
other manifest-listed run state, verify absence and control-device health, and
report retained fixtures precisely. Cleanup never broadens beyond owned targets.

Co-editing experiments run on a separate pushed experiment branch that never
merges. Their design record cites each tested commit and command, including
failures. Experiment outcomes do not claim the deferred engine has shipped.

### Platform and route matrix

| Surface | Required coverage for the proposed claim |
| --- | --- |
| CLI installation, credentials and output | Local native macOS arm64; GitHub-hosted native Windows x64, Linux x64 and Linux arm64 (`ubuntu-24.04-arm`); additional advertised targets get their own runs |
| MCP | At least two actual independent hosts, including one coding agent and one desktop host; every named config adapter is exercised separately |
| Obsidian desktop | macOS, Windows and Linux, actual app and plugin build; preserve existing native requirements |
| Obsidian mobile | Each advertised physical Android and iPhone/iPad platform for setup/pairing, persistence, revoke and two-way sync; availability currently unknown; record iOS/iPadOS separately |
| Server | Linux amd64 and arm64, including a constrained arm64 machine representative of the supported server |
| Deployment | Current native bootstrap: already deployed Compose + trusted TLS. Existing kind/Helm and k3d CI retain their coverage. New storage/deployment adapters need full Compose/Kubernetes evidence in the deferred milestone |
| Network | Private LAN baseline; specified private remote route, including physical phone on cellular; measured limited-bandwidth/interrupted profile |
| Optional provider route | Only if advertised: its own TLS/reachability, transfer and applicable cost/privacy evidence; never substitutes for private-path proof |

VM, emulator and physical-device results are labeled separately. A Windows
plugin pass does not prove Windows CLI credential custody. Cross-compilation
does not prove Linux arm64 installation. Cover the important combinations:
each CLI OS for local behavior, each advertised MCP adapter, both server
architectures for administration, both deployment kinds for storage, and every
native platform for onboarding and persistence. Do not infer the full Cartesian
product from one happy path; record which combinations were exercised.

### Fixture sets

- S: 100 deterministic notes, Unicode/space-containing names, empty/nested
  folders, a 20 MiB attachment, an excluded folder and an unsynced local sentinel.
- M: 10,000 × 2 KiB notes, matching the existing benchmark workload; retain a
  manifest of expected names, sizes and client-side hashes.
- L: 2 GiB and interrupted 20 GiB desktop transfers, with a phone configured to
  demonstrate its actual per-file policy. No claim that a default mobile budget
  admits the 20 GiB file.
- H: Known heads, multiple retained versions, intentional tombstones, protected
  versions and GC-eligible versions; known expected recovery point.
- A: Several disposable devices and management grants: active, pending, expired,
  revoked, duplicate display names, last-active with and without recovery.
- D: Separate volumes for capacity boundaries, mirror failure and integrity
  scenarios. Maintain a healthy control server/device outside those volumes.

Fixture manifests and plaintext hashes stay client-side. Server evidence records
ciphertext identifiers and role aliases. Every test checks the excluded and
unsynced sentinel before/after. Synthetic notes are explicit so a sync probe
cannot quietly modify a real vault.

## 3. Required live scenarios

Each scenario uses the final candidate's real CLI or MCP, the running API and
the native plugin wherever applicable. An independent observer must not merely
repeat the same cached client result. Re-read the server through a fresh session,
inspect deployment/volume state independently, and use a second native client to
prove sync. Capture start, acknowledgement, completion and verification separately.

### V01 — Install, upgrade and remove the management client

On each advertised clean OS/architecture, follow only public installation
instructions, including the runtime prerequisite chosen in WP1. Install the
identified artifact, verify its signature/checksum/provenance, launch it and read
help/schema without credentials or repository access. Test paths with spaces,
no administrator privilege, restricted network and a missing runtime.

Upgrade from the supported previous client while preserving only intended
contexts/credential references. Uninstall removes the client and offers explicit
credential/config retention choices; it does not delete a vault or server.
Verify through a new terminal. Record download time separately from launch time.
Pass: correct installed bytes/version, offline discovery, actionable prerequisite
errors, preserved unrelated configuration, P01. P02 applies once MCP ships.
Before publication use the explicitly trusted source-bound candidate artifact
and supported staging provenance; repeat public-publisher verification in V19.

### V02 — Cold agent discovery and machine output

Start three fresh agent sessions per advertised workflow with only the shipped
instructions and installed executable. In PR-3a exercise offline discovery/schema,
local contexts/doctor and explicitly authorized offline export opening. In later
slices exercise the implemented existing-server, status and device workflows.
Capacity administration and MCP mutations must report unsupported in the current
slice; observe proves that refusal independently. Use duplicate device names where
inventory ships. Record operation/schema selection, clarification count, incorrect
calls, retries, model/client versions and time to the actual outcome.

Require discovery before unknown operations, exact-target selection and a real
verified result. No operator supplies hidden flags or edits commands to rescue
the run. Missing permission must produce the precise next action. Target: each
workflow completes without undocumented intervention and within its live budget;
model deliberation and tool execution are timed separately.

Pipe success, error, empty, paginated, truncated and interrupted output through a
strict JSON/JSONL parser. Check field types, schema version, units, continuation
and exit classes. Test `NO_COLOR`, redirected streams, non-TTY stdin and explicit
output overrides. `--non-interactive` never hangs for input or launches a browser.
Observe credentials are absent from results, logs and agent transcript.

### V03 — Human administration login and scoped workloads

Using the real browser authorization page, approve one matching request for one
server. Verify scopes and expiry in a new CLI process and actual MCP host. Cancel
and expire other requests. Wrong request code/origin and absent approval cannot
enroll an administrator. Browser sign-in remains separate from vault-key access.

Provision one scoped headless grant through the supported protected channel;
relaunch the machine/client and prove intended persistence and file/ACL protection.
An ephemeral grant leaves no credential file. Expiry/revoke stops the next live
request. Logout's local and server effects match its chosen mode. No application
or store inventory is used to discover a credential.

### V04 — Effective permissions across every interface

For each scope boundary, perform an allowed metadata operation and attempt the
corresponding unauthorized mutation through CLI and a real MCP host. Confirm the
server refuses and fresh state is unchanged. Profile changes, alternate commands,
output flags and direct use of the management API must not broaden permission.
Do not use an owner device credential underneath a purported read-only grant.

Check a revoked grant during a queued operation: safe work stops at its declared
boundary, committed effects remain visible, and cancellation does not imply undo.
Record authorization actor in audit evidence without exposing credential values.

### V05 — First Obsidian vault and an existing server

Create a disposable real vault. With only `obsync setup`, reach plugin installed,
enabled, configured and content-device active. Use native Community Plugins trust
and installation; distinguish a staged candidate installed by the test harness
from the public release installation tested in V19. Plugin generates its key and
confirms recovery custody in native UI. The agent sees completion metadata only.

Quit/reopen Obsidian and the management client. Independently inspect the selected
plugin's installed version and settings, and the server's exact active device.
Send fixture S to another native device, edit it there and observe the edit back
on the first device. Check disk bytes and the open editor. Pass only with restart
persistence, exact targeting, unchanged excluded files and P04/P05 timings.

### V06 — First-account bootstrap; new deployment/storage deferred

**Current PR-4a portion.** Start with an existing Compose server provisioned by
the lab, trusted TLS, empty approved storage and no content account or management
grant. Exercise the protected setup-token handoff and interrupted first setup
below, then V05 and restart persistence. Fix the first-account/management-auth
ordering in the independently reviewed auth design. Apply P04/P05 to native setup
and P08 to resumption. The current CLI neither provisions the server nor changes
its storage; a production server is not a fixture.

**Deferred #259 portion.** The following deployment steps run only when the
new-server/storage adapters ship:

For Compose and Kubernetes separately, start with approved empty storage and
the supported prerequisites. `setup` identifies missing prerequisites, renders
the requested target/volumes/capacities/TLS path and applies only authorized steps.
For GitOps, demonstrate reviewable output and `awaiting_external_apply`; then let
the authorized deployment workflow converge it.

**Shared bootstrap proof, required in PR-4a and deferred deployment.**
Begin with neither a content account nor a management grant. Exercise the actual
protected setup-token handoff or documented native owner-input fallback, expire
an abandoned handoff and interrupt first setup once. Prove secret material never
reaches agent output, and resumption does not blindly repeat enrollment.
Include interruption after durable server enrollment but before native credential
persistence. Inventory cannot recover the lost secret: require `needs_action`,
exact orphan attribution and one explicitly approved native recovery enrollment.
Verify the replacement's native persistence, restart and heartbeat before ordinary
revocation of the exactly bound orphan. Two active devices is a partial outcome;
completion requires one active replacement and a revoked orphan. Preserve the
last-device and recovery-age guards. An unidentifiable orphan, unavailable recovery
or another lost enrollment response stops in `needs_action` for reconciliation,
without repeated enrollment.

**Deferred deployment completion proof.** Independently inspect running image
digest, effective env/values, mounts, ownership, single writer, readiness and
trusted client reachability. Complete V05 and restart
the server; data and device state survive. A generated manifest without a running
service is not success. Record external approval/download time separately; apply
P06 to the portion the tool controls.

### V07 — Additional desktop and phone pairing

Pair physical Android and iPhone/iPad to an existing paired desktop, and a second
desktop. Match both native screens, approve in the key-holding client, collect
the envelope and prove active state exactly once. Close a modal, restart an app,
expire/reject a claim and interrupt enrollment before credential persistence in
separate runs. Resume safely without duplicate active identities or content loss.

An administration-only agent can guide/observe the operation but cannot supply
vault-key approval. After success, restart the app and exchange two sentinel edits
in both directions. Approval or URI launch alone fails this scenario. Record
mobile human actions and P04/P05 timing independently.

### V08 — Device management and effective policy

From CLI, list, inspect and rename a device with a duplicate display name;
mutate only its full ID. The current MCP observe profile reads the result and
refuses rename/policy writes with independent unchanged-state evidence; MCP write
execution remains deferred. Observe server, dashboard and native UI agreement.
Request a device budget change, keep the target offline, and verify the result
says `pending_device`. Reconnect it, observe applied revision and exercise a
file at the boundary. Heartbeat and app restart must not revert the policy.

Change local selected folders through the target plugin, then widen/narrow and
restart. Preserve excluded/local unsynced data and the existing scope/replay
journeys. No other device's selection changes. Limits and selection must not be
presented as server authorization. Apply P03/P07 and native propagation budgets.

### V09 — Revoke, archive, logout and disconnect

Keep a test device actively syncing and a control device healthy. Create a
dashboard session and an unspent dashboard link from the test device. Revoke it
through CLI. MCP observe reads the result and refuses a revoke attempt on a
separate still-authorized device; verify that device remains active. Repeat an
actual MCP revoke only when a future write profile ships. Prove a fresh target
request is refused, its related session/link no longer works, and the control
device still exchanges notes. Allow already-committed work only as documented.

Test last-active refusal without registered recovery and the supported recovery
case with it, including the seven-day `recovery_too_new` guard. Archive a revoked entry: it leaves the default list, appears under
the explicit filter, preserves history and remains unable to authenticate after
server restart. Test local management logout and plugin disconnect separately;
all local notes remain. Re-pair explicitly and verify the intended new identity.
No interface may promise remote erasure. Apply P07.

Revoke/expire a parent management grant and the device whose authority approved
it. Confirm dependent grants cease working and cannot extend their lifetime
through a child; an independently owner-enrolled grant follows its explicit
policy. When #260 ships, also check backup/restore/purge permissions separately from
ordinary maintenance.

### V10 — Operation durability, interruption and concurrency

For the offline slice, exercise context/config replacement and plaintext export
opening into an explicitly selected disposable destination. Interrupt each local
write at its declared stages and restart the CLI. Verify atomic/recoverable
results, exact destination confinement, unchanged unrelated files and truthful
partial/unknown outcomes. No lost response or rerun may overwrite an unrelated
file or treat a partial export as complete. P03 applies only to later remote
reads; local progress and recovery use P08.

Using benign campaign operations, drop the response after dispatch, close the
MCP client, stop the CLI while waiting and restart the server during recoverable
job stages. On reconnect, the same operation reports its actual result. No old
GC/scrub summary satisfies a new job. A repeat with the same idempotency key and
input resolves to the original operation; changed input is refused.

The following coordinator backup/restore subcase is deferred with #260. Stop the
lifecycle coordinator while its target server is stopped for backup or restore. A fresh CLI/MCP process must reopen the protected adapter-side record,
acquire its operation lock and reconcile the same job independently. Repeat a
key after plan expiry and receipt compaction: it must refuse as expired, never
silently execute the mutation again. Replanning first checks the actual effect.

For every current or deferred mutator, submit two conflicting plans from
independent callers. Revision checks admit only
the valid transition; the stale plan states the new facts and needs replanning.
Exercise deadlines, cancellation, expired operation retention and bounded history.
Observe `partial`/`unknown` when appropriate, then resolve with independent
readback. At every point check that acknowledged data persists and progress/exit
semantics meet P03/P08. These are authorized functional interruption tests on
isolated instances, not tests against another party's service.

### V11 — Storage inventory, quota and capacity admission (deferred #259)

Read CLI, MCP and dashboard inventory, then independently measure the campaign
host/mounted volumes. Verify declared capacity, tracked usage, physical capacity,
available space, quota and device budget are distinguishable with freshness and
source. Remove measurement access and require `unknown`, not invented values.

Exercise quota and watermark boundaries only on isolated volumes. Confirm a
refused write is not acknowledged, existing bytes remain readable and the control
device remains safe. Apply a valid quota/space remedy and prove ordinary writes
recover. Repeat after restart and against an unverified accounting state. Lowering
quota does not erase content. Apply P03/P07 and compare counter definitions exactly.

### V12 — Real storage/configuration/deployment changes (deferred #259)

For each advertised adapter, preview and apply retention, watermark and scrub
rate changes. Prove effective values after required reconciliation/restart, and
prove invalid or stale plans leave prior state intact. Check that GitOps remains
the authority in its mode. Run one actual supported expansion and prove physical
volume size, mounted filesystem size, server declared capacity and newly admitted
sentinel writes all agree. A PVC request alone is incomplete.

Add a mirror, interrupt copying, resume, verify required ciphertext copies, then
drain/detach through the supported procedure. Migrate a small volume to another
approved empty destination with one writer and retained history intact. An adapter
without support must return a concrete external step and cannot claim verified.
Include removal and failed restart recovery; use P06/P09 budgets.

### V13 — GC, scrub, quarantine and actual repair (deferred #259)

Run GC through CLI and MCP on H. Track the requested operation to completion.
Check eligible ciphertext/history is collected and protected heads/versions still
open on a native device. Verify observed reclaimed bytes against the collector's
accounting model; a changed counter alone is insufficient.

On specifically authorized D fixtures, introduce one known corrupt ciphertext
copy offline. Scrub must detect it. Test healthy-mirror restoration and unmirrored
quarantine separately. A paired device holding matching content must restore the
missing ciphertext, and another device must retrieve correct plaintext. Also
test absent/edited source and large-file mobile capability refusal: unresolved
repair stays visible and never becomes healthy because a pass ended.

Record rate, scheduled pauses, queued time and completed-pass coverage. Set the
P09 deadline from actual scheduling semantics before running. The 1.1.5 source
has a six-hour completed repair-walk interval, five-minute failed-step retry and
a separate five-minute filesystem walk. An on-demand check proves none of those
periodic intervals. Observe the claimed background interval or state it
unverified. Do not change clocks on a live server to accelerate retention tests.

### V14 — Full backup and isolated restore (deferred #260)

Create a full H+S backup through the supported stop/snapshot path. Verify the
manifest includes both volumes, every retained ciphertext dependency and required
external server-key custody. Keep all secrets out of ordinary output. Restart the
source and prove it still serves; the backup's recovery point is explicit.

Restore onto a separate empty server, check package integrity, replay and readiness,
then enroll an authorized fresh native client. Download current and retained
versions and compare plaintext against the fixture manifest. Verify tombstones,
folders and selected history, not just current file count. A CLI `backup verify`
checksum result cannot stand in for this journey. P09 includes data-transfer time.

Test incomplete backup, missing protected key material, incorrect destination,
insufficient capacity and interrupted restore. Original backup and source remain
usable; partly restored state is not exposed as ready. Offline `check`/`export`
operate on a disposable restored copy and are classified as mutating.

### V15 — Restore fencing, clients ahead and credential recovery (deferred #260)

Take a backup, then revoke a test device/grant and create later edits/deletions
on healthy clients. Restore the old backup. Before it becomes reachable, execute
the selected fencing policy: reconcile an independent newer revocation ledger,
or invalidate restored credentials and use trusted recovery enrollment.

Prove the post-backup revoked credentials remain refused after cutover and restart.
Exercise accounts with and without registered recovery; an unrecoverable case
must stay isolated and explain the required owner action. Observe existing clients
ahead of the snapshot: preserve later notes, honor documented deletion recovery,
avoid duplicate/conflict storms and prove two-way sync afterward. Keep every loss
or limitation visible. Recovery success cannot be declared solely from `readyz`.

### V16 — Real MCP hosts and configuration lifecycle

Install the shipped MCP entry into each advertised host without overwriting its
existing config. Record host version, executable digest and actual negotiated
protocol. Exercise supported 2026-07-28 and older initialization-based paths with
real hosts that implement each; unsupported revisions refuse clearly.

In at least two independent hosts, discover schemas/resources, inspect status
and device metadata, read existing authorized operation progress, disconnect/rejoin,
expire a credential and verify denial. Observe exposes no setup, revoke, storage,
backup, sentinel-write or cancellation tool. Attempts through alternate names or
arguments cannot widen it; record refusal and unchanged state. Compare reads with
CLI and a fresh native/dashboard observer. Later write profiles repeat the full
authorized mutation portions before advertising them. Catch startup/update/error messages polluting
protocol stdout; the entire captured stream must parse as the selected protocol.

Test config paths with spaces, existing custom obsync entries, removal, host restart,
missing runtime and missing Obsidian bridge. No token appears in config/transcript.
No sampling, dynamic-tool or task extension is required to finish a core workflow.
Apply P01/P03/P08 and report model deliberation separately.

### V17 — Actual human interfaces, logos, icons and logs

Use real terminals at 80 and 120 columns plus a narrow window; check light/dark,
`NO_COLOR`, plain ASCII, large text and a screen reader. Use native plugin mobile
and desktop surfaces, the dashboard and MCP host tool cards. Check all meaningful
states: waiting, queued, working, pending device, completed-unverified, checked,
refused, partial and unknown. Icons supplement readable labels in every state.

Reuse the existing obsync rings; inspect their legibility at 16/24/32 pixels and
the host's actual icon size. Text-only hosts remain fully understandable. Check
keyboard focus, accessible names, contrast and 200% text. Long/duplicate device
names cannot hide the exact target or action. No terminal escape/control text
from a label changes the rendered interface.

Give a person new to obsync the shipped messages and ask them to distinguish
"revoked", "signed out locally" and "waiting for phone"; add "backup checked"
and "restore verified" when those capabilities ship. An unavailable novice
reader leaves this row NOT_RUN. Failure to explain a shipped meaning is a UX defect. Errors state known
effects, uncertainty and the next action. Progress has real units/age/denominator;
no stalled spinner or synthetic ETA substitutes for a status.

Inspect the same event as human prose and JSONL: code, decision, actor class,
duration and budget agree. Credentials, recovery phrases and private notes never
appear in recorded evidence. Server/administration logs and ordinary MCP output
remain content-blind. Synthetic sentinel names/text may appear in client-side
captures needed to prove native rendering; clearly label that fixture data.
Capture real screens under the repository's capture/redaction rules; obtain
fresh owner captures for changed plugin/dashboard surfaces as required by AGENTS.

### V18 — Upgrade, rollback limits and graceful server lifecycle (deferred #260)

Use an identified existing release, H+S and paired native devices. Upgrade through
each supported deployment path to the candidate's exact digest. Prove configuration,
credentials, retained history and two-way sync survive. Test graceful stop/restart
with queued work. Verify unsupported downgrade/format combinations are refused;
run rollback only on a documented compatible path with a recovery point.

Remove a disposable deployment with default data retention and prove the data can
be reattached safely. Separately test explicitly approved purge on campaign-only
volumes, with exact-target verification and stated irrecoverability. Purge is absent
from ordinary MCP profiles. Apply P06/P09; no owner production action is implied.

### V19 — Post-publication install and instructions

After owner merge and successful publication, verify immutable image/chart/plugin
and CLI/MCP assets against release evidence. Fresh users follow the public docs,
native Community Plugins install/update, CLI install and MCP setup without a
development checkout. Compare installed hashes/versions with candidate evidence.

For every artifact release, verify publication and the public installation path
for the capability it adds. After the last current-scope release, repeat compact
V03/V05/V07/V09/V16 using fresh state and the public artifacts. V11 joins that
round trip when deferred storage ships. Record the actual version installed,
including a newer native-distribution version; never attribute it to an older
candidate. A candidate staging pass is pre-release evidence;
this scenario remains pending until publication and installation actually occur.
Documentation/version mismatch or an unexercised installer blocks delivery claims.

## 4. Timing and resource targets

These are proposed acceptance budgets, not measurements or current product
promises. Freeze them with hardware/network profile before implementation
acceptance. Preserve stricter existing benchmark requirements where applicable.

| Budget | Target and measurement boundary |
| --- | --- |
| P01 local discovery | CLI help/schema/search: warm p95 ≤250 ms; cold process ≤1 s, excluding install download |
| P02 MCP startup | Process launch → usable discovery: ≤2 s on the supported host; measure host overhead separately |
| P03 remote reads | Request issued → full parsed current result: LAN p95 ≤1 s; defined private remote profile p95 ≤3 s |
| P04 small-note sync | Native save → matching peer bytes: existing B2 p50 <1.5 s and p95 <3 s; report open-editor visibility separately with p95 ≤3 s target |
| P05 onboarding | Ready server → two configured native devices + S verified: ≤5 minutes active operator time; after approval S initial sync ≤30 s desktop LAN, ≤60 s mobile LAN; report total wall time too |
| P06 small deployment change | Available predownloaded image/storage → readiness and verified S round trip: ≤120 s on reference Compose; ≤300 s reference Kubernetes, excluding explicit external approval with separate clock |
| P07 immediate changes | Submission → durable acceptance ≤2 s LAN; fresh observable state ≤3 s. Revocation permits no new credential acceptance after its durable commit; policy may remain pending while a device is offline |
| P08 progress and recovery | First status/wait reason ≤2 s; observed running status refreshed at least every 5 s; no-progress age exposed. Brief network recovery → S convergence target ≤10 s, with actual backoff shown if missed |
| P09 dataset work | Predeclare byte/count/rate-based deadline for each scrub/GC/copy/backup/restore; completion and native verification included, not only dispatch |
| P10 steady state | Five quiet minutes after convergence: no repeated identical mutations, duplicate devices/versions, unsolicited polling model turns or continuously increasing memory |

M gets its own fixed desktop/mobile first-sync deadline before the run, anchored
to existing benchmark results and the measured baseline. For L transfers,
calibrate sustained transfer rate on the same hardware/route, then freeze an
end-to-end bound including encryption, storage and peer materialization. Report
the raw deadline and derivation; do not retrofit it to candidate performance.
Server scrub at a configured 4 MiB/s cannot promise a 20 GiB complete pass in
seconds. Include scheduling pauses and pending work in the estimate.

For long jobs record time to first result, actual completion, independent proof,
total bytes/items, rate, peak RSS, CPU, network and storage I/O. Use a baseline
release and the candidate on the same fixture/hardware. Target no unexplained
>10% regression in existing sync p95/throughput or steady-state resource use;
an approved tradeoff needs explicit evidence, not a hidden budget change. Headless
MCP/CLI must not run a second sync engine or repeatedly scan note contents.

### Measurement method

1. One monotonic observer measures start/end whenever possible. Do not subtract
   unsynchronized clocks across machines. For screen/video observations record
   frame rate/resolution; for polling record interval and uncertainty.
2. Short operations: at least 30 recorded samples for each tested
   platform/network profile; nearest-rank p95, p50, maximum and error count.
   Five cold launches are separate from warm samples. Do not pool LAN and mobile
   results or silently discard timeouts.
3. Long jobs: three repetitions where practical, fixed fixture and hardware;
   if fewer, publish the count and limitation. High-risk restore requires three
   successful independent drills across the supported storage/deployment coverage.
4. Alternate baseline and candidate order to reduce cache/thermal bias. Record
   contention, RTT/bandwidth, disk type, free space, battery/power constraints and
   concurrency. Keep instrument-heavy profiling outside timed trials.
5. Time human waiting, downloads, external approvals and model deliberation
   separately from tool-controlled work, but always publish full wall time.
   Do not call a slow onboarding "fast" by hiding its dominant wait.
6. A cancelled, failed or timed-out sample remains in raw evidence and failure
   counts. Every unexplained overrun is triaged. Repeat only with a stated cause
   or changed candidate; never rerun solely to select a fast result.

## 5. Mandatory adverse and refusal matrix

Attach applicable rows to each scenario; record exact refusal and unchanged or
partial resulting state. Use bounded ordinary functional tests on isolated data.

| Condition | Required result |
| --- | --- |
| Missing/expired/revoked/insufficient grant | No unauthorized effect; structured next action and consistent server audit |
| Bad TLS trust or changed origin | No credential forwarding or insecure fallback |
| Wrong active vault, ambiguous device name | Exact-target refusal; no unrelated state touched |
| Plugin disabled, Obsidian unavailable/older, CLI unregistered | Precise supported handoff or capability absence |
| Unsupported server/API/MCP revision | Negotiated compatibility or clear refusal; no guessed commands |
| Stale plan/config/inventory | Refuse before mutation and expose new revision |
| Partial inventory/page budget | Explicit continuation/incompleteness; no "all devices" claim |
| Lost response/disconnect | Durable operation reconciliation; no blind retry of a nonrepeatable mutation |
| App/process restart | Credentials/settings/jobs persist according to contract; no duplicate enrollment |
| Full/read-only/unavailable/unverified storage | No acknowledged lost write; existing data and uncertainty visible |
| Incomplete/mismatched backup, missing protected key | Isolated refusal; source and original backup remain usable |
| Revocation after backup | Restored service remains fenced until the revoked identity is refused |
| Missing native observer or measurement | NOT_RUN/UNKNOWN; never inferred PASS |
| Host lacks icons, extensions or streaming UI | Core structured results and text labels still usable |

### Security acceptance gates

These cross-cutting rows attach to the existing V01–V18 scenarios; they are not
a substitute campaign or a claim of completed security testing. Each S row has
its own `PASS/FAIL/NOT_RUN/UNKNOWN` receipt, exact artifacts and platform coverage.
V19 repeats the applicable installation/trust checks on published bytes.
Candidate installation uses an explicitly trusted staging build/signing path
bound to the tested SHA/hashes; it does not require a not-yet-published production
release. V19 checks production publisher provenance and candidate correspondence.
Disclose native Obsidian installer trust separately; post-install inspection
cannot establish verification before execution.
Use only bounded, authorized functional checks and synthetic campaign data.

| Gate | Scenarios | Independently observed passing outcome |
| --- | --- | --- |
| S01 Trusted installation/update | V01, V18 | Installed bytes and publisher provenance agree with an independently established trust anchor. Altered, untrusted or incompatible candidates are refused; the prior installation remains usable. Verify runtime/helpers and rollback compatibility, not merely a colocated checksum |
| S02 Origin, identity and request authentication | V03, V04, V06, V16 | Intended HTTPS origin and server instance are authenticated. Failed trust or identity mismatch is refused before credential disclosure or mutation; no insecure fallback or silent retargeting. Invalid, stale and repeated management request proofs are refused without effects, including across server restart; a fresh authorized control request succeeds |
| S03 Least privilege and isolation | V03, V04, V16 | Fresh agent gets only approved metadata scopes. Unauthorized grant/device/storage/deployment changes are denied by their authoritative boundary, independent of tool visibility. A grant cannot broaden itself. An advertised isolated workload can read permitted metadata but cannot access unrelated vaults or deployment authority; record same-user/host trust limits |
| S04 Native bridge and local configuration | V05, V08, V16 | Only the approved installation/vault accepts handoff. Wrong-vault operations are refused; unrelated vaults, MCP entries and settings stay unchanged. Other OS users cannot access protected entries. Real native filesystem cases preserve exact destinations and recoverability; Windows semantics receive a native run |
| S05 Secret custody and audit | V02, V03, V05, V07, V16, V17 | Campaign-owned output/configuration/logs/transcripts/residue contain no credential, recovery material, pairing secret, auth header or vault key. Ephemeral credentials leave no persistent copy. Each privileged effect has durable intent/result evidence or explicit reconciliation; unavailable required audit persistence refuses new privileged work |
| S06 Content-owner approval | V05, V07 | Pending, rejected or expired enrollment cannot sync. Management permission alone cannot grant content access. Native approval, envelope collection and protected persistence are separately observed before calling onboarding complete. Distinguish server activation on envelope collection from native persistence; a failed persistence is reconciled/revoked rather than reported complete |
| S07 Effective revoke/expiry | V04, V09 | Fresh requests after durable revocation/expiry fail; linked grants, sessions and handles lose access. A control device still works. Archive/restart cannot restore access; jobs stop at their declared authorization boundary and report committed effects |
| S08 Plans, retries and authority | V05–V06, V08–V10, V12, V16, V18 | Changed/expired/cross-target plans fail before effects; tool arguments or local workspace data cannot create owner approval. Repetition resolves to the original operation; response loss and cancellation cannot silently duplicate destructive effects or produce false success. Independent readback resolves uncertainty where possible |
| S09 Untrusted data stays data | V02, V16, V17 | Synthetic labels, logs, server descriptions and explicit input files cannot become commands, privileged instructions, credential selections or approvals. Human rendering remains readable, machine fields preserve data boundaries and unrelated working-directory files cannot alter executable/identity/target selection |
| S10 Storage integrity/confinement | V11–V14 | Only authorized campaign storage is affected; single writer and admission remain enforced. Refused writes are not acknowledged as durable; protected heads/history remain recoverable and unrelated data unchanged. Interrupted destination writes preserve recoverability and cannot escape the selected target |
| S11 Recovery preserves denied access | V14, V15, V18 | Untrusted, wrong-origin or incomplete backups stay refused/isolated with source and backup intact. Restore cannot broaden configuration authority; its credential fence precedes reachability. Post-backup revocations survive cutover/restart, and an authorized native client recovers plaintext |
| S12 Availability with protections enabled | V04, V10–V13, V16, V18 | Bounded ordinary concurrent work and controlled interruptions preserve declared sync latency/availability. Refusals and queues have documented limits; CPU, memory, input/output and history stay within budgets. TLS, auth, replay, integrity, durability, permissions and audit remain enabled throughout every timed run |

For every denied effect, collect both the requesting client's refusal and
independent before/after proof that protected state did not change. Hidden MCP
tools, client-side rejection and a nonzero exit alone cannot prove server or
adapter enforcement. An observer must use independently authorized read access,
not broaden the restricted test identity. Include a working control client so a
broken service cannot masquerade as successful permission enforcement.

Security fixtures and evidence are campaign-owned and synthetic. Do not collect
unrelated local files, credentials or private user content to prove isolation or
redaction. Capture only the exact approved surfaces, with private raw evidence
outside the public repository. State any runtime/OS limitation explicitly.

Non-waivable invariants: no unauthorized effect, privilege widening, wrong-target
mutation, secret disclosure, management-only content approval, lost acknowledged
data during normal operation, unapproved recovery-point regression during restore,
revival of denied credentials, false success or install trust bypass. An explicitly
approved older recovery point cannot recover later data absent from surviving
clients/backups; name that limitation and never claim a lossless recovery.
Never weaken product protections to meet a time budget. A required S row left
`NOT_RUN` or `UNKNOWN` blocks its advertised capability; no aggregate pass rate
or performance exception can hide it.

## 6. Evidence receipt and independent review

### Useful checks before push

During edits, run focused checks for the changed behavior. Before each code push,
run the canonical local gate once and a small affected-journey smoke in actual
Obsidian through a reproducible repository command. Docs-only ranges retain the
repository's relevant-check rule. Do not replace `make check` or lower coverage,
plugin-test or future CLI-test floors to meet a clock target.

The proposed **five-minute warm pre-push budget is an unmeasured target**. Time
the canonical gate and app smoke separately on the selected host before freezing
that budget. A failure, timeout or exceeded budget remains in the record. Reduce
repeated setup or redundant work using measurements; do not hide skipped checks
inside a success exit. The smoke uses disposable external fixtures, compares peer
bytes and open-editor contents, checks excluded/unsynced sentinels and inspects
relevant settings, status, notices and console. Include an affected refusal or
interruption when that is the changed behavior. A simulated Vault pass cannot
stand in for this app result.

Long native platform/mobile journeys, complete mutation campaigns, sustained load,
large datasets and public installation run at their relevant review/release gates.
Before asking for review, mutate every new guard and resolve the hostile self-review
findings. A small smoke does not close those full campaigns. Retain unit tests
that catch crypto, authorization, durability or distinct regressions; remove only
redundancy whose failure detection remains demonstrated, without reducing floors.
Record line counts and runtime overhead with each optimization. Keep all product
protections enabled, and rerun evidence affected by subsequent changes.

### Final receipts

Create a dated record under `docs/validation-runs/` for each final campaign,
using the repository's existing privacy/capture convention. Private raw evidence
stays outside the repository; publish sanitized observations and checksums.

Each scenario record includes:

- Scenario/run ID, operator/reviewer role and selected capability.
- Applicable security-gate IDs, threat boundary, least-privilege test identity,
  control client and independently authorized observer; approved isolation model
  and residual limits. Record which protections stayed enabled during timing.
- Source SHA; server image/chart digest; CLI/MCP bundle hashes; plugin asset
  hashes; installation channel; OS/architecture; Obsidian and MCP host versions.
- Network/deployment/storage profile, fixture seed and manifest checksum,
  initial state, exact target alias and required permission class.
- Redacted command/tool input, schema/protocol version, plan digest/revision,
  operation handle and expected effect. Never credential values.
- Observation start, acknowledgement, completion and verification; observer
  identity/method, resolution, data freshness and independent readback.
- Raw timing samples, p50/p95/max, budgets, failures, resources and baseline.
- Native screen/editor proof and byte comparison where relevant; before/after
  invariants for excluded data, local unsent edits, heads, tombstones and devices.
- PASS/FAIL/NOT_RUN/UNKNOWN with limitations, evidence links/checksums, cleanup
  result and known retained disposable state.

An independent reviewer reproduces critical onboarding, revoke and restore
outcomes on the candidate and checks that receipts prove their claims. The
ordinary repository source/CI/adversarial review is still required separately.
Live validation must not be replaced by a review of its script or screenshots.
The security review additionally checks effective authorization denials, trusted
installation, secret custody and recovery fencing at the actual boundary; scope
the reproduction to campaign-owned systems and preserve all failed receipts.

Any artifact change invalidates evidence for behavior it can affect. Changes to
shared authentication, state transitions, storage or transport rerun their whole
dependent journey set. Documentation-only edits can reuse unchanged artifact
evidence but must recheck affected instructions. Final publication checks bind
the released bytes to the candidate before evidence is carried forward.

## 7. Release exit and delivery record

Before declaring the candidate ready: every applicable V01–V18 scenario has actual
evidence, native outcomes pass, required budgets pass or have an explicit reviewed
scope decision, and independent review agrees. A missing required device/client
is a release evidence gap, not a reason to mark its row optional retroactively.
V19 remains explicitly pending in the candidate receipt until publication; it is
the post-publication delivery gate, never marked inapplicable to avoid the wait.

All applicable S01–S12 security receipts are also required. Security precedes
convenience, speed and schedule; scope/budget decisions cannot waive the security
contract. Any narrowed feature/platform claim is explicit before publication,
not a retroactive relabeling of a failure as a pass.

Block release claims for lost/overwritten sentinel data, unintended deletion,
unauthorized effects, leaked secrets/content, false success, hidden unknown
outcomes, broken native setup, unsupported advertised platforms, failed recovery
fencing, unproven restores or unexplained timing failures. Human readability and
machine parsing are required acceptance dimensions, not cosmetic follow-ups.

After the owner merges: verify exact-main checks, immutable publication, public
CLI/MCP install and native plugin distribution in V19. Deployment/cutover is a
separate authorized result. The final delivery record states which of source,
candidate live behavior, performance, publication, installation and deployment
are proved. Until then describe the work as planned, implemented or candidate
verified, whichever the evidence actually supports.
