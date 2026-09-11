/** Native retained-history reads and create-only recovery. No feed application. */
import { hex, isHex, randomBytes, unbase64, versionId } from "../crypto";
import { admit, admissionReason } from "../policy";
import { assertSyncPath, inSyncScope } from "../syncScope";
import { ReadControl, VersionRecord } from "../transport";
import { SyncContext, VaultStat } from "./engine";
import { decryptRecordManifest, writeVerified } from "./pull";
import { Manifest } from "./push";

export const HISTORY_SCAN_RECORDS = 20;
export const HISTORY_SCAN_MS = 5000;

export class HistoryCancelled extends Error {
  constructor() { super("History operation cancelled."); }
}

/** Cancellation races only reads, never an already dispatched local publication. */
export class HistoryOperation implements ReadControl {
  private stopped = false;
  private reject!: (error: Error) => void;
  private readonly cancellation = new Promise<never>((_resolve, reject) => { this.reject = reject; });
  constructor(private readonly active: () => boolean = () => true) {
    void this.cancellation.catch(() => undefined);
  }
  check(): void { if (this.stopped || !this.active()) throw new HistoryCancelled(); }
  cancel(): void { this.stopped = true; this.reject(new HistoryCancelled()); }
  async wait<T>(work: Promise<T>): Promise<T> {
    this.check();
    const result = await Promise.race([work, this.cancellation]);
    this.check();
    return result;
  }
}

