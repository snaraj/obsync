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
const { SyncEngine, CALM_MS, FEED_STALL_MS, POLL_STALE_MS, CLOCK_OFF, SERVER_FULL, NOT_OBSYNC_ANSWER, RESUMES, FEED_FAILED, REVOKED_DEVICE } = require("../build/sync/engine.js");
const { EDGE_REQUIRED } = require("../build/transport.js");

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
  assert.deepEqual(r.engine.current(), { kind: "syncing", pending: 0 }, "checking, not idle, until the feed has answered");
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
  assert.ok(r.host.logs.includes(`feed decision=woken reason=online ended_pause=0 dropped_poll=1 read_beside=0 waited_ms=${POLL_STALE_MS}`), r.host.logs.join("\n"));
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

test("a window back in front keeps the one long poll in flight however long it waited, reads beside it at once, and never moves the cursor back (#288)", async () => {
  const r = await started();
  const told = [];
  r.host.hurry = (busy) => told.push(busy);
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const before = polls(r).length;
  const waits = () => polls(r).slice(before).map((request) => /wait=(\d+)/.exec(request.target)[1]);
  // Another device's note lands, and nothing tells the waiting poll: its
  // answer waits in a renderer that was stopped, or a lid slept on it.
  const deaf = r.server.feedWaiters;
  r.server.feedWaiters = [];
  await r.server.publish({ fileId: "ab".repeat(16), path: "Arrived.md", bytes: enc("today's note\n"), mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.server.feedWaiters = deaf;
  const head = r.server.seq;
  r.host.clock += POLL_STALE_MS;
  r.engine.wake("foreground");
  // No virtual time passes: the read is the wake's, not a pause running out.
  await r.timers.run(0, () => r.host.text("Arrived.md") !== null && r.host.logs.some((line) => line.startsWith("feed decision=read_beside")));
  assert.ok(!r.host.logs.some((line) => line.startsWith("feed decision=retry")), "a kept poll is not a failed read");
  assert.equal(r.state.data.lastSeq, head, "the read beside it brought the note at once");
  assert.ok(r.host.logs.includes(`feed decision=woken reason=foreground ended_pause=0 dropped_poll=0 read_beside=1 waited_ms=${POLL_STALE_MS}`), r.host.logs.join("\n"));
  // ONE LONG POLL IN FLIGHT: the one that waited, neither ended nor sent
  // again. `requestUrl` cannot abort it, and on a desktop the poll that
  // replaced it waited behind it and ran out of its budget first.
  assert.deepEqual(waits(), ["0"]);
  assert.equal(r.server.feedWaiters.length, 1);
  assert.ok(!r.host.logs.some((line) => line.includes("decision=cancelled")), r.host.logs.join("\n"));
  // Focus, the desktop's own word, is the same wake.
  r.host.clock += POLL_STALE_MS;
  r.engine.wake("focus");
  await r.timers.run(0, () => r.host.logs.filter((line) => line.startsWith("feed decision=read_beside")).length === 2);
  assert.deepEqual(waits(), ["0", "0"]);
  assert.equal(r.server.feedWaiters.length, 1);

  // The kept poll's answer arrives, naming the old cursor: the cursor stays
  // where the read beside it left it, and the next poll goes out from there.
  r.server.releaseFeed();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1 && waits().length === 3);
  assert.equal(r.state.data.lastSeq, head, "the cursor never moves backwards");
  assert.deepEqual(waits(), ["0", "0", "55"]);
  assert.match(polls(r).at(-1).target, new RegExp(`since=${head}&`));
  // That old-cursor page is not more to read: with the next poll waiting,
  // the window's full pace is given back after the calm (#283).
  await r.timers.run(CALM_MS);
  assert.equal(told.at(-1), false, JSON.stringify(told));
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
});

test("a read beside a kept poll is a read: the feed's stall watch starts again from it (#276, #288)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  // Most of the watch's time passes with the poll waiting; the window comes back.
  r.timers.now += FEED_STALL_MS - 20_000;
  await r.timers.run(0);
  r.host.clock += POLL_STALE_MS;
  r.engine.wake("foreground");
  await r.timers.run(0, () => r.host.logs.some((line) => line.startsWith("feed decision=read_beside")));
  // Past where the poll's own watch would have fired: the feed read, so it did not stall.
  r.timers.now += 30_000;
  await r.timers.run(0);
  assert.ok(!r.host.logs.some((line) => line.startsWith("feed decision=stalled")), r.host.logs.join("\n"));
  // And a feed that then reads nothing more says so, from the read beside.
  r.timers.now += FEED_STALL_MS;
  await r.timers.run(0, () => r.host.logs.some((line) => line.startsWith("feed decision=stalled")));
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
  assert.ok(r.host.logs.includes("feed decision=woken reason=online ended_pause=1 dropped_poll=0 read_beside=0 waited_ms=0"), r.host.logs.join("\n"));
  assert.match(polls(r)[before].target, /wait=0/, "the read after a failure asks without waiting");
  // The address changed: the poll in flight went to the old one, however fresh it is.
  await r.timers.run(0, () => r.server.feedWaiters.length === 1);
  const retries = r.host.logs.filter((line) => line.startsWith("feed decision=retry")).length;
  r.engine.wake("address");
  await r.timers.run(0, () => r.server.feedWaiters.length === 2);
  assert.ok(r.host.logs.includes("feed decision=woken reason=address ended_pause=0 dropped_poll=1 read_beside=0 waited_ms=0"), r.host.logs.join("\n"));
  assert.equal(r.host.logs.filter((line) => line.startsWith("feed decision=retry")).length, retries, "a dropped poll is not a failed read");
  r.engine.stop();
  r.server.releaseFeed();
  await r.engine.stopAndWait();
});

