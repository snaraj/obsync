# E2EE assurance: October 2026 implementation checkpoint

2026-10-12. Scope: [audit #344](https://github.com/snaraj/obsync/issues/344),
[approved plan candidate](https://github.com/snaraj/obsync/blob/83549f4c9580ccf1eb7bd75cf62795ef08261bda/docs/security/e2ee-audit-plan.md),
and implementation [PR #347](https://github.com/snaraj/obsync/pull/347).
This is author evidence, not an independent security verdict or completed audit.
The protected baseline is `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0` (1.1.7);
the composed candidate extends `adfd2fd3e59e0930adec9a3d51b84b9125091b43`.
Exact artifact hashes, commands, failed intermediate results and native limits
are in the [validation record](../validation-runs/2026-10-12-security-train.md).
The focused independent F6 assessment of `c1d60b89` accepted the implemented
mode/context composition, strict recovery, and the reproduced durable-floor
and rotation boundaries. It does not approve the whole PR. It retains the
quantitative model as a conditional analytical horizon, and identified a stale
deployment-test refusal expectation. The repaired local API probe and hosted
ARM64 Compose acceptance pass at `bb290bcb`; later heads retain their own
hosted gate requirement.

## Claim-to-evidence map

“Exercised” below means the named cases passed, not that every attack is
excluded. Each row retains its remaining acceptance rather than converting
unit-test success into a whole-product approval.

| Plan invariant | Current evidence | Remaining acceptance |
| --- | --- | --- |
| E01: content and names stay private | Real plugin engine/server: 21 ordinary and hostile flows, including fresh-root rotation and legacy recovery/upgrade; captured traffic, storage and diagnostic scans; two planted controls. Derived current SIV keys are inventoried and used for actual ciphertext readback. Native desktop sync/custody has separate evidence; its latest run carries no complete wire/key inventory. | Final physical-phone and any later runtime artifact; native keys are not inventoried. Sizes, timing, graph shape, labels and same-domain equality remain visible. |
| E02: server/API authority cannot derive content keys | Existing key separation plus real-ciphertext API-secret/account-recovery-proof refusal, followed by successful content-key decryption. Server-export content-key input removed. | Independent source audit of all acquisition/exfiltration paths and composition assumptions. |
| E03: pairing gives the root only to the approved recipient | Existing v2 commitment, fixed claim, ECDH/secret-bound suite-2 envelope, mandatory sealed vault details and screen comparison; missing, mixed and unknown suite variants refuse. Creator notices identify spoofable server status, with a corrupted-envelope/spoofed-row control. The native driver now requires matching visible comparison codes on both devices before approval; real Obsidian 1.13.7 exercised that path. | Independent malicious-relay review, including every proposed rotation enrollment change. The native honest comparison and injected driver failures are not a coupled native malicious-relay journey. |
| E04: authenticate before publication | Real manifest, parent and chunk corruption refusal; unchanged accepted bytes/state; damaged chunk parks durably while valid siblings progress; honest retry restores exact bytes. Mutations kill normalization and retry removal. | Independent assessment of the complete receive/control surface, beyond these exercised routes. |
| E05: recovery separates content from account authority | Recovery/API-proof decryption negatives; one-frame server authority; strict occupied-account recover-only admission; client root staging, authenticated account/map readback and save acknowledgement. Complete prefixed backups are used by live setup/recovery/pairing/rotation. The real-engine legacy upgrade reads back preserved plaintext after commit; actual desktop UI upgrade and old-generation sibling restoration pass on the final bundle. | Whole-protocol review and physical-phone acceptance; broader native recovery failures remain distinct from the completed legacy journey. Lost one-time enrollment responses can leave unused server credentials; they do not justify automatic retries. |
| E06: custody and diagnostics | Closed error-code messages, explicit detail consumers, relative filesystem/control-character redaction and focused mutation controls. Current-format custody refuses missing/copied/torn pins and withholds replacement identity until save acknowledgement. Repeated simultaneous macOS runs exposed raw root-bearing storage through the public host API. The owner-approved desktop wrapper now encrypts the entire owned envelope through the fixed native bridge before public persistence, requires protected availability and migrates exact owned legacy entries before sync. Actual Obsidian 1.14.4 passes simultaneous setup/sync and both application restarts with independently decrypted native packets and matching identity/generation pins. Its explicit unavailable-service control visibly refuses with zero product writes, metadata saves or requests and no adopted root. | Required hosted acceptance on the pinned desktop platforms remains open; the local unavailable-service injection is distinct from the actual Linux no-keyring leg. The public API still has no encrypted-only write contract; the private bridge is a compatibility constraint. Readback is not joint crash durability or secure erasure. Physical-phone custody remains open. Arbitrary free text is not universally sanitized. |
| E07: revocation matches its selected guarantee | Per-removal access-only/rotation choice is implemented. Real-engine tests prove access-only retained-key decryption and old-root failure against actual new-generation ciphertext. Prepare/commit require separate owner-token authority, complete reseed/readback and locally pinned context. Actual old binaries refuse the durable format marker after normal floor-log pruning; removing only that marker makes both controls open the legacy fallback. Three actual desktops exercise targeted removal, prepared/catalog restarts, retained-peer re-pairing and two-way byte readback; the excluded instance retains old bytes and refuses sync. | Independent whole-protocol approval and remaining fault coverage; physical-phone acceptance. The native server refusal is distinct from the direct-ciphertext old-root proof. Only transitioned clients obtain future-content separation; copied plaintext and old/offline branches remain. |
| E08: integrity is distinguished from freshness/attribution | Corruption and visible fork refuse; authentic sole-head map rollback remains readable in a deliberate regression demonstration. Docs distinguish shared-key authority from a device signature. | Independent replay/rollback/omission review; no global latest-state or server-independent availability guarantee. |
| E09: key/nonce composition and lifetime | [Inventory and implemented AES-SIV replacement](e09-key-nonce-inventory.md). Live wrappers use counted context, context-hash HKDF info and the full context as AD. Published vectors, full-mode EVP comparisons and forced RNG failure/repetition controls pass. Focused independent review accepts the implemented component/live composition and reproduces the finite model's displayed terms. | The model remains a conditional analytical horizon, not an enforced operating profile or E09 PASS. Primitive/KDF terms remain unevaluated; complete protocol and device acceptance remain open. No aggregate offline quota or numeric whole-system failure probability is claimed. |
| E10: observations cannot silently pass incomplete | Scanner/recorder refusal tests, exact typed credential sinks, planted controls, manifest/traffic/storage linkage and closed inventories for three read routes. The expanded 104-case mutation batch passes at its recorded harness hash; the final synthetic-root fixture correction has separate affected controls and a restored 21-flow baseline. Engine/runtime kills require the intended first assertion. | Expand only for demonstrated new surfaces; the native scan and complete engine key inventory remain distinct. |
| E11: no alternate content-key access | Server-export key argument removed; API/admin surfaces retain their distinct non-content authority. No optional encryption/integrity bypass was added. | Independent whole-source/dependency/distribution review. Passing absence scans is not proof that no backdoor exists. |
| E12: failed invariants prevent delivery | E2EE is in the canonical local and hosted gate, with scanner/Make/workflow mutations. The owner assigned this security train to v1.1.8; the committed release classifier passes that step from 1.1.7. The desktop matrix is called unconditionally by the required aggregate, and the publisher requires every native leaf in its exact main-job inventory. Author contracts and 26 deliberate bypass mutations verify these connections. Run 38346895570 exposes all eight exact custody leaf names and the five root jobs expected by the publisher; the aggregate correctly refuses its failed components. | Final hosted checks, independent verdict, physical acceptance and publication evidence. Correct job names and a failing aggregate establish wiring, not runtime success. No universal live publication claim. |

## Architecture decisions and open findings

The content key boundary stays on trusted clients. The server and management
surfaces receive ciphertext and separate API credentials. No administrative
master content key, alternate decrypt path, or switch that disables encryption
or integrity is permitted. Recovery cannot recreate a lost content root from
server/account authority alone.

The candidate implements the bounded revocation transaction: fresh independent
root, full reseed, new recovery backup and explicit re-pairing of every retained
device. It composes suite-2 sealing and the existing pairing-v2 authentication.
Server device lists
do not select cryptographic recipients. An offline old client can continue
using its old root with a colluding server until that client transitions;
instantaneous global cutover is not promised. The independent reviewer must
assess the [transaction and required negative acceptance cases](device-revocation.md)
before final acceptance. Atomic enrollment, suite-2 admission, custody, complete
reseeding and explicit re-pairing are integrated. Their executable source and
author evidence do not constitute independent approval or a shipped guarantee.

Native `requestUrl` **failed redirect containment**: a second loopback origin
received synthetic API/edge headers on 301/302/303, and those headers plus the
POST body on 307/308. The tested untrusted TLS certificate was refused before
HTTP. This exposed authentication material, not a demonstrated content-key leak.
The implementation candidate now uses browser Fetch with redirect refusal
selected before sending, no native fallback, explicit custom-header refusals
and narrowly scoped server CORS. An actual Obsidian 1.13.7 probe refused all
five redirect statuses for GET and POST with zero destination requests; its
positive controls reached the destination. The composed suite-2 candidate passed the
12-step desktop journey, including the permanent native redirect regression,
setup, pairing, sync and encrypted-storage restarts. Hosted Linux, Windows and
macOS also pass native journeys through the Caddy/TLS fixture. Both macOS
launch orders pass at `bb290bcb`, but simultaneous macOS startup again refuses
local custody at `83c3bbea` on the unchanged runtime bundle. The instrumentation
experiment did not resolve that failure. Linux additionally refuses an instance
without CA trust. Native macOS custody, phone, other proxy and certificate
combinations, and final independent review remain open; no released or
platform-wide remedy is claimed.

The historical GCM analysis identified a shared 96-bit nonce budget and a
synthetic repeated-RNG failure. Live callers now use established RFC 5297 SIV
with counted context and one fresh-root migration. The [accounting note](e09-key-nonce-inventory.md)
separates that historical finding from the current resource model: finite
scope/call/time assumptions, exact native AES work and conditional KDF/CTR/CMAC
terms. No enforced global offline quota or complete numeric failure probability
is claimed. The focused independent assessment retains this model only as a
conditional analytical horizon; it does not confer E09 acceptance.

## Bounded completion sequence

1. Finish the final composed local/hosted gates and publish the signed runtime
   checkpoint with its exact source, artifact and evidence accounting.
2. The existing independent reviewer assesses the composed pairing/recovery,
   redirect containment, quantitative assumptions and fresh-root transaction;
   repair demonstrated findings within this train.
3. Repeat affected native desktop and physical-phone journeys on the actual
   final artifact; retain reduced, reproducible evidence and clean fixtures.
4. Apply the owner's agreed release placement; require current hosted gates
   and exact-head independent approval before Ready. Merge remains owner-only.

This train does not add traffic padding, a deduplication redesign, a general
test framework or unrelated infrastructure changes. Live deployment,
Cloudflare account/billing, immutable publication and phone execution are
unproven here. Neither the plan's approval nor these passing tests certifies
the whole system as secure.
