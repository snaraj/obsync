import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeTimers, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { ChunkRepair, REPAIR_BATCH_SIDS, REPAIR_TICK_MS, REPAIR_SCAN_MS } = require("../build/sync/repair.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { pushFile } = require("../build/sync/push.js");
const { applyChange } = require("../build/sync/pull.js");
const { historyManifest } = require("../build/sync/history.js");
const { CHUNK_MAX, CHUNK_MIN } = require("../build/chunker.js");
const c = require("../build/crypto.js");
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function within(work, milestone) {
  const pending = Symbol("pending");
  let timer;
  try {
    const result = await Promise.race([work, new Promise((resolve) => {
      timer = setTimeout(() => resolve(pending), 1000);
    })]);
    assert.notEqual(result, pending, `${milestone} did not settle within 1000 ms`);
    return result;
  } finally { clearTimeout(timer); }
}
const puts = (r) => r.server.requests.filter((request) => request.method === "PUT");

async function note() {
  const r = await rig();
  r.path = "Notes/repair-private-marker.md";
  r.host.seed(r.path, "REPAIR PLAINTEXT SENTINEL", 1000);
  await pushFile(r.context, r.path);
  r.frame = r.server.journal.at(-1);
  r.sid = r.frame.sids[0];
  r.ciphertext = r.server.chunks.get(r.sid);
  r.server.requests.length = 0;
  return r;
}

/** A valid repeated-chunk version without allocating its entire logical file. */
async function repeated(count, len = CHUNK_MIN, isMobile = false) {
  const r = await rig({ isMobile });
  r.path = "Notes/repeated.bin";
  const bytes = new Uint8Array(len).fill(83);
  const sealed = await c.encryptChunk(r.keys.domainKey, bytes);
  const chunks = Array.from({ length: count }, () => ({ sid: sealed.sid, cid: c.hex(sealed.cid), len }));
  const size = count * len;
  const manifest = { v: 1, path: r.path, size, mtime: 1000, domain: r.context.domainId,
    chunks, sha256: c.hex(await c.sha256(bytes)), deleted: false };
  r.frame = await r.server.publishManifest({ fileId: "51".repeat(16), manifest,
    sids: chunks.map((chunk) => chunk.sid), parents: [], deviceId: r.context.deviceId,
    manifestKey: r.keys.manifestKey, bytes: size });
  r.state.setFile(r.path, { fileId: r.frame.file_id, versionId: r.frame.version_id, mtime: 1000, size, sha256: manifest.sha256 });
  r.host.stat = async () => ({ path: r.path, mtime: 1000, size });
  r.reads = [];
  r.host.source = () => ({ size, read: async (offset, length) => {
    r.reads.push({ offset, length });
    return bytes.subarray(0, length);
  } });
  r.sid = sealed.sid;
  r.ciphertext = sealed.ciphertext;
  r.server.chunks.set(r.sid, r.ciphertext);
  r.server.requests.length = 0;
  return r;
}

test("unchanged remembered file repairs the post-quarantine inventory gap; peer decrypts, identities and history stay unchanged", async () => {
  const r = await note();
  // This models scrub's completed forget_chunk result, not a live disk fault.
  r.server.chunks.delete(r.sid);
  const before = structuredClone(r.state.data), journal = structuredClone(r.server.journal);
  const result = await new ChunkRepair(r.context).step();
  assert.deepEqual(result, { kind: "repaired", bytes: 25 });
  assert.deepEqual(r.server.chunks.get(r.sid), r.ciphertext);
  assert.deepEqual(r.state.data, before);
  assert.deepEqual(r.server.journal, journal);
  assert.equal(puts(r).length, 1);
  assert.equal(r.server.unsigned.length, 0);
  assert.equal(r.server.requests.filter((request) => request.target === `/v1/chunks/${r.sid}` && request.method === "GET").length, 1);
  for (const request of r.server.requests) {
    assert.equal(JSON.stringify(request).includes(r.path), false);
    assert.equal(JSON.stringify(request).includes("REPAIR PLAINTEXT SENTINEL"), false);
  }
  const peer = await rig();
  peer.context.transport = r.transport;
  peer.context.deviceId = "52".repeat(16);
  await applyChange(peer.context, r.frame);
  assert.equal(peer.host.text(r.path), r.host.text(r.path));
});

test("healthy remembered chunks are audited without reading or stat-ing local plaintext", async () => {
  const r = await note();
  r.host.read = r.host.stat = r.host.source = () => assert.fail("healthy inventory read local content");
  assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "checked" });
  assert.equal(puts(r).length, 0);
});

