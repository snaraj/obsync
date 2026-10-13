import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const c = require("../build/crypto.js"), dm = require("../build/domainmap.js"), s = require("../build/seal2.js");
const { parseEntry } = require("../build/sync/pull.js");
const { preflightRotationMap, planRotationReseal, RotationResealError } = require("../build/rotationReseal.js");
const domain = "33".repeat(16), file = "44".repeat(16), other = "55".repeat(16), encoder = new TextEncoder();
const refusal = reason => error => error instanceof RotationResealError && error.reason === reason;
async function fixture(suite = 2) {
  const oldRoot = new Uint8Array(32).fill(11), newRoot = new Uint8Array(32).fill(22);
  const oldMap = await dm.domainMapKeys(oldRoot), newMap = await dm.domainMapKeys(newRoot);
  const old = { suite, root: oldRoot, generation: oldMap.fileId }, next = { root: newRoot, generation: newMap.fileId };
  const dk = await c.deriveDomainKey(oldRoot, domain), mk = await c.deriveManifestKey(dk, domain);
  const records = new Map(), chunks = new Map(), heads = new Map(), calls = [];
  const io = {
    async getFile(f) { calls.push(["file", f]); return { file_id: f, domain_id: f === oldMap.fileId ? oldMap.domainId : domain, heads: [...(heads.get(f) ?? [])] }; },
    async getVersion(f, v) { calls.push(["version", f, v]); return structuredClone(records.get(f + v)); },
    async getChunk(sid) { calls.push(["chunk", sid]); return new Uint8Array(chunks.get(sid)); },
    async putChunk(sid, body) { calls.push(["put", sid]); chunks.set(sid, new Uint8Array(body)); },
  };
  async function add(f, entry, { parents = [], kind = 1, key = mk, domainId = domain, raw } = {}) {
    const plaintext = raw ?? encoder.encode(JSON.stringify(entry)), sids = kind === 2 ? [] : entry.chunks.map(x => x.sid);
    const packet = suite === 2 ? { ciphertext: await s.sealRecord(key, kind, { generation: old.generation, domainId, fileId: f, parents, sids }, plaintext) }
      : await c.encryptManifest(key, f, await c.contentVersionId(f, parents, sids), new TextDecoder().decode(plaintext));
    const v = await c.versionId(f, parents, packet.ciphertext, sids);
    records.set(f + v, { version_id: v, parents: [...parents], sids, bytes: kind === 2 ? 0 : entry.size, deleted: kind === 2 ? false : entry.deleted,
      device_id: "77".repeat(16), ts: 1000, manifest_ct: c.base64(packet.ciphertext), ...(suite === 2 ? { seal_suite: 2 } : { manifest_nonce: c.hex(packet.nonce) }) });
    heads.set(f, [...(heads.get(f) ?? []), v]); return [f, v];
  }
  async function note(f = file, { bytes = encoder.encode("rotation synthetic content"), parents = [], patch = {} } = {}) {
    const ch = suite === 2 ? await s.encryptChunk2(dk, { generation: old.generation, domainId: domain }, bytes) : await c.encryptChunk(dk, bytes);
    chunks.set(ch.sid, ch.ciphertext);
    const entry = { v: 1, path: "Notes/source.md", domain, size: bytes.length, mtime: 1200,
      chunks: [{ cid: c.hex(ch.cid), sid: ch.sid, len: bytes.length }], sha256: c.hex(await c.sha256(bytes)), deleted: false, ...patch };
    return { head: await add(f, entry, { parents }), entry, bytes };
  }
  const mapHead = await add(oldMap.fileId, dm.defaultDomainMap(domain), { kind: 2, key: oldMap.key, domainId: oldMap.domainId });
  const inventory = () => [...records.keys()].filter(key => heads.get(key.slice(0, 32))?.includes(key.slice(32))).map(key => [key.slice(0, 32), key.slice(32)]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  async function open(result, plan) {
    const key = result.newFile === next.generation ? newMap.key : await c.deriveManifestKey(await c.deriveDomainKey(next.root, plan.newDomainId), plan.newDomainId);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await s.openRecord(key, result.newFile === next.generation ? 2 : 1,
      { generation: next.generation, domainId: result.post.domain_id, fileId: result.newFile, parents: result.post.parents, sids: result.post.sids }, c.unbase64(result.post.manifest_ct))));
  }
  return { old, next, oldMap, newMap, dk, mk, records, chunks, heads, calls, io, add, note, mapHead, inventory, open };
}

