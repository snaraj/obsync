# 2026-09-24: PR #133 review regressions

This record covers the replacement code after the review of `48b7fe7`.
It records automated checks, not new desktop or phone observations.
The later [native phone record](2026-09-24-phone-candidate.md) exercises this
exact plugin bundle for identical first sync, two-way edits, offline restart
and automatic recovery. Its screenshots and limits are recorded separately.

The pull path now checks the incoming identity's current server heads before
retiring an independent identical note. Historical live-plus-delete replay,
a concurrent fork, a local edit during lookup, and a replacement local record
all preserve the later note. The existing keeper save is checked by reloading
State before retirement and after settlement. Repair PUTs answered with real
HTTP 507 now produce the visible repair error instead of being classified offline.

Validation used Node 26.8.2/npm 11.19.1 and Rust 1.98.0:

- `make check`: Rust 144 + 367 passed; line coverage 94.65%; plugin 781/781;
  dashboard 70/70; contracts 767; both secret scans clear.
- `node --test plugin/test/review-133.test.mjs`: six passing regressions.
  Before the fixes, the historical replay and HTTP 507 cases failed.
- `sh plugin/test/mutants/run.sh plugin/test/mutants/M500.diff` through M505:
  all apply, compile, and fail the restored 781-test suite. M500 has two
  failing witnesses; M501–M505 each have one. The runner restores and rebuilds.
  M502 removes only the keeper save, independently of `setFile`.

The 149-entry `plugin/test/mutants/MATRIX.md` is the earlier 775-test
measurement, not a claim that all historical counts were remeasured here.
Its M25/M26 survivors remain inherited coverage gaps; M28 is equivalent on
1.1.2. The six new patches carry the independent review-fix measurements above.
No native setup action was performed in this review-fix pass, so there are no
new setup screenshots in this record.
