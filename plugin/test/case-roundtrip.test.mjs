/**
 * A folder's capitals changed and changed BACK, between two devices whose
 * disks fold case (issues #165, #166, #127).
 *
 * THE SERVER KEEPS ONE VERSION PER POSITION. A folder record's file id is
 * derived from its path and its manifest carries no time, so the record a
 * device publishes for `Team docs` is byte-for-byte the record the folder's
 * FIRST version was -- and posting a version the store already holds is a
 * `200` no-op (`docs/protocol.md`). A folder re-created where one was deleted,
 * which is what renaming `team docs` back to `Team docs` does to the record
 * for `Team docs`, therefore reached nobody: the other device received the
 * old spelling's tombstone and the moves, never the record that re-cases the
 * directory, refused every move, and told the user to update devices that
 * were already up to date (#165).
 *
 * OBSIDIAN'S INDEX IS THE OTHER HALF. The index is keyed by exact spelling
 * and a volume that folds case answers for both, so after the pull path
 * re-cases an entry the index still holds the OLD spelling: it reports those
 * names as changed and lists them (S24, S93). Each of those names has no
 * record here -- the record moved with the entry -- and a push of it minted a
 * brand-new file id: a duplicate of every note in the folder on the server,
 * which a device paired later adopted and then tried to delete (#166).
 * `staleIndex` models exactly that on the receiving device.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { SCAN_MS } = require("../build/sync/engine.js");
const { caseOnly } = require("../build/vaultPath.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const BODY = "# A note\nthat must survive its folder's capitals changing twice\n";
const OTHER = "second note\n";

const story = (server, a, b) =>
  [`journal=${server.journal.map((frame) => `${frame.seq}:${frame.device_id.slice(0, 4)}${frame.deleted ? ":tombstone" : ""}`).join(",")}`,
    `a_files=${JSON.stringify([...a.host.files.keys()])}`,
    `b_files=${JSON.stringify([...b.host.files.keys()])}`,
    `a_records=${JSON.stringify(Object.keys(a.state.data.files))}`,
    `b_records=${JSON.stringify(Object.keys(b.state.data.files))}`].join(" ");

/**
 * Obsidian's index over a volume that folds case, on the device that APPLIES
 * a re-case: after the entry is renamed, every name it had is still indexed,
 * reported as modified, and listed until the app restarts. Returns the stale
 * names, so a test can say which ones it expected.
 */
function staleIndex(host) {
  const stale = new Set();
  const moveFolder = host.moveFolder.bind(host);
  host.moveFolder = async (from, to) => {
    const source = host.resolveFolder(from);
    const before = source === undefined ? [] : [...host.files.keys()].filter((path) => path.startsWith(`${source}/`));
    const outcome = await moveFolder(from, to);
    if (outcome === "moved") {
      for (const path of before) {
        stale.add(path);
        host.emit("modify", host.entry(path));
      }
    }
    return outcome;
  };
  const move = host.move.bind(host);
  host.move = async (from, to) => {
    const source = host.resolve(from);
    const outcome = await move(from, to);
    if (outcome === "moved" && source !== undefined && caseOnly(source, to)) {
      stale.add(source);
      host.emit("modify", host.entry(source));
    }
    return outcome;
  };
  const list = host.list.bind(host);
  host.list = async () => {
    const real = await list();
    const extra = [];
    for (const path of stale) {
      const found = await host.stat(path);
      if (found !== null && !real.some((file) => file.path === path)) extra.push(found);
    }
    return [...real, ...extra];
  };
  return stale;
}

/** Every version POST a device makes, whatever the server answers. */
function countPosts(device) {
  const posts = [];
  const post = device.transport.postVersion.bind(device.transport);
  device.transport.postVersion = async (id, body) => {
    posts.push(id);
    return post(id, body);
  };
  return posts;
}

/** Two notes in one folder on two devices that both fold case. */
async function seeded(t, folder = "Team docs") {
  const devices = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: false });
  const { timers, a, b } = devices;
  const paths = [`${folder}/One.md`, `${folder}/Two.md`];
  a.host.write(paths[0], BODY, 1000);
  a.host.write(paths[1], OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text(paths[0]) === BODY && b.host.text(paths[1]) === OTHER &&
    paths.every((path) => settled(a, path) && settled(b, path)));
  return { ...devices, ids: paths.map((path) => a.state.fileByPath(path).fileId) };
}

