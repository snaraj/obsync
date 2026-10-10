# E2EE regression instrument and native desktop validation

2026-10-10, implementation issue [#346](https://github.com/snaraj/obsync/issues/346),
within audit [#344](https://github.com/snaraj/obsync/issues/344).
This is evidence for the first assurance slice, not completion of the audit.

## Source and environment

Protected base: `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0` (1.1.7).
The implementation changes server export, the observer, CI and documentation.
Plugin runtime and server sync code are unchanged from that base.
Rust 1.98.0, Node 26.10.0, npm 11.19.1; MacBookPro18,4 running macOS 27.0, arm64.

The plugin bundle used in both the integration and native runs was 1,403,979
bytes, SHA-256
`8b0488c5d83b6c0d2991dba73af8512fa2be8a3e2b9279994a114261a7a184c4`.
It reproduces the released source's bundle. Native Obsidian was 1.13.4 on
Electron 43.1.1. This was the installed desktop app, not the newer app pinned
for hosted desktop jobs. No personal vault was used.

## Reproducible integration gate

`make e2ee` builds the plugin, runs its tests, builds `obsyncd`, and invokes
`scripts/ci/e2ee.mjs`. The same server build and script are unconditional
steps of the existing required `application` job. Makefile invariants require
both commands and the target's presence in `make check`. A dedicated contract
also rejects conditional execution and ignored failures in the job, step and
Makefile recipe. Its behavioral control runs the actual workflow body with a
stub E2EE command returning 17, observes exit 17, then observes the forbidden
`|| true` mutation swallow that failure.
The actual Make target is also executed with its plugin prerequisite already
built and stub build/test commands. Its failure returns 2; `.IGNORE` and
`MAKEFLAGS += --ignore-errors` controls return 0 and must be rejected. A closed
Makefile declaration grammar permits literal targets, `.PHONY` and the two
existing defaults; it refuses error-control flags, shell overrides, includes
and evaluated declarations. Exactly one `e2ee` target is permitted.

The integration uses production WebCrypto, pairing, transport, state and sync
engine modules. Only the Obsidian vault/secret-store boundary and periodic
timers use the existing in-memory adapters. Traffic goes over actual loopback
HTTP through the recorder into an actual disposable `obsyncd` process.
Four GiB capacities avoid the journal's two-GiB frame reservation ceiling.
The process is stopped before storage and final recording scans.

The final scenario covers ten named flows:

1. First-device setup with account recovery registration.
2. Pairing v2: encrypted vault name, commitment verification, comparison-code
   agreement before approval, authenticated envelope collection and key readback.
   The recipient starts without a VRK and keeps only the opened envelope's key;
   independently derived inventoried keys open both the real VRK envelope and
   the separate vault-details ciphertext returned through pairing status.
3. Note creation and recipient content readback.
4. Note editing and recipient content readback.
5. A 700,000-byte random attachment containing a sentinel; byte-for-byte readback.
6. Rename, matching destination bytes and absence of the previous name.
7. Recovery into a third device and content readback.
8. Current access-only revocation: API refusal plus the explicit retained-key
   limitation described below.
9. History readback of the original note after editing and rename.
10. Tampered chunk and manifest refusals, wrong-file binding and wrong-key
    refusal, with honest history still readable afterward.

An observed repaired scenario run completed in 2,858 ms, with 80 recorded
requests and responses, nine server storage files and 28 needles. Counts are
asserted against actual requests, required material classes and named flows.
Random keys affect eligible partial recovery words; random attachment chunking
and asynchronous feed timing also affect counts. Recipient reads have a
five-second budget; `syncNow` drains outgoing work and does not establish that
an independent incoming feed has finished.

The corpus covers seeded note text, paths, folder and vault names, attachment
bytes, edits and post-revocation content; the actual VRK, domain-map, domain,
manifest and chunk keys; pairing code/secret, envelope key and vault-details
key; and the actual
VRK recovery phrase. Authenticated manifests
supply the actual chunk-key inventory. Every original request and response
is searched, without exempting content keys under credential field names.
A separate credential pass permits only exact expected setup, enrollment,
recovery-proof and device-secret values at their typed protocol sinks. A
valid recovery proof planted in an unrelated header is refused. Exceptions
replace only exact top-level value spans in the original wire bytes; duplicate
JSON members (including escaped aliases) are refused without discarding their
bytes. Exception-bearing compressed/chunked credential bodies are deliberately
unsupported and refused, rather than normalized into incomplete evidence.
Content-key scanning still uses the untouched original recording.
Duplicate-member refusal also applies at every recursively decoded JSON layer.
Base64 and hex controls wrap mixed literal/Unicode-escaped leaked values with
duplicate or escaped-alias members; one and two wrapper layers must refuse.
Removing the duplicate exposes the expected secret hit, and public controls pass.

Server logs and client diagnostics also receive the authentication credential
inventory, with a planted control for every credential and each diagnostic
surface. Server storage receives the content inventory; expected stored API
credentials are not treated as content leaks. Individual eligible recovery
words are checked in structured HTTP values, including reason phrases, trailer
values and chunk extensions. Opaque storage and log bytes receive the full
phrase and other secret encodings, not individual common words without context.

Before and after the product flow, real HTTP recordings deliberately leak
sentinel text and a random content-key-shaped value in both directions. They
must parse completely and fail for both needles and directions, including
under credential field names. The storage and diagnostic scanners also must
refuse planted values. These controls are separate from the product capture.

Tampered chunk bytes are injected at the HTTP adapter's receive boundary after
an actual server response. The recorder therefore holds the original server
bytes for those cases. This is a production receive-path regression, not a
complete malicious-server implementation or proof of rollback detection.

## Recorder and scanner checks

34 scanner tests passed. They cover the original false-PASS cases, byte-count
receipts, absent directions, framing ambiguity, incomplete headers/bodies,
close-delimited bodies, chunk terminators/trailers, unsupported or corrupt
compression, nested encodings, base64 alignment, word/value separation,
missing work, decoding budgets, output redaction, unexpected files, links,
short writes, injected write/fsync failures, upstream termination provenance,
bodyless framing, duplicate JSON members, reserved headers, final-response
counts, derived domain/manifest keys and complete large-report output.
Closing the recorder is not evidence that the origin ended a response: every
connection needs an observed upstream EOF. A 250-ms shutdown grace period
allows already completed connections to finish; forced termination still
refuses the capture. Older receipts without this evidence also refuse.

The scanner refuses a stream or decompressed body over 64 MiB. Nested JSON
has a depth and node budget; exhaustion is a refusal, never a partial PASS.
This scanner is bounded regression tooling, not a claim to scan arbitrary
size recordings or every possible encoding.

`python3 -B scripts/validation/e2ee_mutations.py` runs disposable copies with
passing baselines before and after. The repaired matrix passed all 61 assertion-kill cases: 30
recorder/scanner mutations, 23 engine/inventory/planted-leak mutations and eight
CI-contract mutations. Planted actual request leaks cover content, VRK, pairing
envelope key, vault-details key and recovery phrase; diagnostic leaks cover the actual recovery
proof in server and client logs. Removal of raw credential evidence is caught
by duplicate-member controls. Recursive uniqueness and refusal propagation
are each mutated separately. The CI cases remove each required execution guard,
including Make declaration restrictions and target uniqueness.
A mutant must parse and fail its intended assertion; setup, syntax and timeout
errors do not count. Earlier duplicate-framing probes overlapped another guard;
the duplicate content-encoding control establishes an independent assertion.

`python3 -B scripts/validation/server_bounds_mutations.py key-input-refused export-argument-redaction`
compiled both export mutants and killed them in the key-input refusal test. The
old key-file permission mutants were replaced because export no longer reads
key files at all. The process-level export test continues to check both an
intact ciphertext export and a missing-chunk refusal.

## Full local gate

The initial published head `36ec840661f2c3c9250729cad5af1fea1d4754a4`
passed `make check`: formatting, clippy with warnings denied, all Rust
workspace suites, coverage at 94.71% against the 89% floor, 2,244 plugin tests,
the real-server E2EE gate, native CLI acceptance, 83 dashboard tests, chart
validation, 888 contract tests and both working-tree/range secret scans.
The Rust throughput measurement remains the existing ignored benchmark.
Initial failures exposed an obsolete export test invocation, the export's
pinned CodeQL digest and obsolete mutation records; those were repaired.
During the repaired-head full gate, the instrumented CLI closed-output test
returned success once. A held peer descriptor reproduces that behavior: merely
dropping the test's peer does not prove that another fork has released its copy.
The test now shuts down the writer and deliberately retains a peer copy. With
that shutdown removed, the process returns 0 instead of the required 9; restoring
it passes. Shutting down only the peer was tested and did not solve the macOS
case. This is a fixture-only repair; CLI runtime code is unchanged. The initial
failed full-gate result is retained separately from the repaired run.

At `e44c12262034f7adb1439eda00f74a3a260ef45c`, `make check` passed: 2,244 plugin tests,
905 contract tests, 83 dashboard tests, all Rust workspace suites, 94.71%
coverage, native CLI/chart checks and both secret scans. Its E2EE run recorded
ten flows, two controls, 80 requests/responses, nine storage files and 29
needles in 3,172 ms. The 54-case instrument matrix and separate CLI shutdown
mutation all failed their intended assertions and passed after restoration.

The subsequent recursive-decoder, vault-details-inventory and Make-enforcement
repairs passed the complete local gate: 2,244 plugin tests, 909 contracts,
83 dashboard tests, Rust workspace suites, 94.71% coverage, CLI/chart checks
and both secret scans. That run recorded ten flows, two controls, 80 requests,
nine storage files and 31 needles in 3,120 ms. All 61 instrument mutations
failed their intended assertions with passing restored baselines. The duplicate
JSON fixture now uses an explicit byte splice instead of first-occurrence
replacement; no CodeQL disposition or exclusion was added. Hosted analysis of
that correction remains a separate requirement.

The source digest was updated only after re-reading every export printer:
counts, ciphertext SIDs and fixed content/result labels, with no content key
or plaintext introduced. Hosted CI, release classification and independent
review remain separate gates; a local pass is not a Ready receipt.
The documented Linux/Python 3.12 container build also passed strict MkDocs
and the generated-site origin check: 156 files, 8,088 anchors, zero refusals.
The local macOS wheel install was refused by the platform-specific hash pins;
no pin or hash check was relaxed.

## Native desktop observation

The existing `scripts/ci/obsidian-drive.mjs` ran against a disposable loopback
server through the recorder, using two separate Obsidian user-data directories
and fresh sentinel vaults. A local wrapper assigned unused debugging ports
and otherwise retained the driver's journeys. No TLS trust changes were made.
This run observes the application-layer boundary; it does not validate TLS
certificate handling or a deployed endpoint.

| Journey | Observed result |
| --- | --- |
| Native startup, setup and pairing | Two real instances loaded the exact bundle; settings and dialogs completed setup, phrase confirmation and pairing |
| Bidirectional notes | Independent recipient disk readback in 1,260 / 1,257 ms |
| Rename and folders | New name held matching bytes; old name absent; nested and empty folders arrived |
| Ten edits | p50 1,012 ms; p95/max 1,018 ms, measured from vault write to recipient disk |
| Concurrent typing | 100 keystrokes per instance over 20,085 ms; both editors and disks retained them in order, no conflict copy, 454 ms after final insertion |
| Watcher recovery | With the recipient watcher closed, disk changes and listings converged; its watcher was restored |

The native driver reported ten steps passed in 45.7 seconds. This historical
run preceded the review's recorder termination and inventory repairs; its raw
capture was removed during teardown and has not been rescanned with the repaired
instrument. Its app/disk observations remain distinct from current scan proof. Its completed
recording passed a scan for twelve seeded paths/content values read from the
resulting disposable vault. That native scan did not inventory native content
keys, recovery words or every historical edit; the fuller key corpus belongs
to the integration gate above. Native secret-store restart custody was not
asserted by this run. No phone, Windows or Android run was executed here.

The wrapper stopped its owned server and application processes and removed
its capture, server data, profiles and vaults; it reported teardown complete.
A subsequent process check found no Obsidian process using that fixture prefix.
The isolated mutation trees also removed themselves. Build outputs are kept
only while the implementation's required checks and review need them.

## Current limits and remaining audit work

The revocation case first obtains `device_revoked` from the honest server,
then proves that keys retained by that device still open a version created
later when ciphertext is supplied through an authorized fixture transport.
It deliberately pins the current limitation; it is not a passing test of
cryptographic revocation. No new rotation mode or security-disable setting
has been introduced. That mode needs authenticated membership, independent
new keys, epoch transition rules, offline/partition behavior and protocol
review before implementation can claim it.

This slice does not establish rollback/fork/withholding detection, malicious
paired-device attribution, resistance to chosen-input confirmation, an
exhaustive clear-field schema, native mobile assurance, whole-system
cryptographic review, release publication or final owner claim sign-off.
Those remain under #344. The release placement and milestone remain pending
the owner's decision; this record does not authorize changing an agreed train.
