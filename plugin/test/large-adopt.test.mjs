/**
 * A large local file that IS the incoming version is recorded as it, without
 * a byte uploaded or downloaded (issue #232).
 *
 * A device paired over a vault that already holds the server's files -- a
 * copied vault, a device paired again after Leave -- recognised its notes and
 * published every attachment again under a new file id: a version of more
 * than one chunk carries no whole-file digest, so `adopt` could not prove it,
 * and the same-name rule then retired one of the two ids on every device.
 *
 * The proof now is the version's own chunk list: the push path's chunker and
 * keyed chunk ids, run over the local file, name exactly the record's sids,
 * as many and in the same order, and the file is exactly the version's size.
 * Anything else takes the path it took before. Pinned here against the real
 * pull path over the fake server, and a re-pair against the real engine.
 * Fixtures are deterministic noise or runs of one byte, never a secret.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeHost, FakeServer, FakeTimers, KEYS, STEP_MS, keys, memorySecrets, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { State } = require("../build/state.js");
const { Transport } = require("../build/transport.js");
const { LARGE_APPLY_BYTES, SyncEngine } = require("../build/sync/engine.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { CHUNK_MAX, bytesSource, chunkStream } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const NAME = "Files/recording.bin";
const OTHER = "ffffffffffffffffffffffffffffffff";
const INCOMING = "ff".repeat(16);
const MIB = 1 << 20;

/** Deterministic incompressible-looking bytes: a fixture, never a secret. */
function noise(size, seed = 0x2320232) {
  const data = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    data[i] = x & 0xff;
  }
  return data;
}

/** A run of one byte: no cut point inside it, so the chunker cuts it at `CHUNK_MAX` wherever it stands. */
const run = (byte, size = CHUNK_MAX) => new Uint8Array(size).fill(byte);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

/** The push path's own chunks of `bytes`: what a device that published them posted. */
async function sealed(domainKey, bytes) {
  const chunks = [];
  for await (const plaintext of chunkStream(bytesSource(bytes))) {
    const { cid, sid, ciphertext } = await c.encryptChunk(domainKey, plaintext);
    chunks.push({ sid, cid: c.hex(cid), len: plaintext.length, ciphertext });
  }
  return chunks;
}

/** A version of `bytes` from another device, cut by the real chunker; `chunks` overrides the list it states. */
async function publishLarge(server, k, { fileId = INCOMING, path = NAME, bytes, chunks }) {
  const cut = chunks ?? await sealed(k.domainKey, bytes);
  for (const chunk of cut) if (chunk.ciphertext !== undefined) server.chunks.set(chunk.sid, chunk.ciphertext);
  const listed = cut.map(({ sid, cid, len }) => ({ sid, cid, len }));
  const size = listed.reduce((total, chunk) => total + chunk.len, 0);
  const manifest = { v: 1, path, size, mtime: 4000, domain: KEYS.domainId, chunks: listed, sha256: "", deleted: false };
  return server.publishManifest({ fileId, manifest, sids: listed.map((chunk) => chunk.sid), parents: [], deviceId: OTHER,
    manifestKey: k.manifestKey, bytes: size });
}

/** One device on the rig, every publication it makes counted, every byte its vault reads through a source counted. */
async function receiving(options = {}) {
  const r = await rig(options);
  const pushed = [];
  r.context.publish = async (path) => { pushed.push(path); await pushFile(r.context, path); };
  const read = { bytes: 0, calls: 0 };
  const source = r.host.source.bind(r.host);
  r.host.source = (path, size) => {
    const inner = source(path, size);
    return { size: inner.size, read: async (offset, length) => {
      read.calls++;
      const piece = await inner.read(offset, length);
      read.bytes += piece.length;
      return piece;
    } };
  };
  const readWhole = r.host.read.bind(r.host);
  const whole = [];
  r.host.read = async (path) => { whole.push(path); return readWhole(path); };
  return { r, pushed, read, whole };
}

const chunkTraffic = (server) => server.requests.filter((request) => request.target.startsWith("/v1/chunks"));
const posts = (server) => server.requests.filter((request) => request.method === "POST" && /^\/v1\/files\/[0-9a-f]+\/versions/.test(request.target));
const adoptedLine = (fileId, chunks) =>
  new RegExp(`^pull path_class=file bytes=\\d+ decision=adopted reason=identical_chunks chunks=${chunks} duration_ms=\\d+ file=${fileId} seq=\\d+$`);
