/**
 * Folder structure converges, and a 1.0.x device refuses to try (issue #104).
 *
 * WHAT WAS BROKEN. The engine synced FILES. An empty folder made on the
 * desktop never reached the phone, and a folder deleted on one device left
 * its empty tree standing on every other one. Neither loses data; both leave
 * the vault looking different on every device and are fixed by hand.
 *
 * THE COMPATIBILITY BOUNDARY IS FIRST. About a hundred installs are on
 * 1.0.x and will receive folder records from an updated device before they
 * update themselves. A folder record must be REFUSED there — never written as
 * a file at the folder's path, never a crash, never a wedged feed — so the
 * released decoder is vendored (`fixtures/decoder-1.0.x.mjs`) and the records
 * this branch publishes are fed to it.
 *
 * TWO DEVICES, ONE SERVER, REAL EVENTS. The convergence tests drive the same
 * rig issue #96 established (`fake.mjs`, `pair`): a vault that reports
 * every mutation back as an event, the plugin's own `registerVaultEvents`,
 * the real transport signing and the real engine on a desktop and a mobile
 * configuration. The refusal tests drive one engine directly, because what
 * they are about is a record no honest device would ever publish.
 *
 * PLATFORM. Neither half exercises `ObsidianHost` — `FileManager.trashFile`
 * on a folder, `adapter.mkdir`, `readdir` — which stays a real-device
 * acceptance run (`docs/validation.md`).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FakeTimers, STEP_MS, pair, rig, sandbox, settled } from "./fake.mjs";
import { ManifestError, parseManifest } from "./fixtures/decoder-1.0.x.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile, pushFolder } = require("../build/sync/push.js");
const { SyncEngine } = require("../build/sync/engine.js");

const DOMAIN = "0123456789abcdef0123456789abcdef";
const OTHER_DEVICE = "ffffffffffffffffffffffffffffffff";

/** The manifest a folder record carries, exactly as `pushFolder` builds it. */
const folderManifest = (path, deleted = false) =>
  ({ v: 2, kind: "directory", path, domain: DOMAIN, size: 0, chunks: [], sha256: "", deleted });

/** The id a folder record carries on every device: a function of its path. */
const folderId = (keys, path) => c.folderFileId(keys.manifestKey, path);

/** Publish a folder record from the OTHER device, so the pull path applies it. */
async function publishFolder(server, keys, path, { deleted = false, parents = [], manifest, fileId } = {}) {
  return server.publishManifest({
    fileId: fileId ?? (await folderId(keys, path)),
    manifest: manifest ?? folderManifest(path, deleted),
    sids: [],
    parents,
    deviceId: OTHER_DEVICE,
    manifestKey: keys.manifestKey,
    bytes: 0,
  });
}

/** What each device holds, for a failure that has to be read. */
const story = (a, b) =>
  [`desktop_files=${JSON.stringify([...a.host.files.keys()])}`,
    `desktop_folders=${JSON.stringify([...a.host.explicitFolders])}`,
    `phone_files=${JSON.stringify([...b.host.files.keys()])}`,
    `phone_folders=${JSON.stringify([...b.host.explicitFolders])}`,
    `phone_trashed=${JSON.stringify(b.host.trashed)}`].join(" ");

// --- create -------------------------------------------------------------

/**
 * BOTH DIRECTIONS, EVERY TIME. The owner reported the create defect from the
 * PHONE and the delete defect from the DESKTOP, so each is driven each way:
 * `from` is the device that acts, `to` the device that must follow.
 */
const directions = [
  { name: "desktop to phone", from: "a", to: "b" },
  { name: "phone to desktop", from: "b", to: "a" },
];

for (const { name, from, to } of directions) {
  test(`an empty folder made on one device appears on the other (${name})`, async (t) => {
    const devices = await pair(t);
    const { server, timers } = devices;
    const acts = devices[from];
    const follows = devices[to];
    await devices.a.engine.start();
    await devices.b.engine.start();

    acts.host.makeFolder("Ideas");
    await timers.run(STEP_MS, () =>
      follows.host.hasFolder("Ideas") && follows.state.folderByPath("Ideas") !== undefined);
    await timers.run(STEP_MS);

    // ONE version post in the whole exchange: the acting device's. The other
    // device's own vault reported the folder the pull had just made, and it
    // answered with nothing (`engine.ts`, ECHOES).
    assert.equal(
      server.requests.filter((request) => request.target.includes("/versions") && request.json !== null).length,
      1,
      `the folder was published back: ${story(devices.a, devices.b)}`,
    );
    assert.equal(follows.host.hasFolder("Ideas"), true, `the folder never arrived: ${story(devices.a, devices.b)}`);
    assert.equal(follows.host.files.size, 0, "and nothing was written into it");
    assert.equal(follows.state.folderByPath("Ideas") !== undefined, true, "it was not recorded");
    assert.ok(
      follows.host.logs.some((line) => line.includes("folder path_class=folder decision=created")),
      follows.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
    );
    assert.ok(acts.host.logs.some((line) =>
      line.includes("folder path_class=folder decision=published reason=created")));
  });
}

