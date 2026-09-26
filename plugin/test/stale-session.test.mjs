/**
 * Turning obsync off and on mid-upload, and what the session it replaced may
 * still do afterwards (issue #181).
 *
 * Obsidian builds a NEW plugin object, from a fresh evaluation of the bundle,
 * every time the plugin is turned on, while the object it replaced is still
 * draining the upload it was stopped in. That drain ends with a save of the
 * old object's State -- a minute or two later, because every request of an
 * inactive session is refused and retried as a network error -- and it landed
 * over the data file the new object had already read and written: the cursor
 * went back (`seq=128`), synced files became untracked and were published
 * again under new ids, and the identical-name rule's retirement of an old id
 * then deleted a 1 GiB file from the device that made it (S98).
 *
 * Three guards, one per link of that chain, each proved at the level the
 * suite already drives it: plugin objects over one data file; the real
 * engine's startup pass; the real pull, fed by a second device's real rule.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_B, FakeTimers, KEYS, SECRET_B, memorySecrets, published, rig, sandbox } from "./fake.mjs";
import { parseManifest as decoder10x } from "./fixtures/decoder-1.0.x.mjs";

const require = createRequire(import.meta.url);
const { ApiError, Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { applyChange } = require("../build/sync/pull.js");
const { sidDigest } = require("../build/sync/push.js");

const enc = (text) => new TextEncoder().encode(text);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const lines = (host) => host.logs.join(" | ");

// --- (a) one writer per data file, across plugin objects -------------------

const identity = () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
  serverUrl: "https://sync.example.invalid", edgeHeaders: [] });

/**
 * One Obsidian window: one `app`, one data file, one secret store -- and a
 * plugin object per enable, each from its OWN evaluation of the bundle, as
 * Obsidian loads it, so nothing module-level survives from one to the next.
 */
function vaultWindow(t) {
  const secrets = new Map();
  const app = {
    workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (done) => done() },
    secretStorage: { getSecret: (id) => secrets.get(id) ?? null, setSecret: (id, value) => { secrets.set(id, value); } },
    vault: { adapter: {}, on: () => ({}) },
  };
  let metadata = identity();
  const hooks = { save: null };
  let reads = 0;
  const enable = () => {
    const box = sandbox();
    t.after(() => rmSync(box.home, { recursive: true, force: true }));
    const obsidian = box.require("obsidian");
    obsidian.requestUrl = async () => ({ status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) });
    const plugin = new (box.require(join(box.home, "build/main.js")).default)();
    const logs = [];
    plugin.app = app;
    plugin.manifest = { id: "obsync-private-sync", version: "1.1.3" };
    plugin.loadData = async () => { reads++; return structuredClone(metadata); };
    plugin.saveData = async (value) => { if (hooks.save) await hooks.save(); metadata = structuredClone(value); };
    plugin.addCommand = plugin.addSettingTab = plugin.registerEvent = plugin.registerObsidianProtocolHandler = () => {};
    plugin.addStatusBarItem = () => ({ setText() {} });
    plugin.checkForUpdate = async () => {};
    plugin.startEngine = async () => {};
    plugin.log = (line) => logs.push(line);
    return { plugin, logs, notices: obsidian.notices };
  };
  return { enable, hooks, secrets: () => new Map(secrets), metadata: () => structuredClone(metadata), reads: () => reads };
}

const V_BIN = "Attachments/v.bin";
const ORIGINAL = { fileId: "f3".repeat(16), versionId: "a1".repeat(32), mtime: 1000, size: 1073741824, sha256: "b2".repeat(32) };
const REPUBLISHED = { ...ORIGINAL, fileId: "13".repeat(16), versionId: "c3".repeat(32) };

