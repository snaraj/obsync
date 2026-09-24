/**
 * A device that opens Obsidian while its server cannot be reached resumes on
 * its own once it can (issue #129).
 *
 * WHAT IS DRIVEN. The real plugin class, loaded as Obsidian loads it, through
 * its real `onload`, `startEngine`, `syncNow`, `saveSyncFolders`,
 * `leaveServer` and `onunload`. The engine behind it is a port whose `start`
 * answers as the test says -- the transport's own `ApiError`, constructed from
 * the same module the plugin imports, or a local fault -- because the decision
 * under test is the plugin's: which failures get another start and which do
 * not, when, and never two engines at once. The last test closes the seam
 * from the other side: the REAL engine over the REAL transport, against a
 * server that does not answer, throws exactly the `ApiError` the plugin
 * classifies, unwrapped.
 *
 * TIME. `window` is a fake that records every timer and every listener and
 * fires nothing on its own, so a five-minute pause is a number in a table and
 * the `online` event is a function call. Nothing here waits on the wall clock.
 *
 * PLATFORM. The behaviour is the same on desktop and mobile: both renderers
 * provide `window.setTimeout` and raise `online`, and the fake stands in for
 * either. What a phone does with a timer while the app is in the background
 * is the renderer's, not the plugin's, and is a real-device observation.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FakeTimers, KEYS, memorySecrets, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);

/** Let every continuation a start left behind run: three turns is more than any path here takes. */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

/** A `window` that records timers and listeners and fires them only when told. */
function fakeWindow() {
  const timers = new Map();
  const listeners = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener() {},
    /** The delays armed right now, oldest first. */
    armed: () => [...timers.values()].map((timer) => timer.ms),
    /** The clock reaching the one armed timer. */
    fire() {
      assert.equal(timers.size, 1, `exactly one timer is armed, not ${timers.size}`);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.fn();
    },
    /** The renderer raising `online`. */
    online() { for (const fn of listeners.get("online") ?? []) fn(); },
  };
}

const identity = () => ({
  vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
  serverUrl: "https://sync.example.invalid", edgeHeaders: [],
});

/**
 * The real plugin over an engine port. `plan(fn)` decides what the n-th start
 * does -- throw, hang, or return -- and every start not planned succeeds.
 */
async function fixture(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const win = fakeWindow();
  const previousWindow = globalThis.window;
  globalThis.window = win;
  t.after(() => { globalThis.window = previousWindow; });
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const { ApiError } = box.require(join(box.home, "build/transport.js"));
  const { DomainMapError } = box.require(join(box.home, "build/domainmap.js"));
  const engines = [];
  let starts = 0;
  let plan = async () => undefined;
  box.require(join(box.home, "build/sync/engine.js")).SyncEngine = class {
    started = false;
    constructor(options) { this.options = options; engines.push(this); }
    async start() { await plan(++starts, this); this.started = true; }
    stop() { this.started = false; }
    async stopAndWait() { this.stop(); }
    async syncNow() { this.manual = (this.manual ?? 0) + 1; }
  };
  const instance = new Plugin();
  // Obsidian does not wait for the first start (`onload` returns before it); these tests do.
  const load = instance.onload.bind(instance);
  instance.onload = async () => { await load(); await instance.firstStart; };
  let metadata = identity();
  const logs = [], bar = [];
  instance.loadData = async () => structuredClone(metadata);
  instance.saveData = async (value) => { metadata = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText: (text) => bar.push(text) });
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: { onLayoutReady: (listed) => listed() } };
  instance.manifest = { version: "1.1.1" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  t.after(() => instance.onunload());
  return {
    instance, win, logs, bar, engines, ApiError, DomainMapError,
    plan: (fn) => { plan = fn; },
    running: () => engines.filter((engine) => engine.started),
    /** What the transport throws once its own retries are spent: nothing answered, or a 5xx did. */
    unreachable: (status = 0) => new ApiError(status, "unreachable", status === 0 ? "network=SENTINEL" : `status=${status}`),
    scheduled: () => logs.filter((line) => line.startsWith("engine decision=retry_scheduled ")),
  };
}

