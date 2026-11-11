/**
 * A stopped engine says it stopped.
 *
 * `stopAndWait` ended in `idle`, which the status bar draws as the check of a
 * device in step, so a folder save, a leave, a restore or an encryption change
 * that stopped sync could leave "synced" on screen while nothing synced (a
 * desktop rig recorded it for a pending transition, 1.1.10). The engine now
 * ends in `stopped`, with the words for what stopped it; the bar shows its own
 * icon for it; and a start that gets through takes it back.
 *
 * And the operations sync waits for -- a folder save, a leave, a restore --
 * are one field (`Operation`), so two of them at once cannot be written down.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, memorySecrets, rig, sandbox, statusItem, until } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SCAN_MS, SyncEngine } = require("../build/sync/engine.js");

test("the engine's stop ends in `stopped`, with its words, and nothing after it says otherwise", async (t) => {
  const r = await rig();
  r.host.seed("Notes/a.md", "a note\n", 1000);
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, now: () => r.host.clock, timers, onStatus: (status) => statuses.push(status) });
  t.after(() => engine.stop());
  await engine.start();
  await engine.syncNow();
  assert.notEqual(statuses.at(-1)?.kind, "stopped");
  await engine.stopAndWait("saving the folder selection");
  assert.deepEqual(statuses.at(-1), { kind: "stopped", why: "saving the folder selection" });
  const said = statuses.length;
  await timers.run(SCAN_MS * 2);
  assert.equal(statuses.length, said, `a stopped engine spoke again: ${JSON.stringify(statuses.slice(said))}`);
});

test("the bar has its own icon and words for `stopped`, never the check", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { indicated } = box.require(join(box.home, "build/ui/indicator.js"));
  const { statusWords } = box.require(join(box.home, "build/main.js"));
  for (const quiet of [false, true]) assert.equal(indicated({ kind: "stopped", why: "leaving the server" }, quiet), "stopped");
  assert.equal(indicated({ kind: "idle" }, false), "synced");
  assert.equal(statusWords({ kind: "stopped", why: "leaving the server" }), "stopped — leaving the server");
});

test("a start goes on only while no operation runs and no encryption transition is pending", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { startWanted } = box.require(join(box.home, "build/main.js"));
  const table = [
    [{ kind: "none" }, false, true],
    [{ kind: "none" }, true, false],
    [{ kind: "scope" }, false, false],
    [{ kind: "scope" }, true, false],
    [{ kind: "leave" }, false, false],
    [{ kind: "leave" }, true, false],
    [{ kind: "restore", operation: {} }, false, false],
    [{ kind: "restore", operation: {} }, true, false],
  ];
  for (const [operation, transition, wanted] of table) {
    assert.equal(startWanted(operation, transition), wanted, `${operation.kind}, transition=${transition}`);
  }
});

// ---- the compiled plugin ------------------------------------------------------

/**
 * The compiled plugin over an admitted vault, with a stand-in engine that
 * stops as the real one does (above): it ends by saying it stopped, and why.
 * A start says nothing of its own, as a quiet real start does. `hold()` makes
 * the next start wait until the returned function is called.
 */
async function plugin(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  let revoke = null;
  box.require(join(box.home, "build/fetchHttp.js")).fetchHttp = async (request) => {
    if (request.method === "POST" && /\/revoke$/.test(new URL(request.url).pathname)) await revoke?.promise;
    return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(2) };
  };
  const engines = [];
  let held = null;
  box.require(join(box.home, "build/sync/engine.js")).SyncEngine = class {
    constructor(options) { this.options = options; this.started = false; engines.push(this); }
    get context() { return { state: this.options.state }; }
    reachability() {}
    async start() { if (held !== null) await held; this.started = true; }
    stop() { this.started = false; }
    async stopAndWait(why) { this.stop(); this.options.onStatus({ kind: "stopped", why }); }
    async syncNow() {}
    wake() {}
    current() { return { kind: "idle" }; }
  };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  const load = instance.onload.bind(instance);
  instance.onload = async () => { await load(); await instance.firstStart; };
  let metadata = { vrk: null, deviceId: null, deviceSecret: null, serverUrl: "https://sync.example.test", edgeHeaders: [] };
  const bar = statusItem(), logs = [];
  instance.loadData = async () => structuredClone(metadata);
  instance.saveData = async (value) => { metadata = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => bar;
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}), getFiles: () => [] }, workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed() } };
  instance.manifest = { version: "1.1.13" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  t.after(() => instance.onunload());
  const { State } = box.require(join(box.home, "build/state.js")), c = box.require(join(box.home, "build/crypto.js"));
  const admitted = await State.open(instance, false, instance.app.secretStorage);
  await admitted.stageEnrollment2(KEYS.vrk, "pair");
  await admitted.adoptSuite2({ root: KEYS.vrk, generation: (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(KEYS.vrk)))).fileId,
    deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, purpose: "pair" });
  await instance.onload();
  const shows = () => bar.getAttribute("data-state");
  return {
    instance, bar, logs, engines, shows,
    hold() { let release; held = new Promise((resolve) => { release = resolve; }); return () => { held = null; release(); }; },
    holdRevoke() { let release; revoke = { promise: new Promise((resolve) => { release = resolve; }) }; return () => { revoke = null; release(); }; },
  };
}

