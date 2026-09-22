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
 * ECHOES. A write this device made comes back down the feed. It is dropped
 * twice over: by `version_id` (the ids this device authored) and by the
 * `(path, mtime, size)` of the writes this device made, which is what stops
 * the vault watcher from pushing our own pull back up.
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
 * is never downloaded and is listed as remote-only instead.
 */

import type { SyncContext, VaultStat, VaultWriter } from "./engine";
import { CHUNK_MAX, CHUNK_MIN, CHUNK_CIPHERTEXT_MAX } from "../chunker";
import {
  Bytes,
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
import { ChangeRecord, FileRecord, ReadControl } from "../transport";
// The per-path record this device keeps, named apart from the SERVER's file
// record above, which is a different thing with the same name.
import type { FileRecord as FileState } from "../state";
import { admissionReason, admit } from "../policy";
import { VaultPathError, assertVaultPath, caseOnly, vaultPathRefusal } from "../vaultPath";
import { assertSyncPath, inSyncScope } from "../syncScope";
import { conflictCopyPath, isMergeableText, threeWayMerge } from "./conflict";
import { Manifest, ManifestChunk, postManifest, sidDigest } from "./push";

/**
 * One batched chunk fetch. The bound is MEMORY, and it is computed from the
 * ciphertext ceiling including its authentication tag, never from the lengths a manifest declares: a declared length
 * is a number another device chose, so budgeting by it would let a chunk list
 * of zeros pull 64 maximum-size chunks into one 32 MiB budget. The wire cap is
 * 64 sids (`transport.ts`); this one is lower and is the one that holds.
 */
const BATCH_BYTES = 32 << 20;
const BATCH_SIDS = Math.max(1, Math.floor(BATCH_BYTES / CHUNK_CIPHERTEXT_MAX));

export type ApplyResult =
  | "echo"
  | "applied"
  | "deleted"
  | "remote_only"
  | "merged"
  | "conflict_copy"
  | "refused"
  | "skipped";

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
 * The runtime schema check for a decrypted manifest: every field is verified
 * against the shape `Manifest` claims, and `path` against the vault-path rule,
 * BEFORE any of it is used. Without this the type assertion is a promise the
 * compiler cannot keep — the bytes came off the wire from another device.
 */
export function parseManifest(json: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ManifestError("not_json");
  }
  if (!isRecord(value)) throw new ManifestError("not_an_object");
  const refusal = vaultPathRefusal(value["path"]);
  if (refusal !== null) throw new ManifestError(`path_${refusal}`);
  if (value["v"] !== 1) throw new ManifestError("version");
  if (!size(value["size"])) throw new ManifestError("size");
  if (typeof value["mtime"] !== "number" || !Number.isFinite(value["mtime"])) throw new ManifestError("mtime");
  if (typeof value["domain"] !== "string") throw new ManifestError("domain");
  if (typeof value["deleted"] !== "boolean") throw new ManifestError("deleted");
  const digest = value["sha256"];
  if (digest !== "" && !digest32(digest)) throw new ManifestError("sha256");
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

export async function decryptRecordManifest(
  context: SyncContext,
  record: BoundRecord & Pick<ChangeRecord, "file_id" | "parents" | "manifest_ct" | "manifest_nonce">,
): Promise<Manifest> {
  const binder = await contentVersionId(record.file_id, record.parents, record.sids);
  const json = await decryptManifest(
    context.manifestKey,
    record.file_id,
    binder,
    unhex(record.manifest_nonce),
    unbase64(record.manifest_ct),
  );
  const manifest = parseManifest(json);
  // The one choke point: every path that decrypts a manifest from a record
  // -- the feed, an on-demand fetch, a conflict head, a merge base -- comes
  // through here, so none of them can forget to bind it.
  bindManifestToRecord(record, manifest, context.domainId);
  assertSyncPath(manifest.path, context.state.data.syncFolders);
  return manifest;
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
      if (!body) throw new Error(`pull: chunk ${chunk.sid} is missing on the server`);
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

/**
 * Write a manifest's content into the vault atomically and return the stat
 * of what landed, which becomes the echo-suppression key.
 */
async function materialise(context: SyncContext, manifest: Manifest): Promise<VaultStat> {
  // The single choke point for every byte this device writes: the decoded
  // manifest's path was checked at decode, a conflict copy's derived path is
  // checked here, and neither reaches a writer unchecked.
  assertVaultPath(manifest.path);
  const writer = await context.host.writer(manifest.path);
  try {
    await writeVerified(context, manifest, writer);
    const stat = await writer.commit(manifest.mtime);
    context.written.add(`${stat.path}:${stat.mtime}:${stat.size}`);
    // The commit's own stat, handed back rather than looked up again: it is
    // the metadata of the bytes THIS write put there, and a second stat would
    // describe whatever the user saved a moment later instead (finding 2).
    return stat;
  } catch (error) {
    await writer.abort();
    throw error;
  }
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
  if (!context.refused.has(change.file_id)) {
    context.refused.add(change.file_id);
    context.host.notify(
      `obsync refused a change from another device: it does not name a plain file inside this vault (${reason}). ` +
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
    return await applyVersion(context, change);
  } catch (error) {
    // Both refusals are the same decision to the user: this version does not
    // name a file this device may write, by its text (`ManifestError`) or by
    // what the filesystem says its path IS (`VaultPathError` — a symlinked
    // folder, a raced temp file). Skip the version, keep the feed moving.
    if (error instanceof ManifestError) return refuse(context, change, error.reason);
    if (error instanceof VaultPathError) {
      if (error.refusal === "outside_sync_scope") {
        context.host.log(`pull path_class=manifest decision=not_synced reason=outside_sync_scope file=${change.file_id} seq=${change.seq}`);
        return "skipped";
      }
      return refuse(context, change, error.refusal);
    }
    throw error;
  }
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
 * A deletion this device declined to apply, said once per file. The note is
 * still there and still the user's, and the next push carries it back to the
 * other devices, so the message says what happened rather than what failed.
 */
function notifyKeptDeletion(context: SyncContext, change: ChangeRecord, path: string): void {
  if (context.refused.has(change.file_id)) return;
  context.refused.add(change.file_id);
  context.host.notify(
    `obsync did not delete ${path}: it holds changes this device has not uploaded yet. ` +
      `Another device deleted that note; this copy is kept here and is uploaded as a new version.`,
  );
}

async function applyVersion(context: SyncContext, change: ChangeRecord): Promise<ApplyResult> {
  const manifest = await decryptRecordManifest(context, change);
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
          notifyKeptDeletion(context, change, localPath);
          return "skipped";
        }
      }
      const held = await competing(context, localPath, change.file_id);
      if (held !== null) {
        context.host.log(
          `pull path_class=tombstone decision=local_edit_kept reason=${held} file=${change.file_id} seq=${change.seq}`,
        );
        notifyKeptDeletion(context, change, localPath);
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
      await context.state.save();
      context.host.log(`pull path_class=tombstone decision=deleted seq=${change.seq}`);
      return "deleted";
    }
    delete context.state.data.remoteOnly[change.file_id];
    return "skipped";
  }

  if (local && local.versionId === change.version_id) return "skipped";

  const admission = admit(context.state.data.policy, context.state.localBytes(), manifest.size);
  if (!admission.ok) {
    context.state.data.remoteOnly[change.file_id] = { path: manifest.path, size: manifest.size };
    await context.state.save();
    context.host.log(
      `pull path_class=file bytes=${manifest.size} decision=remote_only reason=${admission.reason} seq=${change.seq}`,
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
    } else {
      return await keepBoth(context, change, manifest);
    }
  }

  const started = context.now();
  const landed = await materialise(context, manifest);
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
  }
  await recordAt(context, change, manifest.path, landed);
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
  await materialise(context, manifest);
  const stat = await context.host.stat(manifest.path);
  context.state.setFile(manifest.path, {
    fileId,
    versionId: head.version_id,
    mtime: stat?.mtime ?? manifest.mtime,
    size: stat?.size ?? manifest.size,
    sha256: await sidDigest(head.sids),
  });
  await context.state.save();
  context.host.log(`pull path_class=file bytes=${manifest.size} decision=fetched_on_demand`);
  return manifest.path;
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
 * Two heads on one file. Merge when we can prove a base and the content is
 * mergeable text; otherwise keep both sides. The caller passes the file it
 * already read: deciding that these ARE two heads walks the same graph, and
 * asking twice would buy the same answer with a second request.
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
  // More than a handful of resolutions of ONE file inside a minute is not a
  // user editing on two devices, so this device stops merging that file and
  // keeps both sides instead. It says so once, and the count is in the log.
  const now = context.now();
  const seen = context.merges.get(change.file_id);
  const tally = seen !== undefined && now - seen.since < MERGE_STORM_MS ? seen : { since: now, count: 0 };
  tally.count++;
  context.merges.set(change.file_id, tally);
  if (tally.count > MERGE_STORM_LIMIT) {
    context.host.log(
      `pull decision=refused reason=merge_storm file=${change.file_id} count=${tally.count} window_ms=${MERGE_STORM_MS}`,
    );
    if (!context.refused.has(change.file_id)) {
      context.refused.add(change.file_id);
      context.host.notify(
        `obsync stopped merging ${localPath}: this device resolved it more than ${MERGE_STORM_LIMIT} times in a minute. ` +
          `Both versions are kept side by side instead. Check that every device syncing this vault is up to date.`,
      );
    }
    return await keepBoth(context, change, theirManifest);
  }

  const baseId = commonAncestor(file.versions, localVersionId, change.version_id);
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
    theirManifest.sha256 !== "" &&
    theirManifest.size === mine.length &&
    hex(await sha256(mine)) === theirManifest.sha256
  ) {
    const head = localVersionId < change.version_id ? localVersionId : change.version_id;
    const held = context.state.fileByPath(localPath);
    if (held) context.state.setFile(localPath, { ...held, versionId: head });
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
    baseId !== null &&
    theirManifest.chunks.length === 1 &&
    theirManifest.size <= CHUNK_MAX &&
    isMergeableText(localPath, mine);

  if (mergeable) {
    const baseRecord = file.versions.find((version) => version.version_id === baseId);
    if (baseRecord) {
      const baseManifest = await decryptRecordManifest(context, {
        ...baseRecord,
        file_id: change.file_id,
        domain_id: file.domain_id,
      });
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
      const merged = threeWayMerge(decoder.decode(base), decoder.decode(mine), decoder.decode(theirs));
      if (merged.ok) {
        const text = new TextEncoder().encode(merged.text);
        const writer = await context.host.writer(localPath);
        await writer.write(text);
        const stat = await writer.commit(context.now());
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
      context.host.log(`pull decision=conflict_copy reason=${merged.reason} file=${change.file_id}`);
    }
  }

  return await keepBoth(context, change, theirManifest);
}

/**
 * The merge breaker. One fork of one note costs at most one merge per device,
 * so a file that needs more than this inside a minute is not being edited, it
 * is looping, and a device that keeps merging a loop is what fills a journal
 * (issue #110). Both are constants, not configuration: a device must not be
 * able to be told to keep going.
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
  const landed = await writeBeside(
    context, manifest.path, deviceName, when, manifest.size, manifest.mtime,
    (writer, target) => writeVerified(context, { ...manifest, path: target }, writer),
    (target, occupant) => alreadyCopied(context, manifest, target, occupant),
  );
  if (landed === null) return null;
  if (landed.written) {
    context.written.add(`${landed.stat.path}:${landed.stat.mtime}:${landed.stat.size}`);
  } else {
    context.host.log(
      `pull decision=conflict_copy_present bytes=${manifest.size} name_attempt=${landed.attempt}`,
    );
  }
  return { path: landed.path, attempt: landed.attempt, stat: landed.stat };
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
  // A name of its own here already. Whatever settled this pair last time
  // settled it for good: the incoming id's versions land where this device
  // put it, and they keep landing there until its own device publishes the
  // rename that moves it. Asking the rule again would answer the same way,
  // and deciding it by what occupies its ORIGINAL name would copy the file
  // again every time it is edited, which is the defect itself (issue #113).
  const settled = context.state.pathByFileId(change.file_id);
  if (settled !== undefined) return await updateSettled(context, change, manifest, settled);
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
  await recordAt(context, change, manifest.path, landed);
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
async function createOnly(context: SyncContext, manifest: Manifest): Promise<VaultStat | null> {
  assertVaultPath(manifest.path);
  let writer: VaultWriter;
  try {
    writer = await context.host.createWriter(manifest.path, manifest.size, () => undefined);
  } catch (error) {
    if ((await context.host.stat(manifest.path)) === null) throw error;
    return null;
  }
  let stat: VaultStat;
  try {
    await writeVerified(context, manifest, writer);
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
  context.written.add(`${stat.path}:${stat.mtime}:${stat.size}`);
  return stat;
}

/**
 * A version of a file this device has already given a name of its own.
 *
 * It lands THERE, not at the name its manifest carries: that name belongs to
 * the other note of the pair on this device, and materialising over it is the
 * loss this whole series is about -- while copying it beside again, once per
 * edit, is the defect issue #113 exists to end.
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
  await recordAt(context, change, settled, await materialise(context, { ...manifest, path: settled }));
  context.host.log(
    `pull path_class=file bytes=${manifest.size} decision=applied_beside file=${change.file_id} seq=${change.seq}`,
  );
  return "applied";
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
  await recordAt(context, change, copy.path, copy.stat);
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
  change: ChangeRecord,
  path: string,
  stat: VaultStat,
): Promise<void> {
  context.state.setFile(path, {
    fileId: change.file_id,
    versionId: change.version_id,
    mtime: stat.mtime,
    size: stat.size,
    sha256: await sidDigest(change.sids),
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
