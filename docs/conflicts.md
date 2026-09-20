# Conflicts

Two devices edited the same file before either of them synced. obsync never
discards an edit to resolve that, so exactly one of two things happens.

## A text file is merged

A merge happens only when ALL of these hold, and any one of them failing gives
you a conflict copy instead:

- **It is a text format**: `.md`, `.markdown`, `.txt`, `.csv`, `.json`,
  `.yaml`/`.yml`, `.ts`, `.js`, `.css`, `.html`, `.xml`, `.toml`, `.ini`,
  `.log` — and the local file holds no NUL byte.
- **Both sides are under 8 MiB**, the chunk ceiling: a merge input is held
  whole in memory, so the incoming version must be a single chunk, and so must
  the version the two devices last agreed on. A 12 MiB `.csv` or `.log` is
  never merged, extension notwithstanding; the log line says
  `reason=base_above_one_chunk` when it was the common ancestor that was too
  large.
- **The two versions share a common ancestor.** Two devices that independently
  created the same path have none — there is nothing to merge against, and
  neither side is a later version of the other.
- **The two sides are close enough to align.** The merge lines up each side
  against the common ancestor with a table bounded at 4,000,000 cells, counted
  after the shared opening and closing lines are trimmed. Two versions that
  differ by thousands of lines in the middle exceed it, the merge answers
  `too_large`, and you get a conflict copy. Ordinary note editing is nowhere
  near this.
- **The changes do not overlap.** Edits in different parts of the file merge
  silently and you see one file with both changes; when both devices changed
  THE SAME lines, the merge stops rather than guessing.

## Everything else becomes a conflict copy

A conflict copy is a new file beside the original, in the same folder:

```text
Notes/Ideas.md  ->  Notes/Ideas (conflict from iPhone, 2026-09-07 1432).md
```

- The name is the original's, plus `(conflict from <device>, YYYY-MM-DD HHmm)`
  before the extension. The timestamp is the local time on the device that
  wrote the copy.
- `<device>` is the other device's name, as it appears in the plugin's Devices
  list. Characters a vault or a filesystem rejects are replaced with spaces and
  the name is cut to 40 characters, so a device named from another machine can
  never shape the path.
- A file with no extension keeps none; a dotfile keeps its leading dot.

Nothing is lost: the original keeps one side of the edit and the copy carries
the other. There is no third state and no silent overwrite.

## What to do with one

1. Open both files and decide what the merged note should say.
2. Edit the original until it is right.
3. Delete the conflict copy. It is an ordinary file in your vault, so deleting
   it syncs like any other deletion, and the 30 days of version history
   (`docs/storage.md`) still hold both sides if you want them back.

## Avoiding them

- Let a device finish syncing before editing the same note on another one. The
  status bar reads `obsync: idle` when there is nothing in flight. This is the
  only one of these that helps with a large file or a file two devices created
  independently, because neither of those can ever merge.
- Do not run a second sync tool on the same vault. Two writers produce
  conflicts neither tool can reconcile, and obsync can only see its own.
- On a device that has been offline for a long time, open Obsidian and let
  **Sync now** finish before editing.
