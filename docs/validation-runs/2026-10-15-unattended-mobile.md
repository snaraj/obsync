# Unattended Android security acceptance

2026-10-15; [PR #347](https://github.com/snaraj/obsync/pull/347), security
release 1.1.8. This is an author validation record, not independent approval.

## Candidate and reproduction

Product source: `cb7b5ae4973ed7ba6d494865ed2ba4e7a4cac928`;
protected base: `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0`.
The [runner guide](../../scripts/validation/MOBILE-ACCEPTANCE.md) describes the
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
have passed**. Earlier exploratory journeys are not counted as three fresh
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

The existing red CodeQL aggregate is not an uncovered finding: the required
`dispositions` job passed, and the reviewed `cli/export.rs` file hash exactly
matches its existing disposition for ciphertext identifiers. No alert was
manually dismissed or excluded from analysis.
