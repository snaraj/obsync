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

import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import { Bytes, hex, randomBytes, unhex } from "./crypto";
import { ByteSource, bytesSource } from "./chunker";
import { State } from "./state";
import { SCOPE_EXPANSION_MESSAGE, assertSyncPath, expandsSyncScope, inSyncScope, inSyncTree, parseSyncFolders } from "./syncScope";
import { DeviceRecord, Transport, lostMessage } from "./transport";
import { EngineStatus, SyncContext, SyncEngine, VaultHost, VaultStat, VaultWriter } from "./sync/engine";
import { fetchRemoteOnly } from "./sync/pull";
import { CopyPublicationError, HistoryBrowser, HistoryEntry, HistoryOperation, restoreCopy } from "./sync/history";
import { newVaultKey, PAIRING_ACTION } from "./pairing";
import { ObsyncSettingTab } from "./ui/settings";
import { PairClaimModal, PairCreateModal, RecoveryPhraseModal, RemoteOnlyModal, StatusModal } from "./ui/modals";
import { HistoryModal } from "./ui/history";
import {
  FinalComponent,
  PathResolver,
  PathStat,
  PathWalker,
  VaultPathError,
  WalkResult,
  assertVaultPath,
  chainRefusal,
  isVaultPath,
  sameFile,
  walkVaultPath,
} from "./vaultPath";

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
    utimes(path: string, atime: number, mtime: number): Promise<void>;
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    /** No-follow stat. Rejects when the path does not exist. */
    lstat(path: string): Promise<PathStat>;
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
 * The one sentence the notice and the settings tab both show when the server
 * runs a newer plugin than this device. Obsidian's plugin manager owns
 * installation and updates; this server can never supply executable code.
 */
