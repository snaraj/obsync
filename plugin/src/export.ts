/** Portable ciphertext archive, shared by the app and offline client. See docs/export.md. */
import {
  Bytes, base64, bytesEqual, contentVersionId, decryptChunk, decryptDomainMap,
  decryptManifest, deriveDomainKey, deriveDomainMapKey, deriveManifestKey,
  domainMapIds, folderFileId, hex, hkdf, hmacSha256, isHex, sha256, unbase64, unhex, utf8, versionId,
} from "./crypto";
import { parseDomainMap } from "./domainmap";
import { bindFolderToRecord, bindManifestToRecord, parseEntry } from "./manifest";
import { assertVaultPath } from "./vaultPath";
import type { Transport, VersionRecord } from "./transport";
import type { Manifest } from "./sync/push";

export const EXPORT_MAGIC = utf8("OBSYNC-EXPORT-1\n");
export const EXPORT_INDEX_MAX = 64 * 1024 * 1024;
export const EXPORT_RECORDS_MAX = 100_000;
export const EXPORT_CHUNK_MAX = 8 * 1024 * 1024 + 16;
/** Device resource policy, independent of the server's storage policy. */
export const EXPORT_BYTES_MAX = 64 * 1024 * 1024 * 1024;
export const EXPORT_WORK_MS = 30 * 60 * 1000;
const LABEL = utf8("obsync/export/v1/inventory");
export type ExportVersion = Pick<VersionRecord, "version_id" | "parents" | "sids" | "bytes" | "manifest_ct" | "manifest_nonce" | "deleted">;
export interface ExportFile { file_id: string; domain_id: string; heads: string[]; versions: ExportVersion[] }
export interface ExportIndex { v: 1; source: "device" | "server"; scope: "current" | "history"; snapshot: number; files: ExportFile[] }
export interface ExportReader { size: number; read(offset: number, length: number): Promise<Bytes> }
export type ExportCheck = () => void;
export class ExportError extends Error {
  constructor(readonly reason: string, chunk?: string) {
    super(`Export refused (${reason}).${chunk ? ` Chunk ${chunk} is unavailable.` : ""} No completed output was published.`);
  }
}
function refuse(reason: string): never { throw new ExportError(reason); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function id(value: unknown, bytes: number): value is string { return typeof value === "string" && isHex(value, bytes); }
function ids(value: unknown, bytes: number, max: number, unique = true): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((v) => id(v, bytes)) && (!unique || new Set(value).size === value.length);
}
export function exportBudget(active: ExportCheck = () => {}): ExportCheck {
  const start = Date.now();
  return () => { active(); if (Date.now() - start > EXPORT_WORK_MS) refuse("time_budget"); };
}
function u32(value: number): Bytes { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; }
function number32(bytes: Bytes): number { return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0); }
function chunksOf(index: ExportIndex): string[] { return [...new Set(index.files.flatMap((file) => file.versions.flatMap((version) => version.sids)))].sort(); }
function compact(v: ExportVersion): ExportVersion {
  return { version_id: v.version_id, parents: v.parents, sids: v.sids, bytes: v.bytes, manifest_ct: v.manifest_ct, manifest_nonce: v.manifest_nonce, deleted: v.deleted };
}

