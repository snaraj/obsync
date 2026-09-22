/**
 * One position, one version: the device half of issue #114.
 *
 * Two devices that resolve the same two heads to the same bytes post the same
 * parents and the same chunk list and get two version ids, because the id
 * covers the encrypted manifest and its nonce. The second frame says nothing
 * the first did not, and it forks the file, so another merge has to close it.
 * From 1.0.7 a post may promise to store the id it is answered with, and the
 * server answers such a post with the version it already holds at that
 * position.
 *
 * THE PROMISE IS NOT UNCONDITIONAL, and that is what most of this file is
 * about. The server's identity for a position is `(file_id, parent set, sids
 * in order, tombstone flag)`; it does NOT cover the manifest, which is where
 * the PATH lives. A post whose only new fact is inside that manifest -- a
 * rename -- must not offer the promise, or two devices renaming one note from
 * one version are answered with each other's id, record it, drop each other's
 * frame as their own echo, and keep two different paths for one file id with
 * no version left that could settle it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { DEVICE_B, FakeTimers, KEYS, STEP_MS, keys as vaultKeys, pair, published, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const dm = require("../build/domainmap.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const NOTE = "Notes/Dedupe.md";
const MINE = "what this device wrote\n";

/** The versions the server holds for a file id, oldest first. */
const ids = (server, fileId) =>
  [...(server.files.get(fileId)?.versions ?? [])].reverse().map((version) => version.version_id);

test("a post the server already holds is recorded under the id it answers with", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  const first = r.state.fileByPath(NOTE);

  // The same file, posted again from the same parents with the same chunks --
  // what a second device's identical resolution of one position looks like --
  // with this device's own record cleared so the push really posts.
  r.state.setFile(NOTE, { ...first, sha256: "", versionId: first.versionId });
  const again = await pushFile(r.context, NOTE, true);

  assert.equal(again.status, "pushed");
  assert.deepEqual(r.server.deduplicated, [], "a rename-shaped post was deduplicated");

  // And now the honest #114 shape: same parents, same sids, same path.
  const parents = [first.versionId];
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: parents[0], sha256: "" });
  const twin = await pushFile(r.context, NOTE);

  assert.equal(r.server.deduplicated.length, 1, "the twin was written as a second version");
  assert.equal(twin.versionId, r.server.deduplicated[0].existing, "the answer's id was not recorded");
  assert.equal(r.state.fileByPath(NOTE).versionId, twin.versionId);
  assert.notEqual(twin.versionId, r.server.deduplicated[0].posted, "the posted id was kept anyway");
});

test("a server that sends no version_id leaves the computed id in place", async () => {
  const r = await rig();
  // A server before 1.0.7: it answers a post without naming the version it
  // stored, so the device keeps the id it computed itself and nothing about
  // today's behaviour changes.
  r.server.oldServer = true;
  r.host.seed(NOTE, MINE, 2000);

  const outcome = await pushFile(r.context, NOTE);

  assert.equal(outcome.status, "pushed");
  assert.deepEqual(ids(r.server, outcome.fileId), [outcome.versionId], "the id posted is not the id stored");
  assert.equal(r.state.fileByPath(NOTE).versionId, outcome.versionId);
});

test("a rename is never deduplicated, so both devices still learn the new name", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  const record = r.state.fileByPath(NOTE);
  const RENAMED = "Notes/Dedupe renamed.md";

  // Another device renamed the same note from the same version first: same
  // parents, same chunks, a different path, which the server's key cannot
  // see. This device's own rename must still land as a version of its own.
  const theirs = await r.server.publish({
    fileId: record.fileId, path: "Notes/Their name.md", bytes: enc(MINE), mtime: 3000,
    parents: [record.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    deviceId: DEVICE_B,
  });
  r.host.files.set(RENAMED, r.host.files.get(NOTE));
  r.host.files.delete(NOTE);
  r.state.setFile(RENAMED, { ...record, mtime: -1, sha256: "" });
  r.state.forgetPath(NOTE);

  const outcome = await pushFile(r.context, RENAMED, true);

  assert.deepEqual(r.server.deduplicated, [], "the rename was answered with another device's version");
  assert.notEqual(outcome.versionId, theirs.version_id, "this device recorded the other one's rename");
  const walk = await published(r.server, record.fileId, r.keys.manifestKey);
  assert.deepEqual(
    walk.map((manifest) => manifest.path),
    [NOTE, "Notes/Their name.md", RENAMED],
    "the published path walk lost a rename",
  );
});

