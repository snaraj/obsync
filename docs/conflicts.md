# Conflicts

Two devices edited the same file before either of them synced. obsync never
discards an edit to resolve that, so exactly one of two things happens.

## A text file is merged

Markdown and the other text formats (`.md`, `.markdown`, `.txt`, `.csv`,
`.json`, `.yaml`/`.yml`, `.ts`, `.js`, `.css`, `.html`, `.xml`, `.toml`,
`.ini`, `.log`, and only when the file holds no NUL byte) are merged line by
line against the version both devices last agreed on. Edits in different parts
of the file merge silently and you see one file with both changes.

When the two devices changed THE SAME lines, the merge stops rather than
guessing, and you get a conflict copy instead.

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
  status bar reads `obsync: idle` when there is nothing in flight.
- Do not run a second sync tool on the same vault. Two writers produce
  conflicts neither tool can reconcile, and obsync can only see its own.
- On a device that has been offline for a long time, open Obsidian and let
  **Sync now** finish before editing.
