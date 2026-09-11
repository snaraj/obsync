import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig, FakeTimers } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { HistoryBrowser, HistoryOperation, historyManifest, restoreCopy, restoreCopyPath } = require("../build/sync/history.js");
const { Transport, HISTORY_RESPONSE_BYTES } = require("../build/transport.js");
const { pushFile } = require("../build/sync/push.js");
const { SyncEngine } = require("../build/sync/engine.js");
const c = require("../build/crypto.js");
const enc = (text) => new TextEncoder().encode(text);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function promptly(work) {
  const late = Symbol("still pending");
  const result = await Promise.race([work.then((value) => ({ value }), (error) => ({ error })), new Promise((resolve) => setImmediate(() => resolve(late)))]);
  assert.notEqual(result, late, "logical cancellation did not settle before the next event-loop turn");
  if (result.error) throw result.error;
  return result.value;
}
const response = (value, status = 200) => ({ status, text: JSON.stringify(value), headers: {}, arrayBuffer: new ArrayBuffer(0) });

async function note(r, path = "Notes/note.md", text = "HISTORY SENTINEL", fileId = "31".repeat(16), parents = []) {
  return r.server.publish({ fileId, path, bytes: enc(text), mtime: 1000, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, parents });
}
const entry = (record, path = "Notes/note.md") => ({ fileId: record.file_id, versionId: record.version_id, domainId: record.domain_id, path, size: record.bytes, ts: record.ts, deleted: record.deleted });
const browser = (r, operation = new HistoryOperation(), now) => new HistoryBrowser(r.context, operation, now);

test("history pages include deleted-note content beyond the file-view cap without touching sync state", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  r.state.data.lastSeq = 99;
  const map = r.server.files.get(r.context.mapFileId);
  r.server.journal.push({ ...map.versions[0], file_id: r.context.mapFileId, heads: map.heads, conflicted: false });
  let previous;
  for (let i = 0; i < 23; i++) previous = await note(r, "Notes/note.md", `VERSION ${i}`, undefined, previous ? [previous.version_id] : []);
  await r.server.publishTombstone({ fileId: previous.file_id, path: "Notes/note.md", manifestKey: r.keys.manifestKey, parents: [previous.version_id] });
  await note(r, "Admin/deploy.sh", "EXCLUDED SENTINEL", "32".repeat(16));
  r.host.list = r.host.stat = r.host.read = r.host.createWriter = async () => assert.fail("browsing performed local I/O");
  const before = structuredClone(r.state.data);
  const view = browser(r);
  const first = await view.next();
  assert.equal(first.scanned, 20);
  assert.equal(first.entries.length, 19, "the domain map is skipped");
  assert.equal(first.refused, 0, "the reserved map is skipped before manifest handling");
  assert.equal(view.done, false);
  const second = await view.next();
  const entries = [...first.entries, ...second.entries];
  assert.equal(entries.length, 24);
  assert.equal(entries.filter((row) => row.deleted).length, 1);
  assert.equal(second.refused, 1);
  assert.equal(view.done, true);
  assert.deepEqual(r.state.data, before);
  assert.equal(r.server.requests.filter((q) => q.target.startsWith("/v1/files/")).length, 0, "no capped/wide file record");
  assert.ok(r.server.requests.filter((q) => q.target.startsWith("/v1/changes")).every((q) => q.target.endsWith("wait=0&limit=1")));
});

test("the captured history boundary excludes later versions and the time budget pauses a scan", async () => {
  const r = await rig();
  await note(r);
  await note(r, "Notes/retired.md", "RETAINED", "33".repeat(16));
  const original = r.transport.historyChanges.bind(r.transport);
  let calls = 0;
  r.transport.historyChanges = async (...args) => {
    const page = await original(...args);
    if (++calls === 1) {
      await note(r, "Notes/late.md", "LATE", "32".repeat(16));
      r.server.journal = r.server.journal.filter((row) => row.seq !== 3); // retention gap
    }
    return page;
  };
  const view = browser(r, new HistoryOperation(), () => calls * 6000);
  assert.equal((await view.next()).scanned, 1);
  assert.equal(view.done, false);
  const next = await view.next();
  assert.equal(next.entries.length, 0, "record above the captured head is discarded");
  assert.equal(view.done, true);
  assert.equal(calls, 2);
});