export function updateMessage(server: string, local: string): string {
  return (
    `Server runs ${server}, you have ${local}. Open Settings → Community plugins → ` +
    "Check for updates, then update Private Sync."
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

export class ObsidianHost implements VaultHost {
  private readonly desktop: DesktopVault | null;

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
   * nothing here to walk.
   */
  async syncable(path: string): Promise<boolean> {
    if (!inSyncScope(path, this.plugin.state.data.syncFolders)) return false;
    const desktop = this.desktop;
    if (desktop === null) return isVaultPath(path);
    try {
      await this.confine(desktop, path, ["absent", "file", "directory", "other"]);
      return true;
    } catch (error) {
      if (!(error instanceof VaultPathError)) throw error;
      this.plugin.log(`host path_class=file decision=not_synced reason=${error.refusal}`);
      return false;
    }
  }

  get isMobile(): boolean {
    return Platform.isMobile;
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
    const files = this.plugin.app.vault.getFiles();
    const synced = files.filter((file) => isVaultPath(file.path));
    if (synced.length !== files.length) {
      this.plugin.log(`list decision=skipped_unsyncable files=${files.length - synced.length}`);
    }
    return synced.map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size }));
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
      return buffer.subarray(0, filled) as Bytes;
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
          return cached.subarray(offset, offset + length) as Bytes;
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
          return buffer.subarray(0, filled) as Bytes;
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
        const stat = await this.stat(path);
        return { path, mtime: stat?.mtime ?? mtime, size: stat?.size ?? total };
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
            return { path: file.path, mtime: file.stat.mtime, size: file.stat.size };
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
    let open = true;
    let at = 0;
    const discard = async (): Promise<void> => {
      try {
        if (open) await handle.close();
        open = false;
        if (sameFile(opened, await walker(fs).lstat(temp))) await fs.promises.unlink(temp);
      } catch { this.log("history decision=temp_cleanup_failed"); }
    };
    const bind = async (): Promise<void> => {
      guard();
      const refusal = await chainRefusal(found.chain, walker(fs));
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
          return { path, mtime: Math.round(stat.mtimeMs), size: stat.size };
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
   * descriptor is the identity nothing can change, so if the name no longer
   * means the same file, someone raced us and the write is refused. The same
   * comparison runs after the rename, because the rename is the moment the
   * file becomes visible under its real name.
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
    const temp = `${target}.obsync-${hex(randomBytes(6))}.tmp`;
    const handle = await fs.promises.open(temp, "wx");
    let open = true;
    const opened = await handle.stat();

    /** Close, and remove the temp ONLY while its name still means our file. */
    const discard = async (): Promise<void> => {
      if (open) await handle.close();
      open = false;
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
        await fs.promises.rename(temp, target);
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
        const ours = landed as PathStat;
        return { path, mtime: Math.round(ours.mtimeMs), size: ours.size };
      },
      abort: discard,
    };
  }

  /**
   * Obsidian's own vault-rooted delete; both path rules are applied first,
   * and on desktop the chain is checked again afterwards. A delete that went
   * somewhere else leaves the file we identified still sitting there, so
   * finding it afterwards is the signal that the name moved under us.
   */
  async trash(path: string): Promise<void> {
    assertSyncPath(path, this.plugin.state.data.syncFolders);
    const desktop = this.desktop;
    let found: WalkResult | null = null;
    if (desktop !== null) {
      found = await this.confine(desktop, path, ["absent", "file"]);
      if (found.final === "absent") return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file) {
      await this.plugin.app.vault.trash(file, true);
    } else {
      await this.plugin.app.vault.adapter.remove(path).catch(() => undefined);
    }
    if (desktop === null || found === null) return;
    const refusal = await chainRefusal(found.chain, walker(desktop.fs));
    if (refusal !== null) throw new VaultPathError(refusal);
    if (sameFile(found.stat, await walker(desktop.fs).lstat(found.target))) {
      throw new VaultPathError("target_identity");
    }
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
  /** The newer version the server reports, for the settings tab to name. */
  updateAvailable: string | null = null;
  private statusEl: HTMLElement | null = null;
  private statusValue: EngineStatus = { kind: "idle" };
  /** Invalidates continuations from an earlier load, including a load with no engine yet. */
  private lifecycle: object | null = {};
  private changingScope = false;
  private readonly manualFetches = new Set<Promise<string>>();
  private readonly histories = new Set<HistoryBrowser>();
  private restoring: HistoryOperation | null = null;
  private manualRestore: Promise<{ path: string; syncRequested: boolean }> | null = null;

  get isMobile(): boolean {
    return Platform.isMobile;
  }

  override async onload(): Promise<void> {
    const generation = this.lifecycle = {};
    this.changingScope = false;
    // A same-instance reload owns resumption after older writers settle.
    // They may still persist the old State, so wait before taking a snapshot.
    const settling: Promise<unknown>[] = [...this.manualFetches];
    if (this.manualRestore !== null) settling.push(this.manualRestore);
    if (settling.length !== 0) {
      await Promise.allSettled(settling);
      if (!this.isCurrent(generation)) return;
    }
    const state = await State.open(this, Platform.isMobile).catch((error: unknown) => {
      this.log("state decision=refused reason=load_failed");
      throw error;
    });
    if (!this.isCurrent(generation)) return;
    this.state = state;
    this.host = new ObsidianHost(this);
    this.transport = new Transport({
      request: (request) => requestUrl(request),
      serverUrl: () => this.state.data.serverUrl,
      device: () => {
        const { deviceId, deviceSecret } = this.state.data;
        return deviceId && deviceSecret ? { id: deviceId, secret: unhex(deviceSecret) } : null;
      },
      edgeHeaders: () => this.state.data.edgeHeaders,
      log: (line) => this.log(line),
    });
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

    // Use the installation identity for both URI spellings without also
    // claiming the old generic action used by pre-directory installations.
    const pair = (params: Record<string, string>): void => {
      const code = params["code"];
      if (code) new PairClaimModal(this.app, this, code).open();
    };
    this.registerObsidianProtocolHandler(PAIRING_ACTION, pair);
    this.registerObsidianProtocolHandler(`${PAIRING_ACTION}/pair`, pair);

    this.registerVaultEvents();
    if (this.state.paired) await this.startEngine();
    if (this.isCurrent(generation)) void this.checkForUpdate();
  }

  override onunload(): void {
    this.lifecycle = null;
    this.cancelHistories();
    const engine = this.engine;
    this.engine = null;
    engine?.stop();
  }

  private registerVaultEvents(): void {
    const vault = this.app.vault;
    this.registerEvent(
      vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile) this.engine?.changed(file.path);
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
        }
      }),
    );
    this.registerEvent(
      vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          this.engine?.renamed(oldPath, file.path);
        } else if (file instanceof TFolder) {
          // A folder rename moves every tracked path beneath it; each file
          // keeps its file id so other devices move it instead of
          // re-uploading it.
          for (const path of this.pathsUnder(oldPath)) {
            this.engine?.renamed(path, file.path + path.slice(oldPath.length));
          }
        }
      }),
    );
  }

  private pathsUnder(folder: string): string[] {
    const prefix = `${folder}/`;
    return Object.keys(this.state.data.files).filter((path) => path.startsWith(prefix));
  }

  // --- lifecycle ---------------------------------------------------------

  private isCurrent(generation: object | null): boolean {
    return generation !== null && generation === this.lifecycle;
  }

  async startEngine(): Promise<void> {
    const generation = this.lifecycle;
    if (!this.isCurrent(generation) || !this.state.paired || this.changingScope || this.restoring !== null) return;
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
      await engine.start();
    } catch (error) {
      engine.stop();
      if (this.engine !== engine) return;
      this.engine = null;
      this.setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
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
    for (const browser of this.histories) browser.operation.cancel();
    this.histories.clear();
  }

  openHistory(): HistoryBrowser {
    const context = this.syncContext();
    if (!context) throw new Error("Start sync on this paired device before opening history.");
    const generation = this.lifecycle;
    const engine = this.engine;
    const { deviceId, vrk, serverUrl } = this.state.data;
    const operation: HistoryOperation = new HistoryOperation(() => this.isCurrent(generation) && this.engine === engine &&
      !this.changingScope && (this.restoring === null || this.restoring === operation) &&
      this.state.data.deviceId === deviceId && this.state.data.vrk === vrk && this.state.data.serverUrl === serverUrl);
    const browser = new HistoryBrowser(context, operation);
    this.histories.add(browser);
    return browser;
  }

  closeHistory(browser: HistoryBrowser): void {
    browser.operation.cancel();
    this.histories.delete(browser);
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
    return { path: (created as VaultStat).path, syncRequested };
  }

  async fetchRemoteOnly(fileId: string): Promise<string> {
    const context = this.syncContext();
    if (!context) throw new Error("obsync is not running on this device");
    const fetch = fetchRemoteOnly(context, fileId);
    this.manualFetches.add(fetch);
    try {
      return await fetch;
    } finally {
      this.manualFetches.delete(fetch);
    }
  }

  /** A local scope change never alters policy on the server or replays old versions. */
  async saveSyncFolders(value: string[] | undefined): Promise<void> {
    const generation = this.lifecycle;
    const assertActive = (): void => {
      if (!this.isCurrent(generation)) {
        throw new Error("obsync: plugin unloaded during the folder change; restart Obsidian to check the saved selection.");
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
    const assertChange = (): void => {
      const used = state.data.lastSeq !== 0 || Object.keys(state.data.files).length !== 0 ||
        Object.keys(state.data.remoteOnly).length !== 0;
      if (used && expandsSyncScope(state.data.syncFolders, folders)) {
        this.log("scope decision=refused reason=expansion_requires_resync");
        throw new Error(SCOPE_EXPANSION_MESSAGE);
      }
    };
    assertChange();
    if (this.changingScope) throw new Error("obsync: a folder selection is already being saved.");
    this.changingScope = true;
    this.cancelHistories();
    try {
      // Scope changes take effect only after old work is quiescent. A
      // stopped long poll may finish, but must not advance its cursor.
      await this.engine?.stopAndWait();
      assertActive();
      this.engine = null;
      await Promise.allSettled(this.manualFetches);
      await Promise.allSettled(this.manualRestore === null ? [] : [this.manualRestore]);
      assertActive();
      assertChange();
      const previous = state.data.syncFolders;
      state.data.syncFolders = folders;
      try {
        await state.save();
      } catch (error) {
        state.data.syncFolders = previous;
        throw error;
      }
      assertActive();
      this.log(`scope decision=saved mode=${folders === undefined ? "whole_vault" : "selected_folders"} folders=${folders?.length ?? 0}`);
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
    const deviceId = this.state.data.deviceId;
    if (deviceId === null) throw new Error("this device is not paired yet");
    const trimmed = name.trim();
    // An emptied field means "go back to the default", not "keep whatever
    // name I had": the fallback is the DERIVED name, never the stored one.
    const saved = await this.transport.patchDevice(deviceId, {
      name: trimmed === "" ? this.defaultDeviceName() : trimmed,
      policy: this.state.data.policy,
    });
    // A rename is not repeatable, and there is nothing to reconcile against:
    // the name the user typed is not a fact this device can check for, only
    // one the server can confirm. Say so and keep the local copy unchanged,
    // so a retry sends the same thing rather than a half-applied pair.
    if (saved.outcome === "lost") throw new Error(lostMessage("saving this device's settings", saved));
    this.state.data.deviceName = trimmed === "" ? null : trimmed;
    await this.state.save();
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
   * `only_device` on a revoke that already worked. The device list says which
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

  /**
   * Adopt a vault key (new, or restored from a phrase) and start syncing.
   *
   * No domain is declared here: the engine reads the vault's domain map at
   * every start and writes one for a vault that has none, so the domain a
   * path belongs to has exactly one source (`docs/architecture.md` 5.1).
   */
  async adoptVaultKey(vrk: string): Promise<void> {
    this.state.data.vrk = vrk;
    await this.state.save();
    await this.startEngine();
  }

  /**
   * First-time setup: the one-time token the server printed at first boot
   * creates the account and enrols this device.
   */
  async setUpAccount(setupToken: string, accountName: string): Promise<void> {
    try {
      const enrolled = await this.transport.setup(setupToken, accountName, {
        name: this.deviceName(),
        platform: this.platformName(),
        app_version: this.manifest.version,
      });
      // Setup is not repeatable and the credential it mints exists nowhere
      // else: a lost answer means this device may have been enrolled with a
      // secret it never received. There is nothing to read back without a
      // credential, so say exactly that. The token is spent either way, and
      // the server's `409 already_set_up` will say so on the next attempt.
      if (enrolled.outcome === "lost") throw new Error(lostMessage("creating the account", enrolled));
      const result = enrolled.value;
      this.state.data.deviceId = result.device_id;
      this.state.data.deviceSecret = result.device_secret;
      await this.state.save();
      new Notice("obsync: account created and this device enrolled.");
      if (this.state.data.vrk === null) {
        await this.adoptVaultKey(hex(newVaultKey()));
        new RecoveryPhraseModal(this.app, this, true).open();
      } else {
        await this.startEngine();
      }
    } catch (error) {
      new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 8000);
    }
  }

  async openDashboard(): Promise<void> {
    try {
      const link = await this.transport.dashboardLoginLink();
      // A login link is minted and single use. A lost answer means one may
      // have been minted for nobody; it expires in five minutes, and asking
      // for another is the user's own decision, not a retry this makes.
      if (link.outcome === "lost") throw new Error(lostMessage("requesting a dashboard link", link));
      window.open(link.value.url, "_blank");
    } catch (error) {
      new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 8000);
    }
  }

  // --- update notice -----------------------------------------------------

  /**
   * v0.1 HAS NO SELF-UPDATE, by decision (`docs/architecture.md` 6.3). The
   * manifest, the bundle and the stylesheet all come from the same
   * unauthenticated endpoint, so a hostile server or TLS terminator could
   * replace the bytes AND the hash that is supposed to check them; installing
   * that would hand it the vault key at the next reload. This device
   * therefore reads ONE unauthenticated field — the version — and tells the
   * user to open Obsidian's plugin manager. It never fetches the bundle, and
   * nothing in this plugin writes into `.obsidian/plugins/`.
   */
  async checkForUpdate(): Promise<void> {
    const generation = this.lifecycle;
    if (!this.isCurrent(generation) || this.state.data.serverUrl === "") return;
    try {
      const remote = await this.transport.pluginManifest();
      if (!this.isCurrent(generation)) return;
      if (!isNewer(remote.version, this.manifest.version)) return;
      this.updateAvailable = remote.version;
      this.log(`update decision=available server=${remote.version} local=${this.manifest.version}`);
      new Notice(`obsync: ${updateMessage(remote.version, this.manifest.version)}`, 15000);
    } catch (error) {
      if (this.isCurrent(generation)) this.log(`update decision=skipped reason=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The settings tab's update line, or `null` when this device is current. */
  updateLine(): string | null {
    const server = this.updateAvailable;
    return server === null ? null : updateMessage(server, this.manifest.version);
  }

  // --- status ------------------------------------------------------------

  setStatus(status: EngineStatus): void {
    this.statusValue = status;
    this.statusEl?.setText(`obsync: ${this.statusText()}`);
  }

  statusText(): string {
    switch (this.statusValue.kind) {
      case "idle":
        return this.state.paired ? "idle" : "not paired";
      case "syncing":
        return `syncing ${this.statusValue.pending}`;
      case "offline":
        return "offline";
      case "error":
        return `error — ${this.statusValue.message}`;
    }
  }

  log(line: string): void {
    console.log(`obsync ${line}`);
  }
}
