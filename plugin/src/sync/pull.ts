/**
 * The pull path, `docs/architecture.md` 6.2 items 3 and 4.
 *
 * For each change-feed record not authored here: decrypt the manifest,
 * check it against this device's policy, download the missing chunks,
 * decrypt them, verify, and write the file atomically. Every chunk is
 * verified as it is decrypted (`decryptChunk` recomputes `cid = HMAC(K_d,
 * plaintext)`), and a single-chunk file additionally has its plaintext
 * SHA-256 checked against the manifest before anything reaches the vault.
 * Nothing is written unverified.
 *
 * UNTRUSTED MANIFESTS. Decryption proves a manifest came from a device that
 * holds the vault key; it proves nothing about what the manifest SAYS. Every
 * decrypted manifest is therefore parsed through `parseManifest`, which
 * checks each field's type and puts `path` through the one vault-path rule
 * (`vaultPath.ts`), so a compromised paired device cannot name
 * `../../outside-the-vault.md`, an absolute path, or `.obsidian/**` and have
 * the writer land bytes there. The host refuses on the same terms when the
 * FILESYSTEM disagrees with the string — a symlinked folder, a temp file
 * swapped under the writer — and both arrive here as one decision: a refusal
 * logged with its file id, skipped without a single write, reported to the
 * user once per file, and the feed moves on, because a hostile version that
 * could wedge the feed could stop sync for the whole vault.
 *
 * BOUND TO THE RECORD. Shape is not agreement. The record a manifest rides
 * in is the authenticated statement of what the version IS -- its ordered
 * chunk list, its byte count, its domain, its tombstone bit -- and it is what
 * the server accounts, retains and (in phase 2) authorizes on. The manifest
 * is ciphertext another device wrote. `bindManifestToRecord` therefore
 * refuses, before the first chunk request and before any vault operation,
 * every manifest that disagrees with its record on any of those fields, and
 * every chunk list that does not obey the chunker's own bounds. Without it a
 * validly encrypted manifest could declare `size: 1` over a 41-byte chunk and
 * walk straight through this device's per-file ceiling, or declare zero-length
 * chunks and turn one 32 MiB batch into 512 MiB of bodies in flight. Declared
 * lengths are checked again against the bytes themselves as each chunk
 * decrypts, so nothing unverified is written even if the two agreed.
 *
 * FOLDERS. A record whose manifest says `v: 2` is a FOLDER (`push.ts`,
 * `FolderManifest`), and it is the one record type this path applies without
 * fetching a byte: it makes the folder, or removes it when nothing is left in
 * it, and nothing else. A file tombstone additionally takes the folders it
 * empties, and ONLY the ones no record covers, so a device that says nothing
 * about a folder never deletes it here (issue #104).
 *
 * ECHOES. A write this device made comes back down the feed. It is dropped
 * twice over: by `version_id` (the ids this device authored) and by the
 * `(path, mtime, size)` of the writes this device made, which is what stops
 * the vault watcher from pushing our own pull back up.
 *
 * A TOMBSTONE IS THE SAME DECISION. A remote deletion over a local file that
 * no longer holds what this device pushed is delete-versus-edit, not a
 * deletion: the local bytes are kept and published as a new version of the
 * same file id, which brings the note back everywhere, and the user is told
 * once (issue #106).
 *
 * CONFLICTS. A version is written over a local file only when it DESCENDS
 * from the version this device recorded and the file still carries the SIZE
 * AND MODIFICATION TIME this device recorded for it. The version graph answers
 * the first question; the server's `conflicted` flag cannot, because it is
 * that file's state when the version was journaled and says nothing about what
 * this device has done since. The file's own `(mtime, size)` against its
 * record answers the second, and that is the half NO server can see: bytes
 * this device never pushed are bytes it never heard of, so a note written or
 * edited while this device was closed is a conflict the feed arrives innocent
 * of (issue #98). That second test is METADATA, not content -- the same
 * comparison startup reconciliation uses to decide what to push -- so an edit
 * that leaves both the size and the modification time exactly as they were is
 * invisible to it, here as it always has been there. Two divergent
 * heads on a text file with a reachable common ancestor take the three-way
 * merge and the merged text is posted with BOTH heads as parents. Everything
 * else keeps both sides: the foreign version is written as
 * `<name> (conflict from <device>, <date>).<ext>`, the local bytes stay where
 * they are for the queued push to carry, and the user is told. Merging is
 * attempted only for single-chunk text files; above that a conflict copy is
 * the honest answer.
 *
 * PLATFORM. Desktop writes through a temp file and a rename (Node `fs`),
 * so a crash mid-write cannot leave a torn note, and streams a file of any
 * size. Mobile buffers the file and writes it with `adapter.writeBinary`,
 * which is why the mobile per-file ceiling exists; a file above the ceiling
 * is never downloaded and is listed as remote-only instead, and any older
 * local copy of that file goes to the system trash so the device never shows
 * a stale file and a remote-only entry for the same path (issue #100).
 */

import type { MoveResult, SyncContext, VaultStat, VaultWriter } from "./engine";
import { CHUNK_MAX, CHUNK_MIN, CHUNK_CIPHERTEXT_MAX } from "../chunker";
import {
  Bytes,
  conflictFileId,
  contentVersionId,
  decryptChunk,
  decryptManifest,
  encryptChunk,
  hex,
  isHex,
  sha256,
  unbase64,
  unhex,
} from "../crypto";
import { ApiError, ChangeRecord, FileRecord, ReadControl, Transport } from "../transport";
// The per-path record this device keeps, named apart from the SERVER's file
// record above, which is a different thing with the same name.
import type { FileRecord as FileState } from "../state";
import { admissionReason, admit } from "../policy";
import { VaultPathError, assertVaultPath, caseOnly, vaultPathRefusal } from "../vaultPath";
import {
  assertFolderScope,
  assertSyncPath,
  caseTwinRoot,
  inFolderScope,
  inSyncScope,
  movedSelection,
  selectionAfterRename,
} from "../syncScope";
import { conflictCopyPath, conflictStamp, isMergeableText, threeWayMerge } from "./conflict";
import { FolderManifest, Manifest, ManifestChunk, bury, postManifest, pushFile, reviveFile, retire, sidDigest } from "./push";

/**
 * One batched chunk fetch. The bound is MEMORY, and it is computed from the
 * ciphertext ceiling including its authentication tag, never from the lengths a manifest declares: a declared length
 * is a number another device chose, so budgeting by it would let a chunk list
 * of zeros pull 64 maximum-size chunks into one 32 MiB budget. The wire cap is
 * 64 sids (`transport.ts`); this one is lower and is the one that holds.
 */
const BATCH_BYTES = 32 << 20;
const BATCH_SIDS = Math.max(1, Math.floor(BATCH_BYTES / CHUNK_CIPHERTEXT_MAX));

/**
 * How long after this device last published an edit of a note a deletion of
 * it, arriving while the note is open in an editor here, is still
 * delete-versus-edit and not a deletion (issue #146). Obsidian saves an editor
 * two seconds after a keystroke and the queue publishes the save about a
 * second later, so a user typing in the note publishes every few seconds;
 * this is several of those, which is "still typing" and not "stopped a while
 * ago". Unsaved text in the editor is kept whatever this says (`openEditing`).
 */
export const EDITING_WINDOW_MS = 10_000;

export type ApplyResult =
  | "echo"
  | "applied"
  | "deleted"
  | "remote_only"
  | "merged"
  | "conflict_copy"
  | "refused"
  | "skipped";

/**
 * Why THIS device cannot write one record, in plain words, keyed by the fixed
 * vocabulary its log lines carry: an errno the host's filesystem raised, or a
 * chunk the server does not hold (issue #144). Each is a fact about one file
 * or one chunk, never about the connection, so the feed parks that record and
 * moves on instead of retrying it in front of everything else.
 */
export const UNWRITABLE: Readonly<Record<string, string>> = {
  EPERM: "the file is locked",
  EBUSY: "the file is in use by another program",
  EACCES: "the folder is read-only",
  EROFS: "the disk is read-only",
  ENOSPC: "the disk is full",
  EDQUOT: "the disk is full",
  ENAMETOOLONG: "its name is too long for this device",
  unknown_chunk: "the server is missing part of it; open a device that has it",
};

/** What the status bar, the notice and Show sync status say about one parked file. */
export function unwritableText(path: string, reason: string): string {
  // A chunk the server lost is nothing wrong with THIS device, so it is not
  // said as if it were (2026-09-24 verification, X2).
  if (reason === "unknown_chunk") return `Cannot download ${path}: ${UNWRITABLE[reason]}`;
  return `Cannot write ${path} here: ${UNWRITABLE[reason] ?? "it could not be written"}`;
}

/** A record this device cannot write for a reason local to that one file or chunk. */
export class Unwritable extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`unwritable: ${reason}`);
    this.name = "Unwritable";
  }
}

/**
 * The `UNWRITABLE` key for a failure, or `null` for one that is not this
 * record's alone. Node's `fs` errors carry their errno as `code`, and so does
 * an `ApiError` its server code; nothing else the pull path throws has one.
 */
function unwritable(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(UNWRITABLE, code) ? code : null;
}

/** A decrypted manifest that does not describe a file this device may write. */
export class ManifestError extends Error {
  constructor(readonly reason: string) {
    super(`manifest refused: ${reason}`);
    this.name = "ManifestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function size(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A 32-byte identity as lowercase hex: every sid, cid and plaintext digest. */
function digest32(value: unknown): boolean {
  return typeof value === "string" && isHex(value, 32);
}

/**
 * The head every decrypted manifest shares: it is an object, and its `path`
 * passes the one vault-path rule (`vaultPath.ts`) BEFORE anything else reads
 * it. What kind of manifest it is comes next, in `parseEntry`.
 */
function manifestObject(json: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ManifestError("not_json");
  }
  if (!isRecord(value)) throw new ManifestError("not_an_object");
  const refusal = vaultPathRefusal(value["path"]);
  if (refusal !== null) throw new ManifestError(`path_${refusal}`);
  return value;
}

/**
 * The runtime schema check for a decrypted FILE manifest: every field is
 * verified against the shape `Manifest` claims, and `path` against the
 * vault-path rule, BEFORE any of it is used. Without this the type assertion
 * is a promise the compiler cannot keep — the bytes came off the wire from
 * another device.
 */
export function parseManifest(json: string): Manifest {
  return fileManifest(manifestObject(json));
}

/**
 * Route a decrypted manifest by its `v`, and check every field of whatever it
 * turns out to be. This is the ONLY place `v` is read: it is the
 * compatibility contract with every 1.0.x device, which refuses a shape it
 * does not know rather than guessing at it, and this version owes a NEWER
 * record exactly the same refusal — `fileManifest` gives it, because anything
 * that is not 2 has to be 1.
 */
export function parseEntry(json: string): Manifest | FolderManifest {
  const value = manifestObject(json);
  return value["v"] === 2 ? folderManifest(value) : fileManifest(value);
}

/**
 * A FOLDER record (`push.ts`, `FolderManifest`), checked field by field like
 * a file manifest and for the same reason: these bytes came off the wire from
 * another device, and what they say decides what happens to a directory in
 * this vault. Everything a folder does NOT have is checked too — no chunks,
 * no bytes, no digest — so a live file wearing `kind: "directory"` cannot
 * reach the folder path, which never fetches or writes content at all.
 */
function folderManifest(value: Record<string, unknown>): FolderManifest {
  if (value["kind"] !== "directory") throw new ManifestError("kind");
  if (typeof value["domain"] !== "string") throw new ManifestError("domain");
  if (typeof value["deleted"] !== "boolean") throw new ManifestError("deleted");
  if (value["size"] !== 0) throw new ManifestError("size");
  if (value["sha256"] !== "") throw new ManifestError("sha256");
  const chunks = value["chunks"];
  if (!Array.isArray(chunks)) throw new ManifestError("chunks");
  if (chunks.length !== 0) throw new ManifestError("chunk_count");
  return value as unknown as FolderManifest;
}

function fileManifest(value: Record<string, unknown>): Manifest {
  if (value["v"] !== 1) throw new ManifestError("version");
  if (!size(value["size"])) throw new ManifestError("size");
  if (typeof value["mtime"] !== "number" || !Number.isFinite(value["mtime"])) throw new ManifestError("mtime");
  if (typeof value["domain"] !== "string") throw new ManifestError("domain");
  if (typeof value["deleted"] !== "boolean") throw new ManifestError("deleted");
  const digest = value["sha256"];
  if (digest !== "" && !digest32(digest)) throw new ManifestError("sha256");
  // A retirement's keeper is a file id, and it goes into a request path (#181).
  const keeper = value["keeper"];
  if (keeper !== undefined && (typeof keeper !== "string" || !isHex(keeper, 16))) throw new ManifestError("keeper");
  const chunks = value["chunks"];
  if (!Array.isArray(chunks)) throw new ManifestError("chunks");
  for (const chunk of chunks as unknown[]) {
    if (!isRecord(chunk)) throw new ManifestError("chunk");
    if (!digest32(chunk["sid"])) throw new ManifestError("chunk_sid");
    if (!digest32(chunk["cid"])) throw new ManifestError("chunk_cid");
    if (!size(chunk["len"])) throw new ManifestError("chunk_len");
  }
  return value as unknown as Manifest;
}

/**
 * The authenticated half of a version: what the server recorded, accounts
 * for, and hands every other device. A feed entry carries its own domain; a
 * version read from `GET /v1/files/{id}` takes the file's, which is where the
 * server states it once (`docs/protocol.md`, "Files and versions").
 */
export type BoundRecord = Pick<ChangeRecord, "domain_id" | "sids" | "bytes" | "deleted">;

/**
 * Bind a decrypted manifest to the record it rode in, field by field, before
 * policy, download, or a single vault operation.
 *
 * Decryption proves only that a device holding the vault key wrote these
 * bytes. The record is the authority for what the version IS: the server
 * retains it, counts it against the account, and will authorize on its domain
 * in phase 2. Every field the two both carry must therefore say the same
 * thing, and the ones only the manifest carries -- the per-chunk lengths --
 * must add up to the byte count the record states and stay inside the
 * chunker's bounds. A compromised paired device that could move any of these
 * numbers could make this device exceed its own ceiling, hold far more in
 * memory than one batch allows, or fetch chunks the record never named.
 *
 * Every refusal names one reason and nothing is written: `applyChange` turns
 * it into the same single notice a hostile path gets.
 */
export function bindManifestToRecord(
  record: BoundRecord,
  manifest: Manifest,
  engineDomain: string,
): void {
  // (b) One domain per engine in v0.1 (`engine.ts` refuses a map with more).
  // A record outside it is not this engine's to write, and a manifest naming
  // a domain other than its record's is describing a different file.
  if (record.domain_id !== engineDomain) throw new ManifestError("record_domain");
  if (manifest.domain !== record.domain_id) throw new ManifestError("manifest_domain");

  // (a) The chunk list the server holds, in order. The fetch list and the
  // record's retention must be the same list, or one of them is a lie.
  if (manifest.chunks.length !== record.sids.length) throw new ManifestError("record_sid_count");
  for (const [index, sid] of record.sids.entries()) {
    if ((manifest.chunks[index] as ManifestChunk).sid !== sid) throw new ManifestError("record_sid_order");
  }

  // (c) A tombstone deletes a file; a version writes one. Disagreement here
  // is a delete that lands as a write, or a write that lands as a delete.
  if (manifest.deleted !== record.deleted) throw new ManifestError("record_deleted");

  // (d) The size every ceiling and every buffer is measured against, pinned
  // to the record AND to the chunk lengths that will actually be fetched.
  if (manifest.size !== record.bytes) throw new ManifestError("record_bytes");
  let declared = 0;
  for (const chunk of manifest.chunks) declared += chunk.len;
  if (declared !== manifest.size) throw new ManifestError("chunk_len_sum");

  // (e) The chunk list against the chunker's own bounds (`chunker.ts`, whose
  // constants a second implementation must match): a tombstone has no chunks,
  // a file of at most CHUNK_MAX is exactly one chunk, and above that every
  // chunk but the last fills a CHUNK_MIN..CHUNK_MAX window. Those bounds are
  // what keep a chunk list SHORT: without them a 32 MiB file could declare 32
  // million one-byte chunks, sum correctly, and buy 500 000 fetches.
  const count = manifest.chunks.length;
  if (manifest.deleted) {
    // A tombstone names nothing to fetch. One that carries chunks or a size
    // is a live file wearing a delete bit: the record's tombstone check above
    // passed because both sides agree it is deleted, so this is the only
    // place the shape is refused.
    if (count !== 0 || manifest.size !== 0) throw new ManifestError("chunk_count");
  } else if (manifest.size <= CHUNK_MAX) {
    if (count !== 1) throw new ManifestError("chunk_count");
  }
  // Above CHUNK_MAX no count check is needed: the length sum equals the size
  // and every length is at most CHUNK_MAX, so one chunk cannot represent it.
  // A guard here would be an assertion no input can fail.
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk.len > CHUNK_MAX) throw new ManifestError("chunk_len_ceiling");
    // Zero is a real length exactly once: the single chunk of an empty file.
    // Anywhere else it is a fetch bought for nothing.
    if (chunk.len === 0 && manifest.size !== 0) throw new ManifestError("chunk_len_zero");
    if (index < count - 1 && chunk.len < CHUNK_MIN) throw new ManifestError("chunk_len_short");
  }
}

/**
 * Bind a folder record to the version it rode in, before anything touches a
 * directory. The same rule as `bindManifestToRecord` and the same reason: the
 * record is what the server retains, accounts and will authorize on, and a
 * folder record that disagreed with it could carry a chunk list the server
 * never saw or a delete bit the server never recorded.
 */
export function bindFolderToRecord(
  record: BoundRecord,
  manifest: FolderManifest,
  engineDomain: string,
): void {
  if (record.domain_id !== engineDomain) throw new ManifestError("record_domain");
  if (manifest.domain !== record.domain_id) throw new ManifestError("manifest_domain");
  if (record.sids.length !== 0) throw new ManifestError("record_sid_count");
  if (record.bytes !== 0) throw new ManifestError("record_bytes");
  if (manifest.deleted !== record.deleted) throw new ManifestError("record_deleted");
}

/**
 * A record's manifest as text, or the refusal `undecryptable` (issue #140).
 *
 * AES-GCM refusing a record is a fact about its bytes, not about this moment:
 * they were sealed under a key this device does not hold -- another device
 * pressed "Create a new vault key" or restored another vault's phrase -- or
 * were changed after sealing. No retry changes that, so it is refused like
 * any other manifest and the feed moves past it. It used to escape as
 * WebCrypto's `OperationError`, whose message is empty on Obsidian's
 * renderer, and the feed retried that one record for ever under "offline".
 * Any OTHER failure is a fault on this device and still propagates.
 */
async function openManifest(
  manifestKey: Bytes,
  record: Pick<ChangeRecord, "file_id" | "parents" | "sids" | "manifest_ct" | "manifest_nonce">,
): Promise<string> {
  const binder = await contentVersionId(record.file_id, record.parents, record.sids);
  try {
    return await decryptManifest(manifestKey, record.file_id, binder, unhex(record.manifest_nonce), unbase64(record.manifest_ct));
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "OperationError") throw new ManifestError("undecryptable");
    throw error;
  }
}

/** A live note as the feed states it: the manifest, and the record it rode in. */
export type HeldNote = Manifest & Pick<ChangeRecord, "file_id" | "version_id" | "sids" | "device_id">;

/**
 * What the server's vault holds under this manifest key: the newest version
 * of every live note, by path (issue #141). Read-only -- it posts nothing --
 * so a claimant can compare its own notes with a vault before its first sync
 * publishes any of them. A record this key cannot open is not one it holds.
 * From a cursor, it is what changed since then (issue #181).
 */
