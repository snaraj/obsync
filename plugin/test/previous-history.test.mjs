import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rig, openPublishedManifest } from "./fake.mjs";
const require = createRequire(import.meta.url);
const c = require("../build/crypto.js"), dm = require("../build/domainmap.js"), seal = require("../build/seal2.js");
const { HistoryBrowser, HistoryOperation, restoreCopy } = require("../build/sync/history.js");
const domain = "66".repeat(16), file = "67".repeat(16);

async function fixture(suite = 2) {
  const r = await rig(), root = new Uint8Array(32).fill(81), map = await dm.domainMapKeys(root);
  const dk = await c.deriveDomainKey(root, domain), mk = await c.deriveManifestKey(dk, domain);
  const previous = { root: c.hex(root), generation: map.fileId, suite };
  const bytes = c.utf8("OLD HISTORY PRIVATE SYNTHETIC CONTENT");
  const chunk = suite === 1 ? await c.encryptChunk(dk, bytes) : await seal.encryptChunk2(dk, { generation: map.fileId, domainId: domain }, bytes);
  r.server.chunks.set(chunk.sid, chunk.ciphertext);
  const entry = { v: 1, domain, path: "History/old.md", mtime: 1000, size: bytes.length, deleted: false,
    sha256: c.hex(await c.sha256(bytes)), chunks: [{ sid: chunk.sid, cid: c.hex(chunk.cid), len: bytes.length }] };
  async function add(f, value, parents = [], kind = 1) {
    const sids = kind === 2 ? [] : value.chunks.map(x => x.sid), key = kind === 2 ? map.key : mk, domainId = kind === 2 ? map.domainId : domain;
    const packet = suite === 1 ? await c.encryptManifest(key, f, await c.contentVersionId(f, parents, sids), JSON.stringify(value))
      : { ciphertext: await seal.sealRecord(key, kind, { generation: map.fileId, domainId, fileId: f, parents, sids }, c.utf8(JSON.stringify(value))) };
    const version = await c.versionId(f, parents, packet.ciphertext, sids);
    const record = { version_id: version, parents, sids, bytes: kind === 2 ? 0 : value.size, deleted: kind === 2 ? false : value.deleted,
      device_id: "68".repeat(16), ts: 1000, manifest_ct: c.base64(packet.ciphertext),
      ...(suite === 1 ? { manifest_nonce: c.hex(packet.nonce) } : { seal_suite: 2 }) };
    const stored = r.server.files.get(f) ?? { domain_id: domainId, heads: [], versions: [] };
    stored.heads = [version]; stored.versions.unshift(record); r.server.files.set(f, stored);
    return record;
  }
  await add(map.fileId, dm.defaultDomainMap(domain), [], 2);
  const first = await add(file, entry), head = await add(file, { ...entry, mtime: 2000 }, [first.version_id]);
  const currentChunk = await seal.encryptChunk2(r.keys.domainKey, { generation: r.context.generation, domainId: r.context.domainId }, new Uint8Array());
  r.server.chunks.set(currentChunk.sid, currentChunk.ciphertext);
  async function seed(pointer = file + head.version_id) {
    return r.server.publishManifest({ fileId: "69".repeat(16), manifest: { v: 1, path: entry.path, domain: r.context.domainId,
      mtime: 2000, size: 0, sha256: "", chunks: [{ sid: currentChunk.sid, cid: c.hex(currentChunk.cid), len: 0 }], deleted: false, migration_origin: pointer },
      parents: [], sids: [currentChunk.sid], bytes: 0, deviceId: "68".repeat(16), manifestKey: r.keys.manifestKey });
  }
  const current = await seed();
  return { ...r, previous, entry, bytes, chunk, first, head, current, seed, add,
    browser: (order = {}) => new HistoryBrowser(r.context, new HistoryOperation(), { previous, ...order }), map };
}

