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
 * PLATFORM. Obsidian 1.13.0 or newer is required. Unavailable secret storage
 * stops loading or saving; plaintext is never a fallback. Immediate secret
 * readback and awaited saveData do not promise a crash-durable transaction
 * across the two host stores. The bounded previous credential record allows
 * reload to select the revision named by metadata after an interrupted write;
 * an unknown revision or identity mismatch stops loading.
 */

import { Policy, defaultPolicy } from "./policy";
import { isVaultPath } from "./vaultPath";
import { parseSyncFolders } from "./syncScope";
import { hex, isHex, randomBytes } from "./crypto";

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
  /**
   * The name this version's manifest carries, when the pull path landed it
   * BESIDE that name because another file held it here (issue #149). Absent
   * when the file sits at its own name. It is what makes beside temporary:
   * the note is moved to this name as soon as the name is free
   * (`sync/pull.ts`, `settleBeside`).
   */
  name?: string;
  /**
   * The SERVER's time for `versionId`, from the feed entry or version record
   * it arrived in -- this device's own posts learn theirs from their echo.
   * Absent until then, and on every record written before 1.1.3. It places
   * the version against the feed mark when a restored server has lost it
   * (`sync/restore.ts`, issue #145); a record without one is never re-sent
   * from its version's position.
   */
  ts?: number;
}

/**
 * A folder this device has a published record for. It has no content, so
 * there is nothing to remember but which version last said it exists.
 */
export interface FolderRecord {
  fileId: string;
  versionId: string;
}

/**
 * Has this device pushed exactly what the vault now holds at a path? ONE
 * definition, shared by the engine's startup reconcile and by the
 * unpushed-edit guard in front of leaving a server, so the two can never
 * disagree about what "not pushed yet" means. A record is written only after
 * the server acknowledges the version, and a rename clears its `mtime`
 * (`sync/engine.ts`), so an unpublished move counts as unpushed too.
 */
export function isPushed(record: FileRecord | undefined, mtime: number, size: number): boolean {
  return record !== undefined && record.mtime === mtime && record.size === size;
}

/**
 * The last change-feed entry this device processed (issue #145). The journal
 * never reuses a seq on a server that has not been rebuilt from a backup, so
 * this entry, asked for again, is how a device learns its server went back in
 * time; `ts` is the server's own clock at that entry, the line between what
 * this device has already seen and what was written after the rebuild.
 * `replay` is set while the feed is re-read from zero after a rebuild: every
 * entry before this one is skipped, and the first entry after it replaces it.
 */
export interface FeedMark {
  seq: number;
  fileId: string;
  versionId: string;
  ts: number;
  replay: boolean;
}

/**
 * A tombstone this device published or applied (issue #145): the one
 * positive evidence a deletion may be re-sent from after a restored server
 * lost it. Keyed by file id, dropped when that file id is recorded again.
 */
export interface Grave {
  versionId: string;
  path: string;
  folder: boolean;
  /** The tombstone's server time, as `FileRecord.ts`. */
  ts?: number;
}

/**
 * How many graves are kept, oldest dropped first (logged). A deletion older
 * than the newest thousand is not re-sent after a restore: the note comes back
 * on a device paired afterwards, and nothing is deleted anywhere.
 */
export const GRAVES_MAX = 1000;

export interface RemoteOnlyRecord {
  path: string;
  size: number;
}

