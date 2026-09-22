/**
 * Hand-written fakes: a vault and an obsyncd, both in memory.
 *
 * The fake server is deliberately strict — it verifies the HMAC signature of
 * every device request, that an uploaded chunk hashes to its sid, and that a
 * posted `version_id` equals its own recomputation — so an engine test that
 * passes has exercised the real transport, the real signing and the real
 * version-id preimage, not a mock that agrees with whatever it is told.
 *
 * No assertion library, no mock framework: `node:crypto` and plain objects.
 */

import { createHash, createHmac } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const dm = require("../build/domainmap.js");
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A throwaway directory where `obsidian` resolves to a stub, the way
 * Obsidian's own loader makes it resolve. `build/` is always copied in;
 * `dist/` only when asked, because `build.mjs` deletes and recreates `dist/`
 * and the test runner runs test FILES in parallel — a sandbox that copied it
 * unconditionally would race the bundle test's rebuild.
 */
export function sandbox({ dist = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "obsync-sandbox-"));
  mkdirSync(join(home, "node_modules", "obsidian"), { recursive: true });
  writeFileSync(
    join(home, "node_modules", "obsidian", "package.json"),
    JSON.stringify({ name: "obsidian", version: "0.0.0", main: "index.js" }),
  );
  // The smallest stub that satisfies module-scope evaluation.
  writeFileSync(
    join(home, "node_modules", "obsidian", "index.js"),
    `class Component {}
class Plugin extends Component {}
class Modal { constructor(app) { this.app = app; } }
// Like the real one, the constructor names the tab after the plugin. The API
// declaration does not list \`id\` or \`name\`, so a subclass field with either
// name would shadow them unseen by the compiler; the settings test pins both.
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.id = plugin.manifest?.id ?? "fixture"; this.name = plugin.manifest?.name ?? "Fixture"; }
  update() {} hide() {}
}
class Setting { constructor(el) { this.el = el; } }
// Every Notice the plugin raises is recorded, so a test can read what the
// user was actually told instead of asserting on a call it cannot see.
const notices = [];
class Notice { constructor(message) { this.message = message; notices.push(message); } hide() {} }
class TFile {}
class TFolder {}
class TAbstractFile {}
module.exports = {
  Component, Plugin, Modal, PluginSettingTab, Setting, Notice, TFile, TFolder, TAbstractFile, notices,
  Platform: { isMobile: false, isDesktopApp: true, isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isTablet: false },
  requestUrl: async () => ({ status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }),
  normalizePath: (p) => p,
};
`,
  );
  cpSync(join(PLUGIN_DIR, "build"), join(home, "build"), { recursive: true });
  if (dist) cpSync(join(PLUGIN_DIR, "dist"), join(home, "plugin"), { recursive: true });
  return { home, require: createRequire(join(home, "x.js")) };
}

const enc = (text) => new TextEncoder().encode(text);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Two parent lists that name one position: a set, not an order (#114). */
const sameSet = (a, b) => {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
};

/** A vault of files in memory, with the `VaultHost` surface the engine needs. */
export class FakeHost {
  constructor({ isMobile = false, platform = "linux", appVersion = "0.1.0", deviceName = "test-device" } = {}) {
    /** Paths the host refuses to sync at all, as a symlinked folder is. */
    this.unsyncable = new Set();
    this.isMobile = isMobile;
    this.supportsRangeReads = !isMobile;
    this.platform = platform;
    this.appVersion = appVersion;
    this.deviceName = deviceName;
    this.files = new Map();
    this.logs = [];
    this.notices = [];
    this.trashed = [];
    this.clock = 1757200000000;
  }

  seed(path, content, mtime) {
    const bytes = typeof content === "string" ? enc(content) : content;
    this.files.set(path, { bytes, mtime: mtime ?? this.clock });
    return bytes;
  }

  text(path) {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.bytes) : null;
  }

  async list() {
    return [...this.files.entries()].map(([path, file]) => ({
      path,
      mtime: file.mtime,
      size: file.bytes.length,
    }));
  }

  /** The real host refuses a path with a symlink component; this one is told. */
  async syncable(path) {
    return !this.unsyncable.has(path);
  }

  async stat(path) {
    const file = this.files.get(path);
    return file ? { path, mtime: file.mtime, size: file.bytes.length } : null;
  }

  async read(path) {
    const file = this.files.get(path);
    if (!file) throw new Error(`fake vault: ${path} does not exist`);
    return file.bytes;
  }

  source(path, size) {
    return {
      size,
      read: async (offset, length) => (await this.read(path)).subarray(offset, offset + length),
    };
  }

  async writer(path) {
    const parts = [];
    const host = this;
    return {
      async write(bytes) {
        parts.push(bytes);
      },
      async commit(mtime) {
        let total = 0;
        for (const part of parts) total += part.length;
        const joined = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
          joined.set(part, at);
          at += part.length;
        }
        host.files.set(path, { bytes: joined, mtime });
        return { path, mtime, size: joined.length };
      },
      async abort() {
        parts.length = 0;
      },
    };
  }

  /**
   * The create-only writer, refusing what the real one refuses: a destination
   * that exists, and content that does not match the size the caller declared.
   * Both real hosts enforce that budget (`main.ts`), and a fake that accepts a
   * short or overlong copy is a fake that cannot show a file changing under a
   * copy of it.
   */
  async createWriter(path, size, check) {
    const writer = await this.writer(path);
    let at = 0;
    return {
      write: async (bytes) => {
        check();
        at += bytes.length;
        if (at > size) throw new Error("copy exceeded its byte budget");
        await writer.write(bytes);
      },
      commit: async (mtime) => {
        check();
        if (at !== size) throw new Error("copy content is incomplete");
        if (this.files.has(path)) throw new Error("destination exists");
        return writer.commit(mtime);
      },
      abort: writer.abort,
    };
  }

  async trash(path) {
    this.trashed.push(path);
    this.files.delete(path);
  }

  notify(message) {
    this.notices.push(message);
  }

  log(line) {
    this.logs.push(line);
  }
}