for (const suite of [1, 2]) test(`explicit suite${suite} source reseals authenticated bytes and map deterministically`, async () => {
  const r = await fixture(suite), note = await r.note();
  assert.equal((await preflightRotationMap(r.io, r.old)).versionId, r.mapHead[1], "preflight must authenticate sole source map");
  const plan = await planRotationReseal(r.io, r.old, r.next, r.inventory());
  let result;
  await assert.doesNotReject(async () => { result = await plan.reseal(note.head); }, "rotation must seal honest authenticated source");
  const again = await plan.reseal(note.head), entry = await r.open(result, plan);
  assert.deepEqual(again, result, "reseal retry must produce identical destination post");
  assert.equal(result.post.seal_suite, 2, "rotation writer must declare suite2");
  assert.equal(Object.hasOwn(result.post, "manifest_nonce"), false, "rotation writer must omit legacy nonce");
  assert.deepEqual(result.post.parents, [], "rotation destination must have no old parents");
  assert.equal(result.post.accept_existing, false, "rotation must not deduplicate distinct source heads");
  assert.equal(entry.migration_origin, note.head.join(""), "migration pointer must retain exact old file and version");
  assert.deepEqual([entry.migration_origin.slice(0, 32), entry.migration_origin.slice(32)], note.head, "migration pointer must split into old identifiers");
  assert.equal(entry.path, note.entry.path, "rotation must preserve user path");
  assert.equal(entry.mtime, note.entry.mtime, "rotation must preserve modification time");
  const kd = await c.deriveDomainKey(r.next.root, plan.newDomainId);
  const plaintext = await s.decryptChunk2(kd, { generation: r.next.generation, domainId: plan.newDomainId }, c.unhex(entry.chunks[0].cid), r.chunks.get(entry.chunks[0].sid));
  assert.deepEqual(plaintext, note.bytes, "rotation must preserve authenticated plaintext");
  const calls = r.calls.filter(call => call[0] === "put");
  assert.ok(calls.length === 2 && calls.every(call => r.calls.some(x => x[0] === "chunk" && x[1] === call[1])), "rotation must read back every uploaded chunk");
  const mapResult = await plan.reseal(r.mapHead), map = await r.open(mapResult, plan);
  assert.deepEqual(map, dm.defaultDomainMap(plan.newDomainId), "rotation map must preserve paths and remap sole domain");
  assert.equal(mapResult.newFile, r.next.generation, "rotation map must use new root-derived reserved ID");
  assert.equal(plan.newDomainId, c.hex((await c.hmacSha256(r.newMap.key, c.utf8("obsync/seal-v2/rotation-domain")))).slice(0, 32), "rotation domain must use specified derivation");
  assert.equal(result.newFile, c.hex((await c.hmacSha256(await c.deriveManifestKey(kd, plan.newDomainId), c.concat(c.utf8("obsync/seal-v2/rotation-file\n"), c.unhex(file))))).slice(0, 32), "rotation file must use specified derivation");
});

