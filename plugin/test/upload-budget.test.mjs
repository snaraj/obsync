/**
 * The V7 retransmission budget (`docs/validation.md`, issue #56).
 *
 * V7 kills Obsidian during a 20 GiB upload, reopens it, and allows fewer than
 * 8 MiB of ciphertext to be re-sent. The measurement in issue #56 charged
 * 10,910,020 to 16,743,295 duplicated bytes to four chunk uploads interrupted
 * at once, so the budget is not a property of one upload: it is a property of
 * how many bytes the client is willing to have in flight, how many copies of
 * one chunk it will send, and what it does with an answer it never got.
 *
 * THE WIRE IS THE INSTRUMENT. Every test here drives the real `Transport`,
 * the real signing and the real fake obsyncd (which verifies both), with one
 * counting relay in between that can hold a `PUT`, lose its answer after the
 * body was stored, or drop the body entirely. Duplicated ciphertext is then
 * arithmetic over what the relay saw, not a claim about intent.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { pushFile } = require("../build/sync/push.js");
const { Transport, UPLOAD_BUDGET_BYTES, UPLOAD_INFLIGHT_MAX } = require("../build/transport.js");

const turn = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Deterministic incompressible-looking bytes: a fixture, never a secret. */
function noise(size) {
  const data = new Uint8Array(size);
  let x = 0x1234abcd;
  for (let i = 0; i < size; i++) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    data[i] = x & 0xff;
  }
  return data;
}

/**
 * The counting relay. `verdict(sid, attempt)` decides what happens to one
 * attempt: `ok` forwards it, `lost` stores the body and then loses the answer
 * (which is what an interrupted connection to a server that already wrote the
 * chunk looks like), `dropped` sends the bytes nowhere. `holdAfter` hangs
 * every upload past the first N, which is how a process death is modelled:
 * the bytes left the device and nothing will ever acknowledge them.
 */
function relay(server, { verdict = () => "ok", holdAfter = Infinity, before = () => undefined } = {}) {
  const never = new Promise(() => undefined);
  const w = {
    puts: [],
    failed: [],
    exists: [],
    sent: 0,
    inflight: 0,
    peakInflight: 0,
    peakPerSid: 0,
    live: new Map(),
    attempts: new Map(),
    started: 0,
  };
  w.request = async (request) => {
    const target = request.url.replace(/^https?:\/\/[^/]+/, "");
    if (target === "/v1/chunks/exists") w.exists.push(JSON.parse(request.body).sids);
    before(request, target);
    if (request.method !== "PUT" || !target.startsWith("/v1/chunks/")) return server.request(request);
    const sid = target.slice("/v1/chunks/".length);
    const bytes = request.body.byteLength;
    const attempt = (w.attempts.get(sid) ?? 0) + 1;
    w.attempts.set(sid, attempt);
    w.puts.push({ sid, bytes, attempt });
    w.sent += bytes;
    w.inflight += bytes;
    w.peakInflight = Math.max(w.peakInflight, w.inflight);
    const live = (w.live.get(sid) ?? 0) + 1;
    w.live.set(sid, live);
    w.peakPerSid = Math.max(w.peakPerSid, live);
    try {
      if (++w.started > holdAfter) await never;
      await turn();
      const decided = verdict(sid, attempt, w);
      if (decided !== "ok") w.failed.push({ sid, bytes, attempt, decided });
      if (decided === "lost") {
        await server.request(request);
        throw new Error("relay: the body landed and the answer did not");
      }
      if (decided === "dropped") throw new Error("relay: the body never arrived");
      return await server.request(request);
    } finally {
      w.inflight -= bytes;
      w.live.set(sid, w.live.get(sid) - 1);
    }
  };
  return w;
}

/** The same paired device on a new transport: what reopening Obsidian is. */
function reopen(r, request) {
  return {
    ...r.context,
    transport: new Transport({
      request,
      serverUrl: () => r.state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => r.host.clock,
      sleep: async () => undefined,
      maxAttempts: 2,
      log: (line) => r.host.logs.push(line),
    }),
  };
}

/**
 * Wait for `ready`, then for the client to stop sending: what it had in
 * flight at that moment is what a process death would waste. The readiness
 * predicate is not optional — a run whose first pass is still chunking has
 * sent nothing yet, and "nothing, steadily" is not quiescence.
 */
async function quiet(w, ready) {
  for (let i = 0; i < 400 && !ready(); i++) await turn();
  assert.ok(ready(), "the run reached the state the measurement needs");
  for (let last = -1, stable = 0; stable < 4; ) {
    await turn();
    if (w.sent === last) stable += 1;
    else {
      stable = 0;
      last = w.sent;
    }
  }
  return w.sent;
}

