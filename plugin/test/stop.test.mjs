/**
 * What a stop does to the work it finds (issues #157, #185).
 *
 * Leave and a folder Save both stop the engine first, and both used to wait
 * for whatever it was doing: a push's whole retry budget against a server
 * that was gone (96 s, S40), the rest of a 1.5 GiB upload (17-20 s, S87), a
 * restart's map read (89 s, S70). A stop now CANCELS: the long poll and every
 * retry asleep in its backoff end at once, an upload ends at its chunk
 * boundary, a download at its next batch, and the stop says nothing about the
 * status until nothing of the engine's is still running.
 *
 * THE CLOCK IS VIRTUAL. The transport sleeps on the fake timers, so a stop
 * that waited a retry out would spend virtual time the assertions measure,
 * and a stop that cancels spends none.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FakeTimers, KEYS, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine } = require("../build/sync/engine.js");
const { pushFile } = require("../build/sync/push.js");
const { applyChange } = require("../build/sync/pull.js");
const { Transport } = require("../build/transport.js");
const { CHUNK_MIN, chunkStream } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const NOTE = "Notes/unsent.md";
const VIDEO = "Attachments/video.bin";
const enc = (text) => new TextEncoder().encode(text);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

/** Deterministic incompressible-looking bytes: a fixture, never a secret. */
function noise(size, seed = 0x1234abcd) {
  const data = new Uint8Array(size);
  let x = seed;
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
 * One paired device whose transport waits on the virtual clock. `refuse`
 * names what gets no answer, the way a server that is gone gives none, and
 * `takes` how long a request spends on the wire.
 */
async function device({ refuse = () => false, takes = () => 0 } = {}) {
  const r = await rig();
  const timers = new FakeTimers();
  const transport = new Transport({
    request: async (request) => {
      const target = request.url.replace(/^https?:\/\/[^/]+/, "");
      if (refuse(request.method, target)) throw new Error("net::ERR_CONNECTION_REFUSED");
      const ms = takes(request.method, target);
      if (ms > 0) await new Promise((resolve) => timers.set(resolve, ms));
      return r.server.request(request);
    },
    serverUrl: () => r.state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => timers.now,
    sleep: (ms) => new Promise((resolve) => timers.set(resolve, ms)),
    random: () => 0,
    log: (line) => r.host.logs.push(line),
  });
  const statuses = [];
  const engine = new SyncEngine({ state: r.state, host: r.host, transport, timers, now: () => timers.now, onStatus: (status) => statuses.push(status) });
  return { ...r, timers, transport, engine, statuses, context: { ...r.context, transport } };
}

/** Virtual milliseconds until `work` settles; its outcome is `work`'s own. */
async function elapsed(timers, work) {
  const started = timers.now;
  let done = false;
  const outcome = work.finally(() => { done = true; });
  // A wait that never ends is the failure these tests exist to catch: say so as one.
  await timers.run(10, () => done).catch((error) => assert.fail(`the work never settled: ${error.message}`));
  await outcome;
  return timers.now - started;
}

const retried = (d, prefix) => d.host.logs.some((line) => line.startsWith(prefix) && line.includes("decision=retry"));

test("a stop ends a push asleep in its retry and the feed's long poll at once, instead of waiting them out (#157)", async () => {
  // S40: offline with unsent edits, Leave waited 96 s for the push to give up.
  const d = await device({ refuse: (_method, target) => target === "/v1/chunks/exists" });
  // Above `DIRECT_PUT_MAX`, so the push asks what the server holds first (#195).
  d.host.seed(NOTE, "UNSENT SENTINEL\n".repeat(70_000), 1000);
  await d.engine.start();
  await d.timers.run(10, () => retried(d, "http POST /v1/chunks/exists") && d.server.feedWaiters.length === 1);
  const before = d.statuses.length;

  const ms = await elapsed(d.timers, d.engine.stopAndWait());

  assert.ok(ms < 2000, `the stop took ${ms} ms of virtual time; the push's budget is a minute`);
  assert.ok(d.host.logs.some((line) => /^http POST \/v1\/chunks\/exists decision=cancelled phase=sleeping/.test(line)), "the retry was ended in its pause");
  assert.ok(d.host.logs.some((line) => /^http GET \/v1\/changes\?\S+ decision=cancelled phase=in_flight/.test(line)), "the long poll was ended, not left open");
  assert.ok(d.host.logs.includes("push path_class=file decision=cancelled reason=engine_stopped"), d.host.logs.join("\n"));
  assert.deepEqual(d.statuses.slice(before), [{ kind: "idle" }], "one word, once nothing runs, and no failure for the work the stop ended");
  assert.equal(d.host.logs.some((line) => /decision=(failed|stopped)\b/.test(line)), false, "nor a line at warn level");
  assert.equal(d.state.fileByPath(NOTE), undefined, "the note is still unsent, and the next start's pass queues it");
});

test("the status never says idle while an upload is still stopping (#185)", async () => {
  // S87: the bar read `idle` for the whole wait while 1.2 GiB was uploading.
  const d = await device();
  const read = d.host.read.bind(d.host);
  const entered = deferred(), held = deferred();
  d.host.read = async (path) => {
    if (path === NOTE) { entered.resolve(); await held.promise; }
    return read(path);
  };
  d.host.seed(NOTE, "UNSENT SENTINEL\n", 1000);
  await d.engine.start();
  await entered.promise;
  // The note and its folder's record, each in a worker of its own (#196).
  assert.deepEqual(d.statuses.at(-1), { kind: "syncing", pending: 2 });
  const before = d.statuses.length;

  let done = false;
  const stopping = d.engine.stopAndWait().then(() => { done = true; });
  await d.timers.run();
  assert.equal(done, false, "a read in progress is not something a stop can cut");
  assert.deepEqual(d.statuses.slice(before), [], "and while it finishes the status stays what it was: never idle");
  held.resolve();
  await stopping;
  assert.deepEqual(d.statuses.slice(before), [{ kind: "idle" }]);
});

for (const shape of ["one chunk", "many chunks"]) test(`a chunk upload asleep in its backoff ends at once when sync stops: ${shape} (#157)`, async () => {
  const d = await device({ refuse: (method) => method === "PUT" });
  const halt = new AbortController();
  d.host.seed(VIDEO, shape === "one chunk" ? enc("ONE CHUNK SENTINEL") : noise(12 << 20), 1000);
  const pushing = pushFile({ ...d.context, signal: halt.signal }, VIDEO);
  await d.timers.run(10, () => retried(d, "http PUT /v1/chunks/"));

  halt.abort();
  const ms = await elapsed(d.timers, pushing.then(
    () => assert.fail("a stopped push published a version"),
    (error) => assert.equal(error.code, "cancelled", String(error)),
  ));

  assert.ok(ms < 1000, `the upload took ${ms} ms of virtual time to stop`);
  assert.equal(d.server.files.size, 1, "no version but the domain map's");
});

test("a resumed upload that is stopped reads no further than its next chunk (#185)", async () => {
  // The second pass reads every chunk again to find the ones still missing;
  // a stop that let it run on re-read and re-encrypted everything the server
  // already held before it noticed.
  const d = await device();
  const bytes = noise(28 << 20);
  d.host.seed(VIDEO, bytes, 1000);
  const sealed = [];
  for await (const part of chunkStream({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) })) {
    sealed.push(await c.encryptChunk(d.keys.domainKey, part));
  }
  assert.ok(sealed.length >= 4, `the fixture is many chunks (${sealed.length})`);
  // Everything but the last chunk landed before a restart: a resumed upload.
  for (const { sid, ciphertext } of sealed.slice(0, -1)) d.server.chunks.set(sid, ciphertext);
  const halt = new AbortController();
  let asked = false;
  const request = d.transport.options.request;
  d.transport.options.request = async (sent) => {
    if (sent.url.endsWith("/v1/chunks/exists")) asked = true;
    return request(sent);
  };
  let after = -1;
  const source = d.host.source.bind(d.host);
  d.host.source = (path, size) => {
    const inner = source(path, size);
    return {
      size,
      read: async (at, length) => {
        // The first read of the second pass is where the stop lands.
        if (asked && !halt.signal.aborted) halt.abort();
        else if (halt.signal.aborted) after++;
        return inner.read(at, length);
      },
    };
  };

  await assert.rejects(pushFile({ ...d.context, signal: halt.signal }, VIDEO), (error) => error.code === "cancelled");

  assert.equal(after, -1, `the stopped push read ${after + 1} more windows of a file the server already held`);
  assert.equal(d.server.files.size, 1, "and posted nothing");
});

