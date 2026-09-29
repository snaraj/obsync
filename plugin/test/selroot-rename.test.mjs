/**
 * A SELECTED FOLDER RENAMED ON ITS DEVICE LEAVES NO EMPTY FOLDER ELSEWHERE
 * (issue #240; seen live on Windows during the 1.1.4 journeys, V4).
 *
 * Device A syncs a selection ["W201", "W201 sel"]; device B syncs the whole
 * vault. When A renames the SELECTED folder "W201 sel", its notes move on B,
 * no note is tombstoned and A's selection follows -- and the old folder's
 * record is retired too. Before the fix its tombstone was checked against the
 * selection AFTER the rename, which no longer names it, so it was refused
 * and B kept an empty "W201 sel" for good, as did any device paired later.
 *
 * The removal is published against the selection it was JUDGED in, and
 * nothing wider: a whole-vault judgement is the selection in force at the
 * post, and a selection the person narrows restarts the engine, whose own
 * pass judges the stale record against the narrower selection.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { STEP_MS, pair, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { folderFileId } = require("../build/crypto.js");
const { SyncEngine } = require("../build/sync/engine.js");

const ROOT = "W201";
const SEL = "W201 sel";
const RENAMED = "W201 sel renamed a231";
const NOTES = { "Kept A.md": "KEPT A SENTINEL\n", "Kept B.md": "KEPT B SENTINEL\n" };

const story = (server, a, b) =>
  [`journal=${server.journal.map((f) => `${f.seq}${f.deleted ? ":tomb" : ""}`).join(",")}`,
    `a_sel=${JSON.stringify(a.state.data.syncFolders)}`,
    `a_folders_rec=${JSON.stringify(Object.keys(a.state.data.folders))}`,
    `b_folders_rec=${JSON.stringify(Object.keys(b.state.data.folders))}`,
    `b_files=${JSON.stringify([...b.host.files.keys()])}`,
    `b_dirs=${JSON.stringify([...b.host.explicitFolders])}`,
    `a_logs=${JSON.stringify(a.host.logs.filter((l) => /folder|scope|push .*refus|failed/.test(l)).slice(-12))}`].join(" ");

/** The deleted frames, named by the folder paths given, or `other:<id>`. */
const deletedFrames = async (server, keys, paths) => {
  const ids = await Promise.all(paths.map((p) => folderFileId(keys.manifestKey, p)));
  return server.journal.filter((f) => f.deleted).map((f) => paths[ids.indexOf(f.file_id)] ?? `other:${f.file_id}`);
};

/** Does the server still hold a live record for this folder: what a device paired later would get? */
const liveOnServer = async (server, keys, path) => {
  const id = await folderFileId(keys.manifestKey, path);
  const frames = server.journal.filter((f) => f.file_id === id);
  return frames.length > 0 && !frames[frames.length - 1].deleted;
};

async function setup(t, notes = NOTES) {
  const rig = await pair(t, "immediate", { isMobileB: false });
  const { timers, a, b } = rig;
  a.state.data.syncFolders = [ROOT, SEL];
  a.plugin.log = (line) => a.host.logs.push(line);
  a.host.write(`${ROOT}/Other.md`, "OTHER SENTINEL\n", 1000);
  a.host.makeFolder(`${ROOT}/Sub`);
  a.host.write(`${ROOT}/Sub/Deep.md`, "DEEP SENTINEL\n", 1000);
  for (const [name, body] of Object.entries(notes)) a.host.write(`${SEL}/${name}`, body, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => Object.entries(notes).every(([name, body]) =>
    b.host.text(`${SEL}/${name}`) === body && settled(a, `${SEL}/${name}`) && settled(b, `${SEL}/${name}`)) &&
    b.state.folderByPath(SEL) !== undefined && b.state.folderByPath(`${ROOT}/Sub`) !== undefined);
  await timers.run(STEP_MS);
  const ids = Object.fromEntries(Object.keys(notes).map((name) => [name, a.state.fileByPath(`${SEL}/${name}`).fileId]));
  return { ...rig, ids };
}

