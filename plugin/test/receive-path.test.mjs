/**
 * The receive path at the scale of a first sync and an idle vault (issues
 * #194, #198).
 *
 * A device joining a vault of ten thousand notes rewrote its whole data file
 * once per note and fetched each note with its own round trip; a copied
 * vault published every note it already held under a new id; and an idle
 * vault asked the server about every file, twice a second, for good. Pinned
 * here, each against the real engine and transport over the fake server:
 *
 * - a page's one-chunk notes are recorded in memory and saved once, with the
 *   page, or by a short timer, or at a stop -- and a crash inside the page
 *   loses nothing and duplicates nothing, because the next start holds the
 *   unrecorded names back until the feed adopts them by digest;
 * - those notes' chunks come many to a request, inside the route's caps and a
 *   phone's smaller memory budget, and every proof still runs per note;
 * - a copied vault publishes nothing the server already holds;
 * - the repair walk asks about remembered sids 4,096 at a time, reads back
 *   only what is missing, and rests for hours between walks;
 * - desktop walks its tree every five minutes and when the window comes back,
 *   and the nested-vault answer is kept per folder for one pass.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FakeHost, FakeServer, FakeTimers, KEYS, STEP_MS, keys, memorySecrets, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { State, parseData } = require("../build/state.js");
const { Transport } = require("../build/transport.js");
const { HOLD_MS, SAVE_COALESCE_MS, SCAN_MS, SyncEngine, WALK_MS } = require("../build/sync/engine.js");
const { PREFETCH_BYTES_MOBILE, PREFETCH_SIDS, applyChange } = require("../build/sync/pull.js");
const { pushFile, sidDigest } = require("../build/sync/push.js");
const { ChunkRepair, REPAIR_EXISTS_SIDS, REPAIR_WALK_MS } = require("../build/sync/repair.js");
const { CHUNK_MAX } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const OTHER = "ffffffffffffffffffffffffffffffff";
const fileIdOf = (i) => (0x10000000 + i).toString(16).padStart(32, "0");
const pathOf = (i) => `Notes/n${String(i).padStart(5, "0")}.md`;
const textOf = (i) => `NOTE SENTINEL ${i}\n`;

/** A data file in memory that keeps every write, so a test can count them and read any of them back. */
function memoryStore() {
  let stored = null;
  const writes = [];
  return {
    writes,
    secrets: memorySecrets(),
    loadData: async () => stored,
    saveData: async (value) => {
      stored = JSON.parse(JSON.stringify(value));
      writes.push(stored);
    },
  };
}

async function vaultServer() {
  const server = new FakeServer();
  const k = await keys();
  await server.seedDomainMap(k.map, KEYS.domainId);
  return { server, k };
}

/** Notes `from` to `to` (exclusive), each one chunk, published by another device. */
async function publishNotes(server, k, from, to) {
  for (let i = from; i < to; i++) {
    await server.publish({ fileId: fileIdOf(i), path: pathOf(i), bytes: enc(textOf(i)), mtime: 1757100000000 + i,
      domainKey: k.domainKey, manifestKey: k.manifestKey });
  }
}

/** A note of two chunks, which carries no whole-file digest (#181). */
async function publishTwoChunks(server, k, fileId, path, bytes) {
  const parts = [bytes.subarray(0, CHUNK_MAX), bytes.subarray(CHUNK_MAX)];
  const chunks = [];
  for (const part of parts) {
    const sealed = await c.encryptChunk(k.domainKey, part);
    server.chunks.set(sealed.sid, sealed.ciphertext);
    chunks.push({ sid: sealed.sid, cid: c.hex(sealed.cid), len: part.length });
  }
  const manifest = { v: 1, path, size: bytes.length, mtime: 1757100000000, domain: KEYS.domainId, chunks, sha256: "", deleted: false };
  return server.publishManifest({ fileId, manifest, sids: chunks.map((chunk) => chunk.sid), parents: [], deviceId: OTHER,
    manifestKey: k.manifestKey, bytes: bytes.length });
}

/** One receiving device over `store`: paired, its engine on its own virtual clock. */
async function device(server, { isMobile = false, host = new FakeHost({ isMobile }), store = memoryStore() } = {}) {
  const state = await State.open(store, isMobile, store.secrets);
  if (state.data.deviceId === null) {
    Object.assign(state.data, { vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid" });
    await state.save();
  }
  store.writes.length = 0;
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
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport, host, timers, now: () => timers.now });
  return { state, host, transport, timers, engine, store };
}

const stopped = async (d, server) => {
  d.engine.stop();
  server.releaseFeed();
  await d.engine.stopAndWait();
};

const chunkRequests = (server) => server.requests.filter((request) => request.target.startsWith("/v1/chunks/"));
const batches = (server) => chunkRequests(server).filter((request) => request.target === "/v1/chunks/get")
  .map((request) => JSON.parse(request.json).sids);
const recorded = (write) => new Set(Object.keys(write.files ?? {}));

/** Hold the vault's writer for `path` until `release()`. */
function gate(host, path) {
  const writer = host.writer.bind(host);
  const held = { entered: false, release: () => undefined, restore: () => { host.writer = writer; } };
  const opened = new Promise((resolve) => { held.release = resolve; });
  host.writer = async (asked) => {
    if (asked === path) {
      held.entered = true;
      await opened;
    }
    return writer(asked);
  };
  return held;
}

