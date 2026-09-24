# Mutation kill matrix - the 1.1.2 train

Every guard this range adds or carries, mutated against the whole plugin
suite. Each mutant is an exact unified diff beside this file with its subject
on its first line. Nothing below is typed by hand: the run produces the
numbers and `record.py` writes this file from them, so a table whose counts
have drifted from the suite is a table anyone can catch.

    sh plugin/test/mutants/matrix.sh > matrix.log
    python3 plugin/test/mutants/record.py matrix.log plugin/test/mutants 767

The last argument is the size of the clean suite -- 767 tests here, which
`node --test` prints as `# tests` -- so every count below is out of the whole
suite. One mutant can be re-measured on its own:

    sh plugin/test/mutants/run.sh plugin/test/mutants/M12.diff

A surviving mutant is a finding, so each line below either has a non-zero
count and names the tests that produced it, or says why no test can produce
one. The runner applies with `-F0`: a patch whose context has moved fails
loudly rather than mutating something it was never written for, and a patch
that fails to apply is neither a kill nor a survival -- it is an unmeasured
guard, which is why every mutant whose context a repair moves is re-cut in
the same range as the repair.

| Mutant | Subject | Killed by |
| --- | --- | --- |
| M01 | the tie-break comparison reversed | 39/767 |
| M02 | the tie-break always keeps the name | 23/767 |
| M03 | the tie-break always renames | 17/767 |
| M04 | a name this device already settled is ignored | 8/767 |
| M05 | a settled occupant is written over unchecked | 5/767 |
| M06 | keep-and-record records no copy | 13/767 |
| M07 | the moved file's delete is left unmarked | 3/767 |
| M08 | the moved file's record is left clean | 4/767 |
| M09 | no free name reports the move as done | 1/767 |
| M10 | an unidentified file is never settled | 2/767 |
| M11 | the source of a move is never checked for a local edit | 2/767 |
| M12 | adoption takes any occupant of the length | 2/767 |
| M13 | identify believes any publish outcome | 1/767 |
| M14 | a failed publish reports success | 1/767 |
| M15 | one path pushed twice at once | 3/767 |
| M16 | the source is not re-stat-ed before the trash | 1/767 |
| M17 | the refusal is logged and the move reported as done | 1/767 |
| M18 | the move reads the whole file again | 2/767 |
| M19 | the copy window is the rest of the file | 1/767 |
| M20 | a copy that failed under a moving source is raised, not refused | 1/767 |
| M21 | the fake's create-only writer accepts a short copy | 1/767 |
| M22 | the digest proof is bound to a fresh stat | 2/767 |
| M23 | recordAt stats the file itself | 4/767 |
| M24 | the settled write records a fresh stat | 3/767 |
| M25 | the joined request is dropped, as before | **SURVIVES** 0/767 |
| M26 | the follow-up is remembered and never queued | **SURVIVES** 0/767 |
| M27 | the record is never saved | 1/767 |
| M28 | any held answer enters the rule, not only one about the destination | equivalent, see below |
| M29 | the id the server answers with is ignored | 6/767 |
| M30 | a post never offers the version the server already holds | 3/767 |
| M31 | a rename offers itself for deduplication | 1/767 |
| M32 | the domain map offers itself for deduplication | 1/767 |
| M33 | 121: drain() resolves immediately while draining (the 1.0.6 early return) | 3/767 |
| M34 | 121: sync now never drains again for work queued behind it | 1/767 |
| M35 | 121: sync now always reports that it joined a running drain | 1/767 |
| M36 | 56: the in-flight byte ceiling admits anything | 1/767 |
| M37 | 56: a chunk already in flight is uploaded a second time | 1/767 |
| M38 | 56: the probe always answers that the body never landed | 1/767 |
| M39 | 56: the 409 retry re-uploads every chunk again | 1/767 |
| M40 | 91: a renamed folder does not take the selection with it | 5/767 |
| M41 | 91: a file leaving the selection is published as a deletion | 6/767 |
| M42 | 91: both sides of the move are judged by the selection after it | 5/767 |
| M43 | 91: the followed selection is never persisted | 1/767 |
| M44 | 92: every scope change replays from zero, narrowing included | 1/767 |
| M45 | no hold is ever taken, so no move is ever completed | 11/767 |
| M46 | the desktop writer answers with a fresh look at the name instead of the bytes it committed | 1/767 |
| M47 | the local-copy bound is applied to the streaming host instead of the one that buffers | 1/767 |
| M48 | a tombstone is posted without asking whether the file is still there | 3/767 |
| M49 | a refused deletion is dropped instead of published as the change it is | 1/767 |
| M50 | a move the filesystem refused is removed by its live name anyway | 1/767 |
| M51 | a removal with no hold behind it is made anyway, with the window open | 3/767 |
| M52 | a host that cannot bind a removal is asked to move anyway, and copies first | 2/767 |
| M53 | what moved is not proved against what was copied | 4/767 |
| M54 | the file is put back and deleted by the name an editor writes to | 4/767 |
| M55 | the vacated name is written over instead of created | 1/767 |
| M56 | a save made through an open descriptor after the move is not noticed | 4/767 |
| M57 | a tombstone is applied without proving the file against its record | 3/767 |
| M58 | a replayed tombstone is obeyed whatever this device's version descends from | 6/767 |
| M59 | the tombstone's removal is not bound to the bytes it was told to remove | 1/767 |
| M60 | the put-back looks at the destination and then replaces whatever took it | 2/767 |
| M61 | the hold is released whether or not the restore landed | 1/767 |
| M62 | the hold is unlinked on a stat, with no descriptor left to answer for it | 1/767 |
| M63 | an upload that outlived its path records it anyway | 1/767 |
| M64 | a folder rename moves the records and leaves the pending work behind | 1/767 |
| M65 | the adopted version is proved by everything except the path | 3/767 |
| M66 | the repost after a refused adoption offers the promise again | 3/767 |
| M67 | the bulk-deletion floor is removed, so any pass can hold | 2/767 |
| M68 | a count alone decides a bulk deletion, without the share | 1/767 |
| M69 | the periodic scan may clear a hold the startup pass took | 2/767 |
| M70 | the confirmation queues nothing, so a real deletion never publishes | 1/767 |
| M71 | every remote rename falls back to write-then-trash | 2/767 |
| M72 | the rename shortcut stops proving the source holds this content | 3/767 |
| M73 | leaving a server keeps the folder records it minted | 1/767 |
| M74 | the fake host renames a DIRECTORY component from a file's move | 1/767 |
| M75 | a folder record stops re-casing the directory it names | 20/767 |
| M76 | a note's move records a spelling the vault does not show | 4/767 |
| M77 | a rename that changed no byte downloads the note again | 4/767 |
| M78 | the folder re-case trusts the host's answer instead of the vault's listing | 1/767 |
| M79 | a case-only folder rename publishes its folder record after the moves | 11/767 |
| M80 | each half of a folder rename reads the selection for itself | 2/767 |
| M81 | the case-only folder record is enqueued first and not held to | 8/767 |
| M82 | a batch takes its paths without looking for a barrier | 8/767 |
| M83 | a materialised file is recorded at the manifest's spelling | 2/767 |
| M84 | a re-case carries the records and leaves their heads behind | 1/767 |
| M85 | the scan's move pairing stops asking about a directory's case | 1/767 |
| M86 | a folder rename this device DISCOVERS is declined as a stale record | 1/767 |
| M87 | a pairing is declined on a host that keeps the two spellings apart | 1/767 |
| M88 | an echo mark armed for an event that never comes is never expired | 3/767 |
| M89 | a folder record is judged by the file rule, as it was | 6/767 |
| M90 | an incoming folder record is judged by the file rule, as it was | 8/767 |
| M91 | a received re-case leaves the selection at the old spelling | 1/767 |
| M92 | a discovered folder re-case goes out in the two loops' order | 1/767 |
| M93 | a folder is removed though the vault spells it another way | 1/767 |
| M94 | a failed folder post is logged and dropped, as it was | 3/767 |
| M95 | a retried folder record is put back without its barrier | 2/767 |
| M96 | the fake's folder removal compares names without folding case | 1/767 |
| M97 | the receiver admits a case-twin of a selected folder with no tombstone behind it | 7/767 |
| M98 | a folder tombstone arms the retirement whatever record this device holds | 2/767 |
| M99 | a folder tombstone retires every selected folder rather than the one it names | 1/767 |
| M100 | the retirement is armed by a tombstone that is not this record's own | 1/767 |
| M101 | the retirement is not spent by the folder record that takes it | 1/767 |
| M102 | a record written for a folder leaves its retirement open | 1/767 |
| M103 | the folder rule's case tolerance compares whole paths again | 2/767 |
| M104 | a rename of a file onto its own path is taken as a rename | 1/767 |
| M105 | a folder rename onto its own path still fans out into per-file moves | 1/767 |
| M106 | a folder rename onto its own path still publishes a tombstone and a record | 1/767 |
| M107 | the folder record's hold is not restored at the next start | 1/767 |
| M108 | the reconcile pass queues the folder records it owes after the file work | 1/767 |
| M109 | the fake reports a folder rename that landed where it started | 1/767 |
| M110 | an outage is classified as a refusal, and a refusal as an outage | 14/767 |
| M111 | a 507 the transport retried out is retried again | 1/767 |
| M112 | the reconnect pause is never capped | 1/767 |
| M113 | the reconnect pause never grows | 2/767 |
| M114 | teardown leaves the reconnect armed | 1/767 |
| M115 | the network coming back is not listened for | 1/767 |
| M116 | a start leaves the pending reconnect timer armed | 1/767 |
| M117 | a resume leaves the status bar saying offline | 1/767 |
| M118 | leaving the server leaves the reconnect armed | 1/767 |
| M119 | a folder-selection change carries the old reconnect cycle on | 1/767 |
| M120 | a start that succeeded does not close the reconnect cycle | 1/767 |
| M121 | online starts an engine whether or not a retry is pending | 9/767 |
| M122 | the identical-name check never matches | 3/767 |
| M123 | a record naming no version is settled anyway | 1/767 |
| M124 | identical names are settled without comparing chunk digests | 40/767 |
| M125 | a note whose mtime moved is taken for its recorded version | 1/767 |
| M126 | a note whose size moved is taken for its recorded version | 1/767 |
| M127 | the identical pair keeps the HIGHER id | 3/767 |
| M128 | the yielding device does not record the lower id | 2/767 |
| M129 | the yielding device does not retire its own id | 2/767 |
| M130 | a push never rereads the record before posting | 1/767 |
| M131 | a record of other bytes found before posting is taken for the push | 1/767 |
| M132 | a record that appears during the post is never settled | 2/767 |
| M133 | a record of other bytes that appears during the post is settled as a duplicate | 1/767 |
| M134 | the post-window pair keeps the HIGHER id | 2/767 |
| M135 | the post-window keeper does not retire the posted duplicate | 1/767 |
| M136 | the post-window yield does not record the lower id | 1/767 |
| M137 | the post-window yield does not retire the adopted id | 1/767 |
| M138 | a tombstone that cannot be posted is raised | 1/767 |

