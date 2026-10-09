# Save-supersession recovery, 2026-10-07

At `eae65495c3b7b8e4ee242c39ee556c55656f8a6c`, an injected native save
superseded a real incoming write on both macOS and Android. Each host refused
that incoming version without advancing applied ancestry, earned a fresh
save receipt while input remained recent, and continued typing in the same
pane. Both editors and independent disk reads converged to the complete text,
one file and one server head. This directly exercises the path absent from
the [previous sustained runs](2026-10-06-review-repairs-117.md).

## What changed and how to reproduce the regression

Reload release now names three outcomes: confirmed, superseded, and unconfirmed.
A superseded write invalidates the old save receipt and schedules another
public save/read. It does not demote the pane to native-only ownership.
Unconfirmed reloads still do, and supersession cannot lift an earlier native-only
decision. Composition, rebinding, generation changes and stopped sessions keep
their existing guards. The structured release line names the outcome.

The retained native-host regressions inject a replacement save on desktop and
mobile, with active/passive panes and identical-size/grown content. All eight
failed against the previous implementation. The repaired tests require old
applied ancestry, no false echo receipt, continued bridge eligibility, a new
receipt during recent input, and successful publication/remerge. Additional
controls cover genuine public-save failures and stale/rebound releases.

```sh
npm --prefix plugin run build
node --test --test-reporter=tap plugin/test/nativehost.test.mjs \
  plugin/test/editor-activity.test.mjs
```

This focused baseline passes 159 tests. M4121–M4127 respectively restore the
demotion, drop mobile classification, drop desktop classification, retain the
obsolete receipt, misclassify readback replacement, or overclassify a genuine
mobile/desktop save failure. All compiled and failed assertions, with zero
cancellations; focused failure counts were 10, 4, 4, 1, 5, 1 and 1.
M4117–M4120 were rechecked against the changed interface: 2, 11, 12 and 2
focused failures. The whole-suite mutation runner remains available:

```sh
plugin/test/mutants/run.sh plugin/test/mutants/M4121.diff
```

Its whole-suite counts need not equal those of the focused command above.
Sources were restored and rebuilt after the matrix. The full local `make check`
passed: 2,123 plugin tests, 873 contracts, 83 dashboard tests, Rust/CLI/chart
checks, both secret scans and 94.72% Rust line coverage.

## Native scenario and artifact binding

The disposable pair used macOS 27.0 arm64 / Obsidian 1.13.4 and Android 17
arm64 / official Obsidian 1.14.4. Android used image revision 6, API 37,
build CP41.260831.007, 16 KiB pages, WebView 149.0.7827.5 and software
rendering. Desktop used an isolated profile with a mock keychain; this does
not prove desktop OS credential custody. Android is an emulator, not a
physical-phone substitute.

Installed `main.js` SHA-256 is
`bfc0092d8b3ae70f77c889fe49dc03e797b2a9a709bfe79187a2165f783371ca`;
manifest is `aae46364e30769a65b56cba53c65a89f104cd1cf5d5c5d6978bbedb3afb9eb42`;
styles are `796f28c630774dc80e00b8ba4c0d3811d524b1cd844fe36d0f9597c5ee0e82ce`.
Android independently read back all three installed files. Server SHA-256 is
`7c05a4bb731d85fb50c81db7bd2c8888df85fb89e2a63c8710126a545d7d8534`.
The temporary authenticated account used E2EE, durable writes, normal certificate
checks and an API-only TLS relay. No security protection was disabled.

Before installing the plugin, a native control accepted 130 trusted characters,
zero untrusted events, and matched editor/disk bytes. Pairing compared both
renderers independently and confirmed key retention. Ordinary transfers passed
in both directions (663 ms desktop to Android, 1,450 ms Android to desktop).
These are single observations, not a comparative speed claim.

The collision probe runs once per receiving host:

1. Create a synthetic note with separate writer lines and sync both peers.
2. Type on the target and confirm a normal save receipt.
3. Hold the real incoming-write readback boundary after any pending bridge
   saves; type on the peer to reach that boundary.
4. Type locally in the target's existing pane and call its public save.
   Confirm its actual disk bytes match the editor, then release the boundary.
5. Observe the real supersession refusal, unchanged applied ancestry and a
   fresh save receipt while input is still recent. No exception is synthesized.
6. Continue 20 inputs per writer in the same panes, with each caret placed
   once for that continuation; require exact editor/disk text, one file/head.

