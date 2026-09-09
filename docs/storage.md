# Storage contract

Dated 2026-09-07. Owner rulings: one StorageClass per storage
implementation (local SSD today; local drives and other node types as the
cluster grows), a single copy without backups is an accepted risk for now,
and the class may be reused by other workloads. The server therefore assumes
nothing about the class behind a path; it assumes only a POSIX directory
that honors `fsync`.

## Volumes and roles

| Role | Variable | Contents | Reference class |
| --- | --- | --- | --- |
| blobs | `OBSYNC_BLOBS_DIR` | ciphertext chunks | `local-pie-ssd`, 250 GiB (→ 500 GiB) |
| journal | `OBSYNC_JOURNAL_DIR` | journal segments, index snapshots, server key | `local-pie-ssd`, 4 GiB |
| mirror | `OBSYNC_BLOBS_MIRRORS` | optional extra blob copies | any class |

The chart exposes `storage.blobs.{className,size}`,
`storage.journal.{className,size}`, and `storage.mirrors[]` with the same
fields. A future HDD class or NAS-backed class is a values change, never a
code change.

## On-disk layout

```
<blobs>/v1                                   chunk volume root, mode 0700
<blobs>/v1/<sid[0..2]>/<sid[2..4]>/<sid>     one chunk, mode 0600
<blobs>/v1/tmp/<random>                      in-flight upload, renamed on success
<journal>/v1                                 journal volume root, mode 0700
<journal>/v1/journal/<000001>.log            append-only segments, 64 MiB each
<journal>/v1/index/<seq>.snap                periodic index snapshot
<journal>/v1/nonces                          accepted request nonces, 0600
<journal>/v1/server.key                      only when OBSYNC_SERVER_KEY is unset, 0600
<journal>/v1/setup-token                     first-boot and recovery login, 0600
<journal>/v1/quarantine/<sid>                chunks that failed a scrub
```

## Volume posture

Modes above are enforced on every start, not only at creation. A restored
snapshot, a `tar -x`, a `docker cp`, or a bind mount hands the server volumes
it did not create, and a `server.key` or `setup-token` that arrives readable
by every account on the host is a standing way in: the token is the dashboard
recovery login, and the key with the journal unwraps every stored device
credential.

`serve`, `check`, and `export` therefore run one pass over six classes —
`journal_mount` and `blobs_mount` (the directory each configured volume path
names, one per mirror too, and every directory above it), `blobs_root` (the
primary and each mirror), `journal_root`, `server_key`, `setup_token` —
before anything is read or written through them, and a store cannot be
opened without the completed pass in hand. Every decision is made on an
open handle or on a directory chain, never on a bare name:

1. **Who may rename a root away** (`*_mount`), decided before a byte is
   written. Everything below a root works by name, and a name is only as
   good as the directories that hold it: whoever can rename `v1` away can
   put another tree under the name after the pass, and a later snapshot
   would write that tree's state into the protected root. So every
   configured volume path is validated first — absolute, made only of
   plain names, and free of links down to the last name that exists
   (`not_canonical`), because a link is re-pointed by its owner and a link
   nested inside another link's target is one no walk of the written path
   would see; nothing behind a refused path is read, created, or removed.
   Then every directory that already exists on the path, from the
   filesystem root down, must be owned by root or by the server's user
   (`foreign_owner`), and must not be writable by others
   (`writable_by_others`) or by its group (`writable_by_group`): a group
   number says nothing about who is in the group, and `fsGroup` exists to
   share one. The sticky bit satisfies the write conditions, since it
   narrows rename to the entry's owner, the directory's owner, and root,
   all of which are already root or the server. A chain that would be
   refused once complete is refused before anything is created beneath
   it, so a refused start leaves nothing behind. On Linux, the shipped
   platform, nothing at all is written before the judging: the user the
   server runs as is read off `/proc/self`, which the kernel owns by the
   process's effective user. On other systems (development only) the user
   is learned from a uniquely named empty probe file in the deepest
   existing directory of the journal path, removed at once; a probe a
   crash leaves behind is a harmless empty file under `.posture-probe-`
   and is never swept, since a sweep is a removal by name. A refusal states
   how many directories up it was found (`depth=0` is the configured
   directory itself); it never states a location.

   **The provisioning precondition.** The server takes ownership of
   nothing. When there is anything left to create — the configured
   directory's tail, or `v1` inside it — the deepest directory that exists
   must be owned by the server's user and writable by it, or the start is
   refused as `unwritable`. A named Docker volume satisfies this (the mount
   point is copied from the image, owned by the server's user), and so does
   a `hostPath` or static local volume the operator created for that user
   (`65532:65532`, mode `0700`). A dynamic provisioner that presents a
   root-owned `0755` volume root, or a world-writable one, does not: prepare
   the backing directory once as the node administrator (`chown
   65532:65532` and `chmod 0700`), then start the server. A volume that
   already holds the server's `v1` under a root-owned mount point is
   accepted, since nothing needs creating. The fix for a refusal is always
   to give the directory to root or to the server's user and close it,
   never to widen the pass. The image smoke's eighth property presents
   root-owned `0755` volumes holding no root and requires the `unwritable`
   refusal.
2. **Look, open, compare** (roots and credential files). The name is
   looked at once without following a link (`lstat`): a link, a type the
   server never stores, or a foreign owner is refused before anything is
   opened. The name is then opened read-only and non-blocking (a fifo
   answers instead of waiting for a writer), and the handle must be the
   inode that look saw, or the pass refuses (`swapped`): whatever the name
   is made to say between the look and the open, what the server holds is
   the file it looked at. The one thing the look leaves standing that
   cannot be opened — a file of the server's own user at a mode that shuts
   its user out — is corrected by name only so that a handle can be reached
   at all. Every decision from here on is made on that handle. No
   `O_NOFOLLOW` is involved: its value differs between architectures, and
   the identity check does not.
3. **Type.** On the handle. A directory where a file belongs, a file where
   a root belongs, or anything the server never stores refuses the start.
4. **Owner.** On the handle. The file's user must be the user the process
   runs as, learned from a file the process creates on the journal volume
   and then removes. The process cannot `chown`, and whoever does own a
   file can widen it again, so a foreign owner is a refusal and never a
   correction.
5. **Mode.** On the handle. Roots must be exactly 0700 and credential files
   exactly 0600. Anything else is corrected with one `fchmod` and then
   RE-READ off the same handle: a mode that was set is not a mode that
   stuck. A correction the volume ignored, or one it refused, refuses the
   start.
6. **Read through the handle.** `server.key` and `setup-token` are read
   through the handle they were measured on, and a file the server has just
   written is measured on the handle it was written through and read back
   through it. No name is consulted again after a measurement. Two
   credential classes that resolve to one inode (a hard link) are refused,
   and a `setup-token` that does not hold 64 hex characters is refused
   rather than minted over: a file that is not a token is not a first boot.

Each decision is one line — `event=posture path_class=<class>
decision=<ok|repaired|refused> …` — and a correction states `from` and `to`
in octal. The modes on the `server_key` and `setup_token_ready` lines are the
modes read back off the handle, so a startup line cannot claim a protection a
file does not have. No line carries a filesystem location or any file content.

`obsyncd check` runs the identical pass, and its policy is **repair and
report**: an operator who runs it on a restored volume leaves that volume
correct, and the report names every class with its decision
(`posture setup_token: repaired 0644 -> 0600`; a mount is reported with the
mode it was read at and is never corrected, since it is not the server's to
change). A posture that cannot be corrected exits non-zero, exactly as it
refuses a start.

The chart sets no `fsGroup`. It is a group-sharing mechanism: the kubelet
would make the mount point and everything under it writable by that group,
and a mount point a group may write is refused above. The image ships
`/data/blobs` and `/data/journal` owned by the server's user, and the
reference deployment's host directories are created for that user, so
nothing needs sharing. A platform that applies an `fsGroup` anyway sees the
pass correct the bits below the roots and refuse the mount point; the fix is
to drop the `fsGroup`, not to widen the pass.

`v1/nonces` is not one of the six classes and adds no line to the report.
The one thing measured about it is that the name is not a link and not
another type: a restored volume can arrive with it pointing at a file the
server may write, and an append through it would put nonce lines inside
that file. A start refuses one and says why.
It holds no credential: a device id and a nonce are public request values
that open nothing and are only ever compared, so it is server state like the
journal segments beside it, created 0600 under the same measured 0700 root.
What it does hold is the replay window (`docs/protocol.md`,
"Authentication"): every accepted nonce is appended and fsynced before its
request is answered, a start loads back what the 600 s still covers, the
file is rewritten when it passes twice the cache's ceiling, and a torn final
line costs only itself.

### Nonce log recovery

What an operator can rely on after a crash, and what the next start does
with what the crash left.

Every accepted nonce is appended to `v1/nonces` and fsynced before the
request that carried it is answered. A nonce the server has acted on is a
nonce the server has already written down.

The file is rewritten when it passes twice the cache's ceiling. The
rewrite is one sequence, in this order:

1. `v1/nonces.tmp` is removed by name. A removal by name never follows a
   link, so a link a restored volume brought is unlinked rather than
   written through.
2. The replacement is created at that name exclusively. `O_EXCL` refuses
   a name of any kind that already exists, so nothing this writes can
   land in a file that was already there.
3. The entries the window still covers are written to it.
4. The replacement is fsynced.
5. It is renamed onto `v1/nonces`.
6. The journal root is fsynced.

The handle that wrote the replacement is the handle that appends to it
afterwards. No name is resolved again after step 2.

A crash before step 5 leaves a partial `v1/nonces.tmp` behind. The next
start ignores it. The live window is read from `v1/nonces` alone, and
nothing standing at the temporary name is ever loaded, whatever it holds.
The next compaction removes it at step 1 and takes the name back.

A crash after step 5 leaves the replacement standing as the log, and that
is the file the next start reads. Step 6 is the only step such a crash
can lose, and losing it costs nothing the window promised. The entries
the replacement holds were fsynced at step 4. A rename the filesystem has
not yet committed can only leave the name on the file the replacement was
built from, and every entry in the replacement was appended to that file
before it entered the window, so either file answers the window.

Any failure inside the sequence refuses the request that triggered it
with `503 nonce_log_unavailable` and one `event=nonce_log
decision=refused` line. Nothing already durable changes: `v1/nonces`
holds what it held, and the nonce the refused request carried was never
recorded, so it is unspent and the device may send it again. The
compaction threshold is still outstanding, so the next accepted request
attempts the rewrite again.

The boundary is the one "One writer" states below. These steps defend
against what a crash and a restored volume leave behind. A process
already holding the server's own uid inside the 0700 journal root is held
out by none of them: it can write `v1/nonces` directly, exactly as it can
write the journal segments beside it. Keeping such a process off the
volume is the platform's admission decision, not this file's.

Measured. `crates/obsyncd/src/api/auth.rs` pins each paragraph above with
a test that drives a real compaction over a real volume: a partial
temporary file present at start, a directory standing at the temporary
name, the state step 5 leaves before step 6, and a replacement that
cannot be created because the root is read-only.

Not measured. Nothing here is tested by cutting power or by making a
syscall that succeeded report a failure. The states a crash would leave
are built by hand and then opened. The ordering claim — that a file
fsynced before its rename is on the volume once that rename is visible —
rests on the POSIX `fsync` contract and on the class honoring it, which
this document assumes of every class.

## One writer

The journal has exactly one writer, and the access mode is not what makes
that true. `ReadWriteOnce` keeps other nodes off a volume and nothing more:
Kubernetes lets a second pod on the same node mount it, and this is a
single-node cluster. So `obsyncd` holds an exclusive advisory lock on
`v1/lock` of the journal volume for the life of the store, taken before a
byte of the journal is read: a second `obsyncd` on the same volumes — a
second pod, a rolling surge, a `check` or `export` while `serve` runs —
refuses to start with `event=store_open decision=refused reason=journal_locked`
rather than share the journal. The lock goes with the process, so a crash
leaves nothing to clean, and a stopped server frees it at once. It is an
advisory lock, and its boundary is stated exactly: it refuses cooperative
duplicate starts of this server. A process running as the server's own
user is the server by every test the filesystem offers — owning `v1` is
the authority to rename it and lock a fresh `v1/lock` on a new inode — so
an arbitrary Pod that could mount the claim and run as that user is not
excluded by any file mode; keeping such a Pod off the claim is the
platform's admission decision (who may create Pods mounting these claims),
together with the chart's `replicas: 1` and `strategy: Recreate`. The
volume-directory conditions above constrain other accounts, not that one. Run `check`
and `export` with the server stopped. The chart's `replicas: 1` and
`strategy: Recreate` are the rendered half of the same boundary, so a rollout
never asks for a second writer; `ReadWriteOncePod` is not available on the
non-CSI local class and is not relied on. The image smoke's seventh property
starts a second container on the same volumes while the first serves and
requires the refusal.

## Durability rules

1. Chunk write: stream to `tmp`, hashing; on completion `fsync(file)`,
   `rename` into place, `fsync(dir)`; only then respond. A crash leaves
   either the complete chunk or a `tmp` file that startup removes. Each of
   the three points refuses differently and leaves a different residue: a
   refusal while streaming removes the temp on the way out; a refusal at the
   `fsync` leaves an unsynced temp; a refusal at the `rename` leaves a synced
   one. Both leftovers are removed at the next start, which counts them on
   its `store_open` SUMMARY, and in every case the chunk is simply absent and
   the client re-uploads.
2. Journal append: frame = `u32 len | u32 crc32 | payload`; `write`,
   `fsync(segment)`; only then respond. Startup replay stops at the first
   torn or CRC-failing frame, truncates the segment there, and logs the
   count of frames recovered.
3. Failed journal append: the journal records the length it has made durable
   before it writes, and any failure of the write or of its `fsync` cuts the
   segment back to that length and fsyncs the cut before the error returns.
   Nothing was acknowledged, and the next frame starts clean. This is not a
   nicety: segments are opened `O_APPEND`, so without the rollback the next
   successful frame would land AFTER a torn one, and the next start would
   truncate at the torn frame and discard every write acknowledged since.
   Each failure logs one line, `event=journal_append_failed
   decision=truncated io=<kind> segment=<n> torn_bytes=<n>` — the error's
   kind, never its message, which can carry a path.
4. Faulted journal: if that rollback ITSELF fails, at the truncation or at
   its `fsync`, the journal is faulted. The line says `decision=faulted` and
   adds `rollback_io=<kind>`, and the refusal carries both kinds. The second
   kind is a second fact and the state's actual cause: a truncation refused
   by a full volume and one refused by a read-only mount both read as
   `faulted` and need different repairs. From then on every append refuses
   with `journal_faulted` without touching the volume, `/readyz` answers
   `503 not_ready` with `journal faulted; restart to replay`, and the state
   clears only at the next start, which replays and truncates the tail as
   rule 2 describes. Chunk uploads are unaffected: the blob volume is its
   own record.
5. Snapshot: written to `tmp`, fsynced, renamed; replay starts from the
   newest valid snapshot and applies later frames.
6. No write is acknowledged before it is durable. This is not configurable
   (AGENTS.md requirement 4).

## Journal frames

`account`, `device` (create, update, activate, revoke, delete, wrap),
`version` (which carries its file's `domain_id`, so replay reaches the same
domain the post named), `gc` (a list of sids collected), `scrub` (a
summary), `seen` (device sign-in and edit events, retention-bounded). There
is no `domain` frame: a domain exists because a file record names it
(`docs/architecture.md` 5.1 item 4). Pairings live in memory only, so a
start destroys every pending device no pairing is holding any more, through
the `device` delete frame expiry uses (`docs/architecture.md` 4.2). Frames
carry `account_id`.

## Integrity

- Every upload is verified against its `sid` while streaming.
- The scrub thread re-hashes blobs at `OBSYNC_SCRUB_RATE`, oldest-verified
  first, and moves a mismatch to `quarantine/`, logs it, and marks it in the
  dashboard. A quarantined chunk that a client re-uploads is replaced.
- Every read verifies size; the client verifies the plaintext hash from the
  manifest after decryption, so a corrupted chunk can never be written into
  a vault.

## Garbage collection

Refcounts come from the index (sids referenced by retained versions). A
chunk is collectable when no retained version references it, it is older
than 24 h (protects an upload whose version post has not landed), and the
retention window has passed for the version that last referenced it.
Retention keeps at least `OBSYNC_RETENTION_VERSIONS` versions per file and
everything younger than `OBSYNC_RETENTION_DAYS`. GC runs hourly, logs a
`SUMMARY` with counts and bytes, and needs no device ceremony.

## Free-space watermark and quota

Free space is declared capacity minus tracked usage: the standard library
exposes no filesystem statistics, so `OBSYNC_BLOBS_CAPACITY` and
`OBSYNC_JOURNAL_CAPACITY` are required and the chart sets them from the
claim sizes. Writes are refused with `507` when free space on the blob
volume is below the larger of `OBSYNC_FREE_WATERMARK`'s two terms, or when
the account's quota is exceeded. The dashboard shows both thresholds and the current
values.

The journal volume has the same watermark applied to its own capacity, and
refuses a frame that would take it below with `507 journal_full` before the
volume is asked. Tracked journal usage is everything under the journal root —
the open segment's durable length plus every other file on the volume: the
other segments, the index snapshots, the quarantine, the nonce log, and the
small fixed files. Snapshots are why this is not a segment count: they rest on
the same volume and reach tens of megabytes for a large vault. `VolumeStatus`
reports the same number, so a refusal and the dashboard never disagree about
how full the volume is, at any moment rather than at the last roll. The two
volumes have separate refusal codes, `volume_full` and `journal_full`, because
they are provisioned and filled independently and a refusal that did not say
which one it measured would send an operator to the wrong disk. A journal
volume that fills anyway, below the declared capacity, is rule 3 above: the
append is refused, rolled back, and never acknowledged.

### Where the measure runs

The append path may not walk a directory, and everything that writes to this
volume between two walks would otherwise be invisible to the refusal. So the
total is four numbers, each owned by exactly one writer and each ABSOLUTE
rather than a delta, so they cannot double-count and a missed update cannot
accumulate: the open segment's durable length, a survey of everything the
other three do not own, the quarantine, and the nonce log.

Every writer of this volume, what it leaves behind when it fails, and how the
number stays right. Two properties, never one: the residue is ACCOUNTED FOR,
and the original durability error is still RETURNED. A failing path that
quietly balanced the books would be worse than one that did not.

| Writes | When | Residue on failure | Accounted by |
| --- | --- | --- | --- |
| `journal/<n>.log`, the open segment | every journalled write | a torn tail, rolled back in the same call; kept for the next replay if the rollback also fails | the open segment's durable length, advanced only after a successful fsync |
| `journal/<n>.log`, a new segment (roll) | first append after a start or replay, and at 64 MiB | an empty segment | the survey, re-run by the roll itself, which then excludes the segment it opened |
| the last segment, truncated (replay) | every start | none: it removes bytes | the survey, re-run before replay returns |
| `index/<seq>.tmp` → `<seq>.snap` | each snapshot | a `.tmp` a failed write or rename left, which nothing later removes | the survey, re-run by the prune a successful call ends in AND on every failing exit, before the original error is returned |
| `index/<seq>.snap` and covered segments, removed (prune) | end of each snapshot | whatever was removed before one removal failed | the survey, re-run at the end and on every failing exit, before the original error is returned |
| `quarantine/<sid>` | a scrub mismatch no mirror can repair | the bytes may have MOVED and the failure be in the directory fsyncs that follow the rename | the destination's size read after the attempt, minus what stood at that name before it, applied under the same journal guard the move is made under |
| `nonces` | every authenticated request | a partial line from a short write | the log publishes the absolute size of both its names after every write, the failing ones included |
| `nonces.tmp` → `nonces` (compaction) | when the log passes twice the nonce ceiling | a `nonces.tmp` a failed compaction left | the same publish, which counts the temporary BY NAME so that leftover is seen |
| `server.key` | first boot | a partial key refuses the start | the survey at `Journal::open`, which runs after it |
| `setup-token` | first boot | a partial token refuses the start | a survey `cli::serve` runs after it, being the last write the volume takes before the server serves |
| `lock` | every start | none: it is empty | the survey at `Journal::open`, which runs after it |

The survey walks `O(segments + snapshots)` entries, never a vault, and it does
not follow symlinks, so it cannot wander off the volume it is measuring.

The quarantine move is the one writer whose ordering matters, because it
changes the volume from OUTSIDE the journal's own code. The journal guard is
taken before the move and released after the accounting, so the move and the
number that describes it are one transition: no survey can run between them
and count the file twice, and no watermark check can read the total between
them and see the volume as emptier than it is. Serialization by construction
is half of that; the other half is a test that the guard is really held while
the file moves, which is what the hook inside the move measures.

### When the survey itself fails

An accounted residue is only as good as the walk that measured it, and a walk
can be refused. A survey that fails is a DIFFERENT fact from a survey that
succeeded, and the journal records it as one: `unverified` holds the
`io::ErrorKind` that refused the walk, set on failure and cleared only by a
COMPLETE later one. Nothing partial is ever published — the two walks the
survey makes are stored together or not at all, because one fresh number
beside one stale one is a total that was never true of the volume at any
instant.

While it is set the tracked total is known to be stale, so admission is
fail-closed. The next append retries the survey once: if that succeeds, the
state clears and the watermark is applied to the total it just read; if it
fails, the frame is refused with `503 journal_unverified` and nothing reaches
the volume. Readiness retries it too, which is what makes the recovery visible
without a write: `/readyz` answers `503 not_ready` with `journal usage
unverified; survey failed: <kind>` while it stands, and `200` on the first
probe after the volume can be walked again. The verdict cache bounds how often
an unauthenticated prober can make it walk. `VolumeStatus` carries
`usage_unverified` beside `bytes_used`, so a dashboard shows the figure as the
last one read successfully rather than as a current one.

Two states, and the distinction matters to an operator: `journal_faulted` is
about the segment's CONTENTS — bytes no frame owns — and clears only at a
restart that replays and truncates; `journal_unverified` is about the
ACCOUNTING and clears the moment a walk succeeds. A journal that is both stays
faulted: no survey can speak to a torn tail. Each transition says so once,
`event=journal_survey_failed io=<kind> at=<where>` and
`event=journal_survey_recovered by=<where>`, and never on the retries in
between.

The original operation error is still what its caller gets, in every case
above. The accounting is a consequence of the failure, never a replacement for
reporting it.

## Replication and propagation (design hooks, phased)

- **Mirrors (v0.1):** every chunk write goes to the primary and each mirror
  before the response; reads come from the primary; scrub cross-checks
  mirrors and repairs a bad copy from a good one. This gives a second copy
  on a different class or drive on the same node today.
- **Replica server (v0.3):** a second `obsyncd` in replica mode follows the
  primary's change feed and fetches chunks, giving a warm copy on another
  node. Promotion is an operator action.
- **Export (v0.1):** `obsyncd export --domain` writes that domain's stored
  CIPHERTEXT, which the operator decrypts on a device holding the key; the
  server implements no AES and never could write plaintext
  (`docs/architecture.md` 3 and 5.1). `obsyncd check` verifies every blob
  and journal frame and prints a report. Both are the offline recovery path.

Backups are the operator's decision; the layout is plain files so any
file-level backup tool captures a consistent state after a snapshot.

## Encryption at rest

Chunks and manifests are already ciphertext. Device secrets are wrapped
under the server key. Host-level disk encryption is a host decision outside
this repository.

## Reference deployment

Static local PersistentVolumes under `/mnt/local-pie-ssd/obsidian/obsync-{blobs,
journal}` on class `local-pie-ssd`, `Retain`, `WaitForFirstConsumer`,
`ReadWriteOnce` (which excludes other nodes; the one-writer boundary on the
node is the server's own lock, above), node-affine to the single node,
claimed by `obsync-blobs` and `obsync-journal` in namespace `obsidian`. The claim names come from the
chart, which names every object for the application (`obsync`) and never for
the namespace it happens to be installed into; `scripts/ci/chart_pins.py`
refuses a name here that the render does not create. Growth to 500 GiB is a
PV capacity edit and a claim resize. The platform's storage
exposure policy already admits this class, provisioner, and root.