## Which tests killed each mutant

**M01** - the tie-break comparison reversed

- a device that keeps two spellings apart merges and deletes neither
- a native move preserves an edit arriving inside the trash operation
- an ordinary native move drops its hold and leaves the copy behind
- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a mobile host removes nothing, and the note survives the window
- a hold refused with EPERM removes nothing, and the note survives the window
- a hold refused with EXDEV removes nothing, and the note survives the window
- a hold refused with unsupported removes nothing, and the note survives the window
- a move refused with EXDEV removes nothing, and the note survives the window
- a save that replaces the source between the hold and the removal is preserved
- follow-up: a replacing save inside permanent removal remains in the vault
- a replacement that lands before the move is put back, not removed
- an in-place save before the move is put back, not removed
- a restore that lands nowhere keeps the hold rather than releasing it
- review: restoring a changed moved file does not overwrite a later save
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable
- a pull never replaces a note this device tracks under another identity (other_file)
- the holder of the lower id keeps the path and records the other note
- the holder of the higher id moves its own note aside and yields the path
- a later version of the other note lands on its own name, not on a new copy
- the published rename arrives as a plain move, not another copy
- a rename whose name this device already chose is a no-op, not a second file
- an unpushed local edit at the settled name is kept, not replaced
- the copy's record is stored, not only held in memory
- a note this device never published is given an id before the rule decides
- and it yields the name once it has one, when the other id sorts lower
- a local file of the same length that is NOT this version is never adopted
- a note replaced while it is being adopted is not marked as that version
- a copy replaced while it is being matched is not recorded as the version
- a save that lands on a settled copy as it is written is not recorded as that version
- an edit typed while the note is being moved aside is never trashed
- a note far larger than memory is moved aside a window at a time
- a device that cannot bind a removal keeps both instead of moving its own note
- a local note past this device's ceiling is left where it is
- a note truncated while it is being copied aside is refused, not torn
- an edit made while a note is being pushed is not left behind
- two devices that name one note twice converge, and stay converged

