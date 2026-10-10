# End-to-end encryption audit and continuous assurance plan

*For maintainers, implementers and independent reviewers.*

Status: proposed execution plan, revised 2026-10-10; tracked in issue #344.
Baseline: release 1.1.7, commit `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0`.
Paths and function names below refer to that commit. This specifies work and
acceptance criteria, not an encryption certification or a claim that proposed
gates already run. The [baseline checks](../validation-runs/2026-10-10-e2ee-plan-baseline.md)
separate executed tests, reproduced scanner defects, source observations and
untested security properties.

## 1. The promise and the people relying on it

Notes, attachments, file and folder names must be encrypted on a trusted
device before transmission. The sync server must not receive a key capable
of decrypting them. Vault-name exchange during pairing is also in scope.
Installation, setup, pairing, sync, history, recovery, revocation and export
must preserve that boundary.

The supported consumer is one user synchronizing a vault among their own
Obsidian devices, including a phone and computers on inspected networks.
Every currently paired device has whole-vault authority. Folder selection is
a local preference, not a cryptographic sharing boundary. The dashboard and
administration CLI manage the account; management authority must not confer
content-decryption authority. Multi-user sharing is not implied.

### Actors and trust boundaries

| Actor or condition | Audit requirement |
| --- | --- |
| Passive network observer | No content, private names or content keys; retain the separate TLS guarantees and metadata limits. |
| TLS-inspecting proxy | Capture application traffic after TLS termination. Treat captured setup, device, recovery and dashboard credentials as available to this attacker. |
| Malicious server operator | Give the attacker all server state, the wrapping key, account credentials and control of responses, storage and clocks. Content protection cannot depend on server enforcement. |
| Copied server disks/backups | Distinguish copies with and without the wrapping key. Neither may contain a content key through a supported server operation. |
| Holder of only a device API secret | Exercise account disruption and enrollment; this secret alone must not decrypt or forge vault content. |
| Holder of a paired device's vault key | Can read and forge content in that key's scope. This is distinct from an API-secret-only attacker. Revocation requirements are in section 4. |
| Honest device restarting, offline or restored from backup | Exercise stale state, interrupted custody and old versions; never repair these by disabling encryption or accepting unauthenticated content. |
| Compromised endpoint, OS or installed plugin | Plaintext is available where the user edits it. This audit does not claim protection from an attacker controlling that endpoint. Audit distribution separately. |

Metadata is an explicit disclosure, not a content-key exception. Inventory
exact version sizes, ciphertext lengths, chunk equality within a domain,
opaque file/domain/folder ids, version graph, deletion flags, device labels
and attributed authors, timestamps/typing bursts, addresses, country and
activity retention. User-supplied account/device labels can reveal private
names: explain their visibility and never silently copy a vault/file name
into them. Padding, timing and retention changes require measured tradeoffs
and a separate maintainer decision.

### Hard requirements: no backdoors

There is no vendor/operator/administrator master decryption key, key escrow,
or debug, environment, compatibility or recovery switch that bypasses content
encryption or integrity verification. A server credential, setup token,
dashboard session or offline account reset cannot substitute for device-held
content-key authority. Losing every authorized content key and valid recovery
secret leaves the content unrecoverable.

An explicitly requested local recovery/export belongs on a trusted client.
Its content keys must not pass through a server command, dashboard, management
credential, URL, command-line argument, diagnostic log or support bundle.
Test-only key extraction belongs exclusively in the disposable harness, never
in a shipping plugin capability. Neither revocation choice disables encryption,
authentication, integrity checks or fail-closed behavior. Performance changes
must preserve these rules. Public wording separates content confidentiality
from metadata privacy, account security, freshness and availability.

## 2. What the code and current tests establish

This inventory contains evidence and leads, not proof that all paths satisfy
the promise. Per-change review can inspect surrounding code but does not
establish a completed whole-system audit. Locate historical review receipts
and their actual scope before declaring a review missing.