test("a publish under an adopted file id that dedupes is adoption, and renames nothing", async () => {
  const r = await rig();
  const pushed = [];
  r.context.publish = async (path) => { pushed.push(path); await pushFile(r.context, path); };
  // The other device's note, adopted here byte for byte: this device now
  // tracks THEIR file id, so its own later push of that file posts under it,
  // and an answer naming a version of theirs is possible for the first time.
  r.host.seed(NOTE, MINE, 4000);
  const THEIRS = "ff".repeat(16);
  const frame = await r.server.publish({
    fileId: THEIRS, path: NOTE, bytes: enc(MINE), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, frame), "applied");
  assert.equal(r.state.fileByPath(NOTE).fileId, THEIRS, "the fixture did not adopt the version");

  // The other device appends a line and publishes it. Before that version
  // reaches this device, the user makes the SAME edit here -- one position,
  // one content, two devices -- and this device pushes it.
  const EDITED = `${MINE}a second line\n`;
  const next = await r.server.publish({
    fileId: THEIRS, path: NOTE, bytes: enc(EDITED), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  r.host.seed(NOTE, EDITED, 5000);

  const outcome = await pushFile(r.context, NOTE);

  assert.equal(r.server.deduplicated.length, 1, "the identical content was posted as a new version");
  assert.equal(outcome.versionId, next.version_id, "the answer was not recorded as the version held");
  assert.equal(r.state.fileByPath(NOTE).versionId, next.version_id);
  assert.deepEqual(ids(r.server, THEIRS), [frame.version_id, next.version_id], "a third version was written");
  assert.deepEqual(pushed, [], "publishing was asked for at all");
  assert.equal(r.host.text(NOTE), EDITED, "the note was moved or rewritten");

  // And the other device's own frame for that version now arrives. This
  // device holds that very version id, so the frame is skipped: nothing is
  // written, nothing is copied beside it and nothing is renamed. Under the
  // engine it does not even reach that test, because the engine records the
  // id it was ANSWERED with in `authored` and drops the frame as this
  // device's own echo (`engine.ts`).
  assert.equal(await applyChange(r.context, next), "skipped");
  assert.equal(r.host.text(NOTE), EDITED);
  assert.deepEqual(
    [...r.host.files.keys()].filter((path) => path.includes("(conflict from")), [],
    "a copy was made of a version this device already holds",
  );
});

/**
 * The case the issue is named for, on two real engines.
 *
 * Both devices fork the same note, both resolve the fork, and the resolution
 * is the same text on both sides -- so both post the same parents and the
 * same chunk. The two merges are held until both have been computed, because
 * the point is what happens when neither device can see the other's merge
 * before making its own: that is when the file forks a second time and a
 * third version has to close it. With the promise, the second merge is
 * answered with the first one's version, both devices record THAT id, and the
 * file has one head and no closing version.
 */
test("two engines that merge one note identically end on ONE version", async (t) => {
  const { server, timers, a, b } = await pair(t);
  const SHARED = "Shared.md";
  // Two edits in DIFFERENT hunks, which is the concurrent edit the merge
  // exists for: each device keeps the other's hunk and its own, and the walk
  // over the unchanged anchors between them is the same on both sides, so
  // both devices produce the same merged text byte for byte. (Two edits to
  // the SAME hunk are an overlap, not a merge, and are kept apart instead.)
  const BASE = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
  const MINE = "ALPHA\nbeta\ngamma\ndelta\nepsilon\n";
  const THEIRS = "alpha\nbeta\ngamma\ndelta\nEPSILON\n";
  const MERGED = "ALPHA\nbeta\ngamma\ndelta\nEPSILON\n";

  a.host.write(SHARED, BASE, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(SHARED) === BASE && settled(b, SHARED));
  const fileId = a.state.fileByPath(SHARED).fileId;

  // Hold every merge post -- a version with two parents -- until both devices
  // have made one, so each computes its merge with the other's nowhere in
  // sight. That is the only ordering where the second merge has to be
  // recognised rather than merely skipped, and it is the one the issue
  // describes. The wrapper goes on each device's own transport, because the
  // engines captured it when they were built.
  const held = [];
  let opened = false;
  for (const device of [a, b]) {
    const postVersion = device.transport.postVersion.bind(device.transport);
    device.transport.postVersion = async (fileId, version) => {
      if (version.parents.length === 2 && !opened) {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        held.push(release);
        if (held.length === 2) {
          opened = true;
          for (const open of held) open();
        }
        await gate;
      }
      return postVersion(fileId, version);
    };
  }

  a.engine.stop();
  b.engine.stop();
  a.host.write(SHARED, MINE, 2000);
  b.host.write(SHARED, THEIRS, 3000);
  await a.engine.start();
  await timers.run(STEP_MS, () => server.files.get(fileId).versions.length >= 2);
  await b.engine.start();
  await timers.run(STEP_MS, () => held.length === 2);
  await timers.run(STEP_MS, () =>
    a.host.text(SHARED) === MERGED && b.host.text(SHARED) === MERGED &&
    server.files.get(fileId).heads.length === 1);
  await timers.run(STEP_MS);

  const story = () => `desktop=${JSON.stringify(a.host.text(SHARED))} ` +
    `phone=${JSON.stringify(b.host.text(SHARED))} versions=${ids(server, fileId).length} ` +
    `deduplicated=${server.deduplicated.length}`;
  assert.equal(a.host.text(SHARED), b.host.text(SHARED), `the merge did not converge: ${story()}`);
  assert.equal(held.length, 2, `both devices did not merge without seeing each other: ${story()}`);
  assert.ok(
    server.deduplicated.length >= 1,
    `no merge was recognised as one the server already held: ${story()}`,
  );
  // One head, and both devices hold it: the second merge was answered with the
  // first one's version, so there was nothing left to close.
  assert.equal(server.files.get(fileId).heads.length, 1, `the file is still forked: ${story()}`);
  assert.equal(
    a.state.fileByPath(SHARED).versionId, b.state.fileByPath(SHARED).versionId,
    `the devices hold different version ids: ${story()}`,
  );
  assert.equal(
    a.state.fileByPath(SHARED).versionId, server.files.get(fileId).heads[0],
    `neither device holds the head: ${story()}`,
  );
  // Four versions and not five: the base, one per device, one merge.
  assert.equal(ids(server, fileId).length, 4, `a version was written to close the merge: ${story()}`);
});

/**
 * The domain map is never offered, and this is why.
 *
 * The server recognises "the same version at the same position" without ever
 * looking at the sealed body -- it cannot, the body is ciphertext. For a vault
 * file the key still says something, because the chunk list IS the content.
 * The map carries no chunks and is never a tombstone, so for that one file the
 * key is nothing but its parents: two devices writing DIFFERENT maps from one
 * parent would be answered with each other's version and each would record a
 * write that never happened. The map's whole content lives where the server
 * cannot look, so it is never offered for deduplication.
 */
test("two different domain maps from one parent are two versions", async () => {
  const r = await rig();
  const k = await vaultKeys();
  const map = (prefix) => ({ v: 1, domains: [{ id: KEYS.domainId, paths: [prefix] }] });
  const first = await dm.saveDomainMap(r.transport, k.map, map("Notes/"));
  const second = await dm.saveDomainMap(r.transport, k.map, map("Journal/"), [first]);
  // A third map from the SAME parent as the second: one position, two
  // different maps, and no chunk list that could tell them apart.
  const third = await dm.saveDomainMap(r.transport, k.map, map("Archive/"), [first]);

  assert.deepEqual(r.server.deduplicated, [], "a map write was answered with another map's version");
  assert.notEqual(third, second, "two different maps were given one version id");
  const stored = r.server.files.get(k.map.fileId).versions.map((version) => version.version_id);
  // The rig seeds a map before anything runs, so three writes make four.
  assert.equal(stored.length, 4, "a map write did not land as a version of its own");
  for (const id of [first, second, third]) {
    assert.ok(stored.includes(id), "a map this device wrote is not in the store");
  }
});

/**
 * THE REVIEWER'S OWN INPUT CASES for round 5's finding 5 (PR #120, comment
 * 5778412397), carried verbatim under this header. The offer is made by an
 * ordinary edit and matched against a RENAME another device stored earlier,
 * which the store's clear key cannot tell apart; the third case drives it
 * through a real engine, where the adopted id was then marked as this
 * device's own echo.
 */
async function assertRecordedPath(r, path) {
  const local = r.context.state.fileByPath(path);
  const version = r.server.files.get(local.fileId).versions.find(v => v.version_id === local.versionId);
  const binder = await c.contentVersionId(local.fileId, version.parents, version.sids);
  const manifest = JSON.parse(await c.decryptManifest(r.keys.manifestKey, local.fileId, binder,
    c.unhex(version.manifest_nonce), c.unbase64(version.manifest_ct)));
  console.log(JSON.stringify({localPath: path, recordedVersion: local.versionId, serverManifestPath: manifest.path,
    deduplicated: r.server.deduplicated.length, serverVersions: r.server.files.get(local.fileId).versions.length}));
  assert.equal(manifest.path, path, "a clean local record must not claim a version whose authenticated manifest names another path");
}

test("ordinary concurrent edit must not adopt another device's rename-and-edit manifest", async () => {
  const r = await rig();
  r.host.seed("Original.md", "base\n", 1000);
  await pushFile(r.context, "Original.md");
  const base = r.state.fileByPath("Original.md");
  const renamed = await r.server.publish({fileId: base.fileId, path: "Renamed.md", bytes: enc("edited\n"), mtime: 2000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey});
  r.host.seed("Original.md", "edited\n", 2000);
  await pushFile(r.context, "Original.md");
  await assertRecordedPath(r, "Original.md");
  const applied = await applyChange(r.context, renamed);
  console.log("later_rename_frame=" + applied);
});

test("a persisted unposted rename must retain the dedupe opt-out after state reload", async () => {
  const r = await rig();
  r.host.seed("Original.md", "body\n", 1000);
  await pushFile(r.context, "Original.md");
  const base = r.state.fileByPath("Original.md");
  const theirs = await r.server.publish({fileId: base.fileId, path: "Theirs.md", bytes: enc("body\n"), mtime: 2000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey});
  // The exact state shape SyncEngine.renamed() saves before dispatching its push.
  r.host.files.set("Mine.md", r.host.files.get("Original.md"));
  r.host.files.delete("Original.md");
  r.state.setFile("Mine.md", {...base, mtime: -1, sha256: ""});
  r.state.forgetPath("Original.md");
  await r.state.save();
  r.context.state = await r.reload();
  // A newly constructed engine has no transient renames set. Its startup
  // reconcile dispatches pushFile(context,path,false), as this call does.
  await pushFile(r.context, "Mine.md");
  await assertRecordedPath(r, "Mine.md");
});


test("startup engine does not label a foreign renamed manifest as its own echo", async () => {
  const r = await rig();
  r.host.seed("Original.md", "base\n", 1000);
  await pushFile(r.context, "Original.md");
  const base = r.state.fileByPath("Original.md");
  const renamed = await r.server.publish({fileId: base.fileId, path: "Renamed.md", bytes: enc("edited\n"), mtime: 2000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey});
  r.host.seed("Original.md", "edited\n", 2000);
  let releaseFeed;
  const feed = new Promise(resolve => { releaseFeed = resolve; });
  r.transport.changes = () => feed;
  const { SyncEngine } = require("../build/sync/engine.js");
  const engine = new SyncEngine({state:r.state,transport:r.transport,host:r.host,now:()=>r.host.clock,timers:new FakeTimers()});
  try {
    await engine.start();
    await engine.syncNow();
    r.context = engine.context;
    const foreignEcho = r.context.authored.has(renamed.version_id);
    const applied = await applyChange(r.context, renamed);
    console.log("engine_later_rename_frame=" + applied);
    assert.equal(foreignEcho, false, "a foreign rename must not be marked as this engine own already-applied version");
  } finally {
    engine.stop();
    releaseFeed({seq:r.state.data.lastSeq,head_seq:r.server.seq,changes:[]});
    await engine.stopAndWait();
  }
});