const copies = (host) => [...host.files.keys()].filter((path) => path.includes("(conflict from"));

// --- the proof ------------------------------------------------------------

test("a local file of many chunks that is the incoming version is recorded as it: nothing read twice, sent or fetched (#232)", async () => {
  const { r, pushed, read } = await receiving();
  const bytes = noise(3 * CHUNK_MAX + 12345);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  assert.ok(frame.sids.length >= 3, `the fixture must be several chunks: ${frame.sids.length}`);
  r.host.seed(NAME, bytes, 3000);
  r.server.requests.length = 0;

  assert.equal(await applyChange(r.context, frame), "applied");

  const record = r.state.fileByPath(NAME);
  assert.equal(record.fileId, INCOMING, "the local file was not adopted under the version's id");
  assert.equal(record.versionId, frame.version_id);
  assert.equal(record.size, bytes.length);
  assert.equal(record.mtime, 3000, "the record is not the metadata of the bytes that were proved");
  assert.deepEqual(pushed, [], "the file was published as a second file id");
  assert.deepEqual(posts(r.server), [], "a version was posted");
  assert.deepEqual(chunkTraffic(r.server), [], "a chunk was asked about, sent or fetched");
  assert.deepEqual(copies(r.host), []);
  assert.deepEqual(r.host.files.get(NAME).bytes, bytes, "the file was rewritten");
  assert.equal(read.bytes, bytes.length, "the file was not read exactly once");
  assert.equal(r.host.logs.filter((line) => adoptedLine(INCOMING, frame.sids.length).test(line)).length, 1,
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
});

test("a file that differs from the version in one byte of its last chunk is not adopted, and both are kept (#232)", async () => {
  const { r, pushed } = await receiving();
  const bytes = noise(2 * CHUNK_MAX + 777);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  const local = bytes.slice();
  local[local.length - 5] ^= 0x01;
  r.host.seed(NAME, local, 3000);

  // Today's path: this device's file is published first and, its id sorting
  // lower, keeps the name; the version is written beside it.
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.deepEqual(pushed, [NAME]);
  assert.notEqual(r.state.fileByPath(NAME).fileId, INCOMING, "a file that is not the version was recorded as it");
  assert.deepEqual(r.host.files.get(NAME).bytes, local);
  assert.deepEqual(r.host.files.get(copies(r.host)[0]).bytes, bytes);
  assert.equal(r.host.logs.some((line) => line.includes("decision=adopted")), false);
});

test("the version's chunks in another order are not the version (#232)", async () => {
  const { r, pushed } = await receiving();
  const [a, b, tail] = [run(0x41), run(0x42), run(0x43, 3000)];
  const frame = await publishLarge(r.server, r.keys, { bytes: join(a, b, tail) });
  const local = join(b, a, tail);
  // The premise the case needs: the local file cuts into exactly the
  // version's chunks, the first two swapped.
  const mine = (await sealed(r.keys.domainKey, local)).map((chunk) => chunk.sid);
  assert.deepEqual(mine, [frame.sids[1], frame.sids[0], frame.sids[2]]);
  r.host.seed(NAME, local, 3000);

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.deepEqual(pushed, [NAME]);
  assert.notEqual(r.state.fileByPath(NAME).fileId, INCOMING);
  assert.deepEqual(r.host.files.get(NAME).bytes, local);
  assert.equal(r.host.logs.some((line) => line.includes("decision=adopted")), false);
});

test("a file holding the version and more is not the version, even though it starts with every chunk (#232)", async () => {
  const { r, pushed } = await receiving();
  const bytes = noise(2 * CHUNK_MAX + 99);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  const local = join(bytes, new Uint8Array([0x0a]));
  r.host.seed(NAME, local, 3000);

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.deepEqual(pushed, [NAME]);
  assert.notEqual(r.state.fileByPath(NAME).fileId, INCOMING);
  assert.deepEqual(r.host.files.get(NAME).bytes, local);
});

test("a record naming every chunk of the file and one more is not the file (#232)", async () => {
  const { r } = await receiving();
  const [a, b] = [run(0x51), run(0x52)];
  const local = join(a, b);
  const cut = await sealed(r.keys.domainKey, local);
  assert.equal(cut.length, 2);
  // A record whose stated lengths still add up to the file's size and obey
  // the chunker's bounds, so binding passes it: the second chunk's length is
  // understated by one byte and a one-byte third chunk makes up the sum.
  const [extra] = await sealed(r.keys.domainKey, new Uint8Array([0x0a]));
  const frame = await publishLarge(r.server, r.keys, {
    chunks: [cut[0], { ...cut[1], len: cut[1].len - 1 }, extra],
  });
  assert.equal(frame.bytes, local.length);
  r.host.seed(NAME, local, 3000);

  await applyChange(r.context, frame).catch(() => undefined);

  assert.notEqual(r.state.fileByPath(NAME)?.fileId, INCOMING, "a file two chunks long was recorded as a version of three");
  assert.deepEqual(r.host.files.get(NAME).bytes, local);
  assert.equal(r.host.logs.some((line) => line.includes("decision=adopted")), false);
});

test("a file replaced while it is proved is not recorded as the version (#232)", async () => {
  const { r } = await receiving();
  const bytes = noise(2 * CHUNK_MAX + 31);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  r.host.seed(NAME, bytes, 3000);
  const EDIT = noise(bytes.length, 0x5eed);
  const source = r.host.source.bind(r.host);
  let replaced = false;
  r.host.source = (path, size) => {
    const inner = source(path, size);
    return { size: inner.size, read: async (offset, length) => {
      const piece = await inner.read(offset, length);
      // The user's save lands after the last byte the proof reads, and before
      // anything is recorded about them.
      if (path === NAME && offset + piece.length === size && !replaced) {
        replaced = true;
        r.host.seed(NAME, EDIT, 9999);
      }
      return piece;
    } };
  };

  await applyChange(r.context, frame);

  assert.ok(replaced, "the fixture never replaced the file");
  assert.notEqual(r.state.fileByPath(NAME)?.fileId, INCOMING, "the replacement was recorded as a version it is not");
  assert.deepEqual(r.host.files.get(NAME).bytes, EDIT, "the replacement was lost");
});

test("a stop lands at the next chunk of the proof: nothing is recorded and nothing is published (#232)", async () => {
  const { r, pushed } = await receiving();
  const bytes = noise(3 * CHUNK_MAX + 5);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  r.host.seed(NAME, bytes, 3000);
  const stop = new AbortController();
  r.context.signal = stop.signal;
  const source = r.host.source.bind(r.host);
  r.host.source = (path, size) => {
    const inner = source(path, size);
    return { size: inner.size, read: async (offset, length) => {
      stop.abort();
      return inner.read(offset, length);
    } };
  };

  await assert.rejects(applyChange(r.context, frame), (error) => error.code === "cancelled");

  assert.equal(r.state.fileByPath(NAME), undefined, "a stopped proof recorded the file");
  assert.deepEqual(pushed, []);
  assert.deepEqual(copies(r.host), []);
  assert.deepEqual(r.host.files.get(NAME).bytes, bytes);
});

// --- a phone ----------------------------------------------------------------

test("a phone proves a file of many chunks inside its per-file ceiling, reading it once (#232)", async () => {
  const { r, pushed, read } = await receiving({ isMobile: true, policy: { perFileMaxBytes: 64 * MIB, totalBudgetBytes: 0 } });
  const bytes = noise(2 * CHUNK_MAX + 4321);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  r.host.seed(NAME, bytes, 3000);

  assert.equal(await applyChange(r.context, frame), "applied");

  assert.equal(r.state.fileByPath(NAME).fileId, INCOMING);
  assert.deepEqual(pushed, []);
  assert.ok(r.host.logs.some((line) => adoptedLine(INCOMING, frame.sids.length).test(line)));
  assert.equal(read.bytes, bytes.length, "the file was not read exactly once");
});

test("a phone never reads a file above its per-file ceiling to prove it: the version stays remote-only, as before (#232)", async () => {
  const { r, pushed, read, whole } = await receiving({ isMobile: true, policy: { perFileMaxBytes: 12 * MIB, totalBudgetBytes: 0 } });
  const bytes = noise(2 * CHUNK_MAX + 4321);
  assert.ok(bytes.length > 12 * MIB);
  const frame = await publishLarge(r.server, r.keys, { bytes });
  r.host.seed(NAME, bytes, 3000);

  assert.equal(await applyChange(r.context, frame), "remote_only");

  assert.deepEqual(whole, [], "the file was read whole on a phone above its ceiling");
  assert.equal(read.bytes, 0);
  assert.equal(r.state.fileByPath(NAME), undefined);
  assert.deepEqual(pushed, []);
  assert.equal(r.host.logs.some((line) => line.includes("decision=adopted")), false);
  assert.ok(r.host.logs.some((line) => line.startsWith(`pull path_class=file bytes=${bytes.length} decision=remote_only reason=per_file `)));
});

// --- a device paired again over the vault it holds --------------------------

/** A data file in memory, empty: a device that left, or a copied vault. */
function memoryStore() {
  let stored = null;
  return { secrets: memorySecrets(), loadData: async () => stored, saveData: async (value) => { stored = JSON.parse(JSON.stringify(value)); } };
}

/** One paired device with an empty state over `host`, on its own virtual clock. */
async function paired(server, host) {
  const store = memoryStore();
  const state = await State.open(store, false, store.secrets);
  Object.assign(state.data, { vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid" });
  await state.save();
  const timers = new FakeTimers();
  const transport = new Transport({
    request: (request) => server.request(request),
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: c.unhex(KEYS.deviceSecret) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  return { state, host, timers, engine: new SyncEngine({ state, transport, host, timers, now: () => timers.now }) };
}

test("a device paired again over a vault holding the server's large files posts nothing and fetches nothing for them (#232)", async () => {
  const server = new FakeServer();
  const k = await keys();
  await server.seedDomainMap(k.map, KEYS.domainId);
  const files = [
    // Applied in the feed's own turn.
    { fileId: "a1".repeat(16), path: "Files/scan.pdf", bytes: noise(2 * CHUNK_MAX + 1000, 0xa1) },
    // Large enough that the feed hands its download to the background lane.
    { fileId: "b1".repeat(16), path: "Files/recording.m4a", bytes: noise(LARGE_APPLY_BYTES + MIB, 0xb1) },
  ];
  const frames = [];
  for (const file of files) frames.push(await publishLarge(server, k, file));
  await server.publish({ fileId: "c1".repeat(16), path: "Notes/n.md", bytes: new TextEncoder().encode("NOTE SENTINEL\n"),
    mtime: 1757100000000, domainKey: k.domainKey, manifestKey: k.manifestKey });
  const host = new FakeHost();
  for (const file of files) host.seed(file.path, file.bytes, 1757000000000);
  host.seed("Notes/n.md", "NOTE SENTINEL\n", 1757000000000);
  server.requests.length = 0;

  const d = await paired(server, host);
  await d.engine.start();
  await d.timers.run(STEP_MS, () => d.state.data.lastSeq >= server.seq && files.every((file) => d.state.fileByPath(file.path) !== undefined));
  await d.timers.run(STEP_MS);

  for (const [i, file] of files.entries()) {
    assert.equal(d.state.fileByPath(file.path).fileId, file.fileId, `${file.path} was not adopted under its own id`);
    assert.ok(host.logs.some((line) => adoptedLine(file.fileId, frames[i].sids.length).test(line)), host.logs.join(" | "));
    assert.deepEqual(host.files.get(file.path).bytes, file.bytes);
  }
  // Its folder records are its own to publish; a version with content, or a
  // retirement, is not.
  const mine = server.journal.filter((frame) => frame.device_id === KEYS.deviceId && (frame.sids.length > 0 || frame.deleted));
  assert.deepEqual(mine.map((frame) => frame.file_id), [], "this device posted a version or retired an id");
  const theirs = new Set(frames.flatMap((frame) => frame.sids));
  const moved = server.requests.filter((request) => request.target.startsWith("/v1/chunks") &&
    (request.method === "PUT" || theirs.has(request.target.slice("/v1/chunks/".length)) ||
      (request.json !== null && JSON.parse(request.json).sids?.some((sid) => theirs.has(sid)))));
  assert.deepEqual(moved.map((request) => `${request.method} ${request.target}`), [], "a chunk of the large files was sent or fetched");
  assert.equal(host.logs.some((line) => line.startsWith("feed decision=backgrounded")), false, host.logs.join(" | "));
  assert.ok(host.logs.some((line) => /^reconcile decision=released reason=caught_up held=3 settled=3 queued=0 /.test(line)), host.logs.join(" | "));
  d.engine.stop();
  server.releaseFeed();
  await d.engine.stopAndWait();
});
