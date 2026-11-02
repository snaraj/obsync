/**
 * Force sync (issue #369): Verify all files, then the server's complete
 * listing, every file this device holds at none of its heads handed to the
 * pull path. The device under test has MISSED what it is asked to receive:
 * its cursor is past those versions without having applied them, as a device
 * revoked and paired again, or one whose feed lost them, is. The feed alone
 * would never bring them.
 *
 * PLATFORM. Engine code, identical on desktop and mobile: the fake host
 * stands for both.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, STEP_MS, rig, sandbox, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { FORCE_BUDGET_MS, LARGE_APPLY_BYTES, SyncEngine, REVOKED_DEVICE } = require("../build/sync/engine.js");
const seal2 = require("../build/seal2.js");
const c = require("../build/crypto.js");
const { bytesSource, chunkStream } = require("../build/chunker.js");
const { EditorBusy } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

const OTHER = "ffffffffffffffffffffffffffffffff";
const enc = (text) => new TextEncoder().encode(text);
const fileGet = /\/v1\/files\/([0-9a-f]{32})$/;

async function started(r, timers, until = () => true, now = undefined) {
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers, now });
  await engine.start();
  await timers.run(1000, until);
  return engine;
}

/** Another device's version on the server. */
function publish(r, fileId, path, bytes, parents = [], mtime = 1500) {
  return r.server.publish({
    fileId, path, bytes: typeof bytes === "string" ? enc(bytes) : bytes, mtime, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER,
  });
}

/** This device's cursor moves past everything the server holds, none of it applied: the window it missed. */
function passed(r) {
  r.state.data.lastSeq = r.server.seq;
  r.state.data.feedMark = null;
}

/** Every request this device sends, by URL, from now on. */
function requests(r) {
  const real = r.transport.options.request;
  const urls = [];
  r.transport.options.request = (request) => {
    urls.push(request.url);
    return real(request);
  };
  return urls;
}

const asked = (urls, fileId) => urls.filter((url) => fileGet.exec(url)?.[1] === fileId).length;

/** The plugin's one answer to a press (`main.ts`, `forceAnswer`), which needs Obsidian's module: from a sandbox. */
function answers(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  return box.require(join(box.home, "build/main.js")).forceAnswer;
}

test("a file the server has and this device lacks is received, and a press again asks the server for nothing", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const id = "5a".repeat(16);
  await publish(r, id, "missed.md", "MISSED SENTINEL\n");
  passed(r);
  const engine = await started(r, timers);
  assert.equal(r.host.text("missed.md"), null, "the feed does not bring it");

  const tally = await engine.forceSync();

  assert.equal(r.host.text("missed.md"), "MISSED SENTINEL\n");
  assert.deepEqual(tally, { checked: 0, sent: 0, listed: 1, received: 1, downloading: 0, complete: true },
    "the domain map is not a file on the server");
  assert.ok(r.host.logs.some((line) => line.startsWith("force_sync decision=done checked=0 sent=0 from=start listed=1 behind=1 received=1 downloading=0 requests=2 ")),
    r.host.logs.filter((line) => line.startsWith("force_sync")).join(" | "));

  const urls = requests(r);
  const again = await engine.forceSync();
  assert.deepEqual(again, { checked: 1, sent: 0, listed: 1, received: 0, downloading: 0, complete: true });
  assert.equal(asked(urls, id), 0, "a file held at its head is not asked for");
  engine.stop();
});

test("a server head newer than the version this device holds is received", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const id = "5b".repeat(16);
  const first = await publish(r, id, "note.md", "ONE SENTINEL\n");
  let engine = await started(r, timers, () => settled(r, "note.md"));
  await engine.stopAndWait();
  const second = await publish(r, id, "note.md", "TWO SENTINEL\n", [first.version_id], 1600);
  passed(r);
  engine = await started(r, timers);
  assert.equal(r.host.text("note.md"), "ONE SENTINEL\n", "the feed does not bring it");

  const tally = await engine.forceSync();

  assert.equal(r.host.text("note.md"), "TWO SENTINEL\n");
  assert.equal(r.state.fileByPath("note.md").versionId, second.version_id);
  assert.deepEqual(tally, { checked: 1, sent: 0, listed: 1, received: 1, downloading: 0, complete: true });
  engine.stop();
});

