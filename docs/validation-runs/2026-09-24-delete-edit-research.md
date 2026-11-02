# Delete-versus-edit decision, 2026-09-24

The user chose edit-wins behavior for #178: one live head, deletion retained
in history, and no repeat deletion notices after settlement.

A hosted sync service's troubleshooting guide describes Markdown merge and
other-file conflict handling, and its version history documents recovering
deleted notes separately from current files. A block-based editor's delete and
restore guide describes Trash and restoration before editing a deleted page. These sources
do not establish a universal delete-versus-edit winner. The exact winner here
is the user's explicit decision, not a claimed guarantee about either product.

The implementation uses existing version-graph parents: the live settlement
names the recorded edit and the deletion, leaving unrelated live heads alone.
It waits for any earlier local publication before choosing that parent.
A replayed deletion is already an ancestor and cannot reopen the fork.
Identical settlements deduplicate through the existing server protocol.

Tests cover published and unpublished edits, two concurrent identical
revivals, a startup upload race, a failed earlier upload, queued publications,
an unseen live edit, retained deletion history, replay and subsequent edits.
M650–M657 exercise the new parent, queue and deduplication decisions. M252 and
M253 are recut for deferred-settlement notices. M318 is retired because its
successful-revival notice and suppression set no longer exist; successful
settlements are silent, asserted directly by the regressions.

These are automated outcomes. Current native desktop and phone journeys and
setup captures remain separate acceptance work.