/** Validate all structure before a value chooses an allocation, key or disk operation. */
export async function validateExport(value: unknown, check: ExportCheck): Promise<ExportIndex> {
  if (!object(value) || value.v !== 1 || (value.source !== "device" && value.source !== "server") ||
      (value.scope !== "current" && value.scope !== "history") || !integer(value.snapshot) || !Array.isArray(value.files) ||
      value.files.length > EXPORT_RECORDS_MAX) refuse("inventory");
  const files = new Set<string>();
  let count = 0, bytes = 0, references = 0;
  for (const file of value.files as unknown[]) {
    check();
    if (!object(file) || !id(file.file_id, 16) || !id(file.domain_id, 16) || files.has(file.file_id) ||
        !ids(file.heads, 32, 64) || file.heads.length === 0 || !Array.isArray(file.versions) || file.versions.length === 0) refuse("file_inventory");
    files.add(file.file_id);
    const versions = new Set<string>();
    for (const version of file.versions as unknown[]) {
      check();
      if (++count > EXPORT_RECORDS_MAX) refuse("record_budget");
      if (!object(version) || !id(version.version_id, 32) || versions.has(version.version_id) || !ids(version.parents, 32, 64) ||
          !ids(version.sids, 32, 65_536, false) || !integer(version.bytes) || typeof version.deleted !== "boolean" ||
          !id(version.manifest_nonce, 12) || typeof version.manifest_ct !== "string" || version.manifest_ct.length > 1_398_104) refuse("version_inventory");
      if (version.deleted && (version.bytes !== 0 || version.sids.length !== 0)) refuse("deleted_inventory");
      if ((references += version.sids.length) > 1_000_000 || (bytes += version.bytes) > EXPORT_BYTES_MAX) refuse("byte_budget");
      const ct = unbase64(version.manifest_ct);
      if (ct.length < 16 || ct.length > 1024 * 1024 || base64(ct) !== version.manifest_ct || await versionId(file.file_id, version.parents, ct, version.sids) !== version.version_id) refuse("version_digest");
      if (value.scope === "current" && !file.heads.includes(version.version_id)) refuse("unselected_version");
      versions.add(version.version_id);
    }
    if (file.heads.some((head) => !versions.has(head))) refuse("missing_head");
  }
  return value as unknown as ExportIndex;
}

/** One bounded feed walk. Every page must describe the same journal head. */
export async function selectExport(transport: Pick<Transport, "changes">, history: boolean, check: ExportCheck): Promise<ExportIndex> {
  const selected = new Map<string, ExportFile>();
  let since = 0, snapshot: number | undefined, work = 0, metadata = 0;
  do {
    check();
    const page = await transport.changes(since, 0, 256, { interactive: true });
    if (!integer(page.head_seq) || !integer(page.seq) || page.seq < since || page.seq > page.head_seq ||
        !Array.isArray(page.changes) || page.changes.length > 256) refuse("feed_progress");
    snapshot ??= page.head_seq;
    if (snapshot !== page.head_seq) refuse("snapshot_changed");
    let previous = since;
    for (const change of page.changes) {
      if (++work > 1_000_000) refuse("work_budget");
      if (!integer(change.seq) || change.seq <= previous || change.seq > page.seq || !id(change.file_id, 16) ||
          !id(change.domain_id, 16) || !ids(change.heads, 32, 64)) refuse("feed_progress");
      previous = change.seq;
      if (!history && !change.heads.includes(change.version_id)) continue;
      const version = compact(change);
      if ((metadata += utf8(JSON.stringify(version)).length + (selected.has(change.file_id) ? 1 : change.heads.length * 67 + 150)) > EXPORT_INDEX_MAX) refuse("metadata_budget");
      let file = selected.get(change.file_id);
      if (!file) { file = { file_id: change.file_id, domain_id: change.domain_id, heads: change.heads, versions: [] }; selected.set(change.file_id, file); }
      if (file.domain_id !== change.domain_id || [...file.heads].sort().join() !== [...change.heads].sort().join()) refuse("snapshot_changed");
      file.versions.push(version);
    }
    if (page.seq === since && since < snapshot) refuse("feed_progress");
    since = page.seq;
  } while (since < snapshot);
  check();
  const final = await transport.changes(snapshot, 0, 1, { interactive: true });
  if (final.head_seq !== snapshot || final.seq !== snapshot || final.changes.length !== 0) refuse("snapshot_changed");
  return validateExport({ v: 1, source: "device", scope: history ? "history" : "current", snapshot, files: [...selected.values()] }, check);
}

