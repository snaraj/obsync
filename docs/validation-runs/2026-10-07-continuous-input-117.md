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