test("a nested folder arrives whole, parents and all", async (t) => {
  const { timers, a, b } = await pair(t);
  await a.engine.start();
  await b.engine.start();

  const chain = ["Work", "Work/2026", "Work/2026/Q3"];
  a.host.makeFolder("Work/2026/Q3");
  // Each folder is its own record, so the deepest one arriving does not mean
  // the others have: wait for all three, not for the one that implies them.
  await timers.run(STEP_MS, () => chain.every((path) => b.state.folderByPath(path) !== undefined));

  for (const path of chain) {
    assert.equal(b.host.hasFolder(path), true, `the phone is missing ${path}: ${story(a, b)}`);
    assert.equal(b.state.folderByPath(path) !== undefined, true, `${path} was not recorded`);
  }
});

test("the same folder made on BOTH devices is one record, not two", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);
  await a.engine.start();
  await b.engine.start();

  // Both users make `Projects` before either has heard of the other's. A
  // folder record's id is derived from its path, and its manifest carries no
  // timestamp, so the two devices produce the same version of the same file
  // and the second post is the server's documented no-op.
  a.host.makeFolder("Projects");
  b.host.makeFolder("Projects");
  await timers.run(STEP_MS, () =>
    a.state.folderByPath("Projects") !== undefined && b.state.folderByPath("Projects") !== undefined);
  await timers.run(STEP_MS);

  const id = await folderId(k, "Projects");
  assert.deepEqual(server.vaultFiles(), [id], `the folder forked: ${story(a, b)}`);
  assert.equal(server.files.get(id).versions.length, 1, "one version, posted twice");
  assert.equal(server.files.get(id).heads.length, 1, "and one head");
  assert.equal(a.state.folderByPath("Projects").fileId, id);
  assert.equal(b.state.folderByPath("Projects").fileId, id);
});

test("publishing a folder this device already has a record for costs no request", async () => {
  const { context, host, server } = await rig();
  host.explicitFolders.add("Ideas");
  assert.notEqual(await pushFolder(context, "Ideas"), null);
  const posts = () => server.requests.filter((request) => request.target.includes("/versions")).length;
  const once = posts();

  // The second call is what startup reconciliation and the vault's own echo
  // both arrive as. The post would be a `200` no-op on the server, so the
  // journal cannot show this: the REQUEST is what is saved.
  assert.equal(await pushFolder(context, "Ideas"), null, "a published folder was published again");
  assert.equal(posts(), once, "a folder already recorded here cost a request");
});

// --- delete -------------------------------------------------------------

for (const { name, from, to } of directions) {
  test(`a deleted folder takes its tree off the other device, and a sibling survives (${name})`, async (t) => {
    const devices = await pair(t);
    const { timers } = devices;
    const acts = devices[from];
    const follows = devices[to];
    acts.host.write("Tree/Deep/note.md", "the last note\n", 1000);
    acts.host.write("Tree/Keep/kept.md", "a note that stays\n", 1000);
    await devices.a.engine.start();
    await devices.b.engine.start();
    await timers.run(STEP_MS, () =>
      follows.host.text("Tree/Deep/note.md") !== null && follows.host.text("Tree/Keep/kept.md") !== null &&
      follows.state.folderByPath("Tree/Deep") !== undefined && follows.state.folderByPath("Tree/Keep") !== undefined);

    acts.host.removeFolder("Tree/Deep");
    await timers.run(STEP_MS, () =>
      follows.host.text("Tree/Deep/note.md") === null && !follows.host.hasFolder("Tree/Deep"));
    await timers.run(STEP_MS);

    const told = story(devices.a, devices.b);
    assert.equal(follows.host.text("Tree/Deep/note.md"), null, `the note survived: ${told}`);
    assert.equal(follows.host.hasFolder("Tree/Deep"), false, `an empty folder was left behind: ${told}`);
    assert.equal(follows.state.folderByPath("Tree/Deep"), undefined, "and its record was kept");
    // The sibling still holds a note, so neither it nor the trunk goes.
    assert.equal(follows.host.text("Tree/Keep/kept.md"), "a note that stays\n", `the sibling was lost: ${told}`);
    assert.equal(follows.host.hasFolder("Tree/Keep"), true, `the sibling folder went: ${told}`);
    assert.equal(follows.host.hasFolder("Tree"), true, `the trunk went with the branch: ${told}`);
    assert.ok(follows.host.logs.some((line) =>
      line.includes("folder path_class=folder decision=removed reason=tombstone")));

    // And now the trunk itself: every record under it goes, deepest first.
    acts.host.removeFolder("Tree");
    await timers.run(STEP_MS, () => !follows.host.hasFolder("Tree"));
    await timers.run(STEP_MS);
    assert.equal(follows.host.hasFolder("Tree"), false, `the trunk was kept: ${story(devices.a, devices.b)}`);
    assert.equal(follows.host.files.size, 0, `a note was kept: ${story(devices.a, devices.b)}`);
    assert.deepEqual(Object.keys(follows.state.data.folders), [], "and it still holds folder records");
  });
}

