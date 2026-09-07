# CI map

Dated 2026-09-07. What each job runs, what that proves, and the exact contexts
the owner enters into the branch ruleset. `make check` runs the same battery
locally, and `scripts/ci/makefile-invariants.sh` fails the gate if the two ever
stop agreeing. The one group `check` does not chain is the `container` job's
two `docker build` commands and the image smoke that follows them — `check`
stays runnable with no container runtime — and `make image` reproduces all
three exactly. On a host whose Docker declares a credential helper,
`make image-isolated` is the same build with an empty `DOCKER_CONFIG`, which is
what the gate uses; it carries the caller's current daemon endpoint in so
emptying the configuration cannot also drop the context that names the socket.

## `pr-gate.yml` — pull requests, pushes to `main`, manual dispatch

| Job | Command | What it proves |
| --- | --- | --- |
| `security` | `python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v` | The contract suites hold: seven locks, two-verdict classifier, publication state machines, governance receipt, workflow integrity, the YAML reader, the chart pin logic, the commit identity rules. |
| `security` | `scripts/ci/commit_identity_contract.py` over the event's range | Author and committer are the owner noreply identity, no trailer of any kind, and the last line is a roster signature. The secret scans read blobs and cannot see any of this. |
| `security` | `release_contract.py transition` over the event's range | Every commit in `base..head` advances all seven locks exactly one patch, or the whole range is confined to the documentation allowlist and advances nothing. |
| `security` | `upload-artifact` of the transition verdict (main pushes) | The orchestrator learns which RANGE this push validated; the push base is unrecoverable from git alone once later merges land. |
| `security` | `scripts/ci/install-tools.sh` | gitleaks, helm, trivy, cosign, and actionlint arrive at pinned versions with SHA-256-verified bytes and assert their own version afterwards. |
| `security` | `actionlint` | The workflows parse and their shell bodies pass shellcheck. |
| `security` | `trivy fs --scanners vuln --severity HIGH,CRITICAL` | No high or critical vulnerability in the source tree. Requirement 5 keeps this near-empty by construction; the same policy string is recorded in the release evidence manifest. |
| `security` | `gitleaks git` (full history) and `gitleaks dir` (working tree) | No secret in any blob, in history or in the tree. `.gitleaks.toml` uses the default rule set whole and carries exactly one path allowlist, for `plugin/test/fixtures/crypto.json` -- sentinel-derived cross-implementation vectors whose root input is the byte sequence 00..1f and which are regenerable in one command. It is one FILE wide, not one directory or one rule, and a probe confirms the same payload in a neighbouring fixtures file is still found. |
| `application` | `rustup toolchain install` then exact version assertions | The runner runs the toolchain `rust-toolchain.toml` names (1.98.0 with rustfmt, clippy, llvm-tools) and Node 24.19.0 / npm 11.17.0 — not whatever the runner image shipped. |
| `application` | `cargo fmt --all --check` | Formatting is decided, not argued. |
| `application` | `cargo clippy --workspace --all-targets -- -D warnings` | No lint survives, in tests as well as in the library. |
| `application` | `cargo test --workspace` | The Rust battery, including the doctrine pins. |
| `application` | `./scripts/ci/coverage.sh` against `RUST_COVERAGE_FLOOR` | Line coverage meets the ratchet-only floor (requirement 9), measured with the pinned `llvm-tools` component and no crate. The floor is ONE fact in three places -- AGENTS.md, the Makefile, and this workflow's env -- and `test_coverage_floor.py` fails the gate if they disagree, if any of the three stops declaring it, or if the step that consumes it is removed. |
| `application` | `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build`, `npm test` in `plugin/` | The plugin builds from its lockfile with no install hook executed, and its tests pass under `node --test`. |
| `application` | `node --test dashboard/test/` | The dashboard's pure functions hold. The dashboard has no `package.json` by design, so this needs no install step. |
| `application` | `scripts/ci/makefile-invariants.sh` | `make check` and this workflow run one battery — plus the two `docker build` commands `make image` and the `container` job share, and the smoke that follows them. Both sides are read for what they RUN, never for what they mention: the Makefile's tab-indented recipe lines, and every step `run:` value resolved by `scripts/ci/workflow_runs.py` through the fail-closed YAML reader. The check can still fail — it mutates a copy of each file nine ways (deleting a canonical command, naming it in a comment, and neutralizing it as `true # …` or `echo '…'`) and requires the comparison to refuse every one. |
| `chart` | `helm lint chart`, `helm template smoke chart --kube-version v1.36.0` | The chart renders against the platform's Kubernetes target and satisfies its own required, closed `values.schema.json`. |
| `chart` | `python3 -B scripts/ci/chart_pins.py all` | The three rendered pins below. |
| `container` | `docker build --target server --tag obsync-gate:<sha> .` | The release stage builds, natively on the amd64 runner with no emulation, including the `cargo test --workspace --locked` battery that runs INSIDE the image and the musl cross-link. Nothing is pushed and no registry is logged into; `DOCKER_CONFIG` points at an empty directory so no credential helper is consulted for the anonymous digest-pinned base-image pulls. |
| `container` | `docker create` + `docker cp` + `file` on `/out/obsyncd` | The shipped binary is a static ELF for the runner's OWN architecture — the property that lets the final image be distroless/static with no shell. Asked from outside because distroless has no shell to ask inside, and compared against `uname -m` so an emulated cross-build fails instead of passing. |
| `container` | `docker build --tag obsync-gate-full:<sha> .` | The whole Dockerfile builds: the plugin stage's own `npm ci`/build/test inside the image, the bundle stage the Release asset is exported from, and the final image with the dashboard it serves. |
| `container` | `docker image inspect` | The shipped image is `User=nonroot` with entrypoint `/usr/local/bin/obsyncd`, command `serve`, and one exposed port `8080/tcp` — the half of AGENTS.md's non-root invariant that lives in the bytes rather than in the chart. |
| `container` | `scripts/ci/image-smoke.sh obsync-gate-full:<sha>` | The shipped image SERVES, run the way README.md's quick start runs it: two FRESH named volumes, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a loopback-published port. Five properties — `/readyz` answers `{"ready":true` inside a 60 s budget, every process in the container is uid 65532, the README's own `docker cp … \| tar -xO` yields a 64-lowercase-hex setup token, the same read works on the STOPPED container, and the run carried the hardening it claims. It builds nothing; the image reference is the argument, so the gate smokes exactly what it just built. The build steps above were all green on an image that exited at first boot with `event=server_key_failed decision=exit refusal=io_error`, because the final stage declared `USER nonroot` without creating `/data/blobs` and `/data/journal` and Docker therefore created both mount points root-owned. |
| `gate` | asserts each job's result | One aggregate required context that names every job, so a job renamed, conditioned out, or removed turns the gate red instead of leaving a required check that never reports. |

