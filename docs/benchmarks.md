# Benchmarks — LiveSync is the reference to beat

Dated 2026-09-07. Every number below names the command that produces it.
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
| B2 | Edit propagation, desktop A → desktop B, 1 KiB change | p50 / p95 latency | p50 < 1 s, p95 < 3 s |
| B3 | 2 GiB file upload and download over LAN | MiB/s, peak RSS on server and client | ≥ 3× LiveSync; server RSS < 256 MiB |
| B4 | 20 GiB file, upload killed at 50 %, resumed | bytes re-sent | < 1 chunk |
| B5 | 200 × 20 MiB images burst from mobile | wall time, failures | zero failures |
| B6 | Modify 1 MiB inside a 4 GiB archive | bytes uploaded | ≤ 16 MiB |
| B7 | Server idle and under B1 on the Pi | RSS, CPU | idle RSS < 64 MiB |
| B8 | Storage overhead for a 10 GiB mixed vault | bytes on disk / bytes plaintext | ≤ 1.01 |

## Harness

`bench/` holds a Rust client (`obsyncd bench <scenario>`) that drives the
obsync API directly, plus a shell rig that starts CouchDB in a container
and drives it with the LiveSync replication shape (documents and batches as
its documentation states) for B1, B3, B4, B6, and B8. B2 and B5 are
measured with real Obsidian instances and a timing script; the method and
device models are recorded with each result. Results are committed under
`bench/results/<date>.md` with the exact commit, hardware, and commands.
