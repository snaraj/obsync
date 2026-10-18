# Android transport validation — 2026-10-16

Author evidence for #347 / v1.1.8. This is a transport diagnostic, not three
fresh full acceptance passes or physical-phone acceptance. The earlier
[acceptance record](2026-10-15-unattended-mobile.md) retains the original failed
batches and the one successful full attempt at its historical candidate.

## Measured transport diagnostic

Diagnostic 19 used product source `9ee2242862aa3e56f780447da6ab34028f62946d`
and shared driver source `3311d79422c3033c622517f98f75c38dc5a02eae`, with a
separately frozen private transport diagnostic. Its 68-input manifest SHA-256
is `2943ceb952e33beb101af4023d641d89d0526ffb2ce8c66a281a07729d5cac2c`.
It did not alter the candidate plugin or server.

The diagnostic completed 100 numbered cycles. Each cycle independently read
the complete installed plugin bundle and pulled the official APK once, requiring
exact nonempty bytes and hashes. Together with four setup checks, all 104 APK
receipts verified. A single debugger WebSocket remained open during the stress
cycles and closed normally with code 1000. There was no retry after a failed
transfer and no transport fallback. These are 100 transfers per artifact, not
100 connection lifecycles.

The cycles took 295.716 seconds. The slowest APK verification took 14.053 seconds
within its unchanged 30-second cap. Total wall time was 443.164 seconds, differing
from monotonic elapsed time by 3 milliseconds. Ordinary onboarding, native
untrusted-certificate refusal, guest-only CA installation/root reattachment and
application restart completed. This diagnostic did not execute the full pairing,
reboot, revocation, recovery, rename or confidentiality acceptance journeys.

The parent and a separate audit rehashed the frozen inputs, three installed
plugin assets, 100 raw-read cycles and 104 APK receipts. Both controllers reported
cleanup; independently observed owned PIDs, listeners and runtime paths were
absent. The independent audit also exercised two positive and nine negative
controls. Its first schema-handling error was retained; the corrected audit
re-read the same completed native evidence without rerunning the device.

| Retained artifact | SHA-256 |
| --- | --- |
| Aggregate diagnostic result | `0dc1936962bf179384b2f99a9d01ca8180f9cb2fda594befa7ea9785f651b188` |
| Independent audit | `83e1e488b1517186408e70d2a2a4a5f2efc1ab681088d2ba5d6ae0a6e379f738` |
| Parent cleanup | `367cdee8763ad0d342f502dca0e535d99b39f7b71a41613693fedd77447ea927` |
| Installed plugin bundle | `babc5e9a94c56658a2ce173fb3fb632567ed5b23af67c425882de1ecfa241fef` |
| Official APK | `80505ced8442fafb2d681ecd66645f7855a3ea8beadfa7230f8d003e1101ff8b` |

The frozen diagnostic's `commandCapMs` field incorrectly contained seconds;
its runtime caps and manifest recorded the correct budgets, and no guard read
that field. Its final console label also retained an older diagnostic number.
Both mistakes remain visible in the original evidence. The portable integration
corrects the unit field, with an assertion-killed mutation; no original receipt
was rewritten. This success does not establish the cause of earlier VSOCK
short reads.

## Failed attempts and bounded isolation evidence

APK diagnostic 17 failed before creating either peer: its selected TLS port
already had an unrelated listener. That service was left untouched. The original
failure remains, including its secondary missing-peer-receipt error. The portable
runner now checks all fixed ports first and retains the primary controller error.

APK diagnostic 18 failed before installation: a framework settings query timed
out after 3.006 seconds with no output. Cleanup passed. Its retained ledger hash
is `414760927640f7a0eedd19ab5e8b048d0201346db96d9c2ff491ad5b9adf87ad`.
Source comparison established that the private transport prototype had shortened
four exact framework command forms from the original 30-second cap to 3 seconds.
The correction restores only those original provisioning caps, still clipped to
the original boot/session deadlines. Kernel metadata, connection, raw-byte and
APK caps are unchanged. Diagnostic 19's same settings read took 50 milliseconds;
that observation does not identify why diagnostic 18 stalled.

The separate boot-only ledger covers diagnostics 15, 16, 18, 19, 20, 21 and 22:
two finite successful observations and five retained failures, with no APK or
product-acceptance credit. Its SHA-256 is
`30d7ed84126965a7707f32d490adaa4e418c68b292631a92a311f7ecf05e9899`.
Diagnostic 22 verified the same guest identity through both transports and its
actual UID route. A negative host-alias probe produced no body and no server hit;
the explicitly owned reverse route returned the exact 47-byte body and one hit.
This is a finite IPv4 two-endpoint test, not a general network or IPv6 proof.
A fixed read-only route query used the userdebug image's permitted privileged
child; it does not establish stock-device shell behavior.

## First full batch on the committed TCP integration

Source and drivers were pinned to `34ca2466e2a645c351712557f85ca9256458d179`.
Two earlier launch failures remain separate: TCP batch 01 refused an occupied
TLS port before creating fixtures; the unrelated service was left untouched.
TCP batch 02 failed before Android creation because the launch process's PATH
omitted the system directory containing `lsof`. Its controller cleaned up. The
next launch selected a free port and included the standard system directories;
neither original result was rewritten.

TCP batch 03 failed on its first attempt at step 039: the single selected-TCP
`adb reboot` command exceeded its unchanged 30-second cap. It failed before
reboot observation or reattachment, so whether the guest rebooted is unknown.
Attempts two and three did not run. No timeout was counted as success.

The completed prefix includes ordinary installation, both negative certificate
checks, independent verification-code comparison, approval and separate upload
consent, two-way persisted bytes, 213.003 seconds with zero Android calls,
desktop Quit/relaunch and Android process restart. The independent partial
audit checked 37 committed driver inputs, 39 prefix receipts and 12 actual file
exports. Pairing generation and credential hashes survived the app restart.
Later reboot, offline, revocation, rotation, recovery, rename and final closed
confidentiality checks did not complete. Original runtime receipts establish
the verification-code comparison and quiet-history equality; the partial
audit does not claim to repeat those observations after cleanup.

Both controllers reported cleanup. The parent separately verified the recorded
ADB, emulator, desktop and TLS processes, owned listeners and runtime paths
absent. The failure is in the automation control path; its exact cause remains
unknown. This is partial evidence, not full acceptance.

| Retained artifact | SHA-256 |
| --- | --- |
| TCP batch 02 failed result | `9c2e29ffed6e1043989cefaaa42e8ffa054504cb04bd6a3be6fc9d71ff86bfa6` |
| TCP batch 03 failed result | `34320de8dc69a912a71b2e5e8bf6377d4fffe2858db819860618fa282041f106` |
| Original reboot failure log | `6ce1490010d3ff4a692540e9171f9aa3a903caa715987619b2250810c9608e93` |
| Independent partial audit | `02662536ffbf869e129f17880083f160783d5c16d970c932b61bde37038ab77d` |

The subsequent reboot-only diagnostic 01 used a separately frozen private
driver proposal against clean product source `34ca246`. Its six-input manifest
hash is `692d93980ab89b1fa29fef41ca18a1b94f22e8b0bf1980456b530adc4d89aa7e`.
After matching both guest identities, one scoped TCP disconnect/removal and
one original-emulator reboot request completed with exit zero in 372 ms.
However, no new-boot/TCP-reattachment proof was obtained: the original 240-second
deadline failed after 240.366 seconds. The diagnostic remains FAIL, with guest
reboot and root cause unestablished. Controller cleanup and separate parent
PID/listener absence checks passed. Its independent audit hash is
`b9d08025e2697dda464880498336c8d6811f8b1290e0ed8cb8bb22bc8ff69557`.
This isolated control test did not install the candidate plugin or test pairing,
native key custody, persisted notes or the full acceptance journeys.

