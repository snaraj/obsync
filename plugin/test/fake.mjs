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
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A throwaway directory where `obsidian` resolves to a stub, the way
 * Obsidian's own loader makes it resolve. Both `build/` and `dist/` are
 * copied in, so the compiled modules and the shipped bundle can be required
 * exactly as the app requires them.
 */
export function sandbox() {
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
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting { constructor(el) { this.el = el; } }
class Notice { constructor(message) { this.message = message; } hide() {} }
class TFile {}
class TFolder {}
class TAbstractFile {}
module.exports = {
  Component, Plugin, Modal, PluginSettingTab, Setting, Notice, TFile, TFolder, TAbstractFile,
  Platform: { isMobile: false, isDesktopApp: true, isMacOS: true, isWin: false, isLinux: false, isIosApp: false, isAndroidApp: false, isTablet: false },
  requestUrl: async () => ({ status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }),
  normalizePath: (p) => p,
};
`,
  );
  cpSync(join(PLUGIN_DIR, "build"), join(home, "build"), { recursive: true });
  cpSync(join(PLUGIN_DIR, "dist"), join(home, "plugin"), { recursive: true });
  return { home, require: createRequire(join(home, "x.js")) };
}

const enc = (text) => new TextEncoder().encode(text);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A vault of files in memory, with the `VaultHost` surface the engine needs. */
export class FakeHost {
  constructor({ isMobile = false, platform = "linux", appVersion = "0.1.0", deviceName = "test-device" } = {}) {
    this.isMobile = isMobile;
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
    this.chunks = new Map();
    this.files = new Map();
    this.journal = [];
    this.seq = 0;
    this.devices = [
      {
        device_id: deviceId,
        name: "test-device",
        platform: "linux",
        app_version: "0.1.0",
        last_seen: 0,
        revoked: false,
        policy: { perFileMaxBytes: 0, totalBudgetBytes: 0 },
      },
    ];
    this.requests = [];
    this.unsigned = [];
    this.feedWaiters = [];
    this.heartbeats = 0;
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
    const expected = createHmac("sha256", this.deviceSecret).update(preimage).digest("hex");
    if (expected !== headers["X-Obsync-Sig"]) throw new Error(`fake server: bad signature on ${target}`);
  }

  json(status, value) {
    return { status, headers: {}, text: JSON.stringify(value), arrayBuffer: new ArrayBuffer(0) };
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

    if (path === "/v1/devices/heartbeat") {
      this.heartbeats++;
      return this.json(204, {});
    }
    if (path === "/v1/devices") return this.json(200, { devices: this.devices });
    if (path === "/v1/domains" && request.method === "POST") return this.json(201, {});

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
      const file = this.files.get(fileId) ?? { heads: [], versions: [] };
      this.files.set(fileId, file);
      if (file.versions.some((version) => version.version_id === posted.version_id)) {
        return this.json(200, { seq: this.seq, heads: file.heads, conflicted: file.heads.length > 1 });
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
      return this.json(201, { seq: version.seq, heads: file.heads, conflicted: file.heads.length > 1 });
    }

    const fileGet = /^\/v1\/files\/([0-9a-f]{32})$/.exec(path);
    if (fileGet) {
      const file = this.files.get(fileGet[1]);
      if (!file) return this.error(404, "unknown_file");
      return this.json(200, {
        file_id: fileGet[1],
        heads: file.heads,
        conflicted: file.heads.length > 1,
        versions: file.versions.map((version) => ({ ...version, file_id: fileGet[1] })),
      });
    }

    if (path === "/v1/changes") {
      const since = Number(new URLSearchParams(query).get("since") ?? 0);
      const changes = this.journal.filter((frame) => frame.seq > since);
      if (changes.length > 0) {
        return this.json(200, { seq: changes[changes.length - 1].seq, head_seq: this.seq, changes });
      }
      // A real long poll: hold until the test lands a frame or releases it.
      return new Promise((resolve) => {
        this.feedWaiters.push(() => resolve(this.json(200, { seq: since, head_seq: this.seq, changes: [] })));
      });
    }

    return this.error(404, "not_found", path);
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

  async publishManifest({ fileId, manifest, sids, parents, deviceId, manifestKey, bytes }) {
    const binder = await c.contentVersionId(fileId, parents, sids);
    const sealed = await c.encryptManifest(manifestKey, fileId, binder, JSON.stringify(manifest));
    const manifestCt = c.base64(sealed.ciphertext);
    const versionId = await c.versionId(fileId, parents, sealed.ciphertext, sids);
    const file = this.files.get(fileId) ?? { heads: [], versions: [] };
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
      deleted: manifest.deleted,
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
   * Advance the clock, fire what is due, and let the work it started finish.
   * Each round yields to the event loop, which is what WebCrypto's promises
   * need: they resolve off the microtask queue, so one tick is not enough.
   */
  async run(advanceMs = 1000, rounds = 40) {
    this.now += advanceMs;
    for (let round = 0; round < rounds; round++) {
      const due = this.entries.filter((entry) => entry.due <= this.now);
      this.entries = this.entries.filter((entry) => entry.due > this.now);
      for (const entry of due) entry.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

export const KEYS = {
  vrk: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  domainId: "0123456789abcdef0123456789abcdef",
  deviceId: "aabbccddeeff00112233445566778899",
  deviceSecret: "0f".repeat(32),
};

/** A `State` over an in-memory data file. */
export async function fakeState(isMobile = false) {
  const { State } = require("../build/state.js");
  let stored = null;
  const store = {
    loadData: async () => stored,
    saveData: async (value) => {
      stored = JSON.parse(JSON.stringify(value));
    },
  };
  const state = await State.open(store, isMobile);
  state.data.vrk = KEYS.vrk;
  state.data.deviceId = KEYS.deviceId;
  state.data.deviceSecret = KEYS.deviceSecret;
  state.data.serverUrl = "https://sync.example.invalid";
  state.data.domains[KEYS.domainId] = "";
  return { state, saved: () => stored };
}

export async function keys() {
  const vrk = Uint8Array.from(Buffer.from(KEYS.vrk, "hex"));
  return {
    domainKey: await c.deriveDomainKey(vrk, KEYS.domainId),
    manifestKey: await c.deriveManifestKey(vrk),
  };
}
