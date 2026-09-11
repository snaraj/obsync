import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { FakeTimers, fakeState, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { parseSyncFolders, inSyncScope, inSyncTree, expandsSyncScope } = require("../build/syncScope.js");
const { parseData } = require("../build/state.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { pushFile, pushDelete, postManifest } = require("../build/sync/push.js");
const { applyChange, fetchRemoteOnly, remoteOnlyList, decryptRecordManifest, assembleBytes } = require("../build/sync/pull.js");
const enc = (text) => new TextEncoder().encode(text);
const record = (fileId) => ({ fileId, versionId: "12".repeat(32), mtime: 100, size: 8, sha256: "" });

test("missing scope keeps dedicated-vault compatibility; empty scope survives persistence", () => {
  assert.equal(parseData({}, false).syncFolders, undefined);
  assert.deepEqual(parseData(JSON.parse(JSON.stringify({ syncFolders: [] })), true).syncFolders, []);
  assert.equal(inSyncScope("note.md", undefined), true);
  assert.equal(inSyncScope("Notes/note.md", []), false);
  assert.equal(inSyncScope(".config/setting", undefined), false);
});

test("scope matches folder boundaries and removes redundant descendants", () => {
  assert.deepEqual(parseSyncFolders(["Notes/Journal", "Attachments", "Notes", "Notes"]), ["Attachments", "Notes"]);
  for (const value of ["Notes/note.md", "Notes/Journal/entry.md"]) assert.equal(inSyncScope(value, ["Notes"]), true);
  for (const value of ["Notes", "NotesExtra/admin.sh", "Admin/Notes/a.md", "Notes/../Admin/a.sh", "Notes/.config/main.js"]) {
    assert.equal(inSyncScope(value, ["Notes"]), false, value);
  }
  assert.equal(expandsSyncScope(undefined, ["Notes"]), false);
  assert.equal(expandsSyncScope(["Notes"], ["Notes/Journal"]), false);
  assert.equal(expandsSyncScope(["Notes"], []), false);
  assert.equal(expandsSyncScope(["Notes/Journal"], ["Notes"]), true);
  assert.equal(expandsSyncScope(["Notes"], ["NotesExtra"]), true);
  assert.equal(expandsSyncScope([], undefined), true);
  for (const value of ["Notes", "Notes/Journal", "Notes/Journal/Year"]) assert.equal(inSyncTree(value, ["Notes/Journal"]), true);
  for (const value of ["Admin", "NotesExtra", "Notes/Other", ".config"]) assert.equal(inSyncTree(value, ["Notes/Journal"]), false);
});

test("any malformed persisted restriction stops loading instead of falling back to all files", () => {
  for (const value of [null, {}, "Notes", [7], [""], ["/Notes"], ["Notes/"], ["../Notes"], ["Notes//Sub"], ["C:/Notes"],
    ["Notes\\Sub"], [".config"], ["Notes/\u0000x"], [" Notes"], ["Notes "], ["Notes", "../Admin"]]) {
    assert.throws(() => parseData({ syncFolders: value }, false), undefined, JSON.stringify(value));
  }
});

/** Fail the test at the first host call for an excluded file, including syncable/stat. */
function guardHost(host, folders) {
  const touched = [];
  for (const method of ["syncable", "stat", "read", "source", "writer", "trash"]) {
    const original = host[method].bind(host);
    host[method] = (value, ...rest) => {
      touched.push([method, value]);
      assert.ok(inSyncScope(value, folders), `${method} accessed an excluded path: ${value}`);
      return original(value, ...rest);
    };
  }
  return touched;
}

test("scoped startup and events never inspect excluded files or infer their deletion", async () => {
  const { host, state, server, transport } = await rig();
  state.data.syncFolders = ["Notes"];
  host.seed("Notes/yes.md", "SENTINEL");
  host.seed("Admin/deploy.sh", "SENTINEL");
  host.seed("NotesExtra/deploy.sh", "SENTINEL");
  state.setFile("Admin/absent.sh", record("21".repeat(16)));
  const touched = guardHost(host, ["Notes"]);
  const timers = new FakeTimers();
  const engine = new SyncEngine({ host, state, transport, timers });
  await engine.start();
  engine.changed("Admin/deploy.sh");
  engine.deleted("Admin/absent.sh");
  engine.renamed("Admin/from.sh", "Admin/to.sh");
  await timers.run(1000, () => Boolean(state.fileByPath("Notes/yes.md")) && server.feedWaiters.length !== 0);
  assert.equal(server.vaultFiles().length, 1);
  assert.ok(state.fileByPath("Admin/absent.sh"), "excluded state is retained, never tombstoned");
  assert.ok(touched.some(([method]) => method === "read"), "the allowed control actually synced");
  const beat = JSON.parse(server.requests.find((item) => item.target.endsWith("/heartbeat")).json);
  assert.deepEqual(Object.keys(beat).sort(), ["app_version", "policy"]);
  assert.equal(JSON.stringify(beat).includes("Notes"), false, "local scope is absent from device policy");
  const stopped = engine.stopAndWait();
  server.releaseFeed();
  await stopped;
});

test("direct push, delete and manifest-post entry points refuse excluded paths before I/O", async () => {
  const { host, state, server, context } = await rig();
  state.data.syncFolders = ["Notes"];
  state.setFile("Admin/deploy.sh", record("22".repeat(16)));
  const touched = guardHost(host, ["Notes"]);
  await assert.rejects(pushFile(context, "Admin/deploy.sh"), /outside_sync_scope/);
  await assert.rejects(pushDelete(context, "Admin/deploy.sh"), /outside_sync_scope/);
  await assert.rejects(postManifest(context, "22".repeat(16), [], [], { path: "Admin/deploy.sh" }, 0), /outside_sync_scope/);
  assert.deepEqual(touched, []);
  assert.equal(server.requests.length, 0);
  assert.ok(state.fileByPath("Admin/deploy.sh"));
});

async function publish(r, path, fileId = "31".repeat(16), parents = []) {
  return r.server.publish({ fileId, path, bytes: enc("REMOTE SENTINEL"), mtime: 200,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, parents });
}

test("excluded remote metadata never downloads chunks, writes files or enters remote-only state", async () => {
  const r = await rig({ policy: { perFileMaxBytes: 1, totalBudgetBytes: 1 } });
  r.state.data.syncFolders = ["Notes"];
  const touched = guardHost(r.host, ["Notes"]);
  for (const p of ["Admin/deploy.sh", "NotesExtra/note.md", "Notes", "root.md"]) {
    assert.equal(await applyChange(r.context, await publish(r, p)), "skipped");
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(r.state.data.files, {});
  assert.deepEqual(r.state.data.remoteOnly, {});
  assert.equal(r.server.requests.length, 0);
  assert.ok(r.host.logs.some((line) => line.includes("reason=outside_sync_scope")));
});

test("remote rename, conflict and tombstone cannot act on a remembered excluded source", async () => {
  for (const operation of ["rename", "conflict", "delete"]) {
    const r = await rig();
    r.state.data.syncFolders = ["Notes"];
    const id = "32".repeat(16);
    r.host.seed("Admin/deploy.sh", "LOCAL SENTINEL");
    r.state.setFile("Admin/deploy.sh", record(id));
    const touched = guardHost(r.host, ["Notes"]);
    const change = operation === "delete"
      ? await r.server.publishTombstone({ fileId: id, path: "Notes/allowed.md", manifestKey: r.keys.manifestKey })
      : await publish(r, "Notes/allowed.md", id);
    change.conflicted = operation === "conflict";
    assert.equal(await applyChange(r.context, change), "skipped", operation);
    assert.deepEqual(touched, [], operation);
    assert.equal(r.host.text("Admin/deploy.sh"), "LOCAL SENTINEL");
    assert.equal(r.host.text("Notes/allowed.md"), null);
    assert.ok(r.state.fileByPath("Admin/deploy.sh"));
  }
});

test("a remote rename or tombstone naming an excluded destination keeps the selected source", async () => {
  for (const deleted of [false, true]) {
    const r = await rig();
    r.state.data.syncFolders = ["Notes"];
    const id = "33".repeat(16);
    r.host.seed("Notes/local.md", "LOCAL SENTINEL");
    r.state.setFile("Notes/local.md", record(id));
    const touched = guardHost(r.host, ["Notes"]);
    const change = deleted
      ? await r.server.publishTombstone({ fileId: id, path: "Admin/deploy.sh", manifestKey: r.keys.manifestKey })
      : await publish(r, "Admin/deploy.sh", id);
    assert.equal(await applyChange(r.context, change), "skipped");
    assert.equal(r.host.text("Notes/local.md"), "LOCAL SENTINEL");
    assert.deepEqual(touched, []);
  }
});

test("on-demand fetch and history assembly cannot bypass the folder selection", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const id = "34".repeat(16);
  const change = await publish(r, "Admin/deploy.sh", id);
  r.state.data.remoteOnly[id] = { path: "Admin/deploy.sh", size: 15 };
  assert.deepEqual(remoteOnlyList(r.context), []);
  await assert.rejects(fetchRemoteOnly(r.context, id), /outside_sync_scope/);
  assert.equal(r.server.requests.length, 0, "remembered excluded metadata needs no network lookup");
  delete r.state.data.remoteOnly[id];
  await assert.rejects(fetchRemoteOnly(r.context, id), /outside_sync_scope/);
  await assert.rejects(decryptRecordManifest(r.context, change), /outside_sync_scope/);
  await assert.rejects(assembleBytes(r.context, { path: "Admin/deploy.sh", chunks: [{ sid: "1".repeat(64) }] }), /outside_sync_scope/);
  assert.equal(r.server.requests.filter((item) => item.target.includes("/chunks/")).length, 0);
  assert.equal(r.host.files.size, 0);
});

test("an excluded merge ancestor cannot be assembled from history", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const id = "35".repeat(16);
  const base = await publish(r, "Admin/history.md", id);
  const mine = await publish(r, "Notes/note.md", id, [base.version_id]);
  r.host.seed("Notes/note.md", "LOCAL SENTINEL");
  r.state.setFile("Notes/note.md", { ...record(id), versionId: mine.version_id });
  const theirs = await publish(r, "Notes/note.md", id, [base.version_id]);
  guardHost(r.host, ["Notes"]);
  assert.equal(await applyChange(r.context, theirs), "skipped");
  assert.equal(r.host.text("Notes/note.md"), "LOCAL SENTINEL");
  assert.equal(r.server.requests.filter((item) => item.target.includes("/chunks/")).length, 0);
});

test("allowed conflict copies stay in the selected folder and preserve both versions", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const id = "36".repeat(16);
  r.host.seed("Notes/image.bin", "LOCAL SENTINEL");
  r.state.setFile("Notes/image.bin", record(id));
  guardHost(r.host, ["Notes"]);
  const incoming = await publish(r, "Notes/image.bin", id);
  incoming.conflicted = true;
  assert.equal(await applyChange(r.context, incoming), "conflict_copy");
  assert.equal(r.host.text("Notes/image.bin"), "LOCAL SENTINEL");
  const copy = [...r.host.files.keys()].find((p) => p !== "Notes/image.bin");
  assert.ok(copy.startsWith("Notes/image (conflict from "));
  assert.equal(r.host.text(copy), "REMOTE SENTINEL");
});