// --- A and B: one save per page, many notes to a request ----------------

test("a first sync saves a page of one-chunk notes once and fetches them 64 to a request (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 150);
  const d = await device(server);
  await d.engine.start();
  // No virtual time passes, so no timer can save: what is written is what a page writes.
  await d.timers.run(0, () => d.store.writes.some((write) => write.lastSeq >= server.seq) && d.state.fileByPath(pathOf(149)) !== undefined);

  for (let i = 0; i < 150; i++) {
    assert.equal(d.host.text(pathOf(i)), textOf(i));
    assert.equal(d.state.fileByPath(pathOf(i)).fileId, fileIdOf(i));
  }
  const saved = d.store.writes.filter((write) => recorded(write).size > 0);
  assert.equal(saved.length, 1, `one save for the page, not one per note: ${saved.map((write) => recorded(write).size)}`);
  assert.equal(recorded(saved[0]).size, 150);
  assert.deepEqual(batches(server).map((sids) => sids.length), [PREFETCH_SIDS, PREFETCH_SIDS, 150 - 2 * PREFETCH_SIDS]);
  assert.equal(chunkRequests(server).filter((request) => request.method === "GET").length, 0, "no note fetched alone");
  assert.equal(d.host.logs.filter((line) => /^pull decision=prefetched sids=\d+ bytes=\d+ budget_sids=64 budget_bytes=\d+ duration_ms=\d+$/.test(line)).length, 3);
  await stopped(d, server);
});

test("a note of many chunks, a move and a tombstone are saved as they land; a created note waits for its page (#194, #181)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 1);
  const big = new Uint8Array(CHUNK_MAX + 40).fill(66);
  await publishTwoChunks(server, k, fileIdOf(1), "Files/big.bin", big);
  await publishNotes(server, k, 2, 3);
  const d = await device(server);
  await d.engine.start();
  await d.timers.run(0, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath(pathOf(2)) !== undefined);

  assert.deepEqual(d.host.files.get("Files/big.bin").bytes, big);
  // The two-chunk note was written to the data file on its own, before the
  // note after it existed there; the first note went with it, from memory.
  assert.ok(d.store.writes.some((write) => recorded(write).has("Files/big.bin") && !recorded(write).has(pathOf(2))),
    d.store.writes.map((write) => [...recorded(write)].join(",")).join(" | "));
  assert.equal(d.store.writes.some((write) => recorded(write).has(pathOf(0)) && !recorded(write).has("Files/big.bin")), false,
    "a created one-chunk note was saved on its own");

  // One page from the other device: a rename, an edit, a deletion and a new
  // note. Each of the first three is saved before the page's cursor passes
  // it -- as it lands; the new note only with the page.
  await d.timers.run(0, () => server.feedWaiters.length > 0);
  const release = server.releaseFeed;
  server.releaseFeed = () => undefined;
  const renamed = await server.publish({ fileId: fileIdOf(0), path: "Notes/renamed.md", bytes: enc(textOf(0)), mtime: 1757100000000,
    parents: [d.state.fileByPath(pathOf(0)).versionId], domainKey: k.domainKey, manifestKey: k.manifestKey });
  const edited = await server.publish({ fileId: fileIdOf(2), path: pathOf(2), bytes: enc("an edit from elsewhere\n"), mtime: 1757100009000,
    parents: [d.state.fileByPath(pathOf(2)).versionId], domainKey: k.domainKey, manifestKey: k.manifestKey });
  const tomb = await server.publishTombstone({ fileId: fileIdOf(1), path: "Files/big.bin", manifestKey: k.manifestKey,
    parents: [d.state.fileByPath("Files/big.bin").versionId] });
  await publishNotes(server, k, 3, 4);
  server.releaseFeed = release;
  server.releaseFeed();
  await d.timers.run(0, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath(pathOf(3)) !== undefined);
  await d.timers.run(0, () => d.store.writes.some((write) => write.lastSeq >= server.seq));
  assert.equal(d.host.text("Notes/renamed.md"), textOf(0));
  assert.equal(d.host.text(pathOf(2)), "an edit from elsewhere\n");
  assert.equal(d.host.files.has("Files/big.bin"), false);
  const early = (seq, holds) => d.store.writes.some((write) => write.lastSeq < seq && holds(write));
  assert.ok(early(renamed.seq, (write) => recorded(write).has("Notes/renamed.md")), "the rename waited for the page");
  assert.ok(early(edited.seq, (write) => write.files[pathOf(2)]?.versionId === edited.version_id), "the edit waited for the page");
  assert.ok(early(tomb.seq, (write) => write.lastSeq >= edited.seq && !recorded(write).has("Files/big.bin")), "the deletion waited for the page");
  assert.equal(early(server.seq, (write) => recorded(write).has(pathOf(3))), false, "the new note was saved on its own");
  await stopped(d, server);
});

