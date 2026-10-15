# Unattended Android security acceptance

2026-10-15; [PR #347](https://github.com/snaraj/obsync/pull/347), security
release 1.1.8. This is an author validation record, not independent approval.

## Candidate and reproduction

Product source: `cb7b5ae4973ed7ba6d494865ed2ba4e7a4cac928`;
protected base: `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0`.
The [runner guide](https://github.com/snaraj/obsync/blob/2738e301f04bc2e8e5b1ecda2ec02e545706bb72/scripts/validation/MOBILE-ACCEPTANCE.md) describes the
single command, private pinned inputs, finite journeys and cleanup. The product
and driver checkouts are separate; the full runner requires committed driver
blobs and rechecks them after execution.

| Installed input | SHA-256 |
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
have passed**. Both full batches stopped on their first failed attempt;
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

## Remaining gates

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
