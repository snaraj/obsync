# Continuous input and display confirmation, 2026-10-07

Continued input immediately before a delivered remote addition can make a
second three-way merge repeat that addition. The previous display check then
waits its full second and demotes the pane to native save ownership. This
explains a reproducible route from successful remote delivery to idle-dependent
saving; it does not establish the cause of every native latency outlier.

The retained desktop and mobile regressions deliver `B: remote`, then type
`local ` immediately before `remote` during the public save completion. Both
failed before the repair. Confirmation now recognizes a completed insertion-only
transition on the original pane/file bindings when all delivered characters
remain in order and with their original multiplicity. The existing fallback
still checks deletions, replacements, partial delivery, missing characters and
replacement panes. A structured, content-free line records use of the new
confirmation path. Authentication, encryption, durable writes and transport
are unchanged.

## Deterministic evidence

```sh
npm --prefix plugin run build
node --test --test-reporter=tap \
  --test-name-pattern='typing before a delivered remote addition|incomplete display|partial public bridge|replacement pane|failed public refresh|repeated delivered characters' \
  plugin/test/nativehost.test.mjs
```

The focused baseline has 14 cases. The new positive cases require the next
keystroke to obtain a public save receipt, matching disk bytes and editor
readiness while input remains recent. Negative cases retain refusal of missing
remote text, deleted remote text still displayed, incomplete composition/save,
repeated-character loss and a replacement pane borrowing another pane's receipt.

| Retained mutant | Removed proof | Focused assertion failures |
| --- | --- | ---: |
| M4128 | Completed insertion receipt | 2 |
| M4129 | Incoming transition contains only insertions | 2 |
| M4130 | Delivered text remains intact | 4 |
| M4131 | Every pane began its public save | 1 |
| M4132 | Original pane and file bindings | 2 |
| M4133 | Every delivered code point is present | 6 |
| M4134 | Repeated characters retain multiplicity | 2 |
| M4135 | Structured confirmation diagnostic | 2 |

All eight patches applied exactly, compiled, and failed assertions with zero
cancellations; source bytes were restored and rebuilt. Counts are from the
focused command above. `plugin/test/mutants/run.sh` runs the whole suite and
can produce different failure counts.

The complete `nativehost` and `editor-activity` suites pass 171/171. The full
local `make check` passes: 2,135 plugin tests, 873 contracts, 83 dashboard
tests, Rust/CLI/chart checks, both secret scans and 94.72% Rust line coverage.
The first sandboxed invocation refused the fixed macOS custody helper before
the CLI context cases could run; the native invocation passed without changing
that helper or its guards. The rebuilt plugin SHA-256 is
`aa20632e75d110639ae656f0a3e98a2bdc06158740136f71e77e18466a13f44e`.

## Native evidence that motivated this repair

The preceding candidate `8d3376c1edfcf44077e33100856b2644e79402be` was exercised
in disposable macOS 27 arm64 / Obsidian 1.13.4 and Android 17 arm64 / Obsidian
1.14.4 profiles. Android used API 37, image revision 6, 16 KiB pages,
WebView 149.0.7827.5 and software rendering. E2EE, authentication, certificate
validation and durable writes remained enabled over a temporary TLS relay.

A 60-second, 100 ms-cadence run received remote input during typing but failed
the unchanged 1,500 ms diagnostic on both peers. A separate diagnostic with
temporary ciphertext reuse also failed; it earns no cache or speed claim.
That diagnostic recorded a real `editor_reload_unconfirmed` followed by
`reload_released outcome=unconfirmed` on Android, cessation of fast saves,
and final settling about 10.2 seconds after input stopped. The deterministic
regression above isolates one cause of that class of failure.

A short-paragraph test independently examined actual DOM text ranges inside
the editor scroller and viewport. During-input captures visibly showed only
each device's own stream; neither live buffer converged within the subsequent
30-second deadline. This is a failure, regardless of earlier long-note buffer
or final-file equality. Native input itself stalled during this run. A later
plugin-disabled control retained all 500 expected file bytes but failed its
combined control assertion; it did not isolate the failing component.
Guest compositor/kernel load was high. These observations require separating
fixture input/rendering delays from product sync delays.

The visual acceptance oracle now requires both writers to remain active when
remote text becomes visible, records each input acknowledgment independently,
and treats missing eligible observations as failures. Opening the captures and
checking independent file bytes remain separate requirements.

