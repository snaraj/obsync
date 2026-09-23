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
/**
 * How long ONE user action keeps stepping when a filename filter is set.
 *
 * Without it the dialog was a page-turner: 20 versions per click, oldest
 * first, on a journal of a few thousand records, which is ~300 clicks to
 * reach a note deleted yesterday (issue #102). The per-step bound is right --
 * it bounds one click's network work and is the unit of cancellation -- it
 * was just also the unit of USER effort. A filter says the user is looking
 * for one note, not reading pages, so the steps run themselves until the
 * first match, the end of the journal, a cancel, or this budget.
 */
export const HISTORY_SEARCH_MS = 60_000;

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

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Journal positions this call consumed: the per-step bound, per call. */
  scanned: number;
  refused: number;
  /** Journal positions consumed since this browser opened. */
  checked: number;
  /** About how many the journal holds, from the head this browser captured. */
  about: number;
  error?: string;
}

export interface HistoryOrder {
  /** Newest first, which is where a deletion the user noticed almost always is. */
  newestFirst?: boolean;
  now?: () => number;
}

/**
 * The retained journal, walked in bounded steps.
 *
 * NEWEST FIRST OVER A FORWARD-ONLY CURSOR. `GET /v1/changes?since=N&limit=1`
 * is the only read there is: it answers "the first record after N", so there
 * is no way to ask for the record BEFORE one. Newest-first is therefore a
 * descending walk over WINDOWS: a window of `HISTORY_SCAN_RECORDS` sequence
 * numbers can hold at most that many records, so scanning one window forward
 * costs one step's bound and yields one step's rows, which are then shown in
 * reverse. Each window ends where the last one began, so nothing is skipped
 * and nothing is read twice. A sparse window costs one request and no rows,
 * and the automatic search simply moves on to the next.
 */
export class HistoryBrowser {
  /** Oldest-first: the exclusive LOWER bound already shown. */
  private cursor = 0;
  /** Newest-first: the exclusive UPPER bound already shown. */
  private floor: number | null = null;
  private boundary: number | null = null;
  private readonly now: () => number;
  readonly newestFirst: boolean;
  done = false;
  /** Journal positions consumed since this browser opened. */
  checked = 0;
  constructor(readonly context: SyncContext, readonly operation: HistoryOperation, order: HistoryOrder = {}) {
    this.newestFirst = order.newestFirst ?? true;
    this.now = order.now ?? Date.now;
  }

  /** About how many records the journal holds: the head this device knows. */
  get about(): number {
    return this.boundary ?? this.context.state.data.lastSeq;
  }

  /**
   * One `limit=1` page, with every cursor claim checked before it is used.
   * The server chooses `seq` and `head_seq`; neither may move a cursor
   * backwards, past the head, or past the boundary this browser captured.
   */
  private async read(since: number): Promise<{ seq: number; change: Record<string, unknown> | null }> {
    this.operation.check();
    const page = object(await this.context.transport.historyChanges(since, this.operation));
    this.operation.check();
    this.checked++;
    const seq = page["seq"], head = page["head_seq"], changes = page["changes"];
    if (!number(seq) || !number(head) || seq < since || seq > head ||
        !Array.isArray(changes) || changes.length > 1 ||
        (this.boundary !== null && head < this.boundary) ||
        (seq === since && seq < head)) throw new Error("History cursor did not progress safely.");
    if (this.boundary === null) this.boundary = head;
    const first = (changes as unknown[])[0];
    if (first === undefined) return { seq, change: null };
    const record = object(first);
    if (!number(record["seq"]) || record["seq"] <= since || record["seq"] > seq) {
      throw new Error("Invalid history sequence.");
    }
    return { seq, change: record };
  }

  /** Decrypt one record and keep it when it matches, or count the refusal. */
  private async take(
    record: Record<string, unknown>,
    filter: string,
    out: HistoryEntry[],
    counts: { refused: number },
  ): Promise<void> {
    if (record["file_id"] === this.context.mapFileId) return;
    try {
      if (!id(record["file_id"], 16) || !id(record["domain_id"], 16) || !id(record["version_id"], 32)) {
        throw new Error("Invalid history identity.");
      }
      const manifest = await historyManifest(this.context, record["file_id"], record["domain_id"], record["version_id"], record);
      this.operation.check();
      if (!manifest.path.toLowerCase().includes(filter.toLowerCase())) return;
      out.push({ fileId: record["file_id"], versionId: record["version_id"], domainId: record["domain_id"],
        path: manifest.path, size: manifest.size, deleted: manifest.deleted, ts: record["ts"] as number });
    } catch {
      this.operation.check();
      counts.refused++;
      this.context.host.log("history path_class=manifest decision=refused");
    }
  }