for (const suite of [1, 2]) test(`explicit suite${suite} history restores old bytes without changing live identity or current files`, async () => {
  const r = await fixture(suite), view = r.browser(), before = structuredClone(r.state.data);
  const page = await view.next("old.md");
  assert.equal(page.refused, 0, "honest selected suite must authenticate without refusals");
  assert.deepEqual(page.entries.map(x => x.versionId), [r.head.version_id, r.first.version_id], "previous history must walk authenticated source ancestry");
  assert.ok(page.entries.every(x => x.fileId === file && x.domainId === domain));
  assert.equal(view.done, true);
  let result;
  await assert.doesNotReject(async () => { result = await restoreCopy(view, page.entries[1]); }, "declared previous suite must authenticate honest restore");
  assert.deepEqual(await r.host.read(result.path), r.bytes, "previous restore must return exact authenticated old plaintext");
  assert.deepEqual(r.state.data, before, "previous-generation reads must not change live identity or sync catalog");
  assert.equal(await r.host.stat(r.entry.path), null, "restore must create a sibling, never overwrite historical path");
  assert.equal(r.server.requests.some(q => ["PUT", "POST", "DELETE"].includes(q.method)), false, "history may not publish remote data");
});

test("current history never falls back to an old key and previous history requires authenticated migration pointers", async () => {
  const r = await fixture();
  const current = await new HistoryBrowser(r.context, new HistoryOperation()).next();
  assert.deepEqual(current.entries.map(x => x.versionId), [r.current.version_id], "ordinary history must list only active-suite records");
  r.server.journal[0].manifest_ct = c.base64(new Uint8Array(32));
  const page = await r.browser().next("old.md");
  assert.deepEqual(page.entries, []); assert.equal(page.refused, 1);
  assert.equal(r.server.requests.some(q => q.target.includes(`/files/${file}/versions/`)), false,
    "unverified migration pointer must not cause an old-version read");
});

test("previous history validates its old map and refuses suite confusion without changing live keys", async () => {
  for (const mutation of [p => { p.root = "ab".repeat(32); }, p => { p.generation = "ab".repeat(16); }, p => { p.suite = 1; }]) {
    const r = await fixture(), before = structuredClone(r.state.data); mutation(r.previous);
    await assert.rejects(() => r.browser().next("old.md"), /rotation reseal refused/);
    assert.deepEqual(r.state.data, before);
  }
});

test("previous history authenticates each ancestor and deduplicates repeated migration pointers", async () => {
  const r = await fixture(); await r.seed();
  r.server.files.get(file).versions.find(x => x.version_id === r.first.version_id).manifest_ct = c.base64(new Uint8Array(32));
  const page = await r.browser().next("old.md");
  assert.equal(page.entries.length, 1, "invalid ancestor must not become a displayed history row"); assert.equal(page.entries[0].versionId, r.head.version_id);
  assert.equal(page.refused, 1);
  assert.equal(r.server.requests.filter(q => q.target.endsWith(`/versions/${r.head.version_id}`)).length, 1,
    "repeated migration pointers must not repeat old ancestry");
});

test("old history selection and chunks are reauthenticated before a copy is published", async () => {
  for (const mode of ["domain", "version", "path", "packet", "length", "hash"]) {
    const r = await fixture(1), view = r.browser(), page = await view.next("old.md"), entry = { ...page.entries[0] };
    if (mode === "domain") entry.domainId = r.context.domainId;
    if (mode === "version") entry.versionId = "ab".repeat(32);
    if (mode === "path") entry.path = "History/different.md";
    if (mode === "packet") r.server.chunks.set(r.chunk.sid, new Uint8Array(32));
    if (mode === "length" || mode === "hash") {
      const malformed = { ...r.entry, ...(mode === "length" ? { size: r.bytes.length + 1, chunks: [{ ...r.entry.chunks[0], len: r.bytes.length + 1 }] } : { sha256: "ab".repeat(32) }) };
      entry.versionId = (await r.add(file, malformed)).version_id;
    }
    await assert.rejects(() => restoreCopy(view, entry));
    assert.equal((await r.host.list()).length, 0, `${mode} must not publish any copy`);
  }
});