export async function heldNotes(transport: Transport, manifestKey: Bytes, from = 0): Promise<Map<string, HeldNote>> {
  const newest = new Map<string, HeldNote | null>();
  for (let since = from; ;) {
    const page = await transport.changes(since, 0);
    for (const change of page.changes) {
      try {
        const entry = parseEntry(await openManifest(manifestKey, change));
        const { file_id, version_id, sids, device_id } = change;
        newest.set(file_id, entry.v === 1 && !entry.deleted ? { ...entry, file_id, version_id, sids, device_id } : null);
      } catch (error) {
        if (!(error instanceof ManifestError)) throw error;
      }
    }
    if (page.changes.length === 0 || page.seq <= since) break;
    since = page.seq;
  }
  const held = new Map<string, HeldNote>();
  for (const manifest of newest.values()) if (manifest !== null) held.set(manifest.path, manifest);
  return held;
}

/**
 * Decrypt one record and bind whatever it turns out to be. The feed is the
 * only caller that may act on a folder; everything else means a file and
 * goes through `decryptRecordManifest`, which refuses one.
 */
export async function decodeRecordManifest(
  context: SyncContext,
  record: BoundRecord & Pick<ChangeRecord, "file_id" | "parents" | "manifest_ct" | "manifest_nonce">,
): Promise<Manifest | FolderManifest> {
  const entry = parseEntry(await openManifest(context.manifestKey, record));
  // A FOLDER RECORD IS JUDGED BY THE FOLDER RULE, which differs from a file's
  // at the selection root: the selected folder itself has a record, and that
  // record is the only thing that can carry its own rename (`syncScope.ts`,
  // `inFolderScope`; review round 3, finding 1).
  if (entry.v === 2) {
    bindFolderToRecord(record, entry, context.domainId);
    admitFolderRecord(context, entry.path);
  } else {
    bindManifestToRecord(record, entry, context.domainId);
    assertSyncPath(entry.path, context.state.data.syncFolders);
  }
  return entry;
}

/**
 * Admit one RECEIVED folder record, and tell a re-case of the folder this
 * device syncs from a SECOND folder that only looks like one (review round 4,
 * finding 1).
 *
 * THE STRING RULE CANNOT TELL THEM APART AND NEITHER CAN THE VAULT. A record
 * naming `team docs` where this device selects `Team docs` is, on a host that
 * folds case, one directory entry either way: the vault answers "one entry"
 * BY CONSTRUCTION, so `applyFolder` would re-case the directory and move the
 * selection onto it. But the sender may be a device that keeps the two apart
 * and holds BOTH -- the twin a 1.0.x rename leaves behind
 * (`docs/troubleshooting.md`) -- and there the record names a folder this
 * device never selected. Followed, this device's selection lands on the twin:
 * every later change under the folder it DID select is skipped as out of
 * scope, a note written there never arrives, and its own edits come back to
 * the other device as conflict copies inside the twin. Silently.
 *
 * WHAT TELLS THEM APART IS THE TOMBSTONE, because a re-case is a RENAME and a
 * rename retires the old name. Both senders of one -- `folderRenamed` for a
 * rename this device is told about, and the start-up pass `recaseFolders` for
 * one it discovers -- publish the old spelling's tombstone BEFORE the new
 * record, behind the wire barrier the protocol states (`docs/protocol.md`). A
 * twin carries no tombstone: the receiver's own record for the folder it
 * selects is still live when it arrives.
 *
 * SO THE ADMISSION RULE IS: the tombstone for the selected folder's own
 * folder file id has been applied, no record has been written for that folder
 * since (`state.ts`, `setFolder`), and no folder record has used that
 * admission since -- the retirement is spent by the first record that takes
 * it. Anything else is refused exactly as it was before the tolerance existed
 * (`decision=not_synced reason=outside_sync_scope`), with one notice naming
 * both spellings. A whole-vault device has no selection and no tolerance to
 * narrow: every folder record is in its scope by the folder rule itself.
 */
function admitFolderRecord(context: SyncContext, entryPath: string): void {
  const path = assertVaultPath(entryPath);
  const folders = context.state.data.syncFolders;
  if (inFolderScope(path, folders)) return;
  const selected = caseTwinRoot(path, folders);
  if (selected !== null && context.state.data.retiredRoots[selected] !== undefined) {
    // SPENT HERE. The record the retirement was waiting for has arrived, so a
    // second record one capitalisation off that folder is a twin again --
    // including the twin a case-sensitive sender publishes moments later.
    delete context.state.data.retiredRoots[selected];
    return;
  }
  if (selected !== null) notifyFolderTwin(context, selected, path);
  throw new VaultPathError("outside_sync_scope");
}

/**
 * ONE NOTICE FOR A TWIN, per folder and per engine, because SILENCE is what
 * made this dangerous: the device that holds two folders is the only one that
 * can see them both, and the user of this one is owed the reason its folder
 * stopped agreeing with the other device. The text claims only what is true
 * on both sides of the wire -- two names differing in capitalisation alone,
 * nothing renamed, moved or deleted here -- and names the remedy the
 * troubleshooting page carries.
 */
function notifyFolderTwin(context: SyncContext, selected: string, twin: string): void {
  const key = `twin\u0000${selected}`;
  if (context.refused.has(key)) return;
  context.refused.add(key);
  context.host.notify(
    `obsync: another device published a folder called "${twin}", and this device syncs "${selected}" -- ` +
      "two names that differ only in capitalisation. On a device that keeps those two apart they are two " +
      `folders, so nothing here was renamed, moved or deleted and this device keeps syncing "${selected}". ` +
      "If that device instead renamed the folder you sync here, rename it here to match -- see " +
      'Troubleshooting, "Two folders that differ only in capitalisation".',
  );
}

export async function decryptRecordManifest(
  context: SyncContext,
  record: BoundRecord & Pick<ChangeRecord, "file_id" | "parents" | "manifest_ct" | "manifest_nonce">,
): Promise<Manifest> {
  // The one choke point: every path that decrypts a manifest from a record
  // -- the feed, an on-demand fetch, a conflict head, a merge base, a history
  // row, a repair source -- comes through here or through `decodeRecord-
  // Manifest` beneath it, so none of them can forget to bind it.
  const entry = await decodeRecordManifest(context, record);
  // Every caller but the feed means CONTENT: a file to download, to merge, to
  // restore, to re-seal. A folder record has none, so it is refused here in
  // the same words a 1.0.x device refuses it in.
  if (entry.v !== 1) throw new ManifestError("version");
  return entry;
}

/**
 * Fetch, decrypt and verify every chunk of a manifest, in file order.
 *
 * The declared lengths were bound to the record before the first fetch; here
 * the same numbers are proved against the BYTES, as each chunk decrypts and
 * before any of them reaches a writer. That is also the whole-file check:
 * binding pinned the sum of the declared lengths to `size`, so once every
 * chunk matches its own the assembled total matches `size` too. Comparing the
 * total afterwards would be an assertion no input could fail, and it would
 * fail LATER than this one, after the bytes had been written.
 */
async function* chunkPlaintexts(context: SyncContext, manifest: Manifest, control?: ReadControl): AsyncGenerator<Bytes> {
  assertSyncPath(manifest.path, context.state.data.syncFolders);
  let index = 0;
  while (index < manifest.chunks.length) {
    control?.check();
    const batch = manifest.chunks.slice(index, index + BATCH_SIDS);
    index += batch.length;
    const bodies =
      batch.length === 1
        ? [await context.transport.getChunk((batch[0] as ManifestChunk).sid, control)]
        : await context.transport.getChunks(batch.map((chunk) => chunk.sid), control);
    control?.check();
    for (let i = 0; i < batch.length; i++) {
      const body = bodies[i];
      const chunk = batch[i] as ManifestChunk;
      // The batch's word for the single fetch's `404 unknown_chunk`, and the
      // same refusal: one missing chunk parks one file (issue #144).
      if (!body) throw new ApiError(404, "unknown_chunk", `chunk ${chunk.sid} is missing on the server`);
      const plaintext = await decryptChunk(context.domainKey, unhex(chunk.cid), body);
      if (plaintext.length !== chunk.len) throw new ManifestError("chunk_len_actual");
      control?.check();
      yield plaintext;
    }
  }
}

/** Assemble a whole file in memory. Only used for merge inputs, which are single-chunk. */
export async function assembleBytes(context: SyncContext, manifest: Manifest): Promise<Bytes> {
  const parts: Bytes[] = [];
  for await (const part of chunkPlaintexts(context, manifest)) parts.push(part);
  const out = new Uint8Array(manifest.size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Every folder above `path`, deepest first. `"A/B/c.md"` → `["A/B", "A"]`. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
    out.push(path.slice(0, slash));
  }
  return out;
}

/**
 * Remove one folder through the host's own folder-delete path, marking the
 * echo BEFORE the call for the reason issue #96 established: Obsidian reports
 * the removal to this plugin's delete handler while `trashFolder` is still
 * running, and an unmarked echo becomes a folder tombstone this device
 * publishes for a folder the remote side already owns.
 *
 * `not_empty` means the host found something still in it and did nothing, so
 * the mark is taken back: a suppression owed to an event that will never
 * arrive would swallow the user's own next deletion of that folder.
 *
 * AND NOTHING IS REMOVED BY A NAME THE VAULT SPELLS ANOTHER WAY (review round
 * 3, finding 2). A removal names a path; the walk that resolves it on a host
 * that folds case finds the one directory entry, whatever capitalisation the
 * caller asked with. So a tombstone for `Team docs` arriving after this
 * device has already re-cased that directory to `team docs` -- the order a
 * rename discovered at start-up used to publish in -- resolved to the folder
 * the re-case had just produced, found it empty and deleted it, and the next
 * pass here tombstoned the record too, so an empty folder renamed by
 * capitalisation alone was gone on every device. The vault is asked what it
 * shows, and a name it shows differently is not this removal's to take.
 */
async function removeFolder(
  context: SyncContext,
  path: string,
  shown: string | null,
): Promise<"removed" | "not_empty" | "vault_spelling"> {
  if (shown !== null && shown !== path) {
    context.host.log("folder path_class=folder decision=kept reason=vault_spelling");
    return "vault_spelling";
  }
  context.trashed.add(path);
  const removed = await context.host.trashFolder(path);
  if (!removed) context.trashed.delete(path);
  return removed ? "removed" : "not_empty";
}

/**
 * After a file leaves this vault, take the folders it leaves empty with it —
 * but only the folders NO record covers.
 *
 * A folder with a record is a folder some device published on purpose; it
 * exists until its own tombstone says otherwise, even while it is empty. That
 * is the rule that keeps ANOTHER DEVICE'S SILENCE from becoming a deletion: a
 * device on 1.0.x publishes no folder record and no folder tombstone, ever, so
 * a peer that emptied a folder there has said exactly nothing about the
 * folder, and a folder this device holds a record for stays. This device gives
 * a record to every folder it holds — startup reconciliation to the ones it
 * already had, the vault's own create event to the ones a pull makes on its
 * way to a file — so what is reachable here is the narrow set nobody has
 * claimed yet: a publish that has not run, or a vault older than 1.1.0 whose
 * reconciliation has not finished. Those exist only to hold the file that is
 * leaving, and nothing will ever tombstone them.
 *
 * The walk stops at the first folder it keeps: a folder holding a folder is
 * not empty either.
 */
export async function pruneEmptyParents(context: SyncContext, path: string): Promise<void> {
  for (const folder of ancestors(path)) {
    if (!inSyncScope(folder, context.state.data.syncFolders)) return;
    if (context.state.folderByPath(folder) !== undefined) return;
    if ((await removeFolder(context, folder, await context.host.spelling(folder))) !== "removed") return;
    context.host.log(`folder path_class=folder decision=removed reason=empty_parent`);
  }
}

/**
 * Write a manifest's content into the vault atomically and return the stat
 * of what landed, which becomes the echo-suppression key.
 *
 * `over` is the record of the note this write replaces, and it is checked
 * again at the last moment, not only before the download: a note open in an
 * editor is saved every few seconds while someone types, and a save landing
 * while the version downloaded was written over, keystrokes and all, with the
 * editor then reloading the loss (issue #135). A note that moved is not
 * written, and the answer is `null`. A note that is GONE did not move: it was
 * deleted here, and delete versus edit keeps the edit, so the version lands
 * and the note comes back, as it always has -- which is what a deletion
 * still waiting to be sent then finds (issue #173).
 */