test("edited bytes with unchanged size and mtime cannot repair an older retained version", async () => {
  const r = await note();
  r.server.chunks.delete(r.sid);
  r.host.seed(r.path, "X".repeat(25), 1000);
  const before = structuredClone(r.state.data);
  assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "unresolved", reason: "source_changed" });
  assert.equal(puts(r).length, 0);
  assert.equal(r.server.chunks.has(r.sid), false);
  assert.deepEqual(r.state.data, before);
});

for (const change of ["missing", "mtime", "size", "not_syncable"]) {
  test(`missing server chunk has a visible unresolved result for local source ${change}`, async () => {
    const r = await note();
    r.server.chunks.delete(r.sid);
    if (change === "missing") r.host.files.delete(r.path);
    if (change === "mtime") r.host.files.get(r.path).mtime++;
    if (change === "size") r.host.seed(r.path, "short", 1000);
    if (change === "not_syncable") r.host.unsyncable.add(r.path);
    r.host.source = () => assert.fail("unusable source read");
    assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "unresolved", reason: "missing_source" });
    assert.equal(puts(r).length, 0);
  });
}

test("selected folders are checked before metadata and local access, including cached batches", async () => {
  const r = await note();
  r.state.data.syncFolders = ["Other"];
  r.host.stat = r.host.source = () => assert.fail("excluded path touched");
  assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "skipped" });
  assert.equal(r.server.requests.length, 0);
  const large = await repeated(REPAIR_BATCH_SIDS + 1);
  const repair = new ChunkRepair(large.context);
  assert.equal((await repair.step()).kind, "checked");
  large.state.data.syncFolders = [];
  large.server.requests.length = 0;
  await assert.rejects(repair.step(), /scope/);
  assert.equal(large.server.requests.length, 0);
  assert.equal(large.reads.length, 0);
});

test("remembered path must match the authenticated immutable manifest", async () => {
  const r = await note();
  r.state.data.files["Notes/other.md"] = r.state.data.files[r.path];
  delete r.state.data.files[r.path];
  r.host.source = () => assert.fail("mismatched path read");
  await assert.rejects(new ChunkRepair(r.context).step(), /remembered/);
  assert.equal(r.server.requests.some((request) => request.target === "/v1/chunks/exists"), false);
  assert.equal(puts(r).length, 0);
});

test("authenticated content size must match the remembered size before inventory or source access", async () => {
  const r = await note();
  const manifest = await historyManifest(r.context, r.frame.file_id, r.context.domainId, r.frame.version_id, r.frame);
  assert.equal(manifest.size, 25);
  r.state.data.files[r.path].size = 26;
  r.host.stat = r.host.source = () => assert.fail("mismatched size touched local source");
  await assert.rejects(new ChunkRepair(r.context).step(), /remembered/);
  assert.equal(r.server.requests.some((request) => request.target === "/v1/chunks/exists"), false);
  assert.equal(puts(r).length, 0);
});