test("a stopped engine's download ends at its next batch and leaves nothing behind (#185)", async () => {
  const d = await device();
  // Nine chunks of 1 MiB -- above one chunk's ceiling, so a real chunk list --
  // fetched three to a batch.
  const parts = Array.from({ length: 9 }, (_, index) => noise(CHUNK_MIN, 0x5eed0000 + index));
  const chunks = [];
  for (const part of parts) {
    const { cid, sid, ciphertext } = await c.encryptChunk(d.keys.domainKey, part);
    d.server.chunks.set(sid, ciphertext);
    chunks.push({ sid, cid: c.hex(cid), len: part.length });
  }
  const size = parts.reduce((total, part) => total + part.length, 0);
  const frame = await d.server.publishManifest({
    fileId: "5a".repeat(16),
    manifest: { v: 1, path: VIDEO, size, mtime: 200, domain: KEYS.domainId, chunks, sha256: "", deleted: false },
    sids: chunks.map((chunk) => chunk.sid),
    parents: [],
    deviceId: "ff".repeat(16),
    manifestKey: d.keys.manifestKey,
    bytes: size,
  });
  const halt = new AbortController();
  let batches = 0;
  const getChunks = d.transport.getChunks.bind(d.transport);
  d.transport.getChunks = async (sids, control) => {
    batches++;
    const bodies = await getChunks(sids, control);
    halt.abort();
    return bodies;
  };

  await assert.rejects(applyChange({ ...d.context, signal: halt.signal }, frame), (error) => error.code === "cancelled");

  assert.equal(batches, 1, "the batch in flight finished, and no other was asked for");
  assert.equal(d.host.text(VIDEO), null, "nothing was written at the path");
  assert.deepEqual([...d.host.files.keys()], [], "and nothing was left beside it");
  assert.equal(d.state.fileByPath(VIDEO), undefined);
});

