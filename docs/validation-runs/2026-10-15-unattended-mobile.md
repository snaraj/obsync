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
have passed**. All eighteen full batches stopped on their first failed attempt;
the remaining two attempts in each batch did not run. Earlier exploratory journeys are not counted as three fresh
acceptance runs. The first eighteen fresh runs remain failed in their original
directories. Run 19 passed the core path; all nineteen report successful
owned-process and runtime cleanup.
Their reduced attempt ledger has SHA-256
`9a0596c7191a86374e5489b3610bd55dfdec9e4c3bd10eac576d503599cd4ec5`.

Full batch 18 used committed driver and rebuilt candidate
`76a7116fdca25d3be4650b2ee92aa2df185413e1`. Ordinary pairing, two-way bytes,
the 213-second no-interaction interval, both process restarts, guest reboot,
offline recovery, access-only revocation/re-pairing, interrupted rotation,
direct old-key rejection of new map/manifest/chunk ciphertext, history restore
and post-rotation restart passed before the selected-folder return failed.
The first selected-folder direction and five-minute observation passed. The
Android return's first intermediate rename passed; its second rename failed
the unchanged ten-second native folder/index readiness check. The two-action
step took 169,277 ms. That receipt cannot distinguish a missing native folder
from missing descendant identities, so the cause remains unknown. Recovery-C,
the second selected-folder stability window and closed confidentiality admission
were not reached. The parent rehashed 92 retained exported files; both controller
cleanups passed with zero owned groups and actual runtime/private paths absent.
The original aggregate remains FAIL, SHA-256
`fc497e7901aa014ce6efdebde59b0b339a431f481bd9e71b4231c034d56b664c`.
The eighteen-batch ledger has SHA-256
`83e230f1848e0c3c094fab9896d55ed000cc7b4573303bbbcf002017f41d7ae7`.

Two bounded native diagnostics investigated idle behavior without changing
power settings or deadlines. The first failed an asset readback, followed by
ADB reporting the owned emulator offline; it remains FAIL. The second installed
the exact candidate and renamed an empty folder through ordinary controls
before and after 300,005 ms without device calls. The two-action times were
7,525 ms and 5,462 ms. Android remained Awake and Obsidian visible/resumed;
the default screen timeout was unchanged. This did not reproduce the slowdown
and does not exercise synced descendants or establish host power-management
behavior. Both diagnostics independently verified cleanup. Their reduced record
has SHA-256
`4ccdd152a1692ccdb3df1dfeaadb1e92ed5bf2514cf9261ff755853d763c295e`.

The folder-index driver now retains first/last scalar observations of folder
presence, children-array presence, descendant count and missing/invalid identity
count. Its ten-second deadline, 100 ms polling, 32-descendant bound, readiness
predicate and independent persisted-byte/identity assertions are unchanged.
These facts diagnose future failures; they cannot reconstruct batch 18.
An independent retained-file audit also rejected batch 18's missing final
selected snapshot, confirming that partial evidence cannot supply acceptance.

The composed diagnostic change passes 141 Python tests, 179 Node tests and
194 scripted mutation controls, with no skips. The unchanged ten-second
deadline and readiness predicate are among the deliberately broken controls.
The gate log SHA-256 is
`713d1b4be75c7c27f474ec1bd2a35bf33b3fb57ee96c09a6171fdfccf9b9c596`.
An earlier sandboxed invocation failed because process inspection and loopback
TLS binds were denied. Its failed log remains retained; the complete gate ran
with those required local capabilities, and its recorded disposable children
were independently confirmed absent.

