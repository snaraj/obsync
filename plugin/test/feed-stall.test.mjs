/**
 * A feed that stops says so, and so does a Sync now that waits (issue #276).
 *
 * A 1.1.4 desktop's feed stopped for good after a Settings popout closed:
 * its long poll was dropped by the window's focus, an empty page came back
 * and never applied, and the device read nothing from any other device again
 * -- in silence, while Sync now did not return. The engine showed only that
 * the feed was past its read; the likeliest wait for such a page is the pull
 * chain (`exclusive`), behind a pull that never ends, and which one nothing
 * said. Not reproduced since, so the cause is unconfirmed.
 * These tests hold the chain with the pull that same focus puts there (the
 * first walk's sweep of interrupted writes) and pin what is said now:
 * one line after twice the long-poll budget naming the pull, and a Sync now
 * status naming what it waits on. Nothing is cut short; the wait is reported.
 *
 * And the ordering the issue suspected: a device's own echo read before its
 * push is answered neither holds the feed nor loses the next page.
 *
 * PLATFORM. Engine code, identical on desktop and mobile: the fake host
 * stands for both.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine, FEED_STALL_MS, LARGE_APPLY_BYTES, SYNC_NOW_FEED_MS } = require("../build/sync/engine.js");
const { bytesSource, chunkStream } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const OTHER = "ffffffffffffffffffffffffffffffff";
const STALLED = /^feed decision=stalled waited_ms=(\d+) budget_ms=(\d+) poll_ms=none reading=0 answered=1 last_seq=\d+ in_flight=\d+ pushing=0 chain=sweep:(\d+) behind=2 pulls=0 step=none lane=idle staged=0 saving=0 scan_ms=(\d+)$/;

/**
 * The stalled desktop's shape: its first walk -- the sweep that walk puts on
 * the pull chain, and the walk's own listing -- does not return until
 * `release`, another device's note is on the server, and the page that brings
 * it waits behind the sweep.
 */
async function held(t) {
  const r = await rig();
  const timers = new FakeTimers();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  r.host.sweep = () => gate;
  const list = r.host.list.bind(r.host);
  const statuses = [];
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, timers, now: () => timers.now,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => { engine.stop(); release(); r.server.releaseFeed(); });
  await engine.start();
  // The start's own pass has listed the vault; the walk's listing waits.
  r.host.list = async () => { await gate; return list(); };
  // The first walk: its sweep takes the chain (a Settings popout closing starts it at once).
  await timers.run(1000, () => engine.holder?.label === "sweep" && engine.poll !== null && r.server.feedWaiters.length === 1);
  const sent = engine.poll.sent;
  await r.server.publish({
    fileId: "5a".repeat(16), path: "Notes/remote.md", bytes: new TextEncoder().encode("REMOTE SENTINEL\n"),
    mtime: 1500, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER,
  });
  // The poll is answered, and its page waits behind the sweep -- after the
  // walk's own comparison, which since #244 takes the same chain (`inPass`).
  await timers.run(0, () => engine.poll === null && engine.feedAnswered && engine.behind === 2);
  const stalled = () => r.host.logs.filter((line) => line.startsWith("feed decision=stalled"));
  return { r, timers, engine, release, statuses, sent, stalled };
}

