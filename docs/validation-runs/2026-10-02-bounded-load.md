# Released 1.1.5 under bounded test contention

- Date/operator: 2026-10-02, user.
- Route: isolated Docker test container, no network; no native sync route or TLS
  session was exercised by this campaign.
- Source: released 1.1.5, `03d108505d3993bddff276d70c814a6547222339`, clean.
- Plugin: built from that source; no native install. `main.js` SHA-256
  `34797c29613f28104157e09de46dc713be862269bdebca11c587ebe8c2522b11`
  matches the published 1.1.5 release manifest.
- Host: M1 Max, 10 cores, 64 GiB RAM, macOS 27.0. This is a container campaign,
  not a physical Android or other device run. Obsidian was not involved.
- Container: Linux ARM64, Node 26.10.0, 4-CPU quota, 8 GiB memory, 40 busy worker
  threads during each full suite; no extra workers for standalone cases.
- Image: `node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2`.

## Method

The [pre-run amendment](https://github.com/snaraj/obsync/issues/277#issuecomment-5957066292)
replaced an absolute host load average with ten busy workers per capped CPU.
The runner retains every attempt and uses the tests' existing deadlines and
assertions. Its full-suite command is `node test/run.mjs --test-reporter=tap`.
Standalone invocations select the two exact test names with Node's test filter.

The portable runner being prepared for the tooling PR accepts explicit source,
output and image arguments:

```sh
python3 -B scripts/validation/lab/load277.py \
  --source-repo "$SOURCE_CHECKOUT" --run "$NEW_EXTERNAL_RUN" \
  --image 'node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2'
```

The source checkout must already contain its built plugin and pinned compiler.
Tracked source is copied onto a native container filesystem, alongside those
build inputs. Scratch is a 2 GiB tmpfs. The container runs as an unprivileged
user, without a network or capabilities, with a read-only root filesystem and
`no-new-privileges`. A focused preflight validates bundle building, API
compatibility and native filesystem cases before the repeated campaign.

Harness SHA-256 values at the valid run:

- `load277.py`: `7ad1a4aa967a61e4073c22dd91766a91bfae4d9b413fb9f67840baadf1bdf766`.
- `load277.mjs`: `c839089706d6c8d1455f970a66acad57e9873a56252349580e7abd1ec999602b`.
- Result JSON: `3dc849dc5ae543c8fa124242c9937904b3ed3848aa71e853fd4b4b5d30b6d788`.

## Observed results

The Android different-note re-case and Sync now 8 MiB rewrite each passed
**20/20 standalone repetitions** and their execution in **all five full suites**.
The standalone case durations were 199–211 ms and 408–426 ms respectively.

| Full suite | Duration | Passed | Failed | Skipped | Initial load (1/5/15 min) |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 362.417 s | 1,966 | 0 | 9 | 0.57 / 0.13 / 0.04 |
| 2 | 363.596 s | 1,966 | 0 | 9 | 30.41 / 21.33 / 9.90 |
| 3 | 365.458 s | 1,965 | 1 | 9 | 29.05 / 23.76 / 14.15 |
| 4 | 373.578 s | 1,965 | 1 | 9 | 23.29 / 21.12 / 16.15 |
| 5 | 367.584 s | 1,965 | 1 | 9 | 13.66 / 22.14 / 18.88 |

Each suite ran 1,975 cases; the nine skips are platform-specific. Suites 3–5
failed only `a large note out of the selection is not downloaded when another
device changes it (#239)`, at `plugin/test/left-selection.test.mjs:273`. Its
existing 10,000 ms condition deadline expired; observed case durations were
10,438.924 ms, 10,558.865 ms and 10,342.988 ms.

That observation is tracked in [#319](https://github.com/snaraj/obsync/issues/319).
Its cause is uninvestigated: these results establish neither a scheduling-only
cause nor a product defect. The approved scope freeze defers the investigation.
No extra run, timeout increase, retry or assertion change was used to obtain
green. **#277 remains open:** its five-full-suite acceptance was not met.

## Earlier attempts retained

The first attempt passed all 40 standalone cases, then failed its first full
suite because a read-only build directory and a host filesystem bind did not
provide the required environment. The second also passed all 40 standalone
cases but omitted the pinned TypeScript compiler from its source copy. Its
first full suite also observed the selection deadline. Both attempts were
stopped after the harness defects were identified; their full and partial TAP
output remains retained. Neither counts as valid full-suite acceptance.

The third attempt passed the focused environment preflight and completed all
five scheduled full suites. Raw TAP, image/source identifiers, cgroup bounds,
harness snapshots and teardown receipts are retained outside the repository.
Every task container, native scratch filesystem and newly pulled image was
removed, with absence verified. Existing unrelated resources were preserved.

## Not validated

VAL V1–V28 and J1–J11 were not attempted in this container campaign. Native
desktop/phone behavior, rendered UI, production installation, TLS sync,
throughput, background-window performance, power-loss recovery and physical
Android acceptance are not established by these test results.