A separate fresh diagnostic reused ordinary core pairing and the actual
selected-folder phase, without the unrelated security journeys. TLS controls,
independent verification-code comparison, consent and two-way bytes passed.
Both selected notes reached Android with matching independently exported bytes.
The run then failed to save Android's selected-folder policy: the original
30-second check observed neither a changing scope nor the expected saved policy.
Its receipt verifies the typed input but has no pointer-delivery witness; it
does not establish whether Save was missed, refused, or awaited confirmation.
Neither rename nor either stability window was reached. All eight exported
files were independently rehashed after verified cleanup. The failed diagnostic
record has SHA-256
`8a91063c3b394106ed16a2950be7d3b6b1b49deba6f4ff87379b25753a4beaa7`.

The Save driver now reuses the existing trusted-click witness, restricted to
the exact "Save on this device" setting row. A moved target, another Save
button, an untrusted event or missing actual click refuses. One absolute
30-second budget covers target observation, the single click and the unchanged
saved-policy predicate. Safe first/last observations distinguish folder presence,
the rendered draft, a known confirmation and a known refusal. No action is
resubmitted. These controls address missing action evidence; they do not prove
the cause of the earlier failed diagnostic.

With both diagnostic repairs composed, the full offline harness gate passes
141 Python tests, 184 Node tests and 202 scripted mutation controls, with no
skips. Its log SHA-256 is
`65543124fa3be9ff73d6107858c7d6ebe01955396ff991bb85649259670c270c`.

The next fresh paired diagnostic established an action-driver failure at Save:
one mousedown, mouseup and click were all trusted, but all three reached a
different target from the intended button. The intended button remained
connected, the exact folder existed and the rendered draft matched. No known
confirmation or refusal was visible, and the policy remained unchanged. It
stopped after 1,964 ms rather than repeating the click. The receipt does not
record event geometry, so movement versus coordinate translation remains
unresolved. Both cleanups passed and all eight exported byte buffers matched
independent readback. Its failed diagnostic ledger has SHA-256
`e8c93bc0185ad73120189b4a8f7dc202959fbbb5292e71d14400a1fc905c40f8`.
The original batch-18 rename failure was not reached or explained by this run.

A smaller fresh, unpaired native diagnostic reproduced the wrong-target click.
The intended Save button moved down 236.95 CSS pixels between arming and the
trusted mousedown. All three events reached the textarea at the original point;
the visual viewport offsets stayed zero and its scale stayed one. Independent
readback of the event receipt confirms target motion, rather than an observed
coordinate-offset discrepancy. The underlying scroll or focus trigger is not
established. The one click was not repeated, and the run remains FAIL. Cleanup
passed with zero owned process groups and actual runtime/private paths absent.
Its reduced ledger has SHA-256
`1c8a0381eaa86345bb57191d414ac504f361078c0efa82ee52a80a2d7b325d79`.
This diagnostic does not exercise pairing or explain the original rename failure.

The driver repair scrolls Save into view once, observes its position and hit
target without further scrolling until stable for 200 ms, then rechecks the
target without scrolling before its single witnessed click. Movement restarts
the stable interval; permanent motion or occlusion refuses. Observation, click
and saved-policy verification remain inside the original absolute 30-second
budget. Product behavior and all resulting-state assertions are unchanged.
The composed offline gate passes 141 Python tests, 186 Node tests and 207
scripted mutation controls, with no skips; log SHA-256
`6111125ac55b148fa045beac876563585f37e1477fff1715d2218a5cc5cef7e9`.
Removing settling, retaining a stale position after movement, repeating scrolls,
omitting readiness or skipping the actual click all cause control failures.

The first native diagnostic with that repair failed earlier, before candidate
installation. The owned vault appeared, but official Obsidian's layout-ready
flag remained false through the existing startup deadline (46 observations).
The Save repair was not reached. The offline gate ran concurrently; resource
interference is a hypothesis, not a demonstrated cause. The failed run and
verified cleanup remain recorded, with reduced-ledger SHA-256
`7195a9b9436c06b78176ad1ac6bf32c65ac91c38076851a3f5e76c87db41c38e`.