test("identical-content forks remain distinct and folder pause retirement semantics survive", async () => {
  const r = await fixture();
  const a = await r.note(file, { parents: ["aa".repeat(32)] }), b = await r.note(file, { parents: ["bb".repeat(32)] });
  const keeper = await r.note(other);
  const retired = await r.add("66".repeat(16), { ...a.entry, chunks: [], size: 0, sha256: "", deleted: true, keeper: other, answer: true });
  const folderId = await c.folderFileId(r.mk, "Notes/empty"), folder = await r.add(folderId, { v: 2, kind: "directory", path: "Notes/empty", domain, size: 0, chunks: [], sha256: "", deleted: true });
  const pauseId = c.hex((await c.hmacSha256(r.mk, c.utf8(`obsync/v1/pause/${file}`))).subarray(0, 16));
  const pause = await r.add(pauseId, { v: 3, kind: "pause", path: a.entry.path, target: file, paused: true, domain, size: 0, chunks: [], sha256: "", deleted: false });
  const plan = await planRotationReseal(r.io, r.old, r.next, r.inventory());
  const x = await plan.reseal(a.head), y = await plan.reseal(b.head);
  assert.equal(x.newFile, y.newFile, "source forks must share remapped file identity");
  assert.notEqual(x.newVersion, y.newVersion, "identical-content source forks must retain distinct destination versions");
  assert.deepEqual(x.post.sids, y.post.sids, "fork distinction must not alter user chunks");
  const retiredResult = await plan.reseal(retired), retiredEntry = await r.open(retiredResult, plan);
  assert.equal(retiredEntry.keeper, plan.destination(keeper.head[0]), "retirement keeper must remap through frozen inventory");
  assert.equal(retiredEntry.answer, true, "rotation must preserve answer marker");
  assert.equal(retiredResult.post.deleted, true, "rotation must preserve tombstone semantics");
  assert.equal((await r.open(await plan.reseal(folder), plan)).kind, "directory", "rotation must preserve directory kind");
  assert.equal((await r.open(await plan.reseal(pause), plan)).target, plan.destination(file), "pause must target remapped note identity");
  assert.equal((await r.open(await plan.reseal(pause), plan)).paused, true, "rotation must preserve pause state");
});

test("preflight and frozen plan refuse absent conflicted or multidomain maps without writes", async () => {
  for (const suite of [1, 2]) {
    const r = await fixture(suite); r.heads.set(r.old.generation, []);
    await assert.rejects(preflightRotationMap(r.io, r.old), refusal("map_heads"), "absent map must refuse before prepare");
    r.heads.set(r.old.generation, [r.mapHead[1], "aa".repeat(32)]);
    await assert.rejects(preflightRotationMap(r.io, r.old), refusal("map_heads"), "conflicted map must refuse before prepare");
    await assert.rejects(planRotationReseal(r.io, r.old, r.next, [[r.old.generation, r.mapHead[1]], [r.old.generation, "ff".repeat(32)]]), refusal("map_heads"), "frozen map forks must refuse without selection");
    const head = await r.add(r.old.generation, { v: 1, domains: [{ id: domain, paths: [""] }, { id: other, paths: ["Extra"] }] }, { kind: 2, key: r.oldMap.key, domainId: r.oldMap.domainId });
    r.heads.set(r.old.generation, [head[1]]);
    await assert.rejects(preflightRotationMap(r.io, r.old), refusal("map_domains"), "multidomain map must refuse before prepare");
    assert.equal(r.calls.some(call => call[0] === "put"), false, "map refusals must publish no chunks");
  }
});

test("inventory is bounded sorted unique and reseal cannot select an outside head", async () => {
  const r = await fixture(), note = await r.note(), rows = r.inventory();
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, []), refusal("map_heads"), "frozen inventory must contain exactly one map");
  for (const invalid of [[...rows].reverse(), [rows[0], rows[0]], [[file]], [[file, "aa".repeat(32), "extra"]], [[file, "ZZ".repeat(32)]], Array.from({ length: 65537 }, (_, i) => [file, i.toString(16).padStart(64, "0")])]) {
    await assert.rejects(planRotationReseal(r.io, r.old, r.next, invalid), refusal("inventory"), "invalid frozen inventory must refuse");
  }
  const plan = await planRotationReseal(r.io, r.old, r.next, rows);
  await assert.rejects(plan.reseal([file, "ff".repeat(32)]), refusal("inventory"), "outside frozen head must refuse");
  assert.throws(() => plan.destination("ff".repeat(16)), refusal("reference"), "unknown source identity must refuse");
  r.records.set(r.mapHead.join(""), { ...r.records.get(r.mapHead.join("")), version_id: note.head[1] });
  await assert.rejects(plan.reseal(r.mapHead), refusal("record"), "frozen map reseal must revalidate exact source version");
});

