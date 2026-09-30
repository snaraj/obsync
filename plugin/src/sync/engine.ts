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
 * copy simply takes as long as it takes. A note someone is typing in is the
 * one exception: the editor's save settles after `EDITOR_SETTLE_MS`, at its
 * first look (issue #195).
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
 * else, which is what takes the config folder and `.git/**` out of sync in v0.1
 * (`vaultPath.ts` states the rule and why hidden folders wait for an opt-in).
 *
 * PLATFORM. Concurrency is 4 on desktop and 2 on mobile; the desktop host
 * streams files through Node's `fs` while the mobile host reads and writes
 * whole files through the vault adapter. Both use the same loops.
 */

import { forgottenCredential, FORGOTTEN_DEVICE } from "../accountRecovery";
import { ByteSource, CHUNK_MAX } from "../chunker";
import { Bytes, deriveDomainKey, deriveManifestKey, unhex } from "../crypto";
import type { SyncNotice } from "../notices";
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
import { ApiError, ChangeRecord, ChangesPage, EDGE_REQUIRED, FileRecord, INTERACTIVE_MS, NOT_OBSYNC, SessionEnded, Transport, certificateRefusal } from "../transport";
import { VaultPathError, errorText, caseOnly, vaultPathRefusal } from "../vaultPath";
import { SyncFolders, inFolderScope, inSyncScope, movedSelection, selectionAfterRename } from "../syncScope";
import { ANSWER_MS, ApplyResult, answerOf, announceCopies, decodeRecordManifest, droppedWrite, EDITING_WINDOW_MS, HeldNote, Prefetch, Unwritable, applyChange, heldNotes, publishHeld, restoreRecorded, resumePaused, sameChunks, settleBeside, stage, unwritableText, yieldName } from "./pull";
import { publishPause } from "./pause";
import { PathGone, carryPost, pushDelete, pushFile, pushFolder, pushFolderDelete, sidDigest } from "./push";
import { ChunkRepair, REPAIR_BATCH_SIDS, REPAIR_SCAN_MS, REPAIR_TICK_MS, REPAIR_WALK_MS } from "./repair";
import { Suspicion, probeFeed, recoverLost, seenBefore, young } from "./restore";

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
  /**
   * After a `commit` that failed, take back the copy it published anyway
   * (issue #225): `removed` when the name still meant the file this writer
   * made, as it made it, and it is gone now; `kept` when the name means
   * anything else; `none` when this writer published nothing. Only a host
   * that can tell its own file from another has it (desktop).
   */
  withdraw?(): Promise<"removed" | "kept" | "none">;
}

/**
 * A button on a notice, named by what it asks for: the host draws it and
 * carries it out, so nothing Obsidian-shaped crosses into `sync/` (issues
 * #161, #162). A notice that asks something stays until it is answered.
 */