/** Real host, synthetic files only. Cached excluded metadata must never be requested. */
async function scopedHost(t, mobile) {
  const box = sandbox();
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  const { TFile, TFolder } = box.require("obsidian");
  const root = mkdtempSync(join(tmpdir(), "obsync-scope-"));
  t.after(() => { rmSync(root, { recursive: true }); rmSync(box.home, { recursive: true }); });
  mkdirSync(join(root, "Notes"));
  mkdirSync(join(root, "Admin"));
  writeFileSync(join(root, "Admin/deploy.sh"), "LOCAL SENTINEL");
  writeFileSync(join(root, "Notes/note.md"), "NOTE");
  const file = Object.assign(new TFile(), { path: "Notes/note.md", stat: { mtime: 100, size: 4 } });
  const excludedFile = Object.assign(new TFile(), { path: "Admin/deploy.sh" });
  Object.defineProperty(excludedFile, "stat", { get: () => assert.fail("excluded cached file metadata was inspected") });
  const hiddenFolder = Object.assign(new TFolder(), { path: "Notes/.config" });
  Object.defineProperty(hiddenFolder, "children", { get: () => assert.fail("hidden cached children were inspected") });
  const folder = Object.assign(new TFolder(), { path: "Notes", children: [file, excludedFile, hiddenFolder] });
  const calls = [];
  const state = { data: { syncFolders: ["Notes"] } };
  const adapter = Object.fromEntries(["stat", "readBinary", "writeBinary", "remove", "mkdir", "exists"].map((method) =>
    [method, async (p) => { calls.push([method, p]); throw new Error("unexpected adapter access"); }]));
  const plugin = { state, log: () => undefined, app: { vault: { adapter,
    getFiles: () => { throw new Error("whole-vault listing must not run"); },
    getAbstractFileByPath: (p) => { calls.push(["cached", p]); assert.equal(p, "Notes"); return folder; },
  } } };
  const desktop = { base: root, path, fs: { promises: { ...fs, lstat: async (p) => {
    calls.push(["lstat", p]);
    assert.ok(p === root || p.startsWith(`${root}/Notes`), "excluded filesystem metadata was inspected");
    return fs.lstat(p);
  } } } };
  return { root, calls, state, host: new ObsidianHost(plugin, mobile ? null : desktop) };
}