async function materialise(context: SyncContext, manifest: Manifest): Promise<VaultStat>;
async function materialise(context: SyncContext, manifest: Manifest, over: FileState | undefined): Promise<VaultStat | null>;
async function materialise(context: SyncContext, manifest: Manifest, over?: FileState): Promise<VaultStat | null> {
  // The single choke point for every byte this device writes: the decoded
  // manifest's path was checked at decode, a conflict copy's derived path is
  // checked here, and neither reaches a writer unchecked.
  assertVaultPath(manifest.path);
  const writer = await context.host.writer(manifest.path);
  try {
    await writeVerified(context, manifest, writer);
    const now = over === undefined ? null : await context.host.stat(manifest.path);
    if (over !== undefined && now !== null && (now.mtime !== over.mtime || now.size !== over.size)) {
      await writer.abort();
      return null;
    }
    // The commit's own stat, handed back rather than looked up again: it is
    // the metadata of the bytes THIS write put there, and a second stat would
    // describe whatever the user saved a moment later instead (finding 2).
    return await landedAt(context, await writer.commit(manifest.mtime));
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

/**
 * What a write left behind, named the way the VAULT spells it.
 *
 * NEVER RECORD A SPELLING THE VAULT DOES NOT SHOW (#124). A write names the
 * path it was ASKED for; on a host that folds case the directory it lands in
 * may be spelled another way, because creating a directory that is already
 * there changes nothing and `rename(2)` resolves a destination's directory
 * components without touching them. A record written from the manifest's path
 * would then disagree with this device's own listing, and the scan pairs that
 * difference as a move and publishes a rename the other device never made --
 * which a device that folds case answers with a conflict copy, so both
 * devices gain a duplicate of every note created in that folder while the two
 * spellings disagree (review round 2, finding 3). Tracked notes were already
 * covered, by the refusal path and by the folder record that carries their
 * records with the directory; a note this device is MATERIALISING for the
 * first time was the one writer left unguarded.
 *
 * ASKED ONLY WHERE IT CAN DIFFER, because `spelling` is a directory walk and
 * a phone walks it through the vault adapter. A path with no directory
 * component has nothing to ask about: a file's own LAST component is never
 * the difference, since a name whose folded twin is already in the vault is
 * settled by the same-name rules long before a writer sees it (`competing`).
 * A folder RECORD at exactly this directory's spelling is a spelling the
 * VAULT gave: `applyFolder` writes one only after creating that directory, or
 * after re-casing it and proving the vault shows the new name, and the
 * startup pass publishes one for every folder the vault has. So the walk
 * falls to the first file landing in a directory nothing records yet, and a
 * settled vault pays nothing at all. Nothing is asked either for a version
 * that changes nothing (the `held` rule), for a rename (the host's own move
 * answers), or for a record this device only re-stamps.
 *
 * THE ECHO KEY IS REGISTERED FOR BOTH SPELLINGS, because which one the vault
 * reports back is the vault's business: Obsidian's index answers with the
 * spelling it keeps, and a host that echoes the name it was handed answers
 * with the other. A mark nothing consumes expires with the next scan cycle
 * (`engine.ts`, `sweepEchoes`); an unmarked write is published back.
 */
async function landedAt(context: SyncContext, stat: VaultStat): Promise<VaultStat> {
  context.written.add(`${stat.path}:${stat.mtime}:${stat.size}`);
  const folder = stat.path.slice(0, Math.max(0, stat.path.lastIndexOf("/")));
  if (folder === "" || context.state.folderByPath(folder) !== undefined) return stat;
  const shown = await context.host.spelling(stat.path);
  if (shown === null || shown === stat.path) return stat;
  context.written.add(`${shown}:${stat.mtime}:${stat.size}`);
  context.host.log("pull path_class=file decision=recorded reason=vault_spelling");
  return { ...stat, path: shown };
}

/** Does the file at `path` still carry the `(mtime, size)` of `was`? */
async function unmoved(context: SyncContext, path: string, was: { mtime: number; size: number }): Promise<boolean> {
  const now = await context.host.stat(path);
  return now !== null && now.mtime === was.mtime && now.size === was.size;
}

/** Content verification shared by pull and create-only restore; no identity or echo bookkeeping. */
export async function writeVerified(context: SyncContext, manifest: Manifest, writer: VaultWriter, control?: ReadControl): Promise<void> {
  if (manifest.chunks.length === 1) {
    const only = await firstChunk(context, manifest, control);
    if (manifest.sha256 !== "" && hex(await sha256(only)) !== manifest.sha256) throw new Error("pull: plaintext hash mismatch");
    control?.check();
    await writer.write(only);
  } else {
    for await (const part of chunkPlaintexts(context, manifest, control)) {
      control?.check();
      await writer.write(part);
    }
  }
}

async function firstChunk(context: SyncContext, manifest: Manifest, control?: ReadControl): Promise<Bytes> {
  for await (const part of chunkPlaintexts(context, manifest, control)) return part;
  return new Uint8Array(0);
}

/**
 * A version whose manifest this device will not act on. It is never written,
 * never recorded, and never retried: the feed advances past it, because a
 * hostile device that could wedge the feed could stop sync for the vault.
 */
function refuse(context: SyncContext, change: ChangeRecord, reason: string): ApplyResult {
  context.host.log(
    `pull path_class=manifest decision=refused reason=${reason} file=${change.file_id} seq=${change.seq}`,
  );
  // A key this device does not hold is about the DEVICE that sealed with it,
  // not about one file: one notice per device, naming the one to fix (#140).
  const key = `key\u0000${change.device_id}`;
  if (reason === "undecryptable" && !context.refused.has(key)) {
    context.refused.add(key);
    const name = context.deviceNameFor(change.device_id);
    context.host.notify(
      `obsync cannot read changes from "${name}": they are sealed with a different vault key. This device skips ` +
        `them and keeps receiving everything else; nothing was written here. On "${name}", restore this vault's ` +
        "recovery phrase (obsync settings, Recovery phrase), or leave the server there and pair it again.",
    );
  }
  if (reason !== "undecryptable" && !context.refused.has(change.file_id)) {
    context.refused.add(change.file_id);
    context.host.notify(
      `obsync refused a change from another device: it does not name a file or folder this device can write inside this vault (${reason}). ` +
        `Nothing was written. File id ${change.file_id}.`,
    );
  }
  return "refused";
}

/**
 * Apply one change-feed record.
 */
export async function applyChange(context: SyncContext, change: ChangeRecord): Promise<ApplyResult> {
  // The owner-only domain map rides the same feed under a reserved file id
  // (`domainmap.ts`). It is not a vault file: it has no path, it is sealed
  // under `K_map` rather than a manifest key, and the engine already read it
  // at start. Skipping it by id — before anything tries to decrypt it with
  // the wrong key — is what keeps it out of the vault and out of the log as
  // a false integrity failure.
  if (change.file_id === context.mapFileId) {
    context.host.log(`pull path_class=domainmap decision=skipped seq=${change.seq}`);
    return "skipped";
  }
  if (context.authored.has(change.version_id)) {
    context.authored.delete(change.version_id);
    return "echo";
  }
  if (change.device_id === context.deviceId) return "echo";
  try {
    const entry = await decodeRecordManifest(context, change);
    // NOTHING INTO A VAULT OF ITS OWN, AND NOTHING OUT OF ONE (issue #180):
    // that vault would publish the write again one level deeper. Asked of
    // where the record puts the file and of where this device keeps it,
    // before either is touched.
    const kept = context.state.pathByFileId(change.file_id);
    if ((await context.host.inNestedVault(entry.path)) || (kept !== undefined && (await context.host.inNestedVault(kept)))) {
      throw new VaultPathError("nested_vault");
    }
    const applied = await applyVersion(context, change, entry).catch((error: unknown) => {
      // A write THIS device's disk refused, or a chunk the server does not
      // hold: a fact about this one record, named with the path it was for,
      // so the feed can park it and keep the rest arriving (issue #144).
      const reason = unwritable(error);
      throw reason === null ? error : new Unwritable(entry.path, reason);
    });
    // A version that moved a file off a name, or landed one beside its own,
    // is when a waiting name is most likely free (issue #149).
    await settleBeside(context, change.seq);
    return applied;
  } catch (error) {
    // Both refusals are the same decision to the user: this version does not
    // name a file this device may write, by its text (`ManifestError`) or by
    // what the filesystem says its path IS (`VaultPathError` — a symlinked
    // folder, a raced temp file). Skip the version, keep the feed moving.
    if (error instanceof ManifestError) return refuse(context, change, error.reason);
    if (error instanceof VaultPathError) {
      // Not this device's to write, and not a hostile record: skipped. A
      // nested vault was named to the user once, by the host.
      if (error.refusal === "outside_sync_scope" || error.refusal === "nested_vault") {
        context.host.log(`pull path_class=manifest decision=not_synced reason=${error.refusal} file=${change.file_id} seq=${change.seq}`);
        return "skipped";
      }
      return refuse(context, change, error.refusal);
    }
    throw error;
  }
}

/**
 * Apply one folder record: the whole of folder sync on the receiving side.
 *
 * A create makes the folder (and anything missing above it) and remembers the
 * record. A tombstone removes the folder, but ONLY when it holds nothing — a
 * folder still holding a note, an untracked file or another device's ignored
 * file is kept, and the empty-parent walk that runs when its last file leaves
 * will take it then — and forgets the record either way. Nothing here fetches,
 * decrypts or writes a byte of content: a folder record has none.
 */
async function applyFolder(
  context: SyncContext,
  change: ChangeRecord,
  manifest: FolderManifest,
): Promise<ApplyResult> {
  const path = manifest.path;
  // WHAT THIS VAULT SHOWS, ASKED ONCE, because both decisions below turn on
  // it. A record naming one capitalisation of a selected folder reaches this
  // function on the string rule's tolerance alone (`syncScope.ts`,
  // `inFolderCaseScope`), and the tolerance is not an admission: unless the
  // vault holds a folder this path IS -- one directory entry, two spellings,
  // which only a host that folds case can answer -- the record names a folder
  // this device does not sync, and it is refused in the words it has always
  // been refused in. A host that keeps the two apart answers `null` here.
  const shown = await context.host.spelling(path);
  const folded = shown !== null && caseOnly(shown, path);
  if (!folded) assertFolderScope(path, context.state.data.syncFolders);
  if (manifest.deleted) {
    // Removed FIRST, forgotten after. The record is what `pushFolderDelete`
    // needs to publish a tombstone, so it is still there while the removal
    // runs and the vault reports it — which is what `trashed` suppresses
    // (`engine.ts`, ECHOES; issue #96). Forgotten either way: a folder kept
    // because it still holds something is a folder no device manages now, and
    // the empty-parent walk is what will take it when it empties.
    // THE RECORD THIS TOMBSTONE RETIRES, READ BEFORE IT IS FORGOTTEN. A
    // tombstone that retires this device's own record for a folder it SELECTS
    // opens the one window in which a folder record one capitalisation off
    // that folder is this device's own folder under a new name
    // (`admitFolderRecord`; review round 4, finding 1). Its own record and
    // its own file id: a tombstone for another folder, or one naming a record
    // this device does not hold, opens nothing.
    const retiring = context.state.folderByPath(path);
    const removed = await removeFolder(context, path, shown);
    context.state.forgetFolder(path);
    if (retiring?.fileId === change.file_id) bury(context, change.file_id, change.version_id, path, true, change.ts);
    if (retiring?.fileId === change.file_id && (context.state.data.syncFolders ?? []).includes(path)) {
      context.state.data.retiredRoots[path] = change.file_id;
    }
    await context.state.save();
    if (removed !== "removed") {
      // `vault_spelling` said so at the point of decision, with the reason
      // only that walk knows; this is the one the receiver has always logged.
      if (removed === "not_empty") {
        context.host.log(`folder path_class=folder decision=kept reason=not_empty seq=${change.seq}`);
      }
      return "skipped";
    }
    context.host.log(`folder path_class=folder decision=removed reason=tombstone seq=${change.seq}`);
    await pruneEmptyParents(context, path);
    return "deleted";
  }
  // A FOLDER RECORD IS THE ONLY THING THAT MAY RE-CASE A DIRECTORY (#124).
  // The directory this record names may already be here under another
  // capitalisation -- one entry, two spellings, on every host that folds case
  // -- and `createFolder` would find it "already a directory" and do nothing,
  // which is how the two devices ended up spelling one folder two ways and
  // publishing the difference back and forth forever. A note's own move
  // cannot repair it: `rename(2)` resolves the directory components of its
  // destination and leaves their spelling alone. This record can, because a
  // folder record IS its path.
  if (folded) return await recaseFolder(context, change, shown as string, path);
  // Marked before the call, like every other write this device makes: the
  // vault reports the new folder to this plugin's own create handler while
  // `createFolder` is still running (`engine.ts`, ECHOES).
  context.createdFolders.add(path);
  try {
    await context.host.createFolder(path);
  } catch (error) {
    context.createdFolders.delete(path);
    if (error instanceof VaultPathError) {
      // A FILE stands where another device says a folder is. Named here as a
      // folder decision as well, because `refuse` can only say "manifest".
      context.host.log(
        `folder path_class=folder decision=refused reason=${error.refusal} seq=${change.seq}`,
      );
    }
    throw error;
  }
  context.state.setFolder(path, { fileId: change.file_id, versionId: change.version_id });
  await context.state.save();
  context.host.log(`folder path_class=folder decision=created seq=${change.seq}`);
  return "applied";
}

/**
 * Move this device's folder selection with a folder rename it RECEIVED.
 *
 * The device that makes a rename moves its own selection with it
 * (`engine.ts`, `followSelection`); a device that is told about one owes the
 * same, or it is left selecting a folder its vault no longer shows. Nothing
 * is saved here: every caller saves the records it moves in the same act, and
 * a selection persisted without them would be the half-applied state this
 * whole path exists to avoid.
 */
function followSelection(context: SyncContext, from: string, to: string): void {
  const { state, host } = context;
  let followed: { folders: string[]; moved: number } | null;
  try {
    followed = selectionAfterRename(state.data.syncFolders, from, to);
  } catch (error) {
    // A destination this device may not select at all: the selection stays
    // where it is and says so, exactly as the push side says it.
    host.log(
      `scope decision=not_followed reason=${error instanceof VaultPathError ? error.refusal : "invalid_selection"} ` +
        `folders=${movedSelection(state.data.syncFolders, from).length}`,
    );
    return;
  }
  if (followed === null) return;
  state.data.syncFolders = followed.folders;
  host.log(`scope decision=followed_recase folders=${followed.moved} selected=${followed.folders.length}`);
}

/**
 * Apply a folder record whose path differs from this vault's own spelling of
 * it by capitalisation alone: rename the DIRECTORY ENTRY, then move every
 * record under it with the entry (issue #124).
 *
 * WHY THE ENTRY AND NOT THE FILES. On a host that folds case `Team docs` and
 * `team docs` are one directory, and the per-file move an incoming rename
 * used to be applied by is a POSIX no-op for it: `rename(2)` resolves the
 * directory components of its destination and renames only the last one. The
 * receiving device therefore ended with records spelling a folder one way and
 * a vault spelling it the other, and the scan's `(mtime, size)` pairing
 * published that difference as a rename BACK -- one new version per note
 * every SCAN_MS, on both devices, until the account quota answered 507.
 *
 * ORDER, AND WHAT MAKES IT SAFE EITHER WAY. The sender publishes this record
 * before the moves under it (`main.ts`), so the ordinary course is: the
 * directory is re-cased here, the records follow it, and each move that
 * arrives next names a path this device already holds. A move that arrives
 * FIRST -- from a device older than this version, which publishes no folder
 * record at all -- changes nothing here and says so (`applyVersion`); it can
 * never create the bounce, because nothing records a spelling this vault does
 * not show.
 *
 * THE SELECTION FOLLOWS THE FOLDER, exactly as it does on the device that
 * MAKES the rename (`engine.ts`, `followSelection`). A folder record is
 * applied at the selection root as well as inside it (`syncScope.ts`), so
 * the folder this re-cases may BE what this device syncs -- and a selection
 * left at the spelling the vault no longer shows would put every file under
 * it out of scope in the same tick, which is a device that has quietly
 * stopped syncing its own folder (review round 3, finding 1). It is moved
 * only once the VAULT has confirmed the new spelling, and put back if
 * anything below refuses, so the selection never names a folder this vault
 * does not show. `parseSyncFolders` drops a selection that lives under
 * another, so nothing selected can be strictly under the one this renames.
 */
async function recaseFolder(
  context: SyncContext,
  change: ChangeRecord,
  from: string,
  to: string,
): Promise<ApplyResult> {
  const prefix = `${from}/`;
  const under = (path: string): string => to + path.slice(from.length);
  const files = Object.keys(context.state.data.files).filter((path) => path.startsWith(prefix));
  const folders = Object.keys(context.state.data.folders)
    .filter((path) => path === from || path.startsWith(prefix));
  // Marked BEFORE the rename, like every other write this device makes. A
  // folder rename is reported ONCE, for the folder, and this plugin fans that
  // one event out into a move of every file beneath it and a
  // tombstone-and-create of every folder record beneath it (`main.ts`).
  // Unmarked, this device publishes the peer's own rename straight back at it
  // (`engine.ts`, ECHOES; issue #96).
  const echoes = files.map((path) => `${path}\u0000${under(path)}`);
  for (const echo of echoes) context.moved.add(echo);
  for (const folder of folders) {
    context.trashed.add(folder);
    context.createdFolders.add(under(folder));
  }
  const unmark = (): void => {
    for (const echo of echoes) context.moved.delete(echo);
    for (const folder of folders) {
      context.trashed.delete(folder);
      context.createdFolders.delete(under(folder));
    }
  };
  const outcome = await context.host.moveFolder(from, to).catch((error: unknown) => {
    unmark();
    throw error;
  });
  // ASKED, NEVER ASSUMED. A host that answered `moved` for a rename that left
  // the directory spelled the way it was would have this device write records
  // its own listing contradicts -- which is the livelock, one layer up. The
  // vault says what it shows, and nothing is recorded until it says this.
  if (outcome !== "moved" || (await context.host.spelling(to)) !== to) {
    unmark();
    context.host.log(
      `folder path_class=folder decision=case_refused ` +
        `reason=${outcome === "moved" ? "not_respelled" : outcome} seq=${change.seq}`,
    );
    return "refused";
  }
  // THE SELECTION FOLLOWS THE ENTRY TOO, and only now: until the vault
  // answered, a selection moved forward would have named a folder this vault
  // does not show. After it, a selection left behind is what would -- and
  // every file under it would leave the scope in the same tick, on a device
  // whose own folder just changed its capitalisation (review round 3,
  // finding 1). Nothing else in the selection moves: `parseSyncFolders` drops
  // a selected folder that lives under another.
  followSelection(context, from, to);
  // THE RECORDS FOLLOW THE ENTRY, ALL OF THEM, BEFORE ANY CHILD WORK. What
  // moved is the directory, so every path beneath it moved with it; a record
  // left at the old spelling is one the next scan reads as a deletion of a
  // live note.
  for (const path of files) {
    const record = context.state.fileByPath(path);
    if (record === undefined) continue;
    context.state.setFile(under(path), record);
    context.state.forgetPath(path);
  }
  for (const folder of folders) {
    const record = context.state.folderByPath(folder);
    if (record === undefined) continue;
    context.state.setFolder(under(folder), record);
    context.state.forgetFolder(folder);
  }
  context.state.setFolder(to, { fileId: change.file_id, versionId: change.version_id });
  await context.state.save();
  context.host.log(
    `folder path_class=folder decision=case_renamed files=${files.length} folders=${folders.length} seq=${change.seq}`,
  );
  await refetchCarried(context, files.map(under), change.seq);
  return "applied";
}

/**
 * The heads that were refused while the two spellings disagreed.
 *
 * A version naming the new spelling that arrived BEFORE this folder record --
 * a move that lost the race on the sender's own queue, or an edit made on a
 * device that publishes no folder record at all -- was refused
 * (`case_move_refused reason=folder_case`), and the feed advanced past it.
 * Nothing re-delivers it: this device holds the version it had when the
 * disagreement began, the server holds the newer one, and only the NEXT edit
 * of that note would bring it down. So "update that device and the two agree
 * again" was true of the folder's spelling and not of its notes
 * (`CHANGELOG.md`, `docs/troubleshooting.md`; review round 2, findings 2
 * and 4).
 *
 * Now that the directory and the records agree, each carried record's head is
 * asked for once and applied through the ordinary path, which fetches nothing
 * for a version this device already holds (the `held` rule) and merges,
 * renames or downloads exactly as the feed would have. ONE `getFile` PER
 * CARRIED RECORD, bounded by the folder that was re-cased and not by the
 * vault; a folder holding nothing costs nothing. A failure here is logged and
 * dropped rather than raised: the re-case itself has already succeeded and is
 * saved, and the feed must not be wedged by a request that can be made again
 * at the next one.
 *
 * IT IS LONG-RUNNING WORK, so it says what it is about to do and what it is
 * measured against before it starts, and sums up afterwards (requirement 12):
 * one fetch per carried record is the budget, and the records are the folder
 * the re-case carried.
 */
async function refetchCarried(context: SyncContext, paths: string[], seq: number): Promise<void> {
  const started = context.now();
  let applied = 0;
  let failed = 0;
  context.host.log(
    `folder path_class=folder decision=start reason=heads_refetch budget_records=${paths.length} ` +
      `budget_fetches=${paths.length} seq=${seq}`,
  );
  for (const path of paths) {
    const record = context.state.fileByPath(path);
    if (record === undefined) continue;
    try {
      const file = await context.transport.getFile(record.fileId);
      for (const head of file.heads) {
        const current = context.state.fileByPath(path)?.versionId;
        if (head === current) continue;
        const version = file.versions.find((candidate) => candidate.version_id === head);
        if (version === undefined) continue;
        // A version record names neither its file nor its domain: the server
        // renders both on the file object (`engine.ts`, `reconcileFile`).
        await applyChange(context, {
          ...version,
          file_id: record.fileId,
          domain_id: file.domain_id,
          seq: context.state.data.lastSeq,
          heads: file.heads,
          conflicted: file.heads.length > 1,
        });
        applied++;
      }
    } catch (error) {
      failed++;
      context.host.log(
        `folder path_class=file decision=head_not_refetched reason=${refetchRefusal(error)} seq=${seq}`,
      );
    }
  }
  context.host.log(
    `folder path_class=folder decision=heads_refetched records=${paths.length} applied=${applied} ` +
      `failed=${failed} seq=${seq} duration_ms=${context.now() - started}`,
  );
}

/**
 * One word for why a head could not be re-fetched, from a FIXED vocabulary.
 *
 * A structured line carries decisions, not prose: an error's own message is
 * written by whatever raised it -- a server's error body among them -- and
 * pasting it into a log line puts text this device did not choose into a
 * field readers parse (requirement 12). The class of the failure and, for a
 * request, the status the transport itself read are what a reader needs.
 */
function refetchRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "unreachable") return "unreachable";
    return error.status === 0 ? "not_ready" : `http_${error.status}`;
  }
  if (error instanceof ManifestError) return `manifest_${error.reason}`;
  if (error instanceof VaultPathError) return error.refusal;
  return "failed";
}

/**
 * Why the file at `path` is not this version's to replace, or `null`.
 *
 * A pull may overwrite a local file only when it still carries the size and
 * modification time this device recorded there for THIS file id. The test is
 * the startup reconciliation's own (`engine.ts`): the record a device keeps
 * per path, compared against the file's `(mtime, size)`. It is metadata, not a
 * content hash -- an edit that changes neither dimension is not detected, and
 * re-chunking every local file on every incoming version is the price of
 * closing that, which this does not pay. Each answer is a
 * different way for local content to exist nowhere else -- `no_record`, a file
 * created here while the engine was not running; `other_file`, a different
 * file that happens to share the name, which is how two devices racing the
 * same new note arrive; `local_edit`, a file edited here since it was last
 * pushed. In all three the push that would carry those bytes has not run yet,
 * so the server holds nothing that could give them back.
 */
async function competing(
  context: SyncContext,
  path: string,
  fileId: string,
): Promise<"no_record" | "other_file" | "local_edit" | null> {
  const stat = await context.host.stat(path);
  if (stat === null) return null;
  const record = context.state.fileByPath(path);
  if (record === undefined) return "no_record";
  if (record.fileId !== fileId) return "other_file";
  if (record.mtime !== stat.mtime || record.size !== stat.size) return "local_edit";
  return null;
}

/**
 * Is the note a tombstone would remove open in an editor here and being typed
 * in (issue #146)? `null` when no editor shows it; otherwise the fields its
 * log line carries and whether it is held.
 *
 * `competing` sees the FILE, and the newest keystrokes are not in it: Obsidian
 * keeps them in the editor until its debounced save, so a deletion that
 * fast-forwards over the version the editor last saved passed every check and
 * took the note from under the cursor. Held means the editor holds text the
 * file does not, or this device published an edit of the note inside
 * `EDITING_WINDOW_MS`. The second half is the ENGINE's to answer, not the
 * editor's: an editor also changes when a pulled version is merged into it, and
 * only the push queue's own record (`pushedAt`) says the change came from here.
 *
 * Only a tombstone whose parent IS the version this device holds is asked
 * about. One that reaches it across versions this device never applied deletes
 * text newer than this file, and publishing the file again would put the older
 * text back over it.
 */
async function openEditing(
  context: SyncContext,
  path: string,
  local: FileState,
  change: ChangeRecord,
): Promise<{ held: boolean; fields: string } | null> {
  if (!change.parents.includes(local.versionId)) return null;
  const editor = await context.host.editing(path);
  if (editor === null) return null;
  const at = context.pushedAt.get(path);
  const age = at === undefined ? -1 : context.now() - at;
  return {
    held: editor === "unsaved" || (at !== undefined && age <= EDITING_WINDOW_MS),
    fields: ` editor=${editor} age_ms=${age} budget_ms=${EDITING_WINDOW_MS}`,
  };
}

/**
 * A deletion this device declined to apply, said once per file. The note is
 * still there and still the user's, so the message says what happened rather
 * than what failed -- and WHY, in the words that are true here (issue #173):
 * the fork guard keeps a version that is already on the server, where saying
 * it holds changes not uploaded yet sent the user looking for an upload that
 * never happens.
 */
function notifyKeptDeletion(context: SyncContext, change: ChangeRecord, path: string, onServer: boolean): void {
  if (context.refused.has(change.file_id)) return;
  context.refused.add(change.file_id);
  context.host.notify(
    `obsync did not delete ${path}: ` + (onServer
      ? "another device deleted it without having seen the version here, which is already on the server, so the " +
        "note is kept."
      : "it holds changes this device has not uploaded yet. Another device deleted that note; this copy is kept " +
        "here and is uploaded as a new version."),
  );
}