| Lead | Source observation and remaining work |
| --- | --- |
| F1: client encryption | `plugin/src/crypto.ts` uses WebCrypto AES-GCM; `sync/push.ts:postManifest` seals manifests before posting. Trace every caller and failure/output path. Encryption functions alone do not prove absence of alternate leaks. |
| F2: binding | `crypto.ts:contentVersionId`, `sync/pull.ts:openManifest`, `bindManifestToRecord` and `openChunk` validate content. Cover merge caches, prefetch, history and repair. A server-recomputed hash is not authentication against that server. |
| F3: equality | `encryptChunk` deliberately returns identical ciphertext/storage ids for identical plaintext within a domain. Correct claims that this reveals nothing about plaintext: equality and length are observable. Assess chosen-input confirmation attacks, not only passive observation. |
| F4: old evidence | `docs/validation-runs/2026-09-29-observer-proof.md` records a past manual session. Preserve its scope; it does not prove the 1.1.7 build or every flow. |
| F5: metadata | Trace version fields, `api/edge.rs`, `storage/index.rs`, API rendering and logs. Some sizes/timing are already documented; enumerate actual omissions. |
| F6: recovery credential | `accountRecovery.ts:accountRecovery` derives the proof; `transport.ts:setup` transmits it at recovery; `api/setup.rs:create` compares its hash. The threat model's adversary table and residuals already name it. Test its authority; do not claim it is absent or equate it with a content key. |
| F7: pairing | `pairing.ts`, `crypto.ts:derivePairingV2Key` and the dialogs implement P-256 agreement, creator-key commitment and human comparison. Review the entire state machine. The [2026-10-01 record](../validation-runs/2026-10-01-pairing-commitment.md) documents a review-driven repair and substitution tests. The architecture's deferred enrollment-review sentence does not establish a pairing-v2 review-policy breach. |
| F8: server credentials | `storage/mod.rs:wrap` XORs device secrets with an HKDF-derived mask. Assess integrity, custody and backups. These are API credentials, not content keys. Source does not prove live wrapping-key configuration. |
| F9: evidence wording | Real doctrine tests exist in `crates/obsyncd/src/doctrine_test.rs`; AGENTS.md's named identifiers drift. WebCrypto generated the fixtures checked by Rust HKDF. Node crypto/WebCrypto comparison is not automatically independent implementation provenance. Inventory published-vector/differential checks and skips. |
| F10: client residue | `state.ts` migrates plaintext legacy settings, calling `save()` before load returns, and retains bounded current/previous credentials. Inspect interrupted migration, backups, pairing state, errors and cleanup. Notes and owned client secret storage are expected plaintext/key locations, not server-leak evidence. |
| F11: scanner false PASS | The baseline reproduction passes empty captures, empty needle sets, a plaintext-bearing incomplete header and a plaintext-bearing close-delimited response. A complete-request plaintext control fails. Repair and mutation-test the instrument before relying on it. |
| F12: server key input | `crates/obsyncd/src/cli/mod.rs:ExportArgs::parse` requires a domain key through `--key-file` or accepts `--key`; `cli/export.rs:run` ignores it and exports ciphertext. Remove this unnecessary content-key input and its guidance. This is a verified CLI boundary problem, not demonstrated remote extraction. |
| F13: CI coverage | `pr-gate.yml` runs plugin/scanner unit tests. Compose uses `api_flow.py`, a synthetic device with opaque random bytes, not real Obsidian encryption. Real app journeys are in `desktop-matrix.yml`, explicitly described as non-required. New enforcement must reach required gates and publication authorization. |

The baseline rerun passes 248 focused plugin tests, 152 Rust core tests
(one ignored throughput measurement), and nine observer tests. These counts
are not a whole-product verdict. This revision contains no fresh server-volume
scan, native-device audit or hostile-server acceptance record.

## 3. Claims, proof obligations and rejection behavior