test("records held in memory are saved by the timer while a page still runs, and by a stop (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 30);
  const d = await device(server);
  const held = gate(d.host, pathOf(20));
  await d.engine.start();
  await d.timers.run(0, () => held.entered);
  assert.equal(d.store.writes.some((write) => recorded(write).size > 0), false, "nothing saved before the timer");

  const before = d.store.writes.length;
  await d.timers.run(SAVE_COALESCE_MS, () => d.store.writes.length > before);
  const timed = d.store.writes.at(-1);
  for (let i = 0; i < 20; i++) assert.ok(recorded(timed).has(pathOf(i)), pathOf(i));
  assert.equal(recorded(timed).has(pathOf(20)), false);
  assert.ok(d.host.logs.some((line) => /^state decision=saved reason=coalesced records=20 budget_ms=1500 duration_ms=\d+$/.test(line)),
    d.host.logs.join(" | "));
  held.release();
  await d.timers.run(0, () => d.state.fileByPath(pathOf(29)) !== undefined && d.state.data.lastSeq >= server.seq);
  await stopped(d, server);

  // The same page, stopped with its records in memory: the stop writes them.
  const again = await vaultServer();
  await publishNotes(again.server, again.k, 0, 30);
  const e = await device(again.server);
  const stuck = gate(e.host, pathOf(20));
  await e.engine.start();
  await e.timers.run(0, () => stuck.entered);
  const count = e.store.writes.length;
  e.engine.stop();
  await e.timers.run(0, () => e.store.writes.length > count);
  for (let i = 0; i < 20; i++) assert.ok(recorded(e.store.writes.at(-1)).has(pathOf(i)), pathOf(i));
  assert.ok(e.host.logs.some((line) => /^state decision=saved reason=stop records=20 /.test(line)), e.host.logs.join(" | "));
  stuck.release();
  again.server.releaseFeed();
  await e.engine.stopAndWait();
});

test("a crash inside a page loses no note and mints no id: the next start adopts what it wrote (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 5);
  const pageOne = server.seq;
  const store = memoryStore();
  const host = new FakeHost();
  const first = await device(server, { host, store });
  await first.engine.start();
  await first.timers.run(0, () => first.state.data.lastSeq >= server.seq && first.state.fileByPath(pathOf(4)) !== undefined);
  await first.timers.run(0, () => store.writes.some((write) => write.lastSeq === pageOne));

  // The next page dies at its eighth note: seven written, none of them saved.
  // Published as one page: the device waits in its long poll meanwhile.
  await first.timers.run(0, () => server.feedWaiters.length > 0);
  const release = server.releaseFeed;
  server.releaseFeed = () => undefined;
  await publishNotes(server, k, 5, 20);
  server.releaseFeed = release;
  const held = gate(host, pathOf(12));
  server.releaseFeed();
  await first.timers.run(0, () => held.entered);
  const last = store.writes.at(-1);
  assert.equal(last.lastSeq, pageOne);
  for (let i = 5; i < 12; i++) {
    assert.equal(host.text(pathOf(i)), textOf(i), "written before the crash");
    assert.equal(recorded(last).has(pathOf(i)), false, "and not saved");
  }
  held.restore();

  const second = await device(server, { host, store });
  assert.equal(second.state.data.lastSeq, pageOne, "the page replays from the saved cursor");
  await second.engine.start();
  await second.timers.run(STEP_MS, () => second.state.data.lastSeq >= server.seq &&
    [...Array(20).keys()].every((i) => second.state.fileByPath(pathOf(i)) !== undefined));
  await second.timers.run(STEP_MS);

  for (let i = 0; i < 20; i++) {
    assert.equal(host.text(pathOf(i)), textOf(i), `note ${i}`);
    assert.equal(second.state.fileByPath(pathOf(i)).fileId, fileIdOf(i), `note ${i} kept its id`);
  }
  assert.deepEqual((await server.noteFiles(k.manifestKey)).sort(), [...Array(20).keys()].map(fileIdOf).sort(), "no id was minted");
  assert.equal(host.logs.filter((line) => /^pull path_class=file bytes=\d+ decision=adopted reason=identical_bytes /.test(line)).length, 7);
  assert.ok(host.logs.some((line) => /^reconcile decision=holding reason=feed_names held=7 budget_ms=600000$/.test(line)), host.logs.join(" | "));
  first.engine.stop();
  held.release();
  await stopped(second, server);
});

test("a phone's prefetch holds at most its budget, and every request stays inside the route's caps (#194)", async () => {
  const { server, k } = await vaultServer();
  const size = 1 << 20;
  for (let i = 0; i < 20; i++) {
    await server.publish({ fileId: fileIdOf(i), path: pathOf(i), bytes: new Uint8Array(size).fill(i + 1), mtime: 1757100000000,
      domainKey: k.domainKey, manifestKey: k.manifestKey });
  }
  const d = await device(server, { isMobile: true });
  await d.engine.start();
  await d.timers.run(0, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath(pathOf(19)) !== undefined);
  const asked = batches(server);
  assert.ok(asked.length >= 3, `the budget split the page: ${asked.map((sids) => sids.length)}`);
  for (const sids of asked) {
    assert.ok(sids.length <= PREFETCH_SIDS);
    const bytes = sids.reduce((total, sid) => total + server.chunks.get(sid).length, 0);
    assert.ok(bytes <= PREFETCH_BYTES_MOBILE, `${bytes} bytes asked at once on a phone`);
  }
  for (let i = 0; i < 20; i++) assert.equal(d.host.files.get(pathOf(i)).bytes[size - 1], i + 1);
  await stopped(d, server);
});