for (const mobile of [false, true]) test(`real ${mobile ? "mobile" : "desktop"} host gates every file operation before I/O and lists selected subtrees`, async (t) => {
  const { host, root, calls, state } = await scopedHost(t, mobile);
  for (const p of ["Admin/deploy.sh", "NotesExtra/deploy.sh", "Notes"]) {
    assert.equal(await host.syncable(p), false);
    for (const method of ["stat", "read", "writer", "trash"]) await assert.rejects(host[method](p), /outside_sync_scope/);
    assert.throws(() => host.source(p, 1), /outside_sync_scope/);
  }
  assert.deepEqual(calls, [], "even stat and cached lookup stayed untouched");
  assert.deepEqual(await host.list(), [{ path: "Notes/note.md", mtime: 100, size: 4 }]);
  assert.equal(readFileSync(join(root, "Admin/deploy.sh"), "utf8"), "LOCAL SENTINEL");
  calls.length = 0;
  state.data.syncFolders = [];
  assert.deepEqual(await host.list(), []);
  assert.deepEqual(calls, [], "an explicit empty list does not inventory anything");
});

async function plugin(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  const r = await fakeState();
  instance.state = r.state;
  instance.log = () => undefined;
  let restarts = 0;
  instance.startEngine = async () => { restarts++; };
  return { instance, ...r, restarts: () => restarts };
}

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("scope contraction waits for active work, retains state and cursor, and saves locally", async (t) => {
  const { instance, state, saved, restarts } = await plugin(t);
  state.data.lastSeq = 17;
  state.setFile("Admin/deploy.sh", record("41".repeat(16)));
  const before = structuredClone(state.data.files);
  const engineWork = deferred();
  const fetchWork = deferred();
  instance.engine = { stopAndWait: () => engineWork.promise };
  instance.manualFetches.add(fetchWork.promise);
  const saving = instance.saveSyncFolders(["Notes"]);
  assert.equal(state.data.syncFolders, undefined, "active transfers still use the original scope");
  assert.equal(instance.syncContext(), null, "new manual fetches are blocked during transition");
  engineWork.resolve();
  await new Promise(setImmediate);
  assert.equal(state.data.syncFolders, undefined, "manual downloads must also finish");
  fetchWork.resolve("done");
  await saving;
  assert.deepEqual(saved().syncFolders, ["Notes"]);
  assert.deepEqual(state.data.files, before);
  assert.equal(state.data.lastSeq, 17, "past versions are never replayed");
  assert.equal(restarts(), 1);
});