Each ID needs named tests/mutations, exact source/build hashes and reduced
evidence. Use `PASS`, `FAIL`, `UNKNOWN` or explicit `OUT_OF_SCOPE`. Missing
prerequisites, required skips, parser loss, timeouts and unverified cleanup
cannot become PASS. Negative cases need honest controls and independent
resulting-state checks.

| ID | Required property | Evidence and failure behavior |
| --- | --- | --- |
| E01 | Content/names leave clients only encrypted | Real engine/server transfer; traffic/storage/log scans and matching recipient disk bytes. Plaintext body, path header/query and diagnostic mutants must fail. |
| E02 | Server/account authority cannot obtain content keys | Exercise setup, admin, recovery, export and maintenance with all server credentials. Enumerate key locations; reject content-key input on server interfaces. |
| E03 | Pairing authenticates its peer/transcript | Key substitution, stripped fields, downgrade, replay, intercepted code, races and restart. No approval on mismatch, key adoption or unrelated pending-device authority after refusal. |
| E04 | Verify before vault/editor publication | Alter ciphertext, nonce, tag, AAD-bound ids, order, lengths, paths and tombstones on every receive path. Existing bytes remain; no partial file, deletion, merge or trusted-cache adoption escapes. |
| E05 | Recovery preserves key separation | Correct phrase works locally; wrong phrase, proof alone, token alone, reset and captured credentials cannot open content or replace another device's trusted identity. Account reenrollment and content recovery get separate verdicts. |
| E06 | Key custody fails closed | Migration, missing/corrupt secrets, interrupted save, restore, copied vault, Leave and native restart. No plaintext fallback or new identity after ambiguous load; no unexpected key residue. |
| E07 | Revocation matches the chosen action | Both section 4 choices and pending/failure UX; give revoked keys future ciphertext directly, bypassing API access control. |
| E08 | Freshness/attribution match authenticated evidence | Attack version/device ids, timestamps, sequence, heads, maps, rollback and forks. Separate server assertions from client-authenticated facts and state detection limits. |
| E09 | Key/nonce use is justified | Published vectors, byte-order/label checks, lifecycle/collision analysis and forced bad randomness. Distinct sampled nonces are not lifetime proof. |
| E10 | Capture rejects missing work | Complete byte/corpus/flow accounting, planted controls and malformed-capture cases. Nothing performed or scanned is a refusal. |
| E11 | No alternate decryption/exfiltration route | Trace source to bundle/installed artifact, egress, updates, diagnostics and export. Test fixed/test keys and leaks hidden under allowed fields. |
| E12 | Failed invariants block delivery | A planted failing invariant fails required PR/exact-main gates and denies publication. Omitted, skipped, cancelled or foreign-head evidence also denies. |

### Authenticity is not freshness

AEAD authenticates bytes made by a key holder; it does not alone identify a
particular device, prove a version is latest or prove every update was
disclosed. Device HMAC terminates at the server, which knows those secrets.
It cannot establish authorship against that server. Shared content keys also
do not distinguish individual authorized writers.

Trace which fields drive echo suppression, cache identity, conflict resolution,
times and feed advancement, and which are authenticated. A refused forgery
must not still alter persistent state or prevent later honest delivery.
Authentic old records, including deletions and pause controls, need separate
replay cases; successful decryption alone cannot admit them as current.

Test existing/restarted clients retaining checkpoints, old backups, fresh or
recovered clients, and two partitioned clients. A fresh client seeing only
an untrusted server's valid old history has no independent evidence of unseen
newer history. A server can withhold traffic indefinitely. Define any
authenticated checkpoint/device-comparison mechanism and its trust source
before promising detection. Otherwise document the limit; a timeout does not
prove server malice, and encryption alone does not prove universal rollback
or fork detection.

## 4. Revocation: user choice, encryption always required

The maintainer requested configurability on 2026-10-10. Provide an explicit
choice at revocation, not a global E2EE-disable switch:

