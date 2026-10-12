# E2EE assurance: October 2026 implementation checkpoint

2026-10-12. Scope: [audit #344](https://github.com/snaraj/obsync/issues/344),
[approved plan candidate](https://github.com/snaraj/obsync/blob/83549f4c9580ccf1eb7bd75cf62795ef08261bda/docs/security/e2ee-audit-plan.md),
and implementation [PR #347](https://github.com/snaraj/obsync/pull/347).
This is author evidence, not an independent security verdict or completed audit.
The protected baseline is `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0` (1.1.7);
the candidate extends `482d512e027b57154bfac07b71ea2a706102642f`.
Exact artifact hashes, commands, failed intermediate results and native limits
are in the [validation record](../validation-runs/2026-10-12-security-train.md).

## Claim-to-evidence map

“Exercised” below means the named cases passed, not that every attack is
excluded. Each row retains its remaining acceptance rather than converting
unit-test success into a whole-product approval.

| Plan invariant | Current evidence | Remaining acceptance |
| --- | --- | --- |
| E01: content and names stay private | Real plugin engine/server: 19 ordinary and hostile flows; actual traffic/storage/diagnostic scans; 50 content/key needles; two planted leak controls. Supplemental native macOS scanning covers 34 labelled final-file/vault observations; it has no complete transient/key inventory. | Final physical-phone and any later runtime artifact; native keys are not inventoried. Sizes, timing, graph shape, labels and same-domain equality remain visible. |
| E02: server/API authority cannot derive content keys | Existing key separation plus real-ciphertext API-secret/account-recovery-proof refusal, followed by successful content-key decryption. Server-export content-key input removed. | Independent source audit of all acquisition/exfiltration paths and composition assumptions. |
| E03: pairing gives the root only to the approved recipient | Existing v2 commitment, fixed claim, ECDH/secret-bound envelope and screen comparison; 150 focused pairing/recovery tests. Creator notices identify spoofable server status, with a corrupted-envelope/spoofed-row control. The native driver now requires matching visible comparison codes on both devices before approval; real Obsidian 1.13.7 exercised that path. | Independent malicious-relay review, including every proposed rotation enrollment change. The native honest comparison and injected driver failures are not a coupled native malicious-relay journey. |
| E04: authenticate before publication | Real manifest, parent and chunk corruption refusal; unchanged accepted bytes/state; damaged chunk parks durably while valid siblings progress; honest retry restores exact bytes. Mutations kill normalization and retry removal. | Independent assessment of the complete receive/control surface, beyond these exercised routes. |
| E05: recovery separates content from account authority | Actual recovery journey and API/account-proof decryption negatives. Fresh-root primitive probe rejects the old phrase for new-root data. | Whole recovery-flow review; fresh-root transaction/recovery is still a proposal. |
| E06: custody and diagnostics | Closed error-code messages, explicit detail consumers, relative filesystem/control-character redaction, focused mutation controls. Existing credential lifecycle suites pass 169 tests. Local macOS 1.13.7 passes both encrypted-storage restarts; separate simultaneous/serialized synthetic probes pass eight custody observations. | Hosted macOS 1.13.7 custody refused plaintext storage and remains unresolved; local success does not diagnose or override it. Public API readback is not joint crash durability or secure erasure. Physical-phone custody remains open. Arbitrary free text is not universally sanitized. |
| E07: revocation matches its selected guarantee | Current access-only test proves both API refusal and retained-key decryption when later ciphertext is supplied separately. The independent protocol checkpoint required changes to authorization, cutoff, completeness and recovery in the [fresh-root/re-pair design](device-revocation.md). | Approval of the revised protocol, implementation of the per-removal choice, restart/fault cases and actual device acceptance. No strong-revocation capability is claimed today. |
| E08: integrity is distinguished from freshness/attribution | Corruption and visible fork refuse; authentic sole-head map rollback remains readable in a deliberate regression demonstration. Docs distinguish shared-key authority from a device signature. | Independent replay/rollback/omission review; no global latest-state or server-independent availability guarantee. |
| E09: key/nonce composition and lifetime | [Inventory, conditional analysis and candidate per-record key derivation](e09-key-nonce-inventory.md); absolute uniqueness/oracle claims corrected. Forced RNG exceptions refuse; synthetic repeated-zero RNG causes GCM reuse. | Independent composition and migration review, implementation and negative cases. The candidate is not a literal invocation quota or a NIST conformance claim; no real CSPRNG failure or implemented lifetime mitigation is claimed. |
| E10: observations cannot silently pass incomplete | Scanner/recorder refusal tests, exact typed credential sinks, planted controls, manifest/traffic/storage linkage and closed inventories for three read routes. The repaired complete 98-case mutation batch passes; engine/runtime kills require the intended first assertion, with restored controls. | Expand only for demonstrated new surfaces; the native scan and complete engine key inventory remain distinct. |
| E11: no alternate content-key access | Server-export key argument removed; API/admin surfaces retain their distinct non-content authority. No optional encryption/integrity bypass was added. | Independent whole-source/dependency/distribution review. Passing absence scans is not proof that no backdoor exists. |
| E12: failed invariants prevent delivery | E2EE is in the canonical local and hosted gate, with scanner/Make/workflow mutations; release classifier refuses the current unversioned artifact range. macOS CI now requires custody restart when that job runs. | Owner-agreed release placement, final hosted checks, independent verdict, physical acceptance and publication evidence. Desktop matrix remains optional; no universal live publication claim. |

## Architecture decisions and open findings

The content key boundary stays on trusted clients. The server and management
surfaces receive ciphertext and separate API credentials. No administrative
master content key, alternate decrypt path, or switch that disables encryption
or integrity is permitted. Recovery cannot recreate a lost content root from
server/account authority alone.

Strong revocation uses the smallest proposed transaction: fresh independent
root, full reseed, new recovery backup and explicit re-pairing of every retained
device. It reuses the existing primitives and pairing v2. Server device lists
do not select cryptographic recipients. An offline old client can continue
using its old root with a colluding server until that client transitions;
instantaneous global cutover is not promised. The independent reviewer must
accept the [transaction and required negative acceptance cases](device-revocation.md)
before production implementation.

Native `requestUrl` **failed redirect containment**: a second loopback origin
received synthetic API/edge headers on 301/302/303, and those headers plus the
POST body on 307/308. The tested untrusted TLS certificate was refused before
HTTP. This is an unresolved additional-origin credential exposure, not a
demonstrated content-key leak. Native `fetch` can refuse redirects but requires
CORS preflight compatibility; no unvalidated transport replacement is shipped.

Nonce analysis also remains conditional. File and folder manifests share one
96-bit nonce collision budget per actual key across devices/restarts. Sample
tests cannot establish a lifetime guarantee. The [inventory](e09-key-nonce-inventory.md)
records assumptions, the synthetic fault and unresolved lifetime accounting.
Its candidate extends the existing chunk-style per-record key approach to
metadata, with a keyed plaintext commitment and strict format migration.
That composition remains unapproved and unimplemented.

## Bounded completion sequence

1. Independent reviewer assesses the implemented changes, pairing/recovery,
   redirect finding, nonce assumptions and the fresh-root proposal.
2. Implement the accepted revocation transaction and demonstrated review
   findings; validate their negative cases and crash/retry behavior.
3. Repeat affected native desktop and physical-phone journeys on the actual
   final artifact; retain reduced, reproducible evidence and clean fixtures.
4. Apply the owner's agreed release placement; require current hosted gates
   and exact-head independent approval before Ready. Merge remains owner-only.

This train does not add traffic padding, a deduplication redesign, a general
test framework or unrelated infrastructure changes. Live deployment,
Cloudflare account/billing, immutable publication and phone execution are
unproven here. Neither the plan's approval nor these passing tests certifies
the whole system as secure.
