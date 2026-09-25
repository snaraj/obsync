/**
 * A folder moved or renamed OUTSIDE Obsidian (issue #139).
 *
 * A file manager does not tell Obsidian what it did. With the app open, the
 * vault's watcher sees one folder vanish and another appear, and Obsidian
 * reports exactly that: the old folder DELETED, the new folder and every file
 * in it CREATED, in either order and never as a rename. With the app closed it
 * reports nothing, and the next start finds recorded paths gone and new paths
 * no record explains. Either way the bytes never left the vault, and a
 * tombstone for them is one every other device obeys.
 *
 * WHAT IS PROVEN HERE. A delete and a create of the same bytes is published as
 * the MOVE it is, keeping the file id and its history. A note whose new name
 * is outside this device's folder selection stops syncing from here and is
 * never a deletion anywhere, and the user is told once, with the count. And a
 * deletion held back at startup never deletes -- nor keeps offering to delete
 * -- a note whose bytes are in the vault under another name.
 *
 * WHAT IS NOT. Both devices are the hand-written `EventVault` driven through
 * the plugin's own `registerVaultEvents`; the native event timing of a real
 * Obsidian watcher is a device run (`docs/validation.md`), and this file says
 * nothing about it beyond the two orders it drives.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FakeTimers, KEYS, STEP_MS, pair, rig, sandbox, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine, SCAN_MS } = require("../build/sync/engine.js");
const { inFolderScope, inSyncScope } = require("../build/syncScope.js");

/** Every tombstone naming one of these file ids: what a moved note must never produce. */
const tombstonesFor = (server, ids) => server.journal.filter((frame) => frame.deleted && ids.includes(frame.file_id));
const tombstones = (server) => server.journal.filter((frame) => frame.deleted);

/**
 * Notes with DISTINCT modification times, as real files have: a move is
 * recognised by `(mtime, size)`, the rule the periodic scan already pairs
 * moves by, and two notes written in the same millisecond with the same
 * length are the ambiguity that rule declines to guess about.
 */
const PROJECT = {
  "Projects/Alpha/p1.md": "alpha one\n",
  "Projects/Alpha/p2.md": "alpha two, longer\n",
  "Projects/Alpha/p3.md": "alpha three\n",
  "Projects/Beta/b1.md": "beta one\n",
  "Projects/Beta/b2.md": "beta two\n",
};
const NOTE = { "Notes/n1.md": "a note that stays put\n" };

/** Move every entry under `from` to `to`, with its bytes and its mtime, and say nothing. */
function moveSilently(host, from, to) {
  const moved = [...host.files.keys()].filter((path) => path.startsWith(`${from}/`));
  const folders = [...host.explicitFolders].filter((folder) => folder === from || folder.startsWith(`${from}/`));
  for (const path of moved) {
    const file = host.files.get(path);
    host.files.delete(path);
    host.files.set(to + path.slice(from.length), file);
  }
  for (const folder of folders) {
    host.explicitFolders.delete(folder);
    host.explicitFolders.add(to + folder.slice(from.length));
  }
  return { moved, folders };
}

/**
 * A folder moved by a file manager while Obsidian is open: the files move
 * with their bytes and mtimes, and Obsidian reports what its watcher saw --
 * ONE delete for the old folder, as it reports any folder deletion (the
 * fan-out to the notes under it is the plugin's, `main.ts`), and a create for
 * the new folder and for each file in it.
 */
function fileManagerMove(host, from, to, order) {
  const { moved, folders } = moveSilently(host, from, to);
  const created = () => {
    for (const folder of folders) host.emit("create", host.entry(to + folder.slice(from.length), true));
    for (const path of moved) host.emit("create", host.entry(to + path.slice(from.length)));
  };
  const deleted = () => host.emit("delete", host.entry(from, true));
  if (order === "creates first") {
    created();
    deleted();
  } else {
    deleted();
    created();
  }
}

/**
 * Both devices synced, the desktop selecting `folders` (undefined = the whole
 * vault). Each note gets its own mtime unless `sameMtime` says otherwise.
 */