test("a chunk upload asleep in its backoff is sent to a newly adopted address within one step (#186)", async () => {
  const r = await started();
  // The start's heartbeat reads the device names in the background (#195); a
  // read still unsent when the server moves sleeps at the old address in the
  // push's place, so the move waits for it.
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1 &&
    r.host.logs.includes("devices decision=read reason=heartbeat devices=1 duration_ms=0"));
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
  // A note's one small chunk is its push's first request (#195).
  assert.deepEqual(sent, ["PUT sync.example.invalid"], "the push's first request failed at the old address and sleeps");
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
    ["a wrong clock", (r) => r.server.error(401, "stale_timestamp", "timestamp is outside the window"), { code: "clock", message: `${CLOCK_OFF} ${RESUMES}` }],
    ["a proxy's page", () => proxyPage(), { code: "edge", message: `${NOT_OBSYNC_ANSWER} ${RESUMES}` }],
    ["a read around the server's edge (#228)", (r) => r.server.error(421, "edge_required", "edge connecting-address header missing"), { code: "edge", message: `${EDGE_REQUIRED} ${RESUMES}` }],
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
  assert.deepEqual(r.statuses.find((status) => status.kind === "error"), { kind: "error", code: "credential_rejected", message: REVOKED_DEVICE });
  assert.ok(!r.statuses.some((status) => status.kind === "offline"));
  await stopped(r);
});

test("a full server is said on the first chunk it refuses, stays through answered reads, and clears when it takes a change (#155, #291)", async () => {
  // The watermark's refusal, and the disk's own when a capacity declared
  // larger than the disk leaves the watermark nothing to see (#291).
  for (const [code, detail] of [["volume_full", "free space is below the watermark"], ["storage_full", "the volume is out of space"]]) {
    const r = await started();
    await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
    let full = true;
    const refused = refuse(r, (sent) => full && sent.method === "PUT", () => r.server.error(507, code, detail));
    r.host.seed("Big.md", "a note for a full server\n", 5000);
    r.engine.changed("Big.md");
    await r.timers.run(STEP_MS, () => r.last()?.kind === "error");
    assert.deepEqual(r.last(), { kind: "error", code: "storage", message: `${SERVER_FULL} ${RESUMES}` }, code);
    assert.equal(refused.length, 1, `${code}: the first 507 is the answer: never eight tries`);
    // The feed is answered: a full server still answers reads, so it stands.
    r.server.releaseFeed();
    await r.timers.run(0, () => r.server.feedWaiters.length === 1);
    assert.equal(r.last().code, "storage", code);
    // Room is made; the note goes up, and the status says so by itself.
    full = false;
    r.engine.changed("Big.md");
    await r.timers.run(STEP_MS, () => r.state.fileByPath("Big.md") !== undefined && r.last()?.kind === "idle");
    assert.ok(r.host.logs.includes("engine decision=cleared reason=storage"), code);
    await stopped(r);
  }
});