The next fresh diagnostic ran without the offline gate and passed the small
unpaired path. Save was stable for 278 ms, received exactly one trusted click
on the intended button, and the saved policy matched within 1,956 ms. Independent
receipt readback confirms unchanged button geometry through all three pointer
events. Startup observations took 7,047 ms, 0 ms and 0 ms; the document was
visible and focused, and Android reported Obsidian resumed and Awake. Cleanup
passed with actual runtime/private paths absent. Its ledger SHA-256 is
`17c5df7d238ed7e94f6d9f575eda405ca28427a657bdb9bbf6a69d1933601e2f`.
This establishes the focused Save result, not the earlier startup cause,
selected-folder synchronization or full acceptance.

An actual-source boundary test separately showed that native readiness could
accept a ready result at 20,001 ms under its 20-second limit. The deadline now
starts before the first observation and rejects a late first or final result.
The 20-second limit, 100 ms polling and foreign-vault refusal remain unchanged.
Deliberately removing either time boundary fails the new regression control.
The final composed offline gate passes 141 Python tests, 187 Node tests and
209 scripted mutation controls, with zero skips. Its log SHA-256 is
`f15107b161045cd045e9b053b2e6743b1ee087c215e281fc753e1b3d53f7bd56`.
Both working-tree and outgoing-history secret scans pass.

Full batch 17 used committed driver and rebuilt candidate
`4ff8ae2274a2a07a7b0591bf19276b30f3c2a32d`. It passed ordinary pairing,
two-way bytes, a 213,003 ms interval without Android calls, desktop/Android
process restarts, guest reboot, offline recovery, access-only revocation and
re-pairing, interrupted rotation, direct old-key rejection against new
map/manifest/chunk ciphertext, authenticated history restore and post-rotation
restart. Both selected-folder rename directions passed with five-minute
stability observations of 301,456 ms and 301,482 ms. The Android two-action
rename took 6,699 ms and retained the two original descendant identities.
Old-root and valid unrelated-root recovery refusals left the whole server
journal unchanged.

The run then failed at `recovery-c-setup-wrong-token`, after observing the
authenticated `bad_setup_token` refusal. Its aggregate local-state/content
postcondition failed, but the receipt does not identify which predicate failed;
the cause remains unproven. Both controllers report cleanup PASS, zero owned
groups, and independently verified absence of actual runtime/private paths.
The parent rehashed 80 exported files. The original failed aggregate remains
unchanged, SHA-256
`75edd383fedb2017c73bed904469005c701f1afbfa749724565643b48104431a`.
The seventeen-batch ledger has SHA-256
`eb1896366e8f07800ebd7833ad2d4ac7e4701c07af4130132ccc2782637f537a`.

Author inspection found a separate evidence-retention gap: selected-folder
checks observed bytes and server histories, but did not retain their raw
exports after cleanup. Their PASS receipts alone are insufficient retained
acceptance evidence. The repaired driver exports both peers' bytes at seed,
both convergences and both quiet endpoints, together with fixed fixture
manifests and bounded server-history snapshots. Terminal admission requires
the actual files and matching hashes, source, paths, identities and generation.
Fixture manifests are saved before collection, so failed exports retain their
expected-byte mapping too. Focused offline controls include an actual failed
byte-helper export surviving private/runtime deletion. This repair does not
retroactively supply missing evidence for batch 17.

