/**
 * The wire client for `docs/protocol.md` v1.
 *
 * Every call goes through Obsidian's `requestUrl` (injected as `request`),
 * which is the only HTTP surface available on all platforms: mobile
 * WebViews cannot `fetch` a cross-origin host, and `requestUrl` also frees
 * the request from CORS. `throw: false` is set on every call so a 4xx is
 * data, not an exception, and every refusal can be logged with its code.
 *
 * SIGNING IS NOT OPTIONAL. `call()` signs whenever the endpoint is a device
 * endpoint, and the endpoint decides, not a setting (AGENTS.md requirement
 * 4). The only unsigned calls are the three the protocol defines as
 * unauthenticated: `POST /v1/setup`, `POST /v1/pairing/{id}/claim` (the
 * device has no credential yet; the enroll token in the body is the
 * authenticator) and `GET /v1/plugin/manifest`, from which this client reads
 * ONE field, the version. Code served by the server is never fetched: an
 * unauthenticated endpoint can be replaced by whoever terminates TLS, so the
 * trusted source of plugin code is the GitHub Release, not this transport.
 *
 * BACKOFF. Network errors and 5xx retry with exponential backoff and
 * jitter, 1 s doubling to a 60 s ceiling, half fixed and half random so a
 * fleet of devices does not resynchronise on the same second. 4xx never
 * retries: a refusal is a decision.
 *
 * PLATFORM. Identical on desktop and mobile. Mobile is HTTPS-only, so a
 * plain-HTTP server URL is rejected at the settings tab, not here.
 */