### What the three chart pins prove

They read the COMPLETE render — every template, no `--show-only` — through
`scripts/ci/miniyaml.py`, a fail-closed reader that refuses every construct it
does not fully model. An unparseable render is a FAILED pin, never a passed
one, and expectations come from `chart/values.yaml` so the peer identity and
the storage classes are stated in exactly one place.

- **ingress** — the NetworkPolicy admits exactly one peer, named by namespace
  **and** app label **and** instance, on the service port only, and denies all
  egress. A blank or absent instance is refused by the schema; an overridden
  instance moves the pin and leaves no trace of the default. Comparing the
  whole `spec.ingress` sub-tree rather than counting `- from:` lines is what
  catches a second rule with no `from` (`- {}` renders an allow-all), and
  requiring exactly one NetworkPolicy document is what catches a second policy
  in another template, since ingress rules are additive.
- **storage** — exactly the two claims `docs/storage.md` defines, on the
  classes, sizes and provisioned capacities `values.yaml` names, all
  `ReadWriteOnce`; and the workload mounts NOTHING but those claims — a
  `hostPath`, `emptyDir`, Secret, ConfigMap or inline CSI volume fails the pin
  by name. A mirror is the one declared way to add a third volume and must
  arrive as a claim that also reaches the process through
  `OBSYNC_BLOBS_MIRRORS`; a half-specified mirror is refused by the schema.
- **security** — the rendered pod and container context is the one
  requirement 4 fixes (non-root, read-only root filesystem, no privilege
  escalation, all capabilities dropped, `RuntimeDefault` seccomp, no
  service-account token), and every weakening override is refused by the
  schema rather than merely absent from the defaults. The workload reference
  still renders `repository:tag@digest`.

## `codeql.yml` — pull requests, pushes to `main`, weekly cron