Reboot-only diagnostic 02 retained bounded stage observations under the same
240-second deadline. The single original-route request returned successfully in
324 ms. Independent guest identity changed, and `sys.boot_completed` reached
`1`: the guest did reboot. Reattachment then failed at the response-route check
for the actual adbd UID (2000). It completed 605 framed observations without
admitting a usable WLAN route; the retained first and last classifications are
both `NO_ROUTE`. Intermediate classifications are not individually retained.
No selected-TCP connection was attempted. The diagnostic failed after 240.361
seconds; why the post-boot route was missing remains unestablished by this run.
Its six frozen input pins and cleanup were independently checked. This is
automation diagnosis, with no plugin, pairing or full-acceptance credit.

| Diagnostic 02 retained artifact | SHA-256 |
| --- | --- |
| Frozen input manifest | `e20fec70aa461c245e65bccc8c55bfe0e471eb8174a68f6d3e1fe2208c2a5d07` |
| Independent audit | `bf715b166c5e6d68e307aed0cf54e1093062ed48dd014128c0d45e923bc9d760` |
| Parent process/listener cleanup | `8ca843e63fa2aaca9a69c49cd13e95abf1c5b43ea9deeea7beaf2e33dd80d2e7` |

Diagnostic 03 added one read-only network snapshot at the first non-ready
post-boot route. That snapshot took 286 ms: Wi-Fi was enabled but disconnected,
with no WLAN IPv4 address or route, while user 0 was still unlocking. The link
detail query was permission-denied and remains unobserved. These are early
snapshot facts, not observations of the terminal state or the cause of
disconnection. Reboot and completed startup were observed, but no usable route
was admitted in 612 readiness observations. The diagnostic remains FAIL at
240.351 seconds; no selected-TCP reconnection or product acceptance follows.
All six frozen inputs and controller/parent cleanup were independently checked.

| Diagnostic 03 retained artifact | SHA-256 |
| --- | --- |
| Frozen input manifest | `8b5bed184615cbb277ae286200c31d35ce6a7b0c96e4a5caf9e841f708cb4f56` |
| Independent audit | `0459f91edc0917e8d2a458959a1c687dcbcec47c9c486cc52350dbab7efa26ad` |
| Parent process/listener cleanup | `23548f077cc0cfb31c1dd02f62f651abb272e32a31a6b4dbf18aa0601de9ea05` |

Diagnostic 04 tested one predeclared reconnect to the verified synthetic Wi-Fi
network after user 0 reached `RUNNING_UNLOCKED`. The request completed in 169 ms;
its empty response was not treated as connection proof. The independent route
observer then admitted the expected WLAN route after seven observations. One
selected-TCP connection attempt remained pending. A subsequent route observer
never admitted readiness in 589 observations; its retained first and last
classifications were `NO_ROUTE`. The 14.799-second first reattachment duration
includes several operations, not just the TCP command. No new selected-guest
identity or attachment receipt was obtained. Why the route became unavailable
remains unknown: the early network snapshot preceded the ready route and cannot
establish the later failure's cause. The run remains FAIL at 240.396 seconds.

All six frozen input pins, the single official-APK readback and controller
cleanup were independently checked. The parent also verified exact owned PIDs,
listeners and runtime paths absent. This private control experiment provides no
plugin or acceptance credit; its reconnect proposal is not yet integrated.

| Diagnostic 04 retained artifact | SHA-256 |
| --- | --- |
| Frozen input manifest | `42e1eeb6de84707e09f2b404a27de65ccf327ff6443f8cf50ea44818c7ed6160` |
| Independent audit | `8cc8e67fb7c6e99be2d2fb00a37b9f37bb159e6a7c0d6fffb101a3bc0aed033a` |
| Parent process/listener cleanup | `4808fa390c5101ccfc9a3ba068818ad30736f2b75e166f1ed92e972e3dc632bb` |

Diagnostic 05 added bounded read-only observations at connection failure and
after the phase, without changing the request, retry behavior or deadlines.
It passed the reboot control path in 33.108 seconds: one post-unlock Wi-Fi
request completed in 106 ms, the actual UID route became ready after 12
observations, and the original and selected transports independently identified
the same new boot with completed startup. The final selected-route boot check,
stopped-application check and reverse mappings passed. The failure collectors
were not reached. Controller cleanup completed at 100.284 seconds; separate
parent PID, listener and runtime absence checks passed.

This establishes one successful control path, not the cause of diagnostic 04's
failure, repeatability or product acceptance. Diagnostic 04 remains FAIL and
unexplained. The portable integration includes the fixed initial-network proof,
one post-unlock request and mandatory retained witness; the private diagnostic
snapshot/log collectors are excluded. The next full batch must still prove
pairing retention, trust restoration, persisted bytes and every later journey.

| Diagnostic 05 retained artifact | SHA-256 |
| --- | --- |
| Frozen input manifest | `d22e4171b950eaafd3a4a783c4d96fc88ecb87e5bd1a464dba50e0a1bbb1b910` |
| Independent audit | `8ccfdad45df4b90da2e8c3f952d6828bb9489378b0cadf95a29648b67a137d97` |
| Parent process/listener cleanup | `76a74026cba6aee14f1f90249e76ae93555186fdcf9e43119e40875520207e32` |

## Full TCP batch 04

The next three-run batch used exact source and driver head
`268d851b0287d31bc808c0c92997be3351d42410`. Attempt 01 completed every full
journey in 1,307.856 seconds. Attempt 02 failed during initial Android network
setup; attempt 03 did not run. The aggregate remains **FAIL** and the unchanged
three-pass auditor correctly refused it.

The separate scoped audit verified attempt 01's 100 Android/desktop exports
and two fresh-recovery exports against expected bytes, selected identities,
ancestry and both five-minute stability windows. There are 169 distinct step
numbers and 172 step JSON files; the first three numbers each have two receipts.
The 213.010-second idle interval involved no Android calls. Desktop restart,
Android process death, device reboot, offline recovery, both revocation modes,
interrupted rotation and explicit re-pairing, fresh recovery and selected-folder
renames passed. Old keys opened baseline and access-only ciphertext but failed
to decrypt the new generation's map, manifest and chunk; the current key opened
current ciphertext. All 374 captured connections closed naturally. Scanning
covered 1,833 requests, 779 files and 3,389,672 bytes, with no unexpected hits or
parse errors; the deliberate leak controls were detected.

Attempt 02 obtained the expected Wi-Fi address. Its unmarked, actual-adbd-UID
route predicate nevertheless failed throughout 588 observations. No TCP
connection was attempted and APK installation was not reached. This proves a
failed setup predicate, not failed incoming TCP connectivity or a product
failure. The cause remains unknown. Both controllers reported cleanup; the
parent confirmed 14 captured PIDs, nine listeners and 12 runtime/state paths
absent. Attempt 02's QEMU PID was not captured before state removal; for that
process, only controller cleanup and fixed-listener absence were independently
available. The original failed aggregate and audit refusals remain unchanged.

| Batch 04 retained artifact | SHA-256 |
| --- | --- |
| Failed aggregate | `f1a0e5902eff69064881a22f65597a6f62dd975e8b73bd2894e9acd639c5cc2b` |
| Frozen driver inventory | `a3e6e944a4c4dcbbc9e34bde1afa469f23ae3841461b93acf1644edffc1c60c3` |
| Three-run audit refusal | `16323530119f5b7ccbb2dc6cddc62d952ccbe4cf1e526918d82fa845ba0490bf` |
| Scoped attempt audit | `1eedbc82e3c0b4b37be3d7126e66a6c3e46fcd15aaa3f97d22c7cac44db5493f` |
| Parent terminal cleanup | `f98387b3bc98c1f9894c536c19e4d466eba7c551d85338f19efe308462db6ff6` |

