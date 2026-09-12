/**
 * The wire client for `docs/protocol.md` v1.
 *
 * Every call goes through Obsidian's `requestUrl` (injected as `request`),
 * which is the only HTTP surface available on all platforms: mobile
 * WebViews cannot `fetch` a cross-origin host, and `requestUrl` also frees
 * the request from CORS. `throw: false` is set on every call so a 4xx is
 * data, not an exception, and every refusal can be logged with its code.
 *
 * SIGNING IS NOT OPTIONAL. Every attempt signs whenever the endpoint is a
 * device endpoint, and the endpoint decides, not a setting (AGENTS.md requirement
 * 4). The only unsigned calls are the three the protocol defines as
 * unauthenticated: `POST /v1/setup`, `POST /v1/pairing/{id}/claim` (the
 * device has no credential yet; the enroll token in the body is the
 * authenticator) and `GET /v1/plugin/manifest`, from which this client reads
 * ONE field, the version. Code served by the server is never fetched: an
 * unauthenticated endpoint can be replaced by whoever terminates TLS, so the
 * trusted source of plugin code is the GitHub Release, not this transport.
 *
 * AT MOST ONCE PER SIGNATURE. A signature is spent the moment it is sent:
 * the server remembers the nonce for 600 s and answers `401 replayed_nonce`
 * to anything carrying it again (`docs/protocol.md`, authentication). So a
 * retry is signed afresh, and a request that must not happen twice is not
 * re-sent at all. `ROUTES` classifies every route this client can emit and
 * the classification decides the send: a repeatable route is re-signed and
 * retried, everything else goes exactly once and comes back `ok` or `lost`.
 * `lost` is neither success nor failure — the request may already have been
 * applied — so the caller settles it by READING what the server holds. The
 * transport never guesses, and never produces a `replayed_nonce` of its own.
 *
 * BACKOFF. A repeatable route retries on a network error or a 5xx with
 * exponential backoff and jitter, 1 s doubling to a 60 s ceiling, half fixed
 * and half random so a fleet of devices does not resynchronise on the same
 * second. 4xx never retries: a refusal is a decision.
 *
 * PLATFORM. Identical on desktop and mobile. Mobile is HTTPS-only, so a
 * plain-HTTP server URL is rejected at the settings tab, not here.
 */

import { Bytes, bodyHash, hex, randomBytes, signRequest, unhex, utf8 } from "./crypto";
import { EdgeHeader } from "./state";
import { Policy } from "./policy";

/** Device-local policy uses camelCase; the existing v1 API uses snake_case. */
function policyBody(policy: Policy): { per_file_max_bytes: number; total_budget_bytes: number } {
  return { per_file_max_bytes: policy.perFileMaxBytes, total_budget_bytes: policy.totalBudgetBytes };
}

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

/** A manual read can be cancelled logically; requestUrl itself cannot abort. */
export interface ReadControl {
  check(): void;
  wait<T>(work: Promise<T>): Promise<T>;
}

export const HISTORY_RESPONSE_BYTES = 6 * 1024 * 1024;

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

/**
 * A request sent once and never answered. It may have been applied, so it is
 * not a failure; nothing acknowledged it, so it is not a success. `attempts`
 * is the receipt of the at-most-once rule and `reason` is the last thing the
 * socket said.
 */
export interface Lost {
  outcome: "lost";
  attempts: number;
  reason: string;
}

/** What a route that must not be repeated resolves to. */
export type Sent<T> = { outcome: "ok"; value: T } | Lost;

/**
 * What to tell the user when the caller has nothing to read back. Both
 * guesses mislead — "it failed" about a revoke that worked leaves a lost
 * device trusted — so this says what is known and that nothing was repeated.
 */
export function lostMessage(what: string, lost: Lost): string {
  return (
    `${what}: the server never answered (${lost.reason}), so obsync cannot say whether it happened. ` +
    "It was not repeated, because repeating it could act twice."
  );
}

/** One route this client can emit, and whether a repeat is the same request. */
export interface Route {
  method: string;
  path: RegExp;
  /** May an unanswered send be signed afresh and sent again? */
  idempotent: boolean;
}

