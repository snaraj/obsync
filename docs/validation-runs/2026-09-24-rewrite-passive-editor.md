# Rewrite storm with a passive open editor — 2026-09-24

Scope: existing #179 / S89. This is the follow-up to the Resume-copy repair,
not a different conflict policy or a protocol change.

The coordinator's native n13 run used two genuine desktop apps with bundle
`7557e642f146659c8dfe3cf0e974f405d8ca904d6364898102ddaf5a92d3efed`.
Both had n13 open, both ran the timestamp fixture, and only A received input.
Neither device held the note. Both main notes ended with 16 of the 20 typed
characters, while four of six copies retained all 20. The data was retained,
but this failed both the main-note and copy-count acceptance criteria. Native
receipt: `179-rerun-n13-observation.json` in the coordinator's evidence folder.

`answerOf` exempted every open editor. A passive view therefore prevented a
hold. An initial repair exempting every buffer that differed from disk also
failed: an external write leaves a passive editor briefly displaying its old
buffer. The full suite exposed four copies before the hold under that
interleaving; that failed run is retained as `179-passive-full.log`.

The final change uses trusted editor input, bound to the Markdown view and
its file. Keyboard and before-input events protect typing through a ten-second
save allowance. An IME composition stays protected until composition-end or
focus-out; completion refreshes the save allowance. Leaving a passive view
creates no input. Observation uses capture listeners in the primary window,
existing popouts and newly opened popouts. Synthetic events do not count.
Previously judged background writes recheck current input before starting a
hold. The deletion path's existing unsaved-buffer protection is unchanged.
No note content is parsed or stripped, and all pause/Resume/history rules
remain as in the preceding #179 repair.

Before the repair, both new passive-open Resume-order tests failed. Their
unchanged outcomes now require both devices to hold, five virtual minutes of
continued local stamping with no additional note versions, all 20 characters
in the main note after Resume, and at most one sibling on each device. A
separate regression proves passive buffer lag does not mark human input.
Tests also prove actual input stays exempt after saving and after a cached
background judgment, and the existing two-device co-typing journey runs with
real input provenance in its fake editor. Existing fixtures that describe
user typing now report that input instead of treating arbitrary file writes
as user input.

Reproduction commands use the pinned Node 26.8.2 executable directory first
in PATH:

```sh
npm --prefix plugin run build
node --test --test-reporter=tap plugin/test/*.test.mjs
node --test --test-reporter=tap --test-name-pattern='passive saved|passive editor still|same pair|keydown|beforeinput|IME|focusout|synthetic input|input tracks|onload binds|answer flags' plugin/test/editor-input.test.mjs plugin/test/stamper.test.mjs
```

Final full-suite count: 1080 passed, 0 failed, 0 skipped; 87584.891 ms (`179-passive-restored-full.log`).

All 30 new probes M660–M689 compiled and were killed by the focused final
regressions (50 failing tests across the 30 runs). Each run restored the source
before the next probe. Raw logs and exact killing names are under
`179-passive-mutants/`, with `summary.json` holding the record. They can also
be reproduced against the full suite using the repository's ordinary
`sh plugin/test/mutants/run.sh plugin/test/mutants/Mnnn.diff` command; the
coordinator owns the final composed full matrix.

M149, M325 and M481–M485 were recut for this source. Each compiles and has one
relevant focused kill recorded in `179-passive-recuts/summary.json`. M481 now
removes the actual-input exemption in the answer flag; its old open-editor
check no longer exists. The remaining recuts preserve their previous broken
behavior. M149 still bypasses waiting for Obsidian's vault listing; M325 still
incorrectly requires all panes to be dirty; M482–M485 still corrupt the
arrival, time or cached-verdict checks.

One runtime type test in `typing` is defensive under a validated precondition:
its private weak maps are populated only by `trackInput`, which accepts only
MarkdownView instances. Removing only that consumer type test is equivalent
while those private maps retain their sole writer and the same object
identity; M672 independently removes the producer's runtime type check and
is killed by a deferred non-Markdown leaf. No kill is claimed for the
consumer-only equivalent check.