**M02** - the tie-break always keeps the name

- a native move preserves an edit arriving inside the trash operation
- an ordinary native move drops its hold and leaves the copy behind
- a mobile host removes nothing, and the note survives the window
- a hold refused with EPERM removes nothing, and the note survives the window
- a hold refused with EXDEV removes nothing, and the note survives the window
- a hold refused with unsupported removes nothing, and the note survives the window
- a move refused with EXDEV removes nothing, and the note survives the window
- a save that replaces the source between the hold and the removal is preserved
- follow-up: a replacing save inside permanent removal remains in the vault
- a replacement that lands before the move is put back, not removed
- an in-place save before the move is put back, not removed
- a restore that lands nowhere keeps the hold rather than releasing it
- review: restoring a changed moved file does not overwrite a later save
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable
- the holder of the higher id moves its own note aside and yields the path
- and it yields the name once it has one, when the other id sorts lower
- an edit typed while the note is being moved aside is never trashed
- a note far larger than memory is moved aside a window at a time
- a device that cannot bind a removal keeps both instead of moving its own note
- a local note past this device's ceiling is left where it is
- a note truncated while it is being copied aside is refused, not torn
- two devices that name one note twice converge, and stay converged

**M03** - the tie-break always renames

- a device that keeps two spellings apart merges and deletes neither
- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a pull never replaces a note this device tracks under another identity (other_file)
- the holder of the lower id keeps the path and records the other note
- a later version of the other note lands on its own name, not on a new copy
- the published rename arrives as a plain move, not another copy
- a rename whose name this device already chose is a no-op, not a second file
- an unpushed local edit at the settled name is kept, not replaced
- the copy's record is stored, not only held in memory
- a note this device never published is given an id before the rule decides
- a local file of the same length that is NOT this version is never adopted
- a note replaced while it is being adopted is not marked as that version
- a copy replaced while it is being matched is not recorded as the version
- a save that lands on a settled copy as it is written is not recorded as that version
- an edit made while a note is being pushed is not left behind
- two devices that name one note twice converge, and stay converged

**M04** - a name this device already settled is ignored

- a case-only move is refused, not forced, when another file wears the destination
- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a second version with the same size and modification time still reaches the vault
- a later version of the other note lands on its own name, not on a new copy
- a note that cannot be published keeps both, and the copy is still recorded
- a save that lands on a settled copy as it is written is not recorded as that version
- a version of a file this device tracks lands where it put it, not at a second path

**M05** - a settled occupant is written over unchecked

- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- an edited conflict copy survives the next version that would take its name
- an unpushed local edit at the settled name is kept, not replaced
- a save that lands on a settled copy as it is written is not recorded as that version

**M06** - keep-and-record records no copy

- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a second version with the same size and modification time still reaches the vault
- the holder of the lower id keeps the path and records the other note
- a later version of the other note lands on its own name, not on a new copy
- the published rename arrives as a plain move, not another copy
- the copy's record is stored, not only held in memory
- a note this device never published is given an id before the rule decides
- a note that cannot be published keeps both, and the copy is still recorded
- a publisher that leaves no record is not taken at its word
- a copy replaced while it is being matched is not recorded as the version
- a save that lands on a settled copy as it is written is not recorded as that version
- a device that cannot bind a removal keeps both instead of moving its own note

**M07** - the moved file's delete is left unmarked

- a note written while this device was closed survives one the other device made at the same path
- the holder of the higher id moves its own note aside and yields the path
- a note far larger than memory is moved aside a window at a time

**M08** - the moved file's record is left clean

- the holder of the higher id moves its own note aside and yields the path
- and it yields the name once it has one, when the other id sorts lower
- a note far larger than memory is moved aside a window at a time
- two devices that name one note twice converge, and stay converged

**M09** - no free name reports the move as done

- when no name is free this device keeps its own note and takes none

**M10** - an unidentified file is never settled

- a note this device never published is given an id before the rule decides
- and it yields the name once it has one, when the other id sorts lower

**M11** - the source of a move is never checked for a local edit

- a move never trashes a local file this device has not pushed
- a rename over an unpushed local edit keeps both, and renames nothing

**M12** - adoption takes any occupant of the length

- an occupied name whose bytes are not this version's is not mistaken for it
- a local file of the same length that is NOT this version is never adopted

