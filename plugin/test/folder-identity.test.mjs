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
 * A write now holds one key per id. A file saved with two keeps both until
 * the vault says which folder it shows: never by the order the file lists
 * them in, and never with a removal for an id another key holds.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, STEP_MS, pair, rig, settled } from "./fake.mjs";

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

/** Every version a device posted after `mark`, by id, newest last. */
const postedSince = (server, mark, deviceId = KEYS.deviceId) => [...server.files].flatMap(([fileId, file]) => file.versions
  .filter((version) => version.seq > mark && version.device_id === deviceId)
  .map((version) => ({ fileId, deleted: version.deleted })));

/**
 * What a 1.1.12 desktop could save: the child folder under two spellings with
 * one id. The stale key comes FIRST as the #375 sequence writes it, or LAST
 * once a capitals-only rename made while sync was not running -- in the file
 * manager, with Obsidian closed -- turns the earlier key into the one the
 * vault shows: nothing is written then, so the order stays. `disk` is the
 * vault before the plugin starts again. Answers the reloaded state and its
 * engine after the first reconcile pass.
 */
async function savedTwice(t, { caseSensitive, order, disk = () => undefined }) {
  const r = await rig({ caseSensitive });
  r.host.seed(NOTE, "a note under the child folder\n", 1000);
  await pushFolder(r.context, "Parent");
  await pushFolder(r.context, "Parent/Child");
  await pushFile(r.context, NOTE);
  const parent = r.state.folderByPath("Parent");
  const child = r.state.folderByPath("Parent/Child");
  const live = [["Parent", parent], ["Parent/Child", child]];
  const stale = ["parent/Child", { ...child }];
  r.state.data.folders = Object.fromEntries(order === "last" ? [...live, stale] : [stale, ...live]);
  await r.state.save();
  disk(r.host);
  const mark = r.server.seq;
  const ids = r.server.files.size;
  const state = await r.reload();
  assert.deepEqual(Object.keys(state.data.folders), Object.keys(r.state.data.folders), "the load dropped or moved a key");
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport: r.transport, host: r.host, now: () => r.host.clock, timers });
  t.after(() => engine.stop());
  await engine.start();
  await engine.syncNow();
  await timers.run(SCAN_MS);
  return { ...r, state, engine, timers, child, mark, ids };
}

/** A folder renamed where no event reports it, as one renamed while Obsidian was closed: its files and its own entry. */
function respell(host, from, to) {
  const under = (path) => path === from || path.startsWith(`${from}/`);
  for (const path of [...host.files.keys()].filter(under)) {
    host.files.set(to + path.slice(from.length), host.files.get(path));
    host.files.delete(path);
  }
  for (const path of [...host.explicitFolders].filter(under)) {
    host.explicitFolders.delete(path);
    host.explicitFolders.add(to + path.slice(from.length));
  }
}

/** One folder id under two keys was settled with nothing sent for it, and no folder published under a new id. */
function nothingSent(r, label) {
  assert.deepEqual(postedSince(r.server, r.mark).filter(({ fileId }) => fileId === r.child.fileId), [], `${label}: a version was posted for the shared id`);
  assert.ok(live(r.server, r.child.fileId), `${label}: the folder's record on the server is a tombstone`);
  assert.equal(r.server.files.size, r.ids, `${label}: a folder was published under a new id`);
}

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

for (const caseSensitive of [false, true]) {
  for (const order of ["first", "last"]) {
    test(`a saved file with the stale spelling ${order}, on a host that ${caseSensitive ? "keeps capitals apart" : "folds them"}: ` +
      "the first reconcile keeps the folder the vault shows, under its id, and sends nothing (#375)", async (t) => {
      const r = await savedTwice(t, { caseSensitive, order });
      nothingSent(r, `stale ${order}`);
      assert.deepEqual(Object.keys(r.state.data.folders).sort(), ["Parent", "Parent/Child"], JSON.stringify(r.state.data.folders));
      assert.deepEqual(r.state.folderByPath("Parent/Child"), r.child, "the live folder's record changed");
      assert.deepEqual(r.state.data.folderRemovals, {}, "a removal is still owed");
      assert.ok(r.host.logs.includes(`folder path_class=folder decision=forgot reason=same_file_id at=removal file=${r.child.fileId}`),
        "forgetting the stale key said nothing");
    });
  }
}

test("the load keeps every folder key it reads, in the file's order, two keys for one id included (#375)", () => {
  const record = (fileId, versionId) => ({ fileId: fileId.repeat(32), versionId: versionId.repeat(64) });
  const folders = { a: record("1", "a"), B: record("2", "b"), "B/c": record("3", "c"), A: record("1", "d") };
  const data = parseData({ folders }, false);
  assert.deepEqual(data.folders, folders);
  assert.deepEqual(Object.keys(data.folders), ["a", "B", "B/c", "A"]);
});