test("an authenticated tombstone with matching path and zero size cannot become a repair candidate", async () => {
  const r = await note();
  const frame = await r.server.publishTombstone({ fileId: r.frame.file_id, path: r.path,
    manifestKey: r.keys.manifestKey, parents: [r.frame.version_id], deviceId: r.context.deviceId });
  const manifest = await historyManifest(r.context, frame.file_id, r.context.domainId, frame.version_id, frame);
  assert.equal(manifest.deleted, true);
  assert.equal(manifest.path, r.path);
  assert.equal(manifest.size, 0);
  r.state.setFile(r.path, { fileId: frame.file_id, versionId: frame.version_id, size: 0,
    mtime: manifest.mtime, sha256: manifest.sha256 });
  r.server.requests.length = 0;
  r.host.stat = r.host.source = () => assert.fail("tombstone touched local source");
  await assert.rejects(new ChunkRepair(r.context).step(), /remembered/);
  assert.equal(r.server.requests.some((request) => request.target === "/v1/chunks/exists"), false);
  assert.equal(puts(r).length, 0);
});

test("repair rejects a substituted immutable version before local reads or chunk requests", async () => {
  const r = await note();
  const original = r.transport.historyVersion.bind(r.transport);
  r.transport.historyVersion = async (...args) => ({ ...await original(...args), version_id: "00".repeat(32) });
  r.host.source = () => assert.fail("unverified version read");
  await assert.rejects(new ChunkRepair(r.context).step(), /history version/i);
  assert.equal(puts(r).length, 0);
});

for (const identity of ["file", "version", "map"]) {
  test(`unusable ${identity} identity never becomes a repair request`, async () => {
    const r = await note();
    const record = r.state.data.files[r.path];
    if (identity === "file") record.fileId = "invalid";
    if (identity === "version") record.versionId = "";
    if (identity === "map") record.fileId = r.context.mapFileId;
    let result;
    await assert.doesNotReject(async () => { result = await new ChunkRepair(r.context).step(); });
    assert.deepEqual(result, { kind: "skipped" });
    assert.equal(r.server.requests.length, 0);
  });
}

for (const inventory of ["unrequested", "duplicates", "nonarray"]) {
  test(`invalid ${inventory} inventory cannot authorize repair work`, async () => {
    const r = await note();
    r.transport.missingChunks = async () => inventory === "unrequested" ? ["99".repeat(32)] : inventory === "duplicates" ? [r.sid, r.sid] : {};
    r.host.source = () => assert.fail("invalid inventory read");
    await assert.rejects(new ChunkRepair(r.context).step(), /inventory/);
    assert.equal(puts(r).length, 0);
  });
}

test("large unchanged file audits one bounded batch per step and caches its authenticated manifest", async () => {
  const r = await repeated(REPAIR_BATCH_SIDS + 1);
  const repair = new ChunkRepair(r.context);
  assert.equal((await repair.step()).kind, "checked");
  assert.equal(r.server.requests.filter((request) => request.target.includes("/versions/")).length, 1);
  assert.equal((await repair.step()).kind, "checked");
  assert.equal(r.server.requests.filter((request) => request.target.includes("/versions/")).length, 1);
  assert.equal(r.server.requests.filter((request) => request.target === "/v1/chunks/exists").length, 2);
  assert.equal((await repair.step()).kind, "idle");
  assert.equal(r.reads.length, 0);
});