async function synced(t, delivery, folders, notes = { ...NOTE, ...PROJECT }, sameMtime = false) {
  const rigged = await pair(t, delivery);
  const { timers, a, b } = rigged;
  a.state.data.syncFolders = folders;
  let mtime = 1000;
  for (const [path, body] of Object.entries(notes)) a.host.write(path, body, sameMtime ? mtime : mtime++);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => Object.entries(notes).every(([path, body]) =>
    b.host.text(path) === body && settled(a, path) && settled(b, path)));
  await timers.run(STEP_MS);
  const ids = Object.fromEntries(Object.keys(notes).map((path) => [path, a.state.fileByPath(path).fileId]));
  return { ...rigged, ids };
}

/**
 * THE SELECTION STILL BOUNDS WHAT IS TOUCHED. Whether a note left the
 * selection is answered from Obsidian's index alone (`inventory`); every
 * per-path question the host is asked stays inside the selection, as it
 * always has (`scope.test.mjs`). Returns the violations, which must be none.
 */
function guardScope(host, folders) {
  const violations = [];
  for (const method of ["syncable", "stat", "read", "source", "writer", "trash"]) {
    const original = host[method].bind(host);
    host[method] = (path, ...rest) => {
      const rule = method === "syncable" && rest[0] === "folder" ? inFolderScope : inSyncScope;
      if (!rule(path, folders)) violations.push(`${method} ${path}`);
      return original(path, ...rest);
    };
  }
  return violations;
}

const story = (server, a, b) =>
  [`journal=${server.journal.map((frame) => `${frame.seq}${frame.deleted ? ":tombstone" : ""}`).join(",")}`,
    `desktop_files=${JSON.stringify([...a.host.files.keys()])}`,
    `phone_files=${JSON.stringify([...b.host.files.keys()])}`,
    `desktop_logs=${JSON.stringify(a.host.logs.filter((line) => /^(watch|push|scope|rename|folder|reconcile)/.test(line)))}`].join(" ");

// --- Obsidian open: the watcher's delete + create --------------------------

for (const delivery of ["immediate", "deferred"]) {
  for (const order of ["creates first", "deletes first"]) {
    test(`a folder renamed in a file manager is published as moves, keeping every file id (${delivery}, ${order})`, async (t) => {
      const { server, timers, a, b, ids, keys } = await synced(t, delivery, undefined);
      const alpha = Object.keys(PROJECT).filter((path) => path.startsWith("Projects/Alpha/"));
      const noteIds = alpha.map((path) => ids[path]);
      const notesBefore = (await server.noteFiles(keys.manifestKey)).length;

      fileManagerMove(a.host, "Projects/Alpha", "Projects/Alpha2", order);
      const renamed = (path) => path.replace("Projects/Alpha/", "Projects/Alpha2/");
      await timers.run(STEP_MS, () => tombstonesFor(server, noteIds).length > 0 || alpha.every((path) =>
        b.host.text(renamed(path)) === PROJECT[path] && b.state.fileByPath(renamed(path))?.fileId === ids[path]));
      await timers.run(STEP_MS);

      assert.deepEqual(tombstonesFor(server, noteIds), [], `a moved note was published as deleted: ${story(server, a, b)}`);
      for (const path of alpha) {
        assert.equal(b.host.text(renamed(path)), PROJECT[path], `the phone lost ${path}: ${story(server, a, b)}`);
        assert.equal(b.host.text(path), null, "and does not keep the old name");
        assert.equal(a.state.fileByPath(renamed(path)).fileId, ids[path], "the desktop kept the file id");
        assert.equal(b.state.fileByPath(renamed(path)).fileId, ids[path], "the phone moved it, history and all");
      }
      assert.equal((await server.noteFiles(keys.manifestKey)).length, notesBefore, "a moved note was published as a new file");
      // The phone never removed a note: a move is one host rename (#108).
      assert.deepEqual(b.host.trashed.filter((path) => alpha.includes(path)), [], story(server, a, b));
      // One burst, one decision, one line (requirement 12).
      const decided = a.host.logs.filter((line) => line.startsWith("watch decision=settled"));
      assert.equal(decided.length, 1, decided.join(" | "));
      assert.match(decided[0], /^watch decision=settled reason=vanished files=3 moved=3 left=0 removed=0 folders=1 budget_ms=500 duration_ms=\d+$/);
    });
  }
}

/** Only what a selection covers is ever on the other device to lose. */
const ALPHA = Object.fromEntries(Object.entries(PROJECT).filter(([path]) => path.startsWith("Projects/Alpha/")));