**M13** - identify believes any publish outcome

- a publisher that leaves no record is not taken at its word

**M14** - a failed publish reports success

- a note that cannot be published keeps both, and the copy is still recorded

**M15** - one path pushed twice at once

- a note written while this device was closed survives one the other device made at the same path
- an edit made while a note is being pushed is not left behind
- two devices that name one note twice converge, and stay converged

**M16** - the source is not re-stat-ed before the trash

- an edit typed while the note is being moved aside is never trashed

**M17** - the refusal is logged and the move reported as done

- an edit typed while the note is being moved aside is never trashed

**M18** - the move reads the whole file again

- a note far larger than memory is moved aside a window at a time
- a note truncated while it is being copied aside is refused, not torn

**M19** - the copy window is the rest of the file

- a note far larger than memory is moved aside a window at a time

**M20** - a copy that failed under a moving source is raised, not refused

- a note truncated while it is being copied aside is refused, not torn

**M21** - the fake's create-only writer accepts a short copy

- a note truncated while it is being copied aside is refused, not torn

**M22** - the digest proof is bound to a fresh stat

- a note replaced while it is being adopted is not marked as that version
- a copy replaced while it is being matched is not recorded as the version

**M23** - recordAt stats the file itself

- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a save that lands on a version as it is written is not recorded as that version
- a save that lands on a settled copy as it is written is not recorded as that version

**M24** - the settled write records a fresh stat

- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a save that lands on a settled copy as it is written is not recorded as that version

**M25** - the joined request is dropped, as before

- SURVIVES. No test in the suite distinguishes this mutation from the
  code it replaces; the finding is recorded in the pull request.

**M26** - the follow-up is remembered and never queued

- SURVIVES. No test in the suite distinguishes this mutation from the
  code it replaces; the finding is recorded in the pull request.

- WHY IT SURVIVES NOW AND DID NOT BEFORE, which is the reason this file
  is generated rather than typed. Every earlier run recorded one kill for
  it, always from the same test: `a remote rename that also edits the
  note downloads it rather than renaming`. That test waited for the
  note's TEXT and then asserted on its RECORD, so under any mutation that
  added a step it read a record not yet written and died of
  `undefined.fileId` -- which is not a fact about this mutant. The wait
  is correct now, the phantom is gone with it, and the true state of the
  guard is visible: nothing here tells `pushOne` queueing the follow-up
  it remembered from `pushOne` forgetting it. Reaching that needs a
  second request for a path WHILE it is being pushed, which the drain
  does not produce -- it is awaiting the batch that holds the push, so
  the second request waits in the queue and is served as an ordinary
  push afterwards. The route that does produce it is the pull path
  asking out of turn. The guard is kept: it is review round 2, finding 3,
  where the consequence was an engine reporting idle with an edit that
  had gone nowhere.

**M27** - the record is never saved

- the copy's record is stored, not only held in memory

**M28** - any held answer enters the rule, not only one about the destination

- EQUIVALENT, and kept as the proof of that. The branch it removes sends
  only an answer about the DESTINATION into the rule; the mutant sends the
  source's answer there too, behind a cast that asserts a type the value
  does not have. No outcome moves. For a file id this device already
  tracks, `sameNameTiebreak` hands the version straight to
  `updateSettled`, whose first act is to ask `competing` about that same
  path -- the very answer that put the call there -- so it returns
  `keepBoth`, which is what the `else` calls directly. The rename branch
  below is not reachable either: it requires `held === null`, and `held`
  is what got us here. What the mutant does change is the number of
  `stat` calls on the way to the same answer, and until this range two
  tests could tell the difference -- not because the outcome differed,
  but because each waited on a proxy for what it went on to assert, so an
  apply that took more turns was asserted on half-finished. Both now wait
  on their own condition, and the mutant is indistinguishable across five
  consecutive runs. It is kept rather than deleted because its shape is
  the argument: the cast is the cost of merging the two paths.

**M29** - the id the server answers with is ignored

- a post the server already holds is recorded under the id it answers with
- a publish under an adopted file id that dedupes is adoption, and renames nothing
- two engines that merge one note identically end on ONE version
- ordinary concurrent edit must not adopt another device's rename-and-edit manifest
- a persisted unposted rename must retain the dedupe opt-out after state reload
- two devices resolving one concurrent edit settle instead of looping

**M30** - a post never offers the version the server already holds

- a post the server already holds is recorded under the id it answers with
- a publish under an adopted file id that dedupes is adoption, and renames nothing
- two engines that merge one note identically end on ONE version

**M31** - a rename offers itself for deduplication

- a rename is never deduplicated, so both devices still learn the new name

**M32** - the domain map offers itself for deduplication

- two different domain maps from one parent are two versions

**M33** - 121: drain() resolves immediately while draining (the 1.0.6 early return)

- startup engine does not label a foreign renamed manifest as its own echo
- sync now waits for the drain already running, and says which decision it took
- sync now drains again for work queued after the drain it joined took its last batch

**M34** - 121: sync now never drains again for work queued behind it

- sync now drains again for work queued after the drain it joined took its last batch

**M35** - 121: sync now always reports that it joined a running drain

- sync now waits for the drain already running, and says which decision it took

**M36** - 56: the in-flight byte ceiling admits anything

- V7: killing an upload and reopening re-sends fewer than 8 MiB

**M37** - 56: a chunk already in flight is uploaded a second time

- a chunk in flight is never uploaded twice concurrently

**M38** - 56: the probe always answers that the body never landed

- a lost answer asks whether the body landed instead of re-sending it

**M39** - 56: the 409 retry re-uploads every chunk again

- a version refused for missing chunks re-uploads only what the server lacks

**M40** - 91: a renamed folder does not take the selection with it