const ID = "[0-9a-f]{32}";
const SID = "[0-9a-f]{64}";

/**
 * Every route this client calls, classified once, here.
 *
 * IDEMPOTENT means a repeat leaves the server where one send would have left
 * it and answers the same. The classification follows `docs/protocol.md`
 * rather than the verb, and departs from the verb twice, both times towards
 * the protocol. `POST /v1/chunks/{exists,get}` are reads that use POST only
 * because a sid list does not fit in a query string. `GET
 * /v1/pairing/{id}/envelope` hands over the sealed vault key EXACTLY ONCE and
 * answers `410 envelope_consumed` afterwards, so retrying a lost answer
 * destroys the pairing it was meant to complete. `PUT /v1/chunks/{sid}` is
 * repeatable because the protocol says so: a chunk is named by the hash of
 * its own bytes, so a repeat writes what is already there.
 *
 * Everything that mints or consumes state is not repeatable: setup, every
 * pairing step, a device rename or revoke, a heartbeat, a version post, a
 * dashboard login link.
 *
 * A target no entry matches is refused rather than guessed. One of the two
 * defaults re-sends a write, and a table that quietly grows a default is a
 * table nobody reads.
 */
export const ROUTES: readonly Route[] = [
  { method: "GET", path: /^\/v1\/account$/, idempotent: true },
  { method: "GET", path: /^\/v1\/devices$/, idempotent: true },
  { method: "GET", path: /^\/v1\/changes$/, idempotent: true },
  { method: "GET", path: new RegExp(`^/v1/files/${ID}$`), idempotent: true },
  { method: "GET", path: new RegExp(`^/v1/files/${ID}/versions/${SID}$`), idempotent: true },
  { method: "GET", path: new RegExp(`^/v1/chunks/${SID}$`), idempotent: true },
  { method: "GET", path: new RegExp(`^/v1/pairing/${ID}$`), idempotent: true },
  { method: "GET", path: /^\/v1\/plugin\/manifest$/, idempotent: true },
  { method: "PUT", path: new RegExp(`^/v1/chunks/${SID}$`), idempotent: true },
  { method: "POST", path: /^\/v1\/chunks\/exists$/, idempotent: true },
  { method: "POST", path: /^\/v1\/chunks\/get$/, idempotent: true },
  { method: "GET", path: new RegExp(`^/v1/pairing/${ID}/envelope$`), idempotent: false },
  { method: "POST", path: /^\/v1\/setup$/, idempotent: false },
  { method: "POST", path: /^\/v1\/pairing$/, idempotent: false },
  { method: "POST", path: new RegExp(`^/v1/pairing/${ID}/claim$`), idempotent: false },
  { method: "POST", path: new RegExp(`^/v1/pairing/${ID}/approve$`), idempotent: false },
  { method: "POST", path: new RegExp(`^/v1/pairing/${ID}/reject$`), idempotent: false },
  { method: "PATCH", path: new RegExp(`^/v1/devices/${ID}$`), idempotent: false },
  { method: "POST", path: new RegExp(`^/v1/devices/${ID}/revoke$`), idempotent: false },
  { method: "POST", path: /^\/v1\/devices\/heartbeat$/, idempotent: false },
  { method: "POST", path: new RegExp(`^/v1/files/${ID}/versions$`), idempotent: false },
  { method: "POST", path: /^\/v1\/dashboard\/login-link$/, idempotent: false },
];

