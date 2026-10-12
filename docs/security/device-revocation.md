# Device revocation: fresh-root re-enrollment proposal

**Status: design for independent protocol review; not implemented or reviewed.**
This is the revocation candidate for [audit #344](https://github.com/snaraj/obsync/issues/344). No security PASS,
shipping capability or release assignment follows from this document.

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
It reuses current encryption, keyed map identity, per-domain admission and
pairing v2. There is no automatic group-key broadcast or trusted server key
directory. Cost: upload every current file again, temporary space for both
generations, a new recovery backup, and one comparison/confirmation on every
retained device. Unsynced edits remain available locally throughout.

Transparent automatic group rotation would additionally require independently
authenticated persistent recipient identities, membership authorization,
per-recipient delivery, anti-replay state and fork/concurrent-update rules.
Current device IDs and API secrets do not supply those properties against a
compromised server. That larger protocol is not part of this candidate.

## Generation and authority

Use existing root-derived map identity as the generation identifier:

```
VRK_new = newVaultKey()                         // fresh 32 random bytes
G_new = domainMapKeys(VRK_new).fileId           // existing keyed map identity
L = existing lineage, otherwise G_old          // stable local lineage
O = randomBytes(16)                            // one rotation operation
```

Generate a fresh default content domain and fresh ordinary file IDs. Existing
folder/conflict IDs and the map's domain ID derive under the new keys. Reuse
the current primitive labels, key derivations, chunk/manifest AAD, version
format and request signatures. Fresh roots separate generations without a
generation tag on every ciphertext or server storage record. Reject equality
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
code, claim fixed before reveal, six-digit comparison and ECDH/PS AES-GCM
envelope exactly as specified in `protocol.md`. No new code format, match
function, KDF or asymmetric identity scheme is needed. Compare the codes on
the two actual device screens; never compare a server/dashboard rendering.

For a rotated vault, the encrypted envelope plaintext is a new strict variant:

```
{"v":2,"rotation":{"vrk":"<64hex>","lineage":"<32hex>",
 "operation":"<32hex>","previous_map":"<32hex>","current_map":"<32hex>"}}
```

There is deliberately no top-level `vrk`: today's `openEnvelopeV2` refuses
this variant instead of adopting a key while dropping its generation pin.
Updated parsing requires `v`, `rotation`, nested `vrk` and `current_map`, and
rejects unknown fields, invalid hex and a `current_map` unequal to
`domainMapKeys(vrk).fileId`. The three migration fields `lineage`, `operation`
and `previous_map` are all present for this normal rotation, or all absent
for enrollment from a phrase-only recovered root with no migration history.
Their absence is explicit recovered-state bookkeeping, never permission to
replace a client's existing pin without confirmation. Normal pre-rotation
enrollment retains today's `{vrk}` shape. All subsequent enrollment of a
rotated vault uses the strict variant. A claimant shows “New vault generation;
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
24-word phrase **only on the trusted plugin**. Require explicit backup and
phrase verification before server commit. Restoring this phrase derives the
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

Advance both secret-envelope and metadata versions so today's reader rejects
them (`readEnvelope` and `State.open` currently require version 1). Extend
this installation's owned secret envelope with one bounded rotation record:
new root, fixed context, phase and its existing initiating credential. Keep
one old root separately as **history-only**, not as an alternate sync
credential; before another rotation, preserve older needed history with its
phrase/ciphertext backup instead of growing an automatic root archive.
Nonsecret metadata holds progress, new file-ID mapping, a dirty-edit queue and
the pinned snapshot/catalog. No root, domain, manifest, map or chunk key enters `data.json`, server
requests, dashboard, CLI, diagnostics or logs. Server API credentials retain
their existing role and custody; they are not content keys.

The local phases are `prepared`, `seeding`, `commit_unknown`, `active` and
`blocked`. Once prepared, no reload, credential revision fallback, server
response, missing map or retry may resume old-root encryption. Missing or
inconsistent rotation/pin state stops sync; rotated metadata with a missing
owned secret must not take today's fresh-copy/unpaired fallback. Preserve the
existing serialized saves, session/lifecycle binding and engine-drain ownership; a late old-engine
callback cannot save an old root or upload its queued ciphertext.

1. On the trusted initiator, stop/drain the engine and settle editor saves.
   Capture the current accepted file/folder catalog, scope, tombstones,
   controls and history frontier locally. Preserve pending edits and queued
   work. Resolve required remote-only current files before approving the
   snapshot; a missing file or uncertain/conflicted source stays pending.
   The person confirms which local/snapshot bytes form the new generation.
2. Generate and persist/read back the independent new root and fixed context,
   a fresh map/domain and a separate new-file-ID catalog. Confirm the new
   recovery backup. Record person-designated retained devices locally, not
   from server membership assertions. Do not overwrite the old catalog,
   local notes or old pending queue. A failed local save performs no server transition.
3. Prepare the server operation below: revoke the selected target and fence
   ordinary old-credential writes. Report “Server reports access revoked;
   rotation pending” only after resulting-state readback. With an uncertain
   response,
   show “Server access outcome unknown; rotation pending” and reconcile.
4. Reseed current scope through existing chunk/version/map routes using
   fresh keys and IDs. Do not reuse old sids, cids, ciphertext, manifests,
   cached chunks, parent version IDs, folder/control records or retry bodies.
   Same new-generation chunks may deduplicate normally. Read back and decrypt
   the new map and seeded records and compare actual plaintext with the
   locally pinned source catalog. Server counts/receipts alone are insufficient.
   Omitted old records must not become deletions in the new catalog.
5. Changes during reseeding remain local dirty work; check the source before
   and after each read and retry a changed file. Never overwrite a newer
   local/editor version to finish the snapshot. Drain old retries into
   quarantine; re-encrypt their plaintext intent under the new root rather
   than reposting an old body. A missing source, quota, disk-full or storage
   failure keeps the operation pending and the local bytes intact.
6. Commit the server transition, persist/read back the new-root pin bound to
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
durability path. No generation namespace or changed blob/version format is
necessary for confidentiality. The record holds `operation`, expected/current
map IDs, coordinator device ID, target ID, phase and staged verifier. All IDs
are opaque; no content key is sent. The trusted initiator retains its existing
API credential: changing this server-known authentication secret adds no
content protection and would require unnecessary handoff/receipt machinery.
On a legacy account, first prepare records the supplied old map ID; that
initial association is server coordination, not authenticated vault identity.

| Request (existing device HMAC auth) | Durable semantics |
| --- | --- |
| `POST /v1/account/rotation` with `{operation, previous_map, current_map, target, recovery_verifier}` | Under one store lock, require target differs from coordinator, no different pending operation and no current-map mismatch; record the operation, revoke target/close its sessions and links, and fence old ordinary writes. Same coordinator/operation/exact fields returns the same state; a changed field or competing operation is `409 rotation_conflict`. Only the coordinator may stage ciphertext through existing write routes. Freeze ordinary pairing, setup/recovery and verifier registration while pending, except the narrow recovery below. No last-device hold is disabled as a setting. |
| `GET /v1/account/rotation/{operation}` | Coordinator-only read of pending/committed state; settles a lost prepare/commit response. No root, phrase, new API credential or recipient content secret appears. |
| `POST /v1/account/rotation/{operation}/commit` | Coordinator-only, idempotent. One fsynced frame changes current map ID and recovery verifier/registration time, retires every OTHER prior device credential/closes its sessions and links, lifts the coordinator's staging fence, and marks committed. The coordinator keeps its existing credential. No intermediate state exposes new recovery with other old credentials active. |

Prepare supplies early honest-server removal/write fencing; commit switches
authority atomically; status settles lost responses. There is no ack endpoint,
credential receipt or new content protocol.

Pending recovery reuses `POST /v1/setup`: only setup token plus a proof
matching the **staged new verifier** may create a replacement rotation-scoped
coordinator credential, retiring the prior coordinator grant atomically.
It cannot grant ordinary sync or change the pending root/verifier/operation.
The restored phrase derives the map ID locally; returned operation hints must
match it and cannot choose a root. A conflict remains stopped. Rebuild missing
progress from new-root ciphertext while preserving local edits; do not infer
completed reseeding from the server's phase alone. After commit, ordinary
new-phrase recovery follows existing account enrollment semantics.

The server does not certify reseed completeness or client membership. The
coordinator commits only after its own verified reseed and recovery backup.
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

Review must decide whether this composition and its costly user workflow
meet the owner requirement **before** production implementation. In particular,
review the new enrollment variant's fail-closed compatibility, atomic authority
transition, native pin durability, old-history boundary and partition wording.
Implementation, mutation evidence, native acceptance and delivery are pending.

## Source inventory and minimum change boundary

Baseline examined: declared predecessor
`482d512e027b57154bfac07b71ea2a706102642f`; plan section 4 examined separately
in the current planning lane. These are source observations, not live proof.

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
| Server `api/devices.rs`, `api/admin.rs`, `api/auth.rs`, routing; `storage/{types,journal,index,mod}.rs` | Bounded rotation endpoints/record, write fence, idempotence, combined authority frame and replay/snapshot tests; existing chunk/file storage format remains. No crypto on server. |
| Plugin `ui/settings.ts`, `ui/modals.ts`; dashboard `app.js`/pure helpers; transport | Per-action choice, trusted-client/unavailable/pending language and operation responses. Current standalone CLI's catalog/args make device management unavailable; do not expand it here. |

This file is the entire design artifact. It changes no runtime, release lock,
shared plan or test result. Supporting acceptance remains the table above.