- review: a folder rename retains the pending upload of an untracked new note
- a selected folder renamed keeps its notes on every device, and the selection follows it
- a selected folder moved into another folder keeps its notes on every device, and the selection follows it
- a rename above a selected folder moves the selection with it, persists it, and widens nothing
- a failed save of a followed selection stops the engine instead of syncing an unrecorded scope

**M41** - 91: a file leaving the selection is published as a deletion

- a rename whose target is hidden is not synced, and neither is the plugin's own state
- review: a pending upload must not restore tracking for a file that left the selected scope
- review: moving outside the selection after an upload settles is the safe control
- review: a scope exit during upload must preserve the other device's live note
- a selected folder renamed where no device may sync publishes nothing and says so once
- moving local content into a selected folder creates a new identity; moving it out publishes nothing

**M42** - 91: both sides of the move are judged by the selection after it

- a case-only rename of a SELECTED folder publishes moves, not new notes
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder
- a selected folder renamed keeps its notes on every device, and the selection follows it
- a selected folder moved into another folder keeps its notes on every device, and the selection follows it
- a rename above a selected folder moves the selection with it, persists it, and widens nothing

**M43** - 91: the followed selection is never persisted

- a failed save of a followed selection stops the engine instead of syncing an unrecorded scope

**M44** - 92: every scope change replays from zero, narrowing included

- scope contraction waits for active work, retains state and cursor, and saves locally

**M45** - no hold is ever taken, so no move is ever completed

- a native move preserves an edit arriving inside the trash operation
- an ordinary native move drops its hold and leaves the copy behind
- a move refused with EXDEV removes nothing, and the note survives the window
- a save that replaces the source between the hold and the removal is preserved
- follow-up: a replacing save inside permanent removal remains in the vault
- a replacement that lands before the move is put back, not removed
- an in-place save before the move is put back, not removed
- a restore that lands nowhere keeps the hold rather than releasing it
- review: restoring a changed moved file does not overwrite a later save
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable

**M46** - the desktop writer answers with a fresh look at the name instead of the bytes it committed

- a native settled write records the metadata of the bytes it committed

**M47** - the local-copy bound is applied to the streaming host instead of the one that buffers

- a local note past this device's ceiling is left where it is

**M48** - a tombstone is posted without asking whether the file is still there

- a host that lists two spellings and answers for a third renames nothing
- a file the pull writes while the scan is listing is not published as a tombstone
- a deletion refused because the file came back is published as the change it is

**M49** - a refused deletion is dropped instead of published as the change it is

- a deletion refused because the file came back is published as the change it is

**M50** - a move the filesystem refused is removed by its live name anyway

- a move refused with EXDEV removes nothing, and the note survives the window

**M51** - a removal with no hold behind it is made anyway, with the window open

- a hold refused with EPERM removes nothing, and the note survives the window
- a hold refused with EXDEV removes nothing, and the note survives the window
- a hold refused with unsupported removes nothing, and the note survives the window

**M52** - a host that cannot bind a removal is asked to move anyway, and copies first

- a device that cannot bind a removal keeps both instead of moving its own note
- a note the queue is already pushing is not published a second time

**M53** - what moved is not proved against what was copied

- a save that replaces the source between the hold and the removal is preserved
- a replacement that lands before the move is put back, not removed
- an in-place save before the move is put back, not removed
- review: restoring a changed moved file does not overwrite a later save

**M54** - the file is put back and deleted by the name an editor writes to

- an ordinary native move drops its hold and leaves the copy behind
- follow-up: a replacing save inside permanent removal remains in the vault
- a restore that lands nowhere keeps the hold rather than releasing it
- review: a blocked restore retains the only hold containing the later edit

**M55** - the vacated name is written over instead of created

- follow-up: a replacing save inside permanent removal remains in the vault

**M56** - a save made through an open descriptor after the move is not noticed

- a native move preserves an edit arriving inside the trash operation
- a restore that lands nowhere keeps the hold rather than releasing it
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable

**M57** - a tombstone is applied without proving the file against its record

- a tombstone does not take an edit this device never published
- a tombstone whose revive cannot publish keeps the file and says only that
- a remote delete over an unpushed local edit keeps the edit and republishes it

**M58** - a replayed tombstone is obeyed whatever this device's version descends from

- a ghost tombstone that forks from the record is refused, and the note stays
- a tombstone that forks from the version this device holds is one side of a fork
- review: replay skips a historical tombstone that the tracked live version already incorporates
- review: widening after an excluded remote deletion must preserve the local edit
- review: widening must not trash an unuploaded local edit while its source read is pending
- a delete raced by an edit reaches the other device as a live note

**M59** - the tombstone's removal is not bound to the bytes it was told to remove

- a save landing between the tombstone's check and its removal is kept

**M60** - the put-back looks at the destination and then replaces whatever took it

- a restore that lands nowhere keeps the hold rather than releasing it
- review: restoring a changed moved file does not overwrite a later save

**M61** - the hold is released whether or not the restore landed

- a restore that lands nowhere keeps the hold rather than releasing it

**M62** - the hold is unlinked on a stat, with no descriptor left to answer for it

- review: a descriptor save after the final hold stat remains reachable

**M63** - an upload that outlived its path records it anyway

- review: a selection narrowed while a version is posting records nothing for that path

**M64** - a folder rename moves the records and leaves the pending work behind

- review: a folder rename retains the pending upload of an untracked new note

**M65** - the adopted version is proved by everything except the path

- ordinary concurrent edit must not adopt another device's rename-and-edit manifest
- a persisted unposted rename must retain the dedupe opt-out after state reload
- startup engine does not label a foreign renamed manifest as its own echo

**M66** - the repost after a refused adoption offers the promise again

- ordinary concurrent edit must not adopt another device's rename-and-edit manifest
- a persisted unposted rename must retain the dedupe opt-out after state reload
- startup engine does not label a foreign renamed manifest as its own echo