Two separate setup diagnostics followed. Early-data diagnostic 01 moved the
existing cellular-disable operations before Wi-Fi readiness, using the original
owned emulator connection. It observed the setting change from one to zero,
then one Wi-Fi enable, the unchanged route check and one TCP connection with
matching guest identities. The selected-connection zero readback, dummy-route
and egress checks passed. The official installed APK matched its 15,447,027
expected bytes. Setup and cleanup completed in 55.983 seconds. The frozen-input
manifest hash is `62ac7dcbde22713b46aa0b72089d25c9230f4ad417f51f2383277913c448ec7b`;
the independent audit hash is
`7dd377dc97f4968532047cb017b820856cf1878df2cbee2cf562eb4f5300e3e4`.
This supports the revised setup order, not a causal explanation of batch 04.

Incoming-flow diagnostic 01 separately sampled the unmarked route immediately
before and after the existing one-connection, same-guest exchange. The route
changed from `NO_ROUTE` to `WLAN0_ROUTE`; the result is **inconclusive** about
whether the unmarked-route prerequisite is necessary. Setup and cleanup passed
in 51.665 seconds, with the official APK independently retrieved and verified.
Its frozen-input manifest hash is
`9fe0be0e346cc504845d1079c67ca881baccb0cfc17fb6126ce9f87b64064bcc`.
This private diagnostic is not integrated into acceptance. Neither diagnostic
ran the plugin journeys or earns full-acceptance credit.

The portable change moves the existing cellular-disable operations before the
route prerequisite and verifies zero there. It keeps the original selected-route
zero/egress checks, sole initial TCP connection and all command/phase deadlines.
No acceptance route check, product behavior or failed receipt is removed.

## Acceptance boundary

The portable transport is integrated into the existing acceptance runner, with
no production change. Retained admission requires the expected initial, root and
reboot identities and exact source bindings after both cleanups. Initial and
root attachment retain their unmarked route checks; the reboot-only correction
below requires the actual incoming response bound to the new guest instead.
Root reattachment requires UID 0 and is bounded by both its original 20 seconds
and the remaining session lifetime. Three consecutive fresh full acceptance
passes on the committed integration remain required. The physical-phone gate,
final hosted checks and independent exact-head approval also remain open.

## Full TCP batches 05 and 06

Both launches bind source and driver to `9d6d51a94d84c99fbb84dfe2e350b9942a706c41`.
Batch 05 refused its top-level configuration's mode `0644` before creating any
native fixture. The preparation error is retained; its task-owned configuration
was tightened to `0600` without changing bytes before the separate batch 06.

Batch 06 failed at Android guest reboot after 240.554 seconds; the complete
attempt took 641.233 seconds. Its remaining two attempts did not run. Pairing,
independent code comparison, consent, two-way persisted bytes, a 213.003-second
no-interaction interval, desktop relaunch and Android process restart passed.
A changed original-guest boot identity, completed boot and unlocked user were
observed. The single Wi-Fi restoration request completed in 799 ms. Later
original-route identity and route reads timed out; valid route replies reported
`NO_ROUTE`. Selected TCP connection was never attempted. The records do not
prove permanent channel loss or establish the underlying cause.

The unchanged three-pass auditor refused the aggregate. A separate failure
audit verified 58 input pins, 37 committed helpers, 162 retained references,
four official-APK readbacks and 12 independently exported persisted files.
Both controllers reported cleanup. Parent checks found all nine captured PIDs,
seven scoped listeners and six owned runtime paths absent. Hosted checks at
this head independently passed all eight required contexts; native full
acceptance remains unproven.

| Batch 06 retained artifact | SHA-256 |
| --- | --- |
| Failed aggregate | `e131bea37fada3e3fe8174cd3ca095c04eb3f878cb86ebefc07d6fd52e1c15c3` |
| Frozen audit inputs | `bcfe8b4999f53e1830a4af739b47d5163f7dac872e1e62b634a890e0ed4abc58` |
| Three-run audit refusal | `d43d9f0ccff6015627680f8212dcaa8d63eb2195cc4bc35dec8c94c635088604` |
| Independent failure audit | `40ed6716826749323e438034bfabf5c51b9446bee453e210966d434a896309af` |
| Parent terminal cleanup | `a5406d0ad61228d4e7fd7681bb2e6035d4019bed928adcd6c1b3859d18ad8b57` |

A separate reboot-channel diagnostic failed before its journey: the initial
`svc data disable` returned exit 20, with the retained error
`cmd: Can't find service: phone`. Boot-completed reporting took 115.153 seconds;
the controller ended at 126.844 seconds. No TCP connection, APK installation,
root transition or reboot comparison ran. This proves that boot completion alone
did not establish the required Binder-service readiness. Controller cleanup and
parent checks of three recorded PIDs, four listeners and three runtime paths
passed. The independent record hash is
`d17940d7b6cf3a7f2532fc0205701133224c78130ce586878d9c0802e884ca9a`.

The next private diagnostic added a bounded read-only `service check phone`
precondition, but failed at the unchanged initial boot deadline before reaching
that check. Its controller took 253.447 seconds including cleanup. The retained
startup tail contains two `Failed to make display surface context current: 12299`
and two `Failed to bind to post worker context` errors. Those errors were absent
from the preceding diagnostic's comparable retained tail. The two launches used
the same image, software graphics, effective QEMU configuration and byte-identical
official asset proof. This difference does not establish the boot timeout's cause.
Neither diagnostic exercises the plugin or supplies acceptance evidence.

Controller cleanup passed. Independent parent checks found both captured PIDs,
four scoped listeners and three runtime paths absent, with receipt SHA-256
`c93febfc29115b52e1b758e43f370d1380bc641428dbfd426287d228de1eecf8`.
The QEMU PID was not recorded before the failed boot; for that process the
controller's process-group receipt and listener absence remain separate evidence.
The independent diagnostic audit verified all 18 current pins and referenced
prior evidence; its SHA-256 is
`56488eb16092735de530c1e9b6aa2008b318bd4543070111fc52c8ba87795f51`.

The following diagnostic changed only the emulator's host-window option to
the official `-no-window` mode. The same pinned SDK archive supplied and verified
its headless backend. Android reported boot completion in 198.264 seconds, but
the required `phone` service remained missing in all 64 exact replies before the
unchanged initial boot deadline. No data-disable command, Wi-Fi enable, TCP
connection, APK installation or reboot comparison ran. The controller failed
after 255.872 seconds including cleanup. The readiness guard therefore refused
the missing prerequisite; this is not proof of successful provisioning.

The initial-readiness receipt SHA-256 is
`42fab8dae35ff54065a76c366d465f1cae846efe51dcd258f36d746bf67fc6dc`.
Controller cleanup passed; parent checks found four captured PIDs, four listeners
and three runtime paths absent, recorded as
`d649fd9dbc90cb0cf1796c2c6fe3f1712c7142964d16a36fcbb95a6224cbe95e`.
Contemporaneous host-load observations are retained privately as a possible
confounder, not an established cause or permission to extend deadlines.
The previous display-context errors were not observed in
this run's retained startup tail. Neither observation establishes a causal fix.
The independent audit, including the headless binary's exact match to its pinned
official archive member and every prior input reference, has SHA-256
`f6f2b169446555b007fdd7e5145dd35f46c3e76895940e76f318a09df204e0db`.

