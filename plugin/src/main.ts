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
 * UPDATES ARE NEVER INSTALLED FROM THE SERVER (`docs/architecture.md` 6.3).
 * The plugin compares versions and tells the user; the trusted source of
 * plugin code is the GitHub Release. Nothing here writes into
 * `.obsidian/plugins/`.
 */

import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import { Bytes, hex, randomBytes, unhex } from "./crypto";
import { ByteSource, bytesSource } from "./chunker";
import { State } from "./state";
import { DeviceRecord, Transport } from "./transport";
import { EngineStatus, SyncContext, SyncEngine, VaultHost, VaultStat, VaultWriter } from "./sync/engine";
import { fetchRemoteOnly } from "./sync/pull";
import { newDomainId, newVaultKey } from "./pairing";
import { ObsyncSettingTab } from "./ui/settings";
import { PairClaimModal, PairCreateModal, RecoveryPhraseModal, RemoteOnlyModal, StatusModal } from "./ui/modals";

// The Node filesystem, reached through Electron's `require`. Typed narrowly
// rather than as `any`: only these five calls are used, and only on desktop.
interface NodeFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}
interface NodeFs {
  promises: {
    open(path: string, flags: string): Promise<NodeFileHandle>;
    mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    utimes(path: string, atime: number, mtime: number): Promise<void>;
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  };
}
declare const require: (id: string) => unknown;

function nodeFs(): NodeFs | null {
  if (!Platform.isDesktopApp) return null;
  try {
    return require("fs") as NodeFs;
  } catch {
    return null;
  }
}

/** The GitHub Release that carries a version's plugin bundle and its hashes. */
export function releaseUrl(version: string): string {
  return `https://github.com/snaraj/obsync/releases/tag/v${version}`;
}

/**
 * The one sentence the notice and the settings tab both show when the server
 * runs a newer plugin than this device. It names the file to install and
 * where it comes from, because obsync will not install it for the user: a
 * server that could serve the code could serve any code.
 */