test("a plugin object turned off mid-upload never saves over the one turned on after it (#181)", async (t) => {
  const window = vaultWindow(t);
  const first = window.enable();
  await first.plugin.onload();
  first.plugin.state.data.lastSeq = 128;
  first.plugin.state.data.files[V_BIN] = ORIGINAL;
  await first.plugin.state.save();
  // The upload the plugin is turned off in: its requests are refused from
  // here on, and the drain ends with the engine's final save of THIS State.
  const drained = deferred();
  first.plugin.engine = { stop() {}, async stopAndWait() { await drained.promise; await first.plugin.state.save(); } };
  first.plugin.onunload();

  // Turned on again: a new object reads the data file and moves on.
  const second = window.enable();
  await second.plugin.onload();
  assert.equal(second.plugin.state.data.lastSeq, 128);
  second.plugin.state.data.lastSeq = 177;
  second.plugin.state.data.files[V_BIN] = REPUBLISHED;
  await second.plugin.state.save();

  // The old drain finishes, a minute or two later in S98.
  drained.resolve();
  await Promise.allSettled([...first.plugin.engineTeardowns]);

  assert.equal(window.metadata().lastSeq, 177, "the replaced session wrote its older cursor over the new one");
  assert.deepEqual(window.metadata().files[V_BIN], REPUBLISHED, "the replaced session wrote its older records over the new ones");
  // "Reload app without saving": the next session reads what is on disk.
  const third = window.enable();
  await third.plugin.onload();
  assert.equal(third.plugin.state.data.lastSeq, 177, "the reload started behind the feed position already reached");
  // Refused, and said once, in the log only: nothing failed that the user
  // could fix, and nothing about it is destructive.
  assert.deepEqual(first.logs.filter((line) => line.includes("decision=")), ["state decision=refused reason=superseded"]);
  assert.deepEqual(first.notices, []);
  assert.ok(!second.logs.some((line) => line.startsWith("state decision=")), second.logs.join(" | "));
});

test("the next plugin object reads the data file only after a write already on its way has landed (#181)", async (t) => {
  const window = vaultWindow(t);
  const first = window.enable();
  await first.plugin.onload();
  const entered = deferred(), released = deferred();
  window.hooks.save = async () => { entered.resolve(); await released.promise; };
  first.plugin.state.data.lastSeq = 9;
  const writing = first.plugin.state.save();
  await entered.promise;
  first.plugin.onunload();

  const second = window.enable();
  const reads = window.reads();
  const loading = second.plugin.onload();
  await new Promise(setImmediate);
  assert.equal(window.reads(), reads, "the new object read the data file under a write in flight");
  window.hooks.save = null;
  released.resolve();
  await Promise.all([writing, loading]);
  assert.equal(second.plugin.state.data.lastSeq, 9, "the new object started from what was on disk before the write landed");
});

test("a superseded State writes nothing to either store (#181)", async (t) => {
  const window = vaultWindow(t);
  const first = window.enable();
  await first.plugin.onload();
  // A leave in flight: the credential cleared, its previous revision still in
  // the native store, waiting to be collapsed.
  first.plugin.state.forgetPairing();
  await first.plugin.state.save();
  const second = window.enable();
  await second.plugin.onload();
  const secrets = window.secrets(), metadata = window.metadata();

  await assert.rejects(first.plugin.state.forgetPreviousCredential(), (error) => error.reason === "superseded");
  first.plugin.state.data.lastSeq = 3;
  await assert.rejects(first.plugin.state.save(), (error) => error.reason === "superseded");

  assert.deepEqual(window.secrets(), secrets, "a superseded session rewrote the native secret its successor holds");
  assert.deepEqual(window.metadata(), metadata);
});

test("a plugin object superseded while still loaded stops its engine and says nothing (#181)", async (t) => {
  const window = vaultWindow(t);
  const first = window.enable();
  await first.plugin.onload();
  let stopped = 0;
  first.plugin.engine = { stop() { stopped++; }, async stopAndWait() {} };
  const second = window.enable();
  await second.plugin.onload();

  await assert.rejects(first.plugin.state.save(), (error) => error.reason === "superseded");

  assert.equal(stopped, 1, "the superseded session kept its engine running");
  assert.equal(first.plugin.engine, null);
  assert.deepEqual(first.logs.filter((line) => line.startsWith("state decision=")), ["state decision=refused reason=superseded"]);
  assert.deepEqual(first.notices, [], "a superseded session told the user something failed");
});

