/**
 * Timers a hidden window does not slow (issue #221), and the full pace a
 * hidden window keeps while there is sync work (#283, the last section).
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
import { KEYS, STEP_MS, memorySecrets, pair, sandbox, settled, statusItem } from "./fake.mjs";

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
  return { instance, engines, workers, said, raised: box.require("obsidian").raised };
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

test("on desktop the reconnect after a refused start runs on the worker clock, and is disarmed there", async (t) => {
  const r = await loaded(t);
  const worker = r.workers[0];
  const before = worker.posted.length;
  r.instance.scheduleReconnect(1, 0);
  const armed = worker.posted.slice(before);
  assert.equal(armed.length, 1, "the reconnect was not armed on the worker clock");
  assert.equal(armed[0].ms, 5000, "the first reconnect waits RECONNECT_START_MS");
  assert.equal(r.instance.takeReconnectTimer(), true);
  assert.deepEqual(worker.posted.at(-1), { id: armed[0].id }, "the reconnect was disarmed on another clock");
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

test("a feed that has stopped says so at warn, where the console shows it by default (#276)", async (t) => {
  const r = await loaded(t);
  r.instance.log("feed decision=stalled waited_ms=110000 budget_ms=110000");
  assert.deepEqual(r.said.filter(([, line]) => line.startsWith("obsync feed ")),
    [["warn", "obsync feed decision=stalled waited_ms=110000 budget_ms=110000"]]);
  r.instance.onunload();
});

test("a stop still waiting past its budget says so at warn; a press's wait and a pairing's stay at debug (#287)", async (t) => {
  const r = await loaded(t);
  r.instance.log("engine decision=waiting on=sweep held_ms=12000 in_flight=3 budget_ms=10000");
  r.instance.log("sync_now decision=waiting on=sweep held_ms=12000 behind=2 budget_ms=10000");
  r.instance.log("pairing role=claimant decision=waiting reason=not_approved");
  assert.deepEqual(r.said.filter(([, line]) => /^obsync (engine|sync_now|pairing) .*decision=waiting/.test(line)), [
    ["warn", "obsync engine decision=waiting on=sweep held_ms=12000 in_flight=3 budget_ms=10000"],
    ["debug", "obsync sync_now decision=waiting on=sweep held_ms=12000 behind=2 budget_ms=10000"],
    ["debug", "obsync pairing role=claimant decision=waiting reason=not_approved"],
  ]);
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

test("a reload of the same plugin instance closes the question its old host asked (review of 90d2042)", async (t) => {
  const r = await loaded(t);
  t.after(() => r.instance.onunload());
  r.instance.host.notify("Holding deletions", [{ kind: "delete_everywhere" }, { kind: "restore_here" }]);
  const question = r.raised.at(-1);
  assert.equal(question.message, "Holding deletions");
  assert.equal(question.hidden, false);
  await r.instance.onload();
  await r.instance.firstStart;
  r.instance.host.notify("Holding deletions again", [{ kind: "delete_everywhere" }, { kind: "restore_here" }]);
  assert.equal(question.hidden, true, "the replaced host left its question on screen beside the new one");
});

// --- a background window's pace (#283) ---------------------------------------

/**
 * WHAT IS DRIVEN. Two real engines over the fake server, each host recording
 * what it is told of the work in hand (`VaultHost.hurry`); then the real
 * `ObsidianHost` over a fake of the Electron window Obsidian gives the page.
 * What lifting the throttling does to a minimized window's pace is a
 * real-device measurement (`docs/benchmarks.md`), not something Node can show.
 */