import { Bytes, bodyHash, hex, randomBytes, signRequest, unhex, utf8 } from "./crypto";
import { EdgeHeader } from "./state";
import { Policy } from "./policy";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
  throw: false;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export type RequestFn = (request: HttpRequest) => Promise<HttpResponse>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${status} ${code}: ${detail}`);
    this.name = "ApiError";
  }
}

export interface TransportOptions {
  request: RequestFn;
  serverUrl: () => string;
  /** The device credential, or `null` before pairing. */
  device: () => { id: string; secret: Bytes } | null;
  edgeHeaders: () => EdgeHeader[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (line: string) => void;
  maxAttempts?: number;
}

export interface ChangeRecord {
  seq: number;
  file_id: string;
  version_id: string;
  parents: string[];
  sids: string[];
  bytes: number;
  manifest_ct: string;
  manifest_nonce: string;
  device_id: string;
  ts: number;
  deleted: boolean;
  heads: string[];
  conflicted: boolean;
}

/** One version as `GET /v1/files/{id}` renders it: no file id, no feed seq,
 * no head or conflict flags. Those live on the file object around it, which is
 * why a version cannot be spread into a `ChangeRecord` without adding them. */
export type VersionRecord = Omit<ChangeRecord, "seq" | "file_id" | "heads" | "conflicted">;

export interface FileRecord {
  file_id: string;
  domain_id: string;
  heads: string[];
  conflicted: boolean;
  versions: VersionRecord[];
}

export interface ChangesPage {
  seq: number;
  head_seq: number;
  changes: ChangeRecord[];
}

export interface VersionPost {
  version_id: string;
  parents: string[];
  sids: string[];
  bytes: number;
  /**
   * The domain the file belongs to, in clear (`docs/architecture.md` 5.1
   * item 4). A random id that means nothing without the owner-only map, and
   * the label phase-2 authorization will filter the feed and chunk access
   * with. The server records it on the file's first version and refuses a
   * later version that names a different one.
   */
  domain_id: string;
  manifest_ct: string;
  manifest_nonce: string;
  deleted: boolean;
}

export interface VersionAck {
  seq: number;
  heads: string[];
  conflicted: boolean;
}

export interface DeviceRecord {
  device_id: string;
  name: string;
  platform: string;
  app_version: string;
  last_seen: number;
  revoked: boolean;
}

export interface PairingCreated {
  pairing_id: string;
  enroll_token: string;
  expires: number;
}

export interface PairingClaimant {
  device_id: string;
  name: string;
  platform: string;
  app_version: string;
}

export interface PairingStatus {
  state: "open" | "claimed" | "approved" | "consumed" | "expired";
  claimant: PairingClaimant | null;
}

export interface PairingCredential {
  device_id: string;
  device_secret: string;
}

export interface PairingEnvelope {
  envelope: string;
  nonce: string;
}

/** Only the field the plugin reads; the served hashes are the Install page's. */
export interface PluginManifest {
  version: string;
}

/** The long-poll ceiling, chosen to stay inside a 100 s edge idle limit. */
export const MAX_WAIT_SECONDS = 55;
const BACKOFF_START_MS = 1000;
const BACKOFF_CEILING_MS = 60000;

type CallOptions = {
  auth: "device" | "none";
  json?: unknown;
  binary?: Bytes;
  accept?: "json" | "binary" | "text";
  retry?: boolean;
};

function toArrayBuffer(bytes: Bytes): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

export class Transport {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private readonly maxAttempts: number;

  constructor(private readonly options: TransportOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? (() => Math.random());
    this.log = options.log ?? (() => undefined);
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  /** Half-fixed, half-random exponential backoff, capped at 60 s. */
  backoffMs(attempt: number): number {
    const base = Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** (attempt - 1));
    return Math.round(base / 2 + this.random() * (base / 2));
  }

  private async call(method: string, target: string, options: CallOptions): Promise<HttpResponse> {
    const base = this.options.serverUrl().replace(/\/+$/, "");
    if (base === "") throw new ApiError(0, "no_server_url", "no server URL is configured");
    const headers: Record<string, string> = {};
    let body: Bytes = new Uint8Array(0);
    let bodyText: string | undefined;
    if (options.json !== undefined) {
      bodyText = JSON.stringify(options.json);
      body = utf8(bodyText);
      headers["Content-Type"] = "application/json";
    } else if (options.binary !== undefined) {
      body = options.binary;
      headers["Content-Type"] = "application/octet-stream";
    }
    if (options.auth === "device") {
      const device = this.options.device();
      if (!device) throw new ApiError(0, "not_paired", "this device is not paired");
      const ts = Math.floor(this.now() / 1000);
      const nonce = hex(randomBytes(16));
      headers["X-Obsync-Device"] = device.id;
      headers["X-Obsync-Ts"] = String(ts);
      headers["X-Obsync-Nonce"] = nonce;
      headers["X-Obsync-Sig"] = await signRequest(
        device.secret,
        method,
        target,
        ts,
        nonce,
        await bodyHash(body),
      );
    }
    for (const header of this.options.edgeHeaders()) headers[header.name] = header.value;

    const started = this.now();
    for (let attempt = 1; ; attempt++) {
      let response: HttpResponse | null = null;
      let failure = "";
      try {
        response = await this.options.request({
          url: base + target,
          method,
          headers,
          ...(bodyText !== undefined
            ? { body: bodyText }
            : body.length > 0
              ? { body: toArrayBuffer(body) }
              : {}),
          throw: false,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (response && response.status < 500) {
        if (response.status >= 400) {
          const { code, detail } = parseError(response.text);
          this.log(`http ${method} ${target} status=${response.status} decision=refused code=${code} duration_ms=${this.now() - started}`);
          throw new ApiError(response.status, code, detail);
        }
        this.log(`http ${method} ${target} status=${response.status} decision=ok attempts=${attempt} duration_ms=${this.now() - started}`);
        return response;
      }
      const reason = response ? `status=${response.status}` : `network=${failure}`;
      if (attempt >= this.maxAttempts) {
        this.log(`http ${method} ${target} ${reason} decision=gave_up attempts=${attempt} duration_ms=${this.now() - started}`);
        throw new ApiError(response ? response.status : 0, "unreachable", reason);
      }
      const delay = this.backoffMs(attempt);
      this.log(`http ${method} ${target} ${reason} decision=retry attempt=${attempt} backoff_ms=${delay}`);
      await this.sleep(delay);
    }
  }

  private async json<T>(method: string, target: string, options: CallOptions): Promise<T> {
    const response = await this.call(method, target, options);
    return (response.text === "" ? {} : JSON.parse(response.text)) as T;
  }

  // --- setup and account -------------------------------------------------

  /**
   * First boot: the one-time setup token creates the account AND enrols this
   * device in one step, because every later enrolment goes through pairing
   * and pairing needs an already-paired device (`docs/protocol.md`, setup).
   * The token is the credential, so the call is unsigned.
   */
  setup(
    setupToken: string,
    accountName: string,
    device: { name: string; platform: string; app_version: string },
  ): Promise<PairingCredential & { account_id: string }> {
    return this.json("POST", "/v1/setup", {
      auth: "none",
      json: { setup_token: setupToken, account_name: accountName, device },
    });
  }

  account(): Promise<{ account_id: string; name: string; used_bytes: number; quota_bytes: number; device_count: number }> {
    return this.json("GET", "/v1/account", { auth: "device" });
  }

  // --- pairing -----------------------------------------------------------

  pairingCreate(): Promise<PairingCreated> {
    return this.json("POST", "/v1/pairing", { auth: "device", json: {} });
  }

  pairingClaim(
    pairingId: string,
    enrollToken: string,
    info: { name: string; platform: string; app_version: string },
  ): Promise<PairingCredential> {
    return this.json("POST", `/v1/pairing/${pairingId}/claim`, {
      auth: "none",
      json: { enroll_token: enrollToken, ...info },
    });
  }

  pairingStatus(pairingId: string): Promise<PairingStatus> {
    return this.json("GET", `/v1/pairing/${pairingId}`, { auth: "device" });
  }

  pairingApprove(pairingId: string, envelope: string, nonce: string): Promise<void> {
    return this.json("POST", `/v1/pairing/${pairingId}/approve`, {
      auth: "device",
      json: { envelope, nonce },
    });
  }

  pairingReject(pairingId: string): Promise<void> {
    return this.json("POST", `/v1/pairing/${pairingId}/reject`, { auth: "device", json: {} });
  }

  pairingEnvelope(pairingId: string): Promise<PairingEnvelope> {
    return this.json("GET", `/v1/pairing/${pairingId}/envelope`, { auth: "device" });
  }

  // --- devices -----------------------------------------------------------

  devices(): Promise<{ devices: DeviceRecord[] }> {
    return this.json("GET", "/v1/devices", { auth: "device" });
  }

  patchDevice(deviceId: string, patch: { name?: string; policy?: Policy }): Promise<DeviceRecord> {
    return this.json("PATCH", `/v1/devices/${deviceId}`, { auth: "device", json: patch });
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.json("POST", `/v1/devices/${deviceId}/revoke`, { auth: "device", json: {} });
  }

  heartbeat(appVersion: string, policy: Policy): Promise<void> {
    return this.json("POST", "/v1/devices/heartbeat", {
      auth: "device",
      json: { app_version: appVersion, policy },
    });
  }

  // --- chunks ------------------------------------------------------------

  async missingChunks(sids: string[]): Promise<string[]> {
    const missing: string[] = [];
    for (let i = 0; i < sids.length; i += 4096) {
      const page = await this.json<{ missing: string[] }>("POST", "/v1/chunks/exists", {
        auth: "device",
        json: { sids: sids.slice(i, i + 4096) },
      });
      missing.push(...page.missing);
    }
    return missing;
  }

  async putChunk(sid: string, ciphertext: Bytes): Promise<void> {
    await this.call("PUT", `/v1/chunks/${sid}`, { auth: "device", binary: ciphertext });
  }

  async getChunk(sid: string): Promise<Bytes> {
    const response = await this.call("GET", `/v1/chunks/${sid}`, { auth: "device" });
    return new Uint8Array(response.arrayBuffer);
  }

  /**
   * Batch chunk fetch (≤ 64 sids), one `multipart/mixed` response in request
   * order. Cuts request count over a proxied hop, which is what mobile
   * latency is made of. A missing sid comes back as a zero-length part with
   * `X-Obsync-Missing: 1` and is returned as `null`.
   */
  async getChunks(sids: string[]): Promise<(Bytes | null)[]> {
    const response = await this.call("POST", "/v1/chunks/get", {
      auth: "device",
      json: { sids },
    });
    const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
    const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
    if (!boundary) throw new ApiError(response.status, "bad_multipart", "no multipart boundary");
    const parts = parseMultipart(new Uint8Array(response.arrayBuffer), boundary);
    return parts.map((part) => (part.missing ? null : part.body));
  }

  // --- files and versions ------------------------------------------------

  postVersion(fileId: string, version: VersionPost): Promise<VersionAck> {
    return this.json("POST", `/v1/files/${fileId}/versions`, { auth: "device", json: version });
  }

  getFile(fileId: string): Promise<FileRecord> {
    return this.json("GET", `/v1/files/${fileId}`, { auth: "device" });
  }

  // --- change feed -------------------------------------------------------

  changes(since: number, wait: number, limit = 1000): Promise<ChangesPage> {
    const seconds = Math.min(Math.max(0, Math.floor(wait)), MAX_WAIT_SECONDS);
    return this.json("GET", `/v1/changes?since=${since}&wait=${seconds}&limit=${limit}`, {
      auth: "device",
    });
  }

  // --- dashboard and plugin distribution ---------------------------------

  dashboardLoginLink(): Promise<{ url: string; expires: number }> {
    return this.json("POST", "/v1/dashboard/login-link", { auth: "device", json: {} });
  }

  /**
   * The server's plugin version, and nothing else. There is deliberately no
   * client for `GET /v1/plugin/{bundle,styles}`: the plugin never fetches
   * code it would run (`docs/architecture.md` 6.3). Those endpoints exist for
   * the dashboard's Install page, which shows hashes to compare against the
   * GitHub Release.
   */
  pluginManifest(): Promise<PluginManifest> {
    return this.json("GET", "/v1/plugin/manifest", { auth: "none" });
  }
}

function parseError(text: string): { code: string; detail: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      return {
        code: typeof record["error"] === "string" ? record["error"] : "error",
        detail: typeof record["detail"] === "string" ? record["detail"] : "",
      };
    }
  } catch {
    // A non-JSON error body is the edge's, not the server's.
  }
  return { code: "error", detail: text.slice(0, 200) };
}

export interface MultipartPart {
  sid: string;
  missing: boolean;
  body: Bytes;
}

/**
 * Minimal `multipart/mixed` reader for `POST /v1/chunks/get`. Parts are
 * located by the boundary and each body is taken by its `Content-Length`,
 * so a body that happens to contain the boundary bytes — ciphertext, so it
 * can — is read correctly.
 */
export function parseMultipart(body: Bytes, boundary: string): MultipartPart[] {
  const marker = utf8(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let at = indexOfBytes(body, marker, 0);
  while (at >= 0) {
    let cursor = at + marker.length;
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break; // closing "--"
    while (body[cursor] === 0x0d || body[cursor] === 0x0a) cursor++;
    const headerEnd = indexOfBytes(body, utf8("\r\n\r\n"), cursor);
    if (headerEnd < 0) break;
    const headers = new TextDecoder().decode(body.subarray(cursor, headerEnd));
    const start = headerEnd + 4;
    const length = Number(/content-length:\s*(\d+)/i.exec(headers)?.[1] ?? "0");
    parts.push({
      sid: /x-obsync-sid:\s*([0-9a-f]+)/i.exec(headers)?.[1] ?? "",
      missing: /x-obsync-missing:\s*1/i.test(headers),
      body: body.slice(start, start + length) as Bytes,
    });
    at = indexOfBytes(body, marker, start + length);
  }
  return parts;
}

function indexOfBytes(haystack: Bytes, needle: Bytes, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Re-exported so callers can build a credential without importing `crypto`. */
export function deviceCredential(deviceId: string, secretHex: string): { id: string; secret: Bytes } {
  return { id: deviceId, secret: unhex(secretHex) };
}
