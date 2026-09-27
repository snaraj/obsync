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
 * second. 4xx never retries: a refusal is a decision, and so is `507`, the
 * one 5xx the server answers on purpose (requirement 8). A pause is not a
 * promise to wait it out: `wake` ends every pause at once when the device's
 * network is back, the app returns to the foreground, or the address changes,
 * and every attempt reads the server address afresh (issues #134, #186).
 *
 * PATIENCE. Background work has the whole budget; a person who pressed a
 * button gets `interactive` -- two attempts inside ten seconds -- and a
 * caller may end a call with an `AbortSignal` (`Patience`, issue #182).
 *
 * CHUNK UPLOADS ARE BUDGETED. A chunk body is the only request whose retry
 * costs megabytes, and it is the only one that cannot be resumed, so
 * `putChunk` owns three rules the generic retry cannot express: one upload
 * per sid, a ceiling on the BYTES in flight rather than on their count, with
 * a small allowance of its own for note-sized bodies, and a question — has
 * this body already landed? — before any re-send (`UPLOAD_INFLIGHT_MAX`,
 * `SMALL_INFLIGHT_MAX`, `docs/validation.md` V7).
 *
 * PLATFORM. Identical on desktop and mobile. Mobile is HTTPS-only, so a
 * plain-HTTP server URL is rejected at the settings tab, not here.
 */

import { Bytes, bodyHash, hex, hmacKey, randomBytes, sealedSid, signRequest, unhex, utf8 } from "./crypto";
import { CHUNK_CIPHERTEXT_MAX } from "./chunker";
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

/**
 * A manual read arrived while another still held the slot.
 *
 * This is a scheduling decision on THIS device, not a failure of anything:
 * nothing was sent, nothing was measured against a budget, and the caller
 * that can wait should wait. The repair tick tells it apart from a read that
 * really failed after leaving the device, which is what stopped a benign
 * collision raising "could not verify a retained file" for five minutes
 * (issue #103).
 */
export class HistoryBusyError extends Error {
  constructor() {
    super("The previous history request is still settling. Retry after it finishes.");
    this.name = "HistoryBusyError";
  }
}

/** Why a manual read was refused, for the one log line it writes. */
function refusalReason(error: unknown): string {
  if (error instanceof HistoryBusyError) return "busy";
  if (error instanceof ApiError) {
    return error.code === "response_too_large" ? "too_large" : error.code;
  }
  return error instanceof Error && error.name === "HistoryCancelled" ? "cancelled" : "failed";
}

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

/** A refusal at connect, as Electron and Node word it: the request never left. */
const REFUSED = /ERR_CONNECTION_REFUSED|ECONNREFUSED/;

/**
 * What to tell the user when the caller has nothing to read back. Both
 * guesses mislead — "it failed" about a revoke that worked leaves a lost
 * device trusted — so this says what is known and that nothing was repeated.
 */
export function lostMessage(what: string, lost: Lost): string {
  // A connection refused on the only attempt is the one unanswered send that
  // IS known: nothing reached the server. It is also what a missing or wrong
  // port looks like, so the message names that (2026-09-24 battery, S08; #137).
  if (lost.attempts === 1 && REFUSED.test(lost.reason)) {
    return (
      `${what}: nothing answers at this address and port (${lost.reason}), so nothing was sent. ` +
      "Check the Server URL, port included: it is the port your server publishes HTTPS on. If this address has worked " +
      "before, your server may be switched off."
    );
  }
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
  { method: "GET", path: /^\/v1\/files$/, idempotent: true },
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
  { method: "POST", path: /^\/v1\/account\/recovery$/, idempotent: false },
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
  /**
   * Told after every attempt whether the server answered it (any status it
   * settles on: below 500, or 507). It reports and decides nothing: the
   * retries, and what a request finally returns or throws, are the same with
   * or without it.
   */
  reachable?: (answered: boolean) => void;
  /**
   * The clock an attempt is abandoned by (`attemptMs`, #195). The plugin gives
   * the renderer's; without it an attempt waits as long as the platform lets
   * it, which is what a test that does not ask about deadlines wants.
   */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * HOW LONG ONE ATTEMPT MAY GO UNANSWERED (#195). `requestUrl` has no timeout
 * of its own, and a connection that died under a sleeping laptop or a network
 * change can leave an attempt waiting far longer than any answer takes. Past
 * its deadline an attempt counts as unanswered: a repeatable route signs
 * afresh and retries, a route that must not be repeated reports `lost`, and a
 * late answer is discarded, never applied. A long poll gets its wait and
 * `LONG_POLL_GRACE_MS`; everything else `ATTEMPT_MS`, and a transfer that
 * moves chunk bytes one more millisecond for every `SLOWEST_BYTES_PER_MS`
 * bytes, a floor slow enough that no working link, however poor, is cut off.
 */
export const ATTEMPT_MS = 30000;
export const LONG_POLL_GRACE_MS = 15000;
export const SLOWEST_BYTES_PER_MS = 16;
const TIMED_OUT = new Error("no answer within the attempt's deadline");

/**
 * How long a repeatable call may keep its caller waiting, and whether the
 * caller may end it (issue #182).
 *
 * BACKGROUND IS THE DEFAULT: the feed, a push and a repair have the whole
 * budget, eight attempts over about a minute and a half, because nobody is
 * watching them and giving up early only costs a later start. A person who
 * pressed a button IS watching, and "Check" sat silent for 103 s against a
 * server that was off (S70). `interactive` gives such a call at most
 * `INTERACTIVE_ATTEMPTS` attempts inside `INTERACTIVE_MS` of wall clock, then
 * it throws `unreachable` like any other call that ran out.
 *
 * `signal` ends the call: a retry asleep in its backoff rejects at once, and
 * an attempt in flight is abandoned -- `requestUrl` cannot be aborted, so its
 * late answer is discarded -- with `ApiError(0, "cancelled")`. Either way one
 * line is logged. A route that must not be repeated takes no patience: its one
 * attempt is the whole call already.
 */
export interface Patience {
  interactive?: boolean;
  signal?: AbortSignal;
}

export const INTERACTIVE_MS = 10000;
export const INTERACTIVE_ATTEMPTS = 2;

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

/** One page of `GET /v1/files`: every file's heads, in file-id order. */
export interface FilesPage {
  files: { file_id: string; heads: string[] }[];
  next: string | null;
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
  /**
   * This device's promise to store the `version_id` the answer names, so the
   * server may answer with a version it already holds at this position
   * instead of forking the file (`docs/protocol.md`, "One position, one
   * version"; issue #114). It is the caller's decision, not a constant,
   * because the server's identity for "this position and this content" is
   * `(file_id, parent set, sids, deleted)` and does NOT cover the encrypted
   * manifest -- so a post whose only new fact is inside that manifest, which
   * is what a rename is, must not offer this (`push.ts`).
   */
  accept_existing: boolean;
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
  /**
   * The version the store holds for this post: the posted id, except when the
   * server recognised the post as a version it already had under another id.
   * OPTIONAL because a server older than 1.0.7 does not send it, and `decode`
   * keeps whatever the answer contains and nothing else, so the caller falls
   * back to the id it computed itself (issue #114).
   */
  version_id?: string;
}

export interface DeviceRecord {
  device_id: string;
  name: string;
  platform: string;
  app_version: string;
  last_seen: number;
  revoked: boolean;
  /** `pending` until a paired device's claim collects the vault key; absent from a server that predates it. */
  state?: string;
}

/**
 * `1.2.3` is newer than `1.2.2`; anything unparseable is not newer. Two
 * callers compare a version the server reports: the plugin release it
 * advertises (`main.ts`) and the one a device last reported (`app_version`,
 * `sync/pull.ts`).
 */
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

export interface PairingCreated {
  pairing_id: string;
  enroll_token: string;
  expires: number;
}

export interface PairingClaimant {
  vault?: { envelope: string; nonce: string };
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

/**
 * The retransmission budget `docs/validation.md` V7 sets: killing Obsidian
 * mid-upload and reopening may re-send FEWER than 32 MiB of large chunks,
 * plus the small pipe's `SMALL_INFLIGHT_MAX`. Four maximal chunks: 8 MiB
 * until 1.1.4, raised by measurement (issue #196), because a budget of one
 * chunk waited out a round trip per chunk -- 512 MiB went up at 70.8 MiB/s
 * with 20 ms of round trip and at 133.5 MiB/s with four chunks in flight.
 */
export const UPLOAD_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * The ceiling on chunk bytes in flight, which is what turns that budget from
 * a hope into a property of this client.
 *
 * A chunk upload cannot be resumed: `PUT /v1/chunks/{sid}` carries a whole
 * body and the server keeps nothing until the body hashes to the sid
 * (`docs/protocol.md`), so every byte in flight when the process dies is a
 * byte the restart sends again. Bounding the SUM of the bodies in flight,
 * across every push at once, rather than their COUNT bounds that loss: issue
 * #56 measured at least 10,910,020 bytes duplicated with four uploads
 * interrupted at once when only their count was bounded. `- 1` because V7
 * says "fewer than".
 *
 * A pipe holding nothing admits any body, so no body can wait for ever; no
 * chunk is larger than this ceiling, so none goes above it.
 */
export const UPLOAD_INFLIGHT_MAX = UPLOAD_BUDGET_BYTES - 1;

/**
 * A NOTE NEVER WAITS BEHIND A LARGE CHUNK (issue #196). A body of at most
 * `SMALL_BODY_MAX` -- a note, or a large file's short last chunk -- is
 * admitted against its own `SMALL_INFLIGHT_MAX` rather than behind the large
 * bodies waiting for room, so an edit made during a video upload goes at
 * once. What a kill can make a restart send again is therefore the large
 * budget plus this allowance (`docs/validation.md` V7).
 */
export const SMALL_BODY_MAX = 256 * 1024;
export const SMALL_INFLIGHT_MAX = 1024 * 1024;

type CallOptions = Patience & {
  auth: "device" | "none";
  json?: unknown;
  binary?: Bytes;
  /**
   * The largest answer this route can legitimately return: characters of
   * JSON (`JSON_ANSWER_MAX` when absent), or bytes of a `bulk` answer.
   */
  cap?: number;
  /** The answer is chunk bytes, so `cap` is also what an attempt's deadline grows with. */
  bulk?: boolean;
  /** `hex(SHA-256(binary))`, when the caller holds it as a fact (`uploadChunk`); otherwise it is computed. */
  digest?: string;
};

/**
 * THE LARGEST ANSWER A ROUTE MAY BRING (#202, security item 10).
 *
 * `requestUrl` hands this client a whole answer or nothing: no cap here can
 * stop a broken or hostile terminator making the platform read a body. What a
 * cap does stop is this client parsing, decoding, copying and keeping it --
 * the part that is this code's -- and it turns such an answer into a named
 * refusal instead of a stall. Each is sized well above the largest answer
 * the route can legitimately give:
 *
 * - `JSON_ANSWER_MAX` for the small answers: the account, the device list,
 *   pairing, an acknowledgement, and the largest of them, an existence answer
 *   for 4096 sids, which is about 270 KB.
 * - `METADATA_ANSWER_MAX` for a file's versions and a listing page, which grow
 *   with a file's chunk count and so with its size.
 * - A chunk: its ciphertext ceiling; a batch: that per sid, plus its framing,
 *   for the sids actually asked.
 * - `CHANGES_ANSWER_MAX` for a feed page: twice the 8 MiB a 1.1.4 server caps
 *   its pages at, so a page from it is never refused, and room for a single
 *   entry larger than that cap; a larger page from an older server is asked
 *   again smaller (`changes`).
 */
export const JSON_ANSWER_MAX = 4 * 1024 * 1024;
export const METADATA_ANSWER_MAX = 64 * 1024 * 1024;
export const CHANGES_ANSWER_MAX = 16 * 1024 * 1024;
/** One part's headers and delimiters in a batched chunk answer, generously. */
const MULTIPART_PART_OVERHEAD = 1024;

/**
 * Everything one attempt needs except its signature and its address, which
 * are both per attempt: an address adopted while a request waits is the one
 * its next attempt goes to (issue #186).
 */
interface Prepared {
  headers: Record<string, string>;
  body: Bytes;
  bodyText?: string;
  /** `hex(SHA-256(body))`, the signature's last field. Empty when unsigned. */
  digest: string;
  device: { id: string; secret: Bytes } | null;
  /** How long each attempt may go unanswered (`attemptMs`). */
  deadlineMs: number;
}

/** Chunk bodies in flight through one pipe against its ceiling, and those waiting for room. */
interface Pipe {
  bytes: number;
  readonly max: number;
  readonly waiting: { bytes: number; resume: () => void }[];
}

/** One attempt's deadline: a long poll's wait plus grace, or the floor plus the bytes it moves. */
function attemptMs(target: string, bytes: number): number {
  const wait = /^\/v1\/changes\?.*\bwait=(\d+)/.exec(target)?.[1];
  if (wait !== undefined) return Math.max(ATTEMPT_MS, Number(wait) * 1000 + LONG_POLL_GRACE_MS);
  return ATTEMPT_MS + Math.ceil(bytes / SLOWEST_BYTES_PER_MS);
}

/**
 * What one attempt produced. `settled` means the server decided, whatever it
 * decided; `unsettled` means nothing did — no answer, or a 5xx that says the
 * server reached no conclusion either.
 */
type Attempt =
  | { kind: "settled"; response: HttpResponse }
  | { kind: "unsettled"; status: number; reason: string };

/** The attempts and the wall clock one call may spend (`Patience`). */
interface Budget {
  attempts: number;
  deadline: number;
  interactive: boolean;
}

function toArrayBuffer(bytes: Bytes): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

/**
 * The edge-header rule (issue #183), one for the settings row that takes a
 * header and for the request that sends it. A name is an HTTP token and a
 * value printable ASCII, which is what Fetch and Node's own HTTP layer
 * accept. The names obsync sets itself are never an edge header's:
 * `Content-Type` frames the body, `X-Obsync-*` is the signed identity, and
 * `Host` and `Content-Length` belong to the platform.
 */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
export function ownHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "content-type" || lower === "content-length" || lower === "host" || lower.startsWith("x-obsync-");
}

export class Transport {
  // Shared across modal close/reopen. Cancellation discards a late result,
  // but cannot permit a second buffered request before the first settles.
  private manualRead: Promise<Attempt> | null = null;
  /** sid → the one upload of that chunk this client has in flight. */
  private readonly uploading = new Map<string, Promise<void>>();
  /**
   * The two pipes a chunk body is admitted to (`SMALL_BODY_MAX`): the bytes
   * each has in flight against its ceiling, and its waiters, oldest first, so
   * a maximal body cannot starve.
   */
  private readonly pipes: { large: Pipe; small: Pipe } = {
    large: { bytes: 0, max: UPLOAD_INFLIGHT_MAX, waiting: [] },
    small: { bytes: 0, max: SMALL_INFLIGHT_MAX, waiting: [] },
  };
  /** What the uploader has done, for the per-run summary its caller logs. */
  private readonly upload = { chunks: 0, resent: 0, deduped: 0 };
  /** Manual history operations currently open, whether or not one is reading. */
  private manualSessions = 0;
  /** Every request asleep in its backoff: when it wakes by itself, and how to wake it now. */
  private readonly sleepers = new Set<{ at: number; wake: () => void }>();
  /**
   * The non-extractable HMAC handle requests sign with, imported once per
   * device id (issue #197). The server mints a device id with its secret and
   * never gives that id another (`crates/obsyncd/src/api/devices.rs`,
   * `enrol`), so a new id -- a re-pair, a claim waiting for its key -- is a
   * new credential. The raw secret is still read per request and held no
   * longer than that request; `forgetDevice` drops the handle on a leave.
   */
  private signing: { id: string; key: Promise<CryptoKey> } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private readonly maxAttempts: number;

  constructor(private readonly options: TransportOptions) {
    this.now = options.now ?? (() => Date.now());
    // `window` rather than the bare global: see `defaultTimers` in sync/engine.
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    this.random = options.random ?? (() => Math.random());
    this.log = options.log ?? (() => undefined);
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  /** This device gave up its credential: the handle it signed with goes too. */
  forgetDevice(): void {
    this.signing = null;
  }

  /** Half-fixed, half-random exponential backoff, capped at 60 s. */
  backoffMs(attempt: number): number {
    const base = Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** (attempt - 1));
    return Math.round(base / 2 + this.random() * (base / 2));
  }

  /** The server address as it stands NOW, read by every attempt. */
  private base(): string {
    const base = this.options.serverUrl().replace(/\/+$/, "");
    if (base === "") throw new ApiError(0, "no_server_url", "no server URL is configured");
    return base;
  }

  private async prepare(target: string, options: CallOptions): Promise<Prepared> {
    // Refused before anything is hashed or signed; each attempt asks again.
    this.base();
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
      digest = options.digest ?? await bodyHash(body);
    }
    for (const header of this.options.edgeHeaders()) {
      // AN EDGE HEADER NEVER REPLACES ONE OBSYNC SETS, and one the platform
      // would drop without a word -- Obsidian's desktop request layer did,
      // for a name pasted with its `-H` -- is refused by name before anything
      // is sent (issue #183). Settings refuses both at entry; this holds for
      // a list saved before it did.
      if (ownHeader(header.name) || !HEADER_NAME.test(header.name) || !HEADER_VALUE.test(header.value)) {
        this.log(`http ${target} decision=refused reason=edge_header`);
        throw new Error(`The custom request header "${header.name}" cannot be sent as written, so obsync sent nothing. Correct it in obsync's settings, under Custom request headers.`);
      }
      headers[header.name] = header.value;
    }
    const deadlineMs = attemptMs(target, (options.binary?.length ?? 0) + (options.bulk === true ? options.cap ?? 0 : 0));
    return { headers, body, bodyText, digest, device, deadlineMs };
  }

  /**
   * One attempt, signed HERE rather than once per call. The nonce is spent by
   * being sent, so a second attempt carrying the first attempt's headers
   * would be refused `401 replayed_nonce` — a refusal this client would have
   * manufactured itself.
   */
  private async attempt(method: string, target: string, sending: Prepared, check = (): void => undefined): Promise<Attempt> {
    const url = this.base() + target;
    const headers = { ...sending.headers };
    if (sending.device) {
      const ts = Math.floor(this.now() / 1000);
      const nonce = hex(randomBytes(16));
      headers["X-Obsync-Ts"] = String(ts);
      headers["X-Obsync-Nonce"] = nonce;
      const { id, secret } = sending.device;
      const signing = this.signing?.id === id ? this.signing : (this.signing = { id, key: hmacKey(secret) });
      headers["X-Obsync-Sig"] = await signRequest(await signing.key, method, target, ts, nonce, sending.digest);
    }
    check();
    let outcome: Attempt;
    try {
      const response = await this.timed(this.options.request({
        url,
        method,
        headers,
        ...(sending.bodyText !== undefined
          ? { body: sending.bodyText }
          : sending.body.length > 0
            ? { body: toArrayBuffer(sending.body) }
            : {}),
        throw: false,
      }), sending.deadlineMs);
      // A 507 is the server's decision that it is full, not its absence:
      // retried eight times, a full server read `offline — retrying` for
      // minutes and never said why (S29, issue #155).
      outcome = response.status < 500 || response.status === 507
        ? { kind: "settled", response }
        : { kind: "unsettled", status: response.status, reason: `status=${response.status}` };
    } catch (error) {
      outcome = {
        kind: "unsettled",
        status: 0,
        reason: error === TIMED_OUT
          ? `timeout budget_ms=${sending.deadlineMs}`
          : `network=${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.options.reachable?.(outcome.kind === "settled");
    return outcome;
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

  /** A repeatable route (`ROUTES`): retried until it settles, runs out, or is ended. */
  private async call(method: string, target: string, options: CallOptions): Promise<HttpResponse> {
    const sending = await this.prepare(target, options);
    const started = this.now();
    const budget = this.budget(options, started);
    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted) throw this.ended(method, target, "cancelled", "waiting", attempt - 1, started);
      const outcome = await this.until(this.attempt(method, target, sending), options.signal, budget.deadline);
      if (outcome === "cancelled" || outcome === "deadline") throw this.ended(method, target, outcome, "in_flight", attempt, started);
      if (outcome.kind === "settled") return this.settle(method, target, outcome.response, attempt, started);
      await this.pause(method, target, outcome, attempt, budget, started, options.signal);
    }
  }

  private budget(patience: Patience, started: number): Budget {
    return patience.interactive === true
      ? { attempts: Math.min(INTERACTIVE_ATTEMPTS, this.maxAttempts), deadline: started + INTERACTIVE_MS, interactive: true }
      : { attempts: this.maxAttempts, deadline: Infinity, interactive: false };
  }

  /**
   * An attempt, or the moment its caller stops waiting for it: the signal, or
   * the end of an interactive budget. The attempt itself runs on -- nothing
   * can abort `requestUrl` -- and its late answer is discarded here, though it
   * is still reported to `reachable`: it is a fact about the server.
   */
  private until(work: Promise<Attempt>, signal: AbortSignal | undefined, deadline: number): Promise<Attempt | "cancelled" | "deadline"> {
    if (signal === undefined && deadline === Infinity) return work;
    return new Promise((resolve, reject) => {
      const aborted = (): void => resolve("cancelled");
      signal?.addEventListener("abort", aborted, { once: true });
      if (deadline !== Infinity) void this.sleep(Math.max(0, deadline - this.now())).then(() => resolve("deadline"));
      void work.then(resolve, reject).finally(() => signal?.removeEventListener("abort", aborted));
    });
  }

  /** One request, or `TIMED_OUT` once its deadline passes; its late answer is dropped. */
  private timed<T>(work: Promise<T>, ms: number): Promise<T> {
    const timers = this.options.timers;
    if (timers === undefined) return work;
    return new Promise((resolve, reject) => {
      const handle = timers.set(() => reject(TIMED_OUT), ms);
      work.then(
        (value) => { timers.clear(handle); resolve(value); },
        (error: unknown) => { timers.clear(handle); reject(error); },
      );
    });
  }

  /**
   * Nothing settled the attempt: give up, or pause for the backoff and say
   * so. The pause is the one `wake` ends early and the signal ends at once.
   */
  private async pause(
    method: string,
    target: string,
    outcome: { status: number; reason: string },
    attempt: number,
    budget: Budget,
    started: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const left = budget.deadline - this.now();
    if (attempt >= budget.attempts || left <= 0) {
      this.log(
        `http ${method} ${target} ${outcome.reason} decision=gave_up attempts=${attempt}` +
          `${budget.interactive ? ` budget_ms=${INTERACTIVE_MS}` : ""} duration_ms=${this.now() - started}`,
      );
      throw new ApiError(outcome.status, "unreachable", outcome.reason);
    }
    const delay = Math.min(this.backoffMs(attempt), left);
    this.log(`http ${method} ${target} ${outcome.reason} decision=retry attempt=${attempt} backoff_ms=${delay}`);
    if (!(await this.nap(delay, signal))) throw this.ended(method, target, "cancelled", "sleeping", attempt, started);
  }

  /** A call its caller ended, or whose interactive budget ran out, with its one line. */
  private ended(method: string, target: string, why: "cancelled" | "deadline", phase: string, attempts: number, started: number): ApiError {
    const duration = this.now() - started;
    if (why === "cancelled") {
      this.log(`http ${method} ${target} decision=cancelled phase=${phase} attempts=${attempts} duration_ms=${duration}`);
      return new ApiError(0, "cancelled", "the caller ended this request");
    }
    this.log(`http ${method} ${target} decision=gave_up reason=deadline attempts=${attempts} budget_ms=${INTERACTIVE_MS} duration_ms=${duration}`);
    return new ApiError(0, "unreachable", `no answer within ${INTERACTIVE_MS / 1000} s`);
  }

  /**
   * One backoff pause. True when it ended by itself or by `wake`; false, at
   * once, when the signal ends the call. The injected `sleep` may still fire
   * after a wake: settling twice is a no-op, and the sleeper is gone.
   */
  private nap(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted === true) return Promise.resolve(false);
    return new Promise((resolve) => {
      const sleeper = { at: this.now() + ms, wake: (): void => done(true) };
      const aborted = (): void => done(false);
      const done = (awake: boolean): void => {
        this.sleepers.delete(sleeper);
        signal?.removeEventListener("abort", aborted);
        resolve(awake);
      };
      this.sleepers.add(sleeper);
      signal?.addEventListener("abort", aborted, { once: true });
      void this.sleep(ms).then(() => done(true));
    });
  }

  /**
   * Retry now whatever is asleep in its backoff (issues #134, #186).
   *
   * The device's own word that something changed -- its network is back
   * (`online`), the app is in front of the person again, a new server address
   * was adopted, Retry now was pressed -- is worth more than a timer that was
   * armed before it. A request asleep for up to a minute therefore makes its
   * next attempt now, at the address that stands now, and the cycle goes on
   * exactly as before: an answer ends it, a refusal is never retried, and the
   * attempt counts against the same budget, so the pause stays bounded.
   *
   * ONE EARLY ATTEMPT PER REQUEST PER CALL. A woken request leaves the set
   * and joins it again only when its next pause begins, after that attempt
   * has ended, so a storm of `online` events cannot turn a pause into a loop.
   */
  wake(reason: string): void {
    const asleep = [...this.sleepers];
    this.sleepers.clear();
    for (const sleeper of asleep) sleeper.wake();
    if (asleep.length > 0) this.log(`http decision=woken reason=${reason} requests=${asleep.length}`);
  }

  /** When the soonest request asleep in its backoff tries again by itself, or `null`. */
  retryAt(): number | null {
    let soonest: number | null = null;
    for (const { at } of this.sleepers) soonest = soonest === null ? at : Math.min(soonest, at);
    return soonest;
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
    return decode<T>(this.capped(method, target, await this.call(method, target, options), options.cap ?? JSON_ANSWER_MAX));
  }

  /**
   * An answer larger than its route can legitimately be is refused, never
   * parsed, decoded or kept (#202). Chunk bytes are measured as bytes, JSON as
   * the text this client would parse.
   */
  private capped(method: string, target: string, response: HttpResponse, cap: number, bulk = false): HttpResponse {
    const size = bulk ? response.arrayBuffer.byteLength : response.text.length;
    if (size <= cap) return response;
    this.log(`http ${method} ${target} status=${response.status} decision=refused reason=too_large size=${size} budget=${cap}`);
    throw new ApiError(response.status, "response_too_large", "the answer is larger than this request can be");
  }

  /** One attempt, one outstanding manual request, and a post-buffer ceiling. */
  /**
   * Is a manual history operation open, or one of its reads in flight?
   *
   * The repair tick asks before it starts so the two share the slot in order
   * rather than colliding (issue #103); an open dialog is enough, because the
   * tick runs every second and the user is in front of the other one.
   */
  get manualBusy(): boolean {
    return this.manualSessions > 0 || this.manualRead !== null;
  }

  openManual(): void {
    this.manualSessions++;
  }

  closeManual(): void {
    if (this.manualSessions > 0) this.manualSessions--;
  }

  private async readOnce(target: string, control: ReadControl, maxBytes: number, json?: unknown): Promise<HttpResponse> {
    const started = this.now();
    try {
      control.check();
      if (this.manualRead !== null) throw new HistoryBusyError();
      const method = json === undefined ? "GET" : "POST";
      const metadata = target.startsWith("/v1/changes?") || target.startsWith("/v1/files/");
      const sending = await this.prepare(target, { auth: "device", json, cap: maxBytes, bulk: !metadata });
      control.check();
      if (this.manualRead !== null) throw new HistoryBusyError();
      const pending = this.attempt(method, target, sending, () => control.check());
      this.manualRead = pending;
      void pending.finally(() => {
        if (this.manualRead === pending) this.manualRead = null;
      }).catch(() => undefined);
      const outcome = await control.wait(pending);
      control.check();
      if (outcome.kind !== "settled") throw new ApiError(outcome.status, "unreachable", "History read did not settle; retry explicitly.");
      const response = outcome.response;
      if (response.arrayBuffer.byteLength > maxBytes ||
          (metadata && (response.text.length > maxBytes || utf8(response.text).length > maxBytes))) {
        throw new ApiError(response.status, "response_too_large", "History response exceeds its byte budget.");
      }
      return this.settle(method, target, response, 1, started);
    } catch (error) {
      // `budget_bytes` belongs to the size refusal alone. A read that never
      // left the device was never measured against a byte budget, and naming
      // one made a scheduling collision read like an oversize response.
      const reason = refusalReason(error);
      this.log(
        `history_http decision=refused reason=${reason}` +
          (reason === "too_large" ? ` budget_bytes=${maxBytes}` : "") +
          ` duration_ms=${this.now() - started}`,
      );
      throw error;
    }
  }

  /**
   * Up to `limit` retained records after `since`, for a manual read (issue
   * #199). A 1.1.4 server stops a page at 8 MiB whatever the limit
   * (`crates/obsyncd/src/storage/index.rs`, `CHANGES_PAGE_BYTES`), inside
   * `CHANGES_ANSWER_MAX`; a larger page from an older server is asked again
   * smaller, down to the one record `HISTORY_RESPONSE_BYTES` bounds.
   */
  async historyChanges(since: number, control: ReadControl, limit = 1): Promise<unknown> {
    for (let asked = limit; ; asked = Math.max(1, Math.floor(asked / 2))) {
      const target = `/v1/changes?since=${since}&wait=0&limit=${asked}`;
      try {
        return decode<unknown>(await this.readOnce(target, control, asked === 1 ? HISTORY_RESPONSE_BYTES : CHANGES_ANSWER_MAX));
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "response_too_large") || asked <= 1) throw error;
        this.log(`history_http GET ${target} decision=refused reason=over_cap retry limit=${Math.max(1, Math.floor(asked / 2))}`);
      }
    }
  }

  async historyVersion(fileId: string, versionId: string, control: ReadControl): Promise<unknown> {
    return decode<unknown>(await this.readOnce(`/v1/files/${fileId}/versions/${versionId}`, control, HISTORY_RESPONSE_BYTES));
  }

  /** The same, for a route that must not be repeated. */
  private async once<T>(method: string, target: string, options: CallOptions): Promise<Sent<T>> {
    const sent = await this.send(method, target, options);
    return sent.outcome === "ok" ? { outcome: "ok", value: decode<T>(this.capped(method, target, sent.value, JSON_ANSWER_MAX)) } : sent;
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
    recovery?: { verifier: string; proof: string },
  ): Promise<Sent<PairingCredential & { account_id: string; recovered?: boolean }>> {
    return this.once("POST", "/v1/setup", {
      auth: "none",
      json: { setup_token: setupToken, account_name: accountName, device,
        ...(recovery === undefined ? {} : { recovery_verifier: recovery.verifier, recovery_proof: recovery.proof }) },
    });
  }

  registerRecovery(verifier: string): Promise<Sent<void>> {
    return this.once("POST", "/v1/account/recovery", { auth: "device", json: { recovery_verifier: verifier } });
  }

  account(patience: Patience = {}): Promise<{ account_id: string; name: string; used_bytes: number; quota_bytes: number; device_count: number }> {
    return this.json("GET", "/v1/account", { auth: "device", ...patience });
  }

  // --- pairing -----------------------------------------------------------

  pairingCreate(): Promise<Sent<PairingCreated>> {
    return this.once("POST", "/v1/pairing", { auth: "device", json: {} });
  }

  pairingClaim(
    pairingId: string,
    enrollToken: string,
    info: { name: string; platform: string; app_version: string; vault?: { envelope: string; nonce: string } },
  ): Promise<Sent<PairingCredential>> {
    return this.once("POST", `/v1/pairing/${pairingId}/claim`, {
      auth: "none",
      json: { enroll_token: enrollToken, ...info },
    });
  }

  pairingStatus(pairingId: string, patience: Patience = {}): Promise<PairingStatus> {
    return this.json("GET", `/v1/pairing/${pairingId}`, { auth: "device", ...patience });
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

  devices(patience: Patience = {}): Promise<{ devices: DeviceRecord[] }> {
    return this.json("GET", "/v1/devices", { auth: "device", ...patience });
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

  async missingChunks(sids: string[], patience: Patience = {}): Promise<string[]> {
    const missing: string[] = [];
    for (let i = 0; i < sids.length; i += 4096) {
      const page = await this.json<{ missing: string[] }>("POST", "/v1/chunks/exists", {
        auth: "device",
        json: { sids: sids.slice(i, i + 4096) },
        ...patience,
      });
      missing.push(...page.missing);
    }
    return missing;
  }

  /**
   * Upload one chunk: once per sid, inside the in-flight ceiling, and never a
   * body the server already holds.
   *
   * ONE UPLOAD PER SID. Two files that share a chunk, a push racing the
   * repair walk, and a pull re-sealing a chunk it just verified all name the
   * same sid, and each of them asked `/v1/chunks/exists` before any of the
   * others finished, so each believes the chunk is missing. A sid IS the hash
   * of its bytes, so the second caller wants exactly the bytes the first is
   * already sending: it awaits that upload instead of putting a second copy
   * of up to 8 MiB on the wire beside it.
   */
  async putChunk(sid: string, ciphertext: Bytes, patience: Patience = {}): Promise<void> {
    const running = this.uploading.get(sid);
    if (running) {
      this.upload.deduped += 1;
      await running;
      return;
    }
    const upload = this.uploadChunk(sid, ciphertext, patience);
    this.uploading.set(sid, upload);
    try {
      await upload;
    } finally {
      this.uploading.delete(sid);
    }
  }

  /**
   * One chunk body, retried like any repeatable route — except that a retry
   * ASKS before it re-sends. An unsettled attempt is not a failed one: the
   * body may have arrived, been verified and been stored, and only the answer
   * lost. `/v1/chunks/exists` settles that for a few hundred bytes instead of
   * up to 8 MiB, and a probe that does not settle answers "no", which sends.
   */
  private async uploadChunk(sid: string, ciphertext: Bytes, patience: Patience): Promise<void> {
    const target = `/v1/chunks/${sid}`;
    await this.admit(ciphertext.length);
    try {
      // THE SID IS THE BODY'S HASH where `encryptChunk` made this very body
      // (`sealedSid`, issue #197), so it is the signature's body term and the
      // body is not hashed again. Any other body is hashed like every body.
      const digest = sealedSid(ciphertext) === sid ? sid : undefined;
      const sending = await this.prepare(target, { auth: "device", binary: ciphertext, digest });
      const started = this.now();
      const budget = this.budget(patience, started);
      for (let attempt = 1; ; attempt++) {
        if (patience.signal?.aborted) throw this.ended("PUT", target, "cancelled", "waiting", attempt - 1, started);
        const outcome = await this.until(this.attempt("PUT", target, sending), patience.signal, budget.deadline);
        if (outcome === "cancelled" || outcome === "deadline") throw this.ended("PUT", target, outcome, "in_flight", attempt, started);
        if (outcome.kind === "settled") {
          this.settle("PUT", target, outcome.response, attempt, started);
          this.upload.chunks += 1;
          return;
        }
        await this.pause("PUT", target, outcome, attempt, budget, started, patience.signal);
        if (await this.landed(sid)) {
          this.log(`upload decision=landed bytes=${ciphertext.length} attempts=${attempt} duration_ms=${this.now() - started}`);
          this.upload.chunks += 1;
          return;
        }
        this.upload.resent += ciphertext.length;
      }
    } finally {
      this.release(ciphertext.length);
    }
  }

  /** Does this body fit in flight through its pipe? A pipe holding nothing fits anything. */
  private fits(pipe: Pipe, bytes: number): boolean {
    return pipe.bytes === 0 || pipe.bytes + bytes <= pipe.max;
  }

  /** Claim room for one body, in arrival order within its pipe. */
  private async admit(bytes: number): Promise<void> {
    const pipe = bytes <= SMALL_BODY_MAX ? this.pipes.small : this.pipes.large;
    if (pipe.waiting.length === 0 && this.fits(pipe, bytes)) {
      pipe.bytes += bytes;
      return;
    }
    // The large pipe waits on every chunk of a big upload, which the run's own
    // summary covers; the small allowance filling is the new ceiling firing.
    if (pipe === this.pipes.small) {
      this.log(`upload decision=waiting lane=small bytes=${bytes} in_flight=${pipe.bytes} budget=${pipe.max}`);
    }
    await new Promise<void>((resume) => pipe.waiting.push({ bytes, resume }));
  }

  /** Give the room back and hand it to the waiters that now fit. */
  private release(bytes: number): void {
    const pipe = bytes <= SMALL_BODY_MAX ? this.pipes.small : this.pipes.large;
    pipe.bytes -= bytes;
    for (let head = pipe.waiting[0]; head !== undefined && this.fits(pipe, head.bytes); head = pipe.waiting[0]) {
      pipe.waiting.shift();
      // Claimed HERE, before the waiter resumes, so the next head measures
      // against a pipe that already holds it.
      pipe.bytes += head.bytes;
      head.resume();
    }
  }

  /** Has this chunk already landed? One attempt; anything else answers no. */
  private async landed(sid: string): Promise<boolean> {
    const target = "/v1/chunks/exists";
    try {
      const sending = await this.prepare(target, { auth: "device", json: { sids: [sid] } });
      const probe = await this.attempt("POST", target, sending);
      if (probe.kind !== "settled" || probe.response.status >= 400) return false;
      return decode<{ missing: string[] }>(probe.response).missing.length === 0;
    } catch {
      // The probe saves bytes; it can never cost a chunk.
      return false;
    }
  }

  /**
   * What the chunk uploader has done so far, so a caller can log its own run
   * (requirement 12). `resent` counts ciphertext bytes put on the wire for a
   * chunk whose body this client had already sent: the quantity V7 bounds.
   */
  uploadStats(): { chunks: number; resent: number; deduped: number } {
    return { ...this.upload };
  }

  async getChunk(sid: string, control?: ReadControl, patience: Patience = {}): Promise<Bytes> {
    const target = `/v1/chunks/${sid}`;
    const response = control
      ? await this.readOnce(target, control, CHUNK_CIPHERTEXT_MAX)
      : this.capped("GET", target, await this.call("GET", target, { auth: "device", cap: CHUNK_CIPHERTEXT_MAX, bulk: true, ...patience }), CHUNK_CIPHERTEXT_MAX, true);
    return new Uint8Array(response.arrayBuffer);
  }

  /**
   * Batch chunk fetch (≤ 64 sids), one `multipart/mixed` response in request
   * order. Cuts request count over a proxied hop, which is what mobile
   * latency is made of. A missing sid comes back as a zero-length part with
   * `X-Obsync-Missing: 1` and is returned as `null`.
   */
  async getChunks(
    sids: string[],
    control?: ReadControl,
    patience: Patience = {},
    maxBytes = sids.length * CHUNK_CIPHERTEXT_MAX,
  ): Promise<(Bytes | null)[]> {
    const target = "/v1/chunks/get";
    // `maxBytes` is the ciphertext a caller's budget holds (`pull.ts`, `Prefetch`); the framing is this route's.
    const cap = Math.min(sids.length * CHUNK_CIPHERTEXT_MAX, maxBytes) + (sids.length + 1) * MULTIPART_PART_OVERHEAD;
    const response = control
      ? await this.readOnce(target, control, 33 * 1024 * 1024, { sids })
      : this.capped("POST", target, await this.call("POST", target, { auth: "device", json: { sids }, cap, bulk: true, ...patience }), cap, true);
    const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
    const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
    if (!boundary) throw new ApiError(response.status, "bad_multipart", "no multipart boundary");
    const parts = parseMultipart(new Uint8Array(response.arrayBuffer), boundary);
    // EVERY PART NAMES THE CHUNK IT CARRIES, in the order asked (#202). Matched
    // by position alone, a part reordered or dropped on the way -- a proxy's
    // doing, never the server's -- failed the content check downstream and
    // stalled the feed on that record as if the server were gone. Refused
    // here, by name, it is the refusal it is.
    const count = Math.max(parts.length, sids.length);
    let wrong = 0;
    while (wrong < count && parts[wrong]?.sid === sids[wrong]) wrong++;
    if (wrong < count) {
      this.log(`http POST ${target} decision=refused reason=part_mismatch part=${wrong} parts=${parts.length} asked=${sids.length}`);
      throw new ApiError(response.status, "part_mismatch", `part ${wrong} is not the chunk asked for`);
    }
    return parts.map((part) => (part.missing ? null : part.body));
  }

  // --- files and versions ------------------------------------------------

  postVersion(fileId: string, version: VersionPost): Promise<Sent<VersionAck>> {
    return this.once("POST", `/v1/files/${fileId}/versions`, { auth: "device", json: version });
  }

  getFile(fileId: string, patience: Patience = {}): Promise<FileRecord> {
    return this.json("GET", `/v1/files/${fileId}`, { auth: "device", cap: METADATA_ANSWER_MAX, ...patience });
  }

  /** One version, or `404 unknown_version` when the server does not hold it. */
  getVersion(fileId: string, versionId: string, patience: Patience = {}): Promise<VersionRecord> {
    return this.json("GET", `/v1/files/${fileId}/versions/${versionId}`, { auth: "device", cap: METADATA_ANSWER_MAX, ...patience });
  }

  /** The file listing (`docs/protocol.md`), at most 1000 per page. */
  listFiles(after: string | null, patience: Patience = {}): Promise<FilesPage> {
    return this.json("GET", `/v1/files?${after === null ? "" : `after=${after}&`}limit=1000`, { auth: "device", cap: METADATA_ANSWER_MAX, ...patience });
  }

  // --- change feed -------------------------------------------------------

  /**
   * One page of the feed, and a page over its ceiling is asked again SMALLER
   * (#202). A 1.1.4 server caps its pages by bytes; a 1.1.3 server bounds them
   * only by `limit`, and a page of large manifests can legitimately pass any
   * ceiling there. So an over-ceiling page is asked again from the same cursor
   * at half the limit, down to one entry, each step one line; only a single
   * entry over the ceiling is a refusal.
   */
  async changes(since: number, wait: number, limit = 1000, patience: Patience = {}): Promise<ChangesPage> {
    const seconds = Math.min(Math.max(0, Math.floor(wait)), MAX_WAIT_SECONDS);
    for (let asked = limit; ;) {
      const target = `/v1/changes?since=${since}&wait=${seconds}&limit=${asked}`;
      try {
        return await this.json<ChangesPage>("GET", target, { auth: "device", cap: CHANGES_ANSWER_MAX, ...patience });
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "response_too_large") || asked <= 1) throw error;
        asked = Math.max(1, Math.floor(asked / 2));
        this.log(`http GET ${target} decision=refused reason=over_cap retry limit=${asked}`);
      }
    }
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
  pluginManifest(patience: Patience = {}): Promise<PluginManifest> {
    return this.json("GET", "/v1/plugin/manifest", { auth: "none", ...patience });
  }
}

/**
 * The code for an answer that is not obsync's: a proxy, an access policy or a
 * sign-in page in front of the server answered in its place (issue #155). It
 * is a refusal of its own, because what fixes it -- the address, the edge
 * headers, the proxy -- is not what fixes an absent server or a refusal the
 * server itself made.
 */
export const NOT_OBSYNC = "not_obsync";

/**
 * A CERTIFICATE THIS DEVICE DOES NOT TRUST IS NOT ABSENCE. Something answered,
 * and the device's own TLS refused the certificate it showed: signed by an
 * authority this device was never told to trust. No retry changes that, and
 * "not answering" sent people to their network. Matched on each platform's
 * own words for exactly that failure, which the transport keeps in the
 * `network=` reason: Chromium's on desktop (seen, #201), Apple's and
 * Android's on a phone. A name mismatch or an expired certificate is not
 * this, and is not matched.
 */
const UNTRUSTED_AUTHORITY = /ERR_CERT_AUTHORITY_INVALID|unknown certifying authority|trust anchor for certification path/i;

/** What an untrusted certificate says, with the one thing to do (troubleshooting, same heading). */
export const CERT_UNTRUSTED =
  "This device does not trust your server's certificate, so it refused the connection. Trust that certificate on this device " +
  "-- see Troubleshooting, \"The certificate is not trusted on this device\".";

export function untrustedCertificate(error: unknown): boolean {
  return error instanceof ApiError && error.code === "unreachable" && UNTRUSTED_AUTHORITY.test(error.detail);
}

function decode<T>(response: HttpResponse): T {
  if (response.text === "") return {} as T;
  try {
    return JSON.parse(response.text) as T;
  } catch {
    // An answer obsync never gives: a sign-in page, a portal, a proxy's own.
    throw new ApiError(response.status, NOT_OBSYNC, "the answer is not obsync's");
  }
}

/** obsync refuses with `{"error": code, "detail": text}`; anything else is the edge's. */
function parseError(text: string): { code: string; detail: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)["error"] === "string") {
      const record = parsed as Record<string, unknown>;
      return { code: record["error"] as string, detail: typeof record["detail"] === "string" ? record["detail"] : "" };
    }
  } catch {
    // Not JSON at all: certainly not obsync's.
  }
  return { code: NOT_OBSYNC, detail: text.slice(0, 200) };
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
      body: body.slice(start, start + length),
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