test("a journal volume with no room refuses the feed's read too: the device says out of storage, not offline, and the next answered read clears it (#292)", async () => {
  // Every signed request records its nonce on the journal volume first, so a
  // full one refuses reads as well; with nothing to write, only a read can
  // show the room came back.
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  let full = true;
  const refused = refuse(r, (sent) => full && sent.url.includes("/v1/changes?"), () => r.server.error(507, "storage_full", "the volume is out of space"));
  r.server.releaseFeed();
  await r.timers.run(STEP_MS, () => r.last()?.kind === "error");
  assert.deepEqual(r.last(), { kind: "error", code: "storage", message: `${SERVER_FULL} ${RESUMES}` });
  assert.equal(refused.length, 1, "the first 507 is the answer: never retried as absence");
  assert.ok(!r.statuses.some((status) => status.kind === "offline"), "a full server is never absence");
  // Room again, and nothing written since: the feed's next read is answered.
  full = false;
  await r.timers.run(STEP_MS, () => r.last()?.kind === "idle");
  assert.ok(r.host.logs.includes("engine decision=cleared reason=storage"), r.host.logs.join("\n"));
  await stopped(r);
});

/** A note whose chunk the server answers 500 on every attempt, until the push gives up (#293). */
async function unsent(r) {
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const gate = { failing: true };
  const refused = refuse(r, (sent) => gate.failing && sent.method === "PUT", () => r.server.error(500, "io_error", "SENTINEL"));
  const from = r.statuses.length;
  r.host.seed("Unsent.md", "a note the server could not take\n", 5000);
  r.engine.changed("Unsent.md");
  const failed = () => r.host.logs.filter((line) => line.startsWith("push path_class=file decision=failed ")).length;
  await r.timers.run(STEP_MS, () => failed() === 1);
  assert.ok(refused.length > 1, "the chunk was tried again before the push gave up");
  // The feed is answered: the server is there again, and the note is not on it.
  r.server.releaseFeed();
  await r.timers.run(0, () => r.server.feedWaiters.length === 1);
  assert.equal(r.state.fileByPath("Unsent.md"), undefined);
  return { gate, from, failed };
}

test("a change a push gave up on at a 5xx is work until a push takes it: never idle over an unsent note (#293)", async () => {
  const r = await started();
  const { gate, from, failed } = await unsent(r);
  assert.deepEqual(r.engine.current(), { kind: "syncing", pending: 1 }, "idle over an unsent note");
  // Each scan sends it again, into the same 500: still work, never idle.
  await r.timers.run(STEP_MS, () => failed() >= 3);
  assert.deepEqual(r.statuses.slice(from).filter((status) => status.kind === "idle"), [], "a status said idle while the note was unsent");
  assert.deepEqual(r.statuses.slice(from).filter((status) => status.kind === "syncing" && status.pending > 1), [], "one note counted twice");
  assert.deepEqual(r.engine.current(), { kind: "syncing", pending: 1 });
  // The server takes it at the next scan's push, and idle comes back.
  gate.failing = false;
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Unsent.md") !== undefined && r.last()?.kind === "idle");
  assert.equal(r.server.journal.at(-1).file_id, r.state.fileByPath("Unsent.md").fileId);
  await stopped(r);
});

test("six unsent notes read six, never more, while a scan queues them all again behind four uploads (#293)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const gate = { failing: true };
  refuse(r, (sent) => gate.failing && sent.method === "PUT", () => r.server.error(500, "io_error", "SENTINEL"));
  const from = r.statuses.length;
  const paths = Array.from({ length: 6 }, (_, i) => `Unsent-${i}.md`);
  paths.forEach((path, i) => { r.host.seed(path, `unsent note ${i}\n`, 5000 + i); r.engine.changed(path); });
  const failed = () => r.host.logs.filter((line) => line.startsWith("push path_class=file decision=failed ")).length;
  // Every push gives up, and a scan sends every note again: two rounds.
  await r.timers.run(STEP_MS, () => failed() >= 12);
  const counted = r.statuses.slice(from).filter((status) => status.kind === "syncing").map((status) => status.pending);
  assert.ok(counted.includes(6), `six unsent notes were counted: ${counted}`);
  assert.deepEqual(counted.filter((pending) => pending > 6), [], `a note counted twice: ${counted}`);
  gate.failing = false;
  await r.timers.run(STEP_MS, () => paths.every((path) => r.state.fileByPath(path) !== undefined) && r.last()?.kind === "idle");
  await stopped(r);
});

test("an unsent change the next pass finds nothing to send for is no longer work: gone, or put back as sent (#293)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  r.host.seed("Undone.md", "as the server has it\n", 4000);
  r.engine.changed("Undone.md");
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Undone.md") !== undefined && r.last()?.kind === "idle");
  const { failed } = await unsent(r);
  r.host.seed("Undone.md", "an edit the server could not take\n", 6000);
  r.engine.changed("Undone.md");
  await r.timers.run(STEP_MS, () => failed() >= 2 && r.engine.current().pending === 2);
  // Neither through an event, only as the next listing says: one removed
  // the way a file manager removes it, one put back as it was sent.
  const sent = failed();
  r.host.files.delete("Unsent.md");
  r.host.seed("Undone.md", "as the server has it\n", 4000);
  await r.timers.run(STEP_MS, () => r.engine.current().kind === "idle");
  assert.equal(failed(), sent, "a change with nothing left to send was pushed again");
  await stopped(r);
});

