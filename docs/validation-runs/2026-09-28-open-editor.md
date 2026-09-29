# An open note and the stale editor — 2026-09-28

Issue #252: on the owner's Mac, a note open in Obsidian stayed at
`obsync: syncing 1` after a phone changed it, and nothing said why. This run
finds the cause, checks a first fix on a real iPhone, records how that fix
failed, and checks the fix that replaced it.

## Setup

- Desktop: Obsidian 1.13.4 on macOS 27.0, an isolated profile with its own
  disposable vault (the lab vault, about 7,700 files), driven through its
  DevTools port.
- Phones: the owner's iPhone, Obsidian 1.13.7, a disposable vault per build,
  driven through iPhone Mirroring; and an Android 15 emulator, Obsidian
  1.13.4, driven through its DevTools port.
- Server: obsyncd from this branch on the Mac's loopback. The iPhone reached
  it through a quick tunnel; the emulator through `adb reverse`.
- Builds (`main.js` SHA-256):
  - first fix: `250abdeebccd7eee418bcc3674b9c233d433fae3b84678c4ce6ca0f65dfd8151`
    (the iPhone ran `36d855d0…`, which differs from it in three comment lines);
  - the fix that replaced it:
    `d18f4480e3865ad7302ae15bf1b45599af6b866d0389d08742f8a366be8a4bb2`.

## The cause

The Mac's file-event daemon ran at 100 % CPU for days (Spotlight indexing
beside it). Obsidian reloads an open note when its file watcher reports an
outside change, and the starved watcher reported nothing. obsync wrote the
phone's version to disk; the open editor kept the old text. obsync then
compared the editor with the file, found them different, and took the
difference for unsaved typing: every later version of the note was held
(`active_editor`), and the status said only "syncing 1".

## The first fix, and how it failed

The first fix read Obsidian's `TextFileView.data` as "what this view last
loaded or saved": a view whose text equalled it had nothing typed, so a stale
view held nothing back, and obsync loaded what it wrote into such views.

On the iPhone, at the first fix:

1. **Phone edits, desktop idle: passed.** A line typed on the iPhone into a
   note open and idle on the desktop reached the desktop's disk, and the
   desktop's editor showed it; obsync logged `editor_refreshed views=1` and
   the desktop read `idle`.
2. **Desktop edits, phone open: passed.** A line added on the desktop showed
   in the iPhone's open editor within about 5 s.
3. **Both type: failed.** The desktop typed at the end of the note for 60 s
   while the iPhone typed at the end of its first line. The iPhone showed five
   "merged concurrent edits" notices, and the note ended with the first line's
   own text gone and the desktop's typing inside it. Its earlier versions
   remain in history.

Measured next, on the desktop: after one trusted keystroke, `data` already
equalled the editor's text, before any save. `data` follows every keystroke,
so every view read as untyped, and obsync wrote merges under typing on both
devices.

## The fix that replaced it

A write judged safe now remembers what the note's editors showed at that
moment, which was the file's text. After the write lands, each view still
showing exactly that text loads the written text; a view typed in since shows
something else and is left alone. A view that differs from its file holds the
note, as before 1.1.4. `data` is read nowhere.

On the emulator and the desktop, at the replacing fix: the emulator typed into
a note's first line while the desktop typed at its end, both for 40 s, with
trusted keystrokes. Both statuses named the note ("waiting for unsaved changes
in …"), both went idle, and the note ended exactly as typed on both devices,
each side's run whole, with no conflict copy.

On the iPhone, at the replacing fix, in a fresh vault paired again (its first
sync pulled 7,724 files):

1. **Phone edits, desktop idle: passed.** "hello" typed on the iPhone reached
   the desktop's disk, obsync loaded it into the desktop's open editor
   (`editor_refreshed views=1`), and the desktop read `idle`.
2. **Desktop edits, phone open: passed.** A line added on the desktop showed
   in the iPhone's open editor within about 5 s.
3. **Both type, on different lines: passed.** The iPhone typed "alpha bravo
   delta" at the end of the first line while the desktop typed at the end of
   the note for 60 s. The desktop's status read `syncing 1 file, waiting for
   unsaved changes in <note>` while both typed, then `idle`. Both devices
   ended with the same text: the first line with the iPhone's words, the
   desktop's whole run (419 characters), and no conflict copy.
4. **Both type at the same place: one conflict copy, nothing lost.** In an
   earlier attempt the iPhone's words landed at the end of the note, where
   the desktop was typing too. Two insertions at one place are a conflict by
   design: the note kept the desktop's run, and the iPhone's words went into
   one conflict copy, written by the third device holding both versions (the
   emulator). Neither editor was loaded over while typing.

After the checks: the iPhone's status icon at the check mark with no notice on
screen (its **Show sync status** read `idle`, 7,724 files, before the checks);
the desktop `idle`, its icon at the check mark, nothing waiting to be written,
and no notice open.

## After the review of the fix

The review of the replacing fix found three windows around the refresh: a
desktop awaited a read between judging the editor and renaming the file; one
view's load could reach a tab another load had moved to another note; and a
save of the same size could land after the write and be loaded over. They are
closed in code and pinned by unit tests. On two macOS desktops sharing the lab
vault, at that build:

1. **One edits, the other idle: passed.** Each desktop's edit reached the
   other's open editor within about 1.4 s (`editor_refreshed views=1` on
   each), and both read `idle`.
2. **Both type, on different lines: passed.** One desktop typed at the end of
   a note while the other typed into its first line, 85 characters each over
   30 s, with trusted keystrokes. Both statuses named the note while they
   typed, both went idle, and both disks and both editors ended exactly as
   typed, each with one refresh and no conflict copy.

The iPhone and the emulator were not run again at this build.

## Not covered here

- Windows and Linux desktops: the same code path, not run on a device here.
- A note left stale by a change from another program that Obsidian missed is
  still held until its tab is closed and opened again: nothing on the view
  says whether the difference is typing.