/** No plaintext reads: authenticate the inventory and copy each verified ciphertext once. */
export async function writeExport(index: ExportIndex, vrk: Bytes, chunk: (sid: string) => Promise<Bytes>, write: (bytes: Bytes) => Promise<void>, check: ExportCheck): Promise<void> {
  await validateExport(index, check);
  if (index.source !== "device" || vrk.length !== 32) refuse("device_key");
  const raw = utf8(JSON.stringify(index));
  if (raw.length > EXPORT_INDEX_MAX) refuse("metadata_budget");
  const digest = await sha256(raw), key = await hkdf(vrk, LABEL, new Uint8Array(), 32);
  await write(EXPORT_MAGIC); await write(u32(raw.length)); await write(raw); await write(digest);
  await write(await hmacSha256(key, digest));
  let total = raw.length + EXPORT_MAGIC.length + 68;
  for (const sid of chunksOf(index)) {
    check();
    const body = await chunk(sid).catch((error: unknown) => {
      if (object(error) && error.code === "unknown_chunk") throw new ExportError("missing_chunk", sid);
      throw error;
    });
    if (body.length < 16 || body.length > EXPORT_CHUNK_MAX || (total += body.length + 4) > EXPORT_BYTES_MAX) refuse("ciphertext_budget");
    if (hex(await sha256(body)) !== sid) refuse("chunk_digest");
    await write(u32(body.length)); await write(body);
  }
}

/** Portable output names, including Windows names and case/normalization collisions. */
export function exportPath(path: string): string {
  assertVaultPath(path);
  if (path.length > 4096 || path.split("/").length > 32) refuse("path_budget");
  for (const part of path.split("/")) {
    if (utf8(part).length > 240 || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) refuse("reserved_path");
  }
  return path;
}
export class ExportPaths {
  private readonly names = new Map<string, { path: string; directory: boolean }>();
  add(path: string, directory: boolean): void {
    exportPath(path);
    const parts = path.split("/");
    for (let n = 1; n <= parts.length; n++) {
      const at = parts.slice(0, n).join("/"), dir = n < parts.length || directory, folded = at.normalize("NFC").toLowerCase();
      const held = this.names.get(folded);
      if (held && (held.path !== at || !held.directory || !dir)) refuse("path_collision");
      this.names.set(folded, { path: at, directory: dir });
    }
  }
}
export interface OpenedExport {
  index: ExportIndex;
  files: { path: string; manifest: Manifest; domainKey: Bytes }[];
  directories: string[];
  chunks: Map<string, { offset: number; length: number }>;
  bytes: number;
}

