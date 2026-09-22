/**
 * The sync engine, `docs/architecture.md` 6.2 item 1.
 *
 * The vault watcher (debounced, guarded against half-written files), push
 * queue (bounded concurrency), change-feed long poll and incremental chunk
 * repair share one state. The engine owns everything Obsidian-shaped
 * through the `VaultHost` port, so the whole engine is testable against a
 * hand-written fake vault and a fake transport, with no Obsidian import
 * anywhere under `sync/`.
 *
 * DEBOUNCE AND THE GROWING-FILE GUARD. A vault event schedules its path 500
 * ms out. When the timer fires the file is stat-ed twice, `RECHECK_MS`
 * apart: if size or mtime moved, the file is still being written and the
 * debounce re-arms. A torn upload is never posted; a slow copy simply takes
 * as long as it takes.
 *
 * ECHOES. The engine drops a watcher event whose `(path, mtime, size)`
 * matches a write the pull path just made, drops a delete event for a path
 * the pull path just trashed, and the pull path drops a feed record whose
 * `version_id` this device authored. Without all three, one edit would
 * ping-pong between devices forever -- and the delete echo does worse than
 * ping-pong. Applying a remote RENAME is a write at the new path and a trash
 * at the old one, so the vault reports a deletion for a file that was only
 * moved: publishing that echo posts a tombstone for a live file id, and every
 * device, the one that renamed it included, then obeys it. That is how a
 * rename deleted a note everywhere in 1.0.0-1.0.3 (issue #96).
 *
 * WHAT IS SYNCED. Only canonical relative vault paths, in both directions:
 * the watcher, startup reconciliation and the pull path all refuse anything
 * else, which is what takes `.obsidian/**` and `.git/**` out of sync in v0.1
 * (`vaultPath.ts` states the rule and why hidden folders wait for an opt-in).
 *
 * PLATFORM. Concurrency is 4 on desktop and 2 on mobile; the desktop host
 * streams files through Node's `fs` while the mobile host reads and writes
 * whole files through the vault adapter. Both use the same loops.
 */

import { ByteSource } from "../chunker";
import { Bytes, deriveDomainKey, deriveManifestKey, unhex } from "../crypto";
import {
  DomainMap,
  DomainMapError,
  DomainMapKeys,
  defaultDomainMap,
  domainMapKeys,
  loadDomainMap,
  saveDomainMap,
  soleDomain,
} from "../domainmap";
import { State } from "../state";
import { ApiError, ChangeRecord, Transport } from "../transport";
import { VaultPathError, vaultPathRefusal } from "../vaultPath";
import { SyncFolders, inSyncScope, parseSyncFolders } from "../syncScope";
import { applyChange } from "./pull";
import { pushDelete, pushFile } from "./push";
import { ChunkRepair, REPAIR_BATCH_SIDS, REPAIR_SCAN_MS, REPAIR_TICK_MS } from "./repair";

export interface VaultStat {
  path: string;
  mtime: number;
  size: number;
}

/** An atomic vault write: nothing is visible at `path` until `commit`. */
export interface VaultWriter {
  write(bytes: Bytes): Promise<void>;
  commit(mtime: number): Promise<VaultStat>;
  abort(): Promise<void>;
}

/** Everything the engine needs from Obsidian, so `sync/` imports none of it. */
export interface VaultHost {
  readonly isMobile: boolean;
  /** True only when source() can read a range without buffering the entire file. */
  readonly supportsRangeReads?: boolean;
  readonly platform: string;
  readonly appVersion: string;
  readonly deviceName: string;
  list(): Promise<VaultStat[]>;
  /**
   * May this device sync this path at all? The string rule is not enough on
   * desktop: a symlinked folder is excluded in both directions in v0.1, and
   * only the host can see the filesystem (`vaultPath.ts`).
   */
  syncable(path: string): Promise<boolean>;
  stat(path: string): Promise<VaultStat | null>;
  read(path: string): Promise<Bytes>;
  source(path: string, size: number): ByteSource;
  writer(path: string): Promise<VaultWriter>;
  /** Publish a new file only; an occupied destination must never be replaced. */
  createWriter(path: string, size: number, check: () => void): Promise<VaultWriter>;
  trash(path: string): Promise<void>;
  notify(message: string): void;
  log(line: string): void;
}