test("a prefetch answer larger than its budget is refused and never kept, whatever the records declare (#194)", async () => {
  const { server, k } = await vaultServer();
  // Records that understate their size: each declares 100 bytes and names a 1 MiB chunk.
  for (let i = 0; i < 20; i++) {
    const body = new Uint8Array(1 << 20).fill(i + 1);
    const sid = c.hex(await c.sha256(body));
    server.chunks.set(sid, body);
    const manifest = { v: 1, path: pathOf(i), size: 100, mtime: 1757100000000, domain: KEYS.domainId,
      chunks: [{ sid, cid: "00".repeat(32), len: 100 }], sha256: "00".repeat(32), deleted: false };
    await server.publishManifest({ fileId: fileIdOf(i), manifest, sids: [sid], parents: [], deviceId: OTHER, manifestKey: k.manifestKey, bytes: 100 });
  }
  const d = await device(server, { isMobile: true });
  await d.engine.start();
  await d.timers.run(STEP_MS, () => d.host.logs.some((line) => line.startsWith("pull decision=prefetch_refused")));
  assert.ok(d.host.logs.some((line) => /^pull decision=prefetch_refused reason=response_too_large sids=20 bytes=2320 budget_bytes=8388608 duration_ms=\d+$/.test(line)),
    d.host.logs.join(" | "));
  assert.equal(d.host.logs.some((line) => line.startsWith("pull decision=prefetched")), false, "an answer over the budget was kept");
  for (let i = 0; i < 20; i++) assert.equal(d.host.text(pathOf(i)), null);
  await stopped(d, server);
});

test("a refused prefetch falls back to one GET per note, once per page, and every note still arrives (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 40);
  const request = server.request;
  let refused = 0;
  // Something in front of the server that will not pass a batched answer.
  server.request = async (asked) => {
    if (!asked.url.endsWith("/v1/chunks/get")) return request(asked);
    refused++;
    return server.error(413, "batch_too_large");
  };
  const d = await device(server);
  await d.engine.start();
  await d.timers.run(0, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath(pathOf(39)) !== undefined);
  for (let i = 0; i < 40; i++) assert.equal(d.host.text(pathOf(i)), textOf(i));
  assert.equal(refused, 1, "asked once, not per note");
  assert.equal(chunkRequests(server).filter((asked) => asked.method === "GET").length, 40);
  assert.ok(d.host.logs.some((line) => /^pull decision=prefetch_refused reason=batch_too_large sids=40 bytes=\d+ budget_bytes=\d+ duration_ms=\d+$/.test(line)),
    d.host.logs.join(" | "));
  await stopped(d, server);
});

test("a prefetched chunk that does not decrypt is never written, and the note lands once the server holds it again (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 10);
  const sid = server.journal.find((frame) => frame.file_id === fileIdOf(6)).sids[0];
  const good = server.chunks.get(sid);
  const bad = Uint8Array.from(good);
  bad[0] ^= 1;
  server.chunks.set(sid, bad);
  const d = await device(server);
  await d.engine.start();
  await d.timers.run(STEP_MS, () => d.state.fileByPath(pathOf(5)) !== undefined && d.host.logs.some((line) => line.startsWith("feed decision=retry")));
  assert.equal(d.host.text(pathOf(6)), null, "unverified bytes reached the vault");
  assert.equal(d.state.fileByPath(pathOf(6)), undefined);
  server.chunks.set(sid, good);
  await d.timers.run(STEP_MS, () => d.state.fileByPath(pathOf(9)) !== undefined);
  for (let i = 0; i < 10; i++) assert.equal(d.host.text(pathOf(i)), textOf(i));
  await stopped(d, server);
});

test("the last chunk of a file of many chunks is never taken from the page's prefetch, even when a note of the page shares it (#194, #196)", async () => {
  const { server, k } = await vaultServer();
  // Four chunks, fetched three and one: the last is byte for byte the note
  // published after it, so the two share a sid.
  const shared = enc(textOf(9));
  const parts = [0, 1, 2].map((i) => new Uint8Array(3 << 20).fill(70 + i));
  const chunks = [];
  for (const part of [...parts, shared]) {
    const sealed = await c.encryptChunk(k.domainKey, part);
    server.chunks.set(sealed.sid, sealed.ciphertext);
    chunks.push({ sid: sealed.sid, cid: c.hex(sealed.cid), len: part.length });
  }
  const size = chunks.reduce((total, chunk) => total + chunk.len, 0);
  const manifest = { v: 1, path: "Files/many.bin", size, mtime: 1757100000000, domain: KEYS.domainId, chunks, sha256: "", deleted: false };
  await server.publishManifest({ fileId: "a1".repeat(16), manifest, sids: chunks.map((chunk) => chunk.sid), parents: [], deviceId: OTHER,
    manifestKey: k.manifestKey, bytes: size });
  await publishNotes(server, k, 0, 10);
  const d = await device(server);
  await d.engine.start();
  await d.timers.run(0, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath(pathOf(9)) !== undefined);
  assert.equal(d.host.files.get("Files/many.bin").bytes.length, size);
  for (let i = 0; i < 10; i++) assert.equal(d.host.text(pathOf(i)), textOf(i));
  // One GET, the file's own last chunk; the page's notes came in one batch.
  const gets = chunkRequests(server).filter((request) => request.method === "GET");
  assert.deepEqual(gets.map((request) => request.target), [`/v1/chunks/${chunks[3].sid}`]);
  assert.deepEqual(batches(server).map((sids) => sids.length), [3, 10]);
  await stopped(d, server);
});

