import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig, DEVICE_B, SECRET_B } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile, reviveFile } = require("../build/sync/push.js");
const PATH = "Notes/Kept.md";

for (const published of [false, true]) {
  test(`delete-versus-${published ? "published" : "unpublished"}-edit consumes the deletion and stays settled after replay (#178)`, async () => {
    const r = await rig();
    r.host.seed(PATH, "base\n", 1000);
    const base = await pushFile(r.context, PATH);
    r.host.seed(PATH, "edit wins\n", 2000);
    if (published) await pushFile(r.context, PATH);
    const parent = r.state.fileByPath(PATH).versionId;
    const deletion = await r.server.publishTombstone({ fileId: base.fileId, path: PATH, parents: [base.versionId], manifestKey: r.keys.manifestKey });
    await applyChange(r.context, deletion);
    const file = r.server.files.get(base.fileId);
    assert.equal(file.heads.length, 1);
    const tip = file.versions.find(v => v.version_id === file.heads[0]);
    assert.deepEqual(new Set(tip.parents), new Set([parent, deletion.version_id]));
    assert.equal(tip.deleted, false);
    assert.ok(file.versions.some(v => v.version_id === deletion.version_id && v.deleted));
    assert.equal(r.host.text(PATH), "edit wins\n");
    assert.deepEqual(r.host.notices, []);
    const count = r.server.journal.length;
    r.context.refused.clear();
    await applyChange(r.context, deletion);
    assert.equal(r.server.journal.length, count, "replayed deletion creates no second settlement");
    r.host.seed(PATH, "a later edit\n", 3000);
    await pushFile(r.context, PATH);
    assert.equal(file.heads.length, 1);
    assert.deepEqual(r.host.notices, []);
  });
}

test("settling a deletion does not claim to incorporate another device's unseen edit (#178)", async () => {
  const r = await rig();
  r.host.seed(PATH, "base\n", 1000);
  const base = await pushFile(r.context, PATH);
  r.host.seed(PATH, "local edit\n", 2000);
  const unseen = await r.server.publish({ fileId: base.fileId, path: PATH, parents: [base.versionId], bytes: new TextEncoder().encode("unseen edit\n"), mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const deletion = await r.server.publishTombstone({ fileId: base.fileId, path: PATH, parents: [base.versionId], manifestKey: r.keys.manifestKey });
  await applyChange(r.context, deletion);
  const file = r.server.files.get(base.fileId);
  assert.ok(file.heads.includes(unseen.version_id), "an unseen edit was silently absorbed");
  assert.ok(!file.heads.includes(deletion.version_id));
  assert.equal(file.heads.length, 2);
});

test("two devices reviving identical edits publish one settlement (#178)", async () => {
  const a = await rig(), b = await rig();
  a.server.addDevice(DEVICE_B, SECRET_B);
  b.transport.options.request = a.server.request;
  b.transport.options.device = () => ({ id: DEVICE_B, secret: new Uint8Array(Buffer.from(SECRET_B, "hex")) });
  b.context.deviceId = DEVICE_B;
  a.host.seed(PATH, "base\n", 1000);
  const base = await pushFile(a.context, PATH);
  b.state.setFile(PATH, { ...a.state.fileByPath(PATH) });
  a.host.seed(PATH, "same edit\n", 2000); b.host.seed(PATH, "same edit\n", 2000);
  const deletion = await a.server.publishTombstone({ fileId: base.fileId, path: PATH, parents: [base.versionId], manifestKey: a.keys.manifestKey });
  const outcomes = await Promise.all([reviveFile(a.context, PATH, deletion.version_id), reviveFile(b.context, PATH, deletion.version_id)]);
  assert.equal(outcomes[0].versionId, outcomes[1].versionId);
  assert.equal(a.server.files.get(base.fileId).heads.length, 1);
});

test("a failed startup publication does not cancel the revival waiting behind it (#178)", async () => {
  const r = await rig(); r.host.seed(PATH, "base\n", 1000);
  const base = await pushFile(r.context, PATH);
  const deletion = await r.server.publishTombstone({ fileId: base.fileId, path: PATH, parents: [base.versionId], manifestKey: r.keys.manifestKey });
  r.host.seed(PATH, "edit\n", 2000);
  const original = r.transport.postVersion.bind(r.transport);
  let release, started, first = true;
  const arrived = new Promise(resolve => { started = resolve; });
  r.transport.postVersion = async (...args) => {
    if (first) { first = false; started(); await new Promise(resolve => { release = resolve; }); throw new Error("injected failed startup post"); }
    return original(...args);
  };
  const posting = pushFile(r.context, PATH);
  await arrived;
  const reviving = reviveFile(r.context, PATH, deletion.version_id);
  const results = Promise.allSettled([posting, reviving]); release();
  const [failed, kept] = await results;
  assert.equal(failed.status, "rejected"); assert.equal(kept.status, "fulfilled");
  assert.equal(r.server.files.get(base.fileId).heads.length, 1);
  assert.equal(r.host.text(PATH), "edit\n");
});

test("a completed publication cannot let a new post overtake a queued revival (#178)", async () => {
  const r = await rig(); r.host.seed(PATH, "base\n", 1000);
  const base = await pushFile(r.context, PATH);
  const deletion = await r.server.publishTombstone({ fileId: base.fileId, path: PATH, parents: [base.versionId], manifestKey: r.keys.manifestKey });
  r.host.seed(PATH, "edit\n", 2000);
  const post = r.transport.postVersion.bind(r.transport);
  let firstStarted, secondStarted, releaseFirst, releaseSecond, count = 0, active = 0, maximum = 0;
  const first = new Promise(resolve => { firstStarted = resolve; });
  const second = new Promise(resolve => { secondStarted = resolve; });
  r.transport.postVersion = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    const n = ++count;
    if (n === 1) { firstStarted(); await new Promise(resolve => { releaseFirst = resolve; }); }
    if (n === 2) { secondStarted(); await new Promise(resolve => { releaseSecond = resolve; }); }
    try { return await post(...args); } finally { active--; }
  };
  const one = pushFile(r.context, PATH, true); await first;
  const two = reviveFile(r.context, PATH, deletion.version_id);
  const three = pushFile(r.context, PATH, true);
  releaseFirst(); await second;
  const four = pushFile(r.context, PATH, true);
  await new Promise(resolve => setImmediate(resolve));
  releaseSecond(); await Promise.all([one, two, three, four]);
  assert.equal(maximum, 1, "a later post bypassed the queued revival");
  assert.equal(r.server.files.get(base.fileId).heads.length, 1);
});

test("a deferred settlement describes an already-published edit truthfully and retries quietly (#178)", async () => {
  const r = await rig(); r.host.seed(PATH, "base\n", 1000);
  const base = await pushFile(r.context, PATH);
  r.host.seed(PATH, "published edit\n", 2000); await pushFile(r.context, PATH);
  const deletion = await r.server.publishTombstone({ fileId: base.fileId, path: PATH, parents: [base.versionId], manifestKey: r.keys.manifestKey });
  const read = r.host.read.bind(r.host);
  r.host.read = async path => { const bytes = await read(path); r.host.seed(path, "newer edit\n", 3000); return bytes; };
  await applyChange(r.context, deletion);
  assert.equal(r.host.notices.length, 1);
  assert.match(r.host.notices[0], /already on the server/);
  r.host.read = read;
  await applyChange(r.context, deletion);
  assert.equal(r.server.files.get(base.fileId).heads.length, 1);
  assert.equal(r.host.notices.length, 1, "successful retry adds no notice");
});