test("two folders this vault shows, saved under one id: both kept and nothing sent, said once; deleting one sends nothing (#375)", async (t) => {
  const r = await rig({ caseSensitive: true });
  r.host.seed("Notes/One.md", "a note\n", 1000);
  await pushFolder(r.context, "Notes");
  await pushFile(r.context, "Notes/One.md");
  const notes = r.state.folderByPath("Notes");
  // A host that keeps capitals apart holds both, and the file names both with one id.
  r.host.explicitFolders.add("notes");
  r.state.data.folders = { Notes: notes, notes: { ...notes } };
  await r.state.save();
  const mark = r.server.seq;
  const ids = r.server.files.size;
  const state = await r.reload();
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport: r.transport, host: r.host, now: () => r.host.clock, timers });
  t.after(() => engine.stop());
  await engine.start();
  await engine.syncNow();
  await engine.syncNow();
  await timers.run(SCAN_MS);
  assert.deepEqual(postedSince(r.server, mark), [], "the device posted a version");
  assert.equal(r.server.files.size, ids);
  assert.deepEqual(state.data.folders, { Notes: notes, notes }, "a key was forgotten or changed");
  assert.ok(r.host.logs.includes(`reconcile path_class=folder decision=held reason=same_file_id shown=2 count=2 file=${notes.fileId}`));
  const said = r.host.notices.filter((text) => text.includes("saved as one folder"));
  assert.deepEqual(said, ['obsync: "Notes" and "notes" are saved as one folder, but this vault has them as separate folders. ' +
    "Nothing was removed on your other devices. Rename or delete all but one of them here, and obsync keeps the one left."],
  "not said exactly once");

  // The way out the notice names: one of them goes, and the other keeps the id.
  r.host.explicitFolders.delete("notes");
  engine.folderDeleted("notes");
  await timers.run(STEP_MS, () => state.folderByPath("notes") === undefined);
  await engine.syncNow();
  await timers.run(SCAN_MS);
  assert.deepEqual(postedSince(r.server, mark), [], "deleting one of the two posted a version");
  assert.ok(live(r.server, notes.fileId));
  assert.deepEqual(state.data.folders, { Notes: notes });
  assert.deepEqual(state.data.folderRemovals, {});
});

test("a saved file whose two spellings this vault shows neither of: both kept, nothing removed or published, said once; renamed back, it settles (#375)", async (t) => {
  // Renamed by capitals alone while Obsidian was closed: a third spelling.
  const r = await savedTwice(t, { caseSensitive: false, order: "last", disk: (host) => respell(host, "Parent/Child", "Parent/CHILD") });
  nothingSent(r, "neither shown");
  assert.deepEqual(Object.keys(r.state.data.folders).sort(), ["Parent", "Parent/Child", "parent/Child"], "a key was forgotten");
  assert.deepEqual(r.state.data.folderRemovals, {});
  assert.ok(r.host.logs.includes(`reconcile path_class=folder decision=held reason=same_file_id shown=0 count=2 file=${r.child.fileId}`));
  assert.ok(r.host.logs.includes("reconcile path_class=folder decision=held reason=same_file_id"), "the new spelling's hold said nothing");
  await r.engine.syncNow();
  await r.timers.run(SCAN_MS);
  const said = r.host.notices.filter((text) => text.includes("under none of those names"));
  assert.deepEqual(said, ['obsync: the folder saved as "Parent/Child" and "parent/Child" is in this vault under none of those names, ' +
    "so nothing was removed on your other devices. Rename it back to one of them, and obsync keeps that one."], "not said exactly once");

  // The way out the notice names.
  respell(r.host, "Parent/CHILD", "Parent/Child");
  await r.engine.syncNow();
  await r.timers.run(SCAN_MS);
  nothingSent(r, "renamed back");
  assert.deepEqual(Object.keys(r.state.data.folders).sort(), ["Parent", "Parent/Child"]);
  assert.deepEqual(r.state.folderByPath("Parent/Child"), r.child);
});

test("a re-case received, reconciled at once, retires nothing and publishes nothing new (#375)", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: true });
  a.host.makeFolder("Parent/Child");
  a.host.write(NOTE, "a note under the child folder\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(NOTE) !== undefined && settled(a, NOTE));
  await timers.run(SCAN_MS);
  const child = a.state.folderByPath("Parent/Child").fileId;
  b.host.makeFolder("parent");
  await timers.run(STEP_MS, () => a.state.folderByPath("parent") !== undefined);
  // The re-case wrote the moved keys, and the old spellings' are gone.
  assert.deepEqual(Object.keys(a.state.data.folders).sort(), ["parent", "parent/Child"]);
  const mark = server.seq;
  await a.engine.syncNow();
  await timers.run(SCAN_MS);
  assert.deepEqual(postedSince(server, mark), [], "the reconcile after the re-case posted a version");
  assert.equal(a.state.folderByPath("parent/Child")?.fileId, child);
  assert.ok(live(server, child));
  assert.deepEqual(a.state.data.folderRemovals, {});
});

test("a rename made here, reconciled at once, leaves every folder live under the id it holds, and nothing under a new one (#375)", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: true });
  a.host.makeFolder("Parent/Child");
  a.host.write(NOTE, "a note under the child folder\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(NOTE) !== undefined && settled(a, NOTE));
  await timers.run(SCAN_MS);
  const child = a.state.folderByPath("Parent/Child").fileId;
  b.host.makeFolder("parent");
  await timers.run(STEP_MS, () => a.state.folderByPath("parent") !== undefined);
  const known = new Set(server.files.keys());
  const mark = server.seq;

  a.host.renameFolder("parent", "Parent");
  await a.engine.syncNow();
  await timers.run(SCAN_MS);
  const posted = postedSince(server, mark);
  assert.deepEqual(posted.filter(({ fileId }) => !known.has(fileId) && fileId !== a.state.folderByPath("Parent")?.fileId), [],
    `a folder was published under a new id: ${JSON.stringify(posted)}`);
  assert.deepEqual(Object.keys(a.state.data.folders).sort(), ["Parent", "Parent/Child"], JSON.stringify(a.state.data.folders));
  assert.equal(a.state.folderByPath("Parent/Child").fileId, child, "the child's id changed");
  for (const [path, record] of Object.entries(a.state.data.folders)) {
    assert.ok(live(server, record.fileId), `${path} was left retired`);
    assert.deepEqual(server.files.get(record.fileId).heads, [record.versionId], `${path}'s record is not the server's head`);
  }
  assert.deepEqual(a.state.data.folderRemovals, {});
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