/** An in-memory obsyncd covering the endpoints the engine uses. */
export class FakeServer {
  constructor({ deviceId = "aabbccddeeff00112233445566778899", deviceSecretHex = "0f".repeat(32) } = {}) {
    this.deviceId = deviceId;
    this.deviceSecret = Buffer.from(deviceSecretHex, "hex");
    /** One secret per enrolled device, as obsyncd holds them. */
    this.secrets = new Map([[deviceId, this.deviceSecret]]);
    this.chunks = new Map();
    this.files = new Map();
    this.journal = [];
    this.seq = 0;
    /** Posts this server answered with a version it already held (#114). */
    this.deduplicated = [];
    /** Set to model a server before 1.0.7: no `version_id` in the answer. */
    this.oldServer = false;
    this.devices = [
      {
        device_id: deviceId,
        name: "test-device",
        platform: "linux",
        app_version: "0.1.0",
        last_seen: 0,
        revoked: false,
        policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
      },
    ];
    this.requests = [];
    this.unsigned = [];
    this.feedWaiters = [];
    this.heartbeats = 0;
    /** Set by `seedDomainMap`: the reserved file the map occupies. */
    this.mapFileId = null;
    this.request = this.request.bind(this);
  }

  bodyBytes(request) {
    if (request.body === undefined) return Buffer.alloc(0);
    return typeof request.body === "string" ? Buffer.from(request.body, "utf8") : Buffer.from(new Uint8Array(request.body));
  }

  verify(request, target) {
    const headers = request.headers;
    if (!headers["X-Obsync-Sig"]) {
      this.unsigned.push(target);
      throw new Error(`fake server: ${target} arrived unsigned`);
    }
    const preimage = [
      "obsync/v1",
      request.method,
      target,
      headers["X-Obsync-Ts"],
      headers["X-Obsync-Nonce"],
      sha256(this.bodyBytes(request)),
    ].join("\n");
    // The signing key is the one enrolled for the device that CLAIMS the
    // request, never a server-wide secret: a two-device test must not be able
    // to pass by signing as somebody else.
    const secret = this.secrets.get(headers["X-Obsync-Device"]);
    if (!secret) throw new Error(`fake server: ${target} claims an unenrolled device`);
    const expected = createHmac("sha256", secret).update(preimage).digest("hex");
    if (expected !== headers["X-Obsync-Sig"]) throw new Error(`fake server: bad signature on ${target}`);
  }

  /** Enrol a second device in the same vault, with its own secret. */
  addDevice(deviceId, deviceSecretHex, name, platform = "ios") {
    this.secrets.set(deviceId, Buffer.from(deviceSecretHex, "hex"));
    this.devices.push({
      device_id: deviceId,
      name,
      platform,
      app_version: "0.1.0",
      last_seen: 0,
      revoked: false,
      policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
    });
    return deviceId;
  }

  json(status, value) {
    return { status, headers: {}, text: JSON.stringify(value), arrayBuffer: new ArrayBuffer(0) };
  }

  /**
   * A version acknowledgement. `version_id` names the version the store holds
   * for the post (issue #114); `oldServer` models a server before 1.0.7,
   * which sends no such field, so the device must fall back to the id it
   * computed itself.
   */
  ack(seq, versionId, file) {
    const body = { seq, heads: file.heads, conflicted: file.heads.length > 1 };
    return this.oldServer ? body : { ...body, version_id: versionId };
  }

