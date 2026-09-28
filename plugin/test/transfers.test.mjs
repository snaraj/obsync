/**
 * A note is never held up by a large transfer (issues #195, #196).
 *
 * The queue's workers, the pipe of its own for a note's small body, the
 * one-pass push of a large file, the lane that downloads a large incoming
 * version beside the feed, the chunk-boundary stop on the feed side, the
 * direct PUT of a note's one small chunk, the start that does not wait for
 * its heartbeat, and the short guard for a note someone is typing in.
 *
 * Times are VIRTUAL, on `FakeTimers`; "a 2 GB upload" is a large file whose
 * chunks the wire holds for as long as the test needs, which is all a 2 GB
 * upload is to the note queued behind it. Fixtures are sentinel text or
 * deterministic noise.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport, SMALL_BODY_MAX, SMALL_INFLIGHT_MAX, UPLOAD_INFLIGHT_MAX } = require("../build/transport.js");
/** A large body two of which do not fit in flight together. */
const HALF = Math.floor(UPLOAD_INFLIGHT_MAX / 2) + 1;
const { SyncEngine, EDITOR_SETTLE_MS, LARGE_APPLY_BYTES, RECHECK_MS } = require("../build/sync/engine.js");
const { pushFile, PUSH_WINDOW_BYTES, PUSH_WINDOW_MOBILE_BYTES, DIRECT_PUT_MAX } = require("../build/sync/push.js");
const { writeVerified } = require("../build/sync/pull.js");
const { CHUNK_CIPHERTEXT_MAX, bytesSource, chunkStream } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise((resolve) => setImmediate(resolve));
/** Real time until `until` holds, for work with no timer in it (hashing, signing). */
async function eventually(until, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  return until();
}

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
 * One engine on one rig, every request passing `route` first: a route that
 * answers a promise holds that request until the promise settles.
 */
