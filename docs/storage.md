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

`serve`, `check`, and `export` therefore run one pass over four classes —
`blobs_root` (the primary and each mirror), `journal_root`, `server_key`,
`setup_token` — before anything is read or written through them:

1. **Type.** Read with `symlink_metadata`, so a link is seen rather than
   followed. A link, a directory where a file belongs, or a file where a root
   belongs refuses the start.
2. **Owner.** The file's user must be the user the process runs as, learned
   from a file the process creates on the journal volume and then removes.
   The process cannot `chown`, and whoever does own a file can widen it again,
   so a foreign owner is a refusal and never a correction.
3. **Mode.** Roots must be exactly 0700 and credential files exactly 0600.
   Anything else is corrected with one `chmod` and then RE-READ: a mode that
   was set is not a mode that stuck. A correction the volume ignored, or one
   it refused, refuses the start.

Each decision is one line — `event=posture path_class=<class>
decision=<ok|repaired|refused> …` — and a correction states `from` and `to`
in octal. The modes on the `server_key` and `setup_token_ready` lines are the
modes read back off the volume, so a startup line cannot claim a protection a
file does not have. No line carries a filesystem location or any file content.

`obsyncd check` runs the identical pass, and its policy is **repair and
report**: an operator who runs it on a restored volume leaves that volume
correct, and the report names every class with its decision
(`posture setup_token: repaired 0644 -> 0600`). A posture that cannot be
corrected exits non-zero, exactly as it refuses a start.

On Kubernetes the kubelet may re-apply group bits to volume contents at each
mount when an `fsGroup` is set (the chart sets 65532). The pass corrects them
again and logs one `repaired` line per affected class per start: that is the
pass working, not a fault.

The volume mount points themselves (`OBSYNC_BLOBS_DIR`, `OBSYNC_JOURNAL_DIR`)
are the platform's to own: on the reference deployment they are mount points
the server neither creates nor owns, and refusing their mode would refuse a
correct deployment. They are not the control. The `v1` root inside each is
0700 and owned by the server, which is what stops another account on the host
from reaching anything below it.

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
`ReadWriteOnce`, node-affine to the single node, claimed by `obsync-blobs`
and `obsync-journal` in namespace `obsidian`. The claim names come from the
chart, which names every object for the application (`obsync`) and never for
the namespace it happens to be installed into; `scripts/ci/chart_pins.py`
refuses a name here that the render does not create. Growth to 500 GiB is a
PV capacity edit and a claim resize. The platform's storage
exposure policy already admits this class, provisioner, and root.