// --- C: indexes -----------------------------------------------------------

test("the state's indexes equal a rebuild after any sequence of writes (#194)", async () => {
  const { state } = await (async () => ({ state: await State.open(memoryStore(), false, memorySecrets()) }))();
  let seed = 7;
  // The high bits: a power-of-two LCG's low bits repeat every few draws, and
  // `seed % 8` alone walked the same eight paths in the same order.
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
  const paths = ["a.md", "b.md", "Notes/c.md", "Notes/d.md", "5", "12", "e.md", "Notes/f.md"];
  const ids = ["11".repeat(16), "22".repeat(16), "33".repeat(16), "44".repeat(16)];
  const check = (step) => {
    const files = state.data.files;
    const entries = Object.entries(files);
    assert.equal(state.localBytes(), entries.reduce((total, [, record]) => total + record.size, 0), `bytes at step ${step}`);
    assert.deepEqual(state.besideNames(), entries.filter(([, record]) => record.name !== undefined).map(([path]) => path), `names at step ${step}`);
    for (const id of [...ids, "55".repeat(16)]) {
      const found = state.pathByFileId(id);
      const holders = entries.filter(([, record]) => record.fileId === id).map(([path]) => path);
      if (holders.length === 0) assert.equal(found, undefined, `id ${id} at step ${step}`);
      else assert.ok(holders.includes(found), `id ${id} at step ${step}: ${found} not in ${holders}`);
    }
  };
  for (let step = 0; step < 2000; step++) {
    const path = paths[random(paths.length)];
    const choice = random(10);
    if (choice < 5) {
      const record = { fileId: ids[random(ids.length)], versionId: "", mtime: step, size: random(1000), sha256: "" };
      if (random(3) === 0) record.name = paths[random(paths.length)];
      state.setFile(path, record);
    } else if (choice < 8) {
      state.forgetPath(path);
    } else if (choice < 9) {
      // A move, as the pull path makes one: the same record at a new name, then the old forgotten.
      const record = state.fileByPath(path);
      const to = paths[random(paths.length)];
      if (record !== undefined && to !== path) { state.setFile(to, record); state.forgetPath(path); }
    } else if (random(20) === 0) {
      state.forgetPairing();
    }
    check(step);
  }
  // A record changed without its writer -- only a fixture can -- never
  // answers for the id it no longer holds.
  const lone = "66".repeat(16);
  state.setFile("x.md", { fileId: lone, versionId: "", mtime: 0, size: 1, sha256: "" });
  state.data.files["x.md"] = { ...state.data.files["x.md"], fileId: ids[1] };
  assert.equal(state.pathByFileId(lone), undefined);
});

// --- D: a copied vault --------------------------------------------------