/**
 * A folder another device spells differently, said once per folder.
 *
 * Nothing here failed and nothing was written: the two devices disagree about
 * the capitalisation of a directory, and this one will not re-case a
 * directory on the strength of a note's version -- only a folder record does
 * that, and a device older than 1.1.0 publishes none. The message says what
 * the user can do, because only they can: update the other device, or rename
 * the folder here. Keyed by the FOLDER and not by the file id `refused`
 * otherwise holds, so a folder of two hundred notes is one notice and not two
 * hundred; a vault path and a file id cannot collide.
 */
function notifyFolderCase(context: SyncContext, folder: string): void {
  if (context.refused.has(folder)) return;
  context.refused.add(folder);
  context.host.notify(
    `obsync: another device spells the folder "${folder}" with different capitalisation than this one shows. ` +
      "Notes under it are kept where they are; nothing was written, moved or deleted here. Update every device " +
      "to this version and let each sync once, or rename the folder here to match -- see Troubleshooting, " +
      '"Two folders that differ only in capitalisation".',
  );
}

async function applyVersion(context: SyncContext, change: ChangeRecord, entry: Manifest | FolderManifest): Promise<ApplyResult> {
  if (entry.v === 2) return await applyFolder(context, change, entry);
  const manifest = entry;
  // `let`, because a case-only move renames the entry and then continues
  // down the ordinary path under the new spelling (issue #124).
  let localPath = context.state.pathByFileId(change.file_id);
  // A remembered source can be outside the new scope even when the remote
  // destination is inside it. Refuse before a delete, conflict read or write.
  if (localPath !== undefined) assertSyncPath(localPath, context.state.data.syncFolders);
  const local = localPath === undefined ? undefined : context.state.fileByPath(localPath);

  if (manifest.deleted) {
    if (localPath !== undefined) {
      // THE HALF THE SERVER CANNOT SEE, one branch over (issue #98). A
      // deletion is the change that leaves nothing behind, and the file at
      // this path may hold bytes no version holds: typed while Obsidian was
      // closed, or while this folder was outside the selection -- which a
      // widening replays the whole feed against, tombstones included. The
      // server's frame says the file was deleted THERE; it says nothing
      // about what this device has written here since. Delete-versus-edit
      // keeps BOTH sides (`docs/architecture.md`, section 4), so the file is
      // proved against the record before anything is removed, and the record
      // is left in place so the push republishes those bytes as a version of
      // their own.
      //
      // And the graph is asked first, exactly as it is for a version that is
      // not this device's child: a tombstone whose parents do not include the
      // version this device holds is one side of a FORK, not an instruction.
      // A widening replays the feed from zero, so a deletion this device
      // already applied -- or one another device made before this device
      // published the edit that came after it -- arrives again, years of
      // journal later, against a file that has moved on.
      if (local !== undefined && local.versionId !== "" && !change.parents.includes(local.versionId)) {
        const file = await context.transport.getFile(change.file_id);
        if (reaches(file.versions, local.versionId, change.version_id)) {
          context.host.log(
            `pull path_class=tombstone decision=skipped reason=already_incorporated file=${change.file_id} seq=${change.seq}`,
          );
          return "skipped";
        }
        if (!reaches(file.versions, change.version_id, local.versionId)) {
          context.host.log(
            `pull path_class=tombstone decision=local_edit_kept reason=delete_vs_edit file=${change.file_id} seq=${change.seq}`,
          );
          // Retire the deletion from the current heads, preserving it in history.
          // Only the locally held edit and this tombstone are incorporated; an
          // unrelated concurrent edit remains a head for ordinary merge handling.
          const settled = await reviveFile(context, localPath, change.version_id);
          if (settled.status === "pushed") context.authored.add(settled.versionId);
          else notifyKeptDeletion(context, change, localPath, true);
          return "skipped";
        }
      }
      // A RETIREMENT NEVER DELETES WHAT ITS KEEPER HOLDS (issue #181).
      if (manifest.keeper !== undefined && local !== undefined &&
        (await retiredInto(context, change, manifest.keeper, localPath, local))) return "skipped";
      // A TOMBSTONE IS A STATEMENT ABOUT BYTES THE SERVER HAS (issue #106).
      // Bytes this device never pushed are bytes no version holds, so moving
      // them to the trash here is the one loss no history can undo, and the
      // user is told nothing -- on mobile the system trash is barely
      // reachable. `competing` is the same question the content branch asks
      // (issue #98): does the file at this path still hold what this device
      // put there? When it does not, the local file is kept and published as
      // a new version of the SAME file id, which brings the note back on
      // every device. That is delete-versus-edit keeping both, which
      // `docs/architecture.md` 6.2 item 4 already promises.
      //
      // A successful revive incorporates both the local edit's parent and
      // the deletion. The deletion remains in history, no longer a current
      // head that every subsequent save must meet again (issue #178).
      //
      // AND THE EDITOR IS ONE PLACE THOSE BYTES LIVE (issue #146): a note
      // open and being typed in holds its newest keystrokes there until the
      // next save, so it is kept and published again the same way.
      let held: string | null = await competing(context, localPath, change.file_id);
      const editing = held === null && local !== undefined ? await openEditing(context, localPath, local, change) : null;
      if (editing?.held === true) held = "open_editing";
      const open = editing?.fields ?? "";
      if (held !== null) {
        const started = context.now();
        const revived = await reviveFile(context, localPath, change.version_id);
        if (revived.status === "pushed") context.authored.add(revived.versionId);
        context.host.log(
          `pull path_class=tombstone decision=local_edit_kept reason=${held}${open} published=${revived.status} ` +
            `file=${change.file_id} seq=${change.seq} duration_ms=${context.now() - started}`,
        );
        if (revived.status !== "pushed") {
          // Failed publication still needs an actionable warning: the edit
          // exists only here until it can reach the server.
          notifyKeptDeletion(context, change, localPath, false);
        }
        return "skipped";
      }
      // Marked BEFORE the trash, not after: Obsidian reports the removal to
      // this plugin's own delete handler while `trash` is still running, and
      // an unmarked echo becomes a tombstone this device publishes for a file
      // the remote side already owns (`engine.ts`, ECHOES; issue #96).
      context.trashed.add(localPath);
      // And the removal names the bytes it removes, on a host that can bind
      // one: the check above is a stat, and a save landing between it and
      // the deletion is exactly what the bound removal exists for.
      const verdict = await context.host.trash(
        localPath,
        context.host.bindsRemoval === true && local !== undefined
          ? { path: localPath, mtime: local.mtime, size: local.size }
          : undefined,
      );
      if (verdict === "kept") {
        // The host found other bytes there and left them. Nothing was
        // removed, so no delete event is owed and the record stays: the push
        // carries what is on the disk.
        context.trashed.delete(localPath);
        context.host.log(
          `pull path_class=tombstone decision=local_edit_kept reason=source_changed_in_trash file=${change.file_id} seq=${change.seq}`,
        );
        return "skipped";
      }
      if (verdict === "unheld") {
        // The host cannot bind a removal after all -- a filesystem that
        // refuses `link`, or refuses the atomic move. Refusing here would
        // drop this deletion for good, because the feed advances past it, so
        // the device falls back to the unbound removal and the stat above is
        // what it could prove. That residual is named in the changelog.
        context.host.log(
          `pull path_class=tombstone decision=deleted reason=unheld file=${change.file_id} seq=${change.seq}`,
        );
        await context.host.trash(localPath);
      }
      context.state.forgetPath(localPath);
      bury(context, change.file_id, change.version_id, localPath, false, change.ts);
      await context.state.save();
      context.host.log(`pull path_class=tombstone decision=deleted seq=${change.seq}${open}`);
      await pruneEmptyParents(context, localPath);
      return "deleted";
    }
    delete context.state.data.remoteOnly[change.file_id];
    return "skipped";
  }

  if (local && local.versionId === change.version_id) return "skipped";

  const admission = admit(context.state.data.policy, context.state.localBytes(), manifest.size);
  if (!admission.ok) {
    const started = context.now();
    // AN OLDER LOCAL COPY IS NOT A SECOND TRUTH (issue #100). The file's
    // current version is one this device will not hold, so any copy still on
    // disk is behind it with nothing on screen saying so: the file explorer
    // lists a file that looks synced while "Show remote-only files" lists the
    // same path as absent, and one touch of that copy publishes a version
    // whose parent is not the latest -- which is a conflict copy of stale
    // content on every other device. Remote-only means remote-only, and Fetch
    // is the way back. The one copy that is NOT this decision's to remove is
    // one holding bytes this device never pushed, because no version holds
    // them (`competing`, issue #98); that copy stays and its queued push
    // carries it.
    let local = "none";
    if (localPath !== undefined && (await context.host.stat(localPath)) !== null) {
      const held = await competing(context, localPath, change.file_id);
      if (held !== null) local = `kept_${held}`;
      else {
        context.trashed.add(localPath);
        await context.host.trash(localPath);
        context.state.forgetPath(localPath);
        local = "trashed";
      }
    }
    context.state.data.remoteOnly[change.file_id] = { path: manifest.path, size: manifest.size };
    await context.state.save();
    context.host.log(
      `pull path_class=file bytes=${manifest.size} decision=remote_only reason=${admission.reason} ` +
        `local=${local} seq=${change.seq} duration_ms=${context.now() - started}`,
    );
    return "remote_only";
  }

  if (local && !change.parents.includes(local.versionId)) {
    // Not our child by its parent list -- so ask the graph what it is. Three
    // answers: a version our own already reaches is one this device has
    // incorporated (its own merge, or a head it resolved), a version that
    // reaches ours is a fast-forward across versions this device skipped, and
    // anything else is two heads to resolve. The server's `conflicted` flag
    // answers none of them: it was computed when this version was journaled,
    // so the frame for the head another device wrote FIRST still says false
    // after this device forked the file, and obeying it discards the merge.
    const file = await context.transport.getFile(change.file_id);
    if (reaches(file.versions, local.versionId, change.version_id)) {
      context.host.log(
        `pull path_class=file decision=skipped reason=already_incorporated file=${change.file_id} seq=${change.seq}`,
      );
      return "skipped";
    }
    if (!reaches(file.versions, change.version_id, local.versionId)) {
      return await reconcile(context, file, change, manifest, localPath as string, local.versionId);
    }
  }

  // A MOVE THAT CHANGES ONLY CASE IS ONE RENAME, NOT A WRITE AND A REMOVAL.
  // On a host that folds case the two spellings are ONE entry, so the write
  // below would land in the file this device already has -- leaving the
  // directory spelling the old way -- and the removal that follows a move
  // would then take that very file, the note gone with it. The same host
  // answers `competing` for the destination with the SOURCE's own file,
  // which no record explains under the new spelling, so the move also
  // arrives at the same-name rule as a collision and is settled at the old
  // name for good (issue #124). Renaming the entry first is the operation
  // both host models share: the host refuses if a DIFFERENT file wears the
  // destination's exact name, and that refusal is the real collision, which
  // falls through to the rule below untouched.
  //
  // AND A DIRECTORY'S CASE IS NOT A NOTE'S TO CHANGE. Where the difference
  // lies in a directory component, this rename is a POSIX no-op that answers
  // `moved`: `rename(2)` resolves the destination's directories and renames
  // only its last component, so the entry keeps the spelling it had. A device
  // that recorded the new spelling anyway would hold a record its own listing
  // contradicts, and the scan's `(mtime, size)` pairing publishes that
  // difference as a rename BACK -- one version per note every SCAN_MS, on
  // both devices, for as long as both run. The folder record is what re-cases
  // a directory (`recaseFolder`) and the sender publishes it first
  // (`main.ts`); this asks the vault what it shows, applies the move when the
  // vault has already made it, and otherwise changes NOTHING and says so.
  const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (localPath !== undefined && caseOnly(localPath, manifest.path)) {
    // TWO QUESTIONS, ASKED OF THE VAULT ITSELF. What does it show for the
    // name this device holds, and what for the name the version wants? A host
    // that keeps the two spellings apart answers `null` for a name nothing
    // wears, and the rename below makes the move exactly as it did before.
    const differ = folderOf(localPath) !== folderOf(manifest.path);
    const shownSource = differ ? await context.host.spelling(localPath) : null;
    const shownTarget = differ ? await context.host.spelling(manifest.path) : null;
    if (shownSource === manifest.path) {
      // ONE ENTRY, ALREADY SPELLED THE NEW WAY: the name this device holds
      // and the name this version wants are the same directory entry, so the
      // move has already happened -- the folder record made it -- and only
      // the record is behind. Asked of the vault, never assumed from the
      // folder record having run first.
      const record = context.state.fileByPath(localPath);
      if (record !== undefined) {
        context.state.setFile(manifest.path, record);
        context.state.forgetPath(localPath);
        await context.state.save();
      }
      context.host.log(
        `pull path_class=file decision=case_move_satisfied file=${change.file_id} seq=${change.seq}`,
      );
      localPath = manifest.path;
    } else if (shownTarget !== null && shownTarget !== manifest.path) {
      // The vault answers for the name this version wants with a DIFFERENT
      // spelling of it, which is a host that folds case and a directory this
      // record may not re-case. Nothing is moved and nothing is recorded.
      context.host.log(
        `pull path_class=file decision=case_move_refused reason=folder_case file=${change.file_id} seq=${change.seq}`,
      );
      notifyFolderCase(context, folderOf(manifest.path));
      return "refused";
    }
  }
  if (localPath !== undefined && caseOnly(localPath, manifest.path)) {
    // Marked BEFORE the rename, not after it: the vault reports the rename
    // to this plugin's own handler while `move` is still running, and an
    // unmarked echo is published as a move of this device's own -- which the
    // device that made it then applies back (`engine.ts`, ECHOES; #96).
    const echo = `${localPath}\u0000${manifest.path}`;
    context.moved.add(echo);
    const outcome = await context.host.move(localPath, manifest.path).catch((error: unknown) => {
      context.moved.delete(echo);
      throw error;
    });
    context.host.log(
      `pull path_class=file decision=case_move_${outcome} file=${change.file_id} seq=${change.seq}`,
    );
    if (outcome !== "moved") context.moved.delete(echo);
    if (outcome === "moved") {
      const record = context.state.fileByPath(localPath);
      if (record !== undefined) {
        context.state.setFile(manifest.path, record);
        context.state.forgetPath(localPath);
      }
      // Saved before the write, not after it: a record left at the old
      // spelling while the entry wears the new one is what the next startup
      // scan would read as a deletion of a live note.
      await context.state.save();
      localPath = manifest.path;
    }
  }

  // The half the server cannot see. It flags `conflicted` only for a version
  // whose parents are not its file's heads, and a device that was closed while
  // another wrote posts nothing, so the incoming version arrives as an honest
  // descendant of the parent this device recorded -- over a local file that
  // has moved on since. Materialising it would replace bytes no version holds,
  // and the push already queued for that path would then find the record and
  // the file agreeing and send nothing, which is how the edit left no trace
  // anywhere (issue #98). The move's trash half is the same loss one path over.
  const atTarget = await competing(context, manifest.path, change.file_id);
  const atSource =
    localPath !== undefined && localPath !== manifest.path
      ? await competing(context, localPath, change.file_id)
      : null;
  const held = atTarget ?? atSource;
  if (held !== null) {
    context.host.log(
      `pull path_class=file bytes=${manifest.size} decision=local_edit_kept reason=${held} file=${change.file_id} seq=${change.seq}`,
    );
    // Another NOTE at the destination is not an edit at all: it is two notes
    // wearing one name, and it is settled by rule rather than kept apart
    // forever (issue #113). Only the DESTINATION is settled that way. The
    // source is not touched by any answer the rule gives: vacating the
    // destination (`null` below, then the move's trash half) is reachable
    // only when this device does not track this file id at all, and when it
    // does, the rule hands the version to `updateSettled`, which re-checks
    // that source before writing a byte. Trashing a source that holds an
    // unpushed edit is the loss issue #98 is about.
    if (atTarget === "other_file" || atTarget === "no_record") {
      const decided = await sameNameTiebreak(context, change, manifest, atTarget);
      if (decided !== null) return decided;
    } else if (atTarget === "local_edit" && localPath === manifest.path && local !== undefined) {
      return await reconcile(context, await context.transport.getFile(change.file_id), change, manifest, localPath, local.versionId);
    } else {
      return await keepBoth(context, change, manifest);
    }
  }

  // NOTHING MOVED AND NOTHING CHANGED, SO NOTHING IS FETCHED (issue #108).
  // A version that names the path this device already holds, carrying the
  // content this device already holds, is a version this device already has.
  // A case-only rename arrives exactly like that -- the rename above has just
  // put the entry at this very path, and a folder record that re-cased a
  // directory brought its records with it -- and the changelog's promise for
  // a rename is that nothing is downloaded. Without this, `materialise` below
  // fetched a chunk and rewrote the whole note for a rename that changed no
  // byte: a 900 MB note is 900 MB over the phone's data for a name, and the
  // writer it goes through is the one window in which a save made here is
  // lost. THE PROOFS ARE THE RENAME SHORTCUT'S, minus the move: `held` is
  // null, so the file at this path still carries the `(mtime, size)` this
  // device recorded for THIS file id, and the record's `sha256` is the digest
  // `recordAt` wrote from the version's own sids. A version carrying any
  // other content falls through to the download below.
  if (
    localPath === manifest.path &&
    held === null &&
    local !== undefined &&
    local.size === manifest.size &&
    local.sha256 === (await sidDigest(change.sids))
  ) {
    const landed = (await context.host.stat(manifest.path)) ??
      { path: manifest.path, mtime: local.mtime, size: local.size };
    await recordAt(context, change, manifest.path, landed);
    context.host.log(
      `pull path_class=file bytes=${manifest.size} decision=held file=${change.file_id} seq=${change.seq}`,
    );
    return "applied";
  }

  // A REMOTE RENAME IS A RENAME HERE TOO (issue #108, owner ruling
  // 2026-09-22). Applying one as a write at the new name and a removal of the
  // old left a full copy of every renamed note in the receiving device's
  // system trash -- on mobile, somewhere the user can barely reach -- and
  // re-downloaded bytes the device already had. When the source still holds
  // exactly the content this version carries, the host's own atomic rename IS
  // the whole operation: no download, nothing trashed, the file id unchanged.
  //
  // WHAT MAKES IT SAFE was proved above, not added here. `held` is null, so
  // the file at the source still carries the `(mtime, size)` this device
  // recorded for THIS file id, and nothing else wears the destination's name.
  // The content test is the record's own `sha256`, which `recordAt` writes as
  // the digest of the version's sids -- so this asks that same question
  // backwards, and a version with any other content falls through to the
  // download below.
  //
  // THE FALLBACK IS NOT A SECOND PATH. `occupied` and `missing` fall through
  // to the write-and-trash below exactly as before, which is also what this
  // code did for every rename until now; the tests in
  // `plugin/test/rename.test.mjs` name the trash, so a mutant that forces
  // that fallback for every rename dies there rather than passing quietly.
  if (
    localPath !== undefined &&
    localPath !== manifest.path &&
    held === null &&
    local !== undefined &&
    local.size === manifest.size &&
    local.sha256 === (await sidDigest(change.sids))
  ) {
    // The destination is about to be handed to the host, so it is checked
    // here for the same reason `materialise` checks it: nothing reaches a
    // vault operation unchecked.
    assertVaultPath(manifest.path);
    // Marked BEFORE the rename: the vault reports it to this plugin's own
    // handler while `move` is still running, and an unmarked echo is
    // published as a move of this device's own (`engine.ts`, ECHOES; #96).
    const echo = `${localPath}\u0000${manifest.path}`;
    context.moved.add(echo);
    const outcome = await context.host.move(localPath, manifest.path).catch((error: unknown) => {
      context.moved.delete(echo);
      throw error;
    });
    if (outcome !== "moved") context.moved.delete(echo);
    if (outcome === "moved") {
      // A rename preserves both dimensions, so what the source was PROVED to
      // hold is what the destination holds; the host's own stat is preferred
      // where it gives one, and a host that cannot stat does not lose the
      // record.
      const landed = (await context.host.stat(manifest.path)) ??
        { path: manifest.path, mtime: local.mtime, size: local.size };
      const from = localPath;
      context.state.forgetPath(from);
      await recordAt(context, change, manifest.path, landed);
      // The folder the file moved OUT of may now be empty: the same rule and
      // the same walk as the removal branch below.
      await pruneEmptyParents(context, from);
      context.host.log(
        `pull path_class=file bytes=${manifest.size} decision=renamed file=${change.file_id} seq=${change.seq}`,
      );
      return "applied";
    }
    // No path in the line: a name is vault content (requirement 6), so the
    // issue's suggested `from=`/`to=` fields are deliberately not written.
    context.host.log(
      `pull path_class=file decision=rename_fallback reason=${outcome} file=${change.file_id} seq=${change.seq}`,
    );
  }

  const started = context.now();
  const landed = await materialise(context, manifest, localPath === manifest.path ? local : undefined);
  if (landed === null) {
    context.host.log(
      `pull path_class=file bytes=${manifest.size} decision=local_edit_kept reason=saved_during_pull file=${change.file_id} seq=${change.seq}`,
    );
    const file = await context.transport.getFile(change.file_id);
    return await reconcile(context, file, change, manifest, localPath as string, (local as FileState).versionId);
  }
  if (localPath !== undefined && localPath !== manifest.path) {
    // The move's delete half. The same echo, and the one that cost a renamed
    // note on every device before 1.0.4: here the file is not deleted at all,
    // it is the SAME file id, alive at `manifest.path`. The source was proved
    // against its record above, and the removal names those bytes too, so a
    // save landing between the two is kept rather than taken.
    context.trashed.add(localPath);
    const verdict = await context.host.trash(
      localPath,
      context.host.bindsRemoval === true && local !== undefined
        ? { path: localPath, mtime: local.mtime, size: local.size }
        : undefined,
    );
    if (verdict === "kept") {
      // Those bytes are in no version: they stay under the old name as local
      // content, and the scan publishes them as a file of their own.
      context.trashed.delete(localPath);
      context.host.log(
        `pull path_class=file decision=local_edit_kept reason=source_changed_in_trash file=${change.file_id} seq=${change.seq}`,
      );
    } else if (verdict === "unheld") {
      // A host that cannot bind one removes the old name the way every
      // device did before 1.0.7, rather than leaving a renamed note under
      // two names for good.
      await context.host.trash(localPath);
    }
    context.state.forgetPath(localPath);
    // The folder the file moved OUT of may now be empty. Same rule as a
    // deletion, and the same walk.
    await pruneEmptyParents(context, localPath);
  }
  // `landed.path`, never `manifest.path`: what the vault shows for the file
  // this write put there (`landedAt`, review round 2, finding 3).
  await recordAt(context, change, landed.path, landed);
  context.host.log(
    `pull path_class=file bytes=${manifest.size} chunks=${manifest.chunks.length} decision=applied seq=${change.seq} duration_ms=${context.now() - started}`,
  );
  return "applied";
}

