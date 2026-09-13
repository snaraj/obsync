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
  instance.manifest = { version: "0.1.18" };
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
  r.instance.engine = { stop: () => { stopped++; }, stopAndWait: async () => {} };
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

function vaultKeyDialog(r, derive) {
  const handlers = new Map();
  let closed = 0, generated = 0, recoveryShown = 0;
  class Setting {
    setName() { return this; }
    addTextArea(callback) {
      const area = { setPlaceholder: () => area, onChange: () => area };
      callback(area); return this;
    }
    addButton(callback) {
      let label;
      const button = { setButtonText: (value) => { label = value; return button; },
        onClick: (handler) => { handlers.set(label, handler); return button; } };
      callback(button); return this;
    }
  }
  r.obsidian.Setting = Setting;
  const pairing = r.box.require(join(r.box.home, "build/pairing.js"));
  pairing.entropyFromPhrase = derive;
  pairing.newVaultKey = () => { generated++; return new Uint8Array(32).fill(83); };
  const { VaultKeyModal, RecoveryPhraseModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  RecoveryPhraseModal.prototype.open = () => { recoveryShown++; };
  const modal = new VaultKeyModal(r.instance.app, r.instance);
  modal.setTitle = () => {};
  modal.contentEl = { createEl() {}, empty() {} };
  modal.close = () => { closed++; modal.onClose(); };
  modal.onOpen();
  return { modal, handlers, closed: () => closed, generated: () => generated, recoveryShown: () => recoveryShown };
}

test("a current recovery dialog persists its derived key before reporting success", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  const entered = deferred(), release = deferred();
  const dialog = vaultKeyDialog(r, async () => { entered.resolve(); await release.promise; return new Uint8Array(32).fill(83); });
  const restoring = dialog.handlers.get("Restore")();
  await entered.promise;
  assert.equal(r.instance.state.data.vrk, null);
  assert.equal(r.starts(), 0);
  release.resolve();
  await restoring;
  assert.equal(r.instance.state.data.vrk, "53".repeat(32));
  assert.equal(r.metadata().credentialRevision, 2);
  assert.equal(r.starts(), 1);
  assert.equal(dialog.closed(), 1);
  assert.ok(r.obsidian.notices.includes("obsync: vault key restored."));
});

for (const cancellation of ["reload", "close"]) {
  test(`a held recovery phrase cannot change state after dialog ${cancellation}`, async (t) => {
    const r = await fixture(t);
    await r.instance.onload();
    const entered = deferred(), release = deferred();
    const dialog = vaultKeyDialog(r, async () => { entered.resolve(); await release.promise; return new Uint8Array(32).fill(83); });
    const restoring = dialog.handlers.get("Restore")();
    await entered.promise;
    if (cancellation === "reload") await r.instance.onload();
    else dialog.modal.close();
    const state = r.instance.state, metadata = r.metadata(), starts = r.starts();
    release.resolve();
    await restoring;
    assert.equal(state.data.vrk, null);
    assert.deepEqual(r.metadata(), metadata);
    assert.equal(r.starts(), starts);
    assert.ok(r.obsidian.notices.some((message) => message.includes(cancellation === "reload" ? "previous plugin session is inactive" : "dialog was closed")));
    assert.ok(!r.obsidian.notices.includes("obsync: vault key restored."));
  });
}

for (const action of ["Restore", "Create a new vault key"]) {
  test(`an open dialog from a prior load refuses ${action} before deriving or generating a key`, async (t) => {
    const r = await fixture(t);
    await r.instance.onload();
    let derived = 0;
    const dialog = vaultKeyDialog(r, async () => { derived++; return new Uint8Array(32).fill(83); });
    await r.instance.onload();
    const metadata = r.metadata();
    await dialog.handlers.get(action)();
    assert.equal(derived, 0);
    assert.equal(dialog.generated(), 0);
    assert.equal(dialog.recoveryShown(), 0);
    assert.equal(r.instance.state.data.vrk, null);
    assert.deepEqual(r.metadata(), metadata);
    assert.ok(r.obsidian.notices.some((message) => message.includes("previous plugin session is inactive")));
  });
}

test("new-key dialog handles a rejected save without showing recovery or an unhandled rejection", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  const dialog = vaultKeyDialog(r, async () => assert.fail("no phrase derivation for a new key"));
  r.hooks.save = async () => { throw new Error("fixture metadata failure"); };
  await dialog.handlers.get("Create a new vault key")();
  assert.equal(dialog.generated(), 1);
  assert.equal(dialog.recoveryShown(), 0);
  assert.equal(dialog.closed(), 0);
  assert.equal(r.starts(), 0);
  assert.ok(r.obsidian.notices.some((message) => message.includes("metadata_write_failed")));
});