/** Both notes recorded at `folder` on `device`, at the version the server holds as their head. */
const followed = (server, device, folder, ids) => ids.every((id, index) => {
  const path = `${folder}/${["One.md", "Two.md"][index]}`;
  const head = server.files.get(id)?.heads;
  return device.host.files.has(path) && head?.length === 1 && device.state.fileByPath(path)?.versionId === head[0];
});

test("a folder's capitals changed on one device and changed back on the other converge on both (#165)", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t);

  a.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () => followed(server, b, "team docs", ids) && followed(server, a, "team docs", ids));
  await timers.run(SCAN_MS);

  b.host.renameFolder("team docs", "Team docs");
  await timers.run(STEP_MS, () => followed(server, a, "Team docs", ids) && followed(server, b, "Team docs", ids));
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  for (const device of [a, b]) {
    assert.deepEqual(
      [...device.host.files.keys()].sort(),
      ["Team docs/One.md", "Team docs/Two.md"],
      `a device did not follow the rename back: ${story(server, a, b)}`,
    );
    assert.deepEqual(
      ["Team docs/One.md", "Team docs/Two.md"].map((path) => device.state.fileByPath(path)?.fileId),
      ids,
      `a device holds the notes under other ids: ${story(server, a, b)}`,
    );
  }
  assert.deepEqual(
    a.host.logs.filter((line) => line.includes("decision=case_move_refused")),
    [],
    `the first device refused the moves of the rename back: ${story(server, a, b)}`,
  );
  assert.deepEqual(a.host.notices, [], `the first device was told something: ${a.host.notices.join(" | ")}`);
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `a note was published twice: ${story(server, a, b)}`);
  // THE RECORD FOR `Team docs` IS LIVE AGAIN on the server, and it is the
  // one version every device settles on: made again over the tombstone that
  // retired it, not posted as the first version the store already held.
  const record = server.files.get(await c.folderFileId(keys.manifestKey, "Team docs"));
  assert.equal(record.heads.length, 1, `the folder record forked: ${JSON.stringify(record.heads)}`);
  assert.equal(record.versions.find((version) => version.version_id === record.heads[0]).deleted, false,
    `the folder's record on the server is still its tombstone: ${story(server, a, b)}`);
  assert.equal(a.state.folderByPath("Team docs")?.versionId, record.heads[0], story(server, a, b));
  assert.equal(b.state.folderByPath("Team docs")?.versionId, record.heads[0], story(server, a, b));
});

test("a device applying a capitals-only folder rename posts nothing, even when its index still shows the old names (#166)", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t);
  const stale = staleIndex(b.host);
  const posts = countPosts(b);

  a.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () => followed(server, b, "team docs", ids));
  // The periodic scan twice, and the user's Sync now, which lists the index.
  await timers.run(SCAN_MS);
  await b.engine.syncNow();
  await timers.run(SCAN_MS);

  assert.deepEqual([...stale].sort(), ["Team docs/One.md", "Team docs/Two.md"], "the index model reported nothing");
  assert.deepEqual(posts, [], `the receiving device posted: ${story(server, a, b)}`);
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `the server holds a duplicate note: ${story(server, a, b)}`);
  assert.deepEqual(
    Object.keys(b.state.data.files).sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the receiving device recorded the old spelling again: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    ["team docs/One.md", "team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId),
    ids,
    story(server, a, b),
  );
  assert.deepEqual(b.host.notices, [], `the receiving device was told something: ${b.host.notices.join(" | ")}`);
  assert.equal(
    b.host.logs.some((line) => line.includes("decision=case_ghost_forgotten")),
    false,
    `a record at the old spelling had to be forgotten: ${story(server, a, b)}`,
  );
});

