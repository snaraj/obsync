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


## Descendant comparison and native retry diagnosis

Five alternating comparisons of `1b871587` and `45e8444` used the same
individual-character input, visible-range oracle and 1500 ms budget as above.
The descendant optimization passed 2/5 complete trials; the baseline passed
1/5. All ten trials retained exact independent disk/editor bytes and one head.
All forty during/final screenshots were inspected: both streams advanced
while typing continued. This is not consistent latency acceptance.

The paired mean improvement and 95% bootstrap interval (ms, unrounded inputs,
10000 resamples, seed117; positive means faster) were:

| Destination | p50 improvement [95% interval] | p95 improvement [95% interval] |
| --- | --- | --- |
| Desktop | 4.66 [-37.38, 49.74] | 38.92 [-9.40, 94.40] |
| Android | 8.78 [-37.54, 55.10] | 98.10 [-31.02, 195.58] |

Every interval includes zero. The optimization removes a proven redundant
request, but this experiment does not establish a user-visible speed gain.
Reproduction: the private `paired-descendant.py` runner and
`paired-descendant-analysis.json`, with the same bootstrap procedure above.
The Android leg used validated local TLS; the desktop was the loopback HTTP
control. These are not public-network or physical-phone latency claims.

Additional bounded diagnostics retained their failures. Increasing native save
batching from 5 to100 ms failed the visible deadline. Notifying publication for
every completed historical save snapshot passed one initial trial, then only
1/5 paired trials against 2/5 baseline; that instrumentation is not shipped.
Native phase observation found Android adapter read/write tails of several
hundred milliseconds, while `getFile` p95/max were53.8/78.5 ms in that trace.
Concurrent durations overlap and cannot be added as exclusive causal shares.

A further read-only trace wrapped real `applyPage`, `receive` and `retryOne`
calls. It recorded multiple retries of the same parked file inside one page:

| Changes / distinct files | Page time (ms) | Retries | Time within those retries (ms) |
| --- | --- | --- | --- |
| 6 / 1 | 785.9 | 2 | 553.9 |
| 4 / 1 | 631.4 | 2 | 596.3 |
| 8 / 1 | 508.2 | 2 | 465.3 |
| 2 / 1 | 492.1 | 2 | 465.6 |

Reproduce these aggregates with the private `summarize-page-retries.py` over
its preserved visible-proof receipt. Instrumentation forwards every original
argument/result, captures no note content in phase rows, and restores wrappers
in `finally`. This identifies repeated work, not the full cause of every tail.

The resulting engine change applies every feed record in order but retries a
parked file only after its last record in that page. The retry still checks
native editor readiness and fetches current server heads. A newly refused
record keeps its durable wait and scheduled retry. Nothing changes encryption,
authentication, integrity checks or durable writes. One aggregate diagnostic
records the retries coalesced, without note paths or content.

The real-engine backlog reproduction fails on the old behavior with six
retries. The corrected behavior retries once at the final own echo, receives
an interleaved other note, retains unsaved local content and the durable wait,
and converges both branches automatically once the editor is ready. A second
case proves a newly refused record is not immediately retried. The30 focused
editor/parked tests pass. Mutants M4160–M4164 respectively retry every record,
never retry, retry a fresh refusal, retry an unparked file, or retry at the
first record; all compile and fail assertions (1,2,4,2,1), zero cancellations.
This code still requires its own immutable-bundle native comparison.

The completed diagnostic fixture left through native Settings: server
revocation proved, all25 local notes unchanged, device identity/server metadata
cleared. The Settings screenshot shows not paired and blank connection fields.
Both parent controllers and the TLS sidecar exited0; independent checks proved
four child PIDs absent, the TLS listener and keys absent, and both private,
runtime and manifest paths absent. All97 peer evidence screenshots were opened
and hashed. No physical-iPhone acceptance is inferred from these emulator runs.

The page-retry full local `make check` passed in431.12 s:2174 plugin tests,
873 contracts, 83 dashboard tests, Rust line coverage94.72%, both secret scans
clean. Native acceptance for the new bundle remains a separate requirement.