for (const [selection, from, to, notes, count] of [
  [["Notes", "Projects"], "Projects", "Work", { ...NOTE, ...PROJECT }, 5],
  [["Notes", "Projects/Alpha"], "Projects/Alpha", "Projects/Alpha2", { ...NOTE, ...ALPHA }, 3],
]) {
  for (const order of ["creates first", "deletes first"]) {
    test(`${from} moved out of the selection in a file manager deletes nothing anywhere and says so once (${order})`, async (t) => {
      const { server, timers, a, b, ids } = await synced(t, "immediate", selection, notes);
      const leaving = Object.keys(notes).filter((path) => path.startsWith(`${from}/`));
      assert.equal(leaving.length, count);
      const published = server.journal.length;
      const violations = guardScope(a.host, selection);

      fileManagerMove(a.host, from, to, order);
      await timers.run(STEP_MS, () => tombstones(server).length > 0 || leaving.every((path) => !settled(a, path)));
      await timers.run(STEP_MS);

      assert.deepEqual(tombstones(server), [], `a note that left the selection was deleted: ${story(server, a, b)}`);
      assert.equal(server.journal.length, published, "and nothing else was published for it either");
      for (const path of leaving) {
        assert.equal(b.host.text(path), PROJECT[path], `the phone lost ${path}: ${story(server, a, b)}`);
        assert.equal(b.state.fileByPath(path).fileId, ids[path]);
        assert.equal(a.host.text(to + path.slice(from.length)), PROJECT[path], "the note is alive on the desktop");
        assert.equal(a.state.fileByPath(path), undefined, "which no longer syncs it from here");
        assert.equal(a.state.fileByPath(to + path.slice(from.length)), undefined);
      }
      assert.equal(a.state.fileByPath("Notes/n1.md").fileId, ids["Notes/n1.md"], "the note that stayed is untouched");
      // Once, with the count, and one line saying the same (requirement 12).
      assert.equal(a.host.notices.length, 1, a.host.notices.join(" | "));
      assert.match(a.host.notices[0], new RegExp(`${count} note\\(s\\) moved out of the folders this device syncs`));
      assert.match(a.host.notices[0], /they stay on your other devices/);
      assert.match(a.host.notices[0], /moved out of the folders this device syncs.*Nothing was deleted/s);
      assert.ok(
        a.host.logs.some((line) => line === `scope decision=left_selection files=${count}`),
        a.host.logs.filter((line) => line.startsWith("scope")).join(" | "),
      );
      assert.deepEqual(violations, [], "the host was asked about a path outside the selection");
    });
  }
}

test("a note deleted while a move is settling is still published as deleted", async (t) => {
  // The window a move waits for is not a way to lose a real deletion: the
  // same burst holds a note the user really deleted, and that one has no
  // bytes anywhere in the vault.
  const { server, timers, a, b, ids } = await synced(t, "immediate", undefined);
  a.host.remove("Notes/n1.md");
  fileManagerMove(a.host, "Projects/Alpha", "Projects/Alpha2", "deletes first");
  await timers.run(STEP_MS, () => b.host.text("Notes/n1.md") === null && settled(b, "Projects/Alpha2/p1.md"));
  await timers.run(STEP_MS);

  assert.deepEqual(tombstonesFor(server, [ids["Notes/n1.md"]]).length, 1, story(server, a, b));
  assert.deepEqual(
    tombstonesFor(server, Object.keys(PROJECT).map((path) => ids[path])), [], story(server, a, b));
  assert.equal(b.state.fileByPath("Projects/Alpha2/p1.md").fileId, ids["Projects/Alpha/p1.md"]);
});

test("two moved notes with the same size and mtime are published as both halves, as the scan leaves them", async (t) => {
  // Ambiguity INSIDE the selection is not a note that left it: guessing which
  // note went where is worse than publishing the deletion and the two new
  // files, which is the periodic scan's own answer (`survey`, MOVES).
  const twins = { "Pair/x.md": "same size A\n", "Pair/y.md": "same size B\n" };
  const { server, timers, a, b, ids } = await synced(t, "immediate", undefined, twins, true);
  assert.equal(a.state.fileByPath("Pair/x.md").mtime, a.state.fileByPath("Pair/y.md").mtime);
  assert.equal(a.state.fileByPath("Pair/x.md").size, a.state.fileByPath("Pair/y.md").size);

  fileManagerMove(a.host, "Pair", "Pair2", "deletes first");
  await timers.run(STEP_MS, () => Object.entries(twins).every(([path, body]) =>
    b.host.text(path.replace("Pair/", "Pair2/")) === body && b.host.text(path) === null));
  await timers.run(STEP_MS);

  assert.equal(tombstonesFor(server, Object.values(ids)).length, 2, story(server, a, b));
  for (const path of Object.keys(twins)) {
    assert.notEqual(a.state.fileByPath(path.replace("Pair/", "Pair2/")).fileId, ids[path], "a guess was published as a move");
  }
  assert.equal(a.host.notices.length, 0, "an ambiguous move inside the selection was reported as leaving it");
});

