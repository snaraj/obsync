/**
 * Many notes deleted at once, in Obsidian (issue #162).
 *
 * A multi-select Delete, or a folder deleted, reached every other device
 * within a second: twenty tombstones, and neither device's trash held the
 * notes on the other side. The startup pass already asked before publishing a
 * bulk deletion (issue #123); a live one never did. Now it is the same
 * question, asked the same way and kept the same way: held at the same floor,
 * persisted, one notice with both answers -- Delete everywhere, or Restore
 * here, which puts the notes back from the version this device recorded, with
 * no copy and no new version anywhere. Below the floor nothing changes.
 *
 * Driven through the plugin's own vault-event registration (`pair`), so a
 * folder's deletion arrives as Obsidian reports it: one event for the folder.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine, BULK_DELETION_MIN, DEBOUNCE_MS } = require("../build/sync/engine.js");

const NOTES = Array.from({ length: 20 }, (_, index) => `Notes/n${String(index).padStart(2, "0")}.md`);
const body = (path) => `the note at ${path}, which nobody meant to delete everywhere\n`;
const tombstones = (server) => server.journal.filter((frame) => frame.deleted);
const copies = (host) => [...host.files.keys()].filter((path) => /\((conflict from|restored-|obsync kept)/.test(path));
const HELD_ACTIONS = [{ kind: "delete_everywhere" }, { kind: "restore_here" }];

/** Two devices, both holding `notes`, each with its own mtime. */
async function synced(t, notes = NOTES) {
  const rigged = await pair(t);
  const { timers, a, b } = rigged;
  let mtime = 1000;
  for (const path of notes) a.host.write(path, body(path), mtime++);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => notes.every((path) => b.host.text(path) === body(path) && settled(a, path) && settled(b, path)));
  await timers.run(STEP_MS);
  return rigged;
}

/** Fire what is due at exactly `ms` from now, and let it run: no step past it. */
async function after(timers, ms) {
  timers.now += ms;
  const due = timers.entries.filter((entry) => entry.due <= timers.now);
  timers.entries = timers.entries.filter((entry) => entry.due > timers.now);
  for (const entry of due) entry.fn();
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("twenty notes deleted at once are held, asked about once, and never reach the other device", async (t) => {
  const { server, timers, a, b } = await synced(t);
  const before = server.journal.length;

  for (const path of NOTES) a.host.remove(path);
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === NOTES.length);
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), [], `${tombstones(server).length} deletions reached the server`);
  assert.equal(server.journal.length, before, "the hold published something");
  for (const path of NOTES) assert.equal(b.host.text(path), body(path), `${path} left the other device`);
  assert.deepEqual([...a.state.data.heldDeletions].sort(), NOTES, "the hold is not what was deleted");
  assert.deepEqual(a.host.asked, [{
    message: "obsync: you deleted 20 notes (in Notes). Delete them on your other devices too? They stay there until you choose.",
    actions: HELD_ACTIONS,
  }]);
  assert.ok(
    a.host.logs.includes(`watch decision=held reason=bulk_deletion files=20 held=20 floor=${BULK_DELETION_MIN}`),
    a.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
});

test("Restore here puts every note back with its bytes, and makes no copy and no version", async (t) => {
  const { server, timers, a, b } = await synced(t);
  const records = Object.fromEntries(NOTES.map((path) => [path, { ...a.state.fileByPath(path) }]));
  for (const path of NOTES) a.host.remove(path);
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === NOTES.length);
  const before = server.journal.length;

  await a.engine.restoreHeldDeletions();
  await timers.run(STEP_MS);

  for (const path of NOTES) {
    assert.equal(a.host.text(path), body(path), `${path} was not put back as it was`);
    assert.equal(a.state.fileByPath(path).fileId, records[path].fileId, `${path} lost its identity`);
    assert.equal(a.state.fileByPath(path).versionId, records[path].versionId, `${path} was put back as another version`);
  }
  assert.equal(server.journal.length, before, "Restore here published something");
  assert.deepEqual(copies(a.host), [], "a copy was made here");
  assert.deepEqual(copies(b.host), [], "a copy was made on the other device");
  assert.deepEqual(a.state.data.heldDeletions, []);
  assert.equal(a.host.notices.at(-1), "obsync put 20 note(s) back on this device, and deleted nothing anywhere.");
  // And a later pass finds nothing to send: the notes are exactly as recorded.
  await a.engine.syncNow();
  await timers.run(STEP_MS);
  assert.equal(server.journal.length, before, "the next pass published the restored notes again");
  for (const path of NOTES) assert.equal(b.host.text(path), body(path));
});