The old campaign's Android and relay controllers exited zero; owned processes,
runtime profiles, private account data and live manifests were removed. Shared
tooling was preserved. Physical-iPhone current-byte acceptance remains unproved:
supported native control failed at pipe startup before app discovery, without
evidence about the phone's lock state. This record alone does not clear native
acceptance or authorize Ready.

## Reconciliation request boundary

The character-by-character native diagnostic found repeated head requests
between the push engine and the pull resolver. `reconcileFile` already has
both heads and their graph, but the resolver fetched the same file again.
A peer typing continuously can advance during that extra round trip, making
the selected version obsolete before it can be shown.

The caller now passes its current request's snapshot. Reuse is limited to the
same file/domain, an incoming head present in the graph, and the locally held
version also present. No cross-call mutable-head cache is introduced. The
ordinary fresh read handles missing inputs or a newer local receipt.

```sh
npm --prefix plugin run build
node --test plugin/test/reconcile-snapshot.test.mjs \
  plugin/test/cotyping.test.mjs plugin/test/editor-retry.test.mjs
```

The focused baseline passes 78 tests. Eight new cases include one head request
for push reconciliation instead of two, zero extra requests with a supplied
current snapshot, five refusals of unrelated/incomplete snapshots, and a peer
advancing after the snapshot whose newer text survives the next merge with
one head and no copy. The previous implementation fails three of these eight
cases. This proves request removal and merge behavior, not a native latency
improvement; the updated bundle still requires live comparison.

Retained mutants M4136–M4142 remove, respectively, the engine's snapshot
forwarding, the pull forwarding, file binding, domain binding, head membership,
incoming-record membership and local-record membership. All seven patches
apply exactly and compile. The eight-case focused suite kills them with
1, 3, 1, 1, 1, 1 and 1 assertion failures, zero cancellations. Sources are
restored byte-for-byte and rebuilt afterwards.

The full local `make check` passes after this repair: 2,143 plugin tests,
873 contract tests and 94.72% Rust line coverage. Both filesystem and history
secret scans report no leaks. Native timing remains a separate acceptance gate.

## Saving during network preparation

The request-reuse bundle still failed the 1,500 ms continuous-character
visibility budget on desktop and Android. Both final live editors and disk
reads agreed, with one head. During shared typing, desktop received 143
eligible characters (22 late, none missing; median 976.1 ms, p95 1,848.2 ms,
maximum 2,302.1 ms). Android received 145 (65 late including 14 unseen before
both writers stopped; observed median 1,321.5 ms, p95 3,473.8 ms, maximum
4,203.4 ms). These are one-run diagnostics, not a paired speed claim.

Further isolation found that an early editor-readiness check could abandon
the reserved publication turn even though preparation reads only authenticated
parent content. The check belongs after network preparation, when the current
local delta is read. If still busy, the original defer/hold decision applies.
The final host writer still independently checks all editors and disk before
committing. No unsaved editor is granted write permission, and unpublished
input remains outside the parent merge.

The new completion regression fails before this repair: a native save
completing during download must merge without restarting. Its control keeps
a save pending and requires deferral without changing local bytes, recorded
ancestry or the upload queue.
An initial attempt failed six existing rewrite/overlap cases by bypassing
their defer/hold decision. Moving the existing check after preparation
preserves that policy; all 54 rebase/overlap/budget cases and the targeted
stamper regression pass. The budget test keeps the exact three initial
refusals and separately pins two subsequent typing-lane retry refusals, with
all reservations refunded and no copies. M4143 restores the early check
and fails three assertions across the 24 rebase/budget cases;
M4144 removes the final readiness check and fails one. Both compile, neither
cancels a test, and sources are restored byte-for-byte after mutation.

Accounting correction: commit a1419d0 contains +212/-5, as reported by
`git show --numstat a1419d0`; its message mistakenly says +222/-5.

The corrected full `make check` passes: 2,145 plugin tests, 873 contract
tests, 83 dashboard tests, 94.72% Rust line coverage and both secret scans.
This remains pre-native evidence for this preparation change.

## Native save completion

The preparation repair was installed from clean commit `bb34650` on both
native peers, with independent bundle readback. The fresh Android control
accepted all 130 trusted characters with matching editor and disk bytes before
the plugin was installed. Pairing then completed with independent comparison
and the creator's key-kept acknowledgment.