test("a capitals-only NOTE rename raises no folder notice and posts nothing on the device that follows it (#165)", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t);
  const stale = staleIndex(b.host);
  const posts = countPosts(b);

  a.host.rename("Team docs/One.md", "Team docs/ONE.md");
  await timers.run(STEP_MS, () => b.host.files.has("Team docs/ONE.md") && settled(b, "Team docs/ONE.md") &&
    b.state.fileByPath("Team docs/ONE.md").versionId === server.files.get(ids[0]).heads[0]);
  await timers.run(SCAN_MS);
  await b.engine.syncNow();
  await timers.run(SCAN_MS);

  assert.deepEqual([...stale], ["Team docs/One.md"], "the index model reported nothing");
  assert.deepEqual(posts, [], `the device that followed the rename posted: ${story(server, a, b)}`);
  assert.deepEqual(b.host.notices, [], `a note rename raised a notice: ${b.host.notices.join(" | ")}`);
  assert.equal(b.state.fileByPath("Team docs/ONE.md").fileId, ids[0], story(server, a, b));
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, story(server, a, b));
});

// --- what the folder-capitalisation notice claims ------------------------

const SENDER = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

/**
 * A note's move whose only difference lies in its folder's capitals, from a
 * device the server lists at `version`, applied on a desktop that folds case
 * and still spells the folder the old way.
 */
async function refusedMove(version) {
  const r = await rig({ caseSensitive: false });
  r.host.appVersion = "1.1.4";
  r.server.addDevice(SENDER, "5f".repeat(32), "Old Mac", "macos");
  r.server.devices.find((device) => device.device_id === SENDER).app_version = version;
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const record = r.state.fileByPath("Team docs/One.md");
  const move = await r.server.publish({
    fileId: record.fileId,
    path: "team docs/One.md",
    bytes: enc(BODY),
    mtime: 1000,
    parents: [record.versionId],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
    deviceId: SENDER,
  });
  assert.equal(await applyChange(r.context, move), "refused");
  assert.deepEqual([...r.host.files.keys()], ["Team docs/One.md"], "a note's move re-cased the folder");
  return r;
}

test("the folder-capitalisation notice says to update the other device only when it is older (#165)", async () => {
  const older = await refusedMove("1.0.6");
  assert.equal(older.host.notices.length, 1, older.host.notices.join(" | "));
  assert.ok(
    older.host.notices[0].includes('"Old Mac" runs obsync 1.0.6 and this device runs 1.1.4: update it'),
    older.host.notices[0],
  );

  for (const version of ["1.1.4", "1.2.0", "not a version"]) {
    const same = await refusedMove(version);
    assert.equal(same.host.notices.length, 1, same.host.notices.join(" | "));
    assert.equal(/update/i.test(same.host.notices[0]), false, `version ${version}: ${same.host.notices[0]}`);
    assert.ok(same.host.notices[0].includes("Rename the folder on one device"), same.host.notices[0]);
    assert.ok(same.host.notices[0].includes("capitalisation"), same.host.notices[0]);
  }
});

// --- the ghost a note's capitals leave, and the folder a tombstone kept ----

test("a record a note's capitals left behind is forgotten without a notice about a folder (#165)", async (t) => {
  const { server, timers, a, b } = await seeded(t);
  const live = a.state.fileByPath("Team docs/One.md");
  // The residue of #166 before this fix: a second record at the note's old
  // capitals, under an id of its own, on a device that folds case.
  a.state.setFile("Team docs/one.md", { ...live, fileId: "9".repeat(32) });
  await a.state.save();

  a.engine.stop();
  await a.engine.start();
  await timers.run(STEP_MS);

  assert.equal(a.state.fileByPath("Team docs/one.md"), undefined, `the ghost record is still armed: ${story(server, a, b)}`);
  assert.ok(a.host.logs.some((line) => line.includes("decision=case_ghost_forgotten")), a.host.logs.join(" | "));
  assert.deepEqual(a.host.notices, [], `a note's ghost raised a notice about a folder: ${a.host.notices.join(" | ")}`);
});

