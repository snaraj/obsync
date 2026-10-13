import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, fakeState, rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { applyChange, assembleLegacyBytes } = require("../build/sync/pull.js");
const { pushFile, postManifest } = require("../build/sync/push.js");
const { historyManifest, legacyHistoryManifest } = require("../build/sync/history.js");
const encoder = new TextEncoder();
function engine(r, t) {
  const result = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers: new FakeTimers(), now: () => r.host.clock });
  t.after(async () => { result.stop(); r.server.releaseFeed(); await result.stopAndWait(); });
  return result;
}
async function remote(r) {
  return r.server.publish({ fileId: "77".repeat(16), path: "Notes/remote.md", bytes: encoder.encode("suite2 content sentinel"), mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
}

test("live manifests and chunks use only explicit suite2 packets", async () => {
  const r = await rig(); r.host.seed("Notes/local.md", "suite2 content sentinel", 1000);
  await assert.doesNotReject(pushFile(r.context, "Notes/local.md"), "live writer must seal valid suite2 record");
  const record = r.server.journal.at(-1);
  assert.equal(record.seal_suite, 2, "live writer must declare suite2");
  assert.equal(Object.hasOwn(record, "manifest_nonce"), false, "live writer must omit legacy nonce");
  const manifest = await historyManifest(r.context, record.file_id, record.domain_id, record.version_id, record);
  const copy = await rig(); copy.server.chunks = r.server.chunks;
  const peer = await copy.server.publishManifest({ fileId: record.file_id, manifest, sids: record.sids, parents: record.parents,
    deviceId: "ff".repeat(16), manifestKey: copy.keys.manifestKey, bytes: record.bytes });
  assert.equal(peer.manifest_ct, record.manifest_ct, "honest peer fixture must preserve actual writer packet");
  let applied;
  await assert.doesNotReject(async () => { applied = await applyChange(copy.context, peer); }, "suite2 receiver must authenticate honest new-mode chunks");
  assert.equal(applied, "applied", "suite2 receiver must apply honest control");
  assert.equal(new TextDecoder().decode(await copy.host.read(manifest.path)), "suite2 content sentinel", "honest suite2 bytes must arrive");
});

test("live framing refuses absent mixed or nonliteral suite without writing", async () => {
  const r = await rig(), record = await remote(r);
  for (const patch of [{ seal_suite: undefined }, { seal_suite: null }, { seal_suite: 1 }, { seal_suite: "2" },
    { manifest_nonce: undefined }, { manifest_nonce: null }, { manifest_nonce: "00".repeat(12) }]) {
    const candidate = { ...record, ...patch };
    assert.equal((await applyChange(r.context, candidate)), "refused", "nonclosed suite2 frame must refuse");
  }
  const stripped = { ...record }; delete stripped.seal_suite;
  assert.equal((await applyChange(r.context, stripped)), "refused", "missing suite2 declaration must refuse");
  assert.equal(await r.host.stat("Notes/remote.md"), null, "refused frame must leave disk untouched");
  assert.equal(r.state.fileByPath("Notes/remote.md"), undefined, "refused frame must leave records untouched");
  assert.equal((await applyChange(r.context, record)), "applied", "restored suite2 frame must apply");
});

test("legacy ciphertext opens only through explicitly named history helpers", async () => {
  const r = await rig(), plaintext = encoder.encode("legacy history sentinel"), fileId = "88".repeat(16);
  const chunk = await c.encryptChunk(r.keys.domainKey, plaintext), parents = [], sids = [chunk.sid];
  const manifest = { v: 1, path: "Notes/legacy.md", size: plaintext.length, mtime: 1000, domain: KEYS.domainId,
    chunks: [{ sid: chunk.sid, cid: c.hex(chunk.cid), len: plaintext.length }], sha256: c.hex(await c.sha256(plaintext)), deleted: false };
  const sealed = await c.encryptManifest(r.keys.manifestKey, fileId, await c.contentVersionId(fileId, parents, sids), JSON.stringify(manifest));
  const record = { seq: 1, file_id: fileId, domain_id: KEYS.domainId, version_id: await c.versionId(fileId, parents, sealed.ciphertext, sids),
    parents, sids, bytes: plaintext.length, manifest_ct: c.base64(sealed.ciphertext), manifest_nonce: c.hex(sealed.nonce),
    deleted: false, device_id: "ff".repeat(16), ts: 1000, heads: [], conflicted: false };
  record.heads = [record.version_id]; r.server.chunks.set(chunk.sid, chunk.ciphertext);
  assert.equal((await applyChange(r.context, record)), "refused", "ordinary feed must never fall back to legacy");
  await assert.rejects(historyManifest(r.context, fileId, KEYS.domainId, record.version_id, record), /Invalid history version/, "ordinary history must require suite2");
  const selected = await legacyHistoryManifest(r.context, fileId, KEYS.domainId, record.version_id, record);
  assert.deepEqual(await assembleLegacyBytes(r.context, selected), plaintext, "explicit legacy history control must authenticate old bytes");
  assert.equal(await r.host.stat(manifest.path), null, "legacy history read must not apply bytes");
  assert.equal(r.state.fileByPath(manifest.path), undefined, "legacy history read must not change live records");
  const current = await remote(r);
  await assert.rejects(legacyHistoryManifest(r.context, current.file_id, KEYS.domainId, current.version_id, current), /Invalid legacy history seal/, "legacy helper must never try suite2");
});

test("startup refuses missing map without genuine new initialization capability", async (t) => {
  const r = await rig(); r.server.files.delete(r.keys.map.fileId); r.server.requests.length = 0;
  const before = structuredClone(r.state.data), e = engine(r, t);
  await assert.rejects(e.start(), error => error.reason === "missing", "missing map must refuse without initialization authority");
  assert.equal(e.context, null, "missing map must not create live context");
  assert.equal(r.server.requests.some(request => request.method === "POST"), false, "missing map must not publish replacement");
  assert.deepEqual(r.state.data, before, "missing map refusal must preserve local state");
});

test("new setup authenticates map readback then durably consumes initialization", async (t) => {
  const r = await rig({ initializeMap: true }); r.server.files.delete(r.keys.map.fileId);
  const e = engine(r, t); await assert.doesNotReject(e.start(), "new setup must seal and authenticate suite2 map");
  assert.equal(r.state.custody2().initializeMap, false, "authenticated map readback must consume initialization capability");
  e.stop(); r.server.releaseFeed(); await e.stopAndWait();
  assert.equal((await r.reload()).custody2().initializeMap, false, "map initialization completion must survive reload");
  assert.ok(r.server.requests.filter(request => request.method === "GET" && request.target === `/v1/files/${r.keys.map.fileId}`).length >= 2,
    "new map must be read back before completion");
});

test("corrupt map readback preserves initialization and refuses startup", async (t) => {
  const r = await rig({ initializeMap: true }); r.server.files.delete(r.keys.map.fileId);
  const get = r.transport.getFile.bind(r.transport);
  t.mock.method(r.transport, "getFile", async (...args) => {
    const file = await get(...args); return { ...file, versions: file.versions.map(version => ({ ...version, manifest_nonce: null })) };
  });
  const e = engine(r, t);
  await assert.rejects(e.start(), error => error.reason === "undecryptable", "corrupt map readback must halt startup");
  assert.equal(r.state.custody2().initializeMap, true, "failed map authentication must retain initialization capability");
  assert.equal(e.context, null, "corrupt map must not create live context");
});

test("each live context operation checks current active custody and generation", async (t) => {
  const r = await rig(); r.host.seed("Notes/local.md", "authority sentinel", 1000);
  const acknowledged = r.state.custody2(); let selected = acknowledged;
  t.mock.method(r.state, "custody2", () => selected);
  for (const value of [{ ...acknowledged, phase: "seeding" }, null, { ...acknowledged, enrollment: {} },
    { ...acknowledged, rotation: {} }, { ...acknowledged, generation: "00".repeat(16) }]) {
    selected = value;
    await assert.rejects(pushFile(r.context, "Notes/local.md"), /suite2 authority required/, "inactive or changed pin must refuse live publication");
  }
  assert.equal(r.server.journal.length, 0, "refused pin must publish nothing");
  selected = acknowledged;
  assert.equal((await pushFile(r.context, "Notes/local.md")).status, "pushed", "restored active pin must publish control");
});


test("map identity and clear record shape are verified against local reserved scope", async () => {
  const r = await rig(), dm = require("../build/domainmap.js"), get = r.transport.getFile.bind(r.transport);
  const original = await get(r.keys.map.fileId);
  for (const changed of [{ ...original, file_id: "ff".repeat(16) }, { ...original, domain_id: KEYS.domainId },
    ...[{ sids: null }, { sids: ["ff".repeat(32)] }, { bytes: 1 }, { deleted: true }, { deleted: undefined }].map(patch =>
      ({ ...original, versions: original.versions.map(version => ({ ...version, ...patch })) }))]) {
    r.transport.getFile = async () => changed;
    await assert.rejects(dm.loadDomainMap(r.transport, r.keys.map), error => error.reason === "binding",
      "map declared scope and empty undeleted shape must be exact");
  }
  r.transport.getFile = get;
  assert.deepEqual(await dm.loadDomainMap(r.transport, r.keys.map), dm.defaultDomainMap(KEYS.domainId), "restored map binding must load");
});


test("legacy pin and inactive startup refuse before network or bookkeeping", async (t) => {
  const r = await rig(), legacy = await fakeState(false, false);
  const { UNVERIFIED_LANDING } = require("../build/state.js");
  const e = engine({ ...r, state: legacy.state }, t);
  legacy.state.data.dropped["Notes/unverified.md"] = UNVERIFIED_LANDING;
  await assert.rejects(e.start(), /suite2 authority required/, "legacy pin must never start ordinary engine");
  assert.equal(legacy.state.data.dropped["Notes/unverified.md"], UNVERIFIED_LANDING, "refused startup must preserve unverified bookkeeping");
  const active = r.state.custody2(); let selected = active;
  t.mock.method(r.state, "custody2", () => selected);
  for (const pin of [{ ...active, phase: "seeding" }, { ...active, enrollment: {} }, { ...active, rotation: {} },
    { ...active, generation: "00".repeat(16) }]) {
    selected = pin;
    await assert.rejects(engine(r, t).start(), /suite2 (authority required|generation mismatch)/, "inactive startup must refuse before map request");
  }
  assert.equal(r.server.requests.length, 0, "startup pin must be checked before network work");
});

test("startup rechecks captured authority after asynchronous map and derivations", async (t) => {
  const r = await rig(), active = r.state.custody2(), get = r.transport.getFile.bind(r.transport); let selected = active;
  t.mock.method(r.state, "custody2", () => selected);
  t.mock.method(r.transport, "getFile", async (...args) => { const file = await get(...args); selected = { ...active, phase: "seeding" }; return file; });
  const e = engine(r, t);
  // Isolate the startup checkpoint from its independent periodic heartbeat.
  t.mock.method(e, "heartbeat", async () => undefined);
  await assert.rejects(e.start(), /suite2 authority changed/, "authority changed during start must refuse before live context");
  assert.equal(e.context, null, "changed startup authority must not produce context");
});

test("ordinary existing map starts without consuming absent initialization", async (t) => {
  const r = await rig(), e = engine(r, t);
  await assert.doesNotReject(e.start(), "ordinary existing map must start without initialization capability");
  assert.equal(r.state.custody2().initializeMap, false, "ordinary map start must leave initialization absent");
});

test("an authentic different map readback cannot consume initialization", async (t) => {
  const r = await rig({ initializeMap: true }); r.server.files.delete(r.keys.map.fileId);
  const post = r.transport.postVersion.bind(r.transport), seal = require("../build/seal2.js");
  t.mock.method(r.transport, "postVersion", async (...args) => {
    const result = await post(...args), file = r.server.files.get(r.keys.map.fileId), head = file.versions.at(-1);
    const packet = await seal.sealRecord(r.keys.map.key, 2, { generation: r.keys.generation, domainId: r.keys.map.domainId,
      fileId: r.keys.map.fileId, parents: head.parents, sids: [] }, encoder.encode(JSON.stringify({ v: 1, domains: [{ id: KEYS.domainId, paths: [""] }] })));
    head.manifest_ct = c.base64(packet); head.version_id = await c.versionId(r.keys.map.fileId, head.parents, packet, []); file.heads = [head.version_id];
    return result;
  });
  const e = engine(r, t);
  await assert.rejects(e.start(), error => error.reason === "unwritten", "authenticated readback must describe newly created map");
  assert.equal(r.state.custody2().initializeMap, true, "different map readback must retain initialization");
});

test("adoption readback requires closed suite2 framing before matching operation", async (t) => {
  const r = await rig(), source = await remote(r);
  const manifest = await historyManifest(r.context, source.file_id, source.domain_id, source.version_id, source);
  const get = r.transport.getFile.bind(r.transport);
  t.mock.method(r.transport, "getFile", async (...args) => {
    const file = await get(...args); return { ...file, versions: file.versions.map(version => ({ ...version, manifest_nonce: undefined })) };
  });
  const result = await postManifest(r.context, source.file_id, [], source.sids, { ...manifest, mtime: 2000 }, source.bytes, true);
  assert.notEqual(result.versionId, source.version_id, "nonclosed adoption readback must not be adopted");
  assert.equal(r.server.journal.length, 2, "refused adoption must publish actual suite2 operation");
});


test("engine context access cannot outlive acknowledged active pin", async (t) => {
  const r = await rig(), e = engine(r, t); await e.start();
  t.mock.method(r.state, "custody2", () => null);
  assert.throws(() => e.need(), /suite2 authority required/, "engine context access must enforce current pin");
});