test("newest history follows empty filtered pages that advance within its window", async () => {
  const r = await fixture(), calls = [];
  r.transport.historyChanges = async (since, _control, limit) => {
    calls.push([since, limit]);
    if (limit === 1) return { seq: 1, head_seq: 3, changes: [] };
    if (since === 0) return { seq: 2, head_seq: 3, changes: [] };
    return { seq: 3, head_seq: 3, changes: [{ ...r.current, seq: 3 }] };
  };
  const page = await new HistoryBrowser(r.context, new HistoryOperation()).next();
  assert.equal(page.entries.length, 1, "an empty scoped page must not hide a later current-generation record");
  assert.ok(calls.some(([since]) => since === 2));
});

test("previous suite2 chunks require SID CID tag length and plaintext digest before publication", async () => {
  for (const mode of ["sid", "cid", "tag", "length", "hash"]) {
    const r = await fixture(2), view = r.browser(), page = await view.next("old.md"), selection = { ...page.entries[0] };
    const entry = structuredClone(r.entry);
    if (mode === "sid") r.server.chunks.set(r.chunk.sid, new Uint8Array(32));
    if (mode === "cid") entry.chunks[0].cid = "ab".repeat(32);
    if (mode === "tag") {
      const body = new Uint8Array(r.chunk.ciphertext); body[0] ^= 1;
      const sid = c.hex(await c.sha256(body)); r.server.chunks.set(sid, body); entry.chunks[0].sid = sid;
    }
    if (mode === "length") { entry.size++; entry.chunks[0].len++; }
    if (mode === "hash") entry.sha256 = "ab".repeat(32);
    if (mode !== "sid") selection.versionId = (await r.add(file, entry)).version_id;
    const message = mode === "sid" ? /History chunk identity mismatch/ : ["cid", "tag"].includes(mode) ? /History chunk authentication failed/ : /History content mismatch/;
    await assert.rejects(restoreCopy(view, selection), message, `suite2 ${mode} must refuse before copy publication`);
    assert.deepEqual(await r.host.list(), [], "invalid old chunk must leave local files untouched");
  }
});

test("both explicit suites bind old ciphertext to the exact selected immutable version", async () => {
  for (const suite of [1, 2]) {
    const r = await fixture(suite), view = r.browser(), page = await view.next("old.md"), selection = page.entries[0];
    const replacement = await r.add(file, { ...r.entry, mtime: 3000 }, r.head.parents);
    const record = r.server.files.get(file).versions.find(x => x.version_id === r.head.version_id);
    record.manifest_ct = replacement.manifest_ct;
    if (suite === 1) record.manifest_nonce = replacement.manifest_nonce;
    await assert.rejects(view.readSelection(selection), /History version identity mismatch/, "old ciphertext substitution must not change an immutable selected version");
    assert.deepEqual(await r.host.list(), [], "immutable selection refusal must open no copy");
  }
});

test("previous suite is selected explicitly and never inferred from a record", async () => {
  for (const [source, chosen] of [[1, 2], [2, 1]]) {
    const r = await fixture(source), view = r.browser();
    await view.next("old.md"); // Authenticate old map under its declared suite first.
    r.previous.suite = chosen; // Constructor snapshot must remain source, not this caller's object.
    const page = await view.next("old.md");
    assert.equal(page.entries.length, 0, "finished history must not reopen on caller scope mutation");
    let result;
    await assert.doesNotReject(async () => { result = await restoreCopy(view, { fileId: file, versionId: r.head.version_id, domainId: domain, path: r.entry.path, size: r.entry.size, ts: 1000, deleted: false }); }, "history browser must retain its captured explicit suite");
    assert.deepEqual(await r.host.read(result.path), r.bytes, "history browser must snapshot explicit suite before awaits");
    const wrong = new HistoryBrowser(r.context, new HistoryOperation(), { previous: { ...r.previous, suite: chosen } });
    await assert.rejects(wrong.next("old.md"), /rotation reseal refused/, "explicit wrong suite must refuse rather than try another decoder");
  }
});