The shared 16,354 ms typing window contained 200 individual trusted characters
per writer. Both live editors and independent disk reads ended identical with
one head. All four during/final captures were inspected: each screen showed
the other's partial stream during typing and both complete streams afterwards,
with the caret at its own stream's end. Each during capture had one combined
notice. The unchanged 1,500 ms visibility budget still failed: desktop had
22/137 late eligible characters (median 1,008.3 ms, p95 2,076.3 ms, maximum
2,861.2 ms); Android had 76/145 (median 1,528.3 ms, p95 4,179.7 ms, maximum
4,993.8 ms). Neither receiver had an eligible character unseen before both
writers stopped. These are public-relay diagnostics, not paired speed claims.

Read-only tracing then found Android refusing 33/60 preliminary readiness
checks: 17 during saves, nine before a matching receipt, and seven when input
changed across a read. Eight final checks passed and one refused. A temporary
save-completion diagnostic reduced repeated preparation attempts but did not
pass the visibility budget. Ciphertext reuse and a combined disk-read
experiment also failed that budget; neither is shipped.

Readiness now joins an already scheduled or running native save for at most
100 ms, then repeats the ordinary disk/editor proof. It starts no new save and
performs no readiness polling. Stop wakes waiters immediately. Completion,
timeout and stop remove their waiter and timer; disabled sync, composition,
reload ownership, changed panes/files and absent saves cannot gain readiness
from waiting. The final writer's independent proof remains unchanged.

The focused editor-activity/native-host tests cover both queued and in-flight
saves, bounded continuous input, failed or mismatched saves, pane changes,
composition, stop and simultaneous waiters. The superseded-write test still
requires immediate refusal before any later native save; the host's new wait
is exercised separately. The timeout test pins the original deadline and
asserts completion before awaiting its result, so a broken simulated timer
fails explicitly rather than hanging. This section does not claim native
acceptance of the save-completion repair.

Retained mutants M4145–M4158 compile and fail assertions in the 21-case
focused boundary suite, with zero cancellations. Their failure counts are
2, 4, 6, 3, 1, 1, 1, 1, 16, 4, 1, 3, 2 and 3 respectively. Sources are
restored byte-for-byte and rebuilt after the audit.

The save-completion candidate passes the full local `make check`: 2,166
plugin tests, 873 contract tests, 83 dashboard tests, 94.72% Rust line coverage
and both secret scans. Native acceptance is still outstanding for these bytes.


## Paired native save-completion results

Five alternating baseline/candidate pairs compare clean `bb346509` with
`1b871587`. Each installed bundle was independently read back before its run.
The same native macOS 27 arm64 / Obsidian 1.13.4 and Android 17 arm64 /
Obsidian 1.14.4 clients typed 200 individually delivered trusted characters
per writer at 80 ms cadence for about 16.3 seconds. The receiving oracle
records text ranges actually inside the editor viewport during the shared
input window. Final live-editor and independent disk equality, one file and
one head pass in every run. All 40 during/final screenshots were opened.
The during frames show the other writer advancing while the local caret is
still at the growing stream; the final frames show both complete streams.
Final screenshots alone do not establish cursor position on every mobile frame.

Android used the current API 37 revision-6 image with 16 KiB pages,
WebView 149.0.7827.5, a Pixel 8 profile, two requested cores and 2 GiB requested
memory, with software graphics. A disposable local TLS terminator preserved
certificate/hostname validation, authenticated requests, E2EE and durable
server writes. Native requests rejected the untrusted certificate before
installing a run-only emulator CA, accepted the matching endpoint afterwards,
and still rejected a hostname mismatch. The desktop used a loopback HTTP
control. This establishes Android local-TLS behavior, not desktop TLS, LAN,
physical-phone or production-infrastructure acceptance.

| Pair | Bundle | Desktop p50 / p95 / max (ms) | Android p50 / p95 / max (ms) | Late desktop / Android |
| --- | --- | --- | --- | --- |
| 1 | baseline | 383.7 / 1085.8 / 1630.4 | 800.7 / 2261.4 / 2888.6 | 2 / 28 |
| 1 | candidate | 453.6 / 1028.6 / 1199.9 | 559.0 / 1219.1 / 1447.8 | 0 / 0 |
| 2 | baseline | 340.8 / 765.8 / 969.0 | 644.6 / 1691.2 / 2321.1 | 0 / 13 |
| 2 | candidate | 422.2 / 765.8 / 971.7 | 523.0 / 1133.2 / 1461.8 | 0 / 0 |
| 3 | baseline | 402.5 / 850.3 / 1107.3 | 849.4 / 2298.7 / 2869.0 | 0 / 27 |
| 3 | candidate | 503.8 / 1190.0 / 1600.6 | 577.8 / 1294.6 / 1872.1 | 3 / 4 |
| 4 | baseline | 441.3 / 1014.4 / 1390.1 | 1067.2 / 3342.3 / 3706.4 | 0 / 52 |
| 4 | candidate | 374.8 / 908.7 / 1338.7 | 518.1 / 1004.4 / 1259.7 | 0 / 0 |
| 5 | baseline | 416.6 / 1037.8 / 1582.2 | 710.6 / 1600.5 / 2181.3 | 1 / 11 |
| 5 | candidate | 418.3 / 803.0 / 1133.0 | 551.9 / 1230.4 / 1805.4 | 0 / 3 |