test("distinct ordinary chunks repair after a healthy prefix at exact nonzero offsets, one per step", async () => {
  const r = await rig(), path = "Notes/distinct-repair.bin";
  const bytes = new Uint8Array(2 * CHUNK_MAX + 4096);
  bytes.fill(17, 0, CHUNK_MAX);
  bytes.fill(34, CHUNK_MAX, 2 * CHUNK_MAX);
  bytes.fill(51, 2 * CHUNK_MAX);
  r.host.seed(path, bytes, 1000);
  await pushFile(r.context, path);
  const frame = r.server.journal.at(-1);
  const manifest = await historyManifest(r.context, frame.file_id, r.context.domainId, frame.version_id, frame);
  assert.ok(manifest.chunks.length >= 3, "ordinary upload must produce a healthy prefix and two missing chunks");
  assert.equal(new Set(frame.sids).size, frame.sids.length, "every fixture chunk must have distinct ciphertext");
  const [prefix, first, second] = manifest.chunks;
  const originals = [r.server.chunks.get(first.sid), r.server.chunks.get(second.sid)];
  r.server.chunks.delete(first.sid); r.server.chunks.delete(second.sid);
  const before = structuredClone(r.state.data), journal = structuredClone(r.server.journal), reads = [];
  const source = r.host.source.bind(r.host);
  r.host.source = (...args) => {
    const input = source(...args);
    return { size: input.size, read: async (offset, length) => {
      reads.push({ offset, length }); return input.read(offset, length);
    } };
  };
  r.server.requests.length = 0;
  const repair = new ChunkRepair(r.context);
  assert.deepEqual(await repair.step(), { kind: "repaired", bytes: first.len });
  assert.deepEqual(reads, [{ offset: prefix.len, length: first.len }]);
  assert.equal(puts(r).length, 1);
  assert.deepEqual(r.server.chunks.get(first.sid), originals[0]);
  assert.equal(r.server.chunks.has(second.sid), false, "first step must not repair the next missing chunk");
  assert.deepEqual(await repair.step(), { kind: "repaired", bytes: second.len });
  assert.deepEqual(reads, [{ offset: prefix.len, length: first.len },
    { offset: prefix.len + first.len, length: second.len }]);
  assert.equal(puts(r).length, 2);
  assert.deepEqual(r.server.chunks.get(second.sid), originals[1]);
  assert.deepEqual(r.state.data, before);
  assert.deepEqual(r.server.journal, journal);
  const peer = await rig();
  peer.context.transport = r.transport;
  peer.context.deviceId = "52".repeat(16);
  await applyChange(peer.context, frame);
  assert.deepEqual(await peer.host.read(path), bytes);
});

test("repeated missing chunk is re-uploaded once, using one bounded range, without replaying history", async () => {
  const r = await repeated(3, CHUNK_MAX);
  r.server.chunks.delete(r.sid);
  const repair = new ChunkRepair(r.context);
  let result;
  await assert.doesNotReject(async () => { result = await repair.step(); });
  assert.deepEqual(result, { kind: "repaired", bytes: CHUNK_MAX });
  assert.deepEqual(r.reads, [{ offset: 0, length: CHUNK_MAX }]);
  assert.equal((await repair.step()).kind, "checked");
  assert.equal(puts(r).length, 1);
  assert.equal(r.server.journal.length, 1);
  assert.deepEqual(JSON.parse(r.server.requests.find((request) => request.target === "/v1/chunks/exists").json).sids, [r.sid]);
});

for (const capability of [false, undefined]) {
  test(`non-streaming capability ${capability} refuses a large background source before reading`, async () => {
    const r = await repeated(2, CHUNK_MAX, true);
    r.host.supportsRangeReads = capability;
    r.server.chunks.delete(r.sid);
    r.host.source = () => assert.fail("unbounded background allocation");
    assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "unresolved", reason: "range_read_unavailable" });
    assert.equal(puts(r).length, 0);
  });
}

test("buffered mobile source can restore an exact CHUNK_MAX local file without changing upload policy", async () => {
  const r = await repeated(1, CHUNK_MAX, true);
  r.state.data.policy.perFileMaxBytes = 1;
  r.server.chunks.delete(r.sid);
  assert.equal((await new ChunkRepair(r.context).step()).kind, "repaired");
  assert.deepEqual(r.reads, [{ offset: 0, length: CHUNK_MAX }]);
});

test("healthy large non-streaming file is checked without a content read or a capability refusal", async () => {
  const r = await repeated(2, CHUNK_MAX, true);
  r.host.source = () => assert.fail("healthy large mobile file read");
  assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "checked" });
});

for (const when of ["read", "encryption"]) {
  test(`changed stat during ${when} prevents the repair PUT`, async () => {
    const r = await note();
    r.server.chunks.delete(r.sid);
    const stat = r.host.stat.bind(r.host);
    let calls = 0;
    r.host.stat = async (...args) => {
      if (++calls === (when === "read" ? 2 : 3)) r.host.files.get(r.path).mtime++;
      return stat(...args);
    };
    assert.deepEqual(await new ChunkRepair(r.context).step(), { kind: "unresolved", reason: "source_changed" });
    assert.equal(puts(r).length, 0);
  });
}

