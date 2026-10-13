/** Native retained-history reads and create-only recovery. No feed application. */
import { decryptChunk, deriveDomainKey, deriveManifestKey, hex, isHex, randomBytes, sha256, unbase64, unhex, versionId } from "../crypto";
import { soleDomain } from "../domainmap";
import { preflightRotationMap } from "../rotationReseal";
import { admit, admissionReason } from "../policy";
import { assertSyncPath, inSyncScope } from "../syncScope";
import { readManifestSeal2 } from "../sealWire";
import { decryptChunk2, openRecord } from "../seal2";
import { ReadControl, VersionRecord } from "../transport";
import { SyncContext, VaultStat, VaultWriter } from "./engine";
import { bindManifestToRecord, decryptLegacyRecordManifest, decryptRecordManifest, parseManifest, writeVerified } from "./pull";
import { Manifest } from "./push";

/**
 * How many retained versions one step reads and checks (issue #199): ONE page
 * of the journal, where each version was a request of its own -- twenty round
 * trips a click, and a thousand for a search that went a thousand versions
 * back. A 1.1.4 server ends a page at 8 MiB whatever this asks
 * (`historyChanges`), so a step is one request, and two only for pages of
 * unusually large records.
 */
export const HISTORY_SCAN_RECORDS = 100;
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

class HistoryLimit extends Error {}

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

/** Validate immutable selection independently of the explicitly selected decoder. */
function selectedVersion(fileId: string, domainId: string, expected: string, value: unknown): VersionRecord {
  const r = object(value);
  if (!id(fileId, 16) || !id(domainId, 16) || !id(expected, 32) || r["version_id"] !== expected ||
      !ids(r["parents"], 64) || !ids(r["sids"], 65_536) || !number(r["bytes"]) || !number(r["ts"]) ||
      !id(r["device_id"], 16) || typeof r["deleted"] !== "boolean" ||
      typeof r["manifest_ct"] !== "string" || r["manifest_ct"].length > 1024 * 1024) throw new Error("Invalid history version.");
  return r as unknown as VersionRecord;
}

/** Suite-2 retained history; old records never trigger another decoder. */
export async function historyManifest(context: SyncContext, fileId: string, domainId: string, expected: string, value: unknown): Promise<Manifest> {
  const record = selectedVersion(fileId, domainId, expected, value);
  let packet;
  try { packet = readManifestSeal2(record); } catch { throw new Error("Invalid history version."); }
  if (await versionId(fileId, record.parents, packet, record.sids) !== expected) throw new Error("History version identity mismatch.");
  const manifest = await decryptRecordManifest(context, { ...record, file_id: fileId, domain_id: domainId });
  if (manifest.path.length > 4096) throw new Error("History path exceeds the display/path budget.");
  return manifest;
}

/** Caller explicitly supplies the old-root context for history/reseed only. */
export async function legacyHistoryManifest(context: SyncContext, fileId: string, domainId: string, expected: string, value: unknown): Promise<Manifest> {
  const record = selectedVersion(fileId, domainId, expected, value);
  if ("seal_suite" in record || !id(record.manifest_nonce, 12)) throw new Error("Invalid legacy history seal.");
  if (await versionId(fileId, record.parents, unbase64(record.manifest_ct), record.sids) !== expected) throw new Error("History version identity mismatch.");
  const manifest = await decryptLegacyRecordManifest(context, { ...record, file_id: fileId, domain_id: domainId });
  if (manifest.path.length > 4096) throw new Error("History path exceeds the display/path budget.");
  return manifest;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Journal records this call read: the per-step bound, per call. */
  scanned: number;
  refused: number;
  /** Journal records read since this browser opened. */
  checked: number;
  /** About how many the journal holds, from the head this browser captured. */
  about: number;
  error?: string;
}

export interface HistoryOrder {
  /** Newest first, which is where a deletion the user noticed almost always is. */
  newestFirst?: boolean;
  now?: () => number;
  /** Explicit retained key only; never selected in response to a decrypt failure. */
  previous?: { root: string; generation: string; suite: 1 | 2 };
}

