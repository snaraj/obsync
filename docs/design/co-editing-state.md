# Co-editing state and migration proposal

Status: draft for review, 2026-10-05. No engine, wire format or migration on
this page is implemented. The proposed character-engine and direct-buffer
experiments remain **NOT_RUN**. The
[experiment plan](../validation-plans/co-editing-experiments.md) records the
separate completed desktop public-save pilot and remaining gates. This document
does not close [#315](https://github.com/snaraj/obsync/issues/315).

The proposal follows the issue's
[agreed corrections](https://github.com/snaraj/obsync/issues/315#issuecomment-5947404309)
and the [delivery rulings](https://github.com/snaraj/obsync/issues/254#issuecomment-5958749968):
whole-note deletion wins, concurrent text remains recoverable, and the engine
is deferred. The shipped [architecture](../architecture.md),
[protocol](../protocol.md) and [storage contract](../storage.md) remain in force.

## 1. Starting point and decisions needed

Source inspected: released 1.1.6,
`897124b073baf51ef2cb3fff52a5badc1940a237`. Its plugin source is unchanged
from 1.1.5. Fresh experiments use this exact baseline and record each
candidate commit and artifact hash. Design preparation belongs to
[#325](https://github.com/snaraj/obsync/issues/325) in 1.1.7; the engine remains
in the later release tracked by #315.

| Current source | Consequence for the design |
| --- | --- |
| [pull.ts](../../plugin/src/sync/pull.ts), `applyVersion`, `reviveFile`, `EDITING_WINDOW_MS`; [main.ts](../../plugin/src/main.ts), `editing` | Delete versus edit currently revives the note. Recent input holds a remote write for the 10-second editing window; unsaved text and active composition can hold it longer, until their conditions clear. Changing the winner requires a new format and recovery path. |
| [conflict.ts](../../plugin/src/sync/conflict.ts), `threeWayMerge`; `MERGE_STORM_LIMIT` in pull | Bounded line merging and conflict copies are the current fallback. They cannot become a character algorithm by reducing debounce. |
| [engine.ts](../../plugin/src/sync/engine.ts), `EDITOR_SETTLE_MS`, `pushNow` | A recent editor save settles after 150 ms, after the host's save. A refused publication remains unsent; an unknown API refusal does not call `sent`. |
| [main.ts](../../plugin/src/main.ts), `trackInput`, `editing`, `refreshEditors` | Trusted input and IME protection exist. Whole-view refresh is guarded against local typing; it is not a transaction bridge. |
| [state.ts](../../plugin/src/state.ts), `FileRecord`, `State.save` | Metadata and native secrets have revision binding, but no cross-store crash transaction or operation outbox. |
| [files.rs](../../crates/obsyncd/src/api/files.rs), `post_version`; [storage/mod.rs](../../crates/obsyncd/src/storage/mod.rs), `post_version`, `commit_batch` | The server admits authenticated whole-file versions, checks heads and durably commits. It has no format fence. |
| [gc.rs](../../crates/obsyncd/src/storage/gc.rs), `plan` | Retention can remove old non-head versions, or a sufficiently old sole tombstone's whole history. A causal log cannot use this unchanged. |

The following are implementation blockers, not permission to weaken a rule:

| Conflict or missing contract | Proposed disposition |
| --- | --- |
| #315 requires future keys to exclude a revoked device; every current owner device knows the root key encoded by the recovery phrase. | Fresh epoch keys must not derive from or be wrapped under that old root. Review a separate recovery authority, or a replacement recovery secret at rotation. The old phrase can recover old epochs only. No automatic rotation ships before this is resolved. |
| Unknown manifest versions stop old reads, not old writes. An old client can also create a fresh file ID for the same path after losing its state; the blind server cannot identify that alias. | Recommend an explicit account-wide minimum writer protocol when the first note converts, plus per-note generation fences. All 1.1.5 writes then stop visibly and retain local bytes. This is broader than the issue's suggested per-note boundary and needs explicit agreement. Transparent continued 1.1.5 co-writing is not claimed. |
| Whole-note deletion cannot update a connected 1.1.5 projection that cannot interpret the new generation. | Its stale local copy remains until update/import; never advertise it as a participating co-editor. "Everywhere" means convergence after each device runs a supported client and reconnects. This compatibility consequence must be accepted with the upgrade boundary. |
| A mobile adapter has no public fsync or durable operation-outbox transaction. | Separate locally visible, host-saved and server-durable states. Do not acknowledge a local crash-durable save without a supported host guarantee. This blocks a universal offline-keystroke durability promise. |
| The official editor extension uses CodeMirror modules; repository requirement 5 has a closed build-input list. | Use only the host's existing module instances if approved, with reviewed API declarations and no bundled library or package install. No implementation until the host API boundary and type-input policy are explicit. |
| The issue says reordered data must be refused, but independent concurrent events can arrive in either order. | Refuse altered causal bindings, conflicting identities and stale membership. Buffer an authentic event missing a parent within a fixed bound; integrate independent events deterministically. Exact duplicates are idempotent, never a second edit. |
| The issue still describes the full engine's acceptance; this design and bounded experiments are only its deferred preparation. | Keep engine acceptance open. File the implementation tracker in the deferred milestone after the design and measured experiment record are accepted; do not close the parent for a docs-only delivery. |

## 2. One authoritative history per note generation

The unit is `(opaque note ID, generation)`. A generation is either `legacy`,
`preparing`, `active`, `deleted` or `held`. A conversion seeds one immutable
checkpoint from an authenticated legacy frontier. An active generation has one
encrypted causal event history and a local Markdown projection. It does not
publish continuing v1 snapshots as a second writable history. Attachments and
unconverted notes retain the existing whole-file mechanism.

An event records its author key ID, fresh session ID, counter, preceding event
from that session, causal parents, generation, membership epoch and operation.
Text, paths, cursor positions and the semantic event payload are encrypted.
The outer routing envelope exposes opaque note, generation, epoch, author,
session, counter and parent-event labels, plus ciphertext length and identity.
Their authenticated copies inside the encrypted payload must agree with that
envelope. These fields reveal activity and causal relationships, not just size.
Stable
operation identities survive reconnect, acknowledgement loss and checkpointing.
Arrival order and server timestamps never choose text order.

The algorithm candidate is an Eg-walker style event graph with deterministic
sequence ordering. Its paper separates immutable causality from replay and
allows temporary merge state to be discarded; it also describes worst-case
replay of the whole graph. Those are reasons to experiment, not measured obsync
properties. Retaining an event history is different from retaining its expanded
in-memory merge state. [Eg-walker, sections 2.3 and 3.5](https://arxiv.org/html/2409.14252v1).

The experiment must pin one sequence-order algorithm and its exact version
before results. A consistent byte string alone is insufficient: concurrent
passages must not interleave character by character. The Fugue work supplies a
separate non-interleaving criterion to assess. No third-party implementation is
bundled. [Fugue/FugueMax paper](https://arxiv.org/abs/2305.00583v3).

### Range and whole-note deletion

- A range deletion removes the character identities visible in its causal
  context. A concurrent insertion inside that range survives. This rule also
  applies to replacing a selection: delete observed identities, then insert.
- A whole-note deletion ends that generation. Concurrent insertions, renames,
  external rewrites and delayed editor saves cannot make it live again. They
  are retained as recoverable branches associated with the deleted generation.
- The receiver first preserves its newest editor buffer and unsent outbox in
  recoverable storage, then removes the live projection. If preservation fails,
  it holds the transition and says that deletion is waiting to preserve local
  changes. It never acknowledges completion and discards those bytes.
- History and a plugin-owned Trash view expose the preserved text and original
  name even if the host is configured for permanent deletion. Ordinary host
  trash alone cannot satisfy this. Retention must keep the recovery branch for
  the disclosed history window; incomplete preservation is never GC-eligible.
- One notice per `(note ID, deleted generation)` on each device says that the
  note was deleted and its other changes can be recovered from history or trash.
  A persisted receipt prevents restart, replay and reconnect from repeating it.
  Recovery failure uses the existing error channel rather than a success notice.
- Explicit Restore creates a new note identity, referencing the recovery
  source inside encrypted metadata. It cannot cancel an old deletion or consume
  another occupied path. Later arrivals for the old generation stay in history.

These rules change only converted notes. The existing delete-versus-edit
behavior remains accurately documented for 1.1.6 and unconverted notes.

## 3. Authentication, encryption and membership

Reuse AES-256-GCM, HKDF-SHA-256, SHA-256 and platform randomness. The candidate
adds device-held P-256 signing keys through WebCrypto, separate from pairing's
ephemeral ECDH keys and the server-issued request secret. Availability and key
persistence are native acceptance gates on each platform. WebCrypto specifies
P-256 ECDSA/ECDH; that does not prove a particular host's implementation.
[Web Cryptography specification](https://www.w3.org/TR/webcrypto/).

A device's long-term public signing and key-agreement keys must be bound to
the already authenticated pairing transcript, and then to a signed membership
chain. A server-supplied device name, `device_id` or heartbeat cannot establish
content authorship. An ordinary shared vault AEAD key proves only possession
of that key. Key substitution, an unknown signer or competing membership heads
holds the note rather than selecting a server-preferred roster.

The wire-design review must freeze a canonical encoding with explicit lengths,
fixed integer ranges, no duplicate fields, domain separation and published
vectors before code. Sign the complete semantic event, including context and
membership, then encrypt it. Event identity comes from the canonical unsigned
event, so different valid encodings of an ECDSA signature cannot create two
edits. A repeated author/session/counter with different content is a fork and
stops application. Valid duplicates do nothing.

Candidate nonce discipline: derive separate content and presence keys for a
fresh 256-bit random session under the current epoch key; use a strictly
increasing 96-bit counter per derived key. Serialize allocation before each
encryption and refuse counter exhaustion. Never persist or restore a live
session for further encryption. Restart, backup restore and another process
start fresh sessions; a persisted outbox resends its exact ciphertext only.
Checkpoint creation uses a separate purpose/key. This removes counter rollback
and mixed-purpose reuse; session uniqueness still rests on platform entropy
and the negligible collision probability of the session identifier. The
security review must check this construction, crash ordering and limits;
test success is not a universal nonce proof.

Revocation has two boundaries. The existing server-auth revocation immediately
refuses future requests and must also close an authenticated socket. Content
revocation requires a fresh random epoch key, distributed only to authenticated
remaining members using device key agreement and AEAD. It cannot erase old
content or old keys. A member offline across rotation obtains its authorized
epoch chain before sending; it may submit its preserved old-epoch work for
current-member validation, never silently label it a new-epoch edit. Operations
from a revoked identity beyond the signed retirement frontier are not applied;
the holder can retain or explicitly export its own text.

No fresh key is wrapped under a root already known to the revoked device.
This is why unchanged old-phrase-only recovery and future-key exclusion cannot
both be promised. Membership authority, concurrent rotations, recovery after
loss of every remaining device and signed retirement frontiers require a
separate reviewed decision. Until then the networked rotation experiment is
blocked; it cannot substitute server trust for that decision.

The client authenticates causal links and retained checkpoints before applying
them. Missing dependencies have a bounded waiting state; equivocation is
reported when conflicting evidence meets. A server can withhold the final
event, all witnesses or an entire membership update. Silence is indistinguishable
from disconnection: the status becomes stalled/unknown, never a claim that
the server has proved completeness, freshness or absence of a fork.

Future-content exclusion begins for each writer when it validates the epoch
that removes the device and starts using the fresh key. An offline writer, or
one whose membership update the server withholds, can still encrypt new text
under the old epoch; the removed device can read that text. Ordinary successful
requests do not prove fresh membership. Reconnecting writers validate the
available epoch chain before publication, but this alone cannot detect a
withheld newer epoch. A global revocation-time guarantee needs a separately
reviewed freshness mechanism; this design does not claim it.

## 4. Transport and durable acknowledgements

Keep existing signed HTTP as the durable write path for the first experiment.
A batch is acknowledged only after nonce persistence, ciphertext durability and
the journal commit that makes it discoverable. Group commit already exists;
the experiment measures its reuse before proposing another mechanism. Lost
answers reconcile by exact event identity; they do not create a fresh event.

WebSocket is a later measured candidate for notifications and encrypted
presence. The browser constructor accepts a URL and subprotocols, not arbitrary
authentication headers. Mint a short-lived, single-use ticket over signed
HTTP; bind it to the device and a fresh connection challenge, consume it in
the first frame, and transmit no application data before verification. Never
put credentials in a URL or subprotocol. Reconnect obtains a new ticket;
revocation, expiry and server restart invalidate it. Authentication deadlines,
ticket inventory and unauthenticated connections are bounded. Origin checks
are additional filtering, never authentication. [WebSockets standard](https://websockets.spec.whatwg.org/#the-websocket-interface).

Durable content continues through the existing request-auth path. If a later
proposal sends content on the socket, it must preserve the current signed
request envelope, durable nonce reservation and acknowledgement semantics;
ticket authentication alone does not replace replay protection. WSS terminates
at the existing trusted TLS proxy; the server remains HTTP. RFC 6455 framing,
masking, fragmentation limits and handshake hashing need isolated review and
vectors. Compression extensions are refused. [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455).

Only one delivery worker applies a note at once. A socket notification wakes
the same worker as the feed, with identity-based duplicate suppression. Socket
failure or mobile backgrounding returns to long polling and then a bounded
catch-up. It never starts a competing application path. Presence is encrypted,
expires locally, carries no durable acknowledgement and cannot hold content
progress. No presence updates are emitted while idle; no cover-traffic privacy
claim follows from that choice.

Prototype batches use a fixed 100 ms window and size buckets, as fixed in the
experiment plan. The server still sees account/device activity, opaque note
and epoch/session labels needed for routing, batch counts, size buckets,
ciphertext identities, causal routing metadata and times. It cannot read text,
positions or paths. Padding reduces size precision, not timing observation or
the distinction between idle and active editing. Metadata added by each wire
field must be listed before the experiment, not inferred after an observer run.

### User control and privacy boundaries

Enabling co-editing must explain the upgrade boundary before converting data.
Local Markdown remains readable without the service. Pausing sync stops new
publication while preserving local edits; leaving a shared vault preserves an
explicitly chosen local copy and removes its credentials. Neither action is
described as erasing copies already held by other devices.

Presence is optional and initially disabled. Disabling it stops new cursor and
typing messages without stopping content sync. Content activity still exposes
timing and size metadata to the relay; the interface must not imply otherwise.
Logs and diagnostics retain event counts and opaque identifiers, never note
text, paths, selections, recovery phrases or keys.

History retention and deletion must show what remains recoverable, on which
devices, and when acknowledged server deletion completes. Offline copies and
backups cannot be remotely guaranteed erased. Export must include the latest
local edits and separately identify pending or recoverable branches; it cannot
silently export only the last server acknowledgement. An encrypted archive and
a deliberately requested plaintext export have different privacy consequences.

## 5. Editor, local storage and checkpoints

Use the public `registerEditorExtension` entry point and the host's own
CodeMirror instance. Obsidian documents CM6 extensions and its official sample
leaves CodeMirror modules external. That supports investigating a host API
binding; it does not waive this repository's dependency rule.
[Obsidian editor extensions](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Editor%20extensions.md),
[official sample externals](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs).

One bridge per note maps local transactions to events before disk save, and
maps authenticated remote operations back to every view, including split and
popout views. Remote transactions are tagged so they do not echo or enter the
local user's undo history. Local undo/redo emits new causal operations scoped
to local changes; it never rolls a shared snapshot backwards. Character
identity and editor offset conversion must handle UTF-16 surrogate pairs,
combining marks and grapheme selections without silent normalization.

An active IME composition retains its local range and selection. Incoming
operations are mapped without overwriting composition; if that cannot be
proved for the host, hold them visibly until composition ends. This may miss
the latency target and must be recorded as a failure, not hidden by excluding
those samples. Cursor stability and correct text are separate observations.

Disk is a materialized projection, not an independent merge authority. Save
ordering records which frontier produced the bytes; watcher echoes compare
that identity. An external rewrite is diffed against the exact projection it
replaced and becomes a causal edit. If that base is absent or a bounded diff
cannot finish, preserve the new bytes and hold that note for explicit recovery;
never guess positions, drop text or silently fall back to a conflict-copy
engine. CRLF/BOM preservation has an explicit projection rule and byte oracle.

Local state includes the validated checkpoint/frontier, pending exact encrypted
frames, projection receipt, deleted-generation recovery receipts and notice
receipts. Keys stay in the existing native secret custody. Metadata contains
no plaintext operation content or plaintext content hashes. The outbox is
encrypted even though the user's Markdown files are ordinary local files.

Distinguish `visible in editor`, `saved by host`, `sent`, `server durable` and
`applied by peer`. A renderer event or a resolved mobile adapter write is not
proof of crash durability. On desktop a local outbox can use exclusive private
files, file fsync, atomic publication and directory fsync with confinement.
Mobile needs a documented durable host route or an explicit unmet capability;
the existing SecretStorage/readback contract supplies no such proof.

Checkpoints bind the generation, membership epoch, exact causal frontier,
materialized text digest and retained-history references inside encryption.
Verify them against authenticated events before dropping expanded merge state.
An idle device with a checkpoint must still reconstruct a late concurrent
branch. Ordinary version GC cannot remove the log needed for that operation.
The candidate therefore retains immutable history segments and reference pins;
compaction initially changes memory only. Deleting retained segments requires
a separately proved stable frontier acknowledged by every non-retired writer,
plus recovery retention. An offline writer delays that frontier; a timeout
cannot silently retire it. Disk pressure invokes the existing visible capacity
refusal. Fixed client working budgets do not introduce a server file-size cap.

## 6. Conversion, mixed writers and downgrade

1. **Prepare locally.** Drain the note's publications, authenticate every
   current legacy head, resolve existing forks explicitly and preserve unsent
   buffers. Record the source frontier and checkpoint digest. Unknown heads or
   a concurrent save keep the note legacy; no remote fence has been committed.
2. **Propose the boundary.** Show the user that old clients will retain edits
   locally and must update before sending. Require an authenticated membership
   acknowledgement from supported writers. A heartbeat version string alone is
   not proof that a device can use the new format. An offline old writer is an
   explicit upgrade boundary, not assumed assent.
3. **Commit atomically.** A new server operation compares the exact legacy
   heads, then durably commits the account's minimum writer protocol, note
   generation fence and seed checkpoint reference together. A raced legacy
   write makes this comparison fail without conversion. A lost response is
   settled by reading this exact conversion ID. The last state is either
   fully legacy or fenced with a retrievable seed, never half converted.
4. **Activate after verification.** Clients verify the signed conversion and
   checkpoint, save their local receipt, then attach the editor bridge. A crash
   before that receipt resumes from the server's committed conversion. A server
   answer alone cannot make a client trust an unverified checkpoint.
5. **Keep old text safe.** Legacy writes with the original ID, fresh IDs,
   delete/rename/folder operations and their bulk forms are refused by the
   account writer gate before mutation. Old clients can still read legacy
   history and retain local edits. Use a distinct `upgrade_required` refusal,
   never `domain_mismatch`: 1.1.6 handles the latter by forgetting the old ID
   and publishing again. No claim about old-client UI or restart safety is
   accepted until the unchanged 1.1.6 binary passes the native experiment.
6. **Resume after updating.** Compare retained old-client bytes with its
   authenticated legacy base, preserve them first and import the resulting
   edit into the active generation. A missing base holds for recovery. If the
   note was deleted meanwhile, the edit enters that generation's recovery
   branch and does not recreate the live note.

The account-wide gate is intentionally an unresolved rollout choice: a
per-identity fence alone leaves fresh-ID aliases possible. A design promising
continued old-client writes to other notes needs a different proved boundary
that still keeps paths encrypted. It cannot merely say "write both formats".

Before conversion, downgrade is ordinary legacy behavior. After conversion,
an old plugin may read its local Markdown projection but cannot publish to the
fenced account; deleting local metadata does not remove the server gate. An
old server must refuse a store declaring the newer minimum storage format
before it accepts any writes. The existing journal reader's unknown-frame
behavior is not sufficient proof: a snapshot can otherwise hide the fence.
Restore tooling and every journal/snapshot entry point need that durable marker.

A rollback to the old server and a pre-conversion backup loses later history
on the server. Updated clients retain signed conversion/frontier receipts and
stop on the rollback rather than silently resuming v1. A fresh old client with
no such receipt cannot detect a maliciously rolled-back server. This limitation
must remain explicit. Returning the user's data to an old deployment means a
verified plain export into a new vault after preserving all pending edits;
it does not downgrade the authoritative causal history in place.

## 7. Review and delivery boundary

The experiment plan fixes resource ceilings and failure behavior before data.
The design review must settle the conflicts in section 1, the sequence-order
choice, canonical encoding, membership/recovery authority and platform storage
capabilities before engine implementation. Independent adversarial and dedicated
security reviews remain required. No encryption, auth, replay, integrity,
fsync, path or capacity guard becomes optional.

The docs-only change advances no release. The experiment branch is pushed for
reproduction and never merged; its records cite exact source, commands and
failures. Only later reviewed artifact PRs can ship an engine. Until the real
desktop/phone, mixed-writer, recovery and hostile-input rows pass, the product
continues to promise its current whole-file behavior.