// --- (b) the startup pass adopts this device's own live version -----------

function engineRig(r) {
  const timers = new FakeTimers();
  const transport = new Transport({
    request: r.server.request,
    serverUrl: () => r.state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => r.host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => r.host.logs.push(line),
  });
  return { timers, transport, engine: () => new SyncEngine({ state: r.state, transport, host: r.host, now: () => r.host.clock, timers }) };
}

const walks = (r) => r.host.logs.filter((line) => line.startsWith("reconcile decision=held ")).length;
const ADOPTED = /^reconcile path_class=file decision=adopted reason=own_version /;

test("a synced file whose record was lost is adopted at startup, never published under a new id (#181)", async () => {
  const r = await rig();
  const { timers, engine } = engineRig(r);
  const path = "Attachments/v.bin";
  r.host.seed(path, "the upload this device finished before it was turned off\n", 1000);
  const cursor = r.state.data.lastSeq;
  const first = engine();
  await first.start();
  await timers.run(1000, () => r.state.fileByPath(path) !== undefined);
  await first.stopAndWait();
  const original = r.state.fileByPath(path);
  const posts = r.server.journal.length;

  // The replaced session's late save: the cursor and the records from before
  // this device published the file -- a record lost, a version live.
  r.state.data.lastSeq = cursor;
  delete r.state.data.files[path];

  const second = engine();
  await second.start();
  await timers.run(1000);
  assert.equal(r.server.journal.length, posts, `a synced file was published again: ${lines(r.host)}`);
  assert.equal((await r.server.noteFiles(r.keys.manifestKey)).length, 1, "a second file id was minted for one file");
  // The server's time for the version (#145) is stamped whenever its echo is
  // read, on either record or both; it is a field of the same version, so the
  // comparison leaves it out.
  const bare = ({ ts, ...rest }) => rest;
  assert.deepEqual(bare(r.state.fileByPath(path)), bare(original), "the record is not the version this device already published");
  assert.ok(r.host.logs.some((line) => line.startsWith(`reconcile path_class=file decision=adopted reason=own_version file=${original.fileId}`)),
    lines(r.host));
  assert.ok(r.host.logs.some((line) => /^reconcile decision=held since=\d+ untracked=1 adopted=1 budget_ms=\d+ duration_ms=\d+$/.test(line)),
    lines(r.host));

  // ONE read per start: a second pass in the same start publishes a new file
  // without asking again, and a start with no unrecorded name asks nothing.
  const count = walks(r);
  r.host.seed("Notes/new.md", "made during the session\n", 5000);
  await second.syncNow();
  assert.equal(walks(r), count, "a second pass of one start read the feed again");
  assert.notEqual(r.state.fileByPath("Notes/new.md"), undefined, "a new file was not published");
  await second.stopAndWait();
  const third = engine();
  await third.start();
  await timers.run(1000);
  await third.stopAndWait();
  assert.equal(walks(r), count, "a start with every name recorded read the feed");
});