test("a push that gives up while a pass compares the vault is still work after that pass (#293)", async () => {
  const r = await started();
  const { failed } = await unsent(r);
  // A note the pass compares after it has queued the unsent one, held until
  // that push has given up again, and then not this device's to sync.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const syncable = r.host.syncable.bind(r.host);
  r.host.syncable = async (path, kind) => (path === "Later.md" ? (await held, false) : syncable(path, kind));
  r.host.seed("Later.md", "compared last\n", 6000);
  const from = r.statuses.length;
  await r.timers.run(STEP_MS, () => failed() === 2);
  release();
  await r.timers.run(STEP_MS, () => r.host.logs.some((line) => line.startsWith("scan decision=queued ") && / skipped=1 /.test(line)));
  assert.deepEqual(r.engine.current(), { kind: "syncing", pending: 1 }, "the pass judged a push that gave up during it");
  assert.deepEqual(r.statuses.slice(from).filter((status) => status.kind === "idle"), []);
  await stopped(r);
});

test("a change sent around the server's edge says so, not that the server refused it, and clears when one gets through (#228)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  let around = true;
  const refused = refuse(r, (sent) => around && sent.method === "PUT", () => r.server.error(421, "edge_required", "edge connecting-address header missing"));
  r.host.seed("Edge.md", "a note sent while the route missed the edge\n", 5000);
  r.engine.changed("Edge.md");
  await r.timers.run(STEP_MS, () => refused.length === 1);
  await r.timers.run(STEP_MS);
  assert.equal(refused.length, 1, "a refusal is not retried as absence");
  assert.deepEqual(r.last(), { kind: "error", code: "edge", message: `${EDGE_REQUIRED} ${RESUMES}` });
  // The route goes through the edge again; the next change is taken, and the status says so by itself.
  around = false;
  r.engine.changed("Edge.md");
  await r.timers.run(STEP_MS, () => r.state.fileByPath("Edge.md") !== undefined && r.last()?.kind === "idle");
  assert.ok(r.host.logs.includes("engine decision=cleared reason=edge"), r.host.logs.join("\n"));
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

test("the feed converges on an older server whose large pages pass the ceiling, asking smaller (#202)", async () => {
  const { CHANGES_ANSWER_MAX } = require("../build/transport.js");
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  // A 1.1.3 server bounds a page by entries only: anything above 250 here is too big to keep.
  const huge = { status: 200, headers: {}, text: `{"pad":"${"y".repeat(CHANGES_ANSWER_MAX)}"}`, arrayBuffer: new ArrayBuffer(0) };
  const asked = [];
  refuse(r, (sent) => {
    const limit = /\/v1\/changes\?.*limit=(\d+)/.exec(sent.url)?.[1];
    if (limit !== undefined) asked.push(Number(limit));
    return limit !== undefined && Number(limit) > 250;
  }, () => huge);
  await arriving(r, 3);
  await r.timers.run(STEP_MS, () => r.host.text("In/2.md") !== null && r.state.data.lastSeq === r.server.seq);
  assert.ok(asked.includes(1000) && asked.includes(500) && asked.includes(250), `${asked}`);
  assert.ok(r.host.logs.some((line) => line.endsWith("decision=refused reason=over_cap retry limit=250")), r.host.logs.join("\n"));
  assert.ok(!r.statuses.some((status) => status.kind === "offline" || status.kind === "error"), "not a failure, and not offline");
  await stopped(r);
});

// --- the status is derived from facts (#158) -------------------------------

/** Land notes on the server without the waiting poll hearing of them, then answer it. */
async function arriving(r, count) {
  const deaf = r.server.feedWaiters;
  r.server.feedWaiters = [];
  for (let i = 0; i < count; i++) {
    await r.server.publish({ fileId: (10 + i).toString(16).padStart(32, "0"), path: `In/${i}.md`, bytes: enc(`arrived ${i}\n`),
      mtime: 1000 + i, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  }
  r.server.feedWaiters = deaf;
  r.server.releaseFeed();
}

test("a receiving device counts what arrives down to 0, and never reads idle before the last note is written (#158)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1 && r.last()?.kind === "idle");
  const from = r.statuses.length;
  await arriving(r, 3);
  await r.timers.run(STEP_MS, () => r.host.text("In/2.md") !== null && r.last()?.kind === "idle");
  const all = r.statuses.slice(from).map((status) => status.kind === "syncing" ? status.pending : status.kind);
  // The answered poll's own empty page may come first; the page that carries the notes starts at 3.
  const seen = all.slice(all.indexOf(3));
  assert.equal(seen.at(-1), "idle");
  const during = seen.slice(0, -1);
  assert.ok(during.length >= 3 && during.every((value) => typeof value === "number" && value > 0), `syncing the whole page: ${seen}`);
  assert.deepEqual(during.slice(0, 3), [3, 2, 1], "counted down as each note lands");
  await stopped(r);
});

test("a sending device never reads idle while pushes are still queued, echo pages or not (#158)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  const from = r.statuses.length;
  for (let i = 0; i < 12; i++) r.host.seed(`Out/${i}.md`, `sent ${i}\n`, 2000 + i);
  // Queued as a find-and-replace or a pasted folder does: all at once, then drained in batches.
  const queued = () => r.engine.queue.length + r.engine.active;
  const seen = [];
  const said = r.engine.onStatus;
  r.engine.onStatus = (status) => { said(status); seen.push([status.kind, queued()]); };
  for (let i = 0; i < 12; i++) r.engine.changed(`Out/${i}.md`);
  await r.timers.run(STEP_MS, () => Array.from({ length: 12 }, (_, i) => r.state.fileByPath(`Out/${i}.md`)).every(Boolean) && queued() === 0);
  await r.timers.run(STEP_MS, () => r.last()?.kind === "idle");
  assert.ok(seen.some(([kind]) => kind === "syncing"), "the drain said so");
  assert.deepEqual(seen.filter(([kind, left]) => kind === "idle" && left > 0), [], `no idle with pushes left: ${JSON.stringify(seen)}`);
  assert.ok(r.statuses.length > from);
  await stopped(r);
});

test("Sync now answers with how many changes it sent, and 0 when there was nothing to send (#182)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  // Written while nothing watched: the press's own look at the vault finds them.
  r.host.seed("Now a.md", "first\n", 4000);
  r.host.seed("Now b.md", "second\n", 4001);
  const press = async () => {
    let sent;
    void r.engine.syncNow().then((count) => { sent = count; });
    await r.timers.run(STEP_MS, () => sent !== undefined);
    return sent;
  };
  assert.equal(await press(), 2);
  assert.ok(r.state.fileByPath("Now a.md") && r.state.fileByPath("Now b.md"), "and they were sent");
  assert.equal(await press(), 0);
  // A note deleted while nothing watched: its tombstone is a change sent too.
  r.host.files.delete("Now b.md");
  assert.equal(await press(), 1);
  assert.ok(r.server.journal.some((frame) => frame.deleted), "and the server has it");
  await stopped(r);
});

