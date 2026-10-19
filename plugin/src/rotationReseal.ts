/** Explicit frozen-inventory resealing; no State, local vault, or live-suite fallback. */
import { base64, bytesEqual, concat, contentVersionId, decryptChunk, decryptManifestBytes, deriveDomainKey, deriveManifestKey,
  folderFileId, hex, hmacSha256, isHex, sha256, unbase64, unhex, utf8, versionId, type Bytes } from "./crypto";
import { domainMapKeys, parseDomainMap, serialiseDomainMap, soleDomain, type DomainMap, type DomainMapKeys } from "./domainmap";
import { decryptChunk2, encryptChunk2, openRecord, sealRecord } from "./seal2";
import { readManifestSeal2 } from "./sealWire";
import { bindFolderToRecord, bindManifestToRecord, parseEntry } from "./sync/pull";
import type { FolderManifest, Manifest, PauseManifest } from "./sync/push";
import type { VersionPost } from "./transport";
import { CHUNK_CIPHERTEXT_MAX } from "./chunker";

export interface OldRotationScope { suite: 1 | 2; root: Bytes; generation: string }
export interface NewRotationScope { root: Bytes; generation: string }
export type RotationHead = readonly [string, string];
export interface RotationResealIO {
  getFile(fileId: string): Promise<unknown>;
  getVersion(fileId: string, versionId: string): Promise<unknown>;
  getChunk(sid: string): Promise<Bytes>;
  putChunk(sid: string, ciphertext: Bytes): Promise<void>;
}
export class RotationResealError extends Error {
  constructor(readonly reason: string) { super(`rotation reseal refused: ${reason}`); this.name = "RotationResealError"; }
}
interface RecordBytes { version_id: string; parents: string[]; sids: string[]; bytes: number; deleted: boolean; packet: Bytes; nonce?: Bytes }
type Entry = Manifest | FolderManifest | PauseManifest;
const HEADS_MAX = 65536;
const fatal = (bytes: Bytes): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function fail(reason: string): never { throw new RotationResealError(reason); }
async function external<T>(action: () => Promise<T>, reason: string): Promise<T> {
  try { return await action(); } catch { return fail(reason); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record");
  return value as Record<string, unknown>;
}
function identifier(value: unknown, bytes: number): value is string { return typeof value === "string" && isHex(value, bytes); }
function root(value: Bytes): Bytes {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== 32) fail("scope");
  return new Uint8Array(value);
}
function oldSnapshot(value: OldRotationScope): OldRotationScope {
  try {
    if (!value || ![1, 2].includes(value.suite) || !identifier(value.generation, 16)) fail("scope");
    return { suite: value.suite, generation: value.generation, root: root(value.root) };
  } catch { return fail("scope"); }
}
function nextSnapshot(value: NewRotationScope): NewRotationScope {
  try {
    if (!value || !identifier(value.generation, 16)) fail("scope");
    return { generation: value.generation, root: root(value.root) };
  } catch { return fail("scope"); }
}
function identifiers(value: unknown, cap: number): string[] {
  if (!Array.isArray(value) || value.length > cap || [...value].some(id => !identifier(id, 32))) fail("record");
  return [...value] as string[];
}
async function record(io: RotationResealIO, head: RotationHead, suite: 1 | 2): Promise<RecordBytes> {
  try {
    const r = object(await external(() => io.getVersion(head[0], head[1]), "record"));
    const parents = identifiers(r["parents"], 64), sids = identifiers(r["sids"], 65536);
    if (r["version_id"] !== head[1] || new Set(parents).size !== parents.length ||
        !Number.isSafeInteger(r["bytes"]) || (r["bytes"] as number) < 0 || typeof r["deleted"] !== "boolean" ||
        !identifier(r["device_id"], 16) || !Number.isSafeInteger(r["ts"]) || (r["ts"] as number) < 0) fail("record");
    const bytes = r["bytes"] as number, deleted = r["deleted"] as boolean;
    let packet: Bytes, nonce: Bytes | undefined;
    if (suite === 2) packet = readManifestSeal2(r);
    else {
      if ("seal_suite" in r || !identifier(r["manifest_nonce"], 12) || typeof r["manifest_ct"] !== "string" || r["manifest_ct"].length > (1 << 20)) fail("record");
      packet = unbase64(r["manifest_ct"]);
      if (packet.length < 16 || base64(packet) !== r["manifest_ct"]) fail("record");
      nonce = unhex(r["manifest_nonce"]);
    }
    if (await versionId(head[0], parents, packet, sids) !== head[1]) fail("version_identity");
    return { version_id: head[1], parents, sids, bytes, deleted, packet, ...(nonce === undefined ? {} : { nonce }) };
  } catch (error) { if (error instanceof RotationResealError) throw error; return fail("record"); }
}
async function text(scope: OldRotationScope, key: Bytes, fileId: string, domainId: string, r: RecordBytes, kind: 1 | 2): Promise<string> {
  try {
    return fatal(scope.suite === 2 ? await openRecord(key, kind, { generation: scope.generation, domainId, fileId, parents: r.parents, sids: r.sids }, r.packet)
      : await decryptManifestBytes(key, fileId, await contentVersionId(fileId, r.parents, r.sids), r.nonce!, r.packet));
  } catch { return fail("authentication"); }
}
async function readMap(io: RotationResealIO, scope: OldRotationScope, keys: DomainMapKeys, head: RotationHead): Promise<DomainMap> {
  const r = await record(io, head, scope.suite);
  if (r.deleted || r.bytes !== 0 || r.sids.length !== 0) fail("map");
  try {
    const map = parseDomainMap(await text(scope, keys.key, keys.fileId, keys.domainId, r, 2));
    if (soleDomain(map) === null) fail("map_domains");
    return map;
  } catch (error) { if (error instanceof RotationResealError) throw error; return fail("map"); }
}
async function sourceKeys(scope: OldRotationScope): Promise<DomainMapKeys> {
  const keys = await domainMapKeys(scope.root);
  if (keys.fileId !== scope.generation) fail("generation");
  return keys;
}