test("a folder a tombstone found occupied is not brought back to the device that deleted it (#165)", async (t) => {
  const { server, timers, a, b, keys } = await seeded(t);
  // Something obsync does not sync, in the folder, on the receiving device.
  b.host.files.set("Team docs/.kept", { bytes: enc("not synced\n"), mtime: 1000 });

  a.host.removeFolder("Team docs");
  await timers.run(STEP_MS, () => b.state.fileByPath("Team docs/One.md") === undefined &&
    b.state.fileByPath("Team docs/Two.md") === undefined && b.state.folderByPath("Team docs") === undefined);
  await timers.run(SCAN_MS);
  assert.equal(b.host.hasFolder("Team docs"), true, "the occupied folder was removed");
  const before = server.journal.length;

  // The next start publishes a record for every folder that has none.
  b.engine.stop();
  await b.engine.start();
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(a.host.hasFolder("Team docs"), false, `the deleted folder came back: ${story(server, a, b)}`);
  assert.equal(server.journal.length, before, `the start published the kept folder again: ${story(server, a, b)}`);
  const record = server.files.get(await c.folderFileId(keys.manifestKey, "Team docs"));
  assert.equal(record.versions.find((version) => version.version_id === record.heads[0]).deleted, true, story(server, a, b));
});

// --- the retirement a re-case of a SELECTED folder spends (#127) ----------

const FOREIGN = "ffffffffffffffffffffffffffffffff";
const DOMAIN = "0123456789abcdef0123456789abcdef";

/** A peer's folder record, exactly as `pushFolder` builds one. */
const folderRecord = async (server, keys, path, { deleted = false, parents = [] } = {}) =>
  server.publishManifest({
    fileId: await c.folderFileId(keys.manifestKey, path),
    manifest: { v: 2, kind: "directory", path, domain: DOMAIN, size: 0, chunks: [], sha256: "", deleted },
    sids: [],
    parents,
    deviceId: FOREIGN,
    manifestKey: keys.manifestKey,
    bytes: 0,
  });