A separately frozen phone-startup diagnostic then observed the first exact
`Service phone: found` reply in 109 ms after a 65.118-second boot. It stopped
immediately as designed: zero snapshot reads, data-disable commands, TCP
connections, APK installation or plugin journeys. Its result is
**NOT_REPRODUCED**, not a passing acceptance run or an explanation of the prior
missing service. The original controller records the expected
`FAIL/ControlledStop`; cleanup passed after 79.097 seconds total. Parent checks
confirmed three captured PIDs, four listeners and three runtime paths absent.
The independent audit verifies 16 current input pins, the prior diagnostic's
pins and failure receipts, and all ten retained evidence references. Its SHA-256
is `8337f5f61a20092a8038e9e56dd42ad5eabda31c7af509ae4aef7cc67972e821`.

The next frozen reboot diagnostic reached the comparison. Both the original
guest channel and the selected TCP channel returned complete frames for the
same new boot, `adbd` process identity and UID 2000. Both unmarked route lookups
reported `NO_ROUTE`, while the single actual TCP connection succeeded in
5.842 seconds. The owned loopback listener and original deadline were verified.
This is a direct counterexample to requiring that synthetic route lookup before
an incoming reboot connection; it does not establish the cause of every earlier
timeout. A nonzero socket mark was also observed, without attributing causality.

The root preparation plus reboot journey took 96.296 seconds; the whole
controller took 306.827 seconds including setup and cleanup. The official APK
was independently retrieved and verified. The diagnostic deliberately stopped
before saving the selected binding or running product journeys. It supplies
no mobile acceptance credit. The supported correction is limited to the reboot
prerequisite: require the actual complete TCP response, matching new guest and
UID, completed boot, owned listener and original deadline. Initial and root
route guards remain unchanged.

The independent audit verified 20 current input pins, 40 prior input pins,
five prior receipts and 18 retained evidence references. Its SHA-256 is
`c9a18e6dd82f8f87cd08b510b37638b771ffdd6d6158435459470981e37f5749`.
Controller cleanup passed. Parent checks confirmed all three recorded PIDs,
four listeners and three runtime paths absent; the receipt SHA-256 is
`d7a54b16e7a56ba9ff2fe37d8e3f4a4d66936dae3f0c7e94e1ece3600d16c8d5`.

## Regression failures and controlled repairs

The next `make mobile-harness` stopped in its unchanged plugin prerequisite:
2,524 of 2,527 tests passed. The failed log is retained with SHA-256
`febe3c331e95acafb492f8f203d52a75d9baf9f9dfb2834e02ded5d4b5ad97e7`.
Focused controlled experiments established three test failure modes; the
original run did not record enough scheduling facts to attribute each failure
conclusively:

- The newly refused page test counted an independent `editor_retry` during
  the page's asynchronous save tail. It now counts only retries owned by the
  exclusive page turn, retaining the immediate-retry refusal assertion.
- The parked-note test advanced through a legitimate one-minute retry while
  asserting that no retry happened. It now freezes time during feed completion,
  requires the full-minute timer and tests immediately before its deadline.
- The drain-save test exhausted its bounded fake-clock advances while a real
  file read was pending. A later timer then lay beyond the frozen clock. This
  test now advances only actual pending watcher timers within its original
  ten-second budgets; its final two-second check still advances no virtual time.

All three repaired focused scenarios passed. A delayed actual file read through
1,900 idle rounds also passed. Removing the page refusal guard, shortening the
parked backoff and removing the drain's post-save rescheduling each failed by
assertion. Production code and the shared fake-timer implementation are unchanged.

The separate offline harness initially refused a dirty source binding. Selecting
the existing clean candidate exposed two hostile-permission fixtures affected by
`umask 077`: requested `0644` and `0755` modes became private. Explicit fixture
`chmod` plus readback now proves the intended unsafe state. The two test files
pass under both `022` and `077`; removing the TLS permission check still fails
by assertion. These changes do not relax the actual permission checks.

After those repairs, 221 Python and 204 JavaScript harness tests passed with zero
skips. The final mutation adapter needed the new phone-readiness helper in its
test namespace; its missing attribute was retained as an error, not counted as
a killed mutant. The corrected adapter assertion-killed all 40 controls. Combined
with the preceding successful mutation stages, all 275 existing scripted controls
passed. The logs have SHA-256
`e5f341311ffa1395f2ce6734431f68b11fe7dc8d3fb450b4ecc2af90effec871`
and `bf73c1c5510f1af8e9ca83316997415a330a18ec991d0787557d4df4f222916c`.
Seven additional focused startup mutations and the permission-guard mutation
were assertion-killed. These are offline results, not mobile acceptance.

The next full plugin run passed 2,526 of 2,527 tests, including the three
repairs above, but refused a restored-file test's attribution: a periodic scan
had queued the change. Its retained log SHA-256 is
`164d49f681a7b65244a5c55ad98854f35c2e92a8ff2e6993172e8f1072902a0f`.
A controlled delay of the actual file read reproduced the same assertion while
the original test advanced past the 30-second scan timer. The repaired test
fires its actual deletion debounce, then freezes virtual time while the read
and encryption finish. It retains the scan-count assertion and original
ten-second outcome deadline, and additionally proves the outcome precedes the
scan deadline. Baseline and delayed-read controls passed. Removing the actual
present-file publication path still timed out with one version and zero scans.
This establishes the controlled failure mechanism; the original failed run did
not retain its exact scheduling trace. Its failure remains recorded.

A subsequent plugin run passed 2,522 of 2,527 tests. One failure was an explicit
sandbox denial of the real localhost redirect listener; it requires host test
access, not a product change. Controlled asynchronous barriers then showed two
fixture defects: the parked-files test reached ten virtual minutes before its
retry completed, and both selected-folder rename cases stopped on a legitimate
folder tombstone before the notes moved. The repairs wait for those actual
outcomes within the existing ten-second budgets. The retry test also checks the
exact one-, three-, seven- and fifteen-minute schedule. Renames still refuse any
note tombstone and retain every byte, identity and selection assertion.

The same run's concurrent-edit case ended with equal bytes but two heads and a
closing-storm refusal. Its unchanged focused replay passed. The editor fixture
omitted the real host's trusted-input revision: a controlled eight-round closing
test without that revision reproduces the breaker refusal, while the model with
it permits actual typing and still refuses untyped and conflicting-name loops.
The fixture now changes its revision only on explicit nonempty typing; a new
test rejects revisions caused by saving, external writes or empty input. This
supports correcting the host model, but does not prove the exact scheduling
cause of the original failure. Product mutations removing the input reset,
exponential retry backoff and folder fanout each fail by assertion. The failed
full-run log hash is
`37d906d09c5ea821b75021ce51afc411184ea147e61fbaad23cab4b8dceff724`;
the controlled-proposal manifest hash is
`d14d1d97a1e89f5ccfbbc508f46fc929cdc48e3d197afc591436732574374a8e`.

The first new offline-harness invocation also lacked host access, so scoped
process checks and localhost listeners refused. Two reboot-observation fixtures
additionally needed the new framed incoming-response evidence. Those fixtures
were corrected; the command/cleanup guards remain unchanged. A separate host
run passed all 225 Python tests and 203 of 204 JavaScript tests. Its remaining
failure was a test-generated startup receipt with only 500 ms left: child
startup consumed that budget before the intended hanging-CDP check. Injecting a
600 ms startup delay reproduced the refusal. The test now starts its synthetic
epoch at the helper's first clock read, then advances with real monotonic time;
the actual hanging connection, remaining 500 ms timer and outer limits remain.
Five focused tests and six controls pass, including refusal when the timeout is
removed or reset. No production startup deadline changed.