test("strict source suite generation identity and manifest authentication refuse substitutions", async () => {
  const r = await fixture(), note = await r.note(), rows = r.inventory();
  await assert.rejects(planRotationReseal(r.io, { ...r.old, suite: 1 }, r.next, rows), refusal("record"), "explicit legacy scope must not accept suite2 records");
  await assert.rejects(planRotationReseal(r.io, { ...r.old, generation: "aa".repeat(16) }, r.next, rows), refusal("generation"), "old root must match declared generation");
  await assert.rejects(planRotationReseal(r.io, r.old, { ...r.next, generation: "aa".repeat(16) }, rows), refusal("generation"), "new root must match declared generation");
  await assert.rejects(planRotationReseal(r.io, r.old, { root: r.old.root, generation: r.old.generation }, rows), refusal("generation"), "rotation must change root-derived generation");
  const record = r.records.get(note.head.join("")); record.manifest_nonce = null;
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, rows), refusal("record"), "suite2 source must refuse mixed framing");
  delete record.manifest_nonce; record.manifest_ct = c.base64(new Uint8Array(20));
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, rows), refusal("version_identity"), "source record must match exact frozen version hash");
  const bad = await r.add(other, note.entry, { raw: new Uint8Array([255]) });
  r.heads.delete(file);
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("authentication"), "authenticated malformed UTF8 must refuse");
  assert.ok(bad[1], "malformed UTF8 control must be actual authenticated source record");
});

test("source chunk SID authentication length and hash are verified before writing", async () => {
  for (const mode of ["sid", "auth", "length", "hash"]) {
    const r = await fixture(), original = await r.note(), entry = structuredClone(original.entry);
    if (mode === "sid") r.chunks.set(entry.chunks[0].sid, new Uint8Array(20));
    if (mode === "auth") { const bad = new Uint8Array(r.chunks.get(entry.chunks[0].sid)); bad[0] ^= 1; const sid = c.hex(await c.sha256(bad)); r.chunks.set(sid, bad); entry.chunks[0].sid = sid; }
    if (mode === "length") { entry.chunks[0].len++; entry.size++; }
    if (mode === "hash") entry.sha256 = "ff".repeat(32);
    const head = await r.add(file, entry); r.heads.set(file, [head[1]]);
    const plan = await planRotationReseal(r.io, r.old, r.next, r.inventory());
    await assert.rejects(plan.reseal(head), refusal({ sid: "source_sid", auth: "source_chunk", length: "source_length", hash: "source_hash" }[mode]), `source ${mode} must refuse before upload`);
    assert.equal(r.calls.some(call => call[0] === "put"), false, "invalid source chunk must not publish bytes");
  }
});

test("new chunk readback refuses corrupt missing and oversized responses", async () => {
  for (const mode of ["corrupt", "missing", "oversized"]) {
    const r = await fixture(), note = await r.note(), get = r.io.getChunk, written = new Set();
    const put = r.io.putChunk; r.io.putChunk = async (sid, body) => { await put(sid, body); written.add(sid); };
    r.io.getChunk = async sid => written.has(sid) ? mode === "missing" ? new Uint8Array() : mode === "oversized" ? new Uint8Array((8 << 20) + 17) : new Uint8Array(20) : get(sid);
    const plan = await planRotationReseal(r.io, r.old, r.next, r.inventory());
    await assert.rejects(plan.reseal(note.head), refusal("readback_sid"), "unverified new chunk readback must refuse destination post");
    assert.equal(written.size, 1, "readback refusal fixture must reach actual upload");
  }
});

