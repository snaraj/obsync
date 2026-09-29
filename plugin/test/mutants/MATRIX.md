# Mutation kill matrix - the 1.1.3 train

Every guard this range adds or carries, mutated against the whole plugin
suite. Each mutant is an exact unified diff beside this file with its subject
on its first line. Nothing below is typed by hand: the run produces the
numbers and `record.py` writes this file from them, so a table whose counts
have drifted from the suite is a table anyone can catch.
The [measurement provenance](MEASUREMENT.md) identifies the frozen test
tree and replacement measurements; this table does not claim that every
historical section ran against the final test tree.

    sh plugin/test/mutants/matrix.sh > matrix.log
    python3 plugin/test/mutants/record.py matrix.log plugin/test/mutants 1218

The last argument is the size of the clean suite -- 1218 tests here, which
`node --test` prints as `# tests` -- so every count below is out of the whole
suite. One mutant can be re-measured on its own:

    sh plugin/test/mutants/run.sh plugin/test/mutants/M12.diff

A surviving mutant is a finding, so each line below either has a non-zero
count and names the tests that produced it, or says why no test can produce
one. The runner applies with `-F0`: a patch whose context has moved fails
loudly rather than mutating something it was never written for. It also
applies with `-N`: a patch that reads as already applied is refused, never
applied backwards and counted as a kill of the opposite mutation (#280). A
patch that fails to apply is neither a kill nor a survival -- it is an unmeasured
guard, which is why every mutant whose context a repair moves is re-cut in
the same range as the repair.
Node reports deliberately hung tests as cancelled rather than assertion
failures. Those rejected tests remain named below, and their cancellation
count is shown separately in the table; they are not passing assertions.

| Mutant | Subject | Non-passing tests (including cancellations) |
| --- | --- | --- |
| M01 | the tie-break comparison reversed | 48/1218 |
| M02 | the tie-break always keeps the name | 24/1218 |
| M03 | the tie-break always renames | 25/1218 |
| M04 | a name this device already settled is ignored | 16/1218 |
| M05 | a settled occupant is written over unchecked | 5/1218 |
| M06 | keep-and-record records no copy | 19/1218 |
| M07 | the moved file's delete is left unmarked | 2/1218 |
| M08 | the moved file's record is left clean | 5/1218 |
| M09 | no free name reports the move as done | 1/1218 |
| M10 | an unidentified file is never settled | 3/1218 |
| M11 | the source of a move is never checked for a local edit | 5/1218 |
| M12 | adoption takes any occupant of the length | 2/1218 |
| M13 | identify believes any publish outcome | 1/1218 |
| M14 | a failed publish reports success | 1/1218 |
| M15 | one path pushed twice at once | 1/1218 |
| M16 | the source is not re-stat-ed before the trash | 1/1218 |
| M17 | the refusal is logged and the move reported as done | 1/1218 |
| M18 | the move reads the whole file again | 2/1218 |
| M19 | the copy window is the rest of the file | 1/1218 |
| M20 | a copy that failed under a moving source is raised, not refused | 1/1218 |
| M21 | the fake's create-only writer accepts a short copy | 1/1218 |
| M22 | the digest proof is bound to a fresh stat | 2/1218 |
| M23 | recordAt stats the file itself | 4/1218 |
| M24 | the settled write records a fresh stat | 3/1218 |
| M25 | the joined request is dropped, as before | 1/1218 |
| M26 | the follow-up is remembered and never queued | 1/1218 |
| M27 | the record is never saved | 2/1218 |
| M28 | any held answer enters the rule, not only one about the destination | 27/1218 |
| M29 | the id the server answers with is ignored | 9/1218 |
| M30 | a post never offers the version the server already holds | 12/1218 |
| M31 | a rename offers itself for deduplication | 1/1218 |
| M32 | the domain map offers itself for deduplication | 1/1218 |
| M33 | 121: drain() resolves immediately while draining (the 1.0.6 early return) | 4/1218 |
| M34 | 121: sync now never drains again for work queued behind it | 1/1218 |
| M35 | 121: sync now always reports that it joined a running drain | 1/1218 |
| M36 | 56: the in-flight byte ceiling admits anything | 1/1218 |
| M37 | 56: a chunk already in flight is uploaded a second time | 1/1218 |
| M38 | 56: the probe always answers that the body never landed | 1/1218 |
| M39 | 56: the 409 retry re-uploads every chunk again | 1/1218 |
| M40 | 91: a renamed folder does not take the selection with it | 4/1218 |
| M41 | 91: a file leaving the selection is published as a deletion | 4/1218 |
| M42 | 91: both sides of the move are judged by the selection after it | 5/1218 |
| M43 | 91: the followed selection is never persisted | 1/1218 |
| M44 | 92: every scope change replays from zero, narrowing included | 1/1218 |
| M45 | no hold is ever taken, so no move is ever completed | 20/1218 |
| M46 | the desktop writer answers with a fresh look at the name instead of the bytes it committed | 1/1218 |
| M47 | the local-copy bound is applied to the streaming host instead of the one that buffers | 1/1218 |
| M48 | a tombstone is posted without asking whether the file is still there | 5/1218 |
| M49 | a refused deletion is dropped instead of published as the change it is | 1/1218 |
| M50 | a move the filesystem refused is removed by its live name anyway | 1/1218 |
| M51 | a removal with no hold behind it is made anyway, with the window open | 3/1218 |
| M52 | a host that cannot bind a removal is asked to move anyway, and copies first | 3/1218 |
| M53 | what moved is not proved against what was copied | 4/1218 |
| M54 | the file is put back and deleted by the name an editor writes to | 12/1218 |
| M55 | the vacated name is written over instead of created | 1/1218 |
| M56 | a save made through an open descriptor after the move is not noticed | 4/1218 |
| M57 | a tombstone is applied without proving the file against its record | 5/1218 |
| M58 | a replayed tombstone is obeyed whatever this device's version descends from | 8/1218 |
| M59 | the tombstone's removal is not bound to the bytes it was told to remove | 9/1218 |
| M60 | the put-back looks at the destination and then replaces whatever took it | 2/1218 |
| M61 | the hold is released whether or not the restore landed | 1/1218 |
| M62 | the hold is unlinked on a stat, with no descriptor left to answer for it | 1/1218 |
| M63 | an upload that outlived its path records it anyway | 2/1218 |
| M64 | a folder rename moves the records and leaves the pending work behind | 1/1218 |
| M65 | the adopted version is proved by everything except the path | 3/1218 |
| M66 | the repost after a refused adoption offers the promise again | 5/1218 |
| M67 | the bulk-deletion floor is removed, so any pass can hold | 2/1218 |
| M68 | a count alone decides a bulk deletion, without the share | 1/1218 |
| M69 | the periodic scan may clear a hold the startup pass took | 7/1218 |
| M70 | the confirmation queues nothing, so a real deletion never publishes | 4/1218 |
| M71 | every remote rename falls back to write-then-trash | 10/1218 |
| M72 | the rename shortcut stops proving the source holds this content | 3/1218 |
| M73 | leaving a server keeps the folder records it minted | 1/1218 |
| M74 | the fake host renames a DIRECTORY component from a file's move | 1/1218 |
| M75 | a folder record stops re-casing the directory it names | 20/1218 |
| M76 | a note's move records a spelling the vault does not show | 4/1218 |
| M77 | a rename that changed no byte downloads the note again | 4/1218 |
| M78 | the folder re-case trusts the host's answer instead of the vault's listing | 1/1218 |
| M79 | a case-only folder rename publishes its folder record after the moves | 11/1218 |
| M80 | each half of a folder rename reads the selection for itself | 2/1218 |
| M81 | the case-only folder record is enqueued first and not held to | 8/1218 |
| M82 | a batch takes its paths without looking for a barrier | 8/1218 |
| M83 | a materialised file is recorded at the manifest's spelling | 2/1218 |
| M84 | a re-case carries the records and leaves their heads behind | 1/1218 |
| M85 | the scan's move pairing stops asking about a directory's case | 1/1218 |
| M86 | a folder rename this device DISCOVERS is declined as a stale record | 1/1218 |
| M87 | a pairing is declined on a host that keeps the two spellings apart | 1/1218 |
| M88 | an echo mark armed for an event that never comes is never expired | 5/1218 |
| M89 | a folder record is judged by the file rule, as it was | 7/1218 |
| M90 | an incoming folder record is judged by the file rule, as it was | 8/1218 |
| M91 | a received re-case leaves the selection at the old spelling | 1/1218 |
| M92 | a discovered folder re-case goes out in the two loops' order | 1/1218 |
| M93 | a folder is removed though the vault spells it another way | 1/1218 |
| M94 | a failed folder post is logged and dropped, as it was | 3/1218 |
| M95 | a retried folder record is put back without its barrier | 3/1218 |
| M96 | the fake's folder removal compares names without folding case | 1/1218 |
| M97 | the receiver admits a case-twin of a selected folder with no tombstone behind it | 7/1218 |
| M98 | a folder tombstone arms the retirement whatever record this device holds | 2/1218 |
| M99 | a folder tombstone retires every selected folder rather than the one it names | 1/1218 |
| M100 | the retirement is armed by a tombstone that is not this record's own | 1/1218 |
| M101 | the retirement is not spent by the folder record that takes it | 1/1218 |
| M102 | a record written for a folder leaves its retirement open | 1/1218 |
| M103 | the folder rule's case tolerance compares whole paths again | 2/1218 |
| M104 | a rename of a file onto its own path is taken as a rename | 1/1218 |
| M105 | a folder rename onto its own path still fans out into per-file moves | 1/1218 |
| M106 | a folder rename onto its own path still publishes a tombstone and a record | 1/1218 |
| M107 | the folder record's hold is not restored at the next start | 1/1218 |
| M108 | the reconcile pass queues the folder records it owes after the file work | 2/1218 |
| M109 | the fake reports a folder rename that landed where it started | 1/1218 |
| M110 | an outage is classified as a refusal, and a refusal as an outage | 16/1218 |
| M111 | a 507 the transport retried out is retried again | 1/1218 |
| M112 | the reconnect pause is never capped | 1/1218 |
| M113 | the reconnect pause never grows | 2/1218 |
| M114 | teardown leaves the reconnect armed | 1/1218 |
| M115 | the network coming back is not listened for | 1/1218 |
| M116 | a start leaves the pending reconnect timer armed | 1/1218 |
| M117 | a resume leaves the status bar saying offline | 1/1218 |
| M118 | leaving the server leaves the reconnect armed | 1/1218 |
| M119 | a folder-selection change carries the old reconnect cycle on | 1/1218 |
| M120 | a start that succeeded does not close the reconnect cycle | 1/1218 |
| M121 | online starts an engine whether or not a retry is pending | 7/1218 |
| M122 | the identical-name check never matches | 16/1218 |
| M123 | a record naming no version is settled anyway | 1/1218 |
| M124 | identical names are settled without comparing chunk digests | 54/1218 |
| M125 | a note whose mtime moved is taken for its recorded version | 1/1218 |
| M126 | a note whose size moved is taken for its recorded version | 1/1218 |
| M127 | the identical pair keeps the HIGHER id | 13/1218 |
| M128 | the yielding device does not record the lower id | 3/1218 |
| M129 | the yielding device does not retire its own id | 6/1218 |
| M130 | a push never rereads the record before posting | 1/1218 |
| M131 | a record of other bytes found before posting is taken for the push | 2/1218 |
| M132 | a record that appears during the post is never settled | 3/1218 |
| M133 | a record of other bytes that appears during the post is settled as a duplicate | 4/1218 |
| M134 | the post-window pair keeps the HIGHER id | 3/1218 |
| M135 | the post-window keeper does not retire the posted duplicate | 1/1218 |
| M136 | the post-window yield does not record the lower id | 2/1218 |
| M137 | the post-window yield does not retire the adopted id | 2/1218 |
| M138 | a tombstone that cannot be posted is raised | 1/1218 |
| M139 | the transport never says whether the server answered | 1/1218 |
| M140 | the transport calls every attempt answered | 1/1218 |
| M141 | an unanswered attempt is not shown | 2/1218 |
| M142 | an unanswered attempt covers an error | 2/1218 |
| M143 | an unpaired device is shown offline | 1/1218 |
| M144 | an answer clears any offline, the reconnect cycle's included | 1/1218 |
| M145 | an answer puts back idle, not what it covered | 1/1218 |
| M146 | a transport from an earlier session is heard | 1/1218 |
| M147 | a server that is not there is reported as a repair failure | 1/1218 |
| M148 | onload waits for the first start, holding Obsidian's loading screen until the server answers | 2/1218 (1 cancelled) |
| M149 | the first start reconciles before Obsidian has listed the vault | 2/1218 |
| M150 | a resolution that wrote nothing forgets the note it found, so a run of resolutions after an edit never trips the breaker | 1/1218 |
| M151 | a merge's own write is read as the user's edit, so a loop of merges that each rewrite the note never trips the breaker | 1/1218 |
| M152 | two different merges of one pair are never merged again, so every later version of the note becomes a conflict copy | 7/1218 |
| M153 | the criss-cross base is built from an ancestor the first one already holds, so the false overlap stays and copies return | 56/1218 (1 cancelled) |
| M154 | a criss-cross ancestor above one chunk is assembled whole, so another device's version graph decides this device's memory | 1/1218 |
| M155 | a version arriving while someone types here is kept as a conflict copy again, one copy per version the other device sends | 28/1218 |
| M156 | a version arriving over an unpushed edit is merged and published here as well, so one edit lands on two lines and later merges overlap | 12/1218 |
| M157 | an edit undone before its push leaves the other device's version unapplied here for good | 5/1218 |
| M158 | a merge is written over a save the user made while it downloaded, and the editor reloads the loss | 2/1218 |
| M159 | a version is written over a save the user made while it downloaded, and the editor reloads the loss | 3/1218 |
| M160 | a save made while a version downloaded is answered with a conflict copy instead of a merge | 1/1218 |
| M161 | a version that already holds the edit typed here is recorded under the older of two ids, so the next push forks the note | 1/1218 |
| M162 | the merge breaker counts every resolution again, so two people typing in one note trip it within seconds and the note splits | 1/1218 |
| M163 | the higher version id keeps the note, so a fork settles against the rule every other device applies | 7/1218 |
| M164 | a head a later version replaced is settled anyway, closing a fork that is not there and keeping stale text | 1/1218 |
| M165 | each device publishes its own first version of the shared copy, so the copy is published twice | 1/1218 |
| M166 | two settlements of one fork on the losing device both move the note, making a second copy | 1/1218 |
| M167 | a save landing while the losing note is copied is written over by the kept version | 1/1218 |
| M168 | the status reads idle while a note waits on this device's own push to settle a fork | 4/1218 |
| M169 | a note stays counted as waiting after its fork is settled, and the status reads syncing with nothing left to settle | 1/1218 |
| M170 | an address copied from a browser keeps its path and query | 1/1218 |
| M171 | a desktop accepts any plain HTTP address again | 2/1218 |
| M172 | the one-computer trial on localhost is refused | 2/1218 |
| M173 | a look-alike of loopback passes as loopback | 1/1218 |
| M174 | a phone accepts loopback plain HTTP it cannot reach | 1/1218 |
| M175 | every keystroke of the server address is adopted again | 1/1218 |
| M176 | closing Settings loses a server address typed but not left | 1/1218 |
| M177 | Check before setup asks the signed read, which only says not paired | 1/1218 |
| M178 | Check with no address sends a request to nowhere | 1/1218 |
| M179 | a refused connection still says obsync cannot know whether it happened | 2/1218 |
| M180 | a refusal after an earlier unanswered attempt claims nothing was sent | 1/1218 |
| M181 | a timed-out connection is reported as nothing sent | 1/1218 |
| M182 | a note deleted on another device disappears for good, whatever "Deleted files" says | 7/1218 |
| M183 | a note deleted on another device reaches the bin under a hidden placeholder name, not its own | 7/1218 |
| M184 | with the system Trash unavailable, a note deleted on another device is removed for good instead of going to .trash | 2/1218 |
| M185 | a system Trash that errors stops sync with an error instead of sending the note to .trash | 1/1218 |
| M186 | a vault whose "Deleted files" was never changed loses notes deleted elsewhere for good | 2/1218 |
| M187 | on an Obsidian without the preference lookup, every deletion from another device fails | 1/1218 |
| M188 | the removal's hidden folder can be swapped for a link and the vault's deletion follows it out of the vault | 1/1218 |
| M189 | every deletion from another device leaves an empty hidden folder behind in the note's folder | 14/1218 |
| M190 | a removal the filesystem refuses leaves an empty hidden folder behind | 1/1218 |
| M191 | a save that stopped a removal leaves an empty hidden folder behind once the note is put back | 3/1218 |
| M192 | the log no longer says which bin a note deleted on another device went to | 7/1218 |
| M193 | with "Deleted files" set to the vault's .trash, a note deleted elsewhere goes to the system Trash instead | 2/1218 |
| M194 | with "Deleted files" set to delete permanently, a note deleted elsewhere still goes to the system Trash | 3/1218 |
| M195 | a hidden folder left behind after a removal is left without a word in the log | 1/1218 |
| M196 | leaving the server address field adopts nothing | 4/1218 |
| M197 | a field nobody typed into is adopted and saved again | 1/1218 |
| M200 | a folder renamed in Finder with Obsidian open is deleted on the other devices and comes back under new ids: the delete no longer waits for its create | 12/1218 |
| M201 | a note moved in Finder inside the selection loses its history: it is tombstoned and republished under a new file id | 7/1218 |
| M202 | notes moved out of the folder selection in Finder are deleted on every other device | 8/1218 |
| M203 | a stray delete for a note that is still there hands its identity to an mtime-keeping copy elsewhere | 1/1218 |
| M204 | two same-size, same-mtime notes moved inside the selection stay on the other devices under their old names too: duplicates | 1/1218 |
| M205 | a note leaving the selection makes the engine ask the host about a path outside the selection, breaking the scope contract both layers keep | 6/1218 |
| M206 | a folder moved out of the selection in Finder is published as deleted, so the other devices forget its folder records | 4/1218 |
| M207 | when the vault index cannot be read, every waiting deletion is published anyway, moved notes included | 1/1218 |
| M208 | an empty folder deleted in Obsidian is never removed from the other devices | 2/1218 |
| M209 | a folder moved out of the selection in Finder is published as deleted before its notes are found alive | 10/1218 |
| M210 | deleting a note whose edit is still waiting to upload shows an error in the status bar | 1/1218 |
| M211 | Confirm deletions deletes notes that are back in the vault under a new name | 1/1218 |
| M212 | a folder renamed out of the selection while Obsidian was closed is deleted on the other devices (small) or held for a Confirm that would delete it (big) | 3/1218 |
| M213 | Settings keeps offering to delete notes that are back in the vault under another name | 1/1218 |
| M214 | a selected folder renamed while Obsidian was closed is published as deleted, so the other devices forget its folder record | 2/1218 |
| M215 | moving a folder out of the selection raises one notice per note instead of one naming the count | 7/1218 |
| M216 | a folder moved out of the selection in Finder is published as deleted: the watcher no longer holds it with its notes | 10/1218 |
| M217 | with hidden paths in the index, a note deleted into Obsidian's .trash counts as moved there and its deletion never reaches the other devices | 2/1218 |
| M218 | a moved note can take over the identity of another note that is already synced | 3/1218 |
| M219 | one Finder move is decided several times over, one decision line per deleted note | 4/1218 |
| M220 | a locked note, a read-only folder, a full disk or a missing chunk stops every later change from arriving again | 13/1218 |
| M221 | a large file whose chunks the server lost stalls the whole feed again, fetched in batches | 1/1218 |
| M222 | a parked file with a damaged reason is named as "Cannot write X here: undefined" | 1/1218 |
| M223 | a data file can point a parked retry at any server route instead of a file id | 1/1218 |
| M224 | a data file can name a parked file outside the vault, and the status bar shows it | 1/1218 |
| M225 | an unreachable server parks every record it could not fetch instead of waiting for the network | 3/1218 |
| M226 | a parked attachment deleted on another device stays named in the status bar until the next slow retry | 1/1218 |
| M227 | every change the feed applies asks the server about its file again and logs a bogus release | 5/1218 |
| M228 | every retry of a parked file raises another notice | 2/1218 |
| M229 | a push turns the status bar back to idle while a file is still parked (the S74 flicker) | 6/1218 |
| M230 | the status bar reads idle right after the feed parks a file | 9/1218 |
| M231 | a full disk re-downloads the parked file every minute, forever | 2/1218 |
| M232 | the wait between retries grows without bound, so a fixed file can wait for hours | 1/1218 |
| M233 | every park arms another timer, so several parked files are downloaded many times over | 1/1218 |
| M234 | a file parked again later waits as long as the last episode's backoff had grown, not one minute | 1/1218 |
| M235 | a retry pass writes files while the feed is still writing its own, side by side | 2/1218 |
| M236 | after one network failure the feed never applies another change | 1/1218 |
| M237 | with the server out of reach, a retry pass knocks once for every parked file instead of stopping | 1/1218 |
| M238 | one parked file the server refuses stops every other parked file from being retried, and Sync now fails | 1/1218 |
| M239 | every start and every Sync now writes a retry summary and a state save with nothing parked | 1/1218 |
| M240 | a device syncing selected folders measures the bulk-deletion share against every record it kept, so 12 of 20 selected notes gone is deleted everywhere | 1/1218 |
| M241 | a Sync now after some held notes come back re-derives the hold and publishes the rest without the user's word | 1/1218 |
| M242 | a Sync now that lets go of held notes that came back logs nothing about them | 1/1218 |
| M243 | Sync now with deletions held back says nothing about them | 2/1218 |
| M244 | a Sync now that finds a bulk deletion shows two notices about the one hold it just took | 1/1218 |
| M245 | a deletion whose first send was lost is re-sent without asking whether the note is back, deleting a restored note everywhere | 5/1218 |
| M246 | a lost deletion is re-sent after another device's rename was pulled in, deleting the renamed note and forking it on the server | 3/1218 |
| M247 | a lost deletion decided from an older version is re-sent after the note moved on and was deleted again, forking the file on the server | 2/1218 |
| M248 | a lost deletion is re-sent although the note is back on the disk | 1/1218 |
| M249 | the deleting device says a note is back when it is not on this device | 1/1218 |
| M250 | the device that deleted a note says nothing when another device's change brings it back | 2/1218 |
| M251 | a withdrawn deletion surfaces as a sync error instead of the note simply staying | 4/1218 |
| M252 | a deferred settlement of a published edit says it was not uploaded | 1/1218 |
| M253 | a device whose unpublished changes were kept says they are already on the server, which is false | 1/1218 |
| M254 | a deletion whose first send was lost is never sent again, even though the note is still gone | 1/1218 |
| M260 | a record sealed under another vault key stops the feed again: every later change waits behind it under 'offline' | 2/1218 |
| M261 | one notice per unreadable file instead of one per device: a key change on one computer floods the others with notices | 1/1218 |
| M262 | the unreadable-changes notice no longer says which device to fix | 1/1218 |
| M263 | Restore accepts another vault's phrase and refuses this vault's own | 2/1218 |
| M264 | a server with no vault yet counts as one: any phrase restored there is refused | 2/1218 |
| M265 | a device with no credential cannot restore its phrase before setup: the check asks a server it cannot sign for | 6/1218 (2 cancelled) |
| M266 | Restore with another vault's phrase replaces the key again, and a second domain map strands every other device | 1/1218 |
| M267 | Create a new vault key replaces the key at once on a server that holds a vault, with no question | 3/1218 |
| M268 | Cancel is no longer the default in a confirmation: Enter may take the destructive answer | 3/1218 |
| M269 | closing a confirmation with Cancel or Escape answers nothing, and pairing hangs for ever | 3/1218 (2 cancelled) |
| M270 | a second vault's notes are uploaded into the server's vault without a question (the count is ignored) | 2/1218 |
| M271 | a byte-identical copy of the vault is asked before pairing, as if it were another vault | 6/1218 |
| M272 | cancelling a second vault's pairing leaves an enrolled device with no key behind on the server | 1/1218 |
| M273 | Pair this device, or a pairing link, silently replaces the identity of a device that syncs | 1/1218 |
| M274 | a device whose key never arrived cannot pair again either: the guard refuses every enrolled device | 1/1218 |
| M275 | a note with the same name and size but other bytes counts as already in the vault, so a second vault can pair unasked | 1/1218 |
| M276 | a copy of the vault holding a file above the chunk ceiling is asked before pairing, as if it were another vault | 1/1218 |
| M277 | a device revoked elsewhere cannot leave, so it can never pair again | 1/1218 |
| M278 | a device the server no longer knows cannot leave, so it can never pair again | 1/1218 |
| M279 | First-time setup on a server that holds a vault shows the raw server code instead of 'one server holds one vault' | 1/1218 |
| M280 | every note another device sends to a FAT32 or exFAT vault is refused again (temp_identity), and its temp is left | 1/1218 |
| M281 | a download that stops on a FAT32 or exFAT vault leaves its temp file behind | 1/1218 |
| M282 | the writer proves its temp by the name instead of the descriptor, so a temp another process swapped is renamed into the note | 1/1218 |
| M283 | a conflict copy or restored copy on a volume that renumbers files is refused at its second write | 1/1218 |
| M284 | a conflict copy or restored copy that stops on a volume that renumbers files leaves its temp behind | 1/1218 |
| M285 | a download's temp gets a visible name again, so a quit mid-download publishes the half-file to every device | 2/1218 |
| M286 | a start while a download is under way deletes that download's temp, and the download fails | 1/1218 |
| M287 | the start-up clean-up deletes temps that downloads in progress still hold | 1/1218 |
| M288 | temps left by a quit are never removed | 1/1218 |
| M289 | temps a quit left in any folder below the vault root are never removed | 1/1218 |
| M290 | the start-up clean-up removes a link that wears a temp's name | 1/1218 |
| M291 | a restored copy's temp left by a quit is never removed | 1/1218 |
| M292 | the start-up clean-up deletes a hold, which may be the last name of a save | 1/1218 |
| M293 | every start logs a clean-up line even when there was nothing to clean | 1/1218 |
| M294 | no start removes the temps a quit left | 1/1218 |
| M295 | a start whose clean-up meets a file it cannot stat never syncs | 1/1218 |
| M296 | a second save of the same size inside a coarse mtime step is never sent | 1/1218 |
| M297 | every quick push on any filesystem reads the file a second time | 1/1218 |
| M298 | a whole-second file pushed long after its save is read again and again | 22/1218 |
| M299 | a file stamped with a whole second in the future schedules a re-read a day away | 1/1218 |
| M300 | a pull's own move on desktop is decided as a deletion of the note it moved, logged as removed | 2/1218 |
| M301 | a note typed where a pulled rename left, then deleted, is never deleted on the other devices | 1/1218 |
| M302 | Enter in a confirmation dialog revokes the device or replaces the vault key, because the action is the first button Obsidian focuses | 3/1218 |
| M303 | the note a withdrawn deletion left at its own name is announced as back "as" that same name | 1/1218 |
| M304 | a device that left the server locally logs it as a refusal | 2/1218 |
| M305 | merges of two merges of one pair are never merged again, so two people typing on different lines of one note get a conflict copy | 2/1218 |
| M306 | a criss-cross is followed one level deeper than the bound, so another device's version graph decides how much this device downloads and holds | 1/1218 |
| M307 | a ceiling is kept per keystroke, so a typo like "1 MX" leaves a one-byte ceiling that makes every new note remote-only | 1/1218 |
| M308 | a kept ceiling is not saved, so a restart reads "unlimited" again | 1/1218 |
| M309 | a chunk the server lost is announced as something this device cannot write | 1/1218 |
| M310 | a note open and being typed in is deleted from under the cursor when another device deletes it | 8/1218 |
| M311 | typing still only in the editor is lost when the note's last save was not published in the last few seconds | 2/1218 |
| M312 | a note being typed in is deleted from under the cursor in the pause just after a save | 4/1218 |
| M313 | a note merely open on this device, never edited here, can no longer be deleted from another device | 2/1218 |
| M314 | a note open on this device and edited once can no longer be deleted from another device for the rest of the session | 2/1218 |
| M315 | keeping an open note republishes this device's older text over the other device's newer edit | 1/1218 |
| M316 | a note that is not open anywhere is kept, not deleted, when this device edited it seconds ago | 7/1218 |
| M317 | the log no longer says how old the last edit of an open note was, or the window, when its deletion applies | 2/1218 |
| M319 | a note being typed in is deleted from under the cursor in the pause just after a save (the save is never remembered) | 5/1218 |
| M320 | the plugin's memory of recent saves grows with every note it publishes, for the life of the plugin | 1/1218 |
| M321 | a note saved all day at the front of the memory stops every older save behind it from being forgotten | 1/1218 |
| M322 | a note whose tab Obsidian has not loaded yet counts as an open editor, so its deletion fails or is refused | 1/1218 |
| M323 | any note open in any editor keeps every other note from being deleted by another device | 2/1218 |
| M324 | a note with Windows line endings open on this device can never be deleted from another device | 1/1218 |
| M325 | typing in one of two panes open on the same note is lost when another device deletes it | 1/1218 |
| M330 | a note that landed beside its name never moves when the version that frees the name arrives, so a swap stays split | 9/1218 |
| M331 | a note waiting beside its name never takes it when this device's own user frees it | 2/1218 |
| M332 | a swap leaves both notes waiting at each other's name, so the two devices show them under opposite names for good | 7/1218 |
| M333 | a note that owns its name is moved to a conflict name whenever another note waits for it | 5/1218 |
| M334 | a swap that also edits a note moves it before the vault reports the write, and the phone publishes one note's record over the other's text | 2/1218 |
| M335 | a note the user is typing into is moved to another name under them | 2/1218 |
| M336 | a note the user is typing into is moved to a conflict name when another note wants its place | 1/1218 |
| M337 | a swap stays split whenever a conflict copy from this device already has the first parking name | 1/1218 |
| M338 | one rename the disk refuses stops the device receiving any change | 1/1218 |
| M339 | a note that has taken its name still counts as waiting, so it can be moved off it again | 11/1218 |
| M340 | a device that only applied a swap publishes its own moves back as renames | 7/1218 |
| M341 | a note renamed onto a name the other device just made offline keeps two names for good | 1/1218 |
| M342 | a swap moves the note it waits on to a conflict name and publishes that, instead of waiting for it to leave | 4/1218 |
| M343 | a rename onto a just-made name moves the wrong note aside, so the two devices name both notes differently | 1/1218 |
| M344 | a note landed beside its name forgets the name, so it stays at the old one for good | 9/1218 |
| M345 | a conflict copy never takes its name when the note holding it goes, and the repair pass reports it as a mismatch | 5/1218 |
| M346 | an edit to a note waiting beside its name is never written, and the old text stays under the new version | 7/1218 |
| M347 | after a rename onto a just-made name, one note is published under the other's file id and its text replaces the other's on the other device | 2/1218 |
| M348 | a note beside its name puts "Server repair could not verify a retained file ... check connectivity" on the status bar | 1/1218 |
| M349 | an edited data file can name a path outside the vault as the name a note is moved to | 1/1218 |
| M350 | a folder the vault does not have is saved without a question, and nothing syncs | 2/1218 |
| M351 | `notes` typed for the real `Notes` is saved as typed, and a Mac republishes the folder with older text | 1/1218 |
| M352 | a FILE's name typed as a folder is saved without a question, and nothing syncs | 1/1218 |
| M353 | a folder the vault holds, accented and made in Finder, is asked about as if it were missing | 1/1218 |
| M354 | an empty selection is saved with a bare "saved" and nothing says that nothing syncs | 1/1218 |
| M355 | a hidden folder is refused with the jargon "refused: not a vault path (hidden_segment)" | 1/1218 |
| M356 | a refused selection leaves no refusal code in the log, so nobody can tell which rule refused it | 1/1218 |
| M357 | `notes` is quietly saved as `Notes` and the person is never told | 1/1218 |
| M358 | Cancel on "not a folder in this vault" saves the folder anyway | 2/1218 |
| M359 | `1 MB` in a download ceiling is dropped without a word and reads "unlimited" after a restart | 2/1218 |
| M360 | `1 MB` is kept as 1 MiB, so a ceiling holds 48,576 bytes more than was typed | 2/1218 |
| M361 | an unreadable ceiling such as `1 MX` is dropped without a word | 2/1218 |
| M362 | a refused ceiling stays on screen as if it were kept | 1/1218 |
| M363 | the desktop scan walks a selection typed `notes` into the real `Notes` and republishes its notes with older text | 1/1218 |
| M364 | a device that syncs no folders reads a bare `obsync: idle` | 1/1218 |
| M365 | the status bar keeps saying `idle` after an empty selection is saved, until something else redraws it | 1/1218 |
| M366 | a folder Save shows "Waiting for transfers..." for up to 55 s with nothing transferring | 23/1218 (22 cancelled) |
| M367 | a long poll answered after a stop saves the state, over what a reloaded plugin already holds | 1/1218 |
| M368 | an engine started again runs its stopped feed beside the new one, two polls on one cursor | 1/1218 |
| M369 | a folder Save no longer waits for the change being downloaded, and the new selection races it | 1/1218 |
| M370 | a journal restored behind this device's cursor is read as a live one | 1/1218 |
| M371 | another version where this device's last entry was is not noticed: the restored server's new notes are skipped | 4/1218 |
| M372 | a version where this device read none after its last entry is not noticed | 1/1218 |
| M373 | an old entry retention pruned is taken for a proved restore | 1/1218 |
| M374 | a device started after the restore never asks: it skips what was written there and never re-sends | 4/1218 |
| M375 | a device that reconnects after the restore never asks again | 3/1218 |
| M376 | the rebuilt journal's replay re-applies yesterday: deleted notes come back | 2/1218 |
| M377 | a version the server still holds is re-sent as lost, forking a note on every device | 1/1218 |
| M378 | a note kept behind a move out of the selection is re-sent over its newer history | 1/1218 |
| M379 | a record from before 1.1.3, whose place is unknown, is re-sent over newer history | 1/1218 |
| M380 | a note retention buried long ago is resurrected on a mere suspicion | 4/1218 |
| M381 | a lost version is re-sent with no parents beside another device's re-send | 1/1218 |
| M382 | a re-send names the lost version as its parent and forks every note it re-sends | 4/1218 |
| M383 | two devices re-sending one lost version publish two, and the note forks | 1/1218 |
| M384 | the journal is not re-read after a restore: notes written on the restored server never arrive | 3/1218 |
| M385 | a version the restored server lost is the old read_or_write_failed repair error again | 2/1218 |
| M386 | a deletion this device applied is not remembered, and comes back after a restore | 2/1218 |
| M387 | a deletion this device made is not remembered, and comes back after a restore | 2/1218 |
| M388 | this device's own changes never learn their server time and are never re-sent | 3/1218 |
| M389 | a record keeps a version the server lost over the identical head it holds | 2/1218 |
| M390 | an edit of a twin the other device never retired is copied beside the note again, and the split never heals | 3/1218 |
| M391 | an edit whose parent sat at another name is taken for this note, and this note's id is retired | 1/1218 |
| M392 | an edit of a DIFFERENT note, or one arriving over an unpushed edit, replaces the note here | 1/1218 |
| M393 | an edit whose parent this vault cannot read is refused outright instead of kept beside the note | 1/1218 |
| M394 | the note takes the twin's edit but stays recorded under the id this device retires | 3/1218 |
| M395 | the healed pair leaves this device's duplicate id live on the server | 3/1218 |
| M396 | the twin's edit is recorded here without being written, so the note keeps the old text | 3/1218 |
| M397 | the retirement names a version this device never held, so it no longer forks where the id moved on | 3/1218 |
| M410 | the breaker, tripped, still merges: a loop that merges is never stopped | 1/1218 |
| M411 | a note left for this device's own push is not counted as waiting, so the status reads idle over two different notes | 4/1218 |
| M412 | text typed on top of the losing head is recorded as already published, and never reaches the other device's copy | 1/1218 |
| M413 | an unmergeable version over an unpushed edit is copied at once, so one fork costs two copies | 5/1218 |
| M414 | the losing device's own note is written into a copy sized for the losing version, and refused | 1/1218 |
| M415 | an edit arriving for a note deleted here is refused as if the deletion were a save, and the deletion then forks the note | 4/1218 |
| M416 | a note whose push never comes keeps the status reading syncing for good | 5/1218 |
| M417 | a note waiting on its push hides a parked file the user has to act on | 2/1218 |
| M418 | a note whose push is still in its debounce is dropped from the count, and the status reads idle over two different notes | 2/1218 |
| M419 | a note counted while only its echo was settling keeps the status reading syncing for good | 2/1218 |
| M420 | a folder inside a synced vault pairs with the same server anyway | 1/1218 |
| M421 | first-time setup inside a synced vault spends the setup token and enrols the device | 1/1218 |
| M422 | a vault inside a synced vault that was paired before the check starts syncing | 1/1218 |
| M423 | a synced vault two folders above this one goes unnoticed, and the inner vault pairs | 1/1218 |
| M424 | any Obsidian vault above, with any plugin at all, counts as a synced vault and refuses pairing | 1/1218 |
| M425 | every note of the nested vault is read and its bytes uploaded before the post is refused | 2/1218 |
| M426 | a rename, a deletion or a folder removal inside the nested vault is published to every device | 1/1218 |
| M427 | another device's new note is written into the nested vault, which publishes it one level deeper | 2/1218 |
| M428 | another device's move carries a note out of the nested vault on this computer | 1/1218 |
| M429 | every note skipped for the nested vault raises its own 'refused a change' notice | 3/1218 |
| M430 | every periodic scan lists the nested vault's notes and asks about each one again | 1/1218 |
| M431 | the nested vault is announced again with every note that meets it | 3/1218 |
| M432 | on a computer, a nested vault directly under the vault root is synced both ways | 2/1218 |
| M433 | on a phone, the nested vault is synced both ways | 1/1218 |
| M434 | a file that merely wears the plugin folder's name makes a vault count as synced | 1/1218 |
| M435 | a vault inside a synced vault raises its refusal notice again at every start | 1/1218 |
| M436 | a path through a symlinked folder is skipped silently instead of refused with a notice | 6/1218 |
| M437 | on a phone, the nested folder's own record is still published and applied | 1/1218 |
| M438 | a refusal to pair, set up or start inside a synced vault leaves no line in the log | 3/1218 |
| M440 | a plugin object turned off mid-upload saves its older cursor and records over the session that replaced it | 3/1218 |
| M441 | a new session reads the data file while the old one's write is still landing, and starts from older records | 1/1218 |
| M442 | a new session cannot see the old session's write in flight, and reads under it | 1/1218 |
| M443 | a replaced session finishing a leave rewrites the native secret its successor holds | 1/1218 |
| M444 | turning the plugin off and on gives each object its own lease, and the old one's late save rolls the new one back | 4/1218 |
| M445 | a session superseded while still loaded shows a storage error and a notice for nothing the user can fix | 1/1218 |
| M446 | a superseded session's drain logs a teardown save failure that did not happen | 1/1218 |
| M447 | a superseded session stops without a word in the log | 2/1218 |
| M448 | a synced file whose record was lost is published again under a new file id | 1/1218 |
| M449 | bytes typed here are recorded as another device's version of the same size and time, and never uploaded | 1/1218 |
| M450 | one file id is recorded at two names, and deleting either deletes both everywhere | 1/1218 |
| M451 | every Sync now reads the whole feed since the cursor again | 1/1218 |
| M452 | every start reads the feed even when every name is recorded | 4/1218 (2 cancelled) |
| M453 | a feed read failing at startup stops sync instead of uploading new files | 1/1218 |
| M454 | a retirement no longer names its keeper, and a device with rolled-back records deletes the kept file | 1/1218 |
| M455 | a retirement over a file its keeper holds deletes it, as S98 deleted a 1 GiB file | 1/1218 |
| M456 | a retirement is withheld because an OLD version of the keeper matched, after the keeper moved on | 1/1218 |
| M457 | a keeper this device records elsewhere is recorded at a second name too | 1/1218 |
| M458 | a retirement naming a keeper the server does not know stops the feed for good | 1/1218 |
| M459 | a keeper that is not a file id is put into a request path | 1/1218 |
| M460 | a folder this device deleted is not remembered, and comes back after a restore | 2/1218 |
| M461 | a folder deletion this device applied is not remembered, and comes back after a restore | 1/1218 |
| M462 | a version where this device read none, with its last entry gone, costs a second read to notice | 1/1218 |
| M463 | the mark's version held at another seq is taken for a journal that agrees | 1/1218 |
| M464 | a replay already under way is probed against the old journal and started again | 1/1218 |
| M465 | an entry in the mark's own millisecond, after it, is skipped by the replay | 1/1218 |
| M466 | the graves grow without bound | 1/1218 |
| M467 | an entry the feed parked does not move the mark: every start reads the journal as rebuilt | 1/1218 |
| M468 | a restore's check runs beside a parked record's retry | 1/1218 |
| M469 | a page read while a restore was pending is applied before the restore is answered | 1/1218 |
| M470 | the ceiling row goes on naming the ceiling it had before the one just kept | 1/1218 |
| M480 | a note two devices' plugins keep rewriting bounces on for as long as both run, a copy and a notice every round | 10/1218 |
| M481 | a note someone is typing in, on a line another device also changed, is paused as if a plugin had rewritten it | 3/1218 |
| M482 | an edit made before another device's version arrived counts as an answer to it, and the note pauses | 4/1218 |
| M483 | an edit made exactly five seconds after a sync still counts as an answer, and the note pauses | 1/1218 |
| M484 | an editor-typed note pauses after its editor closes because its saved verdict is ignored | 9/1218 |
| M485 | a pulled version with a remote timestamp is mistaken for a local background edit | 1/1218 |
| M486 | a paused note keeps taking the other device's versions, and its plugin keeps answering them | 5/1218 |
| M487 | a paused note keeps publishing its local rewrites | 11/1218 |
| M488 | a rewrite right after a sync that keeps the note's size and modified time is never sent, and two devices say idle over two notes | 1/1218 |
| M489 | every event on a note whose record already describes it is read and sent again, however long after the last sync | 2/1218 |
| M490 | the status bar reads idle over a note that is paused and no longer syncing | 7/1218 |
| M491 | a restart forgets held notes and restarts their bounce | 10/1218 |
| M492 | after a restart the status bar reads idle over a note that is still paused | 1/1218 |
| M493 | leaving a server keeps notes paused that name that server's files | 1/1218 |
| M494 | a failed Resume drops the hold | 4/1218 |
| M495 | Sync now leaves every held note paused | 9/1218 |
| M496 | resuming pushes what this device held over the note, forking it again, instead of keeping it beside | 38/1218 |
| M497 | a note the plugin rewrote while paused is taken for unchanged at resume, and what this device held is pushed over the note | 41/1218 |
| M498 | the stopped-merging notice sends you to update devices that are already up to date | 1/1218 |
| M499 | the verdict kept on every note edited here is never dropped, and grows for as long as the plugin runs | 1/1218 |
| M500 | historical twin retirement ignores current server heads | 2/1218 |
| M501 | storage refusal is hidden as an offline repair | 1/1218 |
| M502 | keeper metadata is not persisted before retirement | 4/1218 |
| M503 | twin adoption ignores an edit during current-head lookup | 3/1218 |
| M504 | twin adoption ignores a replacement record during lookup | 3/1218 |
| M505 | twin adoption ignores a concurrent server fork | 1/1218 |
| M510 | claimant name length is not bounded | 1/1218 |
| M511 | claimant name permits controls and bidi formatting | 1/1218 |
| M512 | claimant count accepts non-integral numbers | 1/1218 |
| M513 | claimant count accepts negative numbers | 1/1218 |
| M514 | claimant sealing omits plaintext validation | 1/1218 |
| M515 | claimant decoding trusts authenticated malformed metadata | 1/1218 |
| M516 | claimant envelope size is unbounded | 1/1218 |
| M517 | claimant nonce format is not validated | 1/1218 |
| M518 | claimant vault sealing omits pairing additional data | 21/1218 |
| M519 | claimant vault key reuses vault-key envelope label | 2/1218 |
| M520 | creator ignores sealed claimant vault details | 3/1218 |
| M521 | closed creator modal recreates decrypted approval controls | 1/1218 |
| M522 | claim does not send sealed vault details | 17/1218 |
| M523 | missing vault details are not backward compatible | 1/1218 |
| M524 | claim reports no notes | 17/1218 |
| M525 | claim reports a generic vault name | 17/1218 |
| M526 | creator does not show claimant note count | 1/1218 |
| M530 | Sync now misses a silent rewrite with unchanged metadata | 3/1218 |
| M531 | the local hold never reaches the other device, including on retry | 6/1218 |
| M532 | a peer ignores the encrypted hold and keeps publishing | 24/1218 |
| M533 | a replayed historical pause holds a note after Resume | 1/1218 |
| M534 | a clear control pauses the note again | 2/1218 |
| M535 | replaying one current hold floods the device with repeated notices | 4/1218 |
| M536 | an arbitrary encrypted record can masquerade as another note hold | 1/1218 |
| M537 | an unknown control kind pauses a note | 1/1218 |
| M538 | a malformed target id is accepted | 1/1218 |
| M539 | a non-boolean control is accepted | 1/1218 |
| M540 | a control masquerades as a deletion | 1/1218 |
| M541 | a control carrying content bypasses the empty-record schema | 1/1218 |
| M542 | an invalid background-answer flag is accepted | 1/1218 |
| M543 | sequential background answers never carry their origin and bounce forever | 8/1218 |
| M544 | strictly sequential answers never trip the hold | 1/1218 |
| M545 | restart forgets which paused device must preserve its editor text | 3/1218 |
| M546 | corrupt local state can name a non-file-id hold | 1/1218 |
| M547 | corrupt local state can hold a path outside the vault | 1/1218 |
| M548 | the Resume button dismisses status without resuming the note | 1/1218 |
| M549 | the plugin Resume method never reaches the engine | 1/1218 |
| M550 | Resume does not close the existing pause heads | 2/1218 |
| M551 | Resume adopts a conflicting pause at the same server position | 1/1218 |
| M552 | pause publication sends a clear and Resume sends a pause | 11/1218 |
| M553 | a server failure is treated as proof that no control exists | 1/1218 |
| M554 | every held local rewrite sends another control lookup | 1/1218 |
| M555 | restart republishes an identical hold and repeated Resume creates more versions | 6/1218 |
| M556 | Resume takes stale peer text instead of the editor held while paused | 12/1218 |
| M557 | resuming an editor silently consumes a different live head | 1/1218 |
| M558 | a save during Resume drops the hold despite publishing nothing | 1/1218 |
| M559 | a fresh local file at a held path escapes the hold | 1/1218 |
| M560 | two concurrent deliveries issue the same hold notice twice | 1/1218 |
| M561 | Resume clears a hold when it could not preserve the held note | 1/1218 |
| M562 | Resume clears a hold after a concurrent local save interrupted restoration | 1/1218 |
| M563 | a new device cannot Resume a held note it has not downloaded yet | 2/1218 |
| M564 | Resume overwrites a local deletion with the current remote note | 2/1218 |
| M565 | Resume buffers a file above its single-chunk budget | 1/1218 |
| M566 | a note whose old baseline expired can never Resume | 1/1218 |
| M568 | Resume writes a recorded version under a different path | 1/1218 |
| M569 | Resume treats a multi-chunk recorded version as its one-chunk baseline | 1/1218 |
| M570 | no free backup name silently removes the pause | 1/1218 |
| M571 | a save during resume materialisation clears the hold | 2/1218 |
| M572 | an empty control head list vacuously proves a hold exists | 1/1218 |
| M573 | Resume creates a redundant backup of its own known ancestor | 8/1218 |
| M574 | a different encrypted control kind is adopted as this pause | 1/1218 |
| M575 | a control for a different target is adopted as this hold | 1/1218 |
| M576 | a directory-shaped control at the same position is adopted as a pause | 1/1218 |
| M577 | Resume silently consumes a head whose encrypted version it could not inspect | 1/1218 |
| M578 | a stopped engine publishes and forgets a hold when Resume was queued | 1/1218 |
| M579 | a peer hold disappears on restart because it was never persisted | 2/1218 |
| M580 | misclassify non-auth signature errors | 1/1218 |
| M581 | ignore revoked credentials | 1/1218 |
| M582 | omit automatic registration | 2/1218 |
| M583 | map forgotten feed credentials to offline retry | 1/1218 |
| M584 | restart a forgotten device | 1/1218 |
| M585 | hide recovery behind rejected device id | 1/1218 |
| M586 | permit duplicate setup actions | 1/1218 |
| M587 | setup retains rejected enrollment | 2/1218 |
| M588 | enrol before key durability | 1/1218 |
| M589 | replace retained vault key during setup | 5/1218 |
| M590 | adopt credential after vault-key change | 1/1218 |
| M591 | overwrite forgotten status with idle | 1/1218 |
| M592 | keep recovered device blocked | 1/1218 |
| M593 | lose recovery connection settings | 4/1218 |
| M594 | retain stale sync records on reset | 6/1218 |
| M595 | gate phrase restore with rejected credential | 1/1218 |
| M596 | ignore rejection during registration | 1/1218 |
| M597 | stop sync on old server without recovery | 3/1218 |
| M598 | misclassify startup authentication refusal | 3/1218 |
| M599 | force pairing after empty-server switch | 1/1218 |
| M600 | send verifier as key proof | 3/1218 |
| M601 | register the wrong verifier | 2/1218 |
| M602 | reset an active credential without a refusal | 1/1218 |
| M603 | reset during an active restore | 1/1218 |
| M604 | clear identity before old writers drain | 1/1218 |
| M605 | send a proof from a replaced key | 1/1218 |
| M606 | refuse pairing for forgotten device | 2/1218 |
| M607 | claim pairing with stale sync records | 2/1218 |
| M608 | register a verifier after the key changes | 1/1218 |
| M609 | claim after pairing dialog closes during reset | 1/1218 |
| M610 | re-enrollment retains the old device list error | 1/1218 |
| M611 | a device-list result ignores a changed identity | 2/1218 |
| M612 | a device-list result ignores a changed server | 2/1218 |
| M613 | Resume selects heads before a queued older upload completes | 1/1218 |
| M614 | do not redraw settings after pairing | 1/1218 |
| M615 | ignore pairing close callback | 2/1218 |
| M616 | forget the switch-server pairing completion callback | 1/1218 |
| M617 | offer destructive leave before Cancel | 1/1218 |
| M618 | offer destructive leave before Cancel on refusal | 1/1218 |
| M620 | both resumes create a second sibling instead of advancing the recorded-answer copy | 23/1218 |
| M621 | Resume can write a path whose tracked identity changed | 1/1218 |
| M622 | Resume reads a preserved copy above its single-chunk budget | 1/1218 |
| M623 | a missing copy loses its structured Resume refusal | 1/1218 |
| M624 | Resume overwrites an unpublished same-metadata copy edit | 1/1218 |
| M625 | Resume consumes split copy heads without a unique lineage | 1/1218 |
| M626 | Resume writes over a copy after substituting another version for an unreadable head | 1/1218 |
| M627 | Resume changes a copy the remote device moved to another path | 1/1218 |
| M628 | Resume replaces an independent remote copy edit | 1/1218 |
| M629 | a proven baseline copy cannot advance to the newer held text | 30/1218 |
| M630 | retry refuses an already-published held snapshot | 3/1218 |
| M631 | Resume ignores a copy touched while its replacement is prepared | 1/1218 |
| M632 | Resume overwrites a same-metadata copy edit made during preparation | 2/1218 |
| M633 | Resume writes after the copy record has been reassigned | 1/1218 |
| M634 | a growing copy clears the hold when its last recorded digest already matches | 1/1218 |
| M635 | Resume clears the hold despite an independent head racing its copy publication | 1/1218 |
| M636 | a disappeared copy authorizes replacing the held note | 1/1218 |
| M637 | Resume fails to store the held bytes in its preserved copy | 23/1218 |
| M638 | the newer held snapshot forks instead of advancing the preserved baseline | 19/1218 |
| M639 | retrying an already-published held snapshot grows another history version | 2/1218 |
| M650 | revival omits the tombstone parent | 12/1218 |
| M651 | published edit leaves the deletion as another head | 3/1218 |
| M652 | unpublished edit leaves the deletion as another head | 5/1218 |
| M653 | startup push bypasses the publication queue | 6/1218 |
| M654 | revival bypasses an in-flight publication | 1/1218 |
| M655 | completed publication drops a later publication from the queue | 1/1218 |
| M656 | failed publication cancels the revival waiting behind it | 1/1218 |
| M657 | identical revivals from two devices are not deduplicated | 1/1218 |
| M660 | passive open editors prevent the rewrite hold | 6/1218 |
| M661 | input begun after a background judgment still pauses the typist | 3/1218 |
| M662 | real typing is advertised as a background answer | 3/1218 |
| M663 | saved typing loses its debounce allowance | 8/1218 |
| M664 | an old input exempts all later plugin rewrites | 4/1218 |
| M665 | switching files carries the old file input to the new one | 1/1218 |
| M666 | long IME compositions are classified as rewrites | 1/1218 |
| M667 | completed IME composition exempts rewrites forever | 1/1218 |
| M668 | cancelled IME composition remains active after focus leaves | 1/1218 |
| M669 | synthetic plugin events falsely claim human input | 1/1218 |
| M670 | an absent event target throws during input observation | 1/1218 |
| M671 | non-node event targets throw in DOM containment | 1/1218 |
| M672 | deferred non-Markdown leaves are accessed as loaded editors | 1/1218 |
| M673 | an empty editor throws instead of safely ignoring input | 1/1218 |
| M674 | input in another UI or editor protects every open note | 3/1218 |
| M675 | layout restoration installs duplicate input listeners | 1/1218 |
| M676 | CodeMirror event handling can hide trusted input | 1/1218 |
| M677 | leaving a passive editor invents a typing allowance | 1/1218 |
| M678 | physical keyboard input is not observed | 1/1218 |
| M679 | touch keyboard and paste input is not observed | 3/1218 |
| M680 | IME composition start is not observed | 2/1218 |
| M681 | IME completion is not observed | 1/1218 |
| M682 | composition cancellation on focus change is not observed | 1/1218 |
| M683 | plugin startup does not observe its primary window | 1/1218 |
| M684 | already open popout windows miss editor input | 1/1218 |
| M685 | new popout windows miss editor input | 1/1218 |
| M686 | closed file input still applies after a view changes notes | 1/1218 |
| M687 | an IME composition transfers to a different file | 1/1218 |
| M688 | the last input time is not retained through save debounce | 6/1218 |
| M689 | composition completion does not refresh the save allowance | 1/1218 |
| M690 | the typing peer makes a conflict copy before holding | 5/1218 |
| M691 | ordinary user edits are treated as automatic answers | 3/1218 |
| M692 | a passive editor originates the typing-side hold | 1/1218 |
| M693 | the active editor resumes as the background rewriter | 6/1218 |
| M694 | the editor-side hold is not persisted | 1/1218 |
| M695 | the editor-side hold is not shared | 3/1218 |
| M696 | the typing-side hold still falls through to conflict copying | 4/1218 |
| M697 | parallel typing-side detection emits duplicate notices | 1/1218 |
| M698 | the received control classifies its own id instead of the note | 5/1218 |
| M699 | the answer author resumes as a remote editor | 5/1218 |
| M700 | background Resume restores the stale local branch before reconciling | 6/1218 |
| M701 | background Resume guesses one branch from several peer heads | 1/1218 |
| M702 | a local in-flight head is mistaken for the peer editor | 1/1218 |
| M703 | Resume selects an unrelated historical version instead of the peer head | 5/1218 |
| M704 | Resume records the peer head over restored local bytes | 10/1218 |
| M705 | Resume records the old version over the peer bytes | 2/1218 |
| M706 | Resume writes the peer under a different path | 1/1218 |
| M707 | Resume admits a deleted or oversized peer head | 2/1218 |
| M708 | the peer answer pauses even a clean nonoverlapping merge | 1/1218 |
| M709 | the control claims another file at the same path is its author | 1/1218 |
| M710 | twin adoption awaits another digest after checking the replacement boundary | 1/1218 |
| M711 | twin adoption checks the identity before the awaited file recheck | 2/1218 |
| M712 | identical merged heads use their older graph ancestor and displace newly typed text into a conflict copy | 1/1218 |
| M713 | a delayed upload receipt replaces a newer pulled record and gives later typing an older parent | 1/1218 |
| M714 | merges omit an in-flight upload from their parents because they cannot wait for its receipt | 4/1218 (2 cancelled) |
| M715 | a delayed merge receipt replaces a newer pulled identity | 1/1218 |
| M716 | obsolete typing frames are merged and consume the loop budget | 3/1218 |
| M717 | editor uploads can fork from merged bytes before the merge receipt | 2/1218 |
| M718 | reserve the merge after writing, so a watcher upload can keep the old parent | 1/1218 |
| M719 | independent peer typing consumes the loop budget | 3/1218 |
| M720 | unrelated forks reset the loop budget without ancestor proof | 4/1218 |
| M721 | a peer answering our own publication bypasses the loop budget | 2/1218 |
| M722 | the same repeated foreign head resets the loop budget | 4/1218 |
| M723 | a completed upload is omitted from the merge parents, leaving two heads | 1/1218 |
| M724 | a missing pending change bypasses move discovery and publishes a tombstone | 1/1218 |
| M725 | a stale pending change queues a deletion after a pulled move removed its old identity | 3/1218 |
| M726 | identical pull adoption does not persist the keeper before retirement | 1/1218 |
| M727 | unpublished typing is included in another criss-cross merge before its own upload | 1/1218 |
| M728 | criss-cross deferral selects published content instead of unpublished typing | 6/1218 |
| M729 | an empty head view falsely proves an incoming version obsolete | 1/1218 |
| M730 | a head absent from the file view falsely proves an incoming version obsolete | 2/1218 |
| M731 | a current live head is skipped as though it were historical | 122/1218 (3 cancelled) |
| M732 | ignore base-only gaps and lose deletions | 2/1218 |
| M733 | ignore side-only gaps and lose insertions | 8/1218 |
| M734 | omit the terminal alignment boundary and lose tail edits | 39/1218 |
| M735 | stop collecting edits at the first changed line | 107/1218 |
| M736 | treat different text in the same interval as an identical edit | 53/1218 |
| M737 | deduplicate equal text that changes different starting lines | 1/1218 |
| M738 | deduplicate equal text that changes different ending lines | 1/1218 |
| M739 | refuse a left edit adjacent to the right edit | 13/1218 |
| M740 | order a left insertion against a replacement at the same boundary | 4/1218 |
| M741 | refuse a right edit adjacent to the left edit | 4/1218 |
| M742 | order a right insertion against a replacement at the same boundary | 4/1218 |
| M743 | discard unchanged lines before each edit | 39/1218 |
| M744 | discard replacement text while consuming its base interval | 74/1218 |
| M745 | retain the old changed lines after writing their replacements | 62/1218 |
| M746 | discard the unchanged suffix after the final edit | 41/1218 |
| M747 | truncate replacement lines before the matching anchor | 109/1218 |
| M748 | repeat the unchanged matching anchor inside the next edit | 60/1218 |
| M749 | refuse all append-only overlaps | 22/1218 |
| M750 | merge appended text across different starting base lines | 2/1218 |
| M751 | merge appended text across different ending base lines | 1/1218 |
| M752 | allow a whole multi-line replacement into the append rule | 3/1218 |
| M753 | drop extra replacement lines from our side | 2/1218 |
| M754 | drop extra replacement lines from the other side | 1/1218 |
| M755 | treat our replacement of existing text as an append | 3/1218 |
| M756 | treat their replacement of existing text as an append | 5/1218 |
| M757 | consume unequal appended characters as a shared prefix | 8/1218 |
| M758 | split shared emoji into UTF-16 halves | 2/1218 |
| M759 | drop the shared appended prefix | 6/1218 |
| M760 | order concurrent additions by device role rather than a common rule | 4/1218 |
| M761 | discard the existing line when combining appends | 12/1218 |
| M762 | silently choose our text when a change is not an append | 31/1218 |
| M763 | include the base text twice in the left addition | 12/1218 |
| M764 | include the base text twice in the right addition | 12/1218 |
| M765 | remove retained merge verdict | 4/1218 |
| M766 | accept stale background proof | 5/1218 |
| M767 | carry background proof across trusted typing | 1/1218 |
| M768 | keep pre-merge timestamp | 4/1218 |
| M769 | reclassify a user verdict as background | 5/1218 |
| M770 | invent missing background proof | 31/1218 |
| M771 | carry local proof onto incoming-only content | 1/1218 |
| M772 | classify trusted input before a merge as a background rewrite | 1/1218 |
| M773 | ignore a new rewrite waiting for the debounce verdict | 5/1218 |
| M774 | rejudge one saved edit against a later arrival clock | 1/1218 |
| M775 | overwrite the arrival clock before preserving the waiting save | 5/1218 |
| M776 | Remember arrivals only after a host plugin can answer the write. | 11/1218 |
| M777 | derive arrival evidence from echoes and ignored nested entries | 5/1218 |
| M778 | classify unchanged remote bytes as a waiting local edit | 5/1218 |
| M779 | classify a replacement identity as the incoming file | 1/1218 |
| M780 | inspect pending bytes outside selected folders | 1/1218 |
| M781 | invent pending bytes for a missing note | 1/1218 |
| M782 | refuse continued typing before an already received suffix | 3/1218 |
| M783 | allow our deletion through the insertion merge | 1/1218 |
| M784 | allow the peer deletion through the insertion merge | 1/1218 |
| M785 | merge our competing prefix as continued typing | 1/1218 |
| M786 | merge the peer competing prefix as continued typing | 1/1218 |
| M787 | drop the unchanged character anchors while merging insertions | 3/1218 |
| M788 | replay our anchor as another insertion | 3/1218 |
| M789 | replay the peer anchor as another insertion | 3/1218 |
| M790 | merge against one ancestor after the shared base was refused | 3/1218 |
| M791 | ignore failure to resolve a deeper shared base | 1/1218 |
| M792 | treat an unresolvable shared base as absent | 2/1218 |
| M793 | skip shared ancestors when an append looks clean | 4/1218 |
| M794 | omit arrival tracking for newly materialized paths | 2/1218 |
| M795 | drop insertions after the last unchanged character | 3/1218 |
| M796 | duplicate shared text inserted before a received suffix | 1/1218 |
| M797 | only the holder of the smaller identical head can close the fork | 2/1218 |
| M798 | Mobile writes beneath an active native editor. | 5/1218 |
| M799 | Desktop writes beneath an active native editor. | 5/1218 |
| M800 | Native editor refusal escapes the per-note retry classification. | 22/1218 |
| M801 | A saved buffer is overwritten while native typing is still active. | 2/1218 |
| M802 | The feed consumes an active editor update without arming its retry. | 5/1218 |
| M803 | Stopping leaves the owned editor retry timer armed. | 1/1218 |
| M804 | A finished retry leaves its durable wait behind. | 1/1218 |
| M805 | A deferred native editor falsely reports idle. | 2/1218 |
| M806 | Normal typing raises a per-file failure notice. | 1/1218 |
| M807 | A waiting editor repeatedly downloads and tries to overwrite the note. | 2/1218 |
| M808 | A transient connection failure forgets pending editor updates. | 1/1218 |
| M809 | A push reconciliation reports an active editor refusal as an error. | 1/1218 |
| M810 | The fast editor timer also retries locked files. | 1/1218 |
| M811 | An editor retry cannot rearm after its first tick. | 5/1218 |
| M812 | The retry ignores recent native input. | 1/1218 |
| M813 | The retry overwrites an unsaved buffer once recent input ends. | 1/1218 |
| M814 | Sync status calls a normal typing wait a write failure. | 1/1218 |
| M815 | The native commit ignores unsaved text when no recent input was recorded. | 8/1218 |
| M816 | Stopping retains the old editor timer handle. | 1/1218 |
| M817 | Group independent adjacent appends as a replacement. | 4/1218 |
| M818 | Split structural line deletions as if they were appends. | 1/1218 |
| M819 | Merge replacements without preserving original line prefixes. | 1/1218 |
| M820 | Extend a split append across its next line. | 4/1218 |
| M821 | Collapse independent authors into one progress slot. | 2/1218 |
| M822 | Retain forgotten authors outside the received ancestry graph. | 1/1218 |
| M823 | Forget the per-author progress map between resolutions. | 4/1218 |
| M824 | Do not record a new independent remote version. | 3/1218 |
| M825 | busy editor refusals keep consuming the merge budget | 4/1218 |
| M826 | all write failures refund the merge budget | 1/1218 |
| M827 | an old busy refusal erases a new generation charge | 1/1218 |
| M828 | new edits keep the old budget generation | 1/1218 |
| M829 | ignore an unsaved editor when concurrent resolutions exhaust the budget | 1/1218 |
| M830 | ignore recent typing when concurrent resolutions exhaust the budget | 1/1218 |
| M831 | wait for the editor only after the merge budget is exceeded | 2/1218 |
| M832 | silence the editor wait at the merge limit | 2/1218 |
| M833 | omit retained-ancestry lookup | 14/1218 |
| M834 | fetch ancestry for incomplete head listings | 2/1218 |
| M835 | remove ancestry read budget | 2/1218 |
| M836 | swallow transient ancestor failures | 1/1218 |
| M837 | accept substituted ancestor identity | 1/1218 |
| M838 | accept non-array ancestor parents | 1/1218 |
| M839 | accept too many ancestor parents | 1/1218 |
| M840 | accept malformed ancestor parent ids | 3/1218 |
| M841 | walk below known shared frontier | 1/1218 |
| M842 | fetch all missing frontiers at once | 1/1218 |
| M843 | omit ancestry loaded receipt | 2/1218 |
| M844 | omit ancestry budget receipt | 2/1218 |
| M845 | omit unavailable ancestor receipt | 1/1218 |
| M846 | remove ancestry traversal visited guard | 1/1218 |
| M847 | append fetched ancestors after their known parents | 1/1218 |
| M848 | retain partial graph after ancestry failure | 2/1218 |
| M849 | omit recursive criss-cross ancestry lookup | 1/1218 |
| M850 | reject non-string parents even when they have string-like length and indexing | 1/1218 |
| M851 | discard the partial graph when the ancestry read budget is exhausted | 1/1218 |

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
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a note renamed onto a name the other device just made offline ends under one name per note on both (higher id)
- a note beside its name takes it at the next scan once this device's own user frees it
- a note waiting beside its name is repaired like any other, never reported as a mismatch
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
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a name another record still holds is not taken, even once its file is gone
- a copy beside its name that holds an unpushed edit stays where it is
- a move to the freed name that fails is logged, and the version that freed it stays applied
- a copy beside its name waits for the vault to report its write before it moves

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
- a note renamed onto a name the other device just made offline ends under one name per note on both (higher id)
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
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a note beside its name takes it at the next scan once this device's own user frees it
- a note waiting beside its name is repaired like any other, never reported as a mismatch
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
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a name another record still holds is not taken, even once its file is gone
- a copy beside its name that holds an unpushed edit stays where it is
- a move to the freed name that fails is logged, and the version that freed it stays applied
- a copy beside its name waits for the vault to report its write before it moves

**M04** - a name this device already settled is ignored

- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a second version with the same size and modification time still reaches the vault
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id higher)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a later version of the other note lands on its own name, not on a new copy
- a note that cannot be published keeps both, and the copy is still recorded
- a save that lands on a settled copy as it is written is not recorded as that version
- a version of a file this device tracks lands where it put it, not at a second path
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken
- a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name

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
- a note beside its name takes it at the next scan once this device's own user frees it
- a note waiting beside its name is repaired like any other, never reported as a mismatch
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
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a copy beside its name that holds an unpushed edit stays where it is
- a move to the freed name that fails is logged, and the version that freed it stays applied
- a copy beside its name waits for the vault to report its write before it moves