  error(status, code, detail = "") {
    return this.json(status, { error: code, detail });
  }

  /** The server's own version-id recomputation, per docs/architecture.md 3.4. */
  versionId(fileId, parents, manifestCt, sids) {
    return sha256(
      Buffer.concat([
        Buffer.from(fileId, "hex"),
        ...[...parents].sort().map((parent) => Buffer.from(parent, "hex")),
        Buffer.from(manifestCt, "base64"),
        ...sids.map((sid) => Buffer.from(sid, "hex")),
      ]),
    );
  }

  record(fileId, version) {
    const file = this.files.get(fileId) ?? { heads: [], versions: [] };
    this.files.set(fileId, file);
    return file;
  }

  async request(request) {
    const target = request.url.replace(/^https?:\/\/[^/]+/, "");
    const [path, query] = target.split("?");
    this.requests.push({
      method: request.method,
      target,
      json: typeof request.body === "string" ? request.body : null,
    });
    const body = this.bodyBytes(request);
    const json = () => JSON.parse(body.toString("utf8") || "{}");

    if (path.startsWith("/v1/plugin/")) return this.json(200, { version: "0.1.0", bundle_sha256: "", styles_sha256: "" });
    this.verify(request, target);

    // Match the Rust device parser before acknowledging a heartbeat or PATCH.
    if (path === "/v1/devices/heartbeat" || (request.method === "PATCH" && path.startsWith("/v1/devices/"))) {
      const policy = json().policy;
      if (policy != null && ["per_file_max_bytes", "total_budget_bytes"].some((key) =>
        !Number.isSafeInteger(policy[key]) || policy[key] < 0)) return this.error(400, "bad_request");
    }
    if (path === "/v1/devices/heartbeat") {
      this.heartbeats++;
      return this.json(204, {});
    }
    if (path === "/v1/devices") return this.json(200, { devices: this.devices });

    const devicePatch = /^\/v1\/devices\/([0-9a-f]{32})$/.exec(path);
    if (devicePatch && request.method === "PATCH") {
      const device = this.devices.find((candidate) => candidate.device_id === devicePatch[1]);
      if (!device) return this.error(404, "unknown_device");
      const patch = json();
      if (typeof patch.name === "string") device.name = patch.name;
      if (patch.policy) device.policy = patch.policy;
      return this.json(200, device);
    }

    const deviceRevoke = /^\/v1\/devices\/([0-9a-f]{32})\/revoke$/.exec(path);
    if (deviceRevoke && request.method === "POST") {
      const device = this.devices.find((candidate) => candidate.device_id === deviceRevoke[1]);
      if (!device) return this.error(404, "unknown_device");
      const live = this.devices.filter((candidate) => !candidate.revoked);
      if (device.device_id === request.headers["X-Obsync-Device"] && live.length === 1) {
        return this.error(409, "only_device", "the only device cannot revoke itself");
      }
      device.revoked = true;
      return this.json(204, {});
    }

    if (path === "/v1/chunks/exists") {
      const { sids } = json();
      return this.json(200, { missing: sids.filter((sid) => !this.chunks.has(sid)) });
    }
    if (path === "/v1/chunks/get") {
      const { sids } = json();
      if (sids.reduce((total, sid) => total + (this.chunks.get(sid)?.length ?? 0), 0) > 32 * 1024 * 1024) {
        return this.error(413, "batch_too_large");
      }
      const boundary = "obsyncfake";
      const parts = [];
      for (const sid of sids) {
        const chunk = this.chunks.get(sid);
        const head = chunk
          ? `--${boundary}\r\nX-Obsync-Sid: ${sid}\r\nContent-Length: ${chunk.length}\r\n\r\n`
          : `--${boundary}\r\nX-Obsync-Sid: ${sid}\r\nX-Obsync-Missing: 1\r\nContent-Length: 0\r\n\r\n`;
        parts.push(Buffer.from(head), chunk ? Buffer.from(chunk) : Buffer.alloc(0), Buffer.from("\r\n"));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const document = Buffer.concat(parts);
      return {
        status: 200,
        headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
        text: "",
        arrayBuffer: document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength),
      };
    }
    if (path.startsWith("/v1/chunks/")) {
      const sid = path.slice("/v1/chunks/".length);
      if (request.method === "PUT") {
        if (body.length > 8 * 1024 * 1024 + 16) return this.error(413, "body_too_large");
        if (sha256(body) !== sid) return this.error(422, "sid_mismatch", "the body does not hash to its sid");
        this.chunks.set(sid, new Uint8Array(body));
        return this.json(201, {});
      }
      const chunk = this.chunks.get(sid);
      if (!chunk) return this.error(404, "unknown_chunk");
      const buffer = Buffer.from(chunk);
      return {
        status: 200,
        headers: {},
        text: "",
        arrayBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      };
    }

    const versionsPost = /^\/v1\/files\/([0-9a-f]{32})\/versions$/.exec(path);
    if (versionsPost && request.method === "POST") {
      const fileId = versionsPost[1];
      const posted = json();
      for (const sid of posted.sids) {
        if (!this.chunks.has(sid)) return this.error(409, "missing_chunks", sid);
      }
      const recomputed = this.versionId(fileId, posted.parents, posted.manifest_ct, posted.sids);
      if (recomputed !== posted.version_id) return this.error(422, "version_id_mismatch", recomputed);
      // The server's own domain rules (`docs/architecture.md` 5.1 item 4):
      // every version names a domain, and a file never changes the one its
      // first version gave it.
      if (!/^[0-9a-f]{32}$/.test(posted.domain_id ?? "")) {
        return this.error(400, "bad_request", "domain_id must be 32 hex characters");
      }
      const file = this.files.get(fileId) ?? { heads: [], versions: [], domain_id: posted.domain_id };
      this.files.set(fileId, file);
      if (file.domain_id !== posted.domain_id) {
        return this.error(409, "domain_mismatch", file.domain_id);
      }
      if (file.versions.some((version) => version.version_id === posted.version_id)) {
        return this.json(200, this.ack(this.seq, posted.version_id, file));
      }
      // One position, one version (`docs/protocol.md`; issue #114). A post
      // that promises to store the id it is answered with, and whose
      // `(parent set, sids in order, tombstone flag)` a version of this file
      // already holds, is answered with THAT version and writes no frame.
      // The comparison deliberately excludes the encrypted manifest, exactly
      // as the server's does, which is why a rename must not promise this.
      if (posted.accept_existing === true) {
        const twin = file.versions.find(
          (version) =>
            Boolean(version.deleted) === Boolean(posted.deleted) &&
            sameSet(version.parents, posted.parents) &&
            version.sids.length === posted.sids.length &&
            version.sids.every((sid, index) => sid === posted.sids[index]),
        );
        if (twin) {
          this.deduplicated.push({ fileId, posted: posted.version_id, existing: twin.version_id });
          return this.json(200, this.ack(twin.seq, twin.version_id, file));
        }
      }
      const sameHeads =
        file.heads.length === posted.parents.length &&
        file.heads.every((head) => posted.parents.includes(head));
      file.heads = sameHeads ? [posted.version_id] : [...file.heads, posted.version_id];
      const version = {
        ...posted,
        device_id: request.headers["X-Obsync-Device"],
        ts: 1757200000000,
        seq: ++this.seq,
      };
      file.versions.unshift(version);
      this.journal.push({ ...version, file_id: fileId, heads: file.heads, conflicted: file.heads.length > 1 });
      this.releaseFeed();
      return this.json(201, this.ack(version.seq, version.version_id, file));
    }

    const versionGet = /^\/v1\/files\/([0-9a-f]{32})\/versions\/([0-9a-f]{64})$/.exec(path);
    if (versionGet) {
      const version = this.files.get(versionGet[1])?.versions.find((v) => v.version_id === versionGet[2]);
      return version ? this.json(200, version) : this.error(404, "unknown_version");
    }
    const fileGet = /^\/v1\/files\/([0-9a-f]{32})$/.exec(path);
    if (fileGet) {
      const file = this.files.get(fileGet[1]);
      if (!file) return this.error(404, "unknown_file");
      return this.json(200, {
        file_id: fileGet[1],
        domain_id: file.domain_id,
        heads: file.heads,
        conflicted: file.heads.length > 1,
        // Exactly what the server renders: versions carry no file id.
        versions: file.versions,
      });
    }

    if (path === "/v1/changes") {
      const since = Number(new URLSearchParams(query).get("since") ?? 0);
      const params = new URLSearchParams(query);
      const limit = Number(params.get("limit") ?? 1000);
      const remaining = this.journal.filter((frame) => frame.seq > since);
      const changes = remaining.slice(0, limit);
      if (changes.length > 0) {
        return this.json(200, { seq: remaining.length > limit ? changes[changes.length - 1].seq : this.seq, head_seq: this.seq, changes });
      }
      if (Number(params.get("wait") ?? 0) === 0) return this.json(200, { seq: this.seq, head_seq: this.seq, changes: [] });
      // A real long poll: hold until the test lands a frame or releases it.
      return new Promise((resolve) => {
        this.feedWaiters.push(() => resolve(this.json(200, { seq: since, head_seq: this.seq, changes: [] })));
      });
    }

    return this.error(404, "not_found", path);
  }

