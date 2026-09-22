# Mutation kill matrix - the 1.0.7 same-name tie-break

Every guard this branch adds, mutated against the whole plugin suite. Each
mutant is an exact unified diff beside this file with its subject on its first
line, and this record is the output of one command:

    sh plugin/test/mutants/matrix.sh

run over the sources this commit leaves in the tree, 508 tests, against the
pinned TypeScript 5.9.3. One mutant can be re-measured on its own:

    sh plugin/test/mutants/run.sh plugin/test/mutants/M12.diff

A surviving mutant is a finding, so each line below either has a non-zero count
and names the tests that produced it, or says why no test can produce one. The
runner applies with `-F0`: a patch whose context has moved fails loudly rather
than mutating something it was never written for.

| Mutant | Subject | Killed by |
| --- | --- | --- |
| M01 | the tie-break comparison reversed | 19/508 |
| M02 | the tie-break always keeps the name | 6/508 |
| M03 | the tie-break always renames | 14/508 |
| M04 | a name this device already settled is ignored | 5/508 |
| M05 | a settled occupant is written over unchecked | 3/508 |
| M06 | keep-and-record records no copy | 10/508 |
| M07 | the moved file's delete is left unmarked | 3/508 |
| M08 | the moved file's record is left clean | 4/508 |
| M09 | no free name reports the move as done | 1/508 |
| M10 | an unidentified file is never settled | 2/508 |
| M11 | the source of a move is never checked for a local edit | 1/508 |
| M12 | adoption takes any occupant of the length | 2/508 |
| M13 | identify believes any publish outcome | 1/508 |
| M14 | a failed publish reports success | 1/508 |
| M15 | one path pushed twice at once | 3/508 |
| M16 | the source is not re-stat-ed before the trash | 1/508 |
| M17 | the refusal is logged and the move reported as done | 1/508 |
| M18 | the move reads the whole file again | 2/508 |
| M19 | the copy window is the rest of the file | 1/508 |
| M20 | a copy that failed under a moving source is raised, not refused | 1/508 |
| M21 | the fake's create-only writer accepts a short copy | 1/508 |
| M22 | the digest proof is bound to a fresh stat | 2/508 |
| M23 | recordAt stats the file itself | 2/508 |
| M24 | the settled write records a fresh stat | 1/508 |
| M25 | the joined request is dropped, as before | 1/508 |
| M26 | the follow-up is remembered and never queued | 1/508 |
| M27 | the record is never saved | 1/508 |
| M28 | any held answer enters the rule, not only one about the destination | survives, see below |
| M29 | the id the server answers with is ignored | 3/508 |
| M30 | a post never offers the version the server already holds | 3/508 |
| M31 | a rename offers itself for deduplication | 1/508 |
| M32 | the domain map offers itself for deduplication | 1/508 |
| M33 | 121: drain() resolves immediately while draining (the 1.0.6 early return) | 2/508 |
| M34 | 121: sync now never drains again for work queued behind it | 1/508 |
| M35 | 121: sync now always reports that it joined a running drain | 1/508 |
| M36 | 56: the in-flight byte ceiling admits anything | 1/508 |
| M37 | 56: a chunk already in flight is uploaded a second time | 1/508 |
| M38 | 56: the probe always answers that the body never landed | 1/508 |
| M39 | 56: the 409 retry re-uploads every chunk again | 1/508 |
| M40 | 91: a renamed folder does not take the selection with it | 5/508 |
| M41 | 91: a file leaving the selection is published as a deletion | 3/508 |
| M42 | 91: both sides of the move are judged by the selection after it | 3/508 |
| M43 | 91: the followed selection is never persisted | 1/508 |
| M44 | 92: every scope change replays from zero, narrowing included | 1/508 |

## Which tests killed each mutant

**M01** - the tie-break comparison reversed

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
- a note truncated while it is being copied aside is refused, not torn
- an edit made while a note is being pushed is not left behind
- two devices that name one note twice converge, and stay converged

**M02** - the tie-break always keeps the name

- the holder of the higher id moves its own note aside and yields the path
- and it yields the name once it has one, when the other id sorts lower
- an edit typed while the note is being moved aside is never trashed
- a note far larger than memory is moved aside a window at a time
- a note truncated while it is being copied aside is refused, not torn
- two devices that name one note twice converge, and stay converged

**M03** - the tie-break always renames

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

- a second version with the same size and modification time still reaches the vault
- a later version of the other note lands on its own name, not on a new copy
- a note that cannot be published keeps both, and the copy is still recorded
- a save that lands on a settled copy as it is written is not recorded as that version
- a version of a file this device tracks lands where it put it, not at a second path

**M05** - a settled occupant is written over unchecked

- an edited conflict copy survives the next version that would take its name
- an unpushed local edit at the settled name is kept, not replaced
- a save that lands on a settled copy as it is written is not recorded as that version

**M06** - keep-and-record records no copy

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

**M07** - the moved file's delete is left unmarked

