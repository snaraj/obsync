/**
 * Local device state, persisted in the plugin's own data file.
 *
 * WHERE THE VAULT ROOT KEY LIVES. `vrk` (and the device secret) sit in
 * `<vault>/.obsidian/plugins/obsync/data.json`, inside the vault, exactly as
 * every Obsidian sync plugin must: a plugin has no dependency-free path to
 * an OS keychain (Keychain, Credential Manager, Keystore) — those need
 * native modules, which AGENTS.md requirement 5 forbids, and mobile
 * Obsidian exposes no such API at all. The consequence is stated in
 * `docs/threat-model.md`: a device that is read by its own operating system
 * or by another app with vault access is outside the model. Nothing here
 * ever leaves the device: `transport` sends state fields to the server only
 * as the protocol's opaque ids.
 *
 * The layout is compact on purpose — one entry per vault path, one per
 * remote-only file — because it is rewritten on every save.
 *
 * PLATFORM. Identical on desktop and mobile: Obsidian's `loadData`/
 * `saveData` are the only persistence used, and saves are serialised here so
 * two sync loops cannot interleave a half-written state.
 */

import { Policy, defaultPolicy } from "./policy";

/** Obsidian's `Plugin` provides exactly this pair. */
export interface Store {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface FileRecord {
  fileId: string;
  versionId: string;
  mtime: number;
  size: number;
  sha256: string;
}

export interface RemoteOnlyRecord {
  path: string;
  size: number;
}

export interface EdgeHeader {
  name: string;
  value: string;
}

export interface ObsyncData {
  /** Vault root key, 32 bytes as lowercase hex. `null` until setup or pairing. */
  vrk: string | null;
  deviceId: string | null;
  deviceSecret: string | null;
  /** What this device calls itself, as renamed here or on another device. */
  deviceName: string | null;
  serverUrl: string;
  /** Optional service-token headers required by an access-controlled edge. */
  edgeHeaders: EdgeHeader[];
  /** Last change-feed sequence applied. */
  lastSeq: number;
  /** Vault path to the last version this device wrote or read. */
  files: Record<string, FileRecord>;
  /** Domain id to the vault path prefix it covers. */
  domains: Record<string, string>;
  /** File id to the file this device declined to materialise. */
  remoteOnly: Record<string, RemoteOnlyRecord>;
  policy: Policy;
}

export function defaultData(isMobile: boolean): ObsyncData {
  return {
    vrk: null,
    deviceId: null,
    deviceSecret: null,
    deviceName: null,
    serverUrl: "",
    edgeHeaders: [],
    lastSeq: 0,
    files: {},
    domains: {},
    remoteOnly: {},
    policy: defaultPolicy(isMobile),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Merge a loaded data file onto the defaults, dropping anything of the wrong
 * shape. A corrupt or partial file must degrade to "resync from scratch",
 * never to a crash on load or to a half-typed object handed to the engine.
 */
export function parseData(loaded: unknown, isMobile: boolean): ObsyncData {
  const data = defaultData(isMobile);
  if (!isRecord(loaded)) return data;
  data.vrk = typeof loaded["vrk"] === "string" ? loaded["vrk"] : null;
  data.deviceId = typeof loaded["deviceId"] === "string" ? loaded["deviceId"] : null;
  data.deviceSecret = typeof loaded["deviceSecret"] === "string" ? loaded["deviceSecret"] : null;
  data.deviceName = typeof loaded["deviceName"] === "string" ? loaded["deviceName"] : null;
  data.serverUrl = str(loaded["serverUrl"], "");
  data.lastSeq = num(loaded["lastSeq"], 0);
  const headers = loaded["edgeHeaders"];
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (isRecord(header) && typeof header["name"] === "string" && typeof header["value"] === "string") {
        data.edgeHeaders.push({ name: header["name"], value: header["value"] });
      }
    }
  }
  const files = loaded["files"];
  if (isRecord(files)) {
    for (const [path, record] of Object.entries(files)) {
      if (!isRecord(record)) continue;
      if (typeof record["fileId"] !== "string" || typeof record["versionId"] !== "string") continue;
      data.files[path] = {
        fileId: record["fileId"],
        versionId: record["versionId"],
        mtime: num(record["mtime"], 0),
        size: num(record["size"], 0),
        sha256: str(record["sha256"], ""),
      };
    }
  }
  const domains = loaded["domains"];
  if (isRecord(domains)) {
    for (const [id, prefix] of Object.entries(domains)) {
      if (typeof prefix === "string") data.domains[id] = prefix;
    }
  }
  const remoteOnly = loaded["remoteOnly"];
  if (isRecord(remoteOnly)) {
    for (const [fileId, record] of Object.entries(remoteOnly)) {
      if (!isRecord(record) || typeof record["path"] !== "string") continue;
      data.remoteOnly[fileId] = { path: record["path"], size: num(record["size"], 0) };
    }
  }
  const policy = loaded["policy"];
  if (isRecord(policy)) {
    data.policy = {
      perFileMaxBytes: num(policy["perFileMaxBytes"], data.policy.perFileMaxBytes),
      totalBudgetBytes: num(policy["totalBudgetBytes"], data.policy.totalBudgetBytes),
    };
  }
  return data;
}

/**
 * The device's state with a coalescing, serialised writer.
 *
 * `save()` never runs two writes at once and never drops the newest state:
 * a save requested while one is in flight re-runs the write afterwards once,
 * whatever the number of requests. That is the atomicity available to a
 * plugin — Obsidian's `saveData` replaces the file — and it is what keeps a
 * push loop and a pull loop from writing over each other.
 */
export class State {
  private pending = false;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    public data: ObsyncData,
  ) {}

  static async open(store: Store, isMobile: boolean): Promise<State> {
    return new State(store, parseData(await store.loadData(), isMobile));
  }

  save(): Promise<void> {
    this.pending = true;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.pending) {
          this.pending = false;
          await this.store.saveData(this.data);
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** True once this device holds a vault key and a device credential. */
  get paired(): boolean {
    return this.data.vrk !== null && this.data.deviceId !== null && this.data.deviceSecret !== null;
  }

  fileByPath(path: string): FileRecord | undefined {
    return this.data.files[path];
  }

  pathByFileId(fileId: string): string | undefined {
    for (const [path, record] of Object.entries(this.data.files)) {
      if (record.fileId === fileId) return path;
    }
    return undefined;
  }

  setFile(path: string, record: FileRecord): void {
    this.data.files[path] = record;
    delete this.data.remoteOnly[record.fileId];
  }

  forgetPath(path: string): void {
    delete this.data.files[path];
  }

  /** Bytes held locally, the input to the total-budget ceiling. */
  localBytes(): number {
    let total = 0;
    for (const record of Object.values(this.data.files)) total += record.size;
    return total;
  }
}
