/** Restore missing ciphertext from a remembered local version, without posting a version. */
import { CHUNK_MAX, readFully } from "../chunker";
import { encryptChunk, hex, isHex, sha256 } from "../crypto";
import { FileRecord } from "../state";
import { ApiError } from "../transport";
import { assertSyncPath, inSyncScope } from "../syncScope";
import { SyncContext } from "./engine";
import { HistoryCancelled, HistoryOperation, historyManifest } from "./history";
import { Manifest, sidDigest } from "./push";
import { ManifestError } from "./pull";

export const REPAIR_BATCH_SIDS = 64;
/** Remembered sids asked about at once: the route's own cap (`docs/protocol.md`, `POST /v1/chunks/exists`). */
export const REPAIR_EXISTS_SIDS = 4096;
export const REPAIR_TICK_MS = 1000;
/** How soon a walk a failure deferred is tried again: what the repair error promises the person. */
export const REPAIR_SCAN_MS = 5 * 60 * 1000;
/**
 * How long after a complete walk the next one starts (issue #198). The walk
 * read every remembered version back, two signed requests a note, and began
 * again five minutes after it ended: about 7,000 requests an hour from an
 * idle 10,000-note vault, on every device. It asks about remembered sids
 * instead, 4,096 to a request, and a chunk the server lost is still found by
 * the next walk and put back.
 */
export const REPAIR_WALK_MS = 6 * 60 * 60 * 1000;

