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

## The journal volume (issue #292)

Every signed request records its nonce on the journal volume before it is
answered, a read included. So a journal volume the disk fills refuses them
all at the nonce log, and until 1.1.5 it said `503 nonce_log_unavailable`, a
server that is not there. The same rig and plugin, with the journal volume a
16 MiB tmpfs declared as 4 GiB (the blob volume ordinary), filled to 0 bytes
free while the device was idle and synced. Nothing was written after the
fill: **Sync now**, pressed until the nonce file's last page of slack was
used up (29 or 30 presses), then three minutes of the device's own reads.

- Builds: before, the train at `50bbb997` (image `sha256:59e79f0acaa8…`); after,
  this change (image `sha256:586bc99f7b34…`), with the plugin before the
  engine change (`cdfc140d…`) and after it
  (`eff6761543b17d5e4bd981703a1ddc9a0355f73bc331a3ae75189fdb737aba17`).

| # | Journey | Before (`50bbb997`) | After, server only | After, server and plugin |
| --- | --- | --- | --- | --- |
| V11, journal | A journal volume the disk fills, desktop, nothing edited | fail: `offline — retrying`, then `checking for changes` and `offline — retrying` again, for three minutes; Sync now said "Your server is not answering." | pass: "Your server is out of storage, …" at once, standing | pass: the same |
| V11, journal, recovery | Room back, nothing edited | synced 5.6 s later | fail: still "out of storage" 320 s later; an edit cleared it in 5.7 s | pass: synced 5.6 s later |
| V11, disk, recovery again | The blob volume journey above, on this build | — | — | pass: "out of storage" at +6.0 s, standing through a minute of answered reads, synced 6.0 s after the room came back with an edit |

- **Server, before:** every signed request was refused, `GET /v1/changes`
  and `GET /v1/devices` included. The server logged `event=nonce_log
  decision=refused io=StorageFull batch=1` and `event=request … status=503
  decision=nonce_log_unavailable`. The device gave up each round after eight
  attempts, about 90 s.
- **Server, after:** the same refusals, logged `status=507
  decision=storage_full`, answered at the first attempt. Nothing was answered
  as accepted, and the device's reads were refused like its writes.
- **The middle column is why the plugin changed.** A full server's words stood
  until a change was taken, because a full blob volume still answers reads.
  A full journal refuses reads too, and with nothing to write the status
  outlived the full disk. An answered read now clears a storage refusal that a
  read met (`refusedRead`), and a storage refusal that a write met still waits
  for a write, as the blob journey shows.
- **Sweep, after:**
  - status item: the attention icon with the sentence;
  - Show sync status: "What to do" with **Retry now**;
  - notices: the Sync now press's answer was "Your server is out of
    storage, …" once, where the before build said "Your server is not
    answering." twice. The three "nothing to send" notices beside it are the
    presses the server still answered, before the slack ran out;
  - console: `http GET /v1/changes… status=507 decision=refused
    code=storage_full` every 5 s, no error.

## A faulted server (issues #294, #295)

A server whose journal or nonce log is faulted takes nothing more until it is
restarted. A write failed and taking it back failed too. The shipped server
reaches that state only through such a double failure, and has no fault hook
outside its tests. So `/readyz` answering `not_ready` for a faulted nonce log
(#294) is proven by the server test
`a_faulted_nonce_log_is_not_ready_until_a_restart`, not here.

For the device (#295), the rig ran against the real server (image built from
`13c4dbec`, `sha256:b076a3f78588…`, obsyncd 1.1.5) through a loopback proxy
that exists only in the lane's lab. While switched on, the proxy answers what
a faulted server answers, with the server's own code and detail:
- `nonce_log_faulted` to every `/v1/` request (every signed request records
  its nonce first);
- `journal_faulted` to every version post (reads are still served).
The restart is a real restart of the container, and the proxy stops refusing
at that moment. Each journey is the same: a synced note, the fault, a new
note, a minute of the device's own work, one Sync now press, the whole-app
sweep, and then the restart.

- Plugins:
  - before: the train at `78ee6d26`
    (`5e29e9583d41c3bfc2a3fd696cc4311951d9e120cda897d115dcb1dcf083d80f`);
  - after, first: `13c4dbec` (`958753d9…`);
  - after, final: `d75a7403`
    (`3b091edd8f3cc0b7457a9e3b94233910d7280038262ebf55143f5e6378d30832`).

| Journey (no id in docs/validation.md) | Before (`78ee6d26`) | After, first (`13c4dbec`) | After, final (`d75a7403`) |
| --- | --- | --- | --- |
| Nonce log faulted, a new note, desktop | fail: `offline — retrying` at +6.0 s, standing | pass: the restart words at +6.0 s, standing, never offline | pass: the same, with the final words |
| Nonce log: Sync now while faulted | fail: "Your server is not answering. Sync resumes by itself when it is back." | pass: the restart words, once | pass: the same |
| Nonce log: requests refused in the first 75 s | 32, retried eight at a time | 15 | 14 |
| Nonce log: the restart | synced 7.1 s after it, with a press | cleared by the next read at +6.0 s, but `synced` while the note was still unsent until +131.6 s (issue #293) | with the press the words ask for: "sent 1 change." at +1.8 s, synced |
| Journal faulted, a new note, desktop | — | pass: the restart words at +6.0 s, standing through a minute of answered reads; only the version posts refused (4) | pass: the same (3) |
| Journal: the restart | — | fail: the restart words stood 294.8 s after the restart, until the next walk sent the note again | pass: with the press the words ask for, "sent 1 change." at +1.6 s, synced at +7.1 s |

- **The journal's recovery is why the words changed.** A change the server
  refused goes again at the next walk of the vault, up to five minutes later
  (`WALK_MS`), and a person who has just restarted the server was still told
  to restart it. The words now end "then select Sync now.", which sends it at
  once.
- **The nonce log's recovery shows issue #293 on this path.** A read clears
  the refusal, and then the status reads `synced` over a note that is still
  unsent until the next walk. The fix belongs to #293: an unsent change keeps
  the status from `synced`.
- **Sweep, after, final:**
  - status item: the attention icon with the sentence;
  - Show sync status: "What to do", the sentence, **Retry now**;
  - notices: the Sync now answer is the sentence, once;
  - console: warnings only, `http … status=503 decision=refused
    code=nonce_log_faulted` or `code=journal_faulted`; no error-level,
    uncaught or rejection line in any of the four after runs;
  - settings: unchanged.
- Not attempted: a phone. A phone says the sentence once in a notice, the
  same as every standing refusal (#209).

## Also run

- `scripts/ci/image-smoke.sh`, whose property 9 now sends one signed chunk
  onto the exhausted volume: `properties=11 decision=pass` on the after
  image; on the before image it refuses with `a chunk the full blob volume
  cannot hold was not refused 507 storage_full` (`answered 500, not 507:
  'io_error'`).
