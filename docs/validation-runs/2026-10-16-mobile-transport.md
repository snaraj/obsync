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

## Acceptance boundary

The portable transport is integrated into the existing acceptance runner, with
no production change. Retained admission requires the expected initial, root and
reboot identities, actual routes and exact source bindings after both cleanups.
Root reattachment requires UID 0 and is bounded by both its original 20 seconds
and the remaining session lifetime. Three consecutive fresh full acceptance
passes on the committed integration remain required. The physical-phone gate,
final hosted checks and independent exact-head approval also remain open.