  /**
   * Give this vault the domain map a real one already has, WITHOUT putting it
   * on the feed: the engine reads it at start through `GET /v1/files`. The
   * feed case has its own test, because skipping the map by file id is a
   * guard and guards are proved, not assumed.
   */
  /** Every file except the domain map: what a vault's own files are. */
  vaultFiles() {
    return [...this.files.keys()].filter((id) => id !== this.mapFileId);
  }

  async seedDomainMap(mapKeys, domainId) {
    this.mapFileId = mapKeys.fileId;
    const map = dm.defaultDomainMap(domainId);
    const json = dm.serialiseDomainMap(map);
    const binder = await c.contentVersionId(mapKeys.fileId, [], []);
    const sealed = await c.encryptDomainMap(mapKeys.key, mapKeys.fileId, binder, json);
    const versionId = await c.versionId(mapKeys.fileId, [], sealed.ciphertext, []);
    this.files.set(mapKeys.fileId, {
      heads: [versionId],
      domain_id: mapKeys.domainId,
      versions: [
        {
          version_id: versionId,
          parents: [],
          sids: [],
          bytes: 0,
          manifest_ct: c.base64(sealed.ciphertext),
          manifest_nonce: c.hex(sealed.nonce),
          domain_id: mapKeys.domainId,
          deleted: false,
          device_id: "ffffffffffffffffffffffffffffffff",
          ts: 1757200000000,
          seq: ++this.seq,
        },
      ],
    });
    return versionId;
  }