/** Rename `from` -> `to` on A and check B mirrors it: notes moved, old folder gone everywhere. */
async function renameAndCheck({ server, timers, a, b, ids, keys }, from, to) {
  a.host.renameFolder(from, to);
  await timers.run(STEP_MS, () => Object.entries(NOTES).every(([name, body]) =>
    b.host.text(`${to}/${name}`) === body && settled(a, `${to}/${name}`) && settled(b, `${to}/${name}`)));
  // The folder tombstone follows the moves; stop waiting the moment it lands.
  try { await timers.run(STEP_MS, () => !b.host.hasFolder(from), 3000); } catch { /* asserted below */ }
  await timers.run(STEP_MS);
  const told = story(server, a, b);
  // The notes themselves moved: no tombstone for either note, same ids, same bytes.
  assert.deepEqual(server.journal.filter((f) => f.deleted && Object.values(ids).includes(f.file_id)), [], `a note was tombstoned: ${told}`);
  for (const [name, body] of Object.entries(NOTES)) {
    assert.equal(b.host.text(`${to}/${name}`), body, told);
    assert.equal(b.state.fileByPath(`${to}/${name}`).fileId, ids[name], told);
    assert.equal(b.host.text(`${from}/${name}`), null, told);
  }
  assert.deepEqual(a.state.data.syncFolders, [ROOT, to].sort(), `the selection did not follow: ${told}`);
  assert.equal(b.host.hasFolder(to), true, `the new folder never arrived on B: ${told}`);
  assert.equal(a.host.hasFolder(from), false, told);
  // THE DEFECT: B kept the renamed selected folder as an empty folder.
  assert.equal(b.host.hasFolder(from), false, `B kept the renamed selected folder "${from}" as an empty folder: ${told}`);
  assert.equal(b.state.folderByPath(from), undefined, `B still records "${from}": ${told}`);
  assert.equal(a.state.folderByPath(from), undefined, `A still records "${from}" (its tombstone was never sent): ${told}`);
  assert.equal(await liveOnServer(server, keys, from), false, `the server still serves "${from}" to a device paired later: ${told}`);
  assert.equal(a.host.logs.some((line) => line.includes("decision=not_synced reason=outside_sync_scope") && line.startsWith("push")), false, told);
}

test("a renamed selected folder leaves no empty folder on the whole-vault device", async (t) => {
  const r = await setup(t);
  await renameAndCheck(r, SEL, RENAMED);
});

test("and renaming it back leaves none either", async (t) => {
  const r = await setup(t);
  await renameAndCheck(r, SEL, RENAMED);
  await renameAndCheck(r, RENAMED, SEL);
});

test("control: a subfolder inside a selected folder renamed mirrors, old folder gone on B", async (t) => {
  const r = await setup(t);
  const { server, timers, a, b } = r;
  a.host.renameFolder(`${ROOT}/Sub`, `${ROOT}/Sub2`);
  await timers.run(STEP_MS, () => b.host.text(`${ROOT}/Sub2/Deep.md`) === "DEEP SENTINEL\n" && settled(b, `${ROOT}/Sub2/Deep.md`));
  try { await timers.run(STEP_MS, () => !b.host.hasFolder(`${ROOT}/Sub`), 3000); } catch { /* asserted below */ }
  assert.equal(b.host.hasFolder(`${ROOT}/Sub`), false, story(server, a, b));
});