test("Delete everywhere publishes exactly what was held, and the other device lets them go", async (t) => {
  const { server, timers, a, b } = await synced(t);
  for (const path of NOTES) a.host.remove(path);
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === NOTES.length);

  a.engine.confirmHeldDeletions();
  await timers.run(STEP_MS, () => NOTES.every((path) => b.host.text(path) === null));

  assert.equal(tombstones(server).length, NOTES.length);
  assert.deepEqual(a.state.data.heldDeletions, []);
  assert.ok(a.host.logs.includes(`reconcile decision=confirmed reason=bulk_deletion queued=${NOTES.length}`));
});

test("a folder deleted counts the notes inside it, and keeps its own record until the answer", async (t) => {
  const { server, timers, a, b } = await synced(t);
  const folder = a.state.folderByPath("Notes");
  assert.ok(folder, "the fixture's folder has no record");

  a.host.removeFolder("Notes");
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === NOTES.length);
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), [], "the folder, or a note in it, was deleted everywhere");
  assert.equal(b.host.hasFolder("Notes"), true);
  assert.match(a.host.asked[0].message, /^obsync: you deleted 20 notes \(in Notes\)\./);

  await a.engine.restoreHeldDeletions();
  await timers.run(STEP_MS);
  assert.equal(a.host.hasFolder("Notes"), true);
  for (const path of NOTES) assert.equal(a.host.text(path), body(path));
  assert.deepEqual(a.state.folderByPath("Notes"), folder, "the folder's record changed");
  assert.deepEqual(tombstones(server), []);
});

test("a folder deleted and then confirmed goes after its notes, on the other device too", async (t) => {
  const { timers, a, b } = await synced(t);
  a.host.removeFolder("Notes");
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === NOTES.length);

  a.engine.confirmHeldDeletions();
  await timers.run(STEP_MS, () => !b.host.hasFolder("Notes"));

  assert.equal(b.host.hasFolder("Notes"), false, "the empty folder stayed on the other device");
  assert.equal(a.state.folderByPath("Notes"), undefined);
});

test("deletions below the floor go at once, as they always have", async (t) => {
  const { server, timers, a, b } = await synced(t);
  const few = NOTES.slice(0, BULK_DELETION_MIN - 1);
  for (const path of few) a.host.remove(path);
  await timers.run(STEP_MS, () => few.every((path) => b.host.text(path) === null));

  assert.equal(tombstones(server).length, few.length);
  assert.equal(a.engine.heldDeletionCount, 0);
  assert.deepEqual(a.host.asked, [], "a small deletion asked a question");
});

test("the floor is the startup pass's own: exactly five are held", async (t) => {
  const { server, timers, a, b } = await synced(t);
  const five = NOTES.slice(0, BULK_DELETION_MIN);
  for (const path of five) a.host.remove(path);
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === five.length);
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), []);
  for (const path of five) assert.equal(b.host.text(path), body(path));
});

test("Restore here never replaces a file that took a held note's name", async (t) => {
  const { server, timers, a } = await synced(t);
  for (const path of NOTES) a.host.remove(path);
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === NOTES.length);
  // A new note typed at one of the names before the answer, and another typed
  // at a second name in the instant after Restore here looked and before it
  // wrote: the look found nothing, and only the create-only write refuses.
  a.host.seed(NOTES[3], "A NEW NOTE TYPED HERE SENTINEL\n", 9000);
  const stat = a.host.stat.bind(a.host);
  let raced = false;
  a.host.stat = async (path) => {
    if (path !== NOTES[4] || raced) return stat(path);
    raced = true;
    a.host.seed(NOTES[4], "TYPED IN THE INSTANT SENTINEL\n", 9001);
    return null;
  };
  const before = server.journal.length;

  await a.engine.restoreHeldDeletions();
  await timers.run(STEP_MS);

  assert.equal(raced, true, "the race was never run");
  assert.equal(a.host.text(NOTES[3]), "A NEW NOTE TYPED HERE SENTINEL\n", "a note the user made was written over");
  assert.equal(a.host.text(NOTES[4]), "TYPED IN THE INSTANT SENTINEL\n", "a note saved inside the restore was written over");
  for (const path of NOTES.slice(5).concat(NOTES.slice(0, 3))) assert.equal(a.host.text(path), body(path));
  assert.deepEqual(copies(a.host), []);
  assert.deepEqual(a.state.data.heldDeletions, [], "a note whose name was taken is still asked about");
  assert.ok(server.journal.slice(before).every((frame) => !frame.deleted), "Restore here deleted something");
});