test("a local change only a full read finds is sent", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  r.host.seed("mine.md", "MINE SENTINEL\n", 1000);
  const engine = await started(r, timers, () => settled(r, "mine.md"));
  await timers.run(1000, () => engine.queue.length === 0 && engine.pushing.size === 0 && !engine.draining && engine.pending.size === 0);
  const fileId = r.state.fileByPath("mine.md").fileId;
  const before = r.server.files.get(fileId).versions.length;
  // The same size and date: Sync now's size-and-date pass cannot see it.
  r.host.seed("mine.md", "MINE SENTINEL!", 1000);

  const tally = await engine.forceSync();

  assert.deepEqual(tally, { checked: 1, sent: 1, listed: 1, received: 0, downloading: 0, complete: true });
  assert.equal(r.server.files.get(fileId).versions.length, before + 1, "the server took the change");
  assert.equal(r.server.files.get(fileId).heads[0], r.state.fileByPath("mine.md").versionId, "and this device holds its head");
  engine.stop();
});

test("a divergent edit is kept beside the server's as a copy, and neither is written over", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const id = "5c".repeat(16);
  const first = await publish(r, id, "photo.bin", Uint8Array.from([1, 2, 3, 4]));
  let engine = await started(r, timers, () => settled(r, "photo.bin"));
  await engine.stopAndWait();
  await publish(r, id, "photo.bin", Uint8Array.from([9, 9, 9, 9]), [first.version_id], 1600);
  passed(r);
  // Edited here too, keeping its size and date.
  r.host.seed("photo.bin", Uint8Array.from([1, 2, 3, 5]), r.host.files.get("photo.bin").mtime);
  engine = await started(r, timers);

  const tally = await engine.forceSync();
  await timers.run(1000, () => engine.queue.length === 0 && engine.pushing.size === 0 && !engine.draining);

  const kept = [...r.host.files].filter(([path]) => path.startsWith("photo")).map(([, file]) => [...file.bytes].join(",")).sort();
  assert.deepEqual(kept, ["1,2,3,5", "9,9,9,9"], "both versions are in the vault, under two names");
  assert.ok(r.host.notices.some((notice) => notice.includes("kept both versions")), r.host.notices.join(" | "));
  assert.equal(tally.sent, 1, "this device's edit was sent");
  assert.equal(tally.complete, true);
  engine.stop();
});

test("a missed head too large for the pull lock goes to the download lane, as the feed sends it", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const id = "5d".repeat(16);
  const bytes = new Uint8Array(LARGE_APPLY_BYTES + 1).fill(73);
  const chunks = [];
  for await (const plaintext of chunkStream(bytesSource(bytes))) {
    const part = await seal2.encryptChunk2(r.keys.domainKey, { generation: r.keys.generation, domainId: KEYS.domainId }, plaintext);
    r.server.chunks.set(part.sid, part.ciphertext);
    chunks.push({ sid: part.sid, cid: c.hex(part.cid), len: plaintext.length });
  }
  const manifest = { v: 1, path: "large.bin", size: bytes.length, mtime: 1500, domain: KEYS.domainId, chunks, sha256: c.hex(await c.sha256(bytes)), deleted: false };
  await r.server.publishManifest({ fileId: id, manifest, sids: chunks.map((chunk) => chunk.sid), parents: [], deviceId: OTHER,
    manifestKey: r.keys.manifestKey, bytes: bytes.length });
  passed(r);
  const engine = await started(r, timers);

  const tally = await engine.forceSync();

  assert.deepEqual(tally, { checked: 0, sent: 0, listed: 1, received: 0, downloading: 1, complete: true });
  assert.ok(r.host.logs.some((line) => line.startsWith(`feed decision=backgrounded reason=large bytes=${bytes.length} `)));
  await timers.run(1000, () => r.host.files.get("large.bin")?.bytes.length === bytes.length);
  engine.stop();
});

test("a revoked device sends and receives nothing, and says to pair again", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const said = [];
  r.host.seed("mine.md", "MINE SENTINEL\n", 1000);
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers, onStatus: (status) => said.push(status) });
  await engine.start();
  await timers.run(1000, () => settled(r, "mine.md") && engine.queue.length === 0 && engine.pushing.size === 0 && !engine.draining);
  await publish(r, "5d".repeat(16), "missed.md", "MISSED SENTINEL\n");
  passed(r);
  r.server.devices.find((device) => device.device_id === KEYS.deviceId).revoked = true;
  r.host.seed("mine.md", "MINE SENTINEL!", 1000);
  const journal = r.server.journal.length;

  const tally = await engine.forceSync();

  assert.deepEqual(tally, { checked: 0, sent: 0, listed: 0, received: 0, downloading: 0, complete: false });
  assert.equal(r.server.journal.length, journal, "nothing reached the server");
  assert.equal(r.host.text("missed.md"), null, "nothing was received");
  assert.deepEqual(said.at(-1), { kind: "error", code: "credential_rejected", message: REVOKED_DEVICE });
  assert.match(REVOKED_DEVICE, /Pair it again/);
  assert.ok(r.host.logs.some((line) => line.startsWith("force_sync decision=stopped reason=stop ")));
});