async function device({ isMobile = false, route = () => null } = {}) {
  const r = await rig({ isMobile });
  const timers = new FakeTimers();
  const requests = [];
  const transport = new Transport({
    request: async (request) => {
      const target = request.url.replace(/^https?:\/\/[^/]+/, "");
      const bytes = request.body instanceof ArrayBuffer ? request.body.byteLength : (request.body ?? "").length;
      const seen = { method: request.method, target, bytes, done: false };
      requests.push(seen);
      try {
        await route(request.method, target, bytes, request);
        return await r.server.request(request);
      } finally {
        seen.done = true;
      }
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
  return { ...r, timers, transport, engine, statuses, requests, context: { ...r.context, transport } };
}

/** Did `until` hold within the wait's real-time budget? An answer, never a throw. */
const within = (timers, until, step = 10) => timers.run(step, until).then(() => true, () => false);

/** A version of `bytes` in as many chunks as the chunker cuts, published by another device. */
async function publishLarge(r, { fileId, path, bytes, parents = [] }) {
  const chunks = [];
  for await (const plaintext of chunkStream(bytesSource(bytes))) {
    const { cid, sid, ciphertext } = await c.encryptChunk(r.keys.domainKey, plaintext);
    r.server.chunks.set(sid, ciphertext);
    chunks.push({ sid, cid: c.hex(cid), len: plaintext.length });
  }
  const manifest = { v: 1, path, size: bytes.length, mtime: 4000, domain: KEYS.domainId, chunks, sha256: "", deleted: false };
  return r.server.publishManifest({
    fileId, manifest, sids: chunks.map((chunk) => chunk.sid), parents,
    deviceId: "ffffffffffffffffffffffffffffffff", manifestKey: r.keys.manifestKey, bytes: bytes.length,
  });
}

const isChunkRead = (method, target) => (method === "GET" && target.startsWith("/v1/chunks/") && target !== "/v1/chunks/get") ||
  (method === "POST" && target === "/v1/chunks/get");

// --- the push queue and the pipes (#196) ----------------------------------

test("a note is posted within a second while a large upload is stuck on the wire (#196)", async () => {
  const wire = deferred();
  const d = await device({ route: (method, target, bytes) => (method === "PUT" && bytes > SMALL_BODY_MAX ? wire.promise : null) });
  d.host.seed("Video/big.bin", noise(20 << 20), 1000);
  await d.engine.start();
  assert.ok(await within(d.timers, () => d.requests.some((sent) => sent.method === "PUT" && sent.bytes > SMALL_BODY_MAX)), "the large upload is on the wire");

  const edited = d.timers.now;
  d.host.seed("Notes/today.md", "TYPED DURING THE UPLOAD SENTINEL\n", 5000);
  d.engine.changed("Notes/today.md");
  const posted = await within(d.timers, () => d.state.fileByPath("Notes/today.md") !== undefined, 1);
  assert.ok(posted, "the note waited for the large upload");
  const ms = d.timers.now - edited;
  assert.ok(ms <= 1000, `the note took ${ms} ms of virtual time`);
  assert.equal(d.state.fileByPath("Video/big.bin"), undefined, "and the large upload is still in flight");

  wire.resolve();
  assert.ok(await within(d.timers, () => d.state.fileByPath("Video/big.bin") !== undefined), "and then it finishes");
  await d.engine.stopAndWait();
});

test("a barrier waits for the pushes before it to land, goes alone, and holds what is behind it (#196)", async () => {
  const folderPost = deferred();
  let folderId = null;
  const d = await device({
    route: (method, target) => (folderId !== null && method === "POST" && target === `/v1/files/${folderId}/versions` ? folderPost.promise : null),
  });
  folderId = await c.folderFileId(d.keys.manifestKey, "Folder");
  await d.engine.start();
  await d.timers.run(10);
  const readA = deferred();
  const reads = [];
  const read = d.host.read.bind(d.host);
  d.host.read = async (path) => {
    reads.push(path);
    if (path === "A.md") await readA.promise;
    return read(path);
  };
  d.host.seed("A.md", "BEFORE THE BARRIER SENTINEL\n", 5000);
  d.engine.changed("A.md");
  assert.ok(await within(d.timers, () => reads.includes("A.md")), "the first push is in flight");
  d.host.explicitFolders.add("Folder");
  d.engine.folderCreated("Folder", true);
  d.host.seed("B.md", "BEHIND THE BARRIER SENTINEL\n", 5000);
  d.engine.changed("B.md");
  await d.timers.run(100, () => d.timers.now > 3000);
  const folderSent = () => d.requests.some((sent) => sent.target === `/v1/files/${folderId}/versions`);
  assert.equal(folderSent(), false, "the barrier went beside a push queued before it");
  assert.deepEqual(reads, ["A.md"], "a push behind the barrier went first");

  readA.resolve();
  assert.ok(await within(d.timers, () => folderSent()), "the barrier goes once nothing is in flight");
  await d.timers.run(100, () => d.timers.now > 6000);
  assert.deepEqual(reads, ["A.md"], "a push went beside the barrier");

  folderPost.resolve();
  assert.ok(await within(d.timers, () => d.state.fileByPath("B.md") !== undefined));
  const order = d.server.journal.map((frame) => frame.file_id);
  const at = (id) => order.indexOf(id);
  assert.ok(at(d.state.fileByPath("A.md").fileId) < at(folderId), "the push before the barrier landed first");
  assert.ok(at(folderId) < at(d.state.fileByPath("B.md").fileId), "and the push behind it landed after it");
  await d.engine.stopAndWait();
});

test("a note-sized body never queues behind large ones, and the small pipe holds at most its allowance (#196)", async () => {
  const held = [];
  const sent = [];
  const r = await rig();
  const transport = new Transport({
    request: async (request) => {
      const bytes = request.body.byteLength;
      sent.push(bytes);
      await new Promise((resolve) => held.push({ bytes, resolve }));
      return { status: 201, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) };
    },
    serverUrl: () => "https://sync.example.invalid",
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => r.host.clock,
    sleep: async () => undefined,
    log: (line) => r.host.logs.push(line),
  });
  const body = (size, seed) => noise(size, seed);
  const sid = (n) => n.toString(16).padStart(64, "0");
  // Two large bodies: the second waits for room behind the first.
  const large = [transport.putChunk(sid(1), body(HALF, 1)), transport.putChunk(sid(2), body(HALF, 2))];
  assert.ok(await eventually(() => sent.length >= 1));
  await eventually(() => false, 50);
  assert.deepEqual(sent, [HALF], "one large body in flight, one waiting");
  // A note-sized body goes at once, beside them.
  const small = [];
  for (let n = 0; n < 5; n++) small.push(transport.putChunk(sid(10 + n), body(SMALL_BODY_MAX, 10 + n)));
  await eventually(() => sent.length >= 5);
  await eventually(() => false, 50);
  const inSmall = sent.filter((bytes) => bytes <= SMALL_BODY_MAX);
  assert.equal(inSmall.length, SMALL_INFLIGHT_MAX / SMALL_BODY_MAX, `small bodies in flight: ${inSmall.length}`);
  assert.ok(r.host.logs.some((line) => line === `upload decision=waiting lane=small bytes=${SMALL_BODY_MAX} in_flight=${SMALL_INFLIGHT_MAX} budget=${SMALL_INFLIGHT_MAX}`), r.host.logs.join(" | "));
  // Everything lands once answered.
  let settled = false;
  const all = Promise.all([...large, ...small]).then(() => { settled = true; });
  while (!settled) {
    while (held.length > 0) held.shift().resolve();
    await eventually(() => settled || held.length > 0, 1000);
  }
  await all;
});

// --- one pass (#196) -------------------------------------------------------

/**
 * Count what a push reads from the source, and what it holds between
 * encrypting a chunk and the server taking it -- and whether it is WAITING on
 * the wire: between its steps a push always awaits a read, a WebCrypto call,
 * an ask about missing chunks, or the chunks it has sent, so with none of the
 * first three in flight at a turn of the event loop, it is the last.
 */
function instrument(t, context) {
  const seen = { read: 0, reading: 0, asking: 0, crypto: 0, held: 0, peak: 0, putsOpen: 0, postedWithPutOpen: false };
  const count = async (key, work) => {
    seen[key]++;
    try { return await work(); } finally { seen[key]--; }
  };
  seen.waiting = () => seen.reading === 0 && seen.asking === 0 && seen.crypto === 0;
  const subtle = globalThis.crypto.subtle;
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(subtle)).filter((key) => key !== "constructor")) {
    const call = subtle[name].bind(subtle);
    subtle[name] = (...args) => count("crypto", () => call(...args));
    t.after(() => { delete subtle[name]; });
  }
  const source = context.host.source.bind(context.host);
  context.host.source = (path, size) => {
    const inner = source(path, size);
    return { size, read: (offset, length) => count("reading", async () => { const bytes = await inner.read(offset, length); seen.read += bytes.length; return bytes; }) };
  };
  const missing = context.transport.missingChunks.bind(context.transport);
  context.transport.missingChunks = (...args) => count("asking", () => missing(...args));
  const put = context.transport.putChunk.bind(context.transport);
  context.transport.putChunk = async (sid, ciphertext, patience) => {
    seen.held += ciphertext.length;
    seen.peak = Math.max(seen.peak, seen.held);
    seen.putsOpen++;
    try {
      return await put(sid, ciphertext, patience);
    } finally {
      seen.held -= ciphertext.length;
      seen.putsOpen--;
    }
  };
  const post = context.transport.postVersion.bind(context.transport);
  context.transport.postVersion = async (...args) => {
    if (seen.putsOpen > 0) seen.postedWithPutOpen = true;
    return post(...args);
  };
  return seen;
}