export interface ParkedRecord {
  path: string;
  /** An `UNWRITABLE` key, or `active_editor` while a native editor settles. */
  reason: string;
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
  /**
   * Vault path to the folder record covering it. Separate from `files`
   * because everything that walks `files` — startup reconciliation, the byte
   * inventory, chunk repair — means FILES, and a folder in that map would be
   * reconciled as a file the vault no longer has and tombstoned for it.
   */
  folders: Record<string, FolderRecord>;
  /** File id to the file this device declined to materialise. */
  remoteOnly: Record<string, RemoteOnlyRecord>;
  /**
   * Selected folders whose OWN record a tombstone has just retired, to the
   * file id it retired -- the one state in which a folder record that differs
   * from a selected folder by capitalisation alone is this device's own
   * folder under a new name rather than a second folder on a device that
   * keeps the two spellings apart (`sync/pull.ts`, `admitFolderRecord`;
   * review round 4, finding 1). Persisted because the tombstone and the
   * record that follows it are two feed entries, and a restart between them
   * must not turn a rename into a stranger.
   */
  retiredRoots: Record<string, string>;
  /**
   * Folder records this device owes the server that ORDER the moves queued
   * behind them: a rename by capitalisation alone, whose record is the only
   * thing entitled to re-case a directory on a folding receiver
   * (`sync/engine.ts`, `takeBatch`; `docs/protocol.md`). Persisted because a
   * stop between the publication and its acknowledgement would otherwise
   * leave the next start's pass to re-derive the record with no barrier, and
   * the moves went out in front of it (review round 4, finding 3).
   */
  folderBarriers: string[];
  /**
   * File id to a record the feed moved past because THIS device could not
   * write it -- a locked note, a read-only folder, a full disk, a chunk the
   * server does not hold -- with the path and the reason to show
   * (`sync/engine.ts`, `park`; issue #144). Persisted with the cursor that
   * skipped it: forgetting it would lose that change on this device for good.
   */
  parked: Record<string, ParkedRecord>;
  /**
   * File id to a note this device stopped syncing because something here
   * rewrote it right after another device's version arrived, on the lines
   * that device changed too -- two plugins stamping it, as a rule
   * (`sync/pull.ts`, `rewriteStorm`; issue #179). Nothing about it is
   * published or applied until the user resumes it, so it is persisted: a
   * restart must not start the bounce again unasked.
   */
  paused: Record<string, { path: string; remote?: true }>;
  /** The last feed entry processed, `null` until the first (issue #145). */
  feedMark: FeedMark | null;
  /** File id to the tombstone this device published or applied for it. */
  graves: Record<string, Grave>;
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
    folders: {},
    remoteOnly: {},
    retiredRoots: {},
    folderBarriers: [],
    parked: {},
    paused: {},
    feedMark: null,
    graves: {},
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

function isHeader(value: unknown): value is { name: string; value: string } {
  return isRecord(value) && typeof value["name"] === "string" && typeof value["value"] === "string";
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
  const headers: unknown = loaded["edgeHeaders"] === undefined ? [] : loaded["edgeHeaders"];
  if (!Array.isArray(headers) || !headers.every(isHeader)) throw new StateStorageError("invalid_edge_headers");
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
      const name = record["name"];
      if (isVaultPath(name)) (data.files[path] as FileRecord).name = name;
      if (typeof record["ts"] === "number" && Number.isFinite(record["ts"])) data.files[path].ts = record["ts"];
    }
  }
  const folders = loaded["folders"];
  if (isRecord(folders)) {
    for (const [path, record] of Object.entries(folders)) {
      // Same rule as `files`: the data file is editable by anything that can
      // reach the vault, so a path it names is input, not memory.
      if (!isVaultPath(path) || !isRecord(record)) continue;
      if (typeof record["fileId"] !== "string" || typeof record["versionId"] !== "string") continue;
      data.folders[path] = { fileId: record["fileId"], versionId: record["versionId"] };
    }
  }
  // Both of these are the device's own bookkeeping about work in flight, and
  // the data file is editable by anything that can reach the vault, so every
  // entry is judged as input: a path that is not a vault path, or a value of
  // the wrong shape, is dropped rather than handed to the engine.
  const retired = loaded["retiredRoots"];
  if (isRecord(retired)) {
    for (const [path, fileId] of Object.entries(retired)) {
      if (!isVaultPath(path) || typeof fileId !== "string") continue;
      data.retiredRoots[path] = fileId;
    }
  }
  const barriers = loaded["folderBarriers"];
  if (Array.isArray(barriers)) {
    for (const path of barriers as unknown[]) {
      if (!isVaultPath(path) || data.folderBarriers.includes(path)) continue;
      data.folderBarriers.push(path);
    }
  }
  const parked = loaded["parked"];
  if (isRecord(parked)) {
    for (const [fileId, record] of Object.entries(parked)) {
      // The file id goes into a request path and the path onto the screen;
      // the reason only chooses words, so a damaged one keeps the record.
      if (!isHex(fileId, 16) || !isRecord(record) || !isVaultPath(record["path"])) continue;
      data.parked[fileId] = { path: record["path"], reason: str(record["reason"], "") };
    }
  }
  const paused = loaded["paused"];
  if (isRecord(paused)) {
    for (const [fileId, record] of Object.entries(paused)) {
      if (isHex(fileId, 16) && isRecord(record) && isVaultPath(record["path"])) data.paused[fileId] = { path: record["path"], ...(record["remote"] === true ? { remote: true } : {}) };
    }
  }
  // The mark names a request path and the graves a request path and a
  // publication, so a malformed field is dropped rather than trusted: no mark
  // is a device that has not read the feed yet, never a restored server.
  const mark = loaded["feedMark"];
  if (isRecord(mark) && Number.isSafeInteger(mark["seq"]) && (mark["seq"] as number) >= 1 &&
    typeof mark["fileId"] === "string" && isHex(mark["fileId"], 16) &&
    typeof mark["versionId"] === "string" && isHex(mark["versionId"], 32) &&
    typeof mark["ts"] === "number" && Number.isFinite(mark["ts"]) && typeof mark["replay"] === "boolean") {
    data.feedMark = { seq: mark["seq"] as number, fileId: mark["fileId"], versionId: mark["versionId"], ts: mark["ts"], replay: mark["replay"] };
  }
  const graves = loaded["graves"];
  if (isRecord(graves)) {
    for (const [fileId, grave] of Object.entries(graves).slice(-GRAVES_MAX)) {
      if (!isHex(fileId, 16) || !isRecord(grave) || typeof grave["versionId"] !== "string" ||
        !isHex(grave["versionId"], 32) || !isVaultPath(grave["path"]) || typeof grave["folder"] !== "boolean") continue;
      data.graves[fileId] = { versionId: grave["versionId"], path: grave["path"], folder: grave["folder"] };
      if (typeof grave["ts"] === "number" && Number.isFinite(grave["ts"])) data.graves[fileId].ts = grave["ts"];
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
 * Who may write the data file NOW: the newest session, and the write it has
 * in flight (issue #181).
 *
 * ONE PER WINDOW AND PLUGIN, NOT PER PLUGIN OBJECT. Turning the plugin off
 * and on builds a new object from a fresh evaluation of the bundle while the
 * old one is still draining the upload it was stopped in, and that drain ends
 * with a save of the OLD State -- minutes later, because every request of an
 * inactive session is refused and retried as a network error. Landing after
 * the new object read the file, it put back the cursor and records of the
 * session before (S98). Nothing in this module outlives the object, so the
 * lease hangs off the window's global, keyed by the `app` both objects share.
 * A renderer reload or a force-quit ends the old window, and its writers
 * with it.
 */
export interface Lease {
  holder: object | null;
  writing: Promise<unknown>;
}

export function dataLease(app: object, pluginId: string): Lease {
  const scope = globalThis as unknown as Record<symbol, WeakMap<object, Map<string, Lease>> | undefined>;
  const windows = scope[Symbol.for("obsync.dataLease")] ??= new WeakMap();
  const leases = windows.get(app) ?? new Map<string, Lease>();
  windows.set(app, leases);
  const lease = leases.get(pluginId) ?? { holder: null, writing: Promise.resolve() };
  leases.set(pluginId, lease);
  return lease;
}

/**
 * The device's state with a coalescing, serialised writer.
 *
 * `save()` never runs two writes at once and never drops the newest state:
 * a save requested while one is in flight re-runs the write afterwards once,
 * whatever the number of requests. Each write uses a detached snapshot, with
 * a matching credential revision. Any persistence failure blocks this state
 * until reload; callers must not keep syncing from uncertain credentials.
 *
 * AND ONLY THE NEWEST SESSION WRITES (`Lease`). Opening claims the lease
 * before reading, then waits for a write already dispatched; from the claim
 * on, an older State refuses every write, `superseded`, before it touches
 * either store.
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
    private readonly lease: Lease,
    private readonly claim: object,
  ) {}

  static async open(
    store: Store, isMobile: boolean, secrets: SecretStore,
    onFailure: (error: StateStorageError) => void = () => {},
    isCurrent: () => boolean = () => true,
    lease: Lease = { holder: null, writing: Promise.resolve() },
  ): Promise<State> {
    let state: State;
    let migrate = false;
    const claim = lease.holder = {};
    try {
      if (!secrets || typeof secrets.getSecret !== "function" || typeof secrets.setSecret !== "function") {
        throw new StateStorageError("unavailable");
      }
      await Promise.allSettled([lease.writing]);
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
        state = new State(store, data, secrets, id, selected, envelope, raw, onFailure, lease, claim);
      } else {
        Object.assign(data, credentials(metadata));
        const id = hex(randomBytes(16));
        if (secrets.getSecret(secretRef(id)) !== null) throw new StateStorageError("reference_exists");
        state = new State(store, data, secrets, id, null, null, null, onFailure, lease, claim);
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

  /** Refuse every write once a newer session has claimed the data file (`Lease`). */
  private assertHolder(): void {
    if (this.lease.holder !== this.claim) {
      throw new StateStorageError("superseded", "A newer obsync session took over this vault's sync; this one stopped.");
    }
  }

  private async persist(snapshot: ObsyncData): Promise<void> {
    this.assertHolder();
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
      await (this.lease.writing = this.store.saveData({ ...bookkeeping, storageVersion: 1, installationId: this.installationId,
        credentialRef: ref, credentialRevision: selected.revision }));
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

  /**
   * Leave a server: drop this device's identity and everything derived from
   * it, and nothing else. The caller saves.
   *
   * KEPT, deliberately: the vault key, so pairing again — with this server or
   * another — is the SAME vault and not a new one; the folder selection, both
   * ceilings and the name this device answers to, which are the user's
   * choices and not the server's. DROPPED: the device id and its secret, the
   * server address, the edge headers (a service token belongs to the server
   * it was issued for and must never be sent to the next one), the change-feed
   * cursor and every file record. No vault file is touched here; nothing in
   * this class can touch one.
   */
  forgetPairing(): void {
    this.assertAvailable();
    this.data.deviceId = null;
    this.data.deviceSecret = null;
    this.data.serverUrl = "";
    this.data.edgeHeaders = [];
    this.data.lastSeq = 0;
    this.data.files = {};
    // FOLDER RECORDS GO WITH THE FILE RECORDS, for the same reason and one
    // sharper. A folder's file id is `HMAC(K_m,d, …)` over its path, so it
    // names nothing on a different server -- and `pushFolder` returns early
    // when a record exists, so a record kept across a leave would tell this
    // device that every folder it has is already published, and the new
    // server would never receive one (#79 meeting #104).
    this.data.folders = {};
    // AND THE BOOKKEEPING ABOUT WORK IN FLIGHT WITH THEM. A retirement names
    // a folder record this device no longer has, and a barrier is a record
    // owed to a server this device has left: carried across a leave, the
    // first would admit a stranger's folder record at a selected folder and
    // the second would post a record for a vault the new server knows nothing
    // about.
    this.data.retiredRoots = {};
    this.data.folderBarriers = [];
    // And a parked record, which names a version on the server being left,
    // and the feed mark and the graves, which name entries and versions there
    // too: a mark carried to the next server would read its journal as a
    // restored one.
    this.data.parked = {};
    this.data.paused = {};
    this.data.feedMark = null;
    this.data.graves = {};
    this.data.remoteOnly = {};
  }

  /**
   * Drop the bounded previous revision, so a device that has just given up a
   * server does not leave the credential it gave up sitting in the native
   * store. `SecretStorage` declares no delete (`test/api-compatibility`), so
   * the entry is rewritten without its history rather than removed.
   *
   * Crash-safe BY CONSTRUCTION, which is why it is a second write rather than
   * part of `persist`: metadata still names `current`, and `current` is
   * byte-identical in both envelopes, so an interruption between them leaves
   * a revision that loads either way. It refuses unless the recorded revision
   * IS `current` and `current` carries no credential, because collapsing
   * history under any other condition could drop the revision an interrupted
   * write is still named by.
   */
  async forgetPreviousCredential(): Promise<void> {
    this.assertAvailable();
    // Read the records only once nothing is mid-write, so the revision this
    // decides on is the revision metadata actually names.
    await this.settled();
    this.assertAvailable();
    this.assertHolder();
    const envelope = this.envelope;
    if (envelope === null || envelope.previous === null) return;
    if (this.record === null || this.record.revision !== envelope.current.revision ||
      envelope.current.deviceId !== null || envelope.current.deviceSecret !== null) {
      throw new StateStorageError("credential_present");
    }
    const ref = secretRef(this.installationId);
    if (this.secrets.getSecret(ref) !== this.serializedSecret) throw new StateStorageError("secret_changed");
    const collapsed: SecretEnvelope = { ...envelope, previous: null };
    const serialized = JSON.stringify(collapsed);
    try { this.secrets.setSecret(ref, serialized); }
    catch { throw new StateStorageError("secret_write_failed"); }
    if (this.secrets.getSecret(ref) !== serialized) throw new StateStorageError("secret_readback_failed");
    this.envelope = collapsed;
    this.serializedSecret = serialized;
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
    // A file id recorded again is alive here: its old tombstone is no
    // deletion to re-send.
    delete this.data.graves[record.fileId];
  }

  forgetPath(path: string): void {
    delete this.data.files[path];
  }

  folderByPath(path: string): FolderRecord | undefined {
    return this.data.folders[path];
  }

  setFolder(path: string, record: FolderRecord): void {
    this.data.folders[path] = record;
    delete this.data.graves[record.fileId];
    // A RECORD WRITTEN FOR THIS FOLDER ENDS ITS RETIREMENT. The receiving
    // rule is "the tombstone for this folder's record has been applied and no
    // record has been written for it since" (`sync/pull.ts`,
    // `admitFolderRecord`), and this is every writer of one -- the feed's own
    // create, a re-case, and this device's own publication.
    delete this.data.retiredRoots[path];
  }

  forgetFolder(path: string): void {
    delete this.data.folders[path];
  }

  /**
   * Remember a tombstone (issue #145), newest last, and return how many of
   * the oldest `GRAVES_MAX` pushed out; the caller logs a drop.
   */
  bury(fileId: string, grave: Grave): number {
    delete this.data.graves[fileId];
    this.data.graves[fileId] = grave;
    const over = Object.keys(this.data.graves).slice(0, -GRAVES_MAX);
    for (const id of over) delete this.data.graves[id];
    return over.length;
  }

  /** Bytes held locally, the input to the total-budget ceiling. */
  localBytes(): number {
    let total = 0;
    for (const record of Object.values(this.data.files)) total += record.size;
    return total;
  }
}