test("a copied vault publishes none of the notes the server holds, adopts an older copy, and pushes its own (#194)", async () => {
  const { server, k } = await vaultServer();
  // A note the copy lacks, first in the feed: its download is the one whose
  // prefetch would reach for the copied notes after it.
  await server.publish({ fileId: "f1".repeat(16), path: "Notes/fresh.md", bytes: enc("FRESH SENTINEL\n"), mtime: 1757100000000,
    domainKey: k.domainKey, manifestKey: k.manifestKey });
  await publishNotes(server, k, 0, 200);
  const edited = await server.publish({ fileId: "e1".repeat(16), path: "Notes/edited.md", bytes: enc("first words\n"), mtime: 1757100000000,
    domainKey: k.domainKey, manifestKey: k.manifestKey });
  await server.publish({ fileId: "e1".repeat(16), path: "Notes/edited.md", bytes: enc("first words, then more\n"), mtime: 1757100001000,
    parents: [edited.version_id], domainKey: k.domainKey, manifestKey: k.manifestKey });
  const big = new Uint8Array(CHUNK_MAX + 40).fill(67);
  await publishTwoChunks(server, k, "b1".repeat(16), "Files/big.bin", big);
  const host = new FakeHost();
  for (let i = 0; i < 200; i++) host.seed(pathOf(i), textOf(i), 1757000000000);
  host.seed("Notes/edited.md", "first words\n", 1757000000000);
  host.seed("Notes/local-only.md", "LOCAL ONLY SENTINEL\n", 1757000000000);
  host.seed("Files/big.bin", big, 1757000000000);
  const d = await device(server, { host });
  await d.engine.start();
  await d.timers.run(STEP_MS, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath("Notes/local-only.md")?.versionId > "" &&
    d.state.fileByPath("Files/big.bin") !== undefined);
  await d.timers.run(STEP_MS);

  const published = [];
  for (const frame of server.journal.filter((entry) => entry.device_id === KEYS.deviceId)) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(k.manifestKey, frame.file_id, binder, c.unhex(frame.manifest_nonce), c.unbase64(frame.manifest_ct)));
    if (manifest.v === 1) published.push(manifest.path);
  }
  assert.equal(published.filter((path) => path.startsWith("Notes/n")).length, 0, `the copied notes were published again: ${published}`);
  assert.equal(published.includes("Notes/edited.md"), false, "an older copy was published over the newer version");
  assert.ok(published.includes("Notes/local-only.md"), "this device's own note never went out");
  for (let i = 0; i < 200; i++) assert.equal(d.state.fileByPath(pathOf(i)).fileId, fileIdOf(i));
  assert.equal(d.host.text("Notes/edited.md"), "first words, then more\n");
  assert.equal(d.host.text("Notes/fresh.md"), "FRESH SENTINEL\n");
  // Many chunks carry no digest: adopted by its chunks, never by what the vault says about the file (#232).
  assert.equal(d.host.logs.some((line) => line.includes(`decision=adopted reason=identical_bytes file=${"b1".repeat(16)}`)), false);
  assert.ok(d.host.logs.some((line) => /^pull path_class=file bytes=\d+ decision=adopted reason=identical_chunks chunks=2 duration_ms=\d+ file=(b1){16} /.test(line)),
    d.host.logs.join(" | "));
  assert.equal(published.includes("Files/big.bin"), false, "the copied attachment was published again");
  assert.deepEqual(d.host.files.get("Files/big.bin").bytes, big);
  assert.ok(d.host.logs.some((line) => /^reconcile decision=holding reason=feed_names held=202 budget_ms=600000$/.test(line)), d.host.logs.join(" | "));
  // Nothing was downloaded for a note adopted by its digest.
  const copied = new Set(server.journal.filter((frame) => frame.file_id <= fileIdOf(199)).flatMap((frame) => frame.sids));
  const fetched = [...batches(server).flat(), ...chunkRequests(server).filter((request) => request.method === "GET").map((request) => request.target.slice("/v1/chunks/".length))];
  assert.deepEqual(fetched.filter((sid) => copied.has(sid)), [], "a copied note was downloaded");
  assert.ok(d.host.logs.some((line) => /^reconcile decision=released reason=caught_up held=202 settled=202 queued=0 all=0 /.test(line)), d.host.logs.join(" | "));
  await stopped(d, server);
});

test("a note held for a feed that never catches up goes out when the hold's limit ends, and says so (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 1);
  const host = new FakeHost();
  host.seed(pathOf(0), "the copy here differs\n", 1757000000000);
  const request = server.request;
  let reads = 0;
  // The walk at start reads the feed to its end, two pages; every read after it fails.
  server.request = async (asked) => (asked.url.includes("/v1/changes?") && ++reads > 2 ? server.error(500, "internal") : request(asked));
  const d = await device(server, { host });
  await d.engine.start();
  await d.timers.run(STEP_MS, () => host.logs.some((line) => line.startsWith("reconcile decision=holding")));
  const posted = () => server.journal.filter((entry) => entry.device_id === KEYS.deviceId && entry.sids.length > 0).length;
  await d.timers.run(60_000, () => d.timers.now >= HOLD_MS - 60_000);
  assert.equal(posted(), 0, "published before the limit");
  await d.timers.run(60_000, () => posted() > 0);
  assert.ok(host.logs.some((line) => /^reconcile decision=released reason=timeout held=1 settled=0 queued=1 all=0 budget_ms=600000 duration_ms=\d+$/.test(line)),
    host.logs.join(" | "));
  await stopped(d, server);
});

test("an empty state that cannot read the feed at start holds every note until it can (#194)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 20);
  const host = new FakeHost();
  for (let i = 0; i < 20; i++) host.seed(pathOf(i), textOf(i), 1757000000000);
  const request = server.request;
  let reads = 0;
  server.request = async (asked) => (asked.url.includes("/v1/changes?") && ++reads <= 2 ? server.error(503, "busy") : request(asked));
  const d = await device(server, { host });
  await d.engine.start();
  await d.timers.run(STEP_MS, () => d.state.data.lastSeq >= server.seq && d.state.fileByPath(pathOf(19)) !== undefined);
  await d.timers.run(STEP_MS);
  assert.ok(host.logs.some((line) => /^reconcile decision=holding reason=feed_unread held=20 budget_ms=600000$/.test(line)), host.logs.join(" | "));
  assert.equal(server.journal.filter((entry) => entry.device_id === KEYS.deviceId && entry.sids.length > 0).length, 0);
  for (let i = 0; i < 20; i++) assert.equal(d.state.fileByPath(pathOf(i)).fileId, fileIdOf(i));
  await stopped(d, server);
});

// --- E: the repair walk -----------------------------------------------------

