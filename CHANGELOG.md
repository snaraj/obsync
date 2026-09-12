# Changelog

All notable changes to obsync are recorded here. The format follows
Keep a Changelog; versions follow SemVer. Every artifact-classified merge
advances exactly one patch (AGENTS.md, requirement 10).

## 0.1.14 - Unreleased

- Return a failed process status for incomplete check and export reports.
- Verify ciphertext references from every retained version during offline checks,
  including missing history-only chunks, and count each verified chunk once.

## 0.1.13 - Unreleased

- Use Private Sync as the community plugin display name and link the maintainer profile.
- Compile against the official Obsidian 1.7.2 API declarations and declare the same minimum application version.

## 0.1.12 - Unreleased

- Use the distinct `obsync-private-sync` installation and pairing-link identity
  while retaining the Obsync display name. Native installs keep their own
  settings; no other plugin folder or protocol action is adopted. Release
  verification preserves the original ID through 0.1.11 and requires the new
  ID thereafter.

## 0.1.11 - Unreleased

- Prepare native installation and updates through Obsidian's Community
  Plugins browser. Keep one root manifest, publish the three individual
  plugin files from the same build as the ZIP, and bind every asset in v2
  release evidence. New GitHub tags match the unprefixed plugin version;
  image tags retain their prefix. Existing immutable releases retain their
  original audit contract. Directory acceptance and device validation remain
  separate prerequisites for production use.
- Align the commit-signature validator with the documented GPT-6 lane while
  retaining exact-match, identity and trailer refusals.
- Add a folder selection saved only on this device. Existing dedicated
  vaults retain whole-vault sync; selected folders admit only descendants,
  and an explicit empty selection syncs no files. Scoped scans start at the
  selected folders. Push, pull, on-demand downloads, remembered rename and
  deletion sources, conflict copies and merge history obey the selection
  before file access. Invalid persisted selections refuse loading.
- Saving a narrower selection waits for active transfers, preserves files
  and state, and never rewinds the feed. Queued renames remain publishable
  after restart. Expansion after a device has sync history is refused;
  move local files into an already selected folder and run Sync now to add
  content within the same vault. The selection does not revoke access to
  previously shared content or sandbox Obsidian, its plugins or the local OS.
- Complete native folder-selection saves without returning a thenable UI
  component to a Promise continuation, including handled save failures.
- Disabling the plugin cancels pending startup and folder-change
  continuations, so a delayed transfer or local save cannot restart sync
  after unload. Stale startup results cannot replace a newer engine or its
  status; an already-issued local write may finish and must be checked after
  restart.
- Add **Restore from history** to the native command palette. It browses
  retained versions, including deleted notes, with a separate bounded read
  cursor and restores verified content as a new sibling file. Existing
  files, unsynced edits and original history are preserved; the new copy
  uses ordinary sync with a fresh identity. Folder selection and current
  device limits apply, including local bytes added during the download.
- History reads make one attempt at a time; cancellation discards late
  results and blocks replacement reads until the outstanding request
  settles. A dispatched local create is preserved and reported separately
  from remote sync. Desktop publishes without replacing a destination;
  mobile uses Obsidian's create-only API. Neither platform silently falls
  back to an overwriting write.
- Resume sync after a same-instance reload waits for prior history recovery
  and manual-download work, without loading state ahead of their saves.
- Quarantine damaged chunks across separate blob and journal mounts using
  a synced copy on the destination volume before removing the primary.
  Reserve peak copy space, account failed-copy residue, and retain failed
  operations for recovery without claiming quarantine or losing inventory.
  Recovery uploads and delayed scrub summaries cannot discard each other;
  concurrent GC skips a busy chunk pass without holding partial locks.

## 0.1.10 - Unreleased

- The chart's own defaults could not start the server, and both halves of
  that are fixed here. `chart/values.yaml` declares each claim as a
  Kubernetes quantity (`250Gi`, `4Gi`) and the Deployment renders it verbatim
  into `OBSYNC_BLOBS_CAPACITY` / `OBSYNC_JOURNAL_CAPACITY`, but the server's
  size grammar knew only `KiB`/`MiB`/`GiB`/`TiB` and lower-cased what it read,
  so `Gi` was not a size and the pod exited on its own chart's defaults. The
  Service is named `obsync`, so a kubelet with service links on also injected
  `OBSYNC_SERVICE_HOST`, `OBSYNC_SERVICE_PORT` and `OBSYNC_PORT_*` -- and an
  unknown `OBSYNC_*` name is a startup error by design, which is a second
  refusal on the same first boot.

