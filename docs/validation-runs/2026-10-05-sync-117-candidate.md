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

## Linux native sync and custody

The same plugin ran in two official Obsidian 1.13.4 clients inside a fresh
Ubuntu ARM64 VM, as an ordinary user. The final reusable workflow passed native
setup and pairing, three concurrent typing cases, transfers in both directions,
native app closure and vault reopening, and another transfer in each direction.
All typing cases independently matched disk bytes, editor text and file IDs,
with 26 trusted characters per writer and no conflict copies. Convergence after
the final completed native input took 10,881, 10,797 and 10,812 ms, including
the existing editing hold. These are derived from the final insertion timestamp
in each retained timeline; the driver's original counter starts after its final
cadence sleep and records 10,588, 10,497 and 10,516 ms instead.
This remains whole-file merging, not character-level collaboration.

Obsidian reported encrypted `gnome_libsecret` storage, not plain JSON, before
and after restart. Metadata and secret revisions matched on both clients, which
reopened paired and idle without re-enrollment. Native closure, restart and
reopening took 1,703 and 1,755 ms; subsequent note arrival took 1,091 and 1,048 ms.
These are functional observations in one VM using loopback HTTP, not TLS,
cross-machine performance, physical-phone or power-loss durability evidence.
The static ARM64 server hash was
`831b8f649ac643a16a49881cbaf102c1d107d7d90cb33f3e4f86f89b54f68c3e`.

Failures remain recorded. The VM's GPU process initially failed; software
rendering resolved that without disabling the sandbox. A shared session lacked
a usable keyring, so the final launcher uses the repository's existing isolated
GNOME session per profile. Forced whole-session termination produced a
`credential_behind` refusal on one client; this is not claimed as a passing crash
test. Graceful closure requires closing all native windows, awaiting actual exit,
then reopening the vault after the new app becomes ready. A stable launcher and
parent-owned reaping resolved harness identity races without weakening checks.

Twenty-two captures from an earlier passing typing/transfer phase were inspected,
including all settings pages; six final-workflow captures were separately read.
Both editors show the merged text, status shows idle with five files and 254 B,
and post-restart notes show the expected peer sentinel. One merge toast clips at
the capture's right edge; no complete-toast layout claim is made. All thirteen
Linux run profiles, private logs and manifests are removed, along with the new
disposable VM and 338,421,660 bytes of host staging. Reduced failures and captures
remain. The earlier CLI VMs and verified installer are preserved.

Reproduction: `experiments/sync-117/linux-native/run.py --cotype` at never-merge
commit `da2d43bf38b1f90a14e082d39db5f9fb05cf24fb`, with the six explicit
source, harness, run and artifact paths described in its README. The executed
helper hashes match that archive. Use corrected helper commit
`01e18a1e1caceef41b838bf935be8b01ddb69da5` for new runs. It binds all XDG
storage roots to the disposable profile, strips inherited session controls and
starts typing latency at the final insertion timestamp. Both focused isolation
tests pass; ten environment-escape mutations fail twice at their assertions,
with passing controls and removed scratch. Independent delta pre-review agrees.
Those later isolation and timestamp changes were not rerun in the native VM;
the native results above remain bound to the measured archive.
Require the Linux workflow, custody before
and after, independent transfers, teardown and final-cleanup receipts; inspect
captures separately.

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
| Linux ARM64 plugin | Native pairing, concurrent typing, encrypted GNOME custody across graceful restart, post-restart bytes | Same-VM loopback; forced whole-session restart did not pass |
| Windows AMD64 CLI | Native ordinary-user version/help/status guidance inspected; later hosted installer/context/replay/uninstall and peer-access refusals passed | See the [Windows follow-up](2026-10-05-windows-117.md) for tested source and limits |
| Windows AMD64 plugin | Fourteen native journeys and six inspected editor captures, including encrypted credential restart | Same hosted Windows machine; concurrent convergence still takes 10.7 seconds after typing ends |
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

An independent source pre-review at
`061e9e5493197f806efa1e67b894bf66b6a542cc` found no blocking source issues.
It replayed the four final revised mutation patches twice, with assertion
failures only and passing 20-test baselines before and after. Its wrapper's
last empty-temp assertion flagged npm's own compile cache; a separate
`npm --version` control reproduced that cache, and the wrapper removed its
whole scratch tree. This is a retained harness failure, not a failed mutation
or a formal PR approval.

## Rejected upload overlap

The bounded upload-existence overlap experiment is preserved at never-merge
commit `25f155c30bd69f7b007cd9d4e9668194b2aa8bf2`, under
`experiments/sync-117/upload-overlap`. Its three alternating native pairs
produced a median large-file sender ratio of 1.0122 (about 1.2% slower),
failing the fixed requirement of at least 5% improvement and improvement in
every pair. Small-note transfers did not improve. The candidate therefore
contains no change from this experiment.

All six samples independently checked 129 files and 68,160,531 bytes on each
peer, matching persisted identities and request/body-byte counts. The report
retains the exact patch, all samples, four killed mutants and twelve inspected
captures. Its same-host loopback/mock-keychain results are not deployed-route
or phone measurements. All six private runs and the prototype worktree were
removed. Recompute with the archived `recipes/summarize.py`; no failed or slow
sample was discarded. Parallel application and metadata hash caching still
need their own safety and acceptance work; rejection of one experiment does
not complete #325 or approve moving its scope to another release.

Reduced receipts and screenshots are retained in the external dated campaign.
Current Android runtime, vault, private logs and ADB listener are removed; its
emulator exit race was preserved and cleanup independently confirmed. Historical
workers' fixture cleanup is outside this record and is not claimed here.
The later [Windows record](2026-10-05-windows-117.md) supplies native and visual
platform evidence. Remaining #325 performance/design acceptance, physical-phone
acceptance, independent artifact review and owner merge still gate release.

## Further bounded performance results

Two more levers failed their improvement thresholds and were rejected. The
[scheduling-yield archive](https://github.com/snaraj/obsync/blob/767faaf2689f681c5e17032b1eac29d713fbc0af/experiments/version-yield/REPORT.md)
reports a median 128-note sender ratio of 0.989020. The
[version-metadata batch archive](https://github.com/snaraj/obsync/blob/198033e4a63d6263e7d474e647dbec8278f746e9/experiments/version-batch/REPORT.md)
reports 0.987755 and one pair regressing to 1.032258. Both required at least
5% median improvement and improvement in every pair before promotion.

Each experiment used six native Mac samples with independent byte/identity
readback and twelve inspected screenshots. All runtime/private fixtures and
owned experiment inputs/build caches are removed. Exact patches, recipes,
failures and reduced receipts remain on never-merge branches. Neither lever
changes this candidate; no performance gain is claimed from them. Phone and
deployed-route behavior cannot be inferred from these loopback comparisons.
