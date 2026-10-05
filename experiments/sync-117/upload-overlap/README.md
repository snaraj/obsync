# Rejected upload existence overlap, 2026-10-05

This never-merge experiment did not justify a production change for #325.
The proposed overlap had a median paired large-file sender ratio of 1.0122
(about 1.2% slower), against a preregistered requirement of at most 0.95 and
improvement in every pair. Two of three pairs were slower. The production
plugin files were restored byte-for-byte to
`061e9e5493197f806efa1e67b894bf66b6a542cc`; only the exact rejected patch,
recipes, synthetic captures and reduced evidence remain here.

The candidate let one missing-chunk existence request overlap preparation of
the next ciphertext window. It retained the original desktop/mobile windows,
one existence request at a time, failure propagation, and a final drain before
version publication. It changed no protocol, dependency, native capability,
cryptography, authentication or durability setting. The small-note path was
unchanged. This record is neither a shipping approval nor closure of #325.

All six samples are retained in execution order. Each fresh native pair wrote
128 notes (8 KiB repeated payload plus a numbered prefix), then a deterministic
64 MiB plus one byte file. Timers include fixture generation and local creation;
the sender endpoint is the final successful version response, and the receiver
endpoint is the final durable writer completion. Predicate-poll elapsed time is
recorded separately. Values below are milliseconds.

| Sample | Arm | Notes sender | Notes receiver | Large sender | Large receiver |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 4705 | 5395 | 1866 | 2122 |
| 2 | Candidate | 4766 | 5429 | 1837 | 2087 |
| 3 | Candidate | 4629 | 5311 | 1822 | 2072 |
| 4 | Baseline | 4636 | 5304 | 1785 | 2037 |
| 5 | Baseline | 4627 | 5300 | 1804 | 2055 |
| 6 | Candidate | 4791 | 5467 | 1826 | 2077 |

Pairs are (1,2), (4,3), (5,6), always candidate divided by baseline. Large
sender ratios are 0.9845, 1.0207 and 1.0122. The small-note sender median ratio
is 1.0130; there is no demonstrated small-note gain. The large receiver median
ratio is 1.0107. This bounded pilot does not establish a general regression or
an effect on a deployed route. It is sufficient to reject adding this complexity
under the fixed acceptance rule. No sample was discarded or repeated.

Request counts and request-body lengths matched exactly in every pair. Each
small-note sender made 128 chunk PUTs (1,053,714 body bytes) and 128 version POSTs
(107,776 bytes). Each large-file sender made 15 chunk PUTs (67,109,105 bytes),
five existence POSTs (1,055 bytes) and one version POST (4,736 bytes). Receiver
chunk-read requests and request-body lengths also matched; response-body lengths
were not measured by this observer. Summed request durations can overlap and are
not end-to-end latency.

Every run verified all 129 final file paths and all 68,160,531 bytes independently
on both native vaults, plus equal persisted file/version identities. Known
synthetic content/path sentinels were absent from the owned server's storage;
this narrow oracle is not a general confidentiality proof. All 12 captures were
displayed and read, with hashes and concrete observations in
`evidence/visual-inspection.json`. They show the same final numbered note in
both windows. The rightmost status glyph varies after opening the note; these
captures are content evidence, not a stable-idle UI assertion. Each run also
records hook removal, owned process-group/holder absence, and removal of its
runtime, private data and manifest. The controller counts a sample PASS only
after that final cleanup. Copied input binaries and the lane's plugin build,
distribution and dependency directories were also removed after hash checks;
`evidence/final-task-cleanup.json` records their 30,246,839 bytes and absence.

The installed Obsidian bundle was 1.13.4. Both windows and the server ran on the
same macOS host, with loopback HTTP and mock keychains. Authentication, encryption
and durable writes used their normal implementation. No artificial network delay,
task build, VM or stress workload ran during measurement. Host-wide idleness and
observer overhead were not calibrated. TLS, phones, Linux/Windows and the deployed
server route were not measured in this experiment.

The candidate passed 32 focused tests before and after mutation restoration.
Four mutants were killed by assertions/runtime failures: serializing the check
removed the overlap, dropping the remembered error lost rejection, removing the
window guard exceeded the memory bound, and removing the final drain tried to
publish a version before its chunks existed. Exact replacements and commands are
in `recipes/mutants.json`; the new tests are archived beside the patch. This is
focused prototype evidence, not a full-gate or independent implementation verdict.
For each mutant, replace its single `before` occurrence with `after` in the
patched `plugin/src/sync/push.ts`, rebuild, and run `node --test` followed by its
`testArgs` from `plugin/`. Restore the candidate source and rebuild between
mutants. A build failure or cancelled test is not a mutation kill.

To recompute every ratio and acceptance predicate:

```sh
python3 -B experiments/sync-117/upload-overlap/recipes/summarize.py \
  experiments/sync-117/upload-overlap/evidence
```

Reproduction uses two fresh worktrees at the base above. Build the baseline with
the repository's pinned toolchain. In the candidate worktree, apply
`recipes/candidate.diff.json` (a JSON string preserving the exact unified diff), copy `recipes/upload-pipeline.test.mjs` to `plugin/test/`,
and run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build`, then the
focused command in `evidence/provenance.json` from `plugin/`. Retain both `dist/`
directories and use one server binary for both arms. Decode and apply the patch with:

```sh
python3 -c 'import json,sys;sys.stdout.write(json.load(open(sys.argv[1])))' \
  recipes/candidate.diff.json | git -C CANDIDATE_WORKTREE apply -
```

The patch hash in the evidence hashes the decoded bytes, whose whitespace includes
valid blank unified-diff context. Exact measured plugin,
server and patch SHA-256 values are in `evidence/artifacts.json`.

Use the portable harness under `experiments/sync-117/harness` at experiment commit
`0f653717b291d556a3df19d2e35111157e41e542`; the five invoked/imported local helpers
matched those committed bytes. Their measured hashes are retained in
`evidence/recipe-hashes.json`; its `candidate.diff` entry names those same decoded
patch bytes. Create a new external run directory with an
`evidence/` child, then run (all paths absolute):

```sh
python3 -B recipes/compare.py --source CANDIDATE_WORKTREE \
  --binary SERVER_BINARY --harness HARNESS/scripts/validation/lab \
  --root NEW_EXTERNAL_RUN --baseline BASELINE_DIST --candidate CANDIDATE_DIST
```

The controller stops on failure, preserves reduced results and attempts verified
teardown. Inspect failures before reusing anything; never replace a prior sample.
After a resolved run, remove owned input binaries/builds and private fixtures,
retaining only recipes and reduced evidence. The frozen acceptance rules are in
`recipes/README.md`. The exact prototype source is an archived patch, not active
production code on this branch.

Independent-note apply concurrency needs broader ownership changes before it can
be safe. At the base above, `engine.ts:3739` holds one global pull lock and
advances `lastSeq` in application order at line 3757. `pull.ts:1273` calls
`settleBeside`, which can modify names outside the current record.
`pull.ts:2015` admits against shared local bytes without reserving another
worker's pending allocation. `engine.ts:3690` aborts every writer in the shared
staging map at the end of one lane. A bounded worker design therefore needs
reservations for current/target/conflict paths and bytes, per-worker staging
ownership, and durable completion tracking that advances only a contiguous feed
prefix. Rename collisions, delete-wins, cancellation, crash/replay, admission and
active-editor holds must remain serialized wherever those resources intersect.
Existing parallel GET prefetch does not provide these guarantees. This concrete
limitation was recorded without adding an unsafe parallel apply shortcut.