## Page retry comparison and the native save boundary

Five alternating immutable-bundle comparisons of `45e8444` and `2b8e4a5`
used the unchanged individual-character, during-overlap 1500 ms oracle. Each
bundle passed only 1/5 trials. All ten retained exact independent editor/disk
bytes and one head. All forty screenshots were opened. The paired mean
improvement and 95% bootstrap interval were (ms; positive means faster):

| Destination | p50 improvement [95% interval] | p95 improvement [95% interval] |
| --- | --- | --- |
| Desktop | 0.69 [-19.99, 24.97] | 161.98 [-86.00, 539.82] |
| Android | 20.96 [-17.70, 59.62] | -9.92 [-316.40, 271.56] |

Reproduce with private `paired-page-retry.py` and
`analyze-native-pairs.py` over its ten retained receipts, 10000 resamples,
seed117. These results establish neither a latency gain nor acceptance.
The comparison retains the same local TLS Android and loopback desktop
limitations as the preceding campaign.

A diagnostic-only publication interval of250 ms passed2/5 trials against
1/5 with the shipped100 ms interval. Both desktop p50 and p95 became slower
(paired improvement -24.72 ms [-42.20,-7.24] and -214.26 ms
[-325.78,-117.12]). Android intervals included zero. All ten final states
were exact and their forty screenshots were inspected. This experiment is
rejected; the publication interval is unchanged. Reproduce with private
`paired-publication.py` and the same analysis procedure.

A read-only phase trace on `2b8e4a5` passed one trial and its four screenshots
show both streams arriving while typing continues. Android native adapter
read, write and stat tails reached347.6,232.3 and420.6 ms respectively;
`getFile` p95/max were48.8/90.3 ms. The slowest changes page took985.2 ms,
including a780 ms editor merge around a native adapter stall. These durations
overlap. They cannot be summed as independent shares of latency.

The trace also shows two successive native readiness probes during one
authenticated merge preparation. The correction joins a pending native save
once when selecting the saved-editor path. Without a saved receipt, ordinary
reconciliation still classifies unpublished overlaps and automatic rewrite
holds. A busy editor with an existing receipt remains deferred. The final
writer independently checks current bytes, editor identity, input generation
and composition. Encryption, authentication, parent validation and durable
writes are unchanged.

The first attempt instead parked every busy editor. The full gate rejected
that version with six rewrite/overlap/stamper failures (2169/2175 tests).
Those unchanged tests control the repair: the revised path preserves the
ordinary fallback. Failed evidence is retained; that first version is not
shipped. The one-readiness regression fails the prior implementation with two
checks instead of one. The unsaved-receipt, changed-disk and changed-parent
cases continue to refuse without advancing ancestry. M4165 restores the
second probe; M4166 removes the remaining probe; M4167 falls through for a
busy editor with a receipt; M4168 removes ordinary overlap classification.
Native acceptance for this correction is pending.

Focused reproduction: `cd plugin && npm run build && node --test
test/editor-rebase.test.mjs test/merge-budget.test.mjs
test/rewrite-overlap.test.mjs` (55 passing). Each retained M4165–M4168
compiles and fails at runtime; sources are restored and rebuilt after every
mutation. Full-gate and native results must bind the revised bytes.


### Native renderer isolation and sustained same-line regression

The revised one-readiness implementation passed the full local gate: 2175
plugin tests, 873 contracts, 83 dashboard tests, Rust line coverage 94.72%,
and both secret scans (`make check`, 436.66s). Five alternating native pairs
against the preceding page-retry bundle passed 1/5 on each side of the
comparison; all ten retained exact final bytes and one head. The paired
baseline-minus-candidate mean p50 improvement was 41.66 ms on desktop
(95% bootstrap interval 8.41–74.83) and 48.72 ms on Android (17.76–80.32).
The p95 intervals included zero; no tail-latency gain is established.
Reproduce with the private `compare-native-bundles.py` and
`analyze-native-pairs.py` recipes, 10000 resamples, seed 117. All forty images
were opened. Public-TLS background, restart and offline recovery passed,
followed by native Leave preserving 39 synthetic notes. Controller exit and
independent process, listener and filesystem checks confirmed teardown.