for (const cause of ["storage failure", "unload", "same-instance reload"]) {
  for (const rejects of [false, true]) {
    test(`${cause} retains the previous engine drain until ${rejects ? "rejection is handled" : "work settles"}`, async (t) => {
      const r = await fixture(t, identity());
      await r.instance.onload();
      const release = deferred();
      let drains = 0, stopped = 0;
      r.instance.engine = { stop() { stopped++; }, async stopAndWait() {
        drains++; await release.promise;
        if (rejects) throw new Error("fixture final persistence failure after drain");
      } };
      if (cause === "storage failure") {
        r.hooks.save = async () => { throw new Error("fixture metadata failure"); };
        await assert.rejects(r.instance.state.save(), /metadata_write_failed/);
        r.hooks.save = null;
      } else if (cause === "unload") {
        r.instance.onunload();
        r.instance.onunload(); // Repeated teardown must not start another drain.
      }
      if (cause !== "same-instance reload") {
        assert.equal(r.instance.engine, null);
        assert.equal(stopped, 1, "failure and unload stop admission immediately");
      }
      const starts = r.starts(), loads = r.loads();
      const loading = r.instance.onload();
      await tick();
      assert.equal(r.starts(), starts, "no replacement engine while old work is held");
      assert.equal(r.loads(), loads, "no replacement state snapshot before old writers drain");
      assert.equal(stopped, 1);
      assert.equal(drains, 1);
      release.resolve();
      await loading;
      assert.equal(r.starts(), starts + 1);
      assert.equal(r.loads(), loads + 1);
      assert.equal(r.instance.engineTeardowns.size, 0);
      assert.equal(r.logs.includes("engine decision=stopped reason=teardown_save_failed"), rejects);
      assert.equal(r.instance.state.data.vrk, KEYS.vrk);
    });
  }
}

test("a current new-key dialog persists the key before showing its recovery phrase", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  const dialog = vaultKeyDialog(r, async () => assert.fail("no phrase derivation for a new key"));
  await dialog.handlers.get("Create a new vault key")();
  assert.equal(dialog.generated(), 1);
  assert.equal(r.instance.state.data.vrk, "53".repeat(32));
  assert.equal(r.metadata().credentialRevision, 2);
  assert.equal(r.starts(), 1);
  assert.equal(dialog.closed(), 1);
  assert.equal(dialog.recoveryShown(), 1);
});

for (const action of ["Restore", "Create a new vault key"]) {
  test(`closing during the ${action} save retains its dispatched write without late dialog success`, async (t) => {
    const r = await fixture(t);
    await r.instance.onload();
    const entered = deferred(), release = deferred();
    const dialog = vaultKeyDialog(r, async () => new Uint8Array(32).fill(83));
    r.hooks.save = async () => { entered.resolve(); await release.promise; };
    const applying = dialog.handlers.get(action)();
    await entered.promise;
    dialog.modal.close();
    release.resolve();
    await applying;
    assert.equal(r.instance.state.data.vrk, "53".repeat(32), "an already-dispatched write is not undone by closing a dialog");
    assert.equal(r.metadata().credentialRevision, 2);
    assert.equal(dialog.closed(), 1, "the old callback must not close a later dialog");
    assert.equal(dialog.recoveryShown(), 0);
    assert.ok(!r.obsidian.notices.includes("obsync: vault key restored."));
    assert.ok(r.obsidian.notices.some((message) => message.includes("dialog was closed")));
  });
}

test("an active startup failure retains its drain before a replacement load", async (t) => {
  const r = await fixture(t, identity());
  await r.instance.onload();
  const Plugin = r.box.require(join(r.box.home, "build/main.js")).default;
  const Engine = r.box.require(join(r.box.home, "build/sync/engine.js")).SyncEngine;
  const release = deferred();
  let drains = 0;
  Engine.prototype.start = async () => { throw new Error("fixture startup failure"); };
  Engine.prototype.stopAndWait = async function () { this.stop(); drains++; await release.promise; };
  r.instance.startEngine = () => Plugin.prototype.startEngine.call(r.instance);
  await r.instance.startEngine();
  assert.equal(r.instance.engine, null);
  assert.equal(r.instance.engineTeardowns.size, 1);
  assert.equal(r.statuses.at(-1).message, "fixture startup failure");
  Engine.prototype.start = async () => {};
  const loads = r.loads(), loading = r.instance.onload();
  await tick();
  assert.equal(r.loads(), loads);
  assert.equal(drains, 1);
  release.resolve();
  await loading;
  assert.equal(r.loads(), loads + 1);
  assert.ok(r.instance.engine);
  assert.equal(r.instance.engineTeardowns.size, 0);
});