export interface SyncContext {
  readonly state: State;
  readonly transport: Transport;
  readonly host: VaultHost;
  readonly domainKey: Bytes;
  /** The manifest key of THIS domain, `HKDF(K_d, "obsync/v1/manifest", id)`. */
  readonly manifestKey: Bytes;
  readonly domainId: string;
  /** The reserved file id the owner-only domain map occupies, never a vault file. */
  readonly mapFileId: string;
  readonly deviceId: string;
  readonly concurrency: number;
  /** Version ids this device posted, awaiting their echo on the feed. */
  readonly authored: Set<string>;
  /** `path:mtime:size` of writes this device made, awaiting their watcher event. */
  readonly written: Set<string>;
  /** Paths the pull path trashed here, awaiting their watcher delete event. */
  readonly trashed: Set<string>;
  /** File ids whose refusal the user has already been told about, once each. */
  readonly refused: Set<string>;
  /** Resolutions of one file inside the current window, for the merge breaker. */
  readonly merges: Map<string, { since: number; count: number }>;
  /**
   * Publish a local file NOW, out of the queue's turn, and wait for it.
   *
   * The pull path uses it for one thing: a file at a name an incoming version
   * wants, that this device has never published, has no file id -- and
   * without two ids the same-name rule cannot be applied and the two devices
   * settle on different names (`pull.ts`, issue #113). The file was going to
   * be published seconds later by the queue anyway; this only moves it in
   * front of the decision. Absent wherever the pull path runs without a push
   * queue behind it, and then the pull keeps both and settles nothing.
   */
  publish?(path: string): Promise<void>;
  readonly deviceNames: Map<string, string>;
  now(): number;
  deviceNameFor(deviceId: string): string;
}

export type EngineStatus =
  | { kind: "idle" }
  | { kind: "syncing"; pending: number }
  | { kind: "offline" }
  | { kind: "error"; message: string };

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface EngineOptions {
  state: State;
  transport: Transport;
  host: VaultHost;
  now?: () => number;
  timers?: Timers;
  onStatus?: (status: EngineStatus) => void;
}

export const DEBOUNCE_MS = 500;
export const RECHECK_MS = 400;
export const HEARTBEAT_MS = 60 * 60 * 1000;
export const FEED_ERROR_BACKOFF_MS = 5000;

// The host's own timers. Obsidian runs the desktop app inside Electron, where
// the bare globals are Node's and hand back a `Timeout` object rather than the
// numeric handle every other Obsidian surface expects; `window` is the one
// spelling that means the same thing on desktop and on mobile.
const defaultTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

