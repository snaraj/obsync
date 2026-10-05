# 1.1.7 candidate checks

Observed 2026-10-05; unreleased preparation on protected baseline
`897124b073baf51ef2cb3fff52a5badc1940a237`. This record does not close #325 or
claim the release ready. [The stage report](https://github.com/snaraj/obsync/pull/335)
is the preceding documentation slice. The character-editing engine remains
outside this artifact.

## Minimized desktop outage (#283)

The initial native test exposed a real failure: after unanswered requests,
upload draining remained active through transport backoff and background
throttling stayed lifted beyond the 30-second observation budget. All 257
local sentinel files remained byte-exact. Idle, engine cancellation and plugin
unload restoration passed before the fix.

The candidate uses current transport reachability only for the desktop power
policy. An unanswered attempt starts the existing five-second grace; another
failure cannot postpone it. An answer cancels restoration or immediately lifts
throttling while work remains. Refusals that answer are reachable, not evidence
of progress. A lost request can restore throttling while concurrent local work
remains; retry, signing, encryption, queues and persistence are unchanged.
Replacement engines inherit the session state; stopped engines cannot lift it.

Two native Obsidian 1.13.4 windows then passed idle, engine cancellation,
plugin disable/enable, offline drain and recovery checks against the actual
Electron background-throttling getter. The window remained minimized and
hidden continuously through outage and automatic recovery; no foreground or
manual retry was needed. Independent disk reads matched all 257 expected notes
in both vaults, and the final portable run checked exactly 257 matching fixture
filenames on each peer. Screenshots inspected after recovery showed idle with
257 tracked files and the final peer sentinel. The initial outage status was
also visually inspected. Two subsequent minimized recovery runs passed.

These native runs use an owned loopback intermediary and mock keychain.
They prove desktop behavior with authenticated encrypted sync, not trusted TLS,
personal keychain custody, battery life, physical-phone or VM sync. Cancellation
calls the real engine stop; unload uses Obsidian's plugin lifecycle. A first
teardown identity race was preserved and resolved by independent absence proof;
the final portable run completed automatic cleanup. All task profiles, account
state, private logs and manifests are absent.

Plugin SHA-256:
`8f6b05d7dd8f589c4781f117d0ce37eabd9bd0f8cd4ffe2751200c53ee9028ed`.
Server SHA-256:
`9d42d9c240862340d39ce76d36f10d1564fa7dba1e9cab7bad047751c0282cdc`.
Reproduction: the never-merged experiment harness at
`0f653717b291d556a3df19d2e35111157e41e542`, `experiments/sync-117/test.py throttle`,
with an explicit built candidate source and a fresh external run. Require
scenario, teardown, final-cleanup and workflow receipts. Its 22 cleanup guards
pass; the final native run preceded only the final SIGKILL race guard.

## Loaded regression and CLI checks

For #319, the original large-file setup passed 20 standalone runs and four
loaded suites before its fifth loaded run exceeded the unchanged 10-second
setup deadline. The deterministic settled-state setup passed 20 standalone and
five loaded suites, retaining independent bytes, rename selection and request
checks. Load used the pinned Node image, four CPUs, 8 GiB and 40 bounded workers.
These are reliability checks, not a quiet performance comparison.

| Platform | Current candidate evidence | Boundary |
| --- | --- | --- |
| macOS ARM64 CLI | 207 native commands pass | Temporary config/runtime journey; no server contact |
| Linux ARM64 CLI | 223 native commands pass as ordinary uid; temporary roots absent | Actual disposable VM; XDG/default paths and independent frame readback |
| Windows AMD64 CLI | Native ordinary-user version/help/status guidance and capability display inspected | Full candidate hosted installer/storage journey NOT_RUN; missing trusted PowerShell setup correctly refused |
| Android 15 ARM64 | Fresh official Obsidian 1.13.4 and candidate 1.1.7 loaded; settings and HTTPS refusal visually inspected | Unpaired UI only; HTTP not saved; no mobile sync/key-custody claim |
| Physical iPhone | NOT_RUN | Mirror requires local authentication; no personal vault modified |

Five Linux CLI mutations each failed twice at their intended oracle; two
unmodified controls passed. They cover default XDG behavior, honoring an
absolute XDG path, unknown-status guidance, empty lists and doctor guidance.
The final full local gate passed: Rust formatting/clippy/workspace tests,
94.72% line coverage, 1977 plugin tests, 83 dashboard tests, 872 repository
contracts, native CLI packaging, chart checks and both secret scans. Eleven
selected plugin mutations were killed twice, including the new outage/recovery
and replacement-engine guards. A sandboxed gate attempt refused the fixed
macOS ACL helper; the native rerun passed without weakening custody checks.

Reduced receipts and screenshots are retained in the external dated campaign.
Current Android runtime, vault, private logs and ADB listener are removed; its
emulator exit race was preserved and cleanup independently confirmed. Historical
workers' fixture cleanup is outside this record and is not claimed here.
Remaining #325 performance choices, physical-phone acceptance, current hosted
platform checks and owner merge still gate release.