for (const [label, page] of [
  ["stalled", { seq: 0, head_seq: 1, changes: [] }],
  ["negative", { seq: -1, head_seq: 1, changes: [] }],
  ["unsafe integer", { seq: 2 ** 54, head_seq: 2 ** 54, changes: [] }],
  ["past head", { seq: 2, head_seq: 1, changes: [] }],
  ["oversized page", { seq: 2, head_seq: 2, changes: [{ seq: 1 }, { seq: 2 }] }],
  ["record past cursor", { seq: 1, head_seq: 1, changes: [{ seq: 2 }] }],
  ["record at cursor", { seq: 1, head_seq: 1, changes: [{ seq: 0 }] }],
]) test(`history refuses ${label} cursor/envelope`, async () => {
  const r = await rig();
  r.transport.historyChanges = async () => page;
  await assert.rejects(browser(r).next(), /history (cursor|sequence)/i);
  assert.equal(r.state.data.lastSeq, 0);
});

test("history returns earlier rows on a later read failure and retries at the unconsumed cursor", async () => {
  const r = await rig();
  await note(r);
  await note(r, "Notes/second.md", "SECOND", "32".repeat(16));
  const original = r.transport.historyChanges.bind(r.transport);
  let fail = true;
  r.transport.historyChanges = async (cursor, ...args) => {
    if (cursor === 2 && fail) { fail = false; throw new Error("READ SENTINEL"); }
    return original(cursor, ...args);
  };
  const view = browser(r);
  const first = await view.next();
  assert.deepEqual(first.entries.map((e) => e.path), ["Notes/note.md"]);
  assert.match(first.error, /READ SENTINEL/);
  assert.deepEqual((await view.next()).entries.map((e) => e.path), ["Notes/second.md"]);
});

test("cross-page cursor/head regressions are refused, and empty filtered batches remain resumable", async () => {
  for (const field of ["seq", "head_seq"]) {
    const r = await rig();
    const view = browser(r, new HistoryOperation(), (() => { let n = 0; return () => n++ * 6000; })());
    r.transport.historyChanges = async () => ({ seq: 2, head_seq: 4, changes: [] });
    assert.equal((await view.next()).scanned, 1);
    r.transport.historyChanges = async () => ({ seq: 3, head_seq: 4, changes: [], [field]: field === "seq" ? 1 : 3 });
    await assert.rejects(view.next(), /cursor/);
    assert.equal(r.state.data.lastSeq, 0);
  }
  const r = await rig();
  for (let i = 0; i < 21; i++) await note(r, `Notes/note-${i}.md`, `VERSION ${i}`);
  const view = browser(r);
  const first = await view.next("note-20");
  assert.equal(first.scanned, 20);
  assert.deepEqual(first.entries, []);
  assert.equal(view.done, false);
  assert.equal((await view.next("NOTE-20")).entries[0].path, "Notes/note-20.md");
  assert.equal(view.done, true);
  assert.equal((await view.next()).scanned, 0, "completed scans issue no further request");
});

test("authenticated paths still obey the row display budget", async () => {
  const r = await rig();
  const record = await note(r, `Notes/${"a".repeat(4097)}.md`);
  await assert.rejects(historyManifest(r.context, record.file_id, record.domain_id, record.version_id, record), /path budget/);
  const page = await browser(r).next();
  assert.equal(page.entries.length, 0);
  assert.equal(page.refused, 1);
});

test("manual cancellation detaches promptly but blocks reopened reads until the same request settles", async () => {
  const r = await rig();
  const pending = deferred(), issued = deferred();
  let calls = 0;
  r.transport.options.request = async () => { calls++; issued.resolve(); return pending.promise; };
  const op = new HistoryOperation();
  const read = r.transport.historyChanges(0, op);
  await issued.promise;
  op.cancel();
  await assert.rejects(promptly(read), /cancelled/);
  for (let i = 0; i < 3; i++) await assert.rejects(promptly(r.transport.historyChanges(0, new HistoryOperation())), /previous history request/);
  assert.equal(calls, 1);
  pending.resolve(response({ seq: 0, head_seq: 0, changes: [] }));
  await new Promise(setImmediate);
  await r.transport.historyChanges(0, new HistoryOperation());
  assert.equal(calls, 2);
});