export type RepairResult =
  | { kind: "idle" | "checked" | "skipped" }
  | { kind: "repaired"; bytes: number }
  /** The server holds no such version: a restored server, or retention (#145). */
  | { kind: "lost"; fileId: string; ts?: number }
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
 *
 * A ONE-CHUNK FILE WHOSE SID THIS DEVICE REMEMBERS IS ASKED ABOUT WITH THE
 * OTHERS (issue #198): up to 4,096 remembered sids are one existence question,
 * and only a record whose sid the server does not hold has its version read
 * back, to go the way every other record goes. A record with no sid
 * remembered yet is read back too, and teaches the next walk its sid when the
 * server holds everything it names.
 */
export class ChunkRepair {
  private paths: Iterator<string> | null = null;
  /**
   * Records the last existence question passed on, to be read back one a
   * step: those whose remembered sid the server does not hold first, then
   * those with none remembered.
   */
  private readonly later: string[] = [];
  private candidate: Candidate | null = null;
  private busy = false;
  private readonly operation: HistoryOperation;
  /** What the walk in progress did, for the one line the engine writes when it ends. */
  walk = { started: 0, batched: 0, requests: 0, missing: 0, learned: 0 };

  constructor(private readonly context: SyncContext, active: () => boolean = () => true) {
    const vrk = context.state.data.vrk;
    this.operation = new HistoryOperation(() => active() && context.state.data.vrk === vrk &&
      context.state.data.deviceId === context.deviceId);
  }

  cancel(): void { this.operation.cancel(); this.candidate = null; this.paths = null; this.later.length = 0; }

  /** The next record of the walk, starting one when none runs; `null` when it is complete. */
  private next(): string | null {
    if (this.paths === null) {
      this.paths = Object.keys(this.context.state.data.files)[Symbol.iterator]();
      this.walk = { started: this.context.now(), batched: 0, requests: 0, missing: 0, learned: 0 };
    }
    const next = this.paths.next();
    return next.done === true ? null : next.value;
  }

  /** The record's one chunk, when it remembers one that is still its version's (`FileRecord.sid`). */
  private async known(record: FileRecord): Promise<string | null> {
    const sid = record.sid;
    if (sid === undefined || !isHex(sid, 32)) return null;
    return (await sidDigest([sid])) === record.sha256 ? sid : null;
  }

  /**
   * One existence question for the remembered sids of the walk from `path`
   * on, up to `REPAIR_EXISTS_SIDS`. A record out of the selection or unusable
   * is passed over, as its own step would; one with no sid remembered is
   * read back later (`later`).
   */
  private async batch(path: string, sid: string): Promise<void> {
    const asked = new Map<string, string[]>([[sid, [path]]]);
    const unknown: string[] = [];
    while (asked.size < REPAIR_EXISTS_SIDS) {
      const next = this.next();
      if (next === null) break;
      const saved = inSyncScope(next, this.context.state.data.syncFolders) ? this.context.state.fileByPath(next) : undefined;
      if (saved === undefined || !this.usable(saved)) continue;
      const known = await this.known(saved);
      if (known === null) unknown.push(next);
      else asked.set(known, [...(asked.get(known) ?? []), next]);
    }
    const sids = [...asked.keys()];
    const missing = await this.context.transport.missingChunks(sids, { signal: this.context.signal });
    this.operation.check();
    this.inventory(missing, sids);
    for (const gone of missing) this.later.push(...(asked.get(gone) ?? []));
    this.later.push(...unknown);
    this.walk.batched += sids.length;
    this.walk.requests++;
    this.walk.missing += missing.length;
  }

  private usable(record: FileRecord): boolean {
    return isHex(record.fileId, 16) && isHex(record.versionId, 32) && record.fileId !== this.context.mapFileId;
  }

  /** An existence answer names only sids it was asked about, each once. */
  private inventory(missing: unknown, sids: string[]): asserts missing is string[] {
    const asked = new Set(sids);
    if (!Array.isArray(missing) || missing.length > sids.length || new Set(missing).size !== missing.length ||
        missing.some((sid) => !asked.has(sid as string))) throw new Error("Invalid repair inventory response.");
  }

  /** Remember the sid of a one-chunk version the server holds all of, for the next walk's batch. */
  private async learn(path: string, record: FileRecord, sid: string): Promise<void> {
    const current = this.context.state.fileByPath(path);
    if (current === undefined || current.versionId !== record.versionId || current.sid === sid ||
        (await sidDigest([sid])) !== current.sha256) return;
    current.sid = sid;
    this.walk.learned++;
  }

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

  /**
   * Take up the record at `path`: skip it, ask about its remembered sid with
   * its neighbours (`batch`), or read its version back and make it the
   * candidate, answering `null`. `readBack` is a record an existence question
   * passed on (`later`), which is always read back.
   */
  private async open(path: string, readBack: boolean): Promise<RepairResult | null> {
    if (!inSyncScope(path, this.context.state.data.syncFolders)) return { kind: "skipped" };
    assertSyncPath(path, this.context.state.data.syncFolders);
    const saved = this.context.state.fileByPath(path);
    if (!saved || !this.usable(saved)) return { kind: "skipped" };
    const record = { ...saved };
    this.check(path, record);
    // Remembered: asked about with the others, and read back only when missing.
    if (!readBack) {
      const sid = await this.known(record);
      if (sid !== null) {
        await this.batch(path, sid);
        // The first record it passed on is read back in this same step.
        const next = this.later.shift();
        return next === undefined ? { kind: "checked" } : await this.open(next, true);
      }
    }
    const version = await this.context.transport.historyVersion(record.fileId, record.versionId, this.operation)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "unknown_version") return null;
        throw error;
      });
    if (version === null) return { kind: "lost", fileId: record.fileId, ...(record.ts === undefined ? {} : { ts: record.ts }) };
    this.check(path, record);
    let manifest: Manifest;
    try {
      manifest = await historyManifest(this.context, record.fileId, this.context.domainId, record.versionId, version);
    } catch (error) {
      // SEALED UNDER A KEY THIS DEVICE NO LONGER HOLDS: this device made a
      // new vault key after it recorded the file, so the record belongs to
      // the vault it left and there is nothing here to repair it with
      // (#160, #177). Not a failure, and not the person's to act on.
      if (!(error instanceof ManifestError && error.reason === "undecryptable")) throw error;
      this.context.host.log(`repair decision=skipped reason=other_key file=${record.fileId}`);
      return { kind: "skipped" };
    }
    this.check(path, record);
    // THE NAME IS NOT PART OF WHAT IS REPAIRED (#160). Chunk presence is a
    // fact about the version, whatever this device calls the note -- a
    // folder typed in another case, a name the two devices disagree on, a
    // note beside its name (`pull.ts`, `settleBeside`, #149) -- so a
    // different path is verified by the version. A version that is not the
    // remembered file at all is skipped, and said.
    if (manifest.deleted || manifest.size !== record.size) {
      this.context.host.log(`repair decision=skipped reason=version_mismatch file=${record.fileId}`);
      return { kind: "skipped" };
    }
    this.candidate = { path, record, manifest, index: 0, offset: 0 };
    return null;
  }

  async step(): Promise<RepairResult> {
    // Sync now and the timer may meet while an earlier read/write settles.
    if (this.busy) return { kind: "skipped" };
    this.busy = true;
    try {
      this.operation.check();
      if (this.candidate === null) {
        const later = this.later.shift();
        const path = later ?? this.next();
        if (path === null) { this.paths = null; return { kind: "idle" }; }
        const opened = await this.open(path, later !== undefined);
        if (opened !== null) return opened;
      }

      // Set by `open` when it answered nothing.
      const candidate = this.candidate as Candidate;
      const { path, record, manifest, index } = candidate;
      this.check(path, record);
      const batch = manifest.chunks.slice(index, index + REPAIR_BATCH_SIDS);
      const sids = [...new Set(batch.map((chunk) => chunk.sid))];
      const missing = await this.context.transport.missingChunks(sids, { signal: this.context.signal });
      this.check(path, record);
      this.inventory(missing, sids);
      const first = batch.findIndex((chunk) => missing.includes(chunk.sid));
      if (first === -1) {
        this.advance(candidate, batch.length);
        if (manifest.chunks.length === 1) await this.learn(path, record, (manifest.chunks[0] as { sid: string }).sid);
        return { kind: "checked" };
      }
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
