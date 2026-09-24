import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig, FakeTimers } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile, sidDigest } = require("../build/sync/push.js");
const { SyncEngine } = require("../build/sync/engine.js");
const PATH = "Notes/Replay.md", LOW = "11".repeat(16), HIGH = "ff".repeat(16);
const TEXT = "later live note\n";

test("historical identical live frame followed by its deletion cannot retire a later independent note (#133)", async () => {
  const r = await rig();
  const old = await r.server.publish({ fileId: LOW, path: PATH, bytes: new TextEncoder().encode(TEXT), mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const deleted = await r.server.publishTombstone({ fileId: LOW, path: PATH, parents: [old.version_id], manifestKey: r.keys.manifestKey });
  const bytes = r.host.seed(PATH, TEXT, 3000);
  const live = await r.server.publish({ fileId: HIGH, path: PATH, bytes, mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: r.context.deviceId });
  r.state.setFile(PATH, { fileId: HIGH, versionId: live.version_id, mtime: 3000, size: bytes.length, sha256: await sidDigest(live.sids) });
  await r.state.save();
  await applyChange(r.context, old);
  await applyChange(r.context, deleted);
  for (const frame of r.server.journal.filter(frame => frame.seq > deleted.seq)) await applyChange(r.context, frame);
  assert.equal(r.host.text(PATH), TEXT, "the newer live note was lost to historical replay");
  assert.equal(r.state.fileByPath(PATH).fileId, HIGH);
  assert.equal(r.server.files.get(HIGH).versions[0].deleted, false);
  assert.equal((await r.reload()).fileByPath(PATH).fileId, HIGH);
});

test("a keeper selected while a push posts is persisted before the adopted id is retired (#133)", async () => {
  const r = await rig();
  const bytes = r.host.seed(PATH, TEXT, 3000);
  const old = await r.server.publish({ fileId: HIGH, path: PATH, bytes, mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const post = r.transport.postVersion.bind(r.transport);
  let keeper;
  r.transport.postVersion = async (id, version) => {
    if (version.deleted) {
      assert.equal((await r.reload()).fileByPath(PATH).fileId, keeper, "retirement preceded durable keeper metadata");
    }
    const result = await post(id, version);
    if (keeper === undefined && id !== HIGH) {
      keeper = id;
      r.state.setFile(PATH, { fileId: HIGH, versionId: old.version_id, mtime: 3000, size: bytes.length, sha256: await sidDigest(old.sids) });
      await r.state.save();
    }
    return result;
  };
  await pushFile(r.context, PATH);
  assert.ok(keeper && keeper < HIGH);
  assert.equal((await r.reload()).fileByPath(PATH).fileId, keeper);
  assert.equal(r.server.files.get(HIGH).versions[0].deleted, true);
});

test("a real transport 507 during chunk repair remains a visible storage refusal (#133)", async () => {
  const r = await rig(), timers = new FakeTimers(), statuses = [];
  r.host.seed(PATH, TEXT, 3000);
  await pushFile(r.context, PATH);
  const sid = r.server.journal.at(-1).sids[0];
  r.state.data.lastSeq = r.server.seq;
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock, onStatus: s => statuses.push(s) });
  await engine.start();
  const request = r.transport.options.request;
  let refused = 0;
  r.transport.options.request = async req => {
    if (req.method === "PUT") { refused++; return r.server.error(507, "volume_full", "SENTINEL storage refusal"); }
    return request(req);
  };
  r.server.chunks.delete(sid);
  try {
    await engine.syncNow();
    assert.equal(refused, 2, "both real transport attempts must receive 507");
    assert.equal(r.server.chunks.has(sid), false);
    assert.ok(statuses.some(s => s.kind === "error" && /could not verify/.test(s.message)), JSON.stringify(statuses));
    assert.ok(r.host.logs.some(s => /repair decision=deferred reason=read_or_write_failed/.test(s)), r.host.logs.join("\n"));
  } finally {
    await timers.run(0, () => r.server.feedWaiters.length > 0);
    engine.stop(); r.server.releaseFeed(); await engine.stopAndWait();
  }
});

test("an edit during the current-twin lookup is not adopted or retired (#133)", async () => {
  const r = await rig();
  const bytes = r.host.seed(PATH, TEXT, 3000);
  const live = await r.server.publish({ fileId: HIGH, path: PATH, bytes, mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.state.setFile(PATH, { fileId: HIGH, versionId: live.version_id, mtime: 3000, size: bytes.length, sha256: await sidDigest(live.sids) });
  const twin = await r.server.publish({ fileId: LOW, path: PATH, bytes, mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const get = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async id => { const record = await get(id); if (id === LOW) r.host.seed(PATH, "new local edit\n", 5000); return record; };
  await applyChange(r.context, twin);
  assert.equal(r.state.fileByPath(PATH).fileId, HIGH);
  assert.equal(r.host.text(PATH), "new local edit\n");
  assert.equal(r.server.files.get(HIGH).versions[0].deleted, false);
});


test("a replacement record during twin lookup keeps its newer identity (#133)", async () => {
  const r = await rig();
  const bytes = r.host.seed(PATH, TEXT, 3000);
  const live = await r.server.publish({ fileId: HIGH, path: PATH, bytes, mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const original = { fileId: HIGH, versionId: live.version_id, mtime: 3000, size: bytes.length, sha256: await sidDigest(live.sids) };
  r.state.setFile(PATH, original);
  const twin = await r.server.publish({ fileId: LOW, path: PATH, bytes, mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const get = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async id => {
    const record = await get(id);
    if (id === LOW) r.state.setFile(PATH, { ...original, fileId: "ee".repeat(16) });
    return record;
  };
  await applyChange(r.context, twin);
  assert.equal(r.state.fileByPath(PATH).fileId, "ee".repeat(16));
  assert.equal(r.server.files.get(HIGH).versions[0].deleted, false);
});

test("a twin with a concurrent deletion cannot replace an independent live note (#133)", async () => {
  const r = await rig();
  const bytes = r.host.seed(PATH, TEXT, 3000);
  const live = await r.server.publish({ fileId: HIGH, path: PATH, bytes, mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.state.setFile(PATH, { fileId: HIGH, versionId: live.version_id, mtime: 3000, size: bytes.length, sha256: await sidDigest(live.sids) });
  const twin = await r.server.publish({ fileId: LOW, path: PATH, bytes, mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await r.server.publishTombstone({ fileId: LOW, path: PATH, parents: [], manifestKey: r.keys.manifestKey });
  assert.equal((await r.transport.getFile(LOW)).heads.length, 2);
  await applyChange(r.context, twin);
  assert.equal(r.state.fileByPath(PATH).fileId, HIGH);
  assert.equal(r.server.files.get(HIGH).versions[0].deleted, false);
});