test("manual reads never retry, refuse excessive buffered responses, and cancel before sending", async () => {
  const r = await rig();
  let calls = 0;
  r.transport.options.request = async () => { calls++; return response({}, 503); };
  await assert.rejects(r.transport.historyChanges(0, new HistoryOperation()), /unreachable/);
  assert.equal(calls, 1);
  for (const payload of [
    { ...response({}), text: "x".repeat(HISTORY_RESPONSE_BYTES + 1) },
    { ...response({}), arrayBuffer: new ArrayBuffer(HISTORY_RESPONSE_BYTES + 1) },
    { ...response({}), text: "é".repeat(HISTORY_RESPONSE_BYTES / 2 + 1) },
  ]) {
    r.transport.options.request = async () => payload;
    const utf8 = c.utf8;
    c.utf8 = (text) => { assert.ok(text.length <= HISTORY_RESPONSE_BYTES, "oversized text was copied before its length check"); return utf8(text); };
    try { await assert.rejects(r.transport.historyChanges(0, new HistoryOperation()), /response_too_large/); }
    finally { c.utf8 = utf8; }
  }
  const cancelled = new HistoryOperation();
  cancelled.cancel();
  r.transport.options.request = async () => assert.fail("cancelled operation sent a request");
  await assert.rejects(r.transport.historyChanges(0, cancelled), /cancelled/);
});

test("cancellation during signing cannot send a late request", async () => {
  const r = await rig();
  const entered = deferred(), release = deferred();
  const sign = c.signRequest;
  c.signRequest = async (...args) => { entered.resolve(); await release.promise; return sign(...args); };
  const op = new HistoryOperation();
  r.transport.options.request = async () => assert.fail("cancelled signing emitted a request");
  try {
    const read = r.transport.historyChanges(0, op);
    await entered.promise;
    const underlying = r.transport.manualRead;
    op.cancel();
    await assert.rejects(promptly(read), /cancelled/);
    release.resolve();
    await assert.rejects(underlying, /cancelled/);
  } finally { release.resolve(); c.signRequest = sign; }
});

test("exact selected-version verification refuses substituted identities and malformed metadata", async () => {
  const r = await rig();
  const record = await note(r);
  assert.equal((await historyManifest(r.context, record.file_id, record.domain_id, record.version_id, record)).path, "Notes/note.md");
  for (const patch of [
    { version_id: "11".repeat(32) }, { parents: ["11"] }, { sids: ["bad"] }, { bytes: -1 },
    { bytes: 2 ** 54 }, { ts: -1 }, { device_id: "invalid" }, { deleted: "false" },
    { manifest_nonce: "ff" }, { manifest_ct: 1 }, { manifest_ct: "A".repeat(1024 * 1024 + 1) },
    { parents: new Array(65).fill("11".repeat(32)) }, { sids: new Array(65_537).fill("11".repeat(32)) },
    { sids: ["zz".repeat(32)] },
  ]) await assert.rejects(historyManifest(r.context, record.file_id, record.domain_id, record.version_id, { ...record, ...patch }), /Invalid history version/);
  await assert.rejects(historyManifest(r.context, record.file_id, record.domain_id, record.version_id, { ...record, parents: ["11".repeat(32)] }), /identity mismatch/);
  await assert.rejects(historyManifest(r.context, record.file_id, "11".repeat(16), record.version_id, record), /domain/);
  for (const value of [null, [], "record"]) {
    await assert.rejects(historyManifest(r.context, record.file_id, record.domain_id, record.version_id, value), /Invalid history record/);
    r.transport.historyChanges = async () => value;
    await assert.rejects(browser(r).next(), /Invalid history record/);
  }
  for (const args of [["zz".repeat(16), record.domain_id, record.version_id], [record.file_id, "zz".repeat(16), record.version_id], [record.file_id, record.domain_id, "zz".repeat(32)]]) {
    await assert.rejects(historyManifest(r.context, ...args, record), /Invalid history version/);
  }
});