test("scope saving waits for engine work without manual downloads and serializes edits", async (t) => {
  const { instance, state, saved } = await plugin(t);
  const work = deferred();
  t.after(() => work.resolve());
  instance.engine = { stopAndWait: () => work.promise };
  const saving = instance.saveSyncFolders(["Notes"]);
  let refusal;
  void instance.saveSyncFolders([]).catch((error) => { refusal = error; });
  await new Promise(setImmediate);
  assert.match(refusal?.message ?? "", /already being saved/);
  assert.equal(state.data.syncFolders, undefined);
  assert.equal(saved(), null);
  work.resolve();
  await saving;
  assert.deepEqual(saved().syncFolders, ["Notes"]);
});

test("expansion is rechecked after in-flight work has recorded the first synced file", async (t) => {
  const { instance, state, saved } = await plugin(t);
  state.data.syncFolders = ["Notes"];
  const work = deferred();
  instance.engine = { stopAndWait: () => work.promise };
  const saving = instance.saveSyncFolders(["Notes", "Attachments"]);
  state.setFile("Notes/new.md", record("56".repeat(16)));
  work.resolve();
  await assert.rejects(saving, /folders can only be narrowed/);
  assert.deepEqual(state.data.syncFolders, ["Notes"]);
  assert.equal(saved(), null);
});