On a fresh Android 17/API 37.2 arm64 16 KiB emulator using host graphics,
the **same** bundle then passed all five fully-visible individual-character
trials: desktop 721 and Android 725 eligible observations, none over 1500 ms
or unseen. The largest repeat delays were 569.60 and 869.20 ms respectively.
Both streams appeared during simultaneous typing; twenty screenshots were
opened. A separate instrumented trial's largest delays were 664.60/785.40 ms.
Only the owned emulator process was sampled for CPU: p50/p95/max
135.45/157.8/165.3%, compared with 619.9/699.5/740.6% for the preceding
software-renderer trace. The profile and graphics mode both changed: this
is a rendering-overhead lead, not a paired attribution of every older stall.
The local run-CA TLS, desktop loopback and mock desktop-keychain limitations
remain; certificate rejection and hostname checks stayed enabled.

The added 60-second **same-line** diagnostic failed on those bytes despite
299 trusted five-character tokens per writer. The merge-loop breaker fired
while input continued, creating conflict copies. Independent disk bytes
finally matched, but the shared note failed exact token preservation and
per-writer order. Four screenshots were opened, including visible conflict
copies and an Android conflict notice. The long heading did not fit the
viewport; this diagnostic's buffer/DOM observations are not the stricter
fully-visible individual-character oracle. Its failure is retained and does
not become acceptance because the short separate-line trials passed.

The repair records an opaque trusted `beforeinput` identity on the native
file object. Reconciliation consumes each identity once at entry, preserving
input that arrives during a merge for the next reconciliation. A merge's
final disk stamp can include a newer native save; that previously hid the
intervening typing from the disk-stamp-only breaker. Repeated reads of one
identity, saves, reloads, cursor keys and composition bookkeeping cannot
exempt a loop. The optional host capability returns no content, key or time,
is never persisted or sent, and grants no write permission. Disabled scope,
closed/rebound views and stopped lifecycle cannot supply an identity.

Focused reproduction: `cd plugin && npm run build && node --test
 test/editor-activity.test.mjs test/cotyping.test.mjs
 test/merge-budget.test.mjs test/editor-rebase.test.mjs` (155 passing), then
`node --test test/editor-input.test.mjs` (8 passing). The retained
M4169–M4175 patches each compile and fail a runtime assertion with zero
cancellations: no reset, repeated exemption of one input, non-text events,
disabled scope, stopped lifecycle, missing native-host wiring and a token
that never advances. The original no-input loop control still trips at six.
These are author checks; new-bundle native acceptance remains pending.


The long run's later Android feed retry was a separate private-harness fault:
the local TLS proxy allowed 40 seconds for a 55-second changes poll. The host
could retry the closed request with its original signed nonce, which the
server correctly refused. The next fixture permits 70 seconds upstream and
75 seconds downstream; no product replay protection changes. This occurred
after the initial merge-loop refusal and does not excuse that failure.

The first full-gate attempt for the trusted-input repair failed in the
instrumented CLI suite. Its coverage wrapper discarded stdout, so the failed
assertion is unknown. A direct instrumented CLI diagnostic passed 13/13;
three subsequent instrumented whole-workspace diagnostics passed. These do
not retroactively clear the original failure. `coverage.sh` now retains test
stdout so a recurrence identifies its failing assertion. No retry or ignored
exit is added to the gate.


The replacement full local gate passed in 420.32s: 2,183 plugin tests,
873 contracts, 83 dashboard tests, 94.72% Rust line coverage and both secret
scans. The original instrumented CLI failure remains unexplained and retained;
passing diagnostics do not supply its missing cause. Independent token-union
inspection of the failed native run found all 598 typed tokens across 25
desktop note/copy files. No token was missing from that set; the original
shared-note experience and ordering still failed.
