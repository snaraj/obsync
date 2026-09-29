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
  assert.deepEqual(a.state.data.folderRemovals, {}, `a removal is still owed: ${told}`);
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
  assert.deepEqual(b.state.data.folderRemovals, {}, "a refused removal is still owed");
});

/**
 * A REMOVAL OWED ACROSS A STOP (issue #265).
 *
 * The selected folder is renamed while four moves fill a desktop's four slots,
 * so its removal waits in the queue, judged against the old selection; then
 * the engine stops, as a quit or a saved selection stops it. The moves are let
 * go, and the removal is left owed -- written down with its judgement, because
 * no later pass can judge the old name again: it is in no selection now.
 */
const NOTES4 = Object.fromEntries(["N1", "N2", "N3", "N4"].map((name) => [`${name}.md`, `${name} SENTINEL\n`]));

async function renamedThenStopped(t) {
  const r = await setup(t, NOTES4);
  const { timers, a, ids } = r;
  const post = a.transport.postVersion.bind(a.transport);
  const holds = [];
  a.transport.postVersion = async (fileId, body) => {
    if (Object.values(ids).includes(fileId)) await new Promise((resolve) => holds.push(resolve));
    return post(fileId, body);
  };
  a.host.renameFolder(SEL, RENAMED);
  await timers.run(STEP_MS, () => holds.length === 4);
  assert.ok(a.engine.queue.includes(SEL), "the removal was not queued behind the moves, so this proves nothing");
  assert.deepEqual(a.engine.folderRemovals.get(SEL), [ROOT, SEL], "the removal was not judged against the old selection");
  const quiet = a.engine.stopAndWait();
  for (const release of holds) release();
  await quiet;
  a.transport.postVersion = post;
  assert.deepEqual(a.state.data.folderRemovals, { [SEL]: [ROOT, SEL] }, "the removal owed was not written down");
  return r;
}

/** A new engine over the same vault and state, as a plugin reload or a saved selection makes one. */
async function newEngine(t, { a, timers }) {
  const engine = new SyncEngine({ state: a.state, transport: a.transport, host: a.host, now: () => a.host.clock, timers });
  a.plugin.engine = engine;
  t.after(() => engine.stop());
  await engine.start();
  return engine;
}

/** What `saveSyncFolders` puts in force once the old engine has stopped. */
const save = (a, folders) => {
  a.state.data.pendingScope = { folders };
  return a.plugin.applyScope(a.state, "save", Date.now(), () => undefined);
};

/** The old folder gone from B and from the server, every note moved, and nothing owed. */
async function retired(r) {
  const { server, timers, a, b, ids, keys } = r;
  await timers.run(STEP_MS, () => !b.host.hasFolder(SEL) &&
    Object.keys(NOTES4).every((name) => b.state.fileByPath(`${RENAMED}/${name}`) !== undefined));
  await timers.run(STEP_MS);
  const told = story(server, a, b);
  assert.equal(b.host.hasFolder(SEL), false, `B kept the old folder: ${told}`);
  assert.equal(await liveOnServer(server, keys, SEL), false, told);
  assert.deepEqual(await deletedFrames(server, keys, [SEL]), [SEL], `not exactly one tombstone, the old folder's: ${told}`);
  for (const name of Object.keys(NOTES4)) assert.equal(b.state.fileByPath(`${RENAMED}/${name}`)?.fileId, ids[name], told);
  assert.deepEqual(a.state.data.folderRemovals, {}, `the debt outlived its post: ${told}`);
}

test("hostile: a rename's removal owed when the person narrows the selection is refused and logged", async (t) => {
  const r = await renamedThenStopped(t);
  const { server, timers, a, b, keys } = r;
  await save(a, [ROOT]);
  assert.deepEqual(a.state.data.folderRemovals, { [SEL]: [ROOT] }, "the narrower selection did not re-judge the removal owed");
  await newEngine(t, r);
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.startsWith("reconcile decision=queued")));
  await timers.run(STEP_MS);
  const told = story(server, a, b);
  assert.deepEqual(await deletedFrames(server, keys, [SEL]), [], `a removal outside the narrowed selection was published: ${told}`);
  assert.ok(a.host.logs.includes("watch path_class=folder decision=not_synced reason=outside_sync_scope event=reconcile_folder_state"), told);
  assert.equal(a.host.logs.some((line) => line.startsWith("folder path_class=folder decision=published reason=deleted")), false, told);
  assert.deepEqual(a.state.data.folderRemovals, {}, "a refused removal is still owed");
  assert.deepEqual(a.state.data.syncFolders, [ROOT], told);
});

test("a wider selection saved meanwhile keeps the removal as it was judged, and it is sent (#265)", async (t) => {
  const r = await renamedThenStopped(t);
  await save(r.a, [ROOT, RENAMED, "Extra"]);
  assert.deepEqual(r.a.state.data.folderRemovals, { [SEL]: [ROOT, SEL] }, "a wider selection re-judged the removal");
  await newEngine(t, r);
  await retired(r);
});