test("multi-chunk restore uses bounded verified batches and ordinary engine reconciliation uploads the new copy", async () => {
  const r = await rig();
  const chunks = [], original = [];
  for (let i = 0; i < 5; i++) {
    const plaintext = new Uint8Array(2 << 20).fill(i);
    original.push(plaintext);
    const { cid, sid, ciphertext } = await c.encryptChunk(r.keys.domainKey, plaintext);
    r.server.chunks.set(sid, ciphertext);
    chunks.push({ cid: c.hex(cid), sid, len: plaintext.length });
  }
  const manifest = { v: 1, path: "Notes/attachment.bin", size: 10 << 20, mtime: 1000,
    domain: r.context.domainId, chunks, sha256: "", deleted: false };
  const version = await r.server.publishManifest({ fileId: "31".repeat(16), manifest, sids: chunks.map((v) => v.sid), parents: [], deviceId: "ff".repeat(16), manifestKey: r.keys.manifestKey, bytes: manifest.size });
  const parts = [];
  const create = r.host.createWriter.bind(r.host);
  r.host.createWriter = async (...args) => {
    const writer = await create(...args);
    return { ...writer, write: async (part) => { parts.push(part.length); await writer.write(part); } };
  };
  const stat = await restoreCopy(browser(r), entry(version, manifest.path));
  assert.deepEqual(parts, new Array(5).fill(2 << 20));
  assert.deepEqual(Buffer.from(r.host.files.get(stat.path).bytes), Buffer.concat(original));
  const batches = r.server.requests.filter((q) => q.target === "/v1/chunks/get");
  assert.equal(batches.length, 1);
  assert.equal(JSON.parse(batches[0].json).sids.length, 4);
  const timers = new FakeTimers();
  const feed = deferred();
  r.transport.changes = async () => feed.promise;
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers });
  try {
    await engine.start();
    await timers.run(1000, () => r.state.fileByPath(stat.path) !== undefined);
    assert.notEqual(r.state.fileByPath(stat.path).fileId, version.file_id);
    assert.deepEqual(r.server.files.get(r.state.fileByPath(stat.path).fileId).versions[0].parents, []);
  } finally { engine.stop(); feed.resolve({ seq: r.server.seq, head_seq: r.server.seq, changes: [] }); await engine.stopAndWait(); }
});

test("restore preserves unsynced original bytes and history, then ordinary push uses a fresh identity", async () => {
  const r = await rig();
  const record = await note(r);
  const tombstone = await r.server.publishTombstone({ fileId: record.file_id, path: "Notes/note.md", manifestKey: r.keys.manifestKey, parents: [record.version_id] });
  r.host.seed("Notes/note.md", "UNSYNCED LOCAL SENTINEL");
  const original = structuredClone(r.server.files.get(record.file_id));
  const stat = await restoreCopy(browser(r), entry(record));
  assert.equal(r.host.text(stat.path), "HISTORY SENTINEL");
  assert.equal(r.host.text("Notes/note.md"), "UNSYNCED LOCAL SENTINEL");
  assert.equal(r.context.written.size, 0);
  assert.equal(r.state.fileByPath(stat.path), undefined);
  await pushFile(r.context, stat.path);
  assert.notEqual(r.state.fileByPath(stat.path).fileId, record.file_id);
  assert.deepEqual(r.server.files.get(r.state.fileByPath(stat.path).fileId).versions[0].parents, []);
  assert.deepEqual(r.server.files.get(record.file_id), original);
  await assert.rejects(restoreCopy(browser(r), entry(tombstone)), /content version/);
});

