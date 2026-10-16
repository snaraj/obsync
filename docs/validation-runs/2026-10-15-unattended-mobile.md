# Unattended Android security acceptance

2026-10-15; [PR #347](https://github.com/snaraj/obsync/pull/347), security
release 1.1.8. This is an author validation record, not independent approval.

## Candidate and reproduction

Original core-run product source: `cb7b5ae4973ed7ba6d494865ed2ba4e7a4cac928`;
protected base: `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0`.
The [runner guide](https://github.com/snaraj/obsync/blob/2738e301f04bc2e8e5b1ecda2ec02e545706bb72/scripts/validation/MOBILE-ACCEPTANCE.md) describes the
single command, private pinned inputs, finite journeys and cleanup. The product
and driver checkouts are separate; the full runner requires committed driver
blobs and rechecks them after execution.

These hashes describe the successful core run and full batches 01–10. The
replacement-pairing fix below changes the plugin bundle and requires new runs.

| Installed input in those runs | SHA-256 |
| --- | --- |
| Official Android Obsidian 1.13.4 APK | `80505ced8442fafb2d681ecd66645f7855a3ea8beadfa7230f8d003e1101ff8b` |
| Candidate `main.js` | `a1127f8267f7934374321fe8946f455cc594e12701321f7a8221facfdf41aeb1` |
| Candidate `manifest.json` | `19f3a53197def24aa0488afdf945ebee739cf7adf84b200319dfccdddab6a0ef` |
| Candidate `styles.css` | `796f28c630774dc80e00b8ba4c0d3811d524b1cd844fe36d0f9597c5ee0e82ce` |
| Native server | `3b4f94a7baf5d05cfb6cb4d3b3a331b54fc232c0bbd9e0c35925238d0edf9a97` |

The APK digest matches the asset published by the
[official Obsidian release](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.4).
The Android target is API 35, Android 15, ARM64, userdebug, with the image's
2024-09-05 security patch level. This is neither current stock-device hardening
nor hardware-backed custody evidence. A guest-only test CA preserves ordinary
certificate verification; separate native probes must reject an untrusted CA
and a wrong hostname before the trusted route can pass. No public link, host
trust change or production service is involved.

## Measured status

At this checkpoint, **one complete one-command core run and zero full runs
have passed**. All twelve full batches stopped on their first failed attempt;
the remaining two attempts in each batch did not run. Earlier exploratory journeys are not counted as three fresh
acceptance runs. The first eighteen fresh runs remain failed in their original
directories. Run 19 passed the core path; all nineteen report successful
owned-process and runtime cleanup.
Their reduced attempt ledger has SHA-256
`9a0596c7191a86374e5489b3610bd55dfdec9e4c3bd10eac576d503599cd4ec5`.

Run 19 completed in 212.446 seconds, with ordinary pairing and consent and
two independently retrieved matching notes. Its terminal capture contains 48
connections, all with natural upstream EOF and no recorder errors. The last
outstanding response took 42.711 seconds to finish after ordinary desktop Quit;
the runner did not shorten or suppress that response. Its aggregate
`CORE_ONLY` receipt has SHA-256
`5af996b2077a77859a3d5634d19b1e964a70a730c539f4de074c133bcf8fa5b2`.
This validates the small automation path, not the full security journey set.

Full batch 01 passed the 213.006-second no-interaction interval, desktop normal
restart (779 ms to idle), Android process restart (5,299 ms to idle), guest
reboot with retained pairing, and two-way offline recovery. It then failed at
`access-repair-local-consent`: the runner observed active re-pairing and tried
to read a local note identity before observing index readiness. The product
adopts pairing before restarting its engine; the failed run does not establish
whether that identity would subsequently appear. Both controllers cleaned up.
The failed aggregate receipt remains unchanged, SHA-256
`66625ca88ffb19ff5ca65a2bf4e33d5a1ad007743d2449892d72272ff94898b2`.

Full batch 02, source and committed driver `2b2fc8382c735699dbab73942463717b76e3f30b`,
passed re-pairing, retained-note identities and independent bytes. Its 213.010-second
idle period, desktop restart (1,037 ms), Android restart (5,075 ms), guest reboot,
offline recovery and access-only revocation/re-pairing passed. It stopped before
staging key rotation because the desktop helper did not observe exactly one
active other-device row. The first-failure receipt did not retain that row count,
so it alone cannot distinguish stale UI data, rendering readiness or a product
failure. Cleanup passed and all owned runtime/private directories are absent.
The unchanged failed aggregate SHA-256 is
`476b1b78a307e265e5d1d565b12da5510d5ea703003df96872f3f0830945f172`.
The two-batch reduced ledger SHA-256 is
`83285f64170945a1f6f1e9f3b04e58027b031e6ea99c1e978664fb6d5fd57308`.

The next driver uses one ordinary Refresh before target selection, witnesses the
loading/completion transition, and compares the sole visible target with one
authenticated inventory read inside the existing 30-second budget. Unknown,
ambiguous or mismatched targets still refuse. Failure receipts now retain safe
list states and counts. A removed-refresh-witness mutation fails independently.
This repairs the evidence gap without claiming the exact old failure's cause.

Full batch 03, source and committed driver `b8354647337b3c4f916e7f927972335bdd4fef97`,
passed the bounded refresh: zero active peer rows became one row matching the
authenticated inventory in 67 ms. Rotation staging and preparation passed.
The next checkpoint, `prepared-before-restart`, failed; its generic diagnostic
does not identify the exact runtime refusal. Source inspection finds that the
checkpoint calls the general file-list endpoint, which the server intentionally
refuses while rotation is pending. Coordinator per-file reads and the exact
rotation inventory remain available. The test must use those permitted reads
without weakening inventory completeness, retained history, bytes or stopped-sync
assertions. This is a source-supported driver diagnosis, not a claim that the
failed receipt captured the API error.

The repaired checkpoint records the complete server file inventory during the
draft, binds the prepared inventory to its operation, coordinator, cutoff and
head commitment, then reads every permitted source file. Before commit it also
reads every destination derived by the exact bundled rotation planner from the
separately saved UI backups; the detached planner cannot read or write chunks.
Both pending restarts additionally require equality of the entire CRC-verified
owned server journal, detecting writes to file IDs outside the queried set.
Safe fixed stage/reason diagnostics replace the generic checkpoint refusal.
These are driver changes awaiting a fresh native batch.

The failed batch remains unchanged, SHA-256
`e05230442c9a76a81bbc4f33eeadf2a01f808368fd40dfe73aeebe2e8253a49b`.
Both controllers reported cleanup PASS, zero remaining owned process groups,
and absent runtime, private fixture and manifest paths; those paths were checked
independently. The three-batch reduced ledger SHA-256 is
`bbc1ce52f36039de1b7a65680a512d8fe69a584876b87ec3984cd3b003373b40`.
The 213.009-second quiet interval and earlier restart/offline/re-pairing checks
are partial evidence only; three complete passes remain required.

Full batch 04, source and committed driver `93f3e05dd7d521fe0eaab07c8bab7112dcc6bbf6`,
passed another 213.009-second interval without Android calls, ordinary desktop
restart (775 ms), Android process restart (4,414 ms), and guest reboot with
retained pairing and independent persisted-byte equality. It stopped at
`android-home-before-offline`, before exercising the repaired rotation checkpoint.
The helper sent one Home event and immediately sampled resumed activity; its
failure did not retain activity counts. The exact runtime state is therefore
unknown. Input dispatch alone does not establish the completed background
transition. The replacement observes that transition within a fixed deadline,
requires a positive non-Obsidian resumed activity and the same live Obsidian PID,
and retains safe counts on failure. It never repeats Home or accepts absent
activity as proof of backgrounding.

Both controllers reported cleanup PASS with zero remaining owned process groups;
their runtime, private fixture and manifest paths were independently confirmed
absent. The failed aggregate SHA-256 is
`253aa5320a17ffd15339e489b26dde69542abb1d59e84465dc526c28e3604f5d`;
the four-batch reduced ledger SHA-256 is
`b9375c1edb710028e42b5490acf893b65641110e7b93b7126e95c1075e01ec2a`.
These observations do not turn any failed batch into a full pass.

The Home repair passes the composed 113 Python and 114 Node harness tests,
66 scripted mutation controls and both secret scans. Its controls require one
Home event, passive foreground/null-to-background observation, same-process
retention, a positive resumed activity, session-expiry clamping and refusal of
a result received after the fixed deadline. These are offline checks; fresh
native acceptance remains outstanding.

Full batch 05, source and committed driver `4b51b7a4ce89be91b075688b7f34b6ca06b35469`,
passed Home observation, a 213.015-second no-interaction interval, desktop
restart (1,071 ms), Android process restart (5,063 ms), guest reboot and
independent saved-byte comparisons. After offline-route restoration, the
desktop-created note arrived on Android. The next check found the exact 75
persisted bytes and matching editor content for the Android-created note, but
its single immediate sync-identity lookup was absent. It failed after 432 ms.
The 15-second note-read deadline covered only persisted-byte arrival; the
replacement must also observe native index/identity readiness within that same
remaining deadline. This does not prove the missing identity would eventually
appear or that the full offline journey passed.

Both controllers cleaned up, with zero owned process groups and independently
absent runtime, private fixture and manifest paths. The failed aggregate SHA-256
is `d3c1e40c6902fb1d2ad0139f5fbdee9a10a48c93f28573a47638de241dcb2082`;
the five-batch ledger SHA-256 is
`1ed7e9db761a83d17ab43a85794575889b9ab4d7b6e7ea6b1938caf21586af35`.
The composed note-read repair passes 113 Python tests, 118 Node tests and all
76 scripted mutation controls, plus both secret scans. Its actual action-body
controls require one shared deadline, no editor open before identity readiness,
final independently retrieved bytes and unchanged editor/identity assertions.
Permanent missing identity, malformed identity, unexpected enrollment state,
late success, corrupted final bytes and incorrect editor content all refuse.
This is driver validation pending a fresh complete native batch.

Full batch 06, source and committed driver `769ffe3f413fabc4bc6247c5574c9d2a5bdb064c`,
verified the installed official APK initially and rejected the untrusted TLS
route. The pre-trust APK readback then failed exact hash equality, before any
test CA was installed. That old readback retained neither observed hash nor
byte count; its exact cause remains unclassified. The batch stopped and both
controllers cleaned up, with zero owned groups and independently absent runtime,
private fixture and manifest paths. The failed aggregate SHA-256 is
`91f110b185472bbbb77d36ef4cbe609fa03e2dce7cc20b90f5ce3642d4238925`;
the six-batch ledger SHA-256 is
`95782a5a70e78f18b64306c4878a4c4ed943c225b5934ec42e0df3e25040f201`.

The [ADB client source](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/client/commandline.cpp)
shows that legacy `exec-out` returns success after copying its raw stream.
The [daemon protocol](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/daemon/shell_service.cpp)
does not separate stderr or transmit the remote exit code for that mode.
Thus command completion alone cannot diagnose this hash mismatch. Exact pinned
APK equality remains mandatory; no failed read may be retried into a pass.

Full batch 07 at `7791dcd1b17252d8015aa91afccabf3bbe9a2d39` stopped during
the initial installation's separate raw-stream APK readback, before the new
trust-stage verifier ran. The controller receipt names `install` and an APK
hash mismatch; its precise cause also remains unknown. Both controllers report
cleanup PASS, zero owned process groups, and independently confirmed absent
runtime/private/manifest paths. The original aggregate incorrectly calls this
`android_controller_cleanup`; that receipt remains unchanged, SHA-256
`40c778ba0ce962cf71de13daf080c26a34cb22d347db9cef6ad3ccb9527602b8`.
The seven-batch ledger SHA-256 is
`ece47771cc3cdbc5d5ae534faabdc2a2dbb8b11101f33f2b2ac6091ccebb36f6`.

The corrected aggregate distinguishes a failed controller journey from failed
cleanup, propagates only a closed vocabulary of failure stages, and requires
both started controllers' cleanup evidence. Two regression tests and six
deliberate broken guards verify these distinctions. The installer and trust
probe share the strict file verifier rather than retaining two readback methods.
This is a harness correction, not a successful native acceptance result.
The shared-verifier composition passes 125 Python tests, 118 Node tests and
all 84 scripted mutation controls, with no skips. Both secret scans pass.

Source inspection found a separate selected-folder driver mismatch: Settings
can reside in an owned secondary document, while its typing and Save pointer
events were sent to the main vault target. The correction binds those native
events to the page containing the exact owned Settings pane and removes the
temporary DOM marker and connections afterward. Discovery and actions retain
a bounded deadline. This finding concerns input routing, not sync behavior;
the full native rename journey remains unproven.
Parent verification includes the complete action in both window topologies and
14 deliberately broken target/input/deadline/cleanup controls. It removes the
marker before closing the Settings document. The final composition passes
125 Python and 123 Node tests, all 84 scripted mutation controls and both
secret scans; the pinned strict documentation and output-origin checks pass.

Full batch 08 at `e978150e43a1728f679fe2d47d1ec53e97f1cd00` passed both
shared APK readbacks: 15,447,027 bytes matched the official hash, with initial
readback in 546 ms and pre-trust readback in 553 ms. Pairing, consent and both
persisted notes passed, followed by 213.003 seconds without Android calls,
desktop/Android process restarts, guest reboot, offline recovery and access-only
revocation/re-pairing. The parent independently rehashed all four core exports
and all 12 post-restart/reboot exports.

Prepared and commit-unknown rotation checkpoints passed before and after real
desktop restarts, including whole-journal equality. Seeding and the explicit
rotation commit passed. The new desktop note had matching editor/disk bytes;
the revoked Android peer refused access and lacked the new note. Post-rotation
ciphertext capture then failed after 363 ms with `owned_capture_refused`.
That generic diagnostic does not identify the failed assertion. Source review
finds an immediate idle/publication-identity requirement after a note action
that proves local editor/disk bytes only; the run does not prove whether
publication was pending or another capture guard refused. Direct old-key
decryption rejection remains unmeasured in this run.

Both controllers cleaned up, with zero owned process groups and independently
absent runtime/private/manifest paths. The unchanged failed aggregate SHA-256
is `1c2725d705577b078e5ade4efd101d94038aea430bb5adfb366d85fea44634eb`;
the eight-batch ledger SHA-256 is
`2870a167d0a1a4e20e5c59b4c508f3a736ba4d7ff39eb585aecfe10dd265a1b4`.

The capture now observes publication for at most 30 seconds within its unchanged
180-second total deadline. Only an absent local identity or ordinary syncing
may wait; wrong generation, map, enrollment, malformed identity and product
error states refuse immediately. Authenticated ciphertext reads begin only
after readiness, and all before/after current-head, decryption and independent
disk assertions remain. Fixed stage/reason values and boolean observations
identify future refusals without recording raw exceptions or secrets.
A controlled test of the real push code holds its acknowledgement after exact
local bytes exist, reproduces the old refusal, then verifies zero authenticated
reads until publication completes. Seven focused tests and all 20 deliberate
broken controls pass. This offline reproduction does not identify full batch
08's precise cause or establish a native acceptance pass.
The composed harness passes 125 Python tests, 130 Node tests and all 104
scripted mutation controls, with no skips; both secret scans pass. At
`e978150`, 46 hosted checks pass and one deployment check is intentionally
skipped. Required dispositions pass; the non-required CodeQL aggregate remains
red for the existing covered alert.

Full batch 09 at `fb84546eda5ada2c4d155efaf5a91aaf5499bc36` stopped during
onboarding before pairing. Installed plugin hashes passed, and the ordinary
community-trust click was observed. The next read discovered the owned Android
page in 82 ms but its WebSocket handshake hit the existing 15-second deadline.
This is an automation connection failure; the receipt does not establish its
cause, and no product acceptance or ciphertext-capture result follows.
Both controllers verified cleanup; the parent independently confirmed absent
runtime, private and manifest paths. The failed aggregate SHA-256 is
`ec56d5cd5ba55fd19407b91fc1602b9ad5a3871593175172c2c7c924f1bde7ce`.
The nine-batch ledger SHA-256 is
`c18a0095dbd05bab2ef4944735f39cb3ab1dd5026f801e8dcabe70a36075580d`.

Source review found that the driver requested WebSocket closure and immediately
removed its ADB forward without observing closure. The revised driver waits
for close completion before removing that owned transport and recording the
step receipt. Its existing 20-second release budget includes a bounded
two-second close wait; late removal, missing closure and cleanup errors refuse.
The single 15-second handshake records open, error or early-close facts, with
no added reconnect or retry. The existing startup path uses the same cleanup.
Seven focused tests include an actual Node WebSocket and delayed close reply
on a disposable loopback fixture; 14 broken controls fail. These prove the
driver lifecycle contract, not the cause of batch 09 or native acceptance.
Parent composition passes 125 Python tests, 137 Node tests and all 118 scripted
mutation controls, with no skips; both secret scans pass.

Full batch 10 at `32789b8d5b7a35ee97b674ee61b0dc3840ba800d` passed ordinary
installation, TLS rejection/acceptance controls, independent pairing-code
comparison, consent and two-way persisted notes. Its 213.004-second interval
contained zero Android calls. Desktop restart, Android process death/restart,
guest reboot, offline recovery and access-only revocation/re-pairing passed.
The parent independently rehashed 34 exported files from these phases.
Both interrupted-rotation checkpoints and the explicit commit passed.

Detached cryptography then opened actual native old and access-only ciphertext
with the old key, and current ciphertext with the new key. The old key rejected
the new map, manifest and content chunk. Tampering, wrong context and substituting
the current key into the old-key rejection assertion all failed as required.
This directly measures cryptographic revocation for the captured records;
server access denial is not used as a substitute. It does not establish complete
rotation acceptance or a general confidentiality result for the unfinished run.

The batch stopped at `rotation-repair-retained-history` after 20.295 seconds.
Fresh invitation, claimant submission, independently matched verification codes
and creator approval had passed. The status-only check did not observe active
replacement enrollment with both expected generations. Its connection opened
in 5 ms and closed cleanly in 5 ms. The receipt did not capture modal or custody
state, so the exact native cause remains unproven. Source inspection finds that
replacement enrollment still requires the ordinary conditional upload consent,
but this runner path omitted that step. Additional state diagnostics and the
ordinary consent path are required before another fresh batch.

Both controllers reported cleanup PASS with zero remaining owned groups, and
the parent independently confirmed absent runtime/private/manifest paths.
The unchanged failed aggregate SHA-256 is
`73eb104a113d31fd964983fdd75fcfe99032f1e75b28ec2351b6d6b0aaf768b8`;
the ten-batch ledger SHA-256 is
`18840d9a9430261500c6ae337f20be2e6e580db5c57bca1ce385a1bb5a60cb54`.
There is no attempt 02 or 03. Full recovery, retained-history restoration,
selected-folder stability and closed-run confidentiality remain unproven.
At this head, 46 hosted checks pass, deployment is intentionally skipped and
required dispositions pass. The non-required CodeQL aggregate remains red for
the existing covered export-logging alert.

The replacement investigation separately reproduced a production defect using
the actual plugin, persisted State, transport authentication refusal, claimant
modal and authenticated envelope codecs. After a rejected credential, the
claimant unconditionally reset its old enrollment; explicit replacement then
could not stage the history key because that operation requires the old paired
custody. The narrow fix skips this reset only for explicit replacement. Ordinary
revoked-device pairing keeps its existing reset. No revoked credential is
reauthorized, consent skipped or old engine restarted.

The parent rebuilt the fix and passed 160 relevant tests. New cases cover
replacement activation, consent acceptance/cancellation, persisted old-history
reload and refusal before receiving an envelope. Removing the replacement guard
fails the new regressions; disabling ordinary reset fails the existing ordinary
re-pairing case. The parent's first focused invocation used the preceding
compiled build and retained its expected regression failures; the rebuilt run
passed. The new plugin SHA-256 is
`babc5e9a94c56658a2ce173fb3fb632567ed5b23af67c425882de1ecfa241fef`;
manifest and styles hashes remain unchanged. Native acceptance of this changed
bundle is still required. This reproduction does not establish batch 10's
precise native cause.

The revised replacement runner explicitly observes the ordinary conditional
upload-consent step after the independently compared approval. A phone still
holding its old generation may wait only within the original 20-second approval
deadline; an unrelated paired generation refuses. The subsequent local-index
check receives only the remaining budget. Safe terminal facts identify consent,
custody phase, history and rejected-enrollment state without exporting secrets.

A missing consent prompt is admissible only against independent server evidence
prepared before the invitation. The new-generation proof authenticates the map,
all included manifests/chunks and desktop bytes. It excludes only exact old IDs
bound to the frozen rotation inventory and unchanged old heads/history, requires
every deterministic new destination, and re-derives those destinations from
authenticated metadata. Unpinned or foreign records cannot be silently skipped;
the complete server head set must remain unchanged across the proof.

Parent composition passes 125 Python and 146 Node harness tests and all 142
scripted mutation controls, including 24 new consent/inventory controls.
The complete rebuilt plugin suite passes 2,527 tests. Real-server E2EE passes
21 flows and both deliberately broken confidentiality controls, with 380 captured
requests and 148 seeded needles; four CORS-route tests and both secret scans
also pass. These checks precede a new native run; they do not retroactively
change any failed acceptance result.

The remaining canonical targets pass on the composed tree: formatting, lint,
Rust suites, 94.85% Rust line coverage against 89%, the 207-command installed
native CLI journey, dashboard, chart and repository contracts. The already
completed plugin, E2EE, mobile-harness and secret targets were reused rather
than rerun by the remaining-target command. This completes the local battery;
fresh hosted checks and native acceptance still follow the signed checkpoint.

Full batch 11 at `69e2858a128c6edb58541f74647d05a9cf6f4bd0` refused the
private configuration's stale `main.js` pin before either device controller
started. The parent had updated the build receipt but left the old top-level
pin. The original aggregate remains FAIL with cleanup UNKNOWN and a missing
receipt error; the retained controller log identifies the artifact mismatch.
Independent path checks found no device runtime created. The configuration
was corrected against both rebuilt copies, and the real configuration preflight
then passed. This is an operator configuration error, not a product failure.
The failed aggregate SHA-256 is
`92e32ddaf9ecaa3aad93ea3812f19decaf4d93fed466c6f8574c517a12392582`.

Full batch 12 on the same committed source/driver passed ordinary pairing,
consent, two-way bytes, idle, restart/reboot, offline recovery, access-only
revocation/re-pairing and both interrupted-rotation checkpoints. The actual
new-generation map, manifest and chunk rejected the old key; old/access-only
ciphertext still opened with the old key, and the new key opened current
ciphertext. The parent independently rehashed all 34 exported note files.
The run stopped at `independent-rotation-preinvite-known-notes`, whose child
reported `rotation_checkpoint_provenance` after 342 ms. This remains FAIL;
replacement pairing, history recovery, renames and the closed confidentiality
scan did not run. Both controllers cleaned up, with zero owned groups and
independently absent runtime/private/manifest paths. The failed aggregate
SHA-256 is `1ff860b61880b80c308e7250762397ef400fdf94990759e1d7b080035bbd14f5`.

The checkpoint writer hashes the exact saved JSON, including its final newline.
The new inventory reader instead used a trimmed text read before checking that
hash. This changes the bytes under comparison and rejects a valid persisted
checkpoint. Pending rotation correctly carries the new generation; changing
that generation binding would be an incorrect repair. The correction must
read exact bytes while preserving ownership, size and provenance checks.

The corrected reader passes the actual private-save/read serialization test;
trimming at either the call site or reader and hashing trimmed bytes all fail.
Separate production State/checkpoint execution confirms the pending generation
is new while the credential root remains old until activation. Parent composition
passes 125 Python and 148 JavaScript tests, all 145 scripted harness mutations
and both secret scans. An initial sandboxed invocation could not inspect its
owned processes; its failure log remains retained, and the owned leftover sleep
was identified and removed before the successful run with required local access.

The hosted Windows transient-rename test also failed at `69e2858`. A controlled
initial filesystem rename refusal reproduces the same landing-wait timeout:
the test mistook the recovered initial download's retry log for its current
edit's retry. Scoping that observation to logs after the edit begins fixes the
reproduction without changing production code or deadlines. All 16 affected
tests pass, and four broken controls fail. The exact hosted scheduling remains
unknown. That head has 44 successful checks, the Windows failure and dependent
gate failure, one intended deployment skip and the covered CodeQL aggregate
failure; required dispositions pass. Fresh hosted results remain required.
The twelve-batch retained ledger SHA-256 is
`b5a4d16907a4d0728b1852edf3926818a1aa317b0283b6f3edc681cd87d2071e`.

A source-level review also found a deterministic later history-control mismatch:
typing the filename does not redraw the modal's initial Load next button.
The ordinary Restart search action redraws Search without issuing a query;
Search then performs the query. This is a driver correction, not a production
change or native history-acceptance result. The selected-folder Settings lookup
also uses the same live owned Settings document as the existing desktop helper;
main-vault Files controls remain separately bound. Initial absent panes may
become ready only inside the existing deadline; ambiguity still refuses.

| Attempts | First failure and diagnosis |
| --- | --- |
| 01–02 | Shared-driver import entry point and emulator-port validation; harness errors |
| 03–07 | Native permissions and initial vault/plugin readiness were read before their asynchronous transitions completed |
| 08 | Restricted Mode after restart; installed files alone did not prove the plugin was enabled |
| 09–11 | A repeated Create action raced the original native permission/SAF flow; a pointer guard correctly rejected an obscured control |
| 12 | Community trust was visible before force-stop but absent afterward; installation now follows the official application's startup trust flow |
| 13 | Independent saved-note comparison failed after installation and all TLS probes passed; the ADB export command incorrectly quoted an already escaped argument |
| 14 | The ordinary pairing modal did not appear; action completion did not establish the required UI transition |
| 15 | Typed Server URL remained uncommitted after a Tab key; independent native and saved-file checks refused pairing before any claim was submitted |
| 16 | Settings close committed the URL, both verification codes matched, and creator approval passed; active pairing was not observed after mobile consent. That path lacked a delivered-click witness and exceeded its CDP evaluation timeout |
| 17 | The consent target moved before input; the new movement guard refused before sending a click. Pointer readiness now requires a stable position within the original deadline |
| 18 | All core native assertions passed, including consent and both persisted-byte exports. Recorder shutdown detected a truncated stream; aggregate acceptance correctly failed, with both controllers cleaned up |

These failures do not establish a product defect. They establish why action
completion, DOM presence, a successful transfer command or plugin status alone
cannot prove acceptance. The runner must retrieve real saved bytes and retain
the first failure. Source inspection used the actual official APK assets for
onboarding and trust behavior; ADB's command construction was checked against
its upstream implementation. Fixes preserve the original assertions and their
deadlines.

The canonical `make check` completed successfully with the pinned toolchain and
`OBSYNC_ORACLE_SOURCE` naming the separate clean candidate checkout. It includes
102 Python and 90 JavaScript mobile-harness tests, all 32 scripted mutation
controls, 2,524 plugin tests, 930 contract tests, Rust line coverage of 94.85%,
and both secret scans. Its output SHA-256 is
`635e4bea2f0933ae5419b848c1239b7d0915976aee486d9948bcebf68a664e16`.
These validate regression behavior and rejection controls; the native run above
is separate evidence.

The bounded review of the remaining recovery path also found an incorrect
negative-test expectation: old and valid unrelated recovery roots derive a
different generation, so the server refuses them with `generation_mismatch`
before evaluating their recovery proof. That is distinct from a matching-generation
bad proof. The corrected helper must require that exact refusal, unchanged
local custody, no adopted credential, no recovered note bytes or indexed notes,
and the independent parent's unchanged journal check. No native pass is claimed
for this correction yet.

The composed repair passes 107 Python tests and 114 Node tests, with no skips,
plus all 59 scripted mutation controls and both secret scans. The whole-journal
comparison additionally has a deliberate unseen-write mutation in its regression
test. These are offline controls; they do not count as the three required native
runs. The first composed check correctly refused its old positive receipt fixture,
which lacked the newly mandatory whole-journal fact; that fixture was updated
and both omission and false-value admission controls still refuse.

At `b8354647`, all 46 successful hosted checks are terminal and the deployment
check is intentionally skipped. The non-required CodeQL aggregate still reports
the previously reviewed covered alert; required dispositions pass. These checks
do not substitute for the failed full native batch.

At `93f3e05`, the hosted macOS device-name test lacked the post-save adoption log,
and the Windows transient-rename test exhausted its unchanged I/O deadline.
Source inspection found an earlier device-name readiness predicate and slow
stepping toward an already-recorded 60-second virtual retry. Both failures are
retained; the hosted logs do not establish exact scheduling. Controlled delayed-save and slow-clock experiments
reproduce the old failures and pass with the corrected test drivers. Adoption
now waits for its post-save receipt; the rename test advances once to the
observed retry and then waits for actual I/O without further virtual advance.
The existing assertions and real-time deadlines remain in force. Neither fix
changes the product or supplies a hosted pass; fresh hosted results are required.
All 23 focused tests pass. Four broken-product controls still fail: missing
adoption receipt, missing adopted name, disabled retry and late retry.
The hosted follow-up at `4b51b7a4` completed with 46 successful checks and one
intended deployment skip, including both repaired platform tests. Required
dispositions pass; the non-required CodeQL aggregate remains red for the
reviewed covered alert. This does not override full batch 05's failure.

## Remaining gates

The installed-APK probe now performs one ADB file pull into an owned private
temporary directory. Independent device-side size and SHA-256 witnesses before
and after must match the pulled file and the official APK pin; a changed path,
partial transfer, command failure or mismatch refuses before trust installation.
All operations share the original 30-second deadline, clamped to session expiry.
Temporary APK copies are removed on both outcomes. Reduced receipts retain
counts, hashes, stage and exit status without private paths or command output.
Offline tests and deliberate broken controls cover these checks; the change
does not establish a native pass or explain full batch 06's exact cause.
The composed gate passes 121 Python tests, 118 Node tests and all 83 scripted
mutation controls; both secret scans pass. At predecessor `769ffe3`, 46 hosted
checks pass with the intended deployment skip and covered CodeQL aggregate
failure; the required dispositions check passes.

The small native path passed. Three consecutive fresh full runs still must
include native restart/reboot,
background/offline recovery, revocation/re-pairing, interrupted rotation,
old-key rejection against actual new ciphertext, recovery and selected-folder
rename stability, followed by closed confidentiality evidence and cleanup.

An emulator does not discharge the current physical-phone requirement in
`docs/validation.md`. The conditional USB core path is unexecuted and does not
yet establish the full physical journey set. iOS Keychain/WebKit, OEM lifecycle
behavior and hardware-backed custody remain unclaimed. Exact final-head hosted
checks and independent adversarial approval also remain required before Ready;
the owner alone merges.

At head `2738e30`, hosted checks found four new uncovered JavaScript findings
in test-driver string handling, a strict docs-link failure, and an asynchronous
parked-note status assertion in the image test. Those failures require repair;
local gate success does not override them. The existing ciphertext-identifier
logging alert remains covered by its reviewed `cli/export.rs` file hash.
No alert was manually dismissed or excluded from analysis.

The follow-up waits for the re-paired local index only within the remaining
original approval deadline; unexpected paths or wrong identities still fail
immediately, and independent saved-byte checks remain required. The test-driver
serializer now escapes JavaScript/HTML delimiters, and native XML text is decoded
once. A deferred real feed write reproduces the parked-test race; its bounded
wait now includes in-flight pulls and the observed idle state, with its deadline
and final assertions unchanged. The never-idle control still fails. All 18
focused parked tests and the pinned strict documentation build pass locally.
Hosted JavaScript/Rust analyses, required dispositions, strict docs and image
checks pass at `2b2fc838`. All 46 successful checks are terminal; one deployment
check is intentionally skipped. Required dispositions report one covered alert,
zero uncovered alerts and zero drift. The CodeQL aggregate remains red for the previously
reviewed logging alert. Full native acceptance and final-head checks remain
required.