test("a large push reads each byte once, holds at most its window, and posts only after every chunk landed (#196)", async (t) => {
  for (const isMobile of [false, true]) {
    const r = await rig({ isMobile });
    const size = (isMobile ? 48 : 64) << 20;
    r.host.seed("Archive/box.bin", noise(size, isMobile ? 7 : 8), 1000);
    const seen = instrument(t, r.context);
    // THE WIRE IS SLOWER THAN THE READ: no chunk body is answered until the
    // push is waiting on the wire, which it is only with its window full or
    // everything sent. Encrypted chunks pile up to exactly what the window
    // lets them. (It was "until it has stopped reading for 30 ms", and on a
    // machine building the Rust stage beside the suite an encryption took
    // longer than that: the chunks were answered early and never piled up.)
    const request = r.context.transport.options.request;
    r.context.transport.options.request = async (sent) => {
      if (sent.method !== "PUT") return request(sent);
      // Asked between turns of the event loop, never inside one: in a
      // microtask a read can have just resolved with its continuation not yet
      // run, and the push would look idle between two of its own steps.
      const deadline = Date.now() + 10_000;
      do await new Promise((resolve) => setTimeout(resolve, 1));
      while (!seen.waiting() && Date.now() < deadline);
      return request(sent);
    };
    const outcome = await pushFile(r.context, "Archive/box.bin");
    assert.equal(outcome.status, "pushed");
    assert.equal(seen.read, size, `${isMobile ? "mobile" : "desktop"}: read ${seen.read} bytes of a ${size}-byte file`);
    const window = isMobile ? PUSH_WINDOW_MOBILE_BYTES : PUSH_WINDOW_BYTES;
    assert.ok(seen.peak <= window + CHUNK_CIPHERTEXT_MAX, `${isMobile ? "mobile" : "desktop"}: ${seen.peak} bytes held, window ${window}`);
    assert.ok(seen.peak > window / 2, `${isMobile ? "mobile" : "desktop"}: the measurement saw chunks pile up (${seen.peak})`);
    assert.equal(seen.postedWithPutOpen, false, "the version was posted beside a chunk still on the wire");
    assert.equal(r.server.files.get(outcome.fileId).versions.length, 1);
  }
});