**M67** - the bulk-deletion floor is removed, so any pass can hold

- a small vault emptied is below the floor and still publishes
- startup reconciliation tombstones a file deleted while Obsidian was closed

**M68** - a count alone decides a bulk deletion, without the share

- a deletion that is large but not most of the vault is published

**M69** - the periodic scan may clear a hold the startup pass took

- a selected folder renamed while Obsidian was closed publishes nothing and says so once
- the user's confirmation publishes exactly what was held

**M70** - the confirmation queues nothing, so a real deletion never publishes

- the user's confirmation publishes exactly what was held

**M71** - every remote rename falls back to write-then-trash

- a renamed note moves on the other device and neither publishes a tombstone (immediate vault events)
- a renamed note moves on the other device and neither publishes a tombstone (deferred vault events)

**M72** - the rename shortcut stops proving the source holds this content

- a remote rename that also edits the note downloads it rather than renaming
- one version that renames AND edits is downloaded, not applied as a bare rename
- a removal mark outlives no scan cycle, so a later deletion of that path is published

**M73** - leaving a server keeps the folder records it minted

- forgetting a pairing drops the identity and everything derived from it, and nothing else

**M74** - the fake host renames a DIRECTORY component from a file's move

- the two host models answer a second spelling differently, or these tests prove nothing

**M75** - a folder record stops re-casing the directory it names

- a case-only rename on the phone reaches the case-insensitive desktop as one entry
- a case-only folder rename between two devices that both fold case settles, and neither publishes it back
- a host that reports a folder rename it did not make records nothing
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder
- a case-only rename of the folder a device SELECTS is applied there, and the selection follows
- a case-only rename of a subfolder of the selected folder still carries its record
- the folder record reaches the server before the moves under it, whatever the transport does
- a folder record that re-cases the folder this device selects moves the selection with it
- a folder record whose post fails is retried, and the moves stay behind it (rejects it once)
- a folder record whose post fails is retried, and the moves stay behind it (holds it and then rejects it)
- a folder record's hold survives a restart: the post is still in flight when it starts again
- a folder record's hold survives a restart: the post failed while it was stopped
- a folder record's hold survives a restart: the plugin reloaded and a new engine took over
- a folder record reported twice while its post is in flight publishes one record and keeps no hold
- a folder record whose post keeps failing expires with a decision, and the queue drains
- a folder record re-cased here brings down the versions refused while the spellings disagreed
- real filesystem: a peer's case-only folder rename (Team docs -> team docs) is applied to the DIRECTORY and never published back
- real filesystem: a peer's case-only folder rename (team docs -> Team docs) is applied to the DIRECTORY and never published back
- real filesystem: the echo marks a re-case arms for events this host never reports expire with the next scans
- real filesystem: an EMPTY folder re-cased by a peer survives, whatever the order (record then tombstone)

**M76** - a note's move records a spelling the vault does not show

- a case-only folder move with no folder record behind it is refused, and never published back
- a folder record whose post keeps failing expires with a decision, and the queue drains
- a folder record re-cased here brings down the versions refused while the spellings disagreed
- real filesystem: a case-only folder move from a device that publishes no folder record changes nothing, and is not published back

**M77** - a rename that changed no byte downloads the note again

- a case-only rename on the phone reaches the case-insensitive desktop as one entry
- a case-only rename downloads nothing: the note is already here, under this very name
- real filesystem: a peer's case-only folder rename (Team docs -> team docs) is applied to the DIRECTORY and never published back
- real filesystem: a peer's case-only folder rename (team docs -> Team docs) is applied to the DIRECTORY and never published back

**M78** - the folder re-case trusts the host's answer instead of the vault's listing

- a host that reports a folder rename it did not make records nothing

**M79** - a case-only folder rename publishes its folder record after the moves

- a case-only rename on the phone reaches the case-insensitive desktop as one entry
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder
- a case-only rename of a subfolder of the selected folder still carries its record
- the folder record reaches the server before the moves under it, whatever the transport does
- a folder record whose post fails is retried, and the moves stay behind it (rejects it once)
- a folder record whose post fails is retried, and the moves stay behind it (holds it and then rejects it)
- a folder record's hold survives a restart: the post is still in flight when it starts again
- a folder record's hold survives a restart: the post failed while it was stopped
- a folder record's hold survives a restart: the plugin reloaded and a new engine took over
- a folder record reported twice while its post is in flight publishes one record and keeps no hold
- a folder record whose post keeps failing expires with a decision, and the queue drains

**M80** - each half of a folder rename reads the selection for itself

- a case-only rename of a SELECTED folder publishes moves, not new notes
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder

**M81** - the case-only folder record is enqueued first and not held to

- the folder record reaches the server before the moves under it, whatever the transport does
- a folder record whose post fails is retried, and the moves stay behind it (rejects it once)
- a folder record whose post fails is retried, and the moves stay behind it (holds it and then rejects it)
- a folder record's hold survives a restart: the post is still in flight when it starts again
- a folder record's hold survives a restart: the post failed while it was stopped
- a folder record's hold survives a restart: the plugin reloaded and a new engine took over
- a folder record reported twice while its post is in flight publishes one record and keeps no hold
- a folder record whose post keeps failing expires with a decision, and the queue drains

**M82** - a batch takes its paths without looking for a barrier

- the folder record reaches the server before the moves under it, whatever the transport does
- a folder record whose post fails is retried, and the moves stay behind it (rejects it once)
- a folder record whose post fails is retried, and the moves stay behind it (holds it and then rejects it)
- a folder record's hold survives a restart: the post is still in flight when it starts again
- a folder record's hold survives a restart: the post failed while it was stopped
- a folder record's hold survives a restart: the plugin reloaded and a new engine took over
- a folder record reported twice while its post is in flight publishes one record and keeps no hold
- a folder record whose post keeps failing expires with a decision, and the queue drains