Native acceptance of this final bundle remains the coordinator's task. The
previous native failure and earlier intermediate suite failures are not
reported as passes.

| Probe | Relevant kills | Killing tests |
| --- | ---: | --- |
| M660 | 3 | a passive saved editor does not exempt a colliding background rewrite; a passive editor still loading an external write is not unsaved user input; answer flags distinguish actual input from passive buffer lag |
| M661 | 1 | the same pair is settled by the rule when the edit was typed, came long after the sync, or before it |
| M662 | 1 | answer flags distinguish actual input from passive buffer lag |
| M663 | 6 | keydown protects saved typing, then expires; a passive view is not typing; beforeinput protects saved typing, then expires; a passive view is not typing; IME remains typing beyond the save window, then compositionend starts the save allowance; focusout ends a cancelled composition but does not manufacture input in a passive view; input tracks the view's current file, all windows, and has one listener per window; onload binds the primary window, pre-existing popouts, and newly opened windows |
| M664 | 4 | keydown protects saved typing, then expires; a passive view is not typing; beforeinput protects saved typing, then expires; a passive view is not typing; IME remains typing beyond the save window, then compositionend starts the save allowance; focusout ends a cancelled composition but does not manufacture input in a passive view |
| M665 | 1 | input tracks the view's current file, all windows, and has one listener per window |
| M666 | 1 | IME remains typing beyond the save window, then compositionend starts the save allowance |
| M667 | 1 | IME remains typing beyond the save window, then compositionend starts the save allowance |
| M668 | 1 | focusout ends a cancelled composition but does not manufacture input in a passive view |
| M669 | 1 | synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing |
| M670 | 1 | synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing |
| M671 | 1 | synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing |
| M672 | 1 | synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing |
| M673 | 1 | synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing |
| M674 | 3 | keydown protects saved typing, then expires; a passive view is not typing; beforeinput protects saved typing, then expires; a passive view is not typing; synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing |
| M675 | 1 | input tracks the view's current file, all windows, and has one listener per window |
| M676 | 1 | input tracks the view's current file, all windows, and has one listener per window |
| M677 | 1 | focusout ends a cancelled composition but does not manufacture input in a passive view |
| M678 | 1 | keydown protects saved typing, then expires; a passive view is not typing |
| M679 | 3 | beforeinput protects saved typing, then expires; a passive view is not typing; input tracks the view's current file, all windows, and has one listener per window; onload binds the primary window, pre-existing popouts, and newly opened windows |
| M680 | 2 | IME remains typing beyond the save window, then compositionend starts the save allowance; focusout ends a cancelled composition but does not manufacture input in a passive view |
| M681 | 1 | IME remains typing beyond the save window, then compositionend starts the save allowance |
| M682 | 1 | focusout ends a cancelled composition but does not manufacture input in a passive view |
| M683 | 1 | onload binds the primary window, pre-existing popouts, and newly opened windows |
| M684 | 1 | onload binds the primary window, pre-existing popouts, and newly opened windows |
| M685 | 1 | onload binds the primary window, pre-existing popouts, and newly opened windows |
| M686 | 1 | input tracks the view's current file, all windows, and has one listener per window |
| M687 | 1 | input tracks the view's current file, all windows, and has one listener per window |
| M688 | 6 | keydown protects saved typing, then expires; a passive view is not typing; beforeinput protects saved typing, then expires; a passive view is not typing; IME remains typing beyond the save window, then compositionend starts the save allowance; focusout ends a cancelled composition but does not manufacture input in a passive view; input tracks the view's current file, all windows, and has one listener per window; onload binds the primary window, pre-existing popouts, and newly opened windows |
| M689 | 1 | IME remains typing beyond the save window, then compositionend starts the save allowance |