test("the version is posted only once the last chunk has landed (#196)", async () => {
  const r = await rig();
  const last = deferred();
  let puts = 0;
  const request = r.context.transport.options.request;
  const order = [];
  r.context.transport.options.request = async (sent) => {
    const target = sent.url.replace(/^https?:\/\/[^/]+/, "");
    if (sent.method === "PUT" && ++puts === 1) await last.promise;
    const answer = await request(sent);
    order.push(`${sent.method} ${target.startsWith("/v1/chunks/") ? "chunk" : target.endsWith("/versions") ? "version" : target}`);
    return answer;
  };
  r.host.seed("Archive/held.bin", noise(20 << 20, 3), 1000);
  const pushing = pushFile(r.context, "Archive/held.bin");
  for (let i = 0; i < 400 && !order.includes("PUT chunk"); i++) await turn();
  for (let i = 0; i < 40; i++) await turn();
  assert.equal(order.includes("POST version"), false, `posted while a chunk was held: ${order.join(", ")}`);
  last.resolve();
  const outcome = await pushing;
  assert.equal(outcome.status, "pushed");
  assert.equal(order.at(-1), "POST version", order.join(", "));
  assert.equal(r.server.journal.at(-1).file_id, outcome.fileId);
});

test("a stop that ends chunks on the wire while the next is encrypted leaves no failure unobserved (#157, #196)", async () => {
  const r = await rig();
  const halt = new AbortController();
  const size = 40 << 20;
  r.host.seed("Archive/stopped.bin", noise(size, 19), 1000);
  // Every chunk body waits on the wire; the stop lands while the push reads
  // on past its first window, so the uploads it ends fail while nothing is
  // awaiting them.
  let putting = false;
  const request = r.context.transport.options.request;
  r.context.transport.options.request = async (sent) => {
    if (sent.method === "PUT") { putting = true; await new Promise(() => undefined); }
    return request(sent);
  };
  const source = r.host.source.bind(r.host);
  r.host.source = (path, length) => {
    const inner = source(path, length);
    return { size: length, read: async (offset, count) => { if (putting) halt.abort(); return inner.read(offset, count); } };
  };
  const unobserved = [];
  const record = (reason) => unobserved.push(String(reason));
  process.on("unhandledRejection", record);
  try {
    await assert.rejects(pushFile({ ...r.context, signal: halt.signal }, "Archive/stopped.bin"), (error) => error.code === "cancelled");
    assert.ok(halt.signal.aborted, "the stop landed while chunks were on the wire");
    await eventually(() => false, 100);
  } finally {
    process.off("unhandledRejection", record);
  }
  assert.deepEqual(unobserved, [], "an upload the stop ended failed with nothing to observe it");
});

// --- a note's one small chunk (#195, P11) ---------------------------------

test("a small edit costs two requests to send: the chunk and the version (#195)", async () => {
  const r = await rig();
  r.host.seed("Notes/edit.md", "FIRST DRAFT SENTINEL\n", 1000);
  await pushFile(r.context, "Notes/edit.md");
  for (const [label, text, mtime] of [["an edit", "SECOND DRAFT SENTINEL\n", 2000], ["a note at its largest", "x".repeat(DIRECT_PUT_MAX - 16), 3000]]) {
    r.host.seed("Notes/edit.md", text, mtime);
    const before = r.server.requests.length;
    await pushFile(r.context, "Notes/edit.md");
    const sent = r.server.requests.slice(before).map((request) => `${request.method} ${request.target.replace(/[0-9a-f]{32,}/g, "<id>")}`);
    assert.deepEqual(sent, ["PUT /v1/chunks/<id>", "POST /v1/files/<id>/versions"], `${label}: ${sent.join(", ")}`);
  }
});

test("a chunk above the direct ceiling, and bytes the record already names, are asked about first (#195)", async () => {
  const r = await rig();
  r.host.seed("Notes/wide.md", "y".repeat(DIRECT_PUT_MAX), 1000);
  let before = r.server.requests.length;
  await pushFile(r.context, "Notes/wide.md");
  const kinds = (from) => r.server.requests.slice(from).map((request) => `${request.method} ${request.target.replace(/[0-9a-f]{32,}/g, "<id>")}`);
  assert.deepEqual(kinds(before), ["POST /v1/chunks/exists", "PUT /v1/chunks/<id>", "POST /v1/files/<id>/versions"]);

  // A rename carries the bytes the record already names: asked, and not sent.
  r.host.seed("Notes/small.md", "RENAMED SENTINEL\n", 1000);
  await pushFile(r.context, "Notes/small.md");
  before = r.server.requests.length;
  await pushFile(r.context, "Notes/small.md", true);
  assert.deepEqual(kinds(before), ["POST /v1/chunks/exists", "POST /v1/files/<id>/versions"]);
});

// --- the start does not wait for its heartbeat (#195, P13) ----------------

