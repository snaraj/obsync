# Changelog

All notable changes to obsync are recorded here. The format follows
Keep a Changelog; versions follow SemVer. Every artifact-classified merge
advances exactly one SemVer step -- one patch, one minor, or one major
(AGENTS.md, requirement 10).

## 1.1.2 - 2026-09-23

**Sync resumes by itself when the server becomes reachable again.** Until now a
device that opened Obsidian while its server could not be reached -- a laptop
waking before Wi-Fi, a phone away from the home network, a server restarting --
stopped with `obsync: error` and stayed stopped until someone ran **Sync now**.
It now keeps trying on its own: 5 s after the failed start, doubling to every
5 minutes, for as long as Obsidian is open, and at once when the device reports
its network back. The status bar and the settings **Connection** row say
`obsync: offline — retrying` while it waits, and go back to `idle` the moment a
start gets through. Nothing needs pressing when you return; **Sync now** only
makes the next attempt happen now.

**A refusal is still a stop.** A revoked or unapproved device, a signature the
server rejects, a clock too far off, a server that has run out of space, or a
vault key that does not open the vault's records still show
`obsync: error — <reason>` and are never retried by a timer: those need you, and
knocking again would not change the answer. The plugin tells the two apart by
what the server said, not by the wording of a message.

**Same on every platform.** Desktop and mobile use the same timer and the same
`online` event. On a phone, a pause that runs out while Obsidian is in the
background fires when the app returns to the foreground.

Each scheduled retry, each retry run, each resume and each stop writes one line
to the developer console (`engine decision=retry_scheduled ...`,
`decision=retrying`, `decision=resumed`, `decision=stopped reason=start_failed`),
so a device that is not syncing says why.

