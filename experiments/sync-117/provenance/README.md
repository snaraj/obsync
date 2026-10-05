# Original measurement source

`measured-prepare.py` reconstructs the instrumentation used for the 2026-10-05
Mac and ARM component samples on a clean disposable checkout of
`897124b073baf51ef2cb3fff52a5badc1940a237`. Every before/after source hash is
recorded in `measured-source.json`; verify all four after hashes before build.
It is historical, never-merged measurement code, not a shipping candidate.

The maintained branch adds the formatter-required Rust line wrap and replaces
the historical global renderer lookup with a guarded window lookup. The
component driver supplies its own Node measurement object. The original
instrumentation failed the plugin convention against globalThis in product
source; that rule remains unchanged. Maintained hooks pass that rule, but their
additional lookup has not been calibrated against the original measurements.
Use the original recipe to reproduce the original source; use maintained hooks
for new runs and record their new hashes. Instrumentation overhead remains
unmeasured, so these measurements do not establish a shipping speedup.