  releaseFeed() {
    const waiters = this.feedWaiters;
    this.feedWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Land a version authored by another device, as the feed would deliver it. */
  async publish({ fileId, path, bytes, mtime, domainKey, manifestKey, parents = [], deviceId = "ffffffffffffffffffffffffffffffff" }) {
    const { cid, sid, ciphertext } = await c.encryptChunk(domainKey, bytes);
    this.chunks.set(sid, ciphertext);
    const manifest = {
      v: 1,
      path,
      size: bytes.length,
      mtime,
      domain: "0123456789abcdef0123456789abcdef",
      chunks: [{ sid, cid: c.hex(cid), len: bytes.length }],
      sha256: c.hex(await c.sha256(bytes)),
      deleted: false,
    };
    return this.publishManifest({ fileId, manifest, sids: [sid], parents, deviceId, manifestKey, bytes: bytes.length });
  }

  async publishTombstone({ fileId, path, manifestKey, parents = [], deviceId = "ffffffffffffffffffffffffffffffff" }) {
    const manifest = {
      v: 1,
      path,
      size: 0,
      mtime: 1757200000000,
      domain: "0123456789abcdef0123456789abcdef",
      chunks: [],
      sha256: "",
      deleted: true,
    };
    return this.publishManifest({ fileId, manifest, sids: [], parents, deviceId, manifestKey, bytes: 0 });
  }

  /**
   * Land a version whose RECORD fields may be stated separately from the
   * manifest's. Honest traffic leaves them alone and they follow the
   * manifest, which is what every other test uses; a hostile test forges
   * exactly one of them, which is the only way to build a validly encrypted
   * manifest that disagrees with the record it rides in.
   */
  async publishManifest({
    fileId,
    manifest,
    sids,
    parents,
    deviceId,
    manifestKey,
    bytes,
    domainId = manifest.domain,
    deleted = manifest.deleted,
  }) {
    const binder = await c.contentVersionId(fileId, parents, sids);
    const sealed = await c.encryptManifest(manifestKey, fileId, binder, JSON.stringify(manifest));
    const manifestCt = c.base64(sealed.ciphertext);
    const versionId = await c.versionId(fileId, parents, sealed.ciphertext, sids);
    const file = this.files.get(fileId) ?? { heads: [], versions: [], domain_id: domainId };
    this.files.set(fileId, file);
    const sameHeads = file.heads.length === parents.length && file.heads.every((head) => parents.includes(head));
    file.heads = sameHeads ? [versionId] : [...file.heads, versionId];
    const version = {
      version_id: versionId,
      parents,
      sids,
      bytes,
      manifest_ct: manifestCt,
      manifest_nonce: c.hex(sealed.nonce),
      domain_id: domainId,
      deleted,
      device_id: deviceId,
      ts: manifest.mtime,
      seq: ++this.seq,
    };
    file.versions.unshift(version);
    const frame = { ...version, file_id: fileId, heads: file.heads, conflicted: file.heads.length > 1 };
    this.journal.push(frame);
    this.releaseFeed();
    return frame;
  }
}

/** How long a wait for an OUTCOME may take in real time before it gives up. */
const WAIT_BUDGET_MS = 10000;
/** How long a wait for NOTHING watches, in real time, before it is satisfied. */
const QUIET_MS = 250;
/**
 * Virtual steps a wait may take. Both bounds keep the one-hour heartbeat out
 * of reach of any wait (1800 s and 40 s of virtual time), so what a wait does
 * to the virtual clock never depends on how fast the machine is.
 */
const MAX_ADVANCES = 1800;
const QUIET_ADVANCES = 40;

/**
 * Timers on a virtual clock: nothing fires until the test advances time, so a
 * 500 ms debounce and a one-hour heartbeat cannot be confused for each other.
 */
export class FakeTimers {
  constructor() {
    this.entries = [];
    this.next = 1;
    this.now = 0;
  }

