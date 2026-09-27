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
const { SyncEngine, POLL_STALE_MS, CLOCK_OFF, SERVER_FULL, NOT_OBSYNC_ANSWER, FEED_FAILED, REVOKED_DEVICE } = require("../build/sync/engine.js");

const enc = (text) => new TextEncoder().encode(text);
const polls = (r) => r.server.requests.filter((request) => request.target.startsWith("/v1/changes?since="));

async function started() {
  const r = await rig();
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock, onStatus: (status) => statuses.push(status) });
  await engine.start();
  return { ...r, timers, engine, statuses, last: () => statuses.at(-1) };
}

/** Answer the requests `when` picks with `answer`, the rest as the server does. */
function refuse(r, when, answer) {
  const request = r.transport.options.request;
  const seen = [];
  r.transport.options.request = async (sent) => {
    if (when(sent)) { seen.push(sent); return answer(sent); }
    return request(sent);
  };
  return seen;
}

async function stopped(r) {
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
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

// --- a refusal is not absence (#155, #177) --------------------------------

const proxyPage = () => ({ status: 403, headers: {}, text: "<html>SENTINEL access denied</html>", arrayBuffer: new ArrayBuffer(0) });

test("a feed refusal names itself on the first read, never as offline, and clears itself on the next answer (#155)", async () => {
  for (const [name, answer, expected] of [
    ["a wrong clock", (r) => r.server.error(401, "stale_timestamp", "timestamp is outside the window"), { code: "clock", message: CLOCK_OFF }],
    ["a proxy's page", () => proxyPage(), { code: "edge", message: NOT_OBSYNC_ANSWER }],
    ["a refusal no row names", (r) => r.server.error(403, "device_pending", "SENTINEL"), { code: "feed", message: FEED_FAILED }],
  ]) {
    const r = await started();
    await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
    let refusing = true;
    const seen = refuse(r, (sent) => refusing && sent.url.includes("/v1/changes?"), () => answer(r));
    r.server.releaseFeed();
    await r.timers.run(0, () => seen.length === 1 && r.last()?.kind === "error");
    assert.deepEqual(r.last(), { kind: "error", ...expected }, `${name}: named on the first refusal`);
    assert.ok(!r.statuses.some((status) => status.kind === "offline"), `${name}: never offline`);
    assert.equal(seen.length, 1, `${name}: a refusal is not retried as absence`);
    refusing = false;
    r.engine.wake("online");
    await r.timers.run(0, () => r.last()?.kind === "idle");
    assert.ok(r.host.logs.includes(`engine decision=cleared reason=${expected.code}`), r.host.logs.join("\n"));
    await stopped(r);
  }
});

test("a revoked device reads 'removed from your server' at once, and the feed stops (#155)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  refuse(r, (sent) => sent.url.includes("/v1/changes?"), () => r.server.error(403, "device_revoked", "device is revoked"));
  r.server.releaseFeed();
  await r.timers.run(0, () => r.engine.started === false);
  // The plugin keeps this status and tears the engine down (`setStatus`); the stop's own idle comes after it.
  assert.deepEqual(r.statuses.find((status) => status.kind === "error"), { kind: "error", code: "forgotten_device", message: REVOKED_DEVICE });
  assert.ok(!r.statuses.some((status) => status.kind === "offline"));
  await stopped(r);
});

test("a full server is said on the first chunk it refuses, stays through answered reads, and clears when it takes a change (#155)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  let full = true;
  const refused = refuse(r, (sent) => full && sent.method === "PUT", () => r.server.error(507, "volume_full", "free space is below the watermark"));
  r.host.seed("Big.md", "a note for a full server\n", 5000);
  r.engine.changed("Big.md");
  await r.timers.run(STEP_MS, () => r.last()?.kind === "error");
  assert.deepEqual(r.last(), { kind: "error", code: "storage", message: SERVER_FULL });
  assert.equal(refused.length, 1, "the first 507 is the answer: never eight tries");
  // The feed is answered: a full server still answers reads, so it stands.
  r.server.releaseFeed();
  await r.timers.run(0, () => r.server.feedWaiters.length === 1);
  assert.equal(r.last().code, "storage");
  // Room is made; the note goes up, and the status says so by itself.
  full = false;
  r.engine.changed("Big.md");
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Big.md") !== undefined && r.last()?.kind === "idle");
  assert.ok(r.host.logs.includes("engine decision=cleared reason=storage"));
  await stopped(r);
});

test("after a new vault key, an edit the server refuses for the old vault is sent once more as a new note, with one notice and no loop (#177)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  r.host.seed("Old.md", "written before the key changed\n", 5000);
  r.engine.changed("Old.md");
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Old.md") !== undefined);
  const old = r.state.fileByPath("Old.md").fileId;
  // The server now holds that file under a domain this device's key no longer names.
  const posts = refuse(r, (sent) => sent.method === "POST" && sent.url.endsWith(`/v1/files/${old}/versions`),
    () => r.server.error(409, "domain_mismatch", "the file belongs to another domain"));
  r.host.seed("Old.md", "edited, not yet sent, when the key changed\n", 6000);
  r.engine.changed("Old.md");
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Old.md") !== undefined && r.state.fileByPath("Old.md").fileId !== old);
  const fresh = r.state.fileByPath("Old.md").fileId;
  assert.equal(posts.length, 1, "one attempt at the old file: the answer is final");
  assert.equal(r.server.files.get(fresh).heads.length, 1, "the note is on the server under the new key");
  assert.equal(r.host.notices.filter((notice) => notice.includes("vault key changed")).length, 1);
  assert.ok(r.host.logs.includes(`push path_class=file decision=republish reason=domain_mismatch file=${old}`), r.host.logs.join("\n"));
  assert.ok(!r.statuses.some((status) => status.kind === "error"), "no error for a decision that is final");
  // A full scan cycle later nothing is re-queued: no loop.
  const before = posts.length;
  await r.timers.run(1000, () => r.host.logs.filter((line) => line.startsWith("scan decision=")).length >= 1);
  await r.timers.run(STEP_MS);
  assert.equal(posts.length, before);
  await stopped(r);
});