test("the start's first feed read and its reconcile do not wait for the heartbeat (#195)", async () => {
  const beat = deferred();
  const d = await device({ route: (method, target) => (target === "/v1/devices/heartbeat" ? beat.promise : null) });
  d.host.seed("Notes/first.md", "PUSHED BEFORE THE HEARTBEAT SENTINEL\n", 1000);
  // Not awaited: a start that waited for the heartbeat would never return here.
  const starting = d.engine.start();
  assert.ok(await within(d.timers, () => d.requests.some((sent) => sent.target.startsWith("/v1/changes?") && sent.done)), "the feed waited for the heartbeat");
  assert.ok(await within(d.timers, () => d.state.fileByPath("Notes/first.md") !== undefined), "the reconcile waited for the heartbeat");
  assert.equal(d.requests.find((sent) => sent.target === "/v1/devices/heartbeat")?.done, false, "the heartbeat is still unanswered");
  beat.resolve();
  assert.ok(await within(d.timers, () => d.host.logs.includes("heartbeat decision=reported policy_schema=v1")));
  await starting;
  await d.engine.stopAndWait();
});

// --- the editor's own save (#195, P17) -------------------------------------

/** Virtual milliseconds from a change event to the note's version being recorded. */
async function settleTime(d, path, text, { typing }) {
  if (typing) d.host.inputAt.set(path, d.host.clock);
  else d.host.inputAt.delete(path);
  d.host.seed(path, text, d.host.clock);
  const from = d.timers.now;
  d.engine.changed(path);
  assert.ok(await within(d.timers, () => d.state.fileByPath(path)?.size === text.length, 1));
  return d.timers.now - from;
}

test("a note someone is typing in is sent within 200 ms; any other writer keeps the full guard (#195, #99)", async () => {
  const d = await device();
  await d.engine.start();
  await d.timers.run(10);
  const typed = await settleTime(d, "Notes/typed.md", "TYPED SENTINEL\n", { typing: true });
  assert.ok(typed <= 200, `a typed note took ${typed} ms`);
  assert.ok(d.host.logs.includes(`watch path_class=file decision=settled reason=editor_save budget_ms=${EDITOR_SETTLE_MS}`), d.host.logs.join(" | "));
  const external = await settleTime(d, "Notes/external.md", "WRITTEN BY ANOTHER APP SENTINEL\n", { typing: false });
  assert.ok(external >= 900, `an external write took ${external} ms`);
  // Above one chunk the editor's word is not taken: its size is checked again
  // a recheck later (#99), as any file's is.
  const big = "z".repeat((8 << 20) + 1);
  const large = await settleTime(d, "Notes/huge.md", big, { typing: true });
  assert.ok(large >= EDITOR_SETTLE_MS + RECHECK_MS, `a typed note above one chunk took ${large} ms`);
  await d.engine.stopAndWait();
});

test("a typed note that changes while it is read is still abandoned, never posted torn (#195, #99)", async () => {
  const d = await device();
  await d.engine.start();
  await d.timers.run(10);
  const path = "Notes/racing.md";
  const read = d.host.read.bind(d.host);
  let first = true;
  d.host.read = async (at) => {
    const bytes = await read(at);
    // The editor saves again while the push reads.
    if (at === path && first) { first = false; d.host.seed(path, "SECOND SAVE SENTINEL, LONGER\n", d.host.clock + 1); }
    return bytes;
  };
  d.host.inputAt.set(path, d.host.clock);
  d.host.seed(path, "FIRST SAVE SENTINEL\n", d.host.clock);
  d.engine.changed(path);
  assert.ok(await within(d.timers, () => d.state.fileByPath(path)?.size === "SECOND SAVE SENTINEL, LONGER\n".length));
  assert.ok(d.host.logs.some((line) => line.startsWith("push path_class=file decision=abandoned reason=changed_during_read")), d.host.logs.join(" | "));
  const posted = d.server.journal.filter((frame) => frame.file_id === d.state.fileByPath(path).fileId);
  assert.equal(posted.length, 1, "only the finished save was posted");
  await d.engine.stopAndWait();
});

// --- the feed side: stop at a chunk, large downloads beside the feed (#196) -

