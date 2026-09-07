/**
 * The sync engine, `docs/architecture.md` 6.2 item 1.
 *
 * Three loops share one state: the vault watcher (debounced, guarded
 * against half-written files), the push queue (bounded concurrency), and
 * the change-feed long poll. The engine owns everything Obsidian-shaped
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
 * matches a write the pull path just made, and the pull path drops a feed
 * record whose `version_id` this device authored. Without both, one edit
 * would ping-pong between devices forever.
 *
 * PLATFORM. Concurrency is 4 on desktop and 2 on mobile; the desktop host
 * streams files through Node's `fs` while the mobile host reads and writes
 * whole files through the vault adapter. Both use the same loops.
 */

import { ByteSource } from "../chunker";
import { Bytes, deriveDomainKey, deriveManifestKey, unhex } from "../crypto";
import { State } from "../state";
import { ApiError, ChangeRecord, Transport } from "../transport";
import { applyChange } from "./pull";
import { pushDelete, pushFile } from "./push";

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
  readonly platform: string;
  readonly appVersion: string;
  readonly deviceName: string;
  list(): Promise<VaultStat[]>;
  stat(path: string): Promise<VaultStat | null>;
  read(path: string): Promise<Bytes>;
  source(path: string, size: number): ByteSource;
  writer(path: string): Promise<VaultWriter>;
  trash(path: string): Promise<void>;
  notify(message: string): void;
  log(line: string): void;
}

export interface SyncContext {
  readonly state: State;
  readonly transport: Transport;
  readonly host: VaultHost;
  readonly domainKey: Bytes;
  readonly manifestKey: Bytes;
  readonly domainId: string;
  readonly deviceId: string;
  readonly concurrency: number;
  /** Version ids this device posted, awaiting their echo on the feed. */
  readonly authored: Set<string>;
  /** `path:mtime:size` of writes this device made, awaiting their watcher event. */
  readonly written: Set<string>;
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
  domainId: string;
  now?: () => number;
  timers?: Timers;
  onStatus?: (status: EngineStatus) => void;
}

export const DEBOUNCE_MS = 500;
export const RECHECK_MS = 400;
export const HEARTBEAT_MS = 60 * 60 * 1000;
export const FEED_ERROR_BACKOFF_MS = 5000;

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
  private running = false;
  private feed: Promise<void> | null = null;
  private heartbeatHandle: unknown = null;

  constructor(private readonly options: EngineOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.nowFn = options.now ?? (() => Date.now());
  }

  /** Derive the keys and open the loops. Requires a paired, keyed device. */
  async start(): Promise<void> {
    const { state, transport, host, domainId } = this.options;
    const vrk = state.data.vrk;
    const deviceId = state.data.deviceId;
    if (vrk === null || deviceId === null) throw new Error("engine: this device is not paired");
    const key = unhex(vrk);
    const deviceNames = new Map<string, string>();
    this.contextValue = {
      state,
      transport,
      host,
      domainKey: await deriveDomainKey(key, domainId),
      manifestKey: await deriveManifestKey(key),
      domainId,
      deviceId,
      concurrency: host.isMobile ? 2 : 4,
      authored: new Set<string>(),
      written: new Set<string>(),
      deviceNames,
      now: () => this.nowFn(),
      deviceNameFor: (id) => deviceNames.get(id) ?? "another device",
    };
    this.running = true;
    host.log(
      `engine start platform=${host.platform} concurrency=${this.contextValue.concurrency} seq=${state.data.lastSeq}`,
    );
    await this.heartbeat();
    await this.reconcile();
    this.feed = this.feedLoop();
  }

  stop(): void {
    this.running = false;
    for (const entry of this.pending.values()) this.timers.clear(entry.handle);
    this.pending.clear();
    if (this.heartbeatHandle !== null) this.timers.clear(this.heartbeatHandle);
    this.heartbeatHandle = null;
    this.options.host.log("engine stop");
    this.status({ kind: "idle" });
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

  /** A create or modify event from the vault. */
  changed(path: string): void {
    if (!this.running) return;
    this.deletions.delete(path);
    this.debounce(path, 0);
  }

  /** A delete event from the vault. */
  deleted(path: string): void {
    if (!this.running) return;
    const entry = this.pending.get(path);
    if (entry) {
      this.timers.clear(entry.handle);
      this.pending.delete(path);
    }
    this.deletions.add(path);
    this.enqueue(path);
  }

  /**
   * A rename keeps the file's identity: the local record moves to the new
   * path so the next push posts a new VERSION of the same file id with the
   * new path inside its manifest. Other devices then move the file instead
   * of downloading a copy and deleting the original.
   */
  renamed(from: string, to: string): void {
    if (!this.running) return;
    const context = this.need();
    const record = context.state.fileByPath(from);
    if (record) {
      context.state.setFile(to, record);
      context.state.forgetPath(from);
      void context.state.save();
    }
    const entry = this.pending.get(from);
    if (entry) {
      this.timers.clear(entry.handle);
      this.pending.delete(from);
    }
    // Straight into the queue: the debounce and the unchanged-content check
    // would both drop a rename, whose only change is the path in the manifest.
    this.renames.add(to);
    this.deletions.delete(to);
    this.enqueue(to);
  }

  /** The live context, for views that read remote-only accounting. */
  get context(): SyncContext | null {
    return this.contextValue;
  }

  private debounce(path: string, tries: number): void {
    const existing = this.pending.get(path);
    if (existing) this.timers.clear(existing.handle);
    const handle = this.timers.set(() => {
      void this.settle(path, tries);
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
    const entry = this.pending.get(path);
    if (entry) {
      this.timers.clear(entry.handle);
      this.pending.delete(path);
    }
    this.enqueue(path);
  }

  private enqueue(path: string): void {
    if (!this.queue.includes(path)) this.queue.push(path);
    void this.drain();
  }

  // --- push queue --------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return;
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

  private async pushOne(path: string): Promise<void> {
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
        }
        context.state.data.lastSeq = page.seq;
        await context.state.save();
        if (page.changes.length > 0) this.status({ kind: "idle" });
      } catch (error) {
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
  async reconcile(): Promise<void> {
    const context = this.need();
    const started = context.now();
    const seen = new Set<string>();
    let queued = 0;
    for (const file of await context.host.list()) {
      seen.add(file.path);
      const record = context.state.fileByPath(file.path);
      if (record && record.mtime === file.mtime && record.size === file.size) continue;
      this.enqueue(file.path);
      queued++;
    }
    for (const path of Object.keys(context.state.data.files)) {
      if (seen.has(path)) continue;
      this.deletions.add(path);
      this.enqueue(path);
      queued++;
    }
    context.host.log(
      `reconcile decision=queued files=${seen.size} queued=${queued} duration_ms=${context.now() - started}`,
    );
  }

  /** Everything the user's "Sync now" command does. */
  async syncNow(): Promise<void> {
    await this.reconcile();
    await this.drain();
  }

  private async heartbeat(): Promise<void> {
    const context = this.need();
    try {
      await context.transport.heartbeat(context.host.appVersion, context.state.data.policy);
      const { devices } = await context.transport.devices();
      context.deviceNames.clear();
      for (const device of devices) context.deviceNames.set(device.device_id, device.name);
    } catch (error) {
      context.host.log(`heartbeat decision=failed reason=${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.running) {
      this.heartbeatHandle = this.timers.set(() => {
        void this.heartbeat();
      }, HEARTBEAT_MS);
    }
  }
}