export type NoticeAction =
  | { kind: "delete_everywhere" }
  | { kind: "restore_here" }
  | { kind: "fetch"; fileId: string };

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
   * Every file in Obsidian's index, INSIDE THE SELECTION OR NOT, with the
   * size and mtime the index cached: no filesystem walk, no content. It
   * answers one question, asked before a note is called deleted -- are its
   * bytes still in this vault under another name (issue #139)? -- and is never
   * read, queued or published from.
   */
  inventory(): Promise<VaultStat[]>;
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
   * Remove the temp files this host's writes left when the device stopped in
   * the middle of them (issue #159). Called once per start, by its first
   * periodic scan under the pull lock (issue #195); a host whose writes leave
   * nothing behind has none.
   */
  sweep?(): Promise<void>;
  /**
   * Finish, or put back, what this host left half-done that the start pass
   * must see as it was: a re-case stopped between its two renames (issue
   * #219). Awaited before that pass, which is the one that publishes
   * deletions; a host that leaves nothing half-done has none.
   */
  settle?(): Promise<void>;
  /**
   * Is `path` held by such a re-case, its entry still under the hidden name
   * after one more try to put it back? A folder record there waits
   * (`pull.ts`, `applyFolder`); a host that leaves nothing half-done has
   * none.
   */
  recasePending?(path: string): Promise<boolean>;
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
  /**
   * Is `path` in a folder of this vault that is a vault OF ITS OWN syncing
   * with this plugin, or that folder itself (issue #180)? Whatever lands
   * there, that vault publishes again one level deeper, so nothing there is
   * published or applied here. Only the host can see the folder that says so.
   */
  inNestedVault(path: string): Promise<boolean>;
  stat(path: string): Promise<VaultStat | null>;
  read(path: string): Promise<Bytes>;
  source(path: string, size: number): ByteSource;
  /** `size` is the whole content's: a phone writes into one buffer of exactly that many bytes. */
  writer(path: string, size: number): Promise<VaultWriter>;
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
   * Remove this folder through the user's own delete preference, and answer
   * how many entries keep it: `0` once it is gone; otherwise it holds
   * ANYTHING -- including a file this device does not sync, which is the
   * whole reason the host answers this and not the engine: only the host can
   * see the filesystem -- and nothing was done. What an operating system
   * writes by itself keeps nothing and goes with it (`vaultPath.ts`,
   * `osJunk`; issue #184).
   */
  trashFolder(path: string): Promise<number>;
  /**
   * Is `path` open in an editor here (issue #146)? `unsaved` when an editor
   * showing it holds text its file does not -- keystrokes inside the editor's
   * own save debounce, which exist nowhere else -- `saved` when every editor
   * showing it holds exactly the file, and `null` when none shows it. Only the
   * host can see an editor; how recently the note was edited HERE is the
   * engine's to say (`pushedAt`), because an editor also changes when a pulled
   * version is merged into it.
   */
  editing(path: string): Promise<"unsaved" | "saved" | null>;
  /** Recent trusted editor input, including a composition still in progress. */
  typing(path: string): boolean;
  /** Tell the person, through the one notice channel (`notices.ts`); bare words are a notice not yet given a kind. */
  notify(notice: SyncNotice | string, actions?: NoticeAction[]): void;
  /** Take the held-deletions question off the screen once nothing is held (`hold`). */
  closeQuestion?(): void;
  log(line: string): void;
  /**
   * A pass over many paths -- a feed page, a reconcile or scan -- begins
   * (`true`) or ends. A host may keep answers that cost a walk for its length
   * (`main.ts`, `inNestedVault`, issue #198); outside a pass it asks afresh.
   */
  pass?(open: boolean): void;
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
  /**
   * Resolutions of one file inside the current window, for the merge breaker,
   * and the `(mtime, size)` the last one left the note at (`pull.ts`).
   */
  readonly merges: Map<string, { since: number; count: number; left: string; remote?: Map<string, string>; generation?: object }>;
  /**
   * File ids whose note here waits on this device's own push to settle a fork
   * (`pull.ts`, `deferred`): the status is not `idle` while one is in flight
   * (`resting`, issue #135).
   */
  readonly forked: Set<string>;
  /**
   * When the push queue last published an edit of each path, oldest first and
   * none older than `EDITING_WINDOW_MS`: what says a note open in an editor
   * was saved from here seconds ago (`pull.ts`, issue #146). A pull's own
   * write never lands here, and neither does the revive a kept deletion posts.
   */
  readonly pushedAt: Map<string, number>;
  /**
   * The watcher's verdict on the latest change here to each file id: the time
   * of that change, and the arrival of another device's version it ANSWERED,
   * or `null` (`answered`, `pull.ts` `answerOf`, issue #179). What the pull
   * path asks before it settles a collision on that note.
   */
  readonly answering: Map<string, { mtime: number; arrived: number | null }>;
  /** When another device's version of each path last arrived here (`receive`). */
  readonly arrivals: Map<string, number>;
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
  /**
   * Aborted the moment the engine that made this context stops (`stop`): the
   * long poll, a retry asleep in its backoff and a chunk upload end at once,
   * and a download ends at its next batch (issues #157, #185). Absent where
   * the pull path runs without an engine behind it.
   */
  readonly signal?: AbortSignal;
  /**
   * Conflict copies waiting for their final name before they are announced
   * (`pull.ts`, `announceCopies`, issue #164): by file id, the name of the note
   * they sit beside and when. Absent where no engine runs to announce them,
   * and then a copy is announced as it is made.
   */
  readonly copies?: Map<string, { name: string; at: number }>;
  /**
   * Large versions the background lane fetched ahead of their apply, by path
   * and chunk list (`pull.ts`, `stage`, issue #196): uncommitted writers that
   * `materialise` takes in place of a download. Absent where no engine runs
   * the lane.
   */
  readonly staged?: Map<string, VaultWriter>;
  /**
   * A record written in memory only, to be saved with the page it came in or
   * within `SAVE_COALESCE_MS` (`pull.ts`, `recordAt`, issue #194). Absent where
   * no engine runs, and then every record is saved as it is written.
   */
  defer?(): void;
  /**
   * The chunks of the page being applied, fetched many to a request (`pull.ts`,
   * `Prefetch`, issue #194); `null` between pages and where no engine runs.
   */
  ahead?: Prefetch | null;
  /**
   * File ids the feed is expected to find already here, byte for byte: the
   * notes of other devices whose names a held local note occupies (`holding`),
   * with that name and the versions the note there descends from. Their
   * chunks are not fetched ahead, because adopting them fetches none, and a
   * version behind them is never written at another name (`pull.ts`, issue
   * #241).
   */
  readonly expected?: ReadonlyMap<string, { readonly path: string; readonly behind: ReadonlySet<string> }>;
  /**
   * Versions this device authored, of notes it no longer holds anywhere, that
   * are to be applied like another device's instead of dropped as echoes:
   * each is its file's head, proved by the server just before (`returnLost`,
   * issue #239).
   */
  readonly returning?: ReadonlySet<string>;
  readonly deviceNames: Map<string, string>;
  now(): number;
  deviceNameFor(deviceId: string): string;
}

/** Work a stop ended: nothing refused it, so nothing about it is reported. */
export function stopped(error: unknown): boolean {
  return error instanceof ApiError && error.code === "cancelled";
}

/**
 * Runs `read` under `drop`, which the engine's stop aborts too, so one request
 * ends on whichever comes first: a wake dropping it or a stop (#134, #157).
 * The listener goes when the read does, so a long run of polls holds none.
 */
async function untilStopped<T>(stop: AbortSignal | undefined, drop: AbortController, read: () => Promise<T>): Promise<T> {
  const abort = (): void => drop.abort();
  if (stop?.aborted) drop.abort();
  else stop?.addEventListener("abort", abort, { once: true });
  try {
    return await read();
  } finally {
    stop?.removeEventListener("abort", abort);
  }
}

export type EngineStatus =
  | { kind: "idle" }
  | { kind: "syncing"; pending: number; held?: string }
  | { kind: "offline" }
  | { kind: "error"; message: string; code?: string }
  | { kind: "paused"; message: string };

/**
 * What a refusal about this device's whole sync says, in plain words, with the
 * one thing to do next (issue #155). Codes stay in the log lines.
 */
export const REVOKED_DEVICE =
  "This device was removed from your server. Your notes and vault key are safe here. Pair it again from a device that still syncs: obsync settings, Pair this device.";
export const CLOCK_OFF =
  "This device's clock is more than five minutes off, so your server refuses it. Set the date and time to update automatically.";
export const SERVER_FULL =
  "Your server is out of storage, so it refuses new changes. Free space on the server or raise its quota.";
export const NOT_OBSYNC_ANSWER =
  "Something between this device and your server, such as a proxy or an access policy, answered instead of obsync. Check the Server URL and the Custom request headers in obsync settings.";
/**
 * HOW A REFUSAL THAT CLEARS ELSEWHERE ENDS -- a full server, a wrong clock,
 * something in front of the server, the edge (#155, #228). A running engine
 * keeps asking, so its sync resumes by itself. A refused START is never asked
 * again by a timer (#129), so it says what to press. A press -- a Check, the
 * device list -- answers for itself and promises neither.
 */
export const RESUMES = "Sync resumes by itself.";
export const AFTER_START = "Once that is fixed, select Sync now.";
export const FEED_FAILED =
  "Changes from your server could not be read. obsync tries again every few seconds; if this stays, check your server's log.";
export const PUSH_REFUSED =
  "Your server refused a change from this device. It is sent again when the note next changes, or within a minute; if this stays, check your server's log.";
/** Said for a press, a Check or Sync now, that met a server not answering (#182). */
export const NOT_ANSWERING = "Your server is not answering. Sync resumes by itself when it is back.";
export const VERIFY_FAILED =
  "Server repair could not verify a file this device keeps: the file could not be read here, or the server's copy did not check out. It tries again within five minutes; if this stays, check the server's scrub report.";

/**
 * ONE MAPPING FROM A FAILURE TO WHAT THE PERSON READS (issues #155, #160),
 * shared by the feed, a push, a folder post, an editor retry, repair, the
 * engine's start and Check. It answers only for failures that say something
 * about THIS DEVICE'S whole sync -- the server's absence, who this device is,
 * its clock, the server's room, what answers in front of the server -- and
 * `null` for everything else, which each caller words for what it was doing.
 *
 * A REFUSAL IS NOT ABSENCE. Every one of these used to read `offline —
 * retrying`, which sends a person to their Wi-Fi about a revoked device, a
 * wrong clock or a full disk; only absence says offline here.
 */
export function refusalStatus(error: unknown, then = RESUMES): EngineStatus | null {
  if (!(error instanceof ApiError)) return null;
  const said = (message: string): string => (then === "" ? message : `${message} ${then}`);
  // First: a full server is never absence, whatever carried its answer.
  if (error.status === 507) return { kind: "error", code: "storage", message: said(SERVER_FULL) };
  const certificate = certificateRefusal(error);
  if (certificate !== null) return { kind: "error", code: "certificate", message: certificate };
  if (error.code === "unreachable") return { kind: "offline" };
  // Not narrowed by the predicate: every branch below is an `ApiError` too.
  if (forgottenCredential(error as unknown)) {
    return { kind: "error", code: "credential_rejected", message: error.code === "device_revoked" ? REVOKED_DEVICE : FORGOTTEN_DEVICE };
  }
  if (error.code === "stale_timestamp") return { kind: "error", code: "clock", message: said(CLOCK_OFF) };
  if (error.code === NOT_OBSYNC || error.code === "part_mismatch" || error.code === "response_too_large") {
    return { kind: "error", code: "edge", message: said(NOT_OBSYNC_ANSWER) };
  }
  // Pairing's own words for the edge (`transport.ts`), so the two never disagree.
  if (error.code === "edge_required") return { kind: "error", code: "edge", message: said(EDGE_REQUIRED) };
  return null;
}

/**
 * A failed press in words (#182): a Check, a device list read. Absence and
 * the refusals `refusalStatus` names say what they say; any other refusal is
 * said without its code, which stays in the log; a local fault keeps its own
 * words. No `0 unreachable: network=...` reaches a person.
 */
export function refusalText(error: unknown): string {
  const refused = refusalStatus(error, "");
  if (refused?.kind === "offline") return NOT_ANSWERING;
  if (refused?.kind === "error") return refused.message;
  if (error instanceof ApiError) return "Your server refused this request; the obsync log names the reason.";
  return error instanceof Error ? error.message : String(error);
}

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
 * The guard for a note the EDITOR is saving (issue #195): someone typed in it
 * seconds ago, so the change is the editor's own save, written whole, and not
 * a copy still growing. It settles after this and without a recheck; the
 * push's own re-read of the size still abandons a torn read (#99). Up to
 * `EDITOR_SETTLE_MAX_BYTES`, one chunk; any other writer keeps the full guard.
 */
export const EDITOR_SETTLE_MS = 150;
export const EDITOR_SETTLE_MAX_BYTES = CHUNK_MAX;
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
 * How long a read of the device names serves a page from other devices
 * before that page reads them again (issue #164): a rename made elsewhere
 * reaches this device's copies and notices within it, at one request per
 * period at most, and only while other devices are writing.
 */
export const NAMES_TTL_MS = 10 * 60 * 1000;
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
 * How often that pass walks the vault's tree on a host that can
 * (`VaultHost.scan`, desktop), and it walks at a start and at once when the
 * window comes forward (`wake`, issue #198). The tree is where a move made in
 * a file manager shows first, and that move is made with obsync's window
 * behind it, so the moment it comes back is when a walk finds it. Every 30 s,
 * a vault of ten thousand notes was read whole 120 times an hour, on battery
 * too; the passes between walks keep the rest of their work on its 30 s and
 * read nothing.
 */
export const WALK_MS = 5 * 60 * 1000;

/**
 * How long a note another device created may be recorded in memory only
 * before the data file is written (issue #194). The page's own save usually
 * comes first; this bounds a page that takes minutes, a phone's first sync,
 * to a few seconds of records its next start adopts again (`pull.ts`,
 * `recordAt`).
 */
export const SAVE_COALESCE_MS = 1500;

/**
 * How long a start holds back the local notes whose names the feed already
 * carries from another device, waiting for the feed to catch up once (issue
 * #194). A vault copied over from another sync tool, or a restart after a
 * crash inside a page, holds notes that ARE those versions; published first,
 * each took a new file id and was retired again, two versions per note on
 * every device. The feed adopts them by digest instead (`pull.ts`, `adopt`),
 * and a note it does not settle goes out when it has caught up -- or after
 * this long, whatever the feed is doing.
 */
export const HOLD_MS = 10 * 60 * 1000;

/**
 * The coarsest step a vault volume keeps a modification time to: FAT32's two
 * seconds. A whole-second time read within one step of now can still be the
 * time of a later save of the same size (issue #175), so such a push looks
 * again when the step has closed (`recheck`).
 */
export const MTIME_STEP_MS = 2000;

/**
 * THE BULK-DELETION FLOOR (issue #123). Below this many candidates a pass
 * that would tombstone everything it tracks is an ordinary small vault
 * emptying, and holding it back would teach the user to confirm without
 * reading. At or above it, a pass that would retire more than half of what
 * this device tracks is held and named instead of published.
 */
export const BULK_DELETION_MIN = 5;

/**
 * How long one burst of deletions may keep growing (issue #162). The file
 * explorer's multi-select Delete trashes its notes one after another, and a
 * slow system trash spreads twenty of them over several debounce windows,
 * each under the floor; the wait restarts while deletes keep coming, for at
 * most this long from the first.
 */
export const BULK_WINDOW_MS = 5000;

/** The two answers a held deletion waits for, on every notice that asks. */
const HELD_ACTIONS: NoticeAction[] = [{ kind: "delete_everywhere" }, { kind: "restore_here" }];

/** ` (in Folder)` when every path shares one folder, and nothing when they share none. */
function within(paths: string[]): string {
  let common = folderOf(paths[0] ?? "");
  for (const path of paths) while (common !== "" && !path.startsWith(`${common}/`)) common = folderOf(common);
  return common === "" ? "" : ` (in ${common})`;
}

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
/**
 * How long a long poll must have waited before a wake drops it (#195). One
 * sent seconds ago rides a connection that is plainly alive; one that waited
 * longer may ride a socket a network change or a sleeping lid left dead, and
 * the quick read that replaces it costs one round trip.
 */
export const POLL_STALE_MS = 5000;

/**
 * The largest file whose contents Sync now reads again (issue #197): one
 * chunk, which is where a plugin rewrites a note keeping its size and date
 * (#179), and what the arrival window reads for the same reason. A larger
 * file is judged by `(mtime, size)`, as every other pass judges it; "Verify
 * all files" reads every file, however large. Reading them all made a press
 * minutes long on a large vault, and on a phone read 512 MiB files whole.
 */
export const SYNC_NOW_VERIFY_MAX = CHUNK_MAX;

/**
 * How long Sync now waits for its read of the feed (issue #197): the patience
 * the transport gives any request a person is waiting on (`INTERACTIVE_MS`).
 * A server that has not answered by then is the status's to say; the read
 * goes on, and what it brings is applied when it comes.
 */
export const SYNC_NOW_FEED_MS = INTERACTIVE_MS;

/**
 * How soon a PARKED record is tried again (issue #144): one minute, doubling
 * to half an hour for as long as anything stays parked. A retry of a file the
 * disk had no room for downloads it again, so a five-second loop moved 5.5 GB
 * for one 100 MiB file in nine minutes; this moves it about twice an hour.
 * The next start and Sync now try at once, because those are the moments the
 * user has just fixed the cause.
 */
export const PARK_RETRY_MS = 60 * 1000;
export const PARK_RETRY_MAX_MS = 30 * 60 * 1000;

/**
 * A feed entry larger than this is applied by the background lane (issue
 * #196): its chunks are fetched ahead of its turn, outside the pull lock, so
 * the notes behind it keep arriving while it downloads (`lane`).
 */
export const LARGE_APPLY_BYTES = 32 << 20;
/** The parked reason of a record the background lane is downloading: work, not a failure. */
const DOWNLOADING = "downloading";

// The host's own timers. Obsidian runs the desktop app inside Electron, where
// the bare globals are Node's and hand back a `Timeout` object rather than the
// numeric handle every other Obsidian surface expects; `window` is the one
// spelling that means the same thing on desktop and on mobile.
/** `QUIET_MS` of stillness, counted in rechecks because that is what fires. */
const QUIET_RECHECKS = Math.ceil(QUIET_MS / RECHECK_MS);

/** The directory a path lives in; `""` for a path at the vault root. */
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * A listing by `(mtime, size)`, built once, so that asking where N vanished
 * records went costs N lookups and not N walks of the whole vault.
 */
const byStat = (files: VaultStat[]): Map<string, VaultStat[]> => {
  const out = new Map<string, VaultStat[]>();
  for (const file of files) {
    const key = `${file.mtime}:${file.size}`;
    out.set(key, [...(out.get(key) ?? []), file]);
  }
  return out;
};

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
  /**
   * Queued folder paths to publish a record for, each with whether it is a
   * CREATION -- a folder made or renamed here, which is published again over a
   * tombstone the server still holds for that path (`push.ts`, `pushFolder`,
   * issue #165) -- and queued paths to tombstone, each with the selection its
   * removal was JUDGED against: a renamed selected folder's old name is in no
   * selection by the time its tombstone is posted (issue #240).
   */
  private readonly folderPublishes = new Map<string, boolean>();
  private readonly folderRemovals = new Map<string, SyncFolders>();
  /**
   * Queued paths that must reach the server BEFORE anything queued behind
   * them: the wire order, which pushes in flight side by side are not
   * (`takeNext`).
   */
  private readonly barriers = new Set<string>();
  /**
   * The barrier path a worker is carrying, so a post that FAILS can put it
   * back: `takeNext` takes such a path alone, so there is never more than one
   * (`pushNow`).
   */
  private barrierPath: string | null = null;
  /** Failed attempts at one folder record's post, against `FOLDER_POST_TRIES`. */
  private readonly folderRetries = new Map<string, number>();
  /**
   * Selected folders whose record a tombstone retired and that the start-up
   * pass did not publish again, because the feed may still carry the record
   * that renames them (`survey`, issue #127); and whether the feed has caught
   * up since this start, which is when they are settled (`releaseRetired`).
   */
  private readonly retiredHeld = new Set<string>();
  private caughtUp = false;
  /** Echo marks already armed at the previous scan: what this one expires. */
  private echoSweep = new Set<string>();
  /** The failed-folder-post notice is shown once per engine, like every other. */
  private folderPostNoticeShown = false;
  private contextValue: SyncContext | null = null;
  private active = 0;
  private draining = false;
  /** The drain in flight, so a second caller waits for it instead of for nothing. */
  private drainWork: Promise<void> | null = null;
  /** Ends the drain's wait for a push to land, when a path is queued (`drain`). */
  private wakeDrain: (() => void) | null = null;
  private readonly pushing = new Map<string, Promise<void>>();
  /** Paths asked for while their push was in flight: one follow-up each. */
  private readonly again = new Set<string>();
  private running = false;
  private cancelled = false;
  /** One per start: `stop` aborts it, which ends every request that start is waiting on. */
  private halt = new AbortController();
  private heartbeatHandle: unknown = null;
  /** When the device names were last read (`readNames`). */
  private namesReadAt = 0;
  /** Ids a read did not name, so a page cannot cost a read per record; cleared hourly. */
  private readonly unnamed = new Set<string>();
  private repairHandle: unknown = null;
  private scanHandle: unknown = null;
  private repair: ChunkRepair | null = null;
  private repairWork: Promise<void> | null = null;
  private repairNoticeShown = false;
  /** Notes that left the selection since the user was last told, counted for one notice. */
  private exited = 0;
  /**
   * Watcher deletions waiting `DEBOUNCE_MS` for the other half of a move, and
   * the folder deletions reported with them (issue #139, `settleVanished`).
   */
  private readonly vanished = new Set<string>();
  private readonly vanishedFolders = new Set<string>();
  private vanishHandle: unknown = null;
  private caseGhostNoticeShown = false;
  /**
   * The folders deleted with a held burst (issue #162): published after their
   * notes on Delete everywhere, dropped on Restore here, which brings the notes
   * back into them. Not persisted: after a restart the startup pass retires a
   * gone folder's record, and a folder record removes nothing still holding a
   * note on any device (`docs/architecture.md` 6.2.0).
   */
  private heldFolders: string[] = [];
  /** Held deletions the user confirmed, on their way through `settleVanished` unheld. */
  private readonly confirmedDeletions = new Set<string>();
  /** When the burst `vanished` holds began: it grows for at most `BULK_WINDOW_MS`. */
  private burstStarted = 0;
  private bulkNoticeShown = false;
  /** Whether this start's first scan has swept the temp files an interrupted write left (`scanLocal`). */
  private swept = false;
  /** Whether this engine has read the feed for its own notes (`ownNotes`); one start per engine. */
  private ownRead = false;
  /**
   * Local notes this start holds back until the feed has caught up once
   * (`HOLD_MS`, issue #194): by path, with the file ids the feed brings for
   * them (`SyncContext.expected`). `all` holds every note without a record:
   * an empty state whose read of the feed failed, which cannot tell a copy
   * from a note of its own.
   */
  private holding: { paths: Set<string>; since: number; handle: unknown; all: boolean } | null = null;
  private readonly expected = new Map<string, { path: string; behind: ReadonlySet<string> }>();
  /** The versions `returnLost` is bringing back (`SyncContext.returning`). */
  private readonly returning = new Set<string>();
  /** No record and no cursor at this start: a vault the server has not seen from here. */
  private emptyStart = false;
  /** Passes since the last walk of the tree (`WALK_MS`), and why the next pass walks, when it must. */
  private unwalked = 0;
  private walkFor: "start" | "focus" | null = "start";
  /** Records written in memory only since the last save (`defer`), and the timer that saves them. */
  private deferred = 0;
  private saveHandle: unknown = null;
  /** When the repair tick began yielding to a manual history operation. */
  private repairDeferredAt: number | null = null;
  private repairDeferredTicks = 0;
  /**
   * A restored server this engine has to answer before it applies another
   * feed entry (issue #145), and the file ids a check has already decided,
   * so the repair pass meeting one again does not start another.
   */
  private restoreDue: Suspicion | null = null;
  private readonly judged = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** The next pass over the parked records, and the wait it was armed with. */
  private parkHandle: unknown = null;
  private parkDelay = 0;
  private editorHandle: unknown = null;
  /** The feed and a retry pass apply one at a time, never side by side. */
  private pulling: Promise<void> = Promise.resolve();
  /** Whether the background lane is running: one large download at a time (`lane`). */
  private laning = false;
  /** The feed's long poll in flight, and how to drop it (`wake`, #195). */
  private poll: { sent: number; drop: AbortController } | null = null;
  /** Ends the feed's pause after a failed read at once (`wake`). */
  private feedPause: (() => void) | null = null;
  /**
   * Whether the feed's latest request was answered. Until one is -- at start,
   * after a failure, after a wake -- the feed asks without waiting, so an
   * answer, empty or not, arrives in one round trip (#158, #195).
   */
  private feedAnswered = false;
  /**
   * A refusal about this device's whole sync -- its clock, a full server,
   * something in front of the server, a feed that cannot be read -- that
   * stands until the server next accepts what it refused (`accepted`, #155).
   * It is what the status says first, and it clears itself.
   */
  private refused: EngineStatus | null = null;
  /** Whether the feed's latest read went unanswered: the status is `offline` until one is (#158). */
  private absent = false;
  /** Records of the page being applied that are not yet written: work the status counts (#158). */
  private pulls = 0;
  /** Versions the server has taken from this device since it started: what a Sync now press reports (#182). */
  private written = 0;
  /** Files a press's pass queued to have their contents read, since this engine started: what Verify all files reports (#197). */
  private examined = 0;
  /**
   * Sync now's asks for a feed read (`readFeed`, #197), each with the count
   * of reads the feed had sent when it asked: answered by the first read sent
   * after it, once that read is applied or has failed, and by a stop.
   */
  private readonly feedAsks: { after: number; answer: () => void }[] = [];
  /** Reads the feed has sent since this engine was made. */
  private feedReads = 0;
  /** Whether the feed's read in flight asks without waiting: it is the read a Sync now wants. */
  private reading = false;
  /** Paths already sent again under a new vault key (`rekeyed`): once each. */
  private readonly republished = new Set<string>();
  private rekeyNoticeShown = false;

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
  private async openMap(keys: DomainMapKeys, signal: AbortSignal): Promise<DomainMap> {
    const host = this.options.host;
    const existing = await loadDomainMap(this.options.transport, keys, { signal });
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
    const halt = this.halt = new AbortController();
    // A start its stop cut short -- the map read of a restart against a server
    // that is gone -- ends quietly, as one stopped between two steps does.
    return this.track(this.startLoops(halt.signal).catch((error: unknown) => {
      if (!(halt.signal.aborted && stopped(error))) throw error;
    }));
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }

  private async startLoops(signal: AbortSignal): Promise<void> {
    const { state, transport, host } = this.options;
    const vrk = state.data.vrk;
    const deviceId = state.data.deviceId;
    if (vrk === null || deviceId === null) throw new Error("engine: this device is not paired");
    const key = unhex(vrk);
    const mapKeys = await domainMapKeys(key);
    const map = await this.openMap(mapKeys, signal);
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
      merges: new Map<string, { since: number; count: number; left: string }>(),
      pushedAt: new Map<string, number>(),
      answering: new Map<string, { mtime: number; arrived: number | null }>(),
      arrivals: new Map<string, number>(),
      forked: new Set<string>(),
      publish: (path) => this.pushOne(path),
      signal,
      copies: new Map(),
      staged: new Map(),
      defer: () => this.defer(),
      ahead: null,
      expected: this.expected,
      returning: this.returning,
      deviceNames,
      now: () => this.nowFn(),
      deviceNameFor: (id) => deviceNames.get(id) ?? "another device",
    };
    this.caughtUp = false;
    this.retiredHeld.clear();
    this.running = true;
    // Armed before the pass that would publish what it holds (`survey`).
    this.expected.clear();
    this.holding = { paths: new Set(), since: this.nowFn(), handle: null, all: false };
    this.emptyStart = state.data.lastSeq === 0 && Object.keys(state.data.files).length === 0;
    // A cursor at zero: a replay from zero -- a widening's, over the feed this
    // device has read to its mark, or a first read, which has no mark and
    // notes nothing (`ObsyncData.replaying`). One stopped before its catch-up
    // goes on from where it was saved (issue #281), and one started again
    // keeps the mark it began at.
    const unfinished = state.data.replaying;
    if (state.data.lastSeq === 0) state.data.replaying = { through: unfinished?.through ?? state.data.feedMark?.seq ?? 0, notes: {} };
    else if (unfinished !== null) {
      host.log(`feed decision=resumed reason=replay_unfinished noted=${Object.keys(unfinished.notes).length} through=${unfinished.through}`);
    }
    // A start's first pass walks: what moved while the app was closed shows there first.
    this.unwalked = 0;
    this.walkFor = "start";
    host.log(
      `engine start platform=${host.platform} concurrency=${this.contextValue.concurrency} seq=${state.data.lastSeq}`,
    );
    // NOTHING WAITS FOR THE HEARTBEAT (issue #195): it reports this device's
    // version and policy and reads the device names, and nothing the start
    // does next needs either -- a page from a device not named yet reads the
    // names itself (`learnNames`). Nor for the temp-file sweep, which the
    // first periodic scan runs (`scanLocal`).
    this.swept = false;
    void this.track(this.heartbeat());
    // FIRST, AND BEFORE THE PASS THAT QUEUES THE FILE WORK (review round 4,
    // finding 3).
    this.restoreFolderBarriers();
    // And before that pass: a note left under a re-case's hidden name would
    // read to it as deleted (issue #219).
    await host.settle?.().catch((error: unknown) =>
      host.log(`host path_class=file decision=failed reason=settle code=${(error as { code?: string }).code ?? "none"}`));
    await this.reconcile();
    if (this.running) {
      const context = this.need();
      this.repair = new ChunkRepair(context, () => this.running && this.contextValue === context);
      this.repairHandle = this.timers.set(() => { void this.repairTick(); }, REPAIR_TICK_MS);
      host.log(`scan decision=start interval_ms=${SCAN_MS} budget_ms=${SCAN_BUDGET_MS}`);
      this.scanHandle = this.timers.set(() => this.scanTick(), SCAN_MS);
      // What a previous run parked is tried first, before the feed applies
      // anything: a start is when the user has most likely just fixed the
      // cause (issue #144).
      void this.track(this.retryParked("start"));
      // A paused note stays paused across a restart, and says so: the plugin
      // that rewrote it is most likely still there (issue #179).
      if (Object.keys(state.data.paused).length > 0) this.status(this.resting());
      // Not tracked: only the pages it applies are (`feedLoop`).
      void this.feedLoop().catch((error: unknown) => {
        host.log(`feed decision=failed reason=${error instanceof Error ? error.name : "unknown"}`);
      }).finally(() => this.answerFeed(Number.POSITIVE_INFINITY));
    }
  }

  /**
   * Stop, and CANCEL what is waiting rather than wait it out (issues #157,
   * #185): the long poll, any request asleep in its backoff, and every chunk
   * upload, which ends at the chunk boundary -- nothing further is read,
   * encrypted or sent, and a chunk the server already holds is found by its
   * sid when the push runs again. A stop says nothing about the status:
   * `idle` while an upload is still stopping was the lie of #185, so the one
   * word comes from `stopAndWait`, once nothing of this engine's runs.
   */
  stop(): void {
    // A copy still waiting for its final name is announced where it is: a
    // stop must not swallow the one notice that says it exists.
    if (this.contextValue !== null) announceCopies(this.contextValue, true);
    this.cancelled = true;
    this.running = false;
    this.halt.abort();
    this.answerFeed(Number.POSITIVE_INFINITY);
    for (const entry of this.pending.values()) this.timers.clear(entry.handle);
    this.pending.clear();
    if (this.heartbeatHandle !== null) this.timers.clear(this.heartbeatHandle);
    this.heartbeatHandle = null;
    if (this.repairHandle !== null) this.timers.clear(this.repairHandle);
    this.repairHandle = null;
    if (this.scanHandle !== null) this.timers.clear(this.scanHandle);
    this.scanHandle = null;
    // What a stop leaves held, the next start's pass finds again.
    if (this.holding !== null && this.holding.handle !== null) this.timers.clear(this.holding.handle);
    this.holding = null;
    this.expected.clear();
    // And what `defer` held in memory is written now, not at a page that is not coming.
    void this.saveDeferred("stop");
    if (this.parkHandle !== null) this.timers.clear(this.parkHandle);
    this.parkHandle = null;
    this.parkDelay = 0;
    if (this.editorHandle !== null) this.timers.clear(this.editorHandle);
    this.editorHandle = null;
    this.repair?.cancel();
    this.repair = null;
    this.options.host.log("engine stop");
  }

  /** Quiesce before changing local scope; retain enough state to retry queued work. */
  async stopAndWait(): Promise<void> {
    const started = this.nowFn();
    this.stop();
    while (this.inFlight.size !== 0) await Promise.allSettled([...this.inFlight]);
    await this.options.state.save();
    this.options.host.log(`engine decision=quiesced duration_ms=${this.nowFn() - started}`);
    this.status({ kind: "idle" });
  }

  /** The paths this engine is pushing now, for a person waiting on its stop. */
  uploads(): string[] {
    return [...this.pushing.keys()];
  }

  get started(): boolean {
    return this.running;
  }

  /** What the status says now, derived as every status this engine emits is (`resting`). */
  current(): EngineStatus {
    return this.resting();
  }

  private status(status: EngineStatus): void {
    this.onStatus(status);
  }

  /**
   * Say what a failure means (`refusalStatus`, or the caller's own words for
   * one about its piece of work). Absence and a rejected credential are said as
   * they are; a refusal with a code STANDS -- it is what `resting` says until
   * the server accepts again -- and a failure with none is said once.
   */
  private report(status: EngineStatus): void {
    if (status.kind === "error" && status.code !== undefined && status.code !== "credential_rejected") {
      this.refused = status;
      this.status(this.resting());
      return;
    }
    this.status(status);
  }

  /**
   * The server answered a read (`write` false) or took a change (`write`
   * true): a refusal it no longer makes clears (#155). A full server still
   * answers reads, so only a change it takes clears that one.
   */
  private accepted(write: boolean): void {
    if (write) this.written++;
    const refused = this.refused;
    if (refused === null || refused.kind !== "error" || (!write && refused.code === "storage")) return;
    this.refused = null;
    this.options.host.log(`engine decision=cleared reason=${refused.code ?? "error"}`);
    this.status(this.resting());
  }

  private need(): SyncContext {
    if (!this.contextValue) throw new Error("engine: not started");
    return this.contextValue;
  }

  // --- watcher -----------------------------------------------------------

  /**
   * The gate every watcher event and every reconciliation entry passes: a
   * path that is not a canonical relative vault path is not synced, in either
   * direction, and the refusal is visible. This is what keeps the config
   * folder — this plugin's own bundle and its bookkeeping `data.json` —
   * and `.git/**` out of the vault's history (`vaultPath.ts`).
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
    const context = this.need();
    context.trashed.delete(path);
    for (const mark of context.moved) if (mark.startsWith(`${path}\u0000`)) context.moved.delete(mark);
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
   *
   * AND A DELETE IS NOT YET A DELETION (issue #139). A folder moved in a file
   * manager reaches here as a delete for every note in it, beside a create
   * for each at its new name: Obsidian never sees a rename. So the delete
   * waits `DEBOUNCE_MS` for the other half and is decided then, in
   * `settleVanished`.
   *
   * The pull path's own MOVE reaches here the same way on desktop: the host
   * moves with the filesystem, and the watcher reports that as a delete at
   * the old name beside a create at the new one, never the rename its mark
   * was armed for. The delete is that echo -- a note the pull path just moved
   * away is the only thing to delete there -- and was otherwise decided as a
   * deletion that published nothing only because the record had moved first.
   */
  deleted(path: string): void {
    if (!this.running || !this.tracked(path, "delete")) return;
    const context = this.need();
    const away = [...context.moved].find((mark) => mark.startsWith(`${path}\u0000`));
    if (context.trashed.delete(path) || (away !== undefined && context.moved.delete(away))) {
      this.options.host.log(`watch path_class=file decision=echo_suppressed event=delete${away === undefined ? "" : " reason=moved"}`);
      return;
    }
    this.unschedule(path);
    // A push still queued for it would only find the file gone: the batch
    // decides for this path now, as the queued deletion used to.
    const queued = this.queue.indexOf(path);
    if (queued !== -1) this.queue.splice(queued, 1);
    this.vanish([path]);
  }

  /**
   * A folder delete from the vault's watcher. Deleted with the notes inside
   * it, it waits with them, so that a folder whose notes turn out to have
   * LEFT the selection is not the one thing published as deleted. With
   * nothing waiting it is the ordinary folder deletion, at once.
   */
  folderVanished(path: string): void {
    if (this.vanished.size === 0) this.folderDeleted(path);
    else this.vanishedFolders.add(path);
  }

  /**
   * Hold these deletions, and the rest of their burst, for `DEBOUNCE_MS` after
   * the last of them, and never longer than `BULK_WINDOW_MS` after the first.
   * `confirmed` is the user's word on a held deletion: it is published, not
   * asked about again.
   */
  private vanish(paths: string[], confirmed = false): void {
    const now = this.nowFn();
    if (this.vanished.size === 0) this.burstStarted = now;
    for (const path of paths) {
      this.vanished.add(path);
      if (confirmed) this.confirmedDeletions.add(path);
    }
    if (this.vanishHandle !== null) {
      if (now - this.burstStarted >= BULK_WINDOW_MS) return;
      this.timers.clear(this.vanishHandle);
    }
    // Under the pull lock, as a pass is (`inPass`, issue #244): a debounce
    // left pending for a name the pull has just moved finds it gone before
    // the records follow, and deciding then publishes the pull's own move.
    this.vanishHandle = this.timers.set(() => { void this.track(this.exclusive(() => this.settleVanished())); }, DEBOUNCE_MS);
  }

  /**
   * Decide what the deletes of one burst were (issue #139).
   *
   * A path that is back is the change it is. Otherwise the vault is asked
   * where its bytes went, by the rule the periodic scan pairs moves with
   * (`follow`): a move keeps the file id, a note that left the selection is
   * never a deletion, and only a note whose bytes are nowhere in the vault
   * is published as deleted -- through the same queue as ever, so the
   * "file is present" refusal still has the last word. The folders deleted
   * with them go LAST, after the moves that empty them; in a burst where
   * notes left the selection, the folders left with them. A burst that
   * settles after a stop decides nothing: its records stay for the next
   * start's reconcile pass.
   */
  private async settleVanished(): Promise<void> {
    this.vanishHandle = null;
    const paths = [...this.vanished];
    const folders = [...this.vanishedFolders];
    const confirmed = new Set(paths.filter((path) => this.confirmedDeletions.delete(path)));
    this.vanished.clear();
    this.vanishedFolders.clear();
    if (!this.running) return;
    const context = this.need();
    const started = context.now();
    const left: [string, string | null][] = [];
    // What goes now -- confirmed, or back at its name and so the change it
    // is -- and what may be asked about first (issue #162).
    const gone: string[] = [];
    const asked: string[] = [];
    let moved = 0;
    let removed = 0;
    try {
      const index = byStat(await context.host.inventory());
      for (const path of paths) {
        if (!this.running) return;
        const outcome = await this.follow(context, path, index, new Set());
        if (outcome === "moved") moved++;
        else if (outcome !== null) left.push([path, outcome.to]);
        else if (!confirmed.has(path) && (await context.host.stat(path)) === null) asked.push(path);
        else gone.push(path);
      }
    } catch (error) {
      // Nothing is published on a question the vault could not answer: the
      // records stay, and the next reconcile pass asks it again.
      context.host.log(
        `watch decision=failed reason=vanished_unsettled files=${paths.length} budget_ms=${DEBOUNCE_MS} ` +
          `duration_ms=${context.now() - started} error=${errorText(error)}`,
      );
      return;
    }
    // A BULK DELETION IS A QUESTION HERE TOO (issue #162). Deleted in
    // Obsidian, many notes at once -- a multi-select, or a folder, whose notes
    // each count -- reached every other device within a second, and neither
    // the trash there nor anything here said a word. So a burst at the
    // startup pass's own floor is held, persisted and asked about exactly as
    // that pass's hold is; the user's answer is Delete everywhere
    // (`confirmHeldDeletions`) or Restore here (`restoreHeldDeletions`), and
    // nothing of it leaves this device before then. Below the floor a
    // deletion goes as it always did, and what the user has confirmed goes.
    const holding = asked.length >= BULK_DELETION_MIN;
    if (holding) this.holdBurst(context, asked);
    else gone.push(...asked);
    for (const path of gone) {
      this.deletions.add(path);
      this.enqueue(path);
      removed++;
    }
    for (const [path, to] of left) this.leftScope(path, to);
    for (const folder of folders) {
      if (left.length > 0) this.folderLeftScope(folder, context.state.data.syncFolders);
      else if (holding) this.heldFolders.push(folder);
      else this.folderDeleted(folder);
    }
    context.host.log(
      `watch decision=settled reason=vanished files=${paths.length} moved=${moved} left=${left.length} ` +
        `removed=${removed} folders=${folders.length} budget_ms=${DEBOUNCE_MS} duration_ms=${context.now() - started}`,
    );
  }

  /**
   * The host held deletions and asked about them in its own words (`main.ts`,
   * `holdTwin`, issue #219): a pass that finds them still missing holds them
   * without asking a second time.
   */
  heldAsked(): void {
    this.bulkNoticeShown = true;
  }

  /**
   * Hold a burst the user deleted (issue #162) beside anything already held,
   * and ask once: one notice for the burst, with both answers on it.
   */
  private holdBurst(context: SyncContext, paths: string[]): void {
    const held = [...new Set([...context.state.data.heldDeletions, ...paths])];
    this.hold(held);
    this.bulkNoticeShown = true;
    context.host.log(
      `watch decision=held reason=bulk_deletion files=${paths.length} held=${held.length} floor=${BULK_DELETION_MIN}`,
    );
    context.host.notify(
      `obsync: you deleted ${paths.length} notes${within(paths)}. Delete them on your other devices too? ` +
        "They stay there until you choose.",
      HELD_ACTIONS,
    );
  }

  /** Persist what is held; a hold that cannot be saved stops the engine rather than be forgotten. */
  private hold(paths: string[]): void {
    const { state, host } = this.options;
    state.data.heldDeletions = paths;
    // Answered, released or put back: no question is left asking about it.
    if (paths.length === 0) host.closeQuestion?.();
    void this.track(state.save()).catch(() => {
      this.stop();
      host.log("reconcile decision=failed reason=state_not_saved");
    });
  }

  /**
   * Where did a vanished record's bytes go? `null` when nowhere in this vault
   * -- the one answer after which a tombstone may follow.
   *
   * THE PERIODIC SCAN'S OWN RULE (`survey`, MOVES), asked of the whole index:
   * the unrecorded files carrying the record's `(mtime, size)`. Exactly one,
   * in the selection, is the MOVE, and keeps the file id. Any outside it --
   * one or several, because there is nothing to guess about a note this
   * device will not publish -- means the note LEFT the selection: alive here,
   * so never a deletion (`leftScope`), and where it went when exactly one
   * file carries it (issue #239). An ambiguous pair inside the selection
   * stays unpaired, exactly as the scan leaves it.
   */
  private async follow(
    context: SyncContext,
    from: string,
    index: Map<string, VaultStat[]>,
    taken: Set<string>,
  ): Promise<"moved" | { to: string | null } | null> {
    const record = context.state.fileByPath(from);
    const found = record === undefined ? [] : this.carriers(record, index, taken);
    // A file that is still there is not gone, whatever else carries its bytes.
    if (found.length === 0 || (await context.host.stat(from)) !== null) return null;
    const only = found.length === 1 ? (found[0] as VaultStat) : null;
    const folders = context.state.data.syncFolders;
    if (only !== null && inSyncScope(only.path, folders) && (await context.host.syncable(only.path))) {
      this.renamed(from, only.path);
      return "moved";
    }
    return found.some((file) => !inSyncScope(file.path, folders)) ? { to: only?.path ?? null } : null;
  }

  /** The unrecorded files, among `files`, that carry this record's `(mtime, size)`. */
  private carriers(record: { mtime: number; size: number }, files: Map<string, VaultStat[]>, taken: Set<string>): VaultStat[] {
    return (files.get(`${record.mtime}:${record.size}`) ?? []).filter((file) => !taken.has(file.path) &&
      this.options.state.fileByPath(file.path) === undefined);
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
    // A NEW NOTE WHOSE FIRST POST IS IN FLIGHT has no record to move: the
    // post's answer follows it instead, and records nothing if it left the
    // selection (issue #213, `carryPost`).
    if (this.contextValue !== null && this.contextValue.state.fileByPath(from) === undefined && carryPost(this.contextValue, from, to)) {
      this.options.host.log("rename path_class=file decision=carried reason=post_in_flight");
    }
    // A local move across the boundary is a create within the selected
    // folders, or a file leaving them. Never transfer a remembered outside
    // identity in -- and never publish the exit as a deletion, whether the
    // destination is an unselected folder or a path no device syncs at all:
    // the file is ALIVE at `to`, and a tombstone for a live file is obeyed
    // by every other device (issue #91).
    const context = this.need();
    if (!source || !target) {
      // A NOTE THAT LEFT THE SELECTION IS FOLLOWED OUT THERE (issue #239):
      // back into it, it is published as the move it is; moved again outside
      // it, it is remembered at its new name, or forgotten at one no selection
      // can cover, and nothing of it is published.
      const away = Object.keys(context.state.data.departed).find((id) => context.state.data.departed[id]?.path === from);
      if (target && away !== undefined) {
        const refused = this.rejoin(context, away, to, context.state.data.departed[away]?.size ?? 0);
        context.host.log(`rename path_class=file decision=${refused === null ? "published_move reason=moved_back" : `forgotten reason=${refused}`} file=${away}`);
        if (refused !== null) this.changed(to);
      } else if (target) this.changed(to);
      else if (source) this.leftScope(from, to);
      else if (away !== undefined) {
        if (vaultPathRefusal(to) === null) (context.state.data.departed[away] as { path: string }).path = to;
        else delete context.state.data.departed[away];
        this.saveMoved(context);
      }
      if (this.carryMark(context, from, to)) this.saveMoved(context);
      return;
    }
    const record = context.state.fileByPath(from);
    if (record) {
      // Persist the need to publish the new name. A stopped/failed queue
      // must not make a restart mistake an unposted rename for unchanged bytes.
      context.state.setFile(to, { ...record, mtime: -1, sha256: "" });
      context.state.forgetPath(from);
    }
    if (this.carryMark(context, from, to) || record) this.saveMoved(context);
    this.unschedule(from);
    // And its queued push (issue #264): on a host that folds case the old name
    // resolves to the record just moved, and that push -- the move itself --
    // went out ahead of the folder record a re-case must follow.
    const queued = this.queue.indexOf(from);
    if (queued !== -1) this.queue.splice(queued, 1);
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
    // else under it, and so does a first post in flight (issue #213).
    // A dropped write's empty file may have no record and no work at all, only
    // its mark (#242; review of 2e4cdca), and a note that left the selection
    // only the name it went to (#239).
    const { files, dropped, departed } = this.options.state.data;
    const pending = [...this.pending.keys(), ...this.queue, ...this.pushing.keys()];
    const away = Object.values(departed).map((entry) => entry.path);
    for (const path of new Set([...Object.keys(files), ...Object.keys(dropped), ...away, ...pending])) {
      if (path.startsWith(prefix)) this.renamed(path, to + path.slice(from.length), before);
    }
  }

  /**
   * The mark a dropped write left (#242) goes with its file wherever this
   * device moves it, into, out of or within the selection: an empty file is
   * no content on either side (reviews of d62f201 and 2e4cdca). It moves
   * after any record, because a record made at `to` ends a mark there, and a
   * record moved is no download landed.
   */
  private carryMark(context: SyncContext, from: string, to: string): boolean {
    const mark = context.state.data.dropped[from];
    if (mark === undefined) return false;
    delete context.state.data.dropped[from];
    context.state.data.dropped[to] = mark;
    return true;
  }

  private saveMoved(context: SyncContext): void {
    void this.track(context.state.save()).catch(() => {
      this.stop();
      this.options.host.log("rename decision=failed reason=state_not_saved");
    });
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
    this.settleRemoval(path);
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
   * queued push it may still be owed are cancelled, and the user is told once
   * per move, with the count: every caller makes its exits in one synchronous
   * run, so the notice waits for the end of it (issue #139).
   *
   * AND WHERE IT WENT IS REMEMBERED (issue #239), when a caller knows and it
   * is a name some selection can cover: once a selection covers it again, the
   * note is published as a move of the same file id (`rejoin`), and every
   * device ends with one copy of it instead of two.
   */
  private leftScope(from: string, to: string | null = null): void {
    const context = this.need();
    this.unschedule(from);
    this.deletions.delete(from);
    const queued = this.queue.indexOf(from);
    if (queued !== -1) this.queue.splice(queued, 1);
    const record = context.state.fileByPath(from);
    if (record !== undefined) {
      if (to !== null && vaultPathRefusal(to) === null) {
        context.state.data.departed[record.fileId] = { path: to, versionId: record.versionId, size: record.size };
      }
      context.state.forgetPath(from);
      void this.track(context.state.save()).catch(() => {
        this.stop();
        context.host.log("rename decision=failed reason=state_not_saved");
      });
    }
    context.host.log("rename path_class=file decision=not_published reason=moved_out_of_scope");
    if (this.exited++ > 0) return;
    void Promise.resolve().then(() => {
      const count = this.exited;
      this.exited = 0;
      context.host.log(`scope decision=left_selection files=${count}`);
      context.host.notify(
        `obsync: ${count} note(s) moved out of the folders this device syncs; they stay on your other devices. ` +
          "Nothing was deleted: they are still in this vault and the server keeps their history. This device " +
          "no longer syncs them -- move them back into a selected folder, or add their new folder under " +
          "Sync folders on this device.",
      );
    });
  }

  /**
   * A NOTE THAT LEFT THE SELECTION, BACK IN IT (issue #239; owner ruling
   * 2026-09-29): published as a MOVE of its file id to where it stands now,
   * exactly as a rename made here is (`renamed`) -- its record at the new
   * name, owing the post, on the version this device held when it left.
   * Edits made while it was out go in that same version, and what another
   * device did to it meanwhile meets this one by the rules for a rename
   * meeting an edit or a deletion (issue #151). `null` once it is queued; or
   * the reason it cannot be, with the entry forgotten either way: the file id
   * is held here under another name already.
   */
  private rejoin(context: SyncContext, fileId: string, path: string, size: number): "held_elsewhere" | null {
    const away = context.state.data.departed[fileId] as { versionId: string };
    delete context.state.data.departed[fileId];
    this.saveMoved(context);
    if (context.state.pathByFileId(fileId) !== undefined) return "held_elsewhere";
    context.state.setFile(path, { fileId, versionId: away.versionId, mtime: -1, size, sha256: "" });
    this.renames.add(path);
    this.enqueue(path);
    return null;
  }

  /**
   * How many deletions one pass held back, waiting to be told what they were
   * (issue #123). Zero whenever the last pass published what it found.
   */
  get heldDeletionCount(): number {
    return this.options.state.data.heldDeletions.length;
  }

  /**
   * The user says the deletions were real. THE HELD SET IS PUBLISHED AS IT
   * WAS FOUND, not re-derived: re-scanning here would ask the vault a second
   * question the user has not answered, and a file that came back in the
   * meantime is not in the set the user was shown. Each path is decided
   * exactly as a watcher deletion is (`settleVanished`), so everything
   * downstream -- the "file is present" refusal, the scope check, the echo
   * marks -- still applies, a note restored between the notice and the click
   * is still refused by the push that finds it on the disk, and one whose
   * bytes are back under another name is a move or a note that left the
   * selection, never a deletion (issue #139).
   */
  confirmHeldDeletions(): void {
    const held = this.options.state.data.heldDeletions;
    if (!this.running || held.length === 0) return;
    this.hold([]);
    this.bulkNoticeShown = false;
    // The folders deleted with them go after them, as they would have.
    for (const folder of this.heldFolders) this.vanishedFolders.add(folder);
    this.heldFolders = [];
    this.vanish(held, true);
    this.options.host.log(`reconcile decision=confirmed reason=bulk_deletion queued=${held.length}`);
  }

  /**
   * The user's word that the held deletions were NOT meant for every device
   * (issue #162): each note is put back HERE, from the version this device
   * recorded for it (`pull.ts`, `restoreRecorded`). Create-only, so a note
   * that came back some other way, or a file that took its name, is left
   * exactly as it is; and the record keeps its version, so nothing is
   * published and no copy is made anywhere. A note that cannot be put back
   * now -- the server out of reach -- stays held, to be answered again. One
   * pull at a time, because this writes as the feed does.
   */
  restoreHeldDeletions(): Promise<void> {
    return this.track(this.exclusive(async () => {
      const asked = [...this.options.state.data.heldDeletions];
      if (!this.running || asked.length === 0) return;
      const context = this.need();
      const started = context.now();
      this.heldFolders = [];
      const done = new Set<string>();
      let restored = 0;
      for (const path of asked) {
        if (!this.running) return;
        try {
          if ((await restoreRecorded(context, path)) === "restored") restored++;
          done.add(path);
        } catch (error) {
          context.host.log(
            `watch decision=failed reason=restore_held error=${error instanceof ApiError ? `http_${error.status}` : error instanceof Error ? error.name : "unknown"}`,
          );
        }
      }
      this.hold(context.state.data.heldDeletions.filter((path) => !done.has(path)));
      const left = context.state.data.heldDeletions.length;
      if (left === 0) this.bulkNoticeShown = false;
      context.host.log(
        `watch decision=restored reason=bulk_deletion restored=${restored} held=${left} asked=${asked.length} ` +
          `duration_ms=${context.now() - started}`,
      );
      context.host.notify(
        `obsync put ${restored} note(s) back on this device, and deleted nothing anywhere.` + (left === 0 ? ""
          : ` ${left} could not be put back yet and are still held back: try Restore here again once the server can be reached.`),
        left === 0 ? [] : HELD_ACTIONS,
      );
    }));
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
    this.settleRemoval(path);
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
    this.oweRemoval(path, folders);
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
    // Enqueuing it first is not enough -- pushes in flight side by side are
    // journaled in completion order -- so the record's own post is awaited
    // before anything queued behind it is sent (`takeNext`). Only
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
  private publishFolder(path: string, barrier: boolean, recreate = true): void {
    this.folderPublishes.set(path, recreate || this.folderPublishes.get(path) === true);
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

  /**
   * THIS DEVICE OWES THE SERVER A FOLDER'S REMOVAL, judged against `folders`
   * -- and the debt outlives this engine (issue #265). A renamed selected
   * folder's old name is in no selection once the rename is followed, so no
   * later pass can judge its removal again: a post that failed, or a stop
   * before it, left the empty folder on every other device for good. Written
   * down with its judgement, it is settled by the post, and otherwise judged
   * again by the next start's pass (`survey`).
   */
  private oweRemoval(path: string, folders: SyncFolders): void {
    this.folderRemovals.set(path, folders);
    this.options.state.data.folderRemovals[path] = folders === undefined ? null : [...folders];
    this.saveFolderBarriers();
    this.enqueue(path);
  }

  /** Owed no longer: posted, refused, nothing left to retire, or a folder there again. */
  private settleRemoval(path: string): void {
    this.folderRemovals.delete(path);
    const owed = this.options.state.data.folderRemovals;
    if (!Object.hasOwn(owed, path)) return;
    delete owed[path];
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
      this.folderPublishes.set(path, true);
      this.barriers.add(path);
      this.toFront(path);
    }
    this.options.host.log(
      `engine decision=restored reason=folder_barrier folders=${held.length}`,
    );
    void this.track(this.drain());
  }

  /** At the head of the queue, taken out of wherever it already stands. */
  private toFront(path: string): void {
    const queued = this.queue.indexOf(path);
    if (queued !== -1) this.queue.splice(queued, 1);
    this.queue.unshift(path);
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
    }, tries > 0 ? RECHECK_MS : this.options.host.typing(path) ? EDITOR_SETTLE_MS : DEBOUNCE_MS);
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
        `watch path_class=file decision=failed reason=${errorText(error)}`,
      );
    } finally {
      // A note waiting on its push was counted while this debounce was in
      // flight (`resting`). One that ends with no push -- an echo, bytes the
      // record already describes -- leaves nothing else that would decide the
      // status again, and it would read `syncing` for good (issue #135).
      if (this.running && context.forked.size > 0 && !this.draining && !this.acting(path)) this.status(this.resting());
    }
  }

  /** Something here will still act on this note: its debounce, the queue, or a push. */
  private acting(path: string): boolean {
    return this.pending.has(path) || this.queue.includes(path) || this.pushing.has(path);
  }

  private async settleTracked(
    context: SyncContext,
    path: string,
    tries: number,
    seen: Settled | null,
  ): Promise<void> {
    const stat = await context.host.stat(path);
    if (!stat) {
      if (context.state.fileByPath(path) === undefined) return;
      // A pending change can settle between a filesystem rename and its
      // watcher event. Ask where the note went through the same bounded
      // move check as a delete event before publishing any tombstone.
      context.host.log("watch path_class=file decision=deferred reason=missing_during_settle");
      this.deleted(path);
      return;
    }
    const key = `${path}:${stat.mtime}:${stat.size}`;
    if (context.written.has(key)) {
      context.written.delete(key);
      context.host.log(`watch path_class=file decision=echo_suppressed`);
      return;
    }
    // A CHANGE RIGHT AFTER ANOTHER DEVICE'S VERSION ARRIVED IS READ, even when
    // the record's `(mtime, size)` already describes it (issue #179). Something
    // wrote the file -- that is what the event says -- and a plugin answering
    // a sync can leave both numbers as they were: a fixed-width stamp keeps the
    // size, and a plugin that keeps a note's modified time keeps the other.
    // Trusted, those bytes were never sent, and two devices said `idle` over
    // two different notes. The push compares the DIGEST and posts nothing for
    // the recorded bytes, so this costs one read of a note per such event
    // while its arrival is remembered (`sweepEchoes`), and is bounded by what
    // arrives; anywhere else, and above one chunk, the metadata is taken at its
    // word, as it always was.
    const record = context.state.fileByPath(path);
    const described = record !== undefined && record.mtime === stat.mtime && record.size === stat.size;
    if (described && (stat.size > CHUNK_MAX || !context.arrivals.has(path))) return;
    // THE EDITOR'S OWN SAVE IS NOT A COPY (issue #195): a note someone is
    // typing in settles at its first look, `EDITOR_SETTLE_MS` after the event.
    if (seen === null && stat.size <= EDITOR_SETTLE_MAX_BYTES && context.host.typing(path)) {
      context.host.log(`watch path_class=file decision=settled reason=editor_save budget_ms=${EDITOR_SETTLE_MS}`);
      this.unschedule(path);
      if (!described) await this.answered(context, stat);
      this.enqueue(path);
      return;
    }
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
    if (!described) await this.answered(context, stat);
    this.enqueue(path);
  }

  /**
   * Does this change ANSWER another device's version (issue #179)? It does
   * when it lands within `ANSWER_MS` of that version's arrival, without recent trusted input here: a passive open editor is no evidence of typing, and two people typing in one note -- who answer each other's
   * versions too -- are #135's to settle. The answer is published like any
   * other edit; what it decides is what the pull path does when it next finds
   * this note COLLIDING with another device's change on the same lines
   * (`pull.ts`, `rewriteStorm`). A plugin on one device answering a person
   * typing on the other merges cleanly and is never paused; two plugins
   * rewriting one line after each other's syncs never merge, and that is the
   * storm. Echo suppression is untouched: the pull path's own write never
   * gets here (`settleTracked`).
   */
  private async answered(context: SyncContext, stat: VaultStat): Promise<void> {
    const record = context.state.fileByPath(stat.path);
    // A later feed arrival must not re-judge the same save against a clock
    // that came after it. A user's null verdict is just as durable as an
    // automatic answer until another local save changes the timestamp.
    if (record !== undefined && context.answering.get(record.fileId)?.mtime !== stat.mtime) {
      context.answering.set(record.fileId, { mtime: stat.mtime, arrived: await answerOf(context, stat.path, stat.mtime) });
    }
  }

  private enqueue(path: string): void {
    if (!this.running) return;
    // A held note waits for the feed, whichever pass or event asks (`holdBack`).
    if (this.holding?.paths.has(path) === true && this.options.state.fileByPath(path) === undefined) return;
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
   * the settled promise, decides whether there is something to join. A caller
   * joining it also wakes it, so a path queued now finds a free worker at once
   * rather than when a push in flight lands (#196).
   */
  private drain(): Promise<void> {
    if (this.draining && this.drainWork !== null) {
      this.wakeDrain?.();
      return this.drainWork;
    }
    this.drainWork = this.drainQueue();
    return this.drainWork;
  }

  /**
   * THE QUEUE'S WORKERS (issue #196). Up to `concurrency` pushes run at once,
   * and each slot takes the next path it may the moment it frees up. Batches
   * under `Promise.all` waited for their slowest member, so a note queued
   * behind a large upload waited out the whole upload; now it takes the next
   * free slot. What may go when is `takeNext`'s, and a barrier in flight holds
   * every slot until the server has acknowledged it.
   */
  private async drainQueue(): Promise<void> {
    this.draining = true;
    try {
      const context = this.need();
      const running = new Map<string, Promise<void>>();
      let barrier: string | null = null;
      const failed: unknown[] = [];
      for (;;) {
        let took = false;
        while (this.running && failed.length === 0 && running.size < context.concurrency && !(barrier !== null && running.has(barrier))) {
          const path = this.takeNext(running);
          if (path === null) break;
          if (this.barrierPath === path) barrier = path;
          const work: Promise<void> = this.pushOne(path)
            .catch((error: unknown) => { failed.push(error); })
            .finally(() => running.delete(path));
          running.set(path, work);
          took = true;
        }
        this.active = running.size;
        if (took) this.status(this.resting());
        if (running.size === 0) break;
        await Promise.race([new Promise<void>((wake) => { this.wakeDrain = wake; }), ...running.values()]);
        this.wakeDrain = null;
      }
      // The records the pushes held in memory (`pushFile`, issue #274) are
      // written once the queue is empty: a note pushed alone is saved as soon
      // as it would have been, only no longer inside its slot.
      await this.saveDeferred("drained");
      if (failed.length > 0) throw failed[0];
      // Nothing is queued behind anything any more, so no barrier can still
      // mean something. Expiring them here is what keeps one armed for a path
      // that never reached the queue from serialising a later push of that
      // same name.
      this.barriers.clear();
      this.barrierPath = null;
      // A drain a stop ended has no word on the status: `stopAndWait` says it.
      if (this.running) this.status(this.resting());
    } finally {
      this.draining = false;
    }
  }

  /**
   * The next path a free worker may take, or `null`: the one place the WIRE
   * order is decided.
   *
   * Pushes in flight side by side are journaled in completion order. For the
   * folder record of a rename that changes case alone that is not good enough:
   * it is the only record entitled to re-case a directory, and a move that
   * reaches the receiver first is refused there (`docs/protocol.md`). Such a
   * record is a BARRIER: it is taken only at the head of the queue with nothing
   * in flight, alone, and nothing is taken beside or behind it until the server
   * has acknowledged it (`drainQueue`). Paths queued BEFORE it go as they
   * always did: a barrier orders what follows it, it does not stop the queue.
   *
   * ONE PUSH PER PATH: a path queued again while its own push is in flight
   * waits for that push to land, and what is behind it does not wait for it.
   */
  private takeNext(running: ReadonlyMap<string, unknown>): string | null {
    // Cleared first, so the note of what a worker is carrying can never
    // outlive the take that set it.
    this.barrierPath = null;
    for (const [at, path] of this.queue.entries()) {
      if (this.barriers.has(path)) {
        // Anything before it is in flight, or it would have been taken.
        if (running.size !== 0) return null;
        this.barriers.delete(path);
        this.barrierPath = path;
        return this.queue.shift() as string;
      }
      if (!running.has(path)) return this.queue.splice(at, 1)[0] as string;
    }
    return null;
  }

  /**
   * One push per path at a time. The queue's workers and the pull
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
    // What the lines below name: a folder's removal is no file (issue #240).
    let pathClass = "file";
    try {
      // Folder work first: a path is a folder or a file, never both, and the
      // folder sets are the only ones that can name a path with no stat.
      const judged = this.folderRemovals.get(path);
      if (this.folderRemovals.delete(path)) {
        pathClass = "folder";
        try {
          const versionId = await pushFolderDelete(context, path, judged);
          if (versionId !== null) {
            context.authored.add(versionId);
            this.accepted(true);
          }
        } catch (error) {
          // A refusal of the path is final, and said below; a stop keeps the
          // debt for the next start; anything else is retried (issue #265).
          if (error instanceof VaultPathError) this.settleRemoval(path);
          if (error instanceof VaultPathError || !this.running) throw error;
          this.retryRemoval(context, path, judged, error);
          return;
        }
        this.folderRetries.delete(path);
        this.settleRemoval(path);
        return;
      }
      const recreate = this.folderPublishes.get(path);
      if (recreate !== undefined) {
        this.folderPublishes.delete(path);
        // THE BARRIER IS THIS POST'S, NOT THIS ATTEMPT'S (review round 3,
        // finding 3). `takeNext` took it as it took the path, and a post
        // that fails here is the one case where letting it go is wrong:
        // everything queued behind it is a move the receiver can only refuse
        // until this record lands.
        const barrier = this.barrierPath === path;
        this.barrierPath = null;
        try {
          const versionId = await pushFolder(context, path, recreate);
          if (versionId !== null) {
            context.authored.add(versionId);
            this.accepted(true);
          }
          this.folderRetries.delete(path);
          // ACKNOWLEDGED, AND ONLY NOW IS THE HOLD OVER. The path left
          // `folderPublishes` above so the drain cannot post it twice, but
          // what SURVIVES A STOP is this line's business: a note released
          // when the post BEGAN would be gone if the stop landed while it was
          // in flight, which is exactly the window the hold exists for
          // (review round 4, finding 3).
          this.releaseFolderHold(path);
        } catch (error) {
          this.retryFolder(context, path, barrier, recreate, error);
        }
        return;
      }
      const held = context.state.fileByPath(path);
      if ((held !== undefined && context.state.data.paused[held.fileId] !== undefined) || Object.values(context.state.data.paused).some((entry) => entry.path === path)) {
        if (held !== undefined && context.state.data.paused[held.fileId]?.remote !== true) await publishPause(context, held.fileId, path, true);
        context.host.log(`push path_class=file decision=skipped reason=paused file=${held?.fileId ?? "untracked"}`);
        return;
      }
      if (this.deletions.has(path)) {
        this.deletions.delete(path);
        const outcome = await pushDelete(context, path);
        if (outcome !== null) {
          context.authored.add(outcome.versionId);
          this.accepted(true);
          return;
        }
        // No tombstone was posted: either nothing was recorded to delete, or
        // the file is there after all and `pushDelete` refused to say it was
        // gone. A file that is there is a change, which is the rest of this
        // function; a path with nothing at it and nothing recorded is done.
        if ((await context.host.stat(path)) === null) return;
      }
      // A DOWNLOAD THIS DEVICE COULD NOT WRITE IS NOT AN EDIT (#242). A phone
      // whose write stayed empty however often it was made parks the record
      // (`write_dropped`); what stands at the name is the platform's empty
      // file, and publishing it would empty the note on every device -- or,
      // where the download was new, add an empty one. It is never sent: the
      // parked retry writes the version (`competing` in pull.ts), and its
      // deletion publishes nothing either (`pushDelete`). Text typed into it
      // since is an edit, and is sent as one.
      if (droppedWrite(context, await context.host.stat(path))) {
        context.host.log(`push path_class=file decision=skipped reason=write_dropped file=${context.state.data.dropped[path]}`);
        return;
      }
      const forced = this.renames.delete(path);
      // A note another one is waiting to take the name of settles that first
      // (issue #122, `yieldName`): when it moves aside, its own push is the
      // one that publishes it.
      if (await yieldName(context, path)) return;
      const asked = context.now();
      const outcome = await pushFile(context, path, forced);
      if (outcome.status !== "growing") this.recheck(context, path, asked);
      if (outcome.status === "unchanged") return;
      if (outcome.status === "growing") {
        // The file moved while it was read: nothing was published, so this is
        // the debounce's case again and not a failure (issue #99). So is a
        // download dropped after the guard above looked (#242): the next look
        // sees its empty file.
        if (forced) this.renames.add(path);
        this.debounce(path, 0);
        return;
      }
      context.authored.add(outcome.versionId);
      this.accepted(true);
      // Re-inserted, so the map stays oldest first and the trim stops at the
      // first entry the window can still read.
      const now = context.now();
      context.pushedAt.delete(path);
      context.pushedAt.set(path, now);
      for (const [old, at] of context.pushedAt) {
        if (now - at <= EDITING_WINDOW_MS) break;
        context.pushedAt.delete(old);
      }
      if (outcome.ack?.conflicted) await this.reconcileFile(outcome.fileId);
    } catch (error) {
      // A REQUEST OF A PLUGIN SESSION THAT ENDED (#272): the transport said so,
      // once, and this engine was stopped with that session. What it owed is
      // written down for the session that replaced it; nothing more is said.
      if (error instanceof SessionEnded) return;
      // A push can immediately reconcile a competing head. A native editor
      // refusal in that pull uses the same durable retry as the feed.
      const held = error instanceof Unwritable ? context.state.fileByPath(error.path) : undefined;
      if (held !== undefined) {
        this.park(context, held.fileId, error);
        return;
      }
      // A path this device may not sync is a decision, not a failure: it is
      // logged and dropped, and the status bar stays quiet. Every other
      // failure is the user's business.
      if (error instanceof VaultPathError) {
        context.host.log(`push path_class=${pathClass} decision=not_synced reason=${error.refusal}`);
        return;
      }
      // A push the stop cut at a chunk boundary is not a failure: the file is
      // still unsent, and the next start's pass queues it again.
      if (!this.running && stopped(error)) {
        context.host.log(`push path_class=${pathClass} decision=cancelled reason=engine_stopped`);
        return;
      }
      // Nor is a path that went away while it waited its turn (issue #164):
      // what happened to it is its own event's to publish.
      if (error instanceof PathGone) {
        context.host.log("push path_class=file decision=stood_down reason=path_gone");
        return;
      }
      const message = errorText(error);
      context.host.log(`push path_class=${pathClass} decision=failed reason=${message}`);
      if (error instanceof ApiError && error.code === "domain_mismatch") {
        await this.rekeyed(context, path);
        return;
      }
      // A local fault is worded where it was raised; a refusal the server gave
      // is said in plain words, its code left in the line above.
      this.report(refusalStatus(error) ?? { kind: "error", message: error instanceof ApiError ? PUSH_REFUSED : message });
    }
  }

  /**
   * A CHANGE SEALED FOR A VAULT THIS DEVICE'S KEY NO LONGER OPENS (#177).
   *
   * After "Create a new vault key", a file this device recorded before the
   * change is a file of the vault it left: the server holds its versions under
   * the old domain and answers every later post to it `409 domain_mismatch`,
   * which no retry changes -- and the periodic scan used to re-queue the same
   * edit every 30 s for ever. So the answer is final for that version. The
   * record is forgotten, and a note still on disk is sent once more as a new
   * note under the new key; one notice says so. Nothing on this device changes.
   */
  private async rekeyed(context: SyncContext, path: string): Promise<void> {
    const record = context.state.fileByPath(path);
    if (record !== undefined) context.state.forgetPath(path);
    const again = !this.republished.has(path) && (await context.host.stat(path)) !== null;
    this.republished.add(path);
    context.host.log(`push path_class=file decision=${again ? "republish" : "dropped"} reason=domain_mismatch file=${record?.fileId ?? "untracked"}`);
    if (!this.rekeyNoticeShown) {
      this.rekeyNoticeShown = true;
      context.host.notify(
        "obsync: edits made on this device before its vault key changed could not be sent to the old vault. " +
          "They are still here, and obsync sends them under the new key.",
      );
    }
    await context.state.save();
    if (again) this.enqueue(path);
  }

  /**
   * A SAVE THE MODIFICATION TIME CANNOT SEE (issue #175).
   *
   * Every later look at a pushed file -- the watcher's settle, the scan, the
   * next start -- trusts an unchanged `(mtime, size)` to mean unchanged
   * bytes. On FAT32 the time is kept to the even second (HFS+ and ext3 to the
   * second), so a save of the same size inside the step the push read in
   * keeps both numbers and is never sent. So a push that read a whole-second
   * time within one step of `asked` pushes once more when the step has
   * closed: `pushFile` compares the digest and posts nothing if the bytes did
   * not change. A fine-grained time, or one a step away, cannot hide a save,
   * and is never read twice.
   */
  private recheck(context: SyncContext, path: string, asked: number): void {
    const record = context.state.fileByPath(path);
    if (record === undefined || record.mtime % 1000 !== 0) return;
    const age = asked - record.mtime;
    if (Math.abs(age) >= MTIME_STEP_MS) return;
    const delay = MTIME_STEP_MS - age;
    context.host.log(`push path_class=file decision=recheck reason=coarse_mtime delay_ms=${delay}`);
    this.timers.set(() => this.enqueue(path), delay);
  }

  /**
   * A folder record's post FAILED, and what the queue owes it.
   *
   * `takeNext` deleted the barrier as it took the path and `pushNow` deleted
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
  private retryFolder(context: SyncContext, path: string, barrier: boolean, recreate: boolean, error: unknown): void {
    // An ended session's request said so itself (#272), and what survives the
    // stop below is already written down.
    if (error instanceof SessionEnded) return;
    const attempt = (this.folderRetries.get(path) ?? 0) + 1;
    const message = errorText(error);
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
      this.report(refusalStatus(error) ?? { kind: "error", message: error instanceof ApiError ? PUSH_REFUSED : message });
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
    this.publishFolder(path, barrier, recreate);
    // In FRONT: what this record orders is already queued behind it. EVEN
    // WHEN IT IS QUEUED ALREADY (issue #238): a duplicate report of the rename
    // queued it again while the post was in flight, behind those very moves.
    this.toFront(path);
    context.host.log(
      `push path_class=folder decision=retry reason=folder_post attempt=${attempt} budget=${FOLDER_POST_TRIES}`,
    );
  }

  /**
   * A folder removal's post FAILED (issue #265). The debt is written down
   * (`oweRemoval`), so within this engine the removal is posted again against
   * the selection it was judged in, `FOLDER_POST_TRIES` attempts in all; past
   * that it waits for the next start's pass, or Sync now's.
   */
  private retryRemoval(context: SyncContext, path: string, judged: SyncFolders, error: unknown): void {
    const attempt = (this.folderRetries.get(path) ?? 0) + 1;
    const message = errorText(error);
    if (attempt >= FOLDER_POST_TRIES) {
      this.folderRetries.delete(path);
      context.host.log(
        `push path_class=folder decision=expired reason=folder_removal attempt=${attempt} budget=${FOLDER_POST_TRIES} ` +
          `held=next_pass error=${message}`,
      );
      this.report(refusalStatus(error) ?? { kind: "error", message: error instanceof ApiError ? PUSH_REFUSED : message });
      return;
    }
    this.folderRetries.set(path, attempt);
    context.host.log(
      `push path_class=folder decision=retry reason=folder_removal attempt=${attempt} budget=${FOLDER_POST_TRIES} error=${message}`,
    );
    this.folderRemovals.set(path, judged);
    this.enqueue(path);
  }

  /**
   * Another device wrote first. Pull the file's heads and let the pull path
   * merge or keep both, then the local head is current again.
   */
  private async reconcileFile(fileId: string, known?: FileRecord): Promise<void> {
    const context = this.need();
    const file = known ?? await context.transport.getFile(fileId);
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

  /**
   * The change feed, one long poll after another.
   *
   * A STOP WAITS FOR THE PAGE BEING APPLIED, NEVER FOR THE POLL (issue #150).
   * A poll parked on the server moves nothing, and its answer after a stop is
   * dropped unread -- no change applied, no cursor moved, nothing saved, so a
   * reload that already holds the state is never written over. Tracked whole,
   * the loop held every folder Save at "Waiting for transfers..." for the
   * rest of the server's 55 s window with nothing transferring (S30). The
   * loop belongs to the start that made it: one that outlives a stop never
   * runs beside the next start's.
   */
  private async feedLoop(): Promise<void> {
    const context = this.need();
    const live = (): boolean => this.running && this.contextValue === context;
    // THE JOURNAL IS ASKED WHETHER IT WENT BACK, at start and after every
    // failed read -- the moments a server can have been rebuilt from a backup
    // underneath this device (issue #145, `restore.ts`). A read, like the
    // poll: untracked, and its answer after a stop is dropped unread.
    let verify = true;
    while (live()) {
      try {
        if (verify) {
          const found = await probeFeed(context);
          if (!live()) return;
          this.restoreDue ??= found;
          verify = false;
        }
        // Answered before the next page, one pull at a time (`recover`).
        if (this.restoreDue !== null) await this.track(this.recover(context, this.restoreDue));
        if (!live()) return;
        // A Sync now waiting on the feed is asked for at once too (`readFeed`).
        const quick = !this.feedAnswered || this.feedAsks.length > 0;
        const drop = new AbortController();
        this.poll = quick ? null : { sent: this.nowFn(), drop };
        this.reading = quick;
        const sent = ++this.feedReads;
        // Ended by the stop, not waited out: a stopped engine's poll is one more
        // request against a credential that may be about to be given up (#157).
        // A wake drops it too (`wake`), so either ends this one request.
        const page = await untilStopped(context.signal, drop, () =>
          context.transport.changes(context.state.data.lastSeq, quick ? 0 : 55, 1000, { signal: drop.signal }));
        this.poll = null;
        this.reading = false;
        if (!live()) return;
        this.feedAnswered = true;
        this.absent = false;
        this.accepted(false);
        // A restore the repair pass noticed while this read waited is answered
        // before anything the read brought is applied.
        if (this.restoreDue !== null) continue;
        await this.track(this.applyPage(context, page));
        this.answerFeed(sent);
      } catch (error) {
        this.poll = null;
        this.reading = false;
        if (!live()) return;
        // A wake dropped the poll (`wake`): the next read asks at once, and
        // whatever the dropped one brings later is discarded unread.
        if (error instanceof ApiError && error.code === "cancelled") continue;
        // A failed read is the answer a waiting Sync now gets: it says what
        // the status says, and the retry goes on without it.
        this.answerFeed(Number.POSITIVE_INFINITY);
        this.feedAnswered = false;
        // What the failure means, said on the FIRST one (#155): a refusal names
        // itself and stands until the server answers again; only absence reads
        // offline; anything else is a read that failed, said as that.
        const refused = refusalStatus(error) ?? { kind: "error", code: "feed", message: FEED_FAILED };
        if (refused.kind === "error" && refused.code === "credential_rejected") {
          context.host.log("feed decision=stopped reason=credential_rejected");
          this.status(refused);
          this.stop();
          return;
        }
        if (error instanceof ApiError && error.code === "seq_ahead") {
          context.host.log("feed decision=resync reason=seq_ahead");
          this.restoreDue = { verdict: "restored", reason: "seq_ahead" };
          continue;
        }
        verify = true;
        const message = errorText(error);
        context.host.log(`feed decision=retry reason=${message} status=${refused.kind === "error" ? refused.code : refused.kind} retry_ms=${FEED_ERROR_BACKOFF_MS}`);
        // Absence is the feed's to say until its next read is answered, and
        // no longer than that (`resting`).
        this.absent = refused.kind === "offline";
        if (this.absent) this.status(this.resting());
        else this.report(refused);
        await new Promise<void>((resolve) => {
          this.feedPause = resolve;
          this.timers.set(resolve, FEED_ERROR_BACKOFF_MS);
        });
        this.feedPause = null;
      }
    }
  }

  /**
   * The device's word that something changed (#134, #195): its network is
   * back, the app is in front of the person again, the address changed, or
   * Retry now was pressed. The feed's pause after a failed read ends now, and
   * a long poll that has waited `POLL_STALE_MS` -- or any poll, when the
   * address it went to is no longer the address, or Sync now waits for a
   * read (`readFeed`) -- is dropped for a read that asks at once. Requests
   * asleep inside the transport are the transport's to wake
   * (`Transport.wake`). One line, and only when something was ended.
   */
  wake(reason: string): void {
    if (!this.running) return;
    const pause = this.feedPause;
    this.feedPause = null;
    pause?.();
    const poll = this.poll;
    const waited = poll === null ? 0 : this.nowFn() - poll.sent;
    const dropped = poll !== null && (reason === "address" || reason === "sync_now" || waited >= POLL_STALE_MS);
    if (dropped) {
      this.poll = null;
      this.feedAnswered = false;
      poll.drop.abort();
    }
    if (pause !== null || dropped) {
      this.options.host.log(`feed decision=woken reason=${reason} ended_pause=${pause === null ? 0 : 1} dropped_poll=${dropped ? 1 : 0} waited_ms=${waited}`);
    }
    // THE WINDOW IS BACK IN FRONT (issue #198): a note moved in a file manager
    // behind it is found now, by a walk that starts at once -- or by the next
    // pass, when one is running -- and not at the next `WALK_MS`.
    if (reason === "focus" || reason === "foreground") {
      this.walkFor = "focus";
      if (this.scanHandle !== null) {
        this.timers.clear(this.scanHandle);
        this.scanTick();
      }
    }
  }

  /**
   * One pull at a time: a retry pass never applies beside the feed. A failed
   * turn hands the next one on all the same (`then(work, work)`), so one
   * error cannot stop every later pull.
   */
  private exclusive(work: () => Promise<void>): Promise<void> {
    return (this.pulling = this.pulling.then(work, work));
  }

  /**
   * Apply one feed record -- or PARK it, and let the feed move on (issue #144).
   *
   * A record THIS device cannot write, for a reason that belongs to that one
   * file or chunk (`pull.ts`, `Unwritable`), used to be rethrown here, and the
   * feed retried the same record every five seconds without moving its
   * cursor: one locked note, one read-only folder, one attachment on a full
   * disk, one chunk the server had quarantined stopped every later change from
   * arriving, in every folder, while the status bar blamed the network. Every
   * other failure -- the server out of reach, a refusal about this device, a
   * state that cannot be saved -- is still thrown, and keeps the handling it
   * had: it is no fact about one record, and parking every record behind it
   * would only hide it.
   *
   * A LATER VERSION OF A PARKED FILE THAT APPLIES SETTLES IT AT ONCE: the
   * parked record is asked of the server again, which answers with what the
   * file is NOW -- a newer version this device already has, or a deletion --
   * so a deleted attachment stops being retried the moment its tombstone
   * arrives, and a fork keeps both sides as it would have in order.
   *
   * What the pull decided, or `null` for a record parked: either way the feed
   * has consumed it, and the mark moves past it (`processed`, issue #145).
   */
  private async receive(context: SyncContext, change: ChangeRecord): Promise<ApplyResult | null> {
    if (await this.background(context, change)) return null;
    // Another device's authenticated version arrives before its write can
    // trigger a host plugin. Waiting until applyChange returns can miss a
    // rewrite made by that plugin during the filesystem event itself.
    const arrived = context.now();
    const remember = async (): Promise<void> => {
      const path = context.state.pathByFileId(change.file_id);
      if (path === undefined || !inSyncScope(path, context.state.data.syncFolders)) return;
      // Preserve a waiting save's verdict against the previous arrival before
      // replacing that clock with a time later than the save being judged.
      const stat = await context.host.stat(path);
      const local = context.state.fileByPath(path);
      if (stat !== null && local?.fileId === change.file_id &&
        (local.mtime !== stat.mtime || local.size !== stat.size)) {
        await this.answered(context, stat);
        context.host.log(`watch decision=edit_verdict_preserved reason=arrival_advanced file=${change.file_id} seq=${change.seq}`);
      }
      context.arrivals.delete(path);
      context.arrivals.set(path, arrived);
    };
    let incoming = false;
    let result: ApplyResult;
    try {
      result = await applyChange(context, change, async () => {
        incoming = true;
        await remember();
      });
    } catch (error) {
      this.park(context, change.file_id, error);
      return null;
    }
    // First materialisation and renames can establish a different tracked
    // path. Only an authenticated ordinary version supplies this evidence.
    if (incoming) await remember();
    if (context.state.data.parked[change.file_id] !== undefined) await this.retryOne(context, change.file_id);
    return result;
  }

  /**
   * Remember a record this device could not write, with the path and the
   * reason to name, persisted with the cursor that moves past it (`state.ts`).
   * One notice per file, when it is first parked; a retry that fails again
   * only updates the reason. Anything that is not `Unwritable` is thrown on.
   */
  private park(context: SyncContext, fileId: string, error: unknown): void {
    if (!(error instanceof Unwritable)) throw error;
    const parked = context.state.data.parked;
    const known = parked[fileId] !== undefined;
    parked[fileId] = { path: error.path, reason: error.reason };
    // Nothing is marked here. The empty file a dropped write left was marked
    // by the write itself, at the name it wrote, before it committed (#242,
    // `commitMarked`): apart from the reason a later retry may give this
    // record, and before any push could read it.
    this.armParkRetry();
    this.armEditorRetry();
    // The file id and the reason, never the path: a name is vault content.
    context.host.log(
      `feed decision=parked reason=${error.reason} file=${fileId} parked=${Object.keys(parked).length} ` +
        `retry_ms=${error.reason === "active_editor" ? 1000 : this.parkDelay}`,
    );
    if (!known && error.reason !== "active_editor") {
      context.host.notify(
        `obsync: ${unwritableText(error.path, error.reason)}. Every other change keeps arriving. This file is ` +
          "tried again by itself, and at once when you run Sync now after fixing it.",
      );
    }
    this.status(this.resting());
  }

  /**
   * What the status says when nothing is being pushed or pulled, decided in
   * ONE place and in this order: a parked file by name, until it lands; then
   * notes still waiting on this device's own push to settle a fork (issue
   * #135), as the work they are; then `idle`.
   *
   * A note counts only while something is in flight for it -- its debounce,
   * the queue, a push. Nothing in flight means nothing here will change it:
   * a pair no rule settles, a push that never came. Those are dropped rather
   * than left reading `syncing` for good.
   */
  private resting(): EngineStatus {
    if (this.refused !== null) return this.refused;
    const forked = this.contextValue?.forked;
    for (const fileId of forked ?? []) {
      const path = this.options.state.pathByFileId(fileId);
      if (path === undefined || !this.acting(path)) forked?.delete(fileId);
    }
    const records = Object.values(this.options.state.data.parked);
    const working = (entry: { reason: string }): boolean => entry.reason === "active_editor" || entry.reason === DOWNLOADING;
    const waiting = (forked?.size ?? 0) + records.filter(working).length;
    const parked = records.filter((entry) => !working(entry));
    const newest = parked[parked.length - 1];
    if (newest !== undefined) {
      const more = parked.length > 1 ? ` (and ${parked.length - 1} more: Show sync status)` : "";
      return { kind: "error", message: unwritableText(newest.path, newest.reason) + more };
    }
    const paused = Object.values(this.options.state.data.paused);
    const last = paused[paused.length - 1];
    if (last !== undefined) {
      const more = paused.length > 1 ? ` and ${paused.length - 1} more` : "";
      return { kind: "paused", message: `${last.path}${more} (Show sync status)` };
    }
    // FROM FACTS, NOT FROM WHICHEVER LOOP SPOKE LAST (issue #158): absence
    // until the feed is answered again; then the work still to do -- pushes
    // queued and in flight, records arrived and not yet written, notes waiting
    // on their own push or on an editor -- and `idle` only when there is none
    // AND the feed's latest read was answered. Before that first answer the
    // device is checking, which is not idle either.
    if (this.absent) return { kind: "offline" };
    const work = this.queue.length + this.active + this.pulls + waiting;
    // A NOTE WAITING ON AN EDITOR HERE IS NAMED (issue #252): a count
    // alone read "syncing 1" for minutes and said nothing of what to do.
    const held = records.find((entry) => entry.reason === "active_editor")?.path;
    if (work > 0 || (this.running && !this.feedAnswered)) return { kind: "syncing", pending: work, ...(held === undefined ? {} : { held }) };
    return { kind: "idle" };
  }

  /**
   * Sync a paused note again (issue #179): one, from Resume in Show sync
   * status, or every one, from Sync now -- the moments the user has just
   * turned off whatever kept rewriting it. The note is first brought to what
   * the other devices have (`resumePaused`), then asked of the server as any
   * parked record is, then settled by the watcher as if it had just changed,
   * which publishes what this device holds, or its deletion. A resume that
   * fails leaves the note paused, to be resumed again.
   */
  resume(fileId?: string, trigger = "sync_now"): Promise<void> {
    // Nothing paused waits for nothing: Sync now joins the pull queue only
    // when it has a note to bring back.
    if (Object.keys(this.options.state.data.paused).length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      if (!this.running) return;
      const context = this.need();
      const paused = context.state.data.paused;
      for (const id of fileId === undefined ? Object.keys(paused) : [fileId]) {
        const entry = paused[id];
        if (entry === undefined) continue;
        const started = context.now();
        delete paused[id];
        let outcome: string;
        try {
          if (entry.remote === true && context.state.pathByFileId(id) !== undefined && await context.host.stat(entry.path) !== null) {
            // The peer held our note before applying anything. Preserve the
            // local editor's newest text as the next head, even if its last
            // keystrokes were saved after the pause arrived.
            outcome = await publishHeld(context, id, entry.path);
          } else {
            outcome = await resumePaused(context, id);
            if (outcome === "no_free_name" || outcome === "saved_meanwhile") throw new Error(outcome);
            if (outcome !== "deleted_here") await this.reconcileFile(id);
          }
          await publishPause(context, id, entry.path, false);
        } catch (error) {
          paused[id] = entry;
          outcome = `failed_${error instanceof ApiError ? `http_${error.status}` : "error"}`;
        }
        await context.state.save();
        const path = context.state.pathByFileId(id);
        if (path !== undefined && paused[id] === undefined) {
          context.answering.delete(id);
          context.arrivals.delete(path);
          this.changed(path);
        }
        context.host.log(
          `pull decision=resumed outcome=${outcome} file=${id} trigger=${trigger} ` +
            `paused=${Object.keys(paused).length} duration_ms=${context.now() - started}`,
        );
      }
      this.status(this.resting());
    });
  }

  /** Active-editor waits use the durable parked record, but need no error notice or long backoff. */
  private armEditorRetry(): void {
    if (!this.running || this.editorHandle !== null ||
      !Object.values(this.options.state.data.parked).some((entry) => entry.reason === "active_editor")) return;
    this.editorHandle = this.timers.set(() => {
      this.editorHandle = null;
      void this.track(this.retryEditors());
    }, 1000);
  }

  private retryEditors(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.running) return;
      const context = this.need();
      try {
        for (const [fileId, entry] of Object.entries(context.state.data.parked)) {
          if (!this.running) return;
          if (entry.reason === "active_editor") await this.retryOne(context, fileId);
        }
        await context.state.save();
        this.status(this.resting());
      } catch (error) {
        context.host.log(`pull decision=editor_retry_failed reason=${error instanceof ApiError ? `http_${error.status}` : "failed"} retry_ms=1000`);
        this.report(refusalStatus(error) ?? { kind: "error", message: "An editor update could not finish. It will be retried automatically." });
      } finally {
        this.armEditorRetry();
      }
    });
  }

  /** Arm the next pass, one doubling later; with nothing parked, disarm and start over. */
  private armParkRetry(): void {
    if (!Object.values(this.options.state.data.parked).some((entry) => entry.reason !== "active_editor")) {
      if (this.parkHandle !== null) this.timers.clear(this.parkHandle);
      this.parkHandle = null;
      this.parkDelay = 0;
      return;
    }
    if (this.parkHandle !== null || !this.running) return;
    this.parkDelay = Math.min(PARK_RETRY_MAX_MS, this.parkDelay === 0 ? PARK_RETRY_MS : this.parkDelay * 2);
    this.parkHandle = this.timers.set(() => {
      this.parkHandle = null;
      void this.track(this.retryParked("timer"));
    }, this.parkDelay);
  }

  /** Try every parked record again: the timer's turn, the start, or Sync now. */
  private retryParked(trigger: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.running || Object.keys(this.options.state.data.parked).length === 0) return;
      const context = this.need();
      const started = context.now();
      let released = 0;
      for (const fileId of Object.keys(context.state.data.parked)) {
        if (!this.running) return;
        if (trigger === "timer" && context.state.data.parked[fileId]?.reason === "active_editor") continue;
        // The background lane's, and it runs beside this pass (`lane`).
        if (context.state.data.parked[fileId]?.reason === DOWNLOADING) continue;
        try {
          if (await this.retryOne(context, fileId)) released++;
        } catch (error) {
          // Not this record's fault, so nothing is released and nothing new
          // is said; an unreachable server ends the pass, the next one asks.
          context.host.log(
            `feed decision=deferred reason=${error instanceof ApiError ? `http_${error.status}` : "failed"} ` +
              `file=${fileId} trigger=${trigger}`,
          );
          if (error instanceof ApiError && error.code === "unreachable") break;
        }
      }
      await context.state.save();
      this.lane();
      context.host.log(
        `feed decision=retried trigger=${trigger} released=${released} ` +
          `parked=${Object.keys(context.state.data.parked).length} retry_ms=${this.parkDelay} ` +
          `duration_ms=${context.now() - started}`,
      );
      this.status(this.resting());
    });
  }

  /**
   * One parked record, asked of the server as its file stands NOW (`reconcileFile`,
   * every head this device does not hold), so a version that superseded it is
   * what lands. True once nothing about it is left to write here.
   */
  private async retryOne(context: SyncContext, fileId: string): Promise<boolean> {
    const waiting = context.state.data.parked[fileId];
    if (waiting?.reason === "active_editor" &&
      (context.host.typing(waiting.path) || await context.host.editing(waiting.path) === "unsaved")) {
      this.armEditorRetry();
      return false;
    }
    try {
      const file = await context.transport.getFile(fileId);
      // A head too large to fetch under the pull lock goes to the lane.
      if (this.ahead(context, fileId, file) !== null) {
        context.state.data.parked[fileId] = { path: waiting?.path ?? "", reason: DOWNLOADING };
        this.lane();
        return false;
      }
      await this.reconcileFile(fileId, file);
    } catch (error) {
      this.park(context, fileId, error);
      return false;
    }
    delete context.state.data.parked[fileId];
    this.armParkRetry();
    context.host.log(`feed decision=released file=${fileId} parked=${Object.keys(context.state.data.parked).length}`);
    return true;
  }

  /**
   * A LARGE DOWNLOAD NEVER HOLDS UP THE FEED (issue #196). A version of more
   * than `LARGE_APPLY_BYTES` this device would have to download is parked
   * `downloading`, which the status counts as work, and applied by the lane,
   * so the records behind it keep applying. Persisted with the cursor like any
   * parked record, so a stop or a restart resumes it (`retryParked`); a later
   * version of the file that the feed applies settles it at once (`receive`).
   */
  private async background(context: SyncContext, change: ChangeRecord): Promise<boolean> {
    if (change.deleted || change.bytes <= LARGE_APPLY_BYTES || change.device_id === context.deviceId ||
      context.authored.has(change.version_id) || context.state.data.paused[change.file_id] !== undefined ||
      context.state.data.departed[change.file_id] !== undefined) return false;
    // A rename, or bytes this device already holds: nothing to fetch.
    const kept = context.state.pathByFileId(change.file_id);
    if (kept !== undefined && context.state.fileByPath(kept)?.sha256 === (await sidDigest(change.sids))) return false;
    const entry = await decodeRecordManifest(context, change).catch(() => null);
    // Refused by the ordinary apply, which names why.
    if (entry?.v !== 1) return false;
    // A FILE HELD FOR THE FEED IS SETTLED IN THE FEED'S TURN (issue #232):
    // most likely it IS this version, which the apply proves by reading it and
    // fetching nothing (`adopt`). Parked for the lane, it was downloaded, and
    // the hold let its name go before the lane's turn: published again, under
    // a new file id.
    if (this.expected.has(change.file_id)) return false;
    context.state.data.parked[change.file_id] = { path: entry.path, reason: DOWNLOADING };
    context.host.log(
      `feed decision=backgrounded reason=large bytes=${change.bytes} budget=${LARGE_APPLY_BYTES} file=${change.file_id} seq=${change.seq}`,
    );
    this.lane();
    return true;
  }

  /**
   * THE BACKGROUND LANE (issue #196): the records parked `downloading`, one
   * at a time, each fetched ahead outside the pull lock and applied under it
   * (`laneOne`). One run at a time, and a record parked while it runs is
   * taken by the same run. A failure leaves the record for the next pass
   * (`armParkRetry`), except one about that file alone, which is parked by
   * name as the feed parks it.
   */
  private lane(): void {
    if (this.laning || !this.running) return;
    this.laning = true;
    void this.track(this.laneRun(this.need()));
  }

  private async laneRun(context: SyncContext): Promise<void> {
    const tried = new Map<string, unknown>();
    try {
      for (;;) {
        if (!this.running || this.contextValue !== context) return;
        const next = Object.entries(context.state.data.parked)
          .find(([id, entry]) => entry.reason === DOWNLOADING && tried.get(id) !== entry);
        if (next === undefined) return;
        const [fileId, entry] = next;
        tried.set(fileId, entry);
        const started = context.now();
        context.host.log(`pull decision=start reason=background file=${fileId} parked=${Object.keys(context.state.data.parked).length}`);
        let outcome: string;
        try {
          outcome = await this.laneOne(context, fileId);
        } catch (error) {
          if (stopped(error)) return;
          outcome = `deferred_${error instanceof ApiError ? error.code : "failed"}`;
          this.armParkRetry();
        }
        context.host.log(`pull decision=summary reason=background file=${fileId} outcome=${outcome} duration_ms=${context.now() - started}`);
        this.status(this.resting());
      }
    } finally {
      this.laning = false;
    }
  }

  /**
   * One file of the lane: its large head fetched ahead, outside the pull lock
   * (`stage`), then applied UNDER it like any parked record, against the
   * file's heads read again there -- so an older version never lands over a
   * newer one, and a head that moved on to another large version while this
   * one streamed is fetched ahead in its turn.
   */
  private async laneOne(context: SyncContext, fileId: string): Promise<string> {
    for (;;) {
      const before = await context.transport.getFile(fileId, { signal: context.signal });
      const ahead = this.ahead(context, fileId, before);
      if (ahead !== null) await stage(context, ahead);
      let outcome = "applied";
      try {
        await this.exclusive(async () => {
          if (!this.running || this.contextValue !== context) {
            outcome = "stopped";
            return;
          }
          // A later version the feed applied has settled it (`receive`).
          if (context.state.data.parked[fileId]?.reason !== DOWNLOADING) {
            outcome = "settled";
            return;
          }
          const file = await context.transport.getFile(fileId, { signal: context.signal });
          const next = this.ahead(context, fileId, file);
          if (next !== null && next.version_id !== ahead?.version_id) {
            outcome = "moved_on";
            return;
          }
          try {
            await this.reconcileFile(fileId, file);
          } catch (error) {
            this.park(context, fileId, error);
            outcome = "parked";
            return;
          }
          delete context.state.data.parked[fileId];
          await context.state.save();
          this.armParkRetry();
        });
      } finally {
        // What the apply did not take -- the heads moved on, a stop -- is dropped.
        for (const writer of context.staged?.values() ?? []) await writer.abort();
        context.staged?.clear();
      }
      if (outcome !== "moved_on") return outcome;
    }
  }

  /**
   * The one head of `file` worth fetching ahead: a single large version this
   * device does not hold (`stage` still fetches nothing for bytes it has).
   * `null` for anything else -- a fork, a deletion, a small version -- which
   * the ordinary apply settles under the lock.
   */
  private ahead(context: SyncContext, fileId: string, file: FileRecord): ChangeRecord | null {
    const kept = context.state.pathByFileId(fileId);
    const held = kept === undefined ? undefined : context.state.fileByPath(kept);
    const head = file.heads.length === 1 ? file.heads[0] : undefined;
    const version = file.versions.find((candidate) => candidate.version_id === head);
    if (version === undefined || head === held?.versionId || version.deleted || version.bytes <= LARGE_APPLY_BYTES) return null;
    return { ...version, file_id: fileId, domain_id: file.domain_id, seq: context.state.data.lastSeq, heads: file.heads, conflicted: false };
  }

  /**
   * One page of the feed, in order; a stop ends it after the change in hand.
   * Its records are applied one pull at a time beside a retry pass
   * (`exclusive`), and a record this device cannot write is parked (`receive`).
   */
  private async applyPage(context: SyncContext, page: ChangesPage): Promise<void> {
    await this.learnNames(context, page.changes);
    let replayed = 0;
    // Whether any change of the page was more than this device's own version
    // coming back (`pull.ts`, ECHOES) or an entry a replay skips.
    let wrote = false;
    await this.exclusive(async () => {
      // What arrived and is not yet written is work, and the status counts it
      // down as it lands: a receiving device read `idle` through a thousand
      // notes and a gigabyte (issue #158, S46, S26).
      this.pulls = page.changes.length;
      context.ahead = new Prefetch(context, page.changes);
      context.host.pass?.(true);
      try {
        for (const change of page.changes) {
          if (!this.running) break;
          if (this.pulls > 0) this.status(this.resting());
          // Re-reading a rebuilt journal from zero (issue #145): what this
          // device already processed is not news, and applied again it is
          // yesterday's note over today's, a deletion undone, a rename reverted.
          const mark = context.state.data.feedMark;
          if (mark?.replay === true && seenBefore(change, mark)) replayed++;
          else {
            const result = await this.receive(context, change);
            if (result !== "echo") wrote = true;
            this.processed(context, change, result);
          }
          context.state.data.lastSeq = change.seq;
          this.pulls--;
        }
      } finally {
        this.pulls = 0;
        context.ahead = null;
        context.host.pass?.(false);
      }
    });
    if (replayed > 0) context.host.log(`feed decision=skipped reason=seen_before_restore entries=${replayed}`);
    if (!this.caughtUp && page.seq >= page.head_seq) {
      await this.releaseRetired(context);
      await this.returnLost(context);
      this.release("caught_up");
    }
    // A PAGE THAT WROTE NOTHING HERE WAITS FOR THE NEXT SAVE (issue #274).
    // An uploading device reads its own versions back all the way through its
    // upload, a page every few notes, and each page's save rewrote the whole
    // data file to move nothing but the cursor. Lost in a crash, the cursor is
    // older, and those echoes -- or a replay's skipped entries -- are read
    // again and dropped again. An empty page that leaves the cursor where it
    // is has nothing to save at all.
    if (!wrote && this.running) {
      if (page.changes.length > 0 || page.seq !== context.state.data.lastSeq) {
        context.state.data.lastSeq = page.seq;
        this.defer();
      }
    } else {
      // The save below writes what `defer` held (issue #194).
      this.takeDeferred();
      if (!this.running) {
        await context.state.save();
        return;
      }
      context.state.data.lastSeq = page.seq;
      await context.state.save();
    }
    announceCopies(context);
    // EVERY ANSWERED PAGE, EMPTY OR NOT (issue #158): an `offline` the feed
    // said is taken back by the next answer, not by the next page that
    // happens to carry a change -- which kept every device reading `offline —
    // retrying` for minutes after its server was back.
    this.status(this.resting());
  }

  /**
   * A record `recordAt` wrote in memory only (issue #194): its page's save
   * writes it, or this timer, when the page is still running
   * `SAVE_COALESCE_MS` after the first such record.
   */
  private defer(): void {
    this.deferred++;
    if (this.saveHandle !== null || !this.running) return;
    this.saveHandle = this.timers.set(() => {
      this.saveHandle = null;
      void this.saveDeferred("coalesced");
    }, SAVE_COALESCE_MS);
  }

  /** What `defer` held, handed to a save about to run: the count, and no timer left to write it twice. */
  private takeDeferred(): number {
    if (this.saveHandle !== null) this.timers.clear(this.saveHandle);
    this.saveHandle = null;
    const records = this.deferred;
    this.deferred = 0;
    return records;
  }

  /** Save what `defer` held, now -- its timer, or a stop -- and say so in one line. */
  private saveDeferred(reason: string): Promise<void> {
    const records = this.takeDeferred();
    if (records === 0) return Promise.resolve();
    const { state, host } = this.options;
    const started = this.nowFn();
    return this.track(state.save()).then(
      () => host.log(`state decision=saved reason=${reason} records=${records} budget_ms=${SAVE_COALESCE_MS} duration_ms=${this.nowFn() - started}`),
      () => {
        host.log(`state decision=failed reason=${reason} records=${records} budget_ms=${SAVE_COALESCE_MS}`);
        if (this.running) this.stop();
      },
    );
  }

  /** Hold back one local note until the feed has caught up (`HOLD_MS`); the limit runs from the first. */
  private holdBack(path: string): void {
    const holding = this.holding;
    if (holding === null) return;
    holding.paths.add(path);
    holding.handle ??= this.timers.set(() => this.release("timeout"), HOLD_MS);
  }

  /**
   * The feed has caught up once, or `HOLD_MS` passed: every held note the feed
   * did not settle -- adopted, or kept beside another -- is published now. One
   * line, and always one when the limit ended it.
   */
  private release(reason: "caught_up" | "timeout"): void {
    const holding = this.holding;
    if (holding === null) return;
    this.holding = null;
    this.expected.clear();
    if (holding.handle !== null) this.timers.clear(holding.handle);
    let queued = 0;
    for (const path of holding.paths) {
      if (this.options.state.fileByPath(path) !== undefined) continue;
      this.enqueue(path);
      queued++;
    }
    if (holding.paths.size === 0 && reason !== "timeout") return;
    this.options.host.log(
      `reconcile decision=released reason=${reason} held=${holding.paths.size} settled=${holding.paths.size - queued} ` +
        `queued=${queued} all=${holding.all ? 1 : 0} budget_ms=${HOLD_MS} duration_ms=${this.nowFn() - holding.since}`,
    );
  }

  /**
   * The feed has caught up with the journal as it stood, so a rename whose
   * tombstone this device applied before it stopped has arrived by now if it
   * ever will. A retired root the start-up pass held (`survey`, issue #127)
   * that no record took, and that this vault still shows under that name, is
   * the other shape -- a DELETION that found the folder occupied -- and is
   * published again now, which ends its retirement (`docs/protocol.md`).
   */
  private async releaseRetired(context: SyncContext): Promise<void> {
    this.caughtUp = true;
    const held = [...this.retiredHeld];
    this.retiredHeld.clear();
    let published = 0;
    for (const folder of held) {
      if (context.state.data.retiredRoots[folder] === undefined || context.state.folderByPath(folder) !== undefined) continue;
      if ((await context.host.spelling(folder).catch(() => null)) !== folder) continue;
      this.publishFolder(folder, false, false);
      this.enqueue(folder);
      published++;
    }
    if (held.length > 0) {
      context.host.log(`feed path_class=folder decision=released reason=retired_root held=${held.length} published=${published}`);
    }
  }

  /**
   * One feed entry consumed -- applied, skipped, echoed or parked -- is the
   * new mark: a mark left behind a parked entry would find that entry in
   * `(mark, cursor]` at the next start and read the journal as a rebuilt one.
   * An echo of this device's own version also tells the record (or grave)
   * that version's server time, which places it against the mark after a
   * restore.
   */
  private processed(context: SyncContext, change: ChangeRecord, result: ApplyResult | null): void {
    const { state } = context;
    if (result === "echo") {
      const path = state.pathByFileId(change.file_id);
      const record = path === undefined ? undefined : state.fileByPath(path);
      if (record?.versionId === change.version_id) {
        record.ts = change.ts;
        // And the one chunk it is made of, for the repair walk (`FileRecord.sid`, #198).
        if (change.sids.length === 1) record.sid = change.sids[0];
      }
      const grave = state.data.graves[change.file_id];
      if (grave?.versionId === change.version_id) grave.ts = change.ts;
    }
    // What a replay passes as this device's own version of a file -- a live
    // one carries a chunk; a deletion, a folder or a pause none -- of what it
    // had read before, is its newest so far; anything later of that file
    // settles it, this start's own posts among them (`returnLost`, #239).
    const replay = state.data.replaying;
    if (replay !== null) {
      if (result === "echo" && change.sids.length > 0 && change.seq <= replay.through) replay.notes[change.file_id] = change.version_id;
      else delete replay.notes[change.file_id];
    }
    state.data.feedMark = { seq: change.seq, fileId: change.file_id, versionId: change.version_id, ts: change.ts, replay: false };
  }

  /**
   * NOTES THIS DEVICE WROTE AND HOLDS NOWHERE, brought back once a replay over
   * the vault it holds has caught up (issue #239; owner ruling 2026-09-29: a
   * record whose file is missing is never treated as held). A widening reads
   * the whole feed again, and this device's own versions come back to it as
   * echoes -- right for a note it holds, and a silent divergence for one it
   * does not: a note that left the selection before 1.1.5 remembered where
   * to, or whose new name was deleted, hidden or taken into a linked folder
   * while it was out -- and so for one the replay has just given back at an
   * older version of another device's, before passing over this device's own
   * newer one. Such a note's heads, read from the server now, are applied as
   * another device's version would be (`returning`), at the name every other
   * device keeps. One read per note, one line each, and none at all for a
   * note held at that version, one that left and is still out of the
   * selection, or one whose last version was a deletion.
   */
  private returnLost(context: SyncContext): Promise<void> {
    const lost = context.state.data.replaying;
    if (lost === null) return Promise.resolve();
    if (Object.keys(lost.notes).length === 0) {
      context.state.data.replaying = null;
      return Promise.resolve();
    }
    const held = (fileId: string): string | undefined => {
      const path = context.state.pathByFileId(fileId);
      return path === undefined ? undefined : context.state.fileByPath(path)?.versionId;
    };
    return this.exclusive(async () => {
      for (const [fileId, versionId] of Object.entries(lost.notes)) {
        // Stopped part way, what is left waits for the next start's catch-up (#281).
        if (!this.running) return;
        const before = held(fileId);
        if (before !== versionId && context.state.data.departed[fileId] === undefined) {
          const started = context.now();
          let outcome: string;
          this.returning.add(versionId);
          try {
            await this.reconcileFile(fileId);
            outcome = held(fileId) === before ? "not_applied" : "applied";
          } catch (error) {
            outcome = `failed_${error instanceof ApiError ? error.code : error instanceof Unwritable ? error.reason : "error"}`;
          } finally {
            this.returning.delete(versionId);
          }
          context.host.log(
            `feed path_class=file decision=downloaded_again reason=not_held outcome=${outcome} file=${fileId} ` +
              `budget_ms=${SCAN_BUDGET_MS} duration_ms=${context.now() - started}`,
          );
        }
        // And one whose read the stop cut short is asked for again then too.
        if (this.running) delete lost.notes[fileId];
      }
      context.state.data.replaying = null;
      await context.state.save();
    });
  }

  /**
   * Answer a restored server (issue #145): re-send what it lost, then --
   * when the restore is proved, or something had to be re-sent -- read the
   * journal again from zero, skipping what this device had already seen, so
   * what other devices wrote on the rebuilt server arrives even where it
   * reused seqs this device had read past. One notice per run that re-sent.
   */
  private recover(context: SyncContext, due: Suspicion): Promise<void> {
    // ONE PULL AT A TIME: the check re-sends and the rewind moves the cursor,
    // and neither may run beside a page or a parked record's retry.
    return this.exclusive(async () => {
      const live = (): boolean => this.running && this.contextValue === context;
      if (!live()) return;
      const resent = await recoverLost(context, due, this.judged, live);
      // Stopped part way, nothing is decided: the next start asks again.
      if (!live()) return;
      this.restoreDue = null;
      if (due.verdict === "restored" || resent > 0) {
        const mark = context.state.data.feedMark;
        if (mark !== null) context.state.data.feedMark = { ...mark, replay: true };
        context.state.data.lastSeq = 0;
      }
      await context.state.save();
      if (resent > 0) {
        context.host.notify(
          `obsync: The server was restored to an earlier state; this device re-sent ${resent} change${resent === 1 ? "" : "s"}.`,
        );
      }
    });
  }

  // --- reconciliation, the periodic scan and the heartbeat ---------------

  /**
   * Startup reconciliation over Obsidian's own listing: queue what differs
   * from the local record, pair the moves, and publish a tombstone for every
   * recorded path the vault no longer has. This is what makes an edit made
   * while Obsidian was closed, or a file deleted in Finder, reach the server.
   */
  reconcile(verifyUpTo = 0): Promise<void> {
    return this.track(this.reconcileLocal(verifyUpTo));
  }

  private async reconcileLocal(verifyUpTo: number): Promise<void> {
    const host = this.need().host;
    const recheck: VaultStat[] = [];
    await this.inPass(host, "reconcile", async () => this.survey(await host.list(), true, "reconcile", verifyUpTo, recheck));
    // SYNC NOW'S CONTENT CHECK AFTER THE LOCK: it only queues files the pass
    // found unchanged, and on a phone of 7,700 notes it held a page from
    // another device for minutes when it ran inside (#244, #246).
    if (recheck.length === 0) return;
    host.pass?.(true);
    try {
      for (const file of recheck) {
        if (!this.running) return;
        if (!(await host.syncable(file.path))) continue;
        this.enqueue(file.path);
        this.examined++;
      }
    } finally {
      host.pass?.(false);
    }
  }

  /**
   * `work` as one pass of the host's (`VaultHost.pass`), closed however it
   * ends -- AND UNDER THE PULL LOCK, ITS LISTING INCLUDED (issue #244). A pull
   * applying a rename leaves the vault and the records apart for a moment: a
   * phone reports the rename while the host's call still runs, which spends
   * its echo mark, and the records follow the entry only after the host's next
   * answers. A pass that compared inside that moment found the entry moved and
   * nothing recorded there, and published the move as this device's own (5 of
   * 20 folder re-cases on a loaded Android fake); a listing taken before a pull
   * and compared after it pairs the same move backwards. One at a time, a pass
   * never sees half of a pull, and a page waits for the comparison, which is
   * quick. A pass's wait is said.
   */
  private inPass(host: VaultHost, label: string, work: () => Promise<void>): Promise<void> {
    const asked = this.nowFn();
    return this.exclusive(async () => {
      if (!this.running) return;
      const waited = this.nowFn() - asked;
      if (waited > 0) host.log(`${label} decision=waited reason=pull_lock duration_ms=${waited} budget_ms=${SCAN_BUDGET_MS}`);
      host.pass?.(true);
      try {
        await work();
      } finally {
        host.pass?.(false);
      }
    });
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
    // The temp files writes left when this device last stopped in the middle
    // of them (issue #159), once per start. Under the pull lock, so no write
    // of this start is in the middle of one, and beside this scan rather than
    // in front of it; cleaning up is never a reason not to sync.
    if (!this.swept) {
      this.swept = true;
      void this.track(this.exclusive(async () => {
        await context.host.sweep?.().catch((error: unknown) =>
          context.host.log(`host path_class=temp decision=failed reason=sweep code=${(error as { code?: string }).code ?? "none"}`));
      }));
    }
    // A copy whose name no device settled is announced within one scan of
    // `COPY_SETTLE_MS`, even while the feed brings nothing (issue #164).
    announceCopies(context);
    try {
      // FIRST, so the listing below sees where they went: a note waiting
      // beside its name for one this device's own user has since freed
      // (issue #149).
      await settleBeside(context, context.state.data.lastSeq, "scan");
      // A HOST THAT WALKS ITS TREE WALKS IT EVERY `WALK_MS` -- counted in
      // passes, because that is what fires -- at a start, and when the window
      // came back (issue #198). The passes between compare nothing: the walk
      // is the listing that sees what the watcher did not, and Obsidian's
      // index offers a desktop pass nothing a walk minutes later does not,
      // while it names every note the walk leaves out, a nested vault's too.
      if (context.host.scan !== undefined) {
        if (this.walkFor === null && ++this.unwalked < Math.round(WALK_MS / SCAN_MS)) {
          this.sweepEchoes(context, "scan");
          return;
        }
        context.host.log(`scan decision=walk reason=${this.walkFor ?? "interval"} interval_ms=${WALK_MS}`);
        this.walkFor = null;
        this.unwalked = 0;
      }
      await this.inPass(context.host, "scan", async () => this.survey((await context.host.scan?.()) ?? await context.host.list(), false, "scan"));
    } catch (error) {
      context.host.log(
        `scan decision=failed reason=${errorText(error)} budget_ms=${SCAN_BUDGET_MS}`,
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
  private async survey(files: VaultStat[], tombstones: boolean, label: string, verifyUpTo = 0, verify: VaultStat[] = []): Promise<void> {
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
        // A RETIRED ROOT WAITS FOR THE FEED (issue #127). A device stopped
        // between a selected folder's tombstone and the record that renames
        // it published the folder again here, and that record, written, ended
        // the retirement: the rename then arrived as a second folder, was
        // refused with a notice blaming the other device, and the two devices
        // disagreed about the folder from then on. Held until the feed has
        // caught up (`releaseRetired`); a pass after that publishes it.
        if (!this.caughtUp && context.state.data.retiredRoots[folder] !== undefined) {
          this.retiredHeld.add(folder);
          context.host.log(`${label} path_class=folder decision=held reason=retired_root`);
          continue;
        }
        // A FOLDER THAT MERELY HAS NO RECORD HERE IS NOT ONE MADE HERE: a
        // tombstone that found it occupied may have kept it, and bringing it
        // back to the devices that deleted it is not this pass's to decide
        // (`push.ts`, `pushFolder`).
        this.publishFolder(folder, false, false);
        this.enqueue(folder);
        folderQueued++;
      }
    }
    // Sync now reads a recorded file's contents again only up to its ceiling
    // (`SYNC_NOW_VERIFY_MAX`, issue #197); what lies above is counted. The
    // caller queues `verify`, after the lock (`reconcileLocal`).
    let unread = 0;
    for (const file of files) {
      if (!this.running) return;
      if (!this.tracked(file.path, label)) { skipped++; continue; }
      seen.add(file.path);
      if (isPushed(context.state.fileByPath(file.path), file.mtime, file.size)) {
        if (verifyUpTo > 0 && file.size <= verifyUpTo) verify.push(file);
        else if (verifyUpTo > 0) unread++;
        continue;
      }
      fresh.push(file);
    }
    if (verifyUpTo > 0) {
      context.host.log(
        `${label} decision=verify files=${verify.length} over_ceiling=${unread} ` +
          `ceiling_bytes=${Number.isFinite(verifyUpTo) ? verifyUpTo : "none"}`,
      );
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

    // NOTES THAT LEFT THE SELECTION, WHERE IT COVERS THEM AGAIN (issue #239):
    // after a widening, or a start that finds one moved back while the app
    // was closed. Each is published as the move it is (`rejoin`), and one
    // whose name holds nothing this device may sync -- deleted, or taken into
    // a linked folder or a vault of its own while it was out -- is forgotten,
    // so the replay brings it back at the name the other devices keep
    // (`returnLost`). Before the pairing below, which must not take its file
    // for another note's move. One line each, with what it was measured
    // against.
    if (tombstones) {
      const listed = new Map(fresh.map((file) => [file.path, file]));
      for (const [fileId, away] of Object.entries(context.state.data.departed)) {
        if (!this.running) return;
        if (!inSyncScope(away.path, context.state.data.syncFolders)) continue;
        const started = context.now();
        const file = listed.get(away.path);
        const refused = file === undefined ? "destination_gone"
          : !(await context.host.syncable(file.path)) ? "destination_unsyncable"
          : this.rejoin(context, fileId, file.path, file.size);
        if (refused === null) settled.add(away.path);
        else if (context.state.data.departed[fileId] !== undefined) {
          delete context.state.data.departed[fileId];
          this.saveMoved(context);
        }
        context.host.log(
          `${label} path_class=file decision=${refused === null ? "published_move reason=left_selection" : `forgotten reason=${refused}`} ` +
            `file=${fileId} budget_ms=${SCAN_BUDGET_MS} duration_ms=${context.now() - started}`,
        );
      }
    }

    // Moves first: a paired destination must not also be queued as a new
    // file, and a paired source must not also be tombstoned. A path the
    // normalisation check settled is handled in exactly the same way.
    let moves = 0;
    let declined = 0;
    const freshByStat = byStat(fresh);
    for (const from of gone) {
      if (!this.running) return;
      const record = context.state.fileByPath(from);
      if (record === undefined || settled.has(from)) continue;
      const candidates = this.carriers(record, freshByStat, settled);
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
      candidates.push(from);
    }

    // BYTES STILL IN THE VAULT ARE NOT A DELETION (issue #139), in both
    // passes. A selected folder renamed while the app was closed leaves its
    // notes under a name the selection does not cover, which no listing of
    // the selection can show: the whole index is asked instead, and a note
    // found there LEFT the selection -- never a deletion, never a hold.
    // Asked only when something is gone, which is almost never.
    const missing: string[] = [];
    const left: [string, string | null][] = [];
    if (candidates.length > 0) {
      const index = byStat(await context.host.inventory());
      for (const from of candidates) {
        if (!this.running) return;
        // The moves are the pairing above's, which saw every file of the
        // selection; what is left to find here is outside it.
        const outcome = await this.follow(context, from, index, settled);
        if (outcome === null) missing.push(from);
        else if (outcome !== "moved") left.push([from, outcome.to]);
      }
      for (const [from, to] of left) this.leftScope(from, to);
    }

    // A BULK DELETION IS A QUESTION, NOT AN INSTRUCTION (issue #123). What
    // is still missing here has no bytes anywhere in the index -- a folder
    // moved out of the vault, a volume that mounted empty, an index not yet
    // built -- and when that is most of what this device tracks, nothing
    // asked for a deletion: this device has stopped being able to see its
    // own files. Published, those tombstones delete the notes on every other
    // device.
    //
    // So the pass holds them, says what it found, and publishes nothing until
    // the user says which it was. `confirmHeldDeletions` is the other half:
    // a folder the user really did delete still reaches every device, one
    // click later. The rule is deliberately about SHARE and not about
    // folders -- a move of the vault root and a volume that mounted empty
    // arrive here identically, and the share is what they have in common.
    //
    // WHAT THIS DEVICE TRACKS IS WHAT ITS SELECTION COVERS (issue #172).
    // Narrowing the selection keeps the records outside it, and counted,
    // they diluted the share: twelve of twenty selected notes gone was
    // measured as twelve of twenty-nine, and published.
    //
    // ONLY THE USER MAY PUBLISH THE HOLD, and only this pass may take one.
    // The periodic scan never tombstones, so letting it fall into the
    // publishing branch below would clear a hold the startup pass took,
    // thirty seconds later and with nobody asked. And a hold still pending is
    // the user's question, not this pass's: re-derived from scratch, a Sync
    // now after a partial fix fell under half and published what the user
    // was still being asked about (issue #172). So a pass holds what is still
    // missing, and all either pass may do is stop OFFERING a note that is no
    // longer missing -- back, moved, or out of the selection -- which
    // publishes nothing and takes nothing from the user's decision but a note
    // that was never gone (issue #139).
    let removed = 0;
    const scope = context.state.data.syncFolders;
    const tracked = Object.keys(context.state.data.files).filter((path) => inSyncScope(path, scope)).length;
    //
    // AND THE HOLD OUTLIVES A RESTART (issue #162): it is persisted, so the
    // first pass after one finds the user's question still open, holds what
    // is still missing and asks again -- where a hold forgotten there was
    // re-derived by share alone, and twenty notes deleted from a vault of a
    // thousand were published by the next start.
    const still = new Set(missing);
    const held = context.state.data.heldDeletions;
    const kept = held.filter((path) => still.has(path));
    if (kept.length < held.length) {
      context.host.log(
        `${label} decision=released reason=bulk_deletion released=${held.length - kept.length} held=${kept.length}`,
      );
      this.hold(kept);
    }
    if (tombstones && (kept.length > 0 || (missing.length >= BULK_DELETION_MIN && missing.length * 2 > tracked))) {
      this.hold(missing);
      context.host.log(
        `${label} decision=refused reason=bulk_deletion candidates=${missing.length} tracked=${tracked} pending=${kept.length}`,
      );
      if (!this.bulkNoticeShown) {
        this.bulkNoticeShown = true;
        context.host.notify(
          kept.length > 0
            ? `obsync is still holding back ${missing.length} deletions${within(missing)} from your other devices. ` +
                "Delete them there too?"
            : `obsync stopped ${missing.length} deletions it was about to send to your other devices: ` +
              `it can no longer see ${missing.length} of the ${tracked} notes it syncs here, and nothing ` +
              "asked for them to be deleted. A folder renamed or moved outside Obsidian looks exactly like " +
              "this. Put it back, or select it under its new name in Sync folders -- or, if you really did " +
              "delete them, confirm it under Settings, obsync, \"Deletions held back\".",
          HELD_ACTIONS,
        );
      }
    } else if (tombstones) {
      if (held.length > 0) this.hold([]);
      this.bulkNoticeShown = false;
      for (const from of missing) {
        this.deletions.add(from);
        this.enqueue(from);
        removed++;
      }
    }

    // A FILE THIS DEVICE ALREADY PUBLISHED IS NOT A NEW FILE (issue #181).
    // A record can be lost with its version live -- a session's late save
    // over its successor's, a force-quit between the post and the save -- and
    // published again it took a NEW file id, whose twin the identical-name
    // rule then retired with a deletion. So the name is asked of this
    // device's own newest live version first, and a file that is still
    // exactly what this device published is recorded as that version again.
    // "Exactly" is `isPushed`, the one definition this pass already trusts
    // for every tracked file, against the stat this device's own manifest
    // carries.
    const untracked = fresh.filter((file) => !settled.has(file.path) && context.state.fileByPath(file.path) === undefined);
    // THE EMPTY FILE OF A DOWNLOAD THIS DEVICE NEVER FINISHED (issue #248).
    // Android can land a download's write empty (#242), and the mark that
    // keeps that file unsent reaches the data file with the next save: a phone
    // stopped between the two starts with the empty file and no mark, and sent
    // it -- an existing note emptied on every device, or a new empty one.
    // What tells it from a note a person emptied here is the feed: that
    // download is still ahead of this device's cursor, a live version at the
    // very path that the record does not hold. Such a file is marked again, as
    // it was, and the feed writes the version over it (`droppedWrite`,
    // pull.ts). A note emptied here has no such version ahead -- the person
    // emptied what this device held -- and is sent as ever; where both
    // happened before this device could send, the other version's text wins
    // and nothing is lost. A walk that fails holds an emptied note this device
    // records the same way: never sent empty on no evidence.
    const emptied = tombstones ? fresh.filter((file) => file.size === 0 && !settled.has(file.path)) : [];
    const walked = !this.ownRead;
    const own = tombstones ? await this.ownNotes(context, untracked.length + emptied.length) : null;
    const blind = walked && this.ownRead && own === null;
    let unfinished = 0;
    for (const file of emptied) {
      const record = context.state.fileByPath(file.path);
      const note = own?.notes.get(file.path);
      const ahead = note !== undefined && note.version_id !== record?.versionId;
      const mark = ahead ? note.file_id : blind ? record?.fileId : undefined;
      if (mark === undefined) continue;
      context.state.data.dropped[file.path] = mark;
      settled.add(file.path);
      unfinished++;
    }
    if (unfinished > 0) {
      context.host.log(
        `${label} decision=held reason=unfinished_download files=${unfinished} unverified=${blind ? unfinished : 0} ` +
          `budget_ms=${SCAN_BUDGET_MS} duration_ms=${context.now() - started}`,
      );
      void this.track(context.state.save()).catch(() => {
        this.stop();
        context.host.log(`${label} decision=failed reason=state_not_saved`);
      });
    }
    if (own !== null && context.state.data.replaying !== null) {
      const open = untracked.filter((file) => !settled.has(file.path));
      await this.rejoinUnseen(context, own.notes, open, seen, settled, label);
    }
    let queued = 0;
    let adopted = 0;
    let heldBack = 0;
    for (const file of fresh) {
      if (!this.running) return;
      if (settled.has(file.path)) continue;
      if (!(await context.host.syncable(file.path))) { skipped++; continue; }
      const note = own?.notes.get(file.path);
      if (note !== undefined && note.device_id === context.deviceId && context.state.pathByFileId(note.file_id) === undefined) {
        const record = { fileId: note.file_id, versionId: note.version_id, mtime: note.mtime, size: note.size, sha256: await sidDigest(note.sids) };
        if (isPushed(record, file.mtime, file.size)) {
          context.state.setFile(file.path, record);
          context.host.log(`${label} path_class=file decision=adopted reason=own_version file=${note.file_id}`);
          adopted++;
          continue;
        }
      }
      // ANOTHER DEVICE'S NOTE AT THIS NAME, NOT YET APPLIED HERE (issue #194):
      // a vault copied over from another sync tool, or a note a crash left
      // unrecorded inside a page. Published now, it took a new file id that
      // the feed's same-name rule retired again a moment later. It waits
      // instead, and the feed adopts it by digest or settles the name by the
      // rule; a note no other device named goes out at once.
      if (this.holding !== null && context.state.fileByPath(file.path) === undefined &&
        (this.holding.all || (note !== undefined && note.device_id !== context.deviceId))) {
        if (note !== undefined) this.expected.set(note.file_id, { path: file.path, behind: note.behind });
        if (!this.holding.paths.has(file.path)) heldBack++;
        this.holdBack(file.path);
        continue;
      }
      this.enqueue(file.path);
      queued++;
    }
    if (verifyUpTo > 0) this.examined += queued;
    if (own !== null) {
      context.host.log(
        `${label} decision=held since=${own.since} untracked=${untracked.length} adopted=${adopted} ` +
          `budget_ms=${SCAN_BUDGET_MS} duration_ms=${context.now() - own.started}`,
      );
    }
    if (heldBack > 0) {
      context.host.log(`${label} decision=holding reason=${this.holding?.all === true ? "feed_unread" : "feed_names"} ` +
        `held=${heldBack} budget_ms=${HOLD_MS}`);
    }
    // AND THE TOMBSTONE HALF LAST, after the file work: a folder record is
    // retired once the notes under it have published their own tombstones, so
    // the receiver's folder is empty by the time it is asked to remove it. In
    // a pass where notes LEFT the selection, the folders that went left with
    // them (`settleVanished`).
    if (tombstones) {
      // A REMOVAL THIS DEVICE STILL OWES (issue #265) is judged here again,
      // against the selection it was judged in. A folder that stands again,
      // or a record already retired, owes nothing.
      const owed = context.state.data.folderRemovals;
      for (const path of Object.keys(owed)) {
        if (present.has(path) || context.state.folderByPath(path) === undefined) this.settleRemoval(path);
      }
      for (const folder of Object.keys(context.state.data.folders)) {
        // A folder whose notes' deletions are held waits with them, as it
        // does in the watcher's burst (`heldFolders`): the person may yet put
        // them back (issues #162, #219).
        if (context.state.data.heldDeletions.some((path) => path.startsWith(`${folder}/`))) continue;
        if (!this.running) return;
        if (present.has(folder) || casedFolders.has(folder)) continue;
        const judged = owed[folder] ?? undefined;
        if (!this.trackedFolder(folder, "reconcile_folder_state", judged)) {
          folderSkipped++;
          this.settleRemoval(folder);
          continue;
        }
        if (left.length > 0) { this.folderLeftScope(folder, context.state.data.syncFolders); continue; }
        this.oweRemoval(folder, judged);
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
          `not_paired=${declined} left=${left.length}`,
      );
    }
    // LAST, because this pass's own pairings consume marks (`renamed`).
    this.sweepEchoes(context, label);
  }

  /**
   * A NOTE THAT LEFT THE SELECTION UNSEEN (issue #239): moved out of it before
   * this device remembered where to (1.1.4 and older), or by a move nothing
   * here saw. A replay over the vault this device holds finds its own newest
   * version of such a note at a name in the selection that holds nothing
   * here; when exactly one file of the selection, recorded nowhere and at no
   * note's name, IS that version, chunk for chunk (`sameChunks`), and is that
   * version for no other note, that file is the note, moved -- published as
   * the move (`rejoin`). Anything short of that proof leaves the note to be
   * brought back where it was (`returnLost`): two copies, nothing lost.
   * Cost: one read of a file only where its size is such a note's.
   */
  private async rejoinUnseen(
    context: SyncContext,
    notes: Map<string, HeldNote>,
    files: VaultStat[],
    seen: Set<string>,
    settled: Set<string>,
    label: string,
  ): Promise<void> {
    const started = context.now();
    const bySize = new Map<number, HeldNote[]>();
    for (const note of notes.values()) {
      // Missing is what the listing of the selection says, so only a name in it can be.
      if (note.device_id !== context.deviceId || !inSyncScope(note.path, context.state.data.syncFolders) || seen.has(note.path) ||
        context.state.pathByFileId(note.file_id) !== undefined || context.state.data.departed[note.file_id] !== undefined) continue;
      bySize.set(note.size, [...(bySize.get(note.size) ?? []), note]);
    }
    const found = new Map<HeldNote, VaultStat[]>();
    const claimed = new Map<string, number>();
    for (const file of files) {
      if (!this.running) return;
      // Asked of the host only where a size matches: a linked folder or a
      // vault of its own is never published from (`syncable`).
      if (notes.has(file.path) || !bySize.has(file.size) || !(await context.host.syncable(file.path))) continue;
      for (const note of bySize.get(file.size) ?? []) {
        if ((await sameChunks(context, note.sids, file.path, file, file.size)) === null) continue;
        found.set(note, [...(found.get(note) ?? []), file]);
        claimed.set(file.path, (claimed.get(file.path) ?? 0) + 1);
      }
    }
    for (const [note, [file, ...more]] of found) {
      if (file === undefined || more.length > 0 || claimed.get(file.path) !== 1) continue;
      context.state.data.departed[note.file_id] = { path: file.path, versionId: note.version_id, size: file.size };
      const refused = this.rejoin(context, note.file_id, file.path, file.size);
      if (refused === null) settled.add(file.path);
      context.host.log(
        `${label} path_class=file decision=${refused === null ? "published_move reason=identical" : `forgotten reason=${refused}`} ` +
          `file=${note.file_id} budget_ms=${SCAN_BUDGET_MS} duration_ms=${context.now() - started}`,
      );
    }
  }

  /**
   * The newest live notes the feed carries past this device's cursor, by name
   * (issue #181): ONE walk of the feed per start, from this device's cursor --
   * a version whose record was lost was posted after the cursor that was
   * saved with it -- and only when some name has no record. This device's own
   * are adopted again; another device's hold that name back for the feed
   * (issue #194). The reader is pairing's (`heldNotes`). A walk that fails
   * leaves those files to be published as they always were, which costs a
   * duplicate id, never a note: a retirement never deletes what its keeper
   * holds (`pull.ts`, `retiredInto`).
   */
  private async ownNotes(
    context: SyncContext,
    untracked: number,
  ): Promise<{ notes: Map<string, HeldNote>; since: number; started: number } | null> {
    if (untracked === 0 || this.ownRead) return null;
    this.ownRead = true;
    const started = context.now();
    const since = context.state.data.lastSeq;
    try {
      return { notes: await heldNotes(context.transport, context.manifestKey, since), since, started };
    } catch (error) {
      context.host.log(
        `reconcile decision=held_failed reason=${error instanceof ApiError ? error.code : "error"} since=${since} ` +
          `untracked=${untracked} budget_ms=${SCAN_BUDGET_MS} duration_ms=${context.now() - started}`,
      );
      // An empty state is a vault this server has never seen from here: with
      // no feed to say which of its notes the server already has, every one
      // of them waits for it (`holding`, issue #194).
      if (this.emptyStart && this.holding !== null) this.holding.all = true;
      return null;
    }
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
      this.oweRemoval(from, context.state.data.syncFolders);
      this.settleRemoval(to);
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
    // And what the rewrite storm is judged by (issue #179): an arrival once
    // nothing can answer it any more, and a verdict one pass after its edit,
    // so neither grows with the vault for as long as the plugin runs.
    const now = context.now();
    for (const [path, at] of context.arrivals) if (now - at >= ANSWER_MS) context.arrivals.delete(path);
    for (const [fileId, verdict] of context.answering) if (now - verdict.mtime >= SCAN_MS) context.answering.delete(fileId);
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
    // THE NOTICE IS ABOUT A FOLDER, and is given only for one (issue #165). A
    // ghost whose difference is the note's own name is a folder of nothing: a
    // record the note's capitals rename left behind, whose forgetting is the
    // whole of the repair and which the user cannot act on.
    if (!this.caseGhostNoticeShown && folderOf(path) !== folderOf(to)) {
      this.caseGhostNoticeShown = true;
      context.host.notify(
        "obsync: this device holds records for one folder under two capitalisations, and the notes under the " +
          "spelling it no longer shows are already tracked under the one it does. It has stopped tracking the " +
          "old spelling and deleted nothing. If another device shows TWO folders whose names differ only in " +
          "capitalisation, delete the stale one there only once every device runs obsync 1.1.0 or later and " +
          "has synced once since updating -- see Troubleshooting, \"Two folders that differ only in capitalisation\".",
      );
    }
    return true;
  }

  /**
   * Everything the user's "Sync now" command does (issue #197), in order:
   * what is queued here goes; one read of the feed, asked at once, brings
   * what waits on the server (`readFeed`); parked records and paused notes
   * are tried again; and the reconcile pass finds what the watcher missed,
   * reading again the contents of every file of at most
   * `SYNC_NOW_VERIFY_MAX` bytes -- a plugin's rewrite that kept both a note's
   * size and its date (#179). What that pass queues goes too.
   *
   * It resolves only once the queue it was asked to flush is empty. Joining
   * the running drain is not enough on its own: a path queued after that
   * drain took its last batch joins the very drain that will never look at
   * the queue again, so one more drain follows. That second drain is a no-op
   * when nothing is left, which is why one is enough.
   */
  async syncNow(): Promise<number> {
    return (await this.press("sync_now", SYNC_NOW_VERIFY_MAX)).sent;
  }

  /** "Verify all files" (#197): Sync now, reading every file's contents however large. */
  verifyAll(): Promise<{ checked: number; sent: number }> {
    return this.press("verify_all", Number.POSITIVE_INFINITY);
  }

  private async press(trigger: string, verifyUpTo: number): Promise<{ checked: number; sent: number }> {
    const started = this.nowFn();
    const joined = this.draining;
    const queued = this.queue.length;
    const inFlight = this.active;
    const written = this.written;
    const examined = this.examined;
    const held = (): number => this.options.state.data.heldDeletions.length;
    const pending = held() > 0;
    let followUp = await this.flush();
    await this.readFeed();
    await this.retryParked(trigger);
    // A paused note before the pass, so what it holds is in it (issue #179).
    await this.resume(undefined, trigger);
    await this.reconcile(verifyUpTo);
    // The command that "syncs everything" did not send the deletions the user
    // is still being asked about, and says so rather than nothing (#172).
    if (pending && held() > 0) {
      this.options.host.notify(
        `obsync is still holding back ${held()} deletions: Sync now does not send them. Put ` +
          "the notes back, or, if you really deleted them, confirm it under Settings, obsync, \"Deletions held back\".",
        HELD_ACTIONS,
      );
    }
    followUp = (await this.flush()) || followUp;
    this.options.host.log(
      `${trigger} decision=${joined ? "joined_running_drain" : "drained"} queued=${queued} ` +
        `in_flight=${inFlight} follow_up=${followUp ? 1 : 0} examined=${this.examined - examined} ` +
        `duration_ms=${this.nowFn() - started}`,
    );
    await this.repairTick();
    // What this press sent, for the one notice it answers with (`main.ts`,
    // #182): versions the server took, not paths looked at -- the press
    // re-reads many notes, and most are unchanged.
    return { checked: this.examined - examined, sent: this.written - written };
  }

  /** Drain, and once more when a path was queued after the joined drain took its last batch. */
  private async flush(): Promise<boolean> {
    await this.drain();
    const again = this.queue.length > 0 || this.draining;
    if (again) await this.drain();
    return again;
  }

  /**
   * One read of the feed, sent at once and applied, for Sync now (issue #197).
   * The feed has ONE reader, its loop, so this asks the loop for its next read
   * instead of reading beside it -- two readers from one cursor would apply
   * the same records twice. The long poll in flight is dropped (`wake`), and
   * whatever it brings later is discarded unread, as every dropped poll's is.
   * Answered once a read sent after the ask is applied, or fails, or a stop
   * (`answerFeed`) -- or after `SYNC_NOW_FEED_MS`, when the press goes on and
   * the read goes on without it. A read already in flight that asks without
   * waiting -- a start's first, one after a failure -- is the read this would
   * send, and brings what it brings without the press waiting on it.
   */
  private readFeed(): Promise<void> {
    if (!this.running || this.reading) return Promise.resolve();
    return new Promise<void>((answer) => {
      const budget = this.timers.set(() => {
        this.options.host.log(`sync_now decision=feed_unanswered budget_ms=${SYNC_NOW_FEED_MS}`);
        answer();
      }, SYNC_NOW_FEED_MS);
      this.feedAsks.push({ after: this.feedReads, answer: () => { this.timers.clear(budget); answer(); } });
      this.wake("sync_now");
    });
  }

  /** Answer every `readFeed` ask made before read number `through` was sent. */
  private answerFeed(through: number): void {
    while (this.feedAsks.length > 0 && (this.feedAsks[0] as { after: number }).after < through) this.feedAsks.shift()?.answer();
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
      if (result.kind === "idle") {
        // A walk ended (issue #198): the next one is hours away, and the sids it
        // learned are saved with the next state write.
        delay = REPAIR_WALK_MS;
        const walk = repair.walk;
        host.log(
          `repair decision=walked batched=${walk.batched} requests=${walk.requests} missing=${walk.missing} ` +
            `learned=${walk.learned} next_ms=${REPAIR_WALK_MS} duration_ms=${this.nowFn() - walk.started}`,
        );
        if (walk.learned > 0) this.defer();
      }
      if (result.kind === "repaired") host.log(`repair decision=verified bytes=${result.bytes} ${budget()}`);
      else if (result.kind === "lost") {
        // NOT A READ OR WRITE FAILURE (issue #145): the server does not hold
        // the version this device recorded. The feed loop decides what that
        // is -- a version too young to have been collected is a restore --
        // before it applies anything else.
        const verdict = young(this.nowFn(), result.ts) ? "restored" : "suspected";
        host.log(`repair decision=lost reason=unknown_version verdict=${verdict} file=${result.fileId} ${budget()}`);
        if (!this.judged.has(result.fileId)) this.restoreDue ??= { verdict, reason: "repair" };
      } else if (result.kind !== "unresolved") host.log(`repair decision=${result.kind} ${budget()}`);
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
        // EACH CAUSE ITS OWN WORDS (#160). A server that is simply not there is
        // absence, which the status bar already reads from the first unanswered
        // attempt; a refusal about this device -- its clock, a full server,
        // something in front of the server, a revoked device -- is the same
        // refusal the feed or a push would name. Only a file that could not be
        // read here, or a copy that did not check out, is a repair failure, and
        // it no longer sends a person to their network.
        const refused = busy ? null : refusalStatus(error);
        const reason = busy ? "busy" : refused?.kind === "offline" ? "unreachable" : refused?.kind === "error" ? refused.code : "read_or_write_failed";
        host.log(`repair decision=deferred reason=${reason} ${budget()}`);
        if (!busy) {
          this.report(refused ?? { kind: "error", message: VERIFY_FAILED });
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
    } catch (error) {
      context.host.log(`heartbeat decision=${stopped(error) ? "cancelled" : "failed"} reason=${errorText(error)}`);
    }
    this.unnamed.clear();
    await this.readNames(context, "heartbeat");
    if (this.running) {
      this.heartbeatHandle = this.timers.set(() => {
        void this.track(this.heartbeat());
      }, HEARTBEAT_MS);
    }
  }

  /** Read the names again now: this device just paired another, or renamed one (issue #164). */
  async refreshDeviceNames(): Promise<void> {
    const context = this.contextValue;
    if (this.running && context !== null) await this.readNames(context, "requested");
  }

  /**
   * Name every device a page speaks for BEFORE applying it (issue #164).
   * Names were read at start and hourly, so a device paired since was
   * "another device" for up to an hour, in copies that keep that name for
   * good. An id no read has named yet costs ONE read; an id still unnamed
   * after it -- a device deleted since -- is remembered and falls back, so a
   * page never costs more than one request. A page from other devices also
   * re-reads names older than `NAMES_TTL_MS`, which is how a rename made
   * elsewhere arrives.
   */
  private async learnNames(context: SyncContext, changes: ChangeRecord[]): Promise<void> {
    const others = changes.filter((change) => change.device_id !== context.deviceId);
    if (others.length === 0) return;
    const unknown = others.some((change) => !context.deviceNames.has(change.device_id) && !this.unnamed.has(change.device_id));
    if (!unknown && this.nowFn() - this.namesReadAt < NAMES_TTL_MS) return;
    await this.readNames(context, unknown ? "unknown_device" : "stale");
    for (const change of others) if (!context.deviceNames.has(change.device_id)) this.unnamed.add(change.device_id);
  }

  /** The one place device names are read; a failed read keeps the names it had. */
  private async readNames(context: SyncContext, reason: string): Promise<void> {
    const started = this.nowFn();
    let devices: { device_id: string; name: string }[];
    try {
      // Ended by the stop like every request a start makes (#157).
      ({ devices } = await context.transport.devices({ signal: context.signal }));
    } catch (error) {
      context.host.log(
        `devices decision=${stopped(error) ? "cancelled" : "failed"} reason=${reason} error=${error instanceof ApiError ? error.code : "local_or_lost"} duration_ms=${this.nowFn() - started}`,
      );
      return;
    }
    context.deviceNames.clear();
    for (const device of devices) context.deviceNames.set(device.device_id, device.name);
    this.namesReadAt = this.nowFn();
    context.host.log(`devices decision=read reason=${reason} devices=${devices.length} duration_ms=${this.nowFn() - started}`);
    await this.settleOwnName(context, devices).catch((error: unknown) =>
      context.host.log(`device decision=failed reason=own_name error=${error instanceof ApiError ? error.code : "local_or_lost"}`));
  }

  /**
   * This device's own row (issue #152). Before 1.1.4 every desktop enrolled
   * as its bare platform, "macos", and showed "macos-xxxx" only to itself; a
   * device that never chose a name gives the server the one it shows here,
   * once. Any other difference is a rename made on another device, and this
   * device takes it as its own, so it has one name everywhere.
   */
  private async settleOwnName(context: SyncContext, devices: { device_id: string; name: string }[]): Promise<void> {
    const own = devices.find((device) => device.device_id === context.deviceId);
    const shown = context.host.deviceName;
    if (own === undefined || own.name === shown) return;
    const { platform } = context.host;
    const legacy = context.state.data.deviceName === null &&
      (own.name === platform || own.name === `${platform}-${context.deviceId.slice(0, 4)}`);
    if (!legacy) {
      context.state.data.deviceName = own.name;
      await context.state.save();
      context.host.log("device decision=adopted reason=renamed_elsewhere");
      return;
    }
    // The default's tag is kept before the server is told the name it ends.
    await context.state.save();
    const sent = await context.transport.patchDevice(context.deviceId, { name: shown });
    if (sent.outcome === "ok") context.deviceNames.set(context.deviceId, shown);
    context.host.log(`device decision=${sent.outcome === "ok" ? "renamed" : "unconfirmed"} reason=legacy_default`);
  }
}