**Two devices that start with the same notes keep one of each.** A vault copied
to a second device by hand, or moved over from another sync tool, no longer
turns every note into a conflict copy of identical content at first sync. A note
whose bytes are the same on both devices, at the same name, settles on one file
with no copy, whatever order the two devices publish and pull in; a note that
differs by even one character is still kept twice, as a conflict copy
([Conflicts](docs/conflicts.md)). The comparison reads nothing and downloads
nothing: identical notes already share chunk ids. The files on disk are never
written, moved or deleted to settle the pair -- the duplicate is retired on the
server. A device older than 1.1.2 still copies identical content, so update
every device; the copy it makes can simply be deleted. Each settlement writes
one `decision=converged` line naming the id that kept the name and the id
retired (#131).

## 1.1.1 - 2026-09-23

**The setup guide is one press away, and it says which setups are proven.**

### Added

- **Setup guide**, the first row of the plugin's settings on every platform, and the
  command **Open the setup guide** open the project's guide in your browser. The
  address ships with the plugin and the plugin itself sends nothing there;
  Obsidian's help link for the plugin now opens the same page.
- [Choose your setup](docs/setup.md): every way to run and reach the server, what
  each needs, and whether CI or a recorded validation run proves it.

### Changed

- The README opens with the setup guide.

## 1.1.0 - 2026-09-22

**Folders sync now -- an empty one reaches your other devices, and a deleted
one leaves them. That is a new kind of record, so a device still on 1.0.x
refuses each folder with one notice and goes on syncing its notes. Update
every device that syncs the vault, and read "Two folders that differ only in
capitalisation" below if one of your devices shows two.**

This release also carries everything the 1.0.7 work fixed, which had not been
released on its own; those entries are further down, under "Also in this
release", unchanged except where 1.1.0 changed them.

### Folders

**An empty folder now reaches your other devices, and a deleted folder leaves
them.** Until now a folder existed on a device only because a note inside it
did: two empty folders made on a computer never appeared on a phone at all,
and deleting a folder removed its notes everywhere but left the empty tree
standing in every other device's file explorer. Folders are now synced in
their own right -- created, deleted and renamed, in both directions. The
server still cannot read any of it: a folder is stored the same way a note
is, as something only your devices can open.

**A folder is only ever removed when it is empty on that device**, and empty
means empty to the filesystem: a hidden file, a note you do not sync, or
another plugin's data all keep it, and no file is ever taken to make a folder
go. A folder obsync has a record for is removed only by its own deletion
arriving, so an empty folder you keep on purpose does not vanish when its last
note is deleted somewhere else.

**What a device still on 1.0.x does.** It does not know this kind of record,
so it refuses each one: one notice per folder, no file written, nothing
deleted, and its notes keep syncing throughout. On 1.0.6, the newest 1.0.x,
that notice reads "obsync refused a change from another device: it does not
name a plain file inside this vault (version). Nothing was written. File id
..." -- those are the words to search for if you see it. It stops as soon as
that device is updated. This was proved against the decoder shipped in 1.0.0
through 1.0.6, copied into the test suite from the released tag rather than
described; the function that does the refusing, `parseManifest`, is
byte-identical at all seven of those tags -- sha256
`8aa8a2df240bcd8ffba197fc9b2e238bb9b727ef0416007eb526a3082e8aa4de` of it at
each, which `plugin/test/fixtures/decoder-1.0.x.mjs` says how to re-derive.

**Two folders that differ only in capitalisation.** A folder renamed by
capitalisation alone -- `Team docs` to `team docs` -- was published as NEW
notes by versions before 1.1.0, because the computer that made the rename sees
one folder where a phone sees two. Devices that tell the two apart received
the new names and were never told to retire the old ones, so they ended up
showing both: one live folder and one that never changes again. From 1.1.0
such a rename is published as the rename it is, and the device receiving it
renames the folder itself.

**Be precise about what renames it, because that is what decides whether two
devices ever agree.** On a computer, `Team docs` and `team docs` are ONE
folder on the disk, and renaming a note inside it cannot change how the folder
itself is spelled -- the operating system finds the folder by either spelling
and leaves the name it keeps alone. So the folder's own record is what
re-cases it, and obsync publishes that record BEFORE the notes underneath
move. A device receiving it renames the directory, carries every note under it
with the rename, downloads nothing, and publishes nothing back. Before this
release the receiving device took the new spelling into its records while its
disk kept the old one; its next scan read that difference as a rename and
published it back, the other device did the same in reverse, and the two
traded one rename every thirty seconds, re-downloading every note under the
folder each time, for as long as both ran. If you saw a folder's notes gaining
versions endlessly, that was this.

**This works when the folder you renamed is the only one that device syncs,
and on the devices whose filesystem folds capitalisation.** If you chose
folders under "Sync folders on this device", the folder you selected is
published in its own right, so re-capitalising it reaches your other devices
as the one rename it is. That one shape -- the renamed folder IS the selected
folder, which is the usual shape on a phone -- was the one this release nearly
shipped broken: the rename went out as note moves with no folder record behind
them, every device that folds case refused them and told you to update a
device that was already up to date, and every later edit you made in that
folder was refused there too. A device RECEIVING such a rename for the folder
it syncs follows it -- on a Mac, on Windows, on an iPhone, where the two
spellings are one folder on the disk: it keeps syncing under the new
capitalisation and you do not have to select it again. On Linux and on
Android they are TWO folders, so that device does not follow the rename: it
keeps your folder under the old spelling and quietly stops receiving what you
put in it elsewhere, until you rename it there to match. Nothing is lost
either way, and Troubleshooting says how to settle it.

**And a folder that only LOOKS like that rename is left alone, with a
notice.** A device that keeps `Team docs` and `team docs` apart can hold both
-- which is exactly what a capitalisation-only rename made before this release
leaves behind -- and by the name alone, a device syncing just one of them
cannot tell that second folder from a rename of the one it syncs. obsync
follows such a folder only where it really is that rename, which is where the
other device retired the old name first; otherwise it leaves your folder and
your selection where they are, keeps syncing what you chose, and tells you
once, naming both spellings. Following it would have moved that device onto
the folder you did not choose: what the other device put in yours would have
stopped arriving, and your own edits would have come back there as conflict
copies.

**An empty folder re-capitalised while Obsidian was closed no longer
disappears.** obsync finds that rename when it next starts, and it used to
announce the new folder before announcing that the old one was gone -- so a
device that folds case renamed the folder and then obeyed the removal, which
on such a device names the very folder it had just renamed. Nothing was inside
it to keep it, so it was deleted there, and then here. The two records now go
out in the order the rename happened in, and no device removes a folder its
own vault spells differently from the record asking for it.

**If the server refuses the folder record, obsync says so.** The notes under a
folder being re-capitalised wait for that record, because no device can apply
them without it. obsync attempts the record three times; if all three fail it
tells you once, sends the notes anyway -- where the other device refuses them
and says why -- and publishes the folder again the next time it starts.
Nothing is lost and nothing is deleted while that is true.

**If the rename comes from a device still on 1.0.x**, there is no folder
record to send, so the notes arrive asking for a folder spelled a way this
device does not show. obsync refuses those moves rather than guessing: the
notes you already have stay exactly where they are -- nothing of yours is
written over, moved or deleted -- and you are told once per folder. A note
CREATED on the other device meanwhile is not a move and is not refused: it is
written here, in the folder this device shows, and the difference in spelling
is not published back. Update the other device, or rename the folder here to
match, and both devices agree again -- including the edits made there while
the two disagreed, which the folder record brings down with it as it settles
the spelling. Not letting one note's version rename a folder full of other
people's notes is what makes the refusal the safe answer meanwhile.

If a device of yours already shows both, there is a recovery, and its order
matters: **do not delete the stale folder first.** On a device that folds case
the old spelling IS the live note's own entry, so a deletion of it published
from elsewhere can take the notes you are keeping. Update every device, open
each one and let it sync once -- a device that folds case will quietly drop
the records naming the old spelling and tell you so once -- and only then
delete the stale folder, on the device that shows two. The full steps are
under "Two folders that differ only in capitalisation" in the troubleshooting
guide. The last step is yours on purpose: no device can prove the others have
been updated, and a rename leaves a note's size and date exactly as they were,
so nothing later can tell the abandoned copy from the live one.

**An empty folder left under an old spelling can stay or go as you like.**
Nothing in this version deletes a folder that holds anything.

### Notes, and the ways they were lost

**A note another device renames is renamed here too, instead of being
re-downloaded and thrown away.** Applying a rename used to write the note
under its new name and send the old name to the system trash -- so every
rename made on one device left a full copy of that note in every other
device's trash, which on a phone is somewhere you can barely reach. It is now
one rename: nothing is downloaded, nothing is trashed, and the note keeps its
identity. That is true of a rename that changes only capitalisation as well --
it used to rename the entry and then fetch and rewrite the whole note anyway,
which on a phone was the note's full size in data for a change of name. A
rename arriving over a note you have changed here and not yet uploaded is
still kept as two notes, exactly as before.

**obsync no longer tells your other devices to delete everything when it
loses sight of a folder.** If a folder you sync is renamed or moved from
outside Obsidian while Obsidian is closed, obsync sees every note it tracks
vanish at once. It used to publish a deletion for each of them, and every
other device obeyed -- while the notes themselves sat safely on the renaming
device under the new name. obsync now stops, publishes nothing, and tells you
what it found: that it can no longer see most of what it syncs here and that
nothing has been sent. Put the folder back, or select it under its new name,
and it picks up where it was. If you really did delete them, confirm it under
Settings → obsync → "Deletions held back" and they are published then. A small
deletion is untouched by any of this: the hold only happens when more than
half of everything obsync tracks here disappears in one go.

**A note that is still being copied into the vault is no longer published
half-written.** A large file arriving from a file manager or a download used
to be uploaded while it was still growing, so other devices received a
truncated copy -- a 916 MB file arrived as 376 MB. obsync now waits for the
file to hold still, and abandons an upload whose file changed under it rather
than publishing a version of something that is not finished.

**A note moved in from outside Obsidian converges in seconds rather than
minutes, and as a move.** obsync now compares the vault against its own record
every thirty seconds, reading the filesystem itself on a computer instead of
Obsidian's index. A note that vanished from one place and appeared in another
with the same size and date is recognised as the move it is, so your other
devices move their copy instead of deleting one note and downloading another.
That pass never publishes a deletion: it can only add work.

**A note another device deleted after you changed it comes back by itself.**
Keeping your text was already the rule; obsync now also publishes it again
straight away, so the note returns on every device rather than waiting for the
next time you touch it. If that upload cannot go out -- you are offline, or
the note is still being written -- you are told the weaker thing that is true
and the next sync carries it.

**A note whose name differs only in how an accent is stored is no longer
treated as a move.** On a Mac a folder can report `é` one way and Obsidian
another; obsync used to see that as a rename to the other spelling, and the
device applying it would write one and delete the other -- the same file on
most disks, so the note disappeared. It is recognised as one name now.

### Restoring, and getting set up

**Restore from history opens on the newest versions and has a search box.**
It used to page backwards from the oldest, which for a note with a long
history meant a lot of clicking to reach yesterday.

**A repair running in the background no longer interrupts a restore.** The two
used to collide and raise "Server repair could not verify a retained file" --
a message about connectivity, during a recovery, for a scheduling overlap. The
background work yields instead.

**The server can print its own setup token.** `obsyncd setup-token` runs the
image's own binary, so it works where copying a file out of the container does
not -- which is every Kubernetes deployment. The container still has no shell.

**A device can leave its server, or move to another one, without starting a
new vault.** Settings → obsync → This device → "Leave this server" or "Switch
server": the device is revoked where it can be, the server address and the
records go, and your vault key stays, so pairing again is the same vault
rather than a new one.

**The update notice names the plugin and opens the page that installs it.** It
also says which version you have and which the server has, and appears once
per session rather than on every check.

### The documents, and the mark

The documentation is a site now, built from the same files in the repository
and readable without it, and the guides in it are run by CI rather than copied
beside a script that drifts. The README is a short front door; the long pages
live under `docs/`, and the README and the Cloudflare guide exist in twenty
languages besides English. A new page, "Purging a server", covers wiping a
server's storage and re-pairing every device, which is the one operation with
no button and no way back. The plugin has a mark of its own, rendered from a
source file in `brand/` by one command.

**Which version you have.** The latest release is the newest tag on the
Releases page, and that is what Obsidian installs and updates to. `main` is
the edge: merged but unreleased work, for people building from source. There
is no beta channel and no pre-release tag.

### Known limitations in this release

- **A device offline exactly when two notes collide can keep the pair under
  different names** until its note is uploaded and edited again
  ([issue #122](https://github.com/snaraj/obsync/issues/122)). Both notes are
  on both devices throughout; only the names differ, and renaming either one
  yourself settles it.
- **Phones and tablets still settle no same-name pair themselves**, for the
  reason given under "On phones and tablets, obsync renames nothing at all"
  below. The computer publishes the rename and the phone follows it.
- **A save landing in one particular instant can still be lost**, described
  under "The one gap left, said plainly" below. Nothing about it changed here.
- **Folder support has not been driven on a real device yet, of any kind.**
  What exists is the test suite, including tests that drive the plugin's own
  desktop code against a real temporary folder on a real case-folding
  filesystem. The device pass in `docs/validation.md` -- macOS, Linux, a
  phone, and the Windows scenario -- is recorded as not attempted rather than
  claimed, and `docs/validation-runs/` holds no run of it.
- **A folder renamed by capitalisation alone on a phone is not proved.** The
  rename goes through Obsidian's own adapter there rather than through the
  filesystem, and only the device pass can say what that adapter does with a
  spelling it already holds. Until then the phone is covered by the same
  refusal as any other unprovable rename: it changes nothing and says so.
- **A device still on 1.0.x that renames a folder by capitalisation alone
  does not converge with this one** until it is updated, or until the folder
  is renamed here to match, as described under "Two folders that differ only
  in capitalisation". Nothing is lost on either side; the two simply spell the
  folder differently meanwhile, and the notes edited there arrive when the
  spelling is settled rather than while it is not.
- **Two devices renaming ONE folder to two different capitalisations at the
  same time end with copies of the notes under it on both**, the way two
  devices renaming one folder to two different NAMES at the same time already
  did, and more of them. Nothing is lost and nothing keeps changing: rename
  the folder on one device, let every device sync once, and delete the copies
  you do not want.
- **A note roughly 8 MB or larger is still not recognised as one the server
  already holds**, so on a restored vault it is copied beside itself rather
  than adopted -- a duplicate, never a missing note.

### Also in this release

The 1.0.7 work, which never shipped on its own. Everything below is as it was
written for that release, and the sentences 1.1.0 changed have been changed.

**Two notes, one name, settled once.** When two devices each made a note under
the same name while one of them was closed, 1.0.5 and 1.0.6 kept both -- which
is right -- and then left both of them wearing the one name, so every later
edit of either note arrived at a name that was taken and wrote another
`(conflict from ...)` copy. On real devices that was three copies of one note
within a few minutes, on both devices at once. Now the pair is told apart once
and for all: each note has an identity of its own, the note whose identity
sorts first keeps the name, and the device holding the other one renames its
note to the `(conflict from ...)` name and publishes that rename like any other
rename you would make yourself. Both devices work it out from the same two
identities, without asking each other, so both end up with the same two names
-- and from then on each note updates in place, wherever it is edited, instead
of being copied again.

**The exception, and it is a real one.** Working it out needs both identities,
and a note a device has never managed to upload has none. If a device is
offline exactly when it meets the collision, and its note would have sorted
second, that device can keep the pair under different names from the other
device's until its note is uploaded and edited again
([issue #122](https://github.com/snaraj/obsync/issues/122)). The same is true
of a phone or tablet whichever way the pair sorts, for the reason below. Both notes exist
on both devices the whole time; only the names differ, and renaming either one
yourself settles it. A note roughly 8 MB or larger is also never recognised as
one the server already holds (below), so on a restored vault it is copied
beside itself rather than adopted -- a duplicate, never a missing note.

**What you will see when you update.** On one of the two devices, the note that
device made changes name once, to the `(conflict from ...)` name, and obsync
tells you it has done it. Nothing is written over: both notes keep their text,
and both end up on both devices -- under the same two names, with the
exception above. Rename either of them afterwards as you would any note -- the
copy name is a starting point, not a fixture. If you already renamed one of the
pair yourself, there is no longer a collision and nothing here applies to it.

**If you are typing in that note at the moment it happens.** The note is left
exactly where it is, with the text you just typed, and obsync says so instead
of renaming it; the other device's note is kept beside it under a name of its
own, the way 1.0.6 kept it. That holds whether your editor saves into the note
or replaces it, and at every step of the rename -- because obsync never aims a
deletion at the name you are typing into. It moves the note aside first, to a
hidden name of its own; checks that what moved is the copy it made, and puts
it straight back if it is not; and only then clears that copy away, by the
hidden name. A note your editor recreates under the old name while this is
going on is kept as it is, and the pair is settled by keeping both instead.

**The one gap left, said plainly.** A save that lands in the instant between
obsync copying your note and moving it aside, AND leaves both the note's size
and its modification time (which the disk keeps to the second) exactly as they
were, cannot be told apart from no save at all -- so that text can be lost.
Every other moment is covered, including a save made through a file your
editor still has open while obsync is finishing: those bytes are read back
and kept under a name of their own. One more detail worth knowing: the copy
obsync clears away is deleted outright rather than sent to whatever your
"Deleted files" setting points at, because by then its text has already been
written beside it under the new name.

**And the same gap, for a note another device deleted.** obsync checks the
note against what it last uploaded before applying someone else's deletion,
and on a computer it also holds the note across the deletion itself. A phone,
and a few unusual disks and network drives, cannot hold it: there, a save
made in the instant between that check and the deletion is not caught.
Deleting the note anyway is the deliberate choice -- a deletion that is
refused on those devices would never be delivered again, and the note would
come back for everyone.

**On phones and tablets, obsync renames nothing at all.** Settling the pair
means moving one note aside, and moving a note means removing the old copy
once the new one is written. A computer can keep hold of that copy across the
removal and put it back if you typed into it at that moment; a phone cannot,
and neither can a few unusual disks and network drives on computers. Rather
than remove a note it could not give back, obsync keeps both notes on those
devices -- exactly as 1.0.6 did -- and lets the device that CAN do it safely
publish the rename. **What that costs is a name:** until then, that pair can
sit under different names on your phone than on your computer. Both notes are
on both devices the whole time, no text is ever lost, and renaming either one
yourself settles it everywhere. A note larger than that device's per-file
limit (512 MB unless you changed it) is left alone for the same reason.

**Two smaller things behind that.**

- A note a device has never uploaded is now uploaded before obsync decides
  anything about a name it shares. Without that, the device that had not
  uploaded its note yet could not tell the two apart at all, and the two
  devices would settle on different names and stay there -- each keeping its
  own note under the name and the other device's beside it.
- A note that is already exactly the version the server holds is now recognised
  as that version rather than copied beside itself. That is what a device meets
  after its vault folder is restored or replaced, where 1.0.6 would have made a
  conflict copy of every note in it. Recognising it means proving it, byte for
  byte, against the digest the version carries -- so it covers notes up to
  roughly 8 MB, which carry one, and not larger ones, which do not. A larger
  note is copied beside itself as before.

**Update every device that syncs the vault.** A device still on 1.0.x does not
know the rule, and for any pair it has not yet settled it goes on making copies
the way 1.0.6 did. In the case reproduced here -- two devices, one note each
under one name -- both notes survived on both devices and no note content was
lost.

### And the smaller fixes from the same work

**A note another device deleted is no longer deleted here if you have changed
it since.** Two devices can disagree about a note: one deleted it, the other
typed into it. obsync now keeps both sides of that disagreement, the way it
already did for two edits. A deletion arriving for a note whose text differs
from the last version this device uploaded is not applied: the note stays,
and your next sync uploads it again, so it comes back everywhere. That
matters most when you add a folder to the ones this device syncs: obsync then
replays everything that happened while the folder was out, including
deletions from years back, against notes you may have written in the
meantime. In the case reproduced here -- a note deleted on the phone and
edited on the computer while the computer was not syncing that folder -- the
edit was previously lost on both devices; it now survives on both.

**A note moved out of the synced folders while it was still uploading no
longer disappears from your other devices.** If you moved a note out of the
folders this device syncs at the moment obsync was uploading it, the finished
upload made this device start tracking the old location again, and the next
check decided the note had been deleted -- so it was removed from your other
devices, even though the file was sitting safely in its new folder here.
obsync now finishes such an upload without claiming to track a path it no
longer syncs. The version it uploaded stays published, so your other devices
keep the note and its latest text.

**A note you have just written is no longer left behind when you rename its
folder.** Renaming a synced folder carried every note obsync already knew
about, but a note created seconds earlier -- still waiting for obsync to pick
it up -- was left pointing at the old folder name and then ignored. It stayed
on that one device until something else prompted a full check. It now moves
with the folder like everything else in it.

**Two devices that edit one note to the same text no longer lose a rename.**
If one device renamed a note and edited it, and another device made the same
edit without renaming, the server could answer the second device with the
first one's version -- they look identical to a server that cannot read your
notes -- and the rename was then treated as something this device had already
done. The two devices kept two different names for one note with nothing left
to settle it. obsync now checks that the version it is offered really
describes what it just uploaded, and uploads its own version if it does not.

**A note obsync puts back is never written over a note you just saved.**
When obsync has to return a note it moved aside -- because you typed into it
at that moment -- it used to check that the name was free and then write
there, which is a gap another save can slip into. It now uses an operation
that cannot replace anything: if the name has been taken in the meantime, the
note is kept beside it under a numbered "(obsync kept)" name instead, and
both texts survive. And the copy obsync holds during a removal is released
only once its text is safely somewhere else -- including text an editor
writes through a file it still has open at the moment obsync is finishing.

**A note that arrives while obsync is checking the vault is no longer deleted
everywhere.** When obsync starts, and whenever you change which folders it
syncs, it lists the vault and compares that list against what it remembers --
which is how a note you deleted while Obsidian was closed reaches your other
devices. A note arriving from another device in the middle of that check was
in the record and not in the list, so obsync published it as a deletion and
removed a note that was sitting on the disk from every device. It now asks the
vault once more, at the moment it would publish the deletion, and a note that
is there is published as the note it is instead. This was found by this
release's own gate, on a machine slow enough to lose that race.

**A selected folder you rename keeps syncing, and renaming one no longer
deletes its notes elsewhere.** If you sync only some folders and then renamed
or moved one of them in Obsidian, the notes inside it left the selection the
moment they moved, and obsync published a deletion for every one of them: the
folder emptied on your other devices. Now the selection follows the folder --
rename `Work` to `Job` and `Job` is what is synced, without touching the
settings -- and a file that leaves the selection is dropped from syncing
instead of being published as a deletion, which is never done for a file that
is still there. The 1.0.7 notes said one case was not fixed -- a selected
folder renamed while Obsidian is CLOSED, which nothing is awake to see -- and
told you to rename selected folders with Obsidian open. **That case is
handled in this release**, further up: obsync still cannot see the move, but
it no longer believes the notes are gone. It stops, publishes nothing and
tells you what it found ([issue #123](https://github.com/snaraj/obsync/issues/123)).

**Adding a folder to your selection now brings its history down.** Widening
the selection used to leave the newly included folder empty on that device
until something changed inside it, because the device only ever asked for what
had happened since it last looked. A device that widens its selection now
replays the history it skipped, so the folder arrives.

**"Sync now" waits for the sync it asked for.** When a sync was already
running, the command returned immediately and reported done with your queue
still full. It now returns only once the queue it was asked to flush is empty,
including anything that arrived while it was working.

**A killed upload re-sends far less.** Quitting Obsidian mid-upload made the
next run re-send whole chunks it had already delivered; that re-sent volume is
now bounded. Three things to know: fewer bodies are in flight at once on
desktop, which can make a single very large first upload marginally slower; the
retry budget is measured against this release's own runs and NOT claimed as a
device-acceptance result; and a maximal chunk can still exceed the target by up
to 16 bytes, which is the authentication tag.

**Rejecting a pairing that was already approved no longer removes the device.**
On the pairing screen, a reject that arrived after the approval deleted a
device that was by then paired and syncing. That reject is now refused and
changes nothing; to remove a paired device, revoke it from the dashboard's
device list.

**Two devices that reach the same result stop making two versions of it.**
When two devices resolved one concurrent edit to exactly the same text, each
stored its own version of that result, which left the note looking forked until
another merge closed it. The server now recognises a version it already holds
at that position and answers with it, so both devices end up on ONE version.
This applies once BOTH the server and the device run 1.0.7: an older device
keeps the version it computed for itself, and is never answered with another
id. Renames are never treated this way -- what changed there is the name, which
the server cannot see -- so a rename always lands as a version of its own.

### A correction to what 1.0.3 promised

1.0.3 said "your vault, your devices and your pairing are untouched, and the
plugin does not change", which was broader than what had been established.
The plugin really did not change, and no note, key or pairing was touched.
Three behaviours a paired device can see DID change on purpose, and they are
the narrower guarantee that entry should have made
([issue #87](https://github.com/snaraj/obsync/issues/87)):

- Two devices revoking each other in the same instant no longer both succeed,
  so one of those two clicks now fails where before both went through.
- A request from a device that is pending or revoked is refused as that,
  before its signature is checked, rather than being classified by the shape
  of what it asked for.
- Sign-in links a device minted, and dashboard sessions opened from them, end
  when that device is revoked instead of outliving it by up to twelve hours.

## 1.0.6 - 2026-09-21

**Three things 1.0.5 got wrong, all found on real devices after it shipped, none
of them losing a note. Update every device that syncs the vault.** Two are
fixed here; the third is half fixed here and finished in 1.0.7, and this entry
says which is which.

**1. Editing the same note on two open devices could loop.** You would see a
stream of "obsync merged concurrent edits to ..." notices on both devices, one
a second or faster, and the note's version history growing without end. The
note's text was correct on both devices the whole time, and it never changed
again after the first pass. The cause: two devices combining the same pair of
versions produce the same text but two different version ids, so each saw the
other's result as something new to combine, forever. Now a device checks
whether the incoming version's content is the content it already has; if it is,
there is nothing to publish, both devices pick the same version to carry
forward by a rule they compute identically, and one of them publishes the
single entry that closes it. There is also a hard stop: more than five
resolutions of one note within a minute and the device stops combining that
note, keeps both versions side by side as it does for any conflict it cannot
merge, and tells you once. **Once both devices have 1.0.6, editing one note on
both settles in a single round.** When two devices did reach the same combined
text independently, one of them still publishes a single entry to close the
split -- that is deliberate, and it is one entry, not a stream. With more than
two devices editing at once, more than one of them can publish that closing
entry from the same starting point; in testing those settled too, without a
loop.

**2. Two notes created under one name kept making conflict copies — half fixed
here, finished in 1.0.7.** When two devices each created a note under the same
name while one was closed, 1.0.5 kept both, as it should, and then every later
edit wrote another `(conflict from ...)` copy on the other device. Part of that
was this: a copy already on disk was recognised by its size and timestamp
rather than by its content, so the same version could be copied twice under two
names, and a version could be announced as copied when it had not been written
at all. A copy is now recognised by its content, which a vault's own
bookkeeping cannot change, and that half is fixed in this release. One case
still makes a second copy on purpose: a note too large for obsync to carry a
single whole-file fingerprint -- roughly 8 MB and up -- cannot be compared that
way, so its copy takes the next free name rather than risk replacing something. The other
half is that the two notes still compete for the one name; giving them settled,
separate names on every device is planned for 1.0.7 and is not in this release.
**Until then: rename one of the two notes and the copies stop.**

**3. A hidden `.obsync-restore-<id>.tmp` file could be left in your vault.** On
desktop, after obsync wrote a conflict copy, the working file it used to write
that copy safely stayed behind next to the note. It is a plain copy of the
note's text, inside your vault folder, never uploaded, and Obsidian hides it.
Any left by 1.0.5 are safe to delete. 1.0.6 removes its own working file
whether the copy succeeds or fails.

**In every case seen, notes were safe.** In the loop as it was reproduced --
two devices, one note, one edit each -- every device ended up with the same
text, and no note content was lost in any of the three problems above. What the
loops filled was your server's history, and on a server with a storage limit
that could have used the limit up, which stops syncing for the whole vault
until space is freed. The extra history entries are ordinary versions and your
server's own retention removes them in time.

**Update every device that syncs the vault** — a single device left on 1.0.5
can still start a loop. If one is running right now, quit Obsidian on one of
the two devices: stopping one participant can allow outstanding work on the
other to drain. Update every device before resuming.

## 1.0.5 - 2026-09-21

**A note you wrote or edited while Obsidian was closed could be replaced by
another device's version when you opened it again. Update every device that
syncs this vault.** That is the whole release; nothing else changes.

**What happened.** In 1.0.0, 1.0.1, 1.0.2, 1.0.3 and 1.0.4, if you edited a
note while Obsidian was closed on one device, and the same note also changed on
another device in the meantime, opening Obsidian again replaced your version
with the other device's within a few seconds. Writing a NEW note while the app
was closed did the same when another device happened to create a different note
under that same name. No `(conflict from ...)` copy was written and nothing was
moved to the trash. A note that changed on only one device was never affected,
and a note you wrote while the app was closed with no counterpart on another
device was uploaded correctly.

**Content lost this way cannot be brought back.** This is not like 1.0.4's
deletions, where the note's content was still on the server and **Restore from
history** could return it. Here the replaced text had never left the device --
obsync had not uploaded it yet -- so the server never held it, and neither
**Restore from history** nor the dashboard nor your operator's backups can
produce something that was never sent. If Obsidian's own **File recovery**
(Settings, Core plugins) was on, its periodic snapshots of that note are the
one place left to look.

**What happens now.** When a version arrives from another device for a note
this device has changed and not yet uploaded, obsync keeps your file exactly as
it is, writes the other device's version beside it as
`<note> (conflict from <device>, <date>).md`, tells you it kept both, and then
uploads yours. Where the two sides only added lines in different places, they
are merged into one note, as concurrent edits always were. A conflict copy is
never written over something already at that name either, so a copy you have
opened and edited is kept and the new one takes the next free name.

obsync recognises a note you have changed by its **size and its modification
time**, compared with what it recorded when it last uploaded that note — the
same check it has always used at startup to decide what to upload. An edit that
leaves both of those exactly as they were is invisible to that check, on this
release and on every earlier one.

**Why every device.** The device that loses the edit is the one that was
closed, so updating one device protects only that device. Update them all.

**Known issues in this release, fixed in 1.0.6 and 1.0.7.** Editing one note on
two open devices could loop, and a hidden `.obsync-restore-<id>.tmp` file could
be left in the vault folder: both are fixed in 1.0.6. Two notes created under
one name kept making conflict copies: the copies are recognised correctly from
1.0.6, and giving the two notes settled, separate names is planned for 1.0.7;
until then, rename one of them. In every case seen, no note content was lost.
See the 1.0.6 entry above, and update every device.

## 1.0.4 - 2026-09-20

**Renaming a note or a folder could delete it, on every device. Update every
device that syncs this vault, and do not rename anything until you have.**
That is the whole release; nothing else changes.

**What happened.** In 1.0.0, 1.0.1, 1.0.2 and 1.0.3, renaming a note -- through
the inline title, through the file explorer, or by moving it into another
folder -- reached the other devices correctly as a MOVE, and then the device
that applied that move published a DELETION for the note it had just moved.
Every device obeys a deletion, the one that did the renaming included, so the
note left the vault everywhere within seconds of being renamed. Renaming a
folder did the same to every note inside it. A note nobody renamed was never
affected, and no note was ever deleted on its own.

**Your content is not lost, and the server never had it in the clear.** A
deletion here is a marker, not an erasure: the versions before it stay on the
server under the retention its operator set (by default at least ten versions
per file and everything from the last thirty days), and they are still
encrypted with your vault key. To bring a note back, run **Restore from
history** from the command palette on any paired device, find the note by its
path, pick the content version from before the deletion marker -- markers
themselves cannot be restored, which is why the list offers the version under
it -- and restore it. It comes back as a new file beside that path, named
`<note> (restored-...)`, and nothing existing is overwritten. A note Obsidian
moved to your system Trash or to your vault's `.trash` folder when it obeyed
the deletion is also still there, with its body intact.

**What was wrong.** Applying a remote rename means writing the note under its
new name and removing it under the old one. Obsidian reports that removal back
to this plugin exactly as it reports one you make yourself, and the plugin
published it: a deletion for a file that was alive the whole time, one name
over. The plugin already ignored the echo of its own writes; now it ignores the
echo of its own removals too, by the path it is about to remove, and it says so
in its log (`decision=echo_suppressed event=delete`). A deletion you actually
make is untouched by this and still reaches every device, including one you
make on a note that was just renamed elsewhere.

**Why every device.** The device that publishes the wrong deletion is the one
RECEIVING the rename, so a single device left on 1.0.0-1.0.3 can still delete a
note that a fully updated device renames. Update them all, then rename freely.

## 1.0.3 - 2026-09-20

Dashboard security: an independent review of 1.0.1, and a second pass that
exercised a running server rather than reading it. Your vault, your devices
and your pairing are untouched, and the plugin does not change.

**Nothing to do — unless you open the dashboard over plain `http`.** That
stops working after this update at any IP address or LAN name, and also at
`localhost` if your browser is Safari (first bullet below). One thing
everybody will notice: dashboard sessions opened before this update are
signed out once, so open the dashboard from **Open dashboard** on a paired
device again.

- **The dashboard needs a secure address now.** Its two cookies are `Secure`
  and host-bound, which is what stops one plaintext request from carrying
  your session in the clear or letting another host on your domain plant one.
  What that means for the address bar:
  - an `https` address works in every browser — this is the supported way in,
    and the one every install guide here already describes;
  - plain `http` to `localhost` or `127.0.0.1` works in Chrome and Firefox,
    which treat loopback as secure, but **not in Safari**, which sends no
    `Secure` cookie to a plaintext origin at all: on Safari the sign-in
    redirect appears to work and every page is then signed out;
  - plain `http` to any other IP address or LAN name works nowhere. If that
    is how you reach the dashboard today, put your TLS terminator in front of
    it and use its name.
- **Revoking a device now ends what it opened.** Revoking used to leave the
  sign-in link that device had just minted working, and any dashboard session
  opened from one of its links alive for up to twelve hours. Revoking a lost
  laptop while its browser was still signed in did not sign it out. It does
  now: the link stops working and the session ends in the same moment.
- **The dashboard can no longer revoke your last device.** The plugin has
  always refused that, because an account with no active device can never
  sync again and nothing re-enrols one; the dashboard's Revoke button had no
  such guard, so one click was permanent. It refuses now, and the confirm
  text says what revocation does and does not do.
- **Sessions end sooner, and you can end all of them.** A dashboard left open
  and untouched for an hour signs itself out; the twelve-hour limit still
  applies whatever you are doing. **Sign out everywhere** in the top bar ends
  every session the server holds at once, and cancels any sign-in link that
  was opened and never used — a machine you no longer have may be holding
  one, and it would have worked for its five minutes.
- **Two devices revoking each other at the same moment can no longer empty
  your account.** The check for "this is your last device" and the revocation
  itself now happen together, so two clicks that land in the same instant
  cannot both go through. Before, they could, and an account with no active
  device can never sync again: nothing re-enrols one.
- **The recovery token is treated as the break-glass credential it is.** A
  sign-in with it is logged as a warning, and the Overview page says so for
  as long as that session lasts, so a use you did not make is visible.
  `docs/recovery.md` has the three steps that rotate it, and how to tell it
  has been used. Every refused sign-in is logged as a warning too, and while
  the Logs page holds it you can see it. Be precise about what that promise
  is: a refused sign-in is unauthenticated traffic, so it lives in the
  smaller of the two rings below (200 lines) and other unauthenticated
  traffic can push it out of that one — what it can never do is push out the
  authenticated half (1000 lines), which is where your own devices' and your
  own dashboard's decisions are. Your server's stdout keeps every one of
  these lines whatever the page shows.
- **The Logs page can no longer be wiped by a stranger.** Anyone who could
  reach the server could push every decision out of it with about a thousand
  free health probes. Authenticated decisions and unauthenticated traffic now
  keep separate space, so a burst of probes pushes out only older probes.
  Three sync endpoints also used to check the shape of an address or a
  parameter before checking who was asking, which let an anonymous caller
  land a refusal in the authenticated half — a thousand malformed requests
  emptied it in about a second. Every endpoint that needs a credential now
  asks for one first, and knowing a revoked or unapproved device's id is no
  longer treated as knowing its key.
- **The server stops telling strangers how much you write — nearly.** Every
  response used to carry the journal position in a header, including answers
  to unauthenticated probes; polling it reconstructed when and how much you
  edit. The header now rides only a response to a caller whose credential the
  server actually verified. One opening is narrowed rather than closed, and
  it is worth knowing about: `GET /readyz` still states that same position in
  its body, because the readiness contract says it does and the release
  smokes read it. If your server is reachable by people you do not trust,
  `/readyz` is what they can still poll. Whether readiness should state a
  sequence at all is a decision for a later release.
- **Smaller hardening.** `object-src 'none'` and two cross-origin isolation
  headers on dashboard pages; a proper doctype on the page; and an
  unauthenticated caller with a wrong setup token can no longer tell a
  claimed server from an unclaimed one.
- **New page:** `docs/security/dashboard.md`, the dashboard's own threat
  model — what it holds, how you get in, what defends it, and what is
  deliberately left standing.

## 1.0.2 - 2026-09-20

- **Obsidian 1.13.0 or newer.** The floor moves from 1.12.4 because the
  settings tab is now declared to Obsidian rather than drawn by the plugin,
  which is what makes every row searchable from Settings and what the
  non-deprecated destructive button needs. Root `versions.json` keeps 1.0.1
  available to an Obsidian below 1.13.0; the wire protocol, the journal and
  pairing are unchanged, so a device on 1.0.1 and a device on 1.0.2 sync the
  same vault.
- **A shorter first run.** A host name typed alone in **Server URL** becomes
  `https://host`. **Set up** and **Pair this device** apply a folder selection
  that was typed but not yet saved, so the screen is what the device syncs.
  The account-name field is gone: the dashboard calls the one account a
  server holds `obsync`. Notices drop the `obsync:` prefix.
- **A clean community-directory scorecard.** The directory's automated scan
  reported 221 issues on 1.0.0; the same rules (`eslint-plugin-obsidianmd`
  0.4.2 with typescript-eslint's type-checked set) now report none. The
  vendored Obsidian API declaration sits under a `node_modules` path, the one
  name every linter skips, and is pinned at exactly the floor so the compiler
  refuses any member the floor lacks. In the plugin: 17 redundant casts, typed
  edge-header parsing, a history cleanup that no longer throws from `finally`,
  a control-character check that is a loop rather than a regular expression,
  `console.warn` for refusals and `console.debug` for routine decisions,
  sentence-case notices. In the stylesheets: no `columns`, no `clip-path`, no
  `!important`; the recovery phrase is a numbered list laid out as a grid.
- **Disclosures.** The README now states that the plugin lists every file in
  the vault to decide what is in scope, writes the clipboard only when you
  press Copy, talks to one host, and that each Release carries a plugin ZIP
  and an evidence manifest that Obsidian ignores.

## 1.0.1 - 2026-09-20

- **Open dashboard opens the configured server, or nothing.** The plugin used
  to open whatever the server answered with. The server builds that link from
  `OBSYNC_PUBLIC_URL`, which the chart leaves empty on purpose -- a private
  deployment advertises no address of its own -- so on the chart's path the
  answer is the relative `/login?token=…` and the command failed on every
  deployment that had not named itself; on the Compose path the value was
  there but dropped the port. The link is now resolved against the **Server
  URL** this device is configured with, and opened only when the
  resolved ORIGIN is that server's. A link to any other origin is refused by
  name and not opened: the answer carries a single-use dashboard sign-in token,
  and resolving a server's answer without checking where it points is how that
  token would reach somebody else's origin.
- **The Compose route hands out the port it publishes.** `OBSYNC_PUBLIC_URL`
  and the terminator's HTTP-to-HTTPS redirect both named the default HTTPS port
  while the deployment published `OBSYNC_HTTPS_PORT`, so a deployment that
  moved that port sent its own readers to a port nothing listens on. Both now
  carry the published port, and `scripts/ci/compose-smoke.sh` -- which already
  publishes a non-default pair -- reads back the redirect AND the address the
  server hands out. A deployment whose devices arrive somewhere else, because
  another reverse proxy holds 443 in front of it, sets `OBSYNC_PUBLIC_URL`
  itself: an explicit value wins, and the smoke proves that too.
- **A standalone Helm path.** `chart/README.md` carries the exact OCI install
  command, the Secret command for the server key, and a minimal `values.yaml`
  that produces a running pod outside the owner's own platform. No chart
  DEFAULT moved: `deploymentReady: false`, the reference StorageClasses and the
  reference ingress peer are fail-closed on purpose, and the new file is about
  which of them a stranger must replace with their own.
- **The README answers the questions a stranger asks first.** What this plugin
  talks to (your own server, and Obsidian's directory for installation — no
  telemetry, no third party, and no code ever fetched from the sync server);
  what it does, in six lines, above the fold; a Documentation table; and where
  a question, a bug and a vulnerability each go. Four new pages carry what the
  README used to imply: [`docs/troubleshooting.md`](docs/troubleshooting.md)
  (one heading per failure mode, the protocol refusals a device can show, and
  how to collect a report without pasting a credential),
  [`docs/settings.md`](docs/settings.md) (every setting, its default, and when
  to change it), [`docs/recovery.md`](docs/recovery.md) (a lost device, a lost
  server key, a restored volume, a rotated setup token, a moved address — and
  the plain statement that a vault with no device left has no supported way
  back in this version), and [`docs/conflicts.md`](docs/conflicts.md) (what a
  conflict copy is and what to do with it).
- **The Release page leads with what changed.** From this release the published
  notes carry that version's own changelog entry, then the line that installs
  or updates the plugin and the line that upgrades the server by digest, with
  the artifact table and the evidence digest folded underneath. Releases
  through 1.0.0 keep the body they published, byte for byte, because the
  read-only audit re-derives and compares it.
- **The plugin's directory entry says what it does.** The manifest description
  is an action ("Sync your vault across devices, end-to-end encrypted, through
  a server you run yourself.") rather than a product name nobody has heard, and
  a `helpUrl` points at the documentation table.
- **Documentation repairs found by auditing 1.0.0's install path.** The
  `cosign verify` example names the release being installed rather than
  `v0.1.0`; `SECURITY.md` states the private, owner-only posture the reference
  deployment has had since 2026-09-07 instead of a public tunnel with an access
  application; the README says how to reach the server from outside the LAN and
  what the recorded device run did and did not prove; the Kubernetes
  setup-token read is a command rather than a suggestion; the protocol refusals
  the plugin shows verbatim each have a sentence; the first-time-setup
  and pairing surfaces are named as they are labelled; and the two "may not be
  listed yet" hedges are gone, because it is.

## 1.0.0 - 2026-09-15

- First stable release. No behaviour changes with it: 1.0.0 is the point at
  which the guarantees below stop being intentions and start being the
  contract this project is judged against. Everything under "Known limits" is
  what 1.0.0 does NOT claim.
- **Dependency-free, by construction.** The server is one Rust binary built
  against the standard library alone -- no crates, no build script, no
  vendored code -- and the plugin has zero runtime dependencies, built by one
  pinned TypeScript compiler and a bundler in this repository. Cryptography is
  the platform's own WebCrypto on the device and an implementation checked
  against published test vectors on the server. `#![forbid(unsafe_code)]`
  holds everywhere but the one file that delivers SIGTERM.
- **A blind server.** No vault key, chunk key, plaintext chunk, or clear file
  path is sent to, stored by, or logged by the server; file names travel only
  inside encrypted manifests. The server cannot decrypt a vault because it
  holds no key material with which to try. The doctrine tests in
  `crates/obsyncd` refuse a handler, log line, or journal frame carrying a
  field named or shaped like a key or a path.
- **Fail-closed, with nothing to turn off.** No flag, environment variable,
  build feature, or configuration field disables encryption, request
  authentication, replay protection, fsync, integrity verification, probes, or
  the response header policy. The signing window (+/-300 s) and the nonce
  memory (600 s) are constants, not settings. A chart that has not been given
  a resolved image digest fails at pull time rather than deploying something
  unverified.
- **Any size, one path.** There is no per-file or per-vault size limit in
  server code. The only refusals are explicit, configurable and visible: the
  free-space watermark on a volume and the account quota, both HTTP 507.
  Device-side ceilings -- the mobile budget and the per-file mobile ceiling --
  are plugin policy, defaulted per platform and shown in the interface.
- **Native installation and updates.** The plugin installs and updates through
  Obsidian's own Settings -> Community plugins browser as Self Hosted Private
  Sync (`obsync-private-sync`). Root `versions.json` tells that installer which
  release each Obsidian version may take, so an older Obsidian is offered the
  newest release it can actually run instead of nothing. No supported path
  copies files by hand.
- **Two independent routes to a working deployment.** The reference route puts
  a TLS terminator the operator trusts in front of the pod on a private
  network, with `OBSYNC_EDGE=none`. The Compose route (`deploy/compose`) needs
  an account with nobody: Caddy, a private name, a private certificate
  authority, and nothing reachable from the internet;
  `scripts/ci/compose-smoke.sh` re-proves its serving path and its published
  address on every pull request. A tunnel on a public hostname is an optional
  convenience on top of either, never the foundation.

### Validated on real devices

The device campaign behind this release is recorded in
[`docs/validation-runs/2026-09-14.md`](docs/validation-runs/2026-09-14.md),
which carries every V1 through V16 outcome in its own row.

- Route: the Compose route (`deploy/compose`, validation.md V15) with a
  macOS laptop as the server: the 0.1.19 release image by digest behind Caddy
  `tls internal`, a private name and a privately trusted root on each device,
  reachable only on the local network. The reference route (Helm chart behind
  a WARP private route on the homelab) was not exercised in this run: the
  WARP client delivered SSH but not a second port to the same host.
- Devices, operating systems, Obsidian versions, plugin version, server
  commit: a MacBook Pro on macOS 26.6 with Obsidian 1.13.7 and plugin 0.1.18
  (paired first); an iPhone 15 Pro Max on iOS 26.6.1 whose Obsidian version
  was not recorded during the run, with plugin 0.1.19 installed from the
  community directory; server `obsyncd` 0.1.19 from release commit `e47e3d4`.
  The run was driven by the coordinator agent lane with the owner at the
  keyboard for the passcode, the local-network prompt, the firewall changes,
  and one live edit.
- Passed: the production-path install on both devices; V1 first-time setup and
  device enrollment (setup token accepted, recovery phrase shown, device
  listed); V2 pairing the phone (one-time code pasted on the phone, approved
  by name on the desktop, sealed envelope delivered, about one minute end to
  end); V3 two-way live edits (a note created on the desktop appeared on the
  phone, a line appended on the phone appeared on the desktop, each within a
  few seconds as observed, not instrumented); V15 itself, since this run is
  that Compose route confirmed on two real devices with no provider, no public
  hostname, and no port reachable from the internet. Unsigned requests to
  every sync endpoint were refused (401/404/400) and the server log shows
  exactly the two enrolled devices.
- Not attempted: V4, V5, V6, V7, V8, V9, V10, V11, V12, V14, V16, and the
  native update 0.1.18 -> 0.1.19 on the desktop. Not applicable: V13, because
  a laptop server has no private route.
- Two findings, both about generated URLs on a non-default HTTPS port and
  neither affecting sync correctness or privacy: the dashboard link the plugin
  opens, and the terminator's HTTP-to-HTTPS redirect, both drop that port.
  Tracked as [issue #68](https://github.com/snaraj/obsync/issues/68).

### Known limits

- V7 (a 20 GiB archive, Obsidian killed mid-upload, fewer than 8 MiB re-sent)
  is unproven. Resumable uploads exist; the retransmission bound has never been
  measured on a real device.
- V12 (a blob corrupted by hand, quarantined by scrub, restored from a healthy
  client) is unproven on real devices. Hosts without bounded range reads refuse
  automatic repair from a local source above 8 MiB, so a matching source on a
  capable device is required; a synthetic test does not close it.
- iPad and Windows are not validated. `docs/validation.md` names them as
  required platforms for the full campaign and this release does not claim
  them.
- Off-LAN sync (V13) is unproven on either route.
- The selected-folder list may only narrow once a vault has history. Widening
  it needs a safe current-head resync, which this version does not implement.
- Public reachability is not, and has never been, an acceptance criterion
  here: the reference deployment is private and owner-only by ruling.

## 0.1.20 - Unreleased

- Upgrade the plugin build toolchain from Node 24.19.0 with npm 11.17.0 to
  exact Node 26.8.2 with npm 11.19.1, and pin the matching multi-architecture
  image digest in the container build.
- Upgrade the CodeQL Action initialization and analysis steps from 4.37.9 to
  4.38.0 at one immutable upstream commit.

## 0.1.19 - Unreleased

- Generalise the release rule from "exactly one patch" to exactly one SemVer
  step, so a minor (`X.Y+1.0`) and a major (`X+1.0.0`) advance are admissible
  from a protected base and 1.0.0 is reachable without editing the gate in the
  pull request the gate must pass. Every skip, reversion, mixed range, second
  boundary in one range, and step that leaves a lower field non-zero
  (`X.Y+1.1`, `X+1.0.1`) stays denied, and the refusal now names all three
  admissible versions.
- Add root `versions.json`, the ledger Obsidian's community-plugin installer
  reads to offer an older Obsidian the newest release it can actually run, and
  hold it as a release follower: the head row must carry exactly root
  `manifest.json`'s `minAppVersion`, the rows must ascend, and no row may name
  a version above the head. The recorded floors are the ones each published
  release's own manifest declared.
- Follow the vault's own "Deleted files" preference when sync removes a file,
  through `FileManager.trashFile`, instead of always using the operating
  system bin. The file lookup is file-only, so a folder standing where a
  remote manifest names a file is never deleted with its contents.
- Normalise the folder selection a person types in settings through the host's
  `normalizePath`, so a leading or trailing slash, a doubled separator or a
  backslash is a typo rather than a refusal that discards the whole selection.
  Paths that arrive from another device are still refused, never normalised.
- Schedule the engine's timers and the transport's backoff through
  `window`, the one spelling that means the same thing in Obsidian's desktop
  Electron runtime and on mobile.
- State the truth in `README.md`: the plugin is listed in Obsidian's community
  directory as Self Hosted Private Sync, installed from Settings → Community
  plugins → Browse. Add the commands and status-bar legend, a troubleshooting
  section, and the three callouts a self-hosted sync plugin owes a new reader.
- Add the repository conventions established plugins share: issue templates
  for a bug report and a feature request, `.editorconfig`, and a
  `CONTRIBUTING.md` that points at the contract.

## 0.1.18 - Unreleased

- Accept maximal encrypted chunks within the fixed 8 MiB plaintext plus
  16-byte authentication-tag upload ceiling. Budget pulls by ciphertext size
  so three maximal chunks fit the unchanged 32 MiB multipart payload ceiling.
  Preserve chunk identities, history and ordinary four-upload concurrency.

## 0.1.17 - Unreleased

- Automatically audit remembered selected-file chunks and restore missing
  ciphertext from an intact local copy after scrub quarantine. Authenticate
  the retained manifest, preserve chunk identity, and verify restored bytes
  without creating another file version or changing history or tombstones.
- Bound each repair step to 64 chunk entries and at most one chunk upload;
  share one tracked worker between the background timer and Sync now, cancel
  reads on stop, and drain already dispatched writes before replacement loads.
- Report unavailable or changed repair sources. Devices without bounded range
  reads refuse automatic reads of source files above 8 MiB; larger files need
  a matching source on a device with bounded range reads. Native-device V12
  acceptance remains a separate validation requirement.

## 0.1.16 - Unreleased

- Fix native provenance verification by using the exact certificate identity
  without the mutually exclusive workflow selector. Retain repository,
  source, signer, issuer, hosted-runner and SLSA constraints, with a real CLI
  argument regression alongside the publication model.

- Store device credentials, vault keys and edge headers in one owned native
  SecretStorage entry, keeping only a reference and bookkeeping in plugin
  data. Migrate existing settings after verified secret writes, retain a
  bounded prior credential record for interrupted updates, and stop sync on
  unavailable or unverified persistence. Bind recovery dialogs before phrase
  derivation and drain stopped engine work before replacement loads. Require
  Obsidian 1.12.4 or newer.
- Remove obsolete server plugin-code download endpoints. Native Community
  Plugins installation and updates remain the supported distribution path;
  packaged assets and historical release verification remain intact.
- Align current pairing, credential custody, recovery and installation
  guidance with the implemented behavior and remove numbered feature promises.

## 0.1.15 - Unreleased

- Let a new device wait for approval through its own envelope endpoint,
  preserving one-time collection and stopping when the pairing dialog closes.
- Encode device policy using the existing v1 API field names, so heartbeats
  and device-setting updates report both ceilings successfully to the server.
- Use Self Hosted Private Sync as the community plugin display name, preserving
  the installation ID and device pairing protocol.
- Publish GitHub Actions SLSA build provenance for the three native plugin
  assets and verify it against the authorized protected-main source before
  sealing the release. Revalidate that provenance in the read-only release
  audit while preserving historical releases and existing release evidence.
- Refuse publication when the dispatch workflow commit differs from the
  authorized source, so native provenance cannot name a different build.

## 0.1.14 - Unreleased

- Return a failed process status for incomplete check and export reports.
- Verify ciphertext references from every retained version during offline checks,
  including missing history-only chunks, and count each verified chunk once.

## 0.1.13 - Unreleased

- Use Private Sync as the community plugin display name and link the maintainer profile.
- Compile against the official Obsidian 1.7.2 API declarations and declare the same minimum application version.

## 0.1.12 - Unreleased

- Use the distinct `obsync-private-sync` installation and pairing-link identity
  while retaining the Obsync display name. Native installs keep their own
  settings; no other plugin folder or protocol action is adopted. Release
  verification preserves the original ID through 0.1.11 and requires the new
  ID thereafter.

## 0.1.11 - Unreleased

- Prepare native installation and updates through Obsidian's Community
  Plugins browser. Keep one root manifest, publish the three individual
  plugin files from the same build as the ZIP, and bind every asset in v2
  release evidence. New GitHub tags match the unprefixed plugin version;
  image tags retain their prefix. Existing immutable releases retain their
  original audit contract. Directory acceptance and device validation remain
  separate prerequisites for production use.
- Align the commit-signature validator with the documented GPT-6 lane while
  retaining exact-match, identity and trailer refusals.
- Add a folder selection saved only on this device. Existing dedicated
  vaults retain whole-vault sync; selected folders admit only descendants,
  and an explicit empty selection syncs no files. Scoped scans start at the
  selected folders. Push, pull, on-demand downloads, remembered rename and
  deletion sources, conflict copies and merge history obey the selection
  before file access. Invalid persisted selections refuse loading.
- Saving a narrower selection waits for active transfers, preserves files
  and state, and never rewinds the feed. Queued renames remain publishable
  after restart. Expansion after a device has sync history is refused;
  move local files into an already selected folder and run Sync now to add
  content within the same vault. The selection does not revoke access to
  previously shared content or sandbox Obsidian, its plugins or the local OS.
- Complete native folder-selection saves without returning a thenable UI
  component to a Promise continuation, including handled save failures.
- Disabling the plugin cancels pending startup and folder-change
  continuations, so a delayed transfer or local save cannot restart sync
  after unload. Stale startup results cannot replace a newer engine or its
  status; an already-issued local write may finish and must be checked after
  restart.
- Add **Restore from history** to the native command palette. It browses
  retained versions, including deleted notes, with a separate bounded read
  cursor and restores verified content as a new sibling file. Existing
  files, unsynced edits and original history are preserved; the new copy
  uses ordinary sync with a fresh identity. Folder selection and current
  device limits apply, including local bytes added during the download.
- History reads make one attempt at a time; cancellation discards late
  results and blocks replacement reads until the outstanding request
  settles. A dispatched local create is preserved and reported separately
  from remote sync. Desktop publishes without replacing a destination;
  mobile uses Obsidian's create-only API. Neither platform silently falls
  back to an overwriting write.
- Resume sync after a same-instance reload waits for prior history recovery
  and manual-download work, without loading state ahead of their saves.
- Quarantine damaged chunks across separate blob and journal mounts using
  a synced copy on the destination volume before removing the primary.
  Reserve peak copy space, account failed-copy residue, and retain failed
  operations for recovery without claiming quarantine or losing inventory.
  Recovery uploads and delayed scrub summaries cannot discard each other;
  concurrent GC skips a busy chunk pass without holding partial locks.

## 0.1.10 - Unreleased

- The chart's own defaults could not start the server, and both halves of
  that are fixed here. `chart/values.yaml` declares each claim as a
  Kubernetes quantity (`250Gi`, `4Gi`) and the Deployment renders it verbatim
  into `OBSYNC_BLOBS_CAPACITY` / `OBSYNC_JOURNAL_CAPACITY`, but the server's
  size grammar knew only `KiB`/`MiB`/`GiB`/`TiB` and lower-cased what it read,
  so `Gi` was not a size and the pod exited on its own chart's defaults. The
  Service is named `obsync`, so a kubelet with service links on also injected
  `OBSYNC_SERVICE_HOST`, `OBSYNC_SERVICE_PORT` and `OBSYNC_PORT_*` -- and an
  unknown `OBSYNC_*` name is a startup error by design, which is a second
  refusal on the same first boot.

- **Size grammar, one spelling per multiplier.** `parse_size` (and therefore
  `OBSYNC_BLOBS_CAPACITY`, `OBSYNC_JOURNAL_CAPACITY`, `OBSYNC_SCRUB_RATE` and
  the size term of `OBSYNC_FREE_WATERMARK`) now accepts a bare byte count
  (`512`), `B`, the Kubernetes binary suffixes `Ki`, `Mi`, `Gi`, `Ti`, and
  their long forms `KiB`, `MiB`, `GiB`, `TiB`; `Gi` and `GiB` are the same
  multiplier. The suffix is matched case-sensitively after trimming.
  COMPATIBILITY, for both `OBSYNC_*_CAPACITY` and `OBSYNC_FREE_WATERMARK`:
  the single letters `k`, `m`, `g`, `t` and every lower- or upper-case
  spelling (`gib`, `GIB`, `4mib`, `512b`) are DROPPED and now refuse the
  start. A value using one must be rewritten -- `250g` becomes `250Gi`,
  `1%,2g` becomes `1%,2Gi`, `64m` becomes `64Mi`. Nothing in this repository,
  its charts, its compose file or its README used a dropped form. The reason
  they are gone is that Kubernetes reads a single letter as a power of a
  thousand, so keeping them binary made `250G`-shaped input ambiguous in
  exactly the direction that over-states a volume and makes the free-space
  watermark fire late. Decimal SI (`G`, `GB`) is refused for that reason;
  a fraction (`1.5Gi`) is refused for a different one, that the grammar
  deliberately admits whole units of one multiplier and nothing else -- the
  value is an exact byte count, it is simply not a spelling this grammar has.
  A whole-unit size whose product does not fit in 64 bits is refused rather
  than wrapped. The error text now names the accepted forms.

- **Chart.** `values.schema.json` admits only Kubernetes binary quantities
  for the claim sizes the server is told (`^[1-9][0-9]*(Ki|Mi|Gi|Ti)$`), so a
  decimal `250G` -- or the server's own `250GiB`, which the API server would
  refuse -- fails `helm lint` instead of rendering a pod that cannot start.
  The Deployment sets `enableServiceLinks: false` beside its existing
  `automountServiceAccountToken: false`; the Service keeps its name and the
  server's refusal of unknown `OBSYNC_*` names is unchanged and retested.

- **The gate now runs the chart against the binary.** `image-smoke.sh` gains
  a tenth property: `helm template` renders the deployment, the rendered
  environment is read from that render through the fail-closed YAML reader
  (`scripts/ci/chart_pins.py env` -- no variable name, value or mount path is
  typed into the smoke), and the SHIPPED image is started on exactly those
  values and must answer `/readyz`. `chart_pins.py environment` holds the
  render side: service links off, and every quantity either reader refuses is
  refused by the schema. The container job installs the pinned helm for it.

## 0.1.9 - Unreleased

- Two exact pins advance, each confirmed from its source before it was
  written rather than from the proposal text. The runtime base
  `gcr.io/distroless/static-debian13:nonroot` moves from `sha256:f7f8f729...`
  to `sha256:1c2c046b...`: `docker buildx imagetools inspect` resolves that
  tag today to index digest `sha256:1c2c046b...`, and an anonymous registry
  HEAD accepting only the index media types returns the same
  `docker-content-digest`. That digest is the multi-arch INDEX, which is what
  a `FROM` must name for both production platforms; the per-architecture
  manifests beneath it (`sha256:e754765a...` amd64, `sha256:9381e9b7...`
  arm64/v8, and four others) are different digests, and pinning one would
  break the other platform. `docker/setup-qemu-action` moves from `96fe6ef7`
  (v4.2.0) to `1f40c722` (v4.3.0) in the release publisher, with the version
  comment updated; the tag `v4.3.0` in that repository is a lightweight tag
  resolving to exactly that commit. The `library/node` major bump is held
  under issue #32 and the node stage is untouched here.

## 0.1.8 - Unreleased

- A dismissed alert GitHub has stamped `fixed_at` is skipped, counted and
  named instead of refusing the run. `Alert.historical` described exactly this
  case and then tested `most_recent_instance.state == "fixed"`, which the
  shape never satisfies, so the first live reconcile after v0.1.7 (push run
  34368935826 at `f229a46`) stopped on alert #90 with
  `was analysed on commit e4aa059…, not f229a46…` before writing anything:
  every later step was skipped, main kept its one covered open alert, and the
  publisher denied the version on the exact-SHA binding. The API partitions
  main's 78 dismissals exactly: 33 (#55–#90, `hard-coded-cryptographic-value`
  in `api/auth.rs` 583–1052, the auth nonce vectors v0.1.7 removed) carry
  `fixed_at` with their instance left on `e4aa059`, and the other 45 carry
  `fixed_at: null` with their instance on `f229a46`. The stamp is what earns
  the exemption and an old commit alone never does: an unstamped dismissal
  whose instance names another commit, and any OPEN alert that does, are still
  refused as superseded or foreign, and the ref and analysis-key bindings now
  hold in every state. The stamp is read for its presence, null or a non-empty
  string, and its syntax is not validated: the ref, the analysis key and the
  alert's own state are what guard the exemption. `fixed_at` can be read at face value because the job
  waits for `processing_status: complete` on both analyses before it lists
  anything, and on a pull request the base listing now requires the analysis
  record it selects per language to report an empty `error` — agreement on a
  commit is not evidence that the analysis of that commit succeeded, and there
  is no fallback to an older healthy record.

## 0.1.7 - Unreleased

- A journal append that fails is rolled back to the length the journal has
  made durable and the cut is fsynced, so the next frame starts clean and a
  write acknowledged after a failure can no longer be discarded by the next
  start's truncation; if that rollback itself fails the journal is faulted,
  every later append refuses with `journal_faulted`, `/readyz` answers 503
  with the reason to restart, and the line names both the append's and the
  rollback's error kinds.
- The journal volume has its own free-space watermark, refusing a frame with
  `507 journal_full` against `OBSYNC_JOURNAL_CAPACITY` minus everything the
  journal root holds, snapshots included; `VolumeStatus` reports that same
  number, and the image smoke gained a ninth property that exhausts a real
  blob volume and requires the server's `io=StorageFull` account, its 503,
  and its recovery when the space comes back.
- A journal accounting survey that is itself refused is now recorded as a
  fact of its own rather than dropped: the tracked total is marked unverified,
  a survey publishes both of its halves or neither, and while it stands the
  server is fail-closed — an append retries the survey once and otherwise
  refuses with `503 journal_unverified` having written nothing, so the
  watermark is never decided against a figure nothing has re-read. `/readyz`
  retries the survey too and answers `503 not_ready` with the kind that
  refused it, so a volume an operator has fixed comes back on the next probe
  with no write in between; `VolumeStatus` gained `usage_unverified` so the
  dashboard shows the figure as the last one read successfully. A faulted
  journal stays faulted however well the volume measures: that state is about
  the segment's contents and still clears only at a restart. The original
  operation error is unchanged and still what its caller gets.
- The `dispositions` reconciliation rewrites a stored justification with two
  writes, `state=open` then `state=dismissed`: GitHub refuses a `dismissed`
  write to an already-dismissed alert, which stopped the first live run on
  `main` with 78 rewrites planned. Each write announces its phase; either write
  failing is fatal to that run and blocks publication, and the next authorized
  run converges from whatever state was left. The offline step harness is now
  STATEFUL — it holds each alert's state, reason and comment, answers listings
  from them, and refuses a second dismissal the way the API does — so the
  single-write shape cannot pass the suite again.

## 0.1.6 - 2026-09-09

- CodeQL dispositions are code: `security/codeql-dispositions.json` records
  every accepted alert with its rule, its glob, its scope, one of CodeQL's
  three reasons and the issue carrying the reasoning, and a new `dispositions`
  job in `codeql.yml` waits for both analyses to be indexed and then fails any
  ref that carries an alert no entry covers — on a pull request that means the
  changed range AND the base branch, whose alerts a diff-informed pull-request
  analysis never shows and whose dismissed alerts count too, judged in the
  commit the base's analyses ran on. On a push to `main` the job first
  reconciles the alerts that are already quiet — a dismissal nothing covers is
  reopened, a stored justification that is not this file's is rewritten — then
  dismisses every covered open alert and requires `main` to hold zero, so
  nobody dismisses by hand, nothing is excluded from analysis, and a new real
  finding blocks the gate and the release chain until it is fixed or
  dispositioned in a reviewed pull request.
- An acceptance over product code now names what was reviewed: `line_is` (the
  exact source line) or `reviewed_sha256` (the file's bytes), verified on every
  run whether or not an alert touches the file, so an edit to accepted code
  cannot land without re-triage in the same pull request. Every judged alert
  must also name the commit it was analysed on and this workflow's analysis
  key, so a superseded or foreign record cannot supply a line number to a
  checkout that never produced it.

## 0.1.5 - 2026-09-09

- Every line that states a storage refusal now names the `io::ErrorKind`
  behind it (`io=StorageFull`, `io=PermissionDenied`, `io=NotFound`) through
  the one helper the request path already used, so the five fatal startup
  refusals, the collection, unlink and scrub lines, the snapshot retries, the
  expired-pairing sweep, the dropped `seen` event and the `check`/`export`
  refusal say WHICH I/O stopped them instead of `refusal=io_error` alone.
- The image smoke's `deny` adds the number behind that word: `df` of both
  volumes read from inside the compose path's digest-pinned throwaway image,
  and the daemon's own `docker system df`, both best-effort so neither can
  mask the refusal they explain.

## 0.1.4 - 2026-09-09

- The chart's `deploymentReady` gates the replica count instead of only
  annotating it. False, the shipped default, renders every object with
  zero application replicas, so the claims can bind their volumes and the
  TLS proxy can resolve the Service while no Pod waits on a volume or a
  Secret that does not exist yet; true is a scale from zero to one. The
  chart pins render both values and refuse a non-boolean.

## 0.1.3 - 2026-09-08

- The publisher attests with the URI form of the provenance type
  (`--type https://slsa.dev/provenance/v1`): the named `slsaprovenance1`
  makes cosign re-serialise the predicate through its typed struct and
  drop BuildKit's layer metadata, which is what the contract binds each
  platform through. The contract accepts the in-toto Statement v0.1 that
  cosign emits. v0.1.2's publisher run built, signed and attested its
  image, then refused its own attestation on both counts, so that tag
  carries no chart and no Release; nothing weaker was accepted.

## 0.1.2 - 2026-09-08

Tagged and its image published, signed and attested; the publisher's own
verification refused the attestation (statement type; predicate stripped of
its layer groups), so this version received no chart and no GitHub Release
(repaired in 0.1.3).


- The release publisher attests the image's SLSA v1 provenance onto the
  published digest with its own identity, one statement per platform,
  and proves it verifies with the consumer's command before the chart
  embeds the digest. v0.1.1's image carries BuildKit provenance but no
  signed attestation, which the platform's acquisition check requires.
  `scripts/ci/provenance_contract.py` decides, offline, what each
  statement binds: the BuildKit v1 shape naming this exact run, and one
  production platform, identified by the layer digests of that platform's
  manifest; every platform gets exactly one statement, on a fresh build
  and on a reused digest alike.

## 0.1.1 - 2026-09-08

- The release publisher checks the plugin bundle's listing for the names
  the archive holds. The first v0.1.0 publisher run exported a correct
  bundle and then failed its own check, looking for `./main.js` in a
  listing that said `main.js`; v0.1.0 keeps its tag, signed image and
  signed chart and received no Release.
- The nonce log's compaction recovery contract is published for operators
  (`docs/storage.md`, "Nonce log recovery"), and each of its sentences is
  pinned by a test that drives a real compaction over a real volume.

## 0.1.0 - 2026-09-08

Tagged, with its image and chart published and signed; it received no
GitHub Release because the publisher's bundle check failed after them
(repaired in 0.1.1).

### Added

- Repository contract, architecture, wire protocol, storage, threat model,
  benchmark, validation, and platform-onboarding documents.
- Start-time volume posture: `serve`, `check`, and `export` measure the type,
  owner, and mode of both volume roots and both credential files before
  anything is read or written through them. A weak mode is corrected and
  re-read; a link, a substituted type, or a foreign owner refuses the start.
- A ceiling on the heads one file may hold, equal to the parents one version
  may declare, so a conflicted file is always resolvable by one merge naming
  every head and the head list a response carries is bounded. The version
  that would pass it is refused with `409 too_many_heads` and nothing
  already stored changes; replay applies what the journal already holds.
- Replay protection that survives a restart: every accepted nonce is
  appended to `v1/nonces` on the journal volume and fsynced before its
  request is answered, and a start loads back what the 600 s window still
  covers. The file is rewritten once it passes twice the cache's ceiling, a
  torn final line costs only itself, and a volume that will not take the
  record refuses the request with `503 nonce_log_unavailable`, and a link
  standing where that file belongs refuses the start.
- Pending devices are reconciled against the pairing table on every start.
  A pairing lives in memory and the device a claim creates is journaled, so
  a restart used to leave an unapproved claimant nobody could approve and
  expiry could not reach, holding its wrapped secret for the life of the
  store. It is now destroyed down the path expiry uses, with one line
  stating the count.