test("a used device refuses expansion before stopping, saving or restarting", async (t) => {
  const { instance, state, saved, restarts } = await plugin(t);
  state.data.syncFolders = ["Notes"];
  instance.engine = { stopAndWait: () => assert.fail("must refuse before stopping") };
  for (const evidence of ["cursor", "local", "remote"]) {
    state.data.lastSeq = evidence === "cursor" ? 1 : 0;
    state.data.files = evidence === "local" ? { "Notes/a.md": record("51".repeat(16)) } : {};
    state.data.remoteOnly = evidence === "remote" ? { sentinel: { path: "Notes/a.md", size: 1 } } : {};
    for (const scope of [undefined, ["Notes", "Admin"], ["NotesExtra"]]) {
      await assert.rejects(instance.saveSyncFolders(scope), /already selected folder.*Sync now.*fresh local vault.*before pairing/);
      assert.deepEqual(state.data.syncFolders, ["Notes"]);
    }
  }
  assert.equal(saved(), null);
  assert.equal(restarts(), 0);
});

test("an unused device can select folders or an explicit empty scope before pairing", async (t) => {
  const { instance, state, saved } = await plugin(t);
  state.data.deviceId = null;
  await instance.saveSyncFolders([]);
  assert.deepEqual(saved().syncFolders, []);
  await instance.saveSyncFolders(["Notes", "Attachments"]);
  assert.deepEqual(saved().syncFolders, ["Attachments", "Notes"]);
  await assert.rejects(instance.saveSyncFolders(["Notes/../Admin"]), /dot_segment/);
  assert.deepEqual(saved().syncFolders, ["Attachments", "Notes"]);
});