Both scenarios passed all 43 trusted inputs (three setup/collision inputs plus
40 continuation inputs), with zero untrusted events. The controller observed
readiness 43 ms after desktop's native save and 263 ms after Android's;
these are functional fault-injection observations, not latency benchmarks.
One original file remained in each case, with zero additional conflict copies.
All temporary wrappers were restored on exit.

## Sustained typing and lifecycle

The unchanged 180-second co-typing command accepted 449 trusted tokens per
peer, 898 total, with no untrusted input. Both editors and independent disk
reads retained every token once in writer order and both fixed lines. There
were no conflict copies or native overwrite warnings; each peer showed one
normal combined-edits notice. A later authenticated read, after app restart,
confirmed one server head for this note and both collision notes.

**The command still failed its 1,500 ms visibility diagnostic.** The event
oracle observed 18 of 446 eligible tokens overdue on desktop (maximum
2,180.6 ms), and 11 of 446 on Android (maximum 2,465.2 ms). Missing observations
also count as failures. Trusted input and receiving-editor DOM mutations used
controller-aligned renderer clocks with additive round-trip uncertainty.
The run held the shared exclusive timing lease and recorded host load;
absence of nonparticipating background load is not established. A public-relay
run is not a paired speed comparison. This unresolved diagnostic remains under
#325; no threshold or release scope was changed.

The two long-note captures were opened. Both were scrolled beyond the heading;
desktop showed later A tokens and Android mainly the fixed lines. Those partial
views cannot visually prove all tokens or caret behavior. Complete-content
proof comes from the independent editor/disk oracle.

Background/foreground and actual process termination/relaunch retained pairing.
Typed transfers then passed in both directions: 769/957 ms after backgrounding,
982/936 ms after restart. An offline edit remained on disk and resumed
automatically 1,604 ms after reconnection. Leave completed in 3,274 ms: server
revocation was verified, enrollment/endpoint/file metadata were forgotten,
and all 11 local synthetic notes retained their hashes. Lifecycle captures
show matching text, offline-to-green status and the unpaired settings state.

The four settled captures were opened individually. Both streams, WARM/LOCAL/
PEER markers, and tokens 001–020 are visible and ordered. Green status checks
are visible. Android's final caret is at M020; the desktop peer's is at A020.
These settled images do not establish physical-keyboard ergonomics.

| Injected host | Desktop | Android |
| --- | --- | --- |
| Desktop | [Capture](../assets/pane-recovery-117/supersession-A-A.png) | [Capture](../assets/pane-recovery-117/supersession-A-M.png) |
| Android | [Capture](../assets/pane-recovery-117/supersession-M-A.png) | [Capture](../assets/pane-recovery-117/supersession-M-M.png) |

## Hosted native Windows

[Desktop run 37580196035](https://github.com/snaraj/obsync/actions/runs/37580196035)
passed Windows, macOS and both Linux keyring modes. All six Windows PNGs were
opened: both token streams and unchanged lines matched, as did both restart
notes, with green plugin status. Their receipts bind merge checkout
`2c8c5e732a62b7814fa3f7aa3414be8f7218ac8d`, whose parents are protected base
`72bdcf94ed40fc8769c8baad5a6b2db56ae92cfe` and the candidate above. The full
head completed 44 passing checks and the expected PR deployment skip.

The pre-existing Linux executable-fixture race is tracked separately in #338;
no execution retry or package-fixture change enters this repair.

## Cleanup and remaining boundary

Both owned controllers exited zero. Cleanup receipts and direct absence checks
confirm zero owned process groups and removal of the relays, runtime profiles,
private account/vault data, live manifests and copied inputs. Open-file checks
preceded removal of 10,342,341,073 logical bytes of owned downloaded/extracted
inputs and hash-verified preflight copies, including the exact temporary SDK
image link. Shared SDK and Java remain. Frozen recipes, reduced receipts and
synthetic captures remain; the four collision captures are linked above.
All 23 native journey captures, three onboarding/control captures and six
hosted Windows captures were opened individually.

Physical-iPhone current-byte acceptance and earlier on-device fixture cleanup
remain unproved. A fresh supported-control call again failed with
`Sky Computer Use native pipe startup failed` before app discovery. It gives no
evidence of the phone's lock state. These results support delta review of the
repair; they do not establish complete release acceptance or authorize Ready.
