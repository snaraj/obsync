/**
 * A PLUGIN SESSION THAT ENDED SENDS NOTHING MORE AND SAYS SO ONCE (issue #272).
 *
 * Disabling and enabling obsync, or any reload, starts a new session while the
 * old one's requests may still be asleep in their backoff: the server could
 * not be reached, and a background call waits up to a minute between its
 * eight attempts. The plugin's request function refuses every request of a
 * session that is no longer current (`main.ts`). That refusal was read as a
 * network failure, so an old request kept waking, being refused and retrying
 * for up to two minutes, and its last lines -- `gave_up`, then the stopped
 * engine's `push ... decision=failed` and `deferred reason=stopped` -- landed
 * in the console long after the new session had sent the same change.
 *
 * Here the transport is built as the plugin builds it: its request refuses
 * with `SessionEnded` once the session is over, and its backoff sleeps on the
 * virtual clock, so a request really is asleep when the session ends.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { STEP_MS, pair, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport, SessionEnded } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { HistoryOperation } = require("../build/sync/history.js");

/** One plugin session of `device`: its own transport and engine, over the device's vault and state. */
function session(device, server, timers) {
  const s = { current: true, down: false, calls: 0 };
  const credential = device.transport.options.device;
  s.transport = new Transport({
    request: (request) => {
      s.calls++;
      if (!s.current) throw new SessionEnded();
      if (s.down) throw new Error("fake network: connection refused");
      return server.request(request);
    },
    serverUrl: () => device.state.data.serverUrl,
    device: credential,
    edgeHeaders: () => [],
    now: () => device.host.clock,
    sleep: (ms) => new Promise((resolve) => timers.set(resolve, ms)),
    log: (line) => device.host.logs.push(line),
  });
  s.engine = new SyncEngine({ state: device.state, transport: s.transport, host: device.host, now: () => device.host.clock, timers });
  device.plugin.engine = s.engine;
  return s;
}

const ENDED = /^http (GET|POST|PUT) \S+ decision=ended reason=session_inactive$/;

const CANCELLED = /^http (GET|POST|PUT) \S+ decision=cancelled phase=\w+ attempts=\d+ duration_ms=\d+$/;

test("a reload while requests wait out their backoff: each old request ends at its next attempt, one line, and the old session says nothing else", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false });
  a.engine.stop();
  const old = session(a, server, timers);
  t.after(() => old.engine.stop());
  a.host.write("Notes/One.md", "ONE SENTINEL\n", 1000);
  a.host.makeFolder("Empty");
  await old.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Notes/One.md") && b.state.folderByPath("Empty") !== undefined);

  // The server cannot be reached: an edit, a folder's removal and a new
  // folder's record each wait in their backoff.
  old.down = true;
  a.host.write("Notes/One.md", "ONE SENTINEL\nedited while the server is down\n", 2000);
  a.host.removeFolder("Empty");
  a.host.makeFolder("Made while down");
  await timers.run(STEP_MS, () => old.transport.sleepers.size >= 3);
  assert.ok(a.host.logs.some((line) => /decision=retry attempt=1 /.test(line)), "nothing was retrying, so this proves nothing");

  // The reload: the plugin's generation moves on, so its request function
  // refuses, and the old engine stops as `onunload` stops it. What the stop's
  // own signal ends says so at the stop, one line each.
  old.current = false;
  old.engine.stop();
  const mark = a.host.logs.length;
  const calls = old.calls;
  await timers.run(1000, () => old.transport.sleepers.size === 0 && a.host.logs.slice(mark).some((line) => ENDED.test(line)));
  // Then twenty minutes more, for anything that would still come.
  await timers.run(30_000);

  const after = a.host.logs.slice(mark);
  const told = `old session's lines after the reload: ${JSON.stringify(after)}`;
  for (const line of after) assert.ok(ENDED.test(line) || CANCELLED.test(line), told);
  const targets = after.map((line) => line.split(" ").slice(0, 3).join(" "));
  assert.equal(new Set(targets).size, targets.length, `a request said it ended twice: ${told}`);
  const ended = after.filter((line) => ENDED.test(line));
  assert.ok(ended.length >= 1, `no request waited without the stop's signal, so this proves nothing: ${told}`);
  // Each of those made exactly one more attempt, refused before anything was sent.
  assert.equal(old.calls - calls, ended.length, told);
});

test("an old session's request ends as SessionEnded, not as unreachable, and reports nothing about the server", async (t) => {
  const { server, a } = await pair(t);
  a.engine.stop();
  const reached = [];
  let current = false;
  const transport = new Transport({
    request: (request) => {
      if (!current) throw new SessionEnded();
      return server.request(request);
    },
    serverUrl: () => a.state.data.serverUrl,
    device: a.transport.options.device,
    edgeHeaders: () => [],
    now: () => a.host.clock,
    sleep: async () => undefined,
    log: (line) => a.host.logs.push(line),
    reachable: (answered) => reached.push(answered),
  });
  const mark = a.host.logs.length;
  // A repeatable route, a route sent once, a chunk upload, and a manual history read.
  await assert.rejects(transport.getFile("aa".repeat(16)), (error) => error instanceof SessionEnded);
  const once = await transport.pairingEnvelope("bb".repeat(16)).catch((error) => error);
  assert.ok(once instanceof SessionEnded, `a once route came back ${JSON.stringify(once)}`);
  await assert.rejects(transport.putChunk("cc".repeat(32), new Uint8Array([1, 2, 3])), (error) => error instanceof SessionEnded);
  await assert.rejects(transport.historyChanges(0, new HistoryOperation()), (error) => error instanceof SessionEnded);
  const lines = a.host.logs.slice(mark);
  assert.equal(lines.length, 4, JSON.stringify(lines));
  for (const line of lines) assert.match(line, ENDED);
  assert.deepEqual(reached, [], "an attempt that never left the device was reported as the server's absence");
});

test("a chunk upload whose session ends in its backoff ends at the landed probe, and is not sent again", async (t) => {
  const { server, a } = await pair(t);
  a.engine.stop();
  const sent = [];
  let current = true;
  const transport = new Transport({
    request: (request) => {
      sent.push(`${request.method} ${request.url.replace(/^https?:\/\/[^/]+/, "")}`);
      if (!current) throw new SessionEnded();
      // The first attempt is lost on the way, and the session ends while it waits.
      current = false;
      throw new Error("fake network: connection reset");
    },
    serverUrl: () => a.state.data.serverUrl,
    device: a.transport.options.device,
    edgeHeaders: () => [],
    now: () => a.host.clock,
    sleep: async () => undefined,
    log: (line) => a.host.logs.push(line),
  });
  const sid = "cc".repeat(32);
  const mark = a.host.logs.length;
  await assert.rejects(transport.putChunk(sid, new Uint8Array([1, 2, 3])), (error) => error instanceof SessionEnded);
  const lines = a.host.logs.slice(mark);
  assert.deepEqual(sent, [`PUT /v1/chunks/${sid}`, "POST /v1/chunks/exists"], "the body was sent again after the session ended");
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.match(lines[0], /^http PUT \/v1\/chunks\/\S+ network=fake network: connection reset decision=retry attempt=1 /);
  assert.equal(lines[1], "http POST /v1/chunks/exists decision=ended reason=session_inactive");
});
