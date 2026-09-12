/**
 * Local bookkeeping lives in the plugin data file. The vault key, device
 * credential and edge headers live in one plugin-owned SecretStorage entry.
 * Only its exact validated ID is read or written; other secrets are never
 * enumerated. The native store is shared with trusted plugins in this vault,
 * not an isolation boundary against those plugins or the local OS.
 *
 * The layout is compact on purpose — one entry per vault path, one per
 * remote-only file — because it is rewritten on every save.
 *
 * PLATFORM. Obsidian 1.12.4 or newer is required. Unavailable secret storage
 * stops loading or saving; plaintext is never a fallback. Immediate secret
 * readback and awaited saveData do not promise a crash-durable transaction
 * across the two host stores. The bounded previous credential record allows
 * reload to select the revision named by metadata after an interrupted write;
 * an unknown revision or identity mismatch stops loading.
 */

import { Policy, defaultPolicy } from "./policy";
import { isVaultPath } from "./vaultPath";
import { parseSyncFolders } from "./syncScope";
import { hex, randomBytes } from "./crypto";

/** The supported native API surface; deliberately no enumeration method. */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export class StateStorageError extends Error {
  constructor(readonly reason: string, message?: string) {
    super(message ?? `Credential storage could not be verified (${reason}). Sync is stopped. Keep this vault and its settings intact, check Obsidian secret storage, then reload. Do not repeat server setup or delete the credential reference.`);
  }
}

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
  /** File id to the file this device declined to materialise. */
  remoteOnly: Record<string, RemoteOnlyRecord>;
  policy: Policy;
  /** Only this device may set it. Missing = whole vault; [] = no files. */
  syncFolders?: string[];
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

type Credentials = Pick<ObsyncData, "vrk" | "deviceId" | "deviceSecret" | "edgeHeaders">;
interface CredentialRevision extends Credentials { revision: number; serverUrl: string; }
interface SecretEnvelope {
  version: 1;
  installationId: string;
  current: CredentialRevision;
  previous: CredentialRevision | null;
}

function credentials(loaded: Record<string, unknown>): Credentials {
  const field = (name: string, bytes: number): string | null => {
    const value = loaded[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
      throw new StateStorageError("invalid_credentials");
    }
    return value;
  };
  const vrk = field("vrk", 32), deviceId = field("deviceId", 16), deviceSecret = field("deviceSecret", 32);
  if ((deviceId === null) !== (deviceSecret === null)) throw new StateStorageError("incomplete_credential");
  const headers = loaded["edgeHeaders"] === undefined ? [] : loaded["edgeHeaders"];
  if (!Array.isArray(headers) || headers.some((header) => !isRecord(header) ||
    typeof header["name"] !== "string" || typeof header["value"] !== "string")) {
    throw new StateStorageError("invalid_edge_headers");
  }
  return { vrk, deviceId, deviceSecret, edgeHeaders: headers.map((header) => ({ name: header.name, value: header.value })) };
}

function secretRef(installationId: string): string {
  if (!/^[0-9a-f]{32}$/.test(installationId)) throw new StateStorageError("invalid_installation");
  return `obsync-private-sync-v1-${installationId}`;
}

function readEnvelope(raw: string, installationId: string): SecretEnvelope {
  const envelope: unknown = JSON.parse(raw);
  const fields = ["version", "installationId", "current", "previous"];
  if (!isRecord(envelope) || Object.keys(envelope).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(envelope, key)) || envelope["version"] !== 1 ||
    envelope["installationId"] !== installationId) throw new StateStorageError("invalid_envelope");
  const record = (value: unknown): CredentialRevision => {
    const fields = ["revision", "serverUrl", "deviceId", "deviceSecret", "vrk", "edgeHeaders"];
    if (!isRecord(value) || Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key)) ||
      typeof value["serverUrl"] !== "string" || typeof value["revision"] !== "number" ||
      !Number.isSafeInteger(value["revision"]) || value["revision"] < 1) throw new StateStorageError("invalid_envelope");
    return { revision: value["revision"], serverUrl: value["serverUrl"], ...credentials(value) };
  };
  const current = record(envelope["current"]);
  const previous = envelope["previous"] === null ? null : record(envelope["previous"]);
  if (previous !== null && previous.revision >= current.revision) throw new StateStorageError("invalid_envelope");
  return { version: 1, installationId, current, previous };
}

/**
 * Parse noncritical bookkeeping onto defaults. State.open validates identity
 * and credential persistence separately before this data reaches the engine.
 */