const summaries = (r) => r.host.logs.filter((line) => line.startsWith("upload decision=summary"));

test("V7: killing an upload and reopening re-sends fewer than 8 MiB", async () => {
  const r = await rig();
  const path = "Archive/box.bin";
  r.host.seed(path, noise(28 << 20), 1000);

  // The run that dies: four chunks land, the rest are held mid-body, and the
  // process never comes back to acknowledge them (issue #56's shape).
  const dying = relay(r.server, { holdAfter: 4 });
  const killed = reopen(r, dying.request);
  void pushFile(killed, path).catch(() => undefined);
  const atRisk = await quiet(dying, () => dying.started > 4);
  const landed = new Set(r.server.chunks.keys());
  assert.equal(landed.size, 4, "the four uploads the relay let through landed");
  assert.ok(dying.puts.length > 4, "and more were in flight when it died");

  // Reopened: a fresh transport, the same server, the same vault.
  const reading = relay(r.server);
  const restarted = reopen(r, reading.request);
  await pushFile(restarted, path);

  const wasted = atRisk - [...landed].reduce((total, sid) => total + r.server.chunks.get(sid).length, 0);
  const again = reading.puts.filter((put) => landed.has(put.sid));
  assert.deepEqual(again, [], "a chunk that landed before the kill is never sent again");
  assert.equal(reading.peakPerSid, 1, "and nothing is sent twice on the way back");
  assert.ok(
    wasted < UPLOAD_BUDGET_BYTES,
    `V7 allows fewer than ${UPLOAD_BUDGET_BYTES} duplicated bytes; the kill wasted ${wasted}`,
  );
  // The assertion is reachable: four chunks in flight at once would have
  // exceeded the budget, which is exactly what issue #56 measured.
  const widest = Math.max(...dying.puts.map((put) => put.bytes));
  assert.ok(widest * 4 > UPLOAD_BUDGET_BYTES, `four of these bodies exceed the budget (${widest})`);
  assert.equal(r.state.fileByPath(path) !== undefined, true, "and the file finished");
});

test("the bytes in flight stay inside the budget a kill would waste", async () => {
  const r = await rig();
  const path = "Archive/wide.bin";
  r.host.seed(path, noise(28 << 20), 1000);
  const w = relay(r.server);
  await pushFile(reopen(r, w.request), path);

  assert.ok(w.puts.length >= 4, `the fixture is many chunks (${w.puts.length})`);
  assert.ok(w.peakInflight > 0, "the measurement saw the wire busy");
  assert.ok(
    w.peakInflight <= UPLOAD_INFLIGHT_MAX,
    `${w.peakInflight} bytes were in flight at once, ceiling ${UPLOAD_INFLIGHT_MAX}`,
  );
  const widest = Math.max(...w.puts.map((put) => put.bytes));
  assert.ok(widest * 4 > UPLOAD_INFLIGHT_MAX, "and four at once would have broken it");
});

test("a chunk in flight is never uploaded twice concurrently", async () => {
  const r = await rig();
  const shared = noise(2 << 20);
  r.host.seed("A/twin.bin", shared, 1000);
  r.host.seed("B/twin.bin", shared, 1000);

  // Hold the first upload until BOTH pushes have asked what is missing, so
  // both believe they must send the chunk: the race the dedupe answers.
  let open = () => undefined;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const w = relay(r.server, { verdict: () => "ok", before: () => undefined });
  const held = w.request;
  w.request = async (request) => {
    if (request.method === "PUT") await gate;
    return held(request);
  };
  const context = reopen(r, w.request);
  const both = Promise.all([pushFile(context, "A/twin.bin"), pushFile(context, "B/twin.bin")]);
  for (let i = 0; i < 40 && w.exists.length < 2; i++) await turn();
  assert.equal(w.exists.length, 2, "both pushes asked the server what it was missing");
  await turn();
  await turn();
  open();
  await both;

  assert.equal(w.puts.length, 1, `one body for one sid: ${JSON.stringify(w.puts)}`);
  assert.equal(w.peakPerSid, 1, "and never two copies of it at once");
  assert.equal(context.transport.uploadStats().deduped, 1, "the second caller awaited the first");
  assert.equal(r.server.chunks.size, 1);
  for (const path of ["A/twin.bin", "B/twin.bin"]) {
    assert.ok(r.state.fileByPath(path), `${path} still finished`);
  }
});