| Action | Required meaning |
| --- | --- |
| **Revoke access and rotate keys** — recommended default | Stop API access and establish a new content-key epoch unavailable to the removed device. Future protected updates include content, names, manifests, maps and controls. Completion names the established cutover and transitioned writers. |
| **Revoke server access only** | Keep current keys. Before confirmation, explain that retained keys can decrypt later ciphertext obtained from a copied volume or colluding server. This is not cryptographic revocation. |

The choice is made per revocation. No stored preference, server setting,
environment value or build flag may preselect the weaker action
(requirement 4).

Both choices retain encryption/integrity. Neither erases copied data, old keys
or recovery material. Strong revocation is a new protocol capability, not a
1.1.7 feature. Do not advertise it or execute the weaker choice under its name.

Independently review these obligations before implementation:

1. **Independent secrets.** New keys cannot derive solely from the old root,
   public epoch or material the revoked device holds. Never wrap a new key
   solely under the old shared vault key: the removed device can open it.
2. **Authenticated membership/delivery.** Bind vault, epoch, operation,
   recipients and their keys. Server-issued ids/API credentials alone cannot
   authenticate recipients against the server. Test substitution, re-added
   revoked keys, fake enrollments, concurrent rotations and membership replay.
3. **Cutover/offline writers.** Define when new-epoch encryption is required
   and how each writer learns it. Drain/quarantine in-flight old work. An
   offline or old client is not protected until transitioned; pending or
   excluded clients need authenticated re-enrollment. Test a server hiding
   the transition. When global cutover cannot be established under partition,
   report pending/limited protection, not an instantaneous global guarantee.
   Never discard unsynced local edits to force completion.
4. **Recovery/history.** Define new recovery material and user confirmation
   of recoverability. Old phrase plus server state must not recover the new
   epoch. Preserve authorized history without giving new keys to old
   recipients. Old encrypted chunks reused in a new version remain readable
   to old key holders: specify migration/re-encryption and test future content,
   not just manifest-key rotation.
5. **Durability/UX.** Persist before completion; test restart, disk-full,
   missing recipients, lost acknowledgments and retries. Distinguish access
   revoked, rotation pending/failed and rotation completed. No silent downgrade.
6. **Every surface.** Dashboard/management CLI must coordinate with an
   authorized trusted client or report rotation unavailable/pending; never
   ask for a vault key. Cover plugin removal, Leave, last-device removal,
   stolen-device recovery and each supported initiating surface.

Use a reviewed protocol, not an improvised cipher or a checkbox over today's
revoke route. State compromised-endpoint and partition limits. Current-mode
assurance can proceed while rotation is designed, but rotation receives no
PASS/delivery claim until its protocol, implementation and release gates pass.

## 5. Whole-system code and protocol review

Build a source-to-sink/key-authority inventory, including failure paths.
Record generation, derivation, recipients, import/export, storage, lifetime,
retention, rotation and destruction for root/domain/manifest/map/chunk/pairing
keys, recovery proof/verifier, device/server secrets, setup token and
dashboard/management credentials. Content and authentication keys must have
explicit, separate roles.

- **Key establishment:** `crypto.ts`, `pairing.ts`, pairing dialogs,
  `accountRecovery.ts` and setup/restore in `main.ts`. Review RNG failure,
  labels/encodings, P-256 validation, commitment timing, claim fixation before
  reveal, transcript binding, six-digit comparison, downgrade/cancellation.
  State comparison assumptions and per-attempt bound; never auto-confirm.
- **Data application:** push/pull, domain map, conflict/history/repair,
  prefetch/merge caches; every file/control type and received write. Bind
  inputs before policy, trusted caching or commit. Invalid later chunks
  must not leave an accepted partial file.