A focused native desktop reproduction used ordinary account creation, backup,
local Leave, and invalid/stripped/valid backup staging. It reproduced the
wrong-token check's failure: the authenticated refusal occurred, all custody,
credential, engine, content and metadata predicates passed, but the expected
toast was absent. The real notice channel recorded one folded confirmation.
Opening Show sync status and reading its ordinary Recent view exposed the exact
refusal, with all original predicates passing after 236.5 ms and one submission.
This establishes a concrete toast-only oracle defect; it does not reconstruct
the missing facts from batch 17 or count as fresh-C acceptance. The original
failure and subsequent UI observation have respective SHA-256 values
`bb5947c9ec27f7bc67399d8429b9d5570d0b21a9950e2b7f04e7fc584b090bcf` and
`f7a58cd4e5cbdb8f4cdd3ea53c40a29c14f9a2cc3742fd25fbff5afde62ac158`.
The driver repair opens the ordinary full Recent list for refused and successful
recovery messages, avoiding the status summary's ten-entry limit. It waits for
active custody before opening the successful-recovery view, then requires its
exact rendered confirmation. Both outcomes preserve their original shared
45/60-second deadlines and close only that owned modal before continuing.
No request is resubmitted or custody/content check weakened. An enrolling/finally
race was considered but was not observed in this reproduction. Two earlier
diagnostic fixtures stopped before submission: one lacked a precise stage;
the next correctly hit the sole-device Leave refusal before its explicit local
choice was included. All three diagnostics remain recorded FAIL and have
independently verified cleanup and absent runtime/private paths.

Fresh-C readback now retains its source-bound expectations before collecting
actual binary file contents. Partial or mismatched exports produce a retained
FAIL result. Terminal admission independently reopens the two exported files,
checks their nonempty bytes, exact hashes, generation tags and counts, and
rejects missing evidence. The actual exporter-to-admission control passed after
private/runtime deletion and rejected same-size corruption and deletion; its
receipt SHA-256 is
`a499004585643b6123355a8d820bbbd1b920d007768cc168433ae713d066d897`.
This is an offline composition check, not a native recovery pass.

The composed repair passes `scripts/ci/mobile-harness.sh`: 141 Python tests,
172 Node tests and 182 scripted mutation controls, with no skipped tests.
The log SHA-256 is
`e3822345538be388e67e4fbfb44673cc28581934ffe083e7d86560c78622e568`.
Both `make secrets` scans, with `BASE` set to the protected-base SHA above,
pass; their log SHA-256 is
`d8b6455f5794b25fb770a258bd8ccb499101b636cba509f2a0592fb31ffdedd2`.
The preceding composed check failed because the isolated rename UI fixture
lacked the new retention bindings. That failed log is retained; the fixture
now supplies and checks those bindings, while separate filesystem tests verify
actual retained evidence. These controls do not establish native acceptance.

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
all included manifests/chunks and desktop bytes. Previous IDs are bound to the
frozen rotation inventory and unchanged old heads/history; every deterministic
new destination is required and re-derived from authenticated metadata.
Unpinned or foreign records cannot be silently skipped. The current head set
and separately pinned previous histories must remain unchanged across the proof.

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

Full batch 13 at `94dab784938c9e3c38e70c8cc0c2442ed0c9ca65` passed the
same earlier journeys, including a 213.000-second zero-Android-call interval
and direct old-key rejection against new map/manifest/chunk ciphertext. Its
inventory verifier stopped after 459 ms with the generic
`owned_known_notes_inventory_refused`. A parent replay over the actual saved
checkpoints passed byte/provenance binding using the checkpoints' own context;
that diagnostic does not prove the later native reads. Source review finds a
separate mismatch: the authenticated current-generation listing excludes old
history IDs, while this verifier tried to derive old-source destinations from
that listing. Explicit pinned old-ID reads and the current listing must be
verified separately, preserving complete histories and current ciphertext checks.
The original generic receipt cannot establish the exclusive runtime cause.

Both controllers cleaned up, with zero owned groups and independently absent
runtime/private/manifest paths; the parent rehashed 34 exported note files.
The original failed aggregate SHA-256 is
`a08f8b3f993872962dad695d9bb66cc390743bb729b9783bfc5957d000e95329`;
the thirteen-batch ledger SHA-256 is
`55350abd2bc84eb9de6f5aee74df0acf3f9fb47ca31bb669cc7152d5a53be9ca`.
No second or third attempt ran. The hosted Windows test still failed at this
head: its new diagnostics show another retry pending while the test stopped
advancing virtual time after one retry. The first correction alone therefore
does not establish a hosted pass; no CI rerun is counted as a repair.

