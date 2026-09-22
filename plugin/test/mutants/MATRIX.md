# Mutation kill matrix - the 1.0.7 same-name tie-break

Every guard this branch adds, mutated against the whole plugin suite. Each
mutant is an exact unified diff beside this file with its subject on its first
line, and this record is the output of one command:

    sh plugin/test/mutants/matrix.sh

run over the sources this commit leaves in the tree, 484 tests, against the
pinned TypeScript 5.9.3. One mutant can be re-measured on its own:

    sh plugin/test/mutants/run.sh plugin/test/mutants/M12.diff

A surviving mutant is a finding, so each line below either has a non-zero count
and names the tests that produced it, or says why no test can produce one. The
runner applies with `-F0`: a patch whose context has moved fails loudly rather
than mutating something it was never written for.

| Mutant | Subject | Killed by |
| --- | --- | --- |
| M01 | the tie-break comparison reversed | 19/484 |
| M02 | the tie-break always keeps the name | 6/484 |
| M03 | the tie-break always renames | 14/484 |
| M04 | a name this device already settled is ignored | 5/484 |
| M05 | a settled occupant is written over unchecked | 3/484 |
| M06 | keep-and-record records no copy | 10/484 |
| M07 | the moved file's delete is left unmarked | 3/484 |
| M08 | the moved file's record is left clean | 4/484 |
| M09 | no free name reports the move as done | 1/484 |
| M10 | an unidentified file is never settled | 3/484 |
| M11 | the source of a move is never checked for a local edit | 1/484 |
| M12 | adoption takes any occupant of the length | 2/484 |
| M13 | identify believes any publish outcome | 1/484 |
| M14 | a failed publish reports success | 1/484 |
| M15 | one path pushed twice at once | 4/484 |
| M16 | the source is not re-stat-ed before the trash | 1/484 |
| M17 | the refusal is logged and the move reported as done | 1/484 |
| M18 | the move reads the whole file again | 2/484 |
| M19 | the copy window is the rest of the file | 1/484 |
| M20 | a copy that failed under a moving source is raised, not refused | 1/484 |
| M21 | the fake's create-only writer accepts a short copy | 1/484 |
| M22 | the digest proof is bound to a fresh stat | 2/484 |
| M23 | recordAt stats the file itself | 2/484 |
| M24 | the settled write records a fresh stat | 1/484 |
| M25 | the joined request is dropped, as before | 1/484 |
| M26 | the follow-up is remembered and never queued | 1/484 |
| M27 | the record is never saved | 1/484 |
| M28 | any held answer enters the rule, not only one about the destination | survives, see below |

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

- the holder of the higher id moves its own note aside and yields the path
- a note far larger than memory is moved aside a window at a time
- two devices that name one note twice converge, and stay converged
- NOT A DETERMINISTIC COUNT. "two devices that name one note twice converge,
  and stay converged" killed this mutant in one of two full runs at this head
  and not in the other; the other tests named here killed it in both, so the
  floor is one less than the count in the table. Two real engines on one
  virtual clock resolve a collision in an order this mutant lets decide the
  outcome, which is a property of the mutant rather than of the suite: the
  pristine suite passed 484/484 in every run, mutation campaign included.

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
- two devices that name one note twice converge, and stay converged
- NOT A DETERMINISTIC COUNT. "two devices that name one note twice converge,
  and stay converged" killed this mutant in one of two full runs at this head
  and not in the other; the other tests named here killed it in both, so the
  floor is one less than the count in the table. Two real engines on one
  virtual clock resolve a collision in an order this mutant lets decide the
  outcome, which is a property of the mutant rather than of the suite: the
  pristine suite passed 484/484 in every run, mutation campaign included.

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
- a note the queue is already pushing is not published a second time
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