/** Notes pulled from another device through the real pull path, so each record remembers its sid. */
async function pulled(count) {
  const r = await rig();
  for (let i = 0; i < count; i++) {
    const frame = await r.server.publish({ fileId: fileIdOf(i), path: pathOf(i), bytes: enc(textOf(i)), mtime: 1757100000000 + i,
      domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
    await applyChange(r.context, frame);
    assert.equal(r.state.fileByPath(pathOf(i)).sid, frame.sids[0]);
  }
  r.server.requests.length = 0;
  return r;
}

test("a chunk the server lost is found by one existence question and put back (#198)", async () => {
  const r = await pulled(3);
  const sid = r.state.fileByPath(pathOf(1)).sid;
  const ciphertext = r.server.chunks.get(sid);
  r.server.chunks.delete(sid);
  assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "repaired", bytes: textOf(1).length });
  assert.deepEqual(r.server.chunks.get(sid), ciphertext);
  const asked = r.server.requests.map((request) => `${request.method} ${request.target.replace(/[0-9a-f]{32,64}/g, "<id>")}`);
  assert.deepEqual(asked.slice(0, 2), ["POST /v1/chunks/exists", "GET /v1/files/<id>/versions/<id>"], asked.join(" | "));
  assert.equal(JSON.parse(r.server.requests[0].json).sids.length, 3, "every remembered sid in one question");
  assert.equal(asked.filter((line) => line.includes("/versions/")).length, 1, "only the missing note was read back");
});

test("a remembered sid that is not its version's is never believed (#198)", async () => {
  const r = await pulled(2);
  const own = r.state.fileByPath(pathOf(0));
  const lost = own.sid;
  // Another version's chunk, which the server holds.
  own.sid = r.state.fileByPath(pathOf(1)).sid;
  r.server.chunks.delete(lost);
  assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "repaired", bytes: textOf(0).length });
  assert.ok(r.server.chunks.has(lost));
});

test("a remembered sid is read from the data file only as a sid, and a record without one loads as before (#198)", () => {
  const record = { fileId: "12".repeat(16), versionId: "34".repeat(32), mtime: 1, size: 20, sha256: "ab".repeat(32) };
  const data = parseData({ files: { "a.md": { ...record, sid: "cd".repeat(32) }, "b.md": { ...record, sid: "../x" }, "c.md": record } }, false);
  assert.equal(data.files["a.md"].sid, "cd".repeat(32));
  assert.equal("sid" in data.files["b.md"], false);
  assert.deepEqual(data.files["c.md"], record);
});

test("a walk learns the sid of a note it read back, and the next walk only asks (#198)", async () => {
  const r = await rig();
  r.host.seed(pathOf(0), textOf(0), 1000);
  await pushFile(r.context, pathOf(0));
  const frame = r.server.journal.at(-1);
  assert.equal(r.state.fileByPath(pathOf(0)).sid, undefined, "a push leaves it to its echo or the walk");
  r.server.requests.length = 0;
  const repair = new ChunkRepair(r.context);
  assert.deepEqual(await repair.step(), { kind: "checked" });
  assert.equal(r.state.fileByPath(pathOf(0)).sid, frame.sids[0]);
  assert.equal(await sidDigest([r.state.fileByPath(pathOf(0)).sid]), r.state.fileByPath(pathOf(0)).sha256);
  assert.deepEqual(await repair.step(), { kind: "idle" });
  r.server.requests.length = 0;
  assert.deepEqual(await repair.step(), { kind: "checked" });
  assert.deepEqual(r.server.requests.map((request) => request.target), ["/v1/chunks/exists"], "no version read back");
});

test("an idle vault of 10,000 notes costs a few requests an hour, not thousands (#198)", async () => {
  const r = await rig();
  // A desktop's own listing, so the passes between its walks read nothing.
  r.host.scan = () => r.host.list();
  const count = 10_000;
  for (let i = 0; i < count; i++) {
    const sid = c.hex(c.randomBytes(32));
    r.server.chunks.set(sid, new Uint8Array(1));
    r.host.seed(pathOf(i), "x", 1000);
    r.state.setFile(pathOf(i), { fileId: fileIdOf(i), versionId: "ab".repeat(32), mtime: 1000, size: 1, sha256: await sidDigest([sid]), sid });
  }
  r.state.data.lastSeq = r.server.seq;
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers, now: () => timers.now });
  await engine.start();
  const walked = () => r.host.logs.filter((line) => line.startsWith("repair decision=walked")).length;
  // Ten thousand records are digested and surveyed on the way, and the virtual
  // clock steps while they are: the wait is renewed before it runs out of
  // steps (`fake.mjs`, MAX_ADVANCES), inside one wall budget for a loaded
  // machine rather than the default ten seconds.
  const BUDGET_MS = 120_000;
  const deadline = Date.now() + BUDGET_MS;
  while (walked() === 0) {
    const mark = timers.now;
    await timers.run(60_000, () => walked() > 0 || timers.now - mark >= 1000 * 60_000, BUDGET_MS);
    assert.ok(Date.now() < deadline, "the walk never ended");
  }
  const exists = () => r.server.requests.filter((request) => request.target === "/v1/chunks/exists").map((request) => JSON.parse(request.json).sids.length);
  assert.deepEqual(exists(), [REPAIR_EXISTS_SIDS, REPAIR_EXISTS_SIDS, count - 2 * REPAIR_EXISTS_SIDS], "one question per 4,096 sids");
  assert.ok(r.host.logs.some((line) => /^repair decision=walked batched=10000 requests=3 missing=0 learned=0 next_ms=21600000 duration_ms=\d+$/.test(line)),
    r.host.logs.filter((line) => line.startsWith("repair")).join(" | "));
  // An idle hour after the walk: the heartbeat, and nothing of the walk's.
  const hour = 60 * 60 * 1000;
  const since = r.server.requests.length, from = timers.now;
  await timers.run(60_000, () => timers.now - from >= hour, BUDGET_MS);
  const idle = r.server.requests.slice(since).map((request) => request.target);
  assert.ok(idle.length < 10, `${idle.length} requests in an idle hour: ${idle.join(" | ")}`);
  assert.equal(walked(), 1, `the next walk is ${REPAIR_WALK_MS} ms away`);
  engine.stop();
  r.server.releaseFeed();
  await engine.stopAndWait();
});

