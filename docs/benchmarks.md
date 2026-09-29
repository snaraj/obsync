# Benchmarks — LiveSync is the reference to beat

*Internals, for contributors and reviewers.*

Dated 2026-09-26. Every number below names the command that produces it.
The competitor runs only inside a throwaway container during a benchmark
run and ships in no artifact (AGENTS.md requirement 5).

## What LiveSync does (from its own documentation, 2026-09)

- Backend: CouchDB replication over HTTP (or S3-compatible, or P2P).
- Chunks stored as CouchDB documents; binary files as base64 text (+33 %
  on the wire and at rest before compression).
- DEFLATE level 8 per chunk, then AES-256-GCM with HKDF (E2EE v2).
  Reported: 9.0–9.1 % storage saved, upload wall time +197–199 %, CPU
  +581–650 %; median upload 1.49 s → 4.45 s with E2EE.
- Conflicts: three-way text merge from the nearest common ancestor when
  history is present; binary conflicts pick the newer mtime.
- Files above `syncMaxSizeInMB` are skipped.
- Garbage collection is a manual ceremony that must wait for every device.
- HTTPS mandatory on mobile; CouchDB needs a reverse proxy with raised body
  limits and disabled buffering.
- Replication batches: 50 documents, 40 concurrent batches.

## Scenarios and targets

