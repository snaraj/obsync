/**
 * One folder, one record (issue #375).
 *
 * A folder's file id is derived from the path it was first published at, and
 * a re-case the pull applies moves its record, and every record beneath it,
 * to the new spelling with the id it had (`recaseFolder`). Renamed back here,
 * the child's record was written again under the original spelling -- with
 * the same id -- beside the one the re-case had moved. The stale key was then
 * a folder the vault no longer shows, and a reconcile pass owes a removal for
 * it: a tombstone for the LIVE child's id, which every other device obeys.
 * The state now holds one key per id, and a file saved with two is healed when
 * it is read.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SCAN_MS, SyncEngine } = require("../build/sync/engine.js");
const { pushFile, pushFolder } = require("../build/sync/push.js");
const { parseData } = require("../build/state.js");

const NOTE = "Parent/Child/Note.md";

/** Each id the device records a folder under, with the keys holding it. */
const keysById = (state) => {
  const ids = new Map();
  for (const [path, record] of Object.entries(state.data.folders)) ids.set(record.fileId, [...ids.get(record.fileId) ?? [], path]);
  return ids;
};

const live = (server, fileId) => {
  const file = server.files.get(fileId);
  return file.heads.length === 1 && file.versions.find((version) => version.version_id === file.heads[0])?.deleted === false;
};

test("a parent re-cased by the pull and renamed back here leaves one record per folder, under the new spelling (#375)", async (t) => {
  // The desktop folds case; the device that published the lower-case
  // spelling keeps the two apart, as the issue's removed device did.
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: true });
  a.host.makeFolder("Parent/Child");
  a.host.write(NOTE, "a note under the child folder\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(NOTE) !== undefined && settled(a, NOTE));
  await timers.run(SCAN_MS);
  const child = a.state.folderByPath("Parent/Child").fileId;

  // Force sync's two records: the other device's `parent` re-cases the desktop's folder.
  b.host.makeFolder("parent");
  await timers.run(STEP_MS, () => a.state.folderByPath("parent") !== undefined);
  assert.equal(a.state.folderByPath("parent/Child")?.fileId, child, "the re-case did not carry the child's record");

  // The user puts the capitals back in the file explorer.
  a.host.renameFolder("parent", "Parent");
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  const held = keysById(a.state);
  assert.deepEqual([...held.values()].filter((paths) => paths.length > 1), [], `one id under two keys: ${JSON.stringify(a.state.data.folders)}`);
  assert.deepEqual(held.get(child), ["Parent/Child"], JSON.stringify(a.state.data.folders));
  assert.deepEqual(Object.keys(a.state.data.folders).sort(), ["Parent", "Parent/Child"]);
  assert.ok(a.host.logs.some((line) => /^folder path_class=folder decision=forgot reason=same_file_id count=1 file=[0-9a-f]{32}$/.test(line)),
    "forgetting the stale key said nothing");

  // AND A RECONCILE AFTER IT RETIRES NOTHING LIVE: the pass owed a removal
  // for every recorded folder the vault does not show.
  const versions = server.files.get(child).versions.length;
  await a.engine.syncNow();
  await timers.run(SCAN_MS);
  assert.equal(server.files.get(child).versions.length, versions, "the reconcile posted a version for the child's id");
  assert.ok(live(server, child), "the child folder's record on the server is a tombstone");
  assert.deepEqual(a.state.data.folderRemovals, {}, "a removal is still owed");
  assert.equal(a.state.folderByPath("Parent/Child")?.versionId, server.files.get(child).heads[0]);
});