test("a folder the other device still has something in is kept, and goes when that leaves", async (t) => {
  const { context, host, server, state, keys: k } = await rig();
  // The folder, its note, and then a local file nobody else knows about.
  const folder = await publishFolder(server, k, "Shared");
  assert.equal(await applyChange(context, folder), "applied");
  const note = await server.publish({
    fileId: "42".repeat(16), path: "Shared/note.md", bytes: new TextEncoder().encode("hi\n"),
    mtime: 1757200001000, domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, note), "applied");
  host.seed("Shared/local-only.md", "not synced yet", 2000);

  // The other device deletes the whole folder. The note goes; the folder
  // cannot, because this device still has something of its own in it.
  const tombstone = await publishFolder(server, k, "Shared", { deleted: true, parents: [folder.version_id] });
  assert.equal(await applyChange(context, await server.publishTombstone({
    fileId: "42".repeat(16), path: "Shared/note.md", manifestKey: k.manifestKey, parents: [note.version_id],
  })), "deleted");
  assert.equal(await applyChange(context, tombstone), "skipped");
  assert.equal(host.hasFolder("Shared"), true, "a folder holding an unsynced file was removed");
  assert.equal(host.text("Shared/local-only.md"), "not synced yet", "and it took the file with it");
  assert.equal(state.folderByPath("Shared"), undefined, "the record is gone even though the folder stayed");
  assert.ok(host.logs.some((line) => line.includes("folder path_class=folder decision=kept reason=not_empty")));
});

test("a folder no device ever published goes when its last file does", async (t) => {
  const { context, host, server, keys: k } = await rig();
  // What a 1.0.x device's vault looks like: files in folders, no folder
  // records anywhere. Nothing will ever tombstone `Legacy/Deep`.
  const note = await server.publish({
    fileId: "77".repeat(16), path: "Legacy/Deep/only.md", bytes: new TextEncoder().encode("bye\n"),
    mtime: 1757200001000, domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, note), "applied");
  assert.equal(host.hasFolder("Legacy/Deep"), true);

  assert.equal(await applyChange(context, await server.publishTombstone({
    fileId: "77".repeat(16), path: "Legacy/Deep/only.md", manifestKey: k.manifestKey, parents: [note.version_id],
  })), "deleted");

  assert.equal(host.hasFolder("Legacy/Deep"), false, "the empty folder was left behind");
  assert.equal(host.hasFolder("Legacy"), false, "and so was its parent");
  assert.deepEqual(host.trashed, ["Legacy/Deep/only.md", "Legacy/Deep", "Legacy"]);
  assert.ok(host.logs.some((line) => line.includes("folder path_class=folder decision=removed reason=empty_parent")));
});

test("a folder a pulled file made is recorded here too, so nobody's silence can empty it", async (t) => {
  const { timers, a, b } = await pair(t);
  a.host.write("Deep/Nested/note.md", "a note two folders down\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    settled(b, "Deep/Nested/note.md") && b.state.folderByPath("Deep/Nested") !== undefined);
  await timers.run(STEP_MS);

  // The phone made `Deep` and `Deep/Nested` on its way to writing the note.
  // It holds a record for each of them, from its own vault's create event --
  // which is what stops the empty-parent walk from taking them the moment the
  // note leaves, because a folder with a record goes only by its own
  // tombstone. A device that says nothing about a folder never deletes it.
  for (const path of ["Deep", "Deep/Nested"]) {
    assert.equal(b.state.folderByPath(path) !== undefined, true, `${path} was left unclaimed`);
  }

  // The desktop deletes the NOTE and keeps the folders, which is exactly what
  // a device that cannot publish folder records looks like from here.
  a.host.remove("Deep/Nested/note.md");
  await timers.run(STEP_MS, () => b.host.text("Deep/Nested/note.md") === null);
  await timers.run(STEP_MS);

  assert.equal(b.host.hasFolder("Deep/Nested"), true, `the phone emptied a folder nobody deleted: ${story(a, b)}`);
  assert.equal(b.host.hasFolder("Deep"), true, `the phone took the parent too: ${story(a, b)}`);
  assert.equal(a.host.hasFolder("Deep/Nested"), true, "and the desktop still has it");
});

test("a note deleted out of a folder leaves the folder standing on the other device", async (t) => {
  const { timers, a, b } = await pair(t);
  a.host.write("Keep/only.md", "the only note\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Keep/only.md") !== null && b.state.folderByPath("Keep") !== undefined);

  // The NOTE goes; the folder does not. The desktop still has `Keep`, so a
  // phone that swept it up because it was suddenly empty would be inventing a
  // deletion nobody made.
  a.host.remove("Keep/only.md");
  await timers.run(STEP_MS, () => b.host.text("Keep/only.md") === null);
  await timers.run(STEP_MS);

  assert.equal(b.host.hasFolder("Keep"), true, `the phone deleted a folder the desktop still has: ${story(a, b)}`);
  assert.equal(b.state.folderByPath("Keep") !== undefined, true, "and it kept the record");
  assert.equal(a.host.hasFolder("Keep"), true);
});