for (const change of ["stop", "scope", "record", "fileId", "mtime", "size", "sha256", "removed", "key", "device"]) {
  test(`${change} during a partial source read prevents the next range and every PUT`, async () => {
    const r = await note();
    r.server.chunks.delete(r.sid);
    const entered = deferred(), release = deferred();
    let reads = 0, active = true;
    r.host.source = () => ({ size: 25, read: async () => {
      reads++;
      entered.resolve();
      await release.promise;
      return new Uint8Array([82]);
    } });
    const repair = new ChunkRepair(r.context, () => active);
    const work = repair.step();
    await entered.promise;
    if (change === "stop") { active = false; repair.cancel(); }
    if (change === "scope") r.state.data.syncFolders = [];
    if (change === "record") r.state.data.files[r.path].versionId = "99".repeat(32);
    if (change === "fileId") r.state.data.files[r.path].fileId = "99".repeat(16);
    if (change === "mtime") r.state.data.files[r.path].mtime++;
    if (change === "size") r.state.data.files[r.path].size++;
    if (change === "sha256") r.state.data.files[r.path].sha256 = "99".repeat(32);
    if (change === "removed") delete r.state.data.files[r.path];
    if (change === "key") r.state.data.vrk = "99".repeat(32);
    if (change === "device") r.state.data.deviceId = "99".repeat(16);
    release.resolve();
    if (change === "scope") await assert.rejects(work, /scope/);
    else assert.equal((await work).kind, "skipped");
    assert.equal(reads, 1);
    assert.equal(puts(r).length, 0);
  });
}

test("a held repair step refuses overlapping work; cancellation cannot claim an unverified PUT", async () => {
  const r = await note();
  r.server.chunks.delete(r.sid);
  const entered = deferred(), release = deferred();
  const put = r.transport.putChunk.bind(r.transport);
  r.transport.putChunk = async (...args) => { entered.resolve(); await release.promise; await put(...args); };
  const repair = new ChunkRepair(r.context), work = repair.step();
  await entered.promise;
  assert.equal((await within(repair.step(), "overlapping repair refusal")).kind, "skipped");
  repair.cancel();
  let settled = false;
  void work.then(() => { settled = true; });
  await turn();
  assert.equal(settled, false, "dispatched write must settle before its worker drains");
  release.resolve();
  assert.equal((await work).kind, "skipped");
  assert.equal(puts(r).length, 1);
  assert.equal(r.server.requests.some((request) => request.method === "GET" && request.target.startsWith("/v1/chunks/")), false);
});

test("repair only reports success after exact ciphertext readback", async () => {
  const r = await note();
  r.server.chunks.delete(r.sid);
  r.transport.getChunk = async () => new Uint8Array([1, 2, 3]);
  await assert.rejects(new ChunkRepair(r.context).step(), /readback/);
  assert.equal(puts(r).length, 1);
});