for (const [what, reload] of [["the engine starts again", false], ["the plugin reloads and a new engine takes over", true]]) {
  test(`a renamed selected folder's removal stopped before its post is sent when ${what} (#265)`, async (t) => {
    const r = await renamedThenStopped(t);
    if (reload) await newEngine(t, r);
    else await r.a.engine.start();
    await retired(r);
  });
}

test("a renamed selected folder's removal whose post fails is retried and sent (#265)", async (t) => {
  const r = await setup(t);
  const { a, keys } = r;
  const oldId = await folderFileId(keys.manifestKey, SEL);
  const post = a.transport.postVersion.bind(a.transport);
  let posts = 0;
  a.transport.postVersion = async (fileId, body) => {
    if (fileId === oldId && posts++ === 0) throw new Error("fixture: the server could not be reached for this post");
    return post(fileId, body);
  };
  await renameAndCheck(r, SEL, RENAMED);
  assert.equal(posts, 2, "the removal was not posted exactly twice");
  assert.ok(
    a.host.logs.some((line) => line.startsWith("push path_class=folder decision=retry reason=folder_removal attempt=1 budget=3 ")),
    a.host.logs.filter((line) => line.startsWith("push")).join(" | "),
  );
});

test("a removal whose post keeps failing stops at its budget, stays owed, and Sync now sends it (#265)", async (t) => {
  const r = await setup(t);
  const { server, timers, a, b, keys } = r;
  const oldId = await folderFileId(keys.manifestKey, SEL);
  const post = a.transport.postVersion.bind(a.transport);
  let refusing = true;
  let posts = 0;
  a.transport.postVersion = async (fileId, body) => {
    if (fileId === oldId && refusing) {
      posts++;
      throw new Error("fixture: the server could not be reached for this post");
    }
    return post(fileId, body);
  };
  a.host.renameFolder(SEL, RENAMED);
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.includes("decision=expired reason=folder_removal")));
  await timers.run(STEP_MS);
  const pushed = a.host.logs.filter((line) => line.startsWith("push")).join(" | ");
  assert.equal(posts, 3, `the budget is not the one stated: ${pushed}`);
  assert.ok(a.host.logs.some((line) => line.startsWith("push path_class=folder decision=expired reason=folder_removal attempt=3 budget=3 held=next_pass ")), pushed);
  assert.deepEqual(a.state.data.folderRemovals, { [SEL]: [ROOT, SEL] }, "the debt was dropped at the end of its budget");
  assert.equal(b.host.hasFolder(SEL), true, "the removal reached B after all, so this proves nothing");
  refusing = false;
  await a.engine.syncNow();
  await timers.run(STEP_MS, () => !b.host.hasFolder(SEL));
  assert.equal(b.host.hasFolder(SEL), false, story(server, a, b));
  assert.equal(await liveOnServer(server, keys, SEL), false);
  assert.deepEqual(a.state.data.folderRemovals, {});
});

test("a removal owed for a folder that stands again by the next start owes nothing, and nothing is published (#265)", async (t) => {
  const r = await setup(t, NOTES4);
  const { server, timers, a, b, ids, keys } = r;
  const EMPTY = `${ROOT}/Empty`;
  a.host.makeFolder(EMPTY);
  await timers.run(STEP_MS, () => b.state.folderByPath(EMPTY) !== undefined);
  // Four edits in flight fill the slots, so the folder's removal waits in the queue.
  const post = a.transport.postVersion.bind(a.transport);
  const holds = [];
  a.transport.postVersion = async (fileId, body) => {
    if (Object.values(ids).includes(fileId)) await new Promise((resolve) => holds.push(resolve));
    return post(fileId, body);
  };
  for (const name of Object.keys(NOTES4)) a.host.write(`${SEL}/${name}`, `${name} edited\n`, 2000);
  await timers.run(STEP_MS, () => holds.length === 4);
  a.host.removeFolder(EMPTY);
  assert.ok(a.engine.queue.includes(EMPTY), "the removal was not queued, so this proves nothing");
  const quiet = a.engine.stopAndWait();
  for (const release of holds) release();
  await quiet;
  a.transport.postVersion = post;
  assert.deepEqual(Object.keys(a.state.data.folderRemovals), [EMPTY], "the removal owed was not written down");
  // Made again while the engine was stopped.
  a.host.explicitFolders.add(EMPTY);
  await a.engine.start();
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.startsWith("reconcile decision=queued")));
  await timers.run(STEP_MS);
  const told = story(server, a, b);
  assert.deepEqual(await deletedFrames(server, keys, [EMPTY]), [], `a folder standing here was tombstoned: ${told}`);
  assert.deepEqual(a.state.data.folderRemovals, {}, `a folder standing again is still owed a removal: ${told}`);
  assert.equal(b.host.hasFolder(EMPTY), true, told);
});