  set(fn, ms) {
    const handle = this.next++;
    this.entries.push({ handle, fn, due: this.now + ms });
    return handle;
  }

  clear(handle) {
    this.entries = this.entries.filter((entry) => entry.handle !== handle);
  }

  /**
   * Advance the virtual clock, fire what is due, and let the work it started
   * finish. A single push runs dozens of `crypto.subtle` calls, and WebCrypto
   * resolves on the libuv threadpool, so the work this waits for is not on
   * this thread at all.
   *
   * WAIT ON THE OUTCOME AND A WALL CLOCK, NEVER ON A NUMBER OF ROUNDS. A
   * round budget is a guess about how many event-loop turns a runtime needs,
   * and that guess is a function of MACHINE LOAD: when the threadpool is
   * starved (a coverage build, a container build, anything), the same work
   * takes the same wall time but many more idle turns, so a round cap can be
   * exhausted with the work still in flight. Every wait for something to
   * HAPPEN therefore polls a predicate until it holds or `budgetMs` of real
   * time passes, and an exhausted budget throws rather than returning
   * quietly into a mystery assertion.
   *
   * A round that fires nothing means the work is either finished or waiting
   * on a re-armed timer (the growing-file guard re-arms every 400 ms), so the
   * virtual clock steps one `advanceMs`. Those steps stay BOUNDED — the wall
   * clock governs waiting, the virtual clock governs firing — so a slow
   * machine cannot walk virtual time into the hourly heartbeat.
   *
   * A wait with no predicate is the other kind: it precedes an assertion that
   * nothing happened, and it drains for a real quiet window so that claim is
   * about a real interval rather than about a turn count.
   */
  async run(advanceMs = 1000, until = null, budgetMs = WAIT_BUDGET_MS) {
    this.now += advanceMs;
    const deadline = Date.now() + (until ? budgetMs : QUIET_MS);
    const advanceLimit = until ? MAX_ADVANCES : QUIET_ADVANCES;
    let advances = 0;
    for (;;) {
      const due = this.entries.filter((entry) => entry.due <= this.now);
      this.entries = this.entries.filter((entry) => entry.due > this.now);
      for (const entry of due) entry.fn();
      if (due.length > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      } else {
        // Nothing was due, so what we are waiting for is a promise, most of
        // it off-thread. Yield the CPU instead of spinning on it: that is
        // what makes this wait independent of how busy the machine is.
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (advances < advanceLimit) {
          this.now += advanceMs;
          advances++;
        }
      }
      if (until) {
        if (until()) return true;
        if (Date.now() >= deadline) {
          throw new Error(`fake timers: waited ${budgetMs} ms of real time and the condition never held`);
        }
      } else if (Date.now() >= deadline) {
        return true;
      }
    }
  }
}

export const KEYS = {
  vrk: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  domainId: "0123456789abcdef0123456789abcdef",
  deviceId: "aabbccddeeff00112233445566778899",
  deviceSecret: "0f".repeat(32),
};

/** Test-only native store: exact get/set operations, no enumeration surface. */
export function memorySecrets() {
  const held = new Map();
  return {
    getSecret: (id) => held.get(id) ?? null,
    setSecret: (id, value) => { held.set(id, value); },
  };
}

/** A `State` over in-memory metadata and a test-only native secret store. */
export async function fakeState(isMobile = false) {
  const { State } = require("../build/state.js");
  let stored = null;
  let written = false;
  const store = {
    loadData: async () => stored,
    saveData: async (value) => {
      stored = JSON.parse(JSON.stringify(value));
      written = true;
    },
  };
  const secrets = memorySecrets();
  const state = await State.open(store, isMobile, secrets);
  state.data.vrk = KEYS.vrk;
  state.data.deviceId = KEYS.deviceId;
  state.data.deviceSecret = KEYS.deviceSecret;
  state.data.serverUrl = "https://sync.example.invalid";
  // Callers observe writes made by their operation, after fixture setup.
  written = false;
  // `reload` is the next start of the plugin over the SAME stored metadata:
  // what this session holds in memory is not what the next session gets.
  return { state, saved: () => written ? stored : null, reload: () => State.open(store, isMobile, secrets) };
}

/**
 * One paired device, one seeded domain map, one live `SyncContext`: what
 * every engine-level test starts from. It lives here rather than in a test
 * file because more than one suite drives the same rig.
 */
export async function rig({ isMobile = false, policy } = {}) {
  const { Transport } = require("../build/transport.js");
  const host = new FakeHost({ isMobile });
  const server = new FakeServer();
  const { state, saved, reload } = await fakeState(isMobile);
  if (policy) state.data.policy = policy;
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const k = await keys();
  // Every real vault has a domain map before it syncs anything; a rig that
  // started without one would be testing a vault that cannot exist.
  await server.seedDomainMap(k.map, KEYS.domainId);
  const context = {
    state,
    transport,
    host,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    domainId: KEYS.domainId,
    mapFileId: k.map.fileId,
    deviceId: KEYS.deviceId,
    concurrency: isMobile ? 2 : 4,
    authored: new Set(),
    written: new Set(),
    trashed: new Set(),
    refused: new Set(),
    merges: new Map(),
    deviceNames: new Map([["ffffffffffffffffffffffffffffffff", "iPhone"]]),
    now: () => host.clock,
    deviceNameFor: (id) => (id === KEYS.deviceId ? "this device" : "iPhone"),
  };
  return { host, server, state, transport, context, keys: k, saved, reload };
}

export async function keys() {
  const vrk = Uint8Array.from(Buffer.from(KEYS.vrk, "hex"));
  const domainKey = await c.deriveDomainKey(vrk, KEYS.domainId);
  return {
    domainKey,
    // Per domain, not vault-wide (`docs/architecture.md` 5.1 item 2).
    manifestKey: await c.deriveManifestKey(domainKey, KEYS.domainId),
    map: await dm.domainMapKeys(vrk),
  };
}

/**
 * What the SERVER holds for a file id, decrypted: every version's manifest,
 * oldest first.
 *
 * A test that wants to know what was published -- the path a version carries,
 * the digest of its content -- has to read the manifests, because the server
 * holds nothing else about them and a log line is this device's account of
 * its own decision rather than the published fact. The key is the vault's;
 * the server never has it.
 */
export async function published(server, fileId, manifestKey) {
  const file = server.files.get(fileId);
  if (file === undefined) return [];
  const manifests = [];
  for (const version of [...file.versions].reverse()) {
    const binder = await c.contentVersionId(fileId, version.parents, version.sids);
    manifests.push(
      JSON.parse(
        await c.decryptManifest(
          manifestKey,
          fileId,
          binder,
          c.unhex(version.manifest_nonce),
          c.unbase64(version.manifest_ct),
        ),
      ),
    );
  }
  return manifests;
}

/** The plaintext digest a single-chunk manifest carries, for comparison. */
export const digest = (text) => sha256(enc(text));

/** The second device of a paired vault: its own id and its own secret. */
export const DEVICE_B = "00112233445566778899aabbccddeeff";
export const SECRET_B = "3c".repeat(32);

/**
 * The virtual clock steps in 50 ms, not in seconds: a pull takes milliseconds
 * on a real device and the debounce is 500 ms, so a clock that jumped a second
 * per turn would model a vault whose own echo overtakes the pull that caused
 * it. Stepping small keeps that ordering real; a wait still walks the clock
 * past 500 ms, so the debounce and the echo gate are exercised.
 */
export const STEP_MS = 50;

/**
 * Has this device finished recording the file it pushed or pulled? A version
 * reaches the server, and so the other device, BEFORE its author writes its
 * own record, so a wait that named only the other vault could read a state
 * one statement too early.
 */
export const settled = (device, path) => device.state.fileByPath(path) !== undefined;

/**
 * A vault that behaves like Obsidian's: every mutation, the plugin's own
 * included, comes back to this device as a vault event.
 *
 * DELIVERY IS A PARAMETER, NOT AN ASSUMPTION. `immediate` is what Obsidian's
 * own API does (`FileManager.trashFile` triggers `delete` before its promise
 * resolves); `deferred` is a watcher-shaped notification that arrives a turn
 * later. An invariant that held for only one ordering would not be an
 * invariant, so the suites that care drive both.
 */
export class EventVault extends FakeHost {
  constructor({ delivery = "immediate", obsidian, ...options } = {}) {
    super(options);
    this.delivery = delivery;
    this.obsidian = obsidian;
    this.listeners = new Map();
    /** Paths whose `delete` event this vault never delivers (a watcher miss). */
    this.silent = new Set();
  }

