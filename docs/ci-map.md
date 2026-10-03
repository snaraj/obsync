# CI map

*Internals, for contributors and reviewers.*

Dated 2026-09-20. What each job runs, what that proves, and the exact contexts
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
| `security` | `python3 -B -m unittest discover -s scripts/ci -p 'test_*.py' -v` | The contract suites hold: seven locks, two-verdict classifier, publication state machines, governance receipt, workflow integrity, the YAML reader, the chart pin logic, the commit identity rules, the ninth image-smoke property, and the `versions.json` ledger this head publishes under (`test_versions_json.py` reads the committed `versions.json` and `manifest.json`, so a head whose installer ledger contradicts its own manifest floor cannot reach `main`), and the README capture set. `test_capture_contract.py` establishes exactly five things and claims nothing else: each committed capture is a self-consistent PNG datastream (signature, chunk lengths, four-letter types, CRC-32, `IHDR` first, empty `IEND` last, no trailing byte); its `IDAT` bodies are one complete deflate stream that inflates to exactly the `height * (1 + rowbytes)` grid its header declares, with a legal filter byte on every row, under a 64 MiB budget; each file is at most 409,600 bytes; README.md's declared capture section displays the five, each alone on its line, in order, with no construct that could render an image as text; and the folder, the README and the convention's table name the same five. It reads no pixels: what a capture CONTAINS is a human reading every region before the commit. |
| `security` | `scripts/ci/commit_identity_contract.py` over the event's range | Author and committer are the owner noreply identity, no trailer of any kind, and the last line is a roster signature. The secret scans read blobs and cannot see any of this. |
| `security` | `release_contract.py transition` over the event's range | Every commit in `base..head` advances all seven locks exactly one SemVer step -- one patch, one minor, or one major -- or the whole range is confined to the documentation allowlist and advances nothing. |
| `security` | `upload-artifact` of the transition verdict (main pushes) | The orchestrator learns which RANGE this push validated; the push base is unrecoverable from git alone once later merges land. |
| `security` | `scripts/ci/install-tools.sh` | gitleaks, helm, trivy, cosign, and actionlint arrive at pinned versions with SHA-256-verified bytes and assert their own version afterwards. |
| `security` | `actionlint` | The workflows parse and their shell bodies pass shellcheck. |
| `security` | `trivy fs --scanners vuln --severity HIGH,CRITICAL` | No high or critical vulnerability in the source tree. Requirement 5 keeps this near-empty by construction; the same policy string is recorded in the release evidence manifest. |
| `security` | `gitleaks git` (full history) and `gitleaks dir` (working tree) | No secret in any blob, in history or in the tree. `.gitleaks.toml` uses the default rule set whole and carries exactly one path allowlist, for `plugin/test/fixtures/crypto.json` -- sentinel-derived cross-implementation vectors whose root input is the byte sequence 00..1f and which are regenerable in one command. It is one FILE wide, not one directory or one rule, and a probe confirms the same payload in a neighbouring fixtures file is still found. |
| `application` | `rustup toolchain install` then exact version assertions | The runner runs the toolchain `rust-toolchain.toml` names (1.98.0 with rustfmt, clippy, llvm-tools) and Node 26.10.0 / npm 11.19.1 — not whatever the runner image shipped. |
| `application` | `cargo fmt --all --check` | Formatting is decided, not argued. |
| `application` | `cargo clippy --workspace --all-targets -- -D warnings` | No lint survives, in tests as well as in the library. |
| `application` | `cargo test --workspace` | The Rust battery, including the doctrine pins. |
| `application` | `./scripts/ci/coverage.sh` against `RUST_COVERAGE_FLOOR` | Line coverage meets the ratchet-only floor (requirement 9), measured with the pinned `llvm-tools` component and no crate. The floor is ONE fact in three places -- AGENTS.md, the Makefile, and this workflow's env -- and `test_coverage_floor.py` fails the gate if they disagree, if any of the three stops declaring it, or if the step that consumes it is removed. |
| `application` | `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build`, `npm test` in `plugin/` | The plugin builds from its lockfile with no install hook executed, and its tests pass under `node --test`. |
| `application` | `node cli/build.mjs`, `node cli/test.mjs` | The native filesystem adapters build into the CLI; real processes exercise local plans, crash recovery, confinement, installation and explicit export refusal. Passing-test floors exclude skips. |
| `application` | `node --test dashboard/test/` | The dashboard's pure functions hold. The dashboard has no `package.json` by design, so this needs no install step. |
| `application` | `scripts/ci/makefile-invariants.sh` | `make check` and this workflow run one battery — plus the two `docker build` commands `make image` and the `container` job share, and the smoke that follows them. Both sides are read for what they RUN, never for what they mention: the Makefile's tab-indented recipe lines, and every step `run:` value resolved by `scripts/ci/workflow_runs.py` through the fail-closed YAML reader. A step or job carrying an `if:`, and a segment behind a `false &&` or a `||`, are not the battery and do not count. The check can still fail — it mutates a copy of each file thirteen ways (deleting a canonical command, naming it in a comment, neutralizing it as `true # …` or `echo '…'`, and putting it behind a `false &&`, a `||` or an `if:`) and requires the comparison to refuse every one. |
| `chart` | `helm lint chart`, `helm template smoke chart --kube-version v1.36.0` | The chart renders against the platform's Kubernetes target and satisfies its own required, closed `values.schema.json`. |
| `chart` | `python3 -B scripts/ci/chart_pins.py all` | The seven rendered pins below. |
| `container` | `docker build --target server --tag obsync-gate:<sha> .` | The release stage builds, natively on the amd64 runner with no emulation, including the `cargo clippy` lint and the `cargo test --workspace --locked` battery that run INSIDE the image on Linux and the musl cross-link. Nothing is pushed and no registry is logged into; `DOCKER_CONFIG` points at an empty directory so no credential helper is consulted for the anonymous digest-pinned base-image pulls. |
| `container` | `docker create` + `docker cp` + `file` on `/out/obsyncd` | The shipped binary is a static ELF for the runner's OWN architecture — the property that lets the final image be distroless/static with no shell. Asked from outside because distroless has no shell to ask inside, and compared against `uname -m` so an emulated cross-build fails instead of passing. |
| `container` | `docker build --tag obsync-gate-full:<sha> .` | The whole Dockerfile builds: the plugin stage's own `npm ci`/build/test inside the image, the bundle stage the Release asset is exported from, and the final image with the dashboard it serves. |
| `container` | `docker image inspect` | The shipped image is `User=nonroot` with entrypoint `/usr/local/bin/obsyncd`, command `serve`, and one exposed port `8080/tcp` — the half of AGENTS.md's non-root invariant that lives in the bytes rather than in the chart. |
| `container` | `scripts/ci/image-smoke.sh obsync-gate-full:<sha>` | The shipped image SERVES, run the way README.md's quick start runs it: two FRESH named volumes, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a loopback-published port. Five properties — `/readyz` answers `{"ready":true` inside a 60 s budget, every process in the container is uid 65532, the README's own `docker cp … \| tar -xO` yields a 64-lowercase-hex setup token, the same read works on the STOPPED container, and the run carried the hardening it claims. It builds nothing; the image reference is the argument, so the gate smokes exactly what it just built. The build steps above were all green on an image that exited at first boot with `event=server_key_failed decision=exit refusal=io_error`, because the final stage declared `USER nonroot` without creating `/data/blobs` and `/data/journal` and Docker therefore created both mount points root-owned. A sixth property weakens the real key, token and roots on the same volumes to the round-8 reviewer's restored-volume shape and requires a second start to repair every class, log each repair, and log only the modes it read back. A seventh starts a second container on the same volumes while the first serves and requires it to refuse with `reason=journal_locked`, exit non-zero, and leave the first serving: `ReadWriteOnce` excludes other nodes, the server's own lock excludes a second process. An eighth presents root-owned `0755` volumes holding no root, the shape a dynamic provisioner hands a non-root workload, and requires the `unwritable` refusal with nothing created. A ninth exhausts a real blob volume — a tmpfs-backed volume the digest-pinned throwaway fills while the server serves, because a `--tmpfs` mount belongs to one container and `docker cp` into one writes past the mount — and requires `/readyz` to answer `503 not_ready` naming the volume, the log to carry `event=readiness decision=not_ready volume=blobs io=StorageFull`, the container to stay running, and readiness to return once the space does. While the volume is full it also sends one signed chunk through `PUT /v1/chunks/{sid}` with `scripts/ci/api_flow.py full` (plain HTTP to the loopback port, and nowhere else) and requires `507 storage_full` and an empty `v1/tmp` (issue #291). `scripts/ci/test_image_smoke_contract.py` pins the property's executable structure — the size option, the separate journal volume, the hardening, the pinned filler, the grep, the write and its residue check, and the recovery half. |
| `gate` | asserts each job's result | One aggregate required context that names every job, so a job renamed, conditioned out, or removed turns the gate red instead of leaving a required check that never reports. |

### What the chart pins prove

They read the COMPLETE render — every template, no `--show-only` — through
`scripts/ci/miniyaml.py`, a fail-closed reader that refuses every construct it
does not fully model. An unparseable render is a FAILED pin, never a passed
one, and expectations come from `chart/values.yaml` so the peer identity and
the storage classes are stated in exactly one place.

- **ingress** — the NetworkPolicy admits exactly the `ingress.peers` values
  name, each pod by namespace **and** app label **and** instance and each
  address block as written, on the service port only, and denies all egress.
  The shipped default names none and renders NO rule, never one with an empty
  `from`. The single-peer fields of earlier releases render the rule they
  always did. A pod peer missing or blanking its instance, a partial
  single-peer form, a pod and a block in one entry, and a `/0` block or trusted
  network are refused by the schema. Comparing the whole `spec.ingress`
  sub-tree rather than counting `- from:` lines is what catches a second rule
  with no `from` (`- {}` renders an allow-all), and requiring exactly one
  NetworkPolicy document is what catches a second policy in another template,
  since ingress rules are additive.
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
  renders `repository:tag@digest` from any registry path, a mirror included,
  and never without the digest. Scheduling fields, pull secrets and pod labels
  pass through without touching that context, and a pod label the selectors
  match on is refused.
- **readiness** and **environment** — `deploymentReady` gates the replica
  count and nothing else; the process environment is one the server parses.
- **kubernetes** — the chart renders on the lowest minor `Chart.yaml` claims,
  bare and with the suffixes managed clusters report, and on the newest, and
  refuses the minor below.
- **platform** — with `platform.annotationDomain` empty, the shipped default,
  no object carries any annotation; with a domain set, exactly
  `<domain>/deployment-ready` on the Deployment and `<domain>/volume-capacity`
  on each claim, mirrors included; a domain that is not a lower-case DNS
  subdomain of at most 253 characters, or that ends in `kubernetes.io` or
  `k8s.io`, fails the render with a message naming it.
  `scripts/validation/platform_annotation_mutations.py` is its kill matrix.

## `codeql.yml` — pull requests, pushes to `main`, weekly cron

Two matrix jobs, both `build-mode: none`. **Rust is analysed**: `rust` is a
built-in CodeQL language at the pinned action version — `src/languages/
builtin.json` at `2892aa5` (v4.38.2) lists `actions, cpp, csharp, go, java,
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
| Reconcile main's dismissed alerts with this file | **Push only, and BEFORE the check.** A dismissed alert no entry covers is REOPENED — the one mutation that makes the state more visible, and it turns policy drift into the single failure the check already has. A dismissed alert an entry covers whose stored `dismissed_reason` or `dismissed_comment` is not this file's is re-dismissed with the file's values: the reviewed justification wins over whatever was typed. That rewrite is TWO writes — `state=open`, then `state=dismissed` — because GitHub answers a `dismissed` write to an already-dismissed alert with `Alert is already dismissed. (HTTP 400)`; each write logs `redismiss alert=N phase=reopen|dismiss`. Either write failing is fatal to that run: the step exits, every later step is skipped, and publication is blocked — a failed reopen leaves the record exactly as it was, a failure between the two leaves it open and unjustified, and the NEXT authorized run re-lists that record, revalidates it against this file and converges, without assuming the failed run completed. No error is suppressed to make a same-run repair true. An alert the analysis no longer detects is counted as `stale` and left alone: reopening it would resurrect a finding the tool says is gone, and its line number belongs to a tree nobody is judging. GitHub says that in two ways and both are honoured — the most recent INSTANCE is `fixed`, or the alert is still `dismissed` and carries a non-null `fixed_at`, the stamp GitHub writes when the current analysis stops detecting a finding it holds a dismissal for. The stamp is read for its presence — null or a non-empty string — and its syntax is deliberately not validated; what guards the exemption is the ref, the analysis key and the alert's own state. The stamp is what earns the exemption, never the old commit alone: an UNSTAMPED dismissal whose instance sits on another commit is still refused as superseded or foreign, and so is any OPEN alert on another commit. The stamp can be read at face value because the wait-for-indexing step above has already required `processing_status: complete` for both analyses, so `fixed_at` reflects the analysis of the very commit being judged. Push run 34368935826 at `f229a46` found the shape: 33 of main's 78 dismissals stamped with their instance left on `e4aa059`, 45 unstamped on `f229a46`, and reading `fixed` alone refused the run before it wrote anything (issue #29). The step then re-lists main's open alerts, so anything it reopened is in front of the check that follows, and logs `reconcile reopened=N redismissed=N unchanged=N stale=N`. The first push after this train lands will re-dismiss most of the 78 existing acceptances, because their hand-typed comments are not the composed ones. |
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
  or verifies the annotated `X.Y.Z` release tag at the exact source SHA, builds and
  pushes `linux/amd64` and `linux/arm64`, **scans the resolved digest for
  HIGH/CRITICAL before signing it**, signs image and OCI chart keyless,
  substitutes the resolved digest into the chart values before packaging,
  exports the plugin bundle from the same Dockerfile stage the image copies,
  exports the `server-dist` stage once per platform and packs the two static
  server tarballs deterministically (from 1.1.4), attests the plugin files and
  both tarballs with build provenance, and publishes one immutable Release
  carrying the deterministic evidence manifest, the bundle, the plugin files
  and the tarballs.

Position is the contract in two places: the vulnerability gate sits between
digest resolution and `cosign sign`, so a failing digest never receives this
repository's release identity; and the chart digest substitution sits after
signing and before the chart classifier, so the classifier's re-package and the
publish step's package read the identical tree.

## `release-audit.yml` — weekly, read-only

Re-binds the newest immutable Release: the manifest bytes, the notes, the
Release record, the successful run, the annotated tag, both registry aliases
still resolving to the recorded digests, both cosign signatures, the plugin
bundle's SHA-256, from 1.1.4 both server tarballs (bytes against the evidence,
and their build provenance), and a fresh HIGH/CRITICAL scan of the shipped image against
today's vulnerability database. It holds no write permission anywhere.

## `docs-site.yml` — pull requests, pushes to `main`, manual dispatch

| Job | Command | What it proves |
| --- | --- | --- |
| `build` | `python3 -m mkdocs build --strict` | The documentation site renders: every nav entry names a file that exists, every relative link resolves, every referenced image was committed. `--strict` makes each MkDocs warning a failure, so a broken link reddens this check instead of shipping a 404 |
| `deploy` | `actions/configure-pages`, `actions/deploy-pages` | Pushes to `main` publish the built site to GitHub Pages. It holds `pages: write` and `id-token: write` and no `contents` grant at all, so it cannot touch the repository |

`Docs site / build` is NOT one of the eight contexts in
`REQUIRED_STATUS_CHECKS`, so what stops a red docs build from merging is the
Ready rule ("every check green at the exact head", AGENTS.md) rather than
branch protection. Adding it to `Protect-Main` is the owner's call and has the
same open-pull-request cost every new required context has (`dispositions`,
below).

The build inputs come from `docs/requirements.txt` with
`pip install --require-hashes --no-deps --only-binary=:all:`: the file carries
the whole transitive closure at exact versions AND the sha256 of every wheel,
so pip verifies the bytes, resolves nothing, refuses a requirement carrying no
hash, and runs no package's own build code on the runner. The hashes are the
CPython 3.12 linux/amd64 wheels, which is the interpreter the workflow pins and
the platform its runner is.

`scripts/ci/test_docs_site_workflow.py` pins this workflow's own boundaries,
which the four generic rules in `test_workflow_integrity.py` say nothing about:
the `build` job's permissions are exactly `contents: read` (it runs a pull
request's own `mkdocs.yml` and must not hold publishing authority), both the
artifact upload and the `deploy` job require `push` AND `refs/heads/main`,
`configure-pages` carries no `enablement:` input, the install keeps all three
flags, `mkdocs build` keeps `--strict`, every requirement carries a hash, and
`mkdocs.yml` keeps `theme.font: false` — without which Material fetches Roboto
from Google's CDN on every page view, which requirement 1 forbids. Each rule
has a mutation that kills it.

**It is not in the release chain, and that is the design.**
`release-after-main.yml` fires on a completed `PR gate` run and nothing else,
and the publisher's authorization job reads the job inventories of
`pr-gate.yml` and `codeql.yml` alone (`EXPECTED_MAIN_JOBS` and
`EXPECTED_CODEQL_JOBS` in `scripts/ci/release_contract.py`, with
`test_release_contract.py` pinning each to its workflow's jobs). A workflow of
its own adds no job to either inventory, so nothing about the release
authorization moves. A site build added as a job in `pr-gate.yml` WOULD have
moved it, and would have made a documentation dependency a gate on publishing
the server.

`deploy` runs only once the repository owner has turned GitHub Pages on with
source "GitHub Actions". `configure-pages` is called with no `enablement:`
input: if Pages is off, the job fails and says so rather than turning a
publishing surface on by itself.

## `compose-e2e.yml` — pull requests, pushes to `main`, manual dispatch

| Job | Command | What it proves |
| --- | --- | --- |
| `compose` (amd64, arm64) | `docker build`, then `scripts/ci/compose-e2e.sh` | The commands [`docs/server.md`](server.md) SHOWS work against the image this commit builds, on BOTH architectures natively, arm64 included. The `up`, the root-certificate export and the setup-token read are read out of that page by `scripts/ci/docs_blocks.py`, with only the digest, the hostname and the bind address substituted, so a page edited without its gate fails here. It then proves what those commands exist for: `/readyz` through the terminator over TLS; `/login?token=…` answering 302 with a session that reads `/v1/admin/overview` where no session reads 401; and, through `scripts/ci/api_flow.py`, first boot with the token, a second device paired through the API, one file pushed and pulled back on that second device, `missing_auth`/`bad_signature`/`stale_timestamp`/`replayed_nonce` each refused by name, and all of it still there after the stack is restarted |

The token is masked with `::add-mask::` before it is used and is printed
nowhere. Each leg runs on the `ubuntu-24.04` runner image for its
architecture, which is the host distribution the Compose path is exercised on;
the binary's independence from the distribution underneath it is
`arch-matrix.yml`'s eight legs. An `if: always()` step removes every object
carrying the compose project label, so a cancelled run leaves the next one a
clean runner.

## `helm-e2e.yml` — pull requests, pushes to `main`, manual dispatch

| Job | Command | What it proves |
| --- | --- | --- |
| `helm` | `install-tools.sh`, `install-kind.sh`, `docker build`, then `scripts/ci/helm-e2e.sh` | The chart installs and SERVES. A throwaway `kind` cluster at the node image pinned beside kind; the two node directories prepared `0700` and owned by 65532, the StorageClass and both `local` PersistentVolumes, the values file, the TLS front and the setup-token read, all read out of [`docs/kubernetes.md`](kubernetes.md); the image loaded and deployed by the digest containerd actually holds, with `pullPolicy: Never` so the cluster can only run those bytes; both claims `Bound`, the Deployment `Available`, `/readyz` answered through a port-forward AND through the documented terminator over HTTPS, by its port-forward and by its Service's address from the node; then the same `api_flow.py` device flow through that terminator — including a file larger than a stock proxy's 1 MiB body ceiling — and a `helm upgrade` on the digest followed by a `helm rollback`, after which the account, both devices and the file are still there. Last, `scripts/ci/np-probe.sh` opens connections from three one-shot pods: one carrying the three peer labels the values name connects, one with another instance label and one in another namespace are refused. kind's own network plugin (kindnetd) enforces NetworkPolicy, so these are the cluster's refusals, not the render's |
| `kube-versions` | `install-tools.sh`, then `scripts/ci/chart-kube-versions.sh` | The chart renders for every minor its `kubeVersion` claims, from the floor to the kind node image's, in the spellings managed clusters report (`v1.36.3-eks-…`, `v1.36.3-gke.…`, `v1.36.3+k3s1`), and `helm template` REFUSES the version just below the floor, which is what makes the other lines mean the floor is enforced |

What it does not prove, stated rather than implied: the DNS-01 issuance,
because the leaf the terminator serves is one the job issues. What the
terminator step does prove is the wiring a first activation of this chart gets
wrong — the three peer labels, the upstream Service, and the body ceiling. An
`if: always()` step deletes the cluster whatever happened to the script.

## `proxy-matrix.yml` — pull requests, pushes to `main`, manual dispatch

| Job | Command | What it proves |
| --- | --- | --- |
| `proxy` (caddy, nginx, traefik, haproxy) | `docker build`, then `scripts/ci/proxy-e2e.sh <image> <proxy>` and `scripts/validation/proxy_matrix.sh <image> <proxy>` | `deploy/proxies/compose.yml`, run as shipped with the proxy's profile, keeps out of the sync path's way. `proxy-e2e.sh` adds only a second network for the client, then from a client container there `api_flow.py` enrols, pairs and syncs, and proves: an 8 MiB + 16 B chunk up and back, a full 32 MiB `POST /v1/chunks/get` answer in order, a 55 s long poll held to its end (a 30 s proxy timeout answers 504 here) and a long poll woken by a write within 5 s rather than at the end of its wait, the client's own address recorded although it sent a forged `X-Forwarded-For`, and a direct connection to the server's port refused from where the client stands. `proxy_matrix.sh` then proves a client's forged `X-Forwarded-For` and `Forwarded` are not believed through the proxy or around it, and the edge mode's headers are admitted only from the trusted peer; its own long poll is skipped (`SKIP_LONGPOLL=1`) because the first script holds the same poll |
| `proxy-arm64` | the same, nginx, on `ubuntu-24.04-arm` | The same properties natively on arm64 |

## `generic-paths.yml` — nightly, manual dispatch, and pull requests that change what it runs

| Job | Command | What it proves |
| --- | --- | --- |
| `binary` | `docker build --target server-dist`, then `scripts/ci/binary-e2e.sh` | The static server tarball's tree with no container: the binary, dashboard and plugin, installed as its own `obsyncd.service` header says, and that unit run AS SHIPPED with only its names moved to the run's (user, `/opt`, `/var/lib`, `/etc`), so every hardening line it carries is the one that runs; systemd makes both state directories `0700` under a root-owned parent, and the server listens on `127.0.0.1:8080` and nowhere else. The runner's own Ubuntu nginx binary is in front, as `www-data` in a unit of its own, with `deploy/proxies/nginx/nginx.conf` (its upstream, certificate and temporary paths moved, every directive as shipped, on Ubuntu 24.04's nginx 1.24), passing `nginx -t`; then `api_flow.py` enrol and the proxy properties (without the bypass probe, since client and server share the host), and a restart that keeps everything |
| `podman` | `docker build`, `docker save`, then `scripts/ci/podman-e2e.sh` | The unmodified Compose file under ROOTLESS Podman (`podman compose` with the runner's Compose v2 plugin as its provider, netavark and aardvark-dns for name resolution), published on 8080/8443; `/readyz` through Caddy, the sync flow, a restart |
| `k3d` | `install-tools.sh`, `install-k3d.sh`, `docker build`, then `scripts/ci/k3d-e2e.sh` | The chart on k3s as k3s ships: local-path volumes, which the server REFUSES as provisioned (`reason=writable_by_others`) until the documented administrator step (chown to 65532, `0700`, on the node) is taken; k3s's own Traefik as the ingress, its labels read off the running Deployment into the peer values; the sync flow through it; the NetworkPolicy enforced by k3s's controller (`np-probe.sh`); a replacement pod on the same volumes |
| `kind-ipv6` | `helm-e2e.sh` with `OBSYNC_E2E_IP_FAMILY=ipv6` | The whole Kubernetes guide on an IPv6-only cluster, where a server listening on the IPv4 wildcard alone never answers its startup probe; the chart's `[::]` listener is what this leg holds, and the terminator runs with the IPv6 `listen` line the page tells an IPv6 cluster to uncomment, answering through its Service's IPv6 address |

## `desktop-matrix.yml` — nightly, manual dispatch, and pull requests that change the plugin or these harnesses

| Job | Command | What it proves |
| --- | --- | --- |
| `obsidian-linux (none)`, `obsidian-linux (gnome-keyring)` | the plugin built with `npm`, `docker build`, for the second `scripts/ci/install-keyring.sh` (GNOME Keyring from pinned Ubuntu snapshot packages), then `scripts/ci/proxy-e2e.sh <image> caddy --then scripts/ci/obsidian-e2e.sh` | The plugin inside the REAL Obsidian, through `deploy/proxies/compose.yml`'s Caddy: the official AppImage (pinned by SHA-256) under Xvfb, two instances with their own `--user-data-dir` and their own `HOME`, each trusting the throwaway authority through an NSS database of its own and nothing else. `scripts/ci/obsidian-drive.mjs` drives them over the DevTools port: the vault trusted, Server URL, the setup token and the recovery-phrase check on the first, the pairing code carried to the second and approved, then notes both ways, a rename, a nested folder and an empty folder, read off the other instance's disk, and ten timed edits (B2 end to end). Then both instances are restarted on the same directories and must be paired again and carry a note, from the keys Obsidian's secret storage kept: with no keyring (the runner as it comes) it must report no encryption and hold them as plain JSON; with each instance started through `scripts/ci/obsidian-session.sh` (a session bus of its own, GNOME Keyring unlocked from its own `HOME`, a GNOME desktop named), it must report `gnome_libsecret`, hold them encrypted, and show no unencrypted-storage warning. The warning Obsidian shows without a keyring is recorded. A third instance with no trust must be refused. The token is read from a file and deleted; the pairing code and the phrase are never printed |
| `obsidian-macos` | the plugin, `cargo build --release -p obsyncd`, then `scripts/ci/obsidian-host.sh` | The same journeys with the official dmg, the server built natively, Caddy 2.10.2 (pinned) in front with `deploy/proxies/caddy/Caddyfile` (its paths, port and upstream moved), and the authority in the System keychain |
| `static-binary` | `docker build --target server`, the binary uploaded | The static linux/amd64 server for the Windows leg, from this commit |
| `obsidian-windows` | the plugin, that binary, then `scripts/ci/obsidian-host.sh` (Git Bash) | The same journeys with the official installer run silently, the server under WSL 1 in an Alpine distribution imported for the run, Caddy in front, the authority in the machine Root store; plus a rename by capitalisation alone, a note moved to the trash, and an edit to a note another process holds open |
| `plugin-tests` (windows-2025, macos-15) | `npm ci`, `npm run build`, `npm test` | The plugin suite on NTFS and APFS, not only on the ext4 of the gate |

## `cli-native.yml` — pull requests, main pushes and manual dispatch

The CLI process suite runs on `ubuntu-24.04`, `ubuntu-24.04-arm`, `windows-2025`
and `macos-15`, using pinned Node 26.10.0 / npm 11.19.1. Windows additionally runs the public installer and context
journey under ordinary disposable accounts, including recovery after real
process termination. Export remains unsupported; these metadata operations
do not establish credential custody for the later authenticated slice. Publisher provenance and public
download/install acceptance remain separate release checks.

## `bench.yml` — nightly, manual dispatch, and pull requests that change the harness

| Job | Command | What it proves |
| --- | --- | --- |
| `bench` (amd64, arm64) | `docker build`, then `scripts/ci/bench.sh` | Nothing: it MEASURES. [Benchmarks](benchmarks.md) B1, B2 (wire), B3 and B7 against the Compose deployment, with the server's CPU, memory, bytes written and fsync calls read from its own `/proc` entry; full scale on the schedule, smoke scale on a pull request. The results are the run's artifact for 90 days and the step summary; nothing is committed |

CLI native acceptance is in the release chain: publisher authorization waits
for the successful exact-source main run and requires all four native jobs.
The other workflows above remain outside that chain, for the reason
`docs-site.yml` gives. Adding a branch-protection required check remains an
owner setting; publication authorization is enforced separately in source.

## `arch-matrix.yml` — pull requests, pushes to `main`, manual dispatch

| Job | Command | What it proves |
| --- | --- | --- |
| `native` (amd64, arm64) | `docker build --target server`, `file`, `docker build`, `docker image inspect` | Each architecture builds on its OWN runner, never under emulation. The `server` stage runs `cargo clippy --workspace --all-targets --locked` and `cargo test --workspace --locked`, so this IS the workspace suite on each architecture; the shipped binary is then asserted to be a statically linked ELF for that architecture, and the full image to be nonroot with the shipped entrypoint |
| `distributions` (2 × 4) | `scripts/ci/distro-smoke.sh` | The binary each architecture built loads and serves on Debian, Ubuntu, Fedora and Alpine, every image pinned by digest. It is a static musl build with no libc to find at runtime, so these eight legs are the evidence for that rather than a sentence claiming it |

`ubuntu-24.04-arm` is a GitHub-hosted runner, free for public repositories,
which is what makes the arm64 half of requirement 14 provable BEFORE a merge
instead of first at publication, here and in `compose-e2e.yml`. The amd64 half of `native` deliberately
overlaps the gate's `container` job: one set of steps proving both
architectures is worth more than a smaller matrix proving them differently.

**None of the three is in the release chain**, for the reason `docs-site.yml`
gives: `release-after-main.yml` fires on a completed `PR gate` run and nothing
else, and the publisher authorizes against the job inventories of
`pr-gate.yml` and `codeql.yml` alone. A workflow of its own adds a job to
neither. Whether any of them becomes a REQUIRED check is the owner's ruleset
decision; until it is entered into `Protect-Main` a red run here does not block
a merge, and the list below is unchanged.

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
false` on every checkout; GitHub-hosted runners only -- `ubuntu-24.04`,
`ubuntu-24.04-arm`, `macos-15` and `windows-2025`, all free for public
repositories; every third-party action pinned to a full commit SHA with a
version comment; every third-party tool installed only through a
checksum-verifying installer (`scripts/ci/install-tools.sh`,
`scripts/ci/install-kind.sh` and `scripts/ci/install-k3d.sh` for the jobs that
create a cluster), and every other download -- Obsidian, Caddy, the Alpine
root filesystem, strace -- refused by the script that fetches it unless its
SHA-256 matches the pin beside it. Two exceptions are stated rather than
hidden: the Podman job's `netavark` and `aardvark-dns` come from Ubuntu's
archive at exact versions, checked by apt against the archive's signed index,
and k3d starts its own helper image at the tag of its pinned release.
`scripts/ci/test_workflow_integrity.py` refuses
any workflow that breaks the pinning, permissions, `pull_request_target`, or
`persist-credentials` rules, and its allowlist ratchets shut rather than
accumulating excuses. The `container` job builds and never publishes: no
registry login, no push, no builder, an empty `DOCKER_CONFIG`, and
`contents: read` — there is no credential in it to push with. No external
service ever receives repository content.
