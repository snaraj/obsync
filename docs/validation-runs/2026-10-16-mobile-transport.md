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
reboot identities, actual routes and exact source bindings after both cleanups.
Root reattachment requires UID 0 and is bounded by both its original 20 seconds
and the remaining session lifetime. Three consecutive fresh full acceptance
passes on the committed integration remain required. The physical-phone gate,
final hosted checks and independent exact-head approval also remain open.
