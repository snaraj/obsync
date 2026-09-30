/**
 * Sync now, made cheap, and Verify all files, which keeps the full check
 * (issue #197).
 *
 * Sync now read and encrypted every file in the vault to conclude that almost
 * none had changed: minutes on a large vault, and on a phone 512 MiB files
 * read whole. It now sends what is queued, reads the feed once without
 * waiting, retries parked and paused files, and runs the reconcile pass
 * reading again only files of at most one chunk -- where a plugin's rewrite
 * can keep a note's size and date (#179). "Verify all files" reads every
 * file, however large.
 *
 * PLATFORM. Engine code, identical on desktop and mobile: the fake host
 * stands for both.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine, SYNC_NOW_FEED_MS, SYNC_NOW_VERIFY_MAX } = require("../build/sync/engine.js");
const { CHUNK_MAX } = require("../build/chunker.js");

const OTHER = "ffffffffffffffffffffffffffffffff";

/** The feed's long poll never answers, as a server with nothing to report holds it; `wait=0` does. */
function heldFeed(r) {
  const real = r.transport.options.request;
  const reads = [];
  r.transport.options.request = async (request) => {
    if (request.url.includes("/v1/changes?")) {
      reads.push(request.url);
      if (request.url.includes("wait=55")) return new Promise(() => {});
    }
    return real(request);
  };
  return reads;
}

async function started(r, timers, until = () => true) {
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers });
  await engine.start();
  await timers.run(1000, until);
  return engine;
}

/** The same bytes, one of them changed, under the recorded size AND modified time. */
function rewriteInPlace(host, path) {
  const held = host.files.get(path);
  const bytes = held.bytes.slice();
  bytes[bytes.length - 1] ^= 0xff;
  host.files.set(path, { bytes, mtime: held.mtime });
}

const versionsOf = (r, path) => r.server.journal.filter((frame) => frame.file_id === r.state.fileByPath(path)?.fileId).length;

test("the ceiling is one chunk, where a plugin's same-size rewrite lives (#179)", () => {
  assert.equal(SYNC_NOW_VERIFY_MAX, CHUNK_MAX);
  assert.equal(CHUNK_MAX, 8 * 1024 * 1024, "the documented 8 MiB");
});

test("Sync now reads a same-size, same-date rewrite of a file of exactly 8 MiB and not of a larger one; Verify all files reads both", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const at = new Uint8Array(CHUNK_MAX).fill(0x41);
  const over = new Uint8Array(CHUNK_MAX + 1).fill(0x42);
  r.host.seed("Files/at.bin", at, 1000);
  r.host.seed("Files/over.bin", over, 2000);
  const engine = await started(r, timers, () => r.state.fileByPath("Files/at.bin") !== undefined && r.state.fileByPath("Files/over.bin") !== undefined);
  // NOTHING LEFT TO SEND, SO ONLY A PRESS READS THEM AGAIN (issue #277): the
  // queue, its pushes and every debounce drained. A quiet spell of real time
  // was the wait; on a loaded machine a pass's second push of these 16 MiB was
  // still reading when the rewrite below landed, and sent it before the press.
  await timers.run(1000, () => engine.queue.length === 0 && engine.pushing.size === 0 && !engine.draining && engine.pending.size === 0);
  rewriteInPlace(r.host, "Files/at.bin");
  rewriteInPlace(r.host, "Files/over.bin");
  const before = { at: versionsOf(r, "Files/at.bin"), over: versionsOf(r, "Files/over.bin") };

  const sent = await engine.syncNow();

  assert.equal(sent, 1, "Sync now sent the rewrite it read");
  assert.equal(versionsOf(r, "Files/at.bin"), before.at + 1, "a file of exactly the ceiling is read again");
  assert.equal(versionsOf(r, "Files/over.bin"), before.over, "a file above it is judged by its size and date");
  assert.ok(
    r.host.logs.includes(`reconcile decision=verify files=1 over_ceiling=1 ceiling_bytes=${CHUNK_MAX}`),
    r.host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );

  const verified = await engine.verifyAll();

  assert.deepEqual(verified, { checked: 2, sent: 1 }, "every file read, and the one that had changed sent");
  assert.equal(versionsOf(r, "Files/over.bin"), before.over + 1, "Verify all files reads a file of any size");
  assert.ok(r.host.logs.includes("reconcile decision=verify files=2 over_ceiling=0 ceiling_bytes=none"));
  assert.ok(r.host.logs.some((line) => line.startsWith("verify_all decision=drained queued=0 in_flight=0 follow_up=0 examined=2 ")));
  engine.stop();
});

