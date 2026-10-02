# Windows native preparation — 2026-10-02

This is a source preparation branch, with no release or version claim.

## Real Obsidian journey

[Hosted run 37074994057](https://github.com/snaraj/obsync/actions/runs/37074994057)
passed at source `4384669dbd642bdb075a6af886e323b736e15e53` on Windows Server
2025, using Obsidian 1.13.7 and Electron 43.3.0. The tested plugin `main.js`
SHA-256 was `1e1a7b78ac8f12d329aeb75dc2df2de434d3082829954be411aee4276f0f50a1`.
The server was built from the same source and ran in the disposable WSL 1
fixture behind the existing loopback TLS harness.

The existing real-app harness passed all 13 steps in 119.4 seconds:

- Setup and pairing through the plugin settings and dialogs.
- Notes in both directions, rename, nested and empty folders.
- Ten edits reached the other disk: p50 1024 ms, p95/max 1032 ms.
- Both open editors received 99 keystrokes each over 20.076 seconds. Every
  token was in both editors and both disks 10.430 seconds after typing stopped,
  with no conflict copy.
- Watcher-independent listing, edits, rename and deletion reconciled.
- NTFS case-only rename, trash propagation and locked-file recovery passed.
  The locked edit arrived after release of the deliberately held file.
- The workflow's owned-fixture cleanup completed.

These are functional measurements on a hosted runner. They are not a quiet
latency comparison, a claim of acceptable interactive latency, or visual
approval from screenshots. Later source changes need their own evidence.

## Filesystem custody and installer

The separate helper journey has not passed. Runs
[37073813442](https://github.com/snaraj/obsync/actions/runs/37073813442),
[37074608011](https://github.com/snaraj/obsync/actions/runs/37074608011),
[37074988284](https://github.com/snaraj/obsync/actions/runs/37074988284) and
[37075280213](https://github.com/snaraj/obsync/actions/runs/37075280213) refused
during trusted setup, before custody, context recovery or installation proof.
The bounded diagnostics identify an `ArgumentException` during request JSON
parsing. Those failures remain part of the evidence.

Public Windows export, context mutation and installation remain unavailable.
The live sync journey does not establish private export publication, trusted
bootstrap, crash recovery, or power-loss durability.