test("applying a folder tombstone costs the receiving device no request of its own", async (t) => {
  const { server, timers, a, b } = await pair(t);
  await a.engine.start();
  await b.engine.start();
  a.host.makeFolder("Ideas");
  await timers.run(STEP_MS, () => b.state.folderByPath("Ideas") !== undefined);

  const posted = (device) => server.requests.filter((request) =>
    request.method === "POST" && request.target.includes("/versions") &&
    request.json !== null).length;
  const before = posted();
  a.host.removeFolder("Ideas");
  await timers.run(STEP_MS, () => !b.host.hasFolder("Ideas"));
  await timers.run(STEP_MS);

  // One version post: the desktop's tombstone. The phone obeyed it, and its
  // own vault reported the removal to it, and it published nothing back
  // (`engine.ts`, ECHOES; issue #96).
  assert.equal(posted() - before, 1, `the phone answered a deletion with a post: ${story(a, b)}`);
  assert.equal(server.journal.filter((frame) => frame.deleted).length, 1);
  assert.ok(b.host.logs.some((line) =>
    line.includes("watch path_class=folder decision=echo_suppressed event=delete")));
});

test("a folder kept because it was not empty can still be deleted here afterwards", async (t) => {
  const { host, server, state, transport, keys: k } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport, host, now: () => host.clock, timers });
  await engine.start();
  t.after(() => engine.stop());
  const context = engine.context;

  const created = await publishFolder(server, k, "Shared");
  assert.equal(await applyChange(context, created), "applied");
  // A note only this device has, so the folder cannot be removed here.
  host.seed("Shared/local-only.md", "not pushed yet", 2000);
  assert.equal(
    await applyChange(context, await publishFolder(server, k, "Shared", { deleted: true, parents: [created.version_id] })),
    "skipped",
  );

  // The folder has no record now, so reconciliation publishes one: it is a
  // folder this device holds like any other.
  await engine.syncNow();
  await timers.run(STEP_MS, () => state.folderByPath("Shared") !== undefined);
  assert.equal(state.folderByPath("Shared") !== undefined, true, "the kept folder was never republished");

  // And the user's own deletion of it must still reach the other devices: a
  // suppression owed to an event that never came must not swallow this.
  host.files.delete("Shared/local-only.md");
  await host.trashFolder("Shared");
  engine.folderDeleted("Shared");
  await timers.run(STEP_MS, () => state.folderByPath("Shared") === undefined);
  const mine = server.journal.filter((frame) => frame.deleted && frame.device_id === context.deviceId);
  assert.equal(mine.length, 1, "this device's own folder deletion was swallowed");
  assert.equal(mine[0].file_id, await folderId(k, "Shared"));
});

/** Apply a file, then its tombstone, and report which folders were asked about. */
async function emptyOut(r, fileId, path) {
  const created = await r.server.publish({
    fileId, path, bytes: new TextEncoder().encode("bye\n"),
    mtime: 1757200001000, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, created), "applied");
  r.host.folderChecks.length = 0;
  assert.equal(await applyChange(r.context, await r.server.publishTombstone({
    fileId, path, manifestKey: r.keys.manifestKey, parents: [created.version_id],
  })), "deleted");
  return r.host.folderChecks;
}

