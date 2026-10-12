# Security train: integrated regression and native transport findings

2026-10-12, [audit #344](https://github.com/snaraj/obsync/issues/344),
implementation [PR #347](https://github.com/snaraj/obsync/pull/347).
This record distinguishes implemented repairs, author verification and open
acceptance. It is not a whole-system security approval.

## Source

Protected base: `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0` (1.1.7).
Implementation predecessor: `482d512e027b57154bfac07b71ea2a706102642f`.
The candidate adds diagnostic, chunk-retry and pairing-report repairs to that predecessor.
The resulting plugin bundle SHA-256 is
`eac31da302ebd62fba3c8011fcc9a83045ee194abd84b5c9e1362ea1fa430a2a`
(1,406,984 bytes).
The candidate's relevant source hashes are:

| File | SHA-256 |
| --- | --- |
| `plugin/src/sync/pull.ts` | `fcfdb4856c575bfddf1489834569b64327a5092bd49c239ecc73b7cad2df9436` |
| `plugin/src/transport.ts` | `b5e7a7cfda9ccc5db9026bfac8125a7123be104707ef71510144bbee5f2e2d55` |
| `plugin/src/vaultPath.ts` | `aea14a28198f8d1606c85ead0c6a9c7e6295e58ad5ef4c7f221d10a7ec5eeea2` |
| `plugin/src/ui/modals.ts` | `5bdaadbda407ea971d2dfd46f0aae516ed4dccd125100620c72a092ed96bfcd2` |
| `plugin/src/pairing.ts` | `f12d16b2a0d068b67bc41d9e48f87c24af98feed6e18f582f3296c56bad5a74d` |
| `scripts/ci/e2ee.mjs` | `c2257bb189062b0acabc1d244952943bc7ea360b94bf7d856100c93724709767` |
| `scripts/validation/e2ee_mutations.py` | `ff5754f068f5806177b9b64363ae0be041354569938bc764415766e7064aebbf` |

## Reproduction entry points

Run from the repository root with its pinned tools:

```sh
make check
node scripts/ci/e2ee.mjs
node --test plugin/test/crypto.test.mjs
cargo test --locked -p obsyncd api::auth::tests
cargo test --locked -p obsyncd --lib doctrine_test
python3 -B -m unittest discover -s scripts/ci -p test_e2ee_contract.py
python3 -B -m unittest discover -s scripts/ci -p test_obsidian_evidence.py
node --test scripts/ci/obsidian-evidence.test.mjs
```

`python3 -B scripts/validation/e2ee_mutations.py` is the complete mutation
entry point after building the plugin and server. The executed subsets and
overlapping author controls below are described separately; this record does
not claim a single final 98-case execution. Native results come from
`node scripts/ci/obsidian-drive.mjs`, configured through its documented
environment inputs with `OBSYNC_E2E_SECRET_STORE=macos`, the installed Obsidian
binary, this built plugin, disposable vaults/token and a recording loopback
server. No personal vault, public server or system trust changes are required
for that HTTP journey. TLS/redirect probes used separate synthetic endpoints.

The documentation check uses Python 3.12 with `docs/requirements.txt` installed
using `--require-hashes --no-deps --only-binary=:all:`, then
`python3 -m mkdocs build --strict` and both `site_origins.py strip` and `assert`.
Local logs are reduced to the observations below; raw credentials, profiles
and captures are removed after verification.

## Implemented and exercised

The coordinator's initial integrated real-plugin/real-server sample recorded
**19 flows, two planted-leak controls, 185 requests/responses,
12 storage files, 48 needles, 6,867 ms**, within its 120,000-ms budget.
The exact request and needle counts are observations, not fixed expected
counts. That sample preceded the retry correction below; it does not validate
the final parking behavior. The existing scanner and capture refusal rules
remain mandatory.

The flows are setup, pairing, create, edit, attachment, rename, folder move,
delete, restore-copy, pause control, recovery, access-only revocation, history,
hostile receive, hostile feed progress, domain-map refusal, domain-map rollback
limitation, API-only decryption refusal and tamper refusal. Added observations:

- A folder move carries its content and empty subfolder; the former paths
  disappear. Deletion removes the recipient copy. History restore makes a
  fresh file identity with byte-exact content, without reviving the tombstone.
- Actual manifest, parent and chunk responses are damaged at the recipient
  boundary. The production receive path refuses each, without changing saved
  bytes, accepted records, folders, holds or staged content. Honest delivery
  afterwards still works.
- A damaged chunk previously raised a raw WebCrypto `OperationError` and
  stalled later feed records. The first repair made it a permanent manifest
  refusal, which the broader suite correctly rejected: it discarded the
  file's retry. The final repair normalizes it to
  `ManifestError("chunk_authentication")` and maps only that reason to the
  existing `Unwritable` per-file parking mechanism after manifest validation.
  Later files arrive and the cursor progresses; bad bytes remain unapplied.
  The amended existing receive-path test verifies a visible integrity reason,
  persisted parking after state reload, and successful recovery/park removal
  after authentic bytes return and Sync now runs. No new queue was added.
  Missing chunks retain their existing retry behavior; history assembly
  still refuses damage.
- Corrupted and visibly forked domain maps refuse. Two real divergent writes
  create a fork. Replaying an authentic old sole-head response remains
  readable: this explicitly demonstrates the freshness limitation.
- A device API secret and account-recovery proof cannot open actual content
  manifests or chunks, even with the decrypted chunk identifier supplied.
  The honest content key opens those same bytes afterwards.
- Closed clear-field inventories cover the three exercised read routes:
  change feed, file and individual version. They are not an inventory of every
  administration, authentication or pairing response.

The harness now uses an explicit **synthetic** root vector, bytes 1 through
32, to prevent randomly generated recovery words from colliding with its
ordinary public fixture vocabulary. Production derivation, pairing and
recovery code still execute; pairing secrets and ephemeral keys remain fresh.
No production key override or scanner exception was introduced. A prior
random-root baseline refused a recovery-word hit and produced no mutation
evidence. Its individual failed log was not retained; the failure is not counted
as a passing run. A controlled public-word collision reproduced the mechanism,
without proving which discarded bytes caused that particular earlier hit.

Diagnostics now omit server free-text detail from generic `ApiError.message`.
Only the closed protocol code vocabulary can enter that message; the source
inventory exercises 70 current server codes and one compatibility code through
the real parser. Explicit consumers retain `.detail`. Recognized relative
filesystem operands and explicit `.path`/`.dest` fields are redacted, and
ASCII control characters cannot forge diagnostic lines. This is not a claim to
identify every private value in arbitrary free text.

Creator-side pairing now attributes success, missing/removed state and timeout
to **server reports** and asks the person to check syncing on the recipient.
Previously a fabricated `consumed` response and active heartbeat row produced
“it holds the vault key now”. The added test corrupts the actual envelope,
proves the intended recipient refuses it, and still feeds that fabricated row
to the creator: the resulting notice must not claim independent possession.
The existing polling/acceptance state machine is unchanged. No authenticated
peer receipt or new protocol is introduced, and no root disclosure was shown.

## Tests and mutation evidence

The client worker passed 357 focused tests and 82 diagnostic mutations
(11 boundary changes plus 71 code-vocabulary removals), restoring the sources.
The coordinator inspected the patch and separately passed 145 tests covering
transport, diagnostics, engine and merge inputs on the composed build. The
chunk repair also passed its 129-test focused suite; the original failing
tamper test and the two obsolete raw-error expectations were retained as
failed intermediate results before the expectations were corrected.

The assurance worker passed 34 scanner and 11 contract tests. Its mutation
audit killed **90 unique cases**: 30 scanner, 49 engine, nine CI-contract and
two compiled-runtime cases, in nonoverlapping batches of 55 and 35 with green
restored baselines. The initial folder-notification removal survived because
ordinary reconciliation still completed the move; it is not counted. The
replacement changes the actual destination and fails the intended readback.

The Make contract now counts space- and mixed-tab-prefixed duplicate targets.
The behavioral control proves GNU Make accepts those declarations, overrides
the required recipe and returns success without executing the failing Node
command. Removing either target guard must fail the regression. The runtime
mutations rethrow the original authentication error in a disposable compiled
copy: direct receive and public-feed progression fail independently.

The initial complete gate failed seven plugin tests: three obsolete raw-error
message expectations, three conflict-copy rejection expectations affected by
the first chunk fix, and the actual retry regression above. The final parking
repair restores rejection for failed conflict writes and preserves their
unchanged-content/cleanup assertions. Error tests now assert status, code and
preserved explicit `.detail`, without returning free text to generic logs.
The client worker passed all 141 tests across those files and Leave UI tests.
An intermediate coordinator notice assertion used the wrong fixture shape;
the corrected test checks the typed notice before rendering and passes.

A separate author pairing pass ran the six existing suites
`pairing-v2`, `pairing`, `pairing-vault-ui`, `pairing-claim`, `account-recovery`
and `recovery-phrase` via `node --test --test-reporter=tap plugin/test/<name>.test.mjs`:
149 passed, none failed/skipped, on the unchanged predecessor pairing source.
They cover fixed-claim/reveal ordering, commitment/key substitution, context
binding, expiry and cleanup, save-before-sync and recovery authority. This is
not a coupled hostile-relay or physical two-screen comparison test. The parent
real-server API/proof-only decrypt negatives above are separate evidence.
After the wording repair, the worker passed 90 affected pairing tests and
seven source/assertion mutations, with restored controls green. The coordinator
then rebuilt the composed artifact and independently passed all **150** tests
in the six pairing/recovery suites, including the new spoofed-report case.
Four existing mutation patches (M1854, M3599, M3921, M3519) were rebased to
apply to the revised strings while preserving early-completion, unclosed-modal,
lost-unload-cancellation and premature-status defects. All four apply, compile
and fail their intended existing UI tests; each restored 29-test creator suite
passes. M3921 fails its existing bounded wait before the later cancellation
assertion because the uncancelled scripted polling runs past the observed count.
The runner's initial expectation of that later assertion, and an initial copy
setup error, are retained as failed attempts and are not mutation kills.

The coordinator also passed the existing 37 server-authentication tests and
105 release-contract tests. Those results establish their tested boundaries,
not deployment or publisher state. The repaired `make check` passed: Rust
format/lint/workspace and **94.71% line coverage**, **2,248 plugin tests**,
the native CLI checks (including its 13-test POSIX floor), **83 dashboard
tests**, chart checks, **909 repository contracts**, and both secret scans.
Its E2EE invocation recorded 19 flows, two controls, 186 matched requests,
12 storage files and 48 needles in 6,805 ms. It ran before the final two
late-chunk key needles and macOS CI contract below; it is not a claim that
one final immutable head passed every later check in that same run.

The final assurance inventory contains **98 mutation cases** (30 scanner,
56 engine, nine CI, three compiled-runtime). The initial 90-case audit above
was followed by 15 affected/new parking cases and two late-key cases, with
passing restored controls. Unchanged cases were not rerun as a full 98-case
batch. The late-key delta adds the actual keys for two chunks created after
the earlier inventory loop, bringing the baseline to **50 needles**. The
coordinator independently killed five final feed-leak/inventory/runtime/retry
mutations and two integrity-notice mutations, with restored controls passing.
These overlapping checks are not added together as a unique-case total.
A final baseline on the composed pairing-message build passed **19 flows,
two controls, 185 requests/responses, 12 storage files, 50 needles, 6,574 ms**.

The native driver now accepts an explicit macOS encrypted-store expectation,
refuses unsupported store names (including inherited object properties), and
checks custody and revision after both app restarts. Seven focused Node tests
and seven driver-source mutations passed. The macOS desktop job sets that
mode, and a required repository contract pins its invocation and prevents
conditional/ignored execution. Both focused Python tests pass; 11 workflow
mutations fail with the intended assertion, and restored controls pass. This
does not turn the separate optional
Desktop matrix into a required publication check. After the final documentation
additions, 20 doctrine tests pass; the pinned Linux documentation build passes
with 160 files, 8,334 anchors and zero origin refusals. Its first container
launch used an image ID as a repository digest and did not start; the corrected
local-image invocation produced the successful result.

## Native transport: one pass and one unresolved failure

A separate disposable desktop profile loaded the earlier candidate bundle
`74ad4e02febc32666c779bce9901aecbab2c70b582e8c51b634482301968eaf5` in installed
**Obsidian 1.13.4, Electron 43.1.1, Chromium 150.0.7871.114, runtime Node
24.18.0**, on macOS. This is distinct from the newer hosted desktop pin.
Only synthetic credentials and loopback endpoints were used. No system trust,
certificate store, personal profile or vault was changed.

An HTTP POST control delivered the expected 130-byte body. An IP-SAN-correct
self-signed HTTPS endpoint was refused with `ERR_CERT_AUTHORITY_INVALID`
in 17 ms. The endpoint observed a TLS alert and **zero HTTP requests or body
bytes**. This proves the tested untrusted-certificate case, not every TLS
failure or another platform.

**Redirect containment failed.** The actual public `requestUrl` adapter
silently followed cross-port redirects to a second loopback origin:

| Response | Destination observation |
| --- | --- |
| 301, 302, 303 | GET, zero body bytes; dummy Authorization, device, signature and configured edge headers all forwarded |
| 307, 308 | POST, the exact 130-byte synthetic setup/recovery body and all those headers forwarded |

Every call returned 200 from the destination. A response-time status check
cannot undo this disclosure. The vendored public request API has no redirect
control. This is a credential-origin containment finding; the fixture did not
send a content key or demonstrate a break of content encryption. A malicious
configured endpoint already sees these API credentials, while redirection
exposes them to an additional origin. Supported cross-platform remediation
and compatibility with authenticated upstream proxies remain unresolved.

A separate native `fetch` probe refused a redirect before the destination
received a request. Without CORS permission it sent only an anonymous OPTIONS
preflight, which the fixture refused; with synthetic CORS permission the
control POST succeeded. Replacing `requestUrl` with `fetch` therefore needs
actual authenticated-proxy and phone compatibility proof. An unsupported
Electron bridge probe did not complete and is not a proposed remedy.

The worker verified its owned app exited, both fixture servers closed and
the temporary profile, certificates and captures were removed. Sanitized
observations were retained. No physical-phone transport result is claimed.

## Native sync and macOS custody

The composed `793d16818dd8c9cf0a18b8dbd397c1f0eb7e08dfb3ce3e79df40c7c3eda5fd5e`
bundle passed **11 steps in 49.5 seconds** in actual Obsidian 1.13.4 / Electron
43.1.1: setup/phrase confirmation, v2 pairing, notes both ways, rename,
nested and empty folders, repeated edits, simultaneous editing, watcher
starvation/recovery, and both app restarts with encrypted custody. Both disks
and editors retained the exact 100 + 100 keystrokes with no conflict copy;
six reduced editor receipts matched disk hashes. Restart retained pairing,
reported encryption available and plaintext JSON false, and transferred notes
both ways. A named backend was not exposed on this platform; none is inferred.

The real observer recorded **13 connections and 2,196 requests matched to
2,196 responses**, with zero capture errors and zero hits for **44 path/content
needles**. Native content keys were not inventoried, so this is narrower than
the required engine harness's 50-needle key/content scan. This sync journey
used loopback HTTP; the separate self-signed TLS observation above proves its
own limited case. All four owned app process groups and the driver/server
exited; profiles, server data, tokens, raw traffic and screenshots were removed
after retaining reduced evidence. No physical-phone result is claimed.

A later comment-only correction to nonce claims changed the deterministic
bundle to `3a3abc4561406d12e29bb4dcbd3d2207c0d8126d6d36bb35af4ea2a5175f9de3`.
That artifact also passed all 11 native steps in 48.0 seconds, with six
matching editor/disk receipts, encrypted restart custody, and 2,198 matched
requests/responses across 13 connections. Its 44 path/content needles had
zero hits/errors. All four owned app groups and the server/driver exited;
raw fixtures were removed. The coordinator also confirmed that compiling
`crypto.ts` with comments removed yields identical executable bytes before
and after the wording correction, and its 23 focused crypto tests pass.

The final pairing-message build
`eac31da302ebd62fba3c8011fcc9a83045ee194abd84b5c9e1362ea1fa430a2a`
passed all **11 native steps in 47.6 seconds**, on the same actual app/runtime.
The creator visibly said that the server reports the synthetic recipient is
paired and asked the person to confirm syncing there. The coordinator inspected
the cropped real notice; its image remains local-only because it contains the
fixture's generated device name. This is native UI evidence, not a fabricated
toast or a refreshed production onboarding capture.

Final repeated edits measured p50 1,007 ms, p95/max 1,258 ms; 100 + 100
keystrokes over 20.083 seconds reached both disks/editors 452 ms after the
last insertion with zero conflict copies. Six editor receipts matched disk
hashes. Encrypted custody survived both restarts, with plaintext JSON false,
no unencrypted warning, and resumed transfers in 753/1,004 ms. The complete
observer recorded **13 connections and 1,886 matched requests/responses**, zero
errors/hits for **34 labelled observations of final current disposable file
paths/content and vault names**. Labels can contain the same value on both
peers; this is not a count of distinct secrets. The helper walks each current
`e2e/` directory, records relative file paths and current UTF-8 content of at
least four characters, and adds the two vault names. It does not inventory
all transient/deleted/renamed-away material, native content keys or attachments;
this run seeded no attachment. No named per-flow coverage requirement was
imposed by that supplemental scan. The driver separately verifies note and
co-typing readback; the explicit 50-needle engine harness covers its own named
materials. Retained native JSON records counts rather than complete inventories,
so the exact earlier 44-to-34 difference cannot now be reconciled; no explanation
is presented as a measured fact. Its owned four app groups, driver/server and raw fixtures were
removed; only reduced evidence and the local-only notice image remain.

## Architecture and remaining acceptance

The [revocation proposal](../security/device-revocation.md) is a design for
independent review. It offers access-only removal or a fresh root, full reseed
and explicit re-pairing. It reuses existing encryption and pairing v2, keeps
the root out of server/management surfaces, and does not trust a server device
directory to choose recipients. It is **not implemented**.

Coordinator probes of the existing production primitives demonstrated old-root
and API-only refusal of freshly encrypted chunks, manifests and maps, and a
new recovery-phrase round trip. A separate existing-parser probe rejected the
proposed nested rotation envelope for lacking a top-level vault key. These
are primitive-composition and old-parser observations, not a completed
revocation transaction or a protocol verdict.

The [key/nonce inventory](../security/e09-key-nonce-inventory.md) identifies
shared manifest/map key lifetimes, conditional 96-bit collision bounds and
missing aggregate accounting. A forced, repeated-zero RNG probe demonstrates
GCM reuse under that synthetic fault; no real platform CSPRNG failure was
observed. Absolute nonce-uniqueness and independent-AES-oracle wording has
been corrected. These findings need cryptographic assessment, not a claim
that sample tests prove every key lifetime safe.

Still required: independent whole-system/pairing/proposed-protocol review;
resolution of the native redirect finding; rotation implementation and its
fault cases; physical-phone and any later-runtime native journeys; owner-agreed
release placement, lockstep metadata and current hosted gates. Live deployment,
Cloudflare account/billing and immutable publication are not established by
these local tests. No Ready, release completion or universal no-backdoor
certification follows from this record.
