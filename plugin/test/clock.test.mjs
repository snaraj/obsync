/**
 * Timers a hidden window does not slow (issue #221).
 *
 * WHAT IS DRIVEN. `workerClock` over a page clock and a worker that are both
 * fakes and fire only when told, so "the worker's message came first" and
 * "the page's timer came first" are two calls in the order a test picks. The
 * worker's own script runs in `node:vm` against a fake `self`. The last tests
 * load the plugin as Obsidian loads it and pin where the clock is used, that
 * one worker serves the session, that unload ends it, and what a window that
 * cannot make one says.
 *
 * PLATFORM. The worker is desktop's; a phone keeps the page's clock (the last
 * test). What Chromium does to a hidden page's timers, and that a worker's are
 * spared, is a real-device observation (the measurements in #221 and
 * `docs/validation.md`), not something Node can show.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { KEYS, memorySecrets, sandbox, statusItem } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { WORKER_SOURCE, spawnWorker, workerClock } = require("../build/clock.js");

/** The page's clock: records each timer and fires one only when told. */
function pageClock() {
  const timers = new Map();
  // Handles apart from the clock's own ids, so a handle passed to the wrong clock shows.
  let next = 1000;
  return {
    set(fn, ms) { timers.set(next, { fn, ms }); return next++; },
    clear(handle) { timers.delete(handle); },
    /** The delays armed now, oldest first. */
    armed: () => [...timers.values()].map((timer) => timer.ms),
    /** The page's timer of `ms` coming due. */
    fire(ms) {
      const found = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(found, `a page timer of ${ms} ms is armed`);
      timers.delete(found[0]);
      found[1].fn();
    },
  };
}

/** A dedicated worker: keeps what the page posts, and answers only when told. */
class FakeWorker {
  posted = [];
  terminated = false;
  onmessage = null;
  onerror = null;
  postMessage(message) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  /** The worker's timer for `id` came due: its message reaches the page. */
  answer(id) { this.onmessage({ data: id }); }
  /** The worker's timer of `ms` came due. */
  due(ms) { this.answer(this.posted.find((message) => message.ms === ms).id); }
  /** An `error` event: the script failed to load, or threw. */
  fail() { this.onerror({ type: "error" }); }
}

function rig(spawn) {
  const page = pageClock(), logs = [], workers = [], ran = [];
  const clock = workerClock(page, (line) => logs.push(line), spawn ?? (() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }));
  return { clock, page, logs, worker: workers[0], ran, run: (name) => () => ran.push(name) };
}

test("a timer runs once, when the worker's message for it arrives, and its page timer is disarmed", () => {
  const r = rig();
  const id = r.clock.set(r.run("a"), 500);
  assert.deepEqual(r.worker.posted, [{ id, ms: 500 }]);
  assert.deepEqual(r.page.armed(), [500], "the page's clock holds it too, in case the worker never answers");
  r.worker.answer(id);
  assert.deepEqual(r.ran, ["a"]);
  assert.deepEqual(r.page.armed(), [], "the page's timer for it is still armed");
  r.worker.answer(id);
  r.clock.clear(id);
  assert.deepEqual(r.ran, ["a"], "a second message ran it again");
  assert.deepEqual(r.worker.posted, [{ id, ms: 500 }], "a clear after it ran is sent to the worker");
  assert.deepEqual(r.logs, []);
});

test("the page's clock runs a timer the worker has not answered, and the late message runs nothing", () => {
  const r = rig();
  const id = r.clock.set(r.run("a"), 500);
  r.page.fire(500);
  assert.deepEqual(r.ran, ["a"]);
  r.worker.answer(id);
  assert.deepEqual(r.ran, ["a"]);
});

test("a timer cleared before it is due is disarmed on both clocks", () => {
  const r = rig();
  const id = r.clock.set(r.run("a"), 500);
  r.clock.clear(id);
  assert.deepEqual(r.worker.posted, [{ id, ms: 500 }, { id }], "the worker was not told to disarm it");
  assert.deepEqual(r.page.armed(), []);
  assert.deepEqual(r.ran, []);
});