Three of five candidate runs satisfy the unchanged 1,500 ms visibility
budget on both screens; all five baselines fail. Android late eligible
characters decrease from 131/725 to 7/725. No eligible character is missing
before shared typing ends. Desktop has three late characters in each variant.
These failures remain acceptance failures.

For paired per-run p50, baseline-minus-candidate has mean 268.5 ms on Android
(95% bootstrap interval 159.0–409.5 ms). For paired p95 the reduction is
1,062.5 ms (542.1–1,715.2 ms). Both intervals exclude zero. Desktop intervals
include zero: p50 difference -37.6 ms (-87.1–23.3), p95 difference 11.6 ms
(-180.9–162.0); no desktop speed gain is claimed. Calculations use 10,000
resamples of the five pairs with replacement, seed 117. Reproduce from the
rounded table by subtracting candidate from baseline in each pair, resampling
five such differences, and taking the mean and 2.5/97.5 percentiles. Original
unrounded event receipts and the analysis script remain with the private lab
record. The whole comparison held one expiring exclusive timing lease and
retained aggregate host-load samples; the lease cannot prove an absence of
nonparticipating host load. The full repository gate did not overlap these runs.

Single-run diagnostics on the same candidate do not add paired claims:
public-relay visibility still failed; local read-only host tracing passed;
an explicitly enabled bounded ciphertext-reuse experiment failed on six
Android events, and a 200 ms publication-interval experiment failed on six
desktop events. Neither experiment ships. An earlier run named for ciphertext
reuse actually had zero hits, misses and seeded entries: it is a baseline
repeat, not cache evidence. The runner now records its explicit selection;
a label alone never establishes which experiment executed.

Background/resume, actual Android process restart, public-TLS offline/reconnect
and Leave passed on `1b871587`. Background propagation was 514/456 ms and
restart propagation 427/434 ms (desktop-to-Android / reverse). Offline transport
refusal was observed before typing, local bytes were saved, and automatic
reconnect delivered the text in 1,673 ms. Independent bytes and live editors
agreed. Leave revoked the device, cleared its server/device enrollment and
file records, and preserved all 22 local notes. All 12 recovery/Leave captures
were opened. Both controllers exited zero; independent inspection found all
four owned child PIDs, runtime/private directories and live manifests absent.
The TLS sidecar exited zero with its listener and private keys absent. Destroying
the disposable emulator removed its temporary CA and mounts.

Physical-iPhone current-byte acceptance remains unproved. Native control now
reaches an explicit Mac Touch ID/login prompt in iPhone Mirroring; the old
native-control startup failure is no longer the current diagnosis.

## Descendant snapshot reuse

A direct descendant arriving over an unpublished local edit formerly repeated
the head-graph request even when its caller already supplied the matching
snapshot. Both reconciliation branches now share one call-local validation:
file, domain, current incoming head and both version records must match.
Absent or mismatched evidence still performs the fresh authenticated read.
There is no retained mutable-head cache and no editor or durability guard changes.

The 14 snapshot tests pass; restoring the previous product code fails the new
positive descendant case on its extra request. The case preserves unpublished
local bytes, publishes them normally, then proves both authors' text, one head
and no extra file. Five negative descendant cases require the fresh read.
M4136–M4142 and M4159 all compile and fail assertions, with respectively
1, 4, 2, 2, 2, 2, 2 and 1 failures and zero cancellations. The five moved
validation mutants were regenerated against the shared helper. Sources were
restored byte-for-byte and rebuilt. Reproduce the focused baseline with
`cd plugin && npm run build && node --test test/reconcile-snapshot.test.mjs`;
run each retained patch with `plugin/test/mutants/run.sh` for the whole suite.
The paired native figures above precede this additional optimization and are
not a speed claim or native acceptance of the newer bytes.

The descendant change passes the full local `make check`: 2,172 plugin tests,
873 contracts, 83 dashboard tests, 94.72% Rust line coverage and both secret
scans; zero failures. The gate completed in 419.62 seconds.