test("a feed held behind a pull that never ends says so once, at twice its long-poll budget, naming that pull", async (t) => {
  const { r, timers, engine, release, sent, stalled } = await held(t);
  assert.equal(FEED_STALL_MS, 110_000, "twice the server's 55 s long poll");

  timers.now = sent + FEED_STALL_MS - 1000;
  await timers.run(0);
  assert.deepEqual(stalled(), [], "said before the budget ran out");
  timers.now = sent + FEED_STALL_MS;
  await timers.run(0, () => stalled().length > 0);
  const [line] = stalled();
  const match = STALLED.exec(line);
  assert.ok(match, line);
  assert.equal(Number(match[1]), FEED_STALL_MS, line);
  assert.equal(Number(match[2]), FEED_STALL_MS, line);
  assert.ok(Number(match[3]) > 0 && Number(match[4]) >= Number(match[3]), `the sweep, and the walk it came from, are named with their ages: ${line}`);
  timers.now += 5 * FEED_STALL_MS;
  await timers.run(0);
  assert.equal(stalled().length, 1, "one line per stall, not one per minute");
  assert.equal(r.host.files.has("Notes/remote.md"), false);

  // The pull ends: the page applies, the feed reads again and the note arrives.
  release();
  await timers.run(STEP_MS, () => r.host.files.has("Notes/remote.md") && settled({ state: r.state }, "Notes/remote.md"));
  assert.equal(stalled().length, 1);
  assert.equal(engine.scanSince, null, "a walk that ended is still counted as running");
  // A stopped engine's watch says nothing.
  engine.stop();
  timers.now += 5 * FEED_STALL_MS;
  await timers.run(0);
  assert.equal(stalled().length, 1, "a stopped engine reported a stall");
});

test("Sync now behind that pull says on what, in the status and one line, and waits on; its turn ends the saying", async (t) => {
  const { timers, engine, release, statuses, r } = await held(t);
  let done = false;
  const press = engine.syncNow().then(() => { done = true; });
  const waiting = () => r.host.logs.filter((line) => line.startsWith("sync_now decision=waiting "));
  await timers.run(1000, () => waiting().length > 0);
  // Behind the sweep: the walk's comparison (#244), the page, and this press.
  assert.match(waiting()[0], new RegExp(`^sync_now decision=waiting on=sweep held_ms=\\d+ behind=3 budget_ms=${SYNC_NOW_FEED_MS}$`));
  assert.deepEqual(statuses.at(-1), { kind: "syncing", pending: 0, waiting: "sweep" });
  assert.deepEqual(engine.current(), { kind: "syncing", pending: 0, waiting: "sweep" }, "the status names the pull the press waits on");
  timers.now += 60_000;
  await timers.run(0);
  assert.equal(done, false, "the wait was cut short");

  release();
  await timers.run(STEP_MS, () => done);
  await press;
  assert.equal(waiting().length, 1);
  assert.equal(statuses.at(-1).waiting, undefined, "the status kept naming a wait that had ended");
  assert.equal(engine.current().waiting, undefined);
});