test("a lost answer asks whether the body landed instead of re-sending it", async () => {
  const r = await rig();
  const path = "Archive/flaky.bin";
  r.host.seed(path, noise(20 << 20), 1000);
  // Half the uploads lose their answer after the server stored the body.
  let seen = 0;
  const w = relay(r.server, { verdict: (sid, attempt) => (attempt === 1 && seen++ % 2 === 0 ? "lost" : "ok") });
  const context = reopen(r, w.request);
  await pushFile(context, path);

  assert.ok(w.failed.length >= 2, `half the uploads lost their answer (${w.failed.length})`);
  for (const lost of w.failed) {
    assert.ok(
      w.exists.some((sids) => sids.length === 1 && sids[0] === lost.sid),
      "each one was asked about before anything was re-sent",
    );
  }
  assert.deepEqual(w.puts.filter((put) => put.attempt > 1), [], "and no body was sent a second time");
  const bodies = new Map(w.puts.map((put) => [put.sid, put.bytes]));
  const once = [...bodies.values()].reduce((total, bytes) => total + bytes, 0);
  assert.equal(w.sent, once, "every chunk crossed the wire exactly once");
  assert.equal(context.transport.uploadStats().resent, 0, "so nothing was re-sent");
  assert.match(summaries(r).at(-1), /^upload decision=summary chunks=\d+ retried=0 budget=8388608 deduped=0 duration_ms=\d+$/);
  assert.equal(r.server.chunks.size, bodies.size, "and the server holds the whole file");
});

test("a body that never arrived is re-sent, counted, and named against the budget", async () => {
  const r = await rig();
  const path = "Archive/dropped.bin";
  r.host.seed(path, noise(20 << 20), 1000);
  let seen = 0;
  const w = relay(r.server, { verdict: (sid, attempt) => (attempt === 1 && seen++ % 2 === 0 ? "dropped" : "ok") });
  const context = reopen(r, w.request);
  await pushFile(context, path);

  const wasted = w.puts
    .filter((put) => put.attempt === 1 && w.puts.some((other) => other.sid === put.sid && other.attempt === 2))
    .reduce((total, put) => total + put.bytes, 0);
  assert.ok(wasted > 0, "the dropped bodies were really dropped");
  assert.equal(context.transport.uploadStats().resent, wasted, "and the client counts what it re-sent");
  assert.match(
    summaries(r).at(-1),
    new RegExp(`^upload decision=summary chunks=\\d+ retried=${wasted} budget=${UPLOAD_BUDGET_BYTES} deduped=0 duration_ms=\\d+$`),
  );
});

test("a version refused for missing chunks re-uploads only what the server lacks", async () => {
  const r = await rig();
  const path = "Archive/collected.bin";
  r.host.seed(path, noise(20 << 20), 1000);
  await pushFile(r.context, path);
  const stored = [...r.server.chunks.keys()];
  assert.ok(stored.length >= 3, `the fixture is many chunks (${stored.length})`);

  // The server garbage-collects one chunk between the exists check and the
  // version post, which is the only thing that produces `409 missing_chunks`.
  let collected = null;
  const w = relay(r.server, {
    before: (request, target) => {
      if (request.method === "POST" && target.endsWith("/versions") && collected === null) {
        collected = stored[1];
        r.server.chunks.delete(collected);
      }
    },
  });
  const context = reopen(r, w.request);
  await pushFile(context, path, true);

  assert.ok(collected, "the post raced a collection");
  assert.deepEqual(
    w.puts.map((put) => put.sid),
    [collected],
    "exactly the collected chunk was re-uploaded, not the plan",
  );
  assert.equal(w.sent, r.server.chunks.get(collected).length);
  assert.ok(
    r.host.logs.some((line) => line.startsWith(`push decision=retry reason=missing_chunks`) && line.includes(`chunks=1 of=${stored.length}`)),
    `the retry says how much it re-sent: ${r.host.logs.filter((line) => line.includes("missing_chunks")).join(" | ")}`,
  );
});

test("a one-chunk run that re-sent nothing has no summary to log", async () => {
  const r = await rig();
  r.host.seed("Notes/small.md", "UPLOAD BUDGET SENTINEL", 1000);
  await pushFile(r.context, "Notes/small.md");
  assert.deepEqual(summaries(r), [], `one chunk, nothing re-sent: ${r.host.logs.join(" | ")}`);
  assert.ok(r.host.logs.some((line) => line.includes("decision=pushed")), "the push line still says what it did");
});
