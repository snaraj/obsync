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
 * plugin code is the GitHub Release. Nothing here writes into
 * `.obsidian/plugins/`.
 */

import { MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import type { App } from "obsidian";
import { Bytes, deriveDomainKey, deriveManifestKey, hex, randomBytes, sha256, unhex } from "./crypto";
import { domainMapKeys, loadDomainMap, soleDomain } from "./domainmap";
import { ByteSource } from "./chunker";
import { State, StateStorageError, dataLease, isPushed } from "./state";
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
import { ApiError, DeviceRecord, Transport, lostMessage } from "./transport";
import { EngineStatus, MoveResult, SyncContext, SyncEngine, TrashResult, VaultHost, VaultStat, VaultWriter } from "./sync/engine";
import { fetchRemoteOnly, heldNotes } from "./sync/pull";
import { CopyPublicationError, HistoryBrowser, HistoryEntry, HistoryOperation, restoreCopy } from "./sync/history";
import { newVaultKey, PAIRING_ACTION } from "./pairing";
import { ObsyncSettingTab, SETUP_GUIDE_URL, normalizeServerUrl, serverUrlRefusal } from "./ui/settings";
import { LeaveServerModal, PairClaimModal, PairCreateModal, RecoveryPhraseModal, RemoteOnlyModal, StatusModal } from "./ui/modals";
import { HistoryModal } from "./ui/history";
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
  isVaultPath,
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
 * What makes a folder a vault that syncs with this plugin (issue #180):
 * Obsidian's config folder holding this plugin's own folder, which the
 * community installer names after the directory identity. Only the names are
 * looked at, never what is in them.
 */
const PLUGIN_FOLDER = [".obsidian", "plugins", PAIRING_ACTION];

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
  /** `fstat`: the identity of the OPEN file, which no later swap can change. */
  stat(): Promise<PathStat>;
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
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    /** No-follow stat. Rejects when the path does not exist. */
    lstat(path: string): Promise<PathStat>;
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
        return await fs.promises.lstat(path);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
  };
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

/** The decisions that mean the plugin did NOT do what was asked. */
const FAILURE_DECISION = /\bdecision=(refused|failed|stopped|lost|restore_failed|gave_up|temp_cleanup_failed|unresolved)\b/;

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

/** What Obsidian's plugin manager calls this plugin, as `manifest.json` names it. */
const PLUGIN_NAME = "Self Hosted Private Sync";

/** The tab id of Obsidian's own Community plugins page, where an update is installed. */
const COMMUNITY_PLUGINS_TAB = "community-plugins";

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

/** `1.2.3` is newer than `1.2.2`; anything unparseable is not newer. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(candidate);
  const b = parse(current);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

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

export type LeaveResult =
  | { decision: "left"; revoked: boolean }
  | { decision: "refused"; reason: "unpushed_edits"; unpushed: string[] }
  | { decision: "refused"; reason: "last_device" | "bad_signature"; detail: string };

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

export class ObsidianHost implements VaultHost {
  private readonly desktop: DesktopVault | null;
  /** The temps this host's writers hold open now, which `sweep` never takes. */
  private readonly temps = new Set<string>();
  /** The nested vaults this host has already told the user about, once each. */
  private readonly nested = new Set<string>();

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
    const desktop = this.desktop;
    try {
      if (desktop !== null) await this.confine(desktop, path, ["absent", "file", "directory", "other"]);
      if (await this.inNestedVault(path)) throw new VaultPathError("nested_vault");
      return true;
    } catch (error) {
      if (!(error instanceof VaultPathError)) throw error;
      this.plugin.log(`host path_class=file decision=not_synced reason=${error.refusal}`);
      return false;
    }
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
   * `PLUGIN_FOLDER` is out of sync in both directions, as `.obsidian` is:
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
    if (desktop === null) {
      for (let depth = 1; depth <= segments.length; depth++) {
        const folder = segments.slice(0, depth).join("/");
        if (await this.plugin.app.vault.adapter.exists(`${folder}/${PLUGIN_FOLDER.join("/")}`)) return this.named(folder);
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
      if (await this.holdsPlugin(desktop, (chain[depth] as ChainLink).path)) return this.named(segments.slice(0, depth).join("/"));
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

  /** Does the directory `dir` hold `PLUGIN_FOLDER`, each step a real directory? No-follow, names only. */
  private async holdsPlugin(desktop: DesktopVault, dir: string): Promise<boolean> {
    let at = dir;
    for (const name of PLUGIN_FOLDER) {
      at = desktop.path.resolve(at, name);
      if ((await walker(desktop.fs).lstat(at))?.isDirectory() !== true) return false;
    }
    return true;
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
      return files;
    }
    const synced = await this.inventory();
    const skipped = this.plugin.app.vault.getFiles().length - synced.length;
    if (skipped !== 0) this.plugin.log(`list decision=skipped_unsyncable files=${skipped}`);
    return synced;
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
    if (refusal !== null || !sameFile(found.stat, await handle.stat())) {
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
      const size = (await handle.stat()).size;
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
   * An atomic vault write. Desktop writes a sibling temp file, fsyncs it by
   * closing, restores the modification time and renames over the target, so
   * a crash mid-write can never leave a torn note. Mobile buffers and calls
   * `writeBinary` once, which is the strongest primitive the adapter has.
   */
  async writer(path: string): Promise<VaultWriter> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    if (desktop !== null) return this.desktopWriter(desktop, path);
    const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const parts: Bytes[] = [];
    const adapter = this.plugin.app.vault.adapter;
    return {
      write: async (bytes) => {
        parts.push(bytes);
      },
      commit: async (mtime) => {
        // A folder can stand where a remote manifest names a file now that
        // folders sync, and `writeBinary` would not say so. Desktop refuses
        // it in `confine`; mobile refuses it here, in the same words, so both
        // platforms answer a file/folder collision identically (issue #104).
        if ((await adapter.stat(path))?.type === "folder") throw new VaultPathError("not_a_file");
        if (folder !== "" && !(await adapter.exists(folder))) await adapter.mkdir(folder);
        let total = 0;
        for (const part of parts) total += part.length;
        const joined = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
          joined.set(part, at);
          at += part.length;
        }
        await adapter.writeBinary(path, joined.buffer, { mtime });
        // The SIZE is ours: the bytes handed to the adapter, not what a look
        // at the name says a moment later. The mtime is taken from the name
        // only while the name still holds that many bytes -- a save landing
        // between the write and the lookup must not have its metadata
        // recorded as this version's (round 3, finding 2).
        const stat = await this.stat(path);
        if (stat !== null && stat.size === total) return { path, mtime: stat.mtime, size: total };
        if (stat !== null) this.log("host path_class=file decision=write_superseded");
        return { path, mtime, size: total };
      },
      abort: async () => {
        parts.length = 0;
      },
    };
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
    try { opened = await handle.stat(); } catch (error) { await handle.close(); throw error; }
    this.temps.add(temp);
    let open = true;
    let at = 0;
    // The descriptor's identity is read at each proof, as `desktopWriter`
    // says why: a FAT32 or exFAT volume renumbers the temp at its first byte.
    const discard = async (): Promise<void> => {
      this.temps.delete(temp);
      try {
        if (open) {
          opened = await handle.stat();
          await handle.close();
        }
        open = false;
        if (sameFile(opened, await walker(fs).lstat(temp))) await fs.promises.unlink(temp);
      } catch { this.log("history decision=temp_cleanup_failed"); }
    };
    const bind = async (): Promise<void> => {
      guard();
      const refusal = await chainRefusal(found.chain, walker(fs));
      opened = await handle.stat();
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
        const wrote = await handle.stat();
        await bind();
        await handle.close();
        open = false;
        guard();
        try {
          // link is atomic and cannot replace a destination, even one that
          // appeared after preflight. Never fall back to rename/copyFile.
          await fs.promises.link(temp, found.target);
          // From here on, failure/cancellation preserves the published copy.
          const directory = await fs.promises.open(parent, "r");
          try { await directory.sync(); } finally { await directory.close(); }
          const refusal = await chainRefusal(found.chain, walker(fs));
          const landed = await walker(fs).lstat(found.target);
          if (refusal !== null || !sameFile(opened, landed)) throw new Error("Restore publication identity changed.");
          const stat = landed as PathStat;
          if (stat.size !== wrote.size || Math.round(stat.mtimeMs) !== Math.round(wrote.mtimeMs)) {
            this.log("host path_class=file decision=write_superseded");
          }
          return { path, mtime: Math.round(wrote.mtimeMs), size: wrote.size };
        } catch { throw new CopyPublicationError(path); }
      },
      abort: discard,
    };
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
    let opened = await handle.stat();

    /** Close, and remove the temp ONLY while its name still means our file. */
    const discard = async (): Promise<void> => {
      if (open) {
        opened = await handle.stat();
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
      opened = await handle.stat();
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
        await fs.promises.rename(temp, target);
        this.temps.delete(temp);
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
        // The rename kept the inode, and the inode is what `sameFile` proves
        // -- but an ordinary in-place save keeps the inode too, so identity
        // alone does not say these are still our bytes. The answer is bound
        // to what was written; the name is only reported on.
        const ours = landed as PathStat;
        if (ours.size !== wrote.size || Math.round(ours.mtimeMs) !== Math.round(wrote.mtimeMs)) {
          this.log("host path_class=file decision=write_superseded");
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
   * inode to ask for and asks the adapter's own case-SENSITIVE existence
   * check instead, which answers for the exact spelling and nothing else.
   * An Obsidian older than 1.7.2 ignores that argument and answers for the
   * folded name, so the rename is REFUSED there rather than risked: the
   * caller keeps both files, which is what every version before this one
   * did with a case-only rename anyway.
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
      if (await adapter.exists(to, true)) return "occupied";
      if ((await this.stat(from)) === null) return "missing";
      if (folder !== "" && !(await adapter.exists(folder))) await adapter.mkdir(folder);
      await adapter.rename(from, to);
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
   * exact name on mobile -- wears it, because the folded twin of the source
   * IS the source and re-casing it is the whole operation. Nothing is created
   * above the destination: a folder renamed in place keeps the parents it
   * already had, and a destination whose parents are missing is a move this
   * version does not make.
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
      // The case-SENSITIVE existence check, and an Obsidian older than 1.7.2
      // that ignores the argument answers for the folded name -- which
      // refuses this rename rather than risking it, exactly as `move` does.
      if (await adapter.exists(to, true)) return "occupied";
      if ((await adapter.stat(from))?.type !== "folder") return "missing";
      await adapter.rename(from, to);
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
    return "moved";
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
   */
  async trash(path: string, expect?: VaultStat): Promise<TrashResult> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    let found: WalkResult | null = null;
    if (desktop !== null) {
      found = await this.confine(desktop, path, ["absent", "file"]);
      // Nothing here to remove, and so nothing here to preserve either.
      if (found.final === "absent") return "removed";
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
    return await this.removeHeld(desktop, found, hold, expect, path);
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
      const made = await fs.promises.lstat(folder);
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
      const after = await handle.stat();
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
      const last = await handle.stat();
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
      if (!inFolderScope(entry.path, folders)) continue;
      if (this.desktop !== null) {
        try {
          await this.confine(this.desktop, entry.path, ["directory"]);
        } catch (error) {
          if (!(error instanceof VaultPathError)) throw error;
          this.log(`list decision=not_synced reason=${error.refusal}`);
          continue;
        }
      }
      out.push(entry.path);
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
   * Remove an EMPTY folder, through the same "Deleted files" preference a
   * file delete honours. `false`, having removed nothing, when the folder
   * still holds anything at all.
   *
   * The emptiness question is asked of the FILESYSTEM, not of the vault's
   * synced inventory: a folder holding a hidden file, a file this device does
   * not sync, or another plugin's data still holds something, and
   * `trashFile` on a folder takes everything under it. Desktop reads the
   * directory; mobile asks the adapter, which is all it has.
   */
  async trashFolder(path: string): Promise<boolean> {
    assertFolderScope(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    let found: WalkResult | null = null;
    if (desktop !== null) {
      found = await this.confine(desktop, path, ["absent", "directory"]);
      if (found.final === "absent") return true;
      if ((await desktop.fs.promises.readdir(found.target)).length > 0) return false;
    } else {
      const adapter = this.plugin.app.vault.adapter;
      if ((await adapter.stat(path))?.type !== "folder") return true;
      const listed = await adapter.list(path);
      if (listed.files.length > 0 || listed.folders.length > 0) return false;
    }
    const folder = this.plugin.app.vault.getFolderByPath(path);
    if (folder) await this.plugin.app.fileManager.trashFile(folder);
    else await this.plugin.app.vault.adapter.rmdir(path, false);
    if (desktop === null || found === null) return true;
    // The same proof `trash` takes, one link shorter: the walk's last link IS
    // the folder just removed, so the chain checked here is the parents, and
    // the folder itself must no longer be the directory that was walked.
    const refusal = await chainRefusal(found.chain.slice(0, -1), walker(desktop.fs));
    if (refusal !== null) throw new VaultPathError(refusal);
    const after = await walker(desktop.fs).lstat(found.target);
    if (after !== null && after.isDirectory() && after.dev === found.stat?.dev && after.ino === found.stat?.ino) {
      throw new VaultPathError("target_identity");
    }
    return true;
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
   * leaves and `MarkdownView` -- identical on desktop and mobile. A leaf
   * Obsidian has not loaded yet is not a `MarkdownView` and holds nothing
   * typed.
   */
  async editing(path: string): Promise<"unsaved" | "saved" | null> {
    const views = this.plugin.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path);
    const file = views[0]?.file;
    if (!file) return null;
    const lines = (text: string): string => text.replace(/\r\n?/g, "\n");
    const disk = lines(await this.plugin.app.vault.read(file));
    return views.some((view) => lines(view.getViewData()) !== disk) ? "unsaved" : "saved";
  }

  notify(message: string): void {
    new Notice(message, 10000);
  }

  log(line: string): void {
    this.plugin.log(line);
  }
}

export default class ObsyncPlugin extends Plugin {
  state!: State;
  transport!: Transport;
  host!: ObsidianHost;
  engine: SyncEngine | null = null;
  /** The start and update probe `onload` began and deliberately did not wait for. */
  firstStart: Promise<void> = Promise.resolve();
  /** The newer version the server reports, for the settings tab to name. */
  updateAvailable: string | null = null;
  /** Whether this session has already raised the update notice. */
  private updateNotified = false;
  private statusEl: HTMLElement | null = null;
  private statusValue: EngineStatus = { kind: "idle" };
  /** Invalidates continuations from an earlier load, including a load with no engine yet. */
  private lifecycle: object | null = {};
  private stateLoad: Promise<State | null> | null = null;
  /** Retain stopped writers even after the active engine reference is cleared. */
  private readonly engineTeardowns = new Set<Promise<void>>();
  private changingScope = false;
  private readonly manualFetches = new Set<Promise<string>>();
  private readonly histories = new Set<HistoryBrowser>();
  private restoring: HistoryOperation | null = null;
  private manualRestore: Promise<{ path: string; syncRequested: boolean }> | null = null;
  /**
   * The reconnect a start that could not reach the server left behind: how
   * many starts in a row have failed that way, and the timer for the next
   * one (`null` while that start is running). Absent whenever the engine
   * runs, and whenever it stopped for a reason a later start cannot fix.
   */
  private reconnect: { attempt: number; handle: number | null } | null = null;

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
    }, () => this.isCurrent(generation), dataLease(this.app, this.manifest.id)).catch((error: unknown) => {
      if (!this.isCurrent(generation)) return null;
      throw error;
    });
    const state = await loading;
    if (this.stateLoad === loading) this.stateLoad = null;
    if (!this.isCurrent(generation) || state === null) return;
    this.state = state;
    this.host = new ObsidianHost(this);
    const transport: Transport = new Transport({
      request: (request) => {
        state.assertAvailable();
        if (!this.isCurrent(generation) || this.state !== state) throw new Error("The previous plugin session is inactive.");
        return requestUrl(request);
      },
      serverUrl: () => state.data.serverUrl,
      device: () => {
        const { deviceId, deviceSecret } = state.data;
        return deviceId && deviceSecret ? { id: deviceId, secret: unhex(deviceSecret) } : null;
      },
      edgeHeaders: () => state.data.edgeHeaders,
      log: (line) => this.log(line),
      // Only this session's transport speaks for the status bar.
      reachable: (answered) => {
        if (this.transport === transport) this.reachability(answered);
      },
    });
    this.transport = transport;
    this.statusEl = this.addStatusBarItem();
    this.setStatus({ kind: "idle" });
    this.addSettingTab(new ObsyncSettingTab(this.app, this));

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({ id: "restore-history", name: "Restore from history", callback: () => new HistoryModal(this.app, this).open() });
    this.addCommand({
      id: "pair-device",
      name: "Pair a new device",
      callback: () => new PairCreateModal(this.app, this).open(),
    });
    this.addCommand({
      id: "show-recovery-phrase",
      name: "Show recovery phrase",
      callback: () => new RecoveryPhraseModal(this.app, this, false).open(),
    });
    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => void this.openDashboard() });
    this.addCommand({ id: "open-setup-guide", name: "Open the setup guide", callback: () => this.openSetupGuide() });
    this.addCommand({
      id: "remote-only",
      name: "Show remote-only files",
      callback: () => new RemoteOnlyModal(this.app, this).open(),
    });
    this.addCommand({
      id: "status",
      name: "Show sync status",
      callback: () => new StatusModal(this.app, this).open(),
    });
    this.addCommand({
      id: "leave-server",
      name: "Leave this server",
      callback: () => new LeaveServerModal(this.app, this, "leave").open(),
    });
    this.addCommand({
      id: "switch-server",
      name: "Switch server",
      callback: () => new LeaveServerModal(this.app, this, "switch").open(),
    });

    // Use the installation identity for both URI spellings without also
    // claiming the old generic action used by pre-directory installations.
    const pair = (params: Record<string, string>): void => {
      const code = params["code"];
      if (code) new PairClaimModal(this.app, this, code).open();
    };
    this.registerObsidianProtocolHandler(PAIRING_ACTION, pair);
    this.registerObsidianProtocolHandler(`${PAIRING_ACTION}/pair`, pair);

    this.registerVaultEvents();
    // The device's own word that its network is back is the cheapest signal
    // there is, and the one a laptop lid or a phone leaving a tunnel produces;
    // it runs the pending retry now instead of at the timer, and is nothing
    // otherwise. Identical on desktop and mobile: both renderers raise it.
    this.registerDomEvent(window, "online", () => this.retryNow("online"));
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
    this.firstStart = new Promise<void>((listed) => this.app.workspace.onLayoutReady(() => listed())).then(async () => {
      if (this.state.paired) await this.startEngine();
      if (this.isCurrent(generation)) void this.checkForUpdate();
    });
  }

  override onunload(): void {
    this.lifecycle = null;
    this.cancelHistories();
    this.teardownEngine();
  }

  private registerVaultEvents(): void {
    const vault = this.app.vault;
    this.registerEvent(
      vault.on("create", (file: TAbstractFile) => {
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
      vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          this.engine?.renamed(oldPath, file.path);
        } else if (file instanceof TFolder) {
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
          if (caseOnly(oldPath, file.path)) {
            this.engine?.folderRenamed(oldPath, file.path, before);
            this.engine?.renamedFolder(oldPath, file.path, before);
          } else {
            this.engine?.renamedFolder(oldPath, file.path, before);
            this.engine?.folderRenamed(oldPath, file.path, before);
          }
        }
      }),
    );
  }

  private pathsUnder(folder: string): string[] {
    const prefix = `${folder}/`;
    return Object.keys(this.state.data.files).filter((path) => path.startsWith(prefix));
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

  async startEngine(): Promise<void> {
    const generation = this.lifecycle;
    if (!this.isCurrent(generation) || !this.state.paired || this.changingScope || this.restoring !== null) return;
    // Whoever asked for this start owns it: a reconnect still pending would
    // be a second engine, so its timer is taken here and its count carried,
    // and the start below either closes the cycle or continues it.
    this.takeReconnectTimer();
    this.cancelHistories();
    const previous = this.engine;
    await previous?.stopAndWait();
    if (!this.isCurrent(generation) || this.changingScope || this.restoring !== null || this.engine !== previous) return;
    const engine: SyncEngine = new SyncEngine({
      state: this.state,
      transport: this.transport,
      host: this.host,
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
      if (nested !== null) {
        if (this.statusValue.kind !== "error" || this.statusValue.message !== nested) new Notice(`obsync: ${nested}`, 15000);
        throw new Error(nested);
      }
      await engine.start();
      if (this.engine === engine && this.reconnect !== null) {
        this.log(`engine decision=resumed attempt=${this.reconnect.attempt}`);
        this.reconnect = null;
        // A quiet start emits no status of its own -- the drain speaks only
        // when there is work -- so the `offline` this cycle set is cleared
        // here, and only that: a `syncing` the new engine already raised is
        // its own to keep.
        if (this.statusValue.kind === "offline") this.setStatus({ kind: "idle" });
      }
    } catch (error) {
      if (this.engine !== engine) { engine.stop(); return; }
      const attempt = (this.reconnect?.attempt ?? 0) + 1;
      this.teardownEngine();
      if (!unreachable(error)) {
        // A refusal, or a local fault: visible until the person acts, and
        // never knocked on again by a timer (issue #129).
        const code = error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown";
        this.log(`engine decision=stopped reason=start_failed code=${code}`);
        this.setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.scheduleReconnect(attempt, error.status);
      this.setStatus({ kind: "offline" });
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
    this.reconnect = { attempt, handle: window.setTimeout(() => this.retryNow("timer"), delay) };
    this.log(`engine decision=retry_scheduled attempt=${attempt} delay_ms=${delay} status=${status}`);
  }

  /** Disarm the pending reconnect timer, keeping the count. Whether one was armed. */
  private takeReconnectTimer(): boolean {
    const pending = this.reconnect;
    if (pending === null || pending.handle === null) return false;
    window.clearTimeout(pending.handle);
    pending.handle = null;
    return true;
  }

  /** Run the pending reconnect now -- the timer's own turn, or the device saying its network is back. */
  private retryNow(reason: string): void {
    if (!this.takeReconnectTimer()) return;
    this.log(`engine decision=retrying attempt=${this.reconnect?.attempt ?? 0} reason=${reason}`);
    void this.startEngine();
  }

  /** Drop the pending reconnect, timer and count: the next failure opens a new cycle. */
  private cancelReconnect(): void {
    this.takeReconnectTimer();
    this.reconnect = null;
  }

  async restartEngine(): Promise<void> {
    await this.startEngine();
  }

  async syncNow(): Promise<void> {
    if (this.changingScope || this.restoring !== null) return;
    if (!this.engine) {
      await this.startEngine();
      return;
    }
    await this.engine.syncNow();
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
   * this device authored is its own echo, a version its head already reaches
   * is `already_incorporated`, a tombstone for a file it no longer tracks is
   * skipped, and local content the server never received is kept beside the
   * incoming version rather than replaced (`sync/pull.ts`). Narrowing keeps
   * its cursor: nothing new is covered, so there is nothing to replay.
   */
  async saveSyncFolders(value: string[] | undefined): Promise<void> {
    const generation = this.lifecycle;
    const assertActive = (): void => {
      if (!this.isCurrent(generation)) {
        throw new Error("The plugin unloaded during the folder change; restart Obsidian to check the saved selection.");
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
    try {
      // Scope changes take effect only after old work is quiescent. A
      // stopped long poll may finish, but must not advance its cursor.
      await this.engine?.stopAndWait();
      assertActive();
      this.engine = null;
      // A retry that fired into a failed save would restart sync under a
      // status that says it is stopped; the start at the end owns resumption.
      this.cancelReconnect();
      await Promise.allSettled(this.manualFetches);
      await Promise.allSettled(this.manualRestore === null ? [] : [this.manualRestore]);
      assertActive();
      const previous = state.data.syncFolders;
      const cursor = state.data.lastSeq;
      // Decided after the quiesce, against the selection that was in force
      // while the stopped work ran.
      const widened = expandsSyncScope(previous, folders);
      state.data.syncFolders = folders;
      if (widened) state.data.lastSeq = 0;
      try {
        await state.save();
      } catch (error) {
        state.data.syncFolders = previous;
        state.data.lastSeq = cursor;
        throw error;
      }
      assertActive();
      this.log(
        `scope decision=saved mode=${folders === undefined ? "whole_vault" : "selected_folders"} folders=${folders?.length ?? 0} ` +
          `replay=${widened ? "from_zero" : "none"} from_seq=${cursor}`,
      );
      // Redrawn now: whether the status line names an empty selection is this save's to change.
      this.setStatus(this.statusValue);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.log("scope decision=failed reason=not_saved");
        this.setStatus({ kind: "error", message: "Folder selection was not saved. Sync is stopped; retry before restarting Obsidian." });
      } else {
        this.log("scope decision=cancelled reason=plugin_unloaded");
      }
      throw error;
    } finally {
      if (this.isCurrent(generation)) this.changingScope = false;
    }
    await this.startEngine();
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
   * platform-and-id default until they give it one.
   */
  deviceName(): string {
    const chosen = this.state.data.deviceName;
    return chosen !== null && chosen.trim() !== "" ? chosen.trim() : this.defaultDeviceName();
  }

  /** The name a device answers to before anyone renames it. */
  defaultDeviceName(): string {
    const id = this.state.data.deviceId;
    return id === null ? this.platformName() : `${this.platformName()}-${id.slice(0, 4)}`;
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
  }

  /** Every device paired to this vault, for the settings tab's device list. */
  async listDevices(): Promise<DeviceRecord[]> {
    return (await this.transport.devices()).devices;
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
   * it was, and reading it is repeatable.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    const sent = await this.transport.revokeDevice(deviceId);
    if (sent.outcome === "lost") {
      const revoked = (await this.listDevices()).find((device) => device.device_id === deviceId)?.revoked;
      this.log(`device decision=reconciled reason=lost_answer revoked=${revoked === true}`);
      if (revoked !== true) throw new Error(lostMessage(`revoking that device`, sent));
    }
    this.log(`device decision=revoked self=${deviceId === this.state.data.deviceId}`);
    if (deviceId === this.state.data.deviceId) {
      await this.engine?.stopAndWait();
      this.engine = null;
      this.setStatus({ kind: "error", message: "this device was revoked" });
    }
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
    for (const file of await this.host.list()) {
      if (!(await this.tracked(file.path))) continue;
      seen.add(file.path);
      if (!isPushed(state.fileByPath(file.path), file.mtime, file.size)) unpushed.push(file.path);
    }
    for (const path of Object.keys(state.data.files)) {
      if (seen.has(path) || !(await this.tracked(path))) continue;
      unpushed.push(path);
    }
    return unpushed.sort();
  }

  /** A path this device syncs: the engine's own rule (`engine.ts`, `tracked`). */
  private async tracked(path: string): Promise<boolean> {
    return vaultPathRefusal(path) === null && inSyncScope(path, this.state.data.syncFolders) && (await this.host.syncable(path));
  }

  /**
   * How many notes here the server's vault does not already hold, byte for
   * byte at the same path (issue #141). It posts nothing. A claimant asks it
   * before its first sync, which publishes every such note to every device
   * syncing that vault: that is how pairing a second vault merged two. A
   * version too large to carry a whole-file digest is matched by size.
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
    for (const file of await this.host.list()) {
      if (!(await this.tracked(file.path))) continue;
      local++;
      const there = held?.get(file.path);
      const same = there !== undefined && there.size === file.size &&
        (there.sha256 === "" || hex(await sha256(await this.host.read(file.path))) === there.sha256);
      if (!same) unknown++;
    }
    this.log(
      `pairing role=claimant decision=surveyed local=${local} unknown=${unknown} held=${held?.size ?? 0} duration_ms=${Date.now() - started}`,
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
   * The server refuses to revoke the only ACTIVE device (`409 last_device`),
   * because an account with no active device can never sync again and nothing
   * in this release re-enrols one. That refusal is surfaced verbatim and the
   * user may still leave LOCALLY, which is `localOnly`: this device forgets
   * the server, the server keeps the device. A server that does not know this
   * device at all (`401 bad_signature`: rebuilt, restored, or another server)
   * is offered the same local leave, never taken without asking, because a
   * wrong address answers it too (#143). No other device is touched on
   * either path; only this device's id is ever sent.
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
    try {
      const deviceId = state.data.deviceId;
      if (deviceId === null) {
        reason = "not_paired";
        throw new Error("This device is not paired with a server.");
      }
      if (this.changingScope || this.restoring !== null) {
        reason = "busy";
        throw new Error("This device is changing its folder selection or restoring a version. Leave the server once that finishes.");
      }
      // Quiesce first, so the count below is a fact rather than a guess and
      // no push, fetch or restore is still running against the credential
      // this is about to give up.
      await this.engine?.stopAndWait();
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
        await this.revokeDevice(deviceId);
        revoked = true;
      } catch (error) {
        reason = error instanceof ApiError ? error.code : "local_or_lost";
        // Revoked already -- from another device or the dashboard (#143, S80):
        // what leaving asks of the server is done, so this device forgets it
        // too, which is the one way back to pairing again.
        if (error instanceof ApiError && error.code === "device_revoked") revoked = true;
        else if (!(error instanceof ApiError) || (error.code !== "last_device" && error.code !== "bad_signature")) throw error;
        else if (!choice.localOnly) return { decision: "refused", reason: error.code, detail: error.detail };
      }
      assertCurrent();
      state.forgetPairing();
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
      this.setStatus({ kind: "idle" });
      if (reason === "unfinished") reason = "ok";
      return { decision: "left", revoked };
    } finally {
      this.log(
        `unpair decision=${revoked ? "revoked" : cleared ? "left_locally" : "refused"} reason=${reason} unpushed=${unpushed} ` +
          `local_cleared=${cleared} previous_credential=${previous} duration_ms=${Date.now() - started}`,
      );
      // However this ended, a device that is still paired goes on syncing:
      // no refusal here may leave the engine stopped. A device that DID
      // leave starts nothing, because `startEngine` requires `paired`.
      await this.startEngine();
    }
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
  }

  /**
   * Adopt a vault key (new, or restored from a phrase) and start syncing.
   *
   * No domain is declared here: the engine reads the vault's domain map at
   * every start and writes one for a vault that has none, so the domain a
   * path belongs to has exactly one source (`docs/architecture.md` 5.1).
   */
  async adoptVaultKey(vrk: string): Promise<void> {
    const { state, assertCurrent } = this.captureSession();
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
    if (state.data.deviceId === null) return false;
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
    await this.adoptVaultKey(vrk);
  }

  /**
   * First-time setup: the token the server writes privately at first boot
   * creates the account and enrols this device.
   */
  async setUpAccount(setupToken: string, accountName: string): Promise<void> {
    try {
      const { state, transport, assertCurrent } = this.captureSession();
      if (state.data.deviceId !== null || state.data.deviceSecret !== null) {
        throw new Error("This device already has an enrollment. Finish device approval first, then restore its recovery phrase if needed; do not repeat server setup.");
      }
      const nested = await this.nestedRefusal("setup");
      if (nested !== null) {
        new Notice(`obsync: ${nested}`, 12000);
        return;
      }
      const enrolled = await transport.setup(setupToken, accountName, {
        name: this.deviceName(),
        platform: this.platformName(),
        app_version: this.manifest.version,
      });
      assertCurrent();
      // Setup is not repeatable and the credential it mints exists nowhere
      // else: a lost answer means this device may have been enrolled with a
      // secret it never received. There is nothing to read back without a
      // credential, so say exactly that. Setup cannot be repeated; the token
      // remains the dashboard's recovery sign-in, not a second enrollment.
      if (enrolled.outcome === "lost") throw new Error(lostMessage("creating the account", enrolled));
      const result = enrolled.value;
      state.data.deviceId = result.device_id;
      state.data.deviceSecret = result.device_secret;
      await state.save();
      assertCurrent();
      new Notice("Account created and this device enrolled.");
      if (state.data.vrk === null) {
        await this.adoptVaultKey(hex(newVaultKey()));
        assertCurrent();
        new RecoveryPhraseModal(this.app, this, true).open();
      } else {
        await this.startEngine();
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "local_or_lost";
      this.log(`setup decision=failed reason=${code}`);
      // One server holds one vault (#141): the one route left after this
      // refusal, pairing, would merge a second vault into the first.
      const text = code === "already_set_up"
        ? "This server already holds a vault, and one server holds one vault. If this is that vault, use Pair this device with a code from a device that syncs it; a different vault needs a server of its own."
        : error instanceof Error ? error.message : String(error);
      new Notice(`obsync: ${text}`, 12000);
    }
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
    if (!this.isCurrent(generation) || this.state.data.serverUrl === "") return;
    try {
      const remote = await this.transport.pluginManifest();
      if (!this.isCurrent(generation)) return;
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
      if (this.isCurrent(generation)) this.log(`update decision=skipped reason=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The settings tab's deletions-held line, or `null` when the last pass
   * published everything it found (issue #123).
   */
  heldDeletionLine(): string | null {
    const held = this.engine?.heldDeletionCount ?? 0;
    if (held === 0) return null;
    return `obsync can no longer see ${held} note(s) it syncs here and has NOT told your other devices. ` +
      "If a folder was renamed or moved outside Obsidian, put it back or select it under its new name. " +
      "Confirm only if you really deleted them: this removes them from every device.";
  }

  /** The user's word that the held deletions were real (issue #123). */
  confirmHeldDeletions(): void {
    this.engine?.confirmHeldDeletions();
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
    this.statusValue = status;
    this.statusEl?.setText(`obsync: ${this.statusText()}`);
  }

  /**
   * The `offline` this session's transport raised, and the status it covered.
   * Held by identity, so an answer takes back only the `offline` it caused.
   */
  private unanswered: { shown: EngineStatus; covered: EngineStatus } | null = null;

  /**
   * What the transport learned on its last attempt, shown at once.
   *
   * THE STATUS BAR MUST NOT SAY `idle` WHILE NOTHING CAN SYNC. The transport
   * retries a request it gets no answer to for its whole budget -- about a
   * minute and a half -- before anything is thrown, and until then the engine
   * said nothing, so a device opened away from its server read `idle` for that
   * long before `offline — retrying` appeared (measured in the 2026-09-23 run).
   * An unanswered attempt now shows `offline — retrying` at once, which is what
   * the transport is doing, and the next answer puts back what it covered.
   *
   * Only `idle` and `syncing` are covered: an `error` needs the person and is
   * never hidden, and an unpaired device has no sync to be offline from. An
   * answer takes back only the `offline` this raised, never the engine's own
   * or the reconnect cycle's, whose start clears it when it succeeds.
   */
  private reachability(answered: boolean): void {
    if (!answered) {
      const kind = this.statusValue.kind;
      if (!this.state.paired || (kind !== "idle" && kind !== "syncing")) return;
      const shown: EngineStatus = { kind: "offline" };
      this.unanswered = { shown, covered: this.statusValue };
      this.log("engine decision=offline reason=unanswered");
      this.setStatus(shown);
      return;
    }
    const raised = this.unanswered;
    this.unanswered = null;
    if (raised === null || this.statusValue !== raised.shown) return;
    this.log("engine decision=online reason=answered");
    this.setStatus(raised.covered);
  }

  statusText(): string {
    switch (this.statusValue.kind) {
      case "idle":
        // A bare `idle` over a selection of no folders read as all being well (issue #150, S30d).
        if (!this.state.paired) return "not paired";
        return this.state.data.syncFolders?.length === 0 ? "idle — syncing no folders" : "idle";
      case "syncing":
        return `syncing ${this.statusValue.pending}`;
      case "offline":
        // True of both places that set it: the running engine polls again
        // in seconds, and a stopped one is on the reconnect timer.
        return "offline — retrying";
      case "error":
        return `error — ${this.statusValue.message}`;
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