test("Sync now sends what is queued, then reads the feed at once, then retries, then runs the pass", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const reads = heldFeed(r);
  r.host.seed("Notes/queued.md", "QUEUED SENTINEL\n", 1000);
  const engine = await started(r, timers, () => r.state.fileByPath("Notes/queued.md") !== undefined);
  // Idle, with the long poll open and answering nothing.
  await timers.run(1000, () => reads.some((url) => url.includes("wait=55")));

  // Something on the server this device has not read: the poll holds it back.
  await r.server.publish({
    fileId: "5a".repeat(16), path: "Notes/remote.md", bytes: new TextEncoder().encode("REMOTE SENTINEL\n"),
    mtime: 1500, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER,
  });
  // A parked record, waiting on an editor that is still typing.
  r.state.data.parked["6b".repeat(16)] = { path: "Notes/typing.md", reason: "active_editor" };
  r.host.inputAt.set("Notes/typing.md", r.host.clock);
  // And an edit in the queue whose push has not finished.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = r.host.read.bind(r.host);
  r.host.read = async (path) => {
    if (path === "Notes/queued.md") await gate;
    return read(path);
  };
  r.host.seed("Notes/queued.md", "QUEUED EDIT SENTINEL\n", 3000);
  engine.changed("Notes/queued.md");
  await timers.run(1000, () => engine.uploads().includes("Notes/queued.md"));

  const events = [];
  const real = r.transport.options.request;
  r.transport.options.request = async (request) => {
    if (request.method === "POST" && /\/versions$/.test(request.url)) events.push("post");
    if (request.url.includes("wait=0")) events.push("read");
    return real(request);
  };
  const log = r.host.log.bind(r.host);
  r.host.log = (line) => {
    if (line.startsWith("feed decision=woken reason=sync_now")) events.push("feed");
    if (line.startsWith("feed decision=retried trigger=sync_now")) events.push(r.host.files.has("Notes/remote.md") ? "retry" : "retry_before_read");
    if (line.startsWith("reconcile decision=start")) events.push("pass");
    log(line);
  };

  const asked = reads.length;
  let done = false;
  const press = engine.syncNow().then(() => { done = true; });
  // Long enough for a press that read the feed first to have done so.
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  release();
  // Bounded: a press that never got its read ends at its budget, and says so below.
  await timers.run(1000, () => done);
  await press;

  assert.deepEqual(events, ["post", "feed", "read", "retry", "pass"], r.host.logs.slice(-12).join(" | "));
  assert.equal(r.host.text("Notes/remote.md"), "REMOTE SENTINEL\n", "what waited on the server landed before the press returned");
  assert.equal(reads.slice(asked).filter((url) => url.includes("wait=0")).length, 1, "ONE read of the feed for the press");
  // Beside the long poll, which stays the one in flight (#288): a poll sent
  // again asks the same url and waits behind it on a desktop.
  assert.equal(reads.slice(asked).filter((url) => url.includes("wait=55")).length, 0, "the press sent no second long poll");
  assert.ok(!r.host.logs.some((line) => line.includes("decision=cancelled")), r.host.logs.slice(-12).join(" | "));
  engine.stop();
});

test("a stop answers a Sync now waiting on the feed, and so do a read that fails and its budget", async () => {
  for (const ending of ["stop", "failure", "budget"]) {
    const r = await rig();
    const timers = new FakeTimers();
    const reads = heldFeed(r);
    const engine = await started(r, timers);
    await timers.run(1000, () => reads.some((url) => url.includes("wait=55")));
    // The quick read the press asks for never comes back on its own.
    const real = r.transport.options.request;
    let asked = null;
    r.transport.options.request = async (request) => {
      if (request.url.includes("wait=0")) {
        if (ending === "failure") throw new Error("fake network: read failed");
        return new Promise((resolve) => { asked = resolve; });
      }
      return real(request);
    };
    let answered = false;
    const pressed = timers.now;
    const press = engine.syncNow().then(() => { answered = true; }, () => { answered = true; });
    if (ending === "stop") {
      await timers.run(1000, () => asked !== null);
      engine.stop();
    }
    if (ending === "budget") {
      await timers.run(1, () => asked !== null);
      timers.now = pressed + SYNC_NOW_FEED_MS - 1;
      await timers.run(0);
      assert.equal(answered, false, "the press waits for its read up to the budget");
      await timers.run(1000, () => answered);
      assert.ok(r.host.logs.includes(`sync_now decision=feed_unanswered budget_ms=${SYNC_NOW_FEED_MS}`));
    }
    for (const deadline = Date.now() + 10_000; !answered && Date.now() < deadline;) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answered, true, `${ending}: the press still waited on the feed`);
    await press;
    engine.stop();
  }
});