test("a file outside this device's folders is not written, and is not asked for again until it changes", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  r.state.data.syncFolders = ["Notes"];
  const out = "5e".repeat(16);
  await publish(r, "5f".repeat(16), "Notes/in.md", "IN SENTINEL\n");
  const outside = await publish(r, out, "Other/out.md", "OUT SENTINEL\n");
  passed(r);
  const engine = await started(r, timers);
  const urls = requests(r);

  const tally = await engine.forceSync();

  assert.equal(r.host.text("Notes/in.md"), "IN SENTINEL\n");
  assert.deepEqual([...r.host.files.keys()].filter((path) => !path.startsWith("Notes/")), [], "nothing outside Notes");
  assert.deepEqual(tally, { checked: 0, sent: 0, listed: 2, received: 1, downloading: 0, complete: true });
  assert.equal(asked(urls, out), 1, "asked once, and the pull path declined it");
  assert.ok(r.host.logs.some((line) => line.includes("decision=not_synced reason=outside_sync_scope")));

  await engine.forceSync();
  assert.equal(asked(urls, out), 1, "its heads have not moved: not asked again");
  await publish(r, out, "Other/out.md", "OUT AGAIN SENTINEL\n", [outside.version_id], 1600);
  passed(r);
  await engine.forceSync();
  assert.equal(asked(urls, out), 2, "a new head is asked about");
  assert.equal(r.host.text("Other/out.md"), null);
  engine.stop();
});

test("the listing is read to its last page", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const ids = ["61", "62", "63"].map((byte) => byte.repeat(16));
  for (const [i, id] of ids.entries()) await publish(r, id, `page-${i}.md`, `PAGE ${i} SENTINEL\n`);
  passed(r);
  const engine = await started(r, timers);
  const urls = requests(r);
  r.server.pageLimit = 1;

  const tally = await engine.forceSync();

  assert.equal(urls.filter((url) => url.includes("/v1/files?")).length, 4, "one file a page: three notes and the domain map");
  for (const i of [0, 1, 2]) assert.equal(r.host.text(`page-${i}.md`), `PAGE ${i} SENTINEL\n`);
  assert.deepEqual(tally, { checked: 0, sent: 0, listed: 3, received: 3, downloading: 0, complete: true });
  engine.stop();
});

test("a pass over its time says so, and the next press goes on from there", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  const ids = ["71", "72", "73"].map((byte) => byte.repeat(16));
  for (const [i, id] of ids.entries()) await publish(r, id, `slow-${i}.md`, `SLOW ${i} SENTINEL\n`);
  passed(r);
  let clock = 1757200000000;
  const engine = await started(r, timers, () => true, () => clock);
  const real = r.transport.options.request;
  let reads = 0;
  r.transport.options.request = (request) => {
    // The first file's read takes the whole budget.
    if (fileGet.test(request.url) && reads++ === 0) clock += FORCE_BUDGET_MS + 1;
    return real(request);
  };

  const first = await engine.forceSync();

  assert.deepEqual(first, { checked: 0, sent: 0, listed: 2, received: 1, downloading: 0, complete: false }, "it stopped at the second file");
  assert.ok(r.host.logs.some((line) => line.startsWith("force_sync decision=stopped reason=budget ")));
  const second = await engine.forceSync();
  assert.deepEqual(second, { checked: 1, sent: 0, listed: 3, received: 2, downloading: 0, complete: true });
  for (const i of [0, 1, 2]) assert.equal(r.host.text(`slow-${i}.md`), `SLOW ${i} SENTINEL\n`);
  engine.stop();
});

test("a settled pass is in step with the server, and the answer says so", async (t) => {
  const forceAnswer = answers(t);
  const r = await rig();
  const timers = new FakeTimers();
  await publish(r, "91".repeat(16), "arrived.md", "ARRIVED SENTINEL\n");
  passed(r);
  const engine = await started(r, timers);

  const tally = await engine.forceSync();

  assert.deepEqual(engine.current(), { kind: "idle" });
  assert.equal(forceAnswer(tally, engine.current(), 0), "in step with the server: checked 0 files here and 1 on the server; sent 0, received 1.");
  engine.stop();
});

