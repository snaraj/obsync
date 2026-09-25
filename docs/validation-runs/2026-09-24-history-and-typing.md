# Historical catch-up and typing repairs, 2026-09-24

This is author-operated diagnostic evidence following the native 1.1.3 phone
campaign. It distinguishes simulated regressions from native acceptance;
it is not an independent review or a final phone result.

## A joining device recreated resolved conflicts

Fresh phone pairing on bundle
`530ca4aeb1fee893817f99110346226e7573714c542f3d303b45971e0f4b85aa`
created seven new conflict files from an old typing note. Its journal held
44 versions and one current head; the new copies' creation records followed
the pairing. No historical version of that note had been garbage-collected.

The real file endpoint returns its newest ten versions plus every current
head. The fake server had returned the entire graph. With the bounded view,
the client could not walk old parent links to prove that earlier forks were
already resolved and mistakenly preserved them again as new conflicts.

The repair skips an obsolete feed entry when the current head list is nonempty
and every head has a version record in the response. It leaves local bytes
untouched for later feed entries to advance. An older **live** head outside
the ten-version window still causes both edits to be preserved. Empty and
incomplete head views retain the conservative conflict path.

Five regressions in `history-catchup.test.mjs` cover fresh desktop and mobile
replay, an old live head, an empty head view and a missing head record. The two
fresh-device cases each made eight spurious copies before repair and none after.
M716, M729, M730 and M731 apply, compile and fail 2, 1, 1 and 1 focused tests;
the restored source passes. An initial scratch build missing vendored Obsidian
declarations is retained as a setup failure, never counted as a kill.

## Adjacent lines and same-line appends

The native timing build passed interleaved typing in sections separated by an
unchanged line and both rename directions. An adjacent-line attempt produced
several copies. Issue #135's acceptance criteria require the exercised typing
scenarios to finish with the same note and at most one copy, so the narrower
successful native case did not complete that issue.

The old merge intersected the lines unchanged on **both** sides. Two adjacent
line edits had no common anchor between them and were grouped into one false
overlap. The repair compares each side's changed base intervals independently.
Neighboring replacements, insertions and deletions retain their actual edits;
intersecting replacements still refuse to merge.

The same-line append simulation exposed a separate gap in the previous test:
it allowed one copy **per fork**, resulting in five copies in a single typing
session. The strengthened test requires the shared main note to contain every
unique keystroke exactly once, with no copies. When both versions only append
to one existing line, obsync now keeps their shared appended prefix once and
joins the remaining additions in lexicographic order. Unicode code points
define the shared prefix, so different emoji cannot share half a surrogate pair.
Replacements of existing characters and multi-line overlaps remain conflicts.

Before repair, the new adjacent-line desktop/mobile simulation and three
primitive witnesses failed. The two append primitives and strengthened
same-line session also failed. Focused passing results after repair are
recorded separately from the complete gate and native follow-up. Controls
M732–M764 each apply, compile and fail their relevant primitive tests; restored
source passes all those tests again.

Two existing witnesses were updated to keep their original safety purpose:

- The write-record race now requires the local replacement and the peer's
  independently added line in one main note, with no copy. Requiring the
  replaced common-ancestor text to survive would be requiring an extra copy
  of text the user deliberately changed. M23 still compiles and fails it.
- The recursive-base fixture prepends each new word instead of appending it,
  so a direct append merge cannot bypass the recursive path under test.
  Three levels still merge and the fourth is refused. M305 and M306 each
  compile and fail this witness; the original depth limit is unchanged.

Reproduce the targeted suites with the pinned Node toolchain:

```sh
npm --prefix plugin run build
node --test plugin/test/history-catchup.test.mjs plugin/test/conflict.test.mjs \
  plugin/test/cotyping.test.mjs plugin/test/merge.test.mjs plugin/test/samename.test.mjs
```

The pinned full `make check` passes 1,138 plugin tests, 144 core and 375 server
tests, two CLI tests, 70 dashboard tests, 767 contract tests, 94.73% Rust line
coverage and both secret scans. All 709 mutation patches apply with zero fuzz.
The built plugin SHA-256 is
`3e8d499e55ec3b2573bb788826e94a57979fd3be1dfa23a56f5fabec22f2cb47`.
Earlier full-gate failures are retained: the first sandbox run could not bind
test sockets; later failures exposed the stale-head, saved-write and recursive
fixture expectations discussed above. None is counted as a passing run.

The complete mutation matrix and real-phone fresh pairing and typing on the
repaired bundle remain separate gates. Earlier phone screenshots validate
only the bundle and actions named in their original record.