test("a page whose record in hand never finishes, with the download lane waiting its turn, names the record, its step, the lane and a save in flight (#276, first sync)", async (t) => {
  // Lane H's first-sync stall: 82 of 1,000 entries applied, a large file
  // staged by the lane, the lane waiting on the chain the page held, and the
  // page waiting on something that sent no request.
  const r = await rig();
  const timers = new FakeTimers();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path, size) => {
    if (path === "Notes/stuck.md") await gate;
    return writer(path, size);
  };
  const bytes = new Uint8Array(LARGE_APPLY_BYTES + 1).fill(73);
  const chunks = [];
  for await (const plaintext of chunkStream(bytesSource(bytes))) {
    const part = await c.encryptChunk(r.keys.domainKey, plaintext);
    r.server.chunks.set(part.sid, part.ciphertext);
    chunks.push({ sid: part.sid, cid: c.hex(part.cid), len: plaintext.length });
  }
  await r.server.publishManifest({
    fileId: "b1".repeat(16), sids: chunks.map((chunk) => chunk.sid), parents: [], deviceId: OTHER, manifestKey: r.keys.manifestKey, bytes: bytes.length,
    manifest: { v: 1, path: "Files/big.bin", size: bytes.length, mtime: 1400, domain: "0123456789abcdef0123456789abcdef", chunks, sha256: c.hex(await c.sha256(bytes)), deleted: false },
  });
  const stuck = await r.server.publish({
    fileId: "5a".repeat(16), path: "Notes/stuck.md", bytes: new TextEncoder().encode("STUCK SENTINEL\n"),
    mtime: 1500, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER,
  });
  // The lane's second look at its file is the first thing it does in its turn.
  let lane;
  const turn = new Promise((resolve) => { lane = resolve; });
  const getFile = r.transport.getFile.bind(r.transport);
  let looks = 0;
  r.transport.getFile = async (fileId, options) => {
    if (fileId === "b1".repeat(16) && ++looks === 2) await turn;
    return getFile(fileId, options);
  };
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers, now: () => timers.now });
  t.after(() => { engine.stop(); release(); lane(); r.server.releaseFeed(); });
  await engine.start();
  await timers.run(0, () => engine.holder?.label === "page" && engine.step?.name === "apply" && engine.laning && engine.behind > 0);
  // And a metadata save that has not come back: the other wait that sends nothing.
  const store = r.state.store;
  const save = store.saveData;
  store.saveData = async (value) => { await gate; return save(value); };
  const saving = r.state.save().catch(() => undefined);
  timers.now += FEED_STALL_MS;
  const stalled = () => r.host.logs.filter((line) => line.startsWith("feed decision=stalled"));
  await timers.run(0, () => stalled().length > 0);
  assert.equal(stalled().length, 1);
  const line = stalled()[0];
  const match = new RegExp(
    `^feed decision=stalled waited_ms=\\d+ budget_ms=${FEED_STALL_MS} poll_ms=none reading=0 answered=1 last_seq=\\d+ in_flight=\\d+ pushing=0 ` +
      `chain=page:(\\d+) behind=\\d+ pulls=1 step=apply:${stuck.seq}:(\\d+) lane=turn staged=1 saving=1 scan_ms=(none|\\d+)$`).exec(line);
  assert.ok(match, line);
  assert.ok(Number(match[2]) >= FEED_STALL_MS && Number(match[1]) >= Number(match[2]), `the record's step is aged from its start: ${line}`);

  // The write ends and the note lands; the lane has its turn, and it is the
  // chain's holder that names where it is, not a turn it no longer waits for.
  release();
  await saving;
  await timers.run(0, () => r.host.text("Notes/stuck.md") === "STUCK SENTINEL\n" && looks === 2 && engine.poll !== null);
  assert.equal(engine.step, null, "a page that ended still names a record in hand");
  timers.now += FEED_STALL_MS;
  await timers.run(0, () => stalled().length > 1);
  assert.match(stalled()[1], / chain=lane:\d+ behind=\d+ pulls=0 step=none lane=busy staged=1 saving=0 /);
  lane();
  await timers.run(STEP_MS, () => r.host.files.has("Files/big.bin") && !engine.laning);
  assert.equal(stalled().length, 2);
});

test("a device's own echo read before its push is answered holds nothing: the next page applies (#276's suspected order)", async (t) => {
  const { a, b, timers } = await pair(t, "immediate", { isMobileB: false });
  const real = a.transport.options.request;
  let echoed = null;
  // A's version post is answered only once A's feed has applied its own
  // echo -- or after two seconds, so a wedge fails the test rather than the harness.
  a.transport.options.request = async (request) => {
    const answer = await real(request);
    if (request.method !== "POST" || !/\/versions$/.test(request.url) || answer.status !== 201) return answer;
    const seq = JSON.parse(answer.text).seq;
    for (const until = Date.now() + 2000; a.state.data.lastSeq < seq && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 1));
    echoed ??= a.state.data.lastSeq >= seq;
    return answer;
  };
  await a.engine.start();
  await b.engine.start();
  a.host.write("Mine.md", "A SENTINEL\n", 1000);
  await timers.run(STEP_MS, () => echoed !== null && settled(a, "Mine.md"));
  assert.equal(echoed, true, "the echo was not read before the push's answer: the order under test did not happen");
  b.host.write("Theirs.md", "B SENTINEL\n", 2000);
  await timers.run(STEP_MS, () => a.host.text("Theirs.md") === "B SENTINEL\n" && settled(a, "Theirs.md"));
  assert.equal(b.host.text("Mine.md"), "A SENTINEL\n");
  assert.equal(a.host.logs.some((line) => line.startsWith("feed decision=stalled")), false);
});
