import { strict as assert } from "node:assert";
import test from "node:test";
import { FakeTimers, WAIT_BUDGET_MS } from "./fake.mjs";

// An outcome wait is bounded in real time so a loaded runner (the image
// build's in-image run, the hosted Windows runner) can finish off-thread work
// it polls. These pin the budget the waits actually get (#343).

test("an outcome that holds after ten seconds of real time is still awaited", async () => {
  const timers = new FakeTimers();
  const ready = Date.now() + 10500;
  assert.equal(await timers.run(0, () => Date.now() >= ready), true);
});

test("an outcome that never holds is refused at the budget it was given", async () => {
  const timers = new FakeTimers();
  const started = Date.now();
  await assert.rejects(timers.run(0, () => false, 300), /waited 300 ms of real time/);
  assert.ok(Date.now() - started < 5000);
});

test("the default outcome budget is at least sixty seconds", () => {
  assert.ok(WAIT_BUDGET_MS >= 60000);
});
