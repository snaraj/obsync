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
| `security` | `python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v` | The contract suites hold: seven locks, two-verdict classifier, publication state machines, governance receipt, workflow integrity, the YAML reader, the chart pin logic, the commit identity rules, the ninth image-smoke property. |
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
| `application` | `scripts/ci/makefile-invariants.sh` | `make check` and this workflow run one battery — plus the two `docker build` commands `make image` and the `container` job share, and the smoke that follows them. Both sides are read for what they RUN, never for what they mention: the Makefile's tab-indented recipe lines, and every step `run:` value resolved by `scripts/ci/workflow_runs.py` through the fail-closed YAML reader. A step or job carrying an `if:`, and a segment behind a `false &&` or a `||`, are not the battery and do not count. The check can still fail — it mutates a copy of each file thirteen ways (deleting a canonical command, naming it in a comment, neutralizing it as `true # …` or `echo '…'`, and putting it behind a `false &&`, a `||` or an `if:`) and requires the comparison to refuse every one. |
| `chart` | `helm lint chart`, `helm template smoke chart --kube-version v1.36.0` | The chart renders against the platform's Kubernetes target and satisfies its own required, closed `values.schema.json`. |
| `chart` | `python3 -B scripts/ci/chart_pins.py all` | The three rendered pins below. |
| `container` | `docker build --target server --tag obsync-gate:<sha> .` | The release stage builds, natively on the amd64 runner with no emulation, including the `cargo clippy` lint and the `cargo test --workspace --locked` battery that run INSIDE the image on Linux and the musl cross-link. Nothing is pushed and no registry is logged into; `DOCKER_CONFIG` points at an empty directory so no credential helper is consulted for the anonymous digest-pinned base-image pulls. |
| `container` | `docker create` + `docker cp` + `file` on `/out/obsyncd` | The shipped binary is a static ELF for the runner's OWN architecture — the property that lets the final image be distroless/static with no shell. Asked from outside because distroless has no shell to ask inside, and compared against `uname -m` so an emulated cross-build fails instead of passing. |
| `container` | `docker build --tag obsync-gate-full:<sha> .` | The whole Dockerfile builds: the plugin stage's own `npm ci`/build/test inside the image, the bundle stage the Release asset is exported from, and the final image with the dashboard it serves. |
| `container` | `docker image inspect` | The shipped image is `User=nonroot` with entrypoint `/usr/local/bin/obsyncd`, command `serve`, and one exposed port `8080/tcp` — the half of AGENTS.md's non-root invariant that lives in the bytes rather than in the chart. |
| `container` | `scripts/ci/image-smoke.sh obsync-gate-full:<sha>` | The shipped image SERVES, run the way README.md's quick start runs it: two FRESH named volumes, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a loopback-published port. Five properties — `/readyz` answers `{"ready":true` inside a 60 s budget, every process in the container is uid 65532, the README's own `docker cp … \| tar -xO` yields a 64-lowercase-hex setup token, the same read works on the STOPPED container, and the run carried the hardening it claims. It builds nothing; the image reference is the argument, so the gate smokes exactly what it just built. The build steps above were all green on an image that exited at first boot with `event=server_key_failed decision=exit refusal=io_error`, because the final stage declared `USER nonroot` without creating `/data/blobs` and `/data/journal` and Docker therefore created both mount points root-owned. A sixth property weakens the real key, token and roots on the same volumes to the round-8 reviewer's restored-volume shape and requires a second start to repair every class, log each repair, and log only the modes it read back. A seventh starts a second container on the same volumes while the first serves and requires it to refuse with `reason=journal_locked`, exit non-zero, and leave the first serving: `ReadWriteOnce` excludes other nodes, the server's own lock excludes a second process. An eighth presents root-owned `0755` volumes holding no root, the shape a dynamic provisioner hands a non-root workload, and requires the `unwritable` refusal with nothing created. A ninth exhausts a real blob volume — a tmpfs-backed volume the digest-pinned throwaway fills while the server serves, because a `--tmpfs` mount belongs to one container and `docker cp` into one writes past the mount — and requires `/readyz` to answer `503 not_ready` naming the volume, the log to carry `event=readiness decision=not_ready volume=blobs io=StorageFull`, the container to stay running, and readiness to return once the space does. It does NOT put a chunk through `PUT /v1/chunks/{sid}`: that is HMAC-authenticated and the smoke ships no signing client, so `scripts/ci/test_image_smoke_contract.py` pins the property's executable structure instead — the size option, the separate journal volume, the hardening, the pinned filler, the grep, and the recovery half. |
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

A third job, `dispositions`, decides what happens to the alerts those two
produce. It needs `analyze`, holds `contents: read` and `security-events:
write`, and runs on the pull request, on the main push, and on the weekly
schedule alike.