The corrected verifier now uses the scoped current listing and separately
fetches only the previous IDs pinned by the frozen checkpoint. It checks the
complete old heads/version sets before and after verification, requires every
derived current destination, and authenticates and disk-compares every current
note. An old ID appearing in the current listing refuses; nothing is silently
filtered. A regression executes the actual verifier body with real candidate
cryptography, persisted checkpoint bytes and a current-only page. It reproduces
the old `plan_source_inventory` refusal and passes the corrected path. The
existing real-server API test independently confirms the listing's scope.
Safe stage and closed reason diagnostics replace the generic failure.

The Windows fixture now advances only the receiver's registered retry timer
after a fresh completed refusal, with a finite four-timer bound and the same
ten-second wall deadline. Two controlled refusals reproduce the preceding
one-shot-clock failure. All 16 affected tests pass; seven hostile controls
fail, including stale/missing/wrong timers, unbounded retries, disabled product
retry and lost editor protection. This changes no product behavior and does
not explain the hosted operating-system refusal itself.

Parent composition passes 125 Python tests, 150 Node tests, all 149 scripted
mobile mutation controls and both secret scans. The actual-main regression
and 31 consent/inventory mutants are included in that gate. These are offline
results; a fresh native batch and fresh hosted Windows result remain required.

Full batch 14 at `672a1217e0b88b2ccda1f22f3d2f1a8079e6a015` passed the
corrected scoped inventory verifier, ordinary replacement pairing/consent,
previous-generation history restore through the UI, and a post-rotation Android
process restart with both generations retained. Independently retrieved bytes
matched through all these phases; the parent rehashed 80 exported files.
The post-rotation launch reached automatic idle in 4,700 ms. Earlier idle,
restart/reboot, offline, revocation and interrupted-rotation assertions also
passed, including direct old-key rejection against actual new ciphertext.

The batch stopped at `desktop-save-selected-policy` after 295 ms. Its generic
diagnostic does not identify the precise UI refusal. It did not run either
five-minute rename stability window, fresh recovery or the closed capture scan.
Both controllers reported cleanup PASS and zero owned groups; their runtime,
private and manifest paths were independently absent. The original failed
aggregate SHA-256 is
`6ded2a70a7742382181538e69dfc13b299684e3d2a7f4ec0201e0257568ba999`.
No second or third attempt ran. The repaired Windows plugin test passes on
this head's hosted job. The terminal hosted rollup has 46 successful checks,
one intended deployment skip and the existing covered CodeQL aggregate failure.
Required dispositions and the gate pass. Hosted success does not replace the
failed native batch. The fourteen-batch retained ledger has SHA-256
`d4af050d3d85f6d03e5393b084736ae815a2f8e86e7ee778afdca1d749d8cb63`.

An isolated fresh desktop reproduction then passed ordinary setup and fixture
publication but reproduced the immediate scope-action failure. The driver
declared `const row` in the same evaluation scope as the shared CDP prelude's
existing declaration. This syntax error prevents the Settings action from
running. The old action-body fixtures omitted that real prelude and therefore
missed the composition defect. The isolated controller cleaned up completely;
this diagnosis does not relabel batch 14 or satisfy the rename journeys.

The scope repair passed native text entry and Save in two fresh desktop
fixtures; a separate read of persisted plugin metadata confirmed the selected
folder policy. Sixteen focused tests passed and nine deliberately broken
controls failed. These diagnostic fixtures used the unchanged candidate
product and the repaired action driver, not a full mobile acceptance run.
The next isolated fixture passed scope Save and excluded-note creation, then
the ordinary folder rename timed out after 30,457 ms. Its generic receipt
does not distinguish the Files, context-menu and inline-rename waits. The
following snapshot and both stability windows did not run. All five desktop
diagnostic fixtures reported cleanup PASS, zero owned groups and absent
runtime/private/manifest paths. Their controllers deliberately refused an
overall acceptance result because no Android cleanup proof existed; only
the named native actions and independent saved-policy observations passed.

