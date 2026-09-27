/**
 * obsync tells the truth, fast: what the engine does when the device says
 * something changed, and what the status says about what is really going on.
 *
 * WHAT IS EXERCISED. The real engine, pull and push paths and the real
 * transport -- its signing, its retries, its pauses -- against the vault and
 * server in `fake.mjs`, on virtual time. The renderer's events (`online`,
 * `focus`, `visibilitychange`) reach the plugin through `wake`, which
 * `reconnect.test.mjs` drives; here the engine and transport halves of it are.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, STEP_MS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine, POLL_STALE_MS } = require("../build/sync/engine.js");

const enc = (text) => new TextEncoder().encode(text);
const polls = (r) => r.server.requests.filter((request) => request.target.startsWith("/v1/changes?since="));

async function started() {
  const r = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start();
  return { ...r, timers, engine };
}

test("the feed asks without waiting first, then long-polls (#158, #195)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const asked = polls(r).map((request) => /wait=(\d+)/.exec(request.target)[1]);
  assert.deepEqual(asked.slice(-2), ["0", "55"], "one quick read, then the long poll");
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
});

test("a wake drops a long poll that has waited, reads at once, and never applies the dropped poll's late answer (#195)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const before = polls(r).length;
  // A poll sent a moment ago rides a live connection: a wake leaves it be.
  r.engine.wake("focus");
  await r.timers.run(STEP_MS);
  assert.equal(polls(r).length, before);
  assert.ok(!r.host.logs.some((line) => line.startsWith("feed decision=woken")));

  // Another device's note lands, and nothing tells the waiting poll: the
  // connection it rides went dead under a sleeping lid.
  const deaf = r.server.feedWaiters;
  r.server.feedWaiters = [];
  await r.server.publish({ fileId: "ab".repeat(16), path: "Arrived.md", bytes: enc("today's note\n"), mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.server.feedWaiters = deaf;
  const head = r.server.seq;
  r.host.clock += POLL_STALE_MS;
  r.engine.wake("online");
  // No virtual time passes: the read is the wake's, not a pause running out.
  await r.timers.run(0, () => r.host.text("Arrived.md") !== null && r.server.feedWaiters.length === 2);
  assert.ok(!r.host.logs.some((line) => line.startsWith("feed decision=retry")), "a dropped poll is not a failed read");
  assert.equal(r.state.data.lastSeq, head, "the quick read brought it at once");
  assert.ok(r.host.logs.includes(`feed decision=woken reason=online ended_pause=0 dropped_poll=1 waited_ms=${POLL_STALE_MS}`), r.host.logs.join("\n"));
  const after = polls(r).slice(before).map((request) => /wait=(\d+)/.exec(request.target)[1]);
  assert.deepEqual(after, ["0", "55"]);

  // The dropped poll's answer arrives late, naming the old cursor: discarded.
  r.server.releaseFeed();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  assert.equal(r.state.data.lastSeq, head, "the cursor never moves backwards");
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
});

test("a wake ends the feed's pause after a failed read, and a new address takes any poll at once (#134, #186)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const request = r.transport.options.request;
  let down = true;
  r.transport.options.request = async (sent) => {
    if (down && sent.url.includes("/v1/changes?")) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    return request(sent);
  };
  // The long poll is answered, and the next one finds the network gone: both
  // attempts refused, and the feed pauses FEED_ERROR_BACKOFF_MS.
  r.server.releaseFeed();
  await r.timers.run(0, () => r.host.logs.some((line) => line.startsWith("feed decision=retry")));
  // The network returns, and the device says so: no virtual time passes.
  down = false;
  const before = polls(r).length;
  r.engine.wake("online");
  await r.timers.run(0, () => polls(r).length > before);
  assert.ok(r.host.logs.includes("feed decision=woken reason=online ended_pause=1 dropped_poll=0 waited_ms=0"), r.host.logs.join("\n"));
  assert.match(polls(r)[before].target, /wait=0/, "the read after a failure asks without waiting");
  // The address changed: the poll in flight went to the old one, however fresh it is.
  await r.timers.run(0, () => r.server.feedWaiters.length === 1);
  const retries = r.host.logs.filter((line) => line.startsWith("feed decision=retry")).length;
  r.engine.wake("address");
  await r.timers.run(0, () => r.server.feedWaiters.length === 2);
  assert.ok(r.host.logs.includes("feed decision=woken reason=address ended_pause=0 dropped_poll=1 waited_ms=0"), r.host.logs.join("\n"));
  assert.equal(r.host.logs.filter((line) => line.startsWith("feed decision=retry")).length, retries, "a dropped poll is not a failed read");
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
});

test("a chunk upload asleep in its backoff is sent to a newly adopted address within one step (#186)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const request = r.transport.options.request;
  const sent = [];
  r.transport.options.request = async (outgoing) => {
    sent.push(`${outgoing.method} ${new URL(outgoing.url).host}`);
    if (outgoing.url.startsWith("https://sync.example.invalid/")) throw new Error("net::ERR_CONNECTION_REFUSED");
    return request(outgoing);
  };
  // Backoff pauses that only a wake ends: the old address is never waited out.
  const asleep = [];
  r.transport.sleep = () => new Promise((resolve) => asleep.push(resolve));
  r.host.seed("Big.md", "a note written while the server moved\n", 5000);
  r.engine.changed("Big.md");
  await r.timers.run(STEP_MS, () => asleep.length > 0);
  assert.deepEqual(sent, ["POST sync.example.invalid"], "the push's first request failed at the old address and sleeps");
  r.state.data.serverUrl = "https://moved.example.invalid";
  r.transport.wake("address");
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Big.md") !== undefined);
  assert.equal(asleep.length, 1, "no second pause: the woken attempt was answered");
  assert.ok(sent.slice(1).every((line) => line.endsWith(" moved.example.invalid")), `everything after the wake went to the new address: ${sent}`);
  assert.ok(sent.includes("PUT moved.example.invalid"), "the chunk went up there");
  assert.equal(r.server.journal.at(-1).file_id, r.state.fileByPath("Big.md").fileId, "and the note was published there");
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
});