  /** Oldest first: at most 20 records/requests, for up to 5 seconds. */
  private async stepUp(filter: string, out: HistoryEntry[], counts: { scanned: number; refused: number }): Promise<void> {
    const started = this.now();
    let taken = 0;
    while (!this.done && taken < HISTORY_SCAN_RECORDS && (taken === 0 || this.now() - started < HISTORY_SCAN_MS)) {
      const { seq, change } = await this.read(this.cursor);
      taken++;
      counts.scanned++;
      const boundary = this.boundary as number;
      if (change !== null && (change["seq"] as number) <= boundary) await this.take(change, filter, out, counts);
      this.cursor = Math.min(seq, boundary);
      this.done = seq >= boundary;
    }
  }

  /** Newest first: one descending window, shown in reverse. */
  private async stepDown(filter: string, out: HistoryEntry[], counts: { scanned: number; refused: number }): Promise<void> {
    if (this.boundary === null) {
      // One request to learn the head the whole walk is measured against. Its
      // record is the OLDEST one and belongs to the last window, so it is
      // counted and discarded rather than decrypted out of order.
      await this.read(0);
      counts.scanned++;
    }
    const boundary = this.boundary as number;
    if (this.floor === null) this.floor = boundary + 1;
    const from = Math.max(0, this.floor - 1 - HISTORY_SCAN_RECORDS);
    const window: Record<string, unknown>[] = [];
    let cursor = from;
    while (cursor < this.floor - 1) {
      const { seq, change } = await this.read(cursor);
      counts.scanned++;
      if (change !== null && (change["seq"] as number) < this.floor) window.push(change);
      cursor = seq;
      if (change === null) break;
    }
    this.floor = from + 1;
    this.done = from === 0;
    for (const record of window.reverse()) await this.take(record, filter, out, counts);
  }

  /**
   * One user action.
   *
   * With no filter this is one bounded step. With a filter it keeps stepping
   * until the first match, the end of the journal, a cancel, or
   * `HISTORY_SEARCH_MS` -- the per-step bound stays the unit of cancellation,
   * it is no longer the unit of clicking.
   */
  async next(filter = ""): Promise<HistoryPage> {
    const entries: HistoryEntry[] = [];
    const counts = { scanned: 0, refused: 0 };
    const started = this.now();
    const budget = filter === "" ? 0 : HISTORY_SEARCH_MS;
    this.context.host.log(
      `history decision=start order=${this.newestFirst ? "newest_first" : "oldest_first"} filtered=${filter !== ""} ` +
        `checked=${this.checked} about=${this.about} budget_ms=${budget} budget_records=${HISTORY_SCAN_RECORDS}`,
    );
    let error: string | undefined;
    try {
      do {
        if (this.newestFirst) await this.stepDown(filter, entries, counts);
        else await this.stepUp(filter, entries, counts);
      } while (entries.length === 0 && !this.done && budget > 0 && this.now() - started < budget);
    } catch (failure) {
      this.operation.check();
      // A later read failure must not hide rows whose cursor already moved.
      if (entries.length === 0) throw failure;
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.context.host.log(
        `history decision=summary scanned=${counts.scanned} matches=${entries.length} refused=${counts.refused} ` +
          `checked=${this.checked} about=${this.about} budget_ms=${budget} budget_records=${HISTORY_SCAN_RECORDS} ` +
          `duration_ms=${this.now() - started}`,
      );
    }
    return { entries, scanned: counts.scanned, refused: counts.refused, checked: this.checked, about: this.about, error };
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
    let outcome: { stat: VaultStat } | { failure: unknown };
    try {
      await writeVerified(context, manifest, writer, operation);
      used = await inventory(context, operation);
      guard();
      const stat = await writer.commit(manifest.mtime);
      published = true;
      // Publication may have finished after cancellation. Preserve it and
      // return its identity before considering any further asynchronous work.
      context.host.log(`history decision=copy_created bytes=${stat.size} duration_ms=${Date.now() - started}`);
      outcome = { stat };
    } catch (error) {
      outcome = { failure: published ? new CopyPublicationError(path) : error };
    }
    // Cleanup is confined to the owned temp, and runs on both paths. A failure
    // here must still name the already published copy, never imply that it
    // was removed; it outranks whatever the copy itself reported.
    try {
      await writer.abort();
    } catch (error) {
      throw published ? new CopyPublicationError(path) : error;
    }
    if ("failure" in outcome) throw outcome.failure;
    return outcome.stat;
  }
  throw new Error("No unoccupied, untracked sibling name was available. Retry to choose a new name.");
}