test("a deleted note never takes over the identity of a synced note with the same size and mtime", async (t) => {
  // The whole index holds every synced note too, and only an UNRECORDED file
  // can be where a vanished note went: a recorded one is already a note of
  // its own, and pairing with it would retire one id and hand its path to
  // the other.
  const twins = { "Pair/x.md": "same size A\n", "Pair/y.md": "same size B\n" };
  const { server, timers, a, b, ids } = await synced(t, "immediate", undefined, twins, true);

  a.host.remove("Pair/x.md");
  await timers.run(STEP_MS, () => b.host.text("Pair/x.md") === null);
  await timers.run(STEP_MS);

  assert.deepEqual(tombstonesFor(server, Object.values(ids)).map((frame) => frame.file_id), [ids["Pair/x.md"]]);
  assert.equal(a.state.fileByPath("Pair/y.md").fileId, ids["Pair/y.md"], "the surviving note lost its identity");
  assert.equal(b.host.text("Pair/y.md"), twins["Pair/y.md"]);
});

test("a delete reported for a note that is still there moves nothing, whatever else carries its bytes", async (t) => {
  // "A file that is there is not gone" (`pushDelete`), asked before the vault
  // is: an mtime-keeping copy elsewhere must not take the note's identity.
  const { server, timers, engine, host, state } = await device(t, ["Notes/kept.md"]);
  const id = state.fileByPath("Notes/kept.md").fileId;
  const original = host.files.get("Notes/kept.md");
  host.files.set("Notes/copy.md", { bytes: original.bytes, mtime: original.mtime });

  engine.deleted("Notes/kept.md");
  await timers.run(STEP_MS, () => host.logs.some((line) => line.startsWith("watch decision=settled")));
  await timers.run(STEP_MS);

  assert.equal(state.fileByPath("Notes/kept.md")?.fileId, id, "the note lost its identity to a copy");
  assert.equal(state.fileByPath("Notes/copy.md"), undefined);
  assert.deepEqual(tombstones(server), []);
  assert.ok(host.logs.includes("push path_class=tombstone decision=refused reason=file_present"), host.logs.join(" | "));
});

test("a burst the vault cannot answer for publishes nothing and says so", async (t) => {
  const { server, timers, engine, host, state } = await device(t, ["Notes/gone.md"]);
  host.inventory = async () => { throw new Error("index unavailable"); };
  host.files.delete("Notes/gone.md");
  engine.deleted("Notes/gone.md");
  await timers.run(STEP_MS, () => host.logs.some((line) => line.startsWith("watch decision=failed")));
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), [], "a deletion was published on a question nobody answered");
  assert.ok(state.fileByPath("Notes/gone.md"), "the record the next reconcile pass decides from was dropped");
  assert.ok(
    host.logs.some((line) => /^watch decision=failed reason=vanished_unsettled files=1 budget_ms=500 duration_ms=\d+ error=index unavailable$/.test(line)),
    host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
});

// --- Obsidian closed: the startup pass ---------------------------------------

