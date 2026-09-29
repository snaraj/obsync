/**
 * The obsync Obsidian plugin: lifecycle, commands, the vault host, and the
 * update notice.
 *
 * This is the ONLY module that imports Obsidian's runtime API (`ui/` aside),
 * which is what lets the crypto, chunker, transport and sync modules be
 * tested under `node --test` against fakes. Everything Obsidian-shaped is
 * funnelled through `ObsidianHost`, the `VaultHost` implementation below.
 *
 * PLATFORM BEHAVIOUR, stated per AGENTS.md requirement 14:
 *
 * | Behaviour        | Desktop (Electron)                          | Mobile (iOS, iPadOS, Android)          |
 * | ---------------- | ------------------------------------------- | -------------------------------------- |
 * | File read        | streamed in 8 MiB windows through Node `fs`  | whole file via `adapter.readBinary`    |
 * | File write       | temp file + `rename` (atomic), mtime restored| `adapter.writeBinary` with `mtime`     |
 * | Upload/download  | 4 concurrent chunks                          | 2 concurrent chunks                    |
 * | Per-file ceiling | unlimited                                    | 512 MiB, then remote-only              |
 * | Total budget     | unlimited                                    | 50 GiB, then remote-only               |
 * | Transport        | `requestUrl`, HTTP or HTTPS                  | `requestUrl`, HTTPS only               |
 * | Crypto           | WebCrypto                                    | WebCrypto                              |
 *
 * A device with no Node filesystem (mobile, or a desktop adapter that does
 * not expose a base path) takes the adapter path automatically; there is no
 * setting for it.
 *
 * PATH CONFINEMENT, in four layers (`vaultPath.ts`). Every method here puts
 * its path through the string rule; the desktop branch then proves the
 * resolved absolute target is strictly below the vault root; before any
 * `open`, `mkdir`, `rename` or `unlink` it stats every component from the
 * root down without following links, so a symlinked folder inside the vault
 * cannot carry a write outside it; and it RE-CHECKS that chain by device and
 * inode after the syscall, because the walk approved names and a name can be
 * made to mean a different directory a syscall later. The temp file is
 * opened exclusive-create and its descriptor is compared with the name
 * before the first byte and again after the rename. A symlinked folder is
 * not synced at all in v0.1, in either direction.
 *
 * WHAT THAT DOES AND DOES NOT COVER. Node has no `openat`, so every syscall
 * re-resolves a pathname and the plugin cannot hold a directory open and
 * work through it. Binding the chain across the open and across the rename
 * closes the window between the walk and each syscall — the case the third
 * review found, where the parent was swapped for a link to somewhere else
 * between them. The instant between a binding and the syscall it guards
 * cannot be closed by construction; an attacker already running on the
 * device who can win that race is outside the threat model, where
 * protecting a device against its own operating system is a stated non-goal
 * (`docs/threat-model.md`).
 *
 * UPDATES ARE NEVER INSTALLED FROM THE SERVER (`docs/architecture.md` 6.3).
 * The plugin compares versions and tells the user; the trusted source of
 * plugin code is the GitHub Release. Nothing here writes plugin code into
 * the vault's config folder.
 */

import { ItemView, MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import type { App, CliData, CliFlag, CliFlags, CliHandler } from "obsidian";
import { Bytes, deriveDomainKey, deriveManifestKey, hex, randomBytes, sha256, unhex } from "./crypto";
import { accountRecovery, FORGOTTEN_DEVICE, RECOVERY_MISMATCH } from "./accountRecovery";
import { domainMapKeys, loadDomainMap, soleDomain } from "./domainmap";
import { ByteSource, CHUNK_MAX } from "./chunker";
import { Clock, pageTimers, workerClock } from "./clock";
import { KEYS_LOST, State, StateStorageError, dataLease, isPushed, type Held, type ObsyncData } from "./state";
import { HELD, LEVELS, MERGES, NOTICE_DEFAULTS, NoticeChannel, scrub, titles, type Drawn, type NoticeSettings, type SyncNotice } from "./notices";
import {
  assertFolderCaseScope,
  assertFolderScope,
  assertSyncPath,
  expandsSyncScope,
  inFolderScope,
  inSyncScope,
  inSyncTree,
  parseSyncFolders,
} from "./syncScope";
import { ApiError, DeviceRecord, INTERACTIVE_MS, NOT_OBSYNC, Patience, Sent, SessionEnded, Transport, isNewer, lostMessage } from "./transport";
import { AFTER_START, EngineStatus, MoveResult, NOT_ANSWERING, NoticeAction, SyncContext, SyncEngine, Timers, TrashResult, VaultHost, VaultStat, VaultWriter, refusalStatus } from "./sync/engine";
import { EDITING_WINDOW_MS, EditorBusy, fetchRemoteOnly, heldNotes } from "./sync/pull";
import { CopyPublicationError, HistoryBrowser, HistoryEntry, HistoryOperation, restoreCopy } from "./sync/history";
import { newDeviceTag, newVaultKey, PAIRING_ACTION, PAIRING_WINDOW_MS, pastedToken, platformLabel, readClaim, refusalFor, refusalText } from "./pairing";
import { COPIED_VAULT, ObsyncSettingTab, SETUP_GUIDE_URL, normalizeServerUrl, serverUrlRefusal } from "./ui/settings";
import {
  LeaveServerModal, PairClaimModal, PairCreateModal, RecentModal, RecoveryPhraseModal, RemoteOnlyModal, StatusModal, Waiting, alreadyPaired, awaitApproval,
} from "./ui/modals";
import { HistoryModal } from "./ui/history";
import { Indicator, indicated } from "./ui/indicator";
import {
  ChainLink,
  FinalComponent,
  PathResolver,
  PathStat,
  PathWalker,
  VaultPathError,
  WalkResult,
  assertVaultPath,
  caseOnly,
  chainRefusal,
  errorText,
  isVaultPath,
  osJunk,
  sameFile,
  vaultTarget,
  vaultPathRefusal,
  walkVaultPath,
} from "./vaultPath";

/**
 * How deep the filesystem scan walks before it stops and says so.
 *
 * Symlinks are skipped, so there is no loop to fall into; this is a bound on
 * an absurd tree rather than a defence, and a vault nested deeper than this
 * is past what any Obsidian platform handles.
 */
const SCAN_MAX_DEPTH = 32;

/**
 * The names this plugin's writers give their temp files: a download's
 * (`desktopWriter`) and a restored copy's (`createWriter`). Not a hold's --
 * a hold may be the last name of a save (`hold`).
 */
const WRITE_TEMP = /^\.obsync-(?:write|restore)-[0-9a-f]+\.tmp$/;

/**
 * What `link` answers on a volume that has no hard links (issue #176):
 * FAT32 and exFAT say `ENOTSUP` on macOS and `EPERM` on Linux, and Windows
 * reports them as `EISDIR` or `ENOTSUP`; a FUSE or overlay filesystem can say
 * `ENOSYS`, `EOPNOTSUPP` or `EXDEV`. Each of these is answered by an
 * exclusive create, which refuses an occupied name as `link` does. `EEXIST`
 * is not among them: it is the name being taken, the refusal `link` is for.
 */
const LINK_UNSUPPORTED = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "EISDIR", "ENOSYS", "EXDEV"]);

/** The words on a notice's buttons (`VaultHost.notify`). */
const NOTICE_BUTTONS: Record<NoticeAction["kind"], string> = {
  delete_everywhere: "Delete everywhere",
  restore_here: "Restore here",
  fetch: "Fetch",
};

/**
 * One of Obsidian's toasts, for the notice channel (`notices.ts`): its words,
 * one button per action (issues #161, #162) that answers and takes the toast
 * away, and what a click anywhere on it opens. The same decision stays
 * reachable after a toast is dismissed -- Settings, "Deletions held back",
 * Show remote-only files, and Recent in Show sync status -- so a dismissed
 * toast loses nothing. Only a toast without buttons changes its words
 * (`NoticeChannel.show`): `setMessage` empties the element they live in.
 */
function toast(plugin: ObsyncPlugin, text: string, ms: number, actions: readonly NoticeAction[], open?: () => void): Drawn {
  const notice = new Notice(text, ms);
  let hidden = false;
  for (const action of actions) {
    const button = notice.messageEl.createEl("button", { text: NOTICE_BUTTONS[action.kind] });
    button.addEventListener("click", () => {
      notice.hide();
      plugin.act(action);
    });
  }
  if (open !== undefined) notice.containerEl.addEventListener("click", open);
  return {
    update: (words) => {
      notice.setMessage(words);
    },
    hide: () => {
      hidden = true;
      notice.hide();
    },
    // Obsidian takes a toast out of the page when its time is up or it is clicked.
    shown: () => !hidden && notice.containerEl.isConnected,
  };
}

/** The notice channel on Obsidian's screen, for one plugin instance. */
export function noticeChannel(plugin: ObsyncPlugin): NoticeChannel {
  return new NoticeChannel({
    draw: (text, ms, actions, open) => toast(plugin, text, ms, actions, open),
    settings: () => plugin.state?.data.notices ?? NOTICE_DEFAULTS,
    now: () => Date.now(),
    log: (line) => plugin.log(line),
    showStatus: () => plugin.showStatus(),
  });
}

/**
 * A command-line request obsync refuses: one sentence for a person, and the
 * stable code `format=json` prints beside it (`docs/architecture.md` 6.4).
 */
class CliRefusal extends Error {
  constructor(readonly code: "unknown_flag" | "unknown_value" | "failed", message: string) {
    super(message);
  }
}

/** One command-line answer: words for a person, and the documented object for a program. */
interface CliAnswer {
  text: string;
  json: unknown;
}

/** Local date and time to the second, "2026-09-29 14:05:12", for the CLI's Recent. */
function stamp(at: number): string {
  const date = new Date(at);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/**
 * What a folder sync answers on a host that has none. Node opens a directory
 * on Windows for reading only, and `FlushFileBuffers` needs write access, so
 * the sync is refused `EPERM` there, for every folder, every time; a host that
 * will not open a directory at all says `EISDIR`. No POSIX `open(2)` of a
 * directory for reading, and no `fsync(2)`, answers either.
 */
const NO_FOLDER_SYNC = new Set(["EPERM", "EISDIR"]);

/**
 * How long Obsidian's desktop adapter lets its queue go without progress
 * before it abandons the action in front ("File system operation timed out.",
 * 1.13.4): the budget a reconcile this host queues is held to (`reconcile`).
 */
const ADAPTER_QUEUE_MS = 60_000;

/**
 * How many folders above the vault root the nested-vault check looks at. A
 * bound on an absurd path rather than a defence: the walk ends at the
 * filesystem root long before this on any real disk.
 */
const NESTING_LEVELS = 32;

// The Node filesystem, reached through Electron's `require`. Typed narrowly
// rather than as `any`: only these calls are used, and only on desktop.
interface NodeFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
  /** `fstat`: the identity of the OPEN file, which no later swap can change (`fstat` below). */
  stat(options: { bigint: true }): Promise<NodeBigStat>;
  close(): Promise<void>;
  sync(): Promise<void>;
  utimes(atime: number, mtime: number): Promise<void>;
}
interface NodeFs {
  promises: {
    open(path: string, flags: string, mode?: number): Promise<NodeFileHandle>;
    mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
    rename(from: string, to: string): Promise<void>;
    link(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    /** Names inside a directory, including the ones the vault does not show. */
    readdir(path: string): Promise<string[]>;
    /** Remove an EMPTY directory; the caller proves it is empty first. */
    rmdir(path: string): Promise<void>;
    utimes(path: string, atime: number, mtime: number): Promise<void>;
    /** A note's own text, to load into an editor the write went under (`refreshEditors`). */
    readFile(path: string, encoding: "utf8"): Promise<string>;
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    /** No-follow stat. Rejects when the path does not exist. */
    lstat(path: string, options: { bigint: true }): Promise<NodeBigStat>;
    /** Entry names only: the walk lstats each one itself, without following. */
    readdir(path: string): Promise<string[]>;
  };
}
declare const require: (id: string) => unknown;

/** A Node built-in, on the platforms that have one. Mobile has none. */
function nodeModule<T>(id: string): T | null {
  if (!Platform.isDesktopApp) return null;
  try {
    return require(id) as T;
  } catch {
    return null;
  }
}

/** What the desktop path needs: the filesystem, the resolver, the vault root. */
export interface DesktopVault {
  fs: NodeFs;
  path: PathResolver;
  base: string;
}

/**
 * Node's `lstat` as the walker's seam: absent is `null`, everything else is
 * the caller's problem. `ENOTDIR` counts as absent because it is what a
 * lookup THROUGH a non-directory reports, which is the same "nothing here".
 */
function walker(fs: NodeFs): PathWalker {
  return {
    lstat: async (path) => {
      try {
        return pathStat(await fs.promises.lstat(path, { bigint: true }));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
  };
}

/** A stat taken with `{ bigint: true }`: every number in it is a bigint. */
interface NodeBigStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

/**
 * A FILE'S IDENTITY AS THE KERNEL WROTE IT (issue #224). Node hands `dev` and
 * `ino` over as numbers unless asked for bigints, and a number keeps 53 bits
 * of an NTFS or ReFS file id's 64: past 2^53 two neighbouring ids were one
 * number, and `sameFile` took two files for one -- the file a write was bound
 * to among them (#39). Every stat that proves identity is taken this way.
 * `size` and `mtimeMs` are the plain stat's numbers to the bit -- Node's own
 * `sec * 1000 + nsec / 1e6` -- so nothing that compares or records them moves.
 */
function pathStat(stat: NodeBigStat): PathStat {
  const ns = stat.mtimeNs;
  return {
    isDirectory: () => stat.isDirectory(),
    isFile: () => stat.isFile(),
    isSymbolicLink: () => stat.isSymbolicLink(),
    dev: stat.dev,
    ino: stat.ino,
    size: Number(stat.size),
    mtimeMs: Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6,
  };
}

/** `fstat` of an open file, the same way. */
async function fstat(handle: NodeFileHandle): Promise<PathStat> {
  return pathStat(await handle.stat({ bigint: true }));
}

/**
 * The one entry in a directory listing that IS this name: the exact spelling
 * when the directory keeps it, and otherwise the single entry that differs
 * from it in case alone. None, or two of them, is not an answer -- a
 * directory holding both `Team` and `TEAM` is one that keeps the two apart,
 * and neither of them is the name that was asked about.
 */
function soleSpelling(names: string[], segment: string): string | null {
  if (names.includes(segment)) return segment;
  const folded = names.filter((name) => caseOnly(name, segment));
  return folded.length === 1 ? (folded[0] as string) : null;
}

/** The decisions that mean the plugin did NOT do what was asked, or fell back to a slower way of doing it (#221). */
const FAILURE_DECISION = /\bdecision=(refused|failed|stopped|lost|restore_failed|gave_up|temp_cleanup_failed|unresolved|fallback)\b/;

/**
 * How long a device waits to start again after the server could not be
 * reached: 5 s, doubling to a 5-minute cap, for as long as the plugin is
 * loaded and paired (issue #129). The transport has already spent its own
 * eight attempts (1 s doubling to 60 s) inside the start that failed, so the
 * first pause separates two probes without a second one on the heels of the
 * first, and the cap keeps a device away from a LAN-only server to one cheap
 * start every five minutes -- close enough that coming home syncs within
 * minutes even when no `online` event announces it, because the network was
 * up the whole time and only the server was not.
 */
const RECONNECT_START_MS = 5000;
const RECONNECT_CAP_MS = 5 * 60 * 1000;

/** An editor keeps one `\n` for a file that has `\r\n`: text is compared line endings aside. */
function lines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Whether a failed start is the server's ABSENCE rather than its DECISION.
 * The transport says `unreachable` after its own retries when nothing
 * answered or a 5xx said the server reached no conclusion; every other
 * `ApiError` is a refusal (`401 bad_signature`, `403 device_revoked`, ...)
 * and every other error is local (a domain map this version cannot read, a
 * key that does not decrypt). `507` is the one 5xx that IS a decision -- the
 * volume or the account is full (requirement 8) -- so it is excluded by
 * status. Only absence is retried: a refusal retried is the same refusal,
 * louder, and a device knocking every five minutes with a revoked credential
 * is exactly the noise a server log should not have to hold.
 */
function unreachable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "unreachable" && error.status !== 507;
}

/** A start the server refused for a reason no row of `refusalStatus` names. */
const START_REFUSED =
  "Your server refused to start sync with this device. Check the Server URL in obsync settings; the obsync log names the reason.";

/** What Obsidian's plugin manager calls this plugin, as `manifest.json` names it. */
const PLUGIN_NAME = "Self Hosted Private Sync";

/** The tab id of Obsidian's own Community plugins page, where an update is installed. */
const COMMUNITY_PLUGINS_TAB = "community-plugins";

/** The per-vault local-storage key of the reference this vault last opened (`heldReference`). */
const HELD_REFERENCE = "obsync-private-sync-held-reference";

/**
 * Obsidian's settings window, which the app sets on `App` at runtime and the
 * vendored API declaration does not list. Narrow, optional, and never assumed:
 * a host without it is a host where the button does nothing but say so.
 */
interface SettingsHost {
  setting?: { open(): void; openTabById(id: string): void };
}

/**
 * The one sentence the notice and the settings tab both show when the server
 * runs a newer plugin than this device. Obsidian's plugin manager owns
 * installation and updates; this server can never supply executable code.
 *
 * The plugin's own name comes FIRST: a phone-width notice wraps or truncates,
 * and a reader who cannot see the whole sentence still has to learn what is
 * available and which version they run before anything else.
 */
export function updateMessage(server: string, local: string): string {
  return (
    `${PLUGIN_NAME} ${server} is available (this device runs ${local}). ` +
    "Open Settings → Community plugins → Check for updates."
  );
}

/** Re-exported where it always was: the update check and its tests read it here. */
export { isNewer };

/**
 * Where **Open dashboard** may send the browser, decided on this device.
 *
 * The link is SERVER-SUPPLIED data. The server builds it as
 * `{OBSYNC_PUBLIC_URL}/login?token=…` (`crates/obsyncd/src/api/admin.rs`), and
 * the chart ships an empty `publicUrl` on purpose — a server that advertises
 * no address of its own is the private posture, not a misconfiguration — so
 * the answer is then the RELATIVE `/login?token=…`, which no browser can open.
 * A deployment that DOES name itself can still name an address this device
 * does not use. Resolving the answer against the Server URL the operator
 * typed is what makes the first case work and the second visible.
 *
 * Resolution is also what would let a server REDIRECT this device, so the
 * resolved origin must equal the configured one. The answer carries a
 * single-use dashboard token: a hostile or merely misconfigured server that
 * answered with another origin would hand that token, and the administrative
 * session it opens, to whoever owns that origin. The configured URL must be
 * http(s) for the same reason — an opaque base (`foo:bar`) has the opaque
 * origin `null`, which a `javascript:` link resolved against it would match.
 */
export type DashboardTarget = { url: string } | { reason: string; refused: string };

/** What the user chose in the confirmation dialog before leaving a server. */
export interface LeaveChoice {
  /** Leave although this device holds edits the server never received. */
  discardUnpushed: boolean;
  /** Clear this device's pairing even though the server refused to revoke it. */
  localOnly: boolean;
}

/**
 * Why the server did not remove this device, as the Leave dialog words it:
 * the last device, the last device while its recovery key is new (1.1.5), a
 * server that does not know it, no answer from the server (or an answer that
 * was not obsync's), or any other refusal of its own.
 */
export type LeaveRefusal = "last_device" | "recovery_too_new" | "bad_signature" | "unreachable" | "refused";

export type LeaveResult =
  | { decision: "left"; revoked: boolean }
  | { decision: "refused"; reason: "unpushed_edits"; unpushed: string[] }
  | { decision: "refused"; reason: LeaveRefusal; detail: string };

/**
 * What a revoke that did not happen offers instead: leaving on this device
 * only, whatever the server said or failed to say (issue #157). Only `409
 * last_device` and `401 bad_signature` were offered it before, and a server
 * that did not answer -- the commonest reason to leave one -- left a device
 * that could not leave (S40, S70).
 */
function leaveRefusal(error: unknown): { reason: LeaveRefusal; detail: string } {
  if (error instanceof ApiError && error.code === "recovery_too_new") return { reason: error.code, detail: error.detail };
  if (error instanceof ApiError && (error.code === "last_device" || error.code === "bad_signature")) {
    return { reason: error.code, detail: error.detail };
  }
  if (error instanceof ApiError && error.status !== 0 && error.code !== NOT_OBSYNC) return { reason: "refused", detail: error.detail };
  return { reason: "unreachable", detail: error instanceof Error ? error.message : String(error) };
}

/**
 * How long a leave waits for a start under way before it revokes (#233): its
 * steps end at the leave's stop in milliseconds, and the one that cannot, a
 * registration a silent server holds, must not hold a leave past its person's
 * budget (#157).
 */
const START_SETTLE_MS = 500;

/**
 * A request sent once that a person is waiting on: `lost` when nothing has
 * answered within `INTERACTIVE_MS` (issue #157). `requestUrl` cannot be
 * withdrawn, so the request goes on and its late answer is discarded -- a
 * revoke that lands afterwards has still done what the person asked.
 */
function patiently<T>(sent: Promise<Sent<T>>, patience: Patience): Promise<Sent<T>> {
  if (patience.interactive !== true) return sent;
  return new Promise((resolve, reject) => {
    const handle = window.setTimeout(
      () => resolve({ outcome: "lost", attempts: 1, reason: `no answer within ${INTERACTIVE_MS / 1000} s` }),
      INTERACTIVE_MS,
    );
    sent.then(
      (value) => { window.clearTimeout(handle); resolve(value); },
      (error: unknown) => { window.clearTimeout(handle); reject(error); },
    );
  });
}

/** Resolves `true` once `signal` aborts, and never otherwise. */
function aborted(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(true);
    else signal.addEventListener("abort", () => resolve(true), { once: true });
  });
}

export function dashboardTarget(link: string, serverUrl: string): DashboardTarget {
  const base = parseUrl(serverUrl);
  if (base === null || (base.protocol !== "https:" && base.protocol !== "http:")) {
    return {
      reason: "server_url",
      refused: "the Server URL in settings is not an http or https address, so a dashboard link cannot be resolved against it",
    };
  }
  const resolved = parseUrl(link, base);
  if (resolved === null) {
    return {
      reason: "not_a_link",
      refused: "the server answered with something this device cannot read as an address, so no dashboard was opened",
    };
  }
  if (resolved.origin !== base.origin) {
    return {
      reason: "foreign_origin",
      refused: `the dashboard link points at ${resolved.origin}, not at the configured server ${base.origin}, so it was not opened`,
    };
  }
  return { url: resolved.href };
}