test("a stop during a feed download ends at the next chunk, and its fetch in flight at once (#196)", async () => {
  const release = deferred();
  let hold = false;
  const d = await device({ route: (method, target) => (hold && isChunkRead(method, target) ? release.promise : null) });
  const written = [];
  const writer = d.host.writer.bind(d.host);
  d.host.writer = async (path) => {
    const inner = await writer(path);
    return { ...inner, write: async (bytes) => { written.push(bytes.length); if (written.length === 1) d.engine.stop(); await inner.write(bytes); } };
  };
  await d.engine.start();
  await d.timers.run(10);
  // Below the lane's threshold, so the feed downloads it itself, in batches of more than one chunk.
  const bytes = noise(24 << 20, 5);
  await publishLarge(d, { fileId: "5b".repeat(16), path: "Media/clip.bin", bytes });
  assert.ok(await within(d.timers, () => written.length > 0 && !d.engine.started));
  await d.engine.stopAndWait();
  assert.deepEqual(written.length, 1, `chunks written after the stop: ${written.length - 1}`);
  assert.equal(d.host.files.has("Media/clip.bin"), false, "nothing was committed");

  // And a fetch in flight ends with the stop, without its answer.
  const again = await device({ route: (method, target) => (hold && isChunkRead(method, target) ? release.promise : null) });
  await again.engine.start();
  await again.timers.run(10);
  hold = true;
  await publishLarge(again, { fileId: "5c".repeat(16), path: "Media/other.bin", bytes });
  assert.ok(await within(again.timers, () => again.requests.some((sent) => isChunkRead(sent.method, sent.target))));
  const stopping = again.engine.stopAndWait();
  let done = false;
  void stopping.then(() => { done = true; });
  assert.ok(await within(again.timers, () => done), "the stop waited for a chunk fetch nobody answered");
  release.resolve();
});

test("a write a version was already posted for is not a stop's to end (#196)", async () => {
  const r = await rig();
  const halt = new AbortController();
  halt.abort();
  const bytes = noise(12 << 20, 6);
  const frame = await publishLarge(r, { fileId: "5d".repeat(16), path: "Media/posted.bin", bytes });
  const { decryptRecordManifest } = require("../build/sync/pull.js");
  const manifest = await decryptRecordManifest(r.context, frame);
  const context = { ...r.context, signal: halt.signal };
  const parts = [];
  const writer = { write: async (part) => { parts.push(part.length); }, commit: async () => null, abort: async () => undefined };
  await writeVerified(context, manifest, writer, undefined, null);
  assert.equal(parts.reduce((total, length) => total + length, 0), bytes.length, "every chunk written");
  await assert.rejects(writeVerified(context, manifest, writer), (error) => error.code === "cancelled");
});

test("a note behind a large incoming version is applied before that download completes, and the status says syncing (#196)", async () => {
  const release = deferred();
  let bigSids = new Set();
  let fetched = 0;
  const d = await device({
    route: (method, target, _bytes, request) => {
      if (!isChunkRead(method, target)) return null;
      const asked = target === "/v1/chunks/get" ? JSON.parse(request.body).sids : [target.slice("/v1/chunks/".length)];
      fetched += asked.filter((sid) => bigSids.has(sid)).length;
      return asked.some((sid) => bigSids.has(sid)) ? release.promise : null;
    },
  });
  await d.engine.start();
  await d.timers.run(10);
  const bytes = noise(LARGE_APPLY_BYTES + (2 << 20), 9);
  const frame = await publishLarge(d, { fileId: "5e".repeat(16), path: "Media/film.bin", bytes });
  bigSids = new Set(frame.sids);
  await d.server.publish({ fileId: "5f".repeat(16), path: "Notes/after.md", bytes: enc("ARRIVED AFTER THE FILM SENTINEL\n"), mtime: 4000, domainKey: d.keys.domainKey, manifestKey: d.keys.manifestKey });

  assert.ok(await within(d.timers, () => d.state.fileByPath("Notes/after.md") !== undefined), "the note waited for the download");
  assert.equal(d.host.files.has("Media/film.bin"), false, "the download is still in flight");
  assert.ok(d.host.logs.some((line) => line.startsWith(`feed decision=backgrounded reason=large bytes=${bytes.length} budget=${LARGE_APPLY_BYTES}`)), d.host.logs.join(" | "));
  assert.equal(d.engine.current().kind, "syncing", "and the status says so");
  assert.equal(d.engine.current().held, undefined, "a download is not named as waiting for unsaved changes (#252)");
  assert.equal(d.state.data.parked["5e".repeat(16)]?.reason, "downloading");

  release.resolve();
  assert.ok(await within(d.timers, () => d.state.fileByPath("Media/film.bin") !== undefined));
  assert.deepEqual(d.host.files.get("Media/film.bin").bytes, bytes);
  assert.equal(fetched, frame.sids.length, "the apply took what the lane fetched, and fetched nothing again");
  assert.equal(d.state.fileByPath("Media/film.bin").versionId, frame.version_id);
  assert.deepEqual(d.state.data.parked, {});
  assert.ok(await within(d.timers, () => d.engine.current().kind === "idle"));
  await d.engine.stopAndWait();
});

test("a version at the lane's threshold is applied in turn by the feed, not in the background (#196)", async () => {
  const d = await device();
  await d.engine.start();
  await d.timers.run(10);
  const bytes = noise(LARGE_APPLY_BYTES, 10);
  await publishLarge(d, { fileId: "60".repeat(16), path: "Media/edge.bin", bytes });
  assert.ok(await within(d.timers, () => d.host.files.has("Media/edge.bin")));
  assert.equal(d.host.logs.some((line) => line.startsWith("feed decision=backgrounded")), false, d.host.logs.join(" | "));
  await d.engine.stopAndWait();
});

