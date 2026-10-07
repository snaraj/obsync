# Review repairs: native verification, 2026-10-06

The repairs at `274fcefa3a4e701d32950fc57e948b98d505fe73` preserved both
writers in two consecutive three-minute Android/desktop runs. Each accepted
900 trusted inputs, retained every token once in writer order, matched the
two native editors and independent disk reads, and ended with one server
head and no conflict copy. Neither emitted a native external-modification
warning. **The overall commands still failed their 1,500 ms relay visibility
diagnostic. Physical-iPhone acceptance of these bytes remains unproved.**

These results replace the pending repeat in the
[earlier record](2026-10-06-saved-editor-117.md#review-repair-checkpoints).
They do not change that record's failed experiments into passes.

## Artifact and device binding

- Plugin `main.js`: SHA-256
  `99da06ad8a15bad4f73646d7df29dea0dcc43c00f77c9aa934fad21af8ee6737`.
- Styles: SHA-256
  `796f28c630774dc80e00b8ba4c0d3811d524b1cd844fe36d0f9597c5ee0e82ce`.
- Server: SHA-256
  `7c05a4bb731d85fb50c81db7bd2c8888df85fb89e2a63c8710126a545d7d8534`.
- Desktop: macOS 27.0 arm64, native Obsidian 1.13.4, isolated profile and
  synthetic vault. The mock-keychain test mode means this row does not prove
  desktop OS credential custody.
- Android: official Obsidian 1.14.4, Android 17/API 37 arm64 image revision 6,
  build CP41.260831.007, security patch 2026-09-05, 16,384-byte pages,
  WebView 149.0.7827.5, Pixel 8 profile, 1080×2400 at density 420, two CPUs,
  software rendering. Requested RAM was 2,048 MiB; observed guest memory
  was 4,062,848 KiB. The observed value is authoritative.
- Android installation independently read back all three plugin files. The
  controller started at an earlier source head; its launch receipt is not
  substituted for the installed-file receipt.

The native pair used a temporary authenticated, encrypted account and an API
relay with normal certificate validation. The desktop origin was loopback;
Android reached the TLS relay. There was no ZIP download relay. No encryption,
request authentication, integrity check, certificate check or flush was disabled.
These uncontrolled relay observations have no quiet-host lease or paired
baseline; they establish correctness/reachability, not a comparative speed gain.

## Repairs and retained regressions

The earlier authenticated graph first lost parent tokens at 176.692 seconds,
before the copies. A native save could supersede a download while its commit
still returned success, advancing applied ancestry to bytes absent from disk.
The next local publication could then claim the wrong parent. Both hosts now
defer known superseded writes before advancing that ancestry, including an
identical-size/mtime replacement detected during existing readback.

The mobile public-save bridge also starts the editor's saved-baseline transition
before native reload can overwrite accepted input. It retains bounded text
eligibility and the all-panes precondition. Desktop's optional private
`adapter.queue` serialization has an explicit tested public fallback. A visual
reload failure alone still keeps a correctly confirmed durable write.

The suite injects native saves inside mobile and desktop commits, publishes the
local child from the old parent, and then requires a retry with both writers,
one file and one head. Two-pane composition/native-only tests refuse a partial
save. Real-engine tests require publication despite modify-echo suppression,
before a periodic scan can rescue a missing enqueue. Source mutants M4114–M4120
are retained and assertion-killed; each runs with:

```sh
plugin/test/mutants/run.sh plugin/test/mutants/M4114.diff
```

Substitute the other named diff. Earlier unretained mutation counts are
withdrawn; initial surviving or failed test drafts remain historical failures.

## Sustained input and visibility

Each long run typed 450 tokens per peer at 400 ms intervals, placing each caret
once. Trusted native `beforeinput` events and receiving-editor DOM mutations
supplied the event oracle, with controller-aligned renderer clocks and additive
round-trip uncertainty. This is not a physical keyboard or paint measurement.

| Run | Tokens retained | Copies / external warnings | Desktop overdue / maximum | Android overdue / maximum |
| --- | ---: | --- | --- | --- |
| Long 1 | 900 / 900 | 0 / 0 | 32 of 447 / 2,047.2 ms | 38 of 447 / 2,162.0 ms |
| Long 2 | 900 / 900 | 0 / 0 | 20 of 447 / 2,195.0 ms | 26 of 447 / 2,213.7 ms |
| Instrumented 60-second diagnostic | 300 / 300 | 0 / 0 | 6 of 147 / 1,960.7 ms | 3 of 147 / 1,705.5 ms |

Each peer showed one normal combined-edits notice per run. No notice was hidden.
Both long final notes have SHA-256
`d322fc12acc944d97d92f20a44500f9476957f8ba99eec27183e56b363d4150e`.
The subsequent authenticated read found exactly one current head for each of
the three notes, including after Android's app-process restart.

The diagnostic recorded method names, durations and bounded decision lines,
without request arguments, credentials or response content. Median `getFile`
duration was 53.1 ms desktop / 48.5 ms Android; median `getChunk` was
67.8 / 89.6 ms. There were 459 / 497 `getFile` calls in that minute. Slow token
windows contain repeated head reads, superseded-head skips, upload completion
and recursive merge-body retrieval while both writers advance. They do not
show the historical ten-second quiet-typing hold. Calls overlap: summing their
durations would not establish causal shares of end-to-end delay.

Candidates for measured follow-up are bounded reuse of already authenticated
immutable merge bodies, avoiding redundant head reads without weakening current
parent checks, and the separately scoped encrypted edit-batch design in #315.
Any cache needs explicit memory bounds and Leave/revocation cleanup. These are
unearned opportunities, not performance or security claims. The current failed
relay budget remains recorded under #325; no threshold or scope was changed.

## Lifecycle and visual checks

Pairing compared both independent renderer values and confirmed the joining
device kept the key. Both-direction note/editor/disk identity checks passed.
After background/foreground, transfers took 756 ms desktop-to-Android and
967 ms Android-to-desktop. After app-process termination/relaunch, pairing
survived and transfers took 1,249 / 929 ms. An offline edit stayed local,
then converged automatically 1,626 ms after reconnection.

Leave completed in 2,433 ms: the server recorded revocation, the device forgot
its identifier and endpoint, tracked-file metadata became empty, and all 11
local synthetic notes retained their hashes. The visible settings showed the
unpaired state and empty endpoint/header fields.

All 27 native captures were opened. Lifecycle text matched, the offline icon
changed to green after reconnection, and Leave showed the expected state.
The long settled Android captures were scrolled below the heading and cannot
visually prove every token or caret position. An additional diagnostic captured
typing before verification reopened the note: text and the caret were present,
with the caret near the bottom navigation overlay. Complete-content proof comes
from independent editor/disk comparison, not from those partial screenshots.
Physical keyboard ergonomics and a causal explanation for the long capture's
scroll position are not established.

## Gates, hosted Windows and cleanup

The final local plugin suite passed 2,107 tests; the affected host/writer/engine
subset passed 128, contracts passed 873, and both secret scans passed. The prior
repair's full gate passed Rust, CLI, chart, 83 dashboard tests and 94.71% Rust
line coverage. The final head's hosted gate and native matrices passed.

[Native desktop run 37573611808](https://github.com/snaraj/obsync/actions/runs/37573611808)
passed Windows, macOS and both Linux keyring modes. Its six Windows PNGs were
opened: both token streams and fixed lines matched, as did the post-restart
notes, with green obsync status. Capture receipts bind merge checkout
`5e48f62a0c1610248754ef050430711e9b6b53ca`, whose parents are base
`72bdcf94ed40fc8769c8baad5a6b2db56ae92cfe` and the candidate head above.

Both foreground controllers exited zero after stopping their owned groups.
Receipts verify relay, runtime, private account/vault state, live manifests and
copied inputs absent. Open-file checks preceded removal of the owned Android
image, APK, extracted runtime, exact SDK symlink and verified preflight copies.
The removed runtime inputs totaled 11,149,785,462 logical bytes; shared SDK and
Java were preserved. Sanitized evidence and frozen recipes remain.

Physical-iPhone current-byte validation and earlier on-device fixture cleanup
remain blocked: Computer Use returns `Sky Computer Use native pipe startup
failed` before discovering the app, including after the owner's unlock. This
does not show that the phone is locked. These results support delta review;
they do not establish complete release acceptance or authorize Ready/merge.