test("a clear that races the worker's message already on its way runs nothing", () => {
  const r = rig();
  const id = r.clock.set(r.run("a"), 500);
  // The worker's timer fired and posted before the page's clear reached it.
  r.clock.clear(id);
  r.worker.answer(id);
  assert.deepEqual(r.ran, [], "a cleared timer ran");
});

test("timers of different delays run in the order they come due, each its own callback", () => {
  const r = rig();
  const slow = r.clock.set(r.run("slow"), 900);
  const quick = r.clock.set(r.run("quick"), 100);
  assert.notEqual(slow, quick);
  r.worker.due(100);
  r.worker.due(900);
  assert.deepEqual(r.ran, ["quick", "slow"]);
  assert.deepEqual(r.page.armed(), []);
});

test("a worker that cannot be made leaves every timer to the page's clock, said once", () => {
  let r;
  assert.doesNotThrow(() => { r = rig(() => { throw new DOMException("SENTINEL", "SecurityError"); }); }, "the clock failed with its worker");
  assert.deepEqual(r.logs, ["timers decision=fallback reason=SecurityError"]);
  r.clock.set(r.run("slow"), 900);
  const quick = r.clock.set(r.run("quick"), 100);
  r.page.fire(100);
  r.clock.clear(quick);
  r.page.fire(900);
  assert.deepEqual(r.ran, ["quick", "slow"]);
  r.clock.stop();
  assert.deepEqual(r.logs, ["timers decision=fallback reason=SecurityError"], "said once, not per timer");
});

test("a worker that fails is ended, what it held runs on the page's clock, and later timers go there alone", () => {
  const r = rig();
  r.clock.set(r.run("held"), 900);
  r.worker.fail();
  assert.equal(r.worker.terminated, true, "a failed worker was left running");
  assert.deepEqual(r.logs, ["timers decision=fallback reason=worker_error pending=1"]);
  r.clock.set(r.run("later"), 100);
  assert.equal(r.worker.posted.length, 1, "a failed worker was sent another timer");
  r.page.fire(100);
  r.page.fire(900);
  assert.deepEqual(r.ran, ["later", "held"]);
  assert.equal(r.logs.length, 1);
});

test("stop ends the worker without a word, and what it held still runs on the page's clock", () => {
  const r = rig();
  r.clock.set(r.run("held"), 900);
  r.clock.stop();
  assert.equal(r.worker.terminated, true, "stop left the worker running");
  r.clock.set(r.run("later"), 100);
  assert.equal(r.worker.posted.length, 1, "a stopped worker was sent another timer");
  r.page.fire(100);
  r.page.fire(900);
  assert.deepEqual(r.ran, ["later", "held"]);
  assert.deepEqual(r.logs, [], "a stop is not a failure");
});

test("the worker's script arms a timer per message, posts its id when due, and disarms one sent without a delay", () => {
  const timers = new Map(), posted = [];
  let next = 1;
  const self = {
    setTimeout: (fn, ms) => { timers.set(next, { fn, ms }); return next++; },
    clearTimeout: (handle) => { timers.delete(handle); },
    postMessage: (id) => posted.push(id),
  };
  runInNewContext(WORKER_SOURCE, { self });
  self.onmessage({ data: { id: 7, ms: 250 } });
  self.onmessage({ data: { id: 8, ms: 50 } });
  self.onmessage({ data: { id: 8 } });
  assert.deepEqual([...timers.values()].map((timer) => timer.ms), [250], "a disarmed timer is still armed");
  [...timers.values()][0].fn();
  assert.deepEqual(posted, [7]);
});

test("the worker is made from a Blob of that script, whose URL is revoked once the worker holds it", (t) => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = {
    Blob: class { constructor(parts, options) { this.text = parts.join(""); this.type = options.type; } },
    URL: {
      createObjectURL: (blob) => { events.push(["url", blob.text === WORKER_SOURCE, blob.type]); return "blob:SENTINEL"; },
      revokeObjectURL: (url) => events.push(["revoked", url]),
    },
    Worker: class { constructor(url) { events.push(["worker", url]); } },
  };
  t.after(() => { globalThis.window = previous; });
  assert.ok(spawnWorker() instanceof globalThis.window.Worker);
  assert.deepEqual(events, [["url", true, "text/javascript"], ["worker", "blob:SENTINEL"], ["revoked", "blob:SENTINEL"]]);
  events.length = 0;
  globalThis.window.Worker = class { constructor() { throw new DOMException("SENTINEL", "SecurityError"); } };
  assert.throws(() => spawnWorker(), { name: "SecurityError" });
  assert.deepEqual(events.at(-1), ["revoked", "blob:SENTINEL"], "a worker that could not be made kept its URL alive");
});

