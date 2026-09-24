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
 * ms out. Every settle stats the file once and compares that stat with the
 * one the PREVIOUS settle took, `RECHECK_MS` earlier: if size or mtime moved
 * the file is still being written and the debounce re-arms. The gap is the
 * whole guard. Two stats taken back to back agree about a file that is being
 * copied at a gigabyte a minute, because nothing lands between them, which is
 * how a 916 MB copy was published at 376 MB (issue #99). A gap cannot be the
 * whole answer either -- a copy may stall for longer than one recheck -- so
 * the push re-reads the size when its read ends and abandons a version whose
 * file moved underneath it (`push.ts`). A torn upload is never posted; a slow
 * copy simply takes as long as it takes.
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
 * THE PERIODIC SCAN. The watcher is the fast path and stays it. Every
 * `SCAN_MS` the engine also compares a listing of the vault against its own
 * record, because the watcher is Obsidian's events and `host.list()` is
 * Obsidian's index -- both blind to the same change at the same moment, which
 * is why a note moved in from a file manager took minutes while an external
 * EDIT took seconds (issue #101). On desktop `host.scan()` reads the
 * filesystem instead. The pass is ADDITIVE: it queues, and it pairs a
 * vanished recorded path with a new unrecorded one of the same
 * `(mtime, size)` as a MOVE, but it never publishes a tombstone.
 *
 * FOLDERS. A folder is synced as its own record — a manifest with a path and
 * nothing else (`push.ts`, `FolderManifest`) — so an EMPTY folder reaches
 * every device and a deleted one leaves every device (issue #104). The vault
 * events for a folder come in here exactly as a file's do, and a folder the
 * pull path made or removed is dropped as an echo the same way.
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
import { State, isPushed } from "../state";
import { ApiError, ChangeRecord, Transport } from "../transport";
import { VaultPathError, caseOnly, vaultPathRefusal } from "../vaultPath";
import { SyncFolders, inFolderScope, inSyncScope, movedSelection, selectionAfterRename } from "../syncScope";
import { applyChange } from "./pull";
import { pushDelete, pushFile, pushFolder, pushFolderDelete } from "./push";
import { ChunkRepair, REPAIR_BATCH_SIDS, REPAIR_SCAN_MS, REPAIR_TICK_MS } from "./repair";

export interface VaultStat {
  path: string;
  mtime: number;
  size: number;
}

/**
 * What a removal did.
 *
 * `kept` means the file is STILL THERE: it no longer held the content the
 * caller bound the removal to, so what it holds now is bytes this device has
 * not copied anywhere and nothing threw them away.
 *
 * `unheld` means NOTHING WAS REMOVED, because this host could not promise to
 * preserve a save that landed inside the removal. A narrowed window is not a
 * closed one, and a removal this device cannot undo is not made at all: the
 * caller keeps both files instead (round 3, finding 1, re-opened).
 */
export type TrashResult = "removed" | "kept" | "unheld";

/**
 * What a rename of one vault entry did. `occupied` is the refusal that makes
 * the operation safe on a case-sensitive host: a DIFFERENT file already
 * wears the destination's exact name, and a rename that replaced it would
 * destroy a note no version holds (issue #124).
 */
export type MoveResult = "moved" | "occupied" | "missing";

/** What one settle remembers for the next one, `RECHECK_MS` later. */
interface Settled {
  stat: VaultStat;
  /** Consecutive rechecks that saw exactly this `(mtime, size)`. */
  agreed: number;
  /** Has this device watched the file change since the debounce began? */
  grew: boolean;
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
  /**
   * True only when a removal can be BOUND to the content it removes -- that
   * is, when this host can keep the file reachable across the vault's own
   * asynchronous trash and put it back if a save landed inside it. A caller
   * whose removal must not lose a save asks this BEFORE it does the work
   * that leads to one: a host that answers otherwise is never asked to
   * remove anything, and the caller takes its non-destructive path instead.
   */
  readonly bindsRemoval?: boolean;
  readonly platform: string;
  readonly appVersion: string;
  readonly deviceName: string;
  list(): Promise<VaultStat[]>;
  /**
   * The vault as the FILESYSTEM has it, or `null` when this host has no view
   * of its own.
   *
   * `list()` is Obsidian's index, which is never fresher than the vault
   * events this plugin already handles: a change the app has not noticed yet
   * is absent from both, so a periodic pass over `list()` converges nothing
   * the watcher did not already have. On desktop the host can read the
   * directory itself, and that is the only view that converges a change
   * Obsidian has not seen (issue #101). Mobile reaches the vault only through
   * the adapter and answers `null`.
   */
  scan?(): Promise<VaultStat[] | null>;
  /**
   * May this device sync this path at all? The string rule is not enough on
   * desktop: a symlinked folder is excluded in both directions in v0.1, and
   * only the host can see the filesystem (`vaultPath.ts`).
   *
   * THE KIND IS THE CALLER'S TO SAY, because the selection rule differs at
   * one point: a FOLDER record is published for the selected folder itself
   * as well as for everything inside it, and a FILE is never the selected
   * folder (`syncScope.ts`, `inFolderScope`). Omitted means a file, which is
   * every caller but the reconcile pass's folder loops.
   */
  syncable(path: string, kind?: "file" | "folder"): Promise<boolean>;
  stat(path: string): Promise<VaultStat | null>;
  read(path: string): Promise<Bytes>;
  source(path: string, size: number): ByteSource;
  writer(path: string): Promise<VaultWriter>;
  /** Publish a new file only; an occupied destination must never be replaced. */
  createWriter(path: string, size: number, check: () => void): Promise<VaultWriter>;
  /**
   * Remove `path`.
   *
   * With `expect`, the removal is BOUND to the content that metadata
   * describes. The vault's own trash is asynchronous and does work of its own
   * before the file goes (`main.ts`), so a save landing inside that window is
   * invisible to every check the caller can make beforehand -- including a
   * stat taken on the line above the call. A host that can keep the file
   * reachable across the removal removes it, puts it back if what it took
   * had changed, and answers `removed` or `kept`. A host that CANNOT --
   * because it has no second name to give, or because the filesystem refused
   * one -- removes nothing at all and answers `unheld`. Without `expect` the
   * removal is unconditional, which is what a remote tombstone means.
   */
  trash(path: string, expect?: VaultStat): Promise<TrashResult>;
  /**
   * Rename one entry, and REFUSE rather than replace.
   *
   * This is the operation a case-only rename needs and that a write followed
   * by a removal cannot be: on a host that folds case the two spellings are
   * one entry, so writing at the new one lands in the old one and the
   * removal that follows takes the note with it. A rename changes the name
   * the directory keeps, on that host and on a host that keeps the two
   * apart alike.
   *
   * The destination is occupied only when a DIFFERENT file wears its exact
   * name, which only the host can answer: by inode on desktop, and by the
   * adapter's case-sensitive existence check on mobile.
   */
  move(from: string, to: string): Promise<MoveResult>;
  /**
   * The name this vault REALLY shows for `path`, or `null` when nothing here
   * answers to it.
   *
   * THE ONE QUESTION A RECORD MUST NOT GUESS AT (issue #124). `move` renames
   * the entry the last component names; it cannot change the case of a
   * DIRECTORY above it, because `rename(2)` resolves those components and a
   * host that folds case finds the directory by either spelling and leaves
   * the name it keeps alone. A device that wrote a record at the spelling it
   * ASKED for, on a host that shows another, has a record its own listing
   * contradicts -- and the scan pairs that difference as a move and
   * publishes it, which is the livelock this answer exists to make
   * impossible. Every component is resolved, not just the last.
   *
   * `null` is also the answer on a host that keeps the two spellings apart,
   * where the folded twin of a name is a DIFFERENT entry and nothing here
   * wears the name that was asked about.
   */
  spelling(path: string): Promise<string | null>;
  /**
   * Rename a FOLDER entry, refusing rather than replacing.
   *
   * The file `move` cannot do this: its own source and destination are files
   * on every host, and a directory handed to it is refused. Re-casing a
   * directory is the only operation that makes a folder renamed by
   * capitalisation alone converge on a host that folds case, and a folder
   * record -- which IS its path -- is the only thing entitled to ask for it.
   *
   * The destination is occupied when a DIFFERENT directory, or any file,
   * wears its exact name; the folded twin of the source IS the source and is
   * not a refusal.
   */
  moveFolder(from: string, to: string): Promise<MoveResult>;
  /** Every folder path this device may sync, excluding the vault root. */
  listFolders(): Promise<string[]>;
  /** Make this folder and anything missing above it; refuse if a FILE is there. */
  createFolder(path: string): Promise<void>;
  /**
   * Remove this folder through the user's own delete preference. `false`,
   * having done nothing, when it still holds ANYTHING — including a file this
   * device does not sync, which is the whole reason the host answers this and
   * not the engine: only the host can see the filesystem.
   */
  trashFolder(path: string): Promise<boolean>;
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
  /** `from\u0000to` of renames the pull path made, awaiting their watcher event. */
  readonly moved: Set<string>;
  /** Folders the pull path made here, awaiting their watcher create event. */
  readonly createdFolders: Set<string>;
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
/**
 * How long a file that has been SEEN changing must then hold still before it
 * is pushed. One recheck is enough for a file nothing was ever observed
 * writing; it is not enough for a copy, because a copy that stalls for longer
 * than one recheck -- ordinary I/O scheduling for a large `cp` between
 * volumes -- puts two consecutive rechecks inside one pause and they agree
 * about a file that is still growing (issue #99).
 */
export const QUIET_MS = 5000;
export const HEARTBEAT_MS = 60 * 60 * 1000;
/**
 * How often the engine compares the vault against its own record.
 *
 * The watcher is the fast path and stays the fast path. This is the bound on
 * everything it does not report: an event the host dropped, and above all a
 * file moved from outside Obsidian, which took about four minutes to reach
 * the other device while an external EDIT took seconds (issue #101). It is
 * additive only -- it queues and it pairs moves, it never publishes a
 * tombstone -- because a listing this device took itself is the right thing
 * to converge from and the wrong thing to delete on.
 */
export const SCAN_MS = 30 * 1000;

/**
 * THE BULK-DELETION FLOOR (issue #123). Below this many candidates a pass
 * that would tombstone everything it tracks is an ordinary small vault
 * emptying, and holding it back would teach the user to confirm without
 * reading. At or above it, a pass that would retire more than half of what
 * this device tracks is held and named instead of published.
 */
export const BULK_DELETION_MIN = 5;

/** What one pass is measured against; an overrun is logged, never truncated. */
export const SCAN_BUDGET_MS = 5000;

/**
 * How many times one folder record's post is attempted before the barrier it
 * holds is let go (review round 3, finding 3).
 *
 * The record is the only thing entitled to re-case a directory on a folding
 * receiver, so the moves under it wait for it -- and a queue that waited
 * forever for a post that keeps failing would stop this device publishing
 * anything under that folder at all. Three attempts inside the one drain,
 * and then the hold EXPIRES with a decision and a notice: the moves go, the
 * receiver refuses them and says so, and this device's next start republishes
 * the record from the reconcile pass, which is the recovery the protocol
 * already documents. Never silent, and never unbounded.
 */
export const FOLDER_POST_TRIES = 3;
export const FEED_ERROR_BACKOFF_MS = 5000;

// The host's own timers. Obsidian runs the desktop app inside Electron, where
// the bare globals are Node's and hand back a `Timeout` object rather than the
// numeric handle every other Obsidian surface expects; `window` is the one
// spelling that means the same thing on desktop and on mobile.
/** `QUIET_MS` of stillness, counted in rechecks because that is what fires. */
const QUIET_RECHECKS = Math.ceil(QUIET_MS / RECHECK_MS);

/** The directory a path lives in; `""` for a path at the vault root. */
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

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
  /** Queued folder paths to publish a record for, and to tombstone. */
  private readonly folderPublishes = new Set<string>();
  private readonly folderRemovals = new Set<string>();
  /**
   * Queued paths that must reach the server BEFORE anything queued behind
   * them: the wire order, which a batch under `Promise.all` is not
   * (`takeBatch`).
   */
  private readonly barriers = new Set<string>();
  /**
   * The barrier path the batch in flight is carrying, so a post that FAILS
   * can put it back: `takeBatch` takes such a path alone, so there is never
   * more than one (`pushNow`).
   */
  private barrierPath: string | null = null;
  /** Failed attempts at one folder record's post, against `FOLDER_POST_TRIES`. */
  private readonly folderRetries = new Map<string, number>();
  /** Echo marks already armed at the previous scan: what this one expires. */
  private echoSweep = new Set<string>();
  /** The failed-folder-post notice is shown once per engine, like every other. */
  private folderPostNoticeShown = false;
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
  private scanHandle: unknown = null;
  private repair: ChunkRepair | null = null;
  private repairWork: Promise<void> | null = null;
  private repairNoticeShown = false;
  private scopeExitNoticeShown = false;
  private caseGhostNoticeShown = false;
  /** Tombstones one pass refused to publish, awaiting the user's word. */
  private heldDeletions: string[] = [];
  private bulkNoticeShown = false;
  /** When the repair tick began yielding to a manual history operation. */
  private repairDeferredAt: number | null = null;
  private repairDeferredTicks = 0;
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
      moved: new Set<string>(),
      createdFolders: new Set<string>(),
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
    // FIRST, AND BEFORE THE PASS THAT QUEUES THE FILE WORK (review round 4,
    // finding 3).
    this.restoreFolderBarriers();
    await this.reconcile();
    if (this.running) {
      const context = this.need();
      this.repair = new ChunkRepair(context, () => this.running && this.contextValue === context);
      this.repairHandle = this.timers.set(() => { void this.repairTick(); }, REPAIR_TICK_MS);
      host.log(`scan decision=start interval_ms=${SCAN_MS} budget_ms=${SCAN_BUDGET_MS}`);
      this.scanHandle = this.timers.set(() => this.scanTick(), SCAN_MS);
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
    if (this.scanHandle !== null) this.timers.clear(this.scanHandle);
    this.scanHandle = null;
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

  /**
   * The same question about a FOLDER, whose scope rule differs at one point:
   * the selected folder itself has a folder record, because a folder record
   * IS its path and nothing else can carry that folder's own rename
   * (`syncScope.ts`, `inFolderScope`; review round 3, finding 1).
   */
  private trackedFolder(path: string, event: string, folders: SyncFolders = this.options.state.data.syncFolders): boolean {
    const refusal = vaultPathRefusal(path) ??
      (inFolderScope(path, folders) ? null : "outside_sync_scope");
    if (refusal === null) return true;
    this.options.host.log(`watch path_class=folder decision=not_synced reason=${refusal} event=${event}`);
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
    // A RENAME ONTO ITS OWN PATH IS NOT A RENAME (review round 4, finding 2).
    // `rename(2)` resolves the directory components of its destination, so a
    // destination differing from its source in an ANCESTOR alone renames the
    // entry onto itself: the call succeeds, nothing moves, and a host that
    // reports what it was asked for reports a move from a path to itself.
    // Taken as one, the record is written under `to` and forgotten under
    // `from` -- the same key -- so the note loses its record altogether and
    // the next pass publishes it as a NEW file, leaving its old id on the
    // server with nothing to retire it.
    if (from === to) {
      this.options.host.log("watch path_class=file decision=skipped reason=same_path event=rename");
      return;
    }
    // Omitted, `tracked` judges `from` against the selection in force now,
    // which is every caller but `renamedFolder`.
    const source = this.tracked(from, "rename_from", sourceFolders);
    const target = this.tracked(to, "rename_to");
    if (vaultPathRefusal(from) !== null) return;
    // The pull path's own rename comes back here as a vault event, exactly
    // as its trash does. Publishing it would post a version for a move this
    // device only APPLIED, which the device that made it then applies back
    // -- the two spellings of one folder bouncing between devices (#124).
    if (this.running && this.contextValue !== null && this.contextValue.moved.delete(`${from}\u0000${to}`)) {
      this.options.host.log("watch path_class=file decision=echo_suppressed event=rename");
      return;
    }
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
  renamedFolder(from: string, to: string, sourceFolders: SyncFolders = this.options.state.data.syncFolders): void {
    if (!this.running) return;
    // Nothing moved, one kind up (`renamed`, review round 4, finding 2): this
    // would move the selection onto itself and hand every file under the
    // folder a rename from its own path.
    if (from === to) {
      this.options.host.log("watch path_class=folder decision=skipped reason=same_path event=rename");
      return;
    }
    // Each file is judged by the selection in force on EACH side of the move:
    // its old name against the selection before the follow, its new one
    // against the selection after. A record under the renamed folder that the
    // selection never covered is therefore still out of scope on both sides,
    // and moving a selected folder cannot smuggle it into sync.
    //
    // THE SELECTION BEFORE THE MOVE IS THE CALLER'S TO CAPTURE, because the
    // OTHER half of a folder rename moves it too (`folderRenamed`) and either
    // half may run first (`main.ts`). Read here, it would be the selection the
    // rename LEAVES BEHIND whenever the other half ran first -- every old name
    // out of scope, every note under a selected folder published as a NEW file
    // with a new id, and the old ids never retired (review round 2, finding 1).
    const before = sourceFolders;
    this.followSelection(from, to);
    const prefix = `${from}/`;
    // RECORDS ARE NOT THE WHOLE OF WHAT THIS DEVICE OWES. A note written
    // moments ago is still in the debounce, or already in the push queue,
    // and has no record at all -- nothing about it is in `files` yet. Moving
    // only the records left that work pointing at a name the folder no
    // longer has, where it was then refused as outside the selection, and
    // the note stayed on this device alone until something else triggered a
    // reconciliation. Pending work moves with the folder like everything
    // else under it.
    const pending = [...this.pending.keys(), ...this.queue];
    for (const path of new Set([...Object.keys(this.options.state.data.files), ...pending])) {
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
    let followed: { folders: string[]; moved: number } | null;
    try {
      followed = selectionAfterRename(state.data.syncFolders, from, to);
    } catch (error) {
      host.log(
        `scope decision=not_followed reason=${error instanceof VaultPathError ? error.refusal : "invalid_selection"} ` +
          `folders=${movedSelection(state.data.syncFolders, from).length}`,
      );
      return;
    }
    if (followed === null) return;
    state.data.syncFolders = followed.folders;
    host.log(`scope decision=followed_rename folders=${followed.moved} selected=${followed.folders.length}`);
    void this.track(state.save()).catch(() => {
      this.stop();
      host.log("scope decision=failed reason=state_not_saved");
    });
  }

  /**
   * The folder's new name is outside what this device syncs -- the same
   * decision `leftScope` makes for a file, for the record a folder has.
   *
   * Nothing is published: the folder is ALIVE under its new name, and its
   * tombstone would remove it from every device that still has it empty.
   * The record is dropped as well, because a record for a folder this device
   * can no longer see is one the next reconcile pass reads as a folder that
   * was deleted -- the tombstone this branch exists to refuse, thirty seconds
   * later. The user has already been told once by the files that moved with
   * it (`leftScope`); a folder with no files in it says it here and nowhere
   * else, which is the honest cost of a rename this device cannot follow.
   */
  private folderLeftScope(path: string, folders: SyncFolders): void {
    // The source's own refusal first, unchanged: a folder that was never this
    // device's says so in the line it has always said it in.
    if (!this.trackedFolder(path, "folder_rename_from", folders)) return;
    const context = this.need();
    this.folderPublished(path);
    this.folderRemovals.delete(path);
    const queued = this.queue.indexOf(path);
    if (queued !== -1) this.queue.splice(queued, 1);
    if (context.state.folderByPath(path) !== undefined) {
      context.state.forgetFolder(path);
      void this.track(context.state.save()).catch(() => {
        this.stop();
        context.host.log("folder decision=failed reason=state_not_saved");
      });
    }
    context.host.log("folder path_class=folder decision=not_published reason=moved_out_of_scope");
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

  /**
   * How many deletions one pass held back, waiting to be told what they were
   * (issue #123). Zero whenever the last pass published what it found.
   */
  get heldDeletionCount(): number {
    return this.heldDeletions.length;
  }

  /**
   * The user says the deletions were real. THE HELD SET IS PUBLISHED AS IT
   * WAS FOUND, not re-derived: re-scanning here would ask the vault a second
   * question the user has not answered, and a file that came back in the
   * meantime is not in the set the user was shown. Each path is queued
   * exactly as the pass would have queued it, so everything downstream --
   * the "file is present" refusal, the scope check, the echo marks -- still
   * applies, and a note restored between the notice and the click is still
   * refused by the push that finds it on the disk.
   */
  confirmHeldDeletions(): void {
    if (!this.running || this.heldDeletions.length === 0) return;
    const held = this.heldDeletions;
    this.heldDeletions = [];
    this.bulkNoticeShown = false;
    for (const path of held) {
      this.deletions.add(path);
      this.enqueue(path);
    }
    this.options.host.log(`reconcile decision=confirmed reason=bulk_deletion queued=${held.length}`);
  }

  /** Cancel any debounce this path is still owed. */
  private unschedule(path: string): void {
    const entry = this.pending.get(path);
    if (entry === undefined) return;
    this.timers.clear(entry.handle);
    this.pending.delete(path);
  }

  /**
   * A folder appeared in the vault.
   *
   * Publishing it is what makes an EMPTY folder reach the other devices at
   * all: a folder with notes in it arrives as a side effect of their paths,
   * and a folder with none arrived as nothing before 1.1.0 (issue #104).
   *
   * THE ECHO. Obsidian reports a folder this plugin's own pull path made
   * while `createFolder` is still running, so the report arrives BEFORE the
   * record is written and `pushFolder`'s own idempotence cannot see it yet.
   * Unmarked, that costs one signed request per pulled folder, and a folder
   * being RE-created (parents = its old tombstone) would fork into a second
   * head for no content difference at all.
   */
  folderCreated(path: string, barrier = false): void {
    if (!this.running || !this.trackedFolder(path, "folder_create")) return;
    const context = this.need();
    // A folder stands here again, so a delete event still owed for the one
    // the pull path removed will never arrive (`deleted`, issue #96).
    context.trashed.delete(path);
    this.folderRemovals.delete(path);
    if (context.createdFolders.delete(path)) {
      this.options.host.log("watch path_class=folder decision=echo_suppressed event=create");
      return;
    }
    // ARMED BEFORE THE ENQUEUE, because `enqueue` drains synchronously as far
    // as its first await: a barrier armed afterwards could be armed for a path
    // already posted.
    this.publishFolder(path, barrier);
    this.enqueue(path);
  }

  /**
   * A folder left the vault. Its files publish their own tombstones through
   * the delete events Obsidian fires for each of them; this publishes the
   * folder's, which is what removes the empty tree from every other device.
   */
  folderDeleted(path: string, folders: SyncFolders = this.options.state.data.syncFolders): void {
    if (!this.running || !this.trackedFolder(path, "folder_delete", folders)) return;
    const context = this.need();
    context.createdFolders.delete(path);
    this.folderPublished(path);
    if (context.trashed.delete(path)) {
      this.options.host.log("watch path_class=folder decision=echo_suppressed event=delete");
      return;
    }
    this.folderRemovals.add(path);
    this.enqueue(path);
  }

  /**
   * A folder was renamed. A folder record IS its path — a folder has no
   * content to carry an identity through a move — so the old one is
   * tombstoned and the new one published, for this folder and for every
   * folder recorded beneath it. The files inside move as ordinary per-file
   * renames, which keep their file ids (`renamed`).
   */
  folderRenamed(from: string, to: string, sourceFolders: SyncFolders = this.options.state.data.syncFolders): void {
    if (!this.running) return;
    // Nothing moved (`renamed`, review round 4, finding 2), and publishing a
    // tombstone and a record for one path is two versions about a folder that
    // did not change.
    if (from === to) {
      this.options.host.log("watch path_class=folder decision=skipped reason=same_path event=rename");
      return;
    }
    // The selection follows the folder whichever half runs first; the
    // selection each old name is judged against is the caller's, captured
    // before either half ran (`renamedFolder`, `main.ts`). Idempotent by
    // construction: the second call finds no selected folder left to move
    // and returns.
    this.followSelection(from, to);
    const recorded = Object.keys(this.need().state.data.folders);
    // THE FOLDER RECORD IS A WIRE BARRIER FOR A RENAME BY CAPITALISATION
    // ALONE. Only a folder record can re-case a directory on a host that
    // folds case, so a move that overtakes it is refused there with a notice
    // naming a cause that is not the one, and the receiver re-cases with the
    // pre-move version ids (`docs/protocol.md`; review round 2, finding 2).
    // Enqueuing it first is not enough -- a batch runs under `Promise.all` and
    // its journal order is completion order -- so the record's own post is
    // awaited before anything queued behind it is sent (`takeBatch`). Only
    // this folder's record needs it: everything beneath it moved with the
    // directory entry, and the receiver carries those records along.
    const barrier = caseOnly(from, to);
    for (const path of [from, ...recorded.filter((candidate) => candidate.startsWith(`${from}/`))]) {
      const target = to + path.slice(from.length);
      // A FOLDER THAT LEFT THE SCOPE IS NOT A FOLDER THAT WAS DELETED, and a
      // selected folder can now be the one that left: its record is this
      // device's (`trackedFolder`), and its new name may be one no device
      // syncs -- hidden, malformed, or simply outside the selection this
      // rename could not follow. The folder EXISTS there, so a tombstone for
      // it is one every other device obeys, exactly as it is for a file
      // (`leftScope`, issue #91).
      if (vaultPathRefusal(target) !== null || !inFolderScope(target, this.options.state.data.syncFolders)) {
        this.folderLeftScope(path, sourceFolders);
        continue;
      }
      this.folderDeleted(path, sourceFolders);
      this.folderCreated(target, barrier && path === from);
    }
  }

  /**
   * THIS DEVICE OWES THE SERVER A FOLDER RECORD -- and when that record
   * ORDERS the moves queued behind it, the debt outlives this engine (review
   * round 4, finding 3).
   *
   * A rename by capitalisation alone publishes the old spelling's tombstone,
   * then the new record as a wire barrier, then the moves under it
   * (`docs/protocol.md`). Stopped mid-drain -- Obsidian quit, the plugin
   * reloaded, the vault closed -- the barrier died with the drain, and the
   * next start re-derived the record with no barrier and queued it BEHIND the
   * moves it exists to order: the folding receiver refused every one of them
   * and blamed a version problem the pair did not have. So a barrier-bearing
   * publication is written down, and `restoreFolderBarriers` puts it back in
   * front of everything at the next start. An ORDINARY publication needs no
   * note: the next reconcile pass lists the vault, finds the folder without a
   * record and publishes it before any file work (`survey`).
   */
  private publishFolder(path: string, barrier: boolean): void {
    this.folderPublishes.add(path);
    if (!barrier) return;
    this.barriers.add(path);
    const held = this.options.state.data.folderBarriers;
    if (held.includes(path)) return;
    held.push(path);
    this.saveFolderBarriers();
  }

  /** This device owes the publication no longer: drop it, hold and all. */
  private folderPublished(path: string): void {
    this.folderPublishes.delete(path);
    this.releaseFolderHold(path);
  }

  /**
   * The hold is over: the record is on the server, or nothing owes it any
   * more. A publication queued again while this one was in flight -- a
   * watcher reporting one rename twice, a reconcile pass running beside it --
   * publishes nothing of its own, because `pushFolder` finds the record this
   * post has just written.
   */
  private releaseFolderHold(path: string): void {
    const held = this.options.state.data.folderBarriers;
    const at = held.indexOf(path);
    if (at === -1) return;
    held.splice(at, 1);
    this.saveFolderBarriers();
  }

  private saveFolderBarriers(): void {
    void this.track(this.options.state.save()).catch(() => {
      this.stop();
      this.options.host.log("folder decision=failed reason=state_not_saved");
    });
  }

  /**
   * The holds a previous run never got on the wire, put back FIRST.
   *
   * Before any reconciliation and before any file work, because what makes a
   * barrier mean anything is being in FRONT of what it orders: a stop and a
   * start on the same engine keeps the moves this record holds sitting in the
   * queue, and a plugin reload hands a NEW engine the same vault to
   * reconcile, where the pass would queue those moves itself. Either way the
   * record goes to the head of the queue with its barrier re-armed, and
   * nothing under the folder is posted until the server has acknowledged it.
   * A publication the selection no longer covers refuses itself at the post
   * (`pushFolder`) and is forgotten there, so a restored hold can never
   * outlive what it holds.
   */
  private restoreFolderBarriers(): void {
    const held = this.options.state.data.folderBarriers;
    if (held.length === 0) return;
    // In reverse, so the stored order is the order at the front of the queue.
    for (const path of [...held].reverse()) {
      this.folderPublishes.add(path);
      this.barriers.add(path);
      const queued = this.queue.indexOf(path);
      if (queued !== -1) this.queue.splice(queued, 1);
      this.queue.unshift(path);
    }
    this.options.host.log(
      `engine decision=restored reason=folder_barrier folders=${held.length}`,
    );
    void this.track(this.drain());
  }

  /** The live context, for views that read remote-only accounting. */
  get context(): SyncContext | null {
    return this.contextValue;
  }

  private debounce(path: string, tries: number, seen: Settled | null = null): void {
    if (!this.running) return;
    const existing = this.pending.get(path);
    if (existing) this.timers.clear(existing.handle);
    const handle = this.timers.set(() => {
      void this.track(this.settle(path, tries, seen));
    }, tries === 0 ? DEBOUNCE_MS : RECHECK_MS);
    this.pending.set(path, { handle, tries });
  }

  /**
   * The growing-file guard: this stat and the one `RECHECK_MS` ago agree, or
   * wait again. Also the echo gate — a file whose stat matches a write we
   * just made is our own pull coming back and is dropped.
   */
  private async settle(path: string, tries: number, seen: Settled | null): Promise<void> {
    this.pending.delete(path);
    if (!this.running) return;
    const context = this.need();
    // The filesystem gate, which the synchronous watcher entry points cannot
    // run: a path whose components include a symlink is not synced, and the
    // host says so once. Anything else that goes wrong while settling is
    // logged rather than thrown into a timer callback.
    try {
      if (!(await context.host.syncable(path))) return;
      await this.settleTracked(context, path, tries, seen);
    } catch (error) {
      context.host.log(
        `watch path_class=file decision=failed reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async settleTracked(
    context: SyncContext,
    path: string,
    tries: number,
    seen: Settled | null,
  ): Promise<void> {
    const stat = await context.host.stat(path);
    if (!stat) {
      this.deletions.add(path);
      this.enqueue(path);
      return;
    }
    const key = `${path}:${stat.mtime}:${stat.size}`;
    if (context.written.has(key)) {
      context.written.delete(key);
      context.host.log(`watch path_class=file decision=echo_suppressed`);
      return;
    }
    const record = context.state.fileByPath(path);
    if (record && record.mtime === stat.mtime && record.size === stat.size) return;
    // `seen` is the stat the previous settle took, one `RECHECK_MS` timer
    // ago: comparing against it is what puts real time between the two
    // observations. The first settle has nothing to compare with, so it
    // always waits once.
    if (seen === null || seen.stat.mtime !== stat.mtime || seen.stat.size !== stat.size) {
      if (tries % 25 === 24) context.host.log(`watch path_class=file decision=still_growing tries=${tries + 1}`);
      this.debounce(path, tries + 1, { stat, agreed: 0, grew: seen !== null });
      return;
    }
    // A file this device WATCHED change must then hold still for `QUIET_MS`,
    // not for one recheck: a large copy pauses, and two rechecks inside one
    // pause agree about a file that is still growing.
    const agreed = seen.agreed + 1;
    if (agreed < (seen.grew ? QUIET_RECHECKS : 1)) {
      this.debounce(path, tries + 1, { ...seen, agreed });
      return;
    }
    // Only now is the entry retired: the returns above re-arm it through
    // `debounce`, and clearing it before them would drop the timer this
    // settle just decided to take again.
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
        const batch = this.takeBatch(context.concurrency);
        this.status({ kind: "syncing", pending: this.queue.length + batch.length });
        this.active = batch.length;
        await Promise.all(batch.map((path) => this.pushOne(path)));
        this.active = 0;
      }
      // Nothing is queued behind anything any more, so no barrier can still
      // mean something. Expiring them here is what keeps one armed for a path
      // that never reached the queue from serialising a later push of that
      // same name.
      this.barriers.clear();
      this.barrierPath = null;
      this.status({ kind: "idle" });
    } finally {
      this.draining = false;
    }
  }

  /**
   * The next batch, and the one place the WIRE order is decided.
   *
   * A batch runs under `Promise.all`, so every path in it is posted
   * concurrently and the journal's order is completion order. For the folder
   * record of a rename that changes case alone that is not good enough: it is
   * the only record entitled to re-case a directory, and a move that reaches
   * the receiver first is refused there (`docs/protocol.md`). Such a record is
   * a BARRIER: taken alone, and awaited -- the loop above finishes a batch
   * before it takes another -- so nothing queued behind it is sent until the
   * server has acknowledged it. Paths queued BEFORE it still go together: a
   * barrier orders what follows it, it does not stop the queue.
   */
  private takeBatch(concurrency: number): string[] {
    // Cleared first, so the note of what a batch is carrying can never
    // outlive the batch that carried it.
    this.barrierPath = null;
    const first = this.queue[0] as string;
    if (this.barriers.delete(first)) {
      this.barrierPath = first;
      return this.queue.splice(0, 1);
    }
    const behind = this.queue.findIndex((path) => this.barriers.has(path));
    return this.queue.splice(0, behind === -1 ? concurrency : Math.min(concurrency, behind));
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
      // Folder work first: a path is a folder or a file, never both, and the
      // folder sets are the only ones that can name a path with no stat.
      if (this.folderRemovals.delete(path)) {
        const versionId = await pushFolderDelete(context, path);
        if (versionId !== null) context.authored.add(versionId);
        return;
      }
      if (this.folderPublishes.delete(path)) {
        // THE BARRIER IS THIS POST'S, NOT THIS ATTEMPT'S (review round 3,
        // finding 3). `takeBatch` took it as it took the path, and a post
        // that fails here is the one case where letting it go is wrong:
        // everything queued behind it is a move the receiver can only refuse
        // until this record lands.
        const barrier = this.barrierPath === path;
        this.barrierPath = null;
        try {
          const versionId = await pushFolder(context, path);
          if (versionId !== null) context.authored.add(versionId);
          this.folderRetries.delete(path);
          // ACKNOWLEDGED, AND ONLY NOW IS THE HOLD OVER. The path left
          // `folderPublishes` above so the drain cannot post it twice, but
          // what SURVIVES A STOP is this line's business: a note released
          // when the post BEGAN would be gone if the stop landed while it was
          // in flight, which is exactly the window the hold exists for
          // (review round 4, finding 3).
          this.releaseFolderHold(path);
        } catch (error) {
          this.retryFolder(context, path, barrier, error);
        }
        return;
      }
      if (this.deletions.has(path)) {
        this.deletions.delete(path);
        const outcome = await pushDelete(context, path);
        if (outcome !== null) {
          context.authored.add(outcome.versionId);
          return;
        }
        // No tombstone was posted: either nothing was recorded to delete, or
        // the file is there after all and `pushDelete` refused to say it was
        // gone. A file that is there is a change, which is the rest of this
        // function; a path with nothing at it and nothing recorded is done.
        if ((await context.host.stat(path)) === null) return;
      }
      const forced = this.renames.delete(path);
      const outcome = await pushFile(context, path, forced);
      if (outcome.status === "unchanged") return;
      if (outcome.status === "growing") {
        // The file moved while it was read: nothing was published, so this is
        // the debounce's case again and not a failure (issue #99).
        if (forced) this.renames.add(path);
        this.debounce(path, 0);
        return;
      }
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
   * A folder record's post FAILED, and what the queue owes it.
   *
   * `takeBatch` deleted the barrier as it took the path and `pushNow` deleted
   * the path from `folderPublishes` before the post, so before this the
   * publication simply ceased to exist: the moves queued behind it went out
   * alone, a folding receiver refused every one of them with a notice naming
   * a cause that was not the one, and nothing re-derived the record until the
   * next start (review round 3, finding 3). `docs/protocol.md` states the
   * order as a promise about the WIRE, and a promise that holds only when the
   * post succeeds is not the one it states.
   *
   * So the publication and its barrier are put back, in front of the moves
   * they order -- at the FRONT of the queue, because a barrier orders what is
   * behind it and re-queuing it at the back would leave it behind the very
   * moves it holds. `FOLDER_POST_TRIES` attempts bound it; at the bound the
   * hold expires with its own decision and one notice, and the next start's
   * reconcile pass republishes the record.
   */
  private retryFolder(context: SyncContext, path: string, barrier: boolean, error: unknown): void {
    const attempt = (this.folderRetries.get(path) ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    // A POST THAT FAILS AFTER THIS ENGINE STOPPED HAS NO QUEUE TO GO BACK
    // INTO, and what survives a stop is written down rather than re-armed
    // (`publishFolder`; review round 4, finding 3). It matters beyond the
    // dead queue: a plugin reload hands a NEW engine the same state, and this
    // engine's late failure would otherwise put back a hold the engine that
    // replaced it has already discharged -- a record owed for ever, in front
    // of moves that had already gone.
    if (!this.running) {
      context.host.log(`push path_class=folder decision=deferred reason=stopped attempt=${attempt}`);
      return;
    }
    if (error instanceof VaultPathError) {
      this.folderRetries.delete(path);
      this.releaseFolderHold(path);
      context.host.log(`push path_class=folder decision=not_synced reason=${error.refusal}`);
      return;
    }
    if (attempt >= FOLDER_POST_TRIES) {
      this.folderRetries.delete(path);
      this.releaseFolderHold(path);
      context.host.log(
        `push path_class=folder decision=expired reason=folder_post attempt=${attempt} budget=${FOLDER_POST_TRIES}`,
      );
      this.status(error instanceof ApiError && error.code === "unreachable" ? { kind: "offline" } : { kind: "error", message });
      if (!this.folderPostNoticeShown) {
        this.folderPostNoticeShown = true;
        context.host.notify(
          "obsync could not tell your other devices about a folder this device published or renamed: the server " +
            `refused the folder record ${FOLDER_POST_TRIES} times. Nothing was lost here and nothing was deleted ` +
            "anywhere. Until this device syncs again, another device may still show that folder under its old " +
            "capitalisation and refuse the notes moved inside it; this device republishes the folder the next time " +
            "it starts.",
        );
      }
      return;
    }
    this.folderRetries.set(path, attempt);
    this.publishFolder(path, barrier);
    // In FRONT: what this record orders is already queued behind it.
    if (!this.queue.includes(path)) this.queue.unshift(path);
    context.host.log(
      `push path_class=folder decision=retry reason=folder_post attempt=${attempt} budget=${FOLDER_POST_TRIES}`,
    );
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

  // --- reconciliation, the periodic scan and the heartbeat ---------------

  /**
   * Startup reconciliation over Obsidian's own listing: queue what differs
   * from the local record, pair the moves, and publish a tombstone for every
   * recorded path the vault no longer has. This is what makes an edit made
   * while Obsidian was closed, or a file deleted in Finder, reach the server.
   */
  reconcile(): Promise<void> {
    return this.track(this.reconcileLocal());
  }

  private async reconcileLocal(): Promise<void> {
    await this.survey(await this.need().host.list(), true, "reconcile");
  }

  /**
   * The periodic pass: the host's OWN listing, additive only.
   *
   * It never publishes a tombstone. A listing this device took itself is the
   * right thing to converge FROM -- it sees a change Obsidian has not noticed
   * yet, which is the whole point -- and the wrong thing to delete on, because
   * a folder it could not read would otherwise erase a subtree. Deletions stay
   * with the watcher and with startup reconciliation, which read Obsidian's
   * own index.
   */
  private scanTick(): void {
    if (!this.running) return;
    this.scanHandle = null;
    void this.track(this.scanLocal().finally(() => {
      if (this.running && this.scanHandle === null) {
        this.scanHandle = this.timers.set(() => this.scanTick(), SCAN_MS);
      }
    }));
  }

  private async scanLocal(): Promise<void> {
    const context = this.need();
    try {
      const own = context.host.scan === undefined ? null : await context.host.scan();
      await this.survey(own ?? await context.host.list(), false, "scan");
    } catch (error) {
      context.host.log(
        `scan decision=failed reason=${error instanceof Error ? error.message : String(error)} budget_ms=${SCAN_BUDGET_MS}`,
      );
    }
  }

  /**
   * Compare a listing against the local record and act on what differs.
   *
   * MOVES. A file moved from outside Obsidian arrives here as a recorded path
   * that is gone and an unrecorded path that is new, carrying the SAME
   * `(mtime, size)` -- a move preserves both, which a copy-and-delete does
   * not. Pairing them and routing the pair through `renamed` keeps the file
   * id, so the other devices move the note instead of deleting one and
   * downloading another, and no tombstone is ever posted for a live file
   * (issue #101). An ambiguous pair -- two candidates with identical size and
   * mtime -- is not paired, because guessing which note moved is worse than
   * publishing both halves.
   *
   * COST. The filesystem question (`syncable`) is asked only about paths this
   * pass is about to act on, never about every file in the vault: that is
   * what makes a pass every `SCAN_MS` affordable on a large vault, and it
   * decides nothing differently, because an unchanged file is not queued
   * either way.
   */
  private async survey(files: VaultStat[], tombstones: boolean, label: string): Promise<void> {
    const context = this.need();
    const started = context.now();
    const seen = new Set<string>();
    const fresh: VaultStat[] = [];
    let skipped = 0;
    // FOLDERS ARE THE RECONCILE PASS'S BUSINESS, not the periodic scan's.
    // The scan is additive and never publishes a tombstone, and a folder
    // record IS its path -- there is no content to converge from -- so a
    // scan could only ever add folders the next reconcile adds anyway.
    // Listing them every `SCAN_MS` would be a walk of the vault for nothing.
    const folders = tombstones ? await context.host.listFolders() : [];
    // START, with the budget this pass is bounded by: the vault's own
    // inventory, walked once (requirement 12).
    if (tombstones) {
      context.host.log(
        `${label} decision=start budget_files=${files.length} budget_folders=${folders.length}`,
      );
    }
    // FIRST, AND BEFORE ANY FILE WORK (review round 3, finding 2). A folder
    // renamed by capitalisation alone while Obsidian was closed is this
    // pass's to find, and the order it publishes in is the wire order the
    // protocol states: the old record's tombstone, then the new record as a
    // barrier, then the moves underneath -- which queue behind that barrier
    // precisely because they are queued after it.
    const casedFolders = tombstones ? await this.recaseFolders(context, folders, label) : new Set<string>();
    // AND EVERY FOLDER RECORD THIS DEVICE STILL OWES, ALSO BEFORE THE FILE
    // WORK (review round 4, finding 3). Publishing a record for a folder that
    // has none is how a vault that predates 1.1.0 converges once both devices
    // update -- and it is also what re-derives a publication a stop lost, so
    // it must not be queued behind the moves under that folder: a receiver
    // that folds case can apply none of them until the record lands. The
    // barrier that ORDERS them is restored before this pass runs at all
    // (`restoreFolderBarriers`), and nothing here arms one: a folder with no
    // record on any device is not a rename anybody is waiting for.
    let folderQueued = 0;
    let folderSkipped = 0;
    const present = new Set<string>();
    if (tombstones) {
      for (const folder of folders) {
        if (!this.running) return;
        if (!this.trackedFolder(folder, "reconcile_folder") || !(await context.host.syncable(folder, "folder"))) {
          folderSkipped++;
          continue;
        }
        present.add(folder);
        if (casedFolders.has(folder)) continue;
        if (context.state.folderByPath(folder) !== undefined) continue;
        this.publishFolder(folder, false);
        this.enqueue(folder);
        folderQueued++;
      }
    }
    for (const file of files) {
      if (!this.running) return;
      if (!this.tracked(file.path, label)) { skipped++; continue; }
      seen.add(file.path);
      if (isPushed(context.state.fileByPath(file.path), file.mtime, file.size)) continue;
      fresh.push(file);
    }
    // The listing by folded name, built once: a vault of ten thousand files
    // and a folder of a hundred deletions must not cost a million
    // comparisons to ask one question about each. It is built from the WHOLE
    // listing and not from `fresh`, because a rename by capitalisation alone
    // changes neither stat, so the new spelling is never fresh.
    const spellings = new Map<string, string[]>();
    for (const path of seen) {
      const folded = path.toLowerCase();
      spellings.set(folded, [...(spellings.get(folded) ?? []), path]);
    }
    const gone = Object.keys(context.state.data.files).filter((path) => !seen.has(path));
    // The directories this device's records live in, taken ONCE before
    // anything moves: `recordsOnly` asks whether the destination's is already
    // one of them, and a pass that re-read it would answer differently for the
    // second file of a folder than for the first.
    const recordedFolders = new Set(Object.keys(context.state.data.files).map(folderOf));

    // NORMALISATION IS NOT A MOVE. A listing can spell a recorded name
    // differently without anything having happened: Obsidian's index is NFC
    // (`normalizePath`), a macOS volume keeps an accented name decomposed,
    // and the two spellings are one note. Paired as a move, that difference
    // publishes a rename to the other spelling, and the device applying it
    // writes one path and trashes the other -- the same file wherever the
    // volume ignores the difference, so the note is deleted (the #96 class
    // of loss). `scan()` normalises its own listing (`main.ts`); this refuses
    // the pair whatever a listing says, and refuses to queue the twin as a
    // new file or to tombstone the record it belongs to.
    const settled = new Set<string>();
    const recorded = new Map(gone.map((path) => [path.normalize("NFC"), path]));
    let unnormalised = 0;
    for (const file of fresh) {
      const twin = recorded.get(file.path.normalize("NFC"));
      if (twin === undefined) continue;
      settled.add(file.path);
      settled.add(twin);
      unnormalised++;
    }
    // One line for the pass, with a count and no path: a name is vault
    // content and never reaches a log (requirement 6).
    if (unnormalised > 0) context.host.log(`${label} decision=skipped reason=normalisation_only files=${unnormalised}`);

    // Moves first: a paired destination must not also be queued as a new
    // file, and a paired source must not also be tombstoned. A path the
    // normalisation check settled is handled in exactly the same way.
    let moves = 0;
    let declined = 0;
    for (const from of gone) {
      if (!this.running) return;
      const record = context.state.fileByPath(from);
      if (record === undefined || settled.has(from)) continue;
      const candidates = fresh.filter((file) => !settled.has(file.path) &&
        file.mtime === record.mtime && file.size === record.size &&
        context.state.fileByPath(file.path) === undefined);
      if (candidates.length !== 1) continue;
      const to = (candidates[0] as VaultStat).path;
      if (await this.recordsOnly(context, from, to, recordedFolders, label)) {
        settled.add(to);
        settled.add(from);
        declined++;
        continue;
      }
      if (!(await context.host.syncable(to))) { skipped++; continue; }
      settled.add(to);
      settled.add(from);
      moves++;
      this.renamed(from, to);
    }

    // RECORDS THAT LEFT THE LISTING, and the two things that can be true of
    // one. The `(mtime, size)` pairing above cannot see a rename by
    // CAPITALISATION alone: it changes neither stat, and on a host that
    // folds case it does not even change the directory entry, so the new
    // spelling is in the listing and never in `fresh` (issue #124). That is
    // asked here, before anything is tombstoned, and in BOTH passes --
    // pairing a rename is additive, which is exactly what the periodic scan
    // is allowed to do. What is left is a record the vault really does not
    // have, and only the pass that reads Obsidian's own index may publish a
    // tombstone for it.
    let cased = 0;
    const candidates: string[] = [];
    for (const from of gone) {
      if (!this.running) return;
      if (settled.has(from)) continue;
      if (!this.tracked(from, `${label}_state`) || !(await context.host.syncable(from))) { skipped++; continue; }
      if (await this.caseRenamed(context, from, spellings.get(from.toLowerCase()) ?? [], recordedFolders, label)) {
        settled.add(from);
        cased++;
        continue;
      }
      if (!tombstones) continue;
      candidates.push(from);
    }

    // A BULK DELETION IS A QUESTION, NOT AN INSTRUCTION (issue #123). A
    // selected folder renamed from outside Obsidian while the app was closed
    // reaches this pass as EVERY recorded path under it having vanished: no
    // rename event ever arrived, the new paths sit outside the selection, and
    // the old ones are gone. Published, those tombstones delete the notes on
    // every other device, while the notes themselves sit untracked on this
    // one under the new name. The vault is not empty and nothing asked for a
    // deletion; the only thing that happened is that this device stopped
    // being able to see its own files.
    //
    // So the pass holds them, says what it found, and publishes nothing until
    // the user says which it was. `confirmHeldDeletions` is the other half:
    // a folder the user really did delete still reaches every device, one
    // click later. The rule is deliberately about SHARE and not about
    // folders -- a rename of the one selected folder, a move of the vault
    // root, and a volume that mounted empty all arrive here identically, and
    // the share is what they have in common.
    //
    // ONLY THIS PASS MAY TOUCH THE HOLD. The periodic scan reaches here with
    // no candidates at all -- it never tombstones -- so letting it fall into
    // the publishing branch below would clear a hold the startup pass took,
    // thirty seconds later and with nobody asked. The whole decision is
    // therefore inside `tombstones`.
    let removed = 0;
    const tracked = Object.keys(context.state.data.files).length;
    if (!tombstones) {
      // Nothing to publish and nothing to decide.
    } else if (candidates.length >= BULK_DELETION_MIN && candidates.length * 2 > tracked) {
      this.heldDeletions = candidates;
      context.host.log(
        `${label} decision=refused reason=bulk_deletion candidates=${candidates.length} tracked=${tracked}`,
      );
      if (!this.bulkNoticeShown) {
        this.bulkNoticeShown = true;
        context.host.notify(
          `obsync stopped ${candidates.length} deletions it was about to send to your other devices: ` +
            `it can no longer see ${candidates.length} of the ${tracked} notes it syncs here, and nothing ` +
            "asked for them to be deleted. A folder renamed or moved outside Obsidian looks exactly like " +
            "this. Put it back, or select it under its new name in Sync folders -- or, if you really did " +
            "delete them, confirm it under Settings, obsync, \"Deletions held back\".",
        );
      }
    } else {
      this.heldDeletions = [];
      this.bulkNoticeShown = false;
      for (const from of candidates) {
        this.deletions.add(from);
        this.enqueue(from);
        removed++;
      }
    }

    let queued = 0;
    for (const file of fresh) {
      if (!this.running) return;
      if (settled.has(file.path)) continue;
      if (!(await context.host.syncable(file.path))) { skipped++; continue; }
      this.enqueue(file.path);
      queued++;
    }
    // AND THE TOMBSTONE HALF LAST, after the file work: a folder record is
    // retired once the notes under it have published their own tombstones, so
    // the receiver's folder is empty by the time it is asked to remove it.
    if (tombstones) {
      for (const folder of Object.keys(context.state.data.folders)) {
        if (!this.running) return;
        if (present.has(folder) || casedFolders.has(folder)) continue;
        if (!this.trackedFolder(folder, "reconcile_folder_state")) { folderSkipped++; continue; }
        this.folderRemovals.add(folder);
        this.enqueue(folder);
        folderQueued++;
      }
    }

    const duration = context.now() - started;
    // The periodic pass is silent when it had nothing to say: one line every
    // 30 s about an unchanged vault buries the lines that matter. It speaks
    // whenever it acted, and whenever it overran the budget it is measured
    // against.
    if (tombstones || queued + removed + skipped + moves + cased + declined + folderQueued > 0 || duration > SCAN_BUDGET_MS) {
      context.host.log(
        `${label} decision=queued files=${seen.size} queued=${queued} moved=${moves} removed=${removed} ` +
          `folders=${present.size} folders_queued=${folderQueued} folders_skipped=${folderSkipped} ` +
          `skipped=${skipped} budget_ms=${SCAN_BUDGET_MS} duration_ms=${duration} cased=${cased} ` +
          `not_paired=${declined}`,
      );
    }
    // LAST, because this pass's own pairings consume marks (`renamed`).
    this.sweepEchoes(context, label);
  }

  /**
   * The folder renames this pass DISCOVERED: a folder this device records
   * under a spelling the vault no longer shows, beside a listed folder that
   * differs from it in capitalisation alone. Obsidian was closed when it
   * happened, so no rename event ever arrived and only a pass that reads the
   * vault's own inventory will ever see it.
   *
   * THE ORDER IS THE HANDLER'S ORDER, AND IT IS LOAD-BEARING. Published the
   * other way round -- the record for the new spelling first and the
   * tombstone for the old one behind it, which is what two separate loops
   * produced -- a folding receiver re-cased the directory from the record and
   * then took the tombstone for the spelling it had just left: `trashFolder`
   * resolves that name to the ONE directory entry the rename produced, found
   * an EMPTY folder there and removed it, and the receiver's own next pass
   * tombstoned the record it had just written, so the folder was gone on both
   * devices (review round 3, finding 2). The tombstone therefore goes first
   * and the record follows it as a wire barrier, exactly as `folderRenamed`
   * sends a rename this device was told about (`docs/protocol.md`).
   *
   * AND BEFORE THE FILE WORK, because the moves this pass publishes for the
   * notes underneath (`caseRenamed`) are queued after whatever is queued
   * here: behind the barrier, where the protocol says they belong, instead of
   * overtaking the record that is the only thing entitled to re-case the
   * directory on the receiving side.
   */
  private async recaseFolders(context: SyncContext, folders: string[], label: string): Promise<Set<string>> {
    const handled = new Set<string>();
    const listed = new Set(folders);
    const spellings = new Map<string, string[]>();
    for (const folder of folders) {
      const folded = folder.toLowerCase();
      spellings.set(folded, [...(spellings.get(folded) ?? []), folder]);
    }
    for (const from of Object.keys(context.state.data.folders)) {
      if (!this.running) break;
      // TWO FACTS, AND AMBIGUITY IS NOT EVIDENCE (`caseRenamed`, one kind
      // over). The listing no longer spells this folder the recorded way, and
      // it holds exactly ONE folder that differs from it in case alone. A
      // listing holding both, or three spellings of one name, is a host
      // saying something no filesystem can be, and nothing is renamed on it.
      if (listed.has(from)) continue;
      const candidates = (spellings.get(from.toLowerCase()) ?? []).filter((candidate) => caseOnly(candidate, from));
      if (candidates.length !== 1) continue;
      const to = candidates[0] as string;
      // A destination this device already records is not this device's to
      // rename -- that is the ghost `caseRenamed` describes, and dropping a
      // record is never a tombstone.
      if (context.state.folderByPath(to) !== undefined) continue;
      if (!this.trackedFolder(from, "reconcile_folder_case") || !this.trackedFolder(to, "reconcile_folder_case")) continue;
      if (!(await context.host.syncable(to, "folder"))) continue;
      handled.add(from);
      handled.add(to);
      // Contradictory pending work for either name is dropped, exactly as the
      // handlers drop it: a path is a removal or a publication, never both,
      // and `pushNow` would otherwise answer the removal for both.
      this.folderPublished(from);
      this.folderRemovals.add(from);
      this.enqueue(from);
      this.folderRemovals.delete(to);
      // ARMED BEFORE THE ENQUEUE, because `enqueue` drains synchronously as
      // far as its first await (`folderCreated`).
      this.publishFolder(to, true);
      this.enqueue(to);
      // No path in the line: a name is vault content (requirement 6).
      context.host.log(`${label} path_class=folder decision=case_renamed`);
    }
    return handled;
  }

  /**
   * Expire the echo marks armed for vault events that never arrived.
   *
   * Every write, move and removal the pull path makes is marked before it
   * runs, because Obsidian reports it to this plugin's own handlers and an
   * unmarked report is published straight back at the device that made it
   * (ECHOES, issue #96). A mark is consumed by the event it was armed for --
   * on a host that delivers one. The desktop watcher is asynchronous and a
   * folder re-case fans out into per-file moves the app never reports at all
   * (`pull.ts`, `recaseFolder`), so marks are left armed for events that will
   * never come, and the NEXT genuine rename, deletion or creation of exactly
   * those paths is suppressed once instead -- a suppressed folder tombstone
   * being one no later scan re-derives (review round 2, finding 5).
   *
   * SO THEY ARE BOUNDED, by one whole scan cycle: a mark still armed when a
   * second pass finds it is expired there. That is `SCAN_MS` of grace for an
   * event Obsidian delivers in the same turn or the next one, and it asks the
   * vault nothing -- the periodic pass deliberately does not list folders
   * (`survey`, COST), so a folder mark could not be tested against a listing
   * without walking the vault every 30 s for a set that is almost always
   * empty. An expired mark costs at most one republished change, which the
   * device that made it applies as the no-op it is; an unexpired one costs a
   * change that is never published at all.
   */
  private sweepEchoes(context: SyncContext, label: string): void {
    const armed = new Set<string>();
    let expired = 0;
    for (const [name, marks] of [
      ["moved", context.moved],
      ["trashed", context.trashed],
      ["created_folders", context.createdFolders],
      // The WRITE marks too, and the reason they are here is the second key
      // `landedAt` registers for a file that landed in a directory the vault
      // spells another way: one of the two is consumed by the watcher and the
      // other never is, so an unbounded set grew by one key per such file
      // until the plugin was reloaded (review round 3, finding 4c). An
      // expired write mark costs one re-chunk of a file whose recorded digest
      // has not changed, which publishes nothing.
      ["written", context.written],
    ] as [string, Set<string>][]) {
      for (const mark of marks) {
        const tagged = `${name}\u0000${mark}`;
        if (this.echoSweep.has(tagged)) {
          marks.delete(mark);
          expired++;
        } else {
          armed.add(tagged);
        }
      }
    }
    this.echoSweep = armed;
    // No path in the line: a name is vault content (requirement 6).
    if (expired > 0) context.host.log(`${label} decision=echo_expired marks=${expired} armed=${armed.size}`);
  }

  /**
   * A pairing whose difference lies in a DIRECTORY component, where the vault
   * has not moved anything: the record follows the vault's spelling, and
   * nothing is published.
   *
   * `rename(2)` resolves the directory components of a destination and renames
   * only the last one, so a note's own version can never re-case the folder it
   * lives in -- only a folder record can (`pull.ts`, `recaseFolder`).
   * Published as a rename, such a pairing is a rename no device made: a
   * device that folds case finds no record at that spelling, keeps both, and
   * every note created in that folder while the two spellings disagree becomes
   * a duplicate on both devices (review round 2, finding 3).
   *
   * THREE FACTS, AND ALL THREE ARE NEEDED. The two names differ in a directory
   * component and in case alone; the host still answers for the name its own
   * listing dropped, which is the folding host where the two are ONE entry and
   * nothing can have moved; and this device already records other files under
   * the destination's own spelling of that directory, which is what tells a
   * stale record apart from a folder rename this device has just DISCOVERED --
   * there, every record under the folder is moving and none names the
   * destination's spelling yet, and those moves must publish or a
   * case-sensitive device never learns of them.
   *
   * The record follows the vault rather than being dropped: the file keeps its
   * id, its later versions take the refusal path exactly as a tracked note's
   * do, and the next scan finds a record that agrees with the listing instead
   * of re-offering the same pairing every 30 s.
   */
  private async recordsOnly(
    context: SyncContext,
    from: string,
    to: string,
    recordedFolders: Set<string>,
    label: string,
  ): Promise<boolean> {
    if (!caseOnly(from, to) || folderOf(from) === folderOf(to)) return false;
    if (!recordedFolders.has(folderOf(to))) return false;
    if ((await context.host.stat(from)) === null) return false;
    const record = context.state.fileByPath(from);
    if (record !== undefined) {
      context.state.setFile(to, record);
      context.state.forgetPath(from);
      void this.track(context.state.save()).catch(() => {
        this.stop();
        context.host.log(`${label} decision=failed reason=state_not_saved`);
      });
    }
    context.host.log(`${label} path_class=file decision=not_paired reason=folder_case`);
    return true;
  }

  /**
   * Was this recorded path moved by CASE ALONE, on a host that folds case?
   *
   * TWO FACTS, AND ONLY A FOLDING HOST GIVES BOTH. The listing no longer
   * spells this path but holds exactly one that differs from it in case
   * alone, and the host still answers for the spelling its own listing has
   * dropped. A host that keeps the two apart answers `null` for a file that
   * is really gone, so this never fires there and a genuine deletion beside
   * a genuinely different note whose name differs only in case still
   * publishes its tombstone. On a folding host the two spellings ARE one
   * directory entry, so what happened to it can only have been a rename:
   * recording it as one keeps the file id, and every other device then MOVES
   * its copy instead of receiving a second one it never retires.
   *
   * A NEW SPELLING THAT IS ALREADY TRACKED is the residue of that defect
   * rather than the defect: something published the rename as new files
   * instead of as a move -- a device older than 1.1.0, or this one before the
   * selection was captured for both halves of a folder rename (review round
   * 2, finding 1) -- and this record is a ghost of the id it left behind. Its deletion must never be published -- on this folding host the
   * ghost's path IS the live note, and a tombstone is obeyed by every device
   * -- so the record is dropped and nothing is published, removed or
   * renamed. That is the half of the recovery a device can prove by itself;
   * `docs/troubleshooting.md` carries the half only the user can do.
   */
  private async caseRenamed(
    context: SyncContext,
    path: string,
    folded: string[],
    recordedFolders: Set<string>,
    label: string,
  ): Promise<boolean> {
    const spellings = folded.filter((candidate) => caseOnly(candidate, path));
    const to = spellings.length === 1 ? (spellings[0] as string) : null;
    if (to === null || (await context.host.stat(path)) === null) return false;
    if (context.state.fileByPath(to) === undefined) {
      // The host answered for a name its own listing has dropped, so the two
      // spellings are one entry here; `recordsOnly` is what separates a
      // DIRECTORY this device's records already resolve the other way from a
      // folder rename this device has only just discovered.
      if (await this.recordsOnly(context, path, to, recordedFolders, label)) return true;
      context.host.log(`${label} path_class=file decision=case_renamed`);
      this.renamed(path, to);
      return true;
    }
    context.state.forgetPath(path);
    void this.track(context.state.save()).catch(() => {
      this.stop();
      context.host.log(`${label} decision=failed reason=state_not_saved`);
    });
    context.host.log(`${label} path_class=file decision=case_ghost_forgotten`);
    if (!this.caseGhostNoticeShown) {
      this.caseGhostNoticeShown = true;
      context.host.notify(
        "obsync: this device holds records for one folder under two capitalisations, and the notes under the " +
          "spelling it no longer shows are already tracked under the one it does. It has stopped tracking the " +
          "old spelling and deleted nothing. If another device shows TWO folders whose names differ only in " +
          "capitalisation, update every device first, let each sync once, and only then delete the stale " +
          "folder there -- see Troubleshooting, \"Two folders that differ only in capitalisation\".",
      );
    }
    return true;
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
    // THE TICK IS THE ONE THAT CAN WAIT (issue #103). The repair tick and a
    // manual history operation share one read slot, and a collision used to
    // surface as "Server repair could not verify a retained file" -- a
    // message sending the user to check connectivity and the server's scrub
    // report, for a benign scheduling overlap, during recovery, which is the
    // moment they can least absorb a false alarm. The tick runs every second;
    // the dialog is in front of a person. So the tick yields while one is
    // open and comes back a second later.
    if (this.options.transport.manualBusy) {
      if (this.repairDeferredAt === null) {
        this.repairDeferredAt = this.nowFn();
        this.repairDeferredTicks = 0;
        this.options.host.log(
          `repair decision=deferred reason=busy budget_sids=${REPAIR_BATCH_SIDS} budget_chunks=1 duration_ms=0`,
        );
      }
      this.repairDeferredTicks++;
      if (this.repairHandle !== null) this.timers.clear(this.repairHandle);
      this.repairHandle = this.timers.set(() => { void this.repairTick(); }, REPAIR_TICK_MS);
      return Promise.resolve();
    }
    if (this.repairDeferredAt !== null) {
      this.options.host.log(
        `repair decision=resumed reason=history_closed ticks=${this.repairDeferredTicks} ` +
          `duration_ms=${this.nowFn() - this.repairDeferredAt}`,
      );
      this.repairDeferredAt = null;
    }
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
    } catch (error) {
      // Do not expose a source path or untrusted transport/manifest error.
      if (this.running && this.repair === repair) {
        // A read that never left the device is the collision again, one layer
        // down: the dialog took the slot between the check above and this
        // step's own read. It is never an error status (issue #103).
        const busy = error instanceof Error && error.name === "HistoryBusyError";
        // A server that is simply not there is absence, not a repair problem:
        // the status bar already reads `offline — retrying` from the first
        // unanswered attempt, and an error sending an offline person to the
        // server's scrub report is a false alarm (the 2026-09-23 run).
        const absent = error instanceof ApiError && error.code === "unreachable";
        host.log(`repair decision=deferred reason=${busy ? "busy" : absent ? "unreachable" : "read_or_write_failed"} ${budget()}`);
        if (absent) delay = REPAIR_SCAN_MS;
        else if (!busy) {
          this.status({
            kind: "error",
            message: "Server repair could not verify a retained file: this device could not read it or the server would not take it. " +
              "It retries within five minutes; check connectivity and the server scrub report.",
          });
          delay = REPAIR_SCAN_MS;
        }
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
