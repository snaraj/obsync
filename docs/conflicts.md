# Conflicts

*For people using obsync.*

Two devices edited the same note before either of them synced. obsync never
discards an edit to resolve that.

A text note is combined letter by letter: every change from both devices ends
up in one note. Two people typing on the same line, even at the same spot,
both keep what they typed; the same text typed at the same spot on both
devices at once appears once. Text one device deleted stays deleted, and text
one device typed inside something the other deleted is kept. Your notes remain
ordinary files you can open and edit in Obsidian.

While you type, changes from the other device appear in the open note and your
cursor stays where you are typing. Undo takes back only your own typing. A word
your keyboard is still composing, as Android keyboards do with every word, is
finished before the other device's changes come in. On iPhone and iPad,
changes that reach the word you are typing wait until you pause for a moment,
finish the word, or move the cursor: the keyboard there would otherwise put
back the letters it remembers over them.

A second file beside the original, a **conflict copy**, is made only for what
cannot be combined as text. See [below](#everything-else-becomes-a-conflict-copy).

## What to do with a conflict copy

1. Open the original and the file with **conflict from** in its name. You can
   use Obsidian's **Open to the right** action to compare them side by side.
2. Copy the text you want to keep into the original, then check the result.
3. Delete the extra copy when you are satisfied. That deletion syncs too;
   [retained history](storage.md) still holds the earlier versions.

## One device deleted the note while another edited it

The edit stays. You get the edited note back, without a new conflict copy or
repeated successful-resolution notices. The deletion stays in history. If an
edit cannot yet be uploaded, it remains on that device with a warning until
it can be sent.

## A text file is merged

obsync combines two versions into one note when all of these are true.
If any one of them is not, you get a conflict copy instead:

- **It is a text file**: `.md`, `.markdown`, `.txt`, `.csv`, `.json`,
  `.yaml` or `.yml`, `.ts`, `.js`, `.css`, `.html`, `.xml`, `.toml`, `.ini`
  or `.log`.
- **Both versions are smaller than 8 MiB.** A larger text file, such as a big
  `.csv` or `.log`, is never combined.
- **Both versions grew from the same earlier version.** Two devices that each
  created a file with the same name have nothing to combine.
- **obsync can read back to where they grew apart.** After a very long run of
  separate edits, or when an earlier version is no longer kept, it keeps both
  rather than guess; while you type in that note, it waits for the other
  device instead.

Two versions that differ in thousands of places still combine, though text
may land a few words from where its author put it. One case is held instead:
when a plugin rewrites a note by itself right after a sync, such as a
timestamp it updates, on a line another device also changed, obsync pauses
the note rather than join two values into one neither wrote. See
[Stop repeated rewrites](daily-use.md#stop-repeated-rewrites).

The exact rules are in [the architecture](architecture.md#62-plugin-loops),
under Conflicts.

## The same note on two devices is not a conflict

Two devices that start with the same notes -- a vault copied to the second
device by hand, or moved over from another sync tool -- each publish every note
before either has seen the other's. When the two files at one name hold the
same bytes, there is nothing to decide: every device keeps one file and makes
no copy. That holds once every device syncing the vault runs 1.1.2 or later; an
older device still copies identical content, and the copy can simply be
deleted.

Only byte-identical content qualifies. Two notes that differ by one character,
a trailing newline, or their line endings (`\r\n` against `\n`) are two notes
created independently, and you get a conflict copy as described below.

## Everything else becomes a conflict copy

A conflict copy is a new file beside the original, in the same folder:

```text
Notes/Ideas.md  ->  Notes/Ideas (conflict from iPhone, 2026-09-07 1432).md
```

- The name includes the original's name, **conflict from**, the other device,
  and a timestamp. Current shared conflict names use UTC and a short stable
  suffix so devices choose the same copy. Older or locally preserved copies
  can use the earlier local-time format shown above.
- `<device>` is the other device's name, as it appears in the plugin's Devices
  list. Characters a vault or a filesystem rejects are replaced with spaces and
  the name is cut to 40 characters, so a device named from another machine can
  never shape the path.
- A file with no extension keeps none; a dotfile keeps its leading dot.

Nothing is lost: the original keeps one side of the edit and the copy carries
the other. There is no third state and no silent overwrite.

## Avoiding them

- Text notes need no care: type on any device at any time. For a large file, a
  file that is not text, or a file two devices are about to create
  independently, let a device finish syncing before using it on another one.
  The status bar shows a check (`obsync: idle`) when there is nothing in
  flight.
- Do not run a second sync tool on the same vault. Two writers produce
  conflicts neither tool can reconcile, and obsync can only see its own.
- On a device that has been offline for a long time, open Obsidian and let
  **Sync now** finish before editing.