test("a later version the feed applies settles a download in the lane: the older one is never written (#196)", async () => {
  const release = deferred();
  let v1 = new Set();
  const d = await device({
    route: (method, target, _bytes, request) => {
      if (!isChunkRead(method, target)) return null;
      const asked = target === "/v1/chunks/get" ? JSON.parse(request.body).sids : [target.slice("/v1/chunks/".length)];
      return asked.some((sid) => v1.has(sid)) ? release.promise : null;
    },
  });
  const committed = [];
  const writer = d.host.writer.bind(d.host);
  d.host.writer = async (path) => {
    const inner = await writer(path);
    let size = 0;
    return { ...inner, write: async (part) => { size += part.length; await inner.write(part); }, commit: async (mtime) => { committed.push(size); return inner.commit(mtime); } };
  };
  await d.engine.start();
  await d.timers.run(10);
  const fileId = "61".repeat(16);
  const first = noise(LARGE_APPLY_BYTES + (1 << 20), 11);
  const one = await publishLarge(d, { fileId, path: "Media/doc.bin", bytes: first });
  v1 = new Set(one.sids);
  assert.ok(await within(d.timers, () => d.requests.some((sent) => isChunkRead(sent.method, sent.target))), "the first version is downloading");
  // A newer version, small, lands while the first streams.
  await d.server.publish({ fileId, path: "Media/doc.bin", bytes: enc("THE NEWER VERSION SENTINEL\n"), mtime: 5000, domainKey: d.keys.domainKey, manifestKey: d.keys.manifestKey, parents: [one.version_id] });
  assert.ok(await within(d.timers, () => d.state.data.lastSeq >= d.server.seq), "the feed moved past both");
  release.resolve();
  assert.ok(await within(d.timers, () => d.state.fileByPath("Media/doc.bin")?.versionId === d.server.files.get(fileId).heads[0]));
  assert.equal(d.host.text("Media/doc.bin"), "THE NEWER VERSION SENTINEL\n");
  assert.deepEqual(committed, [enc("THE NEWER VERSION SENTINEL\n").length], "the older version was written at the name");
  await d.engine.stopAndWait();
});

test("the lane applies under the pull lock: a page waits for the apply in hand (#196)", async () => {
  // The lane's first read of the heads goes; its second, under the lock, is held.
  const fileId = "62".repeat(16);
  const held = deferred();
  let reads = 0;
  const d = await device({ route: (method, target) => (method === "GET" && target === `/v1/files/${fileId}` && ++reads >= 2 ? held.promise : null) });
  await d.engine.start();
  await d.timers.run(10);
  const bytes = noise(LARGE_APPLY_BYTES + (1 << 20), 12);
  await publishLarge(d, { fileId, path: "Media/locked.bin", bytes });
  assert.ok(await within(d.timers, () => reads >= 2), "the lane reached its apply");
  await d.server.publish({ fileId: "63".repeat(16), path: "Notes/waiting.md", bytes: enc("WAITS FOR THE LOCK SENTINEL\n"), mtime: 4000, domainKey: d.keys.domainKey, manifestKey: d.keys.manifestKey });
  await d.timers.run(10);
  assert.equal(d.state.fileByPath("Notes/waiting.md"), undefined, "a page applied beside the lane's apply");
  held.resolve();
  assert.ok(await within(d.timers, () => d.state.fileByPath("Notes/waiting.md") !== undefined && d.host.files.has("Media/locked.bin")));
  await d.engine.stopAndWait();
});

test("a large download a stop cut short resumes at the next start, as any parked record does (#196)", async () => {
  const release = deferred();
  let hold = true;
  const d = await device({ route: (method, target) => (hold && isChunkRead(method, target) ? release.promise : null) });
  await d.engine.start();
  await d.timers.run(10);
  const bytes = noise(LARGE_APPLY_BYTES + (1 << 20), 13);
  await publishLarge(d, { fileId: "64".repeat(16), path: "Media/resumed.bin", bytes });
  assert.ok(await within(d.timers, () => d.state.data.parked["64".repeat(16)]?.reason === "downloading" && d.requests.some((sent) => isChunkRead(sent.method, sent.target))));
  await d.engine.stopAndWait();
  assert.equal(d.host.files.has("Media/resumed.bin"), false);
  assert.equal(d.saved().parked["64".repeat(16)].reason, "downloading", "the record is kept for the next start");
  hold = false;
  release.resolve();
  const next = new SyncEngine({ state: await d.reload(), host: d.host, transport: d.transport, timers: d.timers, now: () => d.timers.now });
  await next.start();
  assert.ok(await within(d.timers, () => d.host.files.has("Media/resumed.bin")));
  assert.deepEqual(d.host.files.get("Media/resumed.bin").bytes, bytes);
  await next.stopAndWait();
});