for (const [what, notes] of [
  ["a small folder", { "Notes/n1.md": "one\n", "Notes/n2.md": "two two\n", "Notes/n3.md": "three three three\n", "Notes/n4.md": "four\n", "Small/s1.md": "s one\n", "Small/s2.md": "s two two\n", "Small/s3.md": "s three\n" }],
  ["a big folder", Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`Small/big-${index}.md`, `${"x".repeat(index + 1)}\n`]))],
]) {
  test(`${what} renamed out of the selection while Obsidian was closed deletes nothing and holds nothing`, async (t) => {
    const folders = what === "a small folder" ? ["Notes", "Small"] : ["Small"];
    const { server, timers, a, b, ids } = await synced(t, "immediate", folders, notes);
    const leaving = Object.keys(notes).filter((path) => path.startsWith("Small/"));
    const violations = guardScope(a.host, folders);

    moveSilently(a.host, "Small", "Small2");
    await a.engine.reconcile();
    await timers.run(STEP_MS);

    assert.deepEqual(tombstones(server), [], `a rename nobody saw deleted notes: ${story(server, a, b)}`);
    assert.equal(a.engine.heldDeletionCount, 0, "a note that is still in the vault is held as a deletion to confirm");
    for (const path of leaving) {
      assert.equal(b.host.text(path), notes[path], `the phone lost ${path}`);
      assert.equal(b.state.fileByPath(path).fileId, ids[path]);
      assert.equal(a.state.fileByPath(path), undefined, "the record for a note that left the selection was kept");
    }
    assert.equal(a.host.notices.length, 1, a.host.notices.join(" | "));
    assert.match(a.host.notices[0], new RegExp(`${leaving.length} note\\(s\\) moved out of the folders this device syncs`));
    assert.ok(
      a.host.logs.some((line) => /^reconcile decision=queued .* removed=0 .* left=\d+$/.test(line) && line.endsWith(`left=${leaving.length}`)),
      a.host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
    );
    assert.deepEqual(violations, [], "the host was asked about a path outside the selection");
  });
}

/** One device on a fake clock, selecting `Notes`. */
async function device(t, notes) {
  const rigged = await rig();
  const { host, server, state } = rigged;
  state.data.syncFolders = ["Notes"];
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
    timers,
  });
  t.after(() => engine.stop());
  let mtime = 1000;
  for (const path of notes) host.seed(path, `${path} body\n`, mtime++);
  await engine.start();
  await timers.run(1000, () => notes.every((path) => state.fileByPath(path) !== undefined));
  return { ...rigged, timers, engine };
}

const HELD = Array.from({ length: 7 }, (_, index) => `Notes/held-${index}.md`);

/**
 * The notes leave the vault altogether -- the one thing the hold is for --
 * and five come back under other names before anyone confirms: four outside
 * the selection, one inside it. Two are really gone.
 */
async function heldThenBack(t) {
  const d = await device(t, HELD);
  const ids = Object.fromEntries(HELD.map((path) => [path, d.state.fileByPath(path).fileId]));
  const away = new Map(HELD.map((path) => [path, d.host.files.get(path)]));
  for (const path of HELD) d.host.files.delete(path);
  await d.engine.reconcile();
  await d.timers.run(STEP_MS);
  assert.equal(d.engine.heldDeletionCount, HELD.length, "the vault emptied and nothing was held");
  assert.deepEqual(tombstones(d.server), []);
  const back = {
    "Notes/held-0.md": "Archive/held-0.md",
    "Notes/held-1.md": "Archive/held-1.md",
    "Notes/held-2.md": "Archive/deeper/held-2.md",
    "Notes/held-3.md": "Old/held-3.md",
    "Notes/held-4.md": "Notes/renamed-4.md",
  };
  for (const [path, to] of Object.entries(back)) d.host.files.set(to, away.get(path));
  return { ...d, ids, back, gone: ["Notes/held-5.md", "Notes/held-6.md"] };
}

test("confirming held deletions never deletes a note that is in the vault under a new name", async (t) => {
  const { server, timers, engine, host, state, ids, back, gone } = await heldThenBack(t);
  // Isolate confirmation from the independently tested periodic scan. Setup
  // can consume virtual time while crypto awaits a busy worker pool; a timer
  // near its deadline must neither rescue nor invalidate this witness.
  timers.clear(engine.scanHandle);
  const scans = () => host.logs.filter((line) => line.startsWith("scan decision=queued")).length;
  const before = scans();

  engine.confirmHeldDeletions();
  await timers.run(STEP_MS, () => tombstones(server).length >= gone.length);
  await timers.run(STEP_MS);
  assert.equal(scans(), before, "the periodic scan ran, so this does not prove the confirmation itself looked");

  assert.deepEqual(
    tombstones(server).map((frame) => frame.file_id).sort(),
    gone.map((path) => ids[path]).sort(),
    "the confirmation deleted a note that is still in the vault",
  );
  // The one that came back INSIDE the selection is the move it is.
  assert.equal(state.fileByPath("Notes/renamed-4.md").fileId, ids["Notes/held-4.md"]);
  for (const path of Object.keys(back)) assert.equal(state.fileByPath(path), undefined);
  assert.equal(engine.heldDeletionCount, 0);
});