test("another device's version is never adopted by its stat, even at the same name and size (#181)", async () => {
  const r = await rig();
  const { timers, engine } = engineRig(r);
  const path = "Notes/same-size.md";
  const local = "bytes typed here, never published\n";
  const theirs = "bytes another device published!!!\n";
  assert.equal(local.length, theirs.length);
  r.host.seed(path, local, 1000);
  const foreign = await r.server.publish({
    fileId: "44".repeat(16), path, bytes: enc(theirs), mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  const holding = () => [...r.host.files.keys()].find((name) => r.host.text(name) === local);
  const started = engine();
  await started.start();
  await timers.run(1000, () => r.state.fileByPath(holding())?.versionId);
  await started.stopAndWait();

  // Whichever name the same-name rule gives each note, the bytes typed here
  // are published under an id of their own.
  assert.ok(!r.host.logs.some((line) => ADOPTED.test(line)), lines(r.host));
  assert.notEqual(r.state.fileByPath(holding()).fileId, foreign.file_id,
    "bytes this device never published were recorded as another device's version");
});

test("an own version whose file id is recorded at another name is not adopted a second time (#181)", async () => {
  const r = await rig();
  const { timers, engine } = engineRig(r);
  const F = "55".repeat(16);
  const own = { domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: KEYS.deviceId };
  const v1 = await r.server.publish({ fileId: F, path: "Notes/q.md", bytes: enc("first\n"), mtime: 1000, ...own });
  await r.server.publish({ fileId: F, path: "Notes/p.md", bytes: enc("second\n"), mtime: 2000, parents: [v1.version_id], ...own });
  r.host.seed("Notes/q.md", "first\n", 1000);
  r.state.setFile("Notes/q.md", { fileId: F, versionId: v1.version_id, mtime: 1000, size: 6, sha256: await sidDigest(v1.sids) });
  r.host.seed("Notes/p.md", "second\n", 2000);

  const started = engine();
  await started.start();
  await timers.run(1000, () => r.state.fileByPath("Notes/p.md") !== undefined);
  await started.stopAndWait();

  assert.ok(!r.host.logs.some((line) => ADOPTED.test(line)), lines(r.host));
  assert.notEqual(r.state.fileByPath("Notes/p.md").fileId, F, "one file id is recorded at two names");
  assert.equal(r.state.fileByPath("Notes/q.md").fileId, F);
});

test("a feed that cannot be read at startup costs a new id, never the file (#181)", async () => {
  const r = await rig();
  const { timers, transport, engine } = engineRig(r);
  const changes = transport.changes.bind(transport);
  transport.changes = async (since, wait) => {
    if (wait === 0) throw new ApiError(0, "unreachable", "fixture outage");
    return changes(since, wait);
  };
  r.host.seed("Notes/new.md", "made while closed\n", 1000);

  const started = engine();
  await started.start();
  await timers.run(1000, () => r.state.fileByPath("Notes/new.md") !== undefined);
  await started.stopAndWait();

  assert.ok(r.host.logs.some((line) =>
    /^reconcile decision=held_failed reason=unreachable since=\d+ untracked=1 budget_ms=\d+ duration_ms=\d+$/.test(line)), lines(r.host));
  assert.equal((await r.server.noteFiles(r.keys.manifestKey)).length, 1);
});

// --- (c) a retirement never deletes what its keeper holds -----------------

const NOTE = "Attachments/v.bin";
const TEXT = "one gibibyte, in spirit\n";
const X = "f3".repeat(16);
const K = "13".repeat(16);

/**
 * S98 run 3 on two devices. Device A published the note under X and, its
 * records lost, again under K; A's rolled-back state still maps the name to
 * X, clean. Device B holds X at the same name.
 */
async function stale() {
  const a = await rig();
  a.server.addDevice(DEVICE_B, SECRET_B, "laptop");
  const b = await rig();
  const transport = new Transport({
    request: a.server.request,
    serverUrl: () => b.state.data.serverUrl,
    device: () => ({ id: DEVICE_B, secret: Uint8Array.from(Buffer.from(SECRET_B, "hex")) }),
    edgeHeaders: () => [],
    now: () => b.host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => b.host.logs.push(line),
  });
  const own = { domainKey: a.keys.domainKey, manifestKey: a.keys.manifestKey, deviceId: KEYS.deviceId };
  const x = await a.server.publish({ fileId: X, path: NOTE, bytes: enc(TEXT), mtime: 1000, ...own });
  const record = { fileId: X, versionId: x.version_id, mtime: 1000, size: enc(TEXT).length, sha256: await sidDigest(x.sids) };
  for (const device of [a, b]) {
    device.host.seed(NOTE, TEXT, 1000);
    device.state.setFile(NOTE, { ...record });
  }
  const k = await a.server.publish({ fileId: K, path: NOTE, bytes: enc(TEXT), mtime: 2000, ...own });
  return { a, b: { ...b.context, transport, deviceId: DEVICE_B }, own, x, k };
}

/** B meets K at the name it holds under X: the identical-name rule, which retires X. */
async function retiredByB({ a, b, k }) {
  assert.equal(await applyChange(b, k), "applied");
  const retired = a.server.journal.find((frame) => frame.file_id === X && frame.deleted);
  assert.ok(retired, "B did not retire X");
  return retired;
}

/** A retirement of X written by hand, as a device that holds the vault key could. */
function handRetirement({ a, x }, keeper) {
  return a.server.publishManifest({
    fileId: X, sids: [], parents: [x.version_id], deviceId: DEVICE_B, manifestKey: a.keys.manifestKey, bytes: 0,
    manifest: { v: 1, path: NOTE, size: 0, mtime: 3000, domain: KEYS.domainId, chunks: [], sha256: "", deleted: true, keeper },
  });
}

test("a retirement over a name its keeper holds deletes nothing and forgets only the old id (#181)", async () => {
  const world = await stale();
  const { a, k } = world;
  const retired = await retiredByB(world);

  assert.equal(await applyChange(a.context, retired), "skipped");

  assert.equal(a.host.text(NOTE), TEXT, `the retirement deleted the bytes its keeper holds: ${lines(a.host)}`);
  assert.ok(!a.context.trashed.has(NOTE), "the note was trashed");
  assert.equal(a.state.fileByPath(NOTE).fileId, K, "the name is not recorded under the id that keeps it");
  assert.equal(a.state.fileByPath(NOTE).versionId, k.version_id);
  assert.equal(a.state.pathByFileId(X), undefined, "the retired id is still recorded");
  assert.ok(a.host.logs.some((line) => line.startsWith(
    `pull path_class=tombstone decision=kept reason=retired_identical keeper=${K} retired=${X} seq=${retired.seq} duration_ms=`)),
  lines(a.host));
  // The keeper rides inside the manifest, where only a vault-key holder reads
  // it; a device before 1.1.3 still reads the record as the deletion it was.
  const manifest = (await published(a.server, X, a.keys.manifestKey)).at(-1);
  assert.equal(manifest.keeper, K);
  assert.equal(decoder10x(JSON.stringify(manifest)).deleted, true);
});

test("a retirement whose keeper no longer holds these bytes is still a deletion (#181)", async () => {
  const world = await stale();
  const { a, own, k } = world;
  const retired = await retiredByB(world);
  await a.server.publish({ fileId: K, path: NOTE, bytes: enc("the keeper was edited since\n"), mtime: 3000, parents: [k.version_id], ...own });

  assert.equal(await applyChange(a.context, retired), "deleted");

  assert.equal(a.host.text(NOTE), null);
  assert.equal(a.state.fileByPath(NOTE), undefined);
});

test("a retirement whose keeper this device records at another name is an ordinary deletion (#181)", async () => {
  const world = await stale();
  const { a, k } = world;
  const retired = await retiredByB(world);
  a.host.seed("Attachments/v 2.bin", TEXT, 2000);
  a.state.setFile("Attachments/v 2.bin", { fileId: K, versionId: k.version_id, mtime: 2000, size: enc(TEXT).length, sha256: await sidDigest(k.sids) });

  assert.equal(await applyChange(a.context, retired), "deleted");

  assert.equal(a.host.text(NOTE), null);
  assert.equal(a.state.pathByFileId(K), "Attachments/v 2.bin", "one file id is recorded at two names");
  assert.equal(a.host.text("Attachments/v 2.bin"), TEXT);
});

test("a retirement naming a keeper the server does not know is an ordinary deletion, not a stuck feed (#181)", async () => {
  const world = await stale();
  const { a } = world;
  const retired = await handRetirement(world, "77".repeat(16));

  assert.equal(await applyChange(a.context, retired), "deleted");
  assert.equal(a.host.text(NOTE), null);
});

test("a keeper that is not a file id is refused before any request is made (#181)", async () => {
  const world = await stale();
  const { a } = world;
  const retired = await handRetirement(world, "../../v1/account");
  const requests = a.server.requests.length;

  assert.equal(await applyChange(a.context, retired), "refused");

  assert.equal(a.server.requests.length, requests, "a request was built from the keeper");
  assert.equal(a.host.text(NOTE), TEXT);
  assert.equal(a.state.fileByPath(NOTE).fileId, X);
});