/** The table's entry for a request target, or `null`, which is a refusal. */
export function routeFor(method: string, target: string): Route | null {
  const path = target.split("?")[0] as string;
  return ROUTES.find((route) => route.method === method && route.path.test(path)) ?? null;
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
  /**
   * The domain the file is in, in clear. A feed entry arrives without its
   * file, so it carries its own (`docs/protocol.md`, "Change feed"); the
   * pull path binds the decrypted manifest's `domain` to it.
   */
  domain_id: string;
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
 * no domain, no head or conflict flags. Those live on the file object around
 * it, which is why a version cannot be spread into a `ChangeRecord` without
 * adding them -- the domain above all, because the pull path binds the
 * manifest to it. */
export type VersionRecord = Omit<ChangeRecord, "seq" | "file_id" | "domain_id" | "heads" | "conflicted">;

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

/**
 * What the plugin reads of a version acknowledgement. The response also
 * carries the journal `seq`, which nothing here consumes — and leaving it
 * unnamed is what lets a LOST post be settled exactly from the file record,
 * which states heads and conflict but no seq (`docs/protocol.md`).
 */
export interface VersionAck {
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
};

/** Everything one attempt needs except its signature, which is per attempt. */
interface Prepared {
  url: string;
  headers: Record<string, string>;
  body: Bytes;
  bodyText?: string;
  /** `hex(SHA-256(body))`, the signature's last field. Empty when unsigned. */
  digest: string;
  device: { id: string; secret: Bytes } | null;
}

/**
 * What one attempt produced. `settled` means the server decided, whatever it
 * decided; `unsettled` means nothing did — no answer, or a 5xx that says the
 * server reached no conclusion either.
 */
type Attempt =
  | { kind: "settled"; response: HttpResponse }
  | { kind: "unsettled"; status: number; reason: string };

function toArrayBuffer(bytes: Bytes): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

export class Transport {
  // Shared across modal close/reopen. Cancellation discards a late result,
  // but cannot permit a second buffered request before the first settles.
  private manualRead: Promise<Attempt> | null = null;
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

  private async prepare(target: string, options: CallOptions): Promise<Prepared> {
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
    let device: { id: string; secret: Bytes } | null = null;
    let digest = "";
    if (options.auth === "device") {
      device = this.options.device();
      if (!device) throw new ApiError(0, "not_paired", "this device is not paired");
      headers["X-Obsync-Device"] = device.id;
      digest = await bodyHash(body);
    }
    for (const header of this.options.edgeHeaders()) headers[header.name] = header.value;
    return { url: base + target, headers, body, bodyText, digest, device };
  }

  /**
   * One attempt, signed HERE rather than once per call. The nonce is spent by
   * being sent, so a second attempt carrying the first attempt's headers
   * would be refused `401 replayed_nonce` — a refusal this client would have
   * manufactured itself.
   */
  private async attempt(method: string, target: string, sending: Prepared, check = (): void => undefined): Promise<Attempt> {
    const headers = { ...sending.headers };
    if (sending.device) {
      const ts = Math.floor(this.now() / 1000);
      const nonce = hex(randomBytes(16));
      headers["X-Obsync-Ts"] = String(ts);
      headers["X-Obsync-Nonce"] = nonce;
      headers["X-Obsync-Sig"] = await signRequest(sending.device.secret, method, target, ts, nonce, sending.digest);
    }
    check();
    try {
      const response = await this.options.request({
        url: sending.url,
        method,
        headers,
        ...(sending.bodyText !== undefined
          ? { body: sending.bodyText }
          : sending.body.length > 0
            ? { body: toArrayBuffer(sending.body) }
            : {}),
        throw: false,
      });
      return response.status < 500
        ? { kind: "settled", response }
        : { kind: "unsettled", status: response.status, reason: `status=${response.status}` };
    } catch (error) {
      return {
        kind: "unsettled",
        status: 0,
        reason: `network=${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** A settled response: 2xx is returned, 4xx is thrown as the decision it is. */
  private settle(method: string, target: string, response: HttpResponse, attempts: number, started: number): HttpResponse {
    if (response.status >= 400) {
      const { code, detail } = parseError(response.text);
      this.log(`http ${method} ${target} status=${response.status} decision=refused code=${code} duration_ms=${this.now() - started}`);
      throw new ApiError(response.status, code, detail);
    }
    this.log(`http ${method} ${target} status=${response.status} decision=ok attempts=${attempts} duration_ms=${this.now() - started}`);
    return response;
  }

  /** A repeatable route (`ROUTES`): retried until it settles or runs out. */
  private async call(method: string, target: string, options: CallOptions): Promise<HttpResponse> {
    const sending = await this.prepare(target, options);
    const started = this.now();
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.attempt(method, target, sending);
      if (outcome.kind === "settled") return this.settle(method, target, outcome.response, attempt, started);
      if (attempt >= this.maxAttempts) {
        this.log(`http ${method} ${target} ${outcome.reason} decision=gave_up attempts=${attempt} duration_ms=${this.now() - started}`);
        throw new ApiError(outcome.status, "unreachable", outcome.reason);
      }
      const delay = this.backoffMs(attempt);
      this.log(`http ${method} ${target} ${outcome.reason} decision=retry attempt=${attempt} backoff_ms=${delay}`);
      await this.sleep(delay);
    }
  }

  /**
   * A route that must not be repeated (`ROUTES`): one attempt, one signature.
   * An unsettled attempt is reported as `lost` and stops there. Re-sending it
   * would act twice on a request the server may already have applied, and the
   * caller — which knows what the operation MEANS — settles it by reading.
   */
  private async send(method: string, target: string, options: CallOptions): Promise<Sent<HttpResponse>> {
    const sending = await this.prepare(target, options);
    const started = this.now();
    const outcome = await this.attempt(method, target, sending);
    if (outcome.kind === "settled") {
      return { outcome: "ok", value: this.settle(method, target, outcome.response, 1, started) };
    }
    this.log(`http ${method} ${target} ${outcome.reason} decision=lost attempts=1 duration_ms=${this.now() - started}`);
    return { outcome: "lost", attempts: 1, reason: outcome.reason };
  }

  private async json<T>(method: string, target: string, options: CallOptions): Promise<T> {
    return decode<T>(await this.call(method, target, options));
  }

  /** One attempt, one outstanding manual request, and a post-buffer ceiling. */
  private async readOnce(target: string, control: ReadControl, maxBytes: number, json?: unknown): Promise<HttpResponse> {
    const started = this.now();
    try {
      control.check();
      if (this.manualRead !== null) throw new Error("The previous history request is still settling. Retry after it finishes.");
      const method = json === undefined ? "GET" : "POST";
      const sending = await this.prepare(target, { auth: "device", json });
      control.check();
      if (this.manualRead !== null) throw new Error("The previous history request is still settling. Retry after it finishes.");
      const pending = this.attempt(method, target, sending, () => control.check());
      this.manualRead = pending;
      void pending.finally(() => {
        if (this.manualRead === pending) this.manualRead = null;
      }).catch(() => undefined);
      const outcome = await control.wait(pending);
      control.check();
      if (outcome.kind !== "settled") throw new ApiError(outcome.status, "unreachable", "History read did not settle; retry explicitly.");
      const response = outcome.response;
      const metadata = target.startsWith("/v1/changes?") || target.startsWith("/v1/files/");
      if (response.arrayBuffer.byteLength > maxBytes ||
          (metadata && (response.text.length > maxBytes || utf8(response.text).length > maxBytes))) {
        throw new ApiError(response.status, "response_too_large", "History response exceeds its byte budget.");
      }
      return this.settle(method, target, response, 1, started);
    } catch (error) {
      this.log(`history_http decision=refused budget_bytes=${maxBytes} duration_ms=${this.now() - started}`);
      throw error;
    }
  }

  async historyChanges(since: number, control: ReadControl): Promise<unknown> {
    return decode<unknown>(await this.readOnce(`/v1/changes?since=${since}&wait=0&limit=1`, control, HISTORY_RESPONSE_BYTES));
  }

  async historyVersion(fileId: string, versionId: string, control: ReadControl): Promise<unknown> {
    return decode<unknown>(await this.readOnce(`/v1/files/${fileId}/versions/${versionId}`, control, HISTORY_RESPONSE_BYTES));
  }

  /** The same, for a route that must not be repeated. */
  private async once<T>(method: string, target: string, options: CallOptions): Promise<Sent<T>> {
    const sent = await this.send(method, target, options);
    return sent.outcome === "ok" ? { outcome: "ok", value: decode<T>(sent.value) } : sent;
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
  ): Promise<Sent<PairingCredential & { account_id: string }>> {
    return this.once("POST", "/v1/setup", {
      auth: "none",
      json: { setup_token: setupToken, account_name: accountName, device },
    });
  }

  account(): Promise<{ account_id: string; name: string; used_bytes: number; quota_bytes: number; device_count: number }> {
    return this.json("GET", "/v1/account", { auth: "device" });
  }

  // --- pairing -----------------------------------------------------------

  pairingCreate(): Promise<Sent<PairingCreated>> {
    return this.once("POST", "/v1/pairing", { auth: "device", json: {} });
  }

  pairingClaim(
    pairingId: string,
    enrollToken: string,
    info: { name: string; platform: string; app_version: string },
  ): Promise<Sent<PairingCredential>> {
    return this.once("POST", `/v1/pairing/${pairingId}/claim`, {
      auth: "none",
      json: { enroll_token: enrollToken, ...info },
    });
  }

  pairingStatus(pairingId: string): Promise<PairingStatus> {
    return this.json("GET", `/v1/pairing/${pairingId}`, { auth: "device" });
  }

  pairingApprove(pairingId: string, envelope: string, nonce: string): Promise<Sent<void>> {
    return this.once("POST", `/v1/pairing/${pairingId}/approve`, {
      auth: "device",
      json: { envelope, nonce },
    });
  }

  pairingReject(pairingId: string): Promise<Sent<void>> {
    return this.once("POST", `/v1/pairing/${pairingId}/reject`, { auth: "device", json: {} });
  }

  /** Single use by the protocol: a retry would destroy the sealed vault key. */
  pairingEnvelope(pairingId: string): Promise<Sent<PairingEnvelope>> {
    return this.once("GET", `/v1/pairing/${pairingId}/envelope`, { auth: "device" });
  }

  // --- devices -----------------------------------------------------------

  devices(): Promise<{ devices: DeviceRecord[] }> {
    return this.json("GET", "/v1/devices", { auth: "device" });
  }

  patchDevice(deviceId: string, patch: { name?: string; policy?: Policy }): Promise<Sent<DeviceRecord>> {
    return this.once("PATCH", `/v1/devices/${deviceId}`, {
      auth: "device",
      json: { ...patch, policy: patch.policy === undefined ? undefined : policyBody(patch.policy) },
    });
  }

  revokeDevice(deviceId: string): Promise<Sent<void>> {
    return this.once("POST", `/v1/devices/${deviceId}/revoke`, { auth: "device", json: {} });
  }

  heartbeat(appVersion: string, policy: Policy): Promise<Sent<void>> {
    return this.once("POST", "/v1/devices/heartbeat", {
      auth: "device",
      json: { app_version: appVersion, policy: policyBody(policy) },
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

  async getChunk(sid: string, control?: ReadControl): Promise<Bytes> {
    const target = `/v1/chunks/${sid}`;
    const response = control
      ? await this.readOnce(target, control, 8 * 1024 * 1024 + 16)
      : await this.call("GET", target, { auth: "device" });
    return new Uint8Array(response.arrayBuffer);
  }

  /**
   * Batch chunk fetch (≤ 64 sids), one `multipart/mixed` response in request
   * order. Cuts request count over a proxied hop, which is what mobile
   * latency is made of. A missing sid comes back as a zero-length part with
   * `X-Obsync-Missing: 1` and is returned as `null`.
   */
  async getChunks(sids: string[], control?: ReadControl): Promise<(Bytes | null)[]> {
    const response = control ? await this.readOnce("/v1/chunks/get", control, 33 * 1024 * 1024, { sids }) : await this.call("POST", "/v1/chunks/get", {
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

  postVersion(fileId: string, version: VersionPost): Promise<Sent<VersionAck>> {
    return this.once("POST", `/v1/files/${fileId}/versions`, { auth: "device", json: version });
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

  dashboardLoginLink(): Promise<Sent<{ url: string; expires: number }>> {
    return this.once("POST", "/v1/dashboard/login-link", { auth: "device", json: {} });
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

function decode<T>(response: HttpResponse): T {
  return (response.text === "" ? {} : JSON.parse(response.text)) as T;
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
