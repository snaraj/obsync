# Device revocation: fresh-root re-enrollment contract

**Status: implemented candidate; integrated validation and independent review pending.**
This is the revocation contract for [audit #344](https://github.com/snaraj/obsync/issues/344). No security PASS,
shipping capability or release assignment follows from this document.
This delta addresses findings 1, 2, 3 and 7 of the
[independent checkpoint](https://github.com/snaraj/obsync/issues/344#issuecomment-6131002504);
its acceptance cases below are requirements, not passing evidence. Runtime
entry points are `RotationClient`, `rotationReseal`, the version-2 `State`
custody transaction and the server's `api/rotation` and `storage/rotation`
modules. [Run records](../validation-runs/2026-10-12-security-train.md) distinguish
component, integrated and native observations.

## Choice and cost

Every removal asks for one of these actions. The first is recommended on each
invocation; a previous choice never becomes a saved weak default.

| Action | Confirmation and result |
| --- | --- |
| **Revoke access and rotate keys** | “Create a new vault key and recovery phrase, upload a newly encrypted copy of the synced vault, and pair every remaining device again. Old/offline devices can still upload with old keys if a server permits them. Protection starts on each device after it transitions.” |
| **Revoke server access only** | “Stop this device's access on an honest server. Its retained keys and recovery phrase can still decrypt later ciphertext obtained from a copied volume or a colluding server. Content keys will stay the same.” |

Encryption, authentication, integrity checks and replay protection remain
mandatory in both actions. Neither action erases earlier plaintext, ciphertext,
keys or recovery phrases. Strong removal requires a separate trusted client:
the device being excluded must never generate or receive the replacement root.

The smallest candidate is a **fresh root, full reseed and explicit re-pair**.
It reuses keyed map identity, per-domain admission and
pairing v2. There is no automatic group-key broadcast or trusted server key
directory. Cost: upload every current file again, temporary space for both
generations, a new recovery backup, and one comparison/confirmation on every
retained device. Unsynced edits remain available locally throughout.

Compose this transaction with the [suite-2 sealing contract](e09-key-nonce-inventory.md#chosen-replacement-rfc-5297-aes-siv-with-one-migration):
RFC 5297 SIV, counted context, strict recovery backup and durable enrollment/write
floor. They activate in one migration. The earlier custom GCM candidate is
rejected. Existing root/domain/map identity labels remain; content and pairing
seals use the new suite. Neither design acceptance nor component tests establish
the completed transaction.

Transparent automatic group rotation would additionally require independently
authenticated persistent recipient identities, membership authorization,
per-recipient delivery, anti-replay state and fork/concurrent-update rules.
Current device IDs and API secrets do not supply those properties against a
compromised server. That larger protocol is not part of this candidate.

## Separate owner authorization and supported-server preflight

Routine device authentication must never replace recovery authority or retire
all other credentials. Both prepare **and commit** require the initiating
device's existing HMAC authentication **plus the owner-supplied standing setup
token**, checked with the existing setup-token semantics. The old or new
VRK-derived proof is not this independent factor. Present the exact operation,
old/new map IDs, target and staged verifier on the trusted client before each
owner authorization; persist those typed fields as the immutable intent.
Commit additionally binds the frozen cutoff/inventory and completed catalog
commitments below. A changed field refuses rather than revising the operation.

The plugin keeps this token only in memory for the requested action, never in
its secret envelope, metadata, logs, dashboard or management CLI. Re-enter it
after restart and at commit; do not make a stored bearer grant that a routine
coordinator credential alone can use to commit. This reuses separate operator
authority and introduces no new credential service. The server/terminator
already holds/sees this authentication material; it is not a content identity
or protection from a malicious server bypassing its own authorization.

Before stopping normal sync irreversibly, generating a new root or saving a
rotation phase, read `GET /v1/rotation/capabilities` with existing
device authentication. Require the explicit protocol version supporting owner
authorization, stable cutoff inventory, paged catalog and atomic coordinator
transfer; no inference from a general plugin/server version. Missing, malformed
or unsupported capability refuses strong rotation without changing the current
root/pin or silently executing access-only removal. Check again before prepare.
Discovery is availability evidence, never cryptographic server trust.

If support disappears before any prepare request is sent, discard only the
uncommitted draft on explicit cancellation and preserve the old identity/edits.
After dispatch, lost replies, contradictory status or unsupported status routes
are `prepare_unknown`: remain stopped/pending. Only an explicit, reliable
no-transition result from an honest server allows the person to cancel a draft
and explicitly resume the unchanged old generation, with no strong-revocation
claim. Once prepare has applied, no automatic abort or old-root resumption is
allowed. A server denial alone cannot prove nontransition against a malicious
server; uncertain state must not become a downgrade.

## Generation and authority

Use existing root-derived map identity as the generation identifier:

```
VRK_new = newVaultKey()                         // fresh 32 random bytes
G_new = domainMapKeys(VRK_new).fileId           // existing keyed map identity
L = existing lineage, otherwise G_old          // stable local lineage
O = randomBytes(16)                            // one rotation operation
```

Derive a fresh default content domain and fresh ordinary file IDs from the
independent new root, with the fixed rotation labels below so a retry reproduces
the same destinations. Existing
folder/conflict IDs and the map's domain ID derive under the new keys. Reuse
the root/domain/map identity derivations and request signatures; use suite 2's
separate sealing derivations and counted generation context. Fresh roots and
the authenticated generation pin separate current content from history. Reject equality
with the prior root/map/domain identities; RNG errors stop before revocation.

`{L, O, G_old, G_new}` is a fixed enrollment context, not a server identity.
Lineage/operation are migration and history bookkeeping, not additional
confidentiality or decryption prerequisites; the root-derived map ID supplies
content-generation separation.
The trusted initiator fixes it and the new root locally before creating any
pairing code. A new client accepts it only through authenticated pairing from
the actual trusted device, or its own recovery backup. Server-reported device
names, IDs, versions, heartbeats and lists are hints, never content authority.

The content membership is exactly the devices to which the person explicitly
approves a fresh pairing. All prior holders must re-pair, even if an API list
says they are active. There is no retained-recipient directory to which a
server can silently re-add an old public key. A fresh claim for a removed
physical device still must be refused by the person; this protocol cannot
identify physical devices from server names or protect an endpoint that the
person deliberately approves or that is already compromised.

## Pairing and recovery: extend data, preserve pairing v2

Keep v2's fresh ephemeral P-256 keys, creator commitment in the out-of-band
code, claim fixed before reveal, six-digit comparison and ECDH/PS base-key
derivation. Seal with suite 2's SIV/context and explicit wire variant. No new
comparison function or asymmetric identity scheme is needed. Compare the codes on
the two actual device screens; never compare a server/dashboard rendering.

The encrypted envelope plaintext is a strict suite-2 variant:

```
{"v":2,"vrk":"<64hex>","generation":"<32hex>"}
```

The literal suite-2 wire discriminant, absence of a legacy nonce and SIV
framing prevent the old GCM reader from opening this variant. Updated parsing
requires exactly `v`, `vrk` and `generation`, rejects unknown fields and invalid
hex, and requires `generation` to equal `domainMapKeys(vrk).fileId`. Rotation
operation and lineage are local transition bookkeeping, not pairing authority.
Legacy envelopes belong only to an explicitly selected old-generation
operation. Updated live enrollment requires suite 2, including new accounts
without migration history. A claimant shows “New vault generation;
pair from the device performing this rotation”, then explicitly accepts the
authenticated context. A device already pinned to another generation requires
the migration flow; an ordinary pair/setup reply cannot replace its pin.

The existing envelope AEAD authenticates the context and root together to
this one fixed pairing and both public keys. A server cannot substitute the
context or a recipient, replay another pairing's envelope, or turn an old
envelope into one carrying the new root. An intercepted code still requires
the meaningful screen comparison; retain v2's stated per-attempt comparison
bound. Never approve automatically based on app version or device name.

Existing recovery phrases encode root entropy. Generate and show the new
prefixed 24-word backup **only on the trusted plugin**, following suite 2's exact
ASCII grammar and explicit live/history parsers. Require complete backup and
readback verification before server commit. Restoring this backup derives the
new root and `G_new` without any recovery card or server-selected map. Reuse
the existing account-recovery proof and
verifier derivation under `VRK_new`, with its existing content/authentication
role separation. Commit replaces the old verifier atomically; this is the
one new replacement path, not a generic recovery-verifier setter. An old
phrase plus all server state/future traffic cannot derive `VRK_new`.

Do not automatically fall back to an old phrase, retained root or
server-supplied generation. No phrase proves it is the latest backup when a
server withholds a transition. Show the locally derived generation and this
freshness limit; a server cannot make valid old-map ciphertext open under the
new phrase. The old phrase can still open old history or authenticate to a
malicious server; neither grants the new root.

## Local transaction and cutover

Both secret-envelope and metadata versions advance to 2 so the pre-transition
reader rejects them. The installation's
owned secret envelope carries one bounded rotation record:
new root, fixed context, phase and its existing initiating credential. Keep
one old root separately as **history-only**, not as an alternate sync
credential; before another rotation, preserve older needed history with its
phrase/ciphertext backup instead of growing an automatic root archive.
Nonsecret metadata holds the credential revision and generation/phase pin.
The bounded encrypted record holds the prepared inventory and commit receipts;
the client deterministically recomputes the seed mapping on resume. Local
notes remain in place for ordinary reconciliation after activation; no new
unbounded durable edit queue is introduced. No root, domain, manifest, map or chunk key enters `data.json`, server
requests, dashboard, CLI, diagnostics or logs. Server API credentials retain
their existing role and custody; they are not content keys.

The local phases are `draft`, `prepare_unknown`, `prepared`, `seeding`,
`commit_unknown` and `active`; only `draft` is reversible as described
above. A refusal preserves its actual pending phase and displays its reason;
there is no persisted `blocked` phase that could erase an uncertain outcome. While prepare is applied or its outcome unknown, no reload, credential
revision fallback, missing map or retry may resume old-root encryption. Missing or
inconsistent rotation/pin state stops sync; rotated metadata with a missing
owned secret must not take today's fresh-copy/unpaired fallback. Preserve the
existing serialized saves, session/lifecycle binding and engine-drain ownership; a late old-engine
callback cannot save an old root or upload its queued ciphertext.

1. Complete supported-server preflight, then stop/drain the initiating engine
   and settle editor saves. Preserve local bytes, dirty edits and retry intent.
   A local pre-fence catalog is only an edit baseline, **not** the accepted
   server snapshot or completeness boundary. No prior device selection or
   download ceiling defines which server content the operation may omit.
2. Generate and persist/read back the independent new root and fixed context,
   a fresh map/domain and a separate new-file-ID catalog. Confirm the new
   recovery backup. Record person-designated retained devices locally, not
   from server membership assertions. Do not overwrite the old catalog,
   local notes or old pending queue. A failed local save performs no server transition.
3. With separate owner authorization, prepare the server operation below.
   It serializes against the durable write pipeline and returns cutoff `C`
   and an immutable snapshot of every current-generation head at that cutoff, `H`.
   Reconcile through `C` before choosing the reseed source: every racing old
   write is durably included before the fence or refused afterward, even if
   its request authenticated before prepare. Report “Server reports access revoked;
   rotation pending” only after resulting-state readback. With an uncertain
   response,
   show “Server access outcome unknown; rotation pending” and reconcile.
4. Page the full current-generation account inventory `H`, across every
   domain, including map/control/folder/tombstone heads and **every live file
   fork head**. Prior labelled generations remain separate history under the
   server-internal ownership rule below; no lost local retirement catalog or
   old root is required for new-phrase recovery and a later rotation. Unknown
   ownership or an undecryptable current head is pending, never silently skipped.
   Materialize and validate all current content despite the initiating device's `syncFolders`
   or normal download eligibility. Preserve each fork's content/conflict;
   do not arbitrarily pick one head. Reconcile concurrent cutoff heads and
   local dirty edits without overwriting either accepted bytes or editor work.
   Use a capable trusted client's verified source if this device cannot do it.
   Reseed the complete accounted vault through existing routes with fresh
   keys/IDs. Do not reuse old sids, cids, ciphertext, manifests,
   cached chunks, parent version IDs, folder/control records or retry bodies.
   Same new-generation chunks may deduplicate normally. Read back and decrypt
   the new map and every seeded record against the reconciled cutoff source.
   Preserve tombstone/control semantics separately from live file bytes and
   publish the complete source-head to destination-head catalog below.
   Server counts/receipts alone are insufficient. Normal local selection
   applies after transition, not to the account-wide reseed obligation.
   Reserve explicit space/memory budgets; stream bounded chunks on supported
   clients. A remote-only, corrupt, missing or oversized source that cannot
   be safely materialized leaves rotation pending and forbids commit. Do not
   silently disable device ceilings or report an empty/narrow reseed complete.
5. Changes during reseeding remain local dirty work; check the source before
   and after each read and retry a changed file. Never overwrite a newer
   local/editor version to finish the snapshot. Drain old retries into
   quarantine; re-encrypt their plaintext intent under the new root rather
   than reposting an old body. A missing source, quota, disk-full or storage
   failure keeps the operation pending and the local bytes intact.
6. Re-enter owner authority and confirm the exact frozen intent, cutoff and
   completed catalog commitment. Commit the server transition, persist/read
   back the new-root pin bound to
   the unchanged initiating credential, and start only the new-root engine. It
   uses a separate bookkeeping catalog/cache and derives its domain solely
   from the new root's authenticated map. Never load an old map because the
   server omitted the new one. The source snapshot and all dirty edits must
   be accounted for before declaring this initiating device transitioned.
7. Every other retained device stops/drains its old engine, preserves its
   unsynced local bytes and authenticates a fresh pairing from the trusted
   initiator. It installs the new pin and uses a fresh sync catalog. Reconcile
   its local edits into the new generation as ordinary new-key edits/conflict
   copies; never reset/overwrite local files to obtain an empty first sync.
   Confirm generation and recoverability on the actual device after restart.

Obsidian's public `setSecret`/`saveData` APIs do not promise a joint fsync
transaction. Readback proves the host API result, not power-loss durability.
The recovery backup is mandatory; verify the prepared pin after a native app
restart before committing the server transition. Native restart/fault evidence
must validate supported persistence behavior before release. A torn/missing pin
must stop, never choose the old revision and silently keep writing. Local
state rollback by a compromised OS remains outside this protection; losing
both local stores to power failure cannot be described as a retained durable
pin without platform-specific evidence.

**Cutover meaning:** protection applies to writes encrypted under the newly
pinned root by transitioned clients. The initiator may say “New generation
ready; this device transitioned; other devices need pairing”. List retained
clients as pending until direct confirmation; a server heartbeat cannot
confirm their key or pin. Offline/old clients retain local edits and may
continue old-key writes to a colluding server that hides the transition.
There is no instantaneous global cutover or global fork-detection claim.
Never turn an unknown/offline client into a completed transition or discard
its edits. A consciously excluded device is not reported as transitioned.

## Minimal server coordination; not a cryptographic trust anchor

Add one bounded account rotation record, using the existing journal/snapshot
durability path. Fresh roots need no new ciphertext namespace for confidentiality;
add **server-internal file generation ownership** for inventory coordination.
This changes version journal records, replay and snapshots; suite 2 separately
changes the explicit version/pairing sealing fields and content encryption.
An older server reader must refuse the
new durable format, including compacted snapshots, rather than drop ownership
or fence state. Pre-transition readers skip unfamiliar/corrupt snapshots, so a
snapshot field alone cannot establish that barrier. Reserve `000000.log` for
one immutable CRC-framed `format_floor` marker. First durably append a floor-
bearing fact with a new record kind; then publish the marker by file fsync,
rename and directory fsync, before index publication or acknowledgment. Ordinary
append, roll and prune never use or remove the marker. If marker publication
fails after the fact is durable, retain that authority in memory, refuse the
request and forbid compaction until the barrier is complete. Upgraded startup
validates an existing marker separately before replay; a torn/malformed marker
refuses. Proven replayed floor-2 authority may finish a missing marker before
serving. A marker with only pre-floor authority after snapshot fallback refuses
as ambiguous, even if the older snapshot itself parses successfully.
Old replay decodes every frame before filtering its sequence, so the unknown
kind must stop an old executable even after snapshot compaction/fallback. Verify
that behavior with the actual predecessor binary, including the intermediate
atomic-enrollment format. No unfamiliar snapshot may silently lower the floor.

The record holds the immutable authorized
intent, coordinator device ID/grant, phase, cutoff/inventory reference and
catalog-page commitments. All IDs
are opaque; no content key is sent. The trusted initiator retains its existing
API credential: changing this server-known authentication secret adds no
content protection and would require unnecessary handoff/receipt machinery.
On a legacy account, first prepare records the supplied old map ID and assigns
all existing unlabelled file IDs to `G_old` in the same durable transition.
This bootstrap is permitted only when the upgraded store has no prior generation
association; conflicting/partially migrated ownership refuses. Snapshot/replay
must reproduce the assignment before acknowledging it. New files thereafter
receive the authenticated grant's server-assigned generation on first durable
publication; ownership is immutable. Existing IDs cannot be overwritten by a
different generation. While pending, only the coordinator may create/write
fresh `G_new` IDs; no grant may publish another `G_old` head. Validate the fence,
grant scope and file ownership under the serialized storage mutation lock,
including queued/grouped posts authenticated earlier, not just in HTTP auth.
On commit the surviving grant becomes ordinary `G_new`; later enrollment is
scoped to the current generation. Unknown ownership refuses publication.
Freeze ordinary pairing, setup/recovery and verifier registration while pending,
except the narrow coordinator transfer below; it cannot bypass the fence.

Prepare/commit also carry minimum enrollment/write suite 2. Enrollment declares
top-level `seal_suite:2`; setup/recovery also declares locally derived
`generation`. After commit, legacy generic setup/recovery, missing/unknown suite,
legacy pairing/grant activation and legacy publication refuse on an honest
server. A stripped backup prefix cannot bypass this policy. Check grants,
suite and ownership under the mutation lock, including queued requests. A
malicious server can ignore its policy; transitioned clients independently
enforce their authenticated suite/generation pin and never initialize a lower
floor from a missing map.

`H` contains **all** heads of every `G_old` file across the account, independent
of local selection. Earlier labelled generations are history and excluded from
current reconciliation; they are not deleted by rotation. This association is
honest-server coordination, never authenticated vault identity. Clients derive
their map locally and still check root/domain AEAD and their pin; a server label
cannot select a key, adopt old ciphertext or attest inventory freshness. A
malicious server can omit/mislabel unseen heads, within the stated omission
limit. Phrase-only recovery need not reconstruct a chain of retirement catalogs.

| Request | Durable semantics |
| --- | --- |
| `POST /v1/rotation/prepare` with the exact intent plus `setup_token` | Device HMAC **and separate owner token** required. Require the recorded current map to match `G_old` (or the permitted first-legacy bootstrap). In the serialized write pipeline, settle prior accepted batches, fence admissions, capture durable cutoff `C`/inventory `H`, then publish the prepare frame referencing that durable snapshot and any first-legacy ownership assignment. Revoke target/close its sessions and links in that same transition. Target must differ from coordinator. The current coordinator's same operation/exact intent returns the same cutoff/snapshot; changed or competing intent is `409 rotation_conflict`. No general recovery-verifier setter or disabled last-device hold. |
| `GET /v1/rotation/{operation}` and its paged inventory | Current coordinator-only status and stable pages for the recorded cutoff. Settle lost responses; never recompute `H` from later staged writes. No content secret or API credential appears. |
| `POST /v1/rotation/{operation}/catalog` | Current coordinator-only immutable bounded pages linking opaque source heads in `H` to uploaded opaque destination heads. An identical retry is harmless; changed page or out-of-inventory source refuses. No path, key, cid or plaintext field. This is rotation bookkeeping, not a general catalog framework. |
| `POST /v1/rotation/{operation}/commit` with exact intent, `C`, inventory/catalog commitments and `setup_token` | Device HMAC **and freshly entered owner token** required. Compare all fields to frozen intent and complete catalog. One fsynced transition changes current map/recovery verifier, retires every OTHER prior credential/closes its sessions/links, lifts only the current coordinator's staging fence and marks committed. Exact retry returns that result; it cannot substitute a verifier/target/catalog. |

The intent's `target` is an explicit device ID for removal, or explicit `null`
for a standalone migration to suite 2. A non-null target must exist and differ
from the coordinator. The null form still performs the complete fresh-root
reseed and retires every other credential at commit; it is not a weaker mode.
An existing legacy account refuses suite-2 recovery with `migration_required`
without changing state. Before its suite floor advances, explicit legacy
recovery may enroll a migration coordinator, whose updated client keeps normal
sync stopped and treats the old root as a read-only source. It then performs
this transaction. Only a genuinely new, absent account can initialize suite 2
directly; recovery or pairing cannot create a missing map.

The prepare frame references a durable immutable inventory, not an unbounded
head list packed into one frame. Capture it with bounded I/O and existing
file/directory fsync/rename rules while serialized admissions are held. Publish
neither fence acknowledgement nor prepare success before the snapshot and
referencing frame are durable. Crash before publication leaves no acknowledged
transition; replay after publication restores exactly `C`, `H` and the fence.
Retain the referenced old manifests/chunks against retention/GC while pending.

Catalog pages contain ordered tuples
`[old_file_id, old_head_id, new_file_id, new_head_id]`, sorted by source tuple;
use bounded page sizes and deterministic compact JSON of lowercase fixed-size
hex IDs. Hash each page with existing SHA-256; the completed commitment is
SHA-256 of the ordered raw page hashes, bound to page count/operation/cutoff by
the authenticated commit body. Retain only the raw page hashes for this checksum, rather than all catalog
pages; inability to finish is pending. The initial client bounds the complete
inventory at 65,536 heads, whose canonical hash input is at most 6.5 MiB.
A larger inventory explicitly refuses the operation; it is never truncated.
This is a supported-operation limit, not a cryptographic lifetime bound. Pages are consecutively numbered
from zero; source tuples are globally ordered, unique and exhaustive for `H`.
Every frozen current head must have a mapping and every
destination must exist under `G_new` ownership; an old-generation destination
cannot satisfy reseeding. Extras from local edits are recorded separately and
cannot substitute for required source membership. The trusted client verifies
plaintext, names, controls, conflict preservation and every mapped destination.
The honest server enforces inventory membership, not plaintext correctness.
This catalog reveals cross-generation ID linkage to the server: fresh IDs give
cryptographic separation, **not server unlinkability**. A malicious server can
omit/fork its inventory; the checksum is not authenticated global freshness.

Prepare supplies honest-server removal and a frozen inclusion boundary; catalog
pages account for the complete reseed; separately authorized commit switches
authority. There is no ack endpoint or new content/group-key protocol.

Pending recovery reuses `POST /v1/setup`: only the separate setup token plus a
proof matching the **staged new verifier**, exact frozen intent and a locally
persisted resume request ID may request coordinator transfer. One fsynced
transition retires the old grant and updates the operation's coordinator
device ID and restricted wrapped credential together. The replacement can
read that operation/status/inventory, stage and submit its catalog; commit
still separately requires owner token. No ordinary sync, changed intent,
new verifier, unfenced old writes or broader membership is granted.
Persist the request-ID to grant association with existing device/grant records:
an exact lost-response retry returns the same current grant without minting
another. An old/superseded resume ID refuses; replay must never re-enable a
retired grant or disclose a later coordinator's credential. Replay/snapshot
recovery restores the identity and grant together. A fresh later transfer
requires owner authority again and atomically retires the then-current grant.
The restored phrase derives the map ID locally; returned operation hints must
match it and cannot choose a root. A conflict remains stopped. Rebuild missing
progress from new-root ciphertext while preserving local edits; do not infer
completed reseeding from the server's phase alone. After commit, ordinary
new-phrase recovery follows existing account enrollment semantics.

The server does not certify reseed completeness or client membership. The
coordinator requests owner-authorized commit only after its own verified
complete reseed and recovery backup.
Without durable room for the single transition frame, refuse without partial
changes. Journal replay must reproduce the same fence/verifier/credential
phase; the usual timestamp/nonce persistence applies on every attempt.
Retired ordinary credentials receive a visible rotation-required/revoked
refusal; old software cannot silently continue on an honest server.

Do not implement automatic abort back to old-key sync. Recovery from a pending
operation resumes its exact locally kept new root and catalog. If local state
is lost, use its new phrase and existing setup authority to resume; otherwise remain stopped and
request a concrete recovery decision. Target revocation never gets undone.

An honest server serializes simultaneous rotations; a compromised server can
fork its answers or accept both. Each initiator retains its independent local
root/context/catalog. Neither adopts the winner from a CAS reply, deletes its
branch, or merges roots. Resolve a conflict directly on trusted devices:
choose one generation, preserve/export the alternate local edits, re-pair
the alternate writer and re-encrypt its edits into the chosen generation.
Only then may the person explicitly retire the unused local branch. Server
CAS is availability coordination and is not authenticated uniqueness.

## History and initiating surfaces

Keep old history as a separate history-only view using its old root and a
locally pinned pre-cutover frontier/catalog. It never feeds live reconciliation,
ancestor selection, merge caches, names, controls, tombstones or the current
editor. Later old-generation records—even valid tags made by an old root
holder—are not automatically admitted to that history snapshot or new state.
An explicit preview beyond the pinned frontier is labeled untrusted legacy
input; copying/restoring requires an explicit action and fresh encryption.
Do not treat old-key authentication as proof of an unrevoked author.

History already readable with old keys cannot be revoked retroactively.
Existing server retention/GC still applies: a local frontier is not an
indefinite server backup promise. Preserve needed old ciphertext/history with
the existing ciphertext backup/export process before relying on retention;
keep its old recovery material separately. A newly paired device receives
only the new root by default; old history can be recovered locally from its
separate old phrase/backup, never by wrapping the new root under an old key.
New versions, including restoration of an unchanged old file, re-encrypt
every chunk with new keys. New manifests cannot reference an old encrypted
chunk merely because the plaintext did not change.

| Surface | Strong action |
| --- | --- |
| Plugin device removal | Execute on a different trusted, upgraded client with the above transaction. Selecting its own device redirects to another trusted client; it cannot exclude a root it generated. |
| Dashboard | Display both choices. Strong choice says “Continue on a trusted Obsidian device to rotate keys”; report unavailable/pending until that client performs it. It cannot complete rotation, approve recipients or collect a phrase/key. It must not call access-only revoke under the strong label. |
| Management CLI | Current standalone CLI has no device-removal implementation. Keep unsupported operations visibly unavailable. A future authorized management surface may request trusted-client action or report pending; no key/phrase flags, stdin input, environment input or server-only completion. This design adds no management subsystem. |
| Leave / switch server / uninstall | Explain retained-key consequences. Strong removal is initiated on a remaining trusted client; local Leave preserves every note and may finish only the explicitly chosen access-only action. Clearing a local reference is not secure erasure or rotation. |
| Last device / stolen-device recovery | Strong removal requires a separate trusted client. Recover the old vault locally with its phrase and the existing account enrollment authority, then rotate from that client. With no trusted client/root, strong removal is unavailable; no silent downgrade. Existing last-device/recovery-age holds remain on ordinary removal. |

## Required negative acceptance (specification, not test results)

Use only disposable synthetic vaults and fresh test keys. Give the adversary
all server credentials/state; give old-root/phrase material only to explicit
removed-device cases. Each case needs honest control, attack/refusal, retained
local bytes and usable recovery. Native desktop and physical-phone acceptance
remain separate required evidence.

| Case | Required observation |
| --- | --- |
| Removed device + colluding server + old phrase + future captures | Cannot open any new-root map, manifest, control, name or chunk; demonstrate that access-only still decrypts later old-root ciphertext. |
| “New key” derived from/wrapped only with old root; fixed/reused RNG | Mutation fails independence test before claiming strong completion. |
| Substitute claimant/creator key, fake server device row, re-add previous claim/public key | Meaningful comparison/commitment or envelope binding refuses; no new root is disclosed to an unapproved claimant. Test code interception separately with comparison enforced. |
| Replay old envelope into new pairing; alter encrypted operation/map context | AEAD or strict map/context validation refuses before persistence/sync; no old/root fallback. |
| Old claimant or stripped strict envelope variant | Legacy missing-top-level-root refusal; upgraded parser refusal. Neither counts as transitioned. |
| Server says revoked/active/heartbeat without performing it | Server-access status is explicitly server-reported; no claim of denial by a colluding server. Membership/transition stays pending without direct actual-client confirmation; heartbeat is not confirmation. |
| Hide transition from offline/legacy writer | That writer's old-key traffic remains decryptable in the limited-control case; transitioned client never admits it or reports global protection. |
| Roll server/map back after local pin; substitute server recovery context | Stop on missing/invalid current map/context; no old-map/root selection, reset or plaintext application. |
| Valid old-root writes/tombstones/map after snapshot | Quarantine; no current editor/disk/cache/ancestor/delete admission or automatic history extension. |
| Same old plaintext/chunk in new generation; history restore | New derived key/cid/ciphertext/sid; every new manifest chunk opens under the new domain only. Mutation reusing old ciphertext fails. |
| Unsynced offline edits, active editor, changed file mid-reseed, narrower scope | Original local/editor bytes survive; dirty/conflict intent is re-encrypted or pending, never discarded or silently widened. |
| Disk-full at local secret/metadata save, chunk upload or transition frame | No weak fallback/false completion; local bytes survive. Readback/restart identifies old/pending/committed state without mixed authority. |
| Crash before/after prepare, mid-seed, before/after commit, torn frame | Exact phase/fence/verifier/credential recovered within the validated persistence boundary; never old encryption after a retained local prepare pin; retries reuse operation and newly sign each attempt. |
| Lost prepare/commit responses | Read/retry exact operation; no duplicate roots/enrollments, unwarranted success, guessed failure or reopened old access. |
| Concurrent rotations on honest server and forked malicious server | Honest conflict refuses; hostile split remains separate locally. No CAS-based root adoption, branch erasure or silent merge. |
| Late old-engine save/upload callback; prior secret revision chosen at reload | Lifecycle/pin guard blocks it; no old-root transport or overwrite of new state. |
| Wrong new phrase, old phrase, unverifiable backup; lost coordinator credential while pending | No new-generation recovery/completion claim or automatic fallback. Correct staged new proof plus setup authority resumes only the fixed pending operation; old material opens only old history. |
| Dashboard/CLI strong action with no trusted client; self/last-device strong removal | Visible unavailable/pending, no key input and no access-only action under the strong label. |
| Secret/encoding leak across both actions and all failures | Existing E2EE capture/scanner controls cover new/old roots and every exercised derived key; no unexpected server/dashboard/CLI/log hit. |
| Routine/stolen device credential, with old VRK proof, attempts prepare or commit | Both refuse without separate setup-token authority; old verifier, other grants and frozen state survive. A legitimate pending operation cannot be prematurely committed by its stolen routine coordinator credential. |
| Change intent, cutoff, source inventory or completed catalog after owner authorization | Exact-field comparison refuses substitution/replay; setup token is never persisted/logged and must be re-entered after restart. |
| Old write races prepare; authenticated/in-flight/grouped post spans the fence | Every accepted durable write is in `C`/`H`; later publication refuses. Lost prepare reply/restart returns the same frozen snapshot. Reconciled new content includes the racing edit. |
| Empty/narrow selection; remote-only oversized file; multiple current fork heads | Full account inventory remains required. Preserve all fork content/conflicts and control/map/tombstone semantics; no partial/empty completion or silent ceiling bypass. |
| First legacy ownership migration, later new-phrase recovery/rotation, staged write reuses an old file ID, older server reads compacted state | Durable assignment includes every legacy head; replay restores it atomically, unknown/partial association refuses. Later cutoff contains all current-generation heads and excludes prior labelled history without needing lost local catalogs/old roots. Staging cannot overwrite an old-generation ID; labels never bypass client AEAD/pin checks. Older server refuses durable-format downgrade rather than losing the fence/ownership. |
| Missing/corrupt/omitted inventory page or source, exhausted staging space/memory, GC during reseed | No commit/completion; preserve local edits and frozen sources, report pending. Server inventory omission under compromise retains its stated freshness limit. |
| Capability absent/legacy/malformed before prepare; support vanishes or reply is lost after dispatch | No irreversible local prepare for unsupported discovery. No silent access-only action. Uncertain/dispatched/applied state stays stopped/pending; explicit no-transition cancellation makes no strong claim. |
| Coordinator transfer: wrong token/proof/context, lost response, crash before/after frame, repeat/superseded resume ID | Authority and immutable intent checked; identity/grant transfer recovers atomically, exact retry returns one grant, retired coordinator and superseded requests cannot stage/commit/reactivate. Commit still needs separate owner authority. |
| Legacy claimant activates on envelope collection, then rejects strict nested enrollment | No root adoption/sync; self-revoke cleanup removes the briefly active grant or reports stranded server authority. Never treat collection/heartbeat as proof of compatible key possession. |

Review must decide whether this composition and its costly user workflow
meet the owner requirement **before** production implementation. In particular,
review the new enrollment variant's fail-closed compatibility, atomic authority
transition, native pin durability, old-history boundary and partition wording.
Implementation, mutation evidence, native acceptance and delivery are pending.

## Source inventory and minimum change boundary

Baseline for this delta: `ceadfe08b75076ec8f67e255a768c36373af6153` and checkpoint
comment `6131002504`. Earlier source inventory used declared predecessor
`482d512e027b57154bfac07b71ea2a706102642f`. These are source observations,
not implementation or live proof.

| Source / existing interface | Needed change or reused property |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md`; `docs/architecture.md` §§3–4; `docs/protocol.md` Pairing/Devices/Recovery/Files/Domains | Mandatory encryption/blind server, current limitations and existing wire/key contracts. Update durable product claims only after implementation/review. |
| `plugin/src/crypto.ts`: `randomBytes`, domain/map derivation, `domainMapIds`, chunk/manifest crypto | Reuse primitives/labels/AAD; fresh root and default domain supply separation. No replacement group protocol. |
| `plugin/src/domainmap.ts`: `domainMapKeys`, `defaultDomainMap`, `loadDomainMap`, `saveDomainMap` | Reuse keyed generation identity and encrypted map. Missing current map in migration/active state must stop instead of initializing over old server history. |
| `plugin/src/pairing.ts`: `newVaultKey`, commitment/key exchange, `matchCodeV2`, `sealEnvelopeV2`, `openEnvelopeV2`, phrase conversion | Add strict rotated plaintext variant and context validation; retain cryptographic transcript. Today's open returns only top-level `vrk`, so unchanged parsing cannot retain the pin. |
| `plugin/src/state.ts`: `Credentials`, `SecretEnvelope`, `readEnvelope`, serialized persistence/reset | Add owned migration/pin/history custody and metadata-version refusal for old writers. Existing two credential revisions alone cannot represent a pending new root plus quarantined old catalog safely. |
| `plugin/src/main.ts`: `revokeDevice`, `unpushedEdits`, `leaveServer`, root adoption/setup/recovery, engine drain | One bounded orchestration state machine; explicit two-choice UI; preserve edits and guard every root-adoption continuation. |
| `plugin/src/sync/engine.ts` start/domain context; `sync/pull.ts` domain binding; push/history/repair and caches | Reuse one-domain admission; separate fresh bookkeeping/reseed from old history and clear/quarantine all old encrypted reuse/retries. Audit every alternate ingest/cache path, not just normal pull. |
| `plugin/src/accountRecovery.ts`; server `api/setup.rs` | Reuse proof/verifier derivation. Existing registration rejects replacement; only atomic rotation commit may install the new verifier. |
| Server `crates/obsyncd/src/api/setup.rs`: `check_token`/`create`; `api/auth.rs`, routing; `storage/{types,journal,index,mod}.rs` | Separate owner authority at prepare/commit; server-internal file ownership/grant scope in version journal records/replay/snapshots, legacy migration, durable cutoff/inventory, bounded catalog pages, exact-intent checks, atomic coordinator transfer and fault tests. API ciphertext/blob format remains; journal/snapshot format changes and public ID linkage are explicit. No content crypto on server. |
| Plugin `ui/settings.ts`, `ui/modals.ts`; dashboard `app.js`/pure helpers; transport | Per-action choice, trusted-client/unavailable/pending language and operation responses. Current standalone CLI's catalog/args make device management unavailable; do not expand it here. |

This historical inventory explains the implementation boundary. Current entry
points are listed at the start of this contract; the validation record, rather
than this design table, records executed acceptance and remaining gaps.

### Deterministic reseed representation

The new default domain is the first 16 bytes of
`HMAC-SHA256(K_map_new, utf8("obsync/seal-v2/rotation-domain"))`.
An ordinary source file `F_old` maps to the first 16 bytes of
`HMAC-SHA256(K_manifest_new, utf8("obsync/seal-v2/rotation-file\n") || F_old_raw)`.
Folder and pause records use their existing identity functions with the new
manifest key and remapped target. Refuse any collision between distinct source
files and any unresolved keeper/target reference.

Each non-map destination carries the authenticated encrypted field
`migration_origin`, exactly 96 lowercase hex characters encoding the 16-byte
source file ID followed by the 32-byte source head ID, and has an empty parent
list. The explicit source identity also permits bounded read-only traversal of
old history without guessing a file ID. This preserves distinct fork heads even when their user
bytes and timestamps are identical, without inventing timestamps or modifying
notes. Normal records may omit the field; any supplied value must be valid.
A forked map or unsupported multi-domain map blocks the operation explicitly;
the client never chooses one map head or silently omits a domain. The server
rejects duplicate destination tuples in the exhaustive source-to-destination
catalog. Its checks establish opaque membership, not plaintext correctness.
