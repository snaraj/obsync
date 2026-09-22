/**
 * The bulk-deletion guard (issue #123).
 *
 * A folder that IS a selected sync folder, renamed or moved from outside
 * Obsidian while the app is closed, reaches the next startup as every
 * recorded path under it having vanished: no rename event ever arrived, the
 * new paths sit outside the selection and are never queued, and the old ones
 * are simply gone. Published, those tombstones delete the notes on every
 * other device, while the notes themselves sit on this one under the new
 * name, untracked. Nothing was lost locally and nothing asked for a deletion;
 * the only thing that happened is that this device stopped being able to see
 * its own files.
 *
 * So the pass holds the tombstones, says what it found, and publishes nothing
 * until the user says which it was. What is proven here is the whole of that:
 * the hold, the silence on the wire, the one notice, the confirmation that
 * still deletes for real, and the ordinary small deletion that is untouched
 * by any of it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine, BULK_DELETION_MIN } = require("../build/sync/engine.js");

const BODY = "a note that must not be deleted on every other device\n";

/** One device, one engine, one fake clock. */
async function device(t, notes, folders) {
  const rigged = await rig();
  const { host, server, state } = rigged;
  if (folders !== undefined) state.data.syncFolders = folders;
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
  for (const path of notes) host.seed(path, BODY, 1000);
  await engine.start();
  await timers.run(1000, () => notes.every((path) => state.fileByPath(path) !== undefined));
  return { ...rigged, timers, engine };
}

/** Every tombstone on the wire: what a rename nobody saw must never produce. */
const tombstones = (server) => server.journal.filter((frame) => frame.deleted);

/** The notes a selected folder holds, enough of them to be a bulk deletion. */
const NOTES = Array.from({ length: BULK_DELETION_MIN + 2 }, (_, index) => `Notes/note-${index}.md`);

test("a selected folder renamed while Obsidian was closed publishes nothing and says so once", async (t) => {
  const { host, server, state, timers, engine } = await device(t, NOTES, ["Notes"]);
  assert.deepEqual(tombstones(server), [], "the seeding published a tombstone");

  // The rename, as a file manager makes it while the app is closed: the files
  // move, no vault event is ever fired, and the new folder is outside the
  // selection this device still holds.
  for (const path of NOTES) {
    host.files.set(path.replace("Notes/", "Journal/"), host.files.get(path));
    host.files.delete(path);
  }

  await engine.reconcile();
  await timers.run(1000);

  assert.deepEqual(tombstones(server), [],
    `a rename nobody saw was published as ${tombstones(server).length} deletions`);
  assert.equal(engine.heldDeletionCount, NOTES.length, "the pass did not hold what it refused to publish");
  assert.ok(
    host.logs.some((line) =>
      line.includes("decision=refused reason=bulk_deletion") &&
      line.includes(`candidates=${NOTES.length}`) &&
      line.includes(`tracked=${NOTES.length}`)),
    host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );
  assert.equal(host.notices.length, 1, `the user was told ${host.notices.length} times`);
  assert.match(host.notices[0], /stopped 7 deletions/);
  assert.match(host.notices[0], /Sync folders/, "the notice does not say how to put it right");

  // AND IT STAYS HELD. A second pass finds the same thing and must not talk
  // about it again: a notice per startup is how a user learns to dismiss it.
  await engine.reconcile();
  await timers.run(1000);
  assert.deepEqual(tombstones(server), [], "a second pass published what the first held");
  assert.equal(host.notices.length, 1, "the second pass told the user again");
  assert.equal(state.fileByPath(NOTES[0]).fileId.length, 32, "the records were dropped while nothing was published");
});

test("the user's confirmation publishes exactly what was held", async (t) => {
  const { host, server, state, timers, engine } = await device(t, NOTES, ["Notes"]);
  for (const path of NOTES) host.files.delete(path);
  await engine.reconcile();
  await timers.run(1000);
  assert.deepEqual(tombstones(server), [], "the deletion was published before it was confirmed");

  // A folder the user really did delete still reaches every device.
  engine.confirmHeldDeletions();
  await timers.run(1000, () => tombstones(server).length === NOTES.length);

  assert.equal(tombstones(server).length, NOTES.length, "the confirmed deletions never reached the server");
  assert.equal(engine.heldDeletionCount, 0, "the hold outlived the confirmation");
  assert.ok(
    host.logs.some((line) => line.includes(`decision=confirmed reason=bulk_deletion queued=${NOTES.length}`)),
    host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );
  for (const path of NOTES) assert.equal(state.fileByPath(path), undefined, `${path} is still tracked`);
});

test("confirming nothing publishes nothing", async (t) => {
  const { server, engine, timers } = await device(t, NOTES, ["Notes"]);
  const before = server.journal.length;
  engine.confirmHeldDeletions();
  await timers.run(1000);
  assert.equal(server.journal.length, before, "a confirmation with nothing held published something");
});

test("an ordinary deletion below the floor is published exactly as before", async (t) => {
  // The guard is about SHARE and about size together: one note deleted out of
  // seven is the ordinary case this must not touch, and a vault of two notes
  // emptied is below the floor, because holding that back would teach the
  // user to confirm without reading.
  const { host, server, timers, engine } = await device(t, NOTES, ["Notes"]);
  host.files.delete(NOTES[0]);
  await engine.reconcile();
  await timers.run(1000, () => tombstones(server).length === 1);

  assert.equal(tombstones(server).length, 1, "an ordinary deletion was held back");
  assert.equal(engine.heldDeletionCount, 0, "an ordinary deletion was held");
  assert.equal(
    host.logs.some((line) => line.includes("reason=bulk_deletion")),
    false,
    host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );
});

test("a deletion that is large but not most of the vault is published", async (t) => {
  // BOTH HALVES OF THE RULE, and this is the half a floor alone would miss.
  // Five notes is at the floor, so a test that only ever deletes everything
  // cannot tell "at least five" from "at least five AND more than half". Here
  // twelve are tracked and five go: a big tidy-up, not a device that has lost
  // sight of its vault, and it publishes.
  const many = Array.from({ length: 12 }, (_, index) => `Notes/many-${index}.md`);
  const going = many.slice(0, BULK_DELETION_MIN);
  const { host, server, timers, engine } = await device(t, many, ["Notes"]);
  for (const path of going) host.files.delete(path);
  await engine.reconcile();
  await timers.run(1000, () => tombstones(server).length === going.length);

  assert.equal(tombstones(server).length, going.length,
    `${going.length} of ${many.length} deletions were held back`);
  assert.equal(engine.heldDeletionCount, 0, "a deletion of fewer than half was held");
  assert.equal(
    host.logs.some((line) => line.includes("reason=bulk_deletion")),
    false,
    host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );
});

test("a small vault emptied is below the floor and still publishes", async (t) => {
  const few = NOTES.slice(0, BULK_DELETION_MIN - 1);
  const { host, server, timers, engine } = await device(t, few, ["Notes"]);
  for (const path of few) host.files.delete(path);
  await engine.reconcile();
  await timers.run(1000, () => tombstones(server).length === few.length);

  assert.equal(tombstones(server).length, few.length, `${few.length} deletions were held back`);
  assert.equal(engine.heldDeletionCount, 0);
});