export class SyncEngine {
  private readonly timers: Timers;
  private readonly onStatus: (status: EngineStatus) => void;
  private readonly nowFn: () => number;
  private readonly pending = new Map<string, { handle: unknown; tries: number }>();
  private readonly queue: string[] = [];
  private readonly deletions = new Set<string>();
  /** Paths whose NAME changed: their bytes are identical, so the push must be forced. */
  private readonly renames = new Set<string>();
  private contextValue: SyncContext | null = null;
  private active = 0;
  private draining = false;
  /** The drain in flight, so a second caller waits for it instead of for nothing. */
  private drainWork: Promise<void> | null = null;
  private readonly pushing = new Map<string, Promise<void>>();
  /** Paths asked for while their push was in flight: one follow-up each. */
  private readonly again = new Set<string>();
  private running = false;
  private cancelled = false;
  private feed: Promise<void> | null = null;
  private heartbeatHandle: unknown = null;
  private repairHandle: unknown = null;
  private repair: ChunkRepair | null = null;
  private repairWork: Promise<void> | null = null;
  private repairNoticeShown = false;
  private scopeExitNoticeShown = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly options: EngineOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.nowFn = options.now ?? (() => Date.now());
  }

  /**
   * Read the vault's domain map, or write one for a vault that has none.
   *
   * The map on the server is the authority (`docs/architecture.md` 5.1 item
   * 3): a device that guessed which domain a path belongs to would encrypt
   * it under a key no other device derives. A map that cannot be read, or
   * that declares a domain layout this version cannot honour, therefore
   * stops the engine instead of starting a partial sync.
   */
  private async openMap(keys: DomainMapKeys): Promise<DomainMap> {
    const host = this.options.host;
    const existing = await loadDomainMap(this.options.transport, keys);
    if (existing) {
      host.log(`domainmap decision=loaded domains=${existing.domains.length}`);
      return existing;
    }
    const created = defaultDomainMap();
    await saveDomainMap(this.options.transport, keys, created);
    host.log("domainmap decision=created domains=1");
    return created;
  }

  /** Derive the keys and open the loops. Requires a paired, keyed device. */
  start(): Promise<void> {
    this.cancelled = false;
    return this.track(this.startLoops());
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }

  private async startLoops(): Promise<void> {
    const { state, transport, host } = this.options;
    const vrk = state.data.vrk;
    const deviceId = state.data.deviceId;
    if (vrk === null || deviceId === null) throw new Error("engine: this device is not paired");
    const key = unhex(vrk);
    const mapKeys = await domainMapKeys(key);
    const map = await this.openMap(mapKeys);
    const domainId = soleDomain(map);
    if (domainId === null) {
      // v0.1 derives one domain key per engine, so a vault split across
      // domains is one this version cannot write correctly. Refusing is the
      // fail-closed answer; syncing the part it understands is not.
      host.notify(
        "obsync: this vault's domain map declares more than one sharing domain, " +
          "which this version cannot sync. Nothing was read or written.",
      );
      throw new DomainMapError("more_than_one_domain");
    }
    const domainKey = await deriveDomainKey(key, domainId);
    const manifestKey = await deriveManifestKey(domainKey, domainId);
    if (this.cancelled) return;
    const deviceNames = new Map<string, string>();
    this.contextValue = {
      state,
      transport,
      host,
      domainKey,
      manifestKey,
      domainId,
      mapFileId: mapKeys.fileId,
      deviceId,
      concurrency: host.isMobile ? 2 : 4,
      authored: new Set<string>(),
      written: new Set<string>(),
      trashed: new Set<string>(),
      refused: new Set<string>(),
      merges: new Map<string, { since: number; count: number }>(),
      publish: (path) => this.pushOne(path),
      deviceNames,
      now: () => this.nowFn(),
      deviceNameFor: (id) => deviceNames.get(id) ?? "another device",
    };
    this.running = true;
    host.log(
      `engine start platform=${host.platform} concurrency=${this.contextValue.concurrency} seq=${state.data.lastSeq}`,
    );
    await this.heartbeat();
    if (!this.running) return;
    await this.reconcile();
    if (this.running) {
      const context = this.need();
      this.repair = new ChunkRepair(context, () => this.running && this.contextValue === context);
      this.repairHandle = this.timers.set(() => { void this.repairTick(); }, REPAIR_TICK_MS);
      this.feed = this.track(this.feedLoop());
    }
  }

  stop(): void {
    this.cancelled = true;
    this.running = false;
    for (const entry of this.pending.values()) this.timers.clear(entry.handle);
    this.pending.clear();
    if (this.heartbeatHandle !== null) this.timers.clear(this.heartbeatHandle);
    this.heartbeatHandle = null;
    if (this.repairHandle !== null) this.timers.clear(this.repairHandle);
    this.repairHandle = null;
    this.repair?.cancel();
    this.repair = null;
    this.options.host.log("engine stop");
    this.status({ kind: "idle" });
  }

  /** Quiesce before changing local scope; retain enough state to retry queued work. */
  async stopAndWait(): Promise<void> {
    this.stop();
    while (this.inFlight.size !== 0) await Promise.allSettled([...this.inFlight]);
    await this.options.state.save();
  }

  get started(): boolean {
    return this.running;
  }

  private status(status: EngineStatus): void {
    this.onStatus(status);
  }

  private need(): SyncContext {
    if (!this.contextValue) throw new Error("engine: not started");
    return this.contextValue;
  }

  // --- watcher -----------------------------------------------------------

  /**
   * The gate every watcher event and every reconciliation entry passes: a
   * path that is not a canonical relative vault path is not synced, in either
   * direction, and the refusal is visible. This is what keeps `.obsidian/**`
   * — this plugin's own bundle and its bookkeeping `data.json`
   * — and `.git/**` out of the vault's history (`vaultPath.ts`).
   */
  private tracked(path: string, event: string, folders: SyncFolders = this.options.state.data.syncFolders): boolean {
    const refusal = vaultPathRefusal(path) ??
      (inSyncScope(path, folders) ? null : "outside_sync_scope");
    if (refusal === null) return true;
    this.options.host.log(`watch path_class=file decision=not_synced reason=${refusal} event=${event}`);
    return false;
  }

  /** A create or modify event from the vault. */
  changed(path: string): void {
    if (!this.running || !this.tracked(path, "change")) return;
    // A file exists at this path again, so any delete event still owed for
    // the one the pull path trashed there will never arrive. Dropping the
    // suppression now is what keeps it from swallowing the deletion of THIS
    // file: a vault event that goes missing must cost one echo, never one
    // tombstone.
    this.need().trashed.delete(path);
    this.deletions.delete(path);
    this.debounce(path, 0);
  }

  /**
   * A delete event from the vault.
   *
   * The pull path's own trash comes back here: applying a remote rename or a
   * remote deletion removes a file from THIS vault, and Obsidian reports that
   * removal to this plugin like any other. Publishing it would post a
   * tombstone for a file id the vault still holds under another name, so the
   * echo is dropped once, by the path the pull path recorded before trashing
   * it (issue #96).
   */
  deleted(path: string): void {
    if (!this.running || !this.tracked(path, "delete")) return;
    if (this.need().trashed.delete(path)) {
      this.options.host.log("watch path_class=file decision=echo_suppressed event=delete");
      return;
    }
    this.unschedule(path);
    this.deletions.add(path);
    this.enqueue(path);
  }

  /**
   * A rename keeps the file's identity: the local record moves to the new
   * path so the next push posts a new VERSION of the same file id with the
   * new path inside its manifest. Other devices then move the file instead
   * of downloading a copy and deleting the original.
   */
  renamed(from: string, to: string, sourceFolders?: SyncFolders): void {
    if (!this.running) return;
    // Omitted, `tracked` judges `from` against the selection in force now,
    // which is every caller but `renamedFolder`.
    const source = this.tracked(from, "rename_from", sourceFolders);
    const target = this.tracked(to, "rename_to");
    if (vaultPathRefusal(from) !== null) return;
    // A local move across the boundary is a create within the selected
    // folders, or a file leaving them. Never transfer a remembered outside
    // identity in -- and never publish the exit as a deletion, whether the
    // destination is an unselected folder or a path no device syncs at all:
    // the file is ALIVE at `to`, and a tombstone for a live file is obeyed
    // by every other device (issue #91).
    if (!source || !target) {
      if (target) this.changed(to);
      else if (source) this.leftScope(from);
      return;
    }
    const context = this.need();
    const record = context.state.fileByPath(from);
    if (record) {
      // Persist the need to publish the new name. A stopped/failed queue
      // must not make a restart mistake an unposted rename for unchanged bytes.
      context.state.setFile(to, { ...record, mtime: -1, sha256: "" });
      context.state.forgetPath(from);
      void this.track(context.state.save()).catch(() => {
        this.stop();
        this.options.host.log("rename decision=failed reason=state_not_saved");
      });
    }
    this.unschedule(from);
    // Straight into the queue: the debounce and the unchanged-content check
    // would both drop a rename, whose only change is the path in the manifest.
    this.renames.add(to);
    context.trashed.delete(to);
    this.deletions.delete(to);
    this.enqueue(to);
  }

  /**
   * A folder rename moves every file beneath it, and Obsidian reports it
   * ONCE, for the folder (`main.ts`). A selected sync folder that IS that
   * folder, or lives under it, follows the move: without that every file
   * under it leaves the selection in the same tick, and this device publishes
   * a tombstone for a note that is alive under its new name -- which every
   * other device then obeys, and the note is gone everywhere (issue #91).
   */
  renamedFolder(from: string, to: string): void {
    if (!this.running) return;
    // Each file is judged by the selection in force on EACH side of the move:
    // its old name against the selection before the follow, its new one
    // against the selection after. A record under the renamed folder that the
    // selection never covered is therefore still out of scope on both sides,
    // and moving a selected folder cannot smuggle it into sync.
    const before = this.options.state.data.syncFolders;
    this.followSelection(from, to);
    const prefix = `${from}/`;
    for (const path of Object.keys(this.options.state.data.files)) {
      if (path.startsWith(prefix)) this.renamed(path, to + path.slice(from.length), before);
    }
  }

  /**
   * Move the selection with the folder it names. The canonical form is the
   * parser's own, so a destination inside another selected folder collapses
   * into it rather than being remembered twice. A destination this device may
   * not select AT ALL -- hidden, or malformed -- is refused instead: the
   * selection stays where it is, and the files under it leave the scope,
   * which `leftScope` declines to publish as deletions.
   */
  private followSelection(from: string, to: string): void {
    const { state, host } = this.options;
    const folders = state.data.syncFolders;
    if (folders === undefined) return;
    const moved = folders.filter((folder) => folder === from || folder.startsWith(`${from}/`));
    if (moved.length === 0) return;
    let followed: string[];
    try {
      followed = parseSyncFolders(
        folders.map((folder) => (moved.includes(folder) ? to + folder.slice(from.length) : folder)),
      );
    } catch (error) {
      host.log(
        `scope decision=not_followed reason=${error instanceof VaultPathError ? error.refusal : "invalid_selection"} folders=${moved.length}`,
      );
      return;
    }
    state.data.syncFolders = followed;
    host.log(`scope decision=followed_rename folders=${moved.length} selected=${followed.length}`);
    void this.track(state.save()).catch(() => {
      this.stop();
      host.log("scope decision=failed reason=state_not_saved");
    });
  }

  /**
   * The file's new name is outside what this device syncs. It still EXISTS,
   * so the deletion this device would otherwise publish is a tombstone for a
   * live note, and every other device obeys it (issue #91). Nothing is
   * published: dropping the record also disarms the tombstone the next
   * startup scan would infer from the old path's absence, the debounce and
   * queued push it may still be owed are cancelled, and the user is told once.
   */
  private leftScope(from: string): void {
    const context = this.need();
    this.unschedule(from);
    this.deletions.delete(from);
    const queued = this.queue.indexOf(from);
    if (queued !== -1) this.queue.splice(queued, 1);
    if (context.state.fileByPath(from) !== undefined) {
      context.state.forgetPath(from);
      void this.track(context.state.save()).catch(() => {
        this.stop();
        context.host.log("rename decision=failed reason=state_not_saved");
      });
    }
    context.host.log("rename path_class=file decision=not_published reason=moved_out_of_scope");
    if (this.scopeExitNoticeShown) return;
    this.scopeExitNoticeShown = true;
    context.host.notify(
      "obsync: a file was moved out of the folders this device syncs, so this device stopped syncing it. " +
        "Nothing was deleted: the file is still in this vault, your other devices keep their copy, and the " +
        "server keeps its history. Move it back into a selected folder, or add its new folder under " +
        "Sync folders on this device.",
    );
  }

  /** Cancel any debounce this path is still owed. */
  private unschedule(path: string): void {
    const entry = this.pending.get(path);
    if (entry === undefined) return;
    this.timers.clear(entry.handle);
    this.pending.delete(path);
  }

  /** The live context, for views that read remote-only accounting. */
  get context(): SyncContext | null {
    return this.contextValue;
  }

  private debounce(path: string, tries: number): void {
    if (!this.running) return;
    const existing = this.pending.get(path);
    if (existing) this.timers.clear(existing.handle);
    const handle = this.timers.set(() => {
      void this.track(this.settle(path, tries));
    }, tries === 0 ? DEBOUNCE_MS : RECHECK_MS);
    this.pending.set(path, { handle, tries });
  }

  /**
   * The growing-file guard: two stats that agree, or wait again. Also the
   * echo gate — a file whose stat matches a write we just made is our own
   * pull coming back and is dropped.
   */
  private async settle(path: string, tries: number): Promise<void> {
    this.pending.delete(path);
    if (!this.running) return;
    const context = this.need();
    // The filesystem gate, which the synchronous watcher entry points cannot
    // run: a path whose components include a symlink is not synced, and the
    // host says so once. Anything else that goes wrong while settling is
    // logged rather than thrown into a timer callback.
    try {
      if (!(await context.host.syncable(path))) return;
      await this.settleTracked(context, path, tries);
    } catch (error) {
      context.host.log(
        `watch path_class=file decision=failed reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async settleTracked(context: SyncContext, path: string, tries: number): Promise<void> {
    const first = await context.host.stat(path);
    if (!first) {
      this.deletions.add(path);
      this.enqueue(path);
      return;
    }
    const key = `${path}:${first.mtime}:${first.size}`;
    if (context.written.has(key)) {
      context.written.delete(key);
      context.host.log(`watch path_class=file decision=echo_suppressed`);
      return;
    }
    const record = context.state.fileByPath(path);
    if (record && record.mtime === first.mtime && record.size === first.size) return;
    this.debounce(path, tries + 1);
    const second = await context.host.stat(path);
    if (!second || second.mtime !== first.mtime || second.size !== first.size) {
      if (tries % 25 === 24) context.host.log(`watch path_class=file decision=still_growing tries=${tries + 1}`);
      return;
    }
    this.unschedule(path);
    this.enqueue(path);
  }

  private enqueue(path: string): void {
    if (!this.running) return;
    if (!this.queue.includes(path)) this.queue.push(path);
    void this.track(this.drain());
  }

  // --- push queue --------------------------------------------------------

  /**
   * One drain at a time, and every caller waits for the one that is running.
   *
   * Returning early to a caller that asked for the queue to be flushed is
   * what let "Sync now" report done with the queue still full (issue #121).
   * `draining` is set and cleared synchronously inside the loop, so it, not
   * the settled promise, decides whether there is something to join.
   */
  private drain(): Promise<void> {
    if (this.draining && this.drainWork !== null) return this.drainWork;
    this.drainWork = this.drainQueue();
    return this.drainWork;
  }

  private async drainQueue(): Promise<void> {
    this.draining = true;
    try {
      const context = this.need();
      while (this.queue.length > 0 && this.running) {
        const batch = this.queue.splice(0, context.concurrency);
        this.status({ kind: "syncing", pending: this.queue.length + batch.length });
        this.active = batch.length;
        await Promise.all(batch.map((path) => this.pushOne(path)));
        this.active = 0;
      }
      this.status({ kind: "idle" });
    } finally {
      this.draining = false;
    }
  }

  /**
   * One push per path at a time. The queue drains in batches and the pull
   * path can ask for a path out of turn (SyncContext.publish), and two pushes
   * of one unpublished file both find no record, both mint a file id, and
   * both post: two files on the server for one note, one of them orphaned by
   * the record the other leaves (issue #113). Sharing the in-flight push is
   * what makes asking out of turn safe; a path pushed again AFTER one
   * finished is an ordinary second push, which is what a second edit needs.
   *
   * SHARED IS NOT THE SAME AS SATISFIED. The push in flight took its snapshot
   * -- the file's stat and its bytes (`push.ts`) -- before the second request
   * existed, so whatever caused that request is NOT in what is being
   * published. Handing the caller the in-flight promise and nothing else
   * consumed the watcher's trigger for a real edit: the file stayed dirty, the
   * queue emptied, and the engine reported idle with an edit that had gone
   * nowhere and would go nowhere until something touched that note again
   * (review round 2, finding 3). So a path asked for while it is being pushed
   * is remembered, and ONE follow-up push is queued when the one in flight
   * finishes -- one per path however many callers arrive, and free when
   * nothing really changed, because a push of an unchanged file re-chunks it,
   * finds the recorded digest and posts nothing.
   */
  private pushOne(path: string): Promise<void> {
    const active = this.pushing.get(path);
    if (active !== undefined) {
      this.again.add(path);
      return active;
    }
    const work = this.pushNow(path);
    this.pushing.set(path, work);
    const done = (): void => {
      if (this.pushing.get(path) !== work) return;
      this.pushing.delete(path);
      if (this.again.delete(path)) this.enqueue(path);
    };
    void work.then(done, done);
    return work;
  }

  private async pushNow(path: string): Promise<void> {
    const context = this.need();
    try {
      if (this.deletions.has(path)) {
        this.deletions.delete(path);
        const outcome = await pushDelete(context, path);
        if (outcome) context.authored.add(outcome.versionId);
        return;
      }
      const outcome = await pushFile(context, path, this.renames.delete(path));
      if (outcome.status === "unchanged") return;
      context.authored.add(outcome.versionId);
      if (outcome.ack?.conflicted) await this.reconcileFile(outcome.fileId);
    } catch (error) {
      // A path this device may not sync is a decision, not a failure: it is
      // logged and dropped, and the status bar stays quiet. Every other
      // failure is the user's business.
      if (error instanceof VaultPathError) {
        context.host.log(`push path_class=file decision=not_synced reason=${error.refusal}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      context.host.log(`push path_class=file decision=failed reason=${message}`);
      this.status(error instanceof ApiError && error.code === "unreachable" ? { kind: "offline" } : { kind: "error", message });
    }
  }

  /**
   * Another device wrote first. Pull the file's heads and let the pull path
   * merge or keep both, then the local head is current again.
   */
  private async reconcileFile(fileId: string): Promise<void> {
    const context = this.need();
    const file = await context.transport.getFile(fileId);
    const localPath = context.state.pathByFileId(fileId);
    const localVersion = localPath ? context.state.fileByPath(localPath)?.versionId : undefined;
    for (const head of file.heads) {
      if (head === localVersion) continue;
      const version = file.versions.find((candidate) => candidate.version_id === head);
      if (!version) continue;
      const change: ChangeRecord = {
        ...version,
        // A version record names neither its file nor its domain: the server
        // renders `file_id` and `domain_id` on the file object, not on each
        // of its versions, and the change feed is the only place all three
        // travel together. The pull path binds the manifest to both.
        file_id: fileId,
        domain_id: file.domain_id,
        seq: context.state.data.lastSeq,
        heads: file.heads,
        conflicted: true,
      };
      await applyChange(context, change);
    }
  }

  // --- feed --------------------------------------------------------------

  private async feedLoop(): Promise<void> {
    const context = this.need();
    while (this.running) {
      try {
        const page = await context.transport.changes(context.state.data.lastSeq, 55);
        for (const change of page.changes) {
          if (!this.running) break;
          await applyChange(context, change);
          context.state.data.lastSeq = change.seq;
        }
        if (!this.running) {
          await context.state.save();
          return;
        }
        context.state.data.lastSeq = page.seq;
        await context.state.save();
        if (page.changes.length > 0) this.status({ kind: "idle" });
      } catch (error) {
        if (!this.running) return;
        if (error instanceof ApiError && error.code === "seq_ahead") {
          context.host.log("feed decision=resync reason=seq_ahead");
          context.state.data.lastSeq = 0;
          await context.state.save();
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        context.host.log(`feed decision=retry reason=${message}`);
        this.status({ kind: "offline" });
        await new Promise<void>((resolve) => this.timers.set(resolve, FEED_ERROR_BACKOFF_MS));
      }
    }
  }

  // --- startup reconciliation and heartbeat ------------------------------

  /**
   * Compare `(mtime, size)` per path against the local state and queue
   * anything that differs, plus a tombstone for every recorded path the
   * vault no longer has. This is what makes an edit made while Obsidian was
   * closed, or a file deleted in Finder, reach the server.
   */
  reconcile(): Promise<void> {
    return this.track(this.reconcileLocal());
  }

  private async reconcileLocal(): Promise<void> {
    const context = this.need();
    const started = context.now();
    const seen = new Set<string>();
    let queued = 0;
    let skipped = 0;
    for (const file of await context.host.list()) {
      if (!this.running) return;
      if (!this.tracked(file.path, "reconcile") || !(await context.host.syncable(file.path))) {
        skipped++;
        continue;
      }
      seen.add(file.path);
      const record = context.state.fileByPath(file.path);
      if (record && record.mtime === file.mtime && record.size === file.size) continue;
      this.enqueue(file.path);
      queued++;
    }
    for (const path of Object.keys(context.state.data.files)) {
      if (!this.running) return;
      if (seen.has(path)) continue;
      if (!this.tracked(path, "reconcile_state") || !(await context.host.syncable(path))) {
        skipped++;
        continue;
      }
      this.deletions.add(path);
      this.enqueue(path);
      queued++;
    }
    context.host.log(
      `reconcile decision=queued files=${seen.size} queued=${queued} skipped=${skipped} duration_ms=${context.now() - started}`,
    );
  }

  /**
   * Everything the user's "Sync now" command does.
   *
   * It resolves only once the queue it was asked to flush is empty. Joining
   * the running drain is not enough on its own: a path queued after that
   * drain took its last batch joins the very drain that will never look at
   * the queue again, so one more drain follows. That second drain is a no-op
   * when nothing is left, which is why one is enough.
   */
  async syncNow(): Promise<void> {
    const started = this.nowFn();
    const joined = this.draining;
    await this.reconcile();
    const queued = this.queue.length;
    const inFlight = this.active;
    await this.drain();
    const followUp = this.queue.length > 0 || this.draining;
    if (followUp) await this.drain();
    this.options.host.log(
      `sync_now decision=${joined ? "joined_running_drain" : "drained"} queued=${queued} ` +
        `in_flight=${inFlight} follow_up=${followUp ? 1 : 0} duration_ms=${this.nowFn() - started}`,
    );
    await this.repairTick();
  }

  /** One worker shared by the timer and Sync now; dispatched writes are drained on stop. */
  private repairTick(): Promise<void> {
    if (this.repairWork !== null) return this.repairWork;
    if (!this.running || this.repair === null) return Promise.resolve();
    if (this.repairHandle !== null) this.timers.clear(this.repairHandle);
    this.repairHandle = null;
    const repair = this.repair;
    const work = this.track(this.repairStep(repair));
    this.repairWork = work;
    const clear = (): void => { if (this.repairWork === work) this.repairWork = null; };
    void work.then(clear, clear);
    return work;
  }

  private async repairStep(repair: ChunkRepair): Promise<void> {
    let delay = REPAIR_TICK_MS;
    const host = this.options.host;
    const started = this.nowFn();
    const budget = (): string => `budget_sids=${REPAIR_BATCH_SIDS} budget_chunks=1 duration_ms=${this.nowFn() - started}`;
    try {
      const result = await repair.step();
      if (!this.running || this.repair !== repair) return;
      if (result.kind === "idle") delay = REPAIR_SCAN_MS;
      if (result.kind === "repaired") host.log(`repair decision=verified bytes=${result.bytes} ${budget()}`);
      else if (result.kind !== "unresolved") host.log(`repair decision=${result.kind} ${budget()}`);
      if (result.kind === "unresolved") {
        host.log(`repair decision=unresolved reason=${result.reason} ${budget()}`);
        const message = result.reason === "range_read_unavailable"
          ? "Server repair needs a device with safe file-range reads for a file larger than 8 MiB. Keep a synced desktop online; this device cannot automatically supply that file."
          : "Server repair could not restore a missing chunk from this device's current files. Keep another synced device online and check the server scrub report.";
        this.status({ kind: "error", message });
        if (!this.repairNoticeShown) { host.notify(`obsync: ${message}`); this.repairNoticeShown = true; }
      }
    } catch {
      // Do not expose a source path or untrusted transport/manifest error.
      if (this.running && this.repair === repair) {
        host.log(`repair decision=deferred reason=read_or_write_failed ${budget()}`);
        this.status({ kind: "error", message: "Server repair could not verify a retained file. It will retry; check connectivity and the server scrub report." });
        delay = REPAIR_SCAN_MS;
      }
    } finally {
      if (this.running && this.repair === repair) {
        this.repairHandle = this.timers.set(() => { void this.repairTick(); }, delay);
      }
    }
  }

  private async heartbeat(): Promise<void> {
    const context = this.need();
    try {
      // A heartbeat is not repeatable, and nothing here depends on it: it
      // updates `last_seen` and the reported policy, and the next one is an
      // hour away. A lost answer is therefore logged and dropped -- reading
      // the device list back to learn whether a timestamp moved would cost a
      // request to answer a question nothing asks.
      const beat = await context.transport.heartbeat(context.host.appVersion, context.state.data.policy);
      if (beat.outcome === "lost") context.host.log(`heartbeat decision=lost reason=${beat.reason}`);
      else context.host.log("heartbeat decision=reported policy_schema=v1");
      const { devices } = await context.transport.devices();
      context.deviceNames.clear();
      for (const device of devices) context.deviceNames.set(device.device_id, device.name);
    } catch (error) {
      context.host.log(`heartbeat decision=failed reason=${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.running) {
      this.heartbeatHandle = this.timers.set(() => {
        void this.track(this.heartbeat());
      }, HEARTBEAT_MS);
    }
  }
}