test("the periodic scan stops offering to delete a held note that is back under a new name", async (t) => {
  const { server, timers, engine, host, ids, gone } = await heldThenBack(t);

  await timers.run(SCAN_MS, () => engine.heldDeletionCount !== HELD.length);
  await timers.run(STEP_MS);

  assert.equal(engine.heldDeletionCount, gone.length, "the offer still names notes that are in the vault");
  assert.deepEqual(tombstones(server), [], "the scan published a deletion");
  assert.ok(
    host.logs.some((line) => line === `scan decision=released reason=bulk_deletion released=5 held=${gone.length}`),
    host.logs.filter((line) => line.startsWith("scan")).join(" | "),
  );
  // And confirming what is left deletes exactly what is gone.
  engine.confirmHeldDeletions();
  await timers.run(STEP_MS, () => tombstones(server).length >= gone.length);
  await timers.run(STEP_MS);
  assert.deepEqual(tombstones(server).map((frame) => frame.file_id).sort(), gone.map((path) => ids[path]).sort());
});

test("a note deleted while its push is still queued is published as deleted, not as a failure", async (t) => {
  // The queue drains in batches, so a note edited moments ago can be waiting
  // behind another push when its delete arrives. The delete now waits for the
  // other half of a move; the queued push must not run first and find the
  // file gone, which the status bar would show as an error.
  const { server, timers, engine, host, state } = await device(t, ["Notes/a.md", "Notes/e.md"]);
  const doomed = state.fileByPath("Notes/e.md").fileId;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [];
  const read = host.read.bind(host);
  host.read = async (path) => { reads.push(path); await gate; return read(path); };

  host.seed("Notes/a.md", "a, edited\n", 5000);
  engine.changed("Notes/a.md");
  await timers.run(STEP_MS, () => reads.length === 1);
  host.seed("Notes/e.md", "e, edited\n", 5001);
  engine.changed("Notes/e.md");
  await timers.run(STEP_MS);
  assert.deepEqual(reads, ["Notes/a.md"], "the edit to e was pushed, not queued behind a");

  host.files.delete("Notes/e.md");
  engine.deleted("Notes/e.md");
  release();
  await timers.run(STEP_MS, () => tombstones(server).length > 0);
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server).map((frame) => frame.file_id), [doomed]);
  assert.equal(state.fileByPath("Notes/e.md"), undefined);
  assert.deepEqual(host.logs.filter((line) => line.includes("decision=failed")), [], "a deletion surfaced as a failure");
});

test("the real host's inventory is Obsidian's index: every canonical path, no hidden one, no I/O", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  const { TFile } = box.require("obsidian");
  const file = (path, mtime, size) => Object.assign(new TFile(), { path, stat: { mtime, size } });
  const touched = [];
  const refuse = (name) => async (...args) => { touched.push([name, ...args]); throw new Error("inventory did I/O"); };
  const plugin = {
    state: { data: { syncFolders: ["Notes"] } },
    log: () => undefined,
    app: { vault: {
      // Obsidian's own trash is where a note deleted IN OBSIDIAN goes: were it
      // counted, every such deletion would look like a move and never reach
      // the other devices.
      getFiles: () => [file("Notes/a.md", 1, 2), file("Archive/b.md", 3, 4), file(".trash/c.md", 5, 6)],
      getAbstractFileByPath: refuse("cached"),
      adapter: Object.fromEntries(["stat", "list", "exists", "readBinary"].map((name) => [name, refuse(name)])),
    } },
  };
  const desktop = { base: "/vault-that-must-not-be-read", path: { resolve: refuse("resolve") }, fs: { promises: {
    lstat: refuse("lstat"), readdir: refuse("readdir"), stat: refuse("stat"),
  } } };
  for (const host of [new ObsidianHost(plugin, desktop), new ObsidianHost(plugin, null)]) {
    assert.deepEqual(await host.inventory(), [
      { path: "Notes/a.md", mtime: 1, size: 2 },
      { path: "Archive/b.md", mtime: 3, size: 4 },
    ]);
  }
  assert.deepEqual(touched, []);
});
