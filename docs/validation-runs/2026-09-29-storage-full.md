# A disk that fills before the watermark — 2026-09-29

Issue #291. A blob volume whose filesystem runs out before the free-space
watermark does — a capacity declared larger than the disk really holds —
answered a chunk upload `500 io_error`, and a device retries a 500 as a server
that is not there. Server 1.1.5 answers `507 storage_full`, which a device
reads as a full server. This run puts one real desktop in front of the
shipped image, before the change and after it.

## Setup

- One isolated Obsidian 1.13.4 on macOS 27.0, with its own
  `--user-data-dir`, a disposable vault and its own `HOME`, driven through its
  DevTools port. Plugin 1.1.5, the same build in both runs (the change touches
  no plugin source): `main.js` SHA-256
  `cdfc140d8c5bb14e4b3a61d31ce3957a959a618bdbf0a2779f27b374b21e9497`.
- Server: the shipped image, built from the train, in Docker (linux/arm64),
  hardened as `scripts/ci/image-smoke.sh` runs it (read-only root, no
  capabilities, no new privileges), plain HTTP on the Mac's loopback. The blob
  volume is an 8 MiB tmpfs declared as 8 GiB; the journal a 4 GiB
  declaration on an ordinary volume; the watermark the default. The watermark
  sees gigabytes free throughout, so only the filesystem can refuse.
  - before: the train at `d0cdf30` (image `sha256:444eb2833374…`);
  - after: this change (image `sha256:82a9072cb8b7…`).
- The journey: set up the account on the desktop and write one note (it
  syncs); fill the blob volume to 0 bytes free with the digest-pinned
  throwaway container; write a second note of 41 KiB; watch the device for
  four minutes; sweep the whole app; free the space and watch it recover — once
  with an edit to the note, once (after only) with nothing touched.

## Results

| # | Journey | Before (`d0cdf30`) | After (this change) |
| --- | --- | --- | --- |
| V11, disk | A disk that fills before the watermark, desktop: uploads refused with a visible message; nothing corrupted | fail: the device read `offline — retrying` and `syncing 1 file` in turn for four minutes, then the synced check at +237 s with the note not on the server | pass: `error — Your server is out of storage, so it refuses new changes. Free space on the server or raise its quota. Sync resumes by itself.` at +6.1 s, standing for the whole four minutes |
| V11, disk, recovery | Space back, note edited | the status already read synced; Show sync status counted the note 4 s later | synced in 6.0 s |
| V11, disk, recovery | Space back, nothing touched | not run | resumed by itself 246 s after the space came back (the next scan) and synced the note |
| V11, disk, phone | The same on a phone | not attempted | not attempted |

What each side saw:

- **Server, before:** every attempt answered `500 io_error`
  (`event=chunk_put … decision=io_error io=StorageFull`). The device tried
  eight times per round, 87 s and 91 s (`status=500 decision=gave_up
  attempts=8`), and logged `push … decision=failed reason=500 unreachable`.
  Show sync status then read `State idle`, `Files tracked 1`: the second note
  was not on the server while the status said synced.
- **Server, after:** `507 storage_full` (`event=chunk_put …
  decision=storage_full io=StorageFull`, `event=request … status=507`). Two
  attempts in four minutes, the refusal and one re-send, never eight. The
  device logged `http PUT … status=507 decision=refused code=storage_full` and
  `push … decision=failed reason=507 storage_full: the volume is out of space`.
- **Nothing corrupted:** `v1/tmp` on the blob volume was empty after every
  refusal, in both runs, and the server kept running.

## Whole-app sweep (after)

- **Status item:** the attention icon; its tooltip is the sentence above.
- **Notices:** none on the desktop, as designed: a refusal that stands is said
  in a notice only on a phone, once.
- **Show sync status:** "What to do" with the same sentence and **Retry now**;
  `State error — …`; `Files tracked 1` until the space came back, then 2.
- **Settings:** the **Connection** row carries the same sentence.
- **Console:** only the two warn lines per attempt above; no error, no
  uncaught exception.
- The red crossed icon beside obsync's in the status bar is Obsidian's own
  core Sync plugin (`plugin-sync`, `Uninitialized`), enabled in every fresh
  vault; it is not obsync's.

## Not attempted

The phone. The words come from the one mapping every platform uses (a `507`
is a full server, `refusalStatus`), which the plugin suite proves for
`storage_full`; a phone adds one notice when the status turns to it. No
Android emulator or phone was brought up in this lane.

## Also run

- `scripts/ci/image-smoke.sh`, whose property 9 now sends one signed chunk
  onto the exhausted volume: `properties=11 decision=pass` on the after
  image; on the before image it refuses with `a chunk the full blob volume
  cannot hold was not refused 507 storage_full` (`answered 500, not 507:
  'io_error'`).