**M07** - the moved file's delete is left unmarked

- the holder of the higher id moves its own note aside and yields the path
- a note far larger than memory is moved aside a window at a time

**M08** - the moved file's record is left clean

- a note renamed onto a name the other device just made offline ends under one name per note on both (higher id)
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

**M11** - the source of a move is never checked for a local edit

- a move never trashes a local file this device has not pushed
- resolving the same foreign version twice leaves one copy, not two
- a replayed head whose copy carries a different timestamp is still one copy
- a single-chunk version of the same length IS read, and its copy reused
- a rename over an unpushed local edit keeps both, and renames nothing

**M12** - adoption takes any occupant of the length

- an occupied name whose bytes are not this version's is not mistaken for it
- a local file of the same length that is NOT this version is never adopted

**M13** - identify believes any publish outcome

- a publisher that leaves no record is not taken at its word

**M14** - a failed publish reports success

- a note that cannot be published keeps both, and the copy is still recorded

**M15** - one path pushed twice at once

- a pull publication joining an older upload still sends the edit made while it waited

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

- a pull publication joining an older upload still sends the edit made while it waited

**M26** - the follow-up is remembered and never queued

- a pull publication joining an older upload still sends the edit made while it waited

- The previous coverage gap is closed. A pull publication now joins an
  older blocked upload, with no watcher or periodic scan to rescue it;
  dropping the remembered follow-up leaves the latest edit unposted.
  Both M25 and M26 are killed by that behavioral regression.