Subsequent isolated probes located the rename failure at the context-menu
wait: the pinned official macOS app defaults to an Electron native menu,
while the driver expected HTML menu items. The driver now uses Obsidian's
ordinary Files keyboard navigation and F2 rename. It verifies the active
owned Files view, the sole keyboard-focused target folder and absence of
foreign input focus before sending F2. Two intermediate probes refused
incorrect focus assumptions and remain failed. The official Files view uses
its active-leaf key scope and may legitimately leave the DOM active element
on the page body; the driver does not modify menu settings, tree internals or
production behavior to satisfy its assertions.

The ninth fresh desktop diagnostic passed scope Save, independent persisted
policy readback, excluded-note creation, ordinary rename in 946 ms, and the
following snapshot in 366 ms. Existing independent bytes, note identities,
history/ancestry, selected boundaries and empty-trash assertions all passed.
The parent independently verified cleanup PASS, zero owned groups and absent
runtime/private/manifest paths for all nine diagnostic fixtures; the reduced
cleanup ledger has SHA-256
`6cfca59c9aced3ad7c18cb8b0f512ba2fbc854b2aa28fe2cfc8b2b3efcd7799d`.
This is focused desktop evidence, not either five-minute stability window,
Android rename acceptance or a completed full batch.
The combined action regression passes 20 focused tests and kills 20 deliberate
mutations, including shared-prelude collisions, missing settings rows, wrong
active leaf/folder/selection, dropped focus and rename keys, dropped text and
Enter, skipped policy readback, and leaked raw exception text. The parent
replayed those controls against the integrated files. The regression compiles
the actual renderer bodies with the actual shared CDP prelude, which the
original fixtures omitted.
The integrated mobile gate passes 125 Python tests, 157 Node tests and all
149 existing scripted mutation controls, with no skipped tests. The 20 focused
controls above are additional. Both secret scans pass. The unchanged
production artifacts reuse their previously recorded full canonical battery;
the new full native batch remains necessary.

Full batch 15 at `46cd573ffa065a2e04f0dbd1f6536b086c4df390` stopped during
Android onboarding after 36,429 ms: the single independent ADB readback of
installed `main.js` did not match its expected candidate hash. The retained
receipt then records WebSocket close code 1006 and a failed forward removal.
It does not retain the returned byte count/hash, so the precise cause remains
unknown. Native startup had reported the correct vault, layout and plugin
registries ready; pairing and every later acceptance phase did not run.
This is an automation/oracle refusal, not proof of a product encryption defect
or a successful installation. No second or third attempt ran.

Both controllers subsequently reported cleanup PASS and zero owned groups;
the parent independently verified absent runtime/private directories and the
actual desktop and Android ownership manifests. The failed aggregate SHA-256
is `ae6d375130cdcc4fd8bb9a2b4dbf813c04530f932d43f8555642b0af992370fd`.
The fifteen-batch retained ledger has SHA-256
`9caa4845704c702d49c60f6bcd3297f2c73edfe8aaa373f11f7b4b15f348e516`.
The preceding native desktop repair and partial batch 14 assertions are
separate evidence; they do not turn this failed fresh installation into a pass.
The terminal hosted rollup at this head has 46 successful checks and one
intended deployment skip. The existing covered CodeQL aggregate remains red;
required dispositions pass. No new substantive review reply or final-head
independent approval was present when this result was recorded.