test("hostile: a sibling selected folder is untouched; exactly one folder tombstone, the renamed folder's", async (t) => {
  const r = await setup(t);
  await renameAndCheck(r, SEL, RENAMED);
  const { server, a, b, keys } = r;
  assert.deepEqual(await deletedFrames(server, keys, [SEL, ROOT, `${ROOT}/Sub`]), [SEL], story(server, a, b));
  for (const kept of [ROOT, `${ROOT}/Sub`, RENAMED]) {
    assert.ok(b.state.folderByPath(kept), `B lost the record for ${kept}: ${story(server, a, b)}`);
    assert.ok(a.state.folderByPath(kept), `A lost the record for ${kept}`);
  }
  assert.equal(b.host.text(`${ROOT}/Other.md`), "OTHER SENTINEL\n");
});

test("hostile: a selected folder renamed INTO another selected folder collapses the selection and leaves no old folder", async (t) => {
  const r = await setup(t);
  const { server, timers, a, b, ids, keys } = r;
  const to = `${ROOT}/sel`;
  a.host.renameFolder(SEL, to);
  await timers.run(STEP_MS, () => Object.entries(NOTES).every(([name, body]) =>
    b.host.text(`${to}/${name}`) === body && settled(a, `${to}/${name}`) && settled(b, `${to}/${name}`)));
  try { await timers.run(STEP_MS, () => !b.host.hasFolder(SEL), 3000); } catch { /* asserted below */ }
  const told = story(server, a, b);
  assert.deepEqual(a.state.data.syncFolders, [ROOT], `the selection did not collapse into its parent: ${told}`);
  assert.deepEqual(server.journal.filter((f) => f.deleted && Object.values(ids).includes(f.file_id)), [], told);
  for (const name of Object.keys(NOTES)) assert.equal(b.state.fileByPath(`${to}/${name}`).fileId, ids[name], told);
  assert.equal(b.host.hasFolder(SEL), false, `B kept "${SEL}": ${told}`);
  assert.deepEqual(await deletedFrames(server, keys, [SEL, ROOT]), [SEL], told);
  assert.ok(b.state.folderByPath(ROOT), told);
});

test("hostile: a selected folder renamed where no device may sync publishes no tombstone at all", async (t) => {
  const r = await setup(t);
  const { server, timers, a, b } = r;
  const published = server.journal.length;
  a.host.renameFolder(SEL, ".hidden sel");
  await timers.run(STEP_MS, () => Object.keys(NOTES).every((name) => !settled(a, `${SEL}/${name}`)));
  await timers.run(STEP_MS);
  const told = story(server, a, b);
  assert.deepEqual(server.journal.filter((f) => f.deleted), [], `an unfollowable rename published a tombstone: ${told}`);
  assert.equal(server.journal.length, published, told);
  assert.deepEqual(a.state.data.syncFolders, [ROOT, SEL], told);
  for (const [name, body] of Object.entries(NOTES)) assert.equal(b.host.text(`${SEL}/${name}`), body, told);
});

/**
 * A WHOLE-VAULT JUDGEMENT IS NEVER WIDER THAN THE SELECTION AT THE POST.
 *
 * Within one engine only a rename moves the selection, and a rename never
 * narrows a whole vault; a selection the person saves restarts the engine
 * (next test). This pins the rule itself: a removal judged against the whole
 * vault is checked against the selection in force when it is posted, so no
 * later caller can make it wider than what the device syncs now. B is a phone,
 * two posts at a time, and two edits in flight keep the removal queued.
 */