| Step | What it enforces |
| --- | --- |
| Wait for GitHub to index both analyses | Both SARIF uploads reach `processing_status: complete` (600 s budget, 15 s interval) before anything is judged. `analyze` returns when the SARIF is UPLOADED; a listing taken before indexing is empty, so without this step "no uncovered alert" would mean "no alert had arrived yet" and the job would pass on a finding nobody has seen. A `failed` upload or an exhausted budget is a refusal. |
| List the open alerts on the analysed ref | `refs/pull/<n>/merge` on a pull request, `refs/heads/main` otherwise, paginated and slurped into ONE array, plus `git ls-files` as the tracked set. |
| List main's dismissed alerts | **Push only.** A dismissal is permanent until someone changes it, so the file has to answer for the alerts that are already quiet. Without this listing an entry removed, narrowed, or never written leaves its finding silent forever and no later run looks at it again. |
| List the open alerts on the base branch | **Pull request only.** Open AND dismissed, plus the commit the base's analyses describe. GitHub's pull-request analyses are diff-informed here: the merge ref only ever carries findings inside the changed range. Run 34312223079 on `refs/pull/25/merge` returned `results=0` for both languages while `refs/heads/main` at `f67b18d` carried 78 and 1 from the identical rule packs, and main's one open alert — #81, `storage/mod.rs` — is invisible on the pull-request ref. The commit comes from the newest analysis per language category, and that record has to say it SUCCEEDED before anything is listed: `error` is a required string in GitHub's analysis schema, separate from `warning`, and a non-empty one refuses the job naming the language, the commit and the error. A record missing `error` or `commit_sha`, or carrying either as a non-string, refuses as malformed. There is NO fallback to an older healthy record — the tree that would be judged is the one this record names, and a stale success is not evidence about it. Then the two legs must agree: disagreeing legs mean there is no single tree the base's alert lines belong to, and the job stops. That agreed, error-free commit is this path's completeness evidence, which is what lets the base check below read a base dismissal's `fixed_at` stamp — agreement on a SHA alone would not. |
| Check out the base branch as a second tree | **Pull request only.** `git fetch --depth=1` and `git worktree add --detach` at that COMMIT, not the branch tip, so the line numbers are the ones the findings describe. Its `git ls-files` is written out and logged as evidence that the worktree is really the base's. LOCATION predicates (`line_is`, `line_contains`, `within: test-module`) are judged there; `reviewed_sha256` is judged against the PULL REQUEST's tree, because that is the content main will have after the merge, and so is entry validation — whether a glob names a tracked place and whether a content hash names one file are claims about the file being reviewed, so a change that adds a file and its disposition together is not refused for the base not having it yet. |
| Validate the disposition file | `security/codeql-dispositions.json` parses closed: known keys only, an exact rule id, a glob with at least one literal segment that matches a tracked file, one of CodeQL's three reasons, a single-line comment whose composition with its disposition URL still fits GitHub's 280 characters, and no `used in tests` entry over product code. |
| Reconcile main's dismissed alerts with this file | **Push only, and BEFORE the check.** A dismissed alert no entry covers is REOPENED — the one mutation that makes the state more visible, and it turns policy drift into the single failure the check already has. A dismissed alert an entry covers whose stored `dismissed_reason` or `dismissed_comment` is not this file's is re-dismissed with the file's values: the reviewed justification wins over whatever was typed. That rewrite is TWO writes — `state=open`, then `state=dismissed` — because GitHub answers a `dismissed` write to an already-dismissed alert with `Alert is already dismissed. (HTTP 400)`; each write logs `redismiss alert=N phase=reopen|dismiss`. Either write failing is fatal to that run: the step exits, every later step is skipped, and publication is blocked — a failed reopen leaves the record exactly as it was, a failure between the two leaves it open and unjustified, and the NEXT authorized run re-lists that record, revalidates it against this file and converges, without assuming the failed run completed. No error is suppressed to make a same-run repair true. An alert the analysis no longer detects is counted as `stale` and left alone: reopening it would resurrect a finding the tool says is gone, and its line number belongs to a tree nobody is judging. GitHub says that in two ways and both are honoured — the most recent INSTANCE is `fixed`, or the alert is still `dismissed` and carries a non-null `fixed_at`, the stamp GitHub writes when the current analysis stops detecting a finding it holds a dismissal for. The stamp is what earns the exemption, never the old commit alone: an UNSTAMPED dismissal whose instance sits on another commit is still refused as superseded or foreign, and so is any OPEN alert on another commit. The stamp can be read at face value because the wait-for-indexing step above has already required `processing_status: complete` for both analyses, so `fixed_at` reflects the analysis of the very commit being judged. Push run 34368935826 at `f229a46` found the shape: 33 of main's 78 dismissals stamped with their instance left on `e4aa059`, 45 unstamped on `f229a46`, and reading `fixed` alone refused the run before it wrote anything (issue #29). The step then re-lists main's open alerts, so anything it reopened is in front of the check that follows, and logs `reconcile reopened=N redismissed=N unchanged=N stale=N`. The first push after this train lands will re-dismiss most of the 78 existing acceptances, because their hand-typed comments are not the composed ones. |
| Refuse any open alert no disposition covers | **The gate.** Every open alert is classified covered or uncovered by rule, glob, and scope — `line_contains` reads the line CodeQL actually flagged; `within: test-module` accepts only a Rust line at or after the file's TRAILING test module, which is a top-level `#[cfg(test)]` whose next line opens a `mod` that is the file's last top-level item. An attribute on any other item opens nothing: `api/auth.rs` carries `#[cfg(test)]` on a fake clock at line 59 and opens its module at 464, and reading the first attribute as the marker would make every product line below 59 dismissible as a test vector. Any uncovered alert fails the job and is named. No `if:`: it runs on the pull request and on main alike. |
| Refuse any base-branch alert this file stops covering | **Pull request only.** THIS pull request's disposition file — read from the workspace, never the base branch's own copy, which is the version being replaced — against the base branch's open alerts and the base branch's tree. Narrowing or deleting an entry main relies on fails here, before the merge. The historical rule applies here exactly as it does on a push, through the same predicate: a base dismissal GitHub has stamped `fixed_at`, on the base ref and from this analysis key, is `stale`. Completeness is established differently for this caller and that is the point — this pull request's own SARIF uploads say nothing about `main`, so what makes the stamp readable is the BASE analyses' own records: the newest analysis per language category, each reporting an empty `error`, with the two legs agreeing on one commit, which is the commit judged and the commit the base tree is checked out at. An errored or malformed record refuses before any base alert is listed. |
| Dismiss every covered alert and require main to hold none | `push` only. Dismisses each covered alert through the API with the entry's reason and `"<comment> Disposition: <issue url>"`, then re-lists open alerts on main and fails, naming them, if any remain. |

Two bindings make those verdicts mean what they say. **Every judged alert names
the commit and the analysis it came from**: `most_recent_instance.commit_sha`
must equal the commit being judged and `analysis_key` must be
`.github/workflows/codeql.yml:analyze`, so a superseded or foreign record cannot
supply a line number to a checkout that never produced it. The single exemption
is an instance the tool itself reports as `fixed`: nothing is judged from it, so
there is nothing to bind, and it is skipped and counted rather than refused. **Every acceptance
over product code names what was reviewed**: `line_is` (the exact source line,
compared after trimming, equality not substring) or `reviewed_sha256` (the
sha256 of the tracked file, which must then be one file and not a glob). A
`line_contains` token alone over product code is refused — it accepts whatever a
later edit puts on a line carrying that token. `reviewed_sha256` is verified on
EVERY run whether or not an alert touches the file, so an edit to a reviewed
printer cannot land without the same pull request re-reading it and moving the
hash.

The invariant is that **`main` holds zero open code-scanning alerts**, enforced
rather than checked, and the only way an alert goes quiet is a fix or a
disposition entry that arrived through a reviewed PR carrying its own issue.
Nothing is excluded from analysis — no `query-filters`, no `paths-ignore`, no
`config-file` — so accepting a finding is always a written reason, never a
narrower scan. An entry that matched no alert in a listing is reported as
`stale`, informational: on a pull-request ref, where the alerts a disposition
covers are normally already dismissed, every entry reports stale.

Adding a disposition: open an issue that carries the reasoning, then a PR that
adds one entry naming that issue as its `disposition`, with the narrowest glob
and scope that cover the alert. `scripts/ci/codeql_dispositions.py` is offline
and unit-tested; the workflow does the `gh api` I/O and the script decides.
`dispositions` is in the CodeQL inventory `release_contract.py` authorizes a
release against, so a version whose alerts were never judged cannot be
published.

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
dispositions
gate
security
```

`dispositions` is new in v0.1.6, and the ORDER of adding it to `Protect-Main`
matters — though not for the reason it is tempting to give. A pull request whose
branch predates the job CAN report it: `pull_request` runs the workflow file
from the pull request's own branch, which is why this train's first run reported
`dispositions` on a base that had never seen it. The real reason is the other
direction: every OPEN pull request whose branch does NOT carry the job would
become unmergeable the moment the context is required, and would stay that way
until rebased. So the requirement and the job land together: (1) merge this
train, (2) the owner adds `dispositions` to the ruleset, (3)
`release_contract.py settings-preflight` agrees with `REQUIRED_STATUS_CHECKS`
again. Between (1) and (2) the job still runs and still fails red; what is
missing is only the ruleset's refusal to merge around a red one.

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