export interface HistoryEntry {
  fileId: string;
  versionId: string;
  domainId: string;
  path: string;
  size: number;
  ts: number;
  deleted: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid history record.");
  return value as Record<string, unknown>;
}
function number(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function id(value: unknown, bytes: number): value is string { return typeof value === "string" && isHex(value, bytes); }
function ids(value: unknown, max: number): boolean { return Array.isArray(value) && value.length <= max && value.every((v: unknown) => id(v, 32)); }

/** Verify the exact immutable selection, not merely a manifest which decrypts. */
export async function historyManifest(context: SyncContext, fileId: string, domainId: string, expected: string, value: unknown): Promise<Manifest> {
  const r = object(value);
  if (!id(fileId, 16) || !id(domainId, 16) || !id(expected, 32) || r["version_id"] !== expected ||
      !ids(r["parents"], 64) || !ids(r["sids"], 65_536) || !number(r["bytes"]) || !number(r["ts"]) ||
      !id(r["device_id"], 16) || typeof r["deleted"] !== "boolean" || !id(r["manifest_nonce"], 12) ||
      typeof r["manifest_ct"] !== "string" || r["manifest_ct"].length > 1024 * 1024) throw new Error("Invalid history version.");
  const record = r as unknown as VersionRecord;
  if (await versionId(fileId, record.parents, unbase64(record.manifest_ct), record.sids) !== expected) throw new Error("History version identity mismatch.");
  const manifest = await decryptRecordManifest(context, { ...record, file_id: fileId, domain_id: domainId });
  // Row descriptors are bounded too; such a path cannot be a local file on
  // the supported platforms. Never hold unbounded display labels per row.
  if (manifest.path.length > 4096) throw new Error("History path exceeds the display/path budget.");
  return manifest;
}

export class HistoryBrowser {
  private cursor = 0;
  private boundary: number | null = null;
  done = false;
  constructor(readonly context: SyncContext, readonly operation: HistoryOperation, private readonly now = Date.now) {}

  /** Each click scans at most 20 records/requests, holding one full response. */
  async next(filter = ""): Promise<{ entries: HistoryEntry[]; scanned: number; refused: number; error?: string }> {
    const entries: HistoryEntry[] = [];
    let scanned = 0;
    let refused = 0;
    const started = this.now();
    try {
      while (!this.done && scanned < HISTORY_SCAN_RECORDS && (scanned === 0 || this.now() - started < HISTORY_SCAN_MS)) {
        this.operation.check();
        const page = object(await this.context.transport.historyChanges(this.cursor, this.operation));
        this.operation.check();
        const seq = page["seq"], head = page["head_seq"], changes = page["changes"];
        if (!number(seq) || !number(head) || seq < this.cursor || seq > head ||
            !Array.isArray(changes) || changes.length > 1 ||
            (this.boundary !== null && head < this.boundary) || (seq === this.cursor && seq < head)) throw new Error("History cursor did not progress safely.");
        if (this.boundary === null) this.boundary = head;
        const oldCursor = this.cursor;
        scanned++;
        for (const value of changes as unknown[]) {
          const r = object(value);
          if (!number(r["seq"]) || r["seq"] <= oldCursor || r["seq"] > seq) throw new Error("Invalid history sequence.");
          if (r["seq"] > this.boundary) continue;
          if (r["file_id"] === this.context.mapFileId) continue;
          try {
            if (!id(r["file_id"], 16) || !id(r["domain_id"], 16) || !id(r["version_id"], 32)) throw new Error("Invalid history identity.");
            const manifest = await historyManifest(this.context, r["file_id"], r["domain_id"], r["version_id"], r);
            this.operation.check();
            if (!manifest.path.toLowerCase().includes(filter.toLowerCase())) continue;
            entries.push({ fileId: r["file_id"], versionId: r["version_id"], domainId: r["domain_id"],
              path: manifest.path, size: manifest.size, deleted: manifest.deleted, ts: r["ts"] as number });
          } catch (error) {
            this.operation.check();
            refused++;
            this.context.host.log("history path_class=manifest decision=refused");
          }
        }
        this.cursor = Math.min(seq, this.boundary);
        this.done = seq >= this.boundary;
      }
      return { entries, scanned, refused };
    } catch (error) {
      this.operation.check();
      if (entries.length === 0) throw error;
      // A later read failure must not hide rows whose cursor already moved.
      return { entries, scanned, refused, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.context.host.log(`history decision=batch scanned=${scanned} refused=${refused} budget_records=${HISTORY_SCAN_RECORDS} budget_ms=${HISTORY_SCAN_MS} duration_ms=${this.now() - started}`);
    }
  }
}

/** Any error after dispatching a create may leave a complete local copy. */
export class CopyPublicationError extends Error {
  constructor(readonly path: string) { super(`A restored copy may exist at "${path}". Check that path before retrying; no existing file was overwritten.`); }
}

export function restoreCopyPath(path: string, suffix = hex(randomBytes(16))): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  // Bound the derived component in UTF-8, including a long extension.
  const label = ` (restored-${suffix})`;
  const stem = Array.from(dot > 0 ? name.slice(0, dot) : name);
  while (new TextEncoder().encode(stem.join("") + label + ext).length > 240 && stem.length > 0) stem.pop();
  if (stem.length === 0) throw new Error("The historical filename is too long to restore beside it.");
  return path.slice(0, slash + 1) + stem.join("") + label + ext;
}

function remembered(context: SyncContext, path: string): boolean {
  return context.state.fileByPath(path) !== undefined || Object.values(context.state.data.remoteOnly).some((r) => r.path === path);
}

/** True current scoped inventory, including local files not yet uploaded. */
async function inventory(context: SyncContext, operation: HistoryOperation): Promise<number> {
  let used = 0;
  for (const file of await context.host.list()) {
    operation.check();
    if (!inSyncScope(file.path, context.state.data.syncFolders)) continue;
    if (!(await context.host.syncable(file.path))) continue;
    const stat = await context.host.stat(file.path);
    operation.check();
    if (stat) {
      if (!number(stat.size)) throw new Error("Local byte inventory is not measurable.");
      used += stat.size;
    }
    if (!number(used)) throw new Error("Local byte inventory is not measurable.");
  }
  return used;
}

/** Caller owns/drains local writers and must enqueue the new untracked path afterwards. */
export async function restoreCopy(browser: HistoryBrowser, entry: HistoryEntry): Promise<VaultStat> {
  const { context, operation } = browser;
  const started = Date.now();
  operation.check();
  assertSyncPath(entry.path, context.state.data.syncFolders);
  if (!id(entry.fileId, 16) || !id(entry.versionId, 32) || entry.domainId !== context.domainId) throw new Error("Invalid history selection.");
  const version = await context.transport.historyVersion(entry.fileId, entry.versionId, operation);
  const manifest = await historyManifest(context, entry.fileId, entry.domainId, entry.versionId, version);
  operation.check();
  if (manifest.deleted || manifest.path !== entry.path) throw new Error("Select a retained content version, not a deletion marker.");
  let used = await inventory(context, operation);
  const check = (): void => {
    operation.check();
    assertSyncPath(manifest.path, context.state.data.syncFolders);
    const admission = admit(context.state.data.policy, used, manifest.size);
    if (!admission.ok) throw new Error(`Restore refused: ${admissionReason(context.state.data.policy, admission.reason)}.`);
  };
  check();
  for (let attempt = 0; attempt < 3; attempt++) {
    const path = restoreCopyPath(manifest.path);
    assertSyncPath(path, context.state.data.syncFolders);
    if (remembered(context, path) || await context.host.stat(path) !== null) continue;
    const guard = (): void => {
      check();
      assertSyncPath(path, context.state.data.syncFolders);
      if (remembered(context, path)) throw new Error("The proposed copy path is already tracked; retry with a new name.");
    };
    guard();
    const writer = await context.host.createWriter(path, manifest.size, guard);
    let published = false;
    try {
      await writeVerified(context, manifest, writer, operation);
      used = await inventory(context, operation);
      guard();
      const stat = await writer.commit(manifest.mtime);
      published = true;
      // Publication may have finished after cancellation. Preserve it and
      // return its identity before considering any further asynchronous work.
      context.host.log(`history decision=copy_created bytes=${stat.size} duration_ms=${Date.now() - started}`);
      return stat;
    } catch (error) {
      if (published) throw new CopyPublicationError(path);
      throw error;
    } finally {
      try { await writer.abort(); } catch (error) {
        // Cleanup is confined to the owned temp. A later failure must still
        // name the already published copy, never imply that it was removed.
        if (published) throw new CopyPublicationError(path);
        throw error;
      }
    }
  }
  throw new Error("No unoccupied, untracked sibling name was available. Retry to choose a new name.");
}