Two matrix jobs, both `build-mode: none`. **Rust is analysed**: `rust` is a
built-in CodeQL language at the pinned action version — `src/languages/
builtin.json` at `cdf488f` (v4.37.9) lists `actions, cpp, csharp, go, java,
javascript, python, ruby, rust, swift`, so no fallback to
javascript-only was needed. `javascript-typescript` is that file's alias for
`javascript` and covers `plugin/src`, `plugin/build.mjs`, and the dashboard.
Neither job needs a toolchain step, because build-mode `none` extracts from
source.

Cancellation is guarded to pull requests only. The weekly schedule resolves to
the default branch's head SHA, which is the concurrency group of a push run
still analysing that same commit; cancelling it would leave that version
permanently unreleasable, because the publisher authorizes against a CodeQL run
with `event=push`, `head_branch=main`, that exact `head_sha`, and
`conclusion=success`, and no second push-event run for a SHA can ever exist.

## `release-after-main.yml` — success-only `workflow_run` completion

Holds `actions: write` plus `contents: read` and therefore cannot create a ref
at all. It re-derives the gate's published transition class from git and, for a
`no-artifact` verdict, re-proves it against an anchor the verdict cannot
choose: the head of the newest earlier successful protected-main gate run, from
the Actions record, with all six lock files byte-identical across the range.
An `artifact` verdict dispatches `release-publisher.yml` with the exact source
SHA and the completed run id; a `no-artifact` verdict logs and dispatches
nothing.

## `release-publisher.yml` — explicit dispatch on protected `main`

Two jobs, and the split is enforced by permissions rather than convention:

- `authorize` (`actions: read`, `contents: read`) checks out the PROTECTED
  main tree — not the tree asking to be released — and binds the dispatch to
  one successful protected-main PR-gate run with the exact job inventory, plus
  one successful exact-SHA CodeQL run with both matrix jobs.
- `publish` (`contents: write`, `packages: write`, `id-token: write`) creates
  or verifies the annotated `vX.Y.Z` tag at the exact source SHA, builds and
  pushes `linux/amd64` and `linux/arm64`, **scans the resolved digest for
  HIGH/CRITICAL before signing it**, signs image and OCI chart keyless,
  substitutes the resolved digest into the chart values before packaging,
  exports the plugin bundle from the same Dockerfile stage the image copies,
  and publishes one immutable Release carrying the deterministic evidence
  manifest and the bundle.

Position is the contract in two places: the vulnerability gate sits between
digest resolution and `cosign sign`, so a failing digest never receives this
repository's release identity; and the chart digest substitution sits after
signing and before the chart classifier, so the classifier's re-package and the
publish step's package read the identical tree.

## `release-audit.yml` — weekly, read-only

Re-binds the newest immutable Release: the manifest bytes, the notes, the
Release record, the successful run, the annotated tag, both registry aliases
still resolving to the recorded digests, both cosign signatures, the plugin
bundle's SHA-256, and a fresh HIGH/CRITICAL scan of the shipped image against
today's vulnerability database. It holds no write permission anywhere.

## `dependabot.yml`

`github-actions` and `docker` only. Requirement 5 makes the Rust workspace, the
plugin, and the dashboard dependency-free, so a `cargo` or `npm` ecosystem
would have nothing to update and would be a standing invitation to acquire one.
What does drift is the CI supply chain: the actions the workflows pin by SHA
and the base images the Dockerfile pins by digest.

## Required checks for the ruleset

The exact contexts the owner enters into `Protect-Main`, all bound to the
GitHub Actions app. `scripts/ci/release_contract.py` holds the same list in
`REQUIRED_STATUS_CHECKS`, and `test_release_contract.py` fails if it stops
equalling the union of the expected PR-gate and CodeQL job inventories, or if
either workflow's jobs stop matching:

```text
analyze (javascript-typescript, none)
analyze (rust, none)
application
chart
container
gate
security
```

## Zero-spend guardrails

Top-level `permissions: {}` with narrow per-job grants; `persist-credentials:
false` on every checkout; GitHub-hosted `ubuntu-24.04` runners only; every
third-party action pinned to a full commit SHA with a version comment; every
third-party tool installed only through the checksum-verifying
`scripts/ci/install-tools.sh`. `scripts/ci/test_workflow_integrity.py` refuses
any workflow that breaks the pinning, permissions, `pull_request_target`, or
`persist-credentials` rules, and its allowlist ratchets shut rather than
accumulating excuses. The `container` job builds and never publishes: no
registry login, no push, no builder, an empty `DOCKER_CONFIG`, and
`contents: read` — there is no credential in it to push with. No external
service ever receives repository content.