/**
 * The retained journal, walked in bounded steps.
 *
 * NEWEST FIRST OVER A FORWARD-ONLY CURSOR. `GET /v1/changes?since=N` is the
 * only read there is: it answers "the records after N", so there is no way to
 * ask for the record BEFORE one. Newest-first is therefore a descending walk
 * over WINDOWS: a window of `HISTORY_SCAN_RECORDS` sequence numbers can hold
 * at most that many records, so one page read forward from its start covers
 * it and yields one step's rows, which are then shown in reverse. Each window
 * ends where the last one began, so nothing is skipped and nothing is shown
 * twice; what a sparse window's page brings from above it is discarded, and
 * the automatic search simply moves on to the next.
 */
export class HistoryBrowser {
  /** Oldest-first: the exclusive LOWER bound already shown. */
  private cursor = 0;
  /** Newest-first: the exclusive UPPER bound already shown. */
  private floor: number | null = null;
  private boundary: number | null = null;
  private readonly now: () => number;
  private readonly previous: HistoryOrder["previous"];
  private previousContext: SyncContext | null = null;
  private sourceDone = false;
  private readonly ancestry: [string, string][] = [];
  private readonly visited = new Set<string>();
  readonly newestFirst: boolean;
  done = false;
  /** Journal records read since this browser opened. */
  checked = 0;
  constructor(readonly context: SyncContext, readonly operation: HistoryOperation, order: HistoryOrder = {}) {
    this.newestFirst = order.newestFirst ?? true;
    this.now = order.now ?? Date.now;
    this.previous = order.previous === undefined ? undefined : { ...order.previous };
  }

  /** About how many records the journal holds: the head this device knows. */
  get about(): number {
    return this.boundary ?? this.context.state.data.lastSeq;
  }

