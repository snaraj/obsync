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
| B1 | N notes of 2 KiB, four requests in flight (the desktop default), each note `PUT` then version post, as the plugin sends a note of at most 1 MiB |
| B1 fsyncs | the same shape for 500 notes under `strace`: fsync calls per note |
| B2 wire | a device already long-polling; the other pushes a 1 KiB edit (`PUT`, version post); time until the first has the version AND the bytes |
| B2 end to end | two real Obsidian instances (`scripts/ci/obsidian-drive.mjs`): an edit written into one vault, until the other vault's file holds it, read every 250 ms |
| B3 | 2 GiB in 4 MiB chunks (the chunker's target), one in flight as the plugin's budget allows; down in batches of three |
| B7 | a 60 s idle window on the fresh server, and again after B1 |

`.github/workflows/bench.yml` runs it nightly on amd64 and arm64 and keeps the
results as the run's artifact for 90 days; nothing is committed from CI. It is
not a regression gate: shared runners are too noisy for a threshold.

**The series breaks at 1.1.5 (#275).** Until then B1 and B2 sent a
`POST /v1/chunks/exists` before each note's `PUT`, which the plugin stopped
doing for notes of at most 1 MiB (#195). Every B1 and B2 figure below dated
before this change was measured with that third request, one more signed
request and nonce flush per note: compare B1's wall time, requests/s and
fsyncs per note, and B2's latency, only within one side of the break.

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

## Where the time goes (1.1.5, 2026-09-29)

Measured on one Apple M1 Max laptop (macOS 27, APFS) that other work kept at
load averages of 25 to 240, so every time below is a shape, not a floor: two
builds are compared only in interleaved runs under the same load, as ratios,
with the load named. Counts (requests, flushes) do not depend on load. The
desktop rows drive two Obsidian 1.13.4 instances over DevTools against a
loopback server; the route rows use a signed load generator holding N
requests in flight on fresh four-device servers. Neither tool ships here;
[the run record](validation-runs/2026-09-29-speed.md) has the method. The
Linux rows are this repository's `scripts/ci/bench.sh`.

### What a person waits for (1.1.4, load 25 to 57)

| Path | Time | Where it goes |
| --- | --- | --- |
| A word typed on desktop A, until B's open editor shows it (20 rounds) | p50 2.25 s, p95 2.29 s | 2.01 s is Obsidian's own delay before it writes the note to disk; 0.15 s obsync's settle (`EDITOR_SETTLE_MS`); about 50 ms the server's three requests; 26 ms B's write |
| First sync up, 7,703 files, 317 MiB | 224 s, 34 files/s | four pushes in flight, each p50 102 ms: `PUT` 46 ms and version post 29 ms as the plugin saw them; pushes/s fall from 48 to 28 as the vault grows, because every push waits for a rewrite of the plugin's whole state file |
| First sync down, the same vault | 148 s, 52 notes/s | the server's share is 2.7 s of batched reads; the rest is B writing one note at a time, with two full flushes each (#202) |
| Sync now with nothing changed, 7,700 notes | 3.7 to 4.2 s | every note up to 8 MiB is read and hashed again (#197) |

### The server's time is flushes

A new note costs five full flushes: the chunk `PUT` waits for the nonce log,
the blob file and the blob directory; the version post for the nonce log and
the journal. On this laptop one `F_FULLFSYNC` takes about 7 ms and the device
barely overlaps them: 142 flushes/s from one thread, 178 from two, 220 from
four, 333 from sixteen (each thread appending 100 bytes to its own file and
calling `sync_all`, 3 s per row). In a `sample` profile of the server under
the plugin's upload shape (a `PUT` and a version post per note, four in
flight), 64 % of the request threads' blocked samples were flushes, 23 %
`write`, 5 % creating a new fan-out directory, 4 % `rename`, 3 % opening
the temporary file. The server's own code was too small to rank.

### What 1.1.5 changes

**Version posts commit in groups** ([storage](storage.md), durability rule
2): posts queued behind the journal's flush share the next one, each still
answered only once its own frames are durable. **SHA-256 runs 1.2× to
1.7× as fast** here, without SIMD or `unsafe` (a rolling 16-word schedule,
rounds that rename registers instead of shifting them). **Streamed bodies move 64 KiB
per call** instead of 8 KiB: an 8 MiB chunk takes 128 reads and writes
instead of 1,024.

Interleaved on the lab Mac, three rounds, load 52 to 157, 1.1.4 → 1.1.5,
median of rounds:

| Route, requests in flight | Throughput | p50 | Server CPU per request |
| --- | --- | --- | --- |
| Version post, 16 | 45 → 146/s (3.2×) | 351 → 99 ms | 0.46× |
| 4 MiB chunk `GET`, 4 | 308 → 482 MiB/s (1.56×) | 45 → 31 ms | 0.51× |
| 4 MiB chunk `PUT`, 1 | 14 → 22 MiB/s (1.57×) | 157 → 98 ms | 0.66× |
| Version post, 1 and 4; a note (`PUT` + post), 4 | 0.79×, 1.06×, 0.80× | | 1.00×, 0.90×, 1.07× |
| Control, `GET /v1/account`, 1 (untouched) | 0.94× | | 1.08× |

The last two rows are inside this laptop's noise: an earlier interleaved
run of this change (four rounds, two hours earlier) put the same three at
0.98×, 1.28× and 1.19× and the control at 1.19×; single posts alone, six
rounds at load 31 to 65, came out at 0.97× (p50 19.4 → 20.6 ms) beside a
control at 1.10×. At the plugin's four in flight most posts still
find the journal idle. On real Obsidian, uploading to 1.1.5, the server
made 2,417 posts durable with 2,140 journal flushes (0.89 per post) at
load 60 to 240, and 1,569 with 1,394 (0.89) at load 80 to 160. The group
commit pays when several devices post at once.

`cargo test --release -p obsync-core -- --ignored sha256_throughput
--nocapture` at each build, alternated three times, load 70 to 100: 1.21×
to 1.74× (1.1.4 115, 115, 82 MB/s; 1.1.5 166, 139, 143 MB/s).

On Linux, the harness above (`OBSYNC_BENCH_SCALE=full
OBSYNC_BENCH_COMPOSE_OVERRIDE=<subnet override> scripts/ci/bench.sh <image>
results/`) in the same laptop's Docker VM, images built with `docker build`
from 1.1.4 and from 1.1.5, two runs each, alternated, load 60 to 245 at
the start of each run:

| Scenario | 1.1.4 | 1.1.5 |
| --- | --- | --- |
| B3, server CPU for 2 GiB up and down | 21.0 s, 18.3 s | 11.9 s, 11.0 s |
| B3 up / down | 65 / 257, 68 / 310 MiB/s | 74 / 328, 83 / 339 MiB/s |
| B1 fsyncs (with `exists`, before #275) | 5.73, 5.70 per note | 5.69, 5.67 per note |
| B1 (with `exists`, before #275) | 82.1 s, 77.9 s | 76.7 s, 83.0 s |

Moving 2 GiB up and down costs the server 42 % less CPU: every uploaded
byte is hashed, and every downloaded byte copied, by the two paths the
SHA-256 and buffer changes touch. A Linux `fsync` is fast enough that four
clients rarely queue behind one, so B1's flushes and wall time do not move.

**A new fan-out directory is made durable in its parent (#273)**, which
costs a full flush for each chunk that opens a new leaf (two for the first
chunk under each of the 256 first levels). On a store of N chunks a new
chunk opens a leaf with probability e^(−N/65,536): 94 % of the chunks of a
7,700-note first sync into an empty store, 47 % at 50,000 chunks, 10 % at
150,000. The same harness at
`OBSYNC_BENCH_SCALE=smoke` (1,000 notes, then 200 under `strace`, two
requests per note since #275), images from this branch before and after
the change, two runs each, alternated, load 36 to 116:

| Scenario | Before #273 | After |
| --- | --- | --- |
| B1 fsyncs, a fresh store | 4.88, 4.92 per note | 5.88, 5.93 per note |
| B1, 1,000 notes | 6.7 s, 6.1 s | 7.0 s, 5.6 s |

One more flush per new note on Linux does not show in B1's wall time. On
the lab Mac a chunk `PUT` that opens a leaf waits for one more
`F_FULLFSYNC`, about 7 ms; an interleaved run of single uploads there
(put_small, four rounds, load 27 to 249) was inside the laptop's noise.

**A first sync stops rewriting the plugin's data file once per note
(#274).** The same 7,703-file vault on two desktop rigs, the same 1.1.5
server, the 1.1.4 plugin against this one; the uploading rig shown (not
focused) while it uploads, since a minimized one ran 27 times slower
(below); `saveData` wrapped to count every write:

| First sync up, A | 1.1.4 plugin | 1.1.5 plugin, three runs |
| --- | --- | --- |
| Writes of the data file | 7,451 | 211, 233, 253 |
| JSON written | 9.29 GB | 0.22, 0.23, 0.27 GB |
| Time spent writing it | 159 s | 7.7, 7.9, 11.2 s |
| First push to last | 302 s | 233, 250, 281 s |
| Pushes/s, first thousand → last | 24.8 → 19.0 | 30.6 → 27.5, 33.6 → 23.2, 33.2 → 20.2 |
| Load average | 23 to 39 | 20 to 50, 14 to 24, 23 to 29 |

The writes fall 30 to 35 times and the bytes 34 to 42 times. The upload's
wall time moves less, 7 to 23 % on one run before against three after on
a loaded laptop, and pushes still slow across the thousands: what remains
of that slope is other work that grows with the vault (below). Every
download that finished was byte-identical to the upload (7,703 files); the
download is unchanged, 140 s before, 161 s and 135 s after. The first
download after the change stalled part way and was stopped; it did not
recur in the two runs after it ([run record](validation-runs/2026-09-29-speed.md)).

**A minimized Obsidian window syncs far slower, and 1.1.5 lifts that
while it has work (#283).** Mid-upload, rig A made 1.35 notes/s over 20 s
minimized and 37 over the next 20 s shown without focus (load 27). Its
renderer sat at 0.1 % CPU while minimized, with `setTimeout(0)` taking up
to 224 ms: the window, not obsync, set the pace. On rig A alone, with no
sync running, every page timer of 10 ms or more waited for a one-second
wake-up while minimized, and obsync's worker clock (#221) took three times
its delay:

| Wait asked for | Shown | Minimized | Minimized, throttling lifted |
| --- | --- | --- | --- |
| 10 ms page timer | 11 to 12 ms | 994 to 1,021 ms | 12 ms |
| 100 ms page timer | 101 ms | 996 to 1,010 ms | 102 ms |
| 1,000 ms page timer | 1,002 ms | 2,000 to 2,012 ms | 1,002 ms |
| Ten chained 10 ms timers | 111 ms | 9.7 to 37 s | 111 to 117 ms |
| 100 ms worker timer | 103 to 107 ms | 295 to 304 ms | 103 to 108 ms |

The upload slowdown depends on load and the timers do not. At load 5 to
8 the 1.1.5 upload made 30.4, 27.2 and 36.0 notes/s over 30 s minimized
against 37.1, 31.2 and 31.2 shown, within 20 %, while the download made
33.5 and 31.2 minimized against 64.1 and 56.7 shown. So the plugin now
lifts its window's background throttling while it has work and puts it
back when none is left, a line each (`host decision=throttle_lifted` /
`throttle_restored`). The same rigs after the change, at load 9 to 37:
uploads 36.8, 31.6 and 22.2 minimized against 37.9, 36.0 and 30.2 shown;
downloads 52.9, 26.4 and 24.7 against 39.2, 53.8 and 23.6. The load moved
too much within the run to read a ratio closer than that. A 20-note folder
renamed on A reached B in 1.2 to 1.3 s with A shown, and in 1.4 to 1.6 s
with A minimized for 30 s or for more than five minutes. The whole session
lifted and restored 18 times on the two rigs, one span of work each. An
idle renderer cost the same with the throttling restored as with it left
lifted: 16 ms of CPU a minute.

**A device woken after a stall no longer reads `offline` (#288).** Two
rigs had their renderers stopped for 25 s, 2 s into a long poll, and were
then shown again. Before this change, the window's return dropped the
poll, and its replacement waited 20.01 s on the device before it reached
the server. It then ran out of its 70 s budget five seconds before its
answer, and A read `offline — retrying` for 56 s. A second request for a
URL still in flight waits 20 s on the device, and one whose URL differs
does not. The same queue follows a Sync now press or a focus that dropped
a poll, with no stop at all. Before the change, five of six presses and
focuses on one rig led to a false `offline`. After it, a window's return,
a focus or a press keeps the poll, and a read beside it answers in 12 to
27 ms. A timeout while the server answered something else is not
`offline`. No request waited on the device, and no `offline` appeared
([run record](validation-runs/2026-09-29-speed.md)).

**A run of 5xx answers no longer piles up long polls (#297).** One rig
behind a hop that answered every chunk upload 500 for 240 s. Before this
change, each answer that came after a 500 dropped the long poll in
flight, which `requestUrl` cannot withdraw. There were four drops, up to
four polls held on the device at once, and two replacements that reached
the hop 20.00 s after they left. After it, every wake but a new address
or the network coming back keeps the poll and reads beside it. There was
one poll held throughout, reads beside it in 9 to 18 ms, and no poll
waiting on the device. A wake's line now says how many polls the device
holds (`polls_in_flight`)
([run record](validation-runs/2026-09-29-speed.md)).

### What still bounds each path

Each needs a decision outside what 1.1.5 changes: B's one-note-at-a-time
apply with two flushes per note (first sync down, #202); re-hashing every
note (Sync now, #197); Obsidian's own save delay (typing); and, on the
server, the five flushes a new note costs (six while the store is young,
#273), which the protocol (two requests per note) and the blob layout (a
new directory for most early chunks) fix. What remains of the upload's
slowdown across the thousands is smaller. The push of a new note no longer
scans every record for a case-only twin of its name: a state index answers
(P10). The main thread's time per new-note push at 7,700 to 9,500 records
went from 1.15 to 0.38 ms. That is about 3 s over a 7,700-note first sync,
measured over the real push path at load 18 to 20; an earlier estimate of
3.9 ms and 15 s came from a microbenchmark on a loaded machine.