test("the empty-parent walk stops at the first folder it keeps", async (t) => {
  const r = await rig();
  r.host.seed("A/B/Other/stays.md", "a note that keeps its folder", 1000);

  const asked = await emptyOut(r, "81".repeat(16), "A/B/C/gone.md");

  // `A/B/C` is empty and goes. `A/B` is asked, keeps itself because `Other`
  // is in it, and the walk stops there: a folder holding a folder is not
  // empty either, so `A` is never even asked.
  assert.deepEqual(asked, ["A/B/C", "A/B"], "the walk did not stop where it should");
  assert.equal(r.host.hasFolder("A/B/C"), false);
  assert.equal(r.host.hasFolder("A/B"), true);
  assert.equal(r.host.hasFolder("A"), true);
});

test("the empty-parent walk never reaches the selected sync root", async (t) => {
  const r = await rig();
  r.state.data.syncFolders = ["Root"];

  const asked = await emptyOut(r, "82".repeat(16), "Root/Deep/gone.md");

  // `Root` itself is the selection, not a folder inside it: no folder record
  // may name it, so nothing here may remove it either.
  assert.deepEqual(asked, ["Root/Deep"], "the walk reached the sync root");
  assert.equal(r.host.hasFolder("Root/Deep"), false);
  assert.equal(r.host.hasFolder("Root"), true, "the selected folder was removed");
});

// --- rename -------------------------------------------------------------

for (const { name, from, to } of directions) {
  test(`an empty folder renamed on one device is renamed on the other (${name})`, async (t) => {
    const devices = await pair(t);
    const { timers } = devices;
    const acts = devices[from];
    const follows = devices[to];
    await devices.a.engine.start();
    await devices.b.engine.start();
    acts.host.makeFolder("Drafts");
    await timers.run(STEP_MS, () => follows.state.folderByPath("Drafts") !== undefined);

    acts.host.renameFolder("Drafts", "Published");
    await timers.run(STEP_MS, () => follows.host.hasFolder("Published"));
    await timers.run(STEP_MS);

    const told = story(devices.a, devices.b);
    // Renamed, not duplicated: exactly one of the two names exists, on both.
    assert.equal(follows.host.hasFolder("Published"), true, `the new name never arrived: ${told}`);
    assert.equal(follows.host.hasFolder("Drafts"), false, `the old name was left behind: ${told}`);
    assert.equal(acts.host.hasFolder("Published"), true, told);
    assert.equal(acts.host.hasFolder("Drafts"), false, told);
    assert.equal(follows.state.folderByPath("Published") !== undefined, true);
    assert.equal(follows.state.folderByPath("Drafts"), undefined);
  });
}

// --- startup reconciliation ---------------------------------------------

test("startup reconciliation publishes a record for every folder that has none, once", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);
  // A vault from before 1.1.0: folders exist, no folder record does.
  a.host.write("Old/note.md", "written before folders synced\n", 1000);
  a.host.explicitFolders.add("Old/Empty");
  await a.engine.start();
  // THE NOTE TOO, AND NOT ONLY THE FOLDERS. The reconcile pass publishes
  // every folder record it owes BEFORE any file work (`survey`; review round
  // 4, finding 3), so a milestone naming the folder records alone is reached
  // with the note still in the queue -- and the second pass below would then
  // be measured against a journal that had not finished growing.
  await timers.run(STEP_MS, () =>
    a.state.folderByPath("Old") !== undefined && a.state.folderByPath("Old/Empty") !== undefined &&
    settled(a, "Old/note.md"));
  const published = server.journal.length;
  // AND THE FOLDERS WENT FIRST. The pass publishes every folder record it
  // owes before any file work, so a receiver never meets a note under a
  // folder whose record is still queued behind it -- which is the order a
  // rename by capitalisation alone depends on, and the order a restart used
  // to lose (review round 4, finding 3).
  const at = (id) => server.journal.findIndex((frame) => frame.file_id === id);
  assert.ok(
    at(await folderId(k, "Old")) < at(a.state.fileByPath("Old/note.md").fileId),
    `the note was journaled before its folder's record: ${story(a, b)}`,
  );
  assert.ok(
    at(await folderId(k, "Old/Empty")) < at(a.state.fileByPath("Old/note.md").fileId),
    `the note was journaled before the empty folder's record: ${story(a, b)}`,
  );

  // A second pass publishes nothing: the records exist now.
  await a.engine.syncNow();
  await timers.run(STEP_MS);
  assert.equal(server.journal.length, published, "reconciliation republished folders it already had");
  assert.ok(a.host.logs.some((line) =>
    line.includes("reconcile decision=start") && line.includes("budget_folders=2")));
  assert.ok(a.host.logs.some((line) => line.includes("reconcile decision=queued") && line.includes("folders_queued=2")));

  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.hasFolder("Old/Empty") && settled(b, "Old/note.md"));
  assert.equal(b.host.hasFolder("Old/Empty"), true, `the empty folder never converged: ${story(a, b)}`);
});