- **Client custody/transport:** state/native-host/transport and their callers;
  owned secret entries, prior revisions, migration, temporary files, lifecycle
  races, URLs/redirects/headers, diagnostics and all destinations. Dropping a
  JavaScript reference does not prove physical memory erasure.
- **Server/admin:** API, storage, CLI, dashboard and standalone `obsync-cli`;
  actual serialized bodies/logs/journal/index/snapshots/backups/exports, unknown
  fields and support output. Bypassing server authorization still grants no
  content key. Resolve F12 by removing its unnecessary key input.
- **Distribution:** source, bundler, release evidence, installer/update and
  executable inputs. Verify installed bytes or the exact documented installer
  transformation. The sync server must not inject/select executable plugin
  code. Signed publication and installer signature verification are separate
  facts; claim only the observed one.

For GCM, analyze total invocations per actual key across all devices, restarts
and random/derived nonce callers. A 96-bit truncation cannot make collisions
mathematically impossible. Quantify bounds and safe lifetime, or design a
reviewed key separation/rotation mechanism. Include deterministic encryption's
equality and chosen-input consequences. Nonce sampling cannot replace analysis.
Record oracle provenance: WebCrypto-generated fixtures, RFC vectors, Rust
checks and another Node API are not automatically independent cipher engines.