/**
 * Download a file this device previously declined, ignoring the ceiling
 * because the user asked for this one by name.
 */
export async function fetchRemoteOnly(context: SyncContext, fileId: string): Promise<string> {
  const remembered = context.state.pathByFileId(fileId) ?? context.state.data.remoteOnly[fileId]?.path;
  if (remembered !== undefined) assertSyncPath(remembered, context.state.data.syncFolders);
  const file = await context.transport.getFile(fileId);
  const head = file.versions.find((version) => version.version_id === (file.heads[0] ?? ""));
  if (!head) throw new Error("remote-only: the file has no readable head");
  // The manifest AAD binds the file id; a version record carries none. Nor
  // does it carry a domain: the server states that once, on the file, so the
  // binding takes it from there.
  const manifest = await decryptRecordManifest(context, {
    ...head,
    file_id: fileId,
    domain_id: file.domain_id,
  });
  const written = await materialise(context, manifest);
  const stat = await context.host.stat(written.path);
  // The vault's own spelling of what was written, exactly as every other
  // record this device writes for a file it materialised (`landedAt`).
  context.state.setFile(written.path, {
    fileId,
    versionId: head.version_id,
    mtime: stat?.mtime ?? manifest.mtime,
    size: stat?.size ?? manifest.size,
    sha256: await sidDigest(head.sids),
    ts: head.ts,
  });
  await context.state.save();
  context.host.log(`pull path_class=file bytes=${manifest.size} decision=fetched_on_demand`);
  return written.path;
}

/** A version graph, as `GET /v1/files/{id}` renders it. */
export type VersionNode = { version_id: string; parents: string[] };

/** Parent lookup over one file's versions: the walk's only view of the graph. */
function parentsFrom(versions: VersionNode[]): (id: string) => string[] {
  const byId = new Map(versions.map((version) => [version.version_id, version.parents]));
  return (id) => byId.get(id) ?? [];
}

/** Every version `start` reaches through the parent graph, `start` included. */
function reachable(parents: (id: string) => string[], start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of parents(id)) queue.push(parent);
  }
  return seen;
}

/**
 * Is `target` `head` itself, or one of its ancestors?
 *
 * The question a version's `parents` cannot answer: it names the IMMEDIATE
 * parents, so a version this device never applied -- one a ceiling held back,
 * one whose manifest was refused, one outside the current folder selection --
 * leaves the record an ancestor rather than a parent, and the incoming version
 * is still a plain fast-forward. One walk, linear in the graph, and it is what
 * separates a fast-forward from a fork without trusting a flag the server
 * computed before this device had done anything.
 */
function reaches(versions: VersionNode[], head: string, target: string): boolean {
  return reachable(parentsFrom(versions), head).has(target);
}

/**
 * The newest version both heads reach, or `null`.
 *
 * THE PROPERTY. `versions` is the server's own order, newest first
 * (`docs/protocol.md`, "Files and versions"), so the answer is the FIRST id
 * in that order that both heads reach and that is neither head. That is what
 * "newest common ancestor" means here, and it is the whole contract: a merge
 * base is only as good as the edits it does not replay.
 *
 * ONE WALK PER SIDE. Both reachability sets are computed once and
 * intersected. Re-walking the right side per candidate gives the same answer
 * at N times the cost, and the version graph is another device's to shape:
 * the file a conflict lands on is the file with the longest history, and this
 * runs on Obsidian's UI thread while the user waits. `parentsOf` is injected
 * so a test can count lookups and hold that bound without timing a clock.
 */
export function commonAncestor(
  versions: VersionNode[],
  left: string,
  right: string,
  parentsOf?: (id: string) => string[],
): string | null {
  const parents = parentsOf ?? parentsFrom(versions);
  const fromLeft = reachable(parents, left);
  const fromRight = reachable(parents, right);
  for (const { version_id: id } of versions) {
    if (id !== left && id !== right && fromLeft.has(id) && fromRight.has(id)) return id;
  }
  return null;
}

/**
 * Two heads on one file -- or a version that DESCENDS from the one this device
 * recorded, arriving over an edit made here and not pushed yet (`applyVersion`).
 * Merge when we can prove a base and the content is mergeable text; otherwise
 * keep both sides. The caller passes the file it already read: deciding that
 * these ARE two heads walks the same graph, and asking twice would buy the same
 * answer with a second request.
 */
async function reconcile(
  context: SyncContext,
  file: FileRecord,
  change: ChangeRecord,
  theirManifest: Manifest,
  localPath: string,
  localVersionId: string,
): Promise<ApplyResult> {
  // THE BREAKER. Everything below is bounded by construction, but a bound
  // that rests on an argument is not a bound: the cost of being wrong here is
  // a device filling the server's journal and its owner's quota, on battery.
  // More than a handful of resolutions of ONE file in a row inside a minute,
  // with nothing written to the note here in between, is not a user editing on
  // two devices, so this device stops merging that file and keeps both sides
  // instead. It says so once, and the count is in the log.
  //
  // IN A ROW. The loop of issue #110 was named by its note never changing
  // after the first pass, and that is what is counted: resolutions that each
  // find the note exactly as the one before left it. A save in between starts
  // the count again. Two people typing in one open note fork it every few
  // seconds, and counting every one of THOSE tripped the breaker within
  // seconds and split the note between the devices for good (issue #135); a
  // run of resolutions broken by keystrokes is bounded by the typing, exactly
  // as a push is, and only an unbroken one can run away.
  const now = context.now();
  const found = stamp(await context.host.stat(localPath));
  const seen = context.merges.get(change.file_id);
  const tally = seen !== undefined && now - seen.since < MERGE_STORM_MS ? seen : { since: now, count: 0, left: found };
  if (tally.left !== found) tally.count = 0;
  tally.count++;
  context.merges.set(change.file_id, tally);
  const prior = tally.left;
  // Tripped, this device MERGES nothing more: a merge is the one resolution
  // that makes new content, which is what a loop feeds on. The pair is still
  // settled -- by the rule in `converge`, which only ever keeps a version that
  // already exists -- because keeping both sides with nothing closing the fork
  // is what left two devices split for good (issue #135).
  const tripped = tally.count > MERGE_STORM_LIMIT;
  if (tripped) {
    context.host.log(
      `pull decision=refused reason=merge_storm file=${change.file_id} count=${tally.count} window_ms=${MERGE_STORM_MS} counted=in_a_row_note_unchanged`,
    );
    if (!context.refused.has(change.file_id)) {
      context.refused.add(change.file_id);
      context.host.notify(
        `obsync stopped merging ${localPath}: this device resolved it more than ${MERGE_STORM_LIMIT} times in a row ` +
          `in under a minute without the note changing here. Every device keeps the same version as the note and ` +
          `the other beside it as a copy. Check that every device syncing this vault is up to date.`,
      );
    }
  }
  // Settled now, or left for a push again (`deferred`), which counts it anew.
  context.forked.delete(change.file_id);
  const result = await resolve(context, file, change, theirManifest, localPath, localVersionId, tally, tripped);
  // What the resolution LEFT: a write stamps its own commit (`resolve`), never
  // a later look, which could be the user's next save. One that wrote nothing
  // leaves the note as it found it -- unless one running beside it (the feed
  // and a push's own reconciliation resolve one fork side by side) wrote it
  // meanwhile, whose stamp stands.
  if (tally.left === prior) tally.left = found;
  return result;
}

/** A note's `(mtime, size)` as one comparable value; nothing at all is `""`. */
function stamp(stat: VaultStat | null): string {
  return stat === null ? "" : `${stat.mtime}:${stat.size}`;
}

/** The resolution itself; `reconcile` is its breaker. */
async function resolve(
  context: SyncContext,
  file: FileRecord,
  change: ChangeRecord,
  theirManifest: Manifest,
  localPath: string,
  localVersionId: string,
  tally: { left: string },
  tripped: boolean,
): Promise<ApplyResult> {
  // A version that already holds ours is a fast-forward over an edit made
  // here and not pushed yet: its base is exactly the version recorded.
  const ahead = reaches(file.versions, change.version_id, localVersionId);
  const baseId = ahead ? localVersionId : commonAncestor(file.versions, localVersionId, change.version_id);
  const before = await context.host.stat(localPath);
  const mine = await context.host.read(localPath);
  // TWO HEADS, ONE CONTENT.
  //
  // This is where the storm ended up. A and B each merge the same pair to the
  // same text and post it; the two posts differ only in their manifest nonce,
  // so they are two version ids for identical bytes and the file forks again.
  // Each device then merges THAT pair -- to the same bytes once more -- and
  // posts again, about seven times a second (issue #110).
  //
  // Identical bytes are nothing to write and nothing to say. But stopping is
  // not enough: if each device simply adopted the other's head the two would
  // SWAP, the server would still hold two heads, and the next real edit would
  // reconcile against the wrong base. So the head is chosen by a rule both
  // devices compute from the same two ids and cannot disagree about: the
  // lexicographically smaller one wins.
  // The comparison costs no download: the manifest is authenticated, so its
  // `sha256` is a trustworthy statement of the incoming plaintext, and the
  // local bytes are already in hand.
  if (
    !ahead &&
    theirManifest.sha256 !== "" &&
    theirManifest.size === mine.length &&
    hex(await sha256(mine)) === theirManifest.sha256
  ) {
    // A local version the server no longer holds as a head -- one a restored
    // server lost (issue #145) -- is no side of this pair: the one it holds is.
    const head = localVersionId < change.version_id && file.heads.includes(localVersionId) ? localVersionId : change.version_id;
    const held = context.state.fileByPath(localPath);
    if (held) context.state.setFile(localPath, { ...held, versionId: head, ts: head === localVersionId ? held.ts : change.ts });
    await context.state.save();
    context.host.log(
      `pull decision=converged reason=identical_bytes head=${head} file=${change.file_id} seq=${change.seq}`,
    );
    // Agreeing is not the same as closing. The file is still forked on the
    // server, and the next real edit would reconcile against the head this
    // device did not choose. So the device holding the WINNING head -- and
    // only that device, because both compute the same winner -- publishes one
    // version naming both heads as parents. The other says nothing, which is
    // what keeps this from becoming a second storm. Narrow on purpose: exactly
    // these two heads and no others, or the record convergence stands alone.
    if (
      held !== undefined &&
      head === localVersionId &&
      file.heads.length === 2 &&
      file.heads.includes(localVersionId) &&
      file.heads.includes(change.version_id)
    ) {
      await postMerged(context, change, localPath, localVersionId, mine, held.mtime, [...file.heads].sort());
      context.host.log(
        `pull decision=resolved reason=identical_heads file=${change.file_id} seq=${change.seq}`,
      );
    }
    return "skipped";
  }

  const mergeable =
    !tripped &&
    baseId !== null &&
    theirManifest.chunks.length === 1 &&
    theirManifest.size <= CHUNK_MAX &&
    isMergeableText(localPath, mine);

  if (mergeable) {
    const baseManifest = await manifestOf(context, file, change, baseId);
    if (baseManifest) {
      // A merge input is held whole in memory, so it must be one chunk on
      // BOTH sides. Their head was checked above; the ancestor is checked
      // here, because the version graph is another device's to shape and a
      // 20 GB ancestor of a 200-byte note is a graph it may legally post.
      if (baseManifest.chunks.length !== 1) {
        context.host.log(
          `pull decision=conflict_copy reason=base_above_one_chunk bytes=${baseManifest.size} file=${change.file_id}`,
        );
        return await keepBoth(context, change, theirManifest);
      }
      const base = await assembleBytes(context, baseManifest);
      const theirs = await assembleBytes(context, theirManifest);
      const decoder = new TextDecoder();
      let merged = threeWayMerge(decoder.decode(base), decoder.decode(mine), decoder.decode(theirs));
      if (!merged.ok) {
        const crossed = await crissCrossBase(context, file, change, [localVersionId, change.version_id], baseId, decoder.decode(base));
        if (crossed !== null) merged = threeWayMerge(crossed, decoder.decode(mine), decoder.decode(theirs));
      }
      if (merged.ok) {
        const text = new TextEncoder().encode(merged.text);
        // A FAST-FORWARD OVER AN UNPUSHED EDIT IS THE PUSH'S TO PUBLISH. 1.1.2
        // kept a conflict copy of every version another device sent while
        // someone typed here (issue #135). Merging it in here instead would
        // publish the edit twice -- the push already queued, or already in
        // flight, carries it onto the recorded version -- and two lines holding
        // one edit make every later merge an overlap. So nothing is written: the
        // record is marked so that push cannot come back `unchanged`, and it
        // forks the file, which its own reconciliation merges from this same
        // base. A version the merge could not take keeps both, as before.
        if (ahead && !sameBytes(text, theirs)) return await deferToPush(context, change, localPath);
        const writer = await context.host.writer(localPath);
        await writer.write(text);
        // THE NOTE IS LOOKED AT AGAIN AT THE LAST MOMENT. The downloads above
        // take time, and a note open in an editor is saved every few seconds
        // while someone types: a save landing meanwhile was written over,
        // keystrokes and all, and the editor then reloaded the loss (issue
        // #135). A note that moved is left alone. The push of that save forks
        // the file again, and its own reconciliation merges what is there.
        if (before === null || !(await unmoved(context, localPath, before))) {
          await writer.abort();
          return deferred(context, change, "saved_during_merge");
        }
        const stat = await writer.commit(context.now());
        tally.left = stamp(stat);
        context.written.add(`${stat.path}:${stat.mtime}:${stat.size}`);
        // The result is the INCOMING version's own bytes: that version already
        // carries this device's edit, so what the graph called a fork is a
        // fast-forward onto it. Adopt it and post nothing -- a third version
        // saying what the second already says is how the storm was fed. A
        // result that is new to both sides is a real resolution and is posted
        // once, which terminates because the other device then finds its own
        // bytes in it.
        if (sameBytes(text, theirs)) {
          context.state.setFile(localPath, {
            fileId: change.file_id,
            versionId: change.version_id,
            mtime: stat.mtime,
            size: stat.size,
            sha256: await sidDigest(change.sids),
            ts: change.ts,
          });
          await context.state.save();
          context.host.log(
            `pull decision=applied reason=incoming_holds_merge bytes=${theirManifest.size} file=${change.file_id} seq=${change.seq}`,
          );
          return "applied";
        }
        await postMerged(context, change, localPath, localVersionId, text, stat.mtime);
        context.host.notify(`obsync merged concurrent edits to ${localPath}.`);
        context.host.log(`pull decision=merged file=${change.file_id} seq=${change.seq}`);
        return "merged";
      }
      context.host.log(`pull decision=unmerged reason=${merged.reason} file=${change.file_id}`);
    }
  }

  // Not a fork yet: the push of the edit made here makes it one, and the
  // pair is settled then, from the version that edit was made on.
  if (ahead) return await deferToPush(context, change, localPath);
  return await converge(context, file, change, theirManifest, localPath, localVersionId, before, mine, tally);
}

/**
 * A FAST-FORWARD OVER AN UNPUSHED EDIT IS THE PUSH'S TO PUBLISH. 1.1.2 kept a
 * conflict copy of every version another device sent while someone typed here
 * (issue #135). Merging it in here instead would publish the edit twice -- the
 * push already queued, or already in flight, carries it onto the recorded
 * version -- and two lines holding one edit make every later merge an
 * overlap. So nothing is written: the record is marked so that push cannot
 * come back `unchanged`, and it forks the file, which its own reconciliation
 * then settles from this same base.
 */
async function deferToPush(context: SyncContext, change: ChangeRecord, localPath: string): Promise<ApplyResult> {
  const held = context.state.fileByPath(localPath);
  if (held) context.state.setFile(localPath, { ...held, sha256: "" });
  await context.state.save();
  return deferred(context, change, "unpushed_edit");
}

/**
 * A note left for this device's own push to settle: until that push has run,
 * the note here is not the note the other devices have, and the status says
 * so rather than `idle` (issue #135). Counted, not promised: the count is
 * dropped the moment nothing is left in flight for the note (`engine.ts`,
 * `resting`), so a push that never comes cannot hold the status forever.
 */
function deferred(context: SyncContext, change: ChangeRecord, reason: string): ApplyResult {
  context.forked.add(change.file_id);
  context.host.log(`pull decision=deferred reason=${reason} file=${change.file_id} seq=${change.seq}`);
  return "skipped";
}