/** Authenticate metadata, every ciphertext and every output name before plaintext staging. */
export async function inspectExport(reader: ExportReader, vrk: Bytes, allowServer: boolean, check: ExportCheck): Promise<OpenedExport> {
  if (!integer(reader.size) || reader.size > EXPORT_BYTES_MAX || vrk.length !== 32) refuse("archive_budget");
  let offset = 0;
  const read = async (n: number): Promise<Bytes> => {
    check(); if (offset + n > reader.size) refuse("truncated_archive");
    const data = await reader.read(offset, n); if (data.length !== n) refuse("truncated_archive"); offset += n; return data;
  };
  if (!bytesEqual(await read(EXPORT_MAGIC.length), EXPORT_MAGIC)) refuse("format");
  const size = number32(await read(4)); if (size > EXPORT_INDEX_MAX) refuse("metadata_budget");
  const raw = await read(size), digest = await read(32), mac = await read(32);
  if (!bytesEqual(digest, await sha256(raw))) refuse("inventory_digest");
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const index = await validateExport(parsed, check);
  if (index.source === "device") {
    const key = await hkdf(vrk, LABEL, new Uint8Array(), 32);
    if (!bytesEqual(mac, await hmacSha256(key, digest))) refuse("inventory_authentication");
  } else if (!allowServer || !bytesEqual(mac, new Uint8Array(32))) refuse("server_inventory_unverified");
  if (index.source === "server" && index.files.length === 0) refuse("server_empty_unverifiable");
  const chunks = new Map<string, { offset: number; length: number }>();
  for (const sid of chunksOf(index)) {
    const length = number32(await read(4));
    if (length < 16 || length > EXPORT_CHUNK_MAX) refuse("chunk_budget");
    const at = offset, body = await read(length);
    if (hex(await sha256(body)) !== sid) refuse("chunk_digest");
    chunks.set(sid, { offset: at, length });
  }
  if (offset !== reader.size) refuse("trailing_archive");
  const result: OpenedExport = { index, files: [], directories: [], chunks, bytes: 0 };
  const paths = new ExportPaths(), mapKey = await deriveDomainMapKey(vrk), mapIds = await domainMapIds(mapKey);
  const domains = new Map<string, { key: Bytes; manifestKey: Bytes }>();
  for (const file of index.files) {
    let keys = domains.get(file.domain_id);
    if (!keys) { const key = await deriveDomainKey(vrk, file.domain_id); keys = { key, manifestKey: await deriveManifestKey(key, file.domain_id) }; domains.set(file.domain_id, keys); }
    for (const version of file.versions) {
      check();
      const binder = await contentVersionId(file.file_id, version.parents, version.sids);
      if (file.file_id === mapIds.fileId) {
        if (file.domain_id !== mapIds.domainId || version.deleted || version.sids.length !== 0 || version.bytes !== 0) refuse("domain_map");
        parseDomainMap(await decryptDomainMap(mapKey, file.file_id, binder, unhex(version.manifest_nonce), unbase64(version.manifest_ct)));
        continue;
      }
      const manifest = parseEntry(await decryptManifest(keys.manifestKey, file.file_id, binder, unhex(version.manifest_nonce), unbase64(version.manifest_ct)));
      const record = { ...version, domain_id: file.domain_id };
      if (manifest.v === 1) bindManifestToRecord(record, manifest, file.domain_id);
      else bindFolderToRecord(record, manifest, file.domain_id);
      exportPath(manifest.path);
      if (manifest.v === 3 || manifest.deleted) continue;
      if (manifest.v === 2 && await folderFileId(keys.manifestKey, manifest.path) !== file.file_id) refuse("folder_identity");
      let path = manifest.path;
      if (!file.heads.includes(version.version_id)) path = `obsync-history/${file.file_id}/${version.version_id}/${path}`;
      else if (version.version_id !== [...file.heads].sort()[0]) path = `obsync-conflicts/${file.file_id}/${version.version_id}/${path}`;
      paths.add(path, manifest.v === 2);
      if (manifest.v === 2) result.directories.push(path);
      else {
        for (const chunk of manifest.chunks) if (chunks.get(chunk.sid)?.length !== chunk.len + 16) refuse("chunk_size");
        result.bytes += manifest.size;
        if (result.bytes > EXPORT_BYTES_MAX) refuse("plaintext_budget");
        result.files.push({ path, manifest, domainKey: keys.key });
      }
    }
  }
  return result;
}

/** The caller owns a private, unpublished stage; output is verified chunk by chunk. */
export async function decryptExportFile(reader: ExportReader, opened: OpenedExport, file: OpenedExport["files"][number], write: (bytes: Bytes) => Promise<void>, check: ExportCheck): Promise<void> {
  for (const part of file.manifest.chunks) {
    check();
    const located = opened.chunks.get(part.sid); if (!located) refuse("missing_chunk");
    const ct = await reader.read(located.offset, located.length);
    if (ct.length !== located.length || hex(await sha256(ct)) !== part.sid) refuse("chunk_digest");
    const bytes = await decryptChunk(file.domainKey, unhex(part.cid), ct);
    if (bytes.length !== part.len) refuse("plaintext_size");
    if (file.manifest.chunks.length === 1 && hex(await sha256(bytes)) !== file.manifest.sha256) refuse("plaintext_digest");
    await write(bytes);
  }
}