- **Size grammar, one spelling per multiplier.** `parse_size` (and therefore
  `OBSYNC_BLOBS_CAPACITY`, `OBSYNC_JOURNAL_CAPACITY`, `OBSYNC_SCRUB_RATE` and
  the size term of `OBSYNC_FREE_WATERMARK`) now accepts a bare byte count
  (`512`), `B`, the Kubernetes binary suffixes `Ki`, `Mi`, `Gi`, `Ti`, and
  their long forms `KiB`, `MiB`, `GiB`, `TiB`; `Gi` and `GiB` are the same
  multiplier. The suffix is matched case-sensitively after trimming.
  COMPATIBILITY, for both `OBSYNC_*_CAPACITY` and `OBSYNC_FREE_WATERMARK`:
  the single letters `k`, `m`, `g`, `t` and every lower- or upper-case
  spelling (`gib`, `GIB`, `4mib`, `512b`) are DROPPED and now refuse the
  start. A value using one must be rewritten -- `250g` becomes `250Gi`,
  `1%,2g` becomes `1%,2Gi`, `64m` becomes `64Mi`. Nothing in this repository,
  its charts, its compose file or its README used a dropped form. The reason
  they are gone is that Kubernetes reads a single letter as a power of a
  thousand, so keeping them binary made `250G`-shaped input ambiguous in
  exactly the direction that over-states a volume and makes the free-space
  watermark fire late. Decimal SI (`G`, `GB`) is refused for that reason;
  a fraction (`1.5Gi`) is refused for a different one, that the grammar
  deliberately admits whole units of one multiplier and nothing else -- the
  value is an exact byte count, it is simply not a spelling this grammar has.
  A whole-unit size whose product does not fit in 64 bits is refused rather
  than wrapped. The error text now names the accepted forms.

- **Chart.** `values.schema.json` admits only Kubernetes binary quantities
  for the claim sizes the server is told (`^[1-9][0-9]*(Ki|Mi|Gi|Ti)$`), so a
  decimal `250G` -- or the server's own `250GiB`, which the API server would
  refuse -- fails `helm lint` instead of rendering a pod that cannot start.
  The Deployment sets `enableServiceLinks: false` beside its existing
  `automountServiceAccountToken: false`; the Service keeps its name and the
  server's refusal of unknown `OBSYNC_*` names is unchanged and retested.

- **The gate now runs the chart against the binary.** `image-smoke.sh` gains
  a tenth property: `helm template` renders the deployment, the rendered
  environment is read from that render through the fail-closed YAML reader
  (`scripts/ci/chart_pins.py env` -- no variable name, value or mount path is
  typed into the smoke), and the SHIPPED image is started on exactly those
  values and must answer `/readyz`. `chart_pins.py environment` holds the
  render side: service links off, and every quantity either reader refuses is
  refused by the schema. The container job installs the pinned helm for it.

## 0.1.9 - Unreleased

- Two exact pins advance, each confirmed from its source before it was
  written rather than from the proposal text. The runtime base
  `gcr.io/distroless/static-debian13:nonroot` moves from `sha256:f7f8f729...`
  to `sha256:1c2c046b...`: `docker buildx imagetools inspect` resolves that
  tag today to index digest `sha256:1c2c046b...`, and an anonymous registry
  HEAD accepting only the index media types returns the same
  `docker-content-digest`. That digest is the multi-arch INDEX, which is what
  a `FROM` must name for both production platforms; the per-architecture
  manifests beneath it (`sha256:e754765a...` amd64, `sha256:9381e9b7...`
  arm64/v8, and four others) are different digests, and pinning one would
  break the other platform. `docker/setup-qemu-action` moves from `96fe6ef7`
  (v4.2.0) to `1f40c722` (v4.3.0) in the release publisher, with the version
  comment updated; the tag `v4.3.0` in that repository is a lightweight tag
  resolving to exactly that commit. The `library/node` major bump is held
  under issue #32 and the node stage is untouched here.

## 0.1.8 - Unreleased