test("a re-case of the selected folder whose rename fails is admitted again when it is retried (#127)", async () => {
  const r = await rig({ caseSensitive: false });
  r.state.data.syncFolders = ["Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const created = await folderRecord(r.server, r.keys, "Team docs");
  assert.equal(await applyChange(r.context, created), "applied");
  const retired = await folderRecord(r.server, r.keys, "Team docs", { deleted: true, parents: [created.version_id] });
  assert.equal(await applyChange(r.context, retired), "skipped", "the folder held a note, so its tombstone keeps it");
  const recased = await folderRecord(r.server, r.keys, "team docs");

  // The rename is refused by the disk once -- a file in it held open by
  // another program -- and the feed parks the record and asks again later.
  const moveFolder = r.host.moveFolder.bind(r.host);
  r.host.moveFolder = async () => {
    r.host.moveFolder = moveFolder;
    throw Object.assign(new Error("fixture: resource busy"), { code: "EBUSY" });
  };
  await assert.rejects(applyChange(r.context, recased));
  assert.deepEqual(Object.keys(r.state.data.retiredRoots), ["Team docs"], "a rename that never happened spent the retirement");

  assert.equal(await applyChange(r.context, recased), "applied", r.host.logs.join(" | "));
  assert.deepEqual(r.state.data.syncFolders, ["team docs"], "the selection did not follow the retried re-case");
  assert.deepEqual([...r.host.files.keys()], ["team docs/One.md"], "the directory was not re-cased");
  assert.deepEqual(r.host.notices, [], `the retried re-case was refused as a second folder: ${r.host.notices.join(" | ")}`);
  assert.deepEqual(r.state.data.retiredRoots, {}, "the retirement outlived the record written under it");
});

/** Two notes under a folder the RECEIVING device selects, on two devices that fold case. */
async function selected(t) {
  const devices = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: false });
  const { timers, a, b } = devices;
  b.state.data.syncFolders = ["Team docs"];
  a.host.write("Team docs/One.md", BODY, 1000);
  a.host.write("Team docs/Two.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md") && settled(b, "Team docs/Two.md") &&
    b.state.folderByPath("Team docs") !== undefined);
  return { ...devices, ids: ["Team docs/One.md", "Team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId) };
}

test("a device stopped between a folder's tombstone and its re-cased record follows the rename when it starts (#127)", async (t) => {
  const { server, timers, a, b, ids, keys } = await selected(t);
  const retiredId = await c.folderFileId(keys.manifestKey, "Team docs");
  await b.engine.stopAndWait();

  a.host.renameFolder("Team docs", "team docs");
  // The sender's whole rename on the wire: the old spelling's tombstone, the
  // new record, and a move of each note.
  await timers.run(STEP_MS, () => server.journal.some((frame) => frame.file_id === retiredId && frame.deleted) &&
    ids.every((id) => server.journal.filter((frame) => frame.file_id === id).length >= 2));
  // The receiving device applied the old spelling's tombstone and stopped
  // before the record that follows it.
  const tombstone = server.journal.find((frame) => frame.file_id === retiredId && frame.deleted);
  assert.equal(await applyChange(b.engine.context, tombstone), "skipped", "the tombstone removed a folder that holds notes");
  b.state.data.lastSeq = tombstone.seq;
  b.state.data.feedMark = {
    seq: tombstone.seq, fileId: tombstone.file_id, versionId: tombstone.version_id, ts: tombstone.ts, replay: false,
  };
  await b.state.save();
  assert.deepEqual(Object.keys(b.state.data.retiredRoots), ["Team docs"], "the tombstone opened no window");

  // Its next start reconciles BEFORE the feed says anything, which is what
  // used to republish the folder and close the window on the rename.
  let open = null;
  const gate = new Promise((resolve) => { open = resolve; });
  const changes = b.transport.changes.bind(b.transport);
  b.transport.changes = async (...args) => {
    await gate;
    return changes(...args);
  };
  const posts = countPosts(b);
  await b.engine.start();
  await timers.run(STEP_MS);
  open();
  await timers.run(STEP_MS, () => b.state.data.syncFolders[0] === "team docs" && followed(server, b, "team docs", ids))
    .catch(() => undefined);

  assert.deepEqual(b.state.data.syncFolders, ["team docs"], `the selection did not follow the rename: ${story(server, a, b)}`);
  assert.deepEqual([...b.host.files.keys()].sort(), ["team docs/One.md", "team docs/Two.md"], story(server, a, b));
  assert.deepEqual(posts, [], `the start published the retired folder again: ${story(server, a, b)}`);
  assert.deepEqual(b.host.notices, [], `the rename was refused as a second folder: ${b.host.notices.join(" | ")}`);
  assert.deepEqual(b.state.data.retiredRoots, {}, story(server, a, b));
});

test("a folder a tombstone kept is published again once the feed has caught up, and the window closes (#127)", async (t) => {
  const { server, timers, a, b, keys } = await selected(t);
  b.host.files.set("Team docs/.kept", { bytes: enc("not synced\n"), mtime: 1000 });
  a.host.removeFolder("Team docs");
  await timers.run(STEP_MS, () => b.state.fileByPath("Team docs/One.md") === undefined &&
    b.state.fileByPath("Team docs/Two.md") === undefined && b.state.data.retiredRoots["Team docs"] !== undefined);

  // A deletion, with no rename behind it: the next start holds the folder
  // until the feed has shown that nothing follows, then publishes it.
  b.engine.stop();
  await b.engine.start();
  await timers.run(STEP_MS, () => {
    server.releaseFeed();
    return b.state.data.retiredRoots["Team docs"] === undefined;
  }).catch(() => undefined);
  assert.deepEqual(b.state.data.retiredRoots, {}, `the retirement outlived the start that settles it: ${story(server, a, b)}`);
  assert.equal(a.host.hasFolder("Team docs"), false, `the deleted folder came back: ${story(server, a, b)}`);

  // And a folder one capitalisation off it is a second folder again.
  await folderRecord(server, keys, "team docs");
  const twin = (notice) => notice.includes("differ only in capitalisation");
  await timers.run(STEP_MS, () => b.host.notices.some(twin)).catch(() => undefined);
  assert.deepEqual(b.state.data.syncFolders, ["Team docs"], `a case-twin moved the selection: ${story(server, a, b)}`);
  assert.equal(b.host.hasFolder("Team docs"), true, story(server, a, b));
  assert.equal(b.host.notices.filter(twin).length, 1, b.host.notices.join(" | "));
});