test("a saved file holding one folder under two spellings is read back with one, the later, and the next start retires nothing (#375)", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.host.seed(NOTE, "a note under the child folder\n", 1000);
  await pushFolder(r.context, "Parent");
  await pushFolder(r.context, "Parent/Child");
  await pushFile(r.context, NOTE);
  const child = r.state.folderByPath("Parent/Child");
  // What a 1.1.12 desktop saved after the issue's sequence: the stale
  // spelling first, the live one written after it, one id.
  r.state.data.folders = { "parent/Child": { ...child }, Parent: r.state.folderByPath("Parent"), "Parent/Child": child };
  await r.state.save();

  const state = await r.reload();
  assert.deepEqual(Object.keys(state.data.folders), ["Parent", "Parent/Child"], "the stale key survived the load");
  assert.deepEqual(state.data.folders["Parent/Child"], child, "the live record changed");
  assert.equal(state.healedFolders, 1);

  const versions = r.server.files.get(child.fileId).versions.length;
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport: r.transport, host: r.host, now: () => r.host.clock, timers });
  t.after(() => engine.stop());
  await engine.start();
  await engine.syncNow();
  await timers.run(SCAN_MS);
  assert.ok(r.host.logs.includes("folder path_class=folder decision=forgot reason=same_file_id at=load count=1"), "the healed load said nothing");
  assert.equal(r.server.files.get(child.fileId).versions.length, versions, "the start posted a version for the folder's id");
  assert.ok(live(r.server, child.fileId), "the folder's record on the server is a tombstone");
  assert.deepEqual(Object.keys(state.data.folders).sort(), ["Parent", "Parent/Child"]);
  assert.equal(state.healedFolders, 0, "the heal is said once");
});

test("the load keeps every folder whose id is its own, and the later of two keys for one id", () => {
  const record = (fileId, versionId) => ({ fileId: fileId.repeat(32), versionId: versionId.repeat(64) });
  const healed = [];
  const data = parseData({ folders: { a: record("1", "a"), B: record("2", "b"), "B/c": record("3", "c"), A: record("1", "d") } }, false, healed);
  assert.deepEqual(data.folders, { B: record("2", "b"), "B/c": record("3", "c"), A: record("1", "d") });
  assert.deepEqual(healed, ["a"]);
  const none = [];
  assert.deepEqual(Object.keys(parseData({ folders: { a: record("1", "a"), b: record("2", "a") } }, false, none).folders), ["a", "b"]);
  assert.deepEqual(none, []);
});

test("a re-case received and a rename made here move the same folders: the folder, every depth beneath it, and no sibling sharing its prefix (#375)", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: true });
  const DEEP = "Parent/Child/Grand/Note.md";
  a.host.makeFolder("Parent/Child/Grand");
  a.host.write(DEEP, "a note three folders down\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(DEEP) !== undefined && settled(a, DEEP));
  // A sibling whose name starts with the spelling the re-case gives the parent.
  a.host.makeFolder("parent notes");
  await timers.run(STEP_MS, () => a.state.folderByPath("parent notes") !== undefined);
  await timers.run(SCAN_MS);
  const sibling = a.state.folderByPath("parent notes");
  const siblingVersions = server.files.get(sibling.fileId).versions.length;
  const ids = Object.fromEntries(["Parent", "Parent/Child", "Parent/Child/Grand"].map((path) => [path, a.state.folderByPath(path).fileId]));

  // RECEIVED: every record at and beneath the folder takes the new spelling, with its id.
  b.host.makeFolder("parent");
  await timers.run(STEP_MS, () => a.state.folderByPath("parent") !== undefined);
  assert.deepEqual(Object.keys(a.state.data.folders).sort(), ["parent", "parent notes", "parent/Child", "parent/Child/Grand"]);
  assert.equal(a.state.folderByPath("parent/Child").fileId, ids["Parent/Child"]);
  assert.equal(a.state.folderByPath("parent/Child/Grand").fileId, ids["Parent/Child/Grand"]);

  // MADE HERE, before any reconcile pass could cover for it: the same three,
  // each under its own id and live, and the sibling untouched.
  const renamed = timers.now;
  a.host.renameFolder("parent", "Parent");
  await timers.run(STEP_MS, () => ["Parent", "Parent/Child", "Parent/Child/Grand"].every((path) => a.state.folderByPath(path) !== undefined)
    && !Object.keys(a.state.data.folders).some((path) => path.startsWith("parent/")));
  assert.ok(timers.now - renamed < SCAN_MS, `the folders beneath were moved by a reconcile pass, ${timers.now - renamed} ms on, not by the rename`);
  assert.deepEqual(Object.keys(a.state.data.folders).sort(), ["Parent", "Parent/Child", "Parent/Child/Grand", "parent notes"],
    JSON.stringify(a.state.data.folders));
  for (const path of ["Parent/Child", "Parent/Child/Grand"]) {
    assert.equal(a.state.folderByPath(path).fileId, ids[path]);
    assert.ok(live(server, ids[path]), `${path} was left retired`);
  }
  assert.equal(server.files.get(sibling.fileId).versions.length, siblingVersions, "the rename touched the sibling");
  assert.deepEqual(a.state.folderByPath("parent notes"), sibling);
});