| # | Scenario | Measure | Target vs LiveSync |
| --- | --- | --- | --- |
| B1 | 10 000 notes of 2 KiB, initial upload from one desktop | wall time, server CPU s | ≥ 2× faster, ≤ ½ CPU |
| B2 | Edit propagation, desktop A → desktop B, 1 KiB change | p50 / p95 latency, from the write on A to the file on B's disk | p50 < 1.5 s, p95 < 3 s |
| B3 | 2 GiB file upload and download over LAN | MiB/s, peak RSS on server and client | ≥ 3× LiveSync; server RSS < 256 MiB |
| B4 | 20 GiB file, upload killed at 50 %, resumed | bytes re-sent | < 1 chunk |
| B5 | 200 × 20 MiB images burst from mobile | wall time, failures | zero failures |
| B6 | Modify 1 MiB inside a 4 GiB archive | bytes uploaded | ≤ 16 MiB |
| B7 | Server idle and under B1 on the smallest supported node | RSS, CPU | idle RSS < 64 MiB after B1, growing by no more than 1.5 KiB per further retained version ([storage](storage.md#memory)); a start peaks within a few MiB of it |
| B8 | Storage overhead for a 10 GiB mixed vault | bytes on disk / bytes plaintext | ≤ 1.01 |

**B2's target follows from the plugin, not the other way round.** The
desktop watcher waits 500 ms after a change and then re-reads the file 400 ms
later to be sure it has settled (`plugin/src/sync/engine.ts`), so 0.9 s passes
before the first byte leaves the device. A p50 under 1 s is not reachable
while that wait stands, and the earlier target said it was. p95 < 3 s is the
same promise [validation](validation.md) V3 makes to a person. The harness
reports B2 twice: end to end as above, and the network-and-server part alone
(push to observe), so a change to either half shows up in its own number.

B4, B5, B6 and B8 are not measured yet, and nothing here has been run against
LiveSync: the targets' comparison column is still a goal, not a result.

## Harness

`scripts/ci/bench.sh <image> <results-directory>` brings up the Compose
deployment ([server](server.md), `deploy/compose`) with that image and runs
`scripts/ci/api_flow.py bench` against it, through Caddy over TLS, as two
signed devices. The client runs in a container that shares the server's PID
namespace, so it reads the server's own counters: CPU and resident memory from
`/proc/<pid>/stat` and `/status`, bytes written from `/proc/<pid>/io`, and --
in separate passes that are never timed, because tracing slows every call --
fsync calls with `strace -c` on every thread.

| Scenario | What the harness does |
| --- | --- |
| B1 | N notes of 2 KiB, four requests in flight (the desktop default), each note `POST /v1/chunks/exists`, `PUT`, version post, as the plugin does |
| B1 fsyncs | the same shape for 500 notes under `strace`: fsync calls per note |
| B2 wire | a device already long-polling; the other pushes a 1 KiB edit; time until the first has the version AND the bytes |
| B2 end to end | two real Obsidian instances (`scripts/ci/obsidian-drive.mjs`): an edit written into one vault, until the other vault's file holds it, read every 250 ms |
| B3 | 2 GiB in 4 MiB chunks (the chunker's target), one in flight as the plugin's budget allows; down in batches of three |
| B7 | a 60 s idle window on the fresh server, and again after B1 |

`.github/workflows/bench.yml` runs it nightly on amd64 and arm64 and keeps the
results as the run's artifact for 90 days; nothing is committed from CI. It is
not a regression gate: shared runners are too noisy for a threshold.

## Baseline

One run, recorded by hand, 2026-09-26, image built from the 1.1.4 release
train at `6fd61bf` (the server as that commit has it):

```sh
OBSYNC_BENCH_SCALE=full OBSYNC_BENCH_COMPOSE_OVERRIDE=<override moving the subnet> \
  scripts/ci/bench.sh obsync:local results/
```

The override was needed only because that laptop already held the Compose
file's subnet; it moves the subnet and the server's trust list, nothing else.
Machine: Docker Desktop on an Apple silicon laptop, the Linux VM given 5 CPUs
and 7.7 GiB, kernel 5.15 (arm64), load average 5 to 6 from other work during
the run. One laptop run is a shape and an order of magnitude, not a floor.

| Scenario | Result | Server |
| --- | --- | --- |
| B7, fresh | idle 60 s | 1.2 MiB RSS; 0.1 s CPU; 15 fsync calls; 0.06 MiB written |
| B1 | 10 000 × 2 KiB in 60.9 s: 164 notes/s, 492 requests/s | 10.5 s CPU; 244 MiB written; 21 MiB RSS |
| B1 fsyncs | 7.0 fsync calls per note, 2.3 per request | |
| B7, after B1 | idle 60 s, 10 000 notes held | 22 MiB RSS; **11.9 s CPU**; 10 fsync calls; 0.04 MiB written |
| B2 wire | 30 edits: p50 47 ms, p95 74 ms | |
| B2 end to end | 10 edits, Obsidian 1.13.7 on Linux, through Caddy: p50 1014 ms, p95 1023 ms | |
| B3 | 2044 MiB up at 86 MiB/s, down at 345 MiB/s | 22 MiB RSS during; client 81 MiB |

The end-to-end B2 row is `scripts/ci/proxy-e2e.sh <image> caddy --then
scripts/ci/obsidian-e2e.sh` on the same machine, with the Obsidian instances in
a Linux container. Its figures are upper bounds within 250 ms, the interval at
which the driver reads the other vault's disk, so the p50 is the watcher's
0.9 s plus at most about 0.1 s.

### Idle CPU after B1 (#216)

The baseline's B7 after B1 spent 11.9 s of CPU per idle minute: on 1.1.3 and
on the train as `6fd61bf` had it, a store smaller than one scrub step came
out of every step with its whole pass complete, and the next step began the
next pass, so the scrub re-read every chunk every four seconds. 1.1.4 lets a
completed pass rest a day, and paces every step to at most one minute of
work in each hour (docs/storage.md, "Integrity").

Two runs by hand, 2026-09-27, same laptop, `OBSYNC_BENCH_SCALE=full
scripts/ci/bench.sh <image> results/` with the same subnet override. The
train's run shared the laptop with a build, so compare its idle rows, not its
B1 wall time:

| Scenario | train `61c5b0a` | 1.1.4 |
| --- | --- | --- |
| B7, fresh | 0.2 s CPU; 15 fsync calls | 0.27 s CPU; 0 fsync calls |
| B1 | 82.1 s; 13.1 s CPU; 244 MiB written | 48.3 s; 7.6 s CPU; 200 MiB written |
| B1 fsyncs | 7.0 per note, 2.33 per request | 5.77 per note, 1.92 per request |
| B7, after B1 | **12.8 s CPU**; 10 fsync calls; 22.0 MiB RSS | **0.36 s CPU**; 0 fsync calls; 16.9 MiB RSS |

A pass still runs: at every start, and a day after the last one began. After
a restart over the same 10,000 chunks, the first pass worked 228 ms over
9.3 s and then rested (a loopback server in a container, CPU read from its
`/proc/<pid>/stat`).
