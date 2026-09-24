/** Encrypted rewrite holds: schema, replay, bounded publication and the Resume UI. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { rig, sandbox, FakeTimers } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange, parseEntry, resumePaused, publishHeld, decryptRecordManifest } = require("../build/sync/pull.js");
const { publishPause, pauseId } = require("../build/sync/pause.js");
const { postManifest, pushFile } = require("../build/sync/push.js");
const { parseData } = require("../build/state.js");
const { CHUNK_MAX } = require("../build/chunker.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { ApiError } = require("../build/transport.js");
const NOTE = "Notes/held.md", TARGET = "ab".repeat(16), PEER = "ff".repeat(16);
const manifest = (r, paused = true) => ({ v: 3, kind: "pause", path: NOTE, target: TARGET, paused, domain: r.context.domainId, size: 0, chunks: [], sha256: "", deleted: false });
const control = async (r, value = manifest(r), options = {}) => r.server.publishManifest({ fileId: await pauseId(r.context, TARGET), manifest: value, sids: [], parents: [], deviceId: PEER, manifestKey: r.keys.manifestKey, bytes: 0, ...options });

test("a control validates every field before it can hold a note", async () => {
  const r = await rig(), valid = manifest(r);
  assert.deepEqual(parseEntry(JSON.stringify(valid)), valid);
  for (const delta of [{ kind: "file" }, { target: "../x" }, { target: "AB".repeat(16) }, { paused: 1 }, { deleted: true }, { size: 1 }, { sha256: "x" }, { chunks: [{}] }, { chunks: null }, { domain: null }, { path: "../outside.md" }]) {
    assert.throws(() => parseEntry(JSON.stringify({ ...valid, ...delta })), JSON.stringify(delta));
  }
  const file = { ...valid, v: 1, mtime: 1, chunks: [], answer: false };
  assert.throws(() => parseEntry(JSON.stringify(file)), /answer/);
});

test("a peer pause is bound to its control id and encrypted record", async () => {
  for (const options of [{ fileId: "ac".repeat(16) }, { domainId: "ad".repeat(16) }, { sids: ["ad".repeat(32)] }, { bytes: 1 }, { deleted: true }]) {
    const r = await rig();
    const frame = await control(r, manifest(r), options);
    assert.equal(await applyChange(r.context, frame), "refused", JSON.stringify(options));
    assert.deepEqual(r.state.data.paused, {});
    assert.equal(r.host.files.size, 0);
  }
});

test("a peer hold leaves content alone, says so once, and survives reload", async () => {
  const r = await rig();
  r.host.seed(NOTE, "unpublished text\n");
  const frame = await control(r);
  assert.equal(await applyChange(r.context, frame), "skipped");
  assert.equal(await applyChange(r.context, frame), "skipped");
  assert.equal(r.host.text(NOTE), "unpublished text\n");
  assert.equal(r.host.notices.length, 1);
  assert.deepEqual(r.state.data.paused, { [TARGET]: { path: NOTE, remote: true } });
  assert.deepEqual(parseData(r.state.data, false).paused, r.state.data.paused);
  assert.deepEqual((await r.reload()).data.paused, r.state.data.paused, "the peer hold was not saved before returning");
  for (const malformed of [{ [TARGET]: { path: "../escape.md" } }, { bad: { path: NOTE } }, { [TARGET]: null }, [NOTE]]) assert.deepEqual(parseData({ paused: malformed }, false).paused, {});
  assert.deepEqual(parseData({ paused: { [TARGET]: { path: NOTE, remote: "yes" } } }, false).paused, { [TARGET]: { path: NOTE } });
});

test("a cleared historical pause cannot re-pause a replaying client", async () => {
  const r = await rig();
  const old = await control(r);
  const clear = await control(r, manifest(r, false), { parents: [old.version_id] });
  assert.equal(await applyChange(r.context, old), "skipped");
  assert.equal(await applyChange(r.context, clear), "skipped");
  assert.deepEqual(r.state.data.paused, {});
  assert.equal(r.host.notices.length, 0);
});

test("announcing a hold is idempotent across repeated writes and an engine restart", async () => {
  const r = await rig();
  r.state.data.paused[TARGET] = { path: NOTE };
  const getFile = r.transport.getFile.bind(r.transport);
  let reads = 0;
  r.transport.getFile = async (...args) => { reads++; return getFile(...args); };
  for (let count = 0; count < 5; count++) await publishPause(r.context, TARGET, NOTE, true);
  assert.equal(reads, 1, "every automatic rewrite asked the server again after the hold was acknowledged");
  assert.equal(r.server.journal.length, 1);
  r.state.data.paused[TARGET] = { path: NOTE }; // a restarted device's parsed object
  await publishPause(r.context, TARGET, NOTE, true);
  assert.equal(r.server.journal.length, 1);
  await publishPause(r.context, TARGET, NOTE, false);
  await publishPause(r.context, TARGET, NOTE, false);
  assert.equal(r.server.journal.length, 2);
});

test("an unreadable pause position is not treated as a missing position", async () => {
  const r = await rig();
  r.transport.getFile = async () => { throw new ApiError(503, "unreachable", "try later"); };
  await assert.rejects(publishPause(r.context, TARGET, NOTE, true), /try later/);
  assert.equal(r.server.journal.filter((entry) => entry.bytes > 0).length, 0);
});

test("concurrent opposite controls do not adopt each other; explicit Resume closes the fork", async () => {
  const r = await rig(), id = await pauseId(r.context, TARGET);
  const held = await postManifest(r.context, id, [], [], manifest(r), 0, true);
  const resumed = await postManifest(r.context, id, [], [], manifest(r, false), 0, true);
  assert.notEqual(held.versionId, resumed.versionId, "Resume adopted a pause because their clear fields match");
  assert.equal(r.server.files.get(id).heads.length, 2);
  await publishPause(r.context, TARGET, NOTE, false);
  assert.equal(r.server.files.get(id).heads.length, 1);
  assert.deepEqual(r.server.files.get(id).versions[0].parents.sort(), [held.versionId, resumed.versionId].sort());
});

test("Show sync status resumes the selected held note through the actual plugin method", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const rows = [];
  obsidian.Setting.prototype.setName = function (name) { this.name = name; rows.push(this); return this; };
  obsidian.Setting.prototype.setDesc = function (description) { this.description = description; return this; };
  obsidian.Setting.prototype.addButton = function (build) {
    const button = { setButtonText(text) { this.text = text; return this; }, onClick(click) { this.click = click; return this; } };
    this.button = button; build(button); return this;
  };
  const { StatusModal } = box.require(join(box.home, "build/ui/modals.js"));
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const calls = [], plugin = new Plugin();
  plugin.engine = { resume: async (...args) => calls.push(args) };
  plugin.state = { data: parseData({ paused: { [TARGET]: { path: NOTE } } }, false), localBytes: () => 0 };
  plugin.statusText = () => "paused";
  const modal = new StatusModal({}, plugin);
  const element = { createEl: () => element, empty() {} };
  modal.contentEl = element;
  modal.setTitle = () => {};
  let closed = false;
  modal.close = () => { closed = true; };
  modal.onOpen();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, NOTE);
  assert.equal(rows[0].button.text, "Resume");
  rows[0].button.click();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [[TARGET, "status"]]);
  assert.equal(closed, true);
});


async function recordedNote() {
  const r = await rig();
  r.host.seed(NOTE, "recorded\n");
  r.post = await pushFile(r.context, NOTE);
  return r;
}

test("resume fallbacks preserve untracked, deleted, large and unavailable recorded content", async () => {
  const r = await recordedNote();
  assert.equal(await resumePaused(r.context, TARGET), "untracked");
  r.host.files.delete(NOTE);
  assert.equal(await resumePaused(r.context, r.post.fileId), "deleted_here");
  r.host.seed(NOTE, "new text\n");
  const stat = r.host.stat.bind(r.host);
  r.host.stat = async (path) => ({ ...await stat(path), size: CHUNK_MAX + 1 });
  assert.equal(await resumePaused(r.context, r.post.fileId), "ordinary");
  r.host.stat = stat;
  r.server.files.get(r.post.fileId).versions = [];
  assert.equal(await resumePaused(r.context, r.post.fileId), "ordinary");
});

test("unchanged paused bytes require no backup or server read", async () => {
  const r = await recordedNote();
  r.transport.getFile = async () => assert.fail("unchanged content asked the server");
  assert.equal(await resumePaused(r.context, r.post.fileId), "unchanged");
  assert.equal(r.host.files.size, 1);
});

test("Resume refuses to silently consume a foreign live head", async () => {
  const r = await recordedNote();
  const theirs = await r.server.publish({ fileId: r.post.fileId, path: NOTE, bytes: new TextEncoder().encode("other unpublished head\n"), mtime: r.host.clock + 1000, parents: [], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.host.seed(NOTE, "held editor text\n");
  assert.equal(await publishHeld(r.context, r.post.fileId, NOTE), "published_held");
  const copies = [...r.host.files.keys()].filter((path) => path !== NOTE);
  assert.equal(copies.length, 1);
  assert.equal(r.host.text(copies[0]), "other unpublished head\n");
  assert.equal(r.server.files.get(r.post.fileId).heads.length, 1);
  assert.equal(r.host.text(NOTE), "held editor text\n");
});

test("a hold also prevents a new local file at the same path from being pushed", async (t) => {
  const r = await rig(), timers = new FakeTimers();
  r.state.data.paused[TARGET] = { path: NOTE, remote: true };
  r.host.seed(NOTE, "new local file\n");
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  t.after(() => { engine.stop(); r.server.releaseFeed(); });
  await engine.start();
  await timers.run(50, () => r.host.logs.some((line) => line.includes("reason=paused file=untracked")));
  assert.equal(r.state.fileByPath(NOTE), undefined);
  assert.equal(r.server.journal.filter((entry) => entry.bytes > 0).length, 0);
});


test("concurrent deliveries of one peer hold produce one notice", async () => {
  const r = await rig(), frame = await control(r);
  await Promise.all([applyChange(r.context, frame), applyChange(r.context, frame)]);
  assert.equal(r.host.notices.length, 1);
});

test("a peer-held note that changes during Resume stays held", async (t) => {
  const r = await recordedNote(), timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  t.after(() => { engine.stop(); r.server.releaseFeed(); });
  await engine.start();
  r.state.data.paused[r.post.fileId] = { path: NOTE, remote: true };
  const read = r.host.read.bind(r.host);
  r.host.read = async (path) => { const bytes = await read(path); if (path === NOTE) r.host.seed(path, "newer text while uploading\n", r.host.clock + 1); return bytes; };
  await engine.resume(r.post.fileId, "status");
  assert.deepEqual(r.state.data.paused[r.post.fileId], { path: NOTE, remote: true });
  assert.equal(r.host.text(NOTE), "newer text while uploading\n");
});

test("a detector keeps its hold when a resume backup has no free name", async (t) => {
  const r = await recordedNote(), timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  t.after(() => { engine.stop(); r.server.releaseFeed(); });
  await engine.start();
  r.state.data.paused[r.post.fileId] = { path: NOTE };
  r.host.seed(NOTE, "held after pause\n", r.host.clock + 1);
  const stat = r.host.stat.bind(r.host);
  r.host.stat = async (path) => path === NOTE ? stat(path) : ({ path, size: 1, mtime: 1 });
  await engine.resume(r.post.fileId, "status");
  assert.deepEqual(r.state.data.paused[r.post.fileId], { path: NOTE });
  assert.equal(r.host.text(NOTE), "held after pause\n");
  assert.ok(r.host.logs.some((line) => line.includes("decision=resumed outcome=failed_error")));
});

test("resume refuses a saved record that was deleted, moved, or has multiple chunks", async () => {
  for (const kind of ["deleted", "moved", "chunks"]) {
    const r = await recordedNote();
    const original = r.server.files.get(r.post.fileId).versions[0];
    const value = await decryptRecordManifest(r.context, { ...original, file_id: r.post.fileId, domain_id: r.context.domainId });
    if (kind === "moved") value.path = "Notes/elsewhere.md";
    if (kind === "deleted") Object.assign(value, { deleted: true, size: 0, chunks: [], sha256: "" });
    if (kind === "chunks") { value.size = CHUNK_MAX + 1; value.chunks = [{ sid: "ab".repeat(32), cid: "cd".repeat(32), len: CHUNK_MAX }, { sid: "ef".repeat(32), cid: "12".repeat(32), len: 1 }]; }
    const old = await r.server.publishManifest({ fileId: r.post.fileId, manifest: value, sids: value.chunks.map((chunk) => chunk.sid), parents: [], deviceId: PEER, manifestKey: r.keys.manifestKey, bytes: value.size });
    r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: old.version_id });
    r.host.seed(NOTE, "held after pause\n", r.host.clock + 1);
    assert.equal(await resumePaused(r.context, r.post.fileId), "ordinary", kind);
    assert.equal(r.host.text(NOTE), "held after pause\n", kind);
    assert.equal(r.host.files.size, 1, kind);
  }
});

test("an incomplete control lookup is never mistaken for an already-published hold", async () => {
  for (const heads of [[], ["12".repeat(32)]]) {
    const r = await rig(), fileId = await pauseId(r.context, TARGET);
    r.server.files.set(fileId, { domain_id: r.context.domainId, versions: [], heads });
    await publishPause(r.context, TARGET, NOTE, true);
    assert.equal(r.server.journal.length, 1);
  }
});

test("a detector keeps its hold if a save lands during its resume backup", async (t) => {
  const r = await recordedNote(), timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  t.after(() => { engine.stop(); r.server.releaseFeed(); });
  await engine.start();
  r.state.data.paused[r.post.fileId] = { path: NOTE };
  r.host.seed(NOTE, "held before Resume\n", r.host.clock + 1);
  const create = r.host.createWriter.bind(r.host);
  r.host.createWriter = async (...args) => {
    const writer = await create(...args), commit = writer.commit.bind(writer);
    writer.commit = async (...values) => { const result = await commit(...values); r.host.seed(NOTE, "saved inside Resume\n", r.host.clock + 2); return result; };
    return writer;
  };
  await engine.resume(r.post.fileId, "status");
  assert.deepEqual(r.state.data.paused[r.post.fileId], { path: NOTE });
  assert.equal(r.host.text(NOTE), "saved inside Resume\n");
  assert.ok(r.host.logs.some((line) => line.includes("decision=resumed outcome=failed_error")));
});

test("publishing a held editor does not make a copy of its own recorded ancestor", async () => {
  const r = await recordedNote();
  r.host.seed(NOTE, "held latest editor text\n", r.host.clock + 1);
  await publishHeld(r.context, r.post.fileId, NOTE);
  assert.equal(r.host.files.size, 1);
  assert.equal(r.host.text(NOTE), "held latest editor text\n");
});

test("control adoption checks kind and target as well as its paused state", async () => {
  for (const delta of [{ kind: "other" }, { target: "ac".repeat(16) }, { v: 2 }]) {
    const r = await rig(), id = await pauseId(r.context, TARGET);
    const bad = await postManifest(r.context, id, [], [], { ...manifest(r), ...delta }, 0, false);
    const valid = await postManifest(r.context, id, [], [], manifest(r), 0, true);
    assert.notEqual(valid.versionId, bad.versionId, JSON.stringify(delta));
  }
});

test("a newly paired device can explicitly Resume a note held before its first download", async (t) => {
  const r = await rig(), timers = new FakeTimers();
  await r.server.publish({ fileId: TARGET, path: NOTE, bytes: new TextEncoder().encode("already on the server\n"), mtime: r.host.clock, parents: [], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.state.data.paused[TARGET] = { path: NOTE, remote: true };
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  t.after(() => { engine.stop(); r.server.releaseFeed(); });
  await engine.start();
  await timers.run(50, () => r.state.data.lastSeq >= r.server.seq);
  assert.equal(r.host.text(NOTE), null);
  await engine.resume(TARGET, "status");
  assert.equal(r.host.text(NOTE), "already on the server\n");
  assert.deepEqual(r.state.data.paused, {});
});

test("Resume keeps a local deletion instead of applying the note it deliberately held back", async (t) => {
  const r = await recordedNote(), timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  t.after(() => { engine.stop(); r.server.releaseFeed(); });
  await engine.start();
  r.state.data.paused[r.post.fileId] = { path: NOTE };
  r.host.files.delete(NOTE);
  await r.server.publish({ fileId: r.post.fileId, path: NOTE, bytes: new TextEncoder().encode("remote text held back\n"), mtime: r.host.clock + 1, parents: [r.post.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await engine.resume(r.post.fileId, "status");
  assert.equal(r.host.text(NOTE), null);
  assert.deepEqual(r.state.data.paused, {});
});

test("a stop prevents a queued Resume from publishing or forgetting the hold", async () => {
  const r = await recordedNote(), timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start();
  r.state.data.paused[r.post.fileId] = { path: NOTE, remote: true };
  engine.stop(); r.server.releaseFeed(); await engine.stopAndWait();
  const count = r.server.journal.length;
  await engine.resume(r.post.fileId, "status");
  assert.equal(r.server.journal.length, count);
  assert.deepEqual(r.state.data.paused[r.post.fileId], { path: NOTE, remote: true });
});

test("Resume refuses a server head whose version it cannot read", async () => {
  const r = await recordedNote();
  r.server.files.get(r.post.fileId).heads = ["cd".repeat(32)];
  await assert.rejects(publishHeld(r.context, r.post.fileId, NOTE), /missing_head/);
  assert.equal(r.host.files.size, 1);
});


test("Resume selects heads after the older blocked upload is acknowledged", async () => {
  const r = await recordedNote();
  r.host.seed(NOTE, "older local upload\n", 2000);
  const post = r.transport.postVersion.bind(r.transport);
  let release, started, first = true;
  const arrived = new Promise(resolve => { started = resolve; });
  r.transport.postVersion = async (...args) => {
    if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); }
    return post(...args);
  };
  const older = pushFile(r.context, NOTE);
  await arrived;
  r.host.seed(NOTE, "held editor text\n", 3000);
  const resuming = publishHeld(r.context, r.post.fileId, NOTE);
  // Let an incorrectly eager lookup finish before acknowledging the old upload.
  await new Promise(setImmediate);
  release();
  const [prior] = await Promise.all([older, resuming]);
  const file = r.server.files.get(r.post.fileId);
  assert.equal(file.heads.length, 1, "Resume forked over parents selected before the upload acknowledgment");
  const tip = file.versions.find(version => version.version_id === file.heads[0]);
  assert.deepEqual(tip.parents, [prior.versionId]);
  assert.equal(r.host.text(NOTE), "held editor text\n");
  assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
});