test("restore scope and both device policies refuse before a writer, including final local growth", async () => {
  for (const scenario of ["scope", "per_file", "budget", "growth", "policy_change"]) {
    const r = await rig();
    r.state.data.syncFolders = ["Notes"];
    const record = await note(r);
    let created = 0;
    const original = r.host.createWriter.bind(r.host);
    r.host.createWriter = async (...args) => { created++; return original(...args); };
    if (scenario === "scope") r.state.data.syncFolders = [];
    if (scenario === "per_file") r.state.data.policy.perFileMaxBytes = 1;
    if (scenario === "budget") { r.state.data.policy.totalBudgetBytes = record.bytes; r.host.seed("Notes/local.md", "LOCAL"); }
    if (scenario === "growth" || scenario === "policy_change") {
      r.state.data.policy.totalBudgetBytes = record.bytes;
      const get = r.transport.getChunk.bind(r.transport);
      r.transport.getChunk = async (...args) => {
        const result = await get(...args);
        if (scenario === "growth") r.host.seed("Notes/new-unsynced.md", "LOCAL");
        else r.state.data.policy.perFileMaxBytes = 1;
        return result;
      };
    }
    await assert.rejects(restoreCopy(browser(r), entry(record)), /scope|ceiling|budget/);
    if (scenario === "scope") assert.equal(r.server.requests.length, 0, "excluded selections cannot issue even the version read");
    assert.equal(created, scenario === "growth" || scenario === "policy_change" ? 1 : 0);
    assert.ok([...r.host.files.keys()].every((p) => !p.includes("restored-")));
  }
});

test("inventory skips excluded metadata, and selection verification refuses a different historical path", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const record = await note(r);
  r.host.seed("Admin/deploy.sh", "EXCLUDED SENTINEL");
  for (const method of ["stat", "syncable"]) {
    const original = r.host[method].bind(r.host);
    r.host[method] = async (path) => { assert.ok(!path.startsWith("Admin/"), "excluded inventory metadata was accessed"); return original(path); };
  }
  await assert.rejects(restoreCopy(browser(r), entry(record, "Notes/other.md")), /content version/);
  await assert.rejects(restoreCopy(browser(r), { ...entry(record), domainId: "99".repeat(16) }), /Invalid history selection/);
  await restoreCopy(browser(r), entry(record));
  assert.equal(r.host.text("Admin/deploy.sh"), "EXCLUDED SENTINEL");
});

test("a stale remembered or remote-only destination is never adopted, removed or overwritten", async () => {
  const r = await rig();
  const record = await note(r);
  const random = c.randomBytes;
  c.randomBytes = (length) => new Uint8Array(length);
  try {
    const path = restoreCopyPath("Notes/note.md");
    const stale = { fileId: "99".repeat(16), versionId: "99".repeat(32), mtime: 1, size: 0, sha256: "" };
    r.state.setFile(path, stale);
    await assert.rejects(restoreCopy(browser(r), entry(record)), /unoccupied, untracked/);
    assert.deepEqual(r.state.fileByPath(path), stale);
    r.state.forgetPath(path);
    r.state.data.remoteOnly[stale.fileId] = { path, size: 1 };
    await assert.rejects(restoreCopy(browser(r), entry(record)), /unoccupied, untracked/);
    assert.deepEqual(r.state.data.remoteOnly[stale.fileId], { path, size: 1 });
    delete r.state.data.remoteOnly[stale.fileId];
    const stat = await restoreCopy(browser(r), entry(record));
    assert.equal(stat.path, path, "positive control: an untracked absent destination succeeds");
  } finally { c.randomBytes = random; }
});

test("a remembered destination appearing during download is refused before publication", async () => {
  const r = await rig();
  const record = await note(r);
  const create = r.host.createWriter.bind(r.host), get = r.transport.getChunk.bind(r.transport);
  let target;
  const stale = { fileId: "99".repeat(16), versionId: "99".repeat(32), mtime: 1, size: 0, sha256: "" };
  r.host.createWriter = async (path, ...args) => { target = path; return create(path, ...args); };
  r.transport.getChunk = async (...args) => { const bytes = await get(...args); r.state.setFile(target, stale); return bytes; };
  await assert.rejects(restoreCopy(browser(r), entry(record)), /already tracked/);
  assert.deepEqual(r.state.fileByPath(target), stale);
  assert.equal(r.host.files.size, 0);
});

