# Rust CLI candidate: native processes and visible desktop checks

Date: 2026-10-03 through 2026-10-04 UTC. Operator role: agent.
Scope: #255's offline CLI for v1.1.6. These are trusted source-build candidate
checks. Public installation, release provenance and deployment remain V19 work.
No server, vault, management credential or production service was used.

## Source and environments

The hosted checkpoint is `1d399cea0095557e2eca841b06c7c9126df2545e`.
[Native run 37166485108](https://github.com/snaraj/obsync/actions/runs/37166485108)
passed on ordinary users on Windows amd64, macOS arm64 and both Linux
architectures. Each ran the 122-command public package journey and independent
installed-file/context readback. The Windows build uses the native MSVC target.
This run did not retain its artifact hashes in the public event; the revised
journey emits its existing hash/timing receipt before disposable cleanup.

The strengthened [native run 37171478315](https://github.com/snaraj/obsync/actions/runs/37171478315)
passed 132 ordinary-user Windows commands and 129 commands on each POSIX target.
It tested head `190d80999de7db5a09f8c1d040749d7ce938e064` through PR merge checkout
`fac479785873a61db921e1149a1019d1de6de5b8`. Windows peer custody, exact parent DACL
restoration, recovery, concurrent apply, trust refusals and hard-link refusal
all passed. This precedes the isolated context-test correction described below.

[Native run 37172702425](https://github.com/snaraj/obsync/actions/runs/37172702425)
passed the same 132 Windows/129 POSIX journeys after that correction, at head
`a38c559911405f7bb415aa1d98d6380685eab5ad` through PR merge checkout
`37082d3a0c446ea9f974b83252fdc3b491ab4b31`. All 44 checks passed; only the expected
PR documentation deployment was skipped. Each native receipt matched its built
binary and manifest hashes. Independent recalculation matched all 420 samples,
first-five lists, warm p95 values and medians. Windows used QueryPerformanceCounter;
warm p95 help/schema/search were **6.3805 / 6.077 / 6.3791 ms**.

Local Linux used an ordinary user in a virtualized Ubuntu 24.04.5 ARM64 guest.
The Windows desktop check used an ordinary user in a software-emulated Windows
Server 2025 x64 evaluation guest. Its GNU cross-build is supplemental evidence;
it is not the MSVC release artifact. macOS package checks ran on native arm64.
All data was synthetic, outside the source checkout, with explicit paths and
unchanged production guards. Machine names, account identifiers, raw logs and
local configuration are excluded from this record.

| Candidate | Executable SHA-256 | Manifest SHA-256 |
| --- | --- | --- |
| Linux ARM64, byte-identical through `8ab05f1e44b22214cdb53f9b7347706bceffc3d2` | `d1e446a9b39ef0b7d5d33d970e3cef1fc8bf54ed44c02f8dea1a5fe815524171` | `8bf91f3430b0e4b927b30fc22721cbcfeda54c6b6a6d0d5d3eeceb755728a213` |
| Windows GNU at `8ab05f1e44b22214cdb53f9b7347706bceffc3d2` | `40c64f02c97eb8e9ac146599e1428f1d1fe29cc18cfe58c674ba390d59811656` | `95358bbfd666b85a66f43c45f550c9dcf080171e910862728f5f869977149560` |
| macOS ARM64, unchanged at `a5aece076cc948ea852be0db29c609591a1f69ef` | `55b56fa2e980531d6c49886a6594e42bebd416e3333535a0864a0aba48c2b46b` | Not retained for this checkpoint |

Later package documentation changes require fresh manifest verification; these
hashes identify historical candidates and are not a release download reference.

## Observations

| Scenario | Result and independent observation |
| --- | --- |
| V01 native package journey | PASS at the hosted checkpoint: exact five-file installs, two immutable destinations, uninstall and retained contexts on all four targets. Windows peer custody and Python OWNER RIGHTS refusal also passed. |
| V01 Linux visible/manual | PASS: 14 public invocations covered install, version/help, listing, planning, apply/replay, wrong-digest refusal, doctor, a second install and both uninstalls. The final independent file snapshot held revision 1, one context and one receipt; both installations were absent and configuration bytes unchanged. |
| V02 Windows visible/manual | PASS for version, readable context help and the missing-config refusal (exit 2). Help completed in 755 ms in the emulated guest. These observations do not establish its storage lifecycle. |
| V01 Windows emulated setup | FAIL: the unchanged 15-second setup deadline expired. Two separate trivial OS PowerShell launches took 22.511615 and 16.542277 seconds. Configuration and installation directories remained absent. The deadline was not raised. Native hosted success above is separate evidence. |
| V10 macOS strengthened journey | PASS twice for 129 commands on unchanged product code: initialized-config concurrent apply, exact replay, independently sealed revision 2/two receipts, body-before-seal recovery retaining revision 1, exact reapply, and hard-link refusal without changed bytes. This models interruption; it is not physical power loss. |
| V19 public installation | NOT_RUN before publication. Trusted source builds do not prove publisher identity, downloaded execution, public instructions or production delivery. |

The strengthened concurrency contract was fixed before execution: each of two
children may return only success or conflict (0/5), at least one must succeed,
and replay plus independent disk parsing must prove one application. The retained
run returned 0/5. Simultaneous first-use directory creation is not established.
The Windows peer check now first proves access through the fixture parent,
then tests the actual CLI-created subtree and unchanged sealed bytes. Its native
result belongs to the run of that revised harness, not the earlier checkpoint.

The Windows input path initially accepted keys without visible text in one
PowerShell console. An ordinary CMD console accepted input, followed by a nested
PowerShell session using its basic input mode. The precise input cause remains
unproven. The VM was then shut down gracefully and independently observed stopped.
This is an environment limitation, not a substituted successful setup result.

## Timing and reproduction

The Linux candidate used 35 fresh processes per discovery operation. The first
five were recorded separately; warm p95 used the remaining 30. OS caches were
not purged. Warm p95 help/schema/search were **0.546501 / 0.805418 / 0.759334 ms**;
the largest first-five value across them was **0.852585 ms**. These are candidate
process measurements, not download, network or server timings.

The Windows checkpoint above reported 0/15/16 ms samples from its coarse clock;
zero does not mean instantaneous execution. Subsequent journey timing uses
Python's highest-resolution performance counter and records the clock metadata
and all 35 samples so the fixed warm/cold checks can be independently recomputed.

`make check` at `a5aece076cc948ea852be0db29c609591a1f69ef` passed 872 Python
contracts, 1,975 plugin tests, 95.26% Rust line coverage and the then-current
122-command macOS journey. The subsequent journey extension adds native
concurrency/recovery/custody checks without changing product guards. Run:

```sh
cargo build --locked --release -p obsync-cli
python3 cli/check.py
```

The four-target workflow builds the correct native package and runs
`scripts/ci/cli-native.py`; Windows uses `scripts/ci/cli-windows-native.ps1`
for disposable ordinary users and effective peer access. It records exact
artifact hashes, raw discovery samples and independent state checks. Local
reusable fixtures and their README are ignored and retained outside the repo.

## Limits and retained failures

### CLI usability and completion repairs (2026-10-04)

PR #326 now includes default OS settings paths, terminal confirmation and
`context` aliases. The shared native journey verifies these through the installed
executable and independent file readback. Human pipes, explicit plans and machine
output stay read-only unless `--yes` explicitly requests a write. POSIX tests use
real pseudo-terminals, including mixed terminal/pipe streams, cancellation,
confirmation after a 5.1-second pause, and a competing change while confirmation
is open. The last case must refuse the stale revision and preserve both contexts.
The user's thinking time is excluded from execution time; plan expiry is unchanged.

A replacement package with a distinct verified manifest can reuse the same path
after uninstall. Tests require exact installed bytes and the same retained lock
inode. Malformed old bindings and unfinished installation/removal stages refuse
without changing their bytes. This is a two-step upgrade with an availability
gap, and the original verified package is still needed for uninstall. It does
not establish physical power-loss recovery across versions.

Twenty focused author mutations were caught: late-result replacement, helper
output classification and termination, delayed clean helper exit, ancestor ACL
validation, selection type, conflicting apply/plan flags, six confirmation
boundaries, and seven retained-binding guards. Positive controls passed first;
all mutated sources and build scratch were removed. These checks extend the
existing test suites and native jobs; no additional CI job was added.

A separate source-only fault fixture delayed output by 5.1 seconds after an
actual durable context apply. The repaired CLI returned completed/exit 0 with a
late warning at 5,472 ms. Restoring the old final timeout override returned
unknown/exit 7 at 5,476 ms despite the same committed result. A fresh process and
independent sealed-file parsing proved revision 1 and exactly one receipt for
both. The delay exists only in the disposable fixture.

On the same synthetic macOS context, seven samples per command measured median
list/plan/doctor startup at 367.40/373.05/361.81 ms before the repair and
232.31/232.91/231.56 ms afterward, using the final tested macOS binary
`c7a6e370a94cb327bed32eeddb6b4d3aefbfa2611cbbabc9abf871746f511dd3`.
At most two full ACL readers run concurrently;
every already-open ancestor still receives the native check. This is a local
comparison with ordinary OS caches, not a cross-platform performance guarantee.

The final full repair gate passed 1,975 plugin tests, 872 Python contracts,
94.70% Rust line coverage, both secret scans and 199 macOS package commands.
Replacement four-platform native receipts are required on the PR; historical
Windows/Linux acceptance above does not establish these newer cases.

### Earlier stored-state review

The independent review identified eight missing stored-state regression cases.
The shared native journey now uses valid sealed synthetic snapshots to require
maximum-revision refusal before any byte changes, and to prove that one expired
receipt releases capacity while all 63 live receipts survive unchanged. The new
receipt and replay are independently read back. Invalid receipt IDs, digests,
operations, names, current names and complete snapshot magic must each make both
doctor and recovery refuse without changing storage. The fixture restores its
original snapshots afterward and verifies them through the public CLI.

The expanded macOS journey passed **152 commands**. Removing each of these eight
guards made that same journey fail at its corresponding case, twice per guard;
all mutations and disposable builds were removed. Production code is unchanged.
The common fixture runs in the existing four-platform native jobs; acceptance of
these added cases on Windows and Linux requires their replacement native run.

- Public release provenance and installation, exact final native checks and
  independent adversarial approval are separate release gates.
- The emulated Windows storage journey did not complete; native Windows evidence
  comes from the hosted ordinary-user journey. No emulation performance promise
  follows from native success.
- Process interruption and constructed incomplete snapshots do not prove physical
  power-loss durability or every failing filesystem call. Source-unreachable,
  redundant and OS-fault-only guards are distinguished in the author audit.
- The earlier Windows first-install refusal was a fixture ACL mismatch. The
  repaired run proves Python OWNER RIGHTS refusal with unchanged ACL/content,
  then runs on an explicitly prepared account ACL. No production guard changed.
- [The subsequent Windows fixture failure](https://github.com/snaraj/obsync/actions/runs/37170130672/job/111341230565)
  occurred when restoring the peer check's parent DACL. A Windows VM reproduced
  first-write normalization from `D:P` to `D:PAI`, followed by exact restoration
  on the second cycle. Moving that first write before the baseline passed both
  cycles in the same VM. The fixture now performs that initial ACL write while
  empty, before its baseline, and retains full DACL equality. Completed journey
  output precedes the peer check; a separate failure event preserves its outcome
  if restoration also fails. The replacement native run above passed.
- [A later image-build failure](https://github.com/snaraj/obsync/actions/runs/37171478327/job/111345122284)
  returned `config_busy` in the context concurrency test before IPv6 deployment.
  A Linux control retained a duplicate of the fixture's locked file: initial
  apply succeeded, both contenders refused, and final replay reproduced the
  failure. Explicit fixture unlock passed 100 complete context-suite runs with
  that duplicate alive. The existing test now keeps this condition and reports
  its caller on failure. The original test also passed 100 unforced runs; the
  original CI scheduling is not established by this controlled reproduction.
  Product locking, refusal assertions and replay/state checks are unchanged.
- [The retained proxy build failure](https://github.com/snaraj/obsync/actions/runs/37166485128/job/111330328498)
  occurred in an unchanged plugin test before the proxy scenario. Two controlled
  held-save runs proved its read-log predicate precedes the rename request;
  [#327](https://github.com/snaraj/obsync/issues/327) tracks the test race.
- Authenticated management, MCP, export/open and live co-editing remain assigned
  to later agreed releases; these CLI checks make no acceptance claim for them.