  on(name, handler) {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
    return { name };
  }

  emit(name, ...args) {
    const fire = () => {
      for (const handler of this.listeners.get(name) ?? []) handler(...args);
    };
    if (this.delivery === "immediate") fire();
    else setTimeout(fire, 0);
  }

  entry(path, folder = false) {
    const file = folder ? new this.obsidian.TFolder() : new this.obsidian.TFile();
    file.path = path;
    return file;
  }

  // --- what the plugin does to the vault, and what comes back ------------

  async trash(path) {
    const existed = this.files.has(path);
    await super.trash(path);
    if (existed && !this.silent.has(path)) this.emit("delete", this.entry(path));
  }

  async writer(path) {
    const writer = await super.writer(path);
    return { ...writer, commit: async (mtime) => this.commit(writer, path, mtime) };
  }

  async createWriter(path, size, check) {
    const writer = await super.createWriter(path, size, check);
    return { ...writer, commit: async (mtime) => this.commit(writer, path, mtime) };
  }

  async commit(writer, path, mtime) {
    const existed = this.files.has(path);
    const stat = await writer.commit(mtime);
    this.emit(existed ? "modify" : "create", this.entry(path));
    return stat;
  }

  // --- what the USER does to the vault -----------------------------------

  /** Type a note, or edit one. */
  write(path, text, mtime) {
    const existed = this.files.has(path);
    this.seed(path, text, mtime);
    this.emit(existed ? "modify" : "create", this.entry(path));
  }