test("a stop ends the repair pass's check asleep in its retry (#157)", async () => {
  // The pass audits every second what the server holds of this device's
  // notes; a server gone mid-audit left that check retrying under a stop.
  let gone = false;
  const d = await device({ refuse: (_method, target) => gone && target === "/v1/chunks/exists" });
  d.host.seed(NOTE, "RECORDED SENTINEL\n", 1000);
  await pushFile(d.context, NOTE);
  gone = true;
  await d.engine.start();
  await d.timers.run(10, () => retried(d, "http POST /v1/chunks/exists"));

  const ms = await elapsed(d.timers, d.engine.stopAndWait());

  assert.ok(ms < 1000, `the stop took ${ms} ms of virtual time`);
  assert.ok(d.host.logs.some((line) => /^http POST \/v1\/chunks\/exists decision=cancelled phase=sleeping/.test(line)));
});

for (const step of ["map read", "device list"]) test(`a restart the stop cuts short in its ${step} ends quietly, at once (#157)`, async () => {
  // S70: the start after a refused Leave retried the map for 89 s, and the
  // refusal waited behind it.
  const d = await device({
    refuse: (method, target) => step === "map read" ? target === `/v1/files/${d.keys.map.fileId}` : target === "/v1/devices",
  });
  const starting = d.engine.start();
  const prefix = step === "map read" ? `http GET /v1/files/${d.keys.map.fileId}` : "http GET /v1/devices";
  await d.timers.run(10, () => retried(d, prefix));

  const ms = await elapsed(d.timers, d.engine.stopAndWait());

  assert.ok(ms < 1000, `the stop took ${ms} ms of virtual time`);
  await assert.doesNotReject(starting, "a start its stop cut short ends quietly");
  assert.equal(d.engine.started, false);
  assert.ok(d.host.logs.some((line) => line.startsWith(prefix) && line.includes("decision=cancelled")));
  // A stop is not a failure, and the line at warn level would say it was.
  assert.equal(d.host.logs.some((line) => /decision=(failed|stopped)\b/.test(line)), false, d.host.logs.join("\n"));
});

test("a folder Save during a large upload is in force within one chunk's time, and the upload resumes from what landed (#185)", async (t) => {
  // S87 run a: Save waited 17.8 s for the rest of a 1.5 GiB upload.
  const CHUNK_TIME = 1000;
  const d = await device({ takes: (method) => (method === "PUT" ? CHUNK_TIME : 0) });
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const instance = new (box.require(join(box.home, "build/main.js")).default)();
  Object.assign(instance, { state: d.state, host: d.host, transport: d.transport, engine: d.engine, log: (line) => d.host.logs.push(line) });
  instance.startEngine = async () => {
    instance.engine = new SyncEngine({ state: d.state, host: d.host, transport: d.transport, timers: d.timers, now: () => d.timers.now });
    await instance.engine.start();
  };
  const puts = [];
  const request = d.transport.options.request;
  d.transport.options.request = async (sent) => {
    if (sent.method === "PUT") puts.push(sent.url.slice(sent.url.lastIndexOf("/") + 1));
    return request(sent);
  };
  d.host.seed(VIDEO, noise(28 << 20), 1000);
  await d.engine.start();
  await d.timers.run(10, () => d.server.chunks.size >= 1 && puts.length > d.server.chunks.size);
  assert.deepEqual(instance.scopeWaitText(), `Stopping the upload of ${VIDEO}…`, "what the Save button says it waits for");
  const landed = new Set(d.server.chunks.keys());
  const sent = puts.length;

  const ms = await elapsed(d.timers, instance.saveSyncFolders(["Attachments"]));

  assert.ok(ms <= CHUNK_TIME, `the selection took ${ms} ms of virtual time to come into force; one chunk takes ${CHUNK_TIME}`);
  assert.deepEqual(d.state.data.syncFolders, ["Attachments"]);
  assert.equal(d.state.data.pendingScope, undefined);
  await d.timers.run(10, () => d.state.fileByPath(VIDEO) !== undefined);
  assert.deepEqual(puts.slice(sent).filter((sid) => landed.has(sid)), [], "no chunk that landed before the Save is sent again");
  await instance.engine.stopAndWait();
});
