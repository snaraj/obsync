import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { rig, sandbox } from "./fake.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function promptly(work) {
  const late = Symbol("still pending");
  const result = await Promise.race([work.then((value) => ({ value }), (error) => ({ error })), new Promise((resolve) => setImmediate(() => resolve(late)))]);
  assert.notEqual(result, late, "logical cancellation or local-copy receipt did not settle promptly");
  if (result.error) throw result.error;
  return result.value;
}
const enc = (text) => new TextEncoder().encode(text);

async function plugin(t) {
  const r = await rig();
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  instance.state = r.state;
  instance.transport = r.transport;
  instance.host = r.host;
  instance.log = (line) => r.host.log(line);
  instance.setStatus = () => {};
  const changed = [];
  let restarts = 0;
  const engine = () => ({ context: r.context, started: true, stop() {}, stopAndWait: async () => {}, changed: (p) => changed.push(p), syncNow: async () => assert.fail("sync started while restore owns it") });
  instance.engine = engine();
  instance.startEngine = async () => { restarts++; instance.engine = engine(); };
  const version = await r.server.publish({ fileId: "31".repeat(16), path: "Notes/note.md", bytes: enc("RETAINED SENTINEL"), mtime: 1000, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const entry = { fileId: version.file_id, versionId: version.version_id, domainId: version.domain_id, path: "Notes/note.md", size: version.bytes, ts: 1000, deleted: false };
  return { ...r, instance, Plugin, box, entry, version, changed, restarts: () => restarts };
}

function reloadHarness(r) {
  const { instance } = r;
  let persisted = structuredClone(r.state.data), loads = 0, starts = 0;
  r.state.save = async () => { persisted = structuredClone(r.state.data); };
  instance.loadData = async () => { loads++; return structuredClone(persisted); };
  instance.saveData = async (value) => { persisted = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText() {} });
  instance.app = { vault: { adapter: {}, on: () => ({}) } };
  instance.manifest = { version: "0.1.11" };
  instance.checkForUpdate = async () => {};
  // Use actual plugin onload/startEngine admission. The engine port keeps
  // this normal reload test local, without opening a real vault or network.
  r.box.require(join(r.box.home, "build/sync/engine.js")).SyncEngine = class {
    started = false;
    constructor(options) { this.options = options; }
    async start() { starts++; this.started = true; }
    stop() { this.started = false; }
    async stopAndWait() { this.stop(); }
  };
  instance.startEngine = () => r.Plugin.prototype.startEngine.call(instance);
  return { loads: () => loads, starts: () => starts };
}

test("restore drains prior engine and manual Fetch work, blocks competing entry points, and enqueues the fresh copy", async (t) => {
  const r = await plugin(t);
  const stopped = deferred(), fetched = deferred();
  let versionReads = 0;
  const version = r.transport.historyVersion.bind(r.transport);
  r.transport.historyVersion = (...args) => { versionReads++; return version(...args); };
  r.instance.engine.stopAndWait = () => stopped.promise;
  r.instance.manualFetches.add(fetched.promise);
  const b = r.instance.openHistory();
  const pending = r.instance.restoreHistory(b, r.entry);
  assert.equal(r.instance.syncContext(), null);
  await assert.rejects(r.instance.fetchRemoteOnly(r.entry.fileId), /not running/);
  assert.throws(() => r.instance.openHistory(), /Start sync/);
  assert.throws(() => r.instance.restoreHistory(b, r.entry), /Another recovery/);
  await r.instance.syncNow();
  await r.Plugin.prototype.startEngine.call(r.instance);
  assert.equal(r.restarts(), 0);
  assert.equal(r.server.requests.length, 0, "no restore request before existing work drains");
  assert.equal(versionReads, 0);
  stopped.resolve();
  await new Promise(setImmediate);
  assert.equal(r.server.requests.length, 0, "the old Fetch still owns its writer");
  assert.equal(versionReads, 0, "no version read may start while an old Fetch owns admission");
  fetched.resolve("done");
  const result = await pending;
  assert.equal(result.syncRequested, true);
  assert.deepEqual(r.changed, [result.path]);
  assert.equal(r.host.text(result.path), "RETAINED SENTINEL");
  assert.equal(r.context.written.size, 0);
  assert.equal(r.state.fileByPath(result.path), undefined);
  assert.equal(r.restarts(), 1);
});

test("engine drain is required even with no older Fetch, and detached browsers cannot acquire ownership", async (t) => {
  const r = await plugin(t);
  const b = r.instance.openHistory();
  r.instance.histories.delete(b);
  assert.throws(() => r.instance.restoreHistory(b, r.entry), /Another recovery/);
  r.instance.histories.add(b);
  const stopped = deferred();
  r.instance.engine.stopAndWait = () => stopped.promise;
  let reads = 0;
  const version = r.transport.historyVersion.bind(r.transport);
  r.transport.historyVersion = (...args) => { reads++; return version(...args); };
  const restoring = r.instance.restoreHistory(b, r.entry);
  await new Promise(setImmediate);
  assert.equal(reads, 0, "engine ownership must drain before restore reads or writes");
  stopped.resolve();
  assert.ok((await restoring).path.includes("restored-"));
});

test("unload during a pending history read detaches restoration and never restarts or writes", async (t) => {
  const r = await plugin(t);
  const issued = deferred(), response = deferred();
  const request = r.transport.options.request;
  r.transport.options.request = async (value) => { issued.resolve(); await response.promise; return request(value); };
  const work = r.instance.restoreHistory(r.instance.openHistory(), r.entry);
  await issued.promise;
  r.instance.onunload();
  await assert.rejects(promptly(work), /cancelled/);
  assert.equal(r.restarts(), 0);
  assert.equal(r.host.files.size, 0);
  response.resolve();
  await new Promise(setImmediate);
  assert.equal(r.host.files.size, 0);
});

test("scope save cancels a pending restore read without waiting for its network response", async (t) => {
  const r = await plugin(t);
  const issued = deferred(), response = deferred();
  const request = r.transport.options.request;
  r.transport.options.request = async (value) => { issued.resolve(); await response.promise; return request(value); };
  const restore = r.instance.restoreHistory(r.instance.openHistory(), r.entry);
  const refused = assert.rejects(restore, /cancelled/);
  await issued.promise;
  await promptly(r.instance.saveSyncFolders([]));
  await refused;
  assert.deepEqual(r.state.data.syncFolders, []);
  assert.equal(r.host.files.size, 0);
  response.resolve();
  await new Promise(setImmediate);
  assert.equal(r.host.files.size, 0);
  assert.equal(r.restarts(), 1, "only the scope continuation restarted");
});

test("scope save waits for dispatched local publication and retains the resulting copy", async (t) => {
  const r = await plugin(t);
  const entered = deferred(), release = deferred();
  const createWriter = r.host.createWriter.bind(r.host);
  r.host.createWriter = async (...args) => {
    const writer = await createWriter(...args);
    return { ...writer, commit: async (mtime) => {
      // Model a native create that has passed its final guard and was dispatched.
      const stat = await writer.commit(mtime);
      entered.resolve();
      await release.promise;
      return stat;
    } };
  };
  const restore = r.instance.restoreHistory(r.instance.openHistory(), r.entry);
  await entered.promise;
  let saved = false;
  const scope = r.instance.saveSyncFolders([]).then(() => { saved = true; });
  await new Promise(setImmediate);
  assert.equal(saved, false, "local publication must settle before scope changes");
  release.resolve();
  const result = await restore;
  await scope;
  assert.equal(result.syncRequested, false);
  assert.equal(r.host.text(result.path), "RETAINED SENTINEL");
  assert.deepEqual(r.state.data.syncFolders, []);
});

test("unload after create dispatch reports the preserved local copy without claiming sync", async (t) => {
  const r = await plugin(t);
  const entered = deferred(), release = deferred();
  const createWriter = r.host.createWriter.bind(r.host);
  r.host.createWriter = async (...args) => {
    const writer = await createWriter(...args);
    return { ...writer, commit: async (mtime) => {
      const stat = await writer.commit(mtime);
      entered.resolve();
      await release.promise;
      return stat;
    } };
  };
  const restore = r.instance.restoreHistory(r.instance.openHistory(), r.entry);
  await entered.promise;
  r.instance.onunload();
  release.resolve();
  const result = await restore;
  assert.equal(result.syncRequested, false);
  assert.equal(r.restarts(), 0);
  assert.equal(r.host.text(result.path), "RETAINED SENTINEL");
});

test("engine replacement and identity changes invalidate a browser before filesystem access", async (t) => {
  for (const change of ["engine", "identity", "key", "server"]) {
    const r = await plugin(t);
    const b = r.instance.openHistory();
    if (change === "engine") r.instance.engine = { ...r.instance.engine };
    if (change === "identity") r.state.data.deviceId = "99".repeat(16);
    if (change === "key") r.state.data.vrk = "99".repeat(32);
    if (change === "server") r.state.data.serverUrl = "https://other.example.invalid";
    await assert.rejects(b.next(), /cancelled/);
    assert.throws(() => r.instance.restoreHistory(b, r.entry), /cancelled/);
    assert.equal(r.server.requests.length, 0);
    assert.equal(r.host.files.size, 0);
  }
});

test("local-copy receipt does not await ordinary startup, and restart failure preserves it", async (t) => {
  for (const failure of [false, true]) {
    const r = await plugin(t);
    const restarted = deferred(), published = deferred();
    const create = r.host.createWriter.bind(r.host);
    r.host.createWriter = async (...args) => {
      const writer = await create(...args);
      return { ...writer, commit: async (mtime) => { const stat = await writer.commit(mtime); published.resolve(); return stat; } };
    };
    r.instance.startEngine = () => failure ? Promise.reject(new Error("START SENTINEL")) : restarted.promise;
    const restoring = r.instance.restoreHistory(r.instance.openHistory(), r.entry);
    await published.promise;
    const result = await promptly(restoring);
    assert.equal(result.syncRequested, true, "request is distinct from verified remote completion");
    assert.equal(r.host.text(result.path), "RETAINED SENTINEL");
    assert.equal(r.instance.manualRestore, null, "network startup no longer owns local publication");
    r.instance.onunload();
    // A later onload creates a fresh generation and a different live engine.
    // The old completion must not enqueue into that new generation.
    r.instance.lifecycle = {};
    r.instance.engine = { started: true, changed: (path) => r.changed.push(path) };
    restarted.resolve();
    await new Promise(setImmediate);
    assert.deepEqual(r.changed, [], "late startup cannot enqueue into an unloaded generation");
    assert.equal(r.host.text(result.path), "RETAINED SENTINEL");
  }
});

for (const failure of [false, true]) test(`same-instance reload resumes after ${failure ? "uncertain" : "successful"} old publication under only the newest generation`, async (t) => {
  for (const transition of ["reload", "reload_twice", "unload_again"]) {
    const r = await plugin(t), h = reloadHarness(r);
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const create = r.host.createWriter.bind(r.host);
    const { CopyPublicationError } = r.box.require(join(r.box.home, "build/sync/history.js"));
    let path;
    r.host.createWriter = async (...args) => {
      const writer = await create(...args);
      return { ...writer, commit: async (mtime) => {
        const stat = await writer.commit(mtime);
        path = stat.path;
        entered.resolve();
        await release.promise;
        if (failure) throw new CopyPublicationError(path);
        return stat;
      } };
    };
    const outcome = r.instance.restoreHistory(r.instance.openHistory(), r.entry).then((value) => ({ value }), (error) => ({ error }));
    await entered.promise;
    r.instance.onunload();
    const oldState = r.instance.state;
    const firstLoad = r.instance.onload();
    await new Promise(setImmediate);
    assert.equal(h.loads(), 0, "state must not load while publication owns the old snapshot");
    assert.equal(h.starts(), 0);
    assert.equal(r.instance.engine, null);
    assert.notEqual(r.instance.restoring, null, "reload must retain the old publication owner");
    let secondLoad;
    if (transition !== "reload") {
      r.instance.onunload();
      if (transition === "reload_twice") secondLoad = r.instance.onload();
    }
    release.resolve();
    const result = await outcome;
    await Promise.all([firstLoad, secondLoad]);
    assert.equal(r.host.text(path), "RETAINED SENTINEL");
    if (failure) assert.match(result.error.message, /copy may exist/);
    else { assert.equal(result.value.path, path); assert.equal(result.value.syncRequested, false); }
    assert.equal(r.instance.restoring, null);
    assert.equal(r.instance.manualRestore, null);
    if (transition === "unload_again") {
      assert.equal(h.loads(), 0);
      assert.equal(h.starts(), 0);
      assert.equal(r.instance.state, oldState);
      assert.equal(r.instance.engine, null);
    } else {
      assert.equal(h.loads(), 1, "only the latest generation reads state");
      assert.equal(h.starts(), 1, "new onload owns automatic resumption after settlement");
      assert.notEqual(r.instance.state, oldState);
      assert.equal(r.instance.state.paired, true);
      assert.equal(r.instance.engine.started, true);
    }
    r.instance.onunload();
  }
});

for (const older of ["engine", "manual_fetch"]) test(`reload reads state only after the old ${older} persistence completes`, async (t) => {
  const r = await plugin(t), h = reloadHarness(r);
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const persist = async () => {
    entered.resolve();
    await release.promise;
    r.state.data.deviceName = "AFTER PERSISTENCE SENTINEL";
    await r.state.save();
  };
  if (older === "engine") r.instance.engine.stopAndWait = persist;
  else {
    const fetch = persist().then(() => "done");
    r.instance.manualFetches.add(fetch);
    void fetch.finally(() => r.instance.manualFetches.delete(fetch));
  }
  const outcome = r.instance.restoreHistory(r.instance.openHistory(), r.entry).then(() => null, (error) => error);
  await entered.promise;
  r.instance.onunload();
  const loading = r.instance.onload();
  await new Promise(setImmediate);
  assert.equal(h.loads(), 0, "an older writer can still change the stored snapshot");
  assert.equal(h.starts(), 0);
  release.resolve();
  assert.match((await outcome).message, /cancelled/);
  await loading;
  assert.equal(h.loads(), 1);
  assert.equal(h.starts(), 1);
  assert.equal(r.instance.state.data.deviceName, "AFTER PERSISTENCE SENTINEL");
  assert.equal(r.host.files.size, 0);
  r.instance.onunload();
});