A single fresh Android installation-only diagnostic did not reproduce the
mismatch. Independent readbacks matched all three candidate assets exactly:
1,572,823 bytes for `main.js`, 387 for `manifest.json`, and 3,242 for
`styles.css`. The owned holder, ADB and emulator identities matched before
and after each read. The connection closed normally and its forward was
removed. The controller reported cleanup PASS with zero owned groups, and
the parent independently verified the actual runtime/private/manifest paths
absent. The install receipt SHA-256 is
`07cdd5c1c383c918fc353a9e21d4fd253589160e350c9598534043bcb0a7c7d2`;
the controller result is
`ca8194b92b1527ca884b38accb840066c29c24f12928bc137bfafd849d1e00d9`.
Pairing and full acceptance did not run in this diagnostic. Batch 15's cause
remains unknown; a successful isolated sample does not repair or erase it.

The additive driver change now retains expected/observed sizes and hashes,
source rechecks and bounded owned-process facts for each fixed public plugin
asset. On the first mismatch it gathers one independently validated device
size/hash witness and bounded connection facts, then still fails. A matching
remote hash cannot rescue the failed read, and no read-until-match retry is
allowed. Source shape checks still refuse symlinks before reading bytes.
All 35 focused tests pass; ten deliberate broken controls fail, including
accepted mismatches, remote-hash rescue, repeat reads, fabricated byte facts,
changed sources, unvalidated witnesses and private diagnostic leaks. The
parent replayed these controls against the integrated driver. No production
or transport behavior changed, and the next full attempt must supply its own
independent installation evidence.
The integrated follow-up passes 125 Python tests, 159 Node tests and all
149 existing scripted mutation controls with zero skips. The ten focused
controls above are additional; both secret scans pass.

Full batch 16 at `6c0ef69e3b3e562c54c595fbf9493cf467ef7da4` passed
installation with exact sizes/hashes on one read per plugin asset, ordinary
pairing/consent and two-way persisted bytes. It passed 213,010 ms with zero
Android calls, desktop and Android process restarts, guest reboot, offline
recovery, access-only revocation/re-pairing, interrupted rotation across real
restarts, independent inventory checks, replacement pairing, previous-generation
history restore and another Android restart. The post-rotation launch reached
automatic idle in 5,056 ms. The parent independently rehashed 80 exported files.
The detached crypto oracle opened old/access-only ciphertext with the old key
and current ciphertext with the current key, and rejected the old key for the
new map, manifest and chunk. These are partial native results, not full acceptance.

Both peers saved the selected-folder policy and created their excluded controls.
The first Android folder snapshot then failed after 292 ms with
`exact persisted folder case differs`, before either rename. That receipt
does not establish whether storage differs or the directory-entry observation
is wrong. Neither five-minute rename stability window, fresh recovery nor the
closed confidentiality scan ran. No second or third attempt ran.
Both controllers reported cleanup PASS and zero owned groups; the parent
independently verified their actual runtime/private/manifest paths absent.
The original failed aggregate SHA-256 is
`f1e90c4939a0d0935c99f756606deb8f8cd93e379c8557dc8b381d9f83ad68e8`;
its driver manifest is
`55b7680dc0417149ddaaee6b536f2ad711426a90eb45c93dab7dcd1d98ae8d49`.
The sixteen-batch retained ledger has SHA-256
`c54d1eabc47175c7d7625bda2167ea46fd04431c28f17603d7b5ea77636234a4`.
At this head, all 46 successful hosted checks are terminal, with one intended
deployment skip and the existing covered CodeQL aggregate failure. Required
dispositions pass; hosted results do not override the native failure.

A fresh Android-only diagnostic reproduced the exact refusal after ordinary
Files creation of an empty `Team docs` folder. Its `ls` output was the 11-byte
escaped display string `Team\ docs` followed by a newline, not the literal
directory-entry name. The parent independently matched that exact byte string
to the retained hash. A separate bounded NUL-delimited directory enumeration
observed the exact literal folder once and no wrong-case entry. The diagnostic
receipt SHA-256 is
`cc5d16c3cfd7a8504356a652556a6f2032c7e1377aa3b3f2cb43b360c6a8724d`.
Its original controller result remains FAIL, with cleanup PASS, zero groups
and independently absent ownership/runtime/private paths. This establishes
the listing-rendering defect; it does not prove synchronized descendants or
the rename stability windows. No pairing ran in this diagnostic.

