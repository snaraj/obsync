# Unattended mobile acceptance — 2026-10-17

Author evidence for #347 / v1.1.8. Three consecutive fresh emulator attempts
completed FULL_PASS at source and driver commit
`780a8cba86039760e4f349dd6f3e09d258aafe40`. All three used the same pinned
candidate artifacts and frozen driver inputs. The aggregate reports PASS,
`threeFreshFullRunsPassed: true` and `fullAcceptance: PASS` for the emulator.
Physical-phone acceptance remains NOT_RUN.

## Measured runs

| Attempt | Result / controller cleanup | Monotonic seconds | Wall seconds | Difference |
| --- | --- | ---: | ---: | ---: |
| 1 | FULL_PASS / PASS | 1302.719 | 1302.723 | 4 ms |
| 2 | FULL_PASS / PASS | 1278.276 | 1278.280 | 4 ms |
| 3 | FULL_PASS / PASS | 1277.426 | 1277.429 | 3 ms |

Each attempt used official native macOS Obsidian and official Android Obsidian
in a fresh disposable Android userdebug emulator, with the real candidate
server. It completed the [runner scope and evidence mapping](https://github.com/snaraj/obsync/blob/780a8cba86039760e4f349dd6f3e09d258aafe40/scripts/validation/MOBILE-ACCEPTANCE.md#what-is-measured):
ordinary pairing/SAS/consent, two-way persisted bytes, idle and real lifecycle
transitions, scoped offline recovery, access-only and strong revocation,
replacement pairing and retained history, interrupted rotation, both five-minute
selected-folder quiet windows, fresh recovery and closed confidentiality checks.
This is the enumerated unattended scope, not every scenario in the wider
[device-validation requirements](../validation.md).

The unchanged independent retained-record auditor returned
VERIFIED_THREE_RETAINED_FULL_RECORDS. It bound 37 source inputs and 1,875 retained
files, independently compared each attempt's 100 device exports and two fresh-C
recovery exports, and reexecuted the original selected-folder identity,
ancestry and quiet-state assertions. It also checked each retained reboot
request/new-guest/restoration chain. Original direct crypto and closed-scanner
outcomes remain hash-bound receipts. In all three native runs, the old key
opened baseline and access-only ciphertext. After strong rotation it rejected
the new map, manifest and chunk ciphertext; the current key opened that same
new ciphertext. Keys and raw confidential capture had
already been removed, so those operations were not rerun by the terminal audit.

The supplementary audit verified all 59 frozen inputs and 37 committed helper
blobs, with 169 distinct numbered journey steps per attempt. Across the three
runs, all nine fresh B/C/D openings observed the exact initialized chooser,
one completed dispatch and every strict check within the 45-second admission
budget. Each scanner covered three full backups and three canonical mnemonics,
with zero unexpected hits or parse errors. Every run passed three negative
crypto controls and three planted scanner-leak controls. Each also observed
one untrusted-certificate refusal and two wrong-host refusals, including the
post-reboot check. Captures closed at natural EOF without recorder errors.

| Attempt | Android quiet seconds / calls | First selected quiet window seconds | Second selected quiet window seconds |
| --- | ---: | ---: | ---: |
| 1 | 213.003 / 0 | 301.413 | 301.360 |
| 2 | 213.010 / 0 | 301.459 | 301.406 |
| 3 | 213.010 / 0 | 301.497 | 301.513 |

The first private supplement check incorrectly expected two certificate
negative observations and failed. That invocation remains retained; the
corrected count is three. No native run or acceptance predicate was changed.

A separate exact-resource cleanup check returned VERIFIED_ABSENT for all 42
recorded PIDs, 27 listener ports and 18 runtime/private/manifest paths. Both
original controllers reported cleanup PASS and zero remaining groups for each
attempt. This checks the recorded resources; it does not inventory unrelated
processes, devices or storage.

## Artifact and receipt pins

| Artifact | SHA-256 |
| --- | --- |
| Plugin `main.js` | `babc5e9a94c56658a2ce173fb3fb632567ed5b23af67c425882de1ecfa241fef` |
| Plugin `manifest.json` | `19f3a53197def24aa0488afdf945ebee739cf7adf84b200319dfccdddab6a0ef` |
| Plugin `styles.css` | `796f28c630774dc80e00b8ba4c0d3811d524b1cd844fe36d0f9597c5ee0e82ce` |
| Candidate server | `3b4f94a7baf5d05cfb6cb4d3b3a331b54fc232c0bbd9e0c35925238d0edf9a97` |

| Machine record | SHA-256 |
| --- | --- |
| Candidate build receipt | `d498accafb2b789de6d09b0184f9a2496891277351cfafa94d8f5c52b59e7774` |
| Frozen driver manifest | `1f121ca0bba77be11b03e313a59a02638dfe897e3bb8b89a23ec8e8f4ec2a882` |
| Batch aggregate | `943e001d91c089530b7b05f20f06f136ce9a69a00af6bfb5771303ff3223aff1` |
| Independent retained-record audit | `378e355e244414e308399b43a747b9501e01287db7e0a8c6631970ba0c621936` |
| Supplementary retained controls audit | `f912a269d8d8130c80d01eb7c610953df793aada96068e701c963dac4937c473` |
| Independent recorded-resource cleanup | `e334cd9e3b25d408485914ef4dc622b42383031929c0d7f8beef2c4f08fbc0b3` |

## Reproduction and limits

Use clean candidate and driver worktrees at the measured commit, the recorded
Python 3.15 toolchain, pinned official assets and a private `0600` configuration
as described in the [runner guide](https://github.com/snaraj/obsync/blob/780a8cba86039760e4f349dd6f3e09d258aafe40/scripts/validation/MOBILE-ACCEPTANCE.md#run).
Keep the host lid open and choose a new absent output directory:

```sh
caffeinate -i "$PYTHON" -B scripts/validation/mobile-acceptance.py \
  --config "$PRIVATE_CONFIG" --out "$ABSENT_RUN_DIRECTORY" --runs 3 --mode full
```

The [earlier transport record](2026-10-16-mobile-transport.md) preserves the
failed batches and scoped diagnostics. The tcp11 `recovery-d-open` cause stays
UNKNOWN. The missing initialized-chooser check was separately reproduced and
its guard validated; subsequent success does not establish that timeout's cause.
One older dirty-oracle invocation log could not be located in the bounded
historical follow-up. Its failed summary remains retained and is not used as
new passing evidence.

The fixture uses restricted virtual Wi-Fi, an explicitly restored network
after guest reboot, rooted userdebug facilities and a temporary guest-only
system test CA. It does not prove automatic Wi-Fi reconnection or stock-phone
trust installation. Actual physical USB execution remains NOT_RUN; the
[USB adapter](https://github.com/snaraj/obsync/blob/780a8cba86039760e4f349dd6f3e09d258aafe40/scripts/validation/MOBILE-USB.md)
supports only the documented core path, with full journeys and pretrust control
unsupported. Hardware-backed/OS-encrypted custody, OEM power behavior and iOS
Keychain/WebKit behavior remain unmeasured. Raw API credential values were not
exported or exhaustively scanned; the guide names the finite content and
metadata coverage.

This record binds native evidence to the measured commit. A later documentation
checkpoint is not a fresh native run. Final exact-head independent review and
the physical-phone gate remain separate; this author record grants no Ready,
merge or release approval.