test("a start the server could not be reached for is retried, and the next one that gets through resumes", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n === 1) throw r.unreachable(); });
  await r.instance.onload();
  assert.equal(r.engines.length, 1);
  assert.equal(r.instance.engine, null, "the engine that could not start is torn down");
  assert.deepEqual(r.win.armed(), [5000]);
  assert.deepEqual(r.scheduled(), ["engine decision=retry_scheduled attempt=1 delay_ms=5000 status=0"]);
  assert.equal(r.instance.statusText(), "offline — retrying", "the settings row and the status modal read this");
  assert.equal(r.bar.at(-1), "obsync: offline — retrying");
  assert.ok(!r.logs.some((line) => line.includes("decision=stopped")), "an outage is not logged as a stop");

  r.win.fire();
  await settle();
  assert.equal(r.engines.length, 2);
  assert.deepEqual(r.running(), [r.engines[1]]);
  assert.equal(r.instance.engine, r.engines[1]);
  assert.deepEqual(r.win.armed(), [], "a start that succeeded leaves no timer behind");
  assert.ok(r.logs.includes("engine decision=retrying attempt=1 reason=timer"));
  assert.ok(r.logs.includes("engine decision=resumed attempt=1"));
  assert.equal(r.instance.statusText(), "idle");
  assert.equal(r.bar.at(-1), "obsync: idle");

  // The start that got through closed the cycle: a later outage counts from one.
  r.plan(() => { throw r.unreachable(); });
  await r.instance.restartEngine();
  assert.deepEqual(r.win.armed(), [5000]);
  assert.equal(r.scheduled().at(-1), "engine decision=retry_scheduled attempt=1 delay_ms=5000 status=0");
  assert.equal(r.logs.filter((line) => line.startsWith("engine decision=resumed")).length, 1);
});

test("the pause doubles from 5 s and holds at 5 minutes for as long as the outage lasts", async (t) => {
  const r = await fixture(t);
  r.plan(() => { throw r.unreachable(); });
  await r.instance.onload();
  const observed = [];
  for (let attempt = 1; attempt <= 9; attempt++) {
    observed.push(...r.win.armed());
    r.win.fire();
    await settle();
  }
  assert.deepEqual(observed, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  assert.equal(r.engines.length, 10, "one engine per start, each torn down before the next");
  assert.deepEqual(r.running(), []);
  assert.ok(r.logs.includes("engine decision=retry_scheduled attempt=10 delay_ms=300000 status=0"));
  assert.equal(r.instance.statusText(), "offline — retrying");
});

test("a terminator answering 5xx for a server that is not there is an outage too", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n === 1) throw r.unreachable(503); });
  await r.instance.onload();
  assert.deepEqual(r.scheduled(), ["engine decision=retry_scheduled attempt=1 delay_ms=5000 status=503"]);
  assert.deepEqual(r.win.armed(), [5000]);
});

test("the device reporting its network back runs the pending retry now, and is nothing otherwise", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n === 1) throw r.unreachable(); });
  await r.instance.onload();
  assert.deepEqual(r.win.armed(), [5000]);

  r.win.online();
  await settle();
  assert.equal(r.engines.length, 2, "the retry ran at once");
  assert.deepEqual(r.win.armed(), [], "and the timer it pre-empted is gone");
  assert.ok(r.logs.includes("engine decision=retrying attempt=1 reason=online"));
  assert.ok(r.logs.includes("engine decision=resumed attempt=1"));
  assert.deepEqual(r.running(), [r.engines[1]]);

  // With the engine running there is nothing pending: `online` starts nothing.
  r.win.online();
  await settle();
  assert.equal(r.engines.length, 2);
  assert.equal(r.logs.filter((line) => line.includes("reason=online")).length, 1);
});

test("online while a retry is already running starts no second engine", async (t) => {
  const r = await fixture(t);
  const hang = deferred();
  r.plan((n) => { if (n === 1) throw r.unreachable(); if (n === 2) return hang.promise; });
  await r.instance.onload();
  r.win.fire();
  await settle();
  assert.equal(r.engines.length, 2);
  assert.deepEqual(r.running(), [], "the retry is still starting");

  r.win.online();
  await settle();
  assert.equal(r.engines.length, 2, "nothing was pending, so nothing was started");
  hang.resolve();
  await settle();
  assert.deepEqual(r.running(), [r.engines[1]]);
  assert.equal(r.instance.engine, r.engines[1]);
});

