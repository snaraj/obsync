# 2026-10-01: a start that cannot read the feed (#248)

What a device does with a note emptied while obsync was stopped, when its
start cannot read the server's change feed, and what the next start that can
read it does. This is the 1.1.5 behaviour reviewed in the train's last round:
such a file is held for that run only, and judged again by the next engine.

## Setup

- One macOS desktop: Obsidian with its own `--user-data-dir`, a fresh lab
  vault, the plugin built from the train at `2fe0c848`; one loopback
  `obsyncd` built from the same commit; a lab intermediary between them that
  cuts the start's walk of the feed (`GET /v1/changes`, `wait=0`,
  `limit=1000`) while armed, and passes everything else.
- SHA-256: `obsyncd` `afd00acb7b03ad5e907bc5b87009956e29d7eaa3724c03328ba928a5eb6b64e5`;
  `main.js` `34797c29613f28104157e09de46dc713be862269bdebca11c587ebe8c2522b11`;
  `manifest.json` `ed84bd8d8d6f4e316d96ecddc8e097704a8719367781ac35d61cff7b4dba463d`;
  `styles.css` `43dd0db8ccce20e88a3c63ec2ea35e46ce4133912c0e797da036e37a6499287b`.
- The device: a macOS desktop (laptop). Its model, the macOS version and the Obsidian version: not recorded
  during the run. The plugin arrived by the lab script copying the built `main.js`, `manifest.json` and
  `styles.css` into the vault's plugin folder (not through Community Plugins); the page reported plugin
  version 1.1.5.
- The vault synced `Crash/Kept.md` and `Crash/Old.md` (sentinel text), then
  Obsidian was quit. While it was stopped, `Crash/Fresh.md` was made empty (a
  new file) and `Crash/Old.md` emptied (a recorded note), and the
  intermediary armed. Published versions are counted in the server's own log
  (`POST /v1/files/{file_id}/versions`, `201`); the marks and records are the
  plugin's state, read in the page.

## Results

| Step | `Crash/Fresh.md` | `Crash/Old.md` | Published versions |
|---|---|---|---|
| Synced, before the stop | not yet made | recorded, 44 bytes | 5 |
| Start, walk cut (13 cuts), +96 s | held: `unverified`, no record | held: `unverified`, record 44 bytes | 5 |
| Sync now while still cut | read, held, mark kept | read, held, mark kept | 5 |
| Intermediary disarmed, engine restarted in place | sent: record 0 bytes, no mark | sent: record 0 bytes, no mark | 7 |

- While the walk was cut, nothing was sent, through a Sync now that read both
  files (`sync_now decision=drained ... differing=2 read=2`).
- The restart in place (`restartEngine`, a new engine on the same state, as a
  scope save makes) read the feed, found no version ahead at either name, and
  sent both as the person's own empty notes: the two versions the server
  counted, and no mark left.

## Not covered here

- A phone (deferred to #314, v1.1.6). The empty landing #248 is about is Android's dropped write; this
  run proves the start's hold and its end on a desktop, where an emptied note
  takes the same path. The landing itself is held to the plugin's tests.
- A second device reading the two empty notes back (#314).
- A reload (Obsidian quit and started) after the blind start; the plugin's
  tests cover it beside the restart in place.

The rig, the server and the intermediary were stopped at the end of the run,
and the lab folder removed.