test("a newer version an open editor holds back is said as outstanding, by its path, until a press after the editor lets go lands it", async (t) => {
  const forceAnswer = answers(t);
  const r = await rig();
  const timers = new FakeTimers();
  r.host.seed("note.md", "BASE SENTINEL\n", 1000);
  const base = await pushFile(r.context, "note.md");
  await publish(r, base.fileId, "note.md", "REMOTE SENTINEL\n", [base.versionId], 3000);
  passed(r);
  // The person is typing in the note: the write that would land the newer version is refused.
  let busy = true;
  r.host.typing = (path) => path === "note.md" && busy;
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path) => {
    const pending = await writer(path);
    return { ...pending, commit: async (mtime) => {
      if (path === "note.md" && busy) throw new EditorBusy();
      return pending.commit(mtime);
    } };
  };
  const engine = await started(r, timers);

  const held = await engine.forceSync();

  assert.deepEqual(held, { checked: 1, sent: 0, listed: 1, received: 0, downloading: 0, complete: true });
  assert.equal(r.host.text("note.md"), "BASE SENTINEL\n");
  assert.deepEqual(engine.current(), { kind: "syncing", pending: 1, held: "note.md" });
  assert.equal(forceAnswer(held, engine.current(), 0),
    "checked 1 file here and 1 on the server; sent 0, received 0; still syncing 1 file, waiting for unsaved changes in note.md.");

  busy = false;
  const landed = await engine.forceSync();

  assert.equal(r.host.text("note.md"), "REMOTE SENTINEL\n", "the press retried the held version");
  assert.deepEqual(engine.current(), { kind: "idle" });
  assert.equal(forceAnswer(landed, engine.current(), 0), "in step with the server: checked 1 file here and 1 on the server; sent 0, received 0.");
  engine.stop();
});

test("a listing slower than the budget settles each page before the next, a press again goes on from there, and a finished round starts over", async () => {
  for (const slow of [false, true]) {
    const r = await rig();
    const timers = new FakeTimers();
    const ids = ["81", "82", "83"].map((byte) => byte.repeat(16));
    for (const [i, id] of ids.entries()) await publish(r, id, `listed-${i}.md`, `LISTED ${i} SENTINEL\n`);
    passed(r);
    let clock = 1757200000000;
    const engine = await started(r, timers, () => true, () => clock);
    r.server.pageLimit = 1;
    const real = r.transport.options.request;
    let pace = slow ? FORCE_BUDGET_MS * 0.4 : 0;
    // Each page of the listing takes four tenths of the budget: three pages spend it.
    r.transport.options.request = (request) => {
      if (request.url.includes("/v1/files?")) clock += pace;
      return real(request);
    };
    const presses = [];
    do presses.push(await engine.forceSync()); while (!presses.at(-1).complete && presses.length < 5);

    for (const i of [0, 1, 2]) assert.equal(r.host.text(`listed-${i}.md`), `LISTED ${i} SENTINEL\n`, `slow=${slow}`);
    assert.equal(presses.reduce((sum, press) => sum + press.received, 0), 3, `slow=${slow}`);
    if (!slow) assert.equal(presses.length, 1, "a fast listing finishes in one press");
    else {
      assert.equal(presses.length, 2, "the second press goes on where the first stopped");
      assert.equal(presses[0].complete, false);
      assert.ok(presses[0].received >= 1, "the first press settled the pages it listed");
      assert.ok(r.host.logs.some((line) => line.startsWith("force_sync decision=stopped reason=budget checked=0 sent=0 from=start ")));
      assert.ok(r.host.logs.some((line) => line.startsWith("force_sync decision=done ") && line.includes(" from=cursor ")),
        r.host.logs.filter((line) => line.startsWith("force_sync")).join(" | "));
    }
    // A round that reached the last page is over: the next press lists from the first page again.
    pace = 0;
    const first = "0".repeat(31) + "1";
    await publish(r, first, "listed-first.md", "FIRST SENTINEL\n");
    passed(r);
    const again = await engine.forceSync();
    assert.equal(r.host.text("listed-first.md"), "FIRST SENTINEL\n", `slow=${slow}`);
    assert.equal(again.received, 1);
    assert.equal(again.complete, true);
    engine.stop();
  }
});

test("a stop while a page's last file waits its turn neither passes the page nor claims the round", async () => {
  const r = await rig();
  const timers = new FakeTimers();
  await publish(r, "a1".repeat(16), "waiting.md", "WAITING SENTINEL\n");
  passed(r);
  const engine = await started(r, timers);
  const real = r.transport.options.request;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  r.transport.options.request = (request) => {
    // Another pull holds the chain while the listing is read, so the file's turn queues behind it.
    if (request.url.includes("/v1/files?")) void engine.exclusive("hold", () => gate);
    return real(request);
  };

  const pass = engine.forceSync();
  await timers.run(STEP_MS, () => engine.holder?.label === "hold" && engine.behind === 1);
  engine.stop();
  release();
  const tally = await pass;

  assert.equal(tally.complete, false);
  assert.equal(engine.forceAfter, null, "the page was not passed");
  assert.equal(r.host.text("waiting.md"), null);
  assert.ok(r.host.logs.some((line) => line.startsWith("force_sync decision=stopped reason=stop ")));
});