The combined regression receipt has SHA-256
`c6c5c5dcf554f218cccc1b84abcbb142a76a52d8a03a02052ccf387e1bf52533`.
Strict pinned documentation checks passed over 162 files and 8,612 anchors;
both secret scans passed. The failed sandbox run's 21 recorded process groups
were later independently absent without sending a signal. The documentation
output was removed after owner/path checks. These records establish cleanup
and offline evidence only; they do not supply a fresh native acceptance pass.

With those fixture corrections, the complete `scripts/ci/mobile-harness.sh`
passed in 141.491 seconds: 225 Python tests, 204 JavaScript tests, zero skips
and all 285 scripted mutation controls. Its log SHA-256 is
`0ecc702315959a9cd5a8106e3fcbcd21000ef619bcb17a0e5ceef7b329ce7726`.
The ten added reboot controls reject incomplete responses, mixed UIDs, foreign
guests, missing connection results, missing retained evidence and lost deadlines;
they also catch restoring the disproven reboot route prerequisite.

The next full plugin run passed 2,527 of 2,528 tests, with zero skips. Its
remaining outgoing-status test observed `pending: 2`; the retained log hash is
`82276062f7f967a5bfa196217409adbf69894fb1b4c853c326759eb7fd737abc`.
A controlled delayed POST acknowledgement reproduced one outgoing file plus
one arriving own-publication record. The engine deliberately counts incoming
records separately; this did not demonstrate duplicate outgoing queue/push
counting. The test now holds its existing long poll during the outgoing-work
assertions and releases it on both success and failure. Both count assertions,
the changed-byte outcome and all deadlines remain unchanged. Baseline and
delayed-ack controls pass. Removing the follow-up push fails the changed-byte
assertion; removing outgoing deduplication fails the original count assertion.
The proposal manifest hash is
`8f2d807dfa35e926412e67d55c0f2e7974f7067caa8538124b53b7e4ecf953ca`.
The failed full run remains FAIL; focused repair evidence does not turn it into
a passing full run. Fresh hosted validation is required at the repaired head.

The complete repaired status test file passed all 36 tests with zero skips in
19.241 seconds. Its log SHA-256 is
`f8a0c230e5ae885d5bb552f88f34d5d0a96cf8d4613f9f01902a2c50628389c7`.

At signed head `1e0cd0e649171c40f3b618b27334383ad13090d5`, the next fresh
three-run batch stopped on its first attempt after 352.025 seconds. Android
installed the official app and completed the ordinary storage-permission
controls, but its newly created vault did not reach public
`workspace.layoutReady` within the unchanged twenty-second readiness budget.
After 122 observations the exact vault, plugin registry and settings methods
were present; the layout was still not ready. Candidate installation and
pairing had not begun. This is an automation or host-app readiness refusal,
not evidence of a candidate encryption defect. Its exact cause is unproven.
The remaining two attempts did not run; no retry replaced this failure.

The aggregate FAIL hash is
`4eecadc5d00e96130f9a0731870feeba87db2b241d56ca7ad25edeae6e5345a6`.
Both controllers report cleanup PASS. The independent parent check found all
eight recorded processes, six ports and six runtime/manifest paths absent,
without sending any signal; its receipt hash is
`67542e11d5cb3d8dd9045157d74fbecf9cc6625400afa6a575682b4920a3a8d1`.
Wall and monotonic timing differed by one millisecond. The result does not
establish any of the full mobile journeys.

The frozen full auditor refused this batch for `three_full_terminal_passes`.
A separate retained-failure audit verified all 58 input pins, 37 committed
helpers and 37 retained evidence references without changing that predicate.
Its hash is
`e1e8c7d74a7d271bba5f4fff6af8993b9a4c9347e50e6979b03c0e22146733fb`.

Hosted validation at the same head passed the application job: 2,519 plugin
tests passed and nine case-folding filesystem cases were skipped on Linux;
225 Python and 204 JavaScript mobile-harness tests passed. The Windows plugin
job passed all 2,528 tests with zero skips. The application and Windows log
hashes are respectively
`8a0e115afb4eeb9087822068db28d7c73dbaa085829ac5b9d8f03ea27ec5106c`
and `d26a89d6ff8312f6ef6f0a3a5a4ba721fe86ffdf04fe702f054437520bf09594`.
The required disposition check passes: raw CodeQL alert 143 is covered by the
existing `export.rs` source-hash disposition, whose hash still matches. No
alert was manually dismissed. Protected-main open-alert inventory is empty.