**M83** - a materialised file is recorded at the manifest's spelling

- real filesystem: a file written into a folder this vault spells another way is recorded the way the vault spells it
- real filesystem: the write marks a pull leaves behind expire with the next scan cycles

**M84** - a re-case carries the records and leaves their heads behind

- a folder record re-cased here brings down the versions refused while the spellings disagreed

**M85** - the scan's move pairing stops asking about a directory's case

- a record naming a folder this vault spells another way follows the vault, and nothing is published

**M86** - a folder rename this device DISCOVERS is declined as a stale record

- a case-only folder rename the desktop only DISCOVERS leaves the phone one folder

**M87** - a pairing is declined on a host that keeps the two spellings apart

- a note moved between two folders that differ only in case is a move, where the two are two folders

**M88** - an echo mark armed for an event that never comes is never expired

- real filesystem: the echo marks a re-case arms for events this host never reports expire with the next scans
- real filesystem: the write marks a pull leaves behind expire with the next scan cycles
- a removal mark outlives no scan cycle, so a later deletion of that path is published

**M89** - a folder record is judged by the file rule, as it was

- a case-only rename of a SELECTED folder publishes moves, not new notes
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder
- a selected folder the user really deletes still tombstones every note it held
- a selected folder renamed where no device may sync publishes nothing and says so once
- scoped startup and events never inspect excluded files or infer their deletion
- a rename above a selected folder moves the selection with it, persists it, and widens nothing

**M90** - an incoming folder record is judged by the file rule, as it was

- a case-only rename of a SELECTED folder publishes moves, not new notes
- a case-only rename of the folder a device SELECTS is applied there, and the selection follows
- a folder record that re-cases the folder this device selects moves the selection with it
- a folder record one capitalisation off the selection is refused where the two are two folders
- a case-twin of the selected folder, from a device that keeps the two apart, moves no selection
- a tombstone for another selected folder admits no case-twin of this one
- a folder tombstone under another file id opens no window
- a folder record written for the selected folder again ends the retirement

**M91** - a received re-case leaves the selection at the old spelling

- a folder record that re-cases the folder this device selects moves the selection with it

**M92** - a discovered folder re-case goes out in the two loops' order

- an EMPTY folder renamed by case while Obsidian was closed survives on both devices

**M93** - a folder is removed though the vault spells it another way

- real filesystem: an EMPTY folder re-cased by a peer survives, whatever the order (record then tombstone)

**M94** - a failed folder post is logged and dropped, as it was

- a folder record whose post fails is retried, and the moves stay behind it (rejects it once)
- a folder record whose post fails is retried, and the moves stay behind it (holds it and then rejects it)
- a folder record whose post keeps failing expires with a decision, and the queue drains

**M95** - a retried folder record is put back without its barrier

- a folder record whose post fails is retried, and the moves stay behind it (rejects it once)
- a folder record whose post fails is retried, and the moves stay behind it (holds it and then rejects it)

**M96** - the fake's folder removal compares names without folding case

- the two host models answer a second spelling differently, or these tests prove nothing

**M97** - the receiver admits a case-twin of a selected folder with no tombstone behind it

- a case-twin of the selected folder, from a device that keeps the two apart, moves no selection
- a device that keeps the two spellings apart renames a sibling INTO the twin: the phone's selection and notes are untouched
- a device that keeps the two spellings apart creates the twin beside it: the phone's selection and notes are untouched
- a tombstone for another selected folder admits no case-twin of this one
- a tombstone for a folder record this device does not hold admits no case-twin
- a folder tombstone under another file id opens no window
- a folder record written for the selected folder again ends the retirement

**M98** - a folder tombstone arms the retirement whatever record this device holds

- a tombstone for a folder record this device does not hold admits no case-twin
- a folder tombstone under another file id opens no window

**M99** - a folder tombstone retires every selected folder rather than the one it names

- a tombstone for another selected folder admits no case-twin of this one

**M100** - the retirement is armed by a tombstone that is not this record's own

- a folder tombstone under another file id opens no window

**M101** - the retirement is not spent by the folder record that takes it

- a folder record that re-cases the folder this device selects moves the selection with it

**M102** - a record written for a folder leaves its retirement open

- a folder record written for the selected folder again ends the retirement

**M103** - the folder rule's case tolerance compares whole paths again

- a re-case of an ANCESTOR of the selected folder is refused, and nothing is published back
- only the last component's capitalisation is a case difference the folder rule tolerates

**M104** - a rename of a file onto its own path is taken as a rename

- a vault that reports a rename from a path to itself changes nothing

**M105** - a folder rename onto its own path still fans out into per-file moves

- a vault that reports a rename from a path to itself changes nothing

**M106** - a folder rename onto its own path still publishes a tombstone and a record

- a vault that reports a rename from a path to itself changes nothing

**M107** - the folder record's hold is not restored at the next start

- a folder record's hold survives a restart: the post is still in flight when it starts again

**M108** - the reconcile pass queues the folder records it owes after the file work

- startup reconciliation publishes a record for every folder that has none, once

**M109** - the fake reports a folder rename that landed where it started

- the fake reports no rename for a folder move that landed where it started

**M110** - an outage is classified as a refusal, and a refusal as an outage

- a start the server could not be reached for is retried, and the next one that gets through resumes
- the pause doubles from 5 s and holds at 5 minutes for as long as the outage lasts
- a terminator answering 5xx for a server that is not there is an outage too
- the device reporting its network back runs the pending retry now, and is nothing otherwise
- online while a retry is already running starts no second engine
- 401 bad_signature is not retried: it stays an error until the person acts
- 401 stale_timestamp is not retried: it stays an error until the person acts
- 403 device_revoked is not retried: it stays an error until the person acts
- 403 device_pending is not retried: it stays an error until the person acts
- unloading the plugin cancels the pending retry
- leaving the server cancels the pending retry, and the device stays not paired
- changing the folder selection cancels the pending retry; the start it ends with opens a fresh cycle
- Sync now takes the place of the pending retry: one engine, and the cycle goes on from where it was
- a manual start that gets through disarms the pending retry