The structural-reader repair passes 39 focused tests and 16 deliberately
broken controls. The parent replay required each mutation to fail by assertion,
then ran the integrated gate: 125 Python tests, 163 Node tests and all 149
existing scripted mutations pass with zero skips. The reader uses no-PTY shell
output with NUL-delimited immediate entries and an explicit final marker;
entry-boundary truncation, malformed UTF-8, foreign/deep paths, duplicate
entries and excessive output refuse. Exact case, freshness, old-name absence,
selection boundaries and independent descendant byte/identity checks remain.

The second fresh path-only diagnostic passed ordinary folder creation and its
independent exact-entry verification, then failed the case-only rename with
the old folder still present. A third fresh instrumented diagnostic proved
exact replacement text and trusted Enter keydown/keyup on the expected inline
field, with composition false. The inline field remained open with the fixed
destination-already-exists error. Native existence checks returned true for
both spellings, while the exact application index retained only the old name.
The creation control closed normally using the same input and Enter path.
The rename-input receipt SHA-256 is
`c6958be0e301a8a4ec4b8ac3bc863b73818f819630dc36335182646ff687d20c`.
Both failed diagnostics retain their original results and verified cleanup.

This matches the pinned official mobile application's destination-exists
guard with its case-insensitive flag unset and its mobile detection operation
empty. The parent independently verified the APK and application-script hashes
and those source anchors. No official application or production plugin code
was changed. Single-step case-only rename through this pinned Android UI is
not a passing claim. A separate fifth fresh diagnostic passed two explicit
ordinary UI renames through `Obsync-case-rename` in 8.062 seconds, inside the
original 180-second budget. Complete independent directory witnesses checked
the intermediate and final names and absence of obsolete names. Its proof
SHA-256 is `7b3d7acbd74b5210c32eff75623e639153d786cc45288876c7182aee30eb0220`.
This empty, unpaired folder experiment does not prove synchronized descendants
or full acceptance. The fourth diagnostic remains FAIL: its private witness
compared a decoded string marker to bytes and stopped after the first successful
ordinary rename. Corrected witness fixtures refused missing completion before
the fifth fresh run. All five original results remain; the parent independently
checked cleanup PASS, zero remaining owned groups and absence of their actual
runtime, private and manifest paths. The cleanup receipt SHA-256 is
`a93a249964ca1ad81a8bcfebf0d1b12b7ad7d644cba1eb9eb2aeedee6b34a555`.

The composed runner now names this explicit two-action workflow, refuses an
occupied intermediate, keeps the original descendant baseline across both
actions and requires exact final-name and obsolete-name checks. It never falls
back from a failed direct action. The original full-run requirement of two
descendants, unchanged bytes and identities, selection boundaries, ancestry,
180-second phone action limit and both five-minute stability windows remains.
Desktop-origin case-only propagation continues to exercise the existing
production recase path unchanged. A fresh full run is still required.

The composed gate passes 126 Python and 164 JavaScript tests with zero skips,
plus the existing 149 scripted mutations. The parent also killed 16 structural
directory-reader, 26 workflow and seven admission mutants through assertions.
Its review corrected the wrapper's missing descendant count and normalized
monotonic fractional milliseconds to the aggregate's integer receipt contract
before a full run. Empty diagnostics still emit zero; full acceptance requires
two measured descendants. Both secret scans pass. The composed gate log SHA-256
is `d8a2566840f7e096b3ffa7ca0f1b9bac8815dfc94ceff6c97e579c784ba33056`.
One restricted admission-test invocation could not inspect its own subprocess
group; it remains failed. The known process was independently absent, and the
same tests passed with the required process visibility. This is an offline
automation permission failure, not a native product result.

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