test("startup reconciliation tombstones a folder deleted while Obsidian was closed", async (t) => {
  const { context, host, server, state, transport, keys: k } = await rig();
  host.explicitFolders.add("Gone");
  await pushFolder(context, "Gone");
  // Removed in Finder, or on another device's filesystem, with the app shut.
  host.explicitFolders.delete("Gone");

  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport, host, now: () => host.clock, timers });
  await engine.start();
  t.after(() => engine.stop());
  await timers.run(STEP_MS, () => state.folderByPath("Gone") === undefined);

  const tombstones = server.journal.filter((frame) => frame.deleted);
  assert.equal(tombstones.length, 1, "the folder was never tombstoned");
  assert.equal(tombstones[0].file_id, await folderId(k, "Gone"));
  assert.equal(state.folderByPath("Gone"), undefined, "the record outlived the folder");
});

// --- refusals -----------------------------------------------------------

test("a folder record where this device has a FILE is refused, and the file is untouched", async (t) => {
  const { context, host, server, state, keys: k } = await rig();
  host.seed("Notes", "a file, not a folder\n", 1000);

  const record = await publishFolder(server, k, "Notes");
  assert.equal(await applyChange(context, record), "refused");

  assert.equal(host.text("Notes"), "a file, not a folder\n", "the file was replaced");
  assert.equal(host.hasFolder("Notes"), false);
  assert.equal(state.folderByPath("Notes"), undefined);
  assert.deepEqual(host.trashed, []);
  assert.ok(host.logs.some((line) => line.includes("folder path_class=folder decision=refused reason=not_a_directory")));
  assert.equal(host.notices.length, 1, "the user is told once");
});

test("a folder record naming a path outside the vault is refused before anything is made", async (t) => {
  const { context, host, server, keys: k } = await rig();
  const refusals = [
    ["../outside", "path_dot_segment"],
    ["/etc", "path_absolute"],
    ["a/../../b", "path_dot_segment"],
    [".obsidian/plugins", "path_hidden_segment"],
    ["C:/windows", "path_drive_letter"],
  ];
  for (const [path, reason] of refusals) {
    const record = await publishFolder(server, k, path, { fileId: "aa".repeat(16) });
    assert.equal(await applyChange(context, record), "refused", path);
    assert.ok(
      host.logs.some((line) => line.includes(`decision=refused reason=${reason}`)),
      `${path}: ${host.logs.filter((line) => line.includes("refused")).join(" | ")}`,
    );
  }
  assert.equal(host.explicitFolders.size, 0, "a refused path still made a folder");
  assert.equal(host.files.size, 0);
});

test("a folder record that disagrees with the version it rode in is refused", async (t) => {
  const { context, host, server, keys: k } = await rig();
  const cases = [
    // A folder wearing a chunk list: the fetch it would buy is refused here.
    [{ ...folderManifest("A"), chunks: [{ sid: "ab".repeat(32), cid: "cd".repeat(32), len: 8 }] }, {}, "chunk_count"],
    [{ ...folderManifest("A"), size: 4096 }, {}, "size"],
    [{ ...folderManifest("A"), sha256: "ef".repeat(32) }, {}, "sha256"],
    [{ ...folderManifest("A"), kind: "file" }, {}, "kind"],
    // Shape agrees; the RECORD does not.
    [folderManifest("A"), { bytes: 4096 }, "record_bytes"],
    [folderManifest("A", true), { deleted: false }, "record_deleted"],
    [folderManifest("A"), { domainId: "ff".repeat(16) }, "record_domain"],
    [{ ...folderManifest("A"), domain: "ff".repeat(16) }, { domainId: DOMAIN }, "manifest_domain"],
    [folderManifest("A"), { sids: ["ab".repeat(32)] }, "record_sid_count"],
  ];
  for (const [manifest, record, reason] of cases) {
    const published = await server.publishManifest({
      fileId: await folderId(k, "A"), manifest, sids: [], parents: [], deviceId: OTHER_DEVICE,
      manifestKey: k.manifestKey, bytes: 0, domainId: DOMAIN, ...record,
    });
    assert.equal(await applyChange(context, published), "refused", reason);
    assert.ok(
      host.logs.some((line) => line.includes(`decision=refused reason=${reason}`)),
      `${reason}: ${host.logs.filter((line) => line.includes("refused")).join(" | ")}`,
    );
  }
  assert.equal(host.explicitFolders.size, 0, "a refused record still made a folder");
});