test("invalid saved scope refuses plugin startup with a visible state decision", async (t) => {
  const { instance } = await plugin(t);
  const logs = [];
  instance.log = (line) => logs.push(line);
  instance.loadData = async () => ({ syncFolders: null });
  await assert.rejects(instance.onload(), /sync folders must be a list/);
  assert.deepEqual(logs, ["state decision=refused reason=load_failed"]);
  assert.equal(instance.engine, null);
});

test("stopping during startup never opens the filesystem loops or accepts watcher events", async () => {
  const r = await rig();
  const wait = deferred();
  const get = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (id) => { await wait.promise; return get(id); };
  let lists = 0;
  r.host.list = async () => { lists++; return []; };
  const engine = new SyncEngine({ ...r, timers: new FakeTimers() });
  const starting = engine.start();
  engine.changed("Notes/new.md");
  engine.renamed("Notes/from.md", "Notes/to.md");
  const stopping = engine.stopAndWait();
  wait.resolve();
  await starting;
  assert.equal(engine.started, false);
  assert.equal(lists, 0);
  assert.deepEqual(r.state.data.files, {});
  await stopping;
});

test("a scope save failure leaves sync stopped and the previous persisted selection intact", async (t) => {
  const { instance, state, saved, restarts } = await plugin(t);
  state.data.syncFolders = ["Notes"];
  await state.save();
  state.save = async () => { throw new Error("STORE SENTINEL"); };
  await assert.rejects(instance.saveSyncFolders([]), /STORE SENTINEL/);
  assert.deepEqual(state.data.syncFolders, ["Notes"]);
  assert.deepEqual(saved().syncFolders, ["Notes"]);
  assert.equal(instance.engine, null);
  assert.equal(restarts(), 0);
  assert.match(instance.statusText(), /not saved.*Sync is stopped/);
});

test("the plugin waits for a real on-demand download before narrowing and blocks new downloads", async (t) => {
  const { instance } = await plugin(t);
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  instance.state = r.state;
  instance.engine = { context: r.context, stopAndWait: async () => undefined };
  const id = "52".repeat(16);
  await publish(r, "Notes/download.md", id);
  const entered = deferred();
  const held = deferred();
  t.after(() => held.resolve());
  const get = r.transport.getChunk.bind(r.transport);
  r.transport.getChunk = async (sid) => { entered.resolve(); await held.promise; return get(sid); };
  const download = instance.fetchRemoteOnly(id);
  await entered.promise;
  const saving = instance.saveSyncFolders([]);
  await new Promise(setImmediate);
  assert.deepEqual(r.state.data.syncFolders, ["Notes"]);
  await assert.rejects(instance.fetchRemoteOnly(id), /not running/);
  held.resolve();
  await download;
  await saving;
  assert.deepEqual(r.state.data.syncFolders, []);
  assert.equal(r.host.text("Notes/download.md"), "REMOTE SENTINEL");
  assert.ok(r.state.fileByPath("Notes/download.md"));
});

test("a stopped feed checkpoints only the change it actually finished applying", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const entered = deferred();
  const held = deferred();
  const write = r.host.writer.bind(r.host);
  r.host.writer = async (p) => {
    const writer = await write(p);
    const commit = writer.commit.bind(writer);
    writer.commit = async (mtime) => { entered.resolve(); await held.promise; return commit(mtime); };
    return writer;
  };
  const timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers });
  await engine.start();
  await timers.run(1000, () => r.server.feedWaiters.length !== 0);
  const first = await publish(r, "Notes/first.md", "53".repeat(16));
  await entered.promise;
  await publish(r, "Notes/second.md", "54".repeat(16));
  const stopped = engine.stopAndWait();
  held.resolve();
  await stopped;
  assert.equal(r.state.data.lastSeq, first.seq);
  assert.equal(r.host.text("Notes/first.md"), "REMOTE SENTINEL");
  assert.equal(r.host.text("Notes/second.md"), null);
});

