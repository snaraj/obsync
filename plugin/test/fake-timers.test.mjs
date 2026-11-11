import { strict as assert } from "node:assert";
import test from "node:test";
import { FakeTimers, outcomeWithin, WAIT_BUDGET_MS } from "./fake.mjs";

// An outcome wait is bounded in real time so a loaded runner (the image
// build's in-image run, the hosted Windows runner) can finish off-thread work
// it polls. These pin the budget the waits actually get.

test("outcomes that hold after ten seconds of real time are still awaited", async () => {
  const ready = performance.now() + 10500;
  const held = () => performance.now() >= ready;
  assert.deepEqual(await Promise.all([new FakeTimers().run(0, held), outcomeWithin(new FakeTimers(), held)]), [true, true]);
});

test("an outcome that never holds is refused at the budget it was given", async () => {
  const started = performance.now();
  await assert.rejects(new FakeTimers().run(0, () => false, 300), /waited 300 ms of real time/);
  await assert.rejects(outcomeWithin(new FakeTimers(), () => false, 300), /300 ms/);
  assert.ok(performance.now() - started < 5000);
});

test("a watched outcome is refused at its budget even with Date.now frozen", { timeout: 5000 }, async (t) => {
  t.mock.method(Date, "now", () => 0);
  await assert.rejects(outcomeWithin(new FakeTimers(), () => false, 300), /300 ms real-time budget/);
});

test("the default outcome budget is at least sixty seconds", () => {
  assert.ok(WAIT_BUDGET_MS >= 60000);
});

// A wait that met an order it never expected (#378) is refused once its clock
// is spent and nothing moves, naming what it saw, not after the whole budget.
test("a spent wait whose timers stay silent is refused as stalled, with what it observed", async () => {
  const timers = new FakeTimers();
  timers.stallMs = 300;
  timers.observe = () => "holder=hold behind=2 queued=force_sync";
  timers.set(() => undefined, 3600000);
  const started = performance.now();
  await assert.rejects(timers.run(50, () => false),
    /stalled, nothing due and no timer set, cleared or fired for 300 ms .*: virtual_ms=90050 advances=1800 pending_ms=\[3509950\] holder=hold behind=2 queued=force_sync$/);
  assert.ok(performance.now() - started < 30000);
});

test("a spent wait is not a stall while timers still move", async () => {
  const timers = new FakeTimers();
  timers.stallMs = 300;
  const ready = performance.now() + 1500;
  const beat = setInterval(() => timers.set(() => undefined, 3600000), 100);
  try {
    assert.equal(await timers.run(0, () => performance.now() >= ready), true);
  } finally {
    clearInterval(beat);
  }
});

// The yield and the predicate run code as well, so what they do at the stall
// boundary is judged on the queue and clock as they stand after them. Each
// test below jumps `performance.now` across the stall window at that moment,
// so none of them waits it out.
function stallBoundary(t, timers) {
  const real = performance.now.bind(performance);
  let jumped = 0;
  t.mock.method(performance, "now", () => real() + jumped);
  timers.stallMs = 10000;
  return () => { jumped += timers.stallMs; };
}

test("a timer set during the yield at the stall boundary runs instead of being refused as a stall", async (t) => {
  const timers = new FakeTimers();
  const boundary = stallBoundary(t, timers);
  let ran = false;
  setTimeout(() => { boundary(); timers.set(() => { ran = true; }, 0); }, 5);
  assert.equal(await timers.run(0, () => ran), true);
});

test("a timer set and cleared during the yield at the stall boundary restarts the quiet window", async (t) => {
  const timers = new FakeTimers();
  const boundary = stallBoundary(t, timers);
  let done = false;
  setTimeout(() => {
    boundary();
    timers.clear(timers.set(() => undefined, 0));
    setTimeout(() => { done = true; }, 5);
  }, 5);
  assert.equal(await timers.run(0, () => done), true);
});

test("a retry the predicate moves the clock onto at the stall boundary runs instead of being refused", async (t) => {
  const timers = new FakeTimers();
  const boundary = stallBoundary(t, timers);
  let ran = false;
  const handle = timers.set(() => { ran = true; }, 60000);
  const retry = timers.entries.find((entry) => entry.handle === handle);
  let driven = false;
  // As `editListed` drives a parked rename's retry: the clock moves, no timer is set.
  const until = () => {
    if (ran) return true;
    if (!driven) {
      driven = true;
      boundary();
      timers.now = Math.max(timers.now, retry.due);
    }
    return false;
  };
  assert.equal(await timers.run(0, until), true);
});
