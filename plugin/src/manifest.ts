/** Shared authenticated manifest validation for sync and offline exports. */
import { isHex } from "./crypto";
import { CHUNK_MAX, CHUNK_MIN } from "./chunker";
import { vaultPathRefusal } from "./vaultPath";
import type { ChangeRecord } from "./transport";
import type { Manifest, ManifestChunk, FolderManifest, PauseManifest } from "./sync/push";

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
export function parseEntry(json: string): Manifest | FolderManifest | PauseManifest {
  const value = manifestObject(json);
  if (value["v"] === 3) {
    if (value["kind"] !== "pause" || typeof value["target"] !== "string" || !isHex(value["target"], 16) || typeof value["paused"] !== "boolean" || value["deleted"] !== false) throw new ManifestError("pause");
    folderManifest({ ...value, kind: "directory" });
    return value as unknown as PauseManifest;
  }
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
  if (value["answer"] !== undefined && value["answer"] !== true) throw new ManifestError("answer");
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
  manifest: FolderManifest | PauseManifest,
  engineDomain: string,
): void {
  if (record.domain_id !== engineDomain) throw new ManifestError("record_domain");
  if (manifest.domain !== record.domain_id) throw new ManifestError("manifest_domain");
  if (record.sids.length !== 0) throw new ManifestError("record_sid_count");
  if (record.bytes !== 0) throw new ManifestError("record_bytes");
  if (manifest.deleted !== record.deleted) throw new ManifestError("record_deleted");
}