test("the next answered read takes back the feed's offline, even an empty page (#158)", async () => {
  const r = await started();
  await r.timers.run(STEP_MS, () => r.server.feedWaiters.length === 1);
  let down = true;
  refuse(r, (sent) => down && sent.url.includes("/v1/changes?"), () => { throw new Error("net::ERR_CONNECTION_REFUSED"); });
  r.server.releaseFeed();
  await r.timers.run(0, () => r.last()?.kind === "offline");
  down = false;
  const from = r.statuses.length;
  const asked = polls(r).length;
  r.engine.wake("answered");
  await r.timers.run(0, () => r.last()?.kind === "idle");
  assert.equal(r.last()?.kind, "idle");
  // The read that took offline back is the wake's quick one: nothing changed
  // since, so its page was empty. A long poll may already follow it.
  assert.match(polls(r)[asked].target, /wait=0/, "an empty quick read, not a page carrying a change");
  assert.ok(r.statuses.slice(from).length >= 1);
  await stopped(r);
});

test("a device starting with an unfinished upload reads checking, then syncing, never idle before it is sent (#158)", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const statuses = [];
  r.host.seed("Unsent.md", "written while Obsidian was closed\n", 3000);
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock, onStatus: (status) => statuses.push(status) });
  await engine.start();
  await timers.run(STEP_MS, () => r.state.fileByPath("Unsent.md") !== undefined && statuses.at(-1)?.kind === "idle");
  const before = statuses.slice(0, statuses.findIndex((status) => status.kind === "idle"));
  assert.ok(before.some((status) => status.kind === "syncing" && status.pending > 0), JSON.stringify(statuses));
  assert.ok(r.server.journal.some((frame) => frame.file_id === r.state.fileByPath("Unsent.md").fileId), "idle came after the upload");
  engine.stop();
  r.server.releaseFeed();
  await engine.stopAndWait();
});
