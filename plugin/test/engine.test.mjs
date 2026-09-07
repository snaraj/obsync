/**
 * The sync engine end to end against a fake vault and a fake obsyncd.
 *
 * The fake server verifies every signature, every uploaded chunk's sid and
 * every posted version id, so these tests exercise the real transport, the
 * real crypto and the real version-id preimage. What is faked is Obsidian and
 * the socket, nothing else.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeHost, FakeServer, FakeTimers, KEYS, fakeState, keys } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { pushDelete, pushFile } = require("../build/sync/push.js");
const { applyChange, fetchRemoteOnly, remoteOnlyList, commonAncestor } = require("../build/sync/pull.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);

async function rig({ isMobile = false, policy } = {}) {
  const host = new FakeHost({ isMobile });
  const server = new FakeServer();
  const { state } = await fakeState(isMobile);
  if (policy) state.data.policy = policy;
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const k = await keys();
  const context = {
    state,
    transport,
    host,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    domainId: KEYS.domainId,
    deviceId: KEYS.deviceId,
    concurrency: isMobile ? 2 : 4,
    authored: new Set(),
    written: new Set(),
    deviceNames: new Map([["ffffffffffffffffffffffffffffffff", "iPhone"]]),
    now: () => host.clock,
    deviceNameFor: (id) => (id === KEYS.deviceId ? "this device" : "iPhone"),
  };
  return { host, server, state, transport, context, keys: k };
}

test("a push uploads ciphertext and posts a version the server recomputes", async () => {
  const { host, server, state, context } = await rig();
  host.seed("Notes/Ideas.md", "# Ideas\nthe plaintext marker\n", 1000);
  const outcome = await pushFile(context, "Notes/Ideas.md");

  assert.equal(outcome.status, "pushed");
  assert.equal(server.chunks.size, 1);
  assert.equal(server.files.size, 1);
  const record = state.fileByPath("Notes/Ideas.md");
  assert.equal(record.versionId, outcome.versionId);
  assert.equal(record.size, 29);

  // Blind server: no chunk body, and no JSON field, carries the plaintext or
  // the path.
  for (const chunk of server.chunks.values()) {
    assert.equal(Buffer.from(chunk).includes("plaintext marker"), false);
  }
  for (const request of server.requests) {
    if (request.json === null) continue;
    assert.equal(request.json.includes("Ideas"), false, request.target);
    assert.equal(request.json.includes("Notes/"), false, request.target);
  }
});

test("pushing an unchanged file posts nothing", async () => {
  const { host, server, context } = await rig();
  host.seed("a.md", "same", 1000);
  await pushFile(context, "a.md");
  const versions = server.journal.length;
  host.files.get("a.md").mtime = 2000;
  const second = await pushFile(context, "a.md");
  assert.equal(second.status, "unchanged");
  assert.equal(server.journal.length, versions);
});

test("a large file is chunked, and a resumed upload sends only what is missing", async () => {
  const { host, server, context } = await rig();
  const size = 12 << 20;
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
  host.seed("big.bin", data, 1000);

  // Pretend a previous run uploaded the first chunk before dying.
  const { chunkStream, bytesSource } = require("../build/chunker.js");
  const first = (await chunkStream(bytesSource(data)).next()).value;
  const sealed = await c.encryptChunk(context.domainKey, first);
  server.chunks.set(sealed.sid, sealed.ciphertext);

  await pushFile(context, "big.bin");
  const puts = server.requests.filter((request) => request.method === "PUT");
  assert.ok(server.chunks.size >= 2, "the file is more than one chunk");
  assert.equal(puts.length, server.chunks.size - 1, "the chunk already present was not re-sent");
});

test("a pull writes the other device's file and records its version", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const frame = await server.publish({
    fileId: "11".repeat(16),
    path: "Notes/From iPhone.md",
    bytes: enc("written elsewhere\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "applied");
  assert.equal(host.text("Notes/From iPhone.md"), "written elsewhere\n");
  assert.equal(state.fileByPath("Notes/From iPhone.md").versionId, frame.version_id);
  assert.equal(context.written.has("Notes/From iPhone.md:1757200001000:18"), true, "the write is echo-tagged");
});

test("a pull refuses content whose plaintext hash does not match its manifest", async () => {
  const { host, server, context, keys: k } = await rig();
  const frame = await server.publish({
    fileId: "12".repeat(16),
    path: "Notes/Tampered.md",
    bytes: enc("honest bytes\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  // Swap the stored chunk for a different, correctly encrypted one: the
  // manifest's cid no longer matches, so the chunk must be refused.
  const other = await c.encryptChunk(k.domainKey, enc("substituted bytes\n"));
  server.chunks.set(frame.sids[0], other.ciphertext);
  await assert.rejects(() => applyChange(context, frame));
  assert.equal(host.files.has("Notes/Tampered.md"), false, "nothing unverified reached the vault");
});

test("our own versions are dropped on the way back down the feed", async () => {
  const { host, server, context } = await rig();
  host.seed("echo.md", "mine", 1000);
  const outcome = await pushFile(context, "echo.md");
  context.authored.add(outcome.versionId);
  const frame = server.journal[server.journal.length - 1];

  assert.equal(await applyChange(context, frame), "echo");
  assert.equal(context.authored.has(outcome.versionId), false, "the echo is consumed once");
  // Even without the authored set, the device id alone stops it.
  assert.equal(await applyChange(context, frame), "echo");
});

test("a tombstone deletes locally", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const created = await server.publish({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    bytes: enc("bye\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  await applyChange(context, created);
  const tombstone = await server.publishTombstone({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    manifestKey: k.manifestKey,
    parents: [created.version_id],
  });
  assert.equal(await applyChange(context, tombstone), "deleted");
  assert.deepEqual(host.trashed, ["Notes/Doomed.md"]);
  assert.equal(state.fileByPath("Notes/Doomed.md"), undefined);
});

test("a delete pushes a tombstone with no sids", async () => {
  const { host, server, state, context } = await rig();
  host.seed("gone.md", "content", 1000);
  await pushFile(context, "gone.md");
  host.files.delete("gone.md");
  const outcome = await pushDelete(context, "gone.md");
  assert.ok(outcome);
  const frame = server.journal[server.journal.length - 1];
  assert.equal(frame.deleted, true);
  assert.deepEqual(frame.sids, []);
  assert.equal(state.fileByPath("gone.md"), undefined);
});

test("a policy ceiling makes a file remote-only, and a fetch overrides it", async () => {
  const { host, server, state, context, keys: k } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 16, totalBudgetBytes: 0 },
  });
  const frame = await server.publish({
    fileId: "14".repeat(16),
    path: "Attachments/large.bin",
    bytes: enc("this payload is larger than sixteen bytes"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");
  assert.equal(host.files.has("Attachments/large.bin"), false);
  assert.deepEqual(state.data.remoteOnly["14".repeat(16)], { path: "Attachments/large.bin", size: 41 });

  const listed = remoteOnlyList(context);
  assert.equal(listed.length, 1);
  assert.match(listed[0].why, /per-file ceiling/);

  const path = await fetchRemoteOnly(context, "14".repeat(16));
  assert.equal(path, "Attachments/large.bin");
  assert.equal(host.text("Attachments/large.bin"), "this payload is larger than sixteen bytes");
  assert.equal(state.data.remoteOnly["14".repeat(16)], undefined, "it is no longer remote-only");
});

test("a total budget also holds files back", async () => {
  const { server, context, keys: k } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 0, totalBudgetBytes: 8 },
  });
  const frame = await server.publish({
    fileId: "15".repeat(16),
    path: "big.txt",
    bytes: enc("nine bytes"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");
  assert.match(remoteOnlyList(context)[0].why, /total budget/);
});

test("concurrent edits with a common ancestor merge, keeping both", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed("Notes/Shared.md", "one\ntwo\nthree\n", 1000);
  const base = await pushFile(context, "Notes/Shared.md");

  // The other device edits the last line from the same base.
  const theirs = await server.publish({
    fileId: base.fileId,
    path: "Notes/Shared.md",
    bytes: enc("one\ntwo\nTHREE\n"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  // We edit the first line locally, without seeing theirs.
  host.seed("Notes/Shared.md", "ONE\ntwo\nthree\n", 2000);
  const mine = await pushFile(context, "Notes/Shared.md");
  assert.equal(mine.ack.conflicted, true, "the server keeps both heads");

  const head = server.journal.find((frame) => frame.version_id === theirs.version_id);
  const result = await applyChange(context, { ...head, conflicted: true });
  assert.equal(result, "merged");
  assert.equal(host.text("Notes/Shared.md"), "ONE\ntwo\nTHREE\n");
  assert.match(host.notices.join(" "), /merged concurrent edits/);

  const merged = server.journal[server.journal.length - 1];
  assert.deepEqual([...merged.parents].sort(), [mine.versionId, theirs.version_id].sort());
  assert.equal(state.fileByPath("Notes/Shared.md").versionId, merged.version_id);
});

test("overlapping edits keep both sides as a named conflict copy", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed("Notes/Clash.md", "line\n", 1000);
  const base = await pushFile(context, "Notes/Clash.md");
  const theirs = await server.publish({
    fileId: base.fileId,
    path: "Notes/Clash.md",
    bytes: enc("their line\n"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  host.seed("Notes/Clash.md", "my line\n", 2000);
  await pushFile(context, "Notes/Clash.md");

  const head = server.journal.find((frame) => frame.version_id === theirs.version_id);
  assert.equal(await applyChange(context, { ...head, conflicted: true }), "conflict_copy");
  assert.equal(host.text("Notes/Clash.md"), "my line\n", "our edit is untouched");
  const copy = [...host.files.keys()].find((path) => path.includes("conflict from"));
  assert.match(copy, /^Notes\/Clash \(conflict from iPhone, \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
  assert.equal(host.text(copy), "their line\n");
  assert.match(host.notices.join(" "), /kept both versions/);
});

test("a binary conflict is never merged", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed("image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 1000);
  const base = await pushFile(context, "image.png");
  const theirs = await server.publish({
    fileId: base.fileId,
    path: "image.png",
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  host.seed("image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x03]), 2000);
  await pushFile(context, "image.png");
  const head = server.journal.find((frame) => frame.version_id === theirs.version_id);
  assert.equal(await applyChange(context, { ...head, conflicted: true }), "conflict_copy");
  assert.ok([...host.files.keys()].some((path) => path.startsWith("image (conflict from iPhone")));
});

test("the common ancestor walk finds the shared base, or nothing", () => {
  const versions = [
    { version_id: "c", parents: ["a"] },
    { version_id: "b", parents: ["a"] },
    { version_id: "a", parents: [] },
  ];
  assert.equal(commonAncestor(versions, "b", "c"), "a");
  assert.equal(commonAncestor([{ version_id: "x", parents: [] }, { version_id: "y", parents: [] }], "x", "y"), null);
});

test("the engine queues, debounces and pushes what the watcher reports", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
      maxAttempts: 2,
    }),
    host,
    domainId: KEYS.domainId,
    now: () => host.clock,
    timers,
    onStatus: (status) => statuses.push(status.kind),
  });

  host.seed("Existing.md", "already here", 1000);
  await engine.start();
  await timers.run();
  assert.equal(server.heartbeats, 1);
  assert.equal(state.fileByPath("Existing.md") !== undefined, true, "startup reconciliation pushed it");

  host.seed("New.md", "typed just now", 2000);
  engine.changed("New.md");
  await timers.run();
  assert.equal(state.fileByPath("New.md") !== undefined, true);
  assert.ok(statuses.includes("syncing"));
  assert.equal(statuses[statuses.length - 1], "idle");
  engine.stop();
});

test("the growing-file guard waits for a file to stop changing", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    domainId: KEYS.domainId,
    timers,
  });
  await engine.start();

  // Every stat reports a different size, as a file being copied would.
  let calls = 0;
  const realStat = host.stat.bind(host);
  host.stat = async (path) => {
    const stat = await realStat(path);
    if (stat && path === "Copying.bin") stat.size += calls++;
    return stat;
  };
  host.seed("Copying.bin", "growing", 3000);
  engine.changed("Copying.bin");
  for (let round = 0; round < 3; round++) await timers.run(1000);
  assert.equal(state.fileByPath("Copying.bin"), undefined, "nothing torn was uploaded");
  assert.ok(calls >= 4, `the guard kept re-checking instead of pushing (${calls} stats)`);

  host.stat = realStat;
  await timers.run();
  assert.equal(state.fileByPath("Copying.bin") !== undefined, true, "it pushes once the file settles");
  engine.stop();
});

test("a write made by the pull path does not bounce back up", async () => {
  const { host, server, state, keys: k } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    domainId: KEYS.domainId,
    timers,
  });
  await engine.start();
  await timers.run();

  const frame = await server.publish({
    fileId: "16".repeat(16),
    path: "Pulled.md",
    bytes: enc("from elsewhere\n"),
    mtime: 1757200005000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  await applyChange(engine.context, frame);
  const before = server.journal.length;

  // Obsidian now reports the write the pull just made.
  engine.changed("Pulled.md");
  await timers.run();
  assert.equal(server.journal.length, before, "no version was posted for our own write");
  assert.ok(host.logs.some((line) => line.includes("echo_suppressed")));
  engine.stop();
});

test("a rename keeps the file id and moves the path inside the manifest", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    domainId: KEYS.domainId,
    timers,
  });
  host.seed("Old name.md", "stable content", 1000);
  await engine.start();
  await timers.run();
  const fileId = state.fileByPath("Old name.md").fileId;

  host.files.set("New name.md", host.files.get("Old name.md"));
  host.files.delete("Old name.md");
  engine.renamed("Old name.md", "New name.md");
  await timers.run();

  assert.equal(state.fileByPath("Old name.md"), undefined);
  assert.equal(state.fileByPath("New name.md").fileId, fileId, "the file kept its identity");
  assert.equal(server.files.size, 1, "no second file was created");
  assert.equal(server.files.get(fileId).versions.length, 2);
  engine.stop();
});

test("startup reconciliation tombstones a file deleted while Obsidian was closed", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    domainId: KEYS.domainId,
    timers,
  });
  host.seed("Removed.md", "content", 1000);
  await engine.start();
  await timers.run();
  assert.equal(server.journal.length, 1);

  host.files.delete("Removed.md");
  await engine.reconcile();
  await timers.run();
  assert.equal(server.journal[server.journal.length - 1].deleted, true);
  assert.equal(state.fileByPath("Removed.md"), undefined);
  engine.stop();
});