  /** Rename a note through its inline title: one event, one file. */
  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    this.emit("rename", this.entry(to), from);
  }

  /** Rename a folder: every file under it moves, and Obsidian fires ONE event. */
  renameFolder(from, to) {
    for (const path of [...this.files.keys()].filter((candidate) => candidate.startsWith(`${from}/`))) {
      this.files.set(to + path.slice(from.length), this.files.get(path));
      this.files.delete(path);
    }
    this.emit("rename", this.entry(to, true), from);
  }

  /** Delete a note, the way the user's own delete command does. */
  remove(path) {
    this.files.delete(path);
    this.emit("delete", this.entry(path));
  }
}

/**
 * One device: its vault, its state, its own device secret, its engine, and
 * the plugin's real vault-event registration wired between the two.
 */
async function device(box, server, timers, { id, secret, name, delivery, isMobile = false }) {
  const { Transport } = require("../build/transport.js");
  const { SyncEngine } = require("../build/sync/engine.js");
  const obsidian = box.require("obsidian");
  const host = new EventVault({ delivery, obsidian, isMobile, deviceName: name });
  const { state } = await fakeState(isMobile);
  state.data.deviceId = id;
  state.data.deviceSecret = secret;
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id, secret: Uint8Array.from(Buffer.from(secret, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const engine = new SyncEngine({ state, transport, host, now: () => host.clock, timers });
  // The plugin's own handlers, not a copy of them: `registerVaultEvents` is
  // what maps a vault event onto an engine call, including the fan-out a
  // folder rename needs.
  const plugin = new (box.require(join(box.home, "build/main.js")).default)();
  plugin.app = { vault: host };
  plugin.registerEvent = () => undefined;
  plugin.state = state;
  plugin.engine = engine;
  plugin.registerVaultEvents();
  return { host, state, transport, engine, plugin };
}

/**
 * Two paired devices against one server, on one virtual clock.
 *
 * This is the rig for anything a single engine cannot show: what one device
 * does to the OTHER one's vault. Both run the real engine over a vault that
 * answers back, so the whole path from a vault event to a posted version, and
 * from a feed record back to a vault event, is the product's.
 */
export async function pair(t, delivery = "immediate") {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const server = new FakeServer();
  const k = await keys();
  await server.seedDomainMap(k.map, KEYS.domainId);
  server.addDevice(DEVICE_B, SECRET_B, "phone");
  const timers = new FakeTimers();
  const a = await device(box, server, timers, {
    id: KEYS.deviceId, secret: KEYS.deviceSecret, name: "desktop", delivery,
  });
  const b = await device(box, server, timers, {
    id: DEVICE_B, secret: SECRET_B, name: "phone", delivery, isMobile: true,
  });
  t.after(() => { a.engine.stop(); b.engine.stop(); });
  return { server, timers, a, b, keys: k };
}