test("authenticated records without origins cannot trigger previous generation reads", async () => {
  const r = await fixture(), original = r.server.journal[0], entry = await openPublishedManifest(original, r.keys.manifestKey);
  delete entry.migration_origin;
  r.server.journal.length = 0;
  await r.server.publishManifest({ fileId: original.file_id, manifest: entry, parents: [], sids: original.sids, bytes: 0, deviceId: "68".repeat(16), manifestKey: r.keys.manifestKey });
  const page = await r.browser().next("old.md");
  assert.deepEqual(page.entries, [], "authenticated no-origin record must not expose unrelated old history");
  assert.equal(page.refused, 0, "missing optional origin must not count as corrupted ciphertext");
  assert.equal(r.server.requests.some(q => q.target.includes(`/files/${file}`)), false, "no-origin record must not fetch any old note");
});

test("old domain and current folder selection bind before writer creation", async () => {
  for (const mode of ["domain", "path", "selection"]) {
    const r = await fixture(), view = r.browser(), page = await view.next("old.md"), selected = { ...page.entries[0] };
    let writers = 0; const create = r.host.createWriter.bind(r.host);
    r.host.createWriter = (...args) => { writers++; return create(...args); };
    if (mode === "domain") selected.domainId = r.context.domainId;
    if (mode === "path") selected.path = "History/other.md";
    if (mode === "selection") r.state.data.syncFolders = ["Selected"];
    await assert.rejects(restoreCopy(view, selected), undefined, `old ${mode} selection must refuse before writer creation`);
    assert.equal(writers, 0, "unbound historical selection must never create a writer");
  }
});

test("actual shared ancestry is visited once across distinct authenticated migration origins", async () => {
  const r = await fixture(), sibling = await r.add(file, { ...r.entry, mtime: 3000 }, [r.first.version_id]);
  await r.seed(file + sibling.version_id);
  const page = await r.browser().next("old.md");
  assert.deepEqual(new Set(page.entries.map(x => x.versionId)), new Set([r.head.version_id, sibling.version_id, r.first.version_id]), "both fork heads and their shared ancestor must remain visible");
  assert.equal(page.entries.length, 3, "shared authenticated ancestor must appear only once");
  assert.equal(r.server.requests.filter(q => q.target.endsWith(`/versions/${r.first.version_id}`)).length, 1, "shared authenticated ancestor must be fetched only once");
});

test("previous ancestry traversal admits exact cap and refuses one more authenticated pointer", async () => {
  // Seed the counter boundary directly; the final pointer still comes from an actual authenticated current record.
  for (const count of [65535, 65536]) {
    const r = await fixture(), view = r.browser();
    for (let i = 0; i < count; i++) view.visited.add("ff".repeat(16) + i.toString(16).padStart(64, "0"));
    if (count === 65535) {
      await assert.doesNotReject(view.next(), "exact traversal cap must admit its final authenticated origin");
      assert.equal(view.visited.size, 65536, "exact traversal cap must account for authenticated origin");
      await assert.rejects(view.next("old.md"), /65,536-version limit/, "old ancestry must propagate its traversal cap refusal");
    } else {
      await assert.rejects(view.next(), /65,536-version limit/, "one additional authenticated origin must refuse at traversal cap");
      assert.equal(r.server.requests.some(q => q.target.includes(`/files/${file}`)), false, "over-cap history must refuse before old fetch");
    }
  }
});

for (const newestFirst of [true, false]) test(`previous history follows advancing empty scoped pages (${newestFirst ? "newest" : "oldest"})`, async () => {
  const r = await fixture(), calls = [];
  r.transport.historyChanges = async (since, _control, limit) => {
    calls.push([since, limit]);
    if (limit === 1) return { seq: 1, head_seq: 3, changes: [] };
    return since === 0 ? { seq: 2, head_seq: 3, changes: [] } : { seq: 3, head_seq: 3, changes: [{ ...r.current, seq: 3 }] };
  };
  const page = await r.browser({ newestFirst }).next("old.md");
  assert.deepEqual(page.entries.map(x => x.versionId), [r.head.version_id, r.first.version_id], "empty scoped current pages must not hide authenticated old ancestry");
  assert.ok(calls.some(([since]) => since === 2), "history must advance through empty filtered page cursor");
});