/**
 * TWO HEADS THAT DO NOT MERGE, SETTLED BY RULE (issue #135).
 *
 * Keeping both sides on each device and closing nothing left two devices
 * holding different notes under one name for good: every later save forked
 * the file again and made another copy on both. So the pair is settled the
 * way the same-name rule settles two files (#113), by a rule every device
 * computes from the same two ids without asking another:
 *
 *  - THE LOWER VERSION ID KEEPS THE NOTE. Every device ends holding its bytes
 *    under the note's name.
 *  - THE OTHER HEAD GOES TO ONE COPY, the same on every device: a file id
 *    derived from the fork (`conflictFileId`) and a name computed from what
 *    the server says about that version -- its author and its time, in UTC --
 *    so every device that settles the pair posts the same first version and
 *    the server keeps one (`docs/protocol.md`, "One position, one version").
 *    Every device that settles it makes sure of it, because a device on an
 *    older version keeps both its own way and then takes the kept note over
 *    its own: the copy is where that text stays visible.
 *  - THE FORK IS CLOSED by one version naming both heads, holding exactly the
 *    kept head's content, offered the same way, so the next save anywhere is
 *    an ordinary update.
 *
 * The device whose own head lost may hold text typed on top of it that no
 * version has. That text goes into the copy as its next version, and the note
 * is replaced only if it is exactly as it was read: a save landing meanwhile
 * is never written over, and is published as an edit that forks the file
 * again. What the person typing there sees is their note becoming the kept
 * version with any keystrokes not yet saved carried onto it by the editor;
 * what they had saved is in the copy.
 *
 * NARROW ON PURPOSE. Only while both are still heads, and only when both name
 * this note's path: a head that has moved on is settled against the version
 * that replaced it, which the feed brings next, and a rename against an edit,
 * or a copy name something else already holds, is kept as both, as before.
 */
async function converge(
  context: SyncContext,
  file: FileRecord,
  change: ChangeRecord,
  theirManifest: Manifest,
  localPath: string,
  localVersionId: string,
  before: VaultStat | null,
  mine: Bytes,
  tally: { left: string },
): Promise<ApplyResult> {
  // A head that a later version has replaced is settled against that version,
  // which the feed brings next. One the graph does not hold at all is not a
  // pair this rule can see, and is kept as both, as before.
  const replaced = (id: string): boolean =>
    !file.heads.includes(id) && file.heads.some((head) => reaches(file.versions, head, id));
  if (replaced(localVersionId) || replaced(change.version_id)) {
    context.host.log(`pull decision=skipped reason=superseded_head file=${change.file_id} seq=${change.seq}`);
    return "skipped";
  }
  const keeping = localVersionId < change.version_id;
  const ours = await manifestOf(context, file, change, localVersionId);
  const lost = file.versions.find((version) => version.version_id === (keeping ? change.version_id : localVersionId));
  if (
    !file.heads.includes(localVersionId) || !file.heads.includes(change.version_id) ||
    ours === null || lost === undefined || theirManifest.path !== localPath || before === null
  ) {
    return await keepBoth(context, change, theirManifest);
  }
  const parents = [localVersionId, change.version_id].sort();
  let copy: string | null;
  if (keeping) {
    copy = await keepLost(context, change, lost, theirManifest, null);
    if (copy === null) return await keepBoth(context, change, theirManifest);
  } else {
    const held = context.state.fileByPath(localPath);
    const edited = held === undefined || held.mtime !== before.mtime || held.size !== before.size;
    const writer = await context.host.writer(localPath);
    try {
      await writeVerified(context, theirManifest, writer);
      // THE CLAIM. The feed and a push's own reconciliation settle one fork
      // side by side, and only one of them may replace the note: the one that
      // finds the note as it was read and the record still naming the losing
      // head takes it, in the same turn, before anything is written.
      const claimed = (await unmoved(context, localPath, before)) ? context.state.fileByPath(localPath) : undefined;
      if (claimed?.versionId !== localVersionId) {
        await writer.abort();
        return deferred(context, change, "saved_during_merge");
      }
      context.state.setFile(localPath, { ...claimed, versionId: change.version_id });
      const release = async (): Promise<void> => {
        await writer.abort();
        context.state.setFile(localPath, claimed);
      };
      copy = await keepLost(context, change, lost, ours, { text: mine, edited }).catch(async (error: unknown) => {
        await release();
        throw error;
      });
      if (copy === null) {
        // The copy already here, holding the losing text but not what was
        // typed on it since: that text goes out as an edit of its own.
        await release();
        return edited ? await deferToPush(context, change, localPath) : await keepBoth(context, change, theirManifest);
      }
      if (!(await unmoved(context, localPath, before))) {
        // Saved while the copy was written: the note keeps its new text, and
        // the copy holds what it had a moment ago.
        await release();
        return deferred(context, change, "saved_during_copy");
      }
      const landed = await landedAt(context, await writer.commit(theirManifest.mtime));
      tally.left = stamp(landed);
      await recordAt(context, change, localPath, landed);
    } catch (error) {
      await writer.abort();
      throw error;
    }
  }
  const closed = await closeFork(context, change.file_id, parents, keeping ? ours : theirManifest);
  const held = context.state.fileByPath(localPath);
  if (held?.versionId === (keeping ? localVersionId : change.version_id)) {
    context.state.setFile(localPath, { ...held, versionId: closed });
    await context.state.save();
  }
  context.host.notify(
    `obsync kept both versions of ${localPath}: every device keeps the same one as the note, ` +
      `and the other is in "${copy}".`,
  );
  context.host.log(
    `pull decision=converged reason=unmerged role=${keeping ? "keep" : "yield"} closed=${closed} ` +
      `file=${change.file_id} seq=${change.seq}`,
  );
  return keeping ? "skipped" : "applied";
}

/**
 * The losing head, kept in the copy every device agrees on (`converge`), or
 * `null` when its name is held here by something else.
 *
 * Posted before it is written, and offered as the version the server may
 * already hold, so a device that loses its state between the two finds it
 * again on the feed rather than making a second. `own` is this device's own
 * note when its head is the one that lost: its bytes are written instead of
 * downloading the same ones, and whatever it holds beyond the losing head is
 * left for the push to publish as the copy's next version.
 */
async function keepLost(
  context: SyncContext,
  change: ChangeRecord,
  lost: FileRecord["versions"][number],
  manifest: Manifest,
  own: { text: Bytes; edited: boolean } | null,
): Promise<string | null> {
  const fileId = await conflictFileId(context.manifestKey, change.file_id, lost.version_id);
  const recorded = context.state.pathByFileId(fileId);
  if (recorded !== undefined) return own?.edited ? null : recorded;
  if (!context.deviceNames.has(lost.device_id)) {
    // A name read at start or on the hour: a device paired since is not in it,
    // and every device must name its copy alike.
    try {
      for (const device of (await context.transport.devices()).devices) context.deviceNames.set(device.device_id, device.name);
    } catch {
      context.host.log(`pull decision=device_names_unread file=${change.file_id}`);
    }
  }
  const when = new Date(lost.ts);
  const path = conflictCopyPath(
    manifest.path, context.deviceNameFor(lost.device_id), when, 1,
    `${conflictStamp(when, true)}, ${lost.version_id.slice(0, 6)}`,
  );
  assertVaultPath(path);
  const copy: Manifest = { ...manifest, path };
  const sids = manifest.chunks.map((chunk) => chunk.sid);
  let occupant = await context.host.stat(path);
  if (occupant !== null && (own?.edited || (await alreadyCopied(context, copy, path, occupant)) === null)) return null;
  const posted = await postManifest(context, fileId, [], sids, copy, copy.size, true);
  let landed = occupant ?? (await createOnly(context, copy, own?.text));
  if (landed === null) {
    occupant = await context.host.stat(path);
    landed = occupant === null || own?.edited ? null : await alreadyCopied(context, copy, path, occupant);
    if (landed === null) return null;
  }
  context.authored.add(posted.versionId);
  const edited = own?.edited === true;
  context.state.setFile(path, {
    fileId,
    versionId: posted.versionId,
    mtime: edited ? -1 : landed.mtime,
    size: landed.size,
    sha256: edited ? "" : await sidDigest(sids),
  });
  await context.state.save();
  return path;
}

/**
 * Close a fork: one version whose parents are both heads and whose content is
 * exactly the kept one's. Offered as the version the server may already hold,
 * so every device that closes the same pair lands on the same id.
 */
async function closeFork(context: SyncContext, fileId: string, parents: string[], kept: Manifest): Promise<string> {
  const sids = kept.chunks.map((chunk) => chunk.sid);
  const posted = await postManifest(context, fileId, parents, sids, kept, kept.size, true);
  context.authored.add(posted.versionId);
  return posted.versionId;
}

/**
 * One version of this file, decrypted, or `null` for one its record no longer
 * holds (retention keeps the heads and the newest versions, not every one).
 */
async function manifestOf(context: SyncContext, file: FileRecord, change: ChangeRecord, id: string): Promise<Manifest | null> {
  const record = file.versions.find((version) => version.version_id === id);
  if (record === undefined) return null;
  return await decryptRecordManifest(context, { ...record, file_id: change.file_id, domain_id: file.domain_id });
}

/**
 * THE BASE OF A CRISS-CROSS, or `null`.
 *
 * Two devices that resolve the SAME fork while each holds a keystroke the
 * other has not seen post two DIFFERENT merges of one pair, and from then on
 * the two lines share two newest ancestors, neither reaching the other. Either
 * one alone as the base reads the other's half of the first merge as an edit
 * of its own, so every later version was an overlap and a conflict copy, and
 * the fork never closed (issue #135). The base is then those two merged over
 * their own ancestor -- what both devices would have posted had neither been
 * typing. When the two merges were themselves merged differently, that pair
 * is a criss-cross too, and its base is found the same way one level down, at
 * most `CRISS_CROSS_LEVELS` of them. Single-chunk text only, and a pair that
 * does not merge cleanly is no base at all.
 */
async function crissCrossBase(
  context: SyncContext,
  file: FileRecord,
  change: ChangeRecord,
  [left, right]: [string, string],
  first: string,
  firstText: string,
  levels = CRISS_CROSS_LEVELS,
): Promise<string | null> {
  const parents = parentsFrom(file.versions);
  const below = reachable(parents, first);
  const fromLeft = reachable(parents, left);
  const fromRight = reachable(parents, right);
  const other = file.versions.find(
    ({ version_id: id }) => id !== left && id !== right && !below.has(id) && fromLeft.has(id) && fromRight.has(id),
  )?.version_id;
  if (other === undefined) return null;
  const root = commonAncestor(file.versions, first, other, parents);
  const texts: string[] = [];
  for (const id of [root, other]) {
    const manifest = id === null ? null : await manifestOf(context, file, change, id);
    if (manifest === null || manifest.chunks.length !== 1) return null;
    texts.push(new TextDecoder().decode(await assembleBytes(context, manifest)));
  }
  const [rootText, otherText] = texts as [string, string];
  let merged = threeWayMerge(rootText, firstText, otherText);
  if (!merged.ok && levels > 1) {
    const deeper = await crissCrossBase(context, file, change, [first, other], root as string, rootText, levels - 1);
    if (deeper !== null) merged = threeWayMerge(deeper, firstText, otherText);
  }
  context.host.log(
    `pull decision=merge_base reason=criss_cross level=${CRISS_CROSS_LEVELS - levels + 1} ok=${merged.ok} ` +
      `file=${change.file_id} seq=${change.seq}`,
  );
  return merged.ok ? merged.text : null;
}

/**
 * How deep a criss-cross is followed. Each level is one more fork both devices
 * resolved at once, each holding a keystroke; the chunks it downloads and holds
 * are bounded by it, because the version graph is another device's to shape.
 */
const CRISS_CROSS_LEVELS = 3;

/**
 * The merge breaker. One fork of one note costs at most one merge per device,
 * so a file that needs more than this in a row inside a minute, with its note
 * unchanged here in between, is not being edited, it is looping, and a device
 * that keeps merging a loop is what fills a journal (issue #110). Both are
 * constants, not configuration: a device must not be able to be told to keep
 * going.
 */
const MERGE_STORM_LIMIT = 5;
const MERGE_STORM_MS = 60_000;

/** Byte equality over plaintext this device already holds; nothing secret. */
function sameBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * How many names a conflict copy may try before giving up. The stamp is
 * minute-resolution, so collisions come in bursts of one minute; twenty is far
 * past any real vault and it is BOUNDED, because the alternative to giving up
 * must never be overwriting something.
 */
const CONFLICT_COPY_NAMES = 20;

/**
 * Is the file at `path` already EXACTLY this version's content?
 *
 * One foreign head is resolved twice by design -- the feed delivers a head the
 * push's own reconciliation has already handled -- so the second pass must not
 * grow an identical second copy. But "already here" has to be PROVED. Size and
 * modification time are what a vault reports ABOUT a file, not what is in it:
 * an unrelated note that happened to share them, or a second version of the
 * same note with the same length and timestamp, made this device announce a
 * copy it never wrote, skip the version entirely, and never fetch or
 * authenticate a single chunk of it (issue #109).
 *
 * The manifest is authenticated -- AES-GCM under the manifest key, bound field
 * by field to its record -- so its `sha256` is a trustworthy statement of the
 * plaintext. A local file that hashes to it IS this version's content, byte
 * for byte, and nothing weaker is accepted here. A multi-chunk version carries
 * no whole-file digest (`push.ts`, MANIFEST `sha256`) and is never recognised
 * this way: it takes the next name instead, which costs a duplicate copy and
 * never a missing one. Reading is bounded by the same single-chunk rule the
 * merge inputs obey, and a file that cannot be read proves nothing.
 *
 * IT RETURNS THE METADATA THE PROOF IS ABOUT. The answer is used to RECORD
 * the file as this version, and a record is a statement that the file is that
 * version and that nothing has happened to it since -- the sentence the pull
 * path reads before it writes over a file. A save that lands between the stat
 * and the read replaces the bytes the digest proved, so the file is stat-ed
 * again afterwards and a stat that moved proves nothing at all (review round
 * 2, finding 2). What comes back is the metadata of the bytes that were
 * actually verified, and nothing else may be recorded against this version.
 */
async function alreadyCopied(
  context: SyncContext,
  manifest: Manifest,
  path: string,
  occupant: VaultStat,
): Promise<VaultStat | null> {
  if (manifest.chunks.length !== 1 || manifest.sha256 === "") return null;
  if (occupant.size !== manifest.size) return null;
  let bytes: Bytes;
  try {
    bytes = await context.host.read(path);
  } catch {
    return null;
  }
  if (hex(await sha256(bytes)) !== manifest.sha256) return null;
  const after = await context.host.stat(path);
  if (after === null || after.mtime !== occupant.mtime || after.size !== occupant.size) return null;
  return after;
}

/**
 * Write the foreign version at a name nothing occupies.
 *
 * NOT A PLAIN `materialise`. The copy's name is derived, minute-resolution and
 * therefore repeatable, so the destination is a place the user may already
 * have something — the copy an earlier version of this same file left, which
 * they may have opened and edited, with those edits not yet pushed. Writing
 * through the ordinary overwriting writer destroyed exactly the bytes this
 * whole change exists to protect (issue #98, review round 1).
 *
 * THE GUARD IS THE COMMIT, NOT THE LOOK. `createWriter` is the host's
 * create-only writer: on desktop it opens a temp file exclusively and
 * publishes with `link`, which cannot replace a destination even one that
 * appears mid-write; on mobile it calls `Vault.createBinary`, which rejects an
 * existing path. A stat first is only a cheap way to skip a name already taken
 * without paying for its download — it decides nothing, and a name that
 * appears between the stat and the commit is refused by the commit, which is
 * the race a check alone leaves open. A refusal earns the NEXT name, and only
 * a failure with nothing at the name is a real error and rethrown, so a
 * network fault cannot be retried into twenty downloads.
 *
 * THE WRITER OWNS A TEMPORARY FILE, ON BOTH OUTCOMES. The desktop writer
 * publishes with `link`, which leaves its own `.obsync-*.tmp` name pointing at
 * the SAME inode as the published copy, and hands the removal of that name to
 * `abort` (`main.ts`). A caller that aborted only on failure therefore left a
 * second, hidden name for the note's plaintext behind every successful copy,
 * and the blocks with it (issue #109). `abort` runs on both outcomes, exactly
 * as the history copy does; it cannot unpublish anything, because the host
 * unlinks the temp only while it is still the file it opened; and a cleanup
 * that fails is logged rather than turned into a failure of a copy the user
 * already has.
 */
/**
 * Write beside whatever is at `path`, under the first derived name nothing
 * holds, without ever replacing anything.
 *
 * TWO CALLERS, AND THE DIFFERENCE BETWEEN THEM IS THE TIE-BREAK. The pull side
 * writes another device's version as a copy and suppresses the vault event
 * that causes, because that copy is not this device's to publish. The
 * tie-break side writes this device's OWN file aside and deliberately does not
 * suppress it, because that move is exactly what this device publishes. What
 * they share -- the create-only publication, the next name on a collision, the
 * cleanup on both outcomes, and the rule that only a failure with nothing at
 * the name is a real error -- lives here once. It took two review rounds to
 * get right and must not exist twice.
 */
async function writeBeside(
  context: SyncContext,
  path: string,
  deviceName: string,
  when: Date,
  size: number,
  mtime: number,
  fill: (writer: VaultWriter, target: string) => Promise<void>,
  reuse: (target: string, occupant: VaultStat) => Promise<VaultStat | null>,
): Promise<{ path: string; attempt: number; stat: VaultStat; written: boolean } | null> {
  for (let attempt = 1; attempt <= CONFLICT_COPY_NAMES; attempt++) {
    const target = conflictCopyPath(path, deviceName, when, attempt);
    assertVaultPath(target);
    const occupant = await context.host.stat(target);
    if (occupant !== null) {
      // A name already holding this version is answered with the metadata of
      // the bytes that PROVED it, not with a fresh look at the file: what the
      // caller records has to be true of what was verified (finding 2).
      const reused = await reuse(target, occupant);
      if (reused !== null) return { path: target, attempt, stat: reused, written: false };
      continue;
    }
    let writer: VaultWriter;
    try {
      writer = await context.host.createWriter(target, size, () => undefined);
    } catch (error) {
      if ((await context.host.stat(target)) === null) throw error;
      continue;
    }
    let outcome: { stat: VaultStat } | { failure: unknown };
    try {
      await fill(writer, target);
      outcome = { stat: await writer.commit(mtime) };
    } catch (error) {
      outcome = { failure: error };
    }
    try {
      await writer.abort();
    } catch {
      // Never the error the caller hears. A published copy is not withdrawn
      // because its temporary name could not be removed -- the user has the
      // file -- and on the failing path the cause of the failure outranks the
      // cleanup. The residue is named here so it is not silent (requirement 12);
      // the reason is not, because a host error names a filesystem path.
      context.host.log(
        `pull decision=copy_temp_not_removed published=${"stat" in outcome} name_attempt=${attempt}`,
      );
    }
    if ("stat" in outcome) return { path: outcome.stat.path, attempt, stat: outcome.stat, written: true };
    if ((await context.host.stat(target)) === null) throw outcome.failure;
  }
  return null;
}

/**
 * The foreign version, written as a copy beside the local file. The write is
 * echo-suppressed: this device did not author that content and must not
 * publish it back as a file of its own.
 */