test("a manifest version this build does not know is refused, and the feed moves on", async (t) => {
  const { context, host, server, state, keys: k } = await rig();
  // What 1.0.x does with a `v: 2` record is what this build must do with a
  // `v: 4` one: refuse it, write nothing, tell the user once, keep going.
  const future = await server.publishManifest({
    fileId: "5a".repeat(16),
    manifest: { v: 4, path: "Later.md", size: 0, mtime: 1757200000000, domain: DOMAIN, chunks: [], sha256: "", deleted: false },
    sids: [], parents: [], deviceId: OTHER_DEVICE, manifestKey: k.manifestKey, bytes: 0,
  });
  assert.equal(await applyChange(context, future), "refused");
  assert.equal(host.files.size, 0, "a version nothing understands was written");
  assert.equal(host.explicitFolders.size, 0);
  assert.deepEqual(host.trashed, []);
  assert.equal(state.fileByPath("Later.md"), undefined);
  assert.equal(host.notices.length, 1);
  assert.ok(host.logs.some((line) => line.includes("decision=refused reason=version")));

  // The feed is not wedged: the next record applies.
  const note = await server.publish({
    fileId: "5b".repeat(16), path: "After.md", bytes: new TextEncoder().encode("still syncing\n"),
    mtime: 1757200002000, domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, note), "applied");
  assert.equal(host.text("After.md"), "still syncing\n");
});

// --- the 1.0.x boundary --------------------------------------------------

/** Decrypt what the server holds for a file id, the way any device would. */
async function manifestJson(server, keys, fileId) {
  const frame = server.journal.filter((entry) => entry.file_id === fileId).pop();
  assert.ok(frame, `nothing was published for ${fileId}`);
  const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
  return c.decryptManifest(
    keys.manifestKey, frame.file_id, binder,
    Uint8Array.from(Buffer.from(frame.manifest_nonce, "hex")), c.unbase64(frame.manifest_ct),
  );
}

test("every shipped 1.0.x decoder refuses this build's folder records, and still reads its files", async () => {
  const { host, server, context, keys: k } = await rig();

  // The control that stops this from being a test of a decoder that throws at
  // everything: an ORDINARY file this build publishes is still read by it.
  host.seed("Notes/Ideas.md", "# Ideas\n", 1000);
  await pushFile(context, "Notes/Ideas.md");
  const fileId = context.state.fileByPath("Notes/Ideas.md").fileId;
  const file = parseManifest(await manifestJson(server, k, fileId));
  assert.equal(file.path, "Notes/Ideas.md");
  assert.equal(file.v, 1, "this build changed the shape 1.0.x devices read");

  // The folder record and its tombstone: refused, by `v`, before the decoder
  // has looked at anything a write would use.
  host.explicitFolders.add("Notes/Empty");
  await pushFolder(context, "Notes/Empty");
  const folder = await folderId(k, "Notes/Empty");
  for (const stage of ["created", "deleted"]) {
    if (stage === "deleted") {
      const { pushFolderDelete } = require("../build/sync/push.js");
      await pushFolderDelete(context, "Notes/Empty");
    }
    const json = await manifestJson(server, k, folder);
    assert.equal(JSON.parse(json).path, "Notes/Empty", `${stage}: the record names the folder`);
    assert.throws(
      () => parseManifest(json),
      (error) => error instanceof ManifestError && error.reason === "version",
      `${stage}: a 1.0.x device would have acted on a folder record`,
    );
  }
});