const REFUSALS = [
  ["401 bad_signature", (r) => new r.ApiError(401, "bad_signature", "SENTINEL"), "bad_signature"],
  ["401 stale_timestamp", (r) => new r.ApiError(401, "stale_timestamp", "SENTINEL"), "stale_timestamp"],
  ["403 device_revoked", (r) => new r.ApiError(403, "device_revoked", "SENTINEL"), "device_revoked"],
  ["403 device_pending", (r) => new r.ApiError(403, "device_pending", "SENTINEL"), "device_pending"],
  // The transport calls a 507 it retried out `unreachable`, but a full volume
  // is a decision (requirement 8), and knocking again does not empty it.
  ["507 after the transport's retries", (r) => new r.ApiError(507, "unreachable", "status=507"), "unreachable"],
  ["a domain map this version cannot read", (r) => new r.DomainMapError("more_than_one_domain"), "DomainMapError"],
  ["a key that does not decrypt", () => new Error("SENTINEL"), "Error"],
];

for (const [name, refusal, code] of REFUSALS) {
  test(`${name} is not retried: it stays an error until the person acts`, async (t) => {
    const r = await fixture(t);
    r.plan((n) => { if (n === 1) throw refusal(r); });
    await r.instance.onload();
    assert.equal(r.engines.length, 1);
    assert.equal(r.instance.engine, null);
    assert.deepEqual(r.win.armed(), [], "no timer");
    assert.deepEqual(r.scheduled(), []);
    assert.ok(r.logs.includes(`engine decision=stopped reason=start_failed code=${code}`), r.logs.join("\n"));
    assert.match(r.instance.statusText(), /^error — /);
    assert.match(r.bar.at(-1), /^obsync: error — /);

    // Neither does the network coming back knock again on a closed door.
    r.win.online();
    await settle();
    assert.equal(r.engines.length, 1);
    assert.match(r.instance.statusText(), /^error — /);
  });
}

test("Obsidian finishes loading while the first start still waits for the server", async (t) => {
  const r = await fixture(t);
  const server = deferred();
  r.plan(() => server.promise);
  // The plugin's own onload, not the fixture's, which waits for the start on purpose.
  let returned = false;
  const loading = Object.getPrototypeOf(r.instance).onload.call(r.instance).then(() => { returned = true; });
  for (let turn = 0; turn < 50 && !returned; turn++) await new Promise(setImmediate);
  assert.ok(returned, "onload returned while the server had not answered: Obsidian's loading screen is not held");
  assert.equal(r.engines.length, 1, "the first start is running, not skipped");
  assert.deepEqual(r.running(), []);
  server.resolve();
  await r.instance.firstStart;
  assert.deepEqual(r.running(), [r.engines[0]], "and it completes on its own when the server answers");
  await loading;
});

test("the first start waits until Obsidian has listed the vault", async (t) => {
  // A start that reconciles against a vault Obsidian has not listed yet sees
  // every tracked note as deleted and every empty folder as gone (X1).
  const r = await fixture(t);
  let listed = null;
  r.instance.app.workspace = { onLayoutReady: (callback) => { listed = callback; } };
  await Object.getPrototypeOf(r.instance).onload.call(r.instance);
  for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
  assert.equal(r.engines.length, 0, "no start while the vault is still being listed");
  assert.equal(typeof listed, "function", "the start is waiting on Obsidian's layout-ready signal");
  listed();
  await r.instance.firstStart;
  assert.deepEqual(r.running(), [r.engines[0]], "and it starts as soon as the vault is listed");
});

test("unloading the plugin cancels the pending retry", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n === 1) throw r.unreachable(); });
  await r.instance.onload();
  assert.deepEqual(r.win.armed(), [5000]);
  r.instance.onunload();
  assert.deepEqual(r.win.armed(), []);
  // The stub keeps the listener Obsidian would have detached; the plugin
  // itself must still start nothing for an event that arrives after unload.
  r.win.online();
  await settle();
  assert.equal(r.engines.length, 1);
});