**M111** - a 507 the transport retried out is retried again

- 507 after the transport's retries is not retried: it stays an error until the person acts

**M112** - the reconnect pause is never capped

- the pause doubles from 5 s and holds at 5 minutes for as long as the outage lasts

**M113** - the reconnect pause never grows

- the pause doubles from 5 s and holds at 5 minutes for as long as the outage lasts
- Sync now takes the place of the pending retry: one engine, and the cycle goes on from where it was

**M114** - teardown leaves the reconnect armed

- unloading the plugin cancels the pending retry

**M115** - the network coming back is not listened for

- the device reporting its network back runs the pending retry now, and is nothing otherwise

**M116** - a start leaves the pending reconnect timer armed

- a manual start that gets through disarms the pending retry

**M117** - a resume leaves the status bar saying offline

- a start the server could not be reached for is retried, and the next one that gets through resumes

**M118** - leaving the server leaves the reconnect armed

- leaving the server cancels the pending retry, and the device stays not paired

**M119** - a folder-selection change carries the old reconnect cycle on

- changing the folder selection cancels the pending retry; the start it ends with opens a fresh cycle

**M120** - a start that succeeded does not close the reconnect cycle

- a start the server could not be reached for is retried, and the next one that gets through resumes

**M121** - online starts an engine whether or not a retry is pending

- the device reporting its network back runs the pending retry now, and is nothing otherwise
- online while a retry is already running starts no second engine
- 401 bad_signature is not retried: it stays an error until the person acts
- 401 stale_timestamp is not retried: it stays an error until the person acts
- 403 device_revoked is not retried: it stays an error until the person acts
- 403 device_pending is not retried: it stays an error until the person acts
- 507 after the transport's retries is not retried: it stays an error until the person acts
- a domain map this version cannot read is not retried: it stays an error until the person acts
- a key that does not decrypt is not retried: it stays an error until the person acts

**M122** - the identical-name check never matches

- identical notes: the holder of the lower id keeps the name and writes nothing
- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note

**M123** - a record naming no version is settled anyway

- a record that names no version is never retired, however alike the bytes

**M124** - identical names are settled without comparing chunk digests

- control: a native move refuses an edit that arrives before its last stat
- a native move preserves an edit arriving inside the trash operation
- an ordinary native move drops its hold and leaves the copy behind
- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a mobile host removes nothing, and the note survives the window
- a hold refused with EPERM removes nothing, and the note survives the window
- a hold refused with EXDEV removes nothing, and the note survives the window
- a hold refused with unsupported removes nothing, and the note survives the window
- a move refused with EXDEV removes nothing, and the note survives the window
- a save that replaces the source between the hold and the removal is preserved
- follow-up: a replacing save inside permanent removal remains in the vault
- a replacement that lands before the move is put back, not removed
- an in-place save before the move is put back, not removed
- a restore that lands nowhere keeps the hold rather than releasing it
- review: restoring a changed moved file does not overwrite a later save
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable
- a note written while this device was closed survives one the other device made at the same path
- a pull never replaces a note this device tracks under another identity (other_file)
- the holder of the lower id keeps the path and records the other note
- the holder of the higher id moves its own note aside and yields the path
- a later version of the other note lands on its own name, not on a new copy
- the published rename arrives as a plain move, not another copy
- a rename whose name this device already chose is a no-op, not a second file
- an unpushed local edit at the settled name is kept, not replaced
- the copy's record is stored, not only held in memory
- a note this device never published is given an id before the rule decides
- and it yields the name once it has one, when the other id sorts lower
- a local file of the same length that is NOT this version is never adopted
- a note replaced while it is being adopted is not marked as that version
- a copy replaced while it is being matched is not recorded as the version
- a save that lands on a settled copy as it is written is not recorded as that version
- when no name is free this device keeps its own note and takes none
- an edit typed while the note is being moved aside is never trashed
- a device that cannot bind a removal keeps both instead of moving its own note
- a note truncated while it is being copied aside is refused, not torn
- two devices that name one note twice converge, and stay converged
- one differing byte still keeps both notes, from either side
- a widening keeps a note the newly covered folder held and the server also has

**M125** - a note whose mtime moved is taken for its recorded version

- a note with an edit not yet pushed is never taken for its recorded twin

**M126** - a note whose size moved is taken for its recorded version

- a note with an edit not yet pushed is never taken for its recorded twin

**M127** - the identical pair keeps the HIGHER id

- identical notes: the holder of the lower id keeps the name and writes nothing
- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note

**M128** - the yielding device does not record the lower id

- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note

**M129** - the yielding device does not retire its own id

- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note

**M130** - a push never rereads the record before posting

- an adoption that lands while the push reads it publishes nothing

**M131** - a record of other bytes found before posting is taken for the push

- a record of other bytes landing while the push reads is not taken for this push

**M132** - a record that appears during the post is never settled

- an adoption that lands while the push posts settles the pair on the lower id (keep)
- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M133** - a record of other bytes that appears during the post is settled as a duplicate

- a record of other bytes landing while the push reads is not taken for this push

**M134** - the post-window pair keeps the HIGHER id

- an adoption that lands while the push posts settles the pair on the lower id (keep)
- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M135** - the post-window keeper does not retire the posted duplicate

- an adoption that lands while the push posts settles the pair on the lower id (keep)

**M136** - the post-window yield does not record the lower id

- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M137** - the post-window yield does not retire the adopted id

- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M138** - a tombstone that cannot be posted is raised

- a tombstone that cannot be posted costs a duplicate id, never the note