  /**
   * One page of at most `limit` records, with every cursor claim checked
   * before it is used. The server chooses `seq` and `head_seq`; neither may
   * move a cursor backwards, past the head, or past the boundary this browser
   * captured, and each record lies after the one before it, up to `seq`.
   */
  private async read(since: number, limit: number): Promise<{ seq: number; changes: Record<string, unknown>[] }> {
    this.operation.check();
    const page = object(await this.context.transport.historyChanges(since, this.operation, limit));
    this.operation.check();
    const seq = page["seq"], head = page["head_seq"], changes = page["changes"];
    if (!number(seq) || !number(head) || seq < since || seq > head ||
        !Array.isArray(changes) || changes.length > limit ||
        (this.boundary !== null && head < this.boundary) ||
        (seq === since && seq < head)) throw new Error("History cursor did not progress safely.");
    if (this.boundary === null) this.boundary = head;
    let after = since;
    const records = (changes as unknown[]).map((change) => {
      const record = object(change);
      if (!number(record["seq"]) || record["seq"] <= after || record["seq"] > seq) {
        throw new Error("Invalid history sequence.");
      }
      after = record["seq"];
      return record;
    });
    return { seq, changes: records };
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
      if (this.previous) {
        if (manifest.migration_origin !== undefined) this.enqueue(manifest.migration_origin.slice(0, 32), manifest.migration_origin.slice(32));
        return;
      }
      if (!manifest.path.toLowerCase().includes(filter.toLowerCase())) return;
      out.push({ fileId: record["file_id"], versionId: record["version_id"], domainId: record["domain_id"],
        path: manifest.path, size: manifest.size, deleted: manifest.deleted, ts: record["ts"] as number });
    } catch (error) {
      if (error instanceof HistoryLimit) throw error;
      this.operation.check();
      counts.refused++;
      this.context.host.log("history path_class=manifest decision=refused");
    }
  }

  /** Oldest first: at most `HISTORY_SCAN_RECORDS` records, a page at a time, for up to 5 seconds. */
  private async stepUp(filter: string, out: HistoryEntry[], counts: { scanned: number; refused: number }): Promise<void> {
    const started = this.now();
    let taken = 0;
    while (!this.done && taken < HISTORY_SCAN_RECORDS && (taken === 0 || this.now() - started < HISTORY_SCAN_MS)) {
      const { seq, changes } = await this.read(this.cursor, HISTORY_SCAN_RECORDS - taken);
      // An empty page still spends one: every request is bounded, not only every record.
      taken += Math.max(1, changes.length);
      counts.scanned += changes.length;
      const boundary = this.boundary as number;
      for (const change of changes) if ((change["seq"] as number) <= boundary) await this.take(change, filter, out, counts);
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
      counts.scanned += (await this.read(0, 1)).changes.length;
    }
    const boundary = this.boundary as number;
    if (this.floor === null) this.floor = boundary + 1;
    const from = Math.max(0, this.floor - 1 - HISTORY_SCAN_RECORDS);
    const window: Record<string, unknown>[] = [];
    let cursor = from;
    while (cursor < this.floor - 1) {
      const { seq, changes } = await this.read(cursor, HISTORY_SCAN_RECORDS);
      for (const change of changes) if ((change["seq"] as number) < this.floor) window.push(change);
      cursor = seq;
    }
    counts.scanned += window.length;
    this.floor = from + 1;
    this.done = from === 0;
    for (const record of window.reverse()) await this.take(record, filter, out, counts);
  }

  private enqueue(file: string, version: string): void {
    if (!id(file, 16) || !id(version, 32)) throw new Error("Invalid previous-generation history pointer.");
    const key = file + version;
    if (this.visited.has(key)) return;
    if (this.visited.size >= 65_536) throw new HistoryLimit("Previous-generation history exceeds this browser's 65,536-version limit.");
    this.visited.add(key); this.ancestry.push([file, version]);
  }

  private async selectedContext(): Promise<SyncContext> {
    this.operation.check();
    if (!this.previous) return this.context;
    if (this.previousContext) return this.previousContext;
    const { transport } = this.context, control = this.operation;
    const root = unhex(this.previous.root);
    const { map } = await preflightRotationMap({
      getFile: id => transport.historyFile(id, control),
      getVersion: (file, version) => transport.historyVersion(file, version, control),
      getChunk: sid => transport.getChunk(sid, control),
      putChunk: async () => { throw new Error("History cannot publish remote data."); },
    }, { ...this.previous, root });
    control.check();
    const domainId = soleDomain(map)!;
    const domainKey = await deriveDomainKey(root, domainId), manifestKey = await deriveManifestKey(domainKey, domainId);
    control.check();
    this.previousContext = { ...this.context, domainId, domainKey, manifestKey,
      generation: this.previous.generation, mapFileId: this.previous.generation };
    return this.previousContext;
  }

  private async decodeSelection(context: SyncContext, file: string, version: string, record: unknown): Promise<Manifest> {
    if (!this.previous) return historyManifest(context, file, context.domainId, version, record);
    let manifest: Manifest;
    if (this.previous.suite === 1) manifest = await legacyHistoryManifest(context, file, context.domainId, version, record);
    else {
      // Explicit retained-key decoder: it cannot satisfy live sealScope authority.
      const selected = selectedVersion(file, context.domainId, version, record), packet = readManifestSeal2(selected);
      if (await versionId(file, selected.parents, packet, selected.sids) !== version) throw new Error("History version identity mismatch.");
      let json: string;
      try { json = new TextDecoder("utf-8", { fatal: true }).decode(await openRecord(context.manifestKey, 1,
        { generation: context.generation, domainId: context.domainId, fileId: file, parents: selected.parents, sids: selected.sids }, packet)); }
      catch { throw new Error("History manifest authentication failed."); }
      manifest = parseManifest(json);
      bindManifestToRecord({ ...selected, domain_id: context.domainId }, manifest, context.domainId);
    }
    assertSyncPath(manifest.path, this.context.state.data.syncFolders);
    if (manifest.path.length > 4096) throw new Error("History path exceeds the display/path budget.");
    return manifest;
  }

  /** Re-authenticate the selected immutable version before any local writer opens. */
  async readSelection(entry: HistoryEntry): Promise<Manifest> {
    const context = await this.selectedContext();
    if (!id(entry.fileId, 16) || !id(entry.versionId, 32) || entry.domainId !== context.domainId) throw new Error("Invalid history selection.");
    const record = await context.transport.historyVersion(entry.fileId, entry.versionId, this.operation);
    return this.decodeSelection(context, entry.fileId, entry.versionId, record);
  }

  async writeSelection(manifest: Manifest, writer: VaultWriter): Promise<void> {
    const context = await this.selectedContext();
    if (!this.previous) return writeVerified(context, manifest, writer, this.operation);
    // Only the explicit retained key's declared suite; no error-driven fallback.
    if (manifest.chunks.length > 1 && manifest.sha256 !== "") throw new Error("This retained version requires an unsupported whole-file digest check.");
    for (const chunk of manifest.chunks) {
      const packet = await context.transport.getChunk(chunk.sid, this.operation);
      this.operation.check();
      if (hex(await sha256(packet)) !== chunk.sid) throw new Error("History chunk identity mismatch.");
      let plaintext;
      try { plaintext = this.previous.suite === 1 ? await decryptChunk(context.domainKey, unhex(chunk.cid), packet)
        : await decryptChunk2(context.domainKey, { generation: context.generation, domainId: context.domainId }, unhex(chunk.cid), packet); }
      catch { throw new Error("History chunk authentication failed."); }
      if (plaintext.length !== chunk.len || (manifest.chunks.length === 1 && manifest.sha256 !== "" &&
          hex(await sha256(plaintext)) !== manifest.sha256)) throw new Error("History content mismatch.");
      this.operation.check(); await writer.write(plaintext);
    }
  }

  /** Discover authenticated migration pointers, then walk only their old ancestry. */
  private async stepPrevious(filter: string, out: HistoryEntry[], counts: { scanned: number; refused: number }): Promise<void> {
    if (this.ancestry.length === 0 && !this.sourceDone) {
      this.done = false;
      if (this.newestFirst) await this.stepDown("", [], counts); else await this.stepUp("", [], counts);
      this.sourceDone = this.done;
      this.done = this.sourceDone && this.ancestry.length === 0;
      return;
    }
    const context = await this.selectedContext(), start = this.now();
    let checked = 0;
    while (this.ancestry.length > 0 && checked < HISTORY_SCAN_RECORDS && (checked === 0 || this.now() - start < HISTORY_SCAN_MS)) {
      const [file, version] = this.ancestry[0]!;
      try {
        const record = selectedVersion(file, context.domainId, version, await context.transport.historyVersion(file, version, this.operation));
        const manifest = await this.decodeSelection(context, file, version, record);
        this.operation.check();
        for (const parent of record.parents) this.enqueue(file, parent);
        if (manifest.path.toLowerCase().includes(filter.toLowerCase())) out.push({ fileId: file, versionId: version,
          domainId: context.domainId, path: manifest.path, size: manifest.size, deleted: manifest.deleted, ts: record.ts });
      } catch (error) {
        if (error instanceof HistoryLimit) throw error;
        this.operation.check(); counts.refused++;
        context.host.log("history path_class=previous_manifest decision=refused");
      }
      this.ancestry.shift(); checked++; counts.scanned++;
    }
    this.done = this.sourceDone && this.ancestry.length === 0;
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
      // A DELETION MARKER IS NOT WHAT A SEARCH IS FOR (issue #162). A note
      // deleted with many others has its marker in the newest window and its
      // content windows further down, so the search stopped at a row whose
      // Restore is disabled. It runs on until it holds a version it can
      // restore, and lists those first.
      do {
        if (this.previous) await this.stepPrevious(filter, entries, counts);
        else if (this.newestFirst) await this.stepDown(filter, entries, counts);
        else await this.stepUp(filter, entries, counts);
      } while (entries.every((entry) => entry.deleted) && !this.done && budget > 0 && this.now() - started < budget);
      entries.sort((a, b) => Number(a.deleted) - Number(b.deleted));
    } catch (failure) {
      this.operation.check();
      // A later read failure must not hide rows whose cursor already moved.
      if (entries.length === 0) throw failure;
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.checked += counts.scanned;
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
  const manifest = await browser.readSelection(entry);
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
      await browser.writeSelection(manifest, writer);
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