- A dismissed alert GitHub has stamped `fixed_at` is skipped, counted and
  named instead of refusing the run. `Alert.historical` described exactly this
  case and then tested `most_recent_instance.state == "fixed"`, which the
  shape never satisfies, so the first live reconcile after v0.1.7 (push run
  34368935826 at `f229a46`) stopped on alert #90 with
  `was analysed on commit e4aa059…, not f229a46…` before writing anything:
  every later step was skipped, main kept its one covered open alert, and the
  publisher denied the version on the exact-SHA binding. The API partitions
  main's 78 dismissals exactly: 33 (#55–#90, `hard-coded-cryptographic-value`
  in `api/auth.rs` 583–1052, the auth nonce vectors v0.1.7 removed) carry
  `fixed_at` with their instance left on `e4aa059`, and the other 45 carry
  `fixed_at: null` with their instance on `f229a46`. The stamp is what earns
  the exemption and an old commit alone never does: an unstamped dismissal
  whose instance names another commit, and any OPEN alert that does, are still
  refused as superseded or foreign, and the ref and analysis-key bindings now
  hold in every state. The stamp is read for its presence, null or a non-empty
  string, and its syntax is not validated: the ref, the analysis key and the
  alert's own state are what guard the exemption. `fixed_at` can be read at face value because the job
  waits for `processing_status: complete` on both analyses before it lists
  anything, and on a pull request the base listing now requires the analysis
  record it selects per language to report an empty `error` — agreement on a
  commit is not evidence that the analysis of that commit succeeded, and there
  is no fallback to an older healthy record.

## 0.1.7 - Unreleased

- A journal append that fails is rolled back to the length the journal has
  made durable and the cut is fsynced, so the next frame starts clean and a
  write acknowledged after a failure can no longer be discarded by the next
  start's truncation; if that rollback itself fails the journal is faulted,
  every later append refuses with `journal_faulted`, `/readyz` answers 503
  with the reason to restart, and the line names both the append's and the
  rollback's error kinds.
- The journal volume has its own free-space watermark, refusing a frame with
  `507 journal_full` against `OBSYNC_JOURNAL_CAPACITY` minus everything the
  journal root holds, snapshots included; `VolumeStatus` reports that same
  number, and the image smoke gained a ninth property that exhausts a real
  blob volume and requires the server's `io=StorageFull` account, its 503,
  and its recovery when the space comes back.
- A journal accounting survey that is itself refused is now recorded as a
  fact of its own rather than dropped: the tracked total is marked unverified,
  a survey publishes both of its halves or neither, and while it stands the
  server is fail-closed — an append retries the survey once and otherwise
  refuses with `503 journal_unverified` having written nothing, so the
  watermark is never decided against a figure nothing has re-read. `/readyz`
  retries the survey too and answers `503 not_ready` with the kind that
  refused it, so a volume an operator has fixed comes back on the next probe
  with no write in between; `VolumeStatus` gained `usage_unverified` so the
  dashboard shows the figure as the last one read successfully. A faulted
  journal stays faulted however well the volume measures: that state is about
  the segment's contents and still clears only at a restart. The original
  operation error is unchanged and still what its caller gets.
- The `dispositions` reconciliation rewrites a stored justification with two
  writes, `state=open` then `state=dismissed`: GitHub refuses a `dismissed`
  write to an already-dismissed alert, which stopped the first live run on
  `main` with 78 rewrites planned. Each write announces its phase; either write
  failing is fatal to that run and blocks publication, and the next authorized
  run converges from whatever state was left. The offline step harness is now
  STATEFUL — it holds each alert's state, reason and comment, answers listings
  from them, and refuses a second dismissal the way the API does — so the
  single-write shape cannot pass the suite again.

## 0.1.6 - 2026-09-09

- CodeQL dispositions are code: `security/codeql-dispositions.json` records
  every accepted alert with its rule, its glob, its scope, one of CodeQL's
  three reasons and the issue carrying the reasoning, and a new `dispositions`
  job in `codeql.yml` waits for both analyses to be indexed and then fails any
  ref that carries an alert no entry covers — on a pull request that means the
  changed range AND the base branch, whose alerts a diff-informed pull-request
  analysis never shows and whose dismissed alerts count too, judged in the
  commit the base's analyses ran on. On a push to `main` the job first
  reconciles the alerts that are already quiet — a dismissal nothing covers is
  reopened, a stored justification that is not this file's is rewritten — then
  dismisses every covered open alert and requires `main` to hold zero, so
  nobody dismisses by hand, nothing is excluded from analysis, and a new real
  finding blocks the gate and the release chain until it is fixed or
  dispositioned in a reviewed pull request.