export function updateMessage(server: string, local: string): string {
  return (
    `Server runs ${server}, you have ${local}; update from the GitHub Release ` +
    `(obsync-plugin-v${server}.zip) and reinstall: ${releaseUrl(server)}`
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

class ObsidianHost implements VaultHost {
  private readonly fs: NodeFs | null;
  private readonly basePath: string | null;

  constructor(private readonly plugin: ObsyncPlugin) {
    this.fs = nodeFs();
    const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
    this.basePath = this.fs && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
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

  async list(): Promise<VaultStat[]> {
    return this.plugin.app.vault
      .getFiles()
      .map((file) => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size }));
  }

  async stat(path: string): Promise<VaultStat | null> {
    const stat = await this.plugin.app.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") return null;
    return { path, mtime: stat.mtime, size: stat.size };
  }

  async read(path: string): Promise<Bytes> {
    return new Uint8Array(await this.plugin.app.vault.adapter.readBinary(path));
  }

  /**
   * Desktop reads a window at a time straight off the disk, so a 20 GB file
   * never lands in memory. Mobile has no such API and buffers the file once.
   */
  source(path: string, size: number): ByteSource {
    const fs = this.fs;
    const base = this.basePath;
    if (!fs || base === null) {
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
      read: async (offset, length) => {
        const handle = await fs.promises.open(`${base}/${path}`, "r");
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
    const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const fs = this.fs;
    const base = this.basePath;
    if (fs && base !== null) {
      if (folder !== "") await fs.promises.mkdir(`${base}/${folder}`, { recursive: true });
      const temp = `${base}/${path}.obsync-${hex(randomBytes(6))}.tmp`;
      const handle = await fs.promises.open(temp, "w");
      let open = true;
      return {
        write: async (bytes) => {
          await handle.write(bytes);
        },
        commit: async (mtime) => {
          await handle.close();
          open = false;
          const seconds = mtime / 1000;
          await fs.promises.utimes(temp, seconds, seconds);
          await fs.promises.rename(temp, `${base}/${path}`);
          const stat = await fs.promises.stat(`${base}/${path}`);
          return { path, mtime: Math.round(stat.mtimeMs), size: stat.size };
        },
        abort: async () => {
          if (open) await handle.close();
          await fs.promises.unlink(temp).catch(() => undefined);
        },
      };
    }
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

  async trash(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file) {
      await this.plugin.app.vault.trash(file, true);
      return;
    }
    await this.plugin.app.vault.adapter.remove(path).catch(() => undefined);
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

  get isMobile(): boolean {
    return Platform.isMobile;
  }

  override async onload(): Promise<void> {
    this.state = await State.open(this, Platform.isMobile);
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

    // Obsidian routes `obsidian://obsync/pair?code=…` by the action segment;
    // both spellings are registered so a pasted link works either way.
    const pair = (params: Record<string, string>): void => {
      const code = params["code"];
      if (code) new PairClaimModal(this.app, this, code).open();
    };
    this.registerObsidianProtocolHandler("obsync", pair);
    this.registerObsidianProtocolHandler("obsync/pair", pair);

    this.registerVaultEvents();
    if (this.state.paired) await this.startEngine();
    void this.checkForUpdate();
  }

  override onunload(): void {
    this.engine?.stop();
    this.engine = null;
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

  async startEngine(): Promise<void> {
    if (!this.state.paired) return;
    this.engine?.stop();
    this.engine = new SyncEngine({
      state: this.state,
      transport: this.transport,
      host: this.host,
      domainId: this.defaultDomainId(),
      onStatus: (status) => this.setStatus(status),
    });
    try {
      await this.engine.start();
    } catch (error) {
      this.engine = null;
      this.setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async restartEngine(): Promise<void> {
    await this.startEngine();
  }

  async syncNow(): Promise<void> {
    if (!this.engine) {
      await this.startEngine();
      return;
    }
    await this.engine.syncNow();
  }

  syncContext(): SyncContext | null {
    return this.engine?.context ?? null;
  }

  async fetchRemoteOnly(fileId: string): Promise<string> {
    const context = this.syncContext();
    if (!context) throw new Error("obsync is not running on this device");
    return fetchRemoteOnly(context, fileId);
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
    await this.transport.patchDevice(deviceId, {
      name: trimmed === "" ? this.defaultDeviceName() : trimmed,
      policy: this.state.data.policy,
    });
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
   */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.transport.revokeDevice(deviceId);
    this.log(`device decision=revoked self=${deviceId === this.state.data.deviceId}`);
    if (deviceId === this.state.data.deviceId) {
      this.engine?.stop();
      this.engine = null;
      this.setStatus({ kind: "error", message: "this device was revoked" });
    }
  }

  defaultDomainId(): string {
    for (const [id, prefix] of Object.entries(this.state.data.domains)) {
      if (prefix === "") return id;
    }
    const first = Object.keys(this.state.data.domains)[0];
    return first ?? "";
  }

  /** Adopt a vault key (new, or restored from a phrase) and start syncing. */
  async adoptVaultKey(vrk: string): Promise<void> {
    this.state.data.vrk = vrk;
    if (this.defaultDomainId() === "") {
      const domainId = newDomainId();
      this.state.data.domains[domainId] = "";
      await this.transport.createDomain(domainId).catch((error: unknown) => {
        this.log(`domain decision=deferred reason=${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await this.state.save();
    await this.startEngine();
  }

  /**
   * First-time setup: the one-time token the server printed at first boot
   * creates the account and enrols this device.
   */
  async setUpAccount(setupToken: string, accountName: string): Promise<void> {
    try {
      const result = await this.transport.setup(setupToken, accountName, {
        name: this.deviceName(),
        platform: this.platformName(),
        app_version: this.manifest.version,
      });
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
      window.open(link.url, "_blank");
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
   * user where the trusted copy is. It never fetches the bundle, and nothing
   * in this plugin writes into `.obsidian/plugins/`. Signed updates against
   * a key pinned in the installed plugin are a v0.2 item.
   */
  async checkForUpdate(): Promise<void> {
    if (this.state.data.serverUrl === "") return;
    try {
      const remote = await this.transport.pluginManifest();
      if (!isNewer(remote.version, this.manifest.version)) return;
      this.updateAvailable = remote.version;
      this.log(`update decision=available server=${remote.version} local=${this.manifest.version}`);
      new Notice(`obsync: ${updateMessage(remote.version, this.manifest.version)}`, 15000);
    } catch (error) {
      this.log(`update decision=skipped reason=${error instanceof Error ? error.message : String(error)}`);
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