/** Run before prepare; a conflicted or unsupported map never freezes an account. */
export async function preflightRotationMap(io: RotationResealIO, input: OldRotationScope): Promise<{ map: DomainMap; versionId: string }> {
  const scope = oldSnapshot(input);
  try {
    const keys = await sourceKeys(scope), file = object(await external(() => io.getFile(keys.fileId), "map"));
    const heads = file["heads"];
    if (file["file_id"] !== keys.fileId || file["domain_id"] !== keys.domainId || !Array.isArray(heads) || heads.length !== 1 || !identifier(heads[0], 32)) fail("map_heads");
    const selected = heads[0];
    return { map: await readMap(io, scope, keys, [keys.fileId, selected]), versionId: selected };
  } catch (error) { if (error instanceof RotationResealError) throw error; return fail("map"); }
}

function inventorySnapshot(input: readonly RotationHead[]): RotationHead[] {
  try {
    if (!Array.isArray(input) || input.length > HEADS_MAX) fail("inventory");
    const rows: RotationHead[] = []; let previous = "";
    for (const row of input) {
      if (!Array.isArray(row) || row.length !== 2 || !identifier(row[0], 16) || !identifier(row[1], 32)) fail("inventory");
      const position = row[0] + row[1];
      if (position <= previous) fail("inventory");
      previous = position; rows.push([row[0], row[1]]);
    }
    return rows;
  } catch { return fail("inventory"); }
}
async function noteId(key: Bytes, fileId: string): Promise<string> {
  return hex((await hmacSha256(key, concat(utf8("obsync/seal-v2/rotation-file\n"), unhex(fileId)))).subarray(0, 16));
}
async function controlId(key: Bytes, target: string): Promise<string> {
  return hex((await hmacSha256(key, utf8(`obsync/v1/pause/${target}`))).subarray(0, 16));
}