// --- F: the desktop walk and the nested-vault answer ----------------------

/** A host whose own listing is the disk and whose `list()` is a stale index (`scan.test.mjs`). */
function walking(host) {
  const truth = new Map();
  const index = new Map();
  let walks = 0;
  host.scan = async () => { walks++; return [...truth.entries()].map(([path, file]) => ({ path, mtime: file.mtime, size: file.bytes.length })); };
  host.list = async () => [...index.entries()].map(([path, file]) => ({ path, mtime: file.mtime, size: file.bytes.length }));
  return {
    walks: () => walks,
    seed(path, text, mtime) {
      const file = { bytes: enc(text), mtime };
      host.files.set(path, file);
      truth.set(path, file);
      index.set(path, file);
    },
    moveUnseen(from, to) {
      const file = truth.get(from);
      truth.delete(from);
      truth.set(to, file);
      host.files.delete(from);
      host.files.set(to, file);
    },
  };
}

test("a move made behind the window is found when it comes back, and the tree is walked every five minutes (#198)", async () => {
  const r = await rig();
  const vault = walking(r.host);
  vault.seed("Notes/Moved.md", "the note that travels\n", 1000);
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers, now: () => timers.now });
  await engine.start();
  await timers.run(STEP_MS, () => r.state.fileByPath("Notes/Moved.md")?.versionId > "" && vault.walks() === 1);
  const fileId = r.state.fileByPath("Notes/Moved.md").fileId;

  vault.moveUnseen("Notes/Moved.md", "Notes/Archive/Moved.md");
  engine.wake("focus");
  await timers.run(STEP_MS, () => r.state.fileByPath("Notes/Archive/Moved.md") !== undefined);
  assert.equal(r.state.fileByPath("Notes/Archive/Moved.md").fileId, fileId, "moved, not published anew");
  assert.ok(r.host.logs.includes(`scan decision=walk reason=focus interval_ms=${WALK_MS}`), r.host.logs.join(" | "));

  // An idle hour: a walk every `WALK_MS`, a pass every `SCAN_MS`.
  const walks = vault.walks();
  const start = timers.now;
  await timers.run(SCAN_MS, () => timers.now - start >= 60 * 60 * 1000);
  const hourly = vault.walks() - walks;
  assert.ok(hourly >= 11 && hourly <= 13, `${hourly} walks in an idle hour`);
  engine.stop();
  r.server.releaseFeed();
  await engine.stopAndWait();
});

test("every pass the engine opens on its host it closes: a page, a reconcile and a walk (#198)", async () => {
  const { server, k } = await vaultServer();
  await publishNotes(server, k, 0, 5);
  const host = new FakeHost();
  host.scan = () => host.list();
  let open = 0;
  let opened = 0;
  host.pass = (start) => {
    open += start ? 1 : -1;
    if (start) opened++;
  };
  const d = await device(server, { host });
  await d.engine.start();
  await d.timers.run(STEP_MS, () => d.state.fileByPath(pathOf(4)) !== undefined && host.logs.some((line) => line.startsWith("scan decision=walk")));
  await stopped(d, server);
  assert.equal(open, 0, "a pass was left open");
  assert.ok(opened >= 3, `${opened} passes`);
});

test("the nested-vault answer is kept per folder for one pass and asked afresh outside one (#198)", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const present = new Set();
  const asked = [];
  const adapter = { exists: async (path) => { asked.push(path); return present.has(path); } };
  // The phone asks for this plugin's own folder under each folder, at the
  // path Obsidian gives the loaded plugin (`manifest.dir`).
  const manifest = { dir: ".obsidian/plugins/obsync-private-sync" };
  const plugin = { state: { data: {} }, log: () => undefined, manifest, app: { vault: { adapter } } };
  const host = new ObsidianHost(plugin, null);
  host.notify = () => undefined;
  const plugged = (folder) => `${folder}/${manifest.dir}`;

  host.pass(true);
  for (let i = 0; i < 20; i++) assert.equal(await host.inNestedVault(`A/B/n${i}.md`), false);
  assert.equal(asked.filter((path) => path === plugged("A") || path === plugged("A/B")).length, 2, "each folder asked once in the pass");
  present.add(plugged("A/B"));
  assert.equal(await host.inNestedVault("A/B/late.md"), false, "the pass keeps its answer");
  host.pass(false);
  assert.equal(await host.inNestedVault("A/B/x.md"), true, "outside a pass, asked afresh");
  host.pass(true);
  assert.equal(await host.inNestedVault("A/B/y.md"), true, "and the next pass finds it");
  host.pass(false);
});
