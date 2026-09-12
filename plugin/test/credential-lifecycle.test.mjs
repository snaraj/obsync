/** Actual compiled plugin orchestration with a local, non-rendering host port. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KEYS, memorySecrets, sandbox } from "./fake.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
async function fixture(t, initial = null) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian"), requests = [], logs = [], statuses = [];
  obsidian.requestUrl = async (request) => { requests.push(request); return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }; };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  let metadata = structuredClone(initial), loads = 0, starts = 0;
  const writes = [], hooks = { save: null };
  instance.loadData = async () => { loads++; return structuredClone(metadata); };
  instance.saveData = async (value) => { if (hooks.save) await hooks.save(); metadata = structuredClone(value); writes.push(metadata); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText() {} });
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) } };
  instance.manifest = { version: "0.1.16" };
  instance.checkForUpdate = async () => {};
  instance.startEngine = async () => { starts++; };
  instance.log = (line) => logs.push(line);
  instance.setStatus = (status) => statuses.push(status);
  return { box, obsidian, instance, requests, logs, statuses, hooks, writes,
    loads: () => loads, starts: () => starts, metadata: () => structuredClone(metadata) };
}

const identity = () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
  serverUrl: "https://sync.example.invalid", edgeHeaders: [] });

test("unavailable native storage stops startup without writing metadata or starting requests", async (t) => {
  const r = await fixture(t, identity());
  r.instance.app.secretStorage = undefined;
  await assert.rejects(r.instance.onload(), /unavailable/);
  assert.equal(r.starts(), 0);
  assert.equal(r.writes.length, 0);
  assert.equal(r.requests.length, 0);
  assert.deepEqual(r.metadata(), identity());
  assert.ok(r.obsidian.notices.some((message) => message.includes("Sync is stopped")));
});

test("a failed native save stops the active engine and refuses its future transport requests", async (t) => {
  const r = await fixture(t, identity());
  await r.instance.onload();
  const transport = r.instance.transport;
  let stopped = 0;
  r.instance.engine = { stop: () => { stopped++; } };
  r.hooks.save = async () => { throw new Error("fixture metadata failed"); };
  r.instance.state.data.edgeHeaders = [{ name: "X-Local", value: "LOCAL EDGE SENTINEL" }];
  await assert.rejects(r.instance.state.save(), /metadata_write_failed/);
  assert.equal(stopped, 1);
  assert.equal(r.instance.engine, null);
  assert.equal(r.statuses.at(-1).kind, "error");
  await assert.rejects(async () => transport.options.request({ url: "https://sync.example.invalid/v1/account" }), /metadata_write_failed/);
  assert.equal(r.requests.length, 0);
  assert.ok(r.logs.includes("state decision=stopped reason=metadata_write_failed"));
  assert.ok(!JSON.stringify([r.logs, r.statuses, r.obsidian.notices, r.metadata()]).includes("LOCAL EDGE SENTINEL"));
});

test("old transports remain bound to their old state and cannot issue after replacement", async (t) => {
  const r = await fixture(t, identity());
  await r.instance.onload();
  const old = r.instance.transport;
  r.instance.state = { data: { deviceId: "replacement", serverUrl: "https://new.example.invalid" } };
  assert.equal(old.options.device().id, KEYS.deviceId);
  assert.equal(old.options.serverUrl(), identity().serverUrl);
  await assert.rejects(async () => old.options.request({ url: "https://sync.example.invalid" }), /inactive/);
  assert.equal(r.requests.length, 0);
});

for (const stage of ["response", "save"]) {
  test(`setup's superseded ${stage} completion leaves replacement identity untouched`, async (t) => {
    const r = await fixture(t, { ...identity(), deviceId: null, deviceSecret: null });
    await r.instance.onload();
    const entered = deferred(), released = deferred(), original = r.instance.state;
    const replacement = { data: { deviceId: "replacement", vrk: "replacement" }, save: () => assert.fail("replacement save") };
    r.instance.transport.setup = async () => {
      if (stage === "response") { entered.resolve(); await released.promise; }
      return { outcome: "ok", value: { device_id: KEYS.deviceId, device_secret: KEYS.deviceSecret } };
    };
    if (stage === "save") r.hooks.save = async () => { entered.resolve(); await released.promise; };
    const settingUp = r.instance.setUpAccount("local setup sentinel", "Local account");
    await entered.promise;
    r.instance.state = replacement;
    r.instance.lifecycle = {};
    released.resolve();
    await settingUp;
    assert.deepEqual(replacement.data, { deviceId: "replacement", vrk: "replacement" });
    assert.equal(r.starts(), 0);
    assert.equal(original.data.deviceId, stage === "response" ? null : KEYS.deviceId);
    assert.ok(r.obsidian.notices.some((message) => message.includes("previous plugin session is inactive")));
  });
}

test("credential-only enrollment refuses replayed setup before any HTTP request", async (t) => {
  const r = await fixture(t, { ...identity(), vrk: null });
  await r.instance.onload();
  r.instance.transport.setup = async () => assert.fail("existing enrollment must not be replayed");
  await r.instance.setUpAccount("local setup sentinel", "Local account");
  assert.equal(r.starts(), 0);
  assert.ok(r.obsidian.notices.some((message) => message.includes("already has an enrollment")));
});

test("key adoption never restarts after a rejected save or superseded save completion", async (t) => {
  for (const failure of [false, true]) {
    const r = await fixture(t);
    await r.instance.onload();
    const entered = deferred(), released = deferred();
    r.hooks.save = async () => { entered.resolve(); await released.promise; if (failure) throw new Error("fixture failure"); };
    const adopting = r.instance.adoptVaultKey(KEYS.vrk);
    const refused = assert.rejects(adopting, failure ? /metadata_write_failed/ : /inactive/);
    await entered.promise;
    const replacement = { data: { vrk: "replacement" }, save: () => assert.fail("replacement save") };
    if (!failure) { r.instance.state = replacement; r.instance.lifecycle = {}; }
    released.resolve();
    await refused;
    assert.equal(r.starts(), 0);
    assert.equal(replacement.data.vrk, "replacement");
  }
});

for (const stage of ["initial migration", "bookkeeping"]) {
  test(`reload waits for the prior ${stage} write before reading its snapshot`, async (t) => {
    const r = await fixture(t, identity());
    if (stage === "bookkeeping") await r.instance.onload();
    const entered = deferred(), released = deferred();
    r.hooks.save = async () => { entered.resolve(); await released.promise; };
    let first;
    if (stage === "initial migration") first = r.instance.onload();
    else { r.instance.state.data.lastSeq = 9; first = r.instance.state.save(); }
    await entered.promise;
    const before = r.loads();
    const second = r.instance.onload();
    await tick();
    assert.equal(r.loads(), before, "replacement load must not read ahead of the old writer");
    released.resolve();
    await Promise.all([first, second]);
    assert.equal(r.loads(), before + 1);
    assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
    assert.equal(r.instance.state.data.vrk, KEYS.vrk);
    assert.equal(r.instance.state.data.lastSeq, stage === "bookkeeping" ? 9 : 0);
    assert.equal(r.starts(), stage === "bookkeeping" ? 2 : 1);
  });
}

test("asynchronous settings handlers surface storage failure without an unhandled rejection", async (t) => {
  for (const field of ["Server URL", "Edge service-token headers"]) {
    const r = await fixture(t, identity());
    await r.instance.onload();
    const handlers = new Map();
    class Setting {
      setName(value) { this.name = value; return this; }
      setHeading() { return this; } setDesc() { return this; }
      addText(callback) { const widget = { setPlaceholder: () => widget, setValue: () => widget,
        onChange: (handler) => { handlers.set(this.name, handler); return widget; } }; callback(widget); return this; }
      addTextArea(callback) { return this.addText(callback); }
      addButton() { return this; }
    }
    r.obsidian.Setting = Setting;
    const { ObsyncSettingTab } = r.box.require(join(r.box.home, "build/ui/settings.js"));
    const tab = new ObsyncSettingTab(r.instance.app, r.instance);
    tab.server({});
    r.hooks.save = async () => { throw new Error("fixture failure"); };
    handlers.get(field)(field === "Server URL" ? "https://new.example.invalid" : "X-Local: LOCAL TOKEN SENTINEL");
    await tick();
    assert.equal(r.instance.state.paired, false);
    assert.ok(r.obsidian.notices.some((message) => message.includes("Sync is stopped")));
    assert.ok(!JSON.stringify(r.metadata()).includes("LOCAL TOKEN SENTINEL"));
  }
});

test("changing the server URL invalidates a captured enrollment session", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  const session = r.instance.captureSession();
  r.instance.state.data.serverUrl = "https://different.example.invalid";
  assert.throws(session.assertCurrent, /inactive/);
});

test("unloading invalidates a captured session even before state or transport are replaced", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  const session = r.instance.captureSession();
  r.instance.onunload();
  assert.throws(session.assertCurrent, /inactive/);
});