test("a folder save shows the stop while it waits, and the start after it takes the stop back", async (t) => {
  const p = await plugin(t);
  assert.equal(p.shows(), "synced");
  const release = p.hold();
  const saving = p.instance.saveSyncFolders(undefined);
  await until(() => p.shows() === "stopped");
  assert.equal(p.shows(), "stopped", p.bar.label);
  assert.equal(p.bar.label, "obsync: stopped — saving the folder selection");
  release();
  await saving;
  await until(() => p.shows() === "synced");
  assert.equal(p.engines.at(-1).started, true);
  assert.equal(p.shows(), "synced", "a start that got through left the stop's words up");
});

test("a start superseded by a folder save leaves the bar on the stop, not on the check", async (t) => {
  const p = await plugin(t);
  const release = p.hold();
  const restart = p.instance.restartEngine();
  // The restart's engine is made and held in its start.
  await until(() => p.engines.length === 2 && p.instance.engine === p.engines[1]);
  assert.equal(p.instance.engine, p.engines[1], "the restart never reached its start");
  const saving = p.instance.saveSyncFolders(undefined);
  await until(() => p.shows() === "stopped");
  assert.equal(p.shows(), "stopped", p.bar.label);
  release();
  await Promise.all([restart, saving]);
  await until(() => p.logs.some((line) => /^engine decision=stopped reason=superseded/.test(line)));
  assert.ok(p.logs.some((line) => /^engine decision=stopped reason=superseded/.test(line)), p.logs.join(" | "));
});

test("a leave shows the stop while it gives up the credential, and ends unpaired, never on the check", async (t) => {
  const p = await plugin(t);
  const release = p.holdRevoke();
  const leaving = p.instance.leaveServer({ discardUnpushed: true, localOnly: false });
  await until(() => p.shows() === "stopped");
  assert.equal(p.shows(), "stopped", p.bar.label);
  assert.equal(p.bar.label, "obsync: stopped — leaving the server");
  // AND NOTHING ELSE STARTS BESIDE IT: a folder save and a restore are refused while it runs.
  await assert.rejects(p.instance.saveSyncFolders(undefined), /leaving its server/);
  const browser = { operation: { check() {}, cancel() {} } };
  p.instance.histories.add(browser);
  assert.throws(() => p.instance.restoreHistory(browser, {}), /leaving its server/);
  p.instance.histories.delete(browser);
  release();
  const result = await leaving;
  await until(() => p.bar.label === "obsync: not paired");
  assert.equal(result.decision, "left", JSON.stringify(result));
  assert.notEqual(p.shows(), "synced");
  assert.equal(p.bar.label, "obsync: not paired");
  assert.equal(p.instance.operation.kind, "none");
});

test("an encryption change, and this device removing itself, stop sync under words that are not the check", async (t) => {
  const p = await plugin(t);
  await p.instance.quiesceForRotation();
  assert.equal(p.shows(), "stopped", p.bar.label);
  assert.equal(p.bar.label, "obsync: stopped — changing encryption");

  const q = await plugin(t);
  await q.instance.revokeDevice(KEYS.deviceId);
  await until(() => q.shows() === "attention");
  assert.equal(q.shows(), "attention", q.bar.label);
});