export function parseData(loaded: unknown, isMobile: boolean): ObsyncData {
  const data = defaultData(isMobile);
  if (!isRecord(loaded)) return data;
  // A damaged restriction must never fall back to the whole vault. Refuse
  // loading rather than dropping this field like an optional preference.
  if (Object.hasOwn(loaded, "syncFolders")) data.syncFolders = parseSyncFolders(loaded["syncFolders"]);
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
      // A data file is editable by anything that can reach the vault, so the
      // paths it names are input, not memory: an entry that is not a vault
      // path is dropped rather than handed to the engine (`vaultPath.ts`).
      if (!isVaultPath(path)) continue;
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
  const remoteOnly = loaded["remoteOnly"];
  if (isRecord(remoteOnly)) {
    for (const [fileId, record] of Object.entries(remoteOnly)) {
      if (!isRecord(record) || !isVaultPath(record["path"])) continue;
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
 * whatever the number of requests. Each write uses a detached snapshot, with
 * a matching credential revision. Any persistence failure blocks this state
 * until reload; callers must not keep syncing from uncertain credentials.
 */
export class State {
  private pending = false;
  private flushing: Promise<void> | null = null;
  private failure: StateStorageError | null = null;

  private constructor(
    private readonly store: Store,
    public data: ObsyncData,
    private readonly secrets: SecretStore,
    private readonly installationId: string,
    private record: CredentialRevision | null,
    private envelope: SecretEnvelope | null,
    private serializedSecret: string | null,
    private readonly onFailure: (error: StateStorageError) => void,
  ) {}

  static async open(
    store: Store, isMobile: boolean, secrets: SecretStore,
    onFailure: (error: StateStorageError) => void = () => {},
    isCurrent: () => boolean = () => true,
  ): Promise<State> {
    let state: State;
    let migrate = false;
    try {
      if (!secrets || typeof secrets.getSecret !== "function" || typeof secrets.setSecret !== "function") {
        throw new StateStorageError("unavailable");
      }
      const loaded = await store.loadData();
      if (!isCurrent()) throw new StateStorageError("inactive_load");
      if (loaded != null && !isRecord(loaded)) throw new StateStorageError("invalid_metadata");
      const metadata = loaded ?? {};
      let data: ObsyncData;
      try { data = parseData(metadata, isMobile); }
      catch (error) {
        throw new StateStorageError("invalid_sync_folders", error instanceof Error ? error.message : "Invalid saved folder selection; sync is stopped.");
      }
      const versioned = ["storageVersion", "installationId", "credentialRef", "credentialRevision"]
        .some((key) => Object.hasOwn(metadata, key));
      if (versioned) {
        const id = metadata["installationId"], revision = metadata["credentialRevision"];
        if (metadata["storageVersion"] !== 1 || typeof id !== "string" ||
          typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
          typeof metadata["serverUrl"] !== "string" ||
          ["vrk", "deviceSecret", "edgeHeaders"].some((key) => Object.hasOwn(metadata, key))) {
          throw new StateStorageError("invalid_metadata");
        }
        const ref = secretRef(id);
        if (metadata["credentialRef"] !== ref) throw new StateStorageError("invalid_reference");
        const raw = secrets.getSecret(ref);
        if (raw === null) throw new StateStorageError("missing_secret");
        const envelope = readEnvelope(raw, id);
        const selected = [envelope.current, envelope.previous].find((record) => record?.revision === revision);
        if (!selected || selected.serverUrl !== metadata["serverUrl"] || selected.deviceId !== metadata["deviceId"]) {
          throw new StateStorageError("identity_mismatch");
        }
        Object.assign(data, credentials({ ...selected }));
        state = new State(store, data, secrets, id, selected, envelope, raw, onFailure);
      } else {
        Object.assign(data, credentials(metadata));
        const id = hex(randomBytes(16));
        if (secrets.getSecret(secretRef(id)) !== null) throw new StateStorageError("reference_exists");
        state = new State(store, data, secrets, id, null, null, null, onFailure);
        migrate = true;
      }
    } catch (error) {
      const failure = error instanceof StateStorageError ? error : new StateStorageError("load_failed");
      onFailure(failure);
      throw failure;
    }
    if (migrate) await state.save();
    return state;
  }

  assertAvailable(): void {
    if (this.failure !== null) throw this.failure;
  }

  /** Let a replacement plugin load wait for an already-dispatched metadata write. */
  settled(): Promise<void> { return this.flushing ?? Promise.resolve(); }

  private async persist(snapshot: ObsyncData): Promise<void> {
    if (typeof snapshot.serverUrl !== "string") throw new StateStorageError("invalid_server");
    const { vrk, deviceSecret, edgeHeaders, ...bookkeeping } = snapshot;
    const verified = credentials({ vrk, deviceSecret, edgeHeaders, deviceId: snapshot.deviceId });
    const ref = secretRef(this.installationId);
    if (this.secrets.getSecret(ref) !== this.serializedSecret) throw new StateStorageError("secret_changed");
    const payload = { serverUrl: snapshot.serverUrl, ...verified };
    const previousPayload = this.record === null ? null : { serverUrl: this.record.serverUrl, ...credentials({ ...this.record }) };
    let selected: CredentialRevision;
    if (this.record !== null && JSON.stringify(payload) === JSON.stringify(previousPayload)) {
      selected = this.record;
    } else {
      const revision = (this.envelope?.current.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new StateStorageError("revision_exhausted");
      selected = { revision, ...payload };
      const envelope: SecretEnvelope = { version: 1, installationId: this.installationId, current: selected, previous: this.record };
      const serialized = JSON.stringify(envelope);
      try { this.secrets.setSecret(ref, serialized); }
      catch { throw new StateStorageError("secret_write_failed"); }
      if (this.secrets.getSecret(ref) !== serialized) throw new StateStorageError("secret_readback_failed");
      this.envelope = envelope;
      this.serializedSecret = serialized;
    }
    try {
      await this.store.saveData({ ...bookkeeping, storageVersion: 1, installationId: this.installationId,
        credentialRef: ref, credentialRevision: selected.revision });
    } catch { throw new StateStorageError("metadata_write_failed"); }
    this.record = selected;
  }

  async save(): Promise<void> {
    this.assertAvailable();
    this.pending = true;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.pending) {
          this.pending = false;
          await this.persist(JSON.parse(JSON.stringify(this.data)) as ObsyncData);
        }
      } catch (error) {
        this.failure = error instanceof StateStorageError ? error : new StateStorageError("save_failed");
        this.pending = false;
        this.onFailure(this.failure);
        throw this.failure;
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  /** True once this device holds a vault key and a device credential. */
  get paired(): boolean {
    return this.failure === null && this.data.vrk !== null && this.data.deviceId !== null && this.data.deviceSecret !== null;
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