test("the lane reads the file's heads again under the lock: a newer large version is fetched in its turn, the older never written (#196)", async () => {
  const release = deferred();
  let v1 = new Set();
  const d = await device({
    route: (method, target, _bytes, request) => {
      if (!isChunkRead(method, target)) return null;
      const asked = target === "/v1/chunks/get" ? JSON.parse(request.body).sids : [target.slice("/v1/chunks/".length)];
      return asked.some((sid) => v1.has(sid)) ? release.promise : null;
    },
  });
  const committed = [];
  const writer = d.host.writer.bind(d.host);
  d.host.writer = async (path) => {
    const inner = await writer(path);
    let size = 0;
    return { ...inner, write: async (part) => { size += part.length; await inner.write(part); }, commit: async (mtime) => { committed.push(size); return inner.commit(mtime); } };
  };
  await d.engine.start();
  await d.timers.run(10);
  const fileId = "65".repeat(16);
  const one = await publishLarge(d, { fileId, path: "Media/cut.bin", bytes: noise(LARGE_APPLY_BYTES + (1 << 20), 14) });
  v1 = new Set(one.sids);
  assert.ok(await within(d.timers, () => d.requests.some((sent) => isChunkRead(sent.method, sent.target))), "the first version is downloading");
  const second = noise(LARGE_APPLY_BYTES + (3 << 20), 15);
  const two = await publishLarge(d, { fileId, path: "Media/cut.bin", bytes: second, parents: [one.version_id] });
  assert.ok(await within(d.timers, () => d.state.data.lastSeq >= d.server.seq), "the feed moved past both");
  release.resolve();
  assert.ok(await within(d.timers, () => d.state.fileByPath("Media/cut.bin")?.versionId === two.version_id));
  assert.deepEqual(d.host.files.get("Media/cut.bin").bytes, second);
  assert.deepEqual(committed, [second.length], "the older version was written at the name");
  assert.deepEqual(d.state.data.parked, {});
  await d.engine.stopAndWait();
});

test("a large file renamed on another device is moved here, not downloaded again (#196)", async () => {
  let reads = 0;
  const d = await device({ route: (method, target) => { if (isChunkRead(method, target)) reads++; return null; } });
  await d.engine.start();
  await d.timers.run(10);
  const fileId = "66".repeat(16);
  const bytes = noise(LARGE_APPLY_BYTES + (1 << 20), 16);
  const one = await publishLarge(d, { fileId, path: "Media/before.bin", bytes });
  assert.ok(await within(d.timers, () => d.state.fileByPath("Media/before.bin") !== undefined));
  const fetched = reads;
  await publishLarge(d, { fileId, path: "Media/after.bin", bytes, parents: [one.version_id] });
  assert.ok(await within(d.timers, () => d.state.fileByPath("Media/after.bin") !== undefined));
  assert.equal(reads, fetched, "the rename fetched chunks");
  assert.equal(d.host.logs.filter((line) => line.startsWith("feed decision=backgrounded")).length, 1, d.host.logs.join(" | "));
  await d.engine.stopAndWait();
});

test("the lane fetches nothing the apply will not write: above this device's ceiling, or inside a vault of its own (#196, #161, #180)", async () => {
  let reads = 0;
  const d = await device({ route: (method, target) => { if (isChunkRead(method, target)) reads++; return null; } });
  d.state.data.policy = { perFileMaxBytes: LARGE_APPLY_BYTES, totalBudgetBytes: 0 };
  d.host.inNestedVault = async (path) => path.startsWith("Nested/");
  await d.engine.start();
  await d.timers.run(10);
  await publishLarge(d, { fileId: "67".repeat(16), path: "Media/ceiling.bin", bytes: noise(LARGE_APPLY_BYTES + (1 << 20), 17) });
  assert.ok(await within(d.timers, () => d.state.data.remoteOnly["67".repeat(16)] !== undefined), "listed remote-only");
  d.state.data.policy = { perFileMaxBytes: 0, totalBudgetBytes: 0 };
  await publishLarge(d, { fileId: "68".repeat(16), path: "Nested/inner.bin", bytes: noise(LARGE_APPLY_BYTES + (1 << 20), 18) });
  assert.ok(await within(d.timers, () => d.host.logs.some((line) => line.includes("reason=nested_vault") && line.includes("68".repeat(16)))));
  await d.timers.run(10, () => Object.keys(d.state.data.parked).length === 0);
  assert.equal(reads, 0, "chunks were fetched for a version nothing writes");
  await d.engine.stopAndWait();
});