function parseUrl(value: string, base?: URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * How long a note whose other spelling was deleted here is watched for its
 * own deletion (`ObsidianHost.twinDeleted`). Obsidian reports it about 100 ms
 * after the first (measured on Android 15, Obsidian 1.13.8).
 */
const TWIN_WATCH_MS = 10_000;

/**
 * How many times a phone writes a download again when the write left the
 * file empty (`ObsidianHost.landed`). One rewrite healed every such write
 * seen live (2 of 1,200 on Android 15, Obsidian 1.13.8).
 */
const WRITE_AGAIN = 2;

export class ObsidianHost implements VaultHost {
  private readonly desktop: DesktopVault | null;
  /** The temps this host's writers hold open now, which `sweep` never takes. */
  private readonly temps = new Set<string>();
  /** The nested vaults this host has already told the user about, once each. */
  private readonly nested = new Set<string>();
  /** The engine passes running now, and their nested-vault answer per folder (`pass`). */
  private passes = 0;
  private nestedAnswers: Map<string, boolean> | null = null;
  /** A directory this host could not fsync has been logged, once (`syncFolder`). */
  private folderSyncRefused = false;
  /** The linked folders this host has already told the user about, once each (issue #167). */
  private readonly linked = new Set<string>();
  /**
   * Every hidden name a re-case has passed an entry through this session, to
   * the two names of that entry (`recase`, `recased`, `ghost`). Kept for the
   * session, because the vault may report a rename after the call that made
   * it returns, and a name with sixteen random hex digits in it is never
   * reused.
   */
  private readonly recasing = new Map<string, { from: string; to: string }>();
  /** A re-case that could not be put back has been told about, once (`settleRecase`). */
  private recaseTold = false;
  /**
   * Names being taken out of Obsidian's index now -- a ghost's old spelling
   * (`unghost`), or one this host moved or removed on the disk (`reconcile`):
   * their `delete` events are that removal's own.
   */
  private readonly unghosting = new Set<string>();
  /** Obsidian's adapter offers no reconcile here, said once (`reconcile`). */
  private reconcileTold = false;
  /** Entries being put back under their own names now: their `create` events are that put-back's own (`settleRecase`). */
  private readonly returning = new Set<string>();
  /** Obsidian's index could not be corrected here, said once (`unghost`). */
  private ghostKeptTold = false;
  /** Tracked notes whose other spelling was just deleted here, to that spelling and the end of the watch (`twinDeleted`). */
  private readonly twinGuards = new Map<string, { via: string; until: number }>();
  private readonly inputAt = new WeakMap<MarkdownView, { path: string; at: number }>();
  private readonly composing = new WeakMap<MarkdownView, string>();
  private readonly inputWindows = new WeakSet<Window>();

  /**
   * `desktop` is the filesystem seam. It is discovered from Electron in the
   * app; a test passes its own so the desktop path can be run against a real
   * temporary vault, and against a hostile filesystem that swaps a file
   * under the writer between two checks.
   */
  constructor(
    private readonly plugin: ObsyncPlugin,
    desktop?: DesktopVault | null,
  ) {
    if (desktop !== undefined) {
      this.desktop = desktop;
      return;
    }
    const fs = nodeModule<NodeFs>("fs");
    const path = nodeModule<PathResolver>("path");
    const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
    const base = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
    this.desktop = fs !== null && path !== null && base !== null ? { fs, path, base } : null;
  }

  /**
   * The one filesystem gate: the string rule, the root proof, then a
   * no-follow stat of every component (`vaultPath.ts`). `expect` says what
   * the last component may be; anything else is refused before the operation
   * runs, so no `open`, `mkdir`, `rename` or `unlink` ever follows a link.
   */
  private async confine(
    desktop: DesktopVault,
    path: string,
    expect: FinalComponent[],
  ): Promise<WalkResult> {
    assertVaultPath(path);
    const found = await walkVaultPath(desktop.base, path, desktop.path, walker(desktop.fs));
    if (!expect.includes(found.final)) {
      // The refusal names what the operation needed, not what it found.
      throw new VaultPathError(expect.includes("directory") ? "not_a_directory" : "not_a_file");
    }
    return found;
  }

  /**
   * May this device sync this path at all? Desktop refuses a path with a
   * symlink component — a symlinked folder is out of sync in v0.1, in both
   * directions — and says so once per event. Mobile reaches the vault only
   * through Obsidian's adapter, which the host app confines, so there is
   * nothing here to walk. Both refuse a path in a nested vault
   * (`inNestedVault`), before a byte of it is read or uploaded.
   */
  async syncable(path: string, kind: "file" | "folder" = "file"): Promise<boolean> {
    const folders = this.plugin.state.data.syncFolders;
    // The folder rule at the one point it differs: the selected folder itself
    // is a folder this device publishes a record for (`syncScope.ts`). It
    // carries the string rule, so what is left to ask is the filesystem's.
    if (!(kind === "folder" ? inFolderScope(path, folders) : inSyncScope(path, folders))) return false;
    if (kind === "file" && this.holds(path)) {
      this.log("host path_class=file decision=not_synced reason=recase_pending");
      return false;
    }
    const desktop = this.desktop;
    try {
      if (desktop !== null) await this.confine(desktop, path, ["absent", "file", "directory", "other"]);
      if (await this.inNestedVault(path)) throw new VaultPathError("nested_vault");
      return true;
    } catch (error) {
      if (!(error instanceof VaultPathError)) throw error;
      this.plugin.log(`host path_class=${kind} decision=not_synced reason=${error.refusal}`);
      this.linkedFolder(error);
      return false;
    }
  }

  /**
   * Tell the user about one linked folder, once (issue #167). A link in the
   * vault is not synced in either direction (`vaultPath.ts`), and that was
   * true in silence: the folder's files stayed here while its NAME reached the
   * other devices as a real empty folder. It is said where the link is met on
   * the way OUT -- the listing, the watcher, a folder's publication -- in the
   * words a person uses for it. A change from another device that would have
   * to pass through the link keeps its own refusal (`sync/pull.ts`).
   */
  private linkedFolder(error: VaultPathError): void {
    if (error.refusal !== "symlink_component" || error.at === undefined || this.linked.has(error.at)) return;
    this.linked.add(error.at);
    this.log("host path_class=folder decision=excluded reason=symlink_component");
    this.notify(
      `obsync doesn't sync linked folders: "${error.at}" is a link, so it stays on this device only. Nothing in it ` +
        "is sent to your other devices, and nothing from them is written into it. To sync it, move the folder " +
        "itself into the vault instead of linking to it.",
    );
  }

  /**
   * An engine pass over many paths begins or ends (`VaultHost.pass`). While
   * one runs, the nested-vault answer is kept per folder (issue #198): asked
   * of every folder on the way to every note, it cost three no-follow stats a
   * level on desktop and a bridge call a level on a phone -- about 60,000
   * calls in a phone's first sync of 10,000 notes. The answers go when the
   * last pass ends, so a folder that becomes a vault of its own is found by
   * the next pass, and every question outside one is asked afresh. The walk
   * that refuses a link still runs before every write.
   */
  pass(open: boolean): void {
    this.passes = Math.max(0, this.passes + (open ? 1 : -1));
    this.nestedAnswers = this.passes === 0 ? null : this.nestedAnswers ?? new Map();
  }

  /**
   * Is `path` in a folder of this vault that is a vault of its own syncing
   * with this plugin, or is it that folder (issue #180)?
   *
   * THE LOOP THIS CLOSES. Opened as a vault of its own and paired with the
   * same server, `Sub` downloaded the whole vault into itself; this vault saw
   * those downloads as new notes under `Sub/` and published them, and `Sub`
   * downloaded them again one level deeper: `Sub/Sub/Sub/…`, 98 levels deep
   * on every device within seconds (S96). So a folder holding
   * this plugin in a config folder of its own (`holdsPlugin`) is out of sync
   * in both directions, as this vault's config folder is:
   * nothing in it is published from here, and the feed writes, moves and
   * removes nothing in it -- whichever vault was paired first, on whichever
   * computer. It is never excluded silently, and never loudly once per note:
   * one notice and one log line per folder (`named`).
   *
   * PLATFORM. Desktop walks the path first without following a link, then
   * asks each directory on the way down with no-follow `lstat`s, so no
   * question is carried out of the vault by a link; a path the walk refuses
   * is the operation's to refuse in its own words, and is not nested. Mobile
   * asks the adapter, which the host app confines to the vault. Names only,
   * never content, on both.
   */
  async inNestedVault(path: string): Promise<boolean> {
    const segments = path.split("/");
    const desktop = this.desktop;
    // One answer per folder per engine pass (`pass`); outside one, every
    // question is asked. A folder that holds the plugin is named every time.
    const answers = this.nestedAnswers;
    const answer = async (folder: string, ask: () => Promise<boolean>): Promise<boolean> => {
      const known = answers?.get(folder) ?? await ask();
      answers?.set(folder, known);
      return known;
    };
    if (desktop === null) {
      for (let depth = 1; depth <= segments.length; depth++) {
        const folder = segments.slice(0, depth).join("/");
        if (await answer(folder, () => this.holdsPluginHere(folder))) return this.named(folder);
      }
      return false;
    }
    let chain: ChainLink[];
    try {
      chain = (await this.confine(desktop, path, ["absent", "file", "directory", "other"])).chain;
    } catch (error) {
      if (error instanceof VaultPathError) return false;
      throw error;
    }
    // `chain[depth]` is the directory the first `depth` segments name.
    for (let depth = 1; depth < chain.length; depth++) {
      const folder = segments.slice(0, depth).join("/");
      if (await answer(folder, () => this.holdsPlugin(desktop, (chain[depth] as ChainLink).path))) return this.named(folder);
    }
    return false;
  }

  /** Tell the user about one nested vault, once: a notice naming it, and a log line that does not. */
  private named(folder: string): true {
    if (this.nested.has(folder)) return true;
    this.nested.add(folder);
    this.log("host path_class=folder decision=excluded reason=nested_vault");
    this.notify(
      `obsync does not sync "${folder}": that folder is a vault of its own with obsync installed, and syncing it ` +
        "from this vault too would copy this vault into itself. Nothing in it was changed. To sync it from this " +
        "vault again, uninstall obsync in that folder's own vault.",
    );
    return true;
  }

  /**
   * What makes a folder a vault that syncs with this plugin (issue #180): a
   * HIDDEN folder in it holding `plugins/` and this plugin's own folder, which
   * the community installer names after the directory identity. That hidden
   * folder is the other vault's config folder, and its name is that vault's
   * to choose in Obsidian's settings (the vault API names only this
   * vault's), so no one name is assumed: every hidden folder is asked. Only
   * names are looked at, never what is in them; a folder that cannot be
   * listed is not known to be a vault, and the walk skips it as unreadable.
   */
  private async holdsPlugin(desktop: DesktopVault, dir: string): Promise<boolean> {
    let names: string[];
    try {
      names = await desktop.fs.promises.readdir(dir);
    } catch {
      return false;
    }
    next: for (const name of names) {
      if (!name.startsWith(".")) continue;
      let at = desktop.path.resolve(dir, name);
      for (const step of ["plugins", PAIRING_ACTION, null]) {
        // A hidden entry the system will not stat (macOS answers `/.resolve`
        // with EINVAL) is no config folder; the question moves on.
        const stat = await walker(desktop.fs).lstat(at).catch(() => null);
        if (stat?.isDirectory() !== true) continue next;
        if (step !== null) at = desktop.path.resolve(at, step);
      }
      return true;
    }
    return false;
  }

  /**
   * The phone's `holdsPlugin`, through the adapter, which confines every
   * question to the vault. ONE QUESTION PER FOLDER, AS BEFORE: does the folder
   * hold this plugin's own folder at the path this vault holds it
   * (`manifest.dir`, the config folder's name included)? Listing each folder
   * to ask every hidden one instead answers a turn later on Android, a bridge
   * call and a turn per folder for nothing; the race that turn exposed is the
   * engine's to close, and it does (`inPass`, #244). Only a manifest without
   * `dir`, which Obsidian always sets, is asked by listing.
   */
  private async holdsPluginHere(folder: string): Promise<boolean> {
    const adapter = this.plugin.app.vault.adapter;
    const own = this.plugin.manifest.dir;
    if (own !== undefined) return adapter.exists(`${folder}/${own}`);
    let folders: string[];
    try {
      folders = (await adapter.list(folder)).folders;
    } catch {
      return false;
    }
    for (const child of folders) {
      if (child.slice(child.lastIndexOf("/") + 1).startsWith(".") && (await adapter.exists(`${child}/plugins/${PAIRING_ACTION}`))) return true;
    }
    return false;
  }

  /**
   * The name of the vault this one sits INSIDE, when that vault has this
   * plugin (issue #180), or `null`: the other half of `inNestedVault`, asked
   * before this vault is set up, pairs or starts. The folders above the vault
   * root, nearest first and at most `NESTING_LEVELS` of them, one
   * `holdsPlugin` each; nothing else is read. A link on the way up is the
   * one this vault itself was reached through.
   *
   * PLATFORM. Desktop only. Mobile can see nothing outside its vault and
   * answers `null`; there the outer vault's exclusion is the whole defence.
   */
  async enclosingVault(): Promise<string | null> {
    const desktop = this.desktop;
    if (desktop === null) return null;
    let at = desktop.path.resolve(desktop.base);
    for (let level = 0; level < NESTING_LEVELS; level++) {
      const up = desktop.path.resolve(at, "..");
      if (up === at) return null;
      at = up;
      if (await this.holdsPlugin(desktop, at)) return at.slice(at.lastIndexOf(desktop.path.sep) + 1) || at;
    }
    return null;
  }

  get isMobile(): boolean {
    return Platform.isMobile;
  }

  get supportsRangeReads(): boolean {
    return this.desktop !== null;
  }

  /**
   * Can a removal be BOUND to what it removes here? Only where a second name
   * for the same file can be made, which is the desktop filesystem. A caller
   * that must not lose a save asks this before it starts, so a device that
   * cannot promise it is never asked to remove anything (`trash`).
   */
  get bindsRemoval(): boolean {
    return this.desktop !== null;
  }

  get platform(): string {
    return this.plugin.platformName();
  }

  get appVersion(): string {
    return this.plugin.manifest.version;
  }

  get deviceName(): string {
    return this.plugin.deviceName();
  }

  /** Every vault file whose path this device may sync, and no other. */
  async list(): Promise<VaultStat[]> {
    const folders = this.plugin.state.data.syncFolders;
    if (folders !== undefined) {
      const files: VaultStat[] = [];
      const visit = async (entry: TAbstractFile): Promise<void> => {
        if (entry instanceof TFile) {
          if (inSyncScope(entry.path, folders)) files.push({ path: entry.path, mtime: entry.stat.mtime, size: entry.stat.size });
        } else if (entry instanceof TFolder && inSyncTree(entry.path, folders)) {
          // Refuse a linked folder before walking its cached children. No
          // whole-vault inventory or stat of an excluded subtree is needed.
          if (this.desktop !== null) {
            try {
              await this.confine(this.desktop, entry.path, ["directory"]);
            } catch (error) {
              if (!(error instanceof VaultPathError)) throw error;
              this.log(`list decision=not_synced reason=${error.refusal}`);
              this.linkedFolder(error);
              return;
            }
          }
          for (const child of entry.children) await visit(child);
        }
      };
      for (const folder of folders) {
        const entry = this.plugin.app.vault.getAbstractFileByPath(folder);
        if (entry instanceof TFolder) await visit(entry);
      }
      return await this.confirmed(await this.unghosted(files));
    }
    const synced = await this.inventory();
    const skipped = this.plugin.app.vault.getFiles().length - synced.length;
    if (skipped !== 0) this.plugin.log(`list decision=skipped_unsyncable files=${skipped}`);
    return await this.confirmed(await this.unghosted(synced));
  }

  /**
   * THE INDEX, ASKED OF THE DISK WHERE IT DISAGREES WITH A RECORD (issue
   * #245). Obsidian mobile watches no filesystem: a download whose bytes
   * Android lands after Obsidian looked at the file stays in the index at the
   * size it saw, often 0, until Obsidian restarts. Leave then counted a synced
   * note as unsent (four on the emulator), and every pass queued and read it
   * for nothing. A listed file whose size or mtime differs from its record is
   * asked ONE `stat` -- a suspect, never every file -- and the disk's answer
   * stands for it. A file with no record, or one the disk cannot answer for,
   * keeps the index's word.
   */
  private async confirmed(files: VaultStat[]): Promise<VaultStat[]> {
    const started = Date.now();
    let suspects = 0;
    let stale = 0;
    const out: VaultStat[] = [];
    for (const file of files) {
      const record = this.plugin.state.data.files[file.path];
      const suspect = record !== undefined && !isPushed(record, file.mtime, file.size);
      if (suspect) suspects++;
      const disk = suspect ? await this.stat(file.path).catch(() => null) : null;
      if (disk === null || (disk.size === file.size && disk.mtime === file.mtime)) {
        out.push(file);
        continue;
      }
      stale++;
      this.log(`list decision=stale_index size_index=${file.size} size_disk=${disk.size} mtime_index=${file.mtime} mtime_disk=${disk.mtime}`);
      out.push(disk);
    }
    if (stale > 0) this.log(`list decision=confirmed suspects=${suspects} stale=${stale} files=${files.length} duration_ms=${Date.now() - started}`);
    return out;
  }

  /**
   * ONE ENTRY IS LISTED ONCE, however many spellings Obsidian's index keeps
   * for it (issue #219). A rename made below the index -- another app, or
   * two adapter-level renames -- leaves the index holding the old spelling
   * beside the new one for a single file on a phone whose storage folds
   * capitals, and a first upload published that file under two file ids.
   * Where the listing holds names that differ only in capitals, each is asked
   * what the vault really shows, and one the vault shows under ANOTHER listed
   * name is dropped. A note with no such twin costs no lookup, and two real
   * files -- on storage that keeps the spellings apart -- each answer with
   * their own name and are both kept.
   */
  private async unghosted(files: VaultStat[]): Promise<VaultStat[]> {
    const folded = new Map<string, string[]>();
    for (const { path } of files) {
      const twins = folded.get(path.toLowerCase());
      if (twins === undefined) folded.set(path.toLowerCase(), [path]);
      else twins.push(path);
    }
    const ghosts = new Set<string>();
    for (const twins of folded.values()) {
      if (twins.length < 2) continue;
      for (const path of twins) {
        const shown = await this.spelling(path).catch(() => null);
        if (shown !== null && shown !== path && twins.includes(shown)) ghosts.add(path);
      }
    }
    if (ghosts.size === 0) return files;
    this.log(`list decision=skipped reason=index_ghost files=${ghosts.size}`);
    return files.filter((file) => !ghosts.has(file.path));
  }

  /**
   * IS THIS PATH HELD BY A RE-CASE STILL IN FLIGHT (issue #219, `recase`)?
   * Between its two renames the entry wears a hidden name no listing shows,
   * so every record at either of its names, or under them, reads as a note
   * or folder that vanished -- and the start's pass publishes a vanished
   * record as a deletion. A held file is not synced (`syncable`), which that
   * pass asks before it tombstones anything, and held folders are listed as
   * their records stand (`listFolders`), until the rename is asked for again
   * (`settleRecase`).
   */
  private holds(path: string): boolean {
    const pending = this.plugin.state.data.pendingRecase;
    return pending !== undefined && [pending.from, pending.to].some((root) => path === root || path.startsWith(`${root}/`));
  }

  /** `VaultHost.recasePending`: held, and the entry still wears its hidden name after a try to put it back. */
  async recasePending(path: string): Promise<boolean> {
    if (!this.holds(path)) return false;
    await this.settleRecase(false);
    const pending = this.plugin.state.data.pendingRecase;
    return pending !== undefined && (await this.plugin.app.vault.adapter.exists(pending.temp));
  }

  /**
   * The whole index, whatever the selection (`VaultHost.inventory`): the
   * names, sizes and mtimes Obsidian already holds in memory, on desktop and
   * mobile alike. No directory is walked and no file is opened, so a folder
   * outside the selection is compared, never touched.
   */
  async inventory(): Promise<VaultStat[]> {
    return this.plugin.app.vault.getFiles()
      .filter((file) => isVaultPath(file.path))
      .map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size }));
  }

  /**
   * The vault as the FILESYSTEM has it, or `null` on a host with no view of
   * its own (`VaultHost.scan`).
   *
   * `list()` above is Obsidian's index, and the index is never fresher than
   * the vault events this plugin already handles: a note moved into a
   * subfolder from a file manager is absent from both until the app notices,
   * which is why such a move took about four minutes to sync while an
   * external EDIT took seconds (issue #101). One `readdir` per directory and
   * one no-follow `lstat` per entry answer the same question independently.
   *
   * The rules are the ones every other path takes: hidden and non-canonical
   * names are skipped (`vaultPath.ts`), symlinks are skipped in both roles
   * (a symlinked folder is out of sync in v0.1, in both directions), and only
   * the selected folders are walked. A directory that cannot be read is
   * skipped rather than reported as empty -- this listing may only ADD work
   * (`engine.ts`), but a caller that mistook an unreadable folder for a
   * vanished one would be one refactor away from a tombstone.
   *
   * Names come back in Obsidian's own form, NFC (see `walk`). On a volume
   * that tells NFC and NFD apart, a FOLDER whose name is decomposed on disk
   * is then read under its composed name and reported unreadable, which
   * skips that subtree rather than proposing paths the index can never hold.
   */
  async scan(): Promise<VaultStat[] | null> {
    const desktop = this.desktop;
    if (desktop === null) return null;
    const files: VaultStat[] = [];
    for (const root of this.plugin.state.data.syncFolders ?? [""]) {
      // ONLY A FOLDER THE VAULT HOLDS UNDER EXACTLY THE SELECTED NAME -- the
      // question `list()` asks of the same index (issue #150). A walk from the
      // selection's own spelling reached `Notes/` for a selected `notes` on a
      // volume that folds case, and reported every note in it under a name no
      // record held: the device published the folder again as new files
      // carrying older text, over the other device's newer edits (S30a).
      if (root !== "" && !(this.plugin.app.vault.getAbstractFileByPath(root) instanceof TFolder)) {
        this.log("scan decision=skipped reason=not_a_vault_folder");
        continue;
      }
      await this.walk(desktop, root, files, 0);
    }
    return files;
  }

  /**
   * Remove the temp files writes left when this device stopped in the middle
   * of them (issue #159), at each engine start (`VaultHost.sweep`).
   *
   * Only the names a writer makes (`WRITE_TEMP`), and only as regular files:
   * a link wearing one of those names is left where it is, as the writer
   * leaves it. What they held came from the server and is fetched again. A
   * temp a writer of this host holds open is not a leftover. The walk is the
   * scan's, over the selected folders, which is where every write lands.
   */
  async sweep(): Promise<void> {
    const desktop = this.desktop;
    if (desktop === null) return;
    const started = Date.now();
    const found: string[] = [];
    for (const root of this.plugin.state.data.syncFolders ?? [""]) await this.walk(desktop, root, [], 0, found);
    let removed = 0;
    let kept = 0;
    for (const temp of found) {
      if (this.temps.has(temp)) continue;
      await desktop.fs.promises.unlink(temp).then(() => removed++, () => kept++);
    }
    if (removed + kept === 0) return;
    this.log(
      `host path_class=temp decision=removed reason=interrupted_write files=${removed} kept=${kept} ` +
        `duration_ms=${Date.now() - started}`,
    );
  }

  /**
   * On every platform, a re-case this device stopped between its two renames
   * is put back (`settleRecase`), at each engine start and before its first
   * pass (`VaultHost.settle`): that pass is the one that publishes deletions.
   */
  async settle(): Promise<void> {
    await this.settleRecase(false);
  }

  /** One directory, then its subdirectories, to a bounded depth; `temps` collects `WRITE_TEMP` files. */
  private async walk(desktop: DesktopVault, folder: string, out: VaultStat[], depth: number, temps?: string[]): Promise<void> {
    if (depth > SCAN_MAX_DEPTH) {
      this.log(`scan decision=skipped reason=depth budget_depth=${SCAN_MAX_DEPTH}`);
      return;
    }
    const at = folder === "" ? desktop.path.resolve(desktop.base) : vaultTarget(desktop.base, folder, desktop.path);
    let names: string[];
    try {
      names = await desktop.fs.promises.readdir(at);
    } catch {
      // Unreadable is not empty, and this listing never deletes anything.
      this.log("scan decision=skipped reason=unreadable_directory");
      return;
    }
    const folders = this.plugin.state.data.syncFolders;
    for (const name of names) {
      // THE NAME AS OBSIDIAN HAS IT, NOT AS THE VOLUME SPELLS IT. Every path
      // Obsidian's index reports has been through `normalizePath`, which ends
      // in `.normalize("NFC")`; a macOS app writing an accented name through
      // Cocoa leaves it DECOMPOSED on the volume, so `readdir` hands the same
      // note back in NFD. Reported raw, that name is one the record has never
      // held while the recorded one looks gone, and `survey()` would pair the
      // two as a move and publish a rename to the other spelling -- which on a
      // normalisation-insensitive volume names the same file, so the device
      // applying it writes one path and trashes the other: the note is gone,
      // the #96 class of loss. Only the name REPORTED is normalised; every
      // syscall below still takes the raw name the directory gave.
      const path = folder === "" ? name.normalize("NFC") : `${folder}/${name.normalize("NFC")}`;
      // A NO-FOLLOW stat, so a link is neither a file nor a directory here
      // and is listed as neither; `inSyncTree` and `inSyncScope` carry the
      // string rule (`vaultPath.ts`), so a hidden or non-canonical name is
      // neither walked nor listed. None of this is the AUTHORITY on what may
      // be synced: this listing only proposes paths, and `syncable()` walks
      // every component of each one before the engine acts on it.
      const stat = await walker(desktop.fs).lstat(desktop.path.resolve(at, name));
      if (stat === null) continue;
      if (temps !== undefined && stat.isFile() && WRITE_TEMP.test(name)) temps.push(desktop.path.resolve(at, name));
      if (stat.isDirectory()) {
        // A vault of its own is neither listed nor swept (`inNestedVault`);
        // the start's reconcile pass names it, asking of every folder.
        if (inSyncTree(path, folders) && !(await this.holdsPlugin(desktop, desktop.path.resolve(at, name)))) {
          await this.walk(desktop, path, out, depth + 1, temps);
        }
        continue;
      }
      if (!stat.isFile() || !inSyncScope(path, folders)) continue;
      out.push({ path, mtime: Math.round(stat.mtimeMs), size: stat.size });
    }
  }

  /**
   * On desktop the walk itself is the answer: it already stat-ed the file
   * without following a link, so asking the name a second time would only
   * add a lookup to race.
   */
  async stat(path: string): Promise<VaultStat | null> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop !== null) {
      const found = await this.confine(desktop, path, ["absent", "file"]);
      if (found.final === "absent" || found.stat === null) return null;
      return { path, mtime: Math.round(found.stat.mtimeMs), size: found.stat.size };
    }
    const stat = await this.plugin.app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") return null;
    return { path, mtime: stat.mtime, size: stat.size };
  }

  /**
   * Open a vault file for reading and prove, AFTER the open, that the name
   * still means the file the walk approved and that every directory on the
   * way to it is still the same directory. The caller closes the handle.
   */
  private async openBound(desktop: DesktopVault, path: string): Promise<NodeFileHandle> {
    const found = await this.confine(desktop, path, ["file"]);
    const handle = await desktop.fs.promises.open(found.target, "r");
    const refusal = await chainRefusal(found.chain, walker(desktop.fs));
    if (refusal !== null || !sameFile(found.stat, await fstat(handle))) {
      await handle.close();
      throw new VaultPathError(refusal ?? "target_identity");
    }
    return handle;
  }

  async read(path: string): Promise<Bytes> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop === null) {
      return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(path));
    }
    const handle = await this.openBound(desktop, path);
    try {
      const size = (await fstat(handle)).size;
      const buffer = new Uint8Array(size);
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }

  /**
   * Desktop reads a window at a time straight off the disk, so a 20 GB file
   * never lands in memory. Mobile has no such API and buffers the file once.
   */
  source(path: string, size: number): ByteSource {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop === null) {
      let cached: Bytes | null = null;
      return {
        size,
        read: async (offset, length) => {
          cached = cached ?? (await this.read(path));
          return cached.subarray(offset, offset + length);
        },
      };
    }
    return {
      size,
      // The walk and the binding run per window rather than once: a file or
      // a folder that changes between two windows is refused at the next
      // one, and a few `lstat` calls beside an 8 MiB read cost nothing.
      read: async (offset, length) => {
        const handle = await this.openBound(desktop, path);
        try {
          const buffer = new Uint8Array(length);
          let filled = 0;
          while (filled < length) {
            const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
            if (bytesRead === 0) break;
            filled += bytesRead;
          }
          return buffer.subarray(0, filled);
        } finally {
          await handle.close();
        }
      },
    };
  }

  /**
   * An atomic vault write. Desktop writes a sibling temp file, fsyncs it
   * through its descriptor, closes it, restores the modification time,
   * renames it over the target and fsyncs the directory, so a crash mid-write
   * can never leave a torn or empty note (issue #202). Mobile buffers and
   * calls `writeBinary` once, which is the strongest primitive the adapter
   * has; it exposes no fsync.
   *
   * ONE BUFFER ON A PHONE, of exactly `size` bytes, each part copied into
   * place as it arrives (issue #197), as `createWriter` does: the parts and
   * then a joined copy of them held a 512 MiB download twice, 1 GiB, which is
   * enough to end the app. A part past `size`, or a commit short of it, is
   * refused.
   */
  async writer(path: string, size: number): Promise<VaultWriter> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop !== null) return this.desktopWriter(desktop, path);
    const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    let bytes = new Uint8Array(size);
    let at = 0;
    const adapter = this.plugin.app.vault.adapter;
    return {
      write: async (part) => {
        if (at + part.length > bytes.length) throw new Error("A download exceeded its declared size.");
        bytes.set(part, at);
        at += part.length;
      },
      commit: async (mtime) => {
        if (at !== size) throw new Error("A download ended short of its declared size.");
        // A folder can stand where a remote manifest names a file now that
        // folders sync, and `writeBinary` would not say so. Desktop refuses
        // it in `confine`; mobile refuses it here, in the same words, so both
        // platforms answer a file/folder collision identically (issue #104).
        const before = await adapter.stat(path);
        if (before?.type === "folder") throw new VaultPathError("not_a_file");
        if (folder !== "" && !(await adapter.exists(folder))) await adapter.mkdir(folder);
        const shown = await this.assertEditorIdle(path);
        await adapter.writeBinary(path, bytes.buffer, { mtime });
        // The SIZE is ours: the bytes handed to the adapter, not what a look
        // at the name says a moment later. The mtime is taken from the name
        // only while the name still holds that many bytes -- a save landing
        // between the write and the lookup must not have its metadata
        // recorded as this version's (round 3, finding 2).
        const stat = await this.landed(path, bytes, mtime);
        if (stat !== null && stat.size === size) {
          if (shown !== null) {
            await this.refreshEditors(path, shown, new TextDecoder().decode(bytes),
              async () => new TextDecoder().decode(await adapter.readBinary(path)));
          }
          return { path, mtime: stat.mtime, size };
        }
        if (stat !== null) this.log(`host path_class=file decision=write_superseded size=${size} found=${stat.size}`);
        return { path, mtime, size };
      },
      abort: async () => {
        bytes = new Uint8Array(0);
      },
    };
  }

  /**
   * What a phone's download left at its name, once the write is known to
   * have landed.
   *
   * ANDROID CAN LEAVE A WRITE EMPTY (live, 2026-09-27). Obsidian's
   * `writeBinary` resolved over a 993-byte download and the file held
   * nothing, for good: 4 of 1,600 downloads on the Android emulator while a
   * desktop wrote 400 files at a time, and 15 of a 2,000-file tree. The
   * writer took the empty file for a save landing after its write, recorded
   * the download's size, and the watcher then found an empty note and
   * published it: the note was empty on every device, its author's too. A
   * file just written with bytes that reads EMPTY is written again, up to
   * `WRITE_AGAIN` times, each time under the first write's rule in its
   * order: never beneath text an editor holds unsaved, nor a keystroke that
   * arrived while it was read (#135). Its last look at the file comes after
   * the editor's read, and anything but the empty file there is a save that
   * landed, kept and sent as an edit; the keystrokes are asked after that
   * look, with no await between them and the write. The look's own await is
   * the floor every write on a phone has. One that stays empty, or
   * whose editor became busy, is refused as this one file's (`write_dropped`:
   * parked, said once, tried again) and never recorded as written. The empty
   * file is left where it is: nothing on a phone can remove it without
   * racing a save that lands after the last look, so it is never sent
   * instead (`droppedWrite`, pull.ts). Only emptiness is judged: a file
   * holding other bytes is a save that landed, as before.
   */
  private async landed(path: string, bytes: Uint8Array<ArrayBuffer>, mtime: number): Promise<VaultStat | null> {
    const adapter = this.plugin.app.vault.adapter;
    let stat = await this.stat(path);
    for (let again = 1; stat !== null && stat.size === 0 && bytes.length > 0; again++) {
      const unsaved = (await this.editing(path)) === "unsaved";
      const now = await this.stat(path);
      if (now === null || now.size !== 0) return now;
      const busy = unsaved || this.typing(path);
      if (busy || again > WRITE_AGAIN) {
        this.log(
          `host path_class=file decision=refused reason=write_dropped cause=${busy ? "editor_busy" : "budget"} ` +
            `writes=${again} bytes=${bytes.length} budget_writes=${WRITE_AGAIN + 1}`,
        );
        const said = busy ? "The file stayed empty when it was written, and its editor is busy now." : "The file stayed empty when it was written.";
        throw Object.assign(new Error(said), { code: "write_dropped" });
      }
      const started = Date.now();
      await adapter.writeBinary(path, bytes.buffer, { mtime });
      stat = await this.stat(path);
      this.log(
        `host path_class=file decision=written_again reason=empty_after_write attempt=${again} bytes=${bytes.length} ` +
          `found=${stat?.size ?? "absent"} budget_writes=${WRITE_AGAIN + 1} duration_ms=${Date.now() - started}`,
      );
    }
    return stat;
  }

  /** Recovery has no overwrite fallback, on either platform. */
  async createWriter(path: string, size: number, check: () => void): Promise<VaultWriter> {
    const guard = (): void => { check(); assertSyncPath(path, this.plugin.state.data.syncFolders); };
    guard();
    const desktop = this.desktop;
    const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (desktop === null) {
      let bytes = new Uint8Array(size);
      let at = 0;
      return {
        write: async (part) => {
          guard();
          if (at + part.length > bytes.length) throw new Error("Restore exceeded its byte budget.");
          bytes.set(part, at);
          at += part.length;
        },
        commit: async (mtime) => {
          guard();
          if (at !== size) throw new Error("Restore content is incomplete.");
          const vault = this.plugin.app.vault;
          if (folder !== "" && !(await vault.adapter.exists(folder))) {
            guard();
            await vault.adapter.mkdir(folder);
          }
          guard();
          try {
            // The public Vault primitive rejects an existing file; the
            // adapter's writeBinary would silently replace it.
            const file = await vault.createBinary(path, bytes.buffer, { mtime });
            // `size` is the budget this writer enforced to the byte, so it is
            // the size of what was published here whatever the vault's cached
            // stat says after a later save (round 3, finding 2).
            return { path: file.path, mtime: file.stat.mtime, size };
          } catch {
            throw new CopyPublicationError(path);
          }
        },
        abort: async () => { bytes = new Uint8Array(0); },
      };
    }
    const fs = desktop.fs;
    if (folder !== "") {
      const before = await this.confine(desktop, folder, ["absent", "directory"]);
      guard();
      await fs.promises.mkdir(before.target, { recursive: true });
      guard();
    }
    const found = await this.confine(desktop, path, ["absent"]);
    guard();
    const parent = found.target.slice(0, found.target.lastIndexOf(desktop.path.sep));
    const temp = `${parent}${desktop.path.sep}.obsync-restore-${hex(randomBytes(16))}.tmp`;
    const handle = await fs.promises.open(temp, "wx", 0o600);
    let opened: PathStat;
    try { opened = await fstat(handle); } catch (error) { await handle.close(); throw error; }
    this.temps.add(temp);
    let open = true;
    let at = 0;
    // The copy a commit published and then could not confirm (`withdraw`).
    let unconfirmed: PathStat | null = null;
    // The descriptor's identity is read at each proof, as `desktopWriter`
    // says why: a FAT32 or exFAT volume renumbers the temp at its first byte.
    const discard = async (): Promise<void> => {
      this.temps.delete(temp);
      try {
        if (open) {
          opened = await fstat(handle);
          await handle.close();
        }
        open = false;
        if (sameFile(opened, await walker(fs).lstat(temp))) await fs.promises.unlink(temp);
      } catch { this.log("history decision=temp_cleanup_failed"); }
    };
    const bind = async (): Promise<void> => {
      guard();
      const refusal = await chainRefusal(found.chain, walker(fs));
      opened = await fstat(handle);
      if (refusal !== null || !sameFile(opened, await walker(fs).lstat(temp))) throw new VaultPathError(refusal ?? "temp_identity");
      guard();
    };
    try { await bind(); } catch (error) { await discard(); throw error; }
    return {
      write: async (bytes) => {
        await bind();
        if (at + bytes.length > size) throw new Error("Restore exceeded its byte budget.");
        let offset = 0;
        while (offset < bytes.length) {
          guard();
          const result = await handle.write(bytes.subarray(offset));
          if (result.bytesWritten <= 0 || result.bytesWritten > bytes.length - offset) throw new Error("Restore write made no valid progress.");
          offset += result.bytesWritten;
        }
        at += bytes.length;
      },
      commit: async (mtime) => {
        await bind();
        if (at !== size) throw new Error("Restore content is incomplete.");
        await handle.utimes(mtime / 1000, mtime / 1000);
        await handle.sync();
        // `fstat` of the file we hold open: the metadata of OUR bytes, taken
        // while they are still under a name nothing else knows, and the only
        // metadata this writer will answer with (round 3, finding 2).
        const wrote = await fstat(handle);
        await bind();
        await handle.close();
        open = false;
        guard();
        try {
          // link is atomic and cannot replace a destination, even one that
          // appeared after preflight. Never fall back to rename/copyFile.
          let published = opened;
          let made = wrote;
          try {
            await fs.promises.link(temp, found.target);
          } catch (error) {
            // A VOLUME WITH NO HARD LINKS (issue #176): FAT32 and exFAT answer
            // `ENOTSUP` on macOS, `EPERM` on Linux and `EISDIR` or `ENOTSUP`
            // on Windows. The copy is created EXCLUSIVELY instead -- `wx`
            // cannot replace a file either -- and filled from the proven temp.
            const code = (error as { code?: string }).code ?? "";
            if (!LINK_UNSUPPORTED.has(code)) throw error;
            const started = Date.now();
            published = made = await this.publishExclusive(fs, temp, found.target, opened, size, mtime);
            await discard();
            this.log(
              `host path_class=file decision=published reason=link_unsupported fallback=exclusive_create code=${code} ` +
                `bytes=${size} duration_ms=${Date.now() - started}`,
            );
          }
          // From here on, failure/cancellation preserves the published copy.
          unconfirmed = made;
          await this.syncFolder(fs, parent, true);
          const refusal = await chainRefusal(found.chain, walker(fs));
          const landed = await walker(fs).lstat(found.target);
          if (refusal !== null || !sameFile(published, landed)) throw new Error("Restore publication identity changed.");
          const stat = landed as PathStat;
          await this.reconcile(path, "file", true);
          if (stat.size !== made.size || Math.round(stat.mtimeMs) !== Math.round(made.mtimeMs)) {
            this.log("host path_class=file decision=write_superseded");
          }
          unconfirmed = null;
          return { path, mtime: Math.round(made.mtimeMs), size: made.size };
        } catch (error) {
          // The cause by its code alone, because its message names a path on
          // this disk: a refusal that said nothing hid every Windows copy.
          this.log(`host path_class=file decision=refused reason=copy_unconfirmed code=${(error as { code?: string }).code ?? "none"}`);
          throw new CopyPublicationError(path);
        }
      },
      abort: discard,
      // Only the copy this commit made, and only as it made it: the same
      // inode, size and time. Whatever else wears the name now -- another
      // file, or this one after something wrote into it -- stays (#225).
      withdraw: async () => {
        const made = unconfirmed;
        unconfirmed = null;
        if (made === null) return "none";
        const now = await walker(fs).lstat(found.target);
        if (now === null || !sameFile(made, now) || now.size !== made.size || now.mtimeMs !== made.mtimeMs) return "kept";
        return await fs.promises.unlink(found.target).then(() => "removed" as const, () => "kept" as const);
      },
    };
  }

  /**
   * Make a rename in `folder` durable: fsync the directory (issue #202). A
   * host that cannot -- Windows opens no directory for syncing -- still has
   * the note's bytes on disk, synced before the rename, so it is said once in
   * the log and never fails the write it follows.
   *
   * A `strict` caller -- a copy's publication, which says "may exist" rather
   * than claim a copy it cannot vouch for -- is spared only the host with no
   * folder sync at all (`NO_FOLDER_SYNC`); any other failure is thrown to it.
   * Before this, every restored copy and conflict copy on Windows was refused
   * after it had landed, and a conflict went on to write the note again under
   * the next name, up to twenty times (the Windows runner, 2026-09-27).
   */
  private async syncFolder(fs: NodeFs, folder: string, strict = false): Promise<void> {
    try {
      const directory = await fs.promises.open(folder, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      const code = (error as { code?: string }).code ?? "none";
      if (strict && !NO_FOLDER_SYNC.has(code)) throw error;
      if (this.folderSyncRefused) return;
      this.folderSyncRefused = true;
      this.log(`host path_class=folder decision=skipped reason=directory_fsync code=${code}`);
    }
  }

  /**
   * TELL OBSIDIAN WHAT THIS HOST JUST DID ON THE DISK (issue #253). Desktop
   * writes, moves and removes with the filesystem, and Obsidian hears of a
   * change made outside it only from the operating system's file events. A
   * Mac whose `fseventsd` is overloaded delivers them late or not at all, and
   * then a note obsync wrote is on the disk, recorded and synced, while
   * Obsidian does not list it -- not in the file explorer, search or the quick
   * switcher -- until a restart; a note obsync removed stays listed. Obsidian's
   * own writes never wait for an event: its adapter reconciles the name it
   * wrote (`reconcileInternalFile`), which lists it, the folders above it
   * first, or drops it, and raises the event its watcher would have. This asks
   * the adapter for the same, in the adapter's own queue, for a name whose
   * listing disagrees with what this host just did (`present`); a name
   * Obsidian already shows right costs one lookup.
   *
   * THE SAME EVENTS, SOONER, AND ONCE. What it raises is what a prompt watcher
   * raises, and what the phone's adapter raises inside every write: a `create`
   * the engine settles against the echo marks the pull arms before each call
   * (`engine.ts`, ECHOES). A REMOVED name's events are this host's own, as a
   * ghost's are, and never reach the engine (`unindexed`): the removal is the
   * pull applying another device's change, already recorded. The event that
   * arrives late finds the index right and raises nothing, because Obsidian
   * compares with what its index holds -- and asks the folder's listing for
   * the exact name first, so a name the volume spells another way is never
   * listed twice.
   *
   * NOT OBSIDIAN'S PUBLISHED API, so both members are asked for by name, and
   * without them the listing waits for the event as before, said once. A
   * failure is logged and never fails what it follows: that has landed. A
   * hidden name is never asked about, and that is the config folder too:
   * Obsidian accepts only a hidden name for it (1.13.4, `validateConfigDir`).
   * The budget is the adapter queue's own: Obsidian abandons a queued action
   * after `ADAPTER_QUEUE_MS` without progress, and this call with it.
   *
   * NEW BYTES UNDER A NOTE OBSIDIAN LISTS (`written`, issue #267) leave its
   * cached stat and read cache -- search, backlinks -- describing the old ones,
   * so the note is reconciled too, which raises the `modify` a watcher would:
   * the engine settles it against the echo mark like the `create` above. Not
   * while a leaf shows the note (`inView`): Obsidian reloads a view on that
   * event, and merges into one with unsaved typing behind a notice -- typing
   * that can begin while the reconcile waits in the queue. #252's refresh
   * shows such a view the new text; its index follows the editor's next
   * save, the late event, or a restart.
   */
  private async reconcile(path: string, kind: "file" | "folder", present: boolean, written = false): Promise<void> {
    const started = Date.now();
    try {
      if (!isVaultPath(path)) return;
      const vault = this.plugin.app.vault;
      const adapter = vault.adapter as typeof vault.adapter & {
        queue?: (action: () => Promise<void>) => Promise<void>;
        reconcileInternalFile?: (path: string) => Promise<void>;
      };
      const { queue, reconcileInternalFile } = adapter;
      if (typeof queue !== "function" || typeof reconcileInternalFile !== "function") {
        if (!this.reconcileTold) this.log(`vault path_class=${kind} decision=skipped reason=no_reconcile`);
        this.reconcileTold = true;
        return;
      }
      const entry = vault.getAbstractFileByPath(path);
      const changed = written && present && entry instanceof TFile;
      if ((entry !== null) === present && !changed) return;
      if (changed && this.inView(path)) {
        this.log(`vault path_class=${kind} decision=skipped reason=open_view`);
        return;
      }
      const stat = changed ? entry.stat : null;
      if (!present) this.unghosting.add(path);
      try {
        await queue.call(adapter, () => reconcileInternalFile.call(adapter, path));
      } finally {
        this.unghosting.delete(path);
      }
      const now = vault.getAbstractFileByPath(path);
      const done = changed ? now instanceof TFile && now.stat !== stat : (now !== null) === present;
      this.log(
        `vault path_class=${kind} decision=${done ? (changed ? "reindexed" : present ? "listed" : "unlisted") : "unchanged"} ` +
          `reason=${changed ? "bytes_changed" : present ? "not_listed" : "still_listed"} budget_ms=${ADAPTER_QUEUE_MS} ` +
          `duration_ms=${Date.now() - started}`,
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      this.log(
        `vault path_class=${kind} decision=failed reason=reconcile error=${name} budget_ms=${ADAPTER_QUEUE_MS} ` +
          `duration_ms=${Date.now() - started}`,
      );
    }
  }

  /**
   * Does any leaf show `path` -- an editor, a canvas, a preview -- or can this
   * host not tell (`reconcile`)? Asked right before the reconcile is queued: a
   * view that opens after that read the new bytes, and Obsidian ignores a
   * `modify` whose bytes its view last loaded (`TextFileView`, 1.13.4).
   */
  private inView(path: string): boolean {
    const workspace = this.plugin.app.workspace as Partial<App["workspace"]>;
    if (typeof workspace.iterateAllLeaves !== "function") return true;
    let found = false;
    workspace.iterateAllLeaves((leaf) => {
      if ((leaf.view as { file?: TAbstractFile | null }).file?.path === path) found = true;
    });
    return found;
  }

  /**
   * Publish the temp at `target` where `link` cannot (issue #176), and answer
   * with the identity of the file it made.
   *
   * THE SAME TWO PROMISES, KEPT ANOTHER WAY. The destination is opened
   * exclusive-create, which refuses a name anything already wears exactly as
   * `link` does; and nothing but the proven temp -- the inode this writer
   * filled, still under its name -- is read into it. The cost is the one the
   * issue names: while the copy is filled, a partial file is visible under its
   * final name. A copy that fails part-way is removed, and only while that
   * name still means the file this call created.
   */
  private async publishExclusive(fs: NodeFs, temp: string, target: string, proven: PathStat, size: number, mtime: number): Promise<PathStat> {
    const source = await fs.promises.open(temp, "r");
    let copy: NodeFileHandle | null = null;
    try {
      if (!sameFile(await fstat(source), proven)) throw new VaultPathError("temp_identity");
      copy = await fs.promises.open(target, "wx", 0o600);
      const window = new Uint8Array(Math.max(1, Math.min(size, CHUNK_MAX)));
      for (let at = 0; at < size;) {
        const { bytesRead } = await source.read(window, 0, Math.min(window.length, size - at), at);
        if (bytesRead <= 0) throw new Error("Restore copy ended early.");
        for (let offset = 0; offset < bytesRead;) {
          const { bytesWritten } = await copy.write(window.subarray(offset, bytesRead));
          if (bytesWritten <= 0) throw new Error("Restore write made no valid progress.");
          offset += bytesWritten;
        }
        at += bytesRead;
      }
      await copy.utimes(mtime / 1000, mtime / 1000);
      await copy.sync();
      return await fstat(copy);
    } catch (error) {
      if (copy !== null) {
        const mine = await fstat(copy).catch(() => null);
        await copy.close().catch(() => undefined);
        copy = null;
        if (sameFile(mine, await walker(fs).lstat(target).catch(() => null))) await fs.promises.unlink(target).catch(() => undefined);
      }
      throw error;
    } finally {
      await source.close().catch(() => undefined);
      await copy?.close();
    }
  }

  /**
   * The desktop write, confined at every step.
   *
   * The folder chain is walked before `mkdir` (so nothing is created through
   * a link) and walked again after it (so what was created is what we now
   * hold). The temp file is opened EXCLUSIVE-CREATE, which cannot follow a
   * symlink and cannot open something that already exists, and its
   * descriptor is then compared with a no-follow stat of the name: the
   * descriptor is the file nothing can change, so if the name no longer
   * means the same file, someone raced us and the write is refused. The same
   * comparison runs after the rename, because the rename is the moment the
   * file becomes visible under its real name.
   *
   * THE DESCRIPTOR'S IDENTITY IS READ AT EACH PROOF, NOT KEPT FROM THE OPEN
   * (issue #175). FAT32 and exFAT number a file by its first cluster, and an
   * empty file has none: the temp's inode changes when its first byte is
   * written, so an identity kept from the open refused every write on such a
   * volume. Both sides of each comparison are now taken at the same moment.
   * Where inode numbers are stable, that is the identity kept from the open
   * exactly, so nothing is weaker there; where they move, it is the only
   * identity that describes the file the descriptor holds.
   *
   * THE TEMP IS A HIDDEN NAME (issue #159), so the vault-path rule keeps it
   * out of every listing, publication and index even when a quit leaves it
   * behind; `sweep` removes it at the next start.
   */
  private async desktopWriter(desktop: DesktopVault, path: string): Promise<VaultWriter> {
    const fs = desktop.fs;
    const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (folder !== "") {
      const before = await this.confine(desktop, folder, ["absent", "directory"]);
      await fs.promises.mkdir(before.target, { recursive: true });
      await this.confine(desktop, folder, ["directory"]);
    }
    const { target, chain } = await this.confine(desktop, path, ["absent", "file"]);
    const parent = target.slice(0, target.lastIndexOf(desktop.path.sep));
    const temp = `${parent}${desktop.path.sep}.obsync-write-${hex(randomBytes(8))}.tmp`;
    const handle = await fs.promises.open(temp, "wx");
    this.temps.add(temp);
    let open = true;
    let opened = await fstat(handle);

    /** Close, and remove the temp ONLY while its name still means our file. */
    const discard = async (): Promise<void> => {
      if (open) {
        opened = await fstat(handle);
        await handle.close();
      }
      open = false;
      this.temps.delete(temp);
      if (sameFile(opened, await walker(fs).lstat(temp))) {
        await fs.promises.unlink(temp).catch(() => undefined);
      }
    };
    /**
     * The binding: the chain that was walked must still be the same
     * directories, and the temp name must still mean the file we hold open.
     * Run after the open and before the first byte, and again before the
     * rename, because either syscall can be raced by a swapped parent.
     */
    const bind = async (): Promise<void> => {
      const refusal = (await chainRefusal(chain, walker(fs))) ?? undefined;
      opened = await fstat(handle);
      const swapped = refusal !== undefined || !sameFile(opened, await walker(fs).lstat(temp));
      if (!swapped) return;
      await discard();
      throw new VaultPathError(refusal ?? "temp_identity");
    };
    await bind();
    return {
      write: async (bytes) => {
        await handle.write(bytes);
      },
      commit: async (mtime) => {
        await bind();
        // DURABLE BEFORE IT HAS A NAME (issue #202). A rename is atomic for
        // the name, not for the bytes under it, and closing a file flushes
        // nothing: a filesystem that does not flush on replace-by-rename can
        // come back from a power cut with the note's name on an empty file.
        // So the temp's own descriptor is synced first, and the directory
        // after the rename (`syncFolder`). One more fsync per pulled file.
        await handle.sync();
        await handle.close();
        open = false;
        const seconds = mtime / 1000;
        await fs.promises.utimes(temp, seconds, seconds);
        // The metadata of OUR bytes, read from the inode while it is still
        // under the temp name, because the rename is the last instant at
        // which the name and the bytes are certainly the same thing (round
        // 3, finding 2).
        const wrote = await walker(fs).lstat(temp);
        if (wrote === null) throw new VaultPathError("temp_identity");
        // What an open editor may be given is exactly the bytes renamed into
        // place, read BEFORE the editor is judged: nothing awaits between that
        // judgment and the rename, or typing begun in between is written
        // under (review of dec081c, finding 1).
        let text: string | null;
        let shown: string | null;
        try {
          text = this.views(path).length > 0 ? await fs.promises.readFile(temp, "utf8") : null;
          shown = await this.assertEditorIdle(path);
        } catch (error) {
          await discard();
          throw error;
        }
        await fs.promises.rename(temp, target);
        this.temps.delete(temp);
        await this.syncFolder(fs, parent);
        // The rename is the moment the file takes its real name, so the
        // chain is checked again here: a parent swapped after the last
        // binding would otherwise leave our own inode sitting outside the
        // vault, reachable under a vault path.
        const refusal = await chainRefusal(chain, walker(fs));
        const landed = await walker(fs).lstat(target);
        if (refusal !== null || !sameFile(opened, landed)) {
          // Remove what we put there, or a link planted in its place, and
          // nothing else: a regular file that is not ours may be the user's.
          if (sameFile(opened, landed) || (landed !== null && landed.isSymbolicLink())) {
            await fs.promises.unlink(target).catch(() => undefined);
          }
          throw new VaultPathError(refusal ?? "target_identity");
        }
        // Proven at its name: Obsidian lists it now, with these bytes
        // (`reconcile`). One it reconciles is in no view, so nothing below
        // awaits after the event this may raise, which the caller's echo
        // mark settles.
        await this.reconcile(path, "file", true, true);
        // The rename kept the inode, and the inode is what `sameFile` proves
        // -- but an ordinary in-place save keeps the inode too, so identity
        // alone does not say these are still our bytes. The answer is bound
        // to what was written; the name is only reported on.
        const ours = landed as PathStat;
        if (ours.size !== wrote.size || Math.round(ours.mtimeMs) !== Math.round(wrote.mtimeMs)) {
          this.log("host path_class=file decision=write_superseded");
        } else if (shown !== null && text !== null) {
          await this.refreshEditors(path, shown, text, () => fs.promises.readFile(target, "utf8"));
        }
        return { path, mtime: Math.round(wrote.mtimeMs), size: wrote.size };
      },
      abort: discard,
    };
  }

  /**
   * Rename one entry, refusing rather than replacing (issue #124).
   *
   * WHAT ONLY THE HOST CAN ANSWER. `Team docs/One.md` and `team docs/One.md`
   * are one directory entry on a filesystem that folds case and two on one
   * that does not, and no comparison of the two strings can tell which host
   * this is. Desktop asks the kernel: one no-follow stat per name, and the
   * destination is occupied only when it is a DIFFERENT inode. Mobile has no
   * inode to ask for and reads the destination folder's listing instead
   * (`landing`), which gives the real names on every phone; a phone whose
   * storage folds capitals re-cases through a hidden name (`recase`).
   *
   * The destination folder is created when it is missing, because the device
   * that keeps the two spellings apart has no folder under the new one yet.
   * The old folder is left behind empty; nothing in this version deletes a
   * folder, and an empty one holds no notes.
   */
  async move(from: string, to: string): Promise<MoveResult> {
    assertSyncPath(from, this.plugin.state.data.syncFolders);
    assertSyncPath(to, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    const folder = to.slice(0, Math.max(0, to.lastIndexOf("/")));
    if (desktop === null) {
      const adapter = this.plugin.app.vault.adapter;
      const landing = await this.landing(from, to);
      if (landing !== "free" && landing !== "recase") return landing;
      if ((await this.stat(from)) === null) return "missing";
      if (folder !== "" && !(await adapter.exists(folder))) await adapter.mkdir(folder);
      try {
        await adapter.rename(from, to);
      } catch (error) {
        // Refused for the entry's own other spelling: storage that folds
        // capitals, where only a hidden name in between re-cases it.
        if (landing !== "recase") throw error;
        return await this.recase(from, to, "file");
      }
      return "moved";
    }
    const source = await this.confine(desktop, from, ["absent", "file"]);
    if (source.final === "absent") return "missing";
    const found = await this.confine(desktop, to, ["absent", "file"]);
    if (found.final === "file" && !sameFile(source.stat, found.stat)) return "occupied";
    if (folder !== "") {
      const parent = await this.confine(desktop, folder, ["absent", "directory"]);
      await desktop.fs.promises.mkdir(parent.target, { recursive: true });
    }
    await desktop.fs.promises.rename(source.target, found.target);
    // The name is only ever as true as the directories it was resolved
    // through, and a rename is no exception (`vaultPath.ts`).
    const refusal = await chainRefusal(source.chain, walker(desktop.fs)) ??
      await chainRefusal(found.chain, walker(desktop.fs));
    if (refusal !== null) throw new VaultPathError(refusal);
    await this.reconcile(from, "file", false);
    await this.reconcile(to, "file", true);
    return "moved";
  }

  /**
   * The name this vault really shows for `path` (`sync/engine.ts`).
   *
   * EVERY COMPONENT, NOT THE LAST ONE. `Team docs/One.md` and
   * `team docs/One.md` name one file on a folding volume, and the difference
   * between them is not in the name of the file at all. A caller asking what
   * the vault shows is asking so that it can record THAT, so the answer is
   * built out of the real directory entries from the vault root down.
   *
   * A LOOKUP THAT FINDS NOTHING IS THE ANSWER `null`, and it is also what
   * makes this safe on a volume that keeps the two spellings apart: there the
   * folded twin is a different entry, the lookup by the name that was asked
   * about finds nothing, and no caller is told that some other entry is it.
   * Desktop reads the directories itself; mobile asks the adapter, which is
   * the only view it has, and whose listing gives the real names whatever the
   * host app's version does with a case-sensitive `exists`.
   */
  async spelling(path: string): Promise<string | null> {
    assertVaultPath(path);
    const desktop = this.desktop;
    const segments = path.split("/");
    const out: string[] = [];
    if (desktop === null) {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(path))) return null;
      for (const segment of segments) {
        const at = out.join("/");
        const listed = await adapter.list(at === "" ? "/" : at);
        const names = [...listed.files, ...listed.folders].map((child) => child.slice(child.lastIndexOf("/") + 1));
        const name = soleSpelling(names, segment);
        if (name === null) return null;
        out.push(name);
      }
      return out.join("/");
    }
    // The walk is the lookup, and it refuses a symlink component exactly as
    // every other operation here does.
    const found = await this.confine(desktop, path, ["absent", "file", "directory", "other"]);
    if (found.final === "absent") return null;
    let at = desktop.path.resolve(desktop.base);
    for (const segment of segments) {
      let names: string[];
      try {
        names = await desktop.fs.promises.readdir(at);
      } catch {
        return null;
      }
      const name = soleSpelling(names, segment);
      if (name === null) return null;
      at = desktop.path.resolve(at, name);
      out.push(name);
    }
    return out.join("/");
  }

  /**
   * Rename a FOLDER entry, refusing rather than replacing (`sync/engine.ts`).
   *
   * The same shape as `move` one kind over: the destination is occupied only
   * when a DIFFERENT directory -- a different inode on desktop, a different
   * entry in its folder's listing on mobile -- wears it, because the folded
   * twin of the source IS the source and re-casing it is the whole operation.
   * Nothing is created above the destination: a folder renamed in place keeps
   * the parents it already had, and a destination whose parents are missing
   * is a move this version does not make.
   */
  async moveFolder(from: string, to: string): Promise<MoveResult> {
    // BOTH NAMES BY THE FOLDER RULE, and its case tolerance is what makes a
    // rename of the SELECTED folder expressible at all: one of the two names
    // is the selection and the other is the same directory under the
    // capitalisation this rename gives it or takes from it (`syncScope.ts`).
    assertFolderCaseScope(from, this.plugin.state.data.syncFolders);
    assertFolderCaseScope(to, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop === null) {
      const adapter = this.plugin.app.vault.adapter;
      // The folder's listing and the re-case, exactly as `move` has them.
      const landing = await this.landing(from, to);
      if (landing !== "free" && landing !== "recase") return landing;
      if ((await adapter.stat(from))?.type !== "folder") return "missing";
      try {
        await adapter.rename(from, to);
      } catch (error) {
        if (landing !== "recase") throw error;
        return await this.recase(from, to, "folder");
      }
      return "moved";
    }
    const source = await this.confine(desktop, from, ["absent", "directory"]);
    if (source.final === "absent") return "missing";
    const found = await this.confine(desktop, to, ["absent", "directory"]);
    if (
      found.final === "directory" &&
      (found.stat?.dev !== source.stat?.dev || found.stat?.ino !== source.stat?.ino)
    ) {
      return "occupied";
    }
    await desktop.fs.promises.rename(source.target, found.target);
    // The parents only: the last link of each chain is the directory that has
    // just been renamed, so asking for it by its old name is asking about an
    // entry this call removed.
    const refusal = await chainRefusal(source.chain.slice(0, -1), walker(desktop.fs)) ??
      await chainRefusal(found.final === "directory" ? found.chain.slice(0, -1) : found.chain, walker(desktop.fs));
    if (refusal !== null) throw new VaultPathError(refusal);
    await this.reconcile(from, "folder", false);
    await this.reconcile(to, "folder", true);
    return "moved";
  }

  /**
   * Where `from` may go on a phone (issue #219): `free` for the rename as it
   * always was, `recase` for one entry changing its capitals on storage that
   * folds them -- renamed as always where the host allows that, through a
   * hidden name where it refuses (`recase`) -- or the answer itself.
   *
   * THE FOLDER'S LISTING, NOT `exists(to, true)`. Android's shared storage
   * folds capitals as a Mac does, and there Obsidian's case-sensitive
   * existence check answers for the folded name too: every capitals-only
   * rename sent to an Android device was answered `occupied`, waited beside
   * its name for good, and the device kept the old capitals with nothing said
   * (measured on Android 15, Obsidian 1.13.8). The listing gives the real
   * names on every phone. The destination is taken when an entry there wears
   * EXACTLY its name, or when the name answers through an entry that folds to
   * it and is not the source; the source under other capitals is the entry
   * being renamed, never an obstacle. An entry already wearing the new name,
   * with the old one answering only through it, is a re-case made before
   * whose record is behind: nothing is left to do. A phone that keeps the
   * spellings apart answers nothing for a name no entry wears exactly, so it
   * renames as it always did.
   */
  private async landing(from: string, to: string): Promise<MoveResult | "free" | "recase"> {
    // An entry still under a hidden name is neither where the records say
    // nor where this rename wants it: answered, the caller would download a
    // second copy of it. It waits, as a change that cannot be applied yet.
    await this.settleRecase(true);
    if (this.holds(from) || this.holds(to)) throw new Error("a capitals-only rename of this entry is still being put back");
    const adapter = this.plugin.app.vault.adapter;
    const cut = to.lastIndexOf("/");
    const parent = to.slice(0, Math.max(0, cut));
    const name = to.slice(cut + 1);
    const own = from.slice(0, Math.max(0, from.lastIndexOf("/"))) === parent ? from.slice(from.lastIndexOf("/") + 1) : null;
    const listed = parent === "" || (await adapter.exists(parent)) ? await adapter.list(parent === "" ? "/" : parent) : { files: [], folders: [] };
    const names = [...listed.files, ...listed.folders].map((child) => child.slice(child.lastIndexOf("/") + 1));
    if (names.includes(name)) {
      return own !== null && caseOnly(own, name) && !names.includes(own) && (await adapter.exists(from)) ? "moved" : "occupied";
    }
    if (!(await adapter.exists(to))) return "free";
    const twins = names.filter((candidate) => caseOnly(candidate, name));
    return twins.length === 1 && twins[0] === own ? "recase" : "occupied";
  }

  /**
   * Re-case ONE entry on a phone whose storage folds capitals (issue #219):
   * two of Obsidian's own renames, through a hidden name in the same folder.
   *
   * WHY TWO, AND WHY OBSIDIAN'S. The direct rename, which the caller tried
   * first, is refused there -- `Probe.md` to `probe.md` is "Destination file
   * already exists!" from the adapter and the vault alike, so on Android a
   * name's capitals can only be RECEIVED -- while two renames through a name
   * that folds to nothing else succeed, for a file and for a folder whose
   * children follow. The VAULT's rename is the one that keeps Obsidian's
   * index true: the same two steps through the adapter re-case the disk and
   * leave the index listing both spellings of one file, which a first upload
   * published under two file ids (measured on Android 15, Obsidian 1.13.8).
   *
   * ONE RENAME TO EVERYTHING ELSE. The vault reports two renames, and the
   * first names a hidden path no sync rule admits: it is swallowed, and the
   * second is reported as the one rename `from -> to` (`recased`), so the
   * echo marks, the folder record's order and every record move see what a
   * single native rename produces. Nothing is published, tombstoned or
   * recorded under the hidden name.
   *
   * A STOP IN BETWEEN LEAVES THE ENTRY UNDER A HIDDEN NAME, so the re-case is
   * saved BEFORE the first rename and cleared after the second
   * (`pendingRecase`): the next start puts it back (`settleRecase`), and until
   * then nothing reads its records as deleted (`holds`). A second step that
   * fails is undone at once through the same API, and the answer is
   * `occupied`: the caller keeps the entry under the name it has.
   */
  private async recase(from: string, to: string, kind: "file" | "folder"): Promise<MoveResult> {
    const started = Date.now();
    const state = this.plugin.state;
    const vault = this.plugin.app.vault;
    const refuse = (reason: string): MoveResult => {
      this.log(`vault path_class=${kind} decision=refused reason=${reason} via=temp duration_ms=${Date.now() - started}`);
      return "occupied";
    };
    // Obsidian's rename moves what its index holds, and nothing else.
    const entry = vault.getAbstractFileByPath(from);
    if (entry === null || (kind === "file") !== (entry instanceof TFile)) return refuse("not_indexed");
    // One at a time: a second would overwrite the record of the first.
    if (state.data.pendingRecase !== undefined) return refuse("recase_pending");
    const temp = await this.recaseTemp(from, kind);
    if (temp === null) return refuse("temp_taken");
    state.data.pendingRecase = { from, temp, to };
    await state.save();
    this.recasing.set(temp, { from, to });
    const settle = async (): Promise<void> => {
      delete state.data.pendingRecase;
      await state.save();
    };
    try {
      await vault.rename(entry, temp);
    } catch {
      // Nothing moved: the entry still wears the name its records hold.
      await settle();
      return refuse("temp_step");
    }
    // THE OLD NAME IS RECONCILED BEFORE THE NEW ONE EXISTS. Obsidian's
    // watcher reconciles every name the first step touched a turn after it,
    // and its adapter believes Android's storage keeps capitals apart: run
    // after the second step, that reconcile of `from` finds the entry under
    // `to` and indexes it AGAIN under `from` -- two index entries for one
    // note, the second a ghost whose deletion deletes the note (6 of 20
    // back-to-back re-cases on Android 15 left one, 0 of 20 with this wait).
    // A report later still indexes it all the same, with a `create` (`ghost`).
    await this.caughtUp(temp);
    try {
      await vault.rename(entry, to);
    } catch {
      try {
        await vault.rename(entry, from);
      } catch (error) {
        // Left saved for the next start (`settleRecase`), and the caller
        // fails: whatever asked for this rename asks again.
        this.log(`vault path_class=${kind} decision=failed reason=put_back via=temp duration_ms=${Date.now() - started}`);
        throw error;
      }
      await settle();
      return refuse("second_step");
    }
    await settle();
    this.log(`vault path_class=${kind} decision=recased via=temp duration_ms=${Date.now() - started}`);
    return "moved";
  }

  /**
   * Let Obsidian's own watcher catch up with the storage: it reports a
   * change a turn after it lands and reconciles each name in the adapter's
   * one queue, so a queued call made after that turn returns once they have
   * run.
   */
  private async caughtUp(path: string): Promise<void> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await this.plugin.app.vault.adapter.exists(path);
  }

  /**
   * Take the GHOST of a re-case out of Obsidian's index (issue #219): an
   * index entry under `from` while the entry is `to` and the folder's own
   * listing has no `from`. It reads, writes and deletes the note under `to`
   * on storage that folds capitals, so a person who deletes "the extra copy"
   * deletes the note.
   *
   * No public API removes an index entry without acting on the storage, and
   * every public removal of `from` removes the note. The adapter's own
   * `reconcileDeletion` drops the entry and touches nothing else; it is not
   * part of Obsidian's published API, so it is asked for by name and, where
   * absent, the ghost stays -- exactly as before this -- and that is said once.
   * Its `delete` events are its own (`unindexed`). One at a time: a folder's
   * ghost is reported with every entry under it.
   */
  private async unghost(from: string, to: string): Promise<void> {
    const vault = this.plugin.app.vault;
    const kind = vault.getAbstractFileByPath(to) instanceof TFolder ? "folder" : "file";
    if (this.unghosting.has(from)) return;
    this.unghosting.add(from);
    try {
      await this.caughtUp(to);
      if (vault.getAbstractFileByPath(from) === null || vault.getAbstractFileByPath(to) === null) return;
      const cut = from.lastIndexOf("/");
      const listed = await vault.adapter.list(cut === -1 ? "/" : from.slice(0, cut));
      if ([...listed.files, ...listed.folders].some((child) => child.slice(child.lastIndexOf("/") + 1) === from.slice(cut + 1))) return;
      const adapter = vault.adapter as typeof vault.adapter & { reconcileDeletion?: (realPath: string, path: string, now?: boolean) => Promise<void> };
      if (typeof adapter.reconcileDeletion !== "function") {
        if (!this.ghostKeptTold) this.log(`vault path_class=${kind} decision=fallback reason=no_index_api kept=ghost`);
        this.ghostKeptTold = true;
        return;
      }
      await adapter.reconcileDeletion(from, from, true);
      this.log(`vault path_class=${kind} decision=unindexed reason=ghost`);
    } catch {
      this.log(`vault path_class=${kind} decision=failed reason=unghost`);
    } finally {
      this.unghosting.delete(from);
    }
  }

  /**
   * A `create` for the old name of an entry this session re-cased, while the
   * index still holds it under the new one: a late report of the re-case,
   * never a note of its own. It is taken out of the index (`unghost`) and the
   * engine never hears of it. Nor of the `create` a put-back raises for the
   * name the entry's records already hold (`settleRecase`).
   */
  ghost(path: string): boolean {
    for (const root of this.returning) if (path === root || path.startsWith(`${root}/`)) return true;
    for (const { from, to } of this.recasing.values()) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      if (this.plugin.app.vault.getAbstractFileByPath(to + path.slice(from.length)) === null) continue;
      void this.unghost(from, to);
      return true;
    }
    return false;
  }

  /**
   * Is this `delete` one that taking a ghost out of the index raised
   * (`unghost`)? Never a deletion: on storage that folds capitals the engine
   * would find the note under the ghost's name and take it for a new one.
   */
  unindexed(path: string): boolean {
    for (const from of this.unghosting) if (path === from || path.startsWith(`${from}/`)) return true;
    return false;
  }

  /**
   * A DELETION THROUGH A NOTE'S OTHER SPELLING TAKES THE NOTE (issue #219).
   * On storage that folds capitals, Obsidian's index can list one note under
   * a second spelling -- a ghost -- and deleting that entry deletes the file
   * under both: the ghost's `delete` comes first, the note's own a moment
   * later, once Obsidian notices the file is gone. Published, the second
   * deletes the note on every device, for an entry the person took for a
   * copy.
   *
   * So a `delete` for a name nothing records, whose other spelling IS a
   * recorded note or folder, starts a watch on that note: if the storage no
   * longer has it, the deletion is held back from the other devices and the
   * person is asked, with Restore here and Delete everywhere (`holdTwin`),
   * and its own `delete` never reaches the engine. A storage that keeps the
   * spellings apart still has the note, and the watch ends there. Answers
   * whether the event is one the watch holds.
   */
  twinDeleted(path: string, folder: boolean): boolean {
    const now = Date.now();
    for (const [root, guard] of this.twinGuards) {
      if (guard.until < now) this.twinGuards.delete(root);
      else if (path === root || path.startsWith(`${root}/`)) {
        this.holdTwin(root, guard.via);
        return true;
      }
    }
    const { files, folders } = this.plugin.state.data;
    if ((folder ? folders : files)[path] !== undefined) return false;
    const records = Object.keys(files);
    const tracked = (candidate: string): boolean => folder
      ? folders[candidate] !== undefined || records.some((recorded) => recorded.startsWith(`${candidate}/`))
      : files[candidate] !== undefined;
    if (folder && tracked(path)) return false;
    const twin = (folder ? [...Object.keys(folders), ...records.map((recorded) => recorded.slice(0, path.length))] : records)
      .find((candidate) => caseOnly(candidate, path) && tracked(candidate));
    if (twin === undefined) return false;
    this.twinGuards.set(twin, { via: path, until: now + TWIN_WATCH_MS });
    void this.checkTwin(twin, path, folder);
    return false;
  }

  /** Is the recorded twin still on the storage? If not, its deletion is held (`twinDeleted`). */
  private async checkTwin(twin: string, via: string, folder: boolean): Promise<void> {
    try {
      await this.caughtUp(twin);
      const stat = await this.plugin.app.vault.adapter.stat(twin);
      if (stat !== null && (stat.type === "folder") === folder) {
        this.twinGuards.delete(twin);
        return;
      }
    } catch {
      // Unreadable is not present: the deletion is held, never published.
    }
    this.holdTwin(twin, via);
  }

  /**
   * Hold the deletion of `twin` and everything recorded under it, and ask:
   * the same held set, and the same two answers, as a bulk deletion
   * (`engine.ts`, `holdBurst`), so Restore here puts the note back from the
   * version this device recorded and nothing leaves until the person says.
   *
   * A FOLDER IS ONE QUESTION. Obsidian reports a folder's deletion entry by
   * entry, its notes first, all before any watch has looked, so a note is
   * held and asked about as part of the widest watched folder above it.
   */
  private holdTwin(twin: string, via: string): void {
    for (const [root, guard] of this.twinGuards) {
      if (twin.startsWith(`${root}/`) && guard.until >= Date.now()) [twin, via] = [root, guard.via];
    }
    const state = this.plugin.state;
    const fresh = Object.keys(state.data.files)
      .filter((recorded) => (recorded === twin || recorded.startsWith(`${twin}/`)) && !state.data.heldDeletions.includes(recorded));
    if (fresh.length === 0) return;
    state.data.heldDeletions = [...state.data.heldDeletions, ...fresh];
    void state.save().catch(() => this.log("watch decision=failed reason=state_not_saved"));
    const folder = state.data.files[twin] === undefined;
    this.log(`watch path_class=${folder ? "folder" : "file"} decision=held reason=case_twin_deleted files=${fresh.length} held=${state.data.heldDeletions.length}`);
    this.plugin.engine?.heldAsked();
    this.notify(
      `obsync did not delete "${twin}" from your other devices: it was deleted on this device through "${via}", a ` +
        `second name Obsidian showed for the same ${folder ? "folder" : "note"}. Put it back here with Restore here, or ` +
        "delete it everywhere.",
      [{ kind: "delete_everywhere" }, { kind: "restore_here" }],
    );
  }

  /**
   * A hidden name beside `from` that nothing wears, folded or not: random,
   * absent from the disk and from the index, and ending in the file's own
   * extension so Obsidian keeps it the same kind of file.
   */
  private async recaseTemp(from: string, kind: "file" | "folder"): Promise<string | null> {
    const vault = this.plugin.app.vault;
    const cut = from.lastIndexOf("/") + 1;
    const dot = from.lastIndexOf(".");
    const extension = kind === "file" && dot > cut ? from.slice(dot) : "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const temp = `${from.slice(0, cut)}.obsync-recase-${hex(randomBytes(8))}${extension}`;
      if (vault.getAbstractFileByPath(temp) === null && !(await vault.adapter.exists(temp))) return temp;
    }
    return null;
  }

  /**
   * Put back a re-case this device stopped between its two renames (issue
   * #219): at the start, before the pass that publishes deletions (`sweep`),
   * and before any rename (`landing`), where it is also let go.
   *
   * BACK, NOT FORWARD. Every re-case is the pull applying another device's
   * rename, and whatever asked for it asks again -- the feed does not move
   * past a change it could not apply, and a note waiting beside its name is
   * tried at every scan -- so the entry goes back under the name its records
   * still hold, and the rename is then made the ordinary way, its records
   * moved by the pull that asked. Finished here instead, the start's pass
   * would pair the record with the renamed entry by `(mtime, size)` and
   * publish the rename as this device's own, and a rename is never
   * deduplicated (`push.ts`): a second head beside the version it came from.
   * On storage that folds capitals the two names are one, so there is no
   * forward when the way back is taken.
   *
   * AND HELD UNTIL IT IS ASKED FOR AGAIN (`holds`). A folder put back after
   * the old spelling's tombstone had retired its record is a folder with no
   * record, which the start's pass would publish as new -- and a tombstone
   * for that stale spelling later removes the re-cased folder, empty, on a
   * device that folds capitals. Only the next rename lets it go (`clear`),
   * because that rename is what makes the records right.
   *
   * OBSIDIAN'S INDEX ENDS SHOWING THE ENTRY. While the index still holds the
   * hidden name -- a reload of the plugin -- the vault's own rename moves it,
   * as `recase` did. After Obsidian restarts it does not, because hidden
   * names are not indexed, and the adapter's rename is the only one left; it
   * cannot leave the old spelling behind in the index, because nothing
   * indexed the name it leaves. Either way the index is then asked for the
   * name the entry wears, and one it does not show is not let go.
   *
   * ONE THAT CANNOT BE PUT BACK IS KEPT, never deleted: it stays held, one
   * notice says what to do, and every later start and rename tries again.
   */
  private async settleRecase(clear: boolean): Promise<void> {
    const state = this.plugin.state;
    const pending = state.data.pendingRecase;
    if (pending === undefined) return;
    const started = Date.now();
    const vault = this.plugin.app.vault;
    const { from, temp, to } = pending;
    const kind = ((await vault.adapter.stat(temp)) ?? (await vault.adapter.stat(from)))?.type === "folder" ? "folder" : "file";
    this.recasing.set(temp, { from, to });
    let returned = false;
    let failed: string | null = null;
    try {
      let at: string | null = from;
      if (!(await vault.adapter.exists(temp))) at = await this.spelling(from);
      else if (await vault.adapter.exists(from)) failed = "occupied";
      else {
        // The watcher indexes a name the adapter's rename did not, a turn
        // later, and says so with a `create`: the entry's own name, back
        // where its records are, never a new note or folder (`ghost`).
        this.returning.add(from);
        const entry = vault.getAbstractFileByPath(temp);
        if (entry !== null) await vault.rename(entry, from);
        else await vault.adapter.rename(temp, from);
        returned = true;
      }
      if (at !== null) await this.caughtUp(at);
      if (failed === null && at !== null && vault.getAbstractFileByPath(at) === null) failed = "not_indexed";
    } catch {
      failed = "rename";
    }
    this.returning.delete(from);
    const took = Date.now() - started;
    if (failed !== null) {
      this.log(`vault path_class=${kind} decision=failed reason=${failed} via=temp duration_ms=${took}`);
      if (this.recaseTold) return;
      this.recaseTold = true;
      this.notify(
        `obsync could not finish renaming "${from}" to "${to}" on this device. Nothing was deleted` +
          (failed === "occupied"
            ? `: something else there took that name first, so the ${kind === "folder" ? "folder" : "note"} is kept in the ` +
              `same folder as "${temp.slice(temp.lastIndexOf("/") + 1)}", which Obsidian does not show. Rename the other ` +
              "one, then restart Obsidian to finish."
            : ". Restart Obsidian to finish."),
      );
      return;
    }
    if (returned) this.log(`vault path_class=${kind} decision=returned via=temp duration_ms=${took}`);
    if (!clear) return;
    delete state.data.pendingRecase;
    await state.save();
    if (!returned) this.log(`vault path_class=${kind} decision=recovered via=temp duration_ms=${took}`);
  }

  /**
   * A vault rename as the engine must see it (`recase`): `null` for the step
   * INTO a hidden name, the one rename `from -> to` for the step out of it,
   * nothing at all for a step back to the name it left, and every other
   * rename as it came.
   */
  recased(from: string, to: string): [string, string] | null {
    for (const [temp, { from: source }] of this.recasing) {
      const under = (path: string): string | null => path === temp ? "" : path.startsWith(`${temp}/`) ? path.slice(temp.length) : null;
      if (under(to) !== null) return null;
      const rest = under(from);
      if (rest !== null) return source + rest === to ? null : [source + rest, to];
    }
    return [from, to];
  }

  /**
   * Obsidian's own vault-rooted delete; both path rules are applied first,
   * and on desktop the chain is checked again afterwards. A delete that went
   * somewhere else leaves the file we identified still sitting there, so
   * finding it afterwards is the signal that the name moved under us.
   *
   * AND THE DELETE ITSELF IS A WINDOW. `FileManager.trashFile` is
   * asynchronous and does work of its own -- a vault lookup, the user's
   * "Deleted files" preference, a move into a bin -- before the file stops
   * existing. An editor save can land inside that window, and nothing checked
   * before the call can see it: not the caller's last stat, and not a stat
   * taken on the line above this one. What the removal takes then is bytes
   * that exist on this device and NOWHERE else (round 3, finding 1).
   *
   * AND NO CHECK BINDS A PATH-BASED REMOVAL. Checking the name and then
   * handing that NAME to the vault leaves the vault free to remove whatever
   * is at it when it gets there -- a save that replaces the file inside the
   * removal is unlinked, and the hold, which still has the original inode,
   * happily agrees that nothing changed (round 3, finding 1, third pass).
   * The answer is not another check: it is never to aim the destructive call
   * at a name an editor writes to.
   *
   * So the removal is a MOVE and then a delete of what moved. A caller that
   * says WHICH CONTENT it is removing gets a HOLD -- a second name for that
   * inode, made with `link`, which cannot follow a symlink and cannot
   * replace anything -- and then the vault name is RENAMED to a hidden name
   * of ours. Rename is atomic: it takes whatever inode is at the name at
   * that instant and leaves the name free, so a save landing afterwards
   * creates a fresh file there that this device never touches. What moved is
   * then compared with what was copied, by device and inode as well as by
   * metadata; a mismatch means a replacement moved instead, and it is put
   * BACK under the vault name (or kept beside it) and answered `kept`. Only
   * an entry that matches is handed to the vault's own deletion, from a
   * hidden folder where no editor is writing, under its own name.
   *
   * Mobile has no second name to give, and a filesystem can refuse either
   * primitive. Those devices remove NOTHING and answer `unheld`, which is
   * what `decision=kept reason=unheld` in the log says.
   *
   * AND NOTHING IS REMOVED THROUGH ANOTHER NOTE'S SPELLING (issue #219). On
   * storage that folds capitals a name answers through the entry it folds
   * to, so a removal of `path` where the vault shows that entry as a
   * DIFFERENT recorded note removes that note. It is refused and answered
   * `kept`: the caller keeps its record, and the note stays.
   */
  async trash(path: string, expect?: VaultStat): Promise<TrashResult> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    if (await this.otherNote(path)) return "kept";
    const desktop = this.desktop;
    let found: WalkResult | null = null;
    if (desktop !== null) {
      found = await this.confine(desktop, path, ["absent", "file"]);
      // Nothing here to remove, and so nothing here to preserve either.
      if (found.final === "absent") return "removed";
    } else if (!(await this.plugin.app.vault.adapter.exists(path))) {
      // The same on a phone (issue #234). A note gone from its storage with
      // nobody watching -- the Files app, or Obsidian closed -- still has a
      // record, and a deletion from another device reached the vault's own
      // `.trash`, which throws for a name it cannot find: the page failed,
      // and every read after it failed at the same deletion, for good.
      this.log("host path_class=file decision=absent");
      return "removed";
    }
    if (expect === undefined) {
      await this.remove(path);
      if (desktop !== null && found !== null) await this.proveRemoved(desktop, found);
      return "removed";
    }
    // A removal this device cannot undo is not made. Mobile has no second
    // name to give, and a filesystem can refuse one; either way the file
    // stays exactly where it is and the caller keeps both (round 3,
    // finding 1). A narrowed window is not a closed one.
    const hold = desktop === null || found === null ? null : await this.hold(desktop, found);
    if (hold === null || desktop === null || found === null) {
      this.log("host path_class=file decision=kept reason=unheld");
      return "unheld";
    }
    const verdict = await this.removeHeld(desktop, found, hold, expect, path);
    // The note left by a hidden name, which Obsidian never listed, so the
    // name it had is the one to take out of the listing (`reconcile`).
    if (verdict === "removed") await this.reconcile(path, "file", false);
    return verdict;
  }

  /**
   * Does the vault show `path` as a different recorded note (`trash`)? Asked
   * only when a record differs from `path` by capitals alone, so a removal
   * with no such twin costs no lookup.
   */
  private async otherNote(path: string): Promise<boolean> {
    const files = this.plugin.state.data.files;
    const own = files[path]?.fileId;
    if (!Object.keys(files).some((recorded) => caseOnly(recorded, path) && files[recorded]?.fileId !== own)) return false;
    const shown = await this.spelling(path).catch(() => null);
    if (shown === null || shown === path || files[shown] === undefined || files[shown]?.fileId === own) return false;
    this.log("host path_class=file decision=kept reason=case_twin");
    return true;
  }

  /**
   * The vault's own removal. `FileManager.trashFile` honours the user's own
   * "Deleted files" preference -- system bin, the vault's `.trash`, or
   * permanent deletion -- where `Vault.trash(file, true)` overrode it with
   * the system bin. The file lookup is file-only on purpose: a folder
   * standing where a remote manifest names a file must never be deleted with
   * its contents.
   *
   * A NAME THE VAULT HAS NOT INDEXED GETS THE SAME PREFERENCE. Obsidian
   * indexes no dot-named path, so every bound removal arrives here by a
   * hidden one (`removeHeld`), and through 1.1.2 each was deleted outright
   * whatever the setting said (issue #138). The preference is read where
   * `trashFile` reads it and applied as `Vault.trash` applies it: a system
   * bin that refuses falls back to `.trash`. Only "none" deletes; a value
   * that is absent, unreadable or unknown is the default, the system bin.
   */
  private async remove(path: string): Promise<void> {
    const vault = this.plugin.app.vault;
    const file = vault.getFileByPath(path);
    if (file) {
      await this.plugin.app.fileManager.trashFile(file);
      return;
    }
    const option = (vault as App["vault"] & { getConfig?(key: string): unknown }).getConfig?.("trashOption");
    let bin = "system";
    if (option === "none") {
      await vault.adapter.remove(path);
      bin = "none";
    } else if (option === "local" || !(await vault.adapter.trashSystem(path).catch(() => false))) {
      await vault.adapter.trashLocal(path);
      bin = option === "local" ? "local" : "local reason=system_refused";
    }
    this.log(`host path_class=file decision=trashed bin=${bin}`);
  }

  /** The removal went where it was aimed: the chain held and the file is gone. */
  private async proveRemoved(desktop: DesktopVault, found: WalkResult): Promise<void> {
    const refusal = await chainRefusal(found.chain, walker(desktop.fs));
    if (refusal !== null) throw new VaultPathError(refusal);
    if (sameFile(found.stat, await walker(desktop.fs).lstat(found.target))) {
      throw new VaultPathError("target_identity");
    }
  }

  /**
   * The bound removal: move the file out of the vault's way, prove what
   * moved, and only then delete it -- by the name it moved to.
   *
   * The rename is the whole repair. It is atomic, it takes whatever inode is
   * at the name at that instant, and it leaves the name FREE: an editor that
   * saves a moment later writes a new file there, which this device has no
   * reason to touch and never names to the vault. Every check after it is
   * about a file nothing else can reach.
   *
   * What moved is compared with what the caller copied -- device and inode
   * from the hold, size and modification time from the caller -- because the
   * rename may have moved a REPLACEMENT that landed before it. A replacement
   * holds bytes no version holds, so it goes back under the vault name, or
   * beside it when the name has been taken again, and the answer is `kept`.
   *
   * Only a match is handed to the vault's own deletion, from a hidden folder
   * made for this removal and under the note's own name: hidden, so no
   * editor writes there, and its own name, because that is the name the
   * user's bin shows. Obsidian indexes neither, so `remove` applies the
   * "Deleted files" preference itself (issue #138).
   */
  private async removeHeld(
    desktop: DesktopVault,
    found: WalkResult,
    hold: string,
    expect: VaultStat,
    path: string,
  ): Promise<TrashResult> {
    const fs = desktop.fs;
    const drop = async (): Promise<void> => {
      await fs.promises.unlink(hold).catch(() => undefined);
    };
    const held = await walker(fs).lstat(hold);
    const holds = (stat: PathStat | null): boolean =>
      stat !== null && Math.round(stat.mtimeMs) === expect.mtime && stat.size === expect.size;
    if (held === null) {
      this.log("host path_class=file decision=kept reason=hold_gone");
      return "kept";
    }
    // Into a hidden folder made for this removal alone, under the note's own
    // name: the name is what the user's bin will show it by (issue #138).
    const at = found.target.lastIndexOf(desktop.path.sep);
    const name = `.obsync-gone-${hex(randomBytes(8))}`;
    const folder = `${found.target.slice(0, at)}${desktop.path.sep}${name}`;
    const moved = `${folder}${found.target.slice(at)}`;
    let chain = found.chain;
    try {
      await fs.promises.mkdir(folder, { recursive: false });
      // A directory the vault's deletion is aimed through, so it joins the
      // chain every later proof walks.
      const made = pathStat(await fs.promises.lstat(folder, { bigint: true }));
      chain = [...found.chain, { path: folder, dev: made.dev, ino: made.ino }];
      await fs.promises.rename(found.target, moved);
    } catch {
      // Nothing moved, so nothing is removed and the name is still the
      // user's. A host that cannot make this move cannot make the promise.
      this.log("host path_class=file decision=kept reason=move_refused");
      await fs.promises.rmdir(folder).catch(() => undefined);
      await drop();
      return "unheld";
    }
    const gone = await walker(fs).lstat(moved);
    if (!sameFile(held, gone) || !holds(gone)) {
      this.log(
        `host path_class=file decision=kept reason=${sameFile(held, gone) ? "source_changed" : "source_replaced"}`,
      );
      // Only a put-back that really landed releases the hidden name, and
      // only then is the hold released: while either still names the inode,
      // those bytes are reachable.
      if (await this.putBack(desktop, moved, found.target)) {
        await fs.promises.unlink(moved).catch(() => undefined);
        await fs.promises.rmdir(folder).catch(() => undefined);
        await drop();
      }
      return "kept";
    }
    const refusal = await chainRefusal(chain, walker(fs));
    if (refusal !== null) {
      // Putting a file back through a chain that was swapped under us is how
      // a restore writes outside the vault, so the bytes stay where they are
      // and the refusal is raised.
      this.log("host path_class=file decision=restore_failed reason=chain");
      throw new VaultPathError(refusal);
    }
    // The destructive call, at last, and aimed at a name no editor writes to.
    const slash = path.lastIndexOf("/") + 1;
    await this.remove(`${path.slice(0, slash)}${name}/${path.slice(slash)}`);
    await fs.promises.rmdir(folder).catch(() => this.log("host path_class=folder decision=kept reason=rmdir_refused"));
    // And the hold has the last word, because a rename does not close an
    // editor's DESCRIPTOR: a program that still holds the file open writes
    // through it wherever its name has gone, including between the proof
    // above and the removal, and including between this device's last look
    // at the hold and the unlink that releases it. So the hold is OPENED
    // first: the descriptor keeps the inode alive across its own unlink, and
    // what it says afterwards is still readable. Nothing here is the last
    // name of bytes this device has not published.
    let handle: NodeFileHandle;
    try {
      handle = await fs.promises.open(hold, "r");
    } catch {
      this.log("host path_class=file decision=restore_failed reason=hold_gone");
      return "removed";
    }
    try {
      const after = await fstat(handle);
      if (!holds(after)) {
        // The save reached the inode before the hold was released: it is
        // still named, so it is put back by name, and only a put-back that
        // landed releases the hold.
        if (await this.putBack(desktop, hold, found.target)) {
          this.log("host path_class=file decision=kept reason=restored");
          await drop();
          return "kept";
        }
        this.log("host path_class=file decision=kept reason=held");
        return "kept";
      }
      await fs.promises.unlink(hold).catch(() => undefined);
      // The unlink took the inode's last NAME, not the inode: this
      // descriptor is still open on it, so a save that landed in the
      // meantime is read back here and written out under a name of its own
      // rather than lost with the name.
      const last = await fstat(handle);
      if (holds(last)) return "removed";
      this.log("host path_class=file decision=kept reason=descriptor_save");
      await this.preserve(desktop, handle, found.target, last.size);
      return "kept";
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * The bytes an editor wrote into an inode this device has just unnamed.
   * They exist only behind this descriptor now, so they are read back
   * through it and written to a name of their own -- create-only, like every
   * other publication here, so nothing standing anywhere is replaced.
   */
  private async preserve(
    desktop: DesktopVault,
    handle: NodeFileHandle,
    target: string,
    size: number,
  ): Promise<void> {
    const fs = desktop.fs;
    const bytes = new Uint8Array(size);
    let read = 0;
    while (read < size) {
      const chunk = await handle.read(bytes, read, size - read, read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    for (const name of this.restoreNames(desktop, target)) {
      // `wx` is create-only: a name another program took in the meantime
      // fails the open instead of being written over.
      let out: NodeFileHandle;
      try {
        out = await fs.promises.open(name, "wx");
      } catch {
        continue;
      }
      try {
        await out.write(bytes.subarray(0, read));
        await out.sync();
      } finally {
        await out.close().catch(() => undefined);
      }
      if (name !== target) this.log("host path_class=file decision=kept reason=kept_beside");
      return;
    }
    this.log("host path_class=file decision=restore_failed reason=name_taken");
  }

  /**
   * The vault name first, then visible names beside it. A file the user
   * cannot see is a file they have lost, so the alternatives are numbered
   * rather than one-and-done: the name an editor recreated is exactly the
   * one we are competing with, and it can be taken more than once.
   */
  private restoreNames(desktop: DesktopVault, target: string): string[] {
    const dot = target.lastIndexOf(".");
    const cut = dot > target.lastIndexOf(desktop.path.sep) ? dot : target.length;
    const names = [target];
    for (let attempt = 1; attempt <= 16; attempt++) {
      const suffix = attempt === 1 ? " (obsync kept)" : ` (obsync kept ${attempt})`;
      names.push(`${target.slice(0, cut)}${suffix}${target.slice(cut)}`);
    }
    return names;
  }

  /**
   * The entry that moved was not the one the caller copied, so it holds
   * bytes this device has not published anywhere: it goes back under the
   * vault name it came from. If that name has been taken again in the
   * meantime -- an editor recreating it is exactly why we are here -- the
   * file is kept BESIDE it under a visible name instead, because a file the
   * user cannot see is a file they have lost.
   */
  private async putBack(desktop: DesktopVault, source: string, target: string): Promise<boolean> {
    const fs = desktop.fs;
    for (const name of this.restoreNames(desktop, target)) {
      try {
        // `link` IS the check. Looking first and renaming second asks the
        // filesystem a question whose answer expires: a save can create that
        // name in between, and `rename` replaces it without a word. `link`
        // cannot replace anything, so a name taken in that instant fails the
        // call instead of overwriting the note that took it.
        await fs.promises.link(source, name);
        if (name !== target) this.log("host path_class=file decision=kept reason=kept_beside");
        return true;
      } catch {
        // The next name, or the log line below.
      }
    }
    this.log("host path_class=file decision=restore_failed reason=name_taken");
    return false;
  }

  /**
   * A second NAME for the file about to be removed, beside it in its own
   * directory, so the inode outlives the removal and a save made into it
   * stays readable afterwards. `link` is the only primitive that gives one
   * without following a link and without replacing anything. A filesystem
   * that refuses it -- exFAT, some network mounts, a container that forbids
   * it -- gets no removal at all: `null` here is the whole answer, and the
   * caller keeps both files instead.
   */
  private async hold(desktop: DesktopVault, found: WalkResult): Promise<string | null> {
    const parent = found.target.slice(0, found.target.lastIndexOf(desktop.path.sep));
    const hold = `${parent}${desktop.path.sep}.obsync-hold-${hex(randomBytes(8))}.tmp`;
    try {
      await desktop.fs.promises.link(found.target, hold);
      return hold;
    } catch {
      return null;
    }
  }

  /** Every folder this device may sync, from Obsidian's own file tree. */
  async listFolders(): Promise<string[]> {
    const folders = this.plugin.state.data.syncFolders;
    const out: string[] = [];
    for (const entry of this.plugin.app.vault.getAllFolders(false)) {
      // `inFolderScope` carries the vault-path rule, so a hidden folder and a
      // folder outside the selection are both out, in one check -- and the
      // SELECTED folder itself is in, because a folder record is what carries
      // its creation, its removal and its own rename (`syncScope.ts`).
      if (!inFolderScope(entry.path, folders) || this.holds(entry.path)) continue;
      if (this.desktop !== null) {
        try {
          await this.confine(this.desktop, entry.path, ["directory"]);
        } catch (error) {
          if (!(error instanceof VaultPathError)) throw error;
          this.log(`list decision=not_synced reason=${error.refusal}`);
          this.linkedFolder(error);
          continue;
        }
      }
      out.push(entry.path);
    }
    // Where a re-case in flight holds them, the folders are what their
    // records say, neither fewer nor more (`holds`).
    if (this.plugin.state.data.pendingRecase !== undefined) {
      for (const path of Object.keys(this.plugin.state.data.folders)) {
        if (this.holds(path) && inFolderScope(path, folders)) out.push(path);
      }
    }
    return out;
  }

  /**
   * Make this folder, and anything missing above it.
   *
   * A FILE standing at the path is refused, not replaced: another device's
   * manifest does not get to turn this device's note into a directory. On
   * desktop the walk says so before `mkdir` runs, so nothing is created
   * through a link either; on mobile the adapter is asked what is there.
   */
  async createFolder(path: string): Promise<void> {
    assertFolderScope(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop !== null) {
      const found = await this.confine(desktop, path, ["absent", "directory"]);
      if (found.final === "directory") return;
      await desktop.fs.promises.mkdir(found.target, { recursive: true });
      await this.confine(desktop, path, ["directory"]);
      await this.reconcile(path, "folder", true);
      return;
    }
    const adapter = this.plugin.app.vault.adapter;
    const stat = await adapter.stat(path);
    if (stat !== null) {
      if (stat.type !== "folder") throw new VaultPathError("not_a_directory");
      return;
    }
    await adapter.mkdir(path);
  }

  /**
   * Remove a folder, through the same "Deleted files" preference a file
   * delete honours, when nothing keeps it. The answer is how many entries
   * keep it: `0` once it is gone, and for a folder that was never here.
   *
   * The emptiness question is asked of the FILESYSTEM, not of the vault's
   * synced inventory: a folder holding a hidden file, a file this device does
   * not sync, or another plugin's data still holds something, and
   * `trashFile` on a folder takes everything under it. Desktop reads the
   * directory; mobile asks the adapter, which is all it has.
   *
   * WHAT THE OPERATING SYSTEM WRITES BY ITSELF KEEPS NOTHING (issue #184).
   * Finder leaves `.DS_Store` in every folder it has shown and Explorer leaves
   * `Thumbs.db`, so a folder another device deleted stayed here for good,
   * empty in Obsidian's file list and holding only that. Those names (one
   * list, `vaultPath.ts`, `osJunk`), and only as regular files, go WITH the
   * folder: into the bin with it when Obsidian knows the folder, removed
   * first when the adapter's own non-recursive removal is what is left.
   */
  async trashFolder(path: string): Promise<number> {
    assertFolderScope(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    const adapter = this.plugin.app.vault.adapter;
    let found: WalkResult | null = null;
    const junk: string[] = [];
    let kept = 0;
    if (desktop !== null) {
      found = await this.confine(desktop, path, ["absent", "directory"]);
      if (found.final === "absent") return 0;
      for (const name of await desktop.fs.promises.readdir(found.target)) {
        const entry = desktop.path.resolve(found.target, name);
        if (osJunk(name) && (await walker(desktop.fs).lstat(entry))?.isFile() === true) junk.push(entry);
        else kept++;
      }
    } else {
      if ((await adapter.stat(path))?.type !== "folder") return 0;
      const listed = await adapter.list(path);
      for (const file of listed.files) {
        if (osJunk(file.slice(file.lastIndexOf("/") + 1))) junk.push(file);
        else kept++;
      }
      kept += listed.folders.length;
    }
    if (kept > 0) return kept;
    const folder = this.plugin.app.vault.getFolderByPath(path);
    let unlisted = false;
    if (folder) await this.plugin.app.fileManager.trashFile(folder);
    else if (desktop !== null && found !== null) {
      unlisted = true;
      // NOT THE ADAPTER'S `rmdir(path, false)` ON DESKTOP (issue #266): that is
      // `fs.rm` without `recursive`, which refuses EVERY directory, empty or
      // not, with `EISDIR`. A folder Obsidian has not indexed yet -- one a
      // device paired later made moments ago, replaying the history -- stayed
      // for good, and the page failed. `rmdir(2)` takes the walked directory
      // only while it is empty: an entry that arrived since the listing keeps
      // it, and one already gone is gone.
      for (const file of junk) await desktop.fs.promises.unlink(file);
      try {
        await desktop.fs.promises.rmdir(found.target);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") return 1;
        if (code !== "ENOENT") throw error;
      }
    } else {
      for (const file of junk) await adapter.remove(file);
      await adapter.rmdir(path, false);
    }
    if (junk.length > 0) this.log(`host path_class=folder decision=cleared reason=os_junk files=${junk.length}`);
    if (desktop === null || found === null) return 0;
    // The same proof `trash` takes, one link shorter: the walk's last link IS
    // the folder just removed, so the chain checked here is the parents, and
    // the folder itself must no longer be the directory that was walked.
    const refusal = await chainRefusal(found.chain.slice(0, -1), walker(desktop.fs));
    if (refusal !== null) throw new VaultPathError(refusal);
    const after = await walker(desktop.fs).lstat(found.target);
    if (after !== null && after.isDirectory() && after.dev === found.stat?.dev && after.ino === found.stat?.ino) {
      throw new VaultPathError("target_identity");
    }
    // A folder Obsidian did not list when it was removed (#266) may still be
    // reported by a late or starved file event: tell Obsidian it is gone, as
    // every other removal on disk does (#253). Usually the listing already
    // agrees, and this costs one lookup.
    if (unlisted) await this.reconcile(path, "folder", false);
    return 0;
  }

  /**
   * The text the note's open editors show, which is its file's, or null when
   * none is open; one holding unsaved typing, or being typed in, refuses the
   * write.
   */
  private async assertEditorIdle(path: string): Promise<string | null> {
    // A stable disk stat does not include the keystrokes still waiting in
    // Obsidian's two-second save debounce. Writing under that buffer invokes
    // a second, host-app merge of text obsync has already merged (#135).
    // The file can briefly match the buffer while the host still has an
    // external reload queued. Leave recent trusted typing alone too; the
    // engine retries this note after input settles, without blocking others.
    // Check after downloads and filesystem preparation have waited.
    const open = await this.editing(path);
    if (open === "unsaved" || this.typing(path)) throw new EditorBusy();
    // No await since `editing` compared every view with the file.
    const view = this.views(path)[0];
    return open === null || view === undefined ? null : lines(view.getViewData());
  }

  /**
   * AN EDITOR OBSYNC WROTE UNDER SHOWS WHAT IT WROTE (issue #252).
   * Obsidian loads an outside change into an open note when its file watcher
   * reports one, and a starved watcher reported nothing for minutes: the
   * editor kept the old text, every later version of the note was held as
   * unsaved behind "syncing 1", and a keystroke there would have saved the
   * old text over the new. So each view still showing `shown`, the text every
   * view showed when the write was judged safe, loads the written text, as
   * Obsidian's own reload would. A view typed in since shows something else
   * and is left alone. `TextFileView.data` follows every keystroke (Obsidian
   * 1.13.4), so it can say nothing of typing (live, 2026-09-28).
   *
   * Only while the file still holds exactly what was written: a save of the
   * same size can land after the write, so the file is read and compared,
   * and the loads follow with no await after that read. Each view is judged
   * as it is at its own load, because a load can rebind another leaf. The
   * write has landed and stands: a failure here is logged, never thrown
   * (review of dec081c, finding 3).
   */
  private async refreshEditors(path: string, shown: string, text: string, read: () => Promise<string>): Promise<void> {
    const started = Date.now();
    try {
      const written = lines(text);
      if (lines(await read()) !== written) {
        this.log(`host path_class=file decision=editor_left reason=file_changed duration_ms=${Date.now() - started}`);
        return;
      }
      let views = 0;
      for (const view of this.views(path)) {
        if (view.file?.path !== path) continue;
        const now = lines(view.getViewData());
        if (now !== shown || now === written) continue;
        view.setViewData(written, false);
        views++;
      }
      if (views > 0) this.log(`host path_class=file decision=editor_refreshed views=${views}`);
    } catch (error) {
      const kind = error instanceof Error ? error.name : "unknown";
      this.log(`host path_class=file decision=failed reason=editor_refresh error=${kind} duration_ms=${Date.now() - started}`);
    }
  }

  /** The note's editors. A leaf Obsidian has not loaded yet is not a `MarkdownView` and holds nothing typed. */
  private views(path: string): MarkdownView[] {
    return this.plugin.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path);
  }

  /**
   * Is `path` open in an editor, and does one hold text its file does not
   * (issue #146)?
   *
   * Obsidian writes an editor to its file two seconds after a keystroke
   * (`TextFileView.requestSave`), so until then the newest text is in the
   * editor alone. What a view's save would write is `getViewData`, compared
   * here with the file as the vault reads it, line endings aside: the editor
   * keeps one `\n` for a file that has `\r\n`. Public API only -- the markdown
   * leaves and `MarkdownView` -- identical on desktop and mobile.
   */
  async editing(path: string): Promise<"unsaved" | "saved" | null> {
    const views = this.views(path);
    const file = views[0]?.file;
    if (!file) return null;
    const disk = lines(await this.plugin.app.vault.read(file));
    return views.some((view) => lines(view.getViewData()) !== disk) ? "unsaved" : "saved";
  }

  /** A passive editor does not make plugin writes into human typing (#179). */
  typing(path: string): boolean {
    return this.plugin.app.workspace.getLeavesOfType("markdown").some(({ view }) => {
      if (!(view instanceof MarkdownView) || view.file?.path !== path) return false;
      const input = this.inputAt.get(view);
      return this.composing.get(view) === path ||
        (input?.path === path && Date.now() - input.at < EDITING_WINDOW_MS);
    });
  }

  /** Trusted DOM input covers physical keys, paste, touch keyboards and IME. */
  trackInput(target: Window): void {
    if (this.inputWindows.has(target)) return;
    this.inputWindows.add(target);
    const input = (event: Event): void => {
      if (!event.isTrusted || event.target === null || !("nodeType" in event.target)) return;
      for (const { view } of this.plugin.app.workspace.getLeavesOfType("markdown")) {
        if (!(view instanceof MarkdownView) || !view.file || !view.containerEl.contains(event.target as Node)) continue;
        if (event.type !== "focusout" || this.composing.get(view) === view.file.path) this.inputAt.set(view, { path: view.file.path, at: Date.now() });
        if (event.type === "compositionstart") this.composing.set(view, view.file.path);
        if (event.type === "compositionend" || event.type === "focusout") this.composing.delete(view);
      }
    };
    for (const kind of ["keydown", "beforeinput", "compositionstart", "compositionend", "focusout"] as const) {
      this.plugin.registerDomEvent(target, kind, input, true);
    }
  }

  /**
   * Through the plugin's one notice channel (`notices.ts`), which decides how
   * long a notice stays, whether a setting keeps it to Recent, and keeps ONE
   * held-deletions question on screen at a time: every engine start, Sync now
   * and new burst asks again, and the same question stacked down the screen
   * (owner's rig, 2026-09-27: eight at once). `closeQuestion` takes it away
   * once nothing is held any more.
   */
  notify(notice: SyncNotice | string, actions: NoticeAction[] = []): void {
    this.plugin.notices.show(notice, actions);
  }

  /** Take the held-deletions question off the screen: answered, released, or this plugin unloading. */
  closeQuestion(): void {
    this.plugin.notices.close(HELD);
  }

  log(line: string): void {
    this.plugin.log(line);
  }
}

export default class ObsyncPlugin extends Plugin {
  state!: State;
  transport!: Transport;
  host!: ObsidianHost;
  /** Every notice this plugin shows, and the Recent list (`notices.ts`); it outlives a reload of this instance. */
  readonly notices: NoticeChannel = noticeChannel(this);
  engine: SyncEngine | null = null;
  /** The start and update probe `onload` began and deliberately did not wait for. */
  firstStart: Promise<void> = Promise.resolve();
  /** The newer version the server reports, for the settings tab to name. */
  updateAvailable: string | null = null;
  /**
   * This device's recovery registration met a key it did not register (`409
   * recovery_mismatch`, `registerAccountRecovery`): Show sync status and the
   * settings tab say so until a registration succeeds or the device leaves.
   */
  recoveryMismatch = false;
  /** Its sticky toast, taken down with it: a warning that ended must not stand on screen. */
  private recoveryNotice: Notice | null = null;
  /** Whether this session has already raised the update notice. */
  private updateNotified = false;
  private statusEl: HTMLElement | null = null;
  /** The status at a glance, drawn on the status bar item and, on mobile, a view's header (#156, #209). */
  private readonly indicator = new Indicator();
  /** The header action a phone shows the indicator on, and the view it is in (`placeIndicator`). */
  private mobileIndicator: { el: HTMLElement; view: ItemView } | null = null;
  /** The refusal a phone was last told about in a notice, once each (#209). */
  private noticed: string | null = null;
  /** Show sync status and the settings tab, re-drawn on every status change while open (#156). */
  private readonly watchers = new Set<() => void>();
  /** The Show sync status and Recent dialogs last opened; asked for again while one shows, it comes forward (#269). */
  private statusDialog: StatusModal | null = null;
  private recentDialog: RecentModal | null = null;
  private statusValue: EngineStatus = { kind: "idle" };
  forgottenDevice = false;
  /** A pairing claim waiting for its vault key (issue #153); it signs its own collection. */
  waiting: Waiting | null = null;
  private enrolling = false;
  /** Invalidates continuations from an earlier load, including a load with no engine yet. */
  private lifecycle: object | null = {};
  private stateLoad: Promise<State | null> | null = null;
  /** Retain stopped writers even after the active engine reference is cleared. */
  private readonly engineTeardowns = new Set<Promise<void>>();
  /** Every start under way (`startEngine`): what a leave settles before it revokes (#233). */
  private readonly starts = new Set<Promise<void>>();
  private changingScope = false;
  /** Ends the wait of the folder Save in progress: its Cancel (issue #185). */
  private scopeCancel: AbortController | null = null;
  /** A leave is running: a second press, or a second dialog, is refused (S22). */
  private leaving = false;
  private readonly manualFetches = new Set<Promise<string>>();
  /** The folder renames handled this turn, before and after: their entries' own reports are theirs (`registerVaultEvents`). */
  private renamedFolders: [string, string][] = [];
  private readonly histories = new Set<HistoryBrowser>();
  private restoring: HistoryOperation | null = null;
  private manualRestore: Promise<{ path: string; syncRequested: boolean }> | null = null;
  /**
   * The reconnect a start that could not reach the server left behind: how
   * many starts in a row have failed that way, and the timer for the next
   * one (`null` while that start is running). Absent whenever the engine
   * runs, and whenever it stopped for a reason a later start cannot fix.
   */
  private reconnect: { attempt: number; handle: unknown; timers: Timers; at: number } | null = null;
  /** The timers the transport and the engine run on, on desktop: a hidden window does not slow them (#221). */
  private clock: Clock | null = null;

  get isMobile(): boolean {
    return Platform.isMobile;
  }

  override async onload(): Promise<void> {
    const generation = this.lifecycle = {};
    this.changingScope = false;
    this.teardownEngine();
    // A same-instance reload owns resumption after older writers settle.
    // They may still persist the old State, so wait before taking a snapshot.
    const settling: Promise<unknown>[] = [...this.manualFetches, ...this.engineTeardowns];
    if (this.stateLoad !== null) settling.push(this.stateLoad);
    if (this.state) settling.push(this.state.settled());
    if (this.manualRestore !== null) settling.push(this.manualRestore);
    if (settling.length !== 0) {
      await Promise.allSettled(settling);
      if (!this.isCurrent(generation)) return;
    }
    const loading = this.stateLoad = State.open(this, Platform.isMobile, this.app.secretStorage, (error) => {
      // A newer session of this plugin owns the data file (issue #181). This
      // one stops and says so in the log only: nothing failed here that the
      // user could fix, and the newer session is the one syncing.
      const superseded = error.reason === "superseded";
      if (superseded) this.log("state decision=refused reason=superseded");
      if (!this.isCurrent(generation)) return;
      this.teardownEngine();
      this.cancelHistories();
      if (superseded) return;
      this.log(`state decision=stopped reason=${error.reason}`);
      if (this.statusEl) this.setStatus({ kind: "error", message: error.message });
      new Notice(error.message, 15000);
    }, () => this.isCurrent(generation), dataLease(this.app, this.manifest.id), this.heldReference()).catch((error: unknown) => {
      if (!this.isCurrent(generation)) return null;
      throw error;
    });
    const state = await loading;
    if (this.stateLoad === loading) this.stateLoad = null;
    if (!this.isCurrent(generation) || state === null) return;
    this.state = state;
    // A reload of this instance keeps no question the old host asked.
    this.host?.closeQuestion();
    this.host = new ObsidianHost(this);
    this.clock?.stop();
    const clock = this.clock = Platform.isDesktopApp ? workerClock(pageTimers, (line) => this.log(line)) : null;
    const timers = clock ?? pageTimers;
    const transport: Transport = new Transport({
      request: (request) => {
        state.assertAvailable();
        // Ends the call, never retried (`SessionEnded`, issue #272).
        if (!this.isCurrent(generation) || this.state !== state) throw new SessionEnded();
        return requestUrl(request);
      },
      serverUrl: () => state.data.serverUrl,
      device: () => this.credential(state),
      edgeHeaders: () => state.data.edgeHeaders,
      log: (line) => this.log(line),
      // Only this session's transport speaks for the status bar.
      reachable: (answered) => {
        if (this.transport === transport) this.reachability(answered);
      },
      // An attempt nothing answers is abandoned (#195), and a backoff ends, on time in a hidden window (#221).
      timers,
      sleep: (ms) => new Promise((resolve) => timers.set(resolve, ms)),
    });
    this.transport = transport;
    this.statusEl = this.addStatusBarItem();
    this.indicator.attach(this.statusEl);
    // The indicator is the way in: a click opens what it cannot say (#156).
    this.registerDomEvent(this.statusEl, "click", () => this.showStatus());
    this.setStatus({ kind: "idle" });
    this.addSettingTab(new ObsyncSettingTab(this.app, this));
    // A COPY GETS A WAY TO START (issue #168). It loaded as a device that
    // never paired, so the status bar, the settings tab and every command
    // are here; the tab offers Pair this device and Start fresh.
    if (state.copied) {
      this.log("state decision=not_paired reason=copied_vault");
      new Notice(`obsync: ${COPIED_VAULT} Both are in obsync's settings, under This device.`, 15000);
    }
    // AND A DEVICE A CRASH LEFT WITH NO KEYS the same way in (issue #230).
    if (state.keysLost) {
      const { dataRevision, secretRevision } = state.keysLost;
      this.log(`state decision=recovered reason=credential_behind data_revision=${dataRevision} secret_revision=${secretRevision}`);
      new Notice(`obsync: ${KEYS_LOST} Pair this device is in obsync's settings, under This device.`, 15000);
    }
    // ONE reminder, at the start after a confirmation was skipped, and never
    // a recurring popup: Settings and Show sync status keep saying it
    // quietly until the words are confirmed (issue #170).
    if (state.data.recoveryPhrase === "skipped" && state.data.vrk !== null) {
      state.data.recoveryPhrase = "unconfirmed";
      this.log("phrase decision=reminded");
      new Notice("obsync: your 24-word recovery phrase is not confirmed. Without it and without a paired device this vault cannot be recovered. Open obsync's settings, Vault key, and choose Show and confirm.", 15000);
      void state.save().catch(() => {});
    }

    this.addCommand({ id: "sync-now", name: "Sync now (obsync)", callback: () => void this.syncNow() });
    this.addCommand({ id: "verify-all", name: "Verify all files (obsync)", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "restore-history", name: "Restore from history (obsync)", callback: () => new HistoryModal(this.app, this).open() });
    this.addCommand({
      id: "pair-device",
      name: "Pair a new device (obsync)",
      callback: () => new PairCreateModal(this.app, this).open(),
    });
    this.addCommand({
      id: "pair-this-device",
      name: "Pair this device (obsync)",
      // The fresh device's way in (issue #154); one that syncs is told so, and nothing opens.
      callback: () => {
        const paired = alreadyPaired(this);
        if (paired === null) {
          new PairClaimModal(this.app, this).open();
          return;
        }
        this.log("pairing role=claimant decision=refused reason=already_paired source=palette");
        new Notice(`obsync: ${paired}`, 12000);
      },
    });
    this.addCommand({
      id: "show-recovery-phrase",
      name: "Show recovery phrase (obsync)",
      callback: () => new RecoveryPhraseModal(this.app, this, false).open(),
    });
    this.addCommand({ id: "open-dashboard", name: "Open dashboard (obsync)", callback: () => void this.openDashboard() });
    this.addCommand({ id: "open-setup-guide", name: "Open the setup guide (obsync)", callback: () => this.openSetupGuide() });
    this.addCommand({
      id: "remote-only",
      name: "Show remote-only files (obsync)",
      callback: () => new RemoteOnlyModal(this.app, this).open(),
    });
    this.addCommand({
      id: "status",
      name: "Show sync status (obsync)",
      callback: () => this.showStatus(),
    });
    this.addCommand({
      id: "leave-server",
      name: "Leave this server (obsync)",
      callback: () => new LeaveServerModal(this.app, this, "leave").open(),
    });
    this.addCommand({
      id: "switch-server",
      name: "Switch server (obsync)",
      callback: () => new LeaveServerModal(this.app, this, "switch").open(),
    });
    // A CHOICE WITH FIXED ANSWERS IS A SETTING (owner, 2026-09-29): each answer
    // is a command, so a hotkey can be bound to it, as well as a Settings row
    // and a CLI flag.
    for (const [level, words] of LEVELS) {
      this.addCommand({ id: `notices-${level}`, name: `Notifications: ${words} (obsync)`, callback: () => void this.setNotices({ level }, "palette").catch(() => {}) });
    }
    for (const [merges, words] of MERGES) {
      this.addCommand({ id: `merges-${merges}`, name: `Combined edits: ${words} (obsync)`, callback: () => void this.setNotices({ merges }, "palette").catch(() => {}) });
    }
    this.addCommand({ id: "recent", name: "Show recent sync activity (obsync)", callback: () => this.showRecent() });
    this.registerCli();

    // Use the installation identity for both URI spellings without also
    // claiming the old generic action used by pre-directory installations.
    const pair = (params: Record<string, string>): void => {
      const code = params["code"];
      if (code) new PairClaimModal(this.app, this, code).open();
    };
    this.registerObsidianProtocolHandler(PAIRING_ACTION, pair);
    this.registerObsidianProtocolHandler(`${PAIRING_ACTION}/pair`, pair);

    this.registerVaultEvents();
    this.host.trackInput(window);
    this.registerEvent(this.app.workspace.on("window-open", (_workspaceWindow, opened) => this.host.trackInput(opened)));
    // A phone has no status bar: the indicator follows the view in front (#209).
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.placeIndicator()));
    // The device's own word that something changed is the cheapest signal
    // there is (`wake`): its network is back (`online`, which a laptop lid or
    // a phone leaving a tunnel raises), or the app is in front of the person
    // again -- brought to the foreground or unlocked (`visibilitychange`, the
    // phone's signal), or its window focused (`focus`, the desktop's, and the
    // only one a VPN connected on an already-online machine is followed by:
    // it raises no `online`). Both renderers raise all three.
    this.registerDomEvent(window, "online", () => this.wake("online"));
    this.registerDomEvent(window, "focus", () => this.wake("focus"));
    const page = window.document;
    this.registerDomEvent(page, "visibilitychange", () => {
      if (page.visibilityState === "visible") this.wake("foreground");
    });
    // NEVER AWAITED HERE. Obsidian holds its "Loading plugins…" screen until
    // `onload` returns, and a first start talks to the server: with the
    // server out of reach -- a phone away from a LAN-only setup, a laptop
    // waking before Wi-Fi -- awaiting it kept the whole app on that screen for
    // the transport's retry budget, minutes, with "Reload app in Restricted
    // Mode" as the highlighted way out, which turns every plugin off (seen on
    // an iPhone and on desktops, 2026-09-24). The start reports its own
    // outcome -- offline, a retry, an error -- through the status bar, and
    // the update probe still follows it, only for a load that is still current.
    //
    // AND NOT BEFORE OBSIDIAN HAS LISTED THE VAULT. `onload` can run while
    // the vault is still being indexed, and a start then reconciles against
    // an empty listing: every tracked note looked deleted (held back, with a
    // Confirm that would have published them) and every empty folder WAS
    // published as deleted, on every restart, on 1.1.1 too (2026-09-24
    // battery, X1: `reconcile decision=start budget_files=0`).
    this.firstStart = new Promise<void>((listed) => this.app.workspace.onLayoutReady(() => {
      for (const { view } of this.app.workspace.getLeavesOfType("markdown")) {
        const opened = view.containerEl.ownerDocument.defaultView;
        if (opened !== null) this.host.trackInput(opened);
      }
      this.placeIndicator();
      listed();
    })).then(async () => {
      if (this.state.data.pendingScope !== undefined) await this.finishScopeChange(generation);
      if (this.state.paired) await this.startEngine();
      else this.resumePairing();
      if (this.isCurrent(generation)) void this.checkForUpdate();
    });
  }

  /**
   * The credential reference this vault last opened, in Obsidian's per-vault
   * local storage (issue #168; `Held` in state.ts). Not a secret: the data
   * file names the same reference. Local storage can refuse or throw, and a
   * read that fails counts as "never held" -- the copy path, which writes
   * nothing until the person acts -- never as a reason to sync.
   */
  private heldReference(): Held {
    return {
      holds: (ref) => {
        try { return this.app.loadLocalStorage(HELD_REFERENCE) === ref; } catch { return false; }
      },
      hold: (ref) => {
        try { this.app.saveLocalStorage(HELD_REFERENCE, ref); } catch { this.log("held decision=failed reason=local_storage_unwritable"); }
      },
    };
  }

  override onunload(): void {
    this.lifecycle = null;
    // A question this load asked is not left on screen for the next load to ask again.
    this.host?.closeQuestion();
    this.cancelHistories();
    this.teardownEngine();
    this.clock?.stop();
    this.clock = null;
    this.mobileIndicator?.el.remove();
    this.mobileIndicator = null;
    this.indicator.stop();
    this.watchers.clear();
  }

  /**
   * WHERE A PHONE SHOWS THE INDICATOR (#209). Obsidian's mobile app hides the
   * status bar, and ribbon actions there live in a menu that has to be opened,
   * so nothing on a phone said what obsync was doing outside Settings. The
   * header of the view in front is on screen whenever a note is: the
   * indicator is an action there, the same icon and states as the desktop
   * item, and a tap opens Show sync status. It moves with the view in front.
   */
  private placeIndicator(): void {
    if (!Platform.isMobile) return;
    const view = this.app.workspace.getActiveViewOfType(ItemView);
    if (this.mobileIndicator?.view === view) return;
    if (this.mobileIndicator !== null) {
      this.indicator.detach(this.mobileIndicator.el);
      this.mobileIndicator.el.remove();
      this.mobileIndicator = null;
    }
    if (view === null) return;
    const el = view.addAction("refresh-cw", "Show sync status (obsync)", () => this.showStatus());
    this.mobileIndicator = { el, view };
    this.indicator.attach(el);
  }

  /** Show sync status: from the indicator, the palette, and a phone's view header (#156). */
  showStatus(): void {
    this.statusDialog = this.oneDialog(this.statusDialog, () => new StatusModal(this.app, this), "status");
  }

  /** Every notice this session, newest first, shown or kept quiet (`notices.ts`). */
  showRecent(): void {
    this.recentDialog = this.oneDialog(this.recentDialog, () => new RecentModal(this.app, this), "recent");
  }

  /** One dialog, however often it is asked for (#269): the one showing comes forward, or a new one opens. */
  private oneDialog<D extends StatusModal | RecentModal>(showing: D | null, make: () => D, name: string): D {
    if (showing?.isShown() === true) {
      this.log(`${name} decision=forward reason=already_open`);
      showing.forward();
      return showing;
    }
    const dialog = make();
    dialog.open();
    return dialog;
  }

  /** Open a note Recent names; one no longer at that name is said to be so. */
  openNote(path: string): void {
    const file = this.app.vault.getFileByPath(path);
    if (file === null) {
      this.log("recent decision=refused reason=not_at_that_name");
      this.notices.show({ kind: "confirm", text: "{notes} is no longer at that name: it was renamed, moved or deleted since.", paths: [path] });
      return;
    }
    void this.app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * Set what this device shows as a notice, from Settings, the palette or the
   * CLI, and keep it (`ObsyncData.notices`). The palette's answer is said in a
   * notice; Settings shows it in its field and the CLI prints it.
   */
  async setNotices(change: Partial<NoticeSettings>, source: "settings" | "palette" | "cli"): Promise<NoticeSettings> {
    const started = Date.now();
    const previous = this.state.data.notices;
    const next: NoticeSettings = { ...previous, ...change };
    this.state.data.notices = next;
    try {
      await this.state.save();
    } catch (error) {
      // Not kept is not set: the notices go on as the person last saved them.
      this.state.data.notices = previous;
      this.log(`notices decision=failed reason=save source=${source} duration_ms=${Date.now() - started}`);
      throw error;
    }
    this.log(`notices decision=changed level=${next.level} merges=${next.merges} source=${source} duration_ms=${Date.now() - started}`);
    if (source === "palette") this.notices.show({ kind: "confirm", text: this.noticeWords(next) });
    return next;
  }

  /** "notifications: Everything useful; combined edits: Once per note." */
  private noticeWords(settings: NoticeSettings): string {
    const words = (options: readonly [string, string][], value: string): string => options.find(([option]) => option === value)?.[1] ?? value;
    return `notifications: ${words(LEVELS, settings.level)}; combined edits: ${words(MERGES, settings.merges)}.`;
  }

  /**
   * OBSIDIAN'S COMMAND LINE (1.12.2 and later): `<id>:notices` shows the
   * notice settings or sets them, `<id>:recent` shows Recent, `<id>:status`
   * what Show sync status says. Words for a person by default; `format=json`
   * prints the documented object instead, and a refusal as
   * `{"error":{"code","message"}}` (`docs/architecture.md` 6.4). Nothing
   * printed carries an id, key or code (`scrub`). A host that refuses a
   * registration -- one without a command line -- is logged, and the plugin
   * runs on without it.
   */
  private registerCli(): void {
    const format: CliFlag = { value: "text|json", description: "Output format (default: text)" };
    const commands: [string, string, CliFlags, (params: CliData) => CliAnswer | Promise<CliAnswer>][] = [
      ["notices", "Show or set obsync notifications", {
        level: { value: LEVELS.map(([value]) => value).join("|"), description: "What obsync notifies about" },
        merges: { value: MERGES.map(([value]) => value).join("|"), description: "When it notifies about combined edits" },
        format,
      }, (params) => this.noticesCli(params)],
      ["recent", "Show recent obsync notices, newest first", { format }, () => this.recentCli()],
      ["status", "Show obsync sync status", { format }, () => this.statusCli()],
    ];
    for (const [command, description, flags, answer] of commands) {
      const usage = `${command} takes ${Object.entries(flags).map(([name, flag]) => `${name}=${flag.value ?? ""}`).join(", ")}.`;
      const handler: CliHandler = async (params) => {
        const started = Date.now();
        const json = params["format"] === "json";
        try {
          if (Object.keys(params).some((flag) => !Object.hasOwn(flags, flag))) throw new CliRefusal("unknown_flag", `That is not an option here: ${usage}`);
          if (!json && params["format"] !== undefined && params["format"] !== "text") throw new CliRefusal("unknown_value", usage);
          const result = await answer(params);
          this.log(`cli decision=answered command=${command} format=${json ? "json" : "text"} duration_ms=${Date.now() - started}`);
          return scrub(json ? JSON.stringify(result.json) : result.text);
        } catch (error) {
          const refusal = error instanceof CliRefusal ? error : new CliRefusal("failed", "obsync could not do that; its log in Obsidian's developer console says why.");
          this.log(`cli decision=refused reason=${refusal.code} command=${command} duration_ms=${Date.now() - started}`);
          if (json) return JSON.stringify({ error: { code: refusal.code, message: refusal.message } });
          throw new Error(refusal.message);
        }
      };
      try {
        this.registerCliHandler(`${this.manifest.id}:${command}`, description, flags, handler);
      } catch (error) {
        this.log(`cli decision=refused reason=${error instanceof Error ? error.name : "unknown"} command=${command}`);
      }
    }
  }

  /** `{"level","merges"}`, set first from `level=` and `merges=` when given. */
  private async noticesCli(params: CliData): Promise<CliAnswer> {
    const pick = <T extends string>(options: readonly [T, string][], name: string): T | undefined => {
      const value = params[name];
      if (value === undefined) return undefined;
      const found = options.find(([option]) => option === value);
      const values = options.map(([option]) => option);
      if (found === undefined) throw new CliRefusal("unknown_value", `${name} takes ${values.slice(0, -1).join(", ")} or ${values.at(-1) ?? ""}.`);
      return found[0];
    };
    const level = pick(LEVELS, "level"), merges = pick(MERGES, "merges");
    let now = this.state.data.notices;
    if (level !== undefined || merges !== undefined) {
      now = await this.setNotices({ ...level === undefined ? {} : { level }, ...merges === undefined ? {} : { merges } }, "cli");
    }
    const words = (options: readonly [string, string][], value: string): string => options.find(([option]) => option === value)?.[1] ?? value;
    return {
      text: `Notifications: ${words(LEVELS, now.level)} (level=${now.level})\nCombined edits: ${words(MERGES, now.merges)} (merges=${now.merges})`,
      json: { level: now.level, merges: now.merges },
    };
  }

  /** Recent, newest first: `[{"time","kind","note_title","device","text"}]`. */
  private recentCli(): CliAnswer {
    const entries = this.notices.recent();
    return {
      text: entries.length === 0 ? "Nothing since obsync started." : entries.map((entry) => `${stamp(entry.at)}  ${entry.text}`).join("\n"),
      json: entries.map((entry) => ({
        time: new Date(entry.at).toISOString(),
        kind: entry.kind,
        note_title: entry.paths.length === 1 ? titles(entry.paths)[0] ?? null : null,
        device: entry.device ?? null,
        text: entry.text,
      })),
    };
  }

  /** What Show sync status says, without the device id. */
  private statusCli(): CliAnswer {
    const data = this.state.data;
    const server = data.serverUrl === "" ? null : data.serverUrl;
    const device = data.deviceId === null ? null : this.deviceName();
    const counts = {
      files_tracked: Object.keys(data.files).length,
      remote_only: Object.keys(data.remoteOnly).length,
      waiting_to_be_written: Object.keys(data.parked).length,
      paused: Object.keys(data.paused).length,
    };
    return {
      text: [
        `State: ${this.statusText()}`,
        `Server: ${server ?? "not configured"}`,
        `This device: ${device ?? "not paired"}`,
        `Vault key: ${data.vrk === null ? "absent" : "present"}`,
        `Files tracked: ${counts.files_tracked}`,
        `Remote only: ${counts.remote_only}`,
        `Waiting to be written: ${counts.waiting_to_be_written}`,
        `Paused: ${counts.paused}`,
      ].join("\n"),
      json: { state: this.shown().kind, text: this.statusText(), server, device, has_vault_key: data.vrk !== null, ...counts },
    };
  }

  private registerVaultEvents(): void {
    const vault = this.app.vault;
    this.registerEvent(
      vault.on("create", (file: TAbstractFile) => {
        // The old spelling of a re-cased entry, indexed again (issue #219).
        if (this.host?.ghost(file.path)) return;
        if (file instanceof TFile) this.engine?.changed(file.path);
        else if (file instanceof TFolder) this.engine?.folderCreated(file.path);
      }),
    );
    this.registerEvent(
      vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile) this.engine?.changed(file.path);
      }),
    );
    this.registerEvent(
      vault.on("delete", (file: TAbstractFile) => {
        // A note deleted through its ghost is not a deletion the other
        // devices hear of until the person says, and a ghost taken out of
        // the index is not one at all (issue #219). The watch comes first, so
        // it holds the note whatever raised the event.
        if (this.host?.twinDeleted(file.path, file instanceof TFolder) || this.host?.unindexed(file.path)) return;
        if (file instanceof TFile) this.engine?.deleted(file.path);
        else if (file instanceof TFolder) {
          for (const path of this.pathsUnder(file.path)) this.engine?.deleted(path);
          // The folder's own record, and every record beneath it: the files
          // going is what empties the tree, the records going is what removes
          // it from the other devices (issue #104). They wait with the notes,
          // which may yet turn out to have moved (issue #139).
          for (const path of this.foldersUnder(file.path)) this.engine?.folderVanished(path);
        }
      }),
    );
    this.registerEvent(
      vault.on("rename", (file: TAbstractFile, renamedFrom: string) => {
        // A RE-CASE THROUGH A HIDDEN NAME IS ONE RENAME (issue #219): its step
        // into that name is nothing, and its step out is `from -> to`
        // (`ObsidianHost.recase`), so nothing below ever sees the hidden name.
        const moved: [string, string] | null = this.host === undefined
          ? [renamedFrom, file.path]
          : this.host.recased(renamedFrom, file.path);
        if (moved === null) return;
        const [oldPath, path] = moved;
        // ONE FOLDER RENAME, ONE RENAME HERE. Obsidian reports a `rename` for
        // the folder and then one for every entry under it (read off Android
        // Obsidian 1.13.8), and the folder's own is already carried to them all
        // (`renamedFolder`, `folderRenamed`). Taken again, the entries' reports
        // found the echo marks of a re-case this device only APPLIED spent by
        // the folder's, and published its moves and its subfolders' records
        // back as this device's own: a second head per note (#219, live run).
        if (this.renamedFolders.some(([before, after]) => oldPath.startsWith(`${before}/`) && path === after + oldPath.slice(before.length))) return;
        if (file instanceof TFile) {
          this.engine?.renamed(oldPath, path);
        } else if (file instanceof TFolder) {
          // Its entries' reports follow in the same turn (`renamedFolders`).
          if (this.renamedFolders.length === 0) window.setTimeout(() => { this.renamedFolders = []; }, 0);
          this.renamedFolders.push([oldPath, path]);
          // ORDER IS PART OF THE WIRE CONTRACT (issue #124, `docs/protocol.md`).
          // A folder renamed by capitalisation ALONE is one directory entry on
          // a host that folds case, and the receiving device can re-case that
          // entry only from the FOLDER record: a per-file move cannot, because
          // `rename(2)` resolves the directory components of its destination
          // and leaves their spelling alone. So the folder record goes FIRST
          // there, and the moves under it then find a directory already
          // spelled the new way and settle without a rename of their own.
          //
          // Every OTHER rename keeps the old order: the old folder must be
          // emptied by the moves before its tombstone, or the receiving device
          // keeps a folder it was told to remove.
          //
          // `renamedFolder` covers the records AND the work still pending for
          // them, which is more than a listing of tracked paths can reach, and
          // a selected folder takes the selection with it.
          //
          // THE SELECTION IS CAPTURED ONCE, HERE, BEFORE EITHER HALF RUNS.
          // Both halves move the selection with the folder, and each judges a
          // path by the selection in force on ITS OWN side of the move -- an
          // old name against the selection before, a new one against the
          // selection after. Whichever half runs first is the one that moves
          // it, so a half that read the selection for itself would judge every
          // old name against the one the rename LEAVES BEHIND: out of scope,
          // so every note under a renamed SELECTED folder was published as a
          // new file with a new id, its old id never retired, and the scan
          // re-offered the rename every 30 s for good (review round 2, finding
          // 1). Capturing it here is what makes the two orders below differ in
          // what they SEND and not in what they judge (`sync/engine.ts`).
          const before = this.state.data.syncFolders;
          if (caseOnly(oldPath, path)) {
            this.engine?.folderRenamed(oldPath, path, before);
            this.engine?.renamedFolder(oldPath, path, before);
          } else {
            this.engine?.renamedFolder(oldPath, path, before);
            this.engine?.folderRenamed(oldPath, path, before);
          }
        }
      }),
    );
  }

  private pathsUnder(folder: string): string[] {
    const prefix = `${folder}/`;
    // A dropped write's empty file may have only its mark (#242).
    const { files, dropped } = this.state.data;
    return [...new Set([...Object.keys(files), ...Object.keys(dropped)])].filter((path) => path.startsWith(prefix));
  }

  /** The folder itself and every folder record beneath it, deepest first. */
  private foldersUnder(folder: string): string[] {
    const prefix = `${folder}/`;
    return Object.keys(this.state.data.folders)
      .filter((path) => path.startsWith(prefix))
      .sort((a, b) => b.length - a.length)
      .concat(folder);
  }

  // --- lifecycle ---------------------------------------------------------

  private isCurrent(generation: object | null): boolean {
    return generation !== null && generation === this.lifecycle;
  }

  private teardownEngine(): void {
    // Unload, reload and a failed state write all come through here, and a
    // retry that outlived any of them would start an engine nobody asked for.
    this.cancelReconnect();
    const engine = this.engine;
    if (engine === null) return;
    this.engine = null;
    engine.stop();
    // stopAndWait drains in-flight work before its final State save. That save
    // may reject after a storage failure; retain the drain until it settles.
    const teardown = Promise.resolve().then(() => engine.stopAndWait()).catch((error: unknown) => {
      if (error instanceof StateStorageError && error.reason === "superseded") return;
      this.log("engine decision=stopped reason=teardown_save_failed");
    });
    this.engineTeardowns.add(teardown);
    void teardown.then(() => this.engineTeardowns.delete(teardown));
  }

  /** Bind asynchronous enrollment/recovery work to the session that issued it. */
  captureSession(): { state: State; transport: Transport; assertCurrent: () => void } {
    const generation = this.lifecycle, state = this.state, transport = this.transport;
    const serverUrl = state.data.serverUrl;
    const assertCurrent = (): void => {
      state.assertAvailable();
      if (!this.isCurrent(generation) || this.state !== state || this.transport !== transport || state.data.serverUrl !== serverUrl) {
        throw new Error("The previous plugin session is inactive. Its one-time response was not adopted; check the existing enrollment before trying again.");
      }
    };
    assertCurrent();
    return { state, transport, assertCurrent };
  }

  /**
   * Why this vault may not sync at all, or `null`: it sits inside another
   * vault that has this plugin (issue #180, `ObsidianHost.enclosingVault`).
   * Syncing both copies the outer vault into this one, and this one back into
   * the outer, one level deeper each time. Asked before first-time setup,
   * before a pairing claim (typed or from a link), and before every engine
   * start, so a vault paired before this check existed stops too. Desktop
   * only; `role` names the asker in the one line a refusal logs.
   */
  async nestedRefusal(role: string): Promise<string | null> {
    const started = Date.now();
    const outer = await this.host.enclosingVault();
    if (outer === null) return null;
    this.log(`${role} decision=refused reason=nested_vault duration_ms=${Date.now() - started}`);
    return `This folder is inside the synced vault "${outer}". Syncing it too would copy that vault into itself. ` +
      "Open the outer vault instead, or use Selected folders there.";
  }

  /** Start sync, or start it again; kept while it runs, so a leave can settle it first (#233). */
  startEngine(): Promise<void> {
    const start = this.startEngineOwned();
    this.starts.add(start);
    const settled = (): void => { this.starts.delete(start); };
    void start.then(settled, settled);
    return start;
  }

  private async startEngineOwned(): Promise<void> {
    const generation = this.lifecycle;
    if (!this.isCurrent(generation) || !this.state.paired || this.forgottenDevice || this.changingScope || this.restoring !== null) return;
    const started = Date.now();
    // STILL WANTED AFTER EVERY WAIT, NOT ONLY BEFORE THE FIRST (#233). A
    // leave, a folder change, a restore, a revoke or an unload that began
    // while this start waited stopped the engine it found -- or found none
    // yet -- and an engine this start made or started after that outlived
    // it: requests under a revoked credential, a feed retrying every 5 s with
    // no server. So each step asks again whether this start is wanted and
    // `engine` is still the one; one that is not goes no further, and says so
    // in one line. What it made, whoever superseded it has stopped.
    const wanted = (engine: SyncEngine | null): boolean =>
      this.isCurrent(generation) && !this.changingScope && this.restoring === null && !this.leaving && this.engine === engine;
    const superseded = (): void => this.log(`engine decision=stopped reason=superseded duration_ms=${Date.now() - started}`);
    // Whoever asked for this start owns it: a reconnect still pending would
    // be a second engine, so its timer is taken here and its count carried,
    // and the start below either closes the cycle or continues it.
    this.takeReconnectTimer();
    this.cancelHistories();
    const previous = this.engine;
    await previous?.stopAndWait();
    if (!wanted(previous)) return superseded();
    const engine: SyncEngine = new SyncEngine({
      state: this.state,
      transport: this.transport,
      host: this.host,
      timers: this.clock ?? pageTimers,
      onStatus: (status) => {
        if (this.engine === engine) this.setStatus(status);
      },
    });
    this.engine = engine;
    try {
      // Before anything is sent, and a refusal like any other below: the
      // status says why until the person acts, and no timer retries it. The
      // notice comes once, as the status turns to it.
      const nested = await this.nestedRefusal("engine");
      if (!wanted(engine)) return superseded();
      if (nested !== null) {
        if (this.statusValue.kind !== "error" || this.statusValue.message !== nested) new Notice(`obsync: ${nested}`, 15000);
        throw new Error(nested);
      }
      await engine.start();
      if (!wanted(engine)) return superseded();
      if (this.reconnect !== null) {
        this.log(`engine decision=resumed attempt=${this.reconnect.attempt}`);
        this.reconnect = null;
      }
      // A START THAT GOT THROUGH ENDS WHATEVER AN EARLIER ONE SAID (#155): the
      // cycle's `offline`, and an error a relaunch after a revoke, a rebuilt
      // server or a wrong address left standing for as long as nothing spoke.
      // A quiet start emits nothing of its own, so the engine is asked; what
      // the new engine already said is its own, and stands.
      const earlier = this.statusValue.kind;
      if (earlier === "error" || earlier === "offline") this.setStatus(engine.current());
      await this.registerAccountRecovery();
    } catch (error) {
      if (this.engine !== engine) { engine.stop(); return; }
      const attempt = (this.reconnect?.attempt ?? 0) + 1;
      this.teardownEngine();
      if (!unreachable(error)) {
        // A refusal, or a local fault: visible until the person acts, and
        // never knocked on again by a timer (issue #129).
        const code = error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown";
        this.log(`engine decision=stopped reason=start_failed code=${code}`);
        // The one mapping the running engine uses (#155); a local fault is
        // worded where it was raised, and a refusal no row names is said in
        // words, its code left in the line above.
        // Never asked again by a timer, so what clears elsewhere ends in what to
        // press (`AFTER_START`), not in a promise that it resumes.
        this.setStatus(refusalStatus(error, AFTER_START) ?? {
          kind: "error",
          message: error instanceof ApiError ? START_REFUSED : error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.scheduleReconnect(attempt, error.status);
      // Retried like absence, and said as what it is (`refusalStatus`).
      this.setStatus(refusalStatus(error) ?? { kind: "offline" });
    }
  }

  /**
   * Arm the next start after one the server could not be reached for: the
   * `attempt`-th in a row, so the pause doubles from `RECONNECT_START_MS` and
   * holds at `RECONNECT_CAP_MS` for as long as the outage lasts. A background
   * reconnect, not a failure budget: it never gives up on its own.
   */
  private scheduleReconnect(attempt: number, status: number): void {
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_START_MS * 2 ** (attempt - 1));
    // On the plugin's clock, which a hidden desktop window does not slow
    // (issue #221): a reconnect a minute late is a minute of edits held back.
    // Kept beside the handle, so the clock that armed it disarms it.
    const timers = this.clock ?? pageTimers;
    this.reconnect = { attempt, handle: timers.set(() => this.retryNow("timer"), delay), timers, at: Date.now() + delay };
    this.log(`engine decision=retry_scheduled attempt=${attempt} delay_ms=${delay} status=${status}`);
  }

  /** Disarm the pending reconnect timer, keeping the count. Whether one was armed. */
  private takeReconnectTimer(): boolean {
    const pending = this.reconnect;
    if (pending === null || pending.handle === null) return false;
    pending.timers.clear(pending.handle);
    pending.handle = null;
    return true;
  }

  /** Run the pending reconnect now -- the timer's own turn, or the device saying its network is back. */
  private retryNow(reason: string): void {
    if (!this.takeReconnectTimer()) return;
    this.log(`engine decision=retrying attempt=${this.reconnect?.attempt ?? 0} reason=${reason}`);
    void this.startEngine();
  }

  /**
   * Retry now whatever waits on a timer armed before the device said
   * something changed (#134, #186, #195): requests asleep in the transport's
   * backoff, the feed's pause and a stale long poll, and a pending reconnect.
   * Each is at most one early attempt per call, so a storm of events is not a
   * loop.
   */
  wake(reason: string): void {
    this.transport.wake(reason);
    this.engine?.wake(reason);
    this.retryNow(reason);
  }

  /** Drop the pending reconnect, timer and count: the next failure opens a new cycle. */
  private cancelReconnect(): void {
    this.takeReconnectTimer();
    this.reconnect = null;
  }

  async restartEngine(): Promise<void> {
    await this.startEngine();
  }

  /**
   * Sync now ALWAYS ANSWERS, once (#182): it said nothing at all, so a press
   * against a server that was off looked ignored. A server that is not
   * answering is said at once, and the retry goes on in the background;
   * otherwise the press answers when its work is done -- what it sent, that
   * nothing needed sending, or what stopped it.
   *
   * `everything` is "Verify all files" (#197): the same press, reading every
   * file's contents however large, and answered with how many files it read
   * and what it found.
   */
  async syncNow(everything = false): Promise<void> {
    if (this.changingScope || this.restoring !== null) return;
    const away = this.shown().kind === "offline";
    if (away) {
      this.wake("sync_now");
      new Notice(`obsync: ${NOT_ANSWERING}`);
    }
    let sent = 0;
    let checked = 0;
    const running = this.engine;
    if (!running) await this.startEngine();
    if (everything && this.engine) ({ checked, sent } = await this.engine.verifyAll());
    else if (running) sent = (await running.syncNow()) ?? 0;
    if (away) return;
    const status = this.shown();
    const files = `${checked} file${checked === 1 ? "" : "s"}`;
    // Deletions still held: the question the press raised about them is its
    // answer, and "up to date" beside it would be false (the rig, 2026-09-27).
    // Asked of the engine, which an unload has taken away, never of the state.
    const answer = status.kind === "offline" ? `obsync: ${NOT_ANSWERING}`
      : status.kind === "error" ? `obsync: ${status.message}`
      : everything ? `obsync: checked ${files}; ${sent > 0 ? `${sent} had changed and ${sent === 1 ? "was" : "were"} sent` : "none had changed"}.`
      : sent > 0 ? `obsync: sent ${sent} change${sent === 1 ? "" : "s"}.`
      : (this.engine?.context?.state.data.heldDeletions.length ?? 0) > 0 ? null : "obsync: nothing to send; this device is up to date.";
    if (answer !== null) new Notice(answer);
  }

  /** Resume in Show sync status: sync one paused note again (issue #179). */
  async resumeNote(fileId: string): Promise<void> {
    await this.engine?.resume(fileId, "status");
  }

  syncContext(): SyncContext | null {
    return this.changingScope || this.restoring !== null ? null : this.engine?.context ?? null;
  }

  private cancelHistories(): void {
    for (const browser of [...this.histories]) this.closeHistory(browser);
  }

  openHistory(newestFirst = true): HistoryBrowser {
    const context = this.syncContext();
    if (!context) throw new Error("Start sync on this paired device before opening history.");
    const generation = this.lifecycle;
    const engine = this.engine;
    const { deviceId, vrk, serverUrl } = this.state.data;
    const operation: HistoryOperation = new HistoryOperation(() => this.isCurrent(generation) && this.engine === engine &&
      !this.changingScope && (this.restoring === null || this.restoring === operation) &&
      this.state.data.deviceId === deviceId && this.state.data.vrk === vrk && this.state.data.serverUrl === serverUrl);
    const browser = new HistoryBrowser(context, operation, { newestFirst });
    this.histories.add(browser);
    // The transport's manual read slot is held for as long as the dialog is
    // open, so the repair tick yields to it instead of colliding (#103).
    this.transport.openManual();
    return browser;
  }

  closeHistory(browser: HistoryBrowser): void {
    browser.operation.cancel();
    if (this.histories.delete(browser)) this.transport.closeManual();
  }

  restoreHistory(browser: HistoryBrowser, entry: HistoryEntry): Promise<{ path: string; syncRequested: boolean }> {
    browser.operation.check();
    if (!this.histories.has(browser) || this.restoring !== null) throw new Error("Another recovery operation owns this device. Wait or cancel it first.");
    this.restoring = browser.operation;
    for (const other of this.histories) if (other !== browser) other.operation.cancel();
    const work = this.restoreHistoryOwned(browser, entry);
    this.manualRestore = work;
    void work.finally(() => { if (this.manualRestore === work) this.manualRestore = null; }).catch(() => undefined);
    return work;
  }

  private async restoreHistoryOwned(browser: HistoryBrowser, entry: HistoryEntry): Promise<{ path: string; syncRequested: boolean }> {
    const generation = this.lifecycle;
    const previous = this.engine;
    let created: VaultStat | null = null;
    let syncRequested = false;
    try {
      // No self-deadlock: the restore is held separately from older Fetches.
      await previous?.stopAndWait();
      browser.operation.check();
      await browser.operation.wait(Promise.allSettled(this.manualFetches));
      browser.operation.check();
      created = await restoreCopy(browser, entry);
    } catch (error) {
      this.log(`history decision=restore_failed reason=${error instanceof CopyPublicationError ? "publication_may_exist" : "refused_or_cancelled"}`);
      throw error;
    } finally {
      if (this.restoring === browser.operation) this.restoring = null;
      this.closeHistory(browser);
      if (this.isCurrent(generation) && !this.changingScope && this.engine === previous) {
        // Ordinary startup may wait on network retries. Do not withhold a
        // completed local-copy receipt while that independent work settles.
        const restart = this.startEngine();
        syncRequested = created !== null;
        void restart.then(() => {
          if (created && this.isCurrent(generation) && !this.changingScope && this.engine?.started) {
            // No pull echo marker or historical identity: ordinary push
            // gives this new local file a fresh id and empty parents.
            this.engine.changed(created.path);
          }
        }).catch(() => this.log("history decision=sync_pending reason=restart_failed"));
      }
    }
    return { path: created.path, syncRequested };
  }

  async fetchRemoteOnly(fileId: string): Promise<string> {
    const context = this.syncContext();
    if (!context) throw new Error("Sync is not running on this device.");
    const fetch = fetchRemoteOnly(context, fileId);
    this.manualFetches.add(fetch);
    try {
      return await fetch;
    } finally {
      this.manualFetches.delete(fetch);
    }
  }

  /**
   * A local scope change never alters policy on the server or another
   * device's selection.
   *
   * WIDENING REPLAYS THE FEED THIS DEVICE SKIPPED. The files a newly
   * selected folder holds on the server were published before this device's
   * cursor, and the change feed is the only place they exist for it: there is
   * no "list the vault's files" call to ask instead. So a selection that
   * gains a folder, or returns to the whole vault, rewinds the cursor to 0
   * and the restart walks the feed from the beginning, exactly as a device
   * syncing for the first time does (issue #92). The newly covered LOCAL
   * files are the startup scan's half of the same restart.
   *
   * Replay is safe because the pull path answers each record against what
   * this device holds NOW, not against the order it arrives in: a version
   * this device authored is its own echo -- except its own deletion of a file
   * the replay has just written back, which is applied again (issue #237) --
   * a version its head already reaches is `already_incorporated`, a tombstone
   * for a file it no longer tracks is skipped, and local content the server
   * never received is kept beside the incoming version rather than replaced
   * (`sync/pull.ts`). Narrowing keeps its cursor: nothing new is covered, so
   * there is nothing to replay.
   *
   * THE CHOICE IS KEPT THE MOMENT SAVE IS PRESSED (issue #185), as the
   * pending selection, and put in force once the old one's transfers have
   * stopped. It used to be written only after that wait, so a quit during a
   * large upload dropped it without a word; now the next start finishes it
   * (`finishScopeChange`). The stop cuts an upload at its next chunk, so the
   * wait is the chunks on the wire and not the rest of the file, and Cancel
   * ends it: `withdrawn`, nothing changed, sync goes on as it was.
   */
  async saveSyncFolders(value: string[] | undefined): Promise<"saved" | "withdrawn"> {
    const generation = this.lifecycle;
    const assertActive = (): void => {
      if (!this.isCurrent(generation)) {
        throw new Error("The plugin unloaded during the folder change. The selection is kept, and takes effect when obsync starts again.");
      }
    };
    assertActive();
    const state = this.state;
    let folders: string[] | undefined;
    try {
      folders = value === undefined ? undefined : parseSyncFolders(value);
    } catch (error) {
      this.log("scope decision=refused reason=invalid_selection");
      throw error;
    }
    if (this.changingScope) throw new Error("A folder selection is already being saved.");
    this.changingScope = true;
    this.cancelHistories();
    const cancel = this.scopeCancel = new AbortController();
    const started = Date.now();
    let withdrawn = false;
    try {
      const before = state.data.pendingScope;
      state.data.pendingScope = folders === undefined ? {} : { folders };
      try {
        await state.save();
      } catch (error) {
        state.data.pendingScope = before;
        throw error;
      }
      assertActive();
      // Scope changes take effect only after old work is quiescent. A
      // stopped long poll may finish, but must not advance its cursor.
      const previous = this.engine;
      const quiet = (async (): Promise<boolean> => {
        await previous?.stopAndWait();
        await Promise.allSettled(this.manualFetches);
        await Promise.allSettled(this.manualRestore === null ? [] : [this.manualRestore]);
        return false;
      })();
      withdrawn = await Promise.race([quiet, aborted(cancel.signal)]);
      assertActive();
      if (withdrawn) {
        // The stop goes on by itself; the start below waits for it.
        void quiet.catch(() => undefined);
        delete state.data.pendingScope;
        await state.save();
        assertActive();
        this.log(`scope decision=withdrawn reason=cancelled duration_ms=${Date.now() - started}`);
      } else {
        this.engine = null;
        // A retry that fired into a failed save would restart sync under a
        // status that says it is stopped; the start at the end owns resumption.
        this.cancelReconnect();
        await this.applyScope(state, "save", started, assertActive);
        // Redrawn now: whether the status line names an empty selection is this save's to change.
        this.setStatus(this.statusValue);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.log("scope decision=failed reason=not_saved");
        this.setStatus({ kind: "error", message: "Folder selection was not saved. Sync is stopped; retry before restarting Obsidian." });
      } else {
        this.log(`scope decision=deferred reason=plugin_unloaded pending=${state.data.pendingScope !== undefined}`);
      }
      throw error;
    } finally {
      if (this.scopeCancel === cancel) this.scopeCancel = null;
      if (this.isCurrent(generation)) this.changingScope = false;
    }
    if (withdrawn) {
      void this.startEngine().catch(() => this.log("scope decision=sync_pending reason=restart_failed"));
      return "withdrawn";
    }
    await this.startEngine();
    return "saved";
  }

  /**
   * Put the pending selection in force and persist it with the cursor it
   * implies, or leave everything as it was. Decided now, against the selection
   * that was in force while the stopped work ran.
   */
  private async applyScope(state: State, trigger: "save" | "start", started: number, assertActive: () => void): Promise<void> {
    const pending = state.data.pendingScope;
    if (pending === undefined) return;
    const folders = pending.folders;
    const previous = state.data.syncFolders;
    const cursor = state.data.lastSeq;
    const owed = state.data.folderRemovals;
    const widened = expandsSyncScope(previous, folders);
    state.data.syncFolders = folders;
    if (widened) state.data.lastSeq = 0;
    // A NARROWER SELECTION RE-JUDGES EVERY FOLDER REMOVAL STILL OWED (issue
    // #265): judged against it, one outside it is refused, and said, by the
    // next start's pass rather than published beyond what the person now
    // syncs. A wider one leaves each as it was judged.
    if (folders !== undefined && expandsSyncScope(folders, previous)) {
      state.data.folderRemovals = Object.fromEntries(Object.keys(owed).map((path) => [path, [...folders]]));
    }
    delete state.data.pendingScope;
    try {
      await state.save();
    } catch (error) {
      state.data.syncFolders = previous;
      state.data.lastSeq = cursor;
      state.data.folderRemovals = owed;
      state.data.pendingScope = pending;
      throw error;
    }
    // A session that unloaded meanwhile reports nothing, and a later load reads what was written.
    assertActive();
    this.log(
      `scope decision=saved mode=${folders === undefined ? "whole_vault" : "selected_folders"} folders=${folders?.length ?? 0} ` +
        `replay=${widened ? "from_zero" : "none"} from_seq=${cursor} trigger=${trigger} duration_ms=${Date.now() - started}`,
    );
  }

  /**
   * A selection saved while transfers were stopping, and never put in force
   * because Obsidian closed first (issue #185): in force before the first
   * start, and said so once.
   */
  private async finishScopeChange(generation: object | null): Promise<void> {
    if (!this.isCurrent(generation) || this.changingScope) return;
    try {
      await this.applyScope(this.state, "start", Date.now(), () => undefined);
      new Notice("obsync: the folder selection you saved before Obsidian closed is now in effect.", 8000);
    } catch {
      this.log("scope decision=failed reason=not_saved trigger=start");
    }
  }

  /** What a folder Save is waiting for, in the words its button shows (issue #185). */
  scopeWaitText(): string {
    const [first, ...rest] = this.engine?.uploads() ?? [];
    if (first === undefined) return "Saving…";
    return `Stopping the upload of ${first}${rest.length > 0 ? ` and ${rest.length} more` : ""}…`;
  }

  /** Cancel the folder Save still waiting for its transfers: nothing changes. */
  cancelScopeChange(): void {
    this.scopeCancel?.abort();
  }

  // --- identity and keys -------------------------------------------------

  platformName(): string {
    if (Platform.isIosApp) return Platform.isTablet ? "ipados" : "ios";
    if (Platform.isAndroidApp) return "android";
    if (Platform.isMacOS) return "macos";
    if (Platform.isWin) return "windows";
    return "linux";
  }

  /**
   * The name this device answers to in the dashboard's device table and in
   * another device's conflict copies. It is the name the user gave it, or a
   * default until they give it one.
   */
  deviceName(): string {
    const chosen = this.state.data.deviceName;
    return chosen !== null && chosen.trim() !== "" ? chosen.trim() : this.defaultDeviceName();
  }

  /**
   * The name a device answers to before anyone renames it: what it is and a
   * tag made here, "Mac 7KQ4" (issue #152). The tag exists BEFORE setup or a
   * claim, so the server is told the name this device will show -- not the
   * bare platform every Mac used to share -- and it is kept, so the name
   * never changes under the device (`nameThisDevice`).
   */
  defaultDeviceName(): string {
    return `${platformLabel(this.platformName())} ${this.state.data.deviceTag ??= newDeviceTag()}`;
  }

  /** Keep the tag before the name is sent anywhere a restart could lose it. */
  async nameThisDevice(): Promise<string> {
    if (this.state.data.deviceTag === null) {
      this.state.data.deviceTag = newDeviceTag();
      await this.state.save();
    }
    return this.deviceName();
  }

  /**
   * The credential a device request signs with. A pairing claim waiting for
   * its key signs as itself (issue #153): it is never the stored credential
   * until the key it was approved for is kept, and nothing else runs while it
   * waits, because a device that syncs never claims.
   */
  credential(state: State): { id: string; secret: Uint8Array<ArrayBuffer> } | null {
    const waiting = this.waiting?.claim;
    if (waiting !== undefined) return { id: waiting.deviceId, secret: unhex(waiting.deviceSecret) };
    const { deviceId, deviceSecret } = state.data;
    return deviceId && deviceSecret ? { id: deviceId, secret: unhex(deviceSecret) } : null;
  }

  /**
   * Finish a pairing a restart interrupted, inside its window, or say to pair
   * again (issue #153). Never the recovery phrase: a claim holds no key yet.
   */
  resumePairing(): void {
    const state = this.state;
    const held = readClaim(state.heldClaim());
    if (held === null) return;
    // A claim an older session was collecting is this session's now: that
    // session stops at its next step and leaves the entry alone.
    if (state.paired || held.serverUrl !== state.data.serverUrl) {
      this.log("pairing role=claimant decision=dropped reason=stale_claim");
      state.holdClaim(null);
      return;
    }
    this.log(`pairing role=claimant decision=resumed age_ms=${Date.now() - held.claimedAt} window_ms=${PAIRING_WINDOW_MS}`);
    awaitApproval(this, this.app, held, () => undefined, true);
  }

  /** Name another device's copies right after a pairing or a rename (issue #164). */
  async refreshDeviceNames(): Promise<void> {
    await this.engine?.refreshDeviceNames();
  }

  /**
   * Send this device's name and its two ceilings to the server, so the
   * dashboard's device table shows what this device will actually hold
   * (`docs/architecture.md` section 8), and keep both locally.
   */
  async saveDeviceSettings(name: string): Promise<void> {
    const { state, transport, assertCurrent } = this.captureSession();
    const deviceId = state.data.deviceId;
    if (deviceId === null) throw new Error("this device is not paired yet");
    const trimmed = name.trim();
    // An emptied field means "go back to the default", not "keep whatever
    // name I had": the fallback is the DERIVED name, never the stored one.
    const saved = await transport.patchDevice(deviceId, {
      name: trimmed === "" ? this.defaultDeviceName() : trimmed,
      policy: state.data.policy,
    });
    assertCurrent();
    // A rename is not repeatable, and there is nothing to reconcile against:
    // the name the user typed is not a fact this device can check for, only
    // one the server can confirm. Say so and keep the local copy unchanged,
    // so a retry sends the same thing rather than a half-applied pair.
    if (saved.outcome === "lost") throw new Error(lostMessage("saving this device's settings", saved));
    state.data.deviceName = trimmed === "" ? null : trimmed;
    await state.save();
    assertCurrent();
    this.log(`device decision=updated name_len=${trimmed.length}`);
    await this.refreshDeviceNames();
  }

  /**
   * Every device paired to this vault, for the settings tab's device list.
   * A device somebody has forgotten is not one of them (#247): the server
   * keeps its record to refuse it by and to name its versions, and states
   * that with `archived`, which a server before 1.1.5 never sets.
   */
  async listDevices(patience: Patience = {}): Promise<DeviceRecord[]> {
    return (await this.transport.devices(patience)).devices.filter((device) => device.archived !== true);
  }

  /**
   * Revoke a device: from this moment the server refuses everything it
   * sends (`docs/architecture.md` section 4.3). The server refuses to let
   * the only device revoke itself, and that refusal is surfaced verbatim
   * rather than swallowed — a user who has just locked themselves out
   * deserves to know why it did not happen.
   *
   * A revoke is not repeatable, and a lost answer is the one case where both
   * guesses are harmful: "it failed" leaves the user believing a device they
   * wanted out still holds the vault, and a blind repeat can meet
   * `last_device` on a revoke that already worked. The device list says which
   * it was, and reading it is repeatable. `interactive` bounds both the send
   * and that read for a person who is waiting (`patiently`, `Patience`).
   */
  async revokeDevice(deviceId: string, patience: Patience = {}): Promise<void> {
    const sent = await patiently(this.transport.revokeDevice(deviceId), patience);
    if (sent.outcome === "lost") {
      const revoked = (await this.transport.devices(patience)).devices.find((device) => device.device_id === deviceId)?.revoked;
      this.log(`device decision=reconciled reason=lost_answer revoked=${revoked === true}`);
      if (revoked !== true) throw new Error(lostMessage(`revoking that device`, sent));
    }
    this.log(`device decision=revoked self=${deviceId === this.state.data.deviceId}`);
    if (deviceId === this.state.data.deviceId) {
      await this.engine?.stopAndWait();
      this.engine = null;
      // Not this device's own leave, which forgets the pairing next and says
      // what happened itself: a phone put this up after every Leave (#233).
      if (!this.leaving) this.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
    }
  }

  /**
   * Forget a REVOKED device (issue #247): the server takes it off the device
   * lists. NOTHING IS DESTROYED -- the record is what answers that device
   * "This device was removed from your server" rather than the answer a
   * stranger's id gets, and what names the versions it wrote -- so the wire
   * calls it archiving and the person, who is tidying a list, reads Forget.
   *
   * Always a person's press, so always their patience. It is not repeatable,
   * and a lost answer is settled by reading the list: a device no longer
   * listed is the outcome that was asked for.
   *
   * A SERVER BEFORE 1.1.5 HAS NO SUCH ROUTE and answers `404 not_found`; the
   * person is told what to update, and the device stays revoked and listed.
   * Each outcome logs one line with its duration against the interactive budget.
   */
  async forgetRevoked(deviceId: string): Promise<void> {
    const started = Date.now();
    const logged = (decision: string, reason: string): void =>
      this.log(`device decision=${decision} action=forget reason=${reason} duration_ms=${Date.now() - started} budget_ms=${INTERACTIVE_MS}`);
    let sent: Sent<void>;
    try {
      sent = await patiently(this.transport.archiveDevice(deviceId), { interactive: true });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "local";
      if (code === "unknown_device") return logged("forgotten", "already_gone");
      logged("refused", code);
      if (code === "not_found") {
        throw new Error("your server is too old to forget devices. Update it to obsync 1.1.5 or later, then try again.");
      }
      if (code === "device_not_revoked") throw new Error("it can still sync. Revoke it first.");
      throw error;
    }
    if (sent.outcome === "lost") {
      const listed = (await this.transport.devices({ interactive: true })).devices
        .some((device) => device.device_id === deviceId && device.archived !== true);
      logged(listed ? "unconfirmed" : "forgotten", "lost_answer");
      if (listed) throw new Error(lostMessage("forgetting that device", sent));
      return;
    }
    logged("forgotten", "revoked");
  }

  // --- leaving a server --------------------------------------------------

  /**
   * Local edits the server never received: every in-scope vault file whose
   * bytes this device has not pushed, plus every recorded path the vault no
   * longer holds (a deletion this device has not published). The rule is the
   * engine's own startup reconcile, through `isPushed`, so this counts
   * exactly the work that leaving would strand.
   */
  async unpushedEdits(): Promise<string[]> {
    const state = this.state;
    const unpushed: string[] = [];
    const seen = new Set<string>();
    await this.inHostPass(async () => {
      for (const file of await this.host.list()) {
        if (!(await this.tracked(file.path))) continue;
        seen.add(file.path);
        if (!isPushed(state.fileByPath(file.path), file.mtime, file.size)) unpushed.push(file.path);
      }
      for (const path of Object.keys(state.data.files)) {
        if (seen.has(path) || !(await this.tracked(path))) continue;
        unpushed.push(path);
      }
    });
    return unpushed.sort();
  }

  /** A path this device syncs: the engine's own rule (`engine.ts`, `tracked`). */
  private async tracked(path: string): Promise<boolean> {
    return vaultPathRefusal(path) === null && inSyncScope(path, this.state.data.syncFolders) && (await this.host.syncable(path));
  }

  /**
   * `work` as one pass of the host's (`VaultHost.pass`, issue #198), closed
   * however it ends, as the engine's own walks are: a walk over every file
   * asks each folder's nested-vault question once instead of once per file.
   * On a phone that question is a bridge call a level; 300 files four levels
   * deep took 33.6 s outside a pass and 2.5 s inside one (Android emulator).
   */
  private async inHostPass<T>(work: () => Promise<T>): Promise<T> {
    this.host.pass?.(true);
    try {
      return await work();
    } finally {
      this.host.pass?.(false);
    }
  }

  /**
   * How many notes here the server's vault does not already hold, byte for
   * byte at the same path (issue #141). It posts nothing. A claimant asks it
   * before its first sync, which publishes every such note to every device
   * syncing that vault: that is how pairing a second vault merged two. A
   * version too large to carry a whole-file digest is matched by size.
   *
   * AN EARLIER VERSION OF THE NOTE AT THAT PATH IS THE VAULT'S TOO: a device
   * paired again after the others edited while it was away holds the note as
   * it last saw it, which pairing takes as that version and uploads nothing
   * (issue #194). Counted as unknown, it asked about notes the server holds
   * (the Android journey J10, 2026-09-27).
   */
  async notesUnknownTo(vrk: string): Promise<number> {
    const started = Date.now();
    const key = unhex(vrk);
    const map = await loadDomainMap(this.transport, await domainMapKeys(key));
    const domainId = map === null ? null : soleDomain(map);
    const held = domainId === null
      ? null
      : await heldNotes(this.transport, await deriveManifestKey(await deriveDomainKey(key, domainId), domainId));
    let local = 0;
    let unknown = 0;
    let older = 0;
    await this.inHostPass(async () => {
      for (const file of await this.host.list()) {
        if (!(await this.tracked(file.path))) continue;
        local++;
        const there = held?.get(file.path);
        const same = there !== undefined && there.size === file.size &&
          (there.sha256 === "" || hex(await sha256(await this.host.read(file.path))) === there.sha256);
        if (same) continue;
        const earlier = there !== undefined && [...there.versions].some((version) => version.startsWith(`${file.size} `)) &&
          there.versions.has(`${file.size} ${hex(await sha256(await this.host.read(file.path)))}`);
        if (earlier) older++;
        else unknown++;
      }
    });
    this.log(
      `pairing role=claimant decision=surveyed local=${local} unknown=${unknown} older=${older} held=${held?.size ?? 0} duration_ms=${Date.now() - started}`,
    );
    return unknown;
  }

  /**
   * Leave this server (issue #79): revoke THIS device on the server, then
   * forget the pairing, so the device is "not paired" again and can pair with
   * the same server or another one WITHOUT starting a new vault. Before this
   * existed the documented way out was a fresh vault, because a device that
   * only changed its Server URL met `401 bad_signature` forever.
   *
   * THE ORDER IS THE WHOLE DESIGN. Quiesce, count, revoke, and only then
   * clear: a state cleared before the server answers would leave a device
   * with no credential and a server that still trusts one, which is exactly
   * the stuck state this feature removes. Every refusal therefore leaves this
   * device syncing as it was, and the one line this logs says which of the
   * two happened.
   *
   * A REVOKE THAT DID NOT HAPPEN OFFERS THE LOCAL LEAVE, whatever stopped it
   * (issue #157): the server refusing the only ACTIVE device (`409
   * last_device`) until vault recovery is registered, a server that does not
   * know this device (`401 bad_signature`: rebuilt, restored, or another
   * server), no answer at all, or any other refusal. That is `localOnly`: this
   * device forgets the server and its credential exactly as a leave does, and
   * the server keeps listing the device until another device or the dashboard
   * removes it. It is never taken without asking, because a wrong address
   * answers `401` too (#143); nothing is kept for a later revoke, so the
   * device holds no usable credential afterwards. A device the server has
   * already revoked (`403 device_revoked`) has nothing left to ask. No other
   * device is touched on any path; only this device's id is ever sent.
   *
   * NOTHING HERE WAITS OUT THE SERVER. The stop cancels the long poll and
   * every retry and cuts an upload at its chunk boundary (`SyncEngine.stop`),
   * so a start under way is waited for only to its next step: at most the one
   * attempt of a recovery registration it has already sent (#233);
   * the revoke and the read that settles a lost one have a person's budget,
   * two attempts inside ten seconds; and the start after a refusal runs on
   * its own, because a start retries a server that is gone for a minute and
   * a half, and the refusal is what the person is waiting to read (S70:
   * 204 s of silence, now seconds).
   *
   * PLATFORM. Identical on desktop and mobile: one revoke, one metadata
   * write, one secret write, and no filesystem work of any kind.
   */
  async leaveServer(choice: LeaveChoice): Promise<LeaveResult> {
    const started = Date.now();
    const { state, assertCurrent } = this.captureSession();
    let revoked = false;
    // Never "ok" until something finished: an exception anywhere below leaves
    // this line saying the attempt stopped part way, which is the truth.
    let reason = "unfinished";
    let unpushed = 0;
    let cleared = false;
    let previous = "kept";
    let owned = false;
    try {
      const deviceId = state.data.deviceId;
      if (deviceId === null) {
        reason = "not_paired";
        throw new Error("This device is not paired with a server.");
      }
      // ONE LEAVE AT A TIME: a second one, started while the first was still
      // revoking, ended beside its success with a notice about an inactive
      // session (S22).
      if (this.leaving) {
        reason = "already_leaving";
        throw new Error("This device is already leaving the server. Wait for that to finish.");
      }
      if (this.changingScope || this.restoring !== null) {
        reason = "busy";
        throw new Error("This device is changing its folder selection or restoring a version. Leave the server once that finishes.");
      }
      this.leaving = owned = true;
      const starting = [...this.starts];
      // Quiesce first, so the count below is a fact rather than a guess and
      // no push, fetch or restore is still running against the credential
      // this is about to give up.
      await this.engine?.stopAndWait();
      // AND A START UNDER WAY IS SETTLED BEFORE ANYTHING ELSE (#233): one
      // begun as Obsidian opened, a reconnect, a Sync now. The stop above
      // ended its requests; from here it makes no engine and starts none
      // (`startEngineOwned` asks at every step whether a leave began), and it
      // is waited for, so what it sent is answered before the revoke goes.
      // BUT FOR `START_SETTLE_MS` AT MOST: the one step a stop cannot end is a
      // recovery registration already sent, which a server that stopped
      // answering holds for a whole attempt, and a leave answers in seconds
      // even then (#157). Answered after the revoke, it is refused and
      // changes nothing (`registerAccountRecovery`).
      if (starting.length > 0) {
        const waited = Date.now();
        let handle = 0;
        const settled = await Promise.race([
          Promise.allSettled(starting).then(() => true),
          new Promise<boolean>((resolve) => { handle = window.setTimeout(() => resolve(false), START_SETTLE_MS); }),
        ]);
        window.clearTimeout(handle);
        this.log(
          `unpair decision=${settled ? "waited" : "gave_up"} reason=start_under_way starts=${starting.length} ` +
            `budget_ms=${START_SETTLE_MS} duration_ms=${Date.now() - waited}`,
        );
      }
      assertCurrent();
      this.engine = null;
      // No timer may start an engine while the credential is being given up.
      this.cancelReconnect();
      this.cancelHistories();
      await Promise.allSettled(this.manualFetches);
      await Promise.allSettled(this.manualRestore === null ? [] : [this.manualRestore]);
      assertCurrent();
      const pending = await this.unpushedEdits();
      unpushed = pending.length;
      assertCurrent();
      if (unpushed > 0 && !choice.discardUnpushed) {
        reason = "unpushed_edits";
        return { decision: "refused", reason: "unpushed_edits", unpushed: pending };
      }
      try {
        await this.revokeDevice(deviceId, { interactive: true });
        revoked = true;
      } catch (error) {
        reason = error instanceof ApiError ? error.code : "local_or_lost";
        // A reload while the server was asked: this session decides nothing.
        assertCurrent();
        // Revoked already -- from another device or the dashboard (#143, S80):
        // what leaving asks of the server is done, so this device forgets it
        // too, which is the one way back to pairing again.
        if (error instanceof ApiError && error.code === "device_revoked") revoked = true;
        else if (!choice.localOnly) return { decision: "refused", ...leaveRefusal(error) };
      }
      assertCurrent();
      state.forgetPairing();
      this.transport.forgetDevice();
      await state.save();
      cleared = true;
      // Past this point the captured session can no longer be asserted: the
      // address it was captured with is exactly what that write dropped. A
      // concurrent reload is settled by State's serialised writer, and a
      // cleared state can start no engine, because `paired` is false.
      try {
        await state.forgetPreviousCredential();
        previous = "dropped";
      } catch {
        new Notice(
          "obsync: this device left the server. Obsidian's secret storage refused to drop the older credential record; the next pairing on this device replaces it.",
          10000,
        );
      }
      this.updateAvailable = null;
      this.recoveryMismatch = false;
      this.recoveryNotice?.hide();
      this.forgottenDevice = false;
      this.setStatus({ kind: "idle" });
      if (reason === "unfinished") reason = "ok";
      return { decision: "left", revoked };
    } finally {
      if (owned) this.leaving = false;
      this.log(
        `unpair decision=${revoked ? "revoked" : cleared ? "left_locally" : "refused"} reason=${reason} unpushed=${unpushed} ` +
          `local_cleared=${cleared} previous_credential=${previous} duration_ms=${Date.now() - started}`,
      );
      // However this ended, a device that is still paired goes on syncing:
      // no refusal here may leave the engine stopped. A device that DID
      // leave starts nothing, because `startEngine` requires `paired`. Not
      // awaited: see NOTHING HERE WAITS OUT THE SERVER above.
      if (owned) void this.startEngine().catch(() => this.log("unpair decision=sync_pending reason=restart_failed"));
    }
  }

  /**
   * Whether edits made here can reach the server now, so the Leave dialog
   * advises Sync now only where it can work (issue #157): not while offline,
   * and not once the server has stopped recognising this device.
   */
  get sendsNow(): boolean {
    return !this.forgottenDevice && this.statusValue.kind !== "offline";
  }

  /**
   * Adopt a server address: the one place a typed address is normalised,
   * checked against mobile's HTTPS rule and saved, so the settings row and
   * "Switch server" cannot come to disagree about what an address may be.
   */
  async setServerUrl(value: string): Promise<void> {
    const url = normalizeServerUrl(value);
    const refusal = serverUrlRefusal(url, this.isMobile);
    if (refusal !== null) throw new Error(refusal);
    this.state.data.serverUrl = url;
    await this.state.save();
    this.wake("address");
  }

  /**
   * Adopt a vault key (new, or restored from a phrase) and start syncing.
   *
   * No domain is declared here: the engine reads the vault's domain map at
   * every start and writes one for a vault that has none, so the domain a
   * path belongs to has exactly one source (`docs/architecture.md` 5.1).
   */
  async adoptVaultKey(vrk: string, phrase: ObsyncData["recoveryPhrase"] = "unconfirmed"): Promise<void> {
    const { state, assertCurrent } = this.captureSession();
    // A different key is a phrase this device has not confirmed; restoring
    // one from its 24 words is the confirmation (issue #170).
    if (state.data.vrk !== vrk || phrase === "confirmed") state.data.recoveryPhrase = phrase;
    state.data.vrk = vrk;
    await state.save();
    assertCurrent();
    await this.startEngine();
  }

  /**
   * Would `vrk` leave this device outside the vault its server holds (issue
   * #140)? A map lives at a file id derived from its key, so a new key or
   * another vault's phrase finds none, and the engine would write a second
   * map into the same account: every other device then meets records it
   * cannot open. Only a device with a credential can ask, and only a server
   * holding records has a vault to strand.
   */
  async vaultKeyStrands(vrk: string): Promise<boolean> {
    const { state, transport } = this.captureSession();
    if (state.data.deviceId === null || this.forgottenDevice) return false;
    if ((await loadDomainMap(transport, await domainMapKeys(unhex(vrk)))) !== null) return false;
    // Versions, not the journal head: account and device frames move the
    // head of a server that holds no vault yet.
    return (await transport.changes(0, 0, 1)).changes.length > 0;
  }

  /** Restore a key from its phrase, never one that opens nothing on this server (issue #140). */
  async restoreVaultKey(vrk: string): Promise<void> {
    const started = Date.now();
    const strands = await this.vaultKeyStrands(vrk);
    this.log(`vaultkey decision=${strands ? "refused reason=opens_nothing_here" : "restored"} duration_ms=${Date.now() - started}`);
    if (strands) {
      throw new Error("These 24 words do not open the vault on this server: nothing there was sealed with them. The key on this device was not changed.");
    }
    await this.adoptVaultKey(vrk, "confirmed");
  }

  /**
   * First-time setup: the token the server writes privately at first boot
   * creates the account and enrols this device.
   */
  async setUpAccount(setupToken: string, accountName: string): Promise<void> {
    if (this.enrolling) return;
    this.enrolling = true;
    let freshKey = false;
    try {
      if (this.forgottenDevice) await this.resetForgottenEnrollment();
      const { state, transport, assertCurrent } = this.captureSession();
      if (state.data.deviceId !== null || state.data.deviceSecret !== null) {
        throw new Error(state.paired
          ? "This device already has an enrollment, so server setup was not repeated. To set it up with another server, use Leave this server or Switch server first."
          : "This device already has an enrollment, but its last pairing did not finish, so it holds no vault key. Pair it again: on a device that already syncs, choose Pair a new device, then paste its code here with Pair this device. Do not repeat server setup.");
      }
      const nested = await this.nestedRefusal("setup");
      if (nested !== null) {
        new Notice(`obsync: ${nested}`, 12000);
        return;
      }
      // Persist the key BEFORE a one-time request can create its account. A
      // lost answer then leaves the proof needed for an explicit recovery.
      // The name's tag rides that save, or the credential's, so the server
      // is told the name this device keeps (issue #152).
      const name = this.deviceName();
      freshKey = state.data.vrk === null;
      if (freshKey) {
        state.data.vrk = hex(newVaultKey());
        state.data.recoveryPhrase = "unconfirmed";
        await state.save();
      }
      const vrk = state.data.vrk as string;
      const recovery = await accountRecovery(vrk);
      assertCurrent();
      if (state.data.vrk !== vrk) throw new Error("The vault key changed during setup; try again with the current key.");
      // A key made for THIS setup recovers nothing, so it sends no proof: an
      // occupied server then says to pair or restore, rather than establishing
      // a second vault key over the one it holds (#141, #154). A key restored
      // from the phrase sends its proof, which re-enrols an existing account,
      // including one an operator has cleared (`docs/recovery.md`).
      const enrolled = await transport.setup(pastedToken(setupToken), accountName, {
        name,
        platform: this.platformName(),
        app_version: this.manifest.version,
      }, freshKey ? { verifier: recovery.verifier } : recovery);
      assertCurrent();
      if (state.data.vrk !== vrk) throw new Error("The vault key changed while the server answered; this response was not adopted. Restore the intended phrase and recover explicitly.");
      // Setup is not repeatable and the credential it mints exists nowhere
      // else: a lost answer means this device may have been enrolled with a
      // secret it never received. There is nothing to read back without a
      // credential, so say exactly that. An explicit new attempt can recover
      // with the persisted key and token; no request is automatically retried.
      if (enrolled.outcome === "lost") throw new Error(lostMessage("creating the account", enrolled));
      const result = enrolled.value;
      state.data.deviceId = result.device_id;
      state.data.deviceSecret = result.device_secret;
      await state.save();
      assertCurrent();
      new Notice(result.recovered ? "Account recovered and this device re-enrolled." : "Account created and this device enrolled.");
      if (freshKey) {
        await this.startEngine();
        assertCurrent();
        new RecoveryPhraseModal(this.app, this, true).open();
      } else {
        await this.startEngine();
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "local_or_lost";
      this.log(`setup decision=failed reason=${code}`);
      // One server holds one vault (#141). A device whose key was made for
      // this setup is a SECOND device whatever the server said about
      // recovery, and pairing is its way in (#154). Only a key restored from
      // the phrase is told about recovery.
      const pairHere = "pair this device from one that syncs it (Pair a new device there, then Pair this device here)";
      const text = !(error instanceof ApiError)
        ? refusalText(error)
        : freshKey && ["already_set_up", "recovery_unavailable", "bad_recovery_proof"].includes(code)
          ? refusalFor("already_set_up")
          : code === "already_set_up"
            ? `This server already holds a vault, and one server holds one vault. If this is that vault, ${pairHere}, or restore its recovery phrase and use Setup or recover with the setup token; a different vault needs a server of its own.`
            : code === "recovery_unavailable"
              ? `This server holds a vault with no recovery key registered, so these words cannot re-enrol this device on their own: ${pairHere}, or ask whoever runs the server to reset its recovery key and send you the new setup token (server 1.1.5 or later); a different vault needs a server of its own.`
              : code === "bad_recovery_proof"
                ? `These recovery words do not open this server’s vault, and no device was enrolled. Restore its correct 24-word phrase, or ${pairHere}; a different vault needs a server of its own.`
                : refusalText(error);
      new Notice(`obsync: ${text}`, 12000);
    } finally {
      this.enrolling = false;
    }
  }

  /** Register once a successful engine start has opened this vault's map. */
  async registerAccountRecovery(): Promise<void> {
    const deviceId = this.state.data.deviceId;
    try {
      const { state, transport, assertCurrent } = this.captureSession();
      const vrk = state.data.vrk;
      if (vrk === null || this.forgottenDevice) return;
      const { verifier } = await accountRecovery(vrk);
      assertCurrent();
      if (state.data.vrk !== vrk) return;
      const registered = await transport.registerRecovery(verifier);
      assertCurrent();
      this.log(`recovery decision=${registered.outcome === "ok" ? "registered" : "unconfirmed"}`);
      // Its own key registered: the warning below has nothing left to say.
      if (registered.outcome === "ok" && this.recoveryMismatch) {
        this.recoveryMismatch = false;
        this.recoveryNotice?.hide();
        this.render();
        this.log("recovery decision=cleared reason=registered warning=cleared");
      }
    } catch (error) {
      // A KEY THIS DEVICE DID NOT REGISTER (1.1.5). The server cannot tell
      // which key this vault produced, and any device credential can register
      // the first one, so this device says so, once a session, until a
      // registration of its own succeeds: the operator's reset clears the
      // other key and the next start registers this one. Only while this
      // device still holds the credential that asked (#233, below).
      if (this.state.data.deviceId === deviceId && error instanceof ApiError && error.code === "recovery_mismatch") {
        const first = !this.recoveryMismatch;
        this.recoveryMismatch = true;
        // NOTICE-KIND security: never muted by any notice setting (requirement
        // 4), sticky until dismissed; the notice service maps this call site.
        if (first) this.recoveryNotice = new Notice(`obsync security warning: ${RECOVERY_MISMATCH}`, 0);
        this.render();
        // A refusal, so the console carries it at warn (`FAILURE_DECISION`).
        this.log(`recovery decision=refused reason=recovery_mismatch warning=${first ? "shown" : "standing"}`);
        return;
      }
      // A refusal of a credential this device has since given up -- a leave
      // revoked it while the registration was out -- is that credential's,
      // logged and never said: it read "removed" over a device that left (#233).
      const ended = this.state.data.deviceId !== deviceId;
      const refused = refusalStatus(error);
      if (!ended && refused?.kind === "error" && refused.code === "credential_rejected") this.setStatus(refused);
      // Old servers do not implement this route. Sync can continue, and their
      // last-device refusal remains in force until server and client upgrade.
      this.log(`recovery decision=unavailable reason=${error instanceof ApiError ? error.code : "local_or_lost"}${ended ? " session=ended" : ""}`);
    }
  }

  /** Forget only a rejected enrollment; keep local content, key and address. */
  async resetForgottenEnrollment(): Promise<void> {
    if (!this.forgottenDevice) return;
    if (this.changingScope || this.restoring !== null) throw new Error("Finish the current restore or folder change first.");
    const { state, assertCurrent } = this.captureSession();
    this.cancelReconnect();
    this.cancelHistories();
    await this.engine?.stopAndWait();
    await Promise.allSettled(this.engineTeardowns);
    await Promise.allSettled(this.manualFetches);
    await Promise.allSettled(this.manualRestore === null ? [] : [this.manualRestore]);
    assertCurrent();
    this.engine = null;
    const { serverUrl, edgeHeaders } = state.data;
    state.forgetPairing();
    this.transport.forgetDevice();
    state.data.serverUrl = serverUrl;
    state.data.edgeHeaders = edgeHeaders;
    await state.save();
    assertCurrent();
    await state.forgetPreviousCredential();
    this.forgottenDevice = false;
    this.setStatus({ kind: "idle" });
  }

  /** The setup guide, in the browser: a fixed address in the source, never data from a server. */
  openSetupGuide(): void {
    this.log("guide decision=opened");
    window.open(SETUP_GUIDE_URL, "_blank");
  }

  async openDashboard(): Promise<void> {
    try {
      const link = await this.transport.dashboardLoginLink();
      // A login link is minted and single use. A lost answer means one may
      // have been minted for nobody; it expires in five minutes, and asking
      // for another is the user's own decision, not a retry this makes.
      if (link.outcome === "lost") throw new Error(lostMessage("requesting a dashboard link", link));
      // The answer is resolved and origin-checked here, never opened as it
      // arrives: `dashboardTarget` says why. The reason is logged and the link
      // itself never is, because it carries the token.
      const target = dashboardTarget(link.value.url, this.state.data.serverUrl);
      if ("refused" in target) {
        this.log(`dashboard decision=refused reason=${target.reason}`);
        throw new Error(target.refused);
      }
      this.log("dashboard decision=opened");
      window.open(target.url, "_blank");
    } catch (error) {
      new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 8000);
    }
  }

  // --- update notice -----------------------------------------------------

  /**
   * Obsidian's native plugin manager owns installation and updates. This
   * device reads only the server's unauthenticated version metadata and
   * directs the user to that manager. The server serves no executable plugin
   * endpoint, and this plugin never writes its own installed code.
   */
  async checkForUpdate(): Promise<void> {
    const generation = this.lifecycle;
    const serverUrl = this.isCurrent(generation) ? this.state.data.serverUrl : "";
    if (serverUrl === "") return;
    try {
      const remote = await this.transport.pluginManifest();
      if (!this.isCurrent(generation)) return;
      // A server this device left while it answered has nothing to announce here (#233).
      if (this.state.data.serverUrl !== serverUrl) {
        this.log("update decision=dropped reason=session_ended");
        return;
      }
      if (!isNewer(remote.version, this.manifest.version)) return;
      this.updateAvailable = remote.version;
      // ONE notice per session. The settings row says the same thing for as
      // long as it stays true, so a toast raised again on every later probe
      // is noise -- and on a phone it lands on top of what the reader opened
      // the app to do.
      if (this.updateNotified) return;
      this.updateNotified = true;
      this.log(`update decision=notified server=${remote.version} local=${this.manifest.version}`);
      // A Notice is not a control on its own: a tap dismisses it and leaves
      // the reader where they were, several taps from the page that updates.
      // The listener goes on `containerEl`, the whole notice box: `noticeEl`
      // is an alias of `messageEl`, the text element INSIDE it, so a tap that
      // landed on the box's padding would only dismiss. A click on the text
      // bubbles up to the box, so one listener covers both.
      const notice = new Notice(updateMessage(remote.version, this.manifest.version), 15000);
      notice.containerEl.addEventListener("click", () => {
        this.openPluginManager();
      });
    } catch (error) {
      if (this.isCurrent(generation)) this.log(`update decision=skipped reason=${errorText(error)}`);
    }
  }

  /**
   * The settings tab's deletions-held line, or `null` when the last pass
   * published everything it found (issue #123).
   */
  heldDeletionLine(): string | null {
    const held = this.engine?.heldDeletionCount ?? 0;
    if (held === 0) return null;
    return `${held} note(s) deleted or missing here are still on your other devices: obsync has NOT told them. ` +
      "If a folder was renamed or moved outside Obsidian, put it back or select it under its new name. " +
      "Delete everywhere removes them from every device; Restore here puts them back on this one.";
  }

  /** The user's word that the held deletions were real (issue #123). */
  confirmHeldDeletions(): void {
    this.engine?.confirmHeldDeletions();
  }

  /** The user's word that they were not: put them back here, from the server (issue #162). */
  async restoreHeldDeletions(): Promise<void> {
    await this.engine?.restoreHeldDeletions();
  }

  /** A notice's button, pressed (`ObsidianHost.notify`). */
  act(action: NoticeAction): void {
    if (action.kind === "delete_everywhere") this.confirmHeldDeletions();
    else if (action.kind === "restore_here") void this.restoreHeldDeletions();
    else {
      void this.fetchRemoteOnly(action.fileId).then(
        (path) => new Notice(`Fetched ${path}.`),
        (error: unknown) => new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 10000),
      );
    }
  }

  /** The settings tab's update line, or `null` when this device is current. */
  updateLine(): string | null {
    const server = this.updateAvailable;
    return server === null ? null : updateMessage(server, this.manifest.version);
  }

  /**
   * Open Obsidian's own Community plugins page, where **Check for updates**
   * installs. The app owns that page and the download; this plugin still
   * writes no code of its own (`docs/architecture.md` 6.3). `app.setting` is
   * set by the host and absent from the vendored declaration, so it is read
   * through a narrow optional interface and its absence is a logged refusal,
   * never a crash inside a click handler.
   */
  openPluginManager(): void {
    const settings = (this.app as App & SettingsHost).setting;
    if (settings === undefined) {
      this.log("update decision=refused reason=settings_window_unavailable");
      return;
    }
    settings.open();
    settings.openTabById(COMMUNITY_PLUGINS_TAB);
    this.log("update decision=opened_plugin_manager");
  }

  // --- status ------------------------------------------------------------

  setStatus(status: EngineStatus): void {
    if (status.kind === "error" && status.code === "credential_rejected") {
      this.forgottenDevice = true;
      this.teardownEngine();
    } else if (this.forgottenDevice) return;
    this.statusValue = status;
    this.render();
  }

  /** Whether this session's transport's latest attempt went unanswered. */
  private unanswered = false;

  /**
   * What the transport learned on its last attempt, shown at once.
   *
   * THE STATUS BAR MUST NOT SAY `idle` WHILE NOTHING CAN SYNC. The transport
   * retries a request it gets no answer to for its whole budget -- about a
   * minute and a half -- before anything is thrown, and until then the engine
   * said nothing, so a device opened away from its server read `idle` for that
   * long before `offline — retrying` appeared (measured in the 2026-09-23 run).
   * An unanswered attempt now shows `offline — retrying` at once, over an
   * `idle` or a `syncing`: an `error` needs the person and is never hidden,
   * and an unpaired device has no sync to be offline from.
   *
   * AND ANY ANSWER TAKES IT BACK (issue #158), whoever said it. The engine's
   * own offline goes with the feed's next read, which the answer hurries
   * (`wake`), and a start that could not reach the server runs again now. An
   * answer used to take back only the offline this raised, so a device whose
   * feed had said it read `offline — retrying` for minutes after its server
   * was back. Said once per change, not per attempt.
   */
  private reachability(answered: boolean): void {
    if (this.unanswered !== answered) return;
    this.unanswered = !answered;
    this.log(answered ? "engine decision=online reason=answered" : "engine decision=offline reason=unanswered");
    this.render();
    if (answered) {
      this.engine?.wake("answered");
      this.retryNow("answered");
    }
  }

  /** The status the person reads: the transport's silence over a calm one (`reachability`). */
  private shown(): EngineStatus {
    const status = this.statusValue;
    const calm = status.kind === "idle" || status.kind === "syncing";
    return this.unanswered && calm && this.state?.paired === true ? { kind: "offline" } : status;
  }

  private render(): void {
    const status = this.shown();
    const quiet = !this.state.paired || this.state.data.syncFolders?.length === 0;
    this.indicator.update(indicated(status, quiet), `obsync: ${this.statusText()}`);
    // A PHONE HAS NOTHING ELSE THAT CATCHES THE EYE (#209): a refusal that
    // needs the person is said once in a notice there, as it turns to it.
    const refusal = status.kind === "error" && status.code !== undefined ? status.message : null;
    if (Platform.isMobile && refusal !== null && refusal !== this.noticed) new Notice(`obsync: ${refusal}`, 15000);
    this.noticed = refusal;
    for (const watcher of this.watchers) watcher();
  }

  /** Be told of every status change until the returned function is called (#156). */
  onStatusChange(watcher: () => void): () => void {
    this.watchers.add(watcher);
    return () => { this.watchers.delete(watcher); };
  }

  /** The status the person reads, for Show sync status to choose its next step by. */
  currentStatus(): EngineStatus {
    return this.shown();
  }

  /** When the next attempt runs by itself: a request asleep in its backoff, or the pending reconnect. */
  nextRetryAt(): number | null {
    const at = [this.transport.retryAt(), this.reconnect?.handle === null ? null : this.reconnect?.at ?? null]
      .filter((time): time is number => time !== null);
    return at.length === 0 ? null : Math.min(...at);
  }

  /**
   * Retry now, from Show sync status (#156): everything waiting on a timer
   * goes at once, and a stopped engine -- a refusal the person has just
   * fixed, a clock set right -- starts again.
   */
  retry(): void {
    this.log("engine decision=retry_now reason=pressed");
    this.wake("retry_now");
    if (this.engine !== null) void this.syncNow();
    else if (this.reconnect === null) void this.startEngine();
  }

  /** obsync's own settings tab: where Pair this device and the edge headers are. */
  openSettings(): void {
    const settings = (this.app as App & SettingsHost).setting;
    if (settings === undefined) {
      this.log("status decision=refused reason=settings_window_unavailable");
      return;
    }
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  statusText(): string {
    const status = this.shown();
    switch (status.kind) {
      case "idle":
        // A bare `idle` over a selection of no folders read as all being well (issue #150, S30d).
        if (!this.state.paired) return "not paired";
        return this.state.data.syncFolders?.length === 0 ? "idle — syncing no folders" : "idle";
      case "syncing":
        // Nothing counted, but the feed has not answered yet: not idle either.
        // A count names what it counts: "syncing 2" left "2 what?" (owner, 2026-09-27).
        if (status.pending === 0) return "checking for changes";
        return `syncing ${status.pending} file${status.pending === 1 ? "" : "s"}` +
          (status.held === undefined ? "" : `, waiting for unsaved changes in ${status.held}`);
      case "offline":
        // True of both places that set it: the running engine polls again
        // in seconds, and a stopped one is on the reconnect timer.
        return "offline — retrying";
      case "error":
        return `error — ${status.message}`;
      case "paused":
        return `paused — ${status.message}`;
    }
  }

  /**
   * One structured line per decision (requirement 12). A refusal or failure
   * goes out at warn, which DevTools shows by default; routine decisions go
   * out at debug, the level the plugin guidelines reserve for diagnostics.
   */
  log(line: string): void {
    if (FAILURE_DECISION.test(line)) console.warn(`obsync ${line}`);
    else console.debug(`obsync ${line}`);
  }
}