async function writeCopy(
  context: SyncContext,
  manifest: Manifest,
  deviceName: string,
  when: Date,
): Promise<{ path: string; attempt: number; stat: VaultStat } | null> {
  const beside = await writeBeside(
    context, manifest.path, deviceName, when, manifest.size, manifest.mtime,
    (writer, target) => writeVerified(context, { ...manifest, path: target }, writer),
    (target, occupant) => alreadyCopied(context, manifest, target, occupant),
  );
  if (beside === null) return null;
  if (!beside.written) {
    context.host.log(
      `pull decision=conflict_copy_present bytes=${manifest.size} name_attempt=${beside.attempt}`,
    );
    return { path: beside.path, attempt: beside.attempt, stat: beside.stat };
  }
  // The same rule as any other write of this device's: the copy is recorded
  // under the name the vault shows for it, not the one it was asked for.
  const stat = await landedAt(context, beside.stat);
  return { path: stat.path, attempt: beside.attempt, stat };
}

/**
 * A local file's bytes into a writer, one bounded window at a time.
 *
 * NEVER `host.read`, which allocates the file's whole size on desktop and is
 * why a note larger than this device's memory could not be moved at all
 * (review round 2, finding 4). `CHUNK_MAX` is the push path's own window, so
 * the two paths cost the same and neither is bounded by the file.
 *
 * The walk advances by the window it ASKED for, not by the bytes it got, so
 * it terminates whatever the vault hands back. A file that ends early while it
 * is being rewritten therefore delivers fewer bytes than its declared size,
 * and the create-only writer's byte budget refuses that copy rather than
 * publishing a torn one; `moveAside` turns that refusal into its own.
 */
async function copyThrough(
  context: SyncContext,
  from: string,
  size: number,
  writer: VaultWriter,
): Promise<void> {
  const source = context.host.source(from, size);
  for (let at = 0; at < size; at += CHUNK_MAX) {
    await writer.write(await source.read(at, Math.min(CHUNK_MAX, size - at)));
  }
}

/**
 * This device's OWN file, moved to the conflict name because it lost the
 * same-name tie-break, and left DIRTY so the next push publishes the move as a
 * version of this device's file id. That published rename is the one thing
 * either device says about the collision.
 *
 * THE MOVE IS A COPY AND THEN A TRASH, AND THE USER CAN TYPE BETWEEN THEM.
 * The vault offers no atomic rename this device could use for a destination
 * that must not be replaced, so the copy publishes first and the original is
 * removed second -- and Obsidian saves an open note on a timer, so bytes that
 * exist on this device and NOWHERE else can arrive in that gap. The trash
 * would take them: not a conflict copy, not a version on the server, gone
 * (review round 2, finding 1). So the source is stat-ed before the copy and
 * again immediately before the trash, and a source that moved refuses the
 * move: the note keeps its name and its new text, nothing is removed, and the
 * caller falls back to keeping both, which is what 1.0.6 did for this pair
 * anyway. The comparison is `(mtime, size)`, the same metadata test the whole
 * pull path uses for "has this file moved on"; an edit that changes neither
 * is invisible to it here exactly as it is there.
 *
 * AND THE LAST STAT IS NOT THE LAST MOMENT. The trash is asynchronous and
 * does work of its own before the file goes, so a save can land after the
 * check above and still be inside the removal -- which is the same loss one
 * instruction later, and no check made HERE can close it (round 3, finding
 * 1). So the content being removed is named to the host, the removal is
 * bound to it, and a host that reports `kept` has put the file back with the
 * later bytes in it: the note keeps its name and its new text, the copy this
 * function already published keeps the text it had a moment ago, and the
 * caller falls back to keeping both.
 *
 * AND A HOST THAT CANNOT MAKE THAT PROMISE IS NEVER ASKED TO. Mobile has no
 * second name to give a file, and a desktop filesystem can refuse one, so on
 * those devices the pair is settled the way 1.0.6 settled it -- both notes
 * kept, this device's under the name it already has -- and nothing is
 * removed at all. That is asked BEFORE the copy, not after it, so a device
 * that will refuse does not first fill the vault with a copy it cannot use.
 * The cost is a name: two devices can hold that pair under different names
 * until the one that CAN move publishes the rename (issue #122's divergence,
 * one case wider). The alternative is a window in which a note the user is
 * typing into is removed, and there is no version of it anywhere.
 *
 * AND THE LOCAL NOTE CAN BE ANY SIZE. The incoming version says nothing about
 * it: a 21-byte note from another device collides with whatever wears that
 * name here, and the desktop host reads a whole file by allocating its whole
 * size (`main.ts`). So the copy streams through the host's windowed source in
 * the same 8 MiB windows the push path uses, and a multi-GiB note costs what a
 * note costs (review round 2, finding 4).
 *
 * WHICH IS NO ANSWER AT ALL ON A HOST THAT CANNOT STREAM. Mobile's writer
 * allocates the declared size in one `Uint8Array` and its source reads the
 * whole file, so a windowed loop above them still asks for the whole note at
 * once: a 21-byte incoming version, colliding with a 3 GiB local note, asks
 * a 512 MiB device for a 3 GiB buffer (round 3, finding 3). Admission has
 * already weighed the INCOMING size against this device's ceiling and says
 * nothing about the local file, so the local file is weighed here, before
 * anything is allocated or read, on exactly the hosts that cannot stream.
 * Above the ceiling the move is refused and the note is left where it is:
 * the pair is kept as 1.0.6 kept it, which costs a name and loses nothing.
 */
async function moveAside(
  context: SyncContext,
  from: string,
  record: FileState,
  when: Date,
): Promise<string | null> {
  // Asked first, because the answer decides whether this move can happen at
  // all: a device that cannot bind a removal to what it removes settles the
  // pair by keeping both, and nothing here is written, copied or removed.
  if (context.host.bindsRemoval !== true) {
    context.host.log(
      `pull path_class=file decision=move_aside_refused reason=unheld file=${record.fileId}`,
    );
    return null;
  }
  const before = await context.host.stat(from);
  if (before === null) return null;
  // Before the copy asks for anything: on a host whose writer and source hold
  // a whole file, the local note must fit this device's own ceiling, because
  // the copy costs its size in memory however the loop above is written
  // (round 3, finding 3).
  if (context.host.supportsRangeReads !== true) {
    const room = admit(context.state.data.policy, context.state.localBytes(), before.size);
    if (!room.ok) {
      context.host.log(
        `pull path_class=file bytes=${before.size} decision=move_aside_refused ` +
          `reason=${room.reason} file=${record.fileId}`,
      );
      context.host.notify(
        `obsync left ${from} where it is: copying it to a name of its own would need more memory ` +
          `than this device allows (${admissionReason(context.state.data.policy, room.reason)}). ` +
          `Your note is untouched, and the other device's version is beside it.`,
      );
      return null;
    }
  }
  const changed = async (): Promise<boolean> => {
    const now = await context.host.stat(from);
    return now === null || now.mtime !== before.mtime || now.size !== before.size;
  };
  const refuse = (copy: string | null, reason = "source_changed"): null => {
    context.host.log(
      `pull path_class=file decision=move_aside_refused reason=${reason} file=${record.fileId}`,
    );
    if (copy === null) return null;
    context.host.notify(
      reason === "unheld"
        ? `obsync left ${from} where it is: this device cannot move a note aside without risking text ` +
            `typed while it does, so it keeps both notes instead. Your note is untouched, and the text ` +
            `it had a moment ago is in "${copy}".`
        : `obsync left ${from} where it is: it changed while obsync was moving it. Your note and its ` +
            `new text are untouched, and the text it had a moment ago is in "${copy}".`,
    );
    return null;
  };
  let landed: Awaited<ReturnType<typeof writeBeside>>;
  try {
    landed = await writeBeside(
      context, from, context.deviceNameFor(context.deviceId), when, before.size, record.mtime,
      async (writer) => { await copyThrough(context, from, before.size, writer); },
      // Never reused: this is a MOVE of a file that must really arrive.
      async () => null,
    );
  } catch (error) {
    // A copy that failed BECAUSE the note was being written while it was
    // copied is the same refusal, not an error: the create-only writer's byte
    // budget is what catches a note that grew or shrank mid-copy, and it
    // refuses rather than publishing a torn one. Anything else is a real
    // failure and is raised.
    if (await changed()) return refuse(null);
    throw error;
  }
  if (landed === null) return null;
  if (await changed()) return refuse(landed.stat.path);
  // Marked BEFORE the trash: the vault reports the removal to this plugin's
  // own delete handler while the trash is still running, and an unmarked echo
  // publishes a tombstone for a file that is alive one name over (issue #96).
  context.trashed.add(from);
  // The removal names the bytes it is removing. `kept` means the host found
  // other ones there -- a save inside the removal, or a file that replaced
  // the one we held -- and left or put back what it found rather than take
  // it; `unheld` means it removed nothing because it could not promise that.
  // Either way this move did not happen and the pair is kept as 1.0.6 kept
  // it. Only `unheld` withdraws the echo marker: nothing was removed, so no
  // delete event is owed, while a restore really did produce one.
  const verdict = await context.host.trash(from, before);
  if (verdict === "unheld") {
    context.trashed.delete(from);
    return refuse(landed.stat.path, "unheld");
  }
  if (verdict === "kept") return refuse(landed.stat.path, "source_changed_in_trash");
  // `mtime: -1` and no digest, exactly as a user's own rename records it
  // (`engine.ts`): the bytes did not move, the PATH did, and the path lives
  // inside the manifest, so the push must post even though the content is
  // unchanged. The write above is deliberately not echo-suppressed for the
  // same reason -- that event is what carries this move to the push queue.
  context.state.setFile(landed.stat.path, { ...record, mtime: -1, sha256: "" });
  context.state.forgetPath(from);
  await context.state.save();
  return landed.stat.path;
}

/**
 * Two file ids, one path (issue #113).
 *
 * Two devices that each create a note at the same path while one of them is
 * closed produce two FILES with one name. 1.0.5 and 1.0.6 kept both, which is
 * right, and neither ever gave the pair distinct names, so every later edit of
 * either note arrived at an occupied path and made another copy: three copies
 * of one note inside a few minutes, on real devices, symmetrically.
 *
 * The names have to be settled, and settled the SAME WAY on every device
 * without the two of them negotiating about it. So the ids decide, because
 * both devices hold both: THE LOWER FILE ID KEEPS THE PATH.
 *
 * A device holding the lower id writes the incoming version as a copy and
 * RECORDS it under the incoming id, so the next version of that id is an
 * ordinary update of a file it tracks rather than another collision, and it
 * publishes nothing, because that file is not its own. A device holding the
 * higher id moves its own file to the conflict name, lets the ordinary push
 * publish that move as a version of its own id, and then applies the incoming
 * version at the path it has just vacated. Exactly one rename is ever
 * published, by the device whose file actually moved.
 *
 * A file at the name that no record explains has no id to compare, so it is
 * PUBLISHED first and then the same rule decides -- see `identify`. It was
 * going to be published seconds later anyway, and without it the two devices
 * settle on different names and stay there.
 *
 * Returns `null` when the path has been vacated and the caller should apply
 * the incoming version there as it would any other.
 */
async function sameNameTiebreak(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  occupant: "other_file" | "no_record",
): Promise<ApplyResult | null> {
  // A name of its own here already: the incoming id's versions land where
  // this device has it, never as another copy -- a copy per edit is the
  // defect itself (issue #113) -- and wait there for their name to free
  // (`renameOnto`).
  const settled = context.state.pathByFileId(change.file_id);
  if (settled !== undefined) return await renameOnto(context, change, manifest, occupant, settled);
  if (occupant === "no_record") {
    const stat = await context.host.stat(manifest.path);
    // Gone between the check and here: the name is free, so there is nothing
    // to settle and the caller applies the version as it would any other.
    if (stat === null) return null;
    if (await adopt(context, change, manifest, stat)) return "applied";
    if (!(await identify(context, manifest.path, change.file_id))) {
      return await keepBothRecorded(context, change, manifest);
    }
  }
  const when = new Date(context.now());
  const ours = context.state.fileByPath(manifest.path);
  if (ours === undefined) return await keepBoth(context, change, manifest);
  const same = await identicalAtName(context, change, manifest.path, ours);
  if (same !== null) return await convergeIdentical(context, change, manifest, ours, same);
  const healed = await takeEditedTwin(context, change, manifest, ours);
  if (healed !== null) return healed;

  if (ours.fileId < change.file_id) {
    const kept = await keepBothRecorded(context, change, manifest);
    if (kept === "conflict_copy") {
      context.host.log(
        `pull decision=same_name_tiebreak winner=${ours.fileId} role=keep file=${change.file_id} seq=${change.seq}`,
      );
    }
    return kept;
  }

  const moved = await moveAside(context, manifest.path, ours, when);
  if (moved !== null) return await takeVacated(context, change, manifest, ours, moved);
  // A move that did not happen still has to SETTLE the incoming id: recorded
  // under it, the copy is where that file's next version lands, and the pair
  // costs one copy once. Unrecorded, every later edit of it would arrive at
  // an occupied name with no id to compare and make another copy, which is
  // the defect issue #113 exists to end -- and a device that cannot bind a
  // removal (mobile) takes this path for EVERY collision it meets.
  return await keepBothRecorded(context, change, manifest);
}

/**
 * Is the note at the name already the incoming version, byte for byte
 * (issue #131)?
 *
 * Two devices that each start with the same notes -- a vault copied by hand,
 * or one moved over from another sync tool -- publish every note under their
 * own file id before either pulls the other's, so every note meets its twin at
 * its own name. The rule above then keeps one and copies the other beside it:
 * a conflict copy of identical bytes, once per note in the vault.
 *
 * THE PROOF COSTS NO READ. A chunk's id is derived from its plaintext under
 * the domain key (`encryptChunk`), so two versions of the same bytes in one
 * domain name the same chunk ids, and a record keeps the digest of the ids its
 * version names. Equal digests are equal bytes, at any size and with nothing
 * downloaded, and the server learns nothing it does not already hold: it
 * stores both chunk lists.
 *
 * ONLY A CLEAN NOTE. The digest describes the version this device recorded
 * and nothing written since, so a note whose size or mtime has moved -- an
 * edit not yet pushed -- takes the ordinary rule, and so does a record that
 * names no version, which has no parent a retirement could name. The stat
 * returned is the one that was checked, which is what `recordAt` must be handed.
 */
async function identicalAtName(
  context: SyncContext,
  change: Pick<ChangeRecord, "sids">,
  path: string,
  ours: FileState,
): Promise<VaultStat | null> {
  if (ours.versionId === "") return null;
  if (ours.sha256 !== (await sidDigest(change.sids))) return null;
  const stat = await context.host.stat(path);
  if (stat === null || stat.mtime !== ours.mtime || stat.size !== ours.size) return null;
  return stat;
}

/**
 * Two file ids, one name, one content: the same rule, and no copy.
 *
 * The lower id keeps the name, exactly as it does for two different notes, so
 * both devices reach one answer without negotiating. The device holding it
 * writes and records nothing; the other id is its own device's to retire --
 * and a device older than this rule never does, which `takeEditedTwin`
 * settles at that device's first edit (issue #147). The
 * device holding the higher id records the name under the lower one -- its
 * bytes ARE that version -- and publishes one tombstone for its own id, so no
 * device, including one paired later, is handed the duplicate again. The
 * tombstone's parent is the version this device recorded: if that id has
 * moved on elsewhere, it forks instead of deleting, and every device holding
 * the later edit keeps it (delete-versus-edit, issue #98).
 *
 * The note on disk is never written, moved or trashed on either side. A
 * tombstone that cannot be posted costs a duplicate id on the server, never a
 * note: the keeper records nothing for it, and a device that meets it later
 * settles it by this same rule.
 */
async function convergeIdentical(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  ours: FileState,
  stat: VaultStat,
): Promise<ApplyResult> {
  if (ours.fileId < change.file_id) {
    context.host.log(
      `pull decision=converged reason=identical_same_name role=keep keeper=${ours.fileId} file=${change.file_id} seq=${change.seq}`,
    );
    return "skipped";
  }
  // A feed frame can predate a deletion or a later edit. Only a current,
  // sole live head may replace this device's independent live identity.
  const current = await context.transport.getFile(change.file_id);
  if (current.heads.length !== 1 || current.heads[0] !== change.version_id) {
    context.host.log(`pull decision=skipped reason=historical_twin file=${change.file_id} seq=${change.seq}`);
    return "skipped";
  }
  if (context.state.fileByPath(manifest.path) !== ours ||
      await identicalAtName(context, change, manifest.path, ours) === null) {
    context.host.log(`pull decision=skipped reason=twin_changed_during_lookup file=${change.file_id} seq=${change.seq}`);
    return "skipped";
  }
  await recordAt(context, change, manifest.path, stat);
  const retired = await retire(context, ours.fileId, ours.versionId, manifest.path, change.file_id);
  context.host.log(
    `pull decision=converged reason=identical_same_name role=yield keeper=${change.file_id} retired=${ours.fileId} tombstone=${retired} seq=${change.seq}`,
  );
  return "applied";
}

/**
 * A retirement, met by a device that still records the retired id at the name
 * (issue #181): when the keeper's live head holds exactly the bytes recorded
 * here, and the file is still those bytes, the name is recorded under the
 * keeper, the retired id is forgotten, and nothing on disk is touched -- the
 * answer `convergeIdentical` gives, reached from the other end.
 *
 * S98: a device whose records had been rolled back applied a retirement as a
 * deletion and removed a 1 GiB file that the keeper held too, on every device.
 * The proof is `identicalAtName`'s. A keeper that has moved on (the edit
 * `takeEditedTwin` retires for), a file edited here, a keeper this device
 * tracks elsewhere or the server does not know: not this case, and the
 * deletion takes the ordinary path with every guard it already has.
 */
async function retiredInto(
  context: SyncContext,
  change: ChangeRecord,
  keeper: string,
  path: string,
  ours: FileState,
): Promise<boolean> {
  if (context.state.pathByFileId(keeper) !== undefined) return false;
  const started = context.now();
  const file = await context.transport.getFile(keeper).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "unknown_file") return null;
    throw error;
  });
  for (const version of file?.versions.filter((candidate) => file.heads.includes(candidate.version_id)) ?? []) {
    const stat = await identicalAtName(context, version, path, ours);
    if (stat === null) continue;
    await recordAt(context, { ...version, file_id: keeper }, path, stat);
    context.host.log(
      `pull path_class=tombstone decision=kept reason=retired_identical keeper=${keeper} retired=${change.file_id} ` +
        `seq=${change.seq} duration_ms=${context.now() - started}`,
    );
    return true;
  }
  return false;
}

/**
 * An edit of THIS note, made under its twin's id (issue #147).
 *
 * A device older than the rule above (1.1.1) never retires its twin: it goes
 * on editing the note under its own id, and each edit arrived here at a name
 * this device holds under the other id -- a conflict copy every time, which
 * updating that device did not stop, because nothing re-meets a pair the feed
 * is past. The same holds the other way round once it runs this version.
 *
 * THE EDIT IS THE PROOF, not the app version a device reports, which is only
 * its own word. A version whose parent held exactly the bytes of the clean
 * note here, at this same name, was made by a device that holds that id and is
 * not retiring it. So this device takes the edit as the update it is, records
 * the name under that id and retires its own, on the version it recorded: an
 * id that moved on elsewhere forks rather than deletes. The bytes replaced are
 * the edit's own parent, so nothing is lost. Anything less than that proof --
 * other bytes, another name, a parent this vault cannot read, an unpushed edit
 * here -- is `null`, and the rule below decides as it always has.
 */