test("a multi-select the trash spreads over several debounce windows is still one deletion", async (t) => {
  // Obsidian trashes a selection one note at a time; a slow system trash puts
  // each next delete event a few hundred milliseconds after the last, and
  // several windows of four would each have gone out under the floor.
  const { server, timers, a } = await synced(t);
  const gap = DEBOUNCE_MS - 200;
  for (const path of NOTES.slice(0, 12)) {
    a.host.remove(path);
    await after(timers, gap);
  }
  await timers.run(STEP_MS, () => a.engine.heldDeletionCount === 12);
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), [], `${tombstones(server).length} of a slow multi-select went out`);
  assert.equal(a.host.asked.length, 1, a.host.notices.join(" | "));
});

/**
 * One device over the rig, whose state can be reopened as the next start of
 * the plugin reads it (`reload`), and whose engine is fed the watcher's
 * deletions the way `main.ts` feeds them.
 */
async function restartable(t, notes) {
  const r = await rig();
  const timers = new FakeTimers();
  const engineFor = (state) => {
    const engine = new SyncEngine({
      state,
      transport: new Transport({
        request: r.server.request,
        serverUrl: () => state.data.serverUrl,
        device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
        edgeHeaders: () => [],
        now: () => r.host.clock,
        sleep: async () => undefined,
      }),
      host: r.host,
      timers,
    });
    t.after(() => engine.stop());
    return engine;
  };
  let mtime = 1000;
  for (const path of notes) r.host.seed(path, body(path), mtime++);
  const engine = engineFor(r.state);
  await engine.start();
  await timers.run(1000, () => notes.every((path) => r.state.fileByPath(path) !== undefined));
  return { ...r, timers, engine, engineFor };
}

test("the hold, and Restore here, survive a restart", async (t) => {
  // Twelve of thirty: at the floor, and under half, which the startup pass's
  // share rule alone would publish -- so only the persisted question keeps it.
  const all = Array.from({ length: 30 }, (_, index) => `Notes/r${String(index).padStart(2, "0")}.md`);
  const gone = all.slice(0, 12);
  const d = await restartable(t, all);
  for (const path of gone) {
    d.host.files.delete(path);
    d.engine.deleted(path);
  }
  await d.timers.run(1000, () => d.engine.heldDeletionCount === gone.length);
  await d.state.settled();
  d.engine.stop();

  // The next start of the plugin, over what it saved.
  const state = await d.reload();
  assert.deepEqual([...state.data.heldDeletions].sort(), gone, "the hold was not saved");
  d.host.notices.length = 0;
  d.host.asked.length = 0;
  const engine = d.engineFor(state);
  await engine.start();
  await d.timers.run(1000);

  assert.deepEqual(tombstones(d.server), [], `${tombstones(d.server).length} held deletions were published by a restart`);
  assert.equal(engine.heldDeletionCount, gone.length);
  assert.deepEqual(d.host.asked, [{
    message: "obsync is still holding back 12 deletions (in Notes) from your other devices. Delete them there too?",
    actions: HELD_ACTIONS,
  }]);

  const before = d.server.journal.length;
  await engine.restoreHeldDeletions();
  await d.timers.run(1000);
  for (const path of gone) assert.equal(d.host.text(path), body(path), `${path} was not put back after the restart`);
  assert.equal(d.server.journal.length, before, "Restore here published something");
  assert.deepEqual(copies(d.host), []);
  await state.settled();
  assert.deepEqual((await d.reload()).data.heldDeletions, [], "the answered question was saved as still open");
});

test("a note that cannot be put back now stays held, and says so", async (t) => {
  const d = await restartable(t, NOTES);
  for (const path of NOTES) {
    d.host.files.delete(path);
    d.engine.deleted(path);
  }
  await d.timers.run(1000, () => d.engine.heldDeletionCount === NOTES.length);
  d.server.unreachable.add(KEYS.deviceId);

  await d.engine.restoreHeldDeletions();

  assert.equal(d.engine.heldDeletionCount, NOTES.length, "an unanswered restore dropped the question");
  assert.deepEqual(tombstones(d.server), []);
  assert.match(d.host.notices.at(-1), /^obsync put 0 note\(s\) back on this device, and deleted nothing anywhere\. 20 could not be put back yet/);
  assert.deepEqual(d.host.asked.at(-1).actions, HELD_ACTIONS);
});