test("unmeasurable individual local sizes refuse admission without offsetting positive bytes", async () => {
  for (const size of [-1, Number.NaN, 2 ** 54]) {
    const r = await rig();
    const record = await note(r);
    r.host.seed("Notes/positive.md", "POSITIVE");
    r.host.seed("Notes/unmeasurable.md", "LOCAL");
    const stat = r.host.stat.bind(r.host);
    r.host.stat = async (path) => path.endsWith("unmeasurable.md") ? { path, mtime: 1, size } : stat(path);
    r.host.createWriter = async () => assert.fail("unmeasurable inventory admitted a writer");
    await assert.rejects(restoreCopy(browser(r), entry(record)), /not measurable/);
  }
});

test("inventory skips unrepresentable paths and refuses an unsafe cumulative byte count", async () => {
  for (const scenario of ["unrepresentable", "overflow"]) {
    const r = await rig();
    const record = await note(r);
    r.host.seed("Notes/first.md", "ONE");
    r.host.seed("Notes/second.md", "TWO");
    const stat = r.host.stat.bind(r.host), syncable = r.host.syncable.bind(r.host);
    if (scenario === "unrepresentable") {
      r.host.syncable = async (path) => path === "Notes/second.md" ? false : syncable(path);
      r.host.stat = async (path) => { assert.notEqual(path, "Notes/second.md", "unrepresentable metadata was accessed"); return stat(path); };
      await restoreCopy(browser(r), entry(record));
    } else {
      r.host.stat = async (path) => ({ ...await stat(path), size: Number.MAX_SAFE_INTEGER });
      r.host.createWriter = async () => assert.fail("unsafe aggregate admitted a writer");
      await assert.rejects(restoreCopy(browser(r), entry(record)), /not measurable/);
    }
  }
});

test("zero-byte content restores and derived names stay bounded beside the original", async () => {
  const r = await rig();
  const record = await note(r, "Notes/empty.md", "");
  const stat = await restoreCopy(browser(r), entry(record, "Notes/empty.md"));
  assert.equal(stat.size, 0);
  assert.equal(r.host.text(stat.path), "");
  for (const name of ["Notes/note.md", "Notes/noextension", `Notes/${"é".repeat(220)}.md`, `Notes/${"📝".repeat(120)}.md`]) {
    const path = restoreCopyPath(name, "0".repeat(32));
    assert.ok(path.startsWith("Notes/"));
    assert.ok(enc(path.slice(6)).length <= 240);
    assert.equal(new TextDecoder().decode(enc(path)), path, "truncation preserves complete Unicode characters");
    assert.ok(path.includes("restored-"));
    if (name.endsWith(".md")) assert.ok(path.endsWith(".md"));
  }
  assert.throws(() => restoreCopyPath(`Notes/a.${"x".repeat(240)}`), /too long/);
});

test("failures after publication name and preserve the completed local copy", async () => {
  for (const phase of ["cleanup", "receipt"]) {
    const r = await rig();
    const record = await note(r);
    let target;
    const create = r.host.createWriter.bind(r.host);
    r.host.createWriter = async (path, ...args) => {
      target = path;
      const writer = await create(path, ...args);
      return { ...writer, abort: async () => { await writer.abort(); if (phase === "cleanup") throw new Error("CLEANUP SENTINEL"); } };
    };
    if (phase === "receipt") r.host.log = (line) => { if (line.includes("copy_created")) throw new Error("RECEIPT SENTINEL"); };
    await assert.rejects(restoreCopy(browser(r), entry(record)), /copy may exist/);
    assert.equal(r.host.text(target), "HISTORY SENTINEL");
    assert.equal(r.state.fileByPath(target), undefined);
  }
});

test("missing or invalid ciphertext aborts the copy and cancellation during download writes nothing", async () => {
  for (const scenario of ["missing", "invalid", "cancelled"]) {
    const r = await rig();
    const record = await note(r);
    const op = new HistoryOperation();
    if (scenario === "missing") r.server.chunks.clear();
    if (scenario === "invalid") r.server.chunks.set(record.sids[0], new Uint8Array(24));
    if (scenario === "cancelled") {
      const read = r.transport.getChunk.bind(r.transport);
      r.transport.getChunk = async (...args) => { const bytes = await read(...args); op.cancel(); return bytes; };
    }
    await assert.rejects(restoreCopy(browser(r, op), entry(record)));
    assert.equal(r.host.files.size, 0);
    assert.equal(r.state.data.lastSeq, 0);
  }
});