test("Sync now drains again for a path queued after its last drain took its last batch (#121)", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  heldFeed(r);
  // The window a join cannot cover, in the press's LAST drain: the pass's
  // own queue has drained, and a rename lands from the idle status it posts.
  let armed = false;
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, timers,
    onStatus: (status) => {
      if (status.kind !== "idle" || !armed) return;
      armed = false;
      r.host.files.set("Moved.md", r.host.files.get("Gone.md"));
      r.host.files.delete("Gone.md");
      engine.renamed("Gone.md", "Moved.md");
    },
  });
  r.host.seed("Gone.md", "renamed while the last drain ran\n", 1000);
  await engine.start();
  await timers.run(1000, () => r.state.fileByPath("Gone.md") !== undefined);
  await timers.run(5000);
  const goneId = r.state.fileByPath("Gone.md").fileId;
  const log = r.host.log.bind(r.host);
  r.host.log = (line) => {
    if (line.startsWith("reconcile decision=verify")) armed = true;
    log(line);
  };
  let movedAtReturn = null;
  const press = engine.syncNow().then(() => {
    movedAtReturn = r.server.journal.filter((frame) => frame.file_id === goneId).length === 2;
  });
  await timers.run(1000, () => movedAtReturn !== null);
  await press;
  assert.equal(armed, false, "the rename really was queued inside that window");
  assert.equal(movedAtReturn, true, "Sync now returned before the path queued behind its last drain was pushed");
  assert.ok(r.host.logs.some((line) => /^sync_now decision=drained .*follow_up=1 /.test(line)), r.host.logs.slice(-6).join(" | "));
  engine.stop();
});

test("a press made before the feed has started is answered by the stop that ends the start", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers });
  // The start's own pass waits on the vault's listing, so no feed loop runs yet.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const list = r.host.list.bind(r.host);
  let listing = false;
  r.host.list = async () => { listing = true; await gate; return list(); };
  const starting = engine.start().catch(() => undefined);
  await timers.run(1, () => listing);
  let answered = false;
  const press = engine.syncNow().then(() => { answered = true; }, () => { answered = true; });
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false, "the press waits for the feed's first read");
  engine.stop();
  release();
  for (const deadline = Date.now() + 10_000; !answered && Date.now() < deadline;) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, true, "a stop answered the press, though no feed loop ever ran");
  await starting;
  await press;
});

test("a read already asking at once is the press's read: the press neither waits on it nor sends a second", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const real = r.transport.options.request;
  let quick = 0;
  // The start's first read asks without waiting, and is never answered.
  r.transport.options.request = async (request) => {
    if (request.url.includes("/v1/changes?") && request.url.includes("wait=0") && !request.url.includes("limit=2")) {
      quick++;
      return new Promise(() => {});
    }
    return real(request);
  };
  const engine = await started(r, timers, () => quick === 1);
  let answered = false;
  const press = engine.syncNow().then(() => { answered = true; });
  for (const deadline = Date.now() + 10_000; !answered && Date.now() < deadline;) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, true, "the press waited on a read it could not make sooner");
  assert.equal(quick, 1, "and sent no second one beside it");
  await press;
  engine.stop();
});

test("a press made while a page is being written asks at once for the next read", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const reads = [];
  const real = r.transport.options.request;
  r.transport.options.request = async (request) => {
    if (request.url.includes("/v1/changes?")) reads.push(request.url);
    return real(request);
  };
  const engine = await started(r, timers);
  await timers.run(1000, () => reads.some((url) => url.includes("wait=55")));
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let entered = false;
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path, size) => {
    if (path === "Notes/slow.md") { entered = true; await gate; }
    return writer(path, size);
  };
  await r.server.publish({
    fileId: "7c".repeat(16), path: "Notes/slow.md", bytes: new TextEncoder().encode("SLOW SENTINEL\n"),
    mtime: 1500, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER,
  });
  // The feed brought it, and is inside its write.
  await timers.run(1000, () => entered);
  const before = reads.length;
  let done = false;
  const press = engine.syncNow().then(() => { done = true; });
  open();
  // THE CLOCK STANDS STILL WHILE THE PRESS RUNS (issue #277): nothing it
  // waits on is a timer, and walking virtual time while a loaded machine
  // wrote the page ran its read's budget out before the read came.
  await timers.run(0, () => done);
  await press;
  assert.match(reads[before] ?? "", /wait=0/, `the read after the page: ${reads.slice(before).join(" ")}`);
  assert.equal(r.host.logs.some((line) => line.startsWith("sync_now decision=feed_unanswered")), false, "and it came in time");
  engine.stop();
});
