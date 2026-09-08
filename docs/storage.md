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
   it, so a refused start leaves nothing behind; the one write before the
   judging is the probe that learns which user the server is, a uniquely
   named empty file in the deepest existing directory of the journal path,
   removed at once. A refusal states how many directories up it was found
   (`depth=0` is the configured directory itself); it never states a
   location.

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
   either the complete chunk or a `tmp` file that startup removes.
2. Journal append: frame = `u32 len | u32 crc32 | payload`; `write`,
   `fsync(segment)`; only then respond. Startup replay stops at the first
   torn or CRC-failing frame, truncates the segment there, and logs the
   count of frames recovered.
3. Snapshot: written to `tmp`, fsynced, renamed; replay starts from the
   newest valid snapshot and applies later frames.
4. No write is acknowledged before it is durable. This is not configurable
   (AGENTS.md requirement 4).

## Journal frames

`account`, `device` (create, update, activate, revoke, delete, wrap),
`version` (which carries its file's `domain_id`, so replay reaches the same
domain the post named), `gc` (a list of sids collected), `scrub` (a
summary), `seen` (device sign-in and edit events, retention-bounded). There
is no `domain` frame: a domain exists because a file record names it
(`docs/architecture.md` 5.1 item 4). Pairings live in memory only. Frames
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
values. The journal volume has its own watermark; running out of journal
space fails readiness, never corrupts.

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