// --- the plugin: where the clock is used ------------------------------------

/**
 * The real plugin over an engine port, on a window whose workers are
 * `FakeWorker`s, or that has none (`worker: false`). `said` is every log line
 * with the console level it went out at.
 */
async function loaded(t, { mobile = false, worker = true } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { Platform } = box.require("obsidian");
  Object.assign(Platform, { isMobile: mobile, isDesktopApp: !mobile });
  t.after(() => Object.assign(Platform, { isMobile: false, isDesktopApp: true }));
  const workers = [];
  const previous = globalThis.window;
  globalThis.window = { ...previous, Worker: worker ? class extends FakeWorker { constructor() { super(); workers.push(this); } } : undefined };
  t.after(() => { globalThis.window = previous; });
  const said = [];
  const { warn, debug } = console;
  console.warn = (line) => said.push(["warn", line]);
  console.debug = (line) => said.push(["debug", line]);
  t.after(() => Object.assign(console, { warn, debug }));
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const engines = [];
  box.require(join(box.home, "build/sync/engine.js")).SyncEngine = class {
    constructor(options) { this.options = options; engines.push(this); }
    async start() {}
    stop() {}
    async stopAndWait() {}
    wake() {}
    current() { return { kind: "idle" }; }
  };
  const instance = new Plugin();
  instance.loadData = async () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid", edgeHeaders: [] });
  instance.saveData = async () => {};
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => statusItem();
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: {
    on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed(), getActiveViewOfType: () => null,
  } };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.4" };
  instance.checkForUpdate = async () => {};
  await instance.onload();
  await instance.firstStart;
  return { instance, engines, workers, said };
}

test("on desktop the transport and every engine run on one worker clock, and unload ends it", async (t) => {
  const r = await loaded(t);
  await r.instance.startEngine();
  assert.equal(r.engines.length, 2);
  assert.equal(r.workers.length, 1, "one worker for the session, not one per engine");
  const clock = r.engines[0].options.timers;
  assert.equal(typeof clock?.stop, "function", "the engine runs on the page's clock");
  assert.equal(r.engines[1].options.timers, clock);
  assert.equal(r.instance.transport.options.timers, clock, "the transport's deadlines run on another clock");
  void r.instance.transport.sleep(1234);
  assert.deepEqual(r.workers[0].posted.at(-1)?.ms, 1234, "the transport's backoff sleeps on another clock");
  // A load over a load: the new session's worker replaces the old one, never joins it.
  await r.instance.onload();
  assert.equal(r.workers.length, 2);
  assert.equal(r.workers[0].terminated, true, "a second load left the first worker running");
  r.instance.onunload();
  assert.equal(r.workers[1].terminated, true, "unload left the worker running");
});

test("a desktop whose window cannot make a worker runs on the page's clock, and says so once, at warn", async (t) => {
  const r = await loaded(t, { worker: false });
  const timers = r.engines[0].options.timers;
  assert.equal(r.instance.transport.options.timers, timers);
  await new Promise((resolve) => timers.set(resolve, 1));
  await r.instance.startEngine();
  assert.deepEqual(r.said.filter(([, line]) => line.startsWith("obsync timers ")),
    [["warn", "obsync timers decision=fallback reason=TypeError"]], "the console hides it, or says it again");
  r.instance.onunload();
});

test("a phone keeps the page's own clock and makes no worker", async (t) => {
  const r = await loaded(t, { mobile: true });
  assert.equal(r.workers.length, 0);
  const timers = r.engines[0].options.timers;
  assert.equal(typeof timers.set, "function");
  assert.equal(timers.stop, undefined, "a phone runs on a worker clock");
  assert.equal(r.instance.transport.options.timers, timers);
  r.instance.onunload();
});