test("hostile: a whole-vault removal is refused when the selection narrowed before it was posted, and says it is a folder", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate");
  a.host.makeFolder("Gone");
  a.host.write("Keep/One.md", "ONE SENTINEL\n", 1000);
  a.host.write("Keep/Two.md", "TWO SENTINEL\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.state.folderByPath("Gone") !== undefined &&
    settled(b, "Keep/One.md") && settled(b, "Keep/Two.md"));
  const noteIds = ["Keep/One.md", "Keep/Two.md"].map((path) => b.state.fileByPath(path).fileId);
  const post = b.transport.postVersion.bind(b.transport);
  const holds = [];
  b.transport.postVersion = async (fileId, body) => {
    if (noteIds.includes(fileId)) await new Promise((resolve) => holds.push(resolve));
    return post(fileId, body);
  };
  b.host.write("Keep/One.md", "ONE SENTINEL\nedited\n", 2000);
  b.host.write("Keep/Two.md", "TWO SENTINEL\nedited\n", 2000);
  await timers.run(STEP_MS, () => holds.length === 2);

  b.host.removeFolder("Gone");
  assert.ok(b.engine.queue.includes("Gone") && b.engine.folderRemovals.has("Gone"), "the removal was never queued, so this test proves nothing");
  assert.equal(b.engine.folderRemovals.get("Gone"), undefined, "the removal was not judged against the whole vault");
  b.state.data.syncFolders = ["Keep"];
  for (const release of holds) release();
  await timers.run(STEP_MS, () => b.host.logs.some((line) => line.startsWith("push path_class=folder decision=not_synced")));

  const told = story(server, b, a);
  assert.deepEqual(
    b.host.logs.filter((line) => line.includes("decision=not_synced reason=outside_sync_scope") && line.startsWith("push")),
    ["push path_class=folder decision=not_synced reason=outside_sync_scope"],
    told,
  );
  assert.deepEqual(await deletedFrames(server, keys, ["Gone"]), [], `a removal outside the selection was published: ${told}`);
  assert.equal(await liveOnServer(server, keys, "Gone"), true, told);
  assert.equal(a.host.hasFolder("Gone"), true, told);
});

/**
 * A SELECTION THE PERSON NARROWS BETWEEN THE RENAME AND THE POST.
 *
 * Saving a selection stops the engine and starts a new one (`main.ts`,
 * `saveSyncFolders`), so a judgement queued under the old selection never
 * reaches the wire: the new engine's pass finds the old folder's record,
 * judges it against the narrower selection, and refuses it with a line. Four
 * moves in flight fill a desktop's four slots and keep the removal queued.
 */
test("hostile: a rename's removal queued when the person narrows the selection is refused and logged", async (t) => {
  const notes = Object.fromEntries(["N1", "N2", "N3", "N4"].map((name) => [`${name}.md`, `${name} SENTINEL\n`]));
  const r = await setup(t, notes);
  const { server, timers, a, b, ids, keys } = r;
  const post = a.transport.postVersion.bind(a.transport);
  const holds = [];
  a.transport.postVersion = async (fileId, body) => {
    if (Object.values(ids).includes(fileId)) await new Promise((resolve) => holds.push(resolve));
    return post(fileId, body);
  };
  a.host.renameFolder(SEL, RENAMED);
  await timers.run(STEP_MS, () => holds.length === 4);
  assert.ok(a.engine.queue.includes(SEL), "the removal was not queued behind the moves, so this test proves nothing");
  assert.deepEqual(a.engine.folderRemovals.get(SEL), [ROOT, SEL], "the removal was not judged against the old selection");

  // What `saveSyncFolders` does: quiesce, put the new selection in force, start again.
  const quiet = a.engine.stopAndWait();
  for (const release of holds) release();
  await quiet;
  a.state.data.syncFolders = [ROOT];
  const engine = new SyncEngine({ state: a.state, transport: a.transport, host: a.host, now: () => a.host.clock, timers });
  a.plugin.engine = engine;
  t.after(() => engine.stop());
  await engine.start();
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.startsWith("reconcile decision=queued")));
  await timers.run(STEP_MS);

  const told = story(server, a, b);
  assert.deepEqual(await deletedFrames(server, keys, [SEL]), [], `a removal outside the narrowed selection was published: ${told}`);
  assert.ok(
    a.host.logs.some((line) => line === "watch path_class=folder decision=not_synced reason=outside_sync_scope event=reconcile_folder_state"),
    told,
  );
  assert.equal(a.host.logs.some((line) => line.startsWith("folder path_class=folder decision=published reason=deleted")), false, told);
  assert.deepEqual(a.state.data.syncFolders, [ROOT], told);
});
