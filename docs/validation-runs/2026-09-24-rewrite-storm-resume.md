# Rewrite-storm Resume copy validation — 2026-09-24

The native S89 run found an acceptance failure after the shared hold had
successfully stopped note publication for five minutes. With both stamping
fixtures disabled, both devices resumed and converged on the full main note,
but each had two sibling copies: an older published answer and that same
device's newer locally held rewrite.

The former automated test checked the number of copies before Resume and
then checked that the newer held text was present in one copy. It did not
count all siblings after Resume. The test now counts the final siblings and
keeps both stampers active through a five-minute hold.

A second two-engine regression pins the native ordering: one answer is
already being uploaded when the detector persists its hold, the other device
receives the encrypted pause control, and the old upload finishes. Stamping
continues locally for five minutes while the editor completes twenty
characters. After both fixtures stop, both Resume orders must produce the
same main note containing all twenty characters and exactly one shared copy.
The old code fails both orders with `2 !== 1`. The copy's encrypted version
history must contain both the old published answer and the latest held text.

## Fix and refusal boundary

The detector's Resume uses the existing deterministic conflict-file identity
for its recorded source version. It first ensures the baseline is preserved,
then advances that same copy with its newer held bytes. This changes neither
the manifest schema nor the server API. No timestamp or front matter is
stripped, and independent content is never treated as noise.

Advancement requires one readable remote head at the same copy path, with
chunk identity matching either the known baseline or the exact held snapshot.
The local copy must likewise match one of those snapshots and remain unchanged
in both content and metadata while its replacement is prepared. A changed
path record is also refused. The parent lookup and write run inside that
copy's existing publication queue, after any earlier upload acknowledges.
A concurrent remote fork, interrupted publication, or disappearing copy keeps
the original note paused. A retry of an already-published snapshot adds no
extra version.

`resume-copy.test.mjs` covers independent local and remote copy edits, split
heads, unavailable or moved history, the one-chunk budget, same-metadata saves,
path-record changes, a remote head racing publication, a growing/disappearing
copy, and an older upload still in flight. It verifies that ordinary newer
body edits are preserved too, without depending on front-matter parsing.

The explicit `current.deleted` refusal has a redundant content precondition:
record validation binds every deleted manifest to an empty chunk list, while
both acceptable snapshots here contain exactly one chunk. Removing only that
deletion disjunct cannot admit a deleted record through the remaining chunk
identity test. It is retained for clarity and is not counted as a separate
behavioral mutation.

## Verification scope

The copied composed baseline had 1,047 tests; its parked-note fixture observed
a retry summary while a manual verification upload was still draining and
asserted idle too early. The fixture now waits, within its existing bounded
wait, for the actual drain and queue to finish. It still asserts exact idle,
zero active publications, all expected content, and the original notice counts.
No parked-note product behavior changed.

The complete unmutated suite with this fix passes **1,068/1,068** tests.
Commands use the pinned Node 26.8.2 and TypeScript 5.9.3:

```sh
npm --prefix plugin run build
node --test --test-reporter=tap plugin/test/*.test.mjs
sh plugin/test/mutants/run.sh plugin/test/mutants/M620.diff
```

Every probe M620–M639 compiled and failed relevant tests through the full-suite
runner. That audit exposed two fixture defects: the deleted-copy fixture used
an API that always creates a live record, and the growing-copy fixture injected
its edit by read count. The final fixtures use the tombstone API and the
write/upload lifecycle. The local-identity fixture now returns one stable
replacement record, and checks preserve the specific refusal diagnostic.

All twenty probes were then rerun against the corrected nineteen-test
`resume-copy.test.mjs` suite; the table reports those final focused failure
counts, not the earlier full-suite counts. Earlier collateral co-typing,
stamper, and upgrade-fixture failures are not used as mutation proof. The
coordinator's final composed matrix supplies the final full-suite receipt.

| Probe | Final focused failures |
|---|---:|

| M620 | 18 |
| M621 | 1 |
| M622 | 1 |
| M623 | 1 |
| M624 | 1 |
| M625 | 1 |
| M626 | 1 |
| M627 | 1 |
| M628 | 1 |
| M629 | 12 |
| M630 | 3 |
| M631 | 1 |
| M632 | 1 |
| M633 | 1 |
| M634 | 1 |
| M635 | 1 |
| M636 | 1 |
| M637 | 5 |
| M638 | 1 |
| M639 | 2 |

Inherited probes M496, M566, M568, M569, M570 and M571 were recut only for
the new Resume context; their original mutations are unchanged. All 69 prior
#179 probes pass strict `patch -F0` applicability. Their final composed kill
counts are intentionally left to the coordinator's full matrix.

This is automated evidence for the native failure. The coordinator must rerun
native S89 with the repaired bundle before claiming native acceptance.