test("engine automatically repairs unchanged files, idles between complete walks, and reports source loss without paths", async () => {
  const r = await note(), timers = new FakeTimers(), statuses = [];
  r.state.data.lastSeq = r.server.seq;
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock, onStatus: (status) => statuses.push(status) });
  await engine.start();
  assert.ok(timers.entries.some((entry) => entry.due - timers.now === REPAIR_TICK_MS));
  r.server.chunks.delete(r.sid);
  await timers.run(REPAIR_TICK_MS, () => r.host.logs.some((line) => line.startsWith("repair decision=verified")));
  assert.equal(puts(r).length, 1);
  await engine.syncNow(); // Finish the walk, then schedule the idle interval.
  assert.ok(r.host.logs.some((line) => /^repair decision=verified bytes=25 budget_sids=64 budget_chunks=1 duration_ms=\d+$/.test(line)));
  assert.ok(timers.entries.some((entry) => entry.due - timers.now === REPAIR_SCAN_MS));
  r.server.chunks.delete(r.sid);
  r.host.seed(r.path, "X".repeat(25), 1000);
  await engine.syncNow();
  assert.ok(statuses.some((status) => status.kind === "error" && status.message.includes("missing chunk")));
  assert.ok(r.host.notices.some((message) => message.includes("missing chunk")));
  for (let repeat = 0; repeat < 2; repeat++) {
    await engine.syncNow(); // Complete this walk.
    await engine.syncNow(); // The same unavailable source is still unresolved.
  }
  assert.equal(statuses.filter((status) => status.kind === "error" && status.message.includes("missing chunk")).length, 3);
  assert.equal(r.host.notices.filter((message) => message.includes("missing chunk")).length, 1);
  assert.equal([...r.host.notices, ...r.host.logs.filter((line) => line.startsWith("repair "))].some((text) => text.includes(r.path)), false);
  engine.stop(); r.server.releaseFeed(); await engine.stopAndWait();
  assert.equal(timers.entries.length, 0);
});

test("engine shares one repair worker and stopAndWait drains a held PUT before reload", async () => {
  const r = await note(), timers = new FakeTimers();
  r.state.data.lastSeq = r.server.seq;
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start(); r.server.chunks.delete(r.sid);
  const entered = deferred(), release = deferred(), put = r.transport.putChunk.bind(r.transport);
  let calls = 0;
  r.transport.putChunk = async (...args) => { calls++; entered.resolve(); await release.promise; await put(...args); };
  const first = engine.syncNow(); await entered.promise;
  const second = engine.syncNow();
  await turn();
  assert.equal(calls, 1);
  let drained = false;
  const stopping = engine.stopAndWait().then(() => { drained = true; });
  r.server.releaseFeed(); await turn();
  assert.equal(drained, false);
  release.resolve(); await Promise.all([first, second, stopping]);
  assert.equal(drained, true);
  assert.equal(timers.entries.length, 0);
  assert.equal(r.host.logs.some((line) => line.startsWith("repair decision=verified")), false);
});

test("overlapping engine requests retain a single next repair timer after both callers settle", async () => {
  const r = await note(), timers = new FakeTimers();
  r.state.data.lastSeq = r.server.seq;
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start(); r.server.chunks.delete(r.sid);
  const entered = deferred(), release = deferred(), put = r.transport.putChunk.bind(r.transport);
  r.transport.putChunk = async (...args) => { entered.resolve(); await release.promise; await put(...args); };
  const first = engine.syncNow(); await entered.promise;
  const second = engine.syncNow(); await turn();
  release.resolve(); await Promise.all([first, second]);
  assert.equal(timers.entries.filter((entry) => entry.due - timers.now === REPAIR_TICK_MS).length, 1);
  engine.stop(); r.server.releaseFeed(); await engine.stopAndWait();
  assert.equal(timers.entries.length, 0);
});