test("the host is told of sync work once as it begins and once after CALM_MS without any, never per note, never for a waiting poll, and at once at a stop (#283)", async (t) => {
  const { CALM_MS } = require("../build/sync/engine.js");
  const { server, timers, a, b } = await pair(t);
  const told = { a: [], b: [] };
  a.host.hurry = (busy) => told.a.push(busy);
  b.host.hurry = (busy) => told.b.push(busy);
  // Nothing to sync: the feed's first read answered, its poll waiting on the server.
  await a.engine.start();
  await timers.run(CALM_MS);
  assert.deepEqual(told.a, [], "a waiting poll is no work");
  const paths = Array.from({ length: 20 }, (_, i) => `Notes/n${i}.md`);
  paths.forEach((path, i) => a.host.write(path, `NOTE SENTINEL ${i}\n`, 1000 + i));
  // While work is in flight the virtual clock crawls, 2 ms a turn, so that
  // no amount of load can walk it through CALM_MS inside one span; the wait
  // ends once the feed has read the uploads back too.
  const CRAWL_MS = 2;
  const caughtUp = (device) => device.state.data.lastSeq >= server.seq;
  await timers.run(CRAWL_MS, () => paths.every((path) => settled(a, path)) && server.journal.length >= paths.length && caughtUp(a));
  await timers.run(CALM_MS);
  assert.deepEqual(told.a, [true, false], "twenty uploads, one span of work");
  // Twenty notes read back, one span too.
  await b.engine.start();
  await timers.run(CRAWL_MS, () => paths.every((path) => settled(b, path)) && caughtUp(b));
  await timers.run(CALM_MS);
  assert.deepEqual(told.b, [true, false]);
  await timers.run(CALM_MS);
  assert.deepEqual(told, { a: [true, false], b: [true, false] }, "both polls waiting: no work");
  // A stop ends the span at once, not after the calm.
  a.host.write("Notes/late.md", "LATE SENTINEL\n", 5000);
  await timers.run(STEP_MS, () => told.a.length === 3);
  a.engine.stop();
  assert.deepEqual(told.a, [true, false, true, false]);
});

test("the desktop host lifts its window's background throttling for work and puts it back after, a line each; a window without the means, or one that refuses, keeps its pace and says so once (#283)", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { Platform } = box.require("obsidian");
  const previous = globalThis.window;
  t.after(() => { globalThis.window = previous; Object.assign(Platform, { isMobile: false, isDesktopApp: true }); });
  // Every line goes out through the plugin's own logger, at the level it picks.
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const warned = [];
  const { warn, debug } = console;
  console.warn = (line) => warned.push(line);
  console.debug = () => undefined;
  t.after(() => Object.assign(console, { warn, debug }));
  const logs = [];
  const plugin = { state: { data: {} }, log: (line) => { logs.push(line); Plugin.prototype.log.call(null, line); } };
  const asked = [];
  const electron = { electronWindow: { webContents: { setBackgroundThrottling(allowed) { asked.push(allowed); } } } };
  const said = () => logs.splice(0).map((line) => line.replace(/ duration_ms=\d+$/, ""));

  globalThis.window = { ...previous, ...electron };
  const host = new ObsidianHost(plugin, null);
  host.hurry(true);
  host.hurry(false);
  assert.deepEqual(asked, [false, true]);
  assert.deepEqual(said(), ["host decision=throttle_lifted reason=work", "host decision=throttle_restored reason=idle"]);

  // Absent: the window keeps its pace, said once however many changes follow.
  globalThis.window = { ...previous };
  host.hurry(true);
  host.hurry(false);
  host.hurry(true);
  assert.deepEqual(said(), ["host decision=throttle_unavailable reason=absent at=work"]);
  // Looked up at every change: a window that has it again is asked again.
  globalThis.window = { ...previous, ...electron };
  host.hurry(false);
  assert.deepEqual(asked, [false, true, true]);
  assert.deepEqual(said(), ["host decision=throttle_restored reason=idle"]);

  // Refused: the same one line.
  globalThis.window = { ...previous, electronWindow: { webContents: { setBackgroundThrottling() { throw new Error("SENTINEL refused"); } } } };
  const refused = new ObsidianHost(plugin, null);
  refused.hurry(true);
  refused.hurry(false);
  assert.deepEqual(said(), ["host decision=throttle_unavailable reason=failed at=work"]);

  // A phone has no such window: nothing is asked and nothing is said.
  Object.assign(Platform, { isMobile: true, isDesktopApp: false });
  globalThis.window = { ...previous, ...electron };
  new ObsidianHost(plugin, null).hurry(true);
  assert.deepEqual(asked, [false, true, true]);
  assert.deepEqual(said(), []);
  // A window that keeps its slow pace is a fallback, at warn (`docs/troubleshooting.md`); the rest is routine.
  assert.deepEqual(warned.map((line) => line.replace(/ duration_ms=\d+$/, "")), [
    "obsync host decision=throttle_unavailable reason=absent at=work",
    "obsync host decision=throttle_unavailable reason=failed at=work",
  ]);
});