- a note written while this device was closed survives one the other device made at the same path
- the holder of the higher id moves its own note aside and yields the path
- a note far larger than memory is moved aside a window at a time
- NOT A DETERMINISTIC COUNT. The number above is this run's; across two full
  runs at this head the kill set of this mutant moved by one test, always one
  of the two-device or offline rigs -- two engines on one virtual clock, or a
  device that starts with work already queued, resolve their collision in an
  order this mutant lets decide the outcome. That is a property of the mutant,
  not of the suite: the pristine suite passed 508/508 in every run of the
  campaign. The floor is what both runs reproduced: for M07 the higher-id move
  aside and the multi-GiB move, for M10 both unpublished-note tests, and for
  M15 the offline same-path survival, the edit that raced the push, and the
  two-engine convergence.

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
- NOT A DETERMINISTIC COUNT. The number above is this run's; across two full
  runs at this head the kill set of this mutant moved by one test, always one
  of the two-device or offline rigs -- two engines on one virtual clock, or a
  device that starts with work already queued, resolve their collision in an
  order this mutant lets decide the outcome. That is a property of the mutant,
  not of the suite: the pristine suite passed 508/508 in every run of the
  campaign. The floor is what both runs reproduced: for M07 the higher-id move
  aside and the multi-GiB move, for M10 both unpublished-note tests, and for
  M15 the offline same-path survival, the edit that raced the push, and the
  two-engine convergence.

**M11** - the source of a move is never checked for a local edit

- a move never trashes a local file this device has not pushed

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
- NOT A DETERMINISTIC COUNT. The number above is this run's; across two full
  runs at this head the kill set of this mutant moved by one test, always one
  of the two-device or offline rigs -- two engines on one virtual clock, or a
  device that starts with work already queued, resolve their collision in an
  order this mutant lets decide the outcome. That is a property of the mutant,
  not of the suite: the pristine suite passed 508/508 in every run of the
  campaign. The floor is what both runs reproduced: for M07 the higher-id move
  aside and the multi-GiB move, for M10 both unpublished-note tests, and for
  M15 the offline same-path survival, the edit that raced the push, and the
  two-engine convergence.

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

- a save that lands on a version as it is written is not recorded as that version
- a save that lands on a settled copy as it is written is not recorded as that version

**M24** - the settled write records a fresh stat

- a save that lands on a settled copy as it is written is not recorded as that version

**M25** - the joined request is dropped, as before

- an edit made while a note is being pushed is not left behind

**M26** - the follow-up is remembered and never queued

- an edit made while a note is being pushed is not left behind

**M27** - the record is never saved

- the copy's record is stored, not only held in memory

**M28** - any held answer enters the rule, not only one about the destination

- EQUIVALENT, and kept as the proof of that. Routing every non-null answer into
  the rule instead of only an answer about the DESTINATION changes no outcome:
  a `local_edit` answer, at the destination or at the source, names a path this
  device tracks under this very file id, so the rule's first act is to hand it
  to `updateSettled`, which re-checks that same file with `competing` and keeps
  both. The branch is therefore a fast path, not a second guard, and the guard
  it looks like is M05, which dies. It is not removed because the mutant's own
  shape shows the cost: it needs a cast that asserts a type the value does not
  have, and it would make this decision depend on another function's re-check
  rather than on the answer in hand.

**M29** - the id the server answers with is ignored

- a post the server already holds is recorded under the id it answers with
- a publish under an adopted file id that dedupes is adoption, and renames nothing
- two engines that merge one note identically end on ONE version

**M30** - a post never offers the version the server already holds

- a post the server already holds is recorded under the id it answers with
- a publish under an adopted file id that dedupes is adoption, and renames nothing
- two engines that merge one note identically end on ONE version

**M31** - a rename offers itself for deduplication

- a rename is never deduplicated, so both devices still learn the new name

**M32** - the domain map offers itself for deduplication

- two different domain maps from one parent are two versions

**M33** - 121: drain() resolves immediately while draining (the 1.0.6 early return)

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

- a selected folder renamed keeps its notes on every device, and the selection follows it
- a selected folder moved into another folder keeps its notes on every device, and the selection follows it
- a selected folder renamed where no device may sync publishes nothing and says so once
- a rename above a selected folder moves the selection with it, persists it, and widens nothing
- a failed save of a followed selection stops the engine instead of syncing an unrecorded scope

**M41** - 91: a file leaving the selection is published as a deletion

- a rename whose target is hidden is not synced, and neither is the plugin's own state
- a selected folder renamed where no device may sync publishes nothing and says so once
- moving local content into a selected folder creates a new identity; moving it out publishes nothing

**M42** - 91: both sides of the move are judged by the selection after it

- a selected folder renamed keeps its notes on every device, and the selection follows it
- a selected folder moved into another folder keeps its notes on every device, and the selection follows it
- a rename above a selected folder moves the selection with it, persists it, and widens nothing

**M43** - 91: the followed selection is never persisted

- a failed save of a followed selection stops the engine instead of syncing an unrecorded scope

**M44** - 92: every scope change replays from zero, narrowing included

- scope contraction waits for active work, retains state and cursor, and saves locally