**M27** - the record is never saved

- the copy's record is stored, not only held in memory
- a copy beside its name takes it as soon as the note holding the name is renamed away

**M28** - any held answer enters the rule, not only one about the destination

- two devices typing in one open note converge on one note on both
- two devices appending on the same line converge with every keystroke once and no copies
- peer versions that incorporate our own output still consume the loop budget
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- a file left with two heads, or a note whose push is not in flight, comes to rest
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- the status names a parked file first, then a note waiting on its push, then idle
- an automatic answer also holds an unpushed typed overlap before deferring it
- an unflagged overlap over an unpushed typed edit waits for its publication
- a save that lands on a version as it is written is not recorded as that version
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

- NO LONGER EQUIVALENT, and kept as the record of why. Through 1.1.2 the
  branch it removes and the rule it sends the answer into ended the same
  way -- `keepBoth` -- so no outcome moved and the mutant survived by
  construction. 1.1.3 (#135) replaced that keep-both with the lower-id
  settlement (`converge`): an answer about the SOURCE that now enters the
  rule settles a fork the unmutated code leaves to the push, and the
  co-typing tests see the difference. Its subject line is unchanged.

**M29** - the id the server answers with is ignored

- two devices typing in one open note converge on one note on both
- two devices settling the same overlap publish one shared conflict-copy version
- a post the server already holds is recorded under the id it answers with
- a publish under an adopted file id that dedupes is adoption, and renames nothing
- ordinary concurrent edit must not adopt another device's rename-and-edit manifest
- a persisted unposted rename must retain the dedupe opt-out after state reload
- two devices reviving identical edits publish one settlement (\#178)
- the equal-byte shortcut closes exactly two compared heads with both holders online
- concurrent opposite controls do not adopt each other; explicit Resume closes the fork

**M30** - a post never offers the version the server already holds

- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- two devices settling the same overlap publish one shared conflict-copy version
- a post the server already holds is recorded under the id it answers with
- a publish under an adopted file id that dedupes is adoption, and renames nothing
- two engines that merge one note identically end on ONE version
- two devices reviving identical edits publish one settlement (\#178)
- two devices resolving one concurrent edit settle instead of looping
- the equal-byte shortcut closes exactly two compared heads with both holders online
- an edit made while this device was closed survives one the other device made to the same note
- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)

**M31** - a rename offers itself for deduplication

- a rename is never deduplicated, so both devices still learn the new name

**M32** - the domain map offers itself for deduplication

- two different domain maps from one parent are two versions

**M33** - 121: drain() resolves immediately while draining (the 1.0.6 early return)

- startup engine does not label a foreign renamed manifest as its own echo
- sync now waits for the drain already running, and says which decision it took
- sync now drains again for work queued after the drain it joined took its last batch
- a synced file whose record was lost is adopted at startup, never published under a new id (\#181)

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
- a rename above a selected folder moves the selection with it, persists it, and widens nothing
- a failed save of a followed selection stops the engine instead of syncing an unrecorded scope

**M41** - 91: a file leaving the selection is published as a deletion

- a rename whose target is hidden is not synced, and neither is the plugin's own state
- review: a pending upload must not restore tracking for a file that left the selected scope
- review: a scope exit during upload must preserve the other device's live note
- a selected folder renamed where no device may sync publishes nothing and says so once

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
- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a note deleted on another device goes where "Deleted files" says: "none"
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead
- a hidden folder something else wrote into is kept, and reported
- a hidden folder swapped for a link refuses the removal

**M46** - the desktop writer answers with a fresh look at the name instead of the bytes it committed

- a native settled write records the metadata of the bytes it committed

**M47** - the local-copy bound is applied to the streaming host instead of the one that buffers

- a local note past this device's ceiling is left where it is

**M48** - a tombstone is posted without asking whether the file is still there

- a host that lists two spellings and answers for a third renames nothing
- a note deleted here and edited elsewhere before the deletion is sent comes back with the edit
- a file the pull writes while the scan is listing is not published as a tombstone
- a deletion refused because the file came back is published as the change it is
- a delete reported for a note that is still there moves nothing, whatever else carries its bytes

**M49** - a refused deletion is dropped instead of published as the change it is

- a deletion refused because the file came back is published as the change it is

**M50** - a move the filesystem refused is removed by its live name anyway

- a move refused with EXDEV removes nothing, and the note survives the window

**M51** - a removal with no hold behind it is made anyway, with the window open

- a hold refused with EPERM removes nothing, and the note survives the window
- a hold refused with EXDEV removes nothing, and the note survives the window
- a hold refused with unsupported removes nothing, and the note survives the window

**M52** - a host that cannot bind a removal is asked to move anyway, and copies first

- a note written while this device was closed survives one the other device made at the same path
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
- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a note deleted on another device goes where "Deleted files" says: "none"
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead
- a hidden folder something else wrote into is kept, and reported

**M55** - the vacated name is written over instead of created

- follow-up: a replacing save inside permanent removal remains in the vault

**M56** - a save made through an open descriptor after the move is not noticed

- a native move preserves an edit arriving inside the trash operation
- a restore that lands nowhere keeps the hold rather than releasing it
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable

**M57** - a tombstone is applied without proving the file against its record

- delete-versus-unpublished-edit consumes the deletion and stays settled after replay (\#178)
- settling a deletion does not claim to incorporate another device's unseen edit (\#178)
- a tombstone does not take an edit this device never published
- a tombstone whose revive cannot publish keeps the file and says only that
- a remote delete over an unpushed local edit keeps the edit and republishes it

**M58** - a replayed tombstone is obeyed whatever this device's version descends from

- a ghost tombstone that forks from the record is refused, and the note stays
- delete-versus-published-edit consumes the deletion and stays settled after replay (\#178)
- a deferred settlement describes an already-published edit truthfully and retries quietly (\#178)
- a tombstone that forks from the version this device holds is one side of a fork
- review: replay skips a historical tombstone that the tracked live version already incorporates
- review: widening after an excluded remote deletion must preserve the local edit
- review: widening must not trash an unuploaded local edit while its source read is pending
- a delete raced by an edit reaches the other device as a live note

**M59** - the tombstone's removal is not bound to the bytes it was told to remove

- a save landing between the tombstone's check and its removal is kept
- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a note deleted on another device goes where "Deleted files" says: "none"
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead
- a hidden folder something else wrote into is kept, and reported

**M60** - the put-back looks at the destination and then replaces whatever took it

- a restore that lands nowhere keeps the hold rather than releasing it
- review: restoring a changed moved file does not overwrite a later save

**M61** - the hold is released whether or not the restore landed

- a restore that lands nowhere keeps the hold rather than releasing it

**M62** - the hold is unlinked on a stat, with no descriptor left to answer for it

- review: a descriptor save after the final hold stat remains reachable

**M63** - an upload that outlived its path records it anyway

- review: a selection narrowed while a version is posting records nothing for that path
- a copy removed during publication does not authorize replacing the held note

**M64** - a folder rename moves the records and leaves the pending work behind

- review: a folder rename retains the pending upload of an untracked new note

- The original witness let periodic reconciliation rediscover the
  pending note after a folder rename. Its disk scan is now isolated
  after startup: the watcher path must deliver the note on its own.
  The replacement full suite reports one behavioral failure and zero
  cancellations, with no product-source change.

**M65** - the adopted version is proved by everything except the path

- ordinary concurrent edit must not adopt another device's rename-and-edit manifest
- a persisted unposted rename must retain the dedupe opt-out after state reload
- startup engine does not label a foreign renamed manifest as its own echo

**M66** - the repost after a refused adoption offers the promise again

- ordinary concurrent edit must not adopt another device's rename-and-edit manifest
- a persisted unposted rename must retain the dedupe opt-out after state reload
- startup engine does not label a foreign renamed manifest as its own echo
- concurrent opposite controls do not adopt each other; explicit Resume closes the fork
- control adoption checks kind and target as well as its paused state

**M67** - the bulk-deletion floor is removed, so any pass can hold

- a small vault emptied is below the floor and still publishes
- startup reconciliation tombstones a file deleted while Obsidian was closed

**M68** - a count alone decides a bulk deletion, without the share

- a deletion that is large but not most of the vault is published

**M69** - the periodic scan may clear a hold the startup pass took

- a selected folder that left the vault while Obsidian was closed publishes nothing and says so once
- the user's confirmation publishes exactly what was held
- a narrowed selection measures the share against the notes it selects
- Sync now with a hold pending publishes none of it, and says the hold is still waiting
- a pending hold is never published by a pass, even once fewer than half are missing
- the periodic scan stops offering to delete a held note that is back under a new name
- two files sharing a size and an mtime are never paired as a move

**M70** - the confirmation queues nothing, so a real deletion never publishes

- the user's confirmation publishes exactly what was held
- a pending hold is never published by a pass, even once fewer than half are missing
- confirming held deletions never deletes a note that is in the vault under a new name
- the periodic scan stops offering to delete a held note that is back under a new name

**M71** - every remote rename falls back to write-then-trash

- a folder renamed in a file manager is published as moves, keeping every file id (immediate, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (immediate, deletes first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, deletes first)
- a renamed note moves on the other device and neither publishes a tombstone (immediate vault events)
- a renamed note moves on the other device and neither publishes a tombstone (deferred vault events)
- a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (immediate vault events)
- a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (deferred vault events)
- a pending change whose note moved before its rename event follows the live note instead of deleting it
- a copy beside its name takes it as soon as the note holding the name is renamed away

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
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a same-size rewrite that keeps the recorded time right after a sync is still sent
- actual input remains exempt while its editor buffer is unsaved

**M89** - a folder record is judged by the file rule, as it was

- a case-only rename of a SELECTED folder publishes moves, not new notes
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder
- a selected folder the user really deletes still tombstones every note it held
- a selected folder renamed where no device may sync publishes nothing and says so once
- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)
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
- a folder record whose post keeps failing expires with a decision, and the queue drains

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

- a folder record reported twice while its post is in flight publishes one record and keeps no hold
- startup reconciliation publishes a record for every folder that has none, once

**M109** - the fake reports a folder rename that landed where it started

- the fake reports no rename for a folder move that landed where it started

**M110** - an outage is classified as a refusal, and a refusal as an outage

- startup authentication refusal identifies a forgotten device without scheduling reconnect
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
- an unanswered attempt never hides an error, and an answer never clears the reconnect cycle's offline

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
- 401 stale_timestamp is not retried: it stays an error until the person acts
- 403 device_pending is not retried: it stays an error until the person acts
- 507 after the transport's retries is not retried: it stays an error until the person acts
- a domain map this version cannot read is not retried: it stays an error until the person acts
- a key that does not decrypt is not retried: it stays an error until the person acts

**M122** - the identical-name check never matches

- historical identical live frame followed by its deletion cannot retire a later independent note (\#133)
- pull adoption persists its keeper before retiring the prior identical identity (\#133)
- an edit during the current-twin lookup is not adopted or retired (\#133)
- a replacement record during twin lookup keeps its newer identity (\#133)
- a twin with a concurrent deletion cannot replace an independent live note (\#133)
- a replacement at the second stat survives later twin deletion (\#133)
- a replacement at the record boundary survives later twin deletion (\#133)
- identical notes: the holder of the lower id keeps the name and writes nothing
- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note
- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired
- a retirement over a name its keeper holds deletes nothing and forgets only the old id (\#181)
- a retirement whose keeper no longer holds these bytes is still a deletion (\#181)
- a retirement whose keeper this device records at another name is an ordinary deletion (\#181)

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
- a note renamed onto a name the other device just made offline ends under one name per note on both (higher id)
- a note beside its name takes it at the next scan once this device's own user frees it
- a note waiting beside its name is repaired like any other, never reported as a mismatch
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
- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired
- an edit that is not provably of this very note keeps both, and retires nothing
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a name another record still holds is not taken, even once its file is gone
- a copy beside its name that holds an unpushed edit stays where it is
- a move to the freed name that fails is logged, and the version that freed it stays applied
- a copy beside its name waits for the vault to report its write before it moves
- a widening keeps a note the newly covered folder held and the server also has
- another device's version is never adopted by its stat, even at the same name and size (\#181)
- a retirement whose keeper no longer holds these bytes is still a deletion (\#181)

**M125** - a note whose mtime moved is taken for its recorded version

- a note with an edit not yet pushed is never taken for its recorded twin

**M126** - a note whose size moved is taken for its recorded version

- a note with an edit not yet pushed is never taken for its recorded twin

**M127** - the identical pair keeps the HIGHER id

- pull adoption persists its keeper before retiring the prior identical identity (\#133)
- an edit during the current-twin lookup is not adopted or retired (\#133)
- a replacement record during twin lookup keeps its newer identity (\#133)
- a replacement at the second stat survives later twin deletion (\#133)
- a replacement at the record boundary survives later twin deletion (\#133)
- identical notes: the holder of the lower id keeps the name and writes nothing
- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note
- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- a retirement over a name its keeper holds deletes nothing and forgets only the old id (\#181)
- a retirement whose keeper no longer holds these bytes is still a deletion (\#181)
- a retirement whose keeper this device records at another name is an ordinary deletion (\#181)

**M128** - the yielding device does not record the lower id

- pull adoption persists its keeper before retiring the prior identical identity (\#133)
- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note

**M129** - the yielding device does not retire its own id

- pull adoption persists its keeper before retiring the prior identical identity (\#133)
- identical notes: the holder of the higher id adopts the lower id and retires its own
- a tombstone that cannot be posted costs a duplicate id, never the note
- a retirement over a name its keeper holds deletes nothing and forgets only the old id (\#181)
- a retirement whose keeper no longer holds these bytes is still a deletion (\#181)
- a retirement whose keeper this device records at another name is an ordinary deletion (\#181)

**M130** - a push never rereads the record before posting

- an adoption that lands while the push reads it publishes nothing

**M131** - a record of other bytes found before posting is taken for the push

- a record of other bytes landing during the push read is not deduplicated (lower id)
- a record of other bytes landing during the push read is not deduplicated (higher id)

**M132** - a record that appears during the post is never settled

- a keeper selected while a push posts is persisted before the adopted id is retired (\#133)
- an adoption that lands while the push posts settles the pair on the lower id (keep)
- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M133** - a record of other bytes that appears during the post is settled as a duplicate

- a record of other bytes landing during the push read is not deduplicated (lower id)
- a record of other bytes landing during the push read is not deduplicated (higher id)
- a record of other bytes landing during the push post is not deduplicated (lower id)
- a record of other bytes landing during the push post is not deduplicated (higher id)

**M134** - the post-window pair keeps the HIGHER id

- a keeper selected while a push posts is persisted before the adopted id is retired (\#133)
- an adoption that lands while the push posts settles the pair on the lower id (keep)
- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M135** - the post-window keeper does not retire the posted duplicate

- an adoption that lands while the push posts settles the pair on the lower id (keep)

**M136** - the post-window yield does not record the lower id

- a keeper selected while a push posts is persisted before the adopted id is retired (\#133)
- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M137** - the post-window yield does not retire the adopted id

- a keeper selected while a push posts is persisted before the adopted id is retired (\#133)
- an adoption that lands while the push posts settles the pair on the lower id (yield)

**M138** - a tombstone that cannot be posted is raised

- a tombstone that cannot be posted costs a duplicate id, never the note

**M139** - the transport never says whether the server answered

- every attempt says whether the server answered it, and decides nothing

**M140** - the transport calls every attempt answered

- every attempt says whether the server answered it, and decides nothing

**M141** - an unanswered attempt is not shown

- a start still inside the transport's retries already reads offline, and the answer puts idle back
- an answer puts back the syncing it covered, and never a status raised since

**M142** - an unanswered attempt covers an error

- a start still inside the transport's retries already reads offline, and the answer puts idle back
- an unanswered attempt never hides an error, and an answer never clears the reconnect cycle's offline

**M143** - an unpaired device is shown offline

- an unpaired device stays not paired, and a transport from an earlier session is not heard

**M144** - an answer clears any offline, the reconnect cycle's included

- an unanswered attempt never hides an error, and an answer never clears the reconnect cycle's offline

**M145** - an answer puts back idle, not what it covered

- an answer puts back the syncing it covered, and never a status raised since

**M146** - a transport from an earlier session is heard

- an unpaired device stays not paired, and a transport from an earlier session is not heard

**M147** - a server that is not there is reported as a repair failure

- a server that is not there is absence during repair, never a could-not-verify error

**M148** - onload waits for the first start, holding Obsidian's loading screen until the server answers

- Obsidian finishes loading while the first start still waits for the server
- the first start waits until Obsidian has listed the vault

**M149** - the first start reconciles before Obsidian has listed the vault

- onload binds the primary window, pre-existing popouts, and newly opened windows
- the first start waits until Obsidian has listed the vault

**M150** - a resolution that wrote nothing forgets the note it found, so a run of resolutions after an edit never trips the breaker

- the merge breaker counts resolutions in a row, and an edit here starts the count again

**M151** - a merge's own write is read as the user's edit, so a loop of merges that each rewrite the note never trips the breaker

- merges that rewrite the note with nothing typed here still trip the breaker

**M152** - two different merges of one pair are never merged again, so every later version of the note becomes a conflict copy

- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a criss-cross merge loads the shared pair's omitted ancestor

**M153** - the criss-cross base is built from an ancestor the first one already holds, so the false overlap stays and copies return

- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- superseded typing frames neither merge nor consume the loop budget
- merges that rewrite the note with nothing typed here still trip the breaker
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- an editor upload inherits the pending merge at its write boundary
- an editor upload inherits the pending merge at its receipt boundary
- a delayed merge receipt cannot replace a newer recorded version
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- repeated ancestry edges are traversed once, including a hostile cycle
- a fetched child precedes its already-fetched parent when choosing the merge base
- a criss-cross merge loads the shared pair's omitted ancestor
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- a merge that comes out as the other device's bytes is adopted, not posted
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- an automatic answer that merges cleanly needs no hold
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version

**M154** - a criss-cross ancestor above one chunk is assembled whole, so another device's version graph decides this device's memory

- a criss-cross whose other ancestor is above one chunk is never assembled

**M155** - a version arriving while someone types here is kept as a conflict copy again, one copy per version the other device sends

- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- peer versions that incorporate our own output still consume the loop budget
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- a file left with two heads, or a note whose push is not in flight, comes to rest
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- the status names a parked file first, then a note waiting on its push, then idle
- an automatic answer also holds an unpushed typed overlap before deferring it
- an unflagged overlap over an unpushed typed edit waits for its publication
- a save that lands on a version as it is written is not recorded as that version
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

**M156** - a version arriving over an unpushed edit is merged and published here as well, so one edit lands on two lines and later merges overlap

- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- peer versions that incorporate our own output still consume the loop budget
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a save landing while a version downloads is not written over
- a file left with two heads, or a note whose push is not in flight, comes to rest
- the status names a parked file first, then a note waiting on its push, then idle
- a save that lands on a version as it is written is not recorded as that version
- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

**M157** - an edit undone before its push leaves the other device's version unapplied here for good

- an edit undone before its push still publishes, so the version it held back comes in
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- a save that lands on a version as it is written is not recorded as that version

**M158** - a merge is written over a save the user made while it downloaded, and the editor reloads the loss

- two devices appending on the same line converge with every keystroke once and no copies
- a save landing while a merge downloads is not written over

**M159** - a version is written over a save the user made while it downloaded, and the editor reloads the loss

- a save landing while a version downloads is not written over
- a detector keeps its hold if a save lands during its resume backup
- a save during peer-head download is kept in the main note

**M160** - a save made while a version downloaded is answered with a conflict copy instead of a merge

- a save landing while a version downloads is not written over

**M161** - a version that already holds the edit typed here is recorded under the older of two ids, so the next push forks the note

- a version that already holds the unpushed edit is adopted as it is

**M162** - the merge breaker counts every resolution again, so two people typing in one note trip it within seconds and the note splits

- the merge breaker counts resolutions in a row, and an edit here starts the count again

**M163** - the higher version id keeps the note, so a fork settles against the rule every other device applies

- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- text typed on top of the losing head is published as the copy's next version
- a save landing while the losing note is copied keeps the note
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- a binary conflict is never merged

**M164** - a head a later version replaced is settled anyway, closing a fork that is not there and keeping stale text

- a fork whose other head a later version has replaced is left for that version (incomplete view: true)

**M165** - each device publishes its own first version of the shared copy, so the copy is published twice

- two devices settling the same overlap publish one shared conflict-copy version

**M166** - two settlements of one fork on the losing device both move the note, making a second copy

- two settlements of one fork at once on the losing device make one copy

**M167** - a save landing while the losing note is copied is written over by the kept version

- a save landing while the losing note is copied keeps the note

**M168** - the status reads idle while a note waits on this device's own push to settle a fork

- an active editor stays pending, other notes arrive, and its latest head retries without another save
- a push reconciliation retains an active-editor wait without an error notice
- the status names a parked file first, then a note waiting on its push, then idle
- a note counted while its debounce was in flight stops counting when that debounce pushes nothing

**M169** - a note stays counted as waiting after its fork is settled, and the status reads syncing with nothing left to settle

- a version arriving over an unpushed edit is merged by that edit's push, not copied

**M170** - an address copied from a browser keeps its path and query

- a bare host name becomes an https URL; an explicit scheme is kept; mobile refuses http

**M171** - a desktop accepts any plain HTTP address again

- plain http is refused on every platform, loopback on a desktop excepted
- an address typed one key at a time is adopted once, when the field is left or Settings closes

**M172** - the one-computer trial on localhost is refused

- plain http is refused on every platform, loopback on a desktop excepted
- an address typed one key at a time is adopted once, when the field is left or Settings closes

**M173** - a look-alike of loopback passes as loopback

- plain http is refused on every platform, loopback on a desktop excepted

**M174** - a phone accepts loopback plain HTTP it cannot reach

- plain http is refused on every platform, loopback on a desktop excepted

**M175** - every keystroke of the server address is adopted again

- an address typed one key at a time is adopted once, when the field is left or Settings closes

**M176** - closing Settings loses a server address typed but not left

- an address typed one key at a time is adopted once, when the field is left or Settings closes

**M177** - Check before setup asks the signed read, which only says not paired

- Check asks the server without a credential before setup, and says to type an address first

**M178** - Check with no address sends a request to nowhere

- Check asks the server without a credential before setup, and says to type an address first

**M179** - a refused connection still says obsync cannot know whether it happened

- a second save of the same size inside one coarse mtime step is still sent
- a connection refused on the only attempt says nothing was sent and names the port; anything else stays unknown

**M180** - a refusal after an earlier unanswered attempt claims nothing was sent

- a connection refused on the only attempt says nothing was sent and names the port; anything else stays unknown

**M181** - a timed-out connection is reported as nothing sent

- a connection refused on the only attempt says nothing was sent and names the port; anything else stays unknown

**M182** - a note deleted on another device disappears for good, whatever "Deleted files" says

- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead
- a hidden folder something else wrote into is kept, and reported

**M183** - a note deleted on another device reaches the bin under a hidden placeholder name, not its own

- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead
- a hidden folder something else wrote into is kept, and reported

**M184** - with the system Trash unavailable, a note deleted on another device is removed for good instead of going to .trash

- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead

**M185** - a system Trash that errors stops sync with an error instead of sending the note to .trash

- a system bin that refuses (throws) sends the note to the vault's .trash instead

**M186** - a vault whose "Deleted files" was never changed loses notes deleted elsewhere for good

- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable

**M187** - on an Obsidian without the preference lookup, every deletion from another device fails

- a note deleted on another device goes where "Deleted files" says: unreadable

**M188** - the removal's hidden folder can be swapped for a link and the vault's deletion follows it out of the vault

- a hidden folder swapped for a link refuses the removal

**M189** - every deletion from another device leaves an empty hidden folder behind in the note's folder

- a native move preserves an edit arriving inside the trash operation
- an ordinary native move drops its hold and leaves the copy behind
- a restore that lands nowhere keeps the hold rather than releasing it
- review: a blocked restore retains the only hold containing the later edit
- review: a descriptor save after the final hold stat remains reachable
- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a note deleted on another device goes where "Deleted files" says: "none"
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead
- a hidden folder something else wrote into is kept, and reported
- a tombstoned note takes the real directory it emptied, and stops at one that is not empty

**M190** - a removal the filesystem refuses leaves an empty hidden folder behind

- a move refused with EXDEV removes nothing, and the note survives the window

**M191** - a save that stopped a removal leaves an empty hidden folder behind once the note is put back

- a save that replaces the source between the hold and the removal is preserved
- a replacement that lands before the move is put back, not removed
- an in-place save before the move is put back, not removed

**M192** - the log no longer says which bin a note deleted on another device went to

- a note deleted on another device goes where "Deleted files" says: "local"
- a note deleted on another device goes where "Deleted files" says: "system"
- a note deleted on another device goes where "Deleted files" says: never set
- a note deleted on another device goes where "Deleted files" says: unreadable
- a note deleted on another device goes where "Deleted files" says: "none"
- a system bin that refuses (false) sends the note to the vault's .trash instead
- a system bin that refuses (throws) sends the note to the vault's .trash instead

**M193** - with "Deleted files" set to the vault's .trash, a note deleted elsewhere goes to the system Trash instead

- a note deleted on another device goes where "Deleted files" says: "local"
- a hidden folder something else wrote into is kept, and reported

**M194** - with "Deleted files" set to delete permanently, a note deleted elsewhere still goes to the system Trash

- a note deleted on another device goes where "Deleted files" says: "none"
- a tombstoned note takes the real directory it emptied, and stops at one that is not empty
- a vault that does not know the path falls back to the adapter, not to a folder delete

**M195** - a hidden folder left behind after a removal is left without a word in the log

- a hidden folder something else wrote into is kept, and reported

**M196** - leaving the server address field adopts nothing

- asynchronous settings handlers surface storage failure without an unhandled rejection
- a bare host name becomes an https URL; an explicit scheme is kept; mobile refuses http
- plain http is refused on every platform, loopback on a desktop excepted
- an address typed one key at a time is adopted once, when the field is left or Settings closes

**M197** - a field nobody typed into is adopted and saved again

- an address typed one key at a time is adopted once, when the field is left or Settings closes

**M200** - a folder renamed in Finder with Obsidian open is deleted on the other devices and comes back under new ids: the delete no longer waits for its create

- a folder renamed in a file manager is published as moves, keeping every file id (immediate, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (immediate, deletes first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, deletes first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- a note deleted while a move is settling is still published as deleted
- a delete reported for a note that is still there moves nothing, whatever else carries its bytes
- a burst the vault cannot answer for publishes nothing and says so
- a pending change whose note moved before its rename event follows the live note instead of deleting it

**M201** - a note moved in Finder inside the selection loses its history: it is tombstoned and republished under a new file id

- a folder renamed in a file manager is published as moves, keeping every file id (immediate, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (immediate, deletes first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, deletes first)
- a note deleted while a move is settling is still published as deleted
- confirming held deletions never deletes a note that is in the vault under a new name
- a pending change whose note moved before its rename event follows the live note instead of deleting it

**M202** - notes moved out of the folder selection in Finder are deleted on every other device

- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- a small folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- a big folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- confirming held deletions never deletes a note that is in the vault under a new name
- the periodic scan stops offering to delete a held note that is back under a new name

**M203** - a stray delete for a note that is still there hands its identity to an mtime-keeping copy elsewhere

- a delete reported for a note that is still there moves nothing, whatever else carries its bytes

**M204** - two same-size, same-mtime notes moved inside the selection stay on the other devices under their old names too: duplicates

- two moved notes with the same size and mtime are published as both halves, as the scan leaves them

**M205** - a note leaving the selection makes the engine ask the host about a path outside the selection, breaking the scope contract both layers keep

- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- a small folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- a big folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing

**M206** - a folder moved out of the selection in Finder is published as deleted, so the other devices forget its folder records

- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)

**M207** - when the vault index cannot be read, every waiting deletion is published anyway, moved notes included

- a burst the vault cannot answer for publishes nothing and says so

**M208** - an empty folder deleted in Obsidian is never removed from the other devices

- applying a folder tombstone costs the receiving device no request of its own
- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)

**M209** - a folder moved out of the selection in Finder is published as deleted before its notes are found alive

- a folder renamed in a file manager is published as moves, keeping every file id (immediate, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (immediate, deletes first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, deletes first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- a deleted folder takes its tree off the other device, and a sibling survives (desktop to phone)
- a deleted folder takes its tree off the other device, and a sibling survives (phone to desktop)

**M210** - deleting a note whose edit is still waiting to upload shows an error in the status bar

- a note deleted while its push is still queued is published as deleted, not as a failure

**M211** - Confirm deletions deletes notes that are back in the vault under a new name

- confirming held deletions never deletes a note that is in the vault under a new name

**M212** - a folder renamed out of the selection while Obsidian was closed is deleted on the other devices (small) or held for a Confirm that would delete it (big)

- a small folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- a big folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- the periodic scan stops offering to delete a held note that is back under a new name

**M213** - Settings keeps offering to delete notes that are back in the vault under another name

- the periodic scan stops offering to delete a held note that is back under a new name

**M214** - a selected folder renamed while Obsidian was closed is published as deleted, so the other devices forget its folder record

- a small folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- a big folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing

**M215** - moving a folder out of the selection raises one notice per note instead of one naming the count

- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- a small folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- a big folder renamed out of the selection while Obsidian was closed deletes nothing and holds nothing
- a selected folder renamed where no device may sync publishes nothing and says so once

**M216** - a folder moved out of the selection in Finder is published as deleted: the watcher no longer holds it with its notes

- a folder renamed in a file manager is published as moves, keeping every file id (immediate, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (immediate, deletes first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, deletes first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (creates first)
- Projects/Alpha moved out of the selection in a file manager deletes nothing anywhere and says so once (deletes first)
- a deleted folder takes its tree off the other device, and a sibling survives (desktop to phone)
- a deleted folder takes its tree off the other device, and a sibling survives (phone to desktop)

**M217** - with hidden paths in the index, a note deleted into Obsidian's .trash counts as moved there and its deletion never reaches the other devices

- the real host's inventory is Obsidian's index: every canonical path, no hidden one, no I/O
- the vault listing drops what this device may not sync

**M218** - a moved note can take over the identity of another note that is already synced

- a narrowed selection measures the share against the notes it selects
- Sync now with a hold pending publishes none of it, and says the hold is still waiting
- a deleted note never takes over the identity of a synced note with the same size and mtime

**M219** - one Finder move is decided several times over, one decision line per deleted note

- a folder renamed in a file manager is published as moves, keeping every file id (immediate, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (immediate, deletes first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, creates first)
- a folder renamed in a file manager is published as moves, keeping every file id (deferred, deletes first)

**M220** - a locked note, a read-only folder, a full disk or a missing chunk stops every later change from arriving again

- a fast editor retry leaves a locked file on its normal backoff and visible error
- a locked note is parked: every later change arrives, and the status names the file, never offline
- a read-only folder parks only its own notes, and Sync now applies them once it is writable
- a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted
- a chunk missing on the server parks its file, and it arrives once a device restores the chunk
- a parked record survives a restart and applies at the next start
- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest
- a retry pass waits for the feed page in flight: the two never apply side by side
- every refusal a disk can make is parked in plain words; any other failure is not
- a chunk missing from a batch fetch parks its file exactly as a missing single chunk does
- the status names a parked file first, then a note waiting on its push, then idle
- an entry this device parked moves the mark, so the next start finds the journal as it left it (\#144, \#145)
- a restore is answered one pull at a time, never beside a parked record's retry (\#144, \#145)

**M221** - a large file whose chunks the server lost stalls the whole feed again, fetched in batches

- a chunk missing from a batch fetch parks its file exactly as a missing single chunk does

**M222** - a parked file with a damaged reason is named as "Cannot write X here: undefined"

- a parked entry in the data file is input: a file id and a vault path, or it is dropped

**M223** - a data file can point a parked retry at any server route instead of a file id

- a parked entry in the data file is input: a file id and a vault path, or it is dropped

**M224** - a data file can name a parked file outside the vault, and the status bar shows it

- a parked entry in the data file is input: a file id and a vault path, or it is dropped

**M225** - an unreachable server parks every record it could not fetch instead of waiting for the network

- a failed editor retry keeps its durable wait and recovers automatically
- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest
- a server that cannot be reached is not a per-record failure: nothing is parked and the feed waits

**M226** - a parked attachment deleted on another device stays named in the status bar until the next slow retry

- a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted

**M227** - every change the feed applies asks the server about its file again and logs a bogus release

- an EMPTY folder renamed by case while Obsidian was closed survives on both devices
- a folder kept because it was not empty can still be deleted here afterwards
- a locked note is parked: every later change arrives, and the status names the file, never offline
- a echo version supplies no pre-write arrival evidence
- a invalid version supplies no pre-write arrival evidence

**M228** - every retry of a parked file raises another notice

- a locked note is parked: every later change arrives, and the status names the file, never offline
- a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted

**M229** - a push turns the status bar back to idle while a file is still parked (the S74 flicker)

- a locked note is parked: every later change arrives, and the status names the file, never offline
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back

**M230** - the status bar reads idle right after the feed parks a file

- a file left with two heads, or a note whose push is not in flight, comes to rest
- an active editor stays pending, other notes arrive, and its latest head retries without another save
- a locked note is parked: every later change arrives, and the status names the file, never offline
- a read-only folder parks only its own notes, and Sync now applies them once it is writable
- a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted
- a chunk missing on the server parks its file, and it arrives once a device restores the chunk
- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest
- the status names a parked file first, then a note waiting on its push, then idle
- a note counted while its debounce was in flight stops counting when that debounce pushes nothing

**M231** - a full disk re-downloads the parked file every minute, forever

- a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted
- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest

**M232** - the wait between retries grows without bound, so a fixed file can wait for hours

- a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted

**M233** - every park arms another timer, so several parked files are downloaded many times over

- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest

**M234** - a file parked again later waits as long as the last episode's backoff had grown, not one minute

- a locked note is parked: every later change arrives, and the status names the file, never offline

**M235** - a retry pass writes files while the feed is still writing its own, side by side

- a retry pass waits for the feed page in flight: the two never apply side by side
- a restore is answered one pull at a time, never beside a parked record's retry (\#144, \#145)

**M236** - after one network failure the feed never applies another change

- a server that cannot be reached is not a per-record failure: nothing is parked and the feed waits

**M237** - with the server out of reach, a retry pass knocks once for every parked file instead of stopping

- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest

**M238** - one parked file the server refuses stops every other parked file from being retried, and Sync now fails

- several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest

**M239** - every start and every Sync now writes a retry summary and a state save with nothing parked

- a read-only folder parks only its own notes, and Sync now applies them once it is writable

**M240** - a device syncing selected folders measures the bulk-deletion share against every record it kept, so 12 of 20 selected notes gone is deleted everywhere

- a narrowed selection measures the share against the notes it selects

**M241** - a Sync now after some held notes come back re-derives the hold and publishes the rest without the user's word

- a pending hold is never published by a pass, even once fewer than half are missing

**M242** - a Sync now that lets go of held notes that came back logs nothing about them

- Sync now with a hold pending publishes none of it, and says the hold is still waiting

**M243** - Sync now with deletions held back says nothing about them

- Sync now with a hold pending publishes none of it, and says the hold is still waiting
- a pending hold is never published by a pass, even once fewer than half are missing

**M244** - a Sync now that finds a bulk deletion shows two notices about the one hold it just took

- a pending hold is never published by a pass, even once fewer than half are missing

**M245** - a deletion whose first send was lost is re-sent without asking whether the note is back, deleting a restored note everywhere

- a lost deletion is sent again only while the note is still gone
- a lost deletion is not sent again once the note is back on the disk
- a lost deletion is not sent again once another device's change brought the note back
- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name
- a lost deletion is not sent again once the note has moved past the version it was decided from

**M246** - a lost deletion is re-sent after another device's rename was pulled in, deleting the renamed note and forking it on the server

- a lost deletion is not sent again once another device's change brought the note back
- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name
- a lost deletion is not sent again once the note has moved past the version it was decided from

**M247** - a lost deletion decided from an older version is re-sent after the note moved on and was deleted again, forking the file on the server

- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name
- a lost deletion is not sent again once the note has moved past the version it was decided from

**M248** - a lost deletion is re-sent although the note is back on the disk

- a lost deletion is not sent again once the note is back on the disk

**M249** - the deleting device says a note is back when it is not on this device

- a lost deletion is not sent again once the note has moved past the version it was decided from

**M250** - the device that deleted a note says nothing when another device's change brings it back

- a lost deletion is not sent again once another device's change brought the note back
- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name

**M251** - a withdrawn deletion surfaces as a sync error instead of the note simply staying

- a lost deletion is not sent again once the note is back on the disk
- a lost deletion is not sent again once another device's change brought the note back
- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name
- a lost deletion is not sent again once the note has moved past the version it was decided from

**M252** - a deferred settlement of a published edit says it was not uploaded

- a deferred settlement describes an already-published edit truthfully and retries quietly (\#178)

**M253** - a device whose unpublished changes were kept says they are already on the server, which is false

- a tombstone whose revive cannot publish keeps the file and says only that

**M254** - a deletion whose first send was lost is never sent again, even though the note is still gone

- a lost deletion is sent again only while the note is still gone

**M260** - a record sealed under another vault key stops the feed again: every later change waits behind it under 'offline'

- a invalid version supplies no pre-write arrival evidence
- records sealed under another vault key are skipped by name, and the feed keeps receiving (\#140)

**M261** - one notice per unreadable file instead of one per device: a key change on one computer floods the others with notices

- records sealed under another vault key are skipped by name, and the feed keeps receiving (\#140)

**M262** - the unreadable-changes notice no longer says which device to fix

- records sealed under another vault key are skipped by name, and the feed keeps receiving (\#140)

**M263** - Restore accepts another vault's phrase and refuses this vault's own

- a phrase that opens nothing on this server is refused before it replaces the key (\#140)
- a server holding only a vault's map still has a vault to strand, and one holding none has not (\#140)

**M264** - a server with no vault yet counts as one: any phrase restored there is refused

- any phrase is restored where there is no vault to strand (\#140)
- a server holding only a vault's map still has a vault to strand, and one holding none has not (\#140)

**M265** - a device with no credential cannot restore its phrase before setup: the check asks a server it cannot sign for

- a current recovery dialog persists its derived key before reporting success
- new-key dialog handles a rejected save without showing recovery or an unhandled rejection
- a current new-key dialog persists the key before showing its recovery phrase
- closing during the Restore save retains its dispatched write without late dialog success
- closing during the Create a new vault key save retains its dispatched write without late dialog success
- any phrase is restored where there is no vault to strand (\#140)

**M266** - Restore with another vault's phrase replaces the key again, and a second domain map strands every other device

- a phrase that opens nothing on this server is refused before it replaces the key (\#140)

**M267** - Create a new vault key replaces the key at once on a server that holds a vault, with no question

- Create a new vault key on a server that holds a vault asks first, and Cancel keeps the key (\#140)
- confirming Create adopts exactly the key that was checked (\#140)
- Create on a server with no vault asks nothing, and Restore goes through the check (\#140)

**M268** - Cancel is no longer the default in a confirmation: Enter may take the destructive answer

- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing
- Create a new vault key on a server that holds a vault asks first, and Cancel keeps the key (\#140)

**M269** - closing a confirmation with Cancel or Escape answers nothing, and pairing hangs for ever

- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing
- Create a new vault key on a server that holds a vault asks first, and Cancel keeps the key (\#140)

**M270** - a second vault's notes are uploaded into the server's vault without a question (the count is ignored)

- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- answering Pair and upload keeps the key and starts the first sync

**M271** - a byte-identical copy of the vault is asked before pairing, as if it were another vault

- a claimant waits on its envelope, then saves the approved key before restarting sync
- sync stays stopped while the approved key save is pending
- a rejected approved-key save never starts sync
- a superseded key save completion cannot adopt credentials or restart the replacement session
- closing during an already-dispatched envelope preserves its key without starting another session
- an enrolled device whose key never arrived may pair again

**M272** - cancelling a second vault's pairing leaves an enrolled device with no key behind on the server

- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves

**M273** - Pair this device, or a pairing link, silently replaces the identity of a device that syncs

- a device that already syncs refuses a pairing code, even its own, and claims nothing

**M274** - a device whose key never arrived cannot pair again either: the guard refuses every enrolled device

- an enrolled device whose key never arrived may pair again

**M275** - a note with the same name and size but other bytes counts as already in the vault, so a second vault can pair unasked

- a claimant counts the notes the server's vault does not hold, byte for byte, and posts nothing (\#141)

**M276** - a copy of the vault holding a file above the chunk ceiling is asked before pairing, as if it were another vault

- a claimant counts the notes the server's vault does not hold, byte for byte, and posts nothing (\#141)

**M277** - a device revoked elsewhere cannot leave, so it can never pair again

- a device revoked elsewhere leaves locally, which is its way back to pairing (\#143)

**M278** - a device the server no longer knows cannot leave, so it can never pair again

- a server that does not know this device is offered a local leave, never taken unasked (\#143)

**M279** - First-time setup on a server that holds a vault shows the raw server code instead of 'one server holds one vault'

- Setup on an older server explains already_set_up without exposing the raw code (\#141)

**M280** - every note another device sends to a FAT32 or exFAT vault is refused again (temp_identity), and its temp is left

- a vault on a volume that renumbers a file after its first write receives notes, and keeps no temp

**M281** - a download that stops on a FAT32 or exFAT vault leaves its temp file behind

- a write that stops on such a volume takes its temp with it

**M282** - the writer proves its temp by the name instead of the descriptor, so a temp another process swapped is renamed into the note

- on such a volume a temp swapped after the write is still refused, and nothing lands

**M283** - a conflict copy or restored copy on a volume that renumbers files is refused at its second write

- the create-only writer proves its temp the same way on such a volume

**M284** - a conflict copy or restored copy that stops on a volume that renumbers files leaves its temp behind

- the create-only writer proves its temp the same way on such a volume

**M285** - a download's temp gets a visible name again, so a quit mid-download publishes the half-file to every device

- a download's temp is a hidden name: never listed, never a path any device syncs
- the next start removes the temps an interrupted write left, and nothing else

**M286** - a start while a download is under way deletes that download's temp, and the download fails

- the next start removes the temps an interrupted write left, and nothing else

**M287** - the start-up clean-up deletes temps that downloads in progress still hold

- the next start removes the temps an interrupted write left, and nothing else

**M288** - temps left by a quit are never removed

- the next start removes the temps an interrupted write left, and nothing else

**M289** - temps a quit left in any folder below the vault root are never removed

- the next start removes the temps an interrupted write left, and nothing else

**M290** - the start-up clean-up removes a link that wears a temp's name

- the next start removes the temps an interrupted write left, and nothing else

**M291** - a restored copy's temp left by a quit is never removed

- the next start removes the temps an interrupted write left, and nothing else

**M292** - the start-up clean-up deletes a hold, which may be the last name of a save

- the next start removes the temps an interrupted write left, and nothing else

**M293** - every start logs a clean-up line even when there was nothing to clean

- the next start removes the temps an interrupted write left, and nothing else

**M294** - no start removes the temps a quit left

- each start clears an interrupted write's leftovers before it lists the vault, and a failed clean-up stops nothing

**M295** - a start whose clean-up meets a file it cannot stat never syncs

- each start clears an interrupted write's leftovers before it lists the vault, and a failed clean-up stops nothing

**M296** - a second save of the same size inside a coarse mtime step is never sent

- a second save of the same size inside one coarse mtime step is still sent

**M297** - every quick push on any filesystem reads the file a second time

- a file whose modification time can still move is never read twice

**M298** - a whole-second file pushed long after its save is read again and again

- a case-only folder rename the desktop publishes leaves the phone one folder
- a case-only folder rename the desktop only DISCOVERS leaves the phone one folder
- a case-only rename on the phone reaches the case-insensitive desktop as one entry
- a case-only rename of a SELECTED folder publishes moves, not new notes
- a case-only rename of a SELECTED folder reaches a folding receiver as one folder
- a case-only rename of the folder a device SELECTS is applied there, and the selection follows
- a case-only rename of a subfolder of the selected folder still carries its record
- a re-case of an ANCESTOR of the selected folder is refused, and nothing is published back
- a folder record's hold survives a restart: the post is still in flight when it starts again
- a folder record's hold survives a restart: the post failed while it was stopped
- a folder record's hold survives a restart: the plugin reloaded and a new engine took over
- two engines that merge one note identically end on ONE version
- the engine queues, debounces and pushes what the watcher reports
- a second save of the same size inside one coarse mtime step is still sent
- a file whose modification time can still move is never read twice
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a swap that also edits a note converges when the phone's vault reports its own writes late
- engine shares one repair worker and stopAndWait drains a held PUT before reload
- engine cancellation releases a held metadata read without allowing any subsequent source work
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after

**M299** - a file stamped with a whole second in the future schedules a re-read a day away

- a file whose modification time can still move is never read twice

**M300** - a pull's own move on desktop is decided as a deletion of the note it moved, logged as removed

- a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (immediate vault events)
- a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (deferred vault events)

**M301** - a note typed where a pulled rename left, then deleted, is never deleted on the other devices

- a note typed where a pulled rename left, and deleted, is deleted everywhere though the move's delete never came

**M302** - Enter in a confirmation dialog revokes the device or replaces the vault key, because the action is the first button Obsidian focuses

- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing
- Create a new vault key on a server that holds a vault asks first, and Cancel keeps the key (\#140)

**M303** - the note a withdrawn deletion left at its own name is announced as back "as" that same name

- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name

**M304** - a device that left the server locally logs it as a refusal

- the last active device may still leave locally, and is told the server kept it
- a server that does not know this device is offered a local leave, never taken unasked (\#143)

**M305** - merges of two merges of one pair are never merged again, so two people typing on different lines of one note get a conflict copy

- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- merges of merges of one pair merge again, three levels down and no further

**M306** - a criss-cross is followed one level deeper than the bound, so another device's version graph decides how much this device downloads and holds

- merges of merges of one pair merge again, three levels down and no further

**M307** - a ceiling is kept per keystroke, so a typo like "1 MX" leaves a one-byte ceiling that makes every new note remote-only

- a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling

**M308** - a kept ceiling is not saved, so a restart reads "unlimited" again

- a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling

**M309** - a chunk the server lost is announced as something this device cannot write

- a chunk missing on the server parks its file, and it arrives once a device restores the chunk

**M310** - a note open and being typed in is deleted from under the cursor when another device deletes it

- a note open on the desktop and typed in survives a deletion on the other device (unsaved editor)
- a note open on the desktop and typed in survives a deletion on the other device (saved editor)
- a note open on the phone and typed in survives a deletion on the other device (unsaved editor)
- a note open on the phone and typed in survives a deletion on the other device (saved editor)
- an open note holding unsaved typing is kept however long ago it was published (desktop)
- an open note published from here within the window is kept, to its last millisecond (desktop)
- an open note holding unsaved typing is kept however long ago it was published (mobile)
- an open note published from here within the window is kept, to its last millisecond (mobile)

**M311** - typing still only in the editor is lost when the note's last save was not published in the last few seconds

- an open note holding unsaved typing is kept however long ago it was published (desktop)
- an open note holding unsaved typing is kept however long ago it was published (mobile)

**M312** - a note being typed in is deleted from under the cursor in the pause just after a save

- a note open on the desktop and typed in survives a deletion on the other device (saved editor)
- a note open on the phone and typed in survives a deletion on the other device (saved editor)
- an open note published from here within the window is kept, to its last millisecond (desktop)
- an open note published from here within the window is kept, to its last millisecond (mobile)

**M313** - a note merely open on this device, never edited here, can no longer be deleted from another device

- a deletion applies once the last save is past the window, or without an editor (desktop)
- a deletion applies once the last save is past the window, or without an editor (mobile)

**M314** - a note open on this device and edited once can no longer be deleted from another device for the rest of the session

- a deletion applies once the last save is past the window, or without an editor (desktop)
- a deletion applies once the last save is past the window, or without an editor (mobile)

**M315** - keeping an open note republishes this device's older text over the other device's newer edit

- a deletion past a version this device never applied publishes nothing older over it

**M316** - a note that is not open anywhere is kept, not deleted, when this device edited it seconds ago

- a deletion applies once the last save is past the window, or without an editor (desktop)
- a deletion applies once the last save is past the window, or without an editor (mobile)
- a deletion the user makes after a pull-applied move is still published
- a note typed where a pulled rename left, and deleted, is deleted everywhere though the move's delete never came
- a note typed where a pull trashed one is still deleted when the user deletes it
- a note renamed onto it where a pull trashed one is still deleted when the user deletes it
- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)

**M317** - the log no longer says how old the last edit of an open note was, or the window, when its deletion applies

- a deletion applies once the last save is past the window, or without an editor (desktop)
- a deletion applies once the last save is past the window, or without an editor (mobile)

**M319** - a note being typed in is deleted from under the cursor in the pause just after a save (the save is never remembered)

- a note open on the desktop and typed in survives a deletion on the other device (unsaved editor)
- a note open on the desktop and typed in survives a deletion on the other device (saved editor)
- a note open on the phone and typed in survives a deletion on the other device (unsaved editor)
- a note open on the phone and typed in survives a deletion on the other device (saved editor)
- the push queue remembers only the publications the window can still read

**M320** - the plugin's memory of recent saves grows with every note it publishes, for the life of the plugin

- the push queue remembers only the publications the window can still read

**M321** - a note saved all day at the front of the memory stops every older save behind it from being forgotten

- the push queue remembers only the publications the window can still read

**M322** - a note whose tab Obsidian has not loaded yet counts as an open editor, so its deletion fails or is refused

- the host says no editor for another note's editor, or a leaf that is not loaded

**M323** - any note open in any editor keeps every other note from being deleted by another device

- the host says unsaved when an editor on the note would write what its file does not
- the host says no editor for another note's editor, or a leaf that is not loaded

**M324** - a note with Windows line endings open on this device can never be deleted from another device

- the host says saved when every editor on the note holds its file, line endings aside

**M325** - typing in one of two panes open on the same note is lost when another device deletes it

- the host says unsaved when an editor on the note would write what its file does not

**M330** - a note that landed beside its name never moves when the version that frees the name arrives, so a swap stays split

- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id higher)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a move to the freed name that fails is logged, and the version that freed it stays applied
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken

**M331** - a note waiting beside its name never takes it when this device's own user frees it

- a swap that also edits a note converges when the phone's vault reports its own writes late
- a note beside its name takes it at the next scan once this device's own user frees it

**M332** - a swap leaves both notes waiting at each other's name, so the two devices show them under opposite names for good

- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id higher)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken

**M333** - a note that owns its name is moved to a conflict name whenever another note waits for it

- a note renamed onto a name the other device just made offline ends under one name per note on both (higher id)
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken
- a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name

**M334** - a swap that also edits a note moves it before the vault reports the write, and the phone publishes one note's record over the other's text

- a swap that also edits a note converges when the phone's vault reports its own writes late
- a copy beside its name waits for the vault to report its write before it moves

**M335** - a note the user is typing into is moved to another name under them

- a copy beside its name that holds an unpushed edit stays where it is
- a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name

**M336** - a note the user is typing into is moved to a conflict name when another note wants its place

- a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name

**M337** - a swap stays split whenever a conflict copy from this device already has the first parking name

- the note waiting at a name steps aside to the next free name when the first is taken

**M338** - one rename the disk refuses stops the device receiving any change

- a move to the freed name that fails is logged, and the version that freed it stays applied

**M339** - a note that has taken its name still counts as waiting, so it can be moved off it again

- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id higher)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a note beside its name takes it at the next scan once this device's own user frees it
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a copy beside its name waits for the vault to report its write before it moves
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken

**M340** - a device that only applied a swap publishes its own moves back as renames

- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id higher)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a note beside its name takes it at the next scan once this device's own user frees it

**M341** - a note renamed onto a name the other device just made offline keeps two names for good

- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)

**M342** - a swap moves the note it waits on to a conflict name and publishes that, instead of waiting for it to leave

- a case-only move is refused, not forced, when another file wears the destination
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken
- a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name

**M343** - a rename onto a just-made name moves the wrong note aside, so the two devices name both notes differently

- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)

**M344** - a note landed beside its name forgets the name, so it stays at the old one for good

- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (immediate vault events, draft id higher)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id lower)
- two notes whose names are swapped in one call show the same names on both devices (deferred vault events, draft id higher)
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)
- a swap that arrives as two versions ends with each note under its new name
- the note waiting at a name steps aside to the next free name when the first is taken
- a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name

**M345** - a conflict copy never takes its name when the note holding it goes, and the repair pass reports it as a mismatch

- a note beside its name takes it at the next scan once this device's own user frees it
- a note waiting beside its name is repaired like any other, never reported as a mismatch
- a copy beside its name takes it as soon as the note holding the name is renamed away
- a move to the freed name that fails is logged, and the version that freed it stays applied
- a copy beside its name waits for the vault to report its write before it moves

**M346** - an edit to a note waiting beside its name is never written, and the old text stays under the new version

- a native settled write records the metadata of the bytes it committed
- control: a native settled copy protects a save made after commit returns
- a second version with the same size and modification time still reaches the vault
- a swap that also edits a note converges when the phone's vault reports its own writes late
- a later version of the other note lands on its own name, not on a new copy
- a note that cannot be published keeps both, and the copy is still recorded
- a save that lands on a settled copy as it is written is not recorded as that version

**M347** - after a rename onto a just-made name, one note is published under the other's file id and its text replaces the other's on the other device

- a locked note is parked: every later change arrives, and the status names the file, never offline
- a note renamed onto a name the other device just made offline ends under one name per note on both (lower id)

**M348** - a note beside its name puts "Server repair could not verify a retained file ... check connectivity" on the status bar

- a note waiting beside its name is repaired like any other, never reported as a mismatch

**M349** - an edited data file can name a path outside the vault as the name a note is moved to

- a remembered waiting name survives a load only when it is a vault path

**M350** - a folder the vault does not have is saved without a question, and nothing syncs

- a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing
- a folder typed in another case is saved the way the vault spells it, and the person is told

**M351** - `notes` typed for the real `Notes` is saved as typed, and a Mac republishes the folder with older text

- a folder typed in another case is saved the way the vault spells it, and the person is told

**M352** - a FILE's name typed as a folder is saved without a question, and nothing syncs

- a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing

**M353** - a folder the vault holds, accented and made in Finder, is asked about as if it were missing

- a folder typed in another case is saved the way the vault spells it, and the person is told

**M354** - an empty selection is saved with a bare "saved" and nothing says that nothing syncs

- an empty selection is saved and says that nothing syncs

**M355** - a hidden folder is refused with the jargon "refused: not a vault path (hidden_segment)"

- a hidden folder is refused in plain words, before any question, with the refusal's code in the log

**M356** - a refused selection leaves no refusal code in the log, so nobody can tell which rule refused it

- a hidden folder is refused in plain words, before any question, with the refusal's code in the log

**M357** - `notes` is quietly saved as `Notes` and the person is never told

- a folder typed in another case is saved the way the vault spells it, and the person is told

**M358** - Cancel on "not a folder in this vault" saves the folder anyway

- a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing
- a folder typed in another case is saved the way the vault spells it, and the person is told

**M359** - `1 MB` in a download ceiling is dropped without a word and reads "unlimited" after a restart

- a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling
- a download ceiling takes decimal and binary units, and an unreadable one is refused out loud, never dropped

**M360** - `1 MB` is kept as 1 MiB, so a ceiling holds 48,576 bytes more than was typed

- a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling
- a download ceiling takes decimal and binary units, and an unreadable one is refused out loud, never dropped

**M361** - an unreadable ceiling such as `1 MX` is dropped without a word

- a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling
- a download ceiling takes decimal and binary units, and an unreadable one is refused out loud, never dropped

**M362** - a refused ceiling stays on screen as if it were kept

- a download ceiling takes decimal and binary units, and an unreadable one is refused out loud, never dropped

**M363** - the desktop scan walks a selection typed `notes` into the real `Notes` and republishes its notes with older text

- a selected folder typed in another case than the vault's is never walked, so nothing is published: 0 pushes

**M364** - a device that syncs no folders reads a bare `obsync: idle`

- a device that syncs no folders says so in the status bar, not a bare idle (\#150)

**M365** - the status bar keeps saying `idle` after an empty selection is saved, until something else redraws it

- a device that syncs no folders says so in the status bar, not a bare idle (\#150)

**M366** - a folder Save shows "Waiting for transfers..." for up to 55 s with nothing transferring

- an updated paired device registers recovery before its last credential leaves
- an old server without recovery registration can still sync while its last-device safeguard remains
- two devices settling the same overlap publish one shared conflict-copy version
- stopping clears an active-editor retry before it can write
- an active-editor wait resumes after restarting with an advanced feed cursor
- stopping for a folder change never waits out a long poll that moves nothing, and its late answer writes nothing
- an engine started again after a stop runs one feed, never the stopped poll's as well
- a synced file whose record was lost is adopted at startup, never published under a new id (\#181)
- an own version whose file id is recorded at another name is not adopted a second time (\#181)
- a feed that cannot be read at startup costs a new id, never the file (\#181)
- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a later arrival cannot erase the verdict on a waiting local save (typed: true)
- arrival bookkeeping cannot classify unchanged bytes as a local rewrite
- arrival bookkeeping cannot classify missing bytes as a local rewrite
- arrival bookkeeping cannot classify replaced bytes as a local rewrite
- arrival bookkeeping cannot classify outside bytes as a local rewrite
- arrival bookkeeping does not inspect an old path outside the selected folders
- a echo version supplies no pre-write arrival evidence
- a invalid version supplies no pre-write arrival evidence
- a nested version supplies no pre-write arrival evidence
- a host plugin can recognize an arrival before the incoming write returns
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M367** - a long poll answered after a stop saves the state, over what a reloaded plugin already holds

- stopping for a folder change never waits out a long poll that moves nothing, and its late answer writes nothing

**M368** - an engine started again runs its stopped feed beside the new one, two polls on one cursor

- an engine started again after a stop runs one feed, never the stopped poll's as well

**M369** - a folder Save no longer waits for the change being downloaded, and the new selection races it

- a stopped feed checkpoints only the change it actually finished applying

**M370** - a journal restored behind this device's cursor is read as a live one

- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M371** - another version where this device's last entry was is not noticed: the restored server's new notes are skipped

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)
- a change another device made on the restored server is kept, never replaced by the one re-sent over it
- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M372** - a version where this device read none after its last entry is not noticed

- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M373** - an old entry retention pruned is taken for a proved restore

- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M374** - a device started after the restore never asks: it skips what was written there and never re-sends

- a change another device made on the restored server is kept, never replaced by the one re-sent over it
- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)
- a device updated from 1.1.2 has no mark: no probe, and its first feed entry writes one (\#145)
- an entry this device parked moves the mark, so the next start finds the journal as it left it (\#144, \#145)

**M375** - a device that reconnects after the restore never asks again

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)
- a restore is answered one pull at a time, never beside a parked record's retry (\#144, \#145)

**M376** - the rebuilt journal's replay re-applies yesterday: deleted notes come back

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a deletion this device published or applied is re-sent to a restored server, note and folder alike (\#145)

**M377** - a version the server still holds is re-sent as lost, forking a note on every device

- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)

**M378** - a note kept behind a move out of the selection is re-sent over its newer history

- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)

**M379** - a record from before 1.1.3, whose place is unknown, is re-sent over newer history

- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)

**M380** - a note retention buried long ago is resurrected on a mere suspicion

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)
- the check re-sends only what it can prove lost, from parents it can prove this device processed (\#145)
- a rename above a selected folder moves the selection with it, persists it, and widens nothing

**M381** - a lost version is re-sent with no parents beside another device's re-send

- the check re-sends only what it can prove lost, from parents it can prove this device processed (\#145)

**M382** - a re-send names the lost version as its parent and forks every note it re-sends

- Resume refuses to silently consume a foreign live head
- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)
- the check re-sends only what it can prove lost, from parents it can prove this device processed (\#145)

**M383** - two devices re-sending one lost version publish two, and the note forks

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)

**M384** - the journal is not re-read after a restore: notes written on the restored server never arrive

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)
- a change another device made on the restored server is kept, never replaced by the one re-sent over it

**M385** - a version the restored server lost is the old read_or_write_failed repair error again

- a recorded version a restored server no longer holds is re-sent, never a could-not-verify error (\#145)
- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)

**M386** - a deletion this device applied is not remembered, and comes back after a restore

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a deletion this device published or applied is re-sent to a restored server, note and folder alike (\#145)

**M387** - a deletion this device made is not remembered, and comes back after a restore

- a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)
- a deletion this device published or applied is re-sent to a restored server, note and folder alike (\#145)

**M388** - this device's own changes never learn their server time and are never re-sent

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)
- a deletion this device published or applied is re-sent to a restored server, note and folder alike (\#145)

**M389** - a record keeps a version the server lost over the identical head it holds

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a record naming a version the server no longer holds takes the identical head it does hold (\#145)

**M390** - an edit of a twin the other device never retired is copied beside the note again, and the split never heals

- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired

**M391** - an edit whose parent sat at another name is taken for this note, and this note's id is retired

- an edit that is not provably of this very note keeps both, and retires nothing

**M392** - an edit of a DIFFERENT note, or one arriving over an unpushed edit, replaces the note here

- an edit that is not provably of this very note keeps both, and retires nothing

**M393** - an edit whose parent this vault cannot read is refused outright instead of kept beside the note

- an edit that is not provably of this very note keeps both, and retires nothing

**M394** - the note takes the twin's edit but stays recorded under the id this device retires

- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired

**M395** - the healed pair leaves this device's duplicate id live on the server

- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired

**M396** - the twin's edit is recorded here without being written, so the note keeps the old text

- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired

**M397** - the retirement names a version this device never held, so it no longer forks where the id moved on

- mixed versions: the older device's edit settles the pair on its id, with no copy
- an update in place: once the older device runs this version, the newer device's edit settles the pair too
- an edit of the twin is taken as an update, from either side, and only this device's id is retired

**M410** - the breaker, tripped, still merges: a loop that merges is never stopped

- merges that rewrite the note with nothing typed here still trip the breaker

**M411** - a note left for this device's own push is not counted as waiting, so the status reads idle over two different notes

- a version arriving over an unpushed edit is merged by that edit's push, not copied
- a save landing while a merge downloads is not written over
- the status names a parked file first, then a note waiting on its push, then idle
- an unflagged overlap over an unpushed typed edit waits for its publication

**M412** - text typed on top of the losing head is recorded as already published, and never reaches the other device's copy

- text typed on top of the losing head is published as the copy's next version

**M413** - an unmergeable version over an unpushed edit is copied at once, so one fork costs two copies

- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- an unflagged overlap over an unpushed typed edit waits for its publication

**M414** - the losing device's own note is written into a copy sized for the losing version, and refused

- text typed on top of the losing head is published as the copy's next version

**M415** - an edit arriving for a note deleted here is refused as if the deletion were a save, and the deletion then forks the note

- a note deleted here and edited elsewhere before the deletion is sent comes back with the edit
- a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name
- a lost deletion is not sent again once the note has moved past the version it was decided from
- arrival bookkeeping cannot classify missing bytes as a local rewrite

**M416** - a note whose push never comes keeps the status reading syncing for good

- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- a file left with two heads, or a note whose push is not in flight, comes to rest
- a note counted while its debounce was in flight stops counting when that debounce pushes nothing

**M417** - a note waiting on its push hides a parked file the user has to act on

- a fast editor retry leaves a locked file on its normal backoff and visible error
- the status names a parked file first, then a note waiting on its push, then idle

**M418** - a note whose push is still in its debounce is dropped from the count, and the status reads idle over two different notes

- the status names a parked file first, then a note waiting on its push, then idle
- a note counted while its debounce was in flight stops counting when that debounce pushes nothing

**M419** - a note counted while only its echo was settling keeps the status reading syncing for good

- two devices appending on the same line converge with every keystroke once and no copies
- a note counted while its debounce was in flight stops counting when that debounce pushes nothing

**M420** - a folder inside a synced vault pairs with the same server anyway

- a vault inside a vault that syncs with obsync refuses to pair before any request (\#180)

**M421** - first-time setup inside a synced vault spends the setup token and enrols the device

- first-time setup inside a synced vault refuses before the setup request (\#180)

**M422** - a vault inside a synced vault that was paired before the check starts syncing

- a vault paired before the check existed stops at every start inside a synced vault, with one notice (\#180)

**M423** - a synced vault two folders above this one goes unnoticed, and the inner vault pairs

- the ancestor check finds this plugin above the vault root, and nothing else (\#180)

**M424** - any Obsidian vault above, with any plugin at all, counts as a synced vault and refuses pairing

- the ancestor check finds this plugin above the vault root, and nothing else (\#180)

**M425** - every note of the nested vault is read and its bytes uploaded before the post is refused

- a folder that is a vault of its own is neither published nor written into, and is named once (\#180)
- on a phone the adapter says which folder is a vault of its own, in both directions (\#180)

**M426** - a rename, a deletion or a folder removal inside the nested vault is published to every device

- notes synced before their folder became a vault of its own are never renamed, deleted or moved out by sync (\#180)

**M427** - another device's new note is written into the nested vault, which publishes it one level deeper

- a folder that is a vault of its own is neither published nor written into, and is named once (\#180)
- on a phone the adapter says which folder is a vault of its own, in both directions (\#180)

**M428** - another device's move carries a note out of the nested vault on this computer

- notes synced before their folder became a vault of its own are never renamed, deleted or moved out by sync (\#180)

**M429** - every note skipped for the nested vault raises its own 'refused a change' notice

- a folder that is a vault of its own is neither published nor written into, and is named once (\#180)
- notes synced before their folder became a vault of its own are never renamed, deleted or moved out by sync (\#180)
- on a phone the adapter says which folder is a vault of its own, in both directions (\#180)

**M430** - every periodic scan lists the nested vault's notes and asks about each one again

- a folder that is a vault of its own is neither published nor written into, and is named once (\#180)

**M431** - the nested vault is announced again with every note that meets it

- a folder that is a vault of its own is neither published nor written into, and is named once (\#180)
- notes synced before their folder became a vault of its own are never renamed, deleted or moved out by sync (\#180)
- on a phone the adapter says which folder is a vault of its own, in both directions (\#180)

**M432** - on a computer, a nested vault directly under the vault root is synced both ways

- a folder that is a vault of its own is neither published nor written into, and is named once (\#180)
- notes synced before their folder became a vault of its own are never renamed, deleted or moved out by sync (\#180)

**M433** - on a phone, the nested vault is synced both ways

- on a phone the adapter says which folder is a vault of its own, in both directions (\#180)

**M434** - a file that merely wears the plugin folder's name makes a vault count as synced

- the ancestor check finds this plugin above the vault root, and nothing else (\#180)

**M435** - a vault inside a synced vault raises its refusal notice again at every start

- a vault paired before the check existed stops at every start inside a synced vault, with one notice (\#180)

**M436** - a path through a symlinked folder is skipped silently instead of refused with a notice

- the reviewer's case: a manifest through a directory symlink writes nothing outside
- a symlink as the final component leaves the file it points at alone
- a symlink in the middle of a nested path is refused
- a symlink pointing INSIDE the vault is refused too: the rule is no symlink components
- a rename whose destination parent is a symlink is refused, and the original stays
- a folder record through a directory symlink creates nothing outside

**M437** - on a phone, the nested folder's own record is still published and applied

- on a phone the adapter says which folder is a vault of its own, in both directions (\#180)

**M438** - a refusal to pair, set up or start inside a synced vault leaves no line in the log

- a vault paired before the check existed stops at every start inside a synced vault, with one notice (\#180)
- first-time setup inside a synced vault refuses before the setup request (\#180)
- a vault inside a vault that syncs with obsync refuses to pair before any request (\#180)

**M440** - a plugin object turned off mid-upload saves its older cursor and records over the session that replaced it

- a plugin object turned off mid-upload never saves over the one turned on after it (\#181)
- a superseded State writes nothing to either store (\#181)
- a plugin object superseded while still loaded stops its engine and says nothing (\#181)

**M441** - a new session reads the data file while the old one's write is still landing, and starts from older records

- the next plugin object reads the data file only after a write already on its way has landed (\#181)

**M442** - a new session cannot see the old session's write in flight, and reads under it

- the next plugin object reads the data file only after a write already on its way has landed (\#181)

**M443** - a replaced session finishing a leave rewrites the native secret its successor holds

- a superseded State writes nothing to either store (\#181)

**M444** - turning the plugin off and on gives each object its own lease, and the old one's late save rolls the new one back

- a plugin object turned off mid-upload never saves over the one turned on after it (\#181)
- the next plugin object reads the data file only after a write already on its way has landed (\#181)
- a superseded State writes nothing to either store (\#181)
- a plugin object superseded while still loaded stops its engine and says nothing (\#181)

**M445** - a session superseded while still loaded shows a storage error and a notice for nothing the user can fix

- a plugin object superseded while still loaded stops its engine and says nothing (\#181)

**M446** - a superseded session's drain logs a teardown save failure that did not happen

- a plugin object turned off mid-upload never saves over the one turned on after it (\#181)

**M447** - a superseded session stops without a word in the log

- a plugin object turned off mid-upload never saves over the one turned on after it (\#181)
- a plugin object superseded while still loaded stops its engine and says nothing (\#181)

**M448** - a synced file whose record was lost is published again under a new file id

- a synced file whose record was lost is adopted at startup, never published under a new id (\#181)

**M449** - bytes typed here are recorded as another device's version of the same size and time, and never uploaded

- another device's version is never adopted by its stat, even at the same name and size (\#181)

**M450** - one file id is recorded at two names, and deleting either deletes both everywhere

- an own version whose file id is recorded at another name is not adopted a second time (\#181)

**M451** - every Sync now reads the whole feed since the cursor again

- a synced file whose record was lost is adopted at startup, never published under a new id (\#181)

**M452** - every start reads the feed even when every name is recorded

- the feed stops on a forgotten credential and never reports a reachable server as offline
- startup engine does not label a foreign renamed manifest as its own echo
- stopping during a feed wait does not acknowledge unapplied metadata
- a synced file whose record was lost is adopted at startup, never published under a new id (\#181)

**M453** - a feed read failing at startup stops sync instead of uploading new files

- a feed that cannot be read at startup costs a new id, never the file (\#181)

**M454** - a retirement no longer names its keeper, and a device with rolled-back records deletes the kept file

- a retirement over a name its keeper holds deletes nothing and forgets only the old id (\#181)

**M455** - a retirement over a file its keeper holds deletes it, as S98 deleted a 1 GiB file

- a retirement over a name its keeper holds deletes nothing and forgets only the old id (\#181)

**M456** - a retirement is withheld because an OLD version of the keeper matched, after the keeper moved on

- a retirement whose keeper no longer holds these bytes is still a deletion (\#181)

**M457** - a keeper this device records elsewhere is recorded at a second name too

- a retirement whose keeper this device records at another name is an ordinary deletion (\#181)

**M458** - a retirement naming a keeper the server does not know stops the feed for good

- a retirement naming a keeper the server does not know is an ordinary deletion, not a stuck feed (\#181)

**M459** - a keeper that is not a file id is put into a request path

- a keeper that is not a file id is refused before any request is made (\#181)

**M460** - a folder this device deleted is not remembered, and comes back after a restore

- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a deletion this device published or applied is re-sent to a restored server, note and folder alike (\#145)

**M461** - a folder deletion this device applied is not remembered, and comes back after a restore

- a deletion this device published or applied is re-sent to a restored server, note and folder alike (\#145)

**M462** - a version where this device read none, with its last entry gone, costs a second read to notice

- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M463** - the mark's version held at another seq is taken for a journal that agrees

- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M464** - a replay already under way is probed against the old journal and started again

- the probe reads the mark once, and a second time only when the mark's own entry is gone (\#145)

**M465** - an entry in the mark's own millisecond, after it, is skipped by the replay

- an entry is behind the mark by the server's time, and by seq within one millisecond (\#145)

**M466** - the graves grow without bound

- graves are capped oldest first, and a file recorded again has none

**M467** - an entry the feed parked does not move the mark: every start reads the journal as rebuilt

- an entry this device parked moves the mark, so the next start finds the journal as it left it (\#144, \#145)

**M468** - a restore's check runs beside a parked record's retry

- a restore is answered one pull at a time, never beside a parked record's retry (\#144, \#145)

**M469** - a page read while a restore was pending is applied before the restore is answered

- a normal restart over history retention pruned sends one probe and publishes nothing (\#145)

**M470** - the ceiling row goes on naming the ceiling it had before the one just kept

- a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling

**M480** - a note two devices' plugins keep rewriting bounces on for as long as both run, a copy and a notice every round

- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input

**M481** - a note someone is typing in, on a line another device also changed, is paused as if a plugin had rewritten it

- a paused note stays paused across a restart and Resume brings it back
- answer flags distinguish actual input from passive buffer lag
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

**M482** - an edit made before another device's version arrived counts as an answer to it, and the note pauses

- two devices resolving one concurrent edit settle instead of looping
- an edit made while this device was closed survives one the other device made to the same note
- mixed versions: the older device's edit settles the pair on its id, with no copy
- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it

**M483** - an edit made exactly five seconds after a sync still counts as an answer, and the note pauses

- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it

**M484** - an editor-typed note pauses after its editor closes because its saved verdict is ignored

- a received hold uses the target note's current answer proof (typing: false)
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back
- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it
- strictly alternating background answers stop without needing a conflicting pair

**M485** - a pulled version with a remote timestamp is mistaken for a local background edit

- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it

**M486** - a paused note keeps taking the other device's versions, and its plugin keeps answering them

- a newly paired device can explicitly Resume a note held before its first download
- a paused note takes no later ordinary feed frame
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M487** - a paused note keeps publishing its local rewrites

- a hold also prevents a new local file at the same path from being pushed
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M488** - a rewrite right after a sync that keeps the note's size and modified time is never sent, and two devices say idle over two notes

- a same-size rewrite that keeps the recorded time right after a sync is still sent

**M489** - every event on a note whose record already describes it is read and sent again, however long after the last sync

- a second save of the same size inside one coarse mtime step is still sent
- a same-size rewrite that keeps the recorded time right after a sync is still sent

**M490** - the status bar reads idle over a note that is paused and no longer syncing

- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back
- the status names a parked file before a paused note, and a paused note before idle
- a resume that cannot reach the server leaves the note paused

**M491** - a restart forgets held notes and restarts their bounce

- a peer hold leaves content alone, says so once, and survives reload
- Show sync status resumes the selected held note through the actual plugin method
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- a received hold uses the target note's current answer proof (typing: false)
- a received hold uses the target note's current answer proof (typing: true)
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a paused note stays paused across a restart and Resume brings it back

**M492** - after a restart the status bar reads idle over a note that is still paused

- the status names a parked file before a paused note, and a paused note before idle

**M493** - leaving a server keeps notes paused that name that server's files

- forgetting a pairing drops the identity and everything derived from it, and nothing else

**M494** - a failed Resume drops the hold

- a peer-held note that changes during Resume stays held
- a detector keeps its hold when a resume backup has no free name
- a detector keeps its hold if a save lands during its resume backup
- a resume that cannot reach the server leaves the note paused

**M495** - Sync now leaves every held note paused

- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M496** - resuming pushes what this device held over the note, forking it again, instead of keeping it beside

- a detector keeps its hold when a resume backup has no free name
- a detector keeps its hold if a save lands during its resume backup
- Resume advances one proven copy and retains older body text in history (retry: false)
- Resume advances one proven copy and retains older body text in history (retry: true)
- an unpublished same-metadata edit of the preserved copy refuses Resume
- a empty preserved-copy head refuses Resume without consuming it
- a split preserved-copy head refuses Resume without consuming it
- a missing preserved-copy head refuses Resume without consuming it
- a edited preserved-copy head refuses Resume without consuming it
- a deleted preserved-copy head refuses Resume without consuming it
- a moved preserved-copy head refuses Resume without consuming it
- a missing local preserved copy is not overwritten by Resume
- a large local preserved copy is not overwritten by Resume
- a identity local preserved copy is not overwritten by Resume
- a metadata save during copy preparation leaves both notes intact
- a same_metadata save during copy preparation leaves both notes intact
- a identity save during copy preparation leaves both notes intact
- an independent head racing the copy publication is retained and leaves the note held
- a growing copy whose last recorded bytes already equal the held snapshot refuses Resume
- a copy removed during publication does not authorize replacing the held note
- Resume selects the copy parent after its older upload has acknowledged
- background Resume preserves its latest snapshot before adopting the single peer branch
- Resume does not select multiple competing heads as the one peer branch
- Resume does not select own competing heads as the one peer branch
- Resume does not select missing competing heads as the one peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M497** - a note the plugin rewrote while paused is taken for unchanged at resume, and what this device held is pushed over the note

- resume fallbacks preserve untracked, deleted, large and unavailable recorded content
- unchanged paused bytes require no backup or server read
- a detector keeps its hold when a resume backup has no free name
- resume refuses a saved record that was deleted, moved, or has multiple chunks
- a detector keeps its hold if a save lands during its resume backup
- Resume advances one proven copy and retains older body text in history (retry: false)
- Resume advances one proven copy and retains older body text in history (retry: true)
- an unpublished same-metadata edit of the preserved copy refuses Resume
- a empty preserved-copy head refuses Resume without consuming it
- a split preserved-copy head refuses Resume without consuming it
- a missing preserved-copy head refuses Resume without consuming it
- a edited preserved-copy head refuses Resume without consuming it
- a deleted preserved-copy head refuses Resume without consuming it
- a moved preserved-copy head refuses Resume without consuming it
- a missing local preserved copy is not overwritten by Resume
- a large local preserved copy is not overwritten by Resume
- a identity local preserved copy is not overwritten by Resume
- a metadata save during copy preparation leaves both notes intact
- a same_metadata save during copy preparation leaves both notes intact
- a identity save during copy preparation leaves both notes intact
- an independent head racing the copy publication is retained and leaves the note held
- a growing copy whose last recorded bytes already equal the held snapshot refuses Resume
- a copy removed during publication does not authorize replacing the held note
- Resume selects the copy parent after its older upload has acknowledged
- background Resume preserves its latest snapshot before adopting the single peer branch
- Resume does not select multiple competing heads as the one peer branch
- Resume does not select own competing heads as the one peer branch
- Resume does not select missing competing heads as the one peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M498** - the stopped-merging notice sends you to update devices that are already up to date

- more than a handful of resolutions of one file in a window stops the merging

**M499** - the verdict kept on every note edited here is never dropped, and grows for as long as the plugin runs

- actual input remains exempt while its editor buffer is unsaved

**M500** - historical twin retirement ignores current server heads

- historical identical live frame followed by its deletion cannot retire a later independent note (\#133)
- a twin with a concurrent deletion cannot replace an independent live note (\#133)

**M501** - storage refusal is hidden as an offline repair

- a real transport 507 during chunk repair remains a visible storage refusal (\#133)

**M502** - keeper metadata is not persisted before retirement

- a record of other bytes landing during the push read is not deduplicated (lower id)
- a record of other bytes landing during the push read is not deduplicated (higher id)
- a record of other bytes landing during the push post is not deduplicated (lower id)
- a record of other bytes landing during the push post is not deduplicated (higher id)

**M503** - twin adoption ignores an edit during current-head lookup

- an edit during the current-twin lookup is not adopted or retired (\#133)
- a replacement at the second stat survives later twin deletion (\#133)
- a replacement at the record boundary survives later twin deletion (\#133)

**M504** - twin adoption ignores a replacement record during lookup

- a replacement record during twin lookup keeps its newer identity (\#133)
- a replacement at the second stat survives later twin deletion (\#133)
- a replacement at the record boundary survives later twin deletion (\#133)

**M505** - twin adoption ignores a concurrent server fork

- a twin with a concurrent deletion cannot replace an independent live note (\#133)

**M510** - claimant name length is not bounded

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M511** - claimant name permits controls and bidi formatting

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M512** - claimant count accepts non-integral numbers

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M513** - claimant count accepts negative numbers

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M514** - claimant sealing omits plaintext validation

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M515** - claimant decoding trusts authenticated malformed metadata

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M516** - claimant envelope size is unbounded

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M517** - claimant nonce format is not validated

- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M518** - claimant vault sealing omits pairing additional data

- a claimant waits on its envelope, then saves the approved key before restarting sync
- sync stays stopped while the approved key save is pending
- a rejected approved-key save never starts sync
- 403 not_approved
- 409 not_claimant
- 410 pairing_expired
- only the explicit pending-approval refusal permits another envelope request
- a lost envelope response is surfaced once and never fetched again
- an unclassified local error cannot masquerade as pending approval
- closing while waiting leaves the one-time envelope unconsumed
- a superseded claim completion cannot adopt credentials or restart the replacement session
- a superseded envelope completion cannot adopt credentials or restart the replacement session
- a superseded key save completion cannot adopt credentials or restart the replacement session
- closing during an already-dispatched envelope preserves its key without starting another session
- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- answering Pair and upload keeps the key and starts the first sync
- an enrolled device whose key never arrived may pair again
- approval names the decrypted vault and note count before showing its controls (\#141)
- closing while vault details decrypt cannot recreate approval controls (\#141)
- sealed claimant vault details bind the pairing and use a separate key (\#141)
- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M519** - claimant vault key reuses vault-key envelope label

- sealed claimant vault details bind the pairing and use a separate key (\#141)
- claimant vault validation bounds names, counts and sealed wire data (\#141)

**M520** - creator ignores sealed claimant vault details

- approval names the decrypted vault and note count before showing its controls (\#141)
- unauthentic vault details never offer an approval button (\#141)
- closing while vault details decrypt cannot recreate approval controls (\#141)

**M521** - closed creator modal recreates decrypted approval controls

- closing while vault details decrypt cannot recreate approval controls (\#141)

**M522** - claim does not send sealed vault details

- a claimant waits on its envelope, then saves the approved key before restarting sync
- sync stays stopped while the approved key save is pending
- a rejected approved-key save never starts sync
- 403 not_approved
- 409 not_claimant
- 410 pairing_expired
- only the explicit pending-approval refusal permits another envelope request
- a lost envelope response is surfaced once and never fetched again
- an unclassified local error cannot masquerade as pending approval
- closing while waiting leaves the one-time envelope unconsumed
- a superseded claim completion cannot adopt credentials or restart the replacement session
- a superseded envelope completion cannot adopt credentials or restart the replacement session
- a superseded key save completion cannot adopt credentials or restart the replacement session
- closing during an already-dispatched envelope preserves its key without starting another session
- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- answering Pair and upload keeps the key and starts the first sync
- an enrolled device whose key never arrived may pair again

**M523** - missing vault details are not backward compatible

- an old server's absent vault details keep the legacy approval prompt (\#141)

**M524** - claim reports no notes

- a claimant waits on its envelope, then saves the approved key before restarting sync
- sync stays stopped while the approved key save is pending
- a rejected approved-key save never starts sync
- 403 not_approved
- 409 not_claimant
- 410 pairing_expired
- only the explicit pending-approval refusal permits another envelope request
- a lost envelope response is surfaced once and never fetched again
- an unclassified local error cannot masquerade as pending approval
- closing while waiting leaves the one-time envelope unconsumed
- a superseded claim completion cannot adopt credentials or restart the replacement session
- a superseded envelope completion cannot adopt credentials or restart the replacement session
- a superseded key save completion cannot adopt credentials or restart the replacement session
- closing during an already-dispatched envelope preserves its key without starting another session
- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- answering Pair and upload keeps the key and starts the first sync
- an enrolled device whose key never arrived may pair again

**M525** - claim reports a generic vault name

- a claimant waits on its envelope, then saves the approved key before restarting sync
- sync stays stopped while the approved key save is pending
- a rejected approved-key save never starts sync
- 403 not_approved
- 409 not_claimant
- 410 pairing_expired
- only the explicit pending-approval refusal permits another envelope request
- a lost envelope response is surfaced once and never fetched again
- an unclassified local error cannot masquerade as pending approval
- closing while waiting leaves the one-time envelope unconsumed
- a superseded claim completion cannot adopt credentials or restart the replacement session
- a superseded envelope completion cannot adopt credentials or restart the replacement session
- a superseded key save completion cannot adopt credentials or restart the replacement session
- closing during an already-dispatched envelope preserves its key without starting another session
- a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves
- answering Pair and upload keeps the key and starts the first sync
- an enrolled device whose key never arrived may pair again

**M526** - creator does not show claimant note count

- approval names the decrypted vault and note count before showing its controls (\#141)

**M530** - Sync now misses a silent rewrite with unchanged metadata

- sync now waits for the drain already running, and says which decision it took
- sync now drains again for work queued after the drain it joined took its last batch
- Sync now reads a silent fixed-width rewrite after the arrival window expired

**M531** - the local hold never reaches the other device, including on retry

- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- strictly alternating background answers stop without needing a conflicting pair

**M532** - a peer ignores the encrypted hold and keeps publishing

- a peer hold leaves content alone, says so once, and survives reload
- concurrent deliveries of one peer hold produce one notice
- a received hold uses the target note's current answer proof (typing: false)
- a received hold uses the target note's current answer proof (typing: true)
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a hold cannot attribute another local file at the same name to its target
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- strictly alternating background answers stop without needing a conflicting pair
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M533** - a replayed historical pause holds a note after Resume

- a cleared historical pause cannot re-pause a replaying client

**M534** - a clear control pauses the note again

- a cleared historical pause cannot re-pause a replaying client
- a paused note stays paused across a restart and Resume brings it back

**M535** - replaying one current hold floods the device with repeated notices

- a peer hold leaves content alone, says so once, and survives reload
- concurrent deliveries of one peer hold produce one notice
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M536** - an arbitrary encrypted record can masquerade as another note hold

- a peer pause is bound to its control id and encrypted record

**M537** - an unknown control kind pauses a note

- a control validates every field before it can hold a note

**M538** - a malformed target id is accepted

- a control validates every field before it can hold a note

**M539** - a non-boolean control is accepted

- a control validates every field before it can hold a note

**M540** - a control masquerades as a deletion

- a control validates every field before it can hold a note

**M541** - a control carrying content bypasses the empty-record schema

- a control validates every field before it can hold a note

**M542** - an invalid background-answer flag is accepted

- a control validates every field before it can hold a note

**M543** - sequential background answers never carry their origin and bounce forever

- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- strictly alternating background answers stop without needing a conflicting pair
- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M544** - strictly sequential answers never trip the hold

- strictly alternating background answers stop without needing a conflicting pair

**M545** - restart forgets which paused device must preserve its editor text

- a peer hold leaves content alone, says so once, and survives reload
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- a received hold uses the target note's current answer proof (typing: true)

**M546** - corrupt local state can name a non-file-id hold

- a peer hold leaves content alone, says so once, and survives reload

**M547** - corrupt local state can hold a path outside the vault

- a peer hold leaves content alone, says so once, and survives reload

**M548** - the Resume button dismisses status without resuming the note

- Show sync status resumes the selected held note through the actual plugin method

**M549** - the plugin Resume method never reaches the engine

- Show sync status resumes the selected held note through the actual plugin method

**M550** - Resume does not close the existing pause heads

- announcing a hold is idempotent across repeated writes and an engine restart
- concurrent opposite controls do not adopt each other; explicit Resume closes the fork

**M551** - Resume adopts a conflicting pause at the same server position

- concurrent opposite controls do not adopt each other; explicit Resume closes the fork

**M552** - pause publication sends a clear and Resume sends a pause

- announcing a hold is idempotent across repeated writes and an engine restart
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- strictly alternating background answers stop without needing a conflicting pair
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M553** - a server failure is treated as proof that no control exists

- an unreadable pause position is not treated as a missing position

**M554** - every held local rewrite sends another control lookup

- announcing a hold is idempotent across repeated writes and an engine restart

**M555** - restart republishes an identical hold and repeated Resume creates more versions

- announcing a hold is idempotent across repeated writes and an engine restart
- a received hold uses the target note's current answer proof (typing: false)
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M556** - Resume takes stale peer text instead of the editor held while paused

- a peer-held note that changes during Resume stays held
- a detector keeps its hold when a resume backup has no free name
- a detector keeps its hold if a save lands during its resume backup
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M557** - resuming an editor silently consumes a different live head

- Resume refuses to silently consume a foreign live head

**M558** - a save during Resume drops the hold despite publishing nothing

- a peer-held note that changes during Resume stays held

**M559** - a fresh local file at a held path escapes the hold

- a hold also prevents a new local file at the same path from being pushed

**M560** - two concurrent deliveries issue the same hold notice twice

- concurrent deliveries of one peer hold produce one notice

**M561** - Resume clears a hold when it could not preserve the held note

- a detector keeps its hold when a resume backup has no free name

**M562** - Resume clears a hold after a concurrent local save interrupted restoration

- a detector keeps its hold if a save lands during its resume backup

**M563** - a new device cannot Resume a held note it has not downloaded yet

- resume fallbacks preserve untracked, deleted, large and unavailable recorded content
- a newly paired device can explicitly Resume a note held before its first download

**M564** - Resume overwrites a local deletion with the current remote note

- resume fallbacks preserve untracked, deleted, large and unavailable recorded content
- Resume keeps a local deletion instead of applying the note it deliberately held back

**M565** - Resume buffers a file above its single-chunk budget

- resume fallbacks preserve untracked, deleted, large and unavailable recorded content

**M566** - a note whose old baseline expired can never Resume

- resume fallbacks preserve untracked, deleted, large and unavailable recorded content

**M568** - Resume writes a recorded version under a different path

- resume refuses a saved record that was deleted, moved, or has multiple chunks

**M569** - Resume treats a multi-chunk recorded version as its one-chunk baseline

- resume refuses a saved record that was deleted, moved, or has multiple chunks

**M570** - no free backup name silently removes the pause

- a detector keeps its hold when a resume backup has no free name

**M571** - a save during resume materialisation clears the hold

- a detector keeps its hold if a save lands during its resume backup
- a save during peer-head download is kept in the main note

**M572** - an empty control head list vacuously proves a hold exists

- an incomplete control lookup is never mistaken for an already-published hold

**M573** - Resume creates a redundant backup of its own known ancestor

- Resume refuses to silently consume a foreign live head
- publishing a held editor does not make a copy of its own recorded ancestor
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M574** - a different encrypted control kind is adopted as this pause

- control adoption checks kind and target as well as its paused state

**M575** - a control for a different target is adopted as this hold

- control adoption checks kind and target as well as its paused state

**M576** - a directory-shaped control at the same position is adopted as a pause

- control adoption checks kind and target as well as its paused state

**M577** - Resume silently consumes a head whose encrypted version it could not inspect

- Resume refuses a server head whose version it cannot read

**M578** - a stopped engine publishes and forgets a hold when Resume was queued

- a stop prevents a queued Resume from publishing or forgetting the hold

**M579** - a peer hold disappears on restart because it was never persisted

- a peer hold leaves content alone, says so once, and survives reload
- a received hold uses the target note's current answer proof (typing: true)

**M580** - misclassify non-auth signature errors

- only explicit device authentication refusals are classified as forgotten

**M581** - ignore revoked credentials

- only explicit device authentication refusals are classified as forgotten

**M582** - omit automatic registration

- an updated paired device registers recovery before its last credential leaves
- an old server without recovery registration can still sync while its last-device safeguard remains

**M583** - map forgotten feed credentials to offline retry

- the feed stops on a forgotten credential and never reports a reachable server as offline

- Re-measured after repairing the test wait: the original run ended
  with one cancellation and no failed assertion. The wait now observes
  both the expected forgotten-device status and the mutant's offline
  status before asserting the original expected result. The replacement
  full suite has one assertion failure and zero cancellations.

**M584** - restart a forgotten device

- startup authentication refusal identifies a forgotten device without scheduling reconnect

**M585** - hide recovery behind rejected device id

- forgotten credentials show recovery and reset metadata without touching notes, key or address

**M586** - permit duplicate setup actions

- double clicking setup does not mint two devices

**M587** - setup retains rejected enrollment

- setup recovers a forgotten enrollment with its retained key, without uninstalling
- revoking this device directly exposes recovery without restarting the plugin

**M588** - enrol before key durability

- a failed key save creates no server account

**M589** - replace retained vault key during setup

- an updated paired device registers recovery before its last credential leaves
- setup recovers a forgotten enrollment with its retained key, without uninstalling
- a lost first setup response retains its pre-request key for an explicit recovery attempt
- setup's superseded save completion leaves replacement identity untouched
- a device that has left can enrol on another server, and it is still the same vault

**M590** - adopt credential after vault-key change

- a key changed while setup waits cannot adopt the old key's credential

**M591** - overwrite forgotten status with idle

- forgotten credentials show recovery and reset metadata without touching notes, key or address

**M592** - keep recovered device blocked

- setup recovers a forgotten enrollment with its retained key, without uninstalling

**M593** - lose recovery connection settings

- forgotten credentials show recovery and reset metadata without touching notes, key or address
- setup recovers a forgotten enrollment with its retained key, without uninstalling
- recovery reset waits for the old engine writer even after the engine reference was cleared
- a forgotten device can claim pairing only after its stale enrollment is cleared

**M594** - retain stale sync records on reset

- forgotten credentials show recovery and reset metadata without touching notes, key or address
- setup recovers a forgotten enrollment with its retained key, without uninstalling
- revoking this device directly exposes recovery without restarting the plugin
- recovery reset waits for the old engine writer even after the engine reference was cleared
- a forgotten device can claim pairing only after its stale enrollment is cleared
- closing pairing while its forgotten identity resets prevents a claim

**M595** - gate phrase restore with rejected credential

- a forgotten credential permits restoring the phrase before re-enrollment

**M596** - ignore rejection during registration

- a rejected recovery registration also exposes the forgotten-device action

**M597** - stop sync on old server without recovery

- an old server without recovery registration can still sync while its last-device safeguard remains
- a rejected recovery registration also exposes the forgotten-device action
- unload drops engine ownership before its stop callback can update the UI

**M598** - misclassify startup authentication refusal

- startup authentication refusal identifies a forgotten device without scheduling reconnect
- 401 bad_signature is not retried: it stays an error until the person acts
- 403 device_revoked is not retried: it stays an error until the person acts

**M599** - force pairing after empty-server switch

- switching offers setup for an empty server without forcing a pairing code

**M600** - send verifier as key proof

- an updated paired device registers recovery before its last credential leaves
- setup recovers a forgotten enrollment with its retained key, without uninstalling
- a lost first setup response retains its pre-request key for an explicit recovery attempt

**M601** - register the wrong verifier

- an updated paired device registers recovery before its last credential leaves
- setup recovers a forgotten enrollment with its retained key, without uninstalling

**M602** - reset an active credential without a refusal

- recovery reset refuses an active enrollment and an in-progress restore

**M603** - reset during an active restore

- recovery reset refuses an active enrollment and an in-progress restore

**M604** - clear identity before old writers drain

- recovery reset waits for the old engine writer even after the engine reference was cleared

**M605** - send a proof from a replaced key

- a vault-key change during proof derivation sends no stale proof

**M606** - refuse pairing for forgotten device

- a forgotten device can claim pairing only after its stale enrollment is cleared
- closing pairing while its forgotten identity resets prevents a claim

**M607** - claim pairing with stale sync records

- a forgotten device can claim pairing only after its stale enrollment is cleared
- closing pairing while its forgotten identity resets prevents a claim

**M608** - register a verifier after the key changes

- registration does not bind a proof after its vault key was replaced

**M609** - claim after pairing dialog closes during reset

- closing pairing while its forgotten identity resets prevents a claim

- The original suite passed this mutant. The existing cancelled-pairing
  test now also closes an incomplete-code dialog while reset is pending,
  and requires no validation notice after cancellation. The replacement
  full suite has one assertion failure and zero cancellations; the
  product source is unchanged.

**M610** - re-enrollment retains the old device list error

- re-enrollment replaces a cached revoked-device error with the recovered account list

**M611** - a device-list result ignores a changed identity

- a previous deviceId device-list response cannot replace the recovered account
- a previous deviceId device-list error cannot replace the recovered account

**M612** - a device-list result ignores a changed server

- a previous serverUrl device-list response cannot replace the recovered account
- a previous serverUrl device-list error cannot replace the recovered account

**M613** - Resume selects heads before a queued older upload completes

- Resume selects heads after the older blocked upload is acknowledged

**M614** - do not redraw settings after pairing

- closing a completed pairing redraws settings for the new identity

**M615** - ignore pairing close callback

- switch mode takes the new address and opens pairing against it
- closing a completed pairing redraws settings for the new identity

**M616** - forget the switch-server pairing completion callback

- switch mode takes the new address and opens pairing against it

**M617** - offer destructive leave before Cancel

- the dialog states what is kept and what is lost before it will leave

**M618** - offer destructive leave before Cancel on refusal

- a last-device refusal focuses Cancel before the local-only leave action

**M620** - both resumes create a second sibling instead of advancing the recorded-answer copy

- Resume advances one proven copy and retains older body text in history (retry: false)
- Resume advances one proven copy and retains older body text in history (retry: true)
- an unpublished same-metadata edit of the preserved copy refuses Resume
- a empty preserved-copy head refuses Resume without consuming it
- a split preserved-copy head refuses Resume without consuming it
- a missing preserved-copy head refuses Resume without consuming it
- a edited preserved-copy head refuses Resume without consuming it
- a deleted preserved-copy head refuses Resume without consuming it
- a moved preserved-copy head refuses Resume without consuming it
- a missing local preserved copy is not overwritten by Resume
- a large local preserved copy is not overwritten by Resume
- a identity local preserved copy is not overwritten by Resume
- a metadata save during copy preparation leaves both notes intact
- a same_metadata save during copy preparation leaves both notes intact
- a identity save during copy preparation leaves both notes intact
- an independent head racing the copy publication is retained and leaves the note held
- a growing copy whose last recorded bytes already equal the held snapshot refuses Resume
- a copy removed during publication does not authorize replacing the held note
- background Resume preserves its latest snapshot before adopting the single peer branch
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M621** - Resume can write a path whose tracked identity changed

- a identity local preserved copy is not overwritten by Resume

**M622** - Resume reads a preserved copy above its single-chunk budget

- a large local preserved copy is not overwritten by Resume

**M623** - a missing copy loses its structured Resume refusal

- a missing local preserved copy is not overwritten by Resume

**M624** - Resume overwrites an unpublished same-metadata copy edit

- an unpublished same-metadata edit of the preserved copy refuses Resume

**M625** - Resume consumes split copy heads without a unique lineage

- a split preserved-copy head refuses Resume without consuming it

**M626** - Resume writes over a copy after substituting another version for an unreadable head

- a missing preserved-copy head refuses Resume without consuming it

**M627** - Resume changes a copy the remote device moved to another path

- a moved preserved-copy head refuses Resume without consuming it

**M628** - Resume replaces an independent remote copy edit

- a edited preserved-copy head refuses Resume without consuming it

**M629** - a proven baseline copy cannot advance to the newer held text

- Resume advances one proven copy and retains older body text in history (retry: false)
- a empty preserved-copy head refuses Resume without consuming it
- a split preserved-copy head refuses Resume without consuming it
- a missing preserved-copy head refuses Resume without consuming it
- a edited preserved-copy head refuses Resume without consuming it
- a deleted preserved-copy head refuses Resume without consuming it
- a moved preserved-copy head refuses Resume without consuming it
- a metadata save during copy preparation leaves both notes intact
- a same_metadata save during copy preparation leaves both notes intact
- a identity save during copy preparation leaves both notes intact
- an independent head racing the copy publication is retained and leaves the note held
- a copy removed during publication does not authorize replacing the held note
- background Resume preserves its latest snapshot before adopting the single peer branch
- Resume does not select multiple competing heads as the one peer branch
- Resume does not select own competing heads as the one peer branch
- Resume does not select missing competing heads as the one peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M630** - retry refuses an already-published held snapshot

- Resume advances one proven copy and retains older body text in history (retry: true)
- a growing copy whose last recorded bytes already equal the held snapshot refuses Resume
- Resume selects the copy parent after its older upload has acknowledged

**M631** - Resume ignores a copy touched while its replacement is prepared

- a metadata save during copy preparation leaves both notes intact

**M632** - Resume overwrites a same-metadata copy edit made during preparation

- a deletion refused because the file came back is published as the change it is
- a same_metadata save during copy preparation leaves both notes intact

**M633** - Resume writes after the copy record has been reassigned

- a identity save during copy preparation leaves both notes intact

**M634** - a growing copy clears the hold when its last recorded digest already matches

- a growing copy whose last recorded bytes already equal the held snapshot refuses Resume

**M635** - Resume clears the hold despite an independent head racing its copy publication

- an independent head racing the copy publication is retained and leaves the note held

**M636** - a disappeared copy authorizes replacing the held note

- a copy removed during publication does not authorize replacing the held note

**M637** - Resume fails to store the held bytes in its preserved copy

- Resume advances one proven copy and retains older body text in history (retry: false)
- Resume advances one proven copy and retains older body text in history (retry: true)
- an independent head racing the copy publication is retained and leaves the note held
- a copy removed during publication does not authorize replacing the held note
- Resume selects the copy parent after its older upload has acknowledged
- background Resume preserves its latest snapshot before adopting the single peer branch
- Resume does not select multiple competing heads as the one peer branch
- Resume does not select own competing heads as the one peer branch
- Resume does not select missing competing heads as the one peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M638** - the newer held snapshot forks instead of advancing the preserved baseline

- Resume advances one proven copy and retains older body text in history (retry: false)
- background Resume preserves its latest snapshot before adopting the single peer branch
- Resume does not select multiple competing heads as the one peer branch
- Resume does not select own competing heads as the one peer branch
- Resume does not select missing competing heads as the one peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M639** - retrying an already-published held snapshot grows another history version

- Resume advances one proven copy and retains older body text in history (retry: true)
- Resume selects the copy parent after its older upload has acknowledged

**M650** - revival omits the tombstone parent

- a file left with two heads, or a note whose push is not in flight, comes to rest
- delete-versus-unpublished-edit consumes the deletion and stays settled after replay (\#178)
- delete-versus-published-edit consumes the deletion and stays settled after replay (\#178)
- settling a deletion does not claim to incorporate another device's unseen edit (\#178)
- two devices reviving identical edits publish one settlement (\#178)
- a failed startup publication does not cancel the revival waiting behind it (\#178)
- a completed publication cannot let a new post overtake a queued revival (\#178)
- a deferred settlement describes an already-published edit truthfully and retries quietly (\#178)
- a tombstone that forks from the version this device holds is one side of a fork
- a delete raced by an edit reaches the other device as a live note
- an open note holding unsaved typing is kept however long ago it was published (desktop)
- an open note holding unsaved typing is kept however long ago it was published (mobile)

**M651** - published edit leaves the deletion as another head

- delete-versus-published-edit consumes the deletion and stays settled after replay (\#178)
- a deferred settlement describes an already-published edit truthfully and retries quietly (\#178)
- a tombstone that forks from the version this device holds is one side of a fork

**M652** - unpublished edit leaves the deletion as another head

- a file left with two heads, or a note whose push is not in flight, comes to rest
- delete-versus-unpublished-edit consumes the deletion and stays settled after replay (\#178)
- settling a deletion does not claim to incorporate another device's unseen edit (\#178)
- an open note holding unsaved typing is kept however long ago it was published (desktop)
- an open note holding unsaved typing is kept however long ago it was published (mobile)

**M653** - startup push bypasses the publication queue

- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- an editor upload inherits the pending merge at its write boundary
- an editor upload inherits the pending merge at its receipt boundary
- a completed publication cannot let a new post overtake a queued revival (\#178)
- Resume selects heads after the older blocked upload is acknowledged

**M654** - revival bypasses an in-flight publication

- a completed publication cannot let a new post overtake a queued revival (\#178)

**M655** - completed publication drops a later publication from the queue

- a completed publication cannot let a new post overtake a queued revival (\#178)

**M656** - failed publication cancels the revival waiting behind it

- a failed startup publication does not cancel the revival waiting behind it (\#178)

**M657** - identical revivals from two devices are not deduplicated

- two devices reviving identical edits publish one settlement (\#178)

**M660** - passive open editors prevent the rewrite hold

- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- answer flags distinguish actual input from passive buffer lag
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

**M661** - input begun after a background judgment still pauses the typist

- a received hold uses the target note's current answer proof (typing: true)
- a clean merge cannot create background proof from typing_expired_during input
- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it

**M662** - real typing is advertised as a background answer

- a paused note stays paused across a restart and Resume brings it back
- answer flags distinguish actual input from passive buffer lag
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

**M663** - saved typing loses its debounce allowance

- keydown protects saved typing, then expires; a passive view is not typing
- beforeinput protects saved typing, then expires; a passive view is not typing
- IME remains typing beyond the save window, then compositionend starts the save allowance
- focusout ends a cancelled composition but does not manufacture input in a passive view
- input tracks the view's current file, all windows, and has one listener per window
- onload binds the primary window, pre-existing popouts, and newly opened windows
- a saved native editor with recent input defers until that input settles (desktop)
- a saved native editor with recent input defers until that input settles (mobile)

**M664** - an old input exempts all later plugin rewrites

- keydown protects saved typing, then expires; a passive view is not typing
- beforeinput protects saved typing, then expires; a passive view is not typing
- IME remains typing beyond the save window, then compositionend starts the save allowance
- focusout ends a cancelled composition but does not manufacture input in a passive view

**M665** - switching files carries the old file input to the new one

- input tracks the view's current file, all windows, and has one listener per window

**M666** - long IME compositions are classified as rewrites

- IME remains typing beyond the save window, then compositionend starts the save allowance

**M667** - completed IME composition exempts rewrites forever

- IME remains typing beyond the save window, then compositionend starts the save allowance

**M668** - cancelled IME composition remains active after focus leaves

- focusout ends a cancelled composition but does not manufacture input in a passive view

**M669** - synthetic plugin events falsely claim human input

- synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing

**M670** - an absent event target throws during input observation

- synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing

**M671** - non-node event targets throw in DOM containment

- synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing

**M672** - deferred non-Markdown leaves are accessed as loaded editors

- synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing

**M673** - an empty editor throws instead of safely ignoring input

- synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing

**M674** - input in another UI or editor protects every open note

- keydown protects saved typing, then expires; a passive view is not typing
- beforeinput protects saved typing, then expires; a passive view is not typing
- synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing

**M675** - layout restoration installs duplicate input listeners

- input tracks the view's current file, all windows, and has one listener per window

**M676** - CodeMirror event handling can hide trusted input

- input tracks the view's current file, all windows, and has one listener per window

**M677** - leaving a passive editor invents a typing allowance

- focusout ends a cancelled composition but does not manufacture input in a passive view

**M678** - physical keyboard input is not observed

- keydown protects saved typing, then expires; a passive view is not typing

**M679** - touch keyboard and paste input is not observed

- beforeinput protects saved typing, then expires; a passive view is not typing
- input tracks the view's current file, all windows, and has one listener per window
- onload binds the primary window, pre-existing popouts, and newly opened windows

**M680** - IME composition start is not observed

- IME remains typing beyond the save window, then compositionend starts the save allowance
- focusout ends a cancelled composition but does not manufacture input in a passive view

**M681** - IME completion is not observed

- IME remains typing beyond the save window, then compositionend starts the save allowance

**M682** - composition cancellation on focus change is not observed

- focusout ends a cancelled composition but does not manufacture input in a passive view

**M683** - plugin startup does not observe its primary window

- onload binds the primary window, pre-existing popouts, and newly opened windows

**M684** - already open popout windows miss editor input

- onload binds the primary window, pre-existing popouts, and newly opened windows

**M685** - new popout windows miss editor input

- onload binds the primary window, pre-existing popouts, and newly opened windows

**M686** - closed file input still applies after a view changes notes

- input tracks the view's current file, all windows, and has one listener per window

**M687** - an IME composition transfers to a different file

- input tracks the view's current file, all windows, and has one listener per window

**M688** - the last input time is not retained through save debounce

- keydown protects saved typing, then expires; a passive view is not typing
- beforeinput protects saved typing, then expires; a passive view is not typing
- IME remains typing beyond the save window, then compositionend starts the save allowance
- focusout ends a cancelled composition but does not manufacture input in a passive view
- input tracks the view's current file, all windows, and has one listener per window
- onload binds the primary window, pre-existing popouts, and newly opened windows

**M689** - composition completion does not refresh the save allowance

- IME remains typing beyond the save window, then compositionend starts the save allowance

**M690** - the typing peer makes a conflict copy before holding

- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- parallel overlap detection announces one hold without duplicating notices
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M691** - ordinary user edits are treated as automatic answers

- a competing user edit has no automatic-answer flag
- an unflagged overlap over an unpushed typed edit waits for its publication
- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it

**M692** - a passive editor originates the typing-side hold

- a passive editor is not trusted typing

**M693** - the active editor resumes as the background rewriter

- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- parallel overlap detection announces one hold without duplicating notices
- a paused note stays paused across a restart and Resume brings it back
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M694** - the editor-side hold is not persisted

- an authenticated automatic answer holds a competing typed branch before replacing or copying it

**M695** - the editor-side hold is not shared

- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M696** - the typing-side hold still falls through to conflict copying

- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- parallel overlap detection announces one hold without duplicating notices
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M697** - parallel typing-side detection emits duplicate notices

- parallel overlap detection announces one hold without duplicating notices

**M698** - the received control classifies its own id instead of the note

- a received hold uses the target note's current answer proof (typing: false)
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M699** - the answer author resumes as a remote editor

- a received hold uses the target note's current answer proof (typing: false)
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M700** - background Resume restores the stale local branch before reconciling

- background Resume preserves its latest snapshot before adopting the single peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M701** - background Resume guesses one branch from several peer heads

- Resume does not select multiple competing heads as the one peer branch

**M702** - a local in-flight head is mistaken for the peer editor

- Resume does not select own competing heads as the one peer branch

**M703** - Resume selects an unrelated historical version instead of the peer head

- background Resume preserves its latest snapshot before adopting the single peer branch
- the deleted peer head cannot replace the note during background Resume
- the moved peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume
- a save during peer-head download is kept in the main note

**M704** - Resume records the peer head over restored local bytes

- background Resume preserves its latest snapshot before adopting the single peer branch
- a save during peer-head download is kept in the main note
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a paused note stays paused across a restart and Resume brings it back
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M705** - Resume records the old version over the peer bytes

- background Resume preserves its latest snapshot before adopting the single peer branch
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M706** - Resume writes the peer under a different path

- the moved peer head cannot replace the note during background Resume

**M707** - Resume admits a deleted or oversized peer head

- the deleted peer head cannot replace the note during background Resume
- the large peer head cannot replace the note during background Resume

**M708** - the peer answer pauses even a clean nonoverlapping merge

- an automatic answer that merges cleanly needs no hold

**M709** - the control claims another file at the same path is its author

- a hold cannot attribute another local file at the same name to its target

**M710** - twin adoption awaits another digest after checking the replacement boundary

- a replacement at the record boundary survives later twin deletion (\#133)

**M711** - twin adoption checks the identity before the awaited file recheck

- a replacement at the second stat survives later twin deletion (\#133)
- a replacement at the record boundary survives later twin deletion (\#133)

**M712** - identical merged heads use their older graph ancestor and displace newly typed text into a conflict copy

- identical merged heads retain typing saved after their shared content

**M713** - a delayed upload receipt replaces a newer pulled record and gives later typing an older parent

- a delayed upload acknowledgement cannot replace a newer pulled record

**M714** - merges omit an in-flight upload from their parents because they cannot wait for its receipt

- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- an editor upload inherits the pending merge at its write boundary
- an editor upload inherits the pending merge at its receipt boundary

**M715** - a delayed merge receipt replaces a newer pulled identity

- a delayed merge receipt cannot replace a newer recorded version

**M716** - obsolete typing frames are merged and consume the loop budget

- superseded typing frames neither merge nor consume the loop budget
- fresh desktop catch-up does not recreate historical typing conflicts outside the file view
- fresh mobile catch-up does not recreate historical typing conflicts outside the file view

**M717** - editor uploads can fork from merged bytes before the merge receipt

- an editor upload inherits the pending merge at its write boundary
- an editor upload inherits the pending merge at its receipt boundary

**M718** - reserve the merge after writing, so a watcher upload can keep the old parent

- an editor upload inherits the pending merge at its write boundary

**M719** - independent peer typing consumes the loop budget

- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)

**M720** - unrelated forks reset the loop budget without ancestor proof

- the merge breaker counts resolutions in a row, and an edit here starts the count again
- merges that rewrite the note with nothing typed here still trip the breaker
- more than a handful of resolutions of one file in a window stops the merging
- the breaker speaks once per window and forgets when the window passes

**M721** - a peer answering our own publication bypasses the loop budget

- peer versions that incorporate our own output still consume the loop budget
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping

**M722** - the same repeated foreign head resets the loop budget

- repeating one foreign head does not reset the loop budget
- an ordinary failed write still consumes the merge budget
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)

**M723** - a completed upload is omitted from the merge parents, leaving two heads

- a merge includes an upload completed after it read the version graph

**M724** - a missing pending change bypasses move discovery and publishes a tombstone

- a pending change whose note moved before its rename event follows the live note instead of deleting it

**M725** - a stale pending change queues a deletion after a pulled move removed its old identity

- a renamed note moves on the other device and neither publishes a tombstone (deferred vault events)
- a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (immediate vault events)
- a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (deferred vault events)

**M726** - identical pull adoption does not persist the keeper before retirement

- pull adoption persists its keeper before retiring the prior identical identity (\#133)

**M727** - unpublished typing is included in another criss-cross merge before its own upload

- typing beyond a criss-cross head is published before another merge of that pair

**M728** - criss-cross deferral selects published content instead of unpublished typing

- two devices typing in one open note converge on one note on both
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a criss-cross merge loads the shared pair's omitted ancestor

**M729** - an empty head view falsely proves an incoming version obsolete

- an empty head view is not proof that a competing version is obsolete

**M730** - a head absent from the file view falsely proves an incoming version obsolete

- an missing head view is not proof that a competing version is obsolete
- the equal-byte shortcut publishes no closing version when their version already retired

**M731** - a current live head is skipped as though it were historical

- a merge base above one chunk keeps both sides instead of holding it whole
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- repeating one foreign head does not reset the loop budget
- peer versions that incorporate our own output still consume the loop budget
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping
- superseded typing frames neither merge nor consume the loop budget
- the merge breaker counts resolutions in a row, and an edit here starts the count again
- merges that rewrite the note with nothing typed here still trip the breaker
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- an editor upload inherits the pending merge at its write boundary
- an editor upload inherits the pending merge at its receipt boundary
- a delayed merge receipt cannot replace a newer recorded version
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- a save landing while a merge downloads is not written over
- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- text typed on top of the losing head is published as the copy's next version
- a save landing while the losing note is copied keeps the note
- a file left with two heads, or a note whose push is not in flight, comes to rest
- two engines that merge one note identically end on ONE version
- a push reconciliation retains an active-editor wait without an error notice
- concurrent edits with a common ancestor merge, keeping both
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- a binary conflict is never merged
- an old live head outside the newest ten versions is still a real conflict
- typing merges after its common base leaves the ten-version listing
- a retained ancestor read failure is retried without publishing a conflict
- an ancestor response cannot substitute a different version
- an ancestor response rejects non-array parents
- an ancestor response rejects too many parents
- an ancestor response rejects malformed parents
- an ancestor response rejects non-string parents
- an ancestor response rejects array-shaped parents
- ancestry traversal stops at the shared frontier instead of reading older history
- missing historical ancestors keep both edits instead of guessing a base
- ancestry reads stop at the fixed budget on a long private branch
- repeated ancestry edges are traversed once, including a hostile cycle
- a fetched child precedes its already-fetched parent when choosing the merge base
- a partial ancestry graph is discarded when its newer common base is unavailable
- a criss-cross merge loads the shared pair's omitted ancestor
- a partial ancestry graph is discarded when its newer base exceeds the read budget
- refused editor writes do not consume the merge budget or create copies
- an ordinary failed write still consumes the merge budget
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- two devices resolving one concurrent edit settle instead of looping
- more than a handful of resolutions of one file in a window stops the merging
- a merge that comes out as the other device's bytes is adopted, not posted
- the breaker speaks once per window and forgets when the window passes
- the equal-byte shortcut publishes no closing version when a third divergent head
- the equal-byte shortcut publishes no closing version when our version already retired
- the equal-byte shortcut closes exactly two compared heads with smaller holders online
- the equal-byte shortcut closes exactly two compared heads with larger holders online
- the equal-byte shortcut closes exactly two compared heads with both holders online
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- a server restored from last night's backup gets the day's notes, rename and deletions back (S75)
- a change another device made on the restored server is kept, never replaced by the one re-sent over it
- a record naming a version the server no longer holds takes the identical head it does hold (\#145)
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- an automatic answer that merges cleanly needs no hold
- parallel overlap detection announces one hold without duplicating notices
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- an unflagged overlap over an unpushed typed edit waits for its publication
- a save that lands on a version as it is written is not recorded as that version
- allowed conflict copies stay in the selected folder and preserve both versions
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M732** - ignore base-only gaps and lose deletions

- a deletion beside an edited line keeps that edit in either device order
- a delete on one side is honoured; delete versus edit refuses

**M733** - ignore side-only gaps and lose insertions

- identical insertions are kept once and different insertions at the same boundary refuse
- an insertion and replacement beginning at the same boundary are conservatively refused
- an insertion on one side lands once
- edits at the head and the tail of a file merge
- a merge that comes out as the other device's bytes is adopted, not posted
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a save that lands on a version as it is written is not recorded as that version

**M734** - omit the terminal alignment boundary and lose tail edits

- a clean merge takes both sides' changes
- edits to adjacent lines merge without requiring a shared unchanged line
- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent replacements may add lines without swallowing the other replacement
- partly overlapping multi-line changes remain conflicts in either order
- a multi-line replacement remains atomic beside competing appends
- the same replacement text at different base intervals is not the same edit
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- an insertion inside a line cannot absorb a competing new prefix
- insertion alignment refuses oversized character grids on either side
- replacements of existing characters are not classified as appends
- appending cannot absorb a competing multi-line replacement
- edits at the head and the tail of a file merge
- an empty base merges a one-sided creation
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- a rename over an unpushed local edit keeps both, and renames nothing

**M735** - stop collecting edits at the first changed line

- a clean merge takes both sides' changes
- edits to adjacent lines merge without requiring a shared unchanged line
- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- a deletion beside an edited line keeps that edit in either device order
- adjacent replacements may add lines without swallowing the other replacement
- partly overlapping multi-line changes remain conflicts in either order
- a multi-line replacement remains atomic beside competing appends
- the same replacement text at different base intervals is not the same edit
- an insertion and replacement beginning at the same boundary are conservatively refused
- unchanged lines between and after neighboring edits remain in order
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- an insertion inside a line cannot absorb a competing new prefix
- insertion alignment refuses oversized character grids on either side
- replacements of existing characters are not classified as appends
- appending cannot absorb a competing multi-line replacement
- the same edit on both sides is applied once, not twice
- overlapping edits refuse to merge
- a delete on one side is honoured; delete versus edit refuses
- a trailing newline survives a merge
- an empty base merges a one-sided creation
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- superseded typing frames neither merge nor consume the loop budget
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- a fork whose other head a later version has replaced is left for that version (incomplete view: true)
- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- text typed on top of the losing head is published as the copy's next version
- a save landing while the losing note is copied keeps the note
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- an old live head outside the newest ten versions is still a real conflict
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base
- a criss-cross merge loads the shared pair's omitted ancestor
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- more than a handful of resolutions of one file in a window stops the merging
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- a rename over an unpushed local edit keeps both, and renames nothing
- a change another device made on the restored server is kept, never replaced by the one re-sent over it
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- an automatic answer that merges cleanly needs no hold
- parallel overlap detection announces one hold without duplicating notices
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M736** - treat different text in the same interval as an identical edit

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- identical insertions are kept once and different insertions at the same boundary refuse
- a multi-line replacement remains atomic beside competing appends
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- an insertion inside a line cannot absorb a competing new prefix
- insertion alignment refuses oversized character grids on either side
- replacements of existing characters are not classified as appends
- appending cannot absorb a competing multi-line replacement
- overlapping edits refuse to merge
- a delete on one side is honoured; delete versus edit refuses
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- a fork whose other head a later version has replaced is left for that version (incomplete view: true)
- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- text typed on top of the losing head is published as the copy's next version
- a save landing while the losing note is copied keeps the note
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- an old live head outside the newest ten versions is still a real conflict
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base
- more than a handful of resolutions of one file in a window stops the merging
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- parallel overlap detection announces one hold without duplicating notices
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M737** - deduplicate equal text that changes different starting lines

- the same replacement text at different base intervals is not the same edit

**M738** - deduplicate equal text that changes different ending lines

- the same replacement text at different base intervals is not the same edit

**M739** - refuse a left edit adjacent to the right edit

- edits to adjacent lines merge without requiring a shared unchanged line
- a deletion beside an edited line keeps that edit in either device order
- adjacent replacements may add lines without swallowing the other replacement
- the same replacement text at different base intervals is not the same edit
- unchanged lines between and after neighboring edits remain in order
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- a save that lands on a version as it is written is not recorded as that version

**M740** - order a left insertion against a replacement at the same boundary

- identical insertions are kept once and different insertions at the same boundary refuse
- an insertion and replacement beginning at the same boundary are conservatively refused
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it

**M741** - refuse a right edit adjacent to the left edit

- edits to adjacent lines merge without requiring a shared unchanged line
- a deletion beside an edited line keeps that edit in either device order
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- a passive third device merges alternating progress from two independent typists (adjacent lines)

**M742** - order a right insertion against a replacement at the same boundary

- identical insertions are kept once and different insertions at the same boundary refuse
- an insertion and replacement beginning at the same boundary are conservatively refused
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it

**M743** - discard unchanged lines before each edit

- a clean merge takes both sides' changes
- adjacent append runs preserve unchanged anchors and Unicode additions
- identical insertions are kept once and different insertions at the same boundary refuse
- unchanged lines between and after neighboring edits remain in order
- an insertion on one side lands once
- the same edit on both sides is applied once, not twice
- a delete on one side is honoured; delete versus edit refuses
- edits at the head and the tail of a file merge
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- one typist can stop while the peer continues its independent branch
- superseded typing frames neither merge nor consume the loop budget
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- two merges of one pair merge again, on the pair merged as their base
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- a criss-cross merge loads the shared pair's omitted ancestor
- a merge that comes out as the other device's bytes is adopted, not posted
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- an automatic answer that merges cleanly needs no hold
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input

**M744** - discard replacement text while consuming its base interval

- a clean merge takes both sides' changes
- edits to adjacent lines merge without requiring a shared unchanged line
- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- a deletion beside an edited line keeps that edit in either device order
- adjacent replacements may add lines without swallowing the other replacement
- identical insertions are kept once and different insertions at the same boundary refuse
- the same replacement text at different base intervals is not the same edit
- unchanged lines between and after neighboring edits remain in order
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- an insertion on one side lands once
- the same edit on both sides is applied once, not twice
- edits at the head and the tail of a file merge
- a trailing newline survives a merge
- an empty base merges a one-sided creation
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- superseded typing frames neither merge nor consume the loop budget
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base
- a criss-cross merge loads the shared pair's omitted ancestor
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- a merge that comes out as the other device's bytes is adopted, not posted
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- a rename over an unpushed local edit keeps both, and renames nothing
- a change another device made on the restored server is kept, never replaced by the one re-sent over it
- an automatic answer that merges cleanly needs no hold
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version

**M745** - retain the old changed lines after writing their replacements

- a clean merge takes both sides' changes
- edits to adjacent lines merge without requiring a shared unchanged line
- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- a deletion beside an edited line keeps that edit in either device order
- adjacent replacements may add lines without swallowing the other replacement
- the same replacement text at different base intervals is not the same edit
- unchanged lines between and after neighboring edits remain in order
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- the same edit on both sides is applied once, not twice
- a delete on one side is honoured; delete versus edit refuses
- a trailing newline survives a merge
- an empty base merges a one-sided creation
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- superseded typing frames neither merge nor consume the loop budget
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base
- a criss-cross merge loads the shared pair's omitted ancestor
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- a rename over an unpushed local edit keeps both, and renames nothing
- an automatic answer that merges cleanly needs no hold
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version

**M746** - discard the unchanged suffix after the final edit

- adjacent append runs preserve unchanged anchors and Unicode additions
- a deletion beside an edited line keeps that edit in either device order
- identical insertions are kept once and different insertions at the same boundary refuse
- unchanged lines between and after neighboring edits remain in order
- an insertion on one side lands once
- the same edit on both sides is applied once, not twice
- a delete on one side is honoured; delete versus edit refuses
- a trailing newline survives a merge
- one typist can stop while the peer continues its independent branch
- superseded typing frames neither merge nor consume the loop budget
- merges that rewrite the note with nothing typed here still trip the breaker
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- a criss-cross merge loads the shared pair's omitted ancestor
- a merge that comes out as the other device's bytes is adopted, not posted
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- an automatic answer that merges cleanly needs no hold
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version

**M747** - truncate replacement lines before the matching anchor

- a clean merge takes both sides' changes
- edits to adjacent lines merge without requiring a shared unchanged line
- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- a deletion beside an edited line keeps that edit in either device order
- adjacent replacements may add lines without swallowing the other replacement
- identical insertions are kept once and different insertions at the same boundary refuse
- the same replacement text at different base intervals is not the same edit
- unchanged lines between and after neighboring edits remain in order
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- an insertion inside a line cannot absorb a competing new prefix
- insertion alignment refuses oversized character grids on either side
- replacements of existing characters are not classified as appends
- appending cannot absorb a competing multi-line replacement
- an insertion on one side lands once
- the same edit on both sides is applied once, not twice
- overlapping edits refuse to merge
- a delete on one side is honoured; delete versus edit refuses
- edits at the head and the tail of a file merge
- a trailing newline survives a merge
- an empty base merges a one-sided creation
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- superseded typing frames neither merge nor consume the loop budget
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- a fork whose other head a later version has replaced is left for that version (incomplete view: true)
- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- a save landing while the losing note is copied keeps the note
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- an old live head outside the newest ten versions is still a real conflict
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base
- a criss-cross merge loads the shared pair's omitted ancestor
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- more than a handful of resolutions of one file in a window stops the merging
- a merge that comes out as the other device's bytes is adopted, not posted
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- a rename over an unpushed local edit keeps both, and renames nothing
- a change another device made on the restored server is kept, never replaced by the one re-sent over it
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- an automatic answer that merges cleanly needs no hold
- parallel overlap detection announces one hold without duplicating notices
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M748** - repeat the unchanged matching anchor inside the next edit

- a clean merge takes both sides' changes
- edits to adjacent lines merge without requiring a shared unchanged line
- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- a deletion beside an edited line keeps that edit in either device order
- adjacent replacements may add lines without swallowing the other replacement
- identical insertions are kept once and different insertions at the same boundary refuse
- the same replacement text at different base intervals is not the same edit
- unchanged lines between and after neighboring edits remain in order
- an insertion on one side lands once
- the same edit on both sides is applied once, not twice
- a delete on one side is honoured; delete versus edit refuses
- edits at the head and the tail of a file merge
- a trailing newline survives a merge
- an empty base merges a one-sided creation
- two devices typing in one open note converge on one note on both
- desktop and mobile typing on adjacent lines retain both complete sequences without copies
- two devices appending on the same line converge with every keystroke once and no copies
- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- superseded typing frames neither merge nor consume the loop budget
- merges that rewrite the note with nothing typed here still trip the breaker
- a merge includes the upload receipt before choosing its parents (late: false)
- a merge includes the upload receipt before choosing its parents (late: true)
- a merge includes an upload completed after it read the version graph
- an editor upload inherits the pending merge at its write boundary
- an editor upload inherits the pending merge at its receipt boundary
- a delayed merge receipt cannot replace a newer recorded version
- identical merged heads retain typing saved after their shared content
- two merges of one pair merge again, on the pair merged as their base
- a clean-looking append uses both shared ancestors without replaying their text
- typing beyond a criss-cross head is published before another merge of that pair
- merges of merges of one pair merge again, three levels down and no further
- a version arriving over an unpushed edit is merged by that edit's push, not copied
- an edit undone before its push still publishes, so the version it held back comes in
- a version that already holds the unpushed edit is adopted as it is
- two engines that merge one note identically end on ONE version
- concurrent edits with a common ancestor merge, keeping both
- a criss-cross merge loads the shared pair's omitted ancestor
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- a merge that comes out as the other device's bytes is adopted, not posted
- a head this device already merged is not applied again when the feed replays it
- the status names a parked file first, then a note waiting on its push, then idle
- an automatic answer that merges cleanly needs no hold
- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- a clean merge cannot create background proof from absent input
- a clean merge cannot create background proof from user input
- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input
- a save that lands on a version as it is written is not recorded as that version

**M749** - refuse all append-only overlaps

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text
- a push reconciliation retains an active-editor wait without an error notice
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- repeated ancestry edges are traversed once, including a hostile cycle
- a fetched child precedes its already-fetched parent when choosing the merge base
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it

**M750** - merge appended text across different starting base lines

- appending cannot absorb a competing multi-line replacement
- a save that lands on a version as it is written is not recorded as that version

**M751** - merge appended text across different ending base lines

- appending cannot absorb a competing multi-line replacement

**M752** - allow a whole multi-line replacement into the append rule

- appending cannot absorb a competing multi-line replacement
- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it

**M753** - drop extra replacement lines from our side

- appending cannot absorb a competing multi-line replacement
- a delete on one side is honoured; delete versus edit refuses

**M754** - drop extra replacement lines from the other side

- appending cannot absorb a competing multi-line replacement

**M755** - treat our replacement of existing text as an append

- typing continues before an addition already learned from the other device
- replacements of existing characters are not classified as appends
- a passive third device merges alternating progress from two independent typists (same line)

**M756** - treat their replacement of existing text as an append

- replacements of existing characters are not classified as appends
- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- a pull never replaces a note edited without its modification time moving (local_edit)

**M757** - consume unequal appended characters as a shared prefix

- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- two devices appending on the same line converge with every keystroke once and no copies
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base

**M758** - split shared emoji into UTF-16 halves

- adjacent append runs preserve unchanged anchors and Unicode additions
- a shared appended prefix is kept once without splitting Unicode characters

**M759** - drop the shared appended prefix

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- a shared appended prefix is kept once without splitting Unicode characters
- typing continues before an addition already learned from the other device
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)

**M760** - order concurrent additions by device role rather than a common rule

- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- two devices appending on the same line converge with every keystroke once and no copies
- a passive third device merges alternating progress from two independent typists (same line)

**M761** - discard the existing line when combining appends

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base

**M762** - silently choose our text when a change is not an append

- an insertion inside a line cannot absorb a competing new prefix
- insertion alignment refuses oversized character grids on either side
- replacements of existing characters are not classified as appends
- overlapping edits refuse to merge
- a fork whose other head a later version has replaced is left for that version (incomplete view: true)
- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- a save landing while the losing note is copied keeps the note
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- an old live head outside the newest ten versions is still a real conflict
- more than a handful of resolutions of one file in a window stops the merging
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- an authenticated automatic answer holds a competing typed branch before replacing or copying it
- an automatic answer also holds an unpushed typed overlap before deferring it
- parallel overlap detection announces one hold without duplicating notices
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input
- a peer answer holds an overlapping active editor before its first copy (reverse: false)
- a peer answer holds an overlapping active editor before its first copy (reverse: true)

**M763** - include the base text twice in the left addition

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base

**M764** - include the base text twice in the right addition

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- concurrent appends to one line keep both additions in the same order on both devices
- a shared appended prefix is kept once without splitting Unicode characters
- two devices appending on the same line converge with every keystroke once and no copies
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text
- typing merges after its common base leaves the ten-version listing
- ancestry traversal stops at the shared frontier instead of reading older history
- a fetched child precedes its already-fetched parent when choosing the merge base

**M765** - remove retained merge verdict

- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)

**M766** - accept stale background proof

- a clean merge cannot create background proof from stale input
- a clean merge cannot create background proof from typing input
- a clean merge cannot create background proof from typing_during input
- a clean merge cannot create background proof from typing_expired_during input
- a clean merge cannot create background proof from incoming input

**M767** - carry background proof across trusted typing

- a clean merge cannot create background proof from typing_during input

**M768** - keep pre-merge timestamp

- a clean merge retains the background role before a delayed control (settled: true)
- a clean merge retains the background role before a delayed overlap (settled: true)
- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)

**M769** - reclassify a user verdict as background

- an edit made while this device was closed survives one the other device made to the same note
- a version that lands while this device's own edit is still waiting to be pushed does not replace it
- a clean merge cannot create background proof from user input
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it

**M770** - invent missing background proof

- repeating one foreign head does not reset the loop budget
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping
- the merge breaker counts resolutions in a row, and an edit here starts the count again
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- a fork whose other head a later version has replaced is left for that version (incomplete view: true)
- two settlements of one fork at once on the losing device make one copy
- two devices settling the same overlap publish one shared conflict-copy version
- text typed on top of the losing head is published as the copy's next version
- a save landing while the losing note is copied keeps the note
- overlapping edits: the lower id, this device's, keeps the note and the other is one copy
- overlapping edits: the lower id, the other device's, takes the note and this device's is one copy
- a binary conflict is never merged
- an old live head outside the newest ten versions is still a real conflict
- an empty head view is not proof that a competing version is obsolete
- an missing head view is not proof that a competing version is obsolete
- missing historical ancestors keep both edits instead of guessing a base
- ancestry reads stop at the fixed budget on a long private branch
- a partial ancestry graph is discarded when its newer common base is unavailable
- a partial ancestry graph is discarded when its newer base exceeds the read budget
- more than a handful of resolutions of one file in a window stops the merging
- the breaker speaks once per window and forgets when the window passes
- a pull never replaces a note edited since it was last pushed (local_edit)
- a pull never replaces a note edited to exactly the same size (local_edit)
- a pull never replaces a note edited without its modification time moving (local_edit)
- a passive editor is not trusted typing
- a clean merge cannot create background proof from absent input
- allowed conflict copies stay in the selected folder and preserve both versions
- the same pair is settled by the rule when the edit was typed, came long after the sync, or before it
- a published answer and its newer paused text share one copy after Resume (reverse: false)
- a published answer and its newer paused text share one copy after Resume (reverse: true)

**M771** - carry local proof onto incoming-only content

- a clean merge cannot create background proof from incoming input

**M772** - classify trusted input before a merge as a background rewrite

- a clean merge cannot create background proof from typing_expired_during input

**M773** - ignore a new rewrite waiting for the debounce verdict

- a clean merge retains the background role before a delayed control (settled: false)
- a clean merge retains the background role before a delayed overlap (settled: false)
- an unpushed edit made right after a sync, to a note no editor shows, pauses its pair
- a passive saved editor does not exempt a colliding background rewrite
- a passive editor still loading an external write is not unsaved user input

**M774** - rejudge one saved edit against a later arrival clock

- a later arrival cannot erase the verdict on a waiting local save (typed: false)

**M775** - overwrite the arrival clock before preserving the waiting save

- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- a later arrival cannot erase the verdict on a waiting local save (typed: false)

**M776** - Remember arrivals only after a host plugin can answer the write.

- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: false)
- two stampers stop on both devices, then one text holds every key (reverse Resume: false, passive editor: true)
- two stampers stop on both devices, then one text holds every key (reverse Resume: true, passive editor: true)
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a paused note stays paused across a restart and Resume brings it back
- a same-size rewrite that keeps the recorded time right after a sync is still sent
- strictly alternating background answers stop without needing a conflicting pair
- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a later arrival cannot erase the verdict on a waiting local save (typed: true)
- a host plugin can recognize an arrival before the incoming write returns

**M777** - derive arrival evidence from echoes and ignored nested entries

- a second save of the same size inside one coarse mtime step is still sent
- with the note open nowhere, the first device whose answer collides pauses it and nothing forks after
- a echo version supplies no pre-write arrival evidence
- a invalid version supplies no pre-write arrival evidence
- a nested version supplies no pre-write arrival evidence

**M778** - classify unchanged remote bytes as a waiting local edit

- arrival bookkeeping cannot classify unchanged bytes as a local rewrite
- arrival bookkeeping cannot classify missing bytes as a local rewrite
- arrival bookkeeping cannot classify replaced bytes as a local rewrite
- arrival bookkeeping cannot classify outside bytes as a local rewrite
- arrival bookkeeping does not inspect an old path outside the selected folders

**M779** - classify a replacement identity as the incoming file

- arrival bookkeeping cannot classify replaced bytes as a local rewrite

**M780** - inspect pending bytes outside selected folders

- arrival bookkeeping does not inspect an old path outside the selected folders

**M781** - invent pending bytes for a missing note

- arrival bookkeeping cannot classify missing bytes as a local rewrite

**M782** - refuse continued typing before an already received suffix

- typing continues before an addition already learned from the other device
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text

**M783** - allow our deletion through the insertion merge

- replacements of existing characters are not classified as appends

**M784** - allow the peer deletion through the insertion merge

- replacements of existing characters are not classified as appends

**M785** - merge our competing prefix as continued typing

- an insertion inside a line cannot absorb a competing new prefix

**M786** - merge the peer competing prefix as continued typing

- an insertion inside a line cannot absorb a competing new prefix

**M787** - drop the unchanged character anchors while merging insertions

- typing continues before an addition already learned from the other device
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text

**M788** - replay our anchor as another insertion

- typing continues before an addition already learned from the other device
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text

**M789** - replay the peer anchor as another insertion

- typing continues before an addition already learned from the other device
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text

**M790** - merge against one ancestor after the shared base was refused

- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- merges of merges of one pair merge again, three levels down and no further

**M791** - ignore failure to resolve a deeper shared base

- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)

**M792** - treat an unresolvable shared base as absent

- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)

**M793** - skip shared ancestors when an append looks clean

- a clean-looking append uses both shared ancestors without replaying their text
- an unresolvable shared base cannot be replaced by one ancestor (deeper: false)
- an unresolvable shared base cannot be replaced by one ancestor (deeper: true)
- merges of merges of one pair merge again, three levels down and no further

**M794** - omit arrival tracking for newly materialized paths

- a later arrival cannot erase the verdict on a waiting local save (typed: false)
- a later arrival cannot erase the verdict on a waiting local save (typed: true)

**M795** - drop insertions after the last unchanged character

- typing continues before an addition already learned from the other device
- a passive third device merges alternating progress from two independent typists (same line)
- a clean-looking append uses both shared ancestors without replaying their text

**M796** - duplicate shared text inserted before a received suffix

- typing continues before an addition already learned from the other device

**M797** - only the holder of the smaller identical head can close the fork

- the equal-byte shortcut closes exactly two compared heads with larger holders online
- the equal-byte shortcut closes exactly two compared heads with both holders online

**M798** - Mobile writes beneath an active native editor.

- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- a saved native editor with recent input defers until that input settles (mobile)

**M799** - Desktop writes beneath an active native editor.

- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- a saved native editor with recent input defers until that input settles (desktop)

**M800** - Native editor refusal escapes the per-note retry classification.

- an active editor stays pending, other notes arrive, and its latest head retries without another save
- stopping clears an active-editor retry before it can write
- an active-editor wait resumes after restarting with an advanced feed cursor
- a failed editor retry keeps its durable wait and recovers automatically
- a push reconciliation retains an active-editor wait without an error notice
- an unsaved editor keeps waiting even after recent-input tracking ends
- a fast editor retry leaves a locked file on its normal backoff and visible error
- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)
- a late editor refusal preserves a concurrent resolution's budget (new edit: true)
- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)
- a saved native editor with recent input defers until that input settles (desktop)
- a saved native editor with recent input defers until that input settles (mobile)

**M801** - A saved buffer is overwritten while native typing is still active.

- a saved native editor with recent input defers until that input settles (desktop)
- a saved native editor with recent input defers until that input settles (mobile)

**M802** - The feed consumes an active editor update without arming its retry.

- an active editor stays pending, other notes arrive, and its latest head retries without another save
- stopping clears an active-editor retry before it can write
- a failed editor retry keeps its durable wait and recovers automatically
- an unsaved editor keeps waiting even after recent-input tracking ends
- a fast editor retry leaves a locked file on its normal backoff and visible error

**M803** - Stopping leaves the owned editor retry timer armed.

- stopping clears an active-editor retry before it can write

**M804** - A finished retry leaves its durable wait behind.

- an active editor stays pending, other notes arrive, and its latest head retries without another save

**M805** - A deferred native editor falsely reports idle.

- an active editor stays pending, other notes arrive, and its latest head retries without another save
- a push reconciliation retains an active-editor wait without an error notice

**M806** - Normal typing raises a per-file failure notice.

- an active editor stays pending, other notes arrive, and its latest head retries without another save

**M807** - A waiting editor repeatedly downloads and tries to overwrite the note.

- an active editor stays pending, other notes arrive, and its latest head retries without another save
- an unsaved editor keeps waiting even after recent-input tracking ends

**M808** - A transient connection failure forgets pending editor updates.

- a failed editor retry keeps its durable wait and recovers automatically

**M809** - A push reconciliation reports an active editor refusal as an error.

- a push reconciliation retains an active-editor wait without an error notice

**M810** - The fast editor timer also retries locked files.

- a fast editor retry leaves a locked file on its normal backoff and visible error

**M811** - An editor retry cannot rearm after its first tick.

- an active editor stays pending, other notes arrive, and its latest head retries without another save
- a failed editor retry keeps its durable wait and recovers automatically
- an unsaved editor keeps waiting even after recent-input tracking ends
- a fast editor retry leaves a locked file on its normal backoff and visible error
- the status names a parked file first, then a note waiting on its push, then idle

**M812** - The retry ignores recent native input.

- an active editor stays pending, other notes arrive, and its latest head retries without another save

**M813** - The retry overwrites an unsaved buffer once recent input ends.

- an unsaved editor keeps waiting even after recent-input tracking ends

**M814** - Sync status calls a normal typing wait a write failure.

- a push reconciliation retains an active-editor wait without an error notice

**M815** - The native commit ignores unsaved text when no recent input was recorded.

- incoming fast-forward waits for unsaved native editor text (desktop, before download)
- incoming fast-forward waits for unsaved native editor text (desktop, during download)
- incoming merge waits for unsaved native editor text (desktop, before download)
- incoming merge waits for unsaved native editor text (desktop, during download)
- incoming fast-forward waits for unsaved native editor text (mobile, before download)
- incoming fast-forward waits for unsaved native editor text (mobile, during download)
- incoming merge waits for unsaved native editor text (mobile, before download)
- incoming merge waits for unsaved native editor text (mobile, during download)

**M816** - Stopping retains the old editor timer handle.

- stopping clears an active-editor retry before it can write

**M817** - Group independent adjacent appends as a replacement.

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)

**M818** - Split structural line deletions as if they were appends.

- appending cannot absorb a competing multi-line replacement

**M819** - Merge replacements without preserving original line prefixes.

- a multi-line replacement remains atomic beside competing appends

**M820** - Extend a split append across its next line.

- shared appends on adjacent lines do not turn continued typing into an overlap
- adjacent append runs preserve unchanged anchors and Unicode additions
- continued adjacent appends reconcile without copies (desktop)
- continued adjacent appends reconcile without copies (mobile)

**M821** - Collapse independent authors into one progress slot.

- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)

**M822** - Retain forgotten authors outside the received ancestry graph.

- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping

**M823** - Forget the per-author progress map between resolutions.

- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)
- alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping

**M824** - Do not record a new independent remote version.

- one typist can stop while the peer continues its independent branch
- a passive third device merges alternating progress from two independent typists (adjacent lines)
- a passive third device merges alternating progress from two independent typists (same line)

**M825** - busy editor refusals keep consuming the merge budget

- refused editor writes do not consume the merge budget or create copies
- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)
- a late editor refusal preserves a concurrent resolution's budget (new edit: false)

**M826** - all write failures refund the merge budget

- an ordinary failed write still consumes the merge budget

**M827** - an old busy refusal erases a new generation charge

- a late editor refusal preserves a concurrent resolution's budget (new edit: true)

**M828** - new edits keep the old budget generation

- a late editor refusal preserves a concurrent resolution's budget (new edit: true)

**M829** - ignore an unsaved editor when concurrent resolutions exhaust the budget

- overlapping editor refusals cannot trip the breaker or create copies (unsaved)

**M830** - ignore recent typing when concurrent resolutions exhaust the budget

- overlapping editor refusals cannot trip the breaker or create copies (typing)

**M831** - wait for the editor only after the merge budget is exceeded

- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)

**M832** - silence the editor wait at the merge limit

- overlapping editor refusals cannot trip the breaker or create copies (typing)
- overlapping editor refusals cannot trip the breaker or create copies (unsaved)

**M833** - omit retained-ancestry lookup

- typing merges after its common base leaves the ten-version listing
- a retained ancestor read failure is retried without publishing a conflict
- an ancestor response cannot substitute a different version
- an ancestor response rejects non-array parents
- an ancestor response rejects too many parents
- an ancestor response rejects malformed parents
- an ancestor response rejects non-string parents
- an ancestor response rejects array-shaped parents
- ancestry traversal stops at the shared frontier instead of reading older history
- missing historical ancestors keep both edits instead of guessing a base
- ancestry reads stop at the fixed budget on a long private branch
- repeated ancestry edges are traversed once, including a hostile cycle
- a fetched child precedes its already-fetched parent when choosing the merge base
- a partial ancestry graph is discarded when its newer base exceeds the read budget

**M834** - fetch ancestry for incomplete head listings

- an empty head view is not proof that a competing version is obsolete
- an missing head view is not proof that a competing version is obsolete

**M835** - remove ancestry read budget

- ancestry reads stop at the fixed budget on a long private branch
- a partial ancestry graph is discarded when its newer base exceeds the read budget

**M836** - swallow transient ancestor failures

- a retained ancestor read failure is retried without publishing a conflict

**M837** - accept substituted ancestor identity

- an ancestor response cannot substitute a different version

**M838** - accept non-array ancestor parents

- an ancestor response rejects non-array parents

**M839** - accept too many ancestor parents

- an ancestor response rejects too many parents

**M840** - accept malformed ancestor parent ids

- an ancestor response rejects malformed parents
- an ancestor response rejects non-string parents
- an ancestor response rejects array-shaped parents

**M841** - walk below known shared frontier

- ancestry traversal stops at the shared frontier instead of reading older history

**M842** - fetch all missing frontiers at once

- ancestry traversal stops at the shared frontier instead of reading older history

**M843** - omit ancestry loaded receipt

- typing merges after its common base leaves the ten-version listing
- a criss-cross merge loads the shared pair's omitted ancestor

**M844** - omit ancestry budget receipt

- ancestry reads stop at the fixed budget on a long private branch
- a partial ancestry graph is discarded when its newer base exceeds the read budget

**M845** - omit unavailable ancestor receipt

- missing historical ancestors keep both edits instead of guessing a base

**M846** - remove ancestry traversal visited guard

- repeated ancestry edges are traversed once, including a hostile cycle

**M847** - append fetched ancestors after their known parents

- a fetched child precedes its already-fetched parent when choosing the merge base

**M848** - retain partial graph after ancestry failure

- a partial ancestry graph is discarded when its newer common base is unavailable
- a partial ancestry graph is discarded when its newer base exceeds the read budget

**M849** - omit recursive criss-cross ancestry lookup

- a criss-cross merge loads the shared pair's omitted ancestor

**M850** - reject non-string parents even when they have string-like length and indexing

- an ancestor response rejects array-shaped parents

**M851** - discard the partial graph when the ancestry read budget is exhausted

- a partial ancestry graph is discarded when its newer base exceeds the read budget