export class RotationResealer {
  private readonly destinations = new Map<string, string>();
  private readonly kinds = new Map<string, number>();
  private readonly heads: Set<string>;
  private constructor(private readonly io: RotationResealIO, private readonly old: OldRotationScope, private readonly next: NewRotationScope,
    private readonly oldMapKeys: DomainMapKeys, private readonly newMapKeys: DomainMapKeys, private readonly oldDomainId: string,
    readonly newDomainId: string, private readonly oldDomainKey: Bytes, private readonly oldManifestKey: Bytes,
    private readonly newDomainKey: Bytes, private readonly newManifestKey: Bytes, rows: readonly RotationHead[]) {
    this.heads = new Set(rows.map(row => row[0] + row[1]));
  }
  destination(oldFile: string): string { const id = this.destinations.get(oldFile); if (id === undefined) fail("reference"); return id; }
  private async entry(head: RotationHead, r: RecordBytes): Promise<Entry> {
    try {
      const entry = parseEntry(await text(this.old, this.oldManifestKey, head[0], this.oldDomainId, r, 1));
      const bound = { domain_id: this.oldDomainId, sids: r.sids, bytes: r.bytes, deleted: r.deleted };
      if (entry.v === 1) bindManifestToRecord(bound, entry, this.oldDomainId);
      else {
        bindFolderToRecord(bound, entry, this.oldDomainId);
        const expected = entry.v === 2 ? await folderFileId(this.oldManifestKey, entry.path) : await controlId(this.oldManifestKey, entry.target);
        if (head[0] !== expected) fail("source_identity");
      }
      return entry;
    } catch (error) { if (error instanceof RotationResealError) throw error; return fail("manifest"); }
  }
  static async plan(io: RotationResealIO, old: OldRotationScope, next: NewRotationScope, rows: RotationHead[]): Promise<RotationResealer> {
    old = oldSnapshot(old); next = nextSnapshot(next); rows = inventorySnapshot(rows);
    const oldMap = await sourceKeys(old), newMap = await domainMapKeys(next.root);
    if (newMap.fileId !== next.generation || next.generation === old.generation) fail("generation");
    const mapHeads = rows.filter(row => row[0] === oldMap.fileId);
    if (mapHeads.length !== 1) fail("map_heads");
    const map = await readMap(io, old, oldMap, mapHeads[0]!);
    const oldDomainId = soleDomain(map)!;
    const newDomainId = hex((await hmacSha256(newMap.key, utf8("obsync/seal-v2/rotation-domain"))).subarray(0, 16));
    const oldDomainKey = await deriveDomainKey(old.root, oldDomainId), newDomainKey = await deriveDomainKey(next.root, newDomainId);
    const self = new RotationResealer(io, old, next, oldMap, newMap, oldDomainId, newDomainId, oldDomainKey,
      await deriveManifestKey(oldDomainKey, oldDomainId), newDomainKey, await deriveManifestKey(newDomainKey, newDomainId), rows);
    self.destinations.set(oldMap.fileId, newMap.fileId); self.kinds.set(oldMap.fileId, 0);
    const owners = new Map([[newMap.fileId, oldMap.fileId]]), references = new Set<string>();
    for (const head of rows) {
      if (head[0] === oldMap.fileId) continue;
      const entry = await self.entry(head, await record(io, head, old.suite));
      let id: string;
      if (entry.v === 1) { id = await noteId(self.newManifestKey, head[0]); if (entry.keeper !== undefined) references.add(entry.keeper); }
      else if (entry.v === 2) id = await folderFileId(self.newManifestKey, entry.path);
      else { references.add(entry.target); id = await controlId(self.newManifestKey, await noteId(self.newManifestKey, entry.target)); }
      const previous = self.destinations.get(head[0]), owner = owners.get(id);
      if ((previous !== undefined && previous !== id) || (self.kinds.has(head[0]) && self.kinds.get(head[0]) !== entry.v)) fail("source_identity");
      if (owner !== undefined && owner !== head[0]) fail("destination_collision");
      self.destinations.set(head[0], id); self.kinds.set(head[0], entry.v); owners.set(id, head[0]);
    }
    for (const reference of references) if (self.kinds.get(reference) !== 1) fail("reference");
    return self;
  }
  /** Returns a deterministic post; coordinator owns its publication/readback/catalog. */
  async reseal(input: RotationHead): Promise<{ oldFile: string; oldVersion: string; newFile: string; newVersion: string; post: VersionPost }> {
    const selected = inventorySnapshot([input])[0]!;
    if (!this.heads.has(selected[0] + selected[1])) fail("inventory");
    try {
      const r = await record(this.io, selected, this.old.suite), newFile = this.destination(selected[0]);
      let json: string, sids: string[], deleted: boolean, bytes: number, kind: 1 | 2, domainId: string;
      if (selected[0] === this.oldMapKeys.fileId) {
        const map = await readMap(this.io, this.old, this.oldMapKeys, selected);
        json = serialiseDomainMap({ v: 1, domains: [{ id: this.newDomainId, paths: [...map.domains[0]!.paths] }] });
        sids = []; bytes = 0; deleted = false; kind = 2; domainId = this.newMapKeys.domainId;
      } else {
        const entry = await this.entry(selected, r);
        const mapped: Entry = { ...entry, domain: this.newDomainId, migration_origin: selected[0] + selected[1] };
        if (mapped.v === 1) {
          if (mapped.keeper !== undefined) mapped.keeper = this.destination(mapped.keeper);
          const chunks = [];
          if (entry.v !== 1) fail("manifest");
          if (entry.chunks.length > 1 && entry.sha256 !== "") fail("source_hash");
          for (const chunk of entry.chunks) {
            const received = await external(() => this.io.getChunk(chunk.sid), "source_chunk");
            if (!(received instanceof Uint8Array) || !(received.buffer instanceof ArrayBuffer) || received.length < 16 || received.length > CHUNK_CIPHERTEXT_MAX) fail("source_sid");
            const body = new Uint8Array(received);
            if (hex(await sha256(body)) !== chunk.sid) fail("source_sid");
            let plaintext: Bytes;
            try { plaintext = this.old.suite === 1 ? await decryptChunk(this.oldDomainKey, unhex(chunk.cid), body)
              : await decryptChunk2(this.oldDomainKey, { generation: this.old.generation, domainId: this.oldDomainId }, unhex(chunk.cid), body); }
            catch { return fail("source_chunk"); }
            if (plaintext.length !== chunk.len) fail("source_length");
            if (entry.chunks.length === 1 && entry.sha256 !== "" && hex(await sha256(plaintext)) !== entry.sha256) fail("source_hash");
            const sealed = await encryptChunk2(this.newDomainKey, { generation: this.next.generation, domainId: this.newDomainId }, plaintext);
            await external(() => this.io.putChunk(sealed.sid, sealed.ciphertext), "upload_chunk");
            const response = await external(() => this.io.getChunk(sealed.sid), "readback_chunk");
            if (!(response instanceof Uint8Array) || !(response.buffer instanceof ArrayBuffer) || response.length < 16 || response.length > CHUNK_CIPHERTEXT_MAX) fail("readback_sid");
            const returned = new Uint8Array(response);
            if (hex(await sha256(returned)) !== sealed.sid) fail("readback_sid");
            let checked: Bytes;
            try { checked = await decryptChunk2(this.newDomainKey, { generation: this.next.generation, domainId: this.newDomainId }, sealed.cid, returned); }
            catch { return fail("readback_chunk"); }
            if (!bytesEqual(checked, plaintext)) fail("readback_plaintext");
            chunks.push({ sid: sealed.sid, cid: hex(sealed.cid), len: plaintext.length });
          }
          mapped.chunks = chunks;
        } else if (mapped.v === 3) mapped.target = this.destination(mapped.target);
        json = JSON.stringify(mapped); sids = mapped.chunks.map(chunk => chunk.sid); bytes = mapped.size; deleted = mapped.deleted; kind = 1; domainId = this.newDomainId;
      }
      const key = kind === 2 ? this.newMapKeys.key : this.newManifestKey;
      const packet = await sealRecord(key, kind, { generation: this.next.generation, domainId, fileId: newFile, parents: [], sids }, utf8(json));
      const encoded = base64(packet); if (encoded.length > (1 << 20)) fail("manifest_budget");
      const newVersion = await versionId(newFile, [], packet, sids);
      return { oldFile: selected[0], oldVersion: selected[1], newFile, newVersion,
        post: { version_id: newVersion, parents: [], sids, bytes, domain_id: domainId, seal_suite: 2, manifest_ct: encoded, deleted, accept_existing: false } };
    } catch (error) { if (error instanceof RotationResealError) throw error; return fail("reseal"); }
  }
}

export async function planRotationReseal(io: RotationResealIO, oldInput: OldRotationScope, nextInput: NewRotationScope,
  input: readonly RotationHead[]): Promise<RotationResealer> {
  const old = oldSnapshot(oldInput), next = nextSnapshot(nextInput), rows = inventorySnapshot(input);
  try { return await RotationResealer.plan(io, old, next, rows); }
  catch (error) { if (error instanceof RotationResealError) throw error; return fail("plan"); }
}