test("roots inventories and clear record scalars are snapshots across awaits", async (t) => {
  const r = await fixture(), note = await r.note(), rows = r.inventory(), oldRoot = new Uint8Array(r.old.root), newRoot = new Uint8Array(r.next.root);
  const promise = planRotationReseal(r.io, r.old, r.next, rows); r.old.root.fill(99); r.next.root.fill(99); rows[0][0] = "ff".repeat(16);
  let plan;
  await assert.doesNotReject(async () => { plan = await promise; }, "planning must snapshot roots and inventory before first await");
  r.old.root.set(oldRoot); r.next.root.set(newRoot);
  const result = await plan.reseal(note.head);
  assert.equal((await r.open(result, plan)).migration_origin, note.head.join(""), "planning must snapshot roots and inventory before first await");
  const raw = r.records.get(note.head.join("")), version = c.versionId;
  r.io.getVersion = async (f, v) => r.records.get(f + v);
  t.mock.method(c, "versionId", async (...args) => { const value = await version(...args); raw.bytes++; return value; });
  await assert.doesNotReject(plan.reseal(note.head), "record scalars must be snapshotted before hashing await");
});

test("external failures never expose message cause or custom properties", async () => {
  const r = await fixture(), note = await r.note(), secret = "diagnostic synthetic phrase sentinel";
  for (const error of [new Error(secret), Object.assign(new RotationResealError(secret), { cause: new Error(secret), detail: secret })]) {
    const io = { ...r.io, getVersion: async () => { throw error; } };
    try { await planRotationReseal(io, r.old, r.next, r.inventory()); assert.fail("external error must refuse"); }
    catch (failure) {
      assert.equal(failure.reason, "record", "external error must normalize to fixed record code");
      assert.equal(JSON.stringify(failure).includes(secret) || String(failure).includes(secret), false, "normalized error must not echo source values");
      assert.deepEqual(Object.keys(failure).sort(), ["name", "reason"], "normalized error must have no source cause or properties");
    }
  }
  const plan = await planRotationReseal(r.io, r.old, r.next, r.inventory()); r.io.putChunk = async () => { throw new Error(secret); };
  await assert.rejects(plan.reseal(note.head), refusal("upload_chunk"), "upload failure must normalize separately from source authentication");
});

test("migration pointer grammar is exact for files directories and pause records", async () => {
  const r = await fixture(), note = await r.note();
  const entries = [note.entry, { v: 2, kind: "directory", path: "Notes/empty", domain, size: 0, chunks: [], sha256: "", deleted: false },
    { v: 3, kind: "pause", path: "Notes/source.md", target: file, paused: false, domain, size: 0, chunks: [], sha256: "", deleted: false }];
  for (const entry of entries) {
    assert.equal(parseEntry(JSON.stringify({ ...entry, migration_origin: note.head.join("") })).migration_origin, note.head.join(""), "exact migration pointer must parse without changing value");
    for (const bad of [note.head[1], note.head.join("") + "00", "A".repeat(96), null, 1, { file, version: note.head[1] }])
      assert.throws(() => parseEntry(JSON.stringify({ ...entry, migration_origin: bad })), error => error.reason === "migration_origin", "malformed migration pointer must refuse for every kind");
  }
});