test("moving local content into a selected folder creates a new identity; moving it out removes only the selected source", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const oldId = "55".repeat(16);
  r.host.seed("Staging/note.md", "LOCAL SENTINEL");
  r.state.setFile("Staging/note.md", record(oldId));
  guardHost(r.host, ["Notes"]);
  const timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers });
  await engine.start();
  r.host.files.set("Notes/note.md", r.host.files.get("Staging/note.md"));
  r.host.files.delete("Staging/note.md");
  engine.renamed("Staging/note.md", "Notes/note.md");
  await timers.run(1000, () => Boolean(r.state.fileByPath("Notes/note.md")) && r.server.feedWaiters.length !== 0);
  assert.notEqual(r.state.fileByPath("Notes/note.md").fileId, oldId);
  assert.ok(r.state.fileByPath("Staging/note.md"));
  r.host.files.set("Archive/note.md", r.host.files.get("Notes/note.md"));
  r.host.files.delete("Notes/note.md");
  engine.renamed("Notes/note.md", "Archive/note.md");
  await timers.run(1000, () => !r.state.fileByPath("Notes/note.md") && r.server.feedWaiters.length !== 0);
  assert.equal(r.host.text("Archive/note.md"), "LOCAL SENTINEL");
  assert.equal(r.server.journal.at(-1).deleted, true);
  const stopped = engine.stopAndWait();
  r.server.releaseFeed();
  await stopped;
});

test("stopping during a feed wait does not acknowledge unapplied metadata", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const timers = new FakeTimers();
  const entered = deferred();
  const page = deferred();
  r.transport.changes = async () => { entered.resolve(); return page.promise; };
  const engine = new SyncEngine({ ...r, timers });
  await engine.start();
  await entered.promise;
  const seq = r.state.data.lastSeq;
  const stopped = engine.stopAndWait();
  const change = await publish(r, "Notes/later.md");
  assert.ok(change.seq > seq, "the completed long poll really has newer unapplied metadata");
  page.resolve({ seq: change.seq, head_seq: change.seq, changes: [change] });
  await stopped;
  assert.equal(r.state.data.lastSeq, seq);
  assert.equal(r.host.text("Notes/later.md"), null);
});

test("a queued rename survives a scope-change stop and is published on the next scan", async () => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  r.host.seed("Notes/before.md", "LOCAL SENTINEL", 100);
  const before = await pushFile(r.context, "Notes/before.md");
  r.host.seed("Notes/hold.md", "QUEUE SENTINEL", 100);
  const entered = deferred();
  const held = deferred();
  const read = r.host.read.bind(r.host);
  r.host.read = async (p) => {
    if (p === "Notes/hold.md") { entered.resolve(); await held.promise; }
    return read(p);
  };
  const timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers });
  await engine.start();
  await entered.promise;
  await timers.run(1000, () => r.server.feedWaiters.length !== 0);
  r.host.files.set("Notes/after.md", r.host.files.get("Notes/before.md"));
  r.host.files.delete("Notes/before.md");
  engine.renamed("Notes/before.md", "Notes/after.md");
  const stopped = engine.stopAndWait();
  r.server.releaseFeed();
  let settled = false;
  void stopped.then(() => { settled = true; });
  await timers.run();
  assert.equal(settled, false, "the active push must finish before a new scope can be saved");
  held.resolve();
  await stopped;
  assert.equal(r.state.fileByPath("Notes/after.md").fileId, before.fileId);
  const resumed = new SyncEngine({ ...r, timers });
  await resumed.start();
  await timers.run(1000, () => r.state.fileByPath("Notes/after.md").versionId !== before.versionId && r.server.feedWaiters.length !== 0);
  assert.equal(r.state.fileByPath("Notes/after.md").fileId, before.fileId);
  assert.equal(r.host.text("Notes/after.md"), "LOCAL SENTINEL");
  const finished = resumed.stopAndWait();
  r.server.releaseFeed();
  await finished;
});