test("a 1.0.x history scan and repair loop never meet a folder record", async (t) => {
  const { context, host, server, state, keys: k } = await rig();
  // History reads every record through the same decoder, so a folder record
  // is one refused ROW, counted and logged — never a throw that ends the scan
  // and never a row offered for restore.
  const { HistoryBrowser, HistoryOperation } = require("../build/sync/history.js");
  await publishFolder(server, k, "Ideas");
  await server.publish({
    fileId: "6c".repeat(16), path: "Ideas/note.md", bytes: new TextEncoder().encode("readable\n"),
    mtime: 1757200003000, domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  const browser = new HistoryBrowser(context, new HistoryOperation(), () => host.clock);
  const page = await browser.next();
  assert.deepEqual(page.entries.map((entry) => entry.path), ["Ideas/note.md"], "a folder was offered as a file");
  assert.equal(page.refused, 1, "the folder record was not counted as refused");
  assert.ok(host.logs.some((line) => line.includes("history path_class=manifest decision=refused")));

  // Repair walks `state.data.files`, which folder records never enter, so it
  // cannot present one to the decoder at all.
  state.data.folders["Ideas"] = { fileId: await folderId(k, "Ideas"), versionId: "0".repeat(64) };
  assert.deepEqual(Object.keys(state.data.files), [], "a folder record reached the file map");
});

// --- the mobile host -----------------------------------------------------

/**
 * `ObsidianHost` with NO desktop seam: the branch every iOS and Android
 * install takes, where the vault is reached only through Obsidian's adapter.
 * The desktop branch is proved on a real filesystem in `symlink.test.mjs`;
 * this proves the other half answers a file/folder collision the same way.
 */
async function mobileHost(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const files = new Map();
  const folders = new Set();
  const logs = [];
  const adapter = {
    stat: async (path) => {
      if (files.has(path)) return { type: "file", mtime: files.get(path).mtime, size: files.get(path).bytes.length };
      return folders.has(path) ? { type: "folder", mtime: 0, size: 0 } : null;
    },
    exists: async (path) => files.has(path) || folders.has(path),
    mkdir: async (path) => {
      for (const part of path.split("/").map((_, index, all) => all.slice(0, index + 1).join("/"))) folders.add(part);
    },
    writeBinary: async (path, buffer, options) => {
      files.set(path, { bytes: new Uint8Array(buffer), mtime: options?.mtime ?? 0 });
    },
    list: async (path) => ({
      files: [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)),
      folders: [...folders].filter((candidate) => candidate.startsWith(`${path}/`)),
    }),
    rmdir: async (path) => { folders.delete(path); },
  };
  const plugin = {
    state: { data: {} },
    app: {
      vault: {
        adapter,
        getFolderByPath: () => null,
        // Obsidian's own tree, which is what the host asks for its inventory.
        getAllFolders: () => [...folders].map((path) => ({ path })),
      },
      fileManager: { trashFile: async () => assert.fail("no cache entry") },
    },
    log: (line) => logs.push(line),
  };
  return { host: new ObsidianHost(plugin, null), plugin, files, folders, logs };
}

test("the mobile host makes a folder and its parents, and refuses one where a file stands", async (t) => {
  const { host, files, folders } = await mobileHost(t);

  await host.createFolder("Work/2026/Q3");
  assert.deepEqual([...folders].sort(), ["Work", "Work/2026", "Work/2026/Q3"]);
  // Idempotent: a folder that is already there is not an error.
  await host.createFolder("Work/2026");

  files.set("Notes", { bytes: new Uint8Array(1), mtime: 0 });
  await assert.rejects(host.createFolder("Notes"), /not a vault path \(not_a_directory\)/);
  assert.equal(folders.has("Notes"), false, "a file was turned into a folder");
});

test("the host lists only folders this device may sync", async (t) => {
  const { host, plugin, folders } = await mobileHost(t);
  for (const path of ["Notes", "Notes/Deep", "Archive", ".obsidian", ".obsidian/plugins"]) folders.add(path);

  // Whole-vault mode still excludes hidden folders: the vault-path rule takes
  // `.obsidian/**` out of sync in both directions.
  assert.deepEqual((await host.listFolders()).sort(), ["Archive", "Notes", "Notes/Deep"], "a hidden folder was listed");

  // With a selection: the folders inside it AND the selected folder itself,
  // which has a record like any other -- it is the only thing that can carry
  // that folder's own creation, removal or rename to another device (review
  // round 3, finding 1). Never a folder ABOVE it, and never a sibling.
  plugin.state.data.syncFolders = ["Notes"];
  assert.deepEqual(await host.listFolders(), ["Notes", "Notes/Deep"], "the selection was not honoured");
  plugin.state.data.syncFolders = ["Notes/Deep"];
  assert.deepEqual(await host.listFolders(), ["Notes/Deep"], "a folder above the selection was listed");
});

test("the mobile host keeps a folder that holds anything and removes an empty one", async (t) => {
  const { host, files, folders } = await mobileHost(t);
  await host.createFolder("Shared/Inner");
  files.set("Shared/Inner/.hidden", { bytes: new Uint8Array(1), mtime: 0 });

  assert.equal(await host.trashFolder("Shared"), false, "a folder holding a subfolder was removed");
  assert.equal(await host.trashFolder("Shared/Inner"), false, "a folder holding a hidden file was removed");
  files.delete("Shared/Inner/.hidden");
  assert.equal(await host.trashFolder("Shared/Inner"), true);
  assert.equal(folders.has("Shared/Inner"), false);
  assert.equal(await host.trashFolder("Shared"), true);
  assert.equal(await host.trashFolder("Gone"), true, "an absent folder is already removed");
});

test("the mobile host refuses to write a file where a folder stands", async (t) => {
  const { host, files, folders } = await mobileHost(t);
  await host.createFolder("Notes");

  const writer = await host.writer("Notes");
  await writer.write(new Uint8Array([1, 2, 3]));
  await assert.rejects(writer.commit(1000), /not a vault path \(not_a_file\)/);

  assert.equal(files.has("Notes"), false, "a folder was overwritten with a file");
  assert.equal(folders.has("Notes"), true);
});
