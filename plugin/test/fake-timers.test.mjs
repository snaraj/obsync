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