Primary references: [RFC 5116 sections 1.2 and 3](https://www.rfc-editor.org/rfc/rfc5116.html),
[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html), and
[NIST SP 800-38D section 8 and Appendix A](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf).
These define primitive requirements, not certification of this composition.
Primitive/protocol changes require independent security review; preserve
published-vector tests and dependency-free requirements.

## 6. Dynamic evidence that cannot pass without doing the work

### Rig and observation surfaces

Use synthetic vaults and new test keys only. The fast gate runs the actual
plugin engine, real WebCrypto and real `obsyncd`, with only the necessary
Obsidian filesystem boundary faked. The native layer runs the built plugin
in real Obsidian through controlled HTTPS termination and a recording relay.
Capture both directions after TLS termination and account separately for
client-to-terminator headers/rewrites. Inventory all egress so another
destination cannot evade the relay.

Scan server blobs, journals, indexes, snapshots, nonce files, exports and
logs, plus client diagnostics/residue under an explicit location policy.
Plaintext is expected in the synthetic vault and test-key inventory; never
exclude the whole server or logs to silence a hit. Restrict capture access,
publish reduced evidence only and remove owned fixtures on failure too.

### Instrument requirements

- Require nonempty validated needles for every data/key class and exercised
  epoch. Derive chunk keys using known test plaintext/cids; scanning root and
  domain keys alone does not scan chunk keys.
- Require expected flow IDs, roles, route/body types, request/response counts
  and independent source/recipient bytes. One aggregate count is insufficient.
- Scan raw bytes and decoded messages; account for every byte and unmatched
  request/response, including close-delimited and interrupted streams. Parser,
  decompression, unknown-framing and recorder-write failures deny PASS. A
  deliberate interrupted negative case may assert capture refusal; it cannot
  reuse that capture as successful confidentiality evidence.
- Decode framing/compression and nested encodings with bounded resources;
  reaching a bound is UNKNOWN/failure. Include UTF-8, UTF-16LE/BE, NFC/NFD,
  hex, base64/base64url at offsets, base32 where used, percent/JSON escaping,
  Unicode paths and binary markers. Finite encodings cannot prove absence
  of all covert leaks.
- Plant controls through each observation channel/encoding, check detection
  before and after clean runs, and retain both results. Keep controls separate
  from clean captures; never globally exempt their values. Include all F11
  regressions and failures to flush/close the recorder.
- Allowlist by flow, endpoint, direction, exact field, type, purpose and the
  expected credential value from the test inventory. For example, the expected
  account-recovery proof may appear in `POST /v1/setup.recovery_proof` during
  recovery, but not in logs or unrelated responses. Classify setup/device
  credentials separately too. A content key hidden in an allowed metadata/
  credential field still fails; no blanket exception. Acceptance consistently
  means zero **unexpected** hits; separate positive controls must have hits.

### Flows and platforms

Each flow has honest success, hostile/failure cases and persisted-state
readback. Distinct text/name/binary markers and different vault keys prevent
accidental cross-vault acceptance.

| Flow | Variations required |
| --- | --- |
| Setup/pairing | Independent devices; comparison match/mismatch; expired, reused or intercepted code; key substitution; rejected claim; wrong phrase; lifecycle interruption and version skew. |
| Sync/co-typing | Create/edit; concurrent writers; offline/reconnect/restart; first sync/existing vault. Verify saved bytes and editor contents separately. |
| Names/controls | Rename/move, Unicode/case, empty folders, delete, pause/resume and conflicts; private names stay encrypted. |
| Attachments/large files | Binary markers; empty/chunk-boundary/multi-chunk inputs; repeated chunks; streaming/prefetch/batch; truncation and last-chunk corruption; no committed partial file. |
| History/recovery | Preview/restore, merge ancestors, repair, backups, account reset and recovery with/without content keys; honest data survives refusal. |
| Key lifecycle | Both revocation choices, offline survivors, old/revoked clients with a colluding server, failed/pending rotation, Leave/re-pair and new recovery material. |
| Administration/export | Dashboard, credentials, CLI, ciphertext backup/export, diagnostics and unsupported key-input attempts. |

Automate engine/server coverage in required CI. Exercise native macOS,
Windows, Linux, Android and iOS; record OS/Obsidian/plugin/server/installed
versions. An emulator/simulator is not physical-device acceptance. Include
real desktop and physical-phone acceptance, marking other physical-platform
gaps explicitly. Repeat relevant custody/security journeys on final shipping
bytes; a prior artifact's record cannot validate changed security behavior.

## 7. Hostile-server and mutation requirements

Place an adversarial relay/server below the real client. Give it all
server-held keys and API credentials, but content keys only in the explicit
revoked-device/collusion cases. It can rewrite responses/storage without
obeying server validators and recompute public hashes. Test honest control,
attack, then honest recovery.

| Attack | Required observations |
| --- | --- |
| Change/swap/reorder/truncate chunks, manifests, tags, nonces or bound fields | No unverified disk/editor/trusted-cache output; original bytes survive; bounded refusal and usable recovery. |
| Forge ids, author, times, heads or sequence | No false authentication; inspect echo suppression, ancestry, cache admission and cursors, not just decryption. |
| Authentic rollback, old delete/pause, fork, omitted page/map | Exercise section 3's trust states; record actual detection and limits without universal freshness claims. |
| Pairing substitution, race, downgrade/replay | Failure before key disclosure/adoption; no unrelated pending-device authority; comparison/cancel UX remains meaningful. |
| Recovery/reset abuse or stolen API credentials | Account authority never becomes content authority; wrong-key enrollment cannot replace another honest client's trusted key. |
| Revoked device plus server | Old keys/phrase and full state/future traffic cannot open a new epoch after strong-mode cutover; deliberately demonstrate access-only's retained-key limit. |

Respect attacker capabilities: an API-secret-only attacker cannot make a new
valid content tag; an old root-key holder can make old-epoch content. Label
these cases separately.

Mutation kills include encryption bypass; path/root/derived-key leakage in
body/header/URL/log/allowed field; fixed/test keys; omitted AEAD/binding/cid/
length checks; unverified cache replacement; bypassed pair comparison; a new
epoch wrapped with an old key; silent rotation downgrade; disabled recording/
scan; omitted flow/needle class; and failed/skipped evidence permitting
publication. Compile errors, unapplied patches, timeouts and unavailable
fixtures are not kills. Retain assertion failures and passing controls;
investigate every survivor.

## 8. CI, release and evidence contract

Put fast enforcement for implemented E01–E12 obligations into `make check`
and an existing required `pr-gate.yml` job, such as `application`, with matching
contract tests. If a new job is selected, update `release_contract.py` inventories
and the owner-managed ruleset together. Verify live required-check state;
YAML does not establish branch protection or publisher enforcement. No
`continue-on-error`, empty matrix, filter gap, zero-test pass or required skip.
Exercise real encryption, not deployment smoke's opaque random bytes.

Run on every PR and exact protected-main source used for publication. Native
requirements advertised as release gates must reach real authorization,
not remain optional desktop jobs. Physical evidence can be a reviewed
exact-build prerequisite but is not an automated CI pass. Preserve a failing
main/publication case and prove publication denial; a local stub is not live
enforcement evidence.

Evidence records name claim/flow/attack IDs, source/build/installed hashes,
toolchain/platform, synthetic corpus revision, expected/observed counts,
surfaces/byte coverage, scanner/allowlist version, controls/mutations,
disk/editor readback, duration/budget, verdict/limits, reviewer and cleanup.
Publish hashes/reduced verdicts, not raw captures, credentials or key inventories.
Relevant edits invalidate old evidence until affected tests/integration paths
rerun. Test changes receive the same scrutiny as product changes.

Zero marker hits establish only the observed corpus and paths. They are not
a mathematical E2EE proof or proof of no backdoors. Assurance combines source
and key-authority review, protocol analysis, dynamic controls, provenance and
enforced regression gates.

## 9. Execution order and deliverables

| Step | Deliverable and exit condition |
| --- | --- |
| 1. Pin/inventory | Source/build identity; claims/key map; historical review scope; findings explicitly observed, inferred or untested. |
| 2. Validate instruments | F11 repairs, complete capture/corpus/flow accounting, scoped exceptions and controls. Instrument mutants fail before scans count. |
| 3. Current-mode gate | Real engine/server E01–E12 evidence for shipped behavior, including E07's access-only limitation; hostile tests, server-export key-input repair, required PR/main/publisher enforcement and corrected claims. Strong-mode obligations remain pending. |
| 4. Rotation design | Independent section 4 protocol review, membership/cutover/recovery/compatibility; expected failures pinned before code. |
| 5. Implement choices | UX on all entry points, authenticated epochs, both-mode tests/migration and an owner-agreed release. No silent train expansion. |
| 6. Native/review | Final-artifact platform/phone journeys, resulting bytes, notices, mutations/cleanup and resolved findings at the reviewed head. |
| 7. Deliver/maintain | Owner merge, exact-main gates, immutable artifacts and applicable installation proof; final report/public wording; mandatory future regressions. |

This revision is a plan, not production-mutation, real-device-revocation,
credential-rotation or release-assignment authority. Actual tests use disposable
fixtures. Any later live server/edge claim needs scoped host/provider evidence;
source cannot establish it. Preserve zero-cost/provider-neutral operation.

Do not promise elapsed time before protocol/instrument gaps are resolved.
Track concrete dependencies under #344 and focused issues for confirmed
repairs. Keep current-mode assurance, new rotation capability, native acceptance
and delivery separate; a docs-only merge does not close the audit.

## 10. Acceptance and ongoing responsibility

`docs/security/e2ee-audit-2026-10.md` will map public claims to E01–E12 evidence
and name the exact version, actors, assumptions, metadata, failures and limits.
Align README, threat model, architecture/protocol, recovery/export guides,
manifest and UI. Correct unsupported absolutes; accepting a residual does
not pass a stronger claim's test.

Completion requires all applicable gates, no unresolved critical/high finding,
explicit dispositions for others, an independent whole-system verdict and
maintainer acceptance of precise wording. Missing evidence stays unresolved.
Strong revocation needs its delivered protocol and both-mode acceptance, not
just an option label. Key handling, pairing, recovery, sync/merge/cache,
storage/logs, dependencies, bundling and release changes trigger their mapped
security tests and renewed review.