The [current hosted PR Gate](https://github.com/snaraj/obsync/actions/runs/38997155784)
then completed successfully, including all native custody jobs. Its macOS plugin
job also passed all 2,528 tests with zero skips; that log hash is
`67a8308b7d8dee09204f2262818a0e3ff57501de7cb0090983f102a203046142`.
These hosted results do not supply the missing Android acceptance passes.

The next Android-only layout diagnostic never reached the app. Initial boot
observed the expected WLAN address, response route for adbd UID 2000 and owned
loopback listener. Its single twelve-second-capped ADB connection returned a
generic failed-to-connect response after 10.108 seconds. Reconstructing that
exact bounded response matches both its retained 36-byte length and SHA-256;
it does not identify a missing listener, authentication problem or route change.
The diagnostic remains FAIL after 117.701 seconds, with layout readiness
NOT_REACHED and no plugin or server activity. No second connection was tried.
The route evidence hash is
`ad5a67d614fdb81b996f6435b5124e4b140f2fda53acef99043eca67d8f43f1d`.
Controller cleanup passed; the parent independently verified three recorded
processes, four ports and three runtime/manifest paths absent. That cleanup
receipt hash is
`3918ac728d1d1ef9e28dc5bbc6400c2fbde000c8a87d6cd5014f98f3afba3ab3`.

A second frozen diagnostic retained the same controller, transport, Android
driver and layout observer. Its only addition classified the original single
connection response and would take at most four bounded read-only guest
observations after a failed connection, within the original boot deadline.
All 17 input pins verified. The connection succeeded on its first attempt, so
those failure observations did not run. Ordinary onboarding then reached a ready
layout after 31 polls within the unchanged twenty-second budget. The document
was visible and focused, its loader disappeared, and no runtime exception or
console error was observed during the instrumented interval.

Neither previous failure reproduced. This result supports no route, graphics
or layout fix. Instrumentation before the original readiness read adds bounded
overhead, so the result is not an unmodified acceptance run. The controlled stop
occurred before candidate installation, pairing or server use. Parent elapsed
time was 130.3 seconds; the controller reported cleanup PASS and the parent
verified its two captured child PIDs, four ports and three runtime/state paths
absent. The manifest, layout observation, independent retained-evidence audit
and parent cleanup hashes are respectively:

- `d74754037655fd9bd66613a4ceb9eafff52ada50861034542f7b4e3106296e17`
- `cdf2dcdedfa20496a1bcdf657ca3f37b61ade06e647f4434667bc53d5f761ea0`
- `f8d6b6f327aa90f8de86fb0bc5fac7aa2007f1869eeeff8f68858f6bff8bfba6`
- `e416a8a169ce88320c6f8e453f3b407fb9bc33da570d9c081d74345c66be60dc`

The resulting harness change repairs missing failure evidence only. The original
readiness predicate and wait function are byte-for-byte unchanged. An initial
connection refusal now retains its closed response class. A failed native-layout
check takes one read-only layout/loader/focus/visibility snapshot, capped at
three seconds within the remaining session budget. Later readiness or failed
diagnostics cannot change the original failure. There is no extra observation
on successful startup and no new connection attempt.

The first offline verification invocation incorrectly selected the dirty working
tree as the crypto oracle's source. Its clean-source guard refused; the log
remains FAIL with SHA-256
`24ec2a3a855328c0094265b4d418f6bb42003cd68289f640accb1834f86fa72b`.
With `OBSYNC_ORACLE_SOURCE` set to the clean candidate at `1e0cd0e`, the full
`scripts/ci/mobile-harness.sh` passed 225 Python tests, 206 JavaScript tests and
all 285 scripted mutation controls, with zero skips. That log SHA-256 is
`ba8b41d2b0e3ebfe2c850bae01d88c0d8a7b0230e61bd71a014f2b0bcec98bb3`.
Four additional author mutations detected omitted connection evidence, swallowed
readiness failure, ignored remaining budget and raw page text in diagnostics.
Three failed assertions; the missing connection field failed its required-field
lookup. Their receipt SHA-256 is
`bb43209890a86ce02582d84e50c477c6df6ea7b9211af8f4a36ae1ba110eb110`.
Strict pinned documentation and origin checks passed; their disposable container,
site output, private configuration and newly pulled image were removed.

At signed head `e7917c79e66f698e391ad9999030bfb86d24f119`, the next fresh
full batch failed on attempt one after 638.055 seconds. Ordinary installation,
independently compared pairing codes, consent and two-way byte exports passed.
The quiet interval measured 213.010 seconds with no Android calls. Desktop
Quit/relaunch reached automatic idle in 1.020 seconds; Android process restart
reached it in 4.600 seconds. Twelve independently exported files matched their
nonempty expected bytes. These are partial results; attempts two and three
were not run.

The guest-reboot step failed after 240.286 seconds within its existing deadline
and command scheduling. The original route observed a changed boot identity,
completed boot and unlocked user 0. The one prescribed Wi-Fi restoration request
completed in 73 milliseconds. The first selected TCP connection stage reported
`ExpectedAttachmentPending`; the following 469 observations failed at selected
guest identity. Their first and last failures classified an unavailable
transport, with zero stdout and twenty stderr bytes. Each such iteration had
passed `connect()` again; its response text was not retained before the failing
guest read. The single failed connection-stage count is therefore not evidence
of only one connection command. Counts and first/last samples do not establish
every intermediate exception or the initiating cause. No complete incoming
frame or new selected binding was proved. The recorded failure classification
remains `UNCLASSIFIED`; no product encryption failure is inferred.

The aggregate FAIL SHA-256 is
`4d3b7d901a8145ac183c1f8e0703ae97c2ee9c7b0f7de3072bf2f64d6911d5f9`.
The unchanged full auditor refused `three_full_terminal_passes`; its receipt hash
is `592aff9888df8a407f64297b116a814396a4e7737875c7ff7590c785aeb8cfd1`.
A separate scoped audit verified 58 frozen inputs, 37 committed helpers and
166 retained evidence references. That receipt hash is
`9c659c949d58be6b05735ed36e1b80cc9992423c016a070e2232a7fe18492f40`.
Both controllers reported cleanup PASS with no remaining owned process groups.
The parent independently confirmed nine recorded processes, seven ports and six
runtime/manifest paths absent, without signaling or removing anything. Its
receipt hash is
`538f51f49e097a85513f576806d6c7f4474decf837f111212f3d7481860e0f77`.

The [exact-head hosted PR Gate](https://github.com/snaraj/obsync/actions/runs/38999714998)
passed all twelve jobs, including every native custody job. Linux passed 2,519
plugin tests with nine filesystem-specific skips; macOS and Windows each passed
all 2,528 with zero skips. The hosted mobile harness passed 225 Python tests and
206 JavaScript tests. Retained application, macOS and Windows log hashes are,
respectively:

- `579593e9af0ec0cce81bef84c2405a64488c8bd0694813434ed583ab7ff990f3`
- `0b27504b2dcf731d53db1f6516a489a2a0af1a5bc56a995d19228659b96b9405`
- `1ec00af30cfab94f3f3584649462a1542c4d672a96f4b73979e4f823e6f77964`

Hosted success does not replace the missing three consecutive full mobile runs,
physical-phone acceptance or independent final-head adversarial approval.

A frozen standalone reboot diagnostic then observed the network setup boundary.
It retained the exact candidate controller, TCP and APK helpers, installed and
verified official Obsidian, made one root transition, and used the existing
reboot/new-guest/boot-complete/user-unlock checks. It did not reproduce prior
pairing, the quiet interval, plugin installation or CA mounts. After the one
Wi-Fi restoration request, the first guest sample had no WLAN address and the
following Wi-Fi sample showed no association. The single TCP connection then
succeeded in 5.935 seconds. A complete incoming response from the same new guest
and UID took 115 milliseconds; selected boot completion was also observed.
Later samples showed the expected WLAN address and known-network association.

These non-atomic observations establish that a request can complete before the
fixture's network prerequisites are ready. The successful connection does not
prove that the readiness gap caused the previous failure, or that waiting for
those prerequisites is sufficient to fix it. The diagnostic saved no binding
and grants no product acceptance credit. Seven read-only/connection commands
and one listener check stayed within their nominal 33-second combined caps,
clipped to the existing 240-second reboot and 600-second session deadlines.
The controller completed in 79.945 seconds and cleaned up. Independent checks
found three recorded processes, four listeners and three runtime paths absent.
The frozen manifest, comparison, independent audit and independent cleanup
SHA-256 values are respectively:

- `8b7310a0debf64147c41e984806ac7406bb352052b7f33d0882eb3df5b75072d`
- `2ba580467f9cbd9fd5fdd738127ac022bdd0880bf35988a4f8145a4e4a869755`
- `b095267f2902e3153970759bbb5f421757693d5dda3776f767b7d00858c4d57c`
- `11bcf9a15aa8199c7d512b83b3c8f55d05f74e2b8328d455e2b23b338283b405`

The scoped harness repair waits for the observed setup prerequisites before
attempting the reboot connection: the original route must still identify the
same new guest and adbd UID, report the known synthetic Wi-Fi association, and
show the configured WLAN IPv4 address. Missing association or address may be
polled at the existing cadence; unknown, malformed, failed or late observations
are terminal. Every read keeps its three-second cap within the unchanged
absolute reboot deadline. The initial/root route predicates, actual incoming
same-guest response and completed-boot checks remain required. No connection
retry, route fallback, product change or deadline extension is introduced.

The retained evidence includes bounded first/last observations, source and guest
bindings, byte counts and hashes, and monotonic timestamps proving readiness
preceded connection within the same deadline. Admission refuses a missing or
inconsistent witness. The closed connection response is recorded before the
selected guest read, so a subsequent failure cannot erase that stage result.
This is a fixture precondition repair supported by the diagnostic, not a claim
that the full acceptance failure has been resolved. Focused verification passed
69 tests; three author controls caught omission of the readiness guard, its
post-read deadline check and the required retained witness. The mutation receipt
SHA-256 is
`eace5a9eefa6f6d76407b8446fe3e138e64ae6402e4e6d2cae06a4f78da62f26`.

The first full offline invocation for this repair remains FAIL, log SHA-256
`99bef5c0892705a90ac4932ba2968bfae5c0f38294e44ec705bc2ce354740a74`. Its 228 Python and 206 JavaScript tests passed,
but the foreign-guest mutation survived: the fixture returned the altered
guest frame on both the original readiness route and selected incoming route.
The earlier guard therefore masked the later guard under test. The fixture
was corrected to keep the original observation valid and alter only the selected
response; no runtime guard or refusal expectation was removed.
The selected mixed-UID fixture also retains the expected first UID while varying
another UID field, isolating the all-four-fields guard from the later route-UID
binding. The response-membership mutation keeps string type checking so it
cannot be counted as killed by an unrelated attribute error; an unrecognized
string and aligned cross-receipt class exercise membership directly. The null
response refusal remains covered. All 50 focused TCP mutations then failed
assertions, without test errors. The test-only correction manifest SHA-256 is
`dfb8bd472d8b82b39db839cbfe891650848c041e0e5c1e19e098935b4a3ece06`.

The corrected full offline suite passed 228 Python tests, 206 JavaScript tests
and all 285 scripted mutation controls, zero skips. The command remained
`scripts/ci/mobile-harness.sh`, with `OBSYNC_ORACLE_SOURCE` pointing at the clean
unchanged candidate. Its complete log SHA-256 is
`5f1ffe5ff571ee71ae72b936a830f580d318d183b1dac5c83c7d271f21dce98b`. These are harness checks; native acceptance
requires a new fresh full batch and is not inferred from them.

At signed head `94e49bcfabc2faa69661b301483467ab5c172e34`, the next full
batch completed all 169 native journey steps, then failed the final closed
confidentiality scan. Attempt one remains FAIL; attempts two and three were
not run. Its aggregate SHA-256 is
`479cc0fc9c7fbadb7b69614b2a546f7e1ad478b096bdb0caf0e3b476c515bc47`.
The run lasted 1,258.623 monotonic seconds, including the 213-second interval
without Android calls. The guest reboot completed in 23.508 seconds; its
retained readiness observations showed association and the expected address
before the selected connection, within the unchanged deadline.

The independent partial audit verified 58 frozen inputs, 37 committed helpers,
627 retained references, 100 device exports and two fresh-recovery exports.
It re-executed the selected-folder identity, ancestry and five-minute stability
assertions, and checked three ciphertext/outcome bindings. These are partial
journey results, not a completed confidentiality or full acceptance verdict.
The closed recorder had 378 naturally completed connections and no recorder
errors. The scanner then refused `native_traffic_leak_or_parse`; it saved
neither its hit count nor its parser errors before throwing. The capture and
secret inputs were removed during required cleanup. Consequently this evidence
cannot distinguish a leak from a parser refusal, and cannot establish zero hits.
Server-storage and planted-control scanning had not yet been reached.

The unchanged three-pass auditor refused this batch. Independent cleanup
verified 14 recorded processes, ten ports and six runtime/manifest paths absent.
The reduced terminal audit SHA-256 is
`6e08a716782452f21ac4121f94b583147fbb911d284be52c66786b97a0ed72fa`;
the independent cleanup receipt SHA-256 is
`5d4701b27e7c69a2aa28672237d24f70a7f454499d45c610589935bcff62c1cf`.

The [exact-head hosted PR Gate](https://github.com/snaraj/obsync/actions/runs/39001779599)
passed all 13 jobs. Rust passed 734 tests with one ignored measurement and
94.84% line coverage. Linux passed 2,519 plugin tests with nine filesystem-specific
skips; macOS and Windows each passed all 2,528 without skips. The offline mobile
harness passed 228 Python tests, 206 JavaScript tests and 285 mutation controls.
These results do not replace the failed native scan, the three-run requirement,
physical-phone acceptance or independent final-head review.

A separate source-bound synthetic scanner diagnostic reproduced two defects.
An identical public setup `generation_mismatch` refusal passed with one valid
backup and failed with a valid backup containing the word `account`; only the
individual-word needle matched. The complete backup, mnemonic and root were
absent from the capture. The server's fixed public detail contains that word.
This proves a seed-sensitive false positive, not the cause of the deleted
native capture's failure. The diagnostic SHA-256 is
`5b7efbaa297d04098465aa306055cfdccb2923afe248a60ef48f5770fdb3d136`.
It also reproduced a missing-needle case: a candidate-valid 24-word mnemonic
whose words were all shorter than seven letters escaped detection when sent
without the backup prefix. Explicitly adding the complete mnemonic detected
the planted leak. Existing root and complete-backup controls still failed.
That diagnostic SHA-256 is
`afcf487911981864c2c9ac5c752adb67d4cb4a224bc78153512e255a4779956f`.

The repair narrows individual-word matching only for the byte-exact public
setup refusal, bound to the candidate server source, the paired setup request
and its final 409 response. Changed source, route, status, body, extra fields,
headers and encoded values remain refused or scanned. Complete backup,
canonical mnemonic, content and key needles remain active. Canonical mnemonics
retain a recovery classification so Android metadata scanning includes them.

A refused native scan now saves bounded categories, counts, source/capture
hashes and failure-only message diagnostics before cleanup. It records no raw
needle, recovery word, request target, header, body or error text. A diagnostic
write failure, cap, timeout or unlocalized match cannot rescue acceptance;
message candidates are explicitly not an attribution of the original hit.
The scoped integration review found no blocking composition issue. Native
acceptance of these repairs requires a new batch; the earlier failure remains
unclassified.

The first full local gate for this repair failed an unchanged permission-fixture
assertion. The invocation's restrictive `077` umask prevented its requested
`0644` file from being created permissively, so no repair log was expected.
A controlled run of that exact unchanged test failed under `077` and passed
under `022`. The next full gate uses the normal `022` test umask, with its log
created separately as `0600`; no product or test assertion was weakened.

That invocation passed 734 Rust tests (one ignored measurement), 94.85% Rust
line coverage, all 2,528 plugin tests without skips, and the real-server E2EE
check with 21 flows and two planted leak controls. It then stopped in mutation
setup: the mnemonic diagnostic selector matched two source locations after
composition. This was an invalid mutation, not a killed control. Narrowing it
to the intended diagnostic branch left the tested behavior unchanged.
The complete offline harness then passed 228 Python tests, 220 JavaScript tests
and all 310 scripted mutation controls, zero skips. The remaining canonical
gate stages were run separately; the interrupted full invocation stays FAIL.

At signed head `317b32c1cc3359c620c9c3677acd047f0e79b7f1`, the next batch
failed before pairing: the unchanged official APK installation exceeded its
90-second limit. Attempts two and three were not run. The batch aggregate
SHA-256 is `d73c42817ffe59c63710b53127ea5fed20bafff27ae103d490330527b8396918`.
The three-pass auditor refused acceptance; independent cleanup verified eight
recorded processes, seven ports and six paths absent. The timeout identifies
an automation stage, but the missing stdout prevents attributing its cause.

Two separate installation diagnostics passed without retrying an install.
The Android-only fixture installed in 7.235 seconds; a fresh fixture including
the ordinary desktop enrollment and local TLS route installed in 5.043 seconds.
Both independently verified the installed APK. The latter retained bounded
client trace facts: local copying reported all 15,447,027 APK bytes by
623 milliseconds, which does not independently prove guest consumption.
It completed ordinary desktop shutdown and natural recorder closure.
Independent cleanup verified eight processes, eight ports and six paths absent.
The diagnostic manifest, result and cleanup SHA-256 values are respectively:

- `fcd4c4b839163cf5aa88a2c92a62fc5dc250ce6be8a39052acf64820df3ad7b3`
- `d092e46574da690eb10263b68cedeb1cfc2e758c748611d189a8aa3b3b5ab8af`
- `afde9ab9b3556419fe7c6d62377ee14e6435ab3d03d36a2a6307d840a7afc17e`

These diagnostics do not explain the earlier timeout or count as acceptance.
Its cause remains unknown. The
[hosted PR Gate for this head](https://github.com/snaraj/obsync/actions/runs/39005068038)
passed all 13 jobs; native acceptance, physical-phone evidence and final-head
independent review remain separate gates.

At signed head `79ebe97c7ea79e52369e82d5b5f6ab1a29eb2c14`, the next
three-attempt batch stopped after its second attempt. Attempt one was
FULL_PASS; attempt two failed at `recovery-d-open`; attempt three was NOT_RUN.
The batch remains FAIL, with aggregate SHA-256
`dfad21b3cc5492067c333ceb211fc2aee09e779441468e46229f758ad0c73aed`.
Its frozen input manifest SHA-256 is
`5e4ecbd01e92ec1a074d50d49a91d902f27286dec699c7e4534ab2d6edde648e`.

Attempt one completed all 169 native journey steps in 1,289.301 monotonic
seconds. It included ordinary pairing and consent, a 213-second interval
without Android calls, process restarts, guest reboot, offline recovery,
both revocation modes, interrupted rotation, both five-minute selected-folder
stability windows, and fresh recovery. Its final confidentiality scan covered
three backups and all three canonical mnemonics, with zero unexpected hits or
parse errors. Planted traffic, server-storage and server-log leaks were detected.
The author-side retained-evidence audit verified 100 device exports and two
fresh-recovery exports. This is one complete emulator pass, not the required
three consecutive passes or physical-phone acceptance.

Attempt two lasted 1,297.443 monotonic seconds. Fresh desktop D provisioning
succeeded, but opening its vault failed after 45.653 seconds, before any
recovery backup was submitted. The retained helper reports only a generic
owned-step refusal. It cannot distinguish initial dispatch, target selection,
trust/plugin readiness or later settings failure; the cause remains UNKNOWN.
Its 100 device exports, selected-folder ancestry and quiet endpoints, and three
ciphertext bindings remain scoped evidence. Both attempts retained old-key
rejection of current map, manifest and chunk ciphertext, current-key success,
and successful old-key baseline/access-only controls. Fresh-C recovery and the
final confidentiality scan were not reached in attempt two.

The unchanged three-pass auditor refused acceptance, receipt SHA-256
`e74af0cf94104a51d65e17780ab982ef8e6ddd098b53eefa5fa7adc396af15e7`.
A separate partial audit hash-binds 1,211 retained files without promoting the
batch; its SHA-256 is
`77d70c99d887eb5288c2a7bc2018b0ef94226db92ce257b35b90dd0699481a10`.
Independent terminal checks verified 27 recorded processes, 18 listeners and
18 task paths absent. Six of those paths belong to the unrun third attempt.
Both executed controllers reported cleanup PASS and zero remaining groups.
The independent cleanup receipt SHA-256 is
`ffee6b6730f7df985365485f43dbdf83b66bd52035176b8f69f3d32d64a9453e`.

The [hosted PR Gate at this head](https://github.com/snaraj/obsync/actions/runs/39080708532)
passed all 13 jobs, including all 935 repository contracts. The local contract
invocation's unchanged release-audit subprocess timeout remains a failed
invocation; the hosted pass is a separate result. Of all PR checks, 46 passed,
one deployment was skipped and the nonrequired CodeQL aggregate remained red
for a covered alert; the required dispositions check passed. No manual alert
dismissal was performed. Neither these checks nor the partial audit closes
the three-pass, physical-phone or final-head review gate.

A separate opening diagnostic used the same clean candidate, actual official
Android application, ordinary desktop enrollment, and the unchanged session
owners. Its first attempt failed before either recovery vault opened: an
uppercase label in the diagnostic wrapper violated the desktop operator's
lowercase argument contract. That failure remains retained. Independent
cleanup verified seven recorded processes, eight ports and seven paths absent.

After correcting only that argument and using a fresh environment, B opened
in 1.416 seconds and D in 1.280 seconds. All three desktop processes quit
naturally with exit code zero. The private wrapper deliberately stopped its
parent with a distinct nonzero result after recording diagnostic completion;
the original controller's FAIL was not relabelled as product acceptance.
An independent audit verified all 89 frozen inputs and the terminal sequence;
fresh cleanup checks found nine processes, ten ports and seven paths absent.
The diagnostic result, retained audit and cleanup SHA-256 values are:

- `4cda6ca113febe740c09720a6dca32d8965aa10386b3c74db5b1c6ed7b76af96`
- `276c8fabf32ab64e8d1657d33a9f9e058410c7d0d4cb99347aa0df0dea683c0c`
- `146f91442a827332675c9e707bd0d5473044f2b04e8312c0e13f08ee54445eb7`

This reduced fixture did not execute the preceding paired Android workload,
rotation or recovery submission. It therefore establishes that the isolated
open sequence can succeed, not the cause or repair of the full-batch timeout.

The installed official startup source registers the vault-open handler before
creating the ordinary chooser. The bundled `obsidian.asar` SHA-256 is
`a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d`.
The chooser's inner DOM appears only after its renderer initialization. The
previous first-page selection did not require that initialized context;
this identifies a missing readiness check, not proof of the batch timeout's
cause.

The driver now requires the exact process-bound chooser URL, initialized
inner DOM and callable IPC before one vault-open dispatch, and rechecks them
in that dispatch evaluation. A shared monotonic 45-second opening admission
budget begins before chooser selection, covers the later strict recovery
readiness checks and refuses a late final receipt write. The asynchronous
watchdog does not claim to interrupt synchronous work or cancel guest
execution; the existing 120-second outer process cap remains. Success and
failure retain bounded readiness facts without raw DOM or exception text.
Nine focused controls and 14 source mutations exercised this guard; these
offline results do not count as native acceptance or explain the earlier
failure. The separately frozen B/D diagnostic retains its own outcome.

The guarded diagnostic then repeated the fresh B/D sequence on the same clean
candidate with 94 frozen inputs. Both processes opened successfully: B in
1.952 seconds and D in 1.359 seconds; their measured opening admission times
were 1.447 and 0.949 seconds. Both retained the exact initialized chooser,
one completed dispatch and all strict detached/plugin/settings/URL checks.
All three desktops quit naturally with exit code zero. The deliberate child
exit remains diagnostic-only; no pairing, recovery submission or full-run
acceptance is inferred. The result, independent retained audit and independent
cleanup SHA-256 values are respectively:

- `e205f3eefe646d756c86bf0ab51f9af790591f85cbc4d165e66fcc887eea3bb7`
- `9d599ada64ec49a3375d2e60b6395117d5235195215d03ce091f85391b70a0ba`
- `5d6b7ee70ee0e3234e95c0b82261af45e5e13b76dd00ab1bd998b3ea039389e2`

The independent cleanup check found nine recorded processes, ten listeners
and seven task paths absent. Native READY receipts were rehashed; private
child logs had already been removed, so their recorded step hashes could not
be rechecked. The earlier full-batch timeout remains unexplained. The new
check addresses the separately reproduced missing prerequisite without
extending a deadline, redispatching or changing the product.

The first combined test invocation after this change failed four of 23 tests:
older synthetic open adapters lacked the new chooser and monotonic-clock
inputs. Updating those adapters preserves the one-dispatch, 45-second,
225-poll refusal assertions and requires the new bounded success evidence.
The corrected focused run passed all 23 tests and all 43 recovery mutation
controls, including the 14 chooser controls now in the regular harness.
That failed invocation remains retained; it is not counted as a passing run.

The complete offline command `bash scripts/ci/mobile-harness.sh` then passed
232 Python tests, 232 JavaScript tests and all 329 scripted mutation controls,
with zero skips. Its log SHA-256 is
`64d0f9f17d720b478197b86d6fcb90b630423bd2f01780edf2f0eee5ba82f3c9`.
An earlier observation-only invocation failed because the sandbox denied its
local sockets and process queries; a separately authorized invocation passed.
Neither result is a native acceptance run. The physical-phone gate, three
consecutive full emulator passes and final exact-head review remain open.