test("leaving the server cancels the pending retry, and the device stays not paired", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n === 1) throw r.unreachable(); });
  await r.instance.onload();
  assert.deepEqual(r.win.armed(), [5000]);
  r.instance.unpushedEdits = async () => [];
  r.instance.revokeDevice = async () => undefined;
  const left = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  assert.deepEqual(left, { decision: "left", revoked: true });
  assert.deepEqual(r.win.armed(), []);
  assert.equal(r.engines.length, 1, "leaving starts nothing");
  assert.equal(r.instance.statusText(), "not paired");
  r.win.online();
  await settle();
  assert.equal(r.engines.length, 1);
});

test("changing the folder selection cancels the pending retry; the start it ends with opens a fresh cycle", async (t) => {
  const r = await fixture(t);
  r.plan(() => { throw r.unreachable(); });
  await r.instance.onload();
  assert.deepEqual(r.win.armed(), [5000]);
  await r.instance.saveSyncFolders(["Notes"]);
  await settle();
  assert.deepEqual(r.instance.state.data.syncFolders, ["Notes"]);
  assert.equal(r.engines.length, 2, "the save's own start, and only that");
  assert.deepEqual(r.win.armed(), [5000], "one timer, at the first pause again: the old cycle was dropped, not continued");
  assert.deepEqual(r.scheduled(), [
    "engine decision=retry_scheduled attempt=1 delay_ms=5000 status=0",
    "engine decision=retry_scheduled attempt=1 delay_ms=5000 status=0",
  ]);
});

test("Sync now takes the place of the pending retry: one engine, and the cycle goes on from where it was", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n <= 2) throw r.unreachable(); });
  await r.instance.onload();
  assert.deepEqual(r.win.armed(), [5000]);

  await r.instance.syncNow();
  await settle();
  assert.equal(r.engines.length, 2, "the manual start ran");
  assert.deepEqual(r.running(), []);
  assert.deepEqual(r.win.armed(), [10000], "the pre-empted timer is gone; the failure counts as the second in a row");
  assert.deepEqual(r.scheduled(), [
    "engine decision=retry_scheduled attempt=1 delay_ms=5000 status=0",
    "engine decision=retry_scheduled attempt=2 delay_ms=10000 status=0",
  ]);

  r.win.fire();
  await settle();
  assert.deepEqual(r.running(), [r.engines[2]]);
  assert.equal(r.engines.length, 3);
  assert.ok(r.logs.includes("engine decision=resumed attempt=2"));
  assert.deepEqual(r.win.armed(), []);
  // And Sync now on a running engine is the engine's own pass, not a restart.
  await r.instance.syncNow();
  assert.equal(r.engines.length, 3);
  assert.equal(r.engines[2].manual, 1);
});

test("a manual start that gets through disarms the pending retry", async (t) => {
  const r = await fixture(t);
  r.plan((n) => { if (n === 1) throw r.unreachable(); });
  await r.instance.onload();
  assert.deepEqual(r.win.armed(), [5000]);
  await r.instance.syncNow();
  await settle();
  assert.deepEqual(r.running(), [r.engines[1]]);
  // Not merely harmless: a stale timer left armed would fire into a LATER
  // cycle and run its retry early, ahead of the pause that cycle chose.
  assert.deepEqual(r.win.armed(), [], "a running engine has no retry armed behind it");
  assert.ok(r.logs.includes("engine decision=resumed attempt=1"));
});