test("multi-chunk and empty content are authenticated with bounded chunk readbacks", async () => {
  const r = await fixture(), blocks = [new Uint8Array(8 << 20).fill(31), new Uint8Array([32])], descriptors = [];
  for (const block of blocks) { const chunk = await s.encryptChunk2(r.dk, { generation: r.old.generation, domainId: domain }, block); r.chunks.set(chunk.sid, chunk.ciphertext); descriptors.push({ cid: c.hex(chunk.cid), sid: chunk.sid, len: block.length }); }
  const entry = { v: 1, path: "Notes/large.bin", domain, size: blocks.reduce((sum, p) => sum + p.length, 0), mtime: 1000, chunks: descriptors, sha256: "", deleted: false };
  const head = await r.add(file, entry), empty = await r.note(other, { bytes: new Uint8Array() });
  const plan = await planRotationReseal(r.io, r.old, r.next, r.inventory()), result = await plan.reseal(head), mapped = await r.open(result, plan);
  assert.equal(mapped.chunks.length, 2, "rotation must preserve every large source chunk");
  const kd = await c.deriveDomainKey(r.next.root, plan.newDomainId);
  for (const [i, chunk] of mapped.chunks.entries()) assert.deepEqual(await s.decryptChunk2(kd, { generation: r.next.generation, domainId: plan.newDomainId }, c.unhex(chunk.cid), r.chunks.get(chunk.sid)), blocks[i], "large chunks must retain exact verified plaintext");
  assert.equal((await r.open(await plan.reseal(empty.head), plan)).chunks[0].len, 0, "empty file must retain authenticated zero-length chunk");
  assert.equal(r.calls.filter(call => call[0] === "put").length, 3, "all chunks including empty file must be uploaded and checked");
});

test("map clear fields source bindings and closed references are required", async () => {
  const r = await fixture(), mapRecord = r.records.get(r.mapHead.join("")), getFile = r.io.getFile;
  for (const patch of [{ file_id: file }, { domain_id: domain }]) {
    r.io.getFile = async f => ({ ...await getFile(f), ...patch });
    await assert.rejects(preflightRotationMap(r.io, r.old), refusal("map_heads"), "preflight map namespace must be root-derived");
  }
  r.io.getFile = getFile;
  for (const patch of [{ bytes: 1 }, { deleted: true }]) {
    Object.assign(mapRecord, patch);
    await assert.rejects(preflightRotationMap(r.io, r.old), refusal("map"), "source map must have exact empty undeleted shape");
    Object.assign(mapRecord, { bytes: 0, deleted: false });
  }
  const note = await r.note(file, { patch: { domain: other } });
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("manifest"), "source manifest must bind authoritative map domain");
  r.heads.delete(file);
  const unknown = await r.add(file, { ...note.entry, domain, chunks: [], size: 0, sha256: "", deleted: true, keeper: other });
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("reference"), "retirement cannot point outside frozen inventory");
  assert.ok(unknown[1], "closed reference fixture must contain valid authenticated source");
});

test("mapping collisions and inconsistent folder source identities refuse", async (t) => {
  const r = await fixture(); await r.note(); await r.note(other);
  const hmac = c.hmacSha256;
  t.mock.method(c, "hmacSha256", async (key, bytes) => new TextDecoder().decode(bytes).startsWith("obsync/seal-v2/rotation-file\n") ? new Uint8Array(32).fill(99) : hmac(key, bytes));
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("destination_collision"), "distinct source files must not share destination mapping");
  t.mock.restoreAll(); r.heads.delete(file); r.heads.delete(other);
  await r.add(file, { v: 2, kind: "directory", path: "Notes/folder", domain, size: 0, chunks: [], sha256: "", deleted: false });
  await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("source_identity"), "source folder ID must authenticate its path-derived identity");
});

test("source record schema and snapshots reject malformed scopes without IO", async () => {
  const r = await fixture(), note = await r.note(), valid = structuredClone(r.records.get(note.head.join("")));
  for (const patch of [{ bytes: -1 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { deleted: null }, { device_id: file + "00" }, { ts: -1 }, { parents: ["aa".repeat(32), "aa".repeat(32)] }, { sids: null }]) {
    r.records.set(note.head.join(""), { ...valid, ...patch });
    await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("record"), "source record schema must refuse malformed clear fields");
  }
  for (const old of [{ ...r.old, root: new Uint8Array(31) }, { ...r.old, suite: 3 }, { ...r.old, generation: "A".repeat(32) }, { ...r.old, root: new Uint8Array(new SharedArrayBuffer(32)) }]) {
    const before = r.calls.length;
    await assert.rejects(planRotationReseal(r.io, old, r.next, r.inventory()), refusal("scope"), "invalid source scope must refuse before IO");
    assert.equal(r.calls.length, before, "scope refusal must not access source server");
  }
});

