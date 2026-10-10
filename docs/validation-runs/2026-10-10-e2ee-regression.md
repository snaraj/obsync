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
both commands and the target's presence in `make check`.

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

An observed final scenario run completed in 2,739 ms, with 80 recorded
requests and responses, nine server storage files and 22 needles. Counts are
asserted against the requests actually sent, required material classes and
named flows, not inferred from a green exit. Random attachment chunking and asynchronous feed timing can change
needle/storage/request counts in another valid run. The complete local gate
recorded 79 requests, nine storage files and 22 needles in 2,985 ms. Recipient reads have a
five-second budget; `syncNow` drains outgoing work and does not establish that
an independent incoming feed has finished.

The corpus covers seeded note text, paths, folder and vault names, attachment
bytes, edits and post-revocation content; the actual VRK, domain-map, domain,
manifest and chunk keys; and pairing code/secret. Authenticated manifests
supply the actual chunk-key inventory. Every original request and response
is searched, without exempting content keys under credential field names.
A separate credential pass permits only exact expected setup, enrollment,
recovery-proof and device-secret values at their typed protocol sinks. A
valid recovery proof planted in an unrelated header is refused.

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

24 scanner tests passed. They cover the original false-PASS cases, byte-count
receipts, absent directions, framing ambiguity, incomplete headers/bodies,
close-delimited bodies, chunk terminators/trailers, unsupported or corrupt
compression, nested encodings, base64 alignment, word/value separation,
missing work, decoding budgets, output redaction, unexpected files, links,
short writes, and injected write/fsync failures.

The scanner refuses a stream or decompressed body over 64 MiB. Nested JSON
has a depth and node budget; exhaustion is a refusal, never a partial PASS.
This scanner is bounded regression tooling, not a claim to scan arbitrary
size recordings or every possible encoding.

`python3 -B scripts/validation/e2ee_mutations.py` reproduced 23 assertion kills
in disposable copies, with passing baselines before and after. Fourteen
mutants attack recorder/receipt handling, raw and close-body scanning,
framing, decompression, word values, decoding bounds, report redaction and
empty corpus handling. Nine attack integration controls, required flows and
key inventory, storage scanning, request counts, credential sinks and
ciphertext tampering. Initial close-body, bodyless-framing and empty-builder
mutants survived overlapping checks; the focused cases were strengthened,
then all 23 failed their intended assertions. Syntax/setup errors do not
count as kills.

`python3 -B scripts/validation/server_bounds_mutations.py key-input-refused export-argument-redaction`
compiled both export mutants and killed them in the key-input refusal test. The
old key-file permission mutants were replaced because export no longer reads
key files at all. The process-level export test continues to check both an
intact ciphertext export and a missing-chunk refusal.

## Full local gate

`make check` exited zero: formatting, clippy with warnings denied, all Rust
workspace suites, coverage at 94.71% against the 89% floor, 2,244 plugin tests,
the real-server E2EE gate, native CLI acceptance, 83 dashboard tests, chart
validation, 888 contract tests and both working-tree/range secret scans.
The Rust throughput measurement remains the existing ignored benchmark.
Initial failures exposed an obsolete export test invocation, the export's
pinned CodeQL digest and obsolete mutation records; those were repaired.
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

The native driver reported ten steps passed in 45.7 seconds. Its completed
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