- An acceptance over product code now names what was reviewed: `line_is` (the
  exact source line) or `reviewed_sha256` (the file's bytes), verified on every
  run whether or not an alert touches the file, so an edit to accepted code
  cannot land without re-triage in the same pull request. Every judged alert
  must also name the commit it was analysed on and this workflow's analysis
  key, so a superseded or foreign record cannot supply a line number to a
  checkout that never produced it.

## 0.1.5 - 2026-09-09

- Every line that states a storage refusal now names the `io::ErrorKind`
  behind it (`io=StorageFull`, `io=PermissionDenied`, `io=NotFound`) through
  the one helper the request path already used, so the five fatal startup
  refusals, the collection, unlink and scrub lines, the snapshot retries, the
  expired-pairing sweep, the dropped `seen` event and the `check`/`export`
  refusal say WHICH I/O stopped them instead of `refusal=io_error` alone.
- The image smoke's `deny` adds the number behind that word: `df` of both
  volumes read from inside the compose path's digest-pinned throwaway image,
  and the daemon's own `docker system df`, both best-effort so neither can
  mask the refusal they explain.

## 0.1.4 - 2026-09-09

- The chart's `deploymentReady` gates the replica count instead of only
  annotating it. False, the shipped default, renders every object with
  zero application replicas, so the claims can bind their volumes and the
  TLS proxy can resolve the Service while no Pod waits on a volume or a
  Secret that does not exist yet; true is a scale from zero to one. The
  chart pins render both values and refuse a non-boolean.

## 0.1.3 - 2026-09-08

- The publisher attests with the URI form of the provenance type
  (`--type https://slsa.dev/provenance/v1`): the named `slsaprovenance1`
  makes cosign re-serialise the predicate through its typed struct and
  drop BuildKit's layer metadata, which is what the contract binds each
  platform through. The contract accepts the in-toto Statement v0.1 that
  cosign emits. v0.1.2's publisher run built, signed and attested its
  image, then refused its own attestation on both counts, so that tag
  carries no chart and no Release; nothing weaker was accepted.

## 0.1.2 - 2026-09-08

Tagged and its image published, signed and attested; the publisher's own
verification refused the attestation (statement type; predicate stripped of
its layer groups), so this version received no chart and no GitHub Release
(repaired in 0.1.3).


- The release publisher attests the image's SLSA v1 provenance onto the
  published digest with its own identity, one statement per platform,
  and proves it verifies with the consumer's command before the chart
  embeds the digest. v0.1.1's image carries BuildKit provenance but no
  signed attestation, which the platform's acquisition check requires.
  `scripts/ci/provenance_contract.py` decides, offline, what each
  statement binds: the BuildKit v1 shape naming this exact run, and one
  production platform, identified by the layer digests of that platform's
  manifest; every platform gets exactly one statement, on a fresh build
  and on a reused digest alike.

## 0.1.1 - 2026-09-08

- The release publisher checks the plugin bundle's listing for the names
  the archive holds. The first v0.1.0 publisher run exported a correct
  bundle and then failed its own check, looking for `./main.js` in a
  listing that said `main.js`; v0.1.0 keeps its tag, signed image and
  signed chart and received no Release.
- The nonce log's compaction recovery contract is published for operators
  (`docs/storage.md`, "Nonce log recovery"), and each of its sentences is
  pinned by a test that drives a real compaction over a real volume.

## 0.1.0 - 2026-09-08

Tagged, with its image and chart published and signed; it received no
GitHub Release because the publisher's bundle check failed after them
(repaired in 0.1.1).

### Added

- Repository contract, architecture, wire protocol, storage, threat model,
  benchmark, validation, and platform-onboarding documents.
- Start-time volume posture: `serve`, `check`, and `export` measure the type,
  owner, and mode of both volume roots and both credential files before
  anything is read or written through them. A weak mode is corrected and
  re-read; a link, a substituted type, or a foreign owner refuses the start.
- A ceiling on the heads one file may hold, equal to the parents one version
  may declare, so a conflicted file is always resolvable by one merge naming
  every head and the head list a response carries is bounded. The version
  that would pass it is refused with `409 too_many_heads` and nothing
  already stored changes; replay applies what the journal already holds.
- Replay protection that survives a restart: every accepted nonce is
  appended to `v1/nonces` on the journal volume and fsynced before its
  request is answered, and a start loads back what the 600 s window still
  covers. The file is rewritten once it passes twice the cache's ceiling, a
  torn final line costs only itself, and a volume that will not take the
  record refuses the request with `503 nonce_log_unavailable`, and a link
  standing where that file belongs refuses the start.
- Pending devices are reconciled against the pairing table on every start.
  A pairing lives in memory and the device a claim creates is journaled, so
  a restart used to leave an unapproved claimant nobody could approve and
  expiry could not reach, holding its wrapped secret for the life of the
  store. It is now destroyed down the path expiry uses, with one line
  stating the count.