test("engine cancellation releases a held metadata read without allowing any subsequent source work", async () => {
  const r = await note(), timers = new FakeTimers();
  r.state.data.lastSeq = r.server.seq;
  const original = r.server.request, entered = deferred(), release = deferred();
  let metadataCalls = 0, responseReleased = false, sourceReads = 0;
  const { Transport } = require("../build/transport.js");
  const transport = new Transport({ request: async (request) => {
    if (request.url.includes("/versions/")) {
      metadataCalls++; entered.resolve(); await release.promise; responseReleased = true;
    }
    return original(request);
  }, serverUrl: () => r.state.data.serverUrl,
    device: () => ({ id: r.state.data.deviceId, secret: c.unhex(r.state.data.deviceSecret) }),
    edgeHeaders: () => [], now: () => r.host.clock, sleep: async () => undefined });
  const engine = new SyncEngine({ state: r.state, host: r.host, transport, timers });
  await engine.start();
  // The feed must actually be waiting before releaseFeed can drain it.
  await timers.run(0, () => r.server.feedWaiters.length > 0);
  r.host.source = () => { sourceReads++; assert.fail("cancelled repair read content"); };
  const work = engine.syncNow(); await within(entered.promise, "metadata dispatch");
  const underlying = transport.manualRead;
  assert.ok(underlying instanceof Promise);
  try {
    const stopping = engine.stopAndWait(); r.server.releaseFeed();
    await within(Promise.all([work, stopping]), "cancelled repair and engine drain");
    assert.equal(responseReleased, false, "logical drain must not need the held metadata response");
    assert.equal(transport.manualRead, underlying, "the underlying read remains owned until it settles");
    assert.equal(metadataCalls, 1);
    assert.equal(sourceReads, 0);
    assert.equal(r.server.requests.some((request) => request.target === "/v1/chunks/exists"), false);
    assert.equal(puts(r).length, 0);
    assert.equal(timers.entries.length, 0);
  } finally {
    release.resolve();
    await within(underlying, "underlying metadata response");
    await engine.stopAndWait();
  }
  assert.equal(responseReleased, true);
  assert.equal(transport.manualRead, null);
  assert.equal(metadataCalls, 1);
  assert.equal(sourceReads, 0);
  assert.equal(r.server.requests.some((request) => request.target === "/v1/chunks/exists"), false);
  assert.equal(puts(r).length, 0);
  assert.equal(timers.entries.length, 0);
});

test("repair verification failure is visible without repeating an untrusted error or claiming success", async () => {
  const r = await note(), timers = new FakeTimers(), statuses = [];
  r.state.data.lastSeq = r.server.seq;
  const engine = new SyncEngine({ ...r, timers, onStatus: (status) => statuses.push(status) });
  await engine.start();
  let attempts = 0;
  r.transport.historyVersion = async () => { attempts++; throw new Error(`PRIVATE ERROR ${r.path}`); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await engine.syncNow();
    assert.equal(attempts, attempt + 1);
    assert.equal(timers.entries.filter((entry) => entry.due - timers.now === REPAIR_SCAN_MS).length, 1);
    assert.equal(timers.entries.some((entry) => entry.due - timers.now === REPAIR_TICK_MS), false);
    if (attempt === 0) await engine.syncNow(); // Complete the failed walk before the next attempt.
  }
  assert.ok(statuses.some((status) => status.kind === "error" && status.message.includes("could not verify")));
  assert.equal([...r.host.logs, ...statuses.map((status) => status.message ?? "")].some((text) => text.includes("PRIVATE ERROR")), false);
  assert.equal(r.host.logs.some((text) => text.startsWith("repair decision=verified")), false);
  await timers.run(0, () => r.server.feedWaiters.length > 0);
  engine.stop(); r.server.releaseFeed(); await engine.stopAndWait();
});

test("native host reports actual range capability and closes its bounded source descriptor", async (t) => {
  const box = sandbox(), root = mkdtempSync(join(tmpdir(), "obsync-repair-range-"));
  t.after(() => { rmSync(box.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const plugin = { state: { data: {} }, app: { vault: { adapter: {} } } };
  const fallback = new ObsidianHost(plugin, null);
  assert.equal(fallback.supportsRangeReads, false);
  writeFileSync(join(root, "source.bin"), new Uint8Array(100).fill(7));
  let closed = 0, failRead = false;
  const instrumented = { promises: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: (...values) => handle.stat(...values), read: (...values) => {
      if (failRead) throw new Error("synthetic range read failure");
      return handle.read(...values);
    },
      close: async () => { closed++; await handle.close(); } };
  } } };
  const host = new ObsidianHost(plugin, { fs: instrumented, path: nodePath, base: root });
  assert.equal(host.supportsRangeReads, true);
  assert.deepEqual(await host.source("source.bin", 100).read(40, 10), new Uint8Array(10).fill(7));
  assert.equal(closed, 1);
  failRead = true;
  await assert.rejects(host.source("source.bin", 100).read(40, 10), /synthetic range read failure/);
  assert.equal(closed, 2);
});
