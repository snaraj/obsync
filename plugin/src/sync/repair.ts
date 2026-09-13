/** Restore missing ciphertext from a remembered local version, without posting a version. */
import { CHUNK_MAX, readFully } from "../chunker";
import { encryptChunk, hex, isHex, sha256 } from "../crypto";
import { FileRecord } from "../state";
import { assertSyncPath, inSyncScope } from "../syncScope";
import { SyncContext } from "./engine";
import { HistoryCancelled, HistoryOperation, historyManifest } from "./history";
import { Manifest } from "./push";

export const REPAIR_BATCH_SIDS = 64;
export const REPAIR_TICK_MS = 1000;
export const REPAIR_SCAN_MS = 5 * 60 * 1000;

export type RepairResult =
  | { kind: "idle" | "checked" | "skipped" }
  | { kind: "repaired"; bytes: number }
  | { kind: "unresolved"; reason: "missing_source" | "source_changed" | "range_read_unavailable" };

interface Candidate {
  path: string;
  record: FileRecord;
  manifest: Manifest;
  index: number;
  offset: number;
}

/**
 * One manifest and one chunk at a time. Each step audits at most 64 SIDs and
 * restores at most one chunk. The manifest stays cached between its batches.
 * Only remembered local versions are sources; this is not a server-wide
 * inventory or a guarantee that another device can supply unavailable bytes.
 */
export class ChunkRepair {
  private paths: Iterator<string> | null = null;
  private candidate: Candidate | null = null;
  private busy = false;
  private readonly operation: HistoryOperation;

  constructor(private readonly context: SyncContext, active: () => boolean = () => true) {
    const vrk = context.state.data.vrk;
    this.operation = new HistoryOperation(() => active() && context.state.data.vrk === vrk &&
      context.state.data.deviceId === context.deviceId);
  }

  cancel(): void { this.operation.cancel(); this.candidate = null; this.paths = null; }

  private check(path: string, record: FileRecord): void {
    this.operation.check();
    assertSyncPath(path, this.context.state.data.syncFolders);
    const current = this.context.state.fileByPath(path);
    if (!current || current.fileId !== record.fileId || current.versionId !== record.versionId ||
        current.mtime !== record.mtime || current.size !== record.size || current.sha256 !== record.sha256) {
      throw new HistoryCancelled();
    }
  }

  private async unchanged(candidate: Candidate): Promise<boolean> {
    const { path, record } = candidate;
    this.check(path, record);
    if (!(await this.context.host.syncable(path))) return false;
    this.check(path, record);
    const stat = await this.context.host.stat(path);
    this.check(path, record);
    return stat !== null && stat.size === record.size && stat.mtime === record.mtime;
  }

  private advance(candidate: Candidate, count: number): void {
    for (let i = 0; i < count; i++) {
      candidate.offset += candidate.manifest.chunks[candidate.index++]!.len;
    }
    if (candidate.index === candidate.manifest.chunks.length) this.candidate = null;
  }

  async step(): Promise<RepairResult> {
    // Sync now and the timer may meet while an earlier read/write settles.
    if (this.busy) return { kind: "skipped" };
    this.busy = true;
    try {
      this.operation.check();
      if (this.candidate === null) {
        this.paths ??= Object.keys(this.context.state.data.files)[Symbol.iterator]();
        const next = this.paths.next();
        if (next.done) { this.paths = null; return { kind: "idle" }; }
        const path = next.value;
        if (!inSyncScope(path, this.context.state.data.syncFolders)) return { kind: "skipped" };
        assertSyncPath(path, this.context.state.data.syncFolders);
        const saved = this.context.state.fileByPath(path);
        if (!saved || !isHex(saved.fileId, 16) || !isHex(saved.versionId, 32) || saved.fileId === this.context.mapFileId) {
          return { kind: "skipped" };
        }
        const record = { ...saved };
        this.check(path, record);
        const version = await this.context.transport.historyVersion(record.fileId, record.versionId, this.operation);
        this.check(path, record);
        const manifest = await historyManifest(this.context, record.fileId, this.context.domainId, record.versionId, version);
        this.check(path, record);
        if (manifest.deleted || manifest.path !== path || manifest.size !== record.size) {
          throw new Error("Repair version does not match the remembered local file.");
        }
        this.candidate = { path, record, manifest, index: 0, offset: 0 };
      }

      const candidate = this.candidate;
      const { path, record, manifest, index } = candidate;
      this.check(path, record);
      const batch = manifest.chunks.slice(index, index + REPAIR_BATCH_SIDS);
      const sids = [...new Set(batch.map((chunk) => chunk.sid))];
      const missing = await this.context.transport.missingChunks(sids);
      this.check(path, record);
      if (!Array.isArray(missing) || missing.length > sids.length || new Set(missing).size !== missing.length ||
          missing.some((sid) => !sids.includes(sid))) throw new Error("Invalid repair inventory response.");
      const first = batch.findIndex((chunk) => missing.includes(chunk.sid));
      if (first === -1) { this.advance(candidate, batch.length); return { kind: "checked" }; }
      this.advance(candidate, first);
      const chunk = manifest.chunks[candidate.index]!;

      if (this.context.host.supportsRangeReads !== true && record.size > CHUNK_MAX) {
        this.candidate = null;
        return { kind: "unresolved", reason: "range_read_unavailable" };
      }
      if (!(await this.unchanged(candidate))) {
        this.candidate = null;
        return { kind: "unresolved", reason: "missing_source" };
      }
      this.check(path, record);
      // Desktop serves bounded ranges. The existing mobile adapter may read
      // the whole local file internally; this chunk budget is not an RSS cap.
      const source = this.context.host.source(path, record.size);
      const plaintext = await readFully({ size: source.size, read: async (offset, length) => {
        this.check(path, record);
        return source.read(offset, length);
      } }, candidate.offset, chunk.len);
      this.check(path, record);
      if (!(await this.unchanged(candidate))) {
        this.candidate = null;
        return { kind: "unresolved", reason: "source_changed" };
      }
      const sealed = await encryptChunk(this.context.domainKey, plaintext);
      this.check(path, record);
      if (plaintext.length !== chunk.len || hex(sealed.cid) !== chunk.cid || sealed.sid !== chunk.sid) {
        this.candidate = null;
        return { kind: "unresolved", reason: "source_changed" };
      }
      // Check again after encryption, immediately before the only write.
      if (!(await this.unchanged(candidate))) {
        this.candidate = null;
        return { kind: "unresolved", reason: "source_changed" };
      }
      this.check(path, record);
      await this.context.transport.putChunk(chunk.sid, sealed.ciphertext);
      this.check(path, record);
      const restored = await this.context.transport.getChunk(chunk.sid, this.operation);
      this.check(path, record);
      if (hex(await sha256(restored)) !== chunk.sid) throw new Error("Repair readback did not match the retained ciphertext.");
      this.check(path, record);
      this.advance(candidate, 1);
      return { kind: "repaired", bytes: plaintext.length };
    } catch (error) {
      this.candidate = null;
      if (error instanceof HistoryCancelled) return { kind: "skipped" };
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