async function takeEditedTwin(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  ours: FileState,
): Promise<ApplyResult | null> {
  const started = context.now();
  const file = await context.transport.getFile(change.file_id);
  const parent = file.versions.find((version) => version.version_id === change.parents[0]);
  if (parent === undefined) return null;
  const was = await decryptRecordManifest(context, { ...parent, file_id: change.file_id, domain_id: file.domain_id })
    .catch(() => null);
  if (was?.path !== manifest.path || (await identicalAtName(context, parent, manifest.path, ours)) === null) return null;
  const landed = await materialise(context, manifest);
  await recordAt(context, change, landed.path, landed);
  const retired = await retire(context, ours.fileId, ours.versionId, manifest.path, change.file_id);
  context.host.log(
    `pull decision=converged reason=edited_twin keeper=${change.file_id} retired=${ours.fileId} tombstone=${retired} ` +
      `seq=${change.seq} duration_ms=${context.now() - started}`,
  );
  return "applied";
}

/**
 * The incoming version, into the name this device has just vacated -- and
 * only if it is still vacant.
 *
 * The move frees the name by RENAMING the old note away (`main.ts`), which is
 * atomic and leaves nothing behind. It does not stop the user's editor from
 * saving a moment later, and that save creates a file at a name this device
 * tracks NOTHING at: bytes no version holds, that this device has not copied
 * anywhere. Writing the incoming version over them would be the same loss the
 * move exists to avoid, one instruction further on, so the write is
 * create-only and an occupied name falls back to keeping both.
 */
async function takeVacated(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  ours: FileState,
  moved: string,
): Promise<ApplyResult> {
  const landed = await createOnly(context, manifest);
  if (landed === null) {
    context.host.log(
      `pull path_class=file decision=vacated_name_taken file=${change.file_id} seq=${change.seq}`,
    );
    return await keepBothRecorded(context, change, manifest);
  }
  await recordAt(context, change, landed.path, landed);
  context.host.log(
    `pull decision=same_name_tiebreak winner=${change.file_id} role=rename file=${ours.fileId} seq=${change.seq}`,
  );
  context.host.log(
    `pull path_class=file bytes=${manifest.size} decision=applied seq=${change.seq}`,
  );
  context.host.notify(
    `obsync found two different notes named ${manifest.path}. This device's is now "${moved}", ` +
      `and the other device's keeps the name.`,
  );
  return "applied";
}

/**
 * Write a manifest at its own name, WITHOUT replacing anything. `null` means
 * the name is occupied -- by a file this device did not put there -- and the
 * caller must not treat that as a failure; anything else is one.
 */
async function createOnly(context: SyncContext, manifest: Manifest, fill?: Bytes): Promise<VaultStat | null> {
  assertVaultPath(manifest.path);
  let writer: VaultWriter;
  try {
    writer = await context.host.createWriter(manifest.path, fill?.length ?? manifest.size, () => undefined);
  } catch (error) {
    if ((await context.host.stat(manifest.path)) === null) throw error;
    return null;
  }
  let stat: VaultStat;
  try {
    if (fill === undefined) await writeVerified(context, manifest, writer);
    else await writer.write(fill);
    stat = await writer.commit(manifest.mtime);
  } catch (error) {
    await writer.abort();
    if ((await context.host.stat(manifest.path)) === null) throw error;
    return null;
  }
  try {
    // The create-only writer publishes by linking its temp name over; the
    // temp is its to remove, and a published file is never withdrawn because
    // that failed. The residue is named rather than silent (requirement 12).
    await writer.abort();
  } catch {
    context.host.log("pull decision=copy_temp_not_removed published=true name_attempt=0");
  }
  // Bytes this device supplied are its own to publish, so their write is not
  // marked as an echo: the watcher's event is what queues their push.
  return fill === undefined ? await landedAt(context, stat) : stat;
}

/**
 * A file this device tracks, whose version names a path another file holds
 * here (issue #149): the next version of a copy the same-name rule settled,
 * or a RENAME onto a name this device still gives to something else.
 *
 * WHAT HOLDS THE NAME DECIDES WHETHER TO WAIT. A note this device received is
 * a note the renaming device knew, so it is leaving the name -- a swap
 * reaches here as two versions, and the second is on its way -- and the
 * version lands beside its name until that happens (`settleBeside`). A note
 * this device made and published AFTER this version, which is what a version
 * this device authored and the feed has not handed back yet means, is one
 * the renaming device never saw: two notes that want one name, which the
 * same-name rule settles here exactly as the other device settles it --
 * the lower file id keeps the name. A note at the name with no record at all
 * is published first, as `identify` does for an untracked version, and then
 * it is exactly that.
 */
async function renameOnto(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  occupant: "other_file" | "no_record",
  settled: string,
): Promise<ApplyResult> {
  if (occupant === "no_record") await identify(context, manifest.path, change.file_id);
  const ours = context.state.fileByPath(manifest.path);
  if (ours !== undefined && context.authored.has(ours.versionId)) {
    const keep = ours.fileId < change.file_id;
    const moved = keep ? null : await moveAside(context, manifest.path, ours, new Date(context.now()));
    context.host.log(
      `pull decision=same_name_tiebreak winner=${keep ? ours.fileId : change.file_id} ` +
        `role=${keep ? "keep" : moved === null ? "kept_both" : "rename"} file=${keep ? change.file_id : ours.fileId} seq=${change.seq}`,
    );
    if (moved !== null) {
      context.host.notify(
        `obsync found two different notes named ${manifest.path}. This device's is now "${moved}", ` +
          `and the other device's keeps the name.`,
      );
    }
  }
  return await updateSettled(context, change, manifest, settled);
}

/**
 * A version of a file this device has already given a name of its own.
 *
 * It lands THERE, not at the name its manifest carries: that name belongs to
 * another note on this device, and materialising over it is the loss this
 * whole series is about -- while copying it beside again, once per edit, is
 * the defect issue #113 exists to end. The record remembers the name it
 * wants, and the note moves there once nothing holds it (`settleBeside`).
 *
 * The check below is the ONLY thing standing between that write and an
 * unpushed edit: the user can open a conflict copy and type into it, and
 * those bytes exist on this device and nowhere else (issue #98). It is made
 * here, against the file about to be written, rather than earlier against the
 * same path by a caller -- the guard belongs at the write.
 */
async function updateSettled(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  settled: string,
): Promise<ApplyResult> {
  if ((await competing(context, settled, change.file_id)) !== null) {
    return await keepBoth(context, change, manifest);
  }
  // A version that changes nothing but the name is not written again: the
  // file there already holds it, by the proof the rename shortcut makes
  // (issue #108), and a write the vault has not reported yet is a note that
  // cannot move (`settleBeside`).
  const local = context.state.fileByPath(settled) as FileState;
  const beside = local.sha256 === (await sidDigest(change.sids))
    ? (await context.host.stat(settled)) ?? { path: settled, mtime: local.mtime, size: local.size }
    : await materialise(context, { ...manifest, path: settled });
  await recordAt(context, change, beside.path, beside, manifest.path);
  context.host.log(
    `pull path_class=file bytes=${manifest.size} decision=applied_beside file=${change.file_id} seq=${change.seq}`,
  );
  return "applied";
}

/**
 * Move a tracked note to another name through the host's guarded rename,
 * which refuses an occupied destination rather than replacing it (`main.ts`).
 * The echo is marked BEFORE the rename, as every move the pull path makes
 * (`engine.ts`, ECHOES; #96); the record follows the note and forgets the
 * name it waited for once it is there. A rename keeps both dimensions, so the
 * record keeps the ones that were proved, and a save that raced it stays
 * visible to the scan as the edit it is.
 */
async function relocate(context: SyncContext, from: string, to: string): Promise<MoveResult> {
  const echo = `${from}\u0000${to}`;
  context.moved.add(echo);
  const outcome = await context.host.move(from, to).catch((error: unknown) => {
    context.moved.delete(echo);
    throw error;
  });
  if (outcome !== "moved") {
    context.moved.delete(echo);
    return outcome;
  }
  const record = context.state.fileByPath(from) as FileState;
  const { name, ...arrived } = record;
  context.state.forgetPath(from);
  context.state.setFile(to, name === to ? arrived : record);
  await context.state.save();
  await pruneEmptyParents(context, from);
  return outcome;
}

/**
 * May the pull move this note now? Only when it still holds what this device
 * recorded -- a note holding bytes not pushed yet stays where it is, because
 * its push is what says where it belongs -- and when the vault has reported
 * this device's own last write to it. That report can arrive after the move,
 * and a move whose echo it clears is read as the USER renaming whichever
 * note the pull has put at that name since (issue #149): its record moves
 * onto the other note's bytes. Such a note waits for its echo, then moves.
 */
async function movable(context: SyncContext, path: string, record: FileState): Promise<boolean> {
  for (const mark of context.written) if (mark.startsWith(`${path}:`)) return false;
  return (await competing(context, path, record.fileId)) === null;
}

/**
 * BESIDE IS TEMPORARY (issue #149). Every note that landed beside its name
 * moves to that name as soon as nothing holds it: after each version this
 * device applies, and at each scan, which is when a name this device's own
 * user freed is found. Without this a note that landed beside a name stayed
 * there for good, the two devices showed it under different names, and this
 * device's next edit published its old name back as a rename.
 *
 * A NOTE THAT ONLY WAITS AT A NAME HAS NO CLAIM TO IT. A swap arrives as two
 * versions, each landed beside the other's name, and neither name is ever
 * free; so a waiting note steps aside to a conflict name, still waiting for
 * its own, and the note that wants its place takes it -- after which the name
 * the second one left is usually the first one's. A note at its OWN name is
 * waited for, never moved.
 *
 * Every move is the host's guarded rename and never a write, so nothing is
 * replaced; a name another record holds is taken only once that note has
 * stepped aside, so a deletion still to be published keeps its record. Each
 * pass that moves a note looks again, since the place that note left may be
 * the one another waits for; the work is bounded by the waiting notes and
 * costs nothing when none waits. A failure is logged and never raised: the
 * version that ran this has been applied, and the feed must not be wedged by
 * a rename it can make next time. Each line names the pass that decided it.
 */
export async function settleBeside(context: SyncContext, seq: number, pass = "pull"): Promise<void> {
  const files = context.state.data.files;
  for (let moved = true; moved;) {
    moved = false;
    for (const path in files) {
      const record = files[path] as FileState;
      const want = record.name;
      if (want === undefined) continue;
      const holder = files[want];
      if (holder !== undefined && holder.name === undefined) continue;
      let outcome: string;
      try {
        if (!(await movable(context, path, record))) continue;
        if (holder !== undefined) {
          if (!(await movable(context, want, holder))) continue;
          const when = new Date(context.now());
          outcome = "occupied";
          for (let attempt = 1; outcome === "occupied" && attempt <= CONFLICT_COPY_NAMES; attempt++) {
            outcome = await relocate(context, want, conflictCopyPath(want, context.deviceNameFor(context.deviceId), when, attempt));
          }
          context.host.log(`${pass} path_class=file decision=parked_beside outcome=${outcome} file=${holder.fileId} seq=${seq}`);
          if (outcome !== "moved") continue;
        }
        outcome = await relocate(context, path, want);
      } catch (error) {
        outcome = error instanceof VaultPathError ? error.refusal : "failed";
      }
      context.host.log(
        `${pass} path_class=file decision=${outcome === "moved" ? "renamed_from_beside" : `beside_kept reason=${outcome}`} ` +
          `file=${record.fileId} seq=${seq}`,
      );
      moved ||= outcome === "moved";
    }
  }
}

/**
 * Is the local file at the name ALREADY this version, byte for byte?
 *
 * A vault whose local state was lost or replaced meets every one of its own
 * notes this way: no record explains them, and every one of them is exactly
 * the version the server holds. Publishing each as a new file id and then
 * renaming the losers would double the vault and scatter its names over a
 * bookkeeping file, so a local file that IS this version is simply recorded
 * as it, and nothing is written, published or moved. The proof is the
 * manifest's authenticated digest, exactly as a conflict copy's reuse is
 * proved; a version too large to carry one (`push.ts`, MANIFEST `sha256`) is
 * not recognised this way and takes the ordinary path, which costs a
 * duplicate and never a loss.
 *
 * A file id this device tracks somewhere else never reaches this: the rule
 * hands those to `updateSettled` before asking anything about the name.
 */
async function adopt(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
  occupant: VaultStat,
): Promise<boolean> {
  const verified = await alreadyCopied(context, manifest, manifest.path, occupant);
  if (verified === null) return false;
  await recordAt(context, change, manifest.path, verified);
  context.host.log(
    `pull path_class=file bytes=${manifest.size} decision=adopted reason=identical_bytes file=${change.file_id} seq=${change.seq}`,
  );
  return true;
}

/**
 * Give the local file at `path` an identity, so that the rule above has two
 * ids to compare.
 *
 * THE RACE THIS CLOSES. A device that was closed while another wrote pulls
 * the incoming version before its own reconciliation has finished publishing
 * the note it made under that name while it was shut -- the queue and the
 * feed run side by side, and either can win. The pulling device then sees a
 * file with no id, cannot apply the rule, and keeps both under a name it
 * chose alone; the other device, whose file IS published, applies the rule
 * and keeps both under a name IT chose. Neither is wrong and they never
 * agree, which is the divergence issue #113 is about. Publishing the local
 * file first costs one push the queue was about to make anyway and leaves
 * both devices holding both ids, which is all the rule needs.
 *
 * A failure is not one: the file keeps its bytes, and the decision falls back
 * to keeping both, exactly as every version before 1.0.7 did.
 */
async function identify(context: SyncContext, path: string, fileId: string): Promise<boolean> {
  if (context.publish === undefined) return false;
  try {
    await context.publish(path);
  } catch {
    // The reason is not logged: a host or transport error names a path.
    context.host.log(`pull path_class=file decision=not_identified file=${fileId}`);
    return false;
  }
  const record = context.state.fileByPath(path);
  return record !== undefined && record.fileId !== fileId;
}

/**
 * Both notes kept, and the copy RECORDED under the incoming file id.
 *
 * Both answers that keep the incoming version beside a local file end here:
 * the device that keeps the name by the rule, and the device that could not
 * identify its own file at all. Both notes survive, as they did in 1.0.5 and
 * 1.0.6, and the record is what is new: the next version of that id is an
 * ordinary update of a file this device tracks instead of another copy, a
 * later rename of it is a plain move, and the startup scan never publishes
 * the copy as a THIRD file id (issue #113). A file id this device tracks
 * somewhere else never reaches this: the rule hands those to `updateSettled`,
 * which keeps them where they are.
 */
async function keepBothRecorded(
  context: SyncContext,
  change: ChangeRecord,
  manifest: Manifest,
): Promise<ApplyResult> {
  const copy = await keepBothAt(context, change, manifest);
  if (copy === null) return "refused";
  await recordAt(context, change, copy.path, copy.stat, manifest.path);
  return "conflict_copy";
}

/**
 * The record a materialised version leaves behind, wherever it landed.
 *
 * THE STAT IS THE CALLER'S, AND IT IS NOT NEGOTIABLE. A record says the file
 * at `path` IS this version and nothing has happened to it since, and the pull
 * path reads exactly that sentence before it writes over a file. Looking the
 * metadata up here would describe the file as it is NOW -- which, after a save
 * that landed while the version was being written or verified, is a different
 * file being declared clean under a version it does not hold, and the next
 * version of that id then overwrote it with no copy kept (review round 2,
 * finding 2). So every caller hands in the metadata of the bytes it actually
 * wrote or actually verified: the writer's own commit, or the stat the digest
 * was proved against.
 */
async function recordAt(
  context: SyncContext,
  change: Pick<ChangeRecord, "file_id" | "version_id" | "sids" | "ts">,
  path: string,
  stat: VaultStat,
  wants?: string,
): Promise<void> {
  context.state.setFile(path, {
    fileId: change.file_id,
    versionId: change.version_id,
    mtime: stat.mtime,
    size: stat.size,
    sha256: await sidDigest(change.sids),
    // Landed BESIDE the name it carries: remembered, so it moves there once
    // that name is free (`settleBeside`, issue #149).
    ...(wants === undefined ? {} : { name: wants }),
    ts: change.ts,
  });
  await context.state.save();
}

/** Write the foreign head beside ours under a named copy, and say so. */
async function keepBoth(
  context: SyncContext,
  change: ChangeRecord,
  theirManifest: Manifest,
): Promise<ApplyResult> {
  return (await keepBothAt(context, change, theirManifest)) === null ? "refused" : "conflict_copy";
}

/** The same, returning where the copy landed, and what it landed as. */
async function keepBothAt(
  context: SyncContext,
  change: ChangeRecord,
  theirManifest: Manifest,
): Promise<{ path: string; stat: VaultStat } | null> {
  const copy = await writeCopy(
    context,
    theirManifest,
    context.deviceNameFor(change.device_id),
    new Date(context.now()),
  );
  if (copy === null) {
    // Nothing was written and nothing was replaced. The version is still on
    // the server, so this refuses a copy, not the content.
    context.host.log(
      `pull path_class=file decision=refused reason=no_free_conflict_name names=${CONFLICT_COPY_NAMES} file=${change.file_id} seq=${change.seq}`,
    );
    context.host.notify(
      `obsync kept your version of ${theirManifest.path} and could not place the other device's copy: ` +
        `every name it tried was already taken. Nothing here was changed, and the other version is still on the server.`,
    );
    return null;
  }
  context.host.notify(
    `obsync kept both versions of ${theirManifest.path}. The other device's copy is "${copy.path}".`,
  );
  context.host.log(
    `pull decision=conflict_copy file=${change.file_id} seq=${change.seq} bytes=${theirManifest.size} name_attempt=${copy.attempt}`,
  );
  return { path: copy.path, stat: copy.stat };
}

/** Post the merge result as one version whose parents are BOTH heads. */
async function postMerged(
  context: SyncContext,
  change: ChangeRecord,
  path: string,
  localVersionId: string,
  text: Bytes,
  mtime: number,
  over?: string[],
): Promise<void> {
  const { cid, sid, ciphertext } = await encryptChunk(context.domainKey, text);
  const missing = await context.transport.missingChunks([sid]);
  if (missing.length > 0) await context.transport.putChunk(sid, ciphertext);
  const manifest: Manifest = {
    v: 1,
    path,
    size: text.length,
    mtime,
    domain: context.domainId,
    chunks: [{ sid, cid: hex(cid), len: text.length }],
    sha256: hex(await sha256(text)),
    deleted: false,
  };
  const parents = over ?? [localVersionId, change.version_id].sort();
  // THE CASE ISSUE #114 IS ABOUT. Two devices that resolve the same two heads
  // to the same bytes produce the same parents, the same chunk and the same
  // path, and two version ids, because the id covers the encrypted manifest
  // and its nonce. The second frame says nothing the first did not and forks
  // the file, which another merge then has to close. So this post offers the
  // server the version it already holds at this position, and this device
  // records the id it is answered with.
  const posted = await postManifest(context, change.file_id, parents, [sid], manifest, text.length, true);
  context.authored.add(posted.versionId);
  context.state.setFile(path, {
    fileId: change.file_id,
    versionId: posted.versionId,
    mtime,
    size: text.length,
    sha256: await sidDigest([sid]),
  });
  await context.state.save();
}

/**
 * Remote-only accounting for the "Remote only" view. The stored paths were
 * checked when they were recorded; they are checked again here because this
 * list is what the user sees and what a fetch acts on, and a data file is
 * editable by anything that can reach the vault.
 */
export function remoteOnlyList(context: SyncContext): { fileId: string; path: string; size: number; why: string }[] {
  const policy = context.state.data.policy;
  const listable = Object.entries(context.state.data.remoteOnly).filter(([, record]) => inSyncScope(record.path, context.state.data.syncFolders));
  return listable.map(([fileId, record]) => {
    const admission = admit(policy, context.state.localBytes(), record.size);
    return {
      fileId,
      path: record.path,
      size: record.size,
      why: admission.ok ? "available" : admissionReason(policy, admission.reason),
    };
  });
}