test("previous restore uses create-only writer and leaves a concurrent occupant intact", async () => {
  const r = await fixture(), view = r.browser(), page = await view.next("old.md"), writer = r.host.writer.bind(r.host);
  const occupant = c.utf8("CONCURRENT OCCUPANT SYNTHETIC CONTENT"); let destination, aborts = 0;
  r.host.writer = async (...args) => {
    destination = args[0]; const temporary = await writer(...args);
    return { ...temporary, abort: async () => { aborts++; return temporary.abort(); } };
  };
  const getChunk = r.transport.getChunk.bind(r.transport);
  r.transport.getChunk = async (...args) => {
    const bytes = await getChunk(...args);
    r.host.seed(destination, occupant, 9000); // After either writer opens, before its commit.
    return bytes;
  };
  await assert.rejects(restoreCopy(view, page.entries[0]), /destination exists/, "historical copy must refuse concurrent destination collision");
  assert.deepEqual(await r.host.read(destination), occupant, "historical copy must preserve concurrent occupant bytes");
  assert.equal(aborts, 1, "failed historical copy must abort owned temporary writer");
  assert.equal(await r.host.stat(r.entry.path), null, "failed copy must leave original historical path absent");
});

test("tracked paths and late policy changes block previous copy commit", async () => {
  for (const mode of ["tracked", "policy"]) {
    const r = await fixture(), view = r.browser(), page = await view.next("old.md"), create = r.host.createWriter.bind(r.host);
    let destination, commits = 0, aborts = 0;
    r.host.createWriter = async (...args) => {
      destination = args[0]; const writer = await create(...args);
      return { ...writer, write: async bytes => { await writer.write(bytes);
        if (mode === "tracked") r.state.setFile(destination, { fileId: "ab".repeat(16), versionId: "ab".repeat(32), size: 0, mtime: 1000, sha256: "" });
        else r.state.data.policy.perFileMaxBytes = 1;
      }, commit: async (...values) => { commits++; return writer.commit(...values); }, abort: async () => { aborts++; return writer.abort(); } };
    };
    await assert.rejects(restoreCopy(view, page.entries[0]), undefined, `late ${mode} change must refuse copy commit`);
    assert.equal(commits, 0, "late authority change must refuse before commit dispatch");
    assert.equal(aborts, 1, "late refusal must abort owned historical temporary writer");
    assert.equal(await r.host.stat(destination), null, "late refusal must publish no historical copy");
  }
});

test("current ciphertext replacement cannot substitute an authenticated immutable migration origin", async () => {
  const r = await fixture(), original = r.server.journal[0], substitute = await r.seed(file + r.first.version_id);
  original.manifest_ct = substitute.manifest_ct; // Both packets authenticate in the same context; only the version hash distinguishes them.
  r.server.journal.pop();
  const page = await r.browser().next("old.md");
  assert.deepEqual(page.entries, [], "immutable current ciphertext substitution must not seed old ancestry");
  assert.equal(page.refused, 1, "immutable origin substitution must report refusal");
  assert.equal(r.server.requests.some(q => q.target.includes(`/files/${file}/versions/`)), false, "unverified immutable origin must not cause any old-version fetch");
});

test("previous multi-chunk whole-file digests refuse before any copy publication", async () => {
  const r = await fixture(), chunks = [];
  for (const bytes of [new Uint8Array(8 << 20).fill(37), new Uint8Array([38])]) {
    const dk = await c.deriveDomainKey(c.unhex(r.previous.root), domain);
    const chunk = await seal.encryptChunk2(dk, { generation: r.previous.generation, domainId: domain }, bytes);
    r.server.chunks.set(chunk.sid, chunk.ciphertext); chunks.push({ sid: chunk.sid, cid: c.hex(chunk.cid), len: bytes.length });
  }
  const version = await r.add(file, { ...r.entry, size: (8 << 20) + 1, chunks, sha256: "ab".repeat(32) });
  const view = r.browser();
  await assert.rejects(restoreCopy(view, { fileId: file, versionId: version.version_id, domainId: domain, path: r.entry.path, size: (8 << 20) + 1, deleted: false, ts: 1000 }), /unsupported whole-file digest check/, "unsupported retained whole-file digest must refuse publication");
  assert.deepEqual(await r.host.list(), [], "unsupported retained digest must not publish a partial copy");
});