test("source packet arrays and legacy framing stay inside protocol bounds", async () => {
  for (const suite of [1, 2]) {
    const r = await fixture(suite), note = await r.note(), valid = structuredClone(r.records.get(note.head.join("")));
    for (const patch of [{ parents: new Array(65).fill(0).map((_, i) => i.toString(16).padStart(64, "0")) }, { sids: new Array(65537).fill("aa".repeat(32)) }, { parents: ["AA".repeat(32)] }]) {
      r.records.set(note.head.join(""), { ...valid, ...patch });
      await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("record"), "source arrays must meet exact protocol limits before authentication");
    }
    if (suite === 1) for (const patch of [{ seal_suite: 2 }, { manifest_nonce: "ff".repeat(11) }, { manifest_ct: "AA==" }, { manifest_ct: "AAAA".repeat(10) + "AB==" }, { manifest_ct: "AAAA".repeat(262145) }]) {
      r.records.set(note.head.join(""), { ...valid, ...patch });
      await assert.rejects(planRotationReseal(r.io, r.old, r.next, r.inventory()), refusal("record"), "legacy source frame must be explicit canonical and bounded");
    }
  }
});

test("readback authentication and plaintext equality are separate checks", async (t) => {
  const r = await fixture(), note = await r.note(), plan = await planRotationReseal(r.io, r.old, r.next, r.inventory()), decrypt = s.decryptChunk2;
  t.mock.method(s, "decryptChunk2", async (key, scope, cid, body) => scope.generation === r.next.generation ? (() => { throw new Error("synthetic authentication refusal"); })() : decrypt(key, scope, cid, body));
  await assert.rejects(plan.reseal(note.head), refusal("readback_chunk"), "new readback must authenticate under destination scope");
  t.mock.restoreAll();
  t.mock.method(s, "decryptChunk2", async (key, scope, cid, body) => scope.generation === r.next.generation ? new Uint8Array(note.bytes.length) : decrypt(key, scope, cid, body));
  await assert.rejects(plan.reseal(note.head), refusal("readback_plaintext"), "verified readback must match just-authenticated source bytes");
});

test("large nonstreamable whole-file hash is refused and output manifest budget is enforced", async () => {
  const r = await fixture(), descriptors = [];
  for (const bytes of [new Uint8Array(8 << 20), new Uint8Array([1])]) {
    const ch = await s.encryptChunk2(r.dk, { generation: r.old.generation, domainId: domain }, bytes); r.chunks.set(ch.sid, ch.ciphertext); descriptors.push({ cid: c.hex(ch.cid), sid: ch.sid, len: bytes.length });
  }
  const large = { v: 1, path: "Notes/large.bin", domain, size: (8 << 20) + 1, mtime: 1000, chunks: descriptors, sha256: "aa".repeat(32), deleted: false };
  const head = await r.add(file, large), plan = await planRotationReseal(r.io, r.old, r.next, r.inventory());
  await assert.rejects(plan.reseal(head), refusal("source_hash"), "unsupported large whole-file digest must refuse before upload");
  assert.equal(r.calls.some(call => call[0] === "put"), false, "unsupported digest must not partially publish chunks");
  r.heads.delete(file);
  const entry = { ...large, chunks: [], size: 0, sha256: "", deleted: true, padding: "" };
  entry.padding = "x".repeat(786416 - encoder.encode(JSON.stringify(entry)).length);
  const bounded = await r.add(file, entry), nextPlan = await planRotationReseal(r.io, r.old, r.next, r.inventory());
  assert.equal(r.records.get(bounded.join("")).manifest_ct.length, 1048576, "budget fixture must meet exact accepted source packet ceiling");
  await assert.rejects(nextPlan.reseal(bounded), refusal("manifest_budget"), "rotation-added pointer must not exceed server manifest ceiling");
});