test("the real engine surfaces the transport's own classification, unwrapped", async (t) => {
  const { SyncEngine } = require("../build/sync/engine.js");
  const { ApiError } = require("../build/transport.js");
  const r = await rig();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, now: () => r.host.clock, timers: new FakeTimers() });
  t.after(() => engine.stop());
  const real = r.transport.options.request;
  const answer = { request: real };
  r.transport.options.request = (request) => answer.request(request);
  const shape = (status, code) => (error) => error instanceof ApiError && error.status === status && error.code === code;

  // Nothing answers: the socket error every attempt saw.
  answer.request = async () => { throw new Error("connection refused SENTINEL"); };
  await assert.rejects(engine.start(), shape(0, "unreachable"));
  // A terminator answering for a server that is not there.
  answer.request = async () => ({ status: 503, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) });
  await assert.rejects(engine.start(), shape(503, "unreachable"));
  // A refusal keeps its own code, which is what tells it from absence.
  answer.request = async () => ({ status: 401, headers: {}, text: JSON.stringify({ error: "bad_signature", detail: "SENTINEL" }), arrayBuffer: new ArrayBuffer(0) });
  await assert.rejects(engine.start(), shape(401, "bad_signature"));
  // And once the server answers, the same device starts.
  answer.request = real;
  await engine.start();
  assert.ok(engine.started);
});

/*
 * THE STATUS BAR NEVER SAYS `idle` WHILE NOTHING CAN SYNC (the 2026-09-23 run).
 * The transport retries an unanswered request for about a minute and a half
 * before it throws, and until then a device opened away from its server read
 * `idle`. Every attempt now reports whether the server answered, and the bar
 * follows it at once.
 */

/** The report the plugin's own transport makes after one attempt. */
const report = (r, answered) => r.instance.transport.options.reachable(answered);

test("a start still inside the transport's retries already reads offline, and the answer puts idle back", async (t) => {
  const r = await fixture(t);
  const gate = deferred();
  r.plan(async (n) => { if (n === 1) await gate.promise; });
  const loading = r.instance.onload();
  await settle();
  assert.equal(r.instance.statusText(), "idle", "nothing has been attempted yet");
  report(r, false);
  assert.equal(r.instance.statusText(), "offline — retrying", "the first unanswered attempt is shown at once");
  assert.equal(r.bar.at(-1), "obsync: offline — retrying");
  assert.ok(r.logs.includes("engine decision=offline reason=unanswered"));
  report(r, false);
  assert.equal(r.logs.filter((line) => line === "engine decision=offline reason=unanswered").length, 1, "said once, not per attempt");
  report(r, true);
  assert.equal(r.instance.statusText(), "idle");
  assert.ok(r.logs.includes("engine decision=online reason=answered"));
  gate.resolve();
  await loading;
  await settle();
  assert.equal(r.instance.statusText(), "idle");
  assert.deepEqual(r.win.armed(), [], "an outage the transport rode out arms no reconnect");
});

test("an answer puts back the syncing it covered, and never a status raised since", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  r.instance.setStatus({ kind: "syncing", pending: 3 });
  report(r, false);
  assert.equal(r.instance.statusText(), "offline — retrying");
  report(r, true);
  assert.equal(r.instance.statusText(), "syncing 3", "the work still pending is not called idle");

  report(r, false);
  r.instance.setStatus({ kind: "syncing", pending: 1 });
  report(r, true);
  assert.equal(r.instance.statusText(), "syncing 1", "the engine's newer word stands");
});

test("an unanswered attempt never hides an error, and an answer never clears the reconnect cycle's offline", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  r.instance.setStatus({ kind: "error", message: "SENTINEL" });
  report(r, false);
  assert.equal(r.instance.statusText(), "error — SENTINEL");
  report(r, true);
  assert.equal(r.instance.statusText(), "error — SENTINEL");

  r.plan(() => { throw r.unreachable(); });
  await r.instance.restartEngine();
  assert.deepEqual(r.win.armed(), [5000]);
  report(r, true);
  assert.equal(r.instance.statusText(), "offline — retrying", "only the start that gets through ends the cycle");
});

test("an unpaired device stays not paired, and a transport from an earlier session is not heard", async (t) => {
  const r = await fixture(t);
  await r.instance.onload();
  const earlier = r.instance.transport.options.reachable;
  r.instance.transport = { options: {} };
  earlier(false);
  assert.equal(r.instance.statusText(), "idle", "a replaced transport speaks for nothing");

  const s = await fixture(t);
  s.plan((n) => { if (n === 1) throw s.unreachable(); });
  await s.instance.onload();
  s.instance.unpushedEdits = async () => [];
  s.instance.revokeDevice = async () => undefined;
  await s.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  report(s, false);
  assert.equal(s.instance.statusText(), "not paired");
});
