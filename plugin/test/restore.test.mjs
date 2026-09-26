/**
 * The server rebuilt from a volume backup (issue #145, battery S75).
 *
 * `docs/recovery.md` tells the owner how to rebuild a server from a volume
 * backup. Everything journaled after that backup is gone from the server, and
 * NOT from the devices that made it or pulled it: their records name versions
 * the server no longer holds, and the journal's next frames reuse seqs those
 * devices have already read past. What the devices owe the restored server is
 * the day's work, re-sent from what they hold -- the notes, the rename, the
 * deletion -- and what they must never do is read `idle` while holding it,
 * skip what another device wrote on the restored server, or write over it.
 * And what a WRONG verdict may cost is requests, never a publication.
 *
 * `FakeServer.restoreTo` is the restore: every version after a seq dropped,
 * heads recomputed by obsyncd's rule, orphaned chunks gone, and the seq put
 * back so the next frame reuses one.
 *
 * WHAT A FRESH DEVICE GETS is what the server's HEADS say, so these tests read
 * the heads' manifests and chunks with the vault key rather than counting
 * frames: a device paired after the restore materialises exactly that.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { DEVICE_B, FakeTimers, KEYS, STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { probeFeed, recoverLost, seenBefore } = require("../build/sync/restore.js");
const { applyChange } = require("../build/sync/pull.js");
const { sidDigest } = require("../build/sync/push.js");
const { Transport } = require("../build/transport.js");

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);

const N01 = "Notes/n01.md";
const N20 = "Notes/n20.md";
const P1 = "Projects/Alpha/p1.md";
const P1_FINAL = "Projects/Alpha/p1-final.md";
const DAY = ["Day/d1.md", "Day/d2.md", "Day/d3.md", "Day/d4.md", "Day/d5.md"];
const B_NEW = "Notes/b-new.md";
const N01_TEXT = "line one\nline two\nline three\n";
const B_EDIT = "line one, as the second device edited it\nline two\nline three\n";
const C_EDIT = "line one\nline two\nline three, as a device paired after the restore edited it\n";
const P1_TEXT = "a project note renamed after the backup\n";
const N20_TEXT = "a note deleted after the backup\n";
const dayText = (path) => `${path}: a note created after the backup\n`;
const B_NEW_TEXT = "a note the second device created after the backup\n";
/** Another device's clock, well after anything the devices under test wrote. */
const LATER = 1757300000000;
/** Forty days before the rigs' clock: past any retention a server can have. */
const OLD = 1757200000000 - 40 * 24 * 60 * 60 * 1000;
const OTHER_DEVICE = "ffffffffffffffffffffffffffffffff";
const RESTORED_NOTICE = /The server was restored to an earlier state; this device re-sent (\d+) change/;

/**
 * Every HEAD the server holds for a vault file, decrypted: what a device
 * paired now would be given. Folder records carry `folder: true` and no text.
 */
async function heads(server, k) {
  const out = [];
  for (const fileId of server.vaultFiles()) {
    const file = server.files.get(fileId);
    for (const head of file.heads) {
      const version = file.versions.find((candidate) => candidate.version_id === head);
      const binder = await c.contentVersionId(fileId, version.parents, version.sids);
      const manifest = JSON.parse(await c.decryptManifest(
        k.manifestKey, fileId, binder, c.unhex(version.manifest_nonce), c.unbase64(version.manifest_ct),
      ));
      let text = "";
      for (const chunk of manifest.chunks) {
        text += dec(await c.decryptChunk(k.domainKey, c.unhex(chunk.cid), server.chunks.get(chunk.sid)));
      }
      out.push({ fileId, path: manifest.path, deleted: manifest.deleted, folder: manifest.v === 2, text, forked: file.heads.length > 1 });
    }
  }
  return out;
}

/** The live note head at `path`, or `undefined`. */
const live = (all, path) => all.find((head) => head.path === path && !head.deleted && !head.folder);

/** Every conflict copy in a vault. */
const copies = (host) => [...host.files.keys()].filter((path) => path.includes("(conflict from"));

/** Every text a vault holds, under any name. */
const texts = (host) => [...host.files.keys()].map((path) => host.text(path));

/** The single head of a file, when it has one. */
const soleHead = (server, fileId) => {
  const file = server.files.get(fileId);
  return file?.heads.length === 1 ? file.versions.find((version) => version.version_id === file.heads[0]) : undefined;
};

/** The records a device keeps that name no version the server holds as a head. */
const strays = (server, device) => Object.entries(device.state.data.files)
  .filter(([, record]) => !server.files.get(record.fileId)?.heads.includes(record.versionId)).map(([path]) => path);

/** What happened, for a failure that has to be read. */
const story = (server, a, b) => [
  `server_seq=${server.seq}`,
  `a_files=${JSON.stringify([...a.host.files.keys()])}`,
  `b_files=${JSON.stringify([...b.host.files.keys()])}`,
  `a_log=${a.host.logs.filter((line) => /^feed |^restore |seq_ahead|repair decision/.test(line)).slice(-8).join(" / ")}`,
  `b_log=${b.host.logs.filter((line) => /^feed |^restore |seq_ahead|repair decision/.test(line)).slice(-8).join(" / ")}`,
].join(" ");

/**
 * Wait for the recovery to land, and fall through to the assertions when it
 * never does: they name what is missing, where a timeout names nothing.
 */
async function recovered(timers, condition) {
  try {
    await timers.run(STEP_MS, condition);
  } catch (error) {
    if (!/never held/.test(String(error))) throw error;
  }
  await timers.run(STEP_MS);
}

/**
 * Stop an engine and wait for it, answering every long poll it parks on and
 * firing every timer it waits on until it has: a stopping engine can take
 * one more turn round its feed loop, and a poll nobody answers holds
 * `stopAndWait` for ever (`repair.test.mjs`, `drainingFeed`).
 */
async function halt(engine, server, timers) {
  engine.stop();
  let done = false;
  const stopped = engine.stopAndWait().finally(() => { done = true; });
  while (!done) {
    server.releaseFeed();
    for (const entry of timers.entries.splice(0)) entry.fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await stopped;
}

/** Has this device processed everything the server holds? */
const caughtUp = (server, device) => device.state.data.lastSeq === server.seq && device.state.data.feedMark?.seq === server.seq;

test("a server restored from last night's backup gets the day's notes, rename and deletions back (S75)", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  // Yesterday: three notes and an empty folder, on both devices.
  a.host.write(N01, N01_TEXT, 1000);
  a.host.write(P1, P1_TEXT, 1000);
  a.host.write(N20, N20_TEXT, 1000);
  a.host.makeFolder("Old");
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => [N01, P1, N20].every((path) =>
    settled(a, path) && settled(b, path) && b.host.text(path) !== null) && b.state.folderByPath("Old") !== undefined);

  // The backup, taken now: everything up to here survives the restore.
  const backup = server.seq;
  const ids = {
    n01: a.state.fileByPath(N01).fileId, p1: a.state.fileByPath(P1).fileId,
    n20: a.state.fileByPath(N20).fileId, old: a.state.folderByPath("Old").fileId,
  };

  // The day's work, on both devices, which both then hold.
  for (const path of DAY) a.host.write(path, dayText(path), 5000);
  a.host.rename(P1, P1_FINAL);
  a.host.removeFolder("Old");
  b.host.write(N01, B_EDIT, 6000);
  b.host.remove(N20);
  await timers.run(STEP_MS, () =>
    a.host.text(N01) === B_EDIT && a.host.text(N20) === null && a.state.fileByPath(N20) === undefined &&
    DAY.every((path) => b.host.text(path) === dayText(path) && settled(a, path) && settled(b, path)) &&
    b.host.text(P1_FINAL) === P1_TEXT && b.host.text(P1) === null && settled(a, P1_FINAL) && settled(b, P1_FINAL) &&
    b.state.fileByPath(N20) === undefined && !b.host.hasFolder("Old") && caughtUp(server, a) && caughtUp(server, b));
  const day = DAY.map((path) => a.state.fileByPath(path).fileId);
  assert.equal(live(await heads(server, k), DAY[0])?.text, dayText(DAY[0]), "the server held the day's work before the restore");

  // The restore. The first device is connected through it, and reconnects to
  // a server whose head is BEHIND its cursor; the second is offline, and
  // comes back only after the first has re-sent what it holds.
  server.unreachable.add(DEVICE_B);
  server.releaseFeed();
  await timers.run(STEP_MS, () => b.host.logs.some((line) => line.startsWith("feed decision=retry")));
  server.restoreTo(backup);
  assert.equal(server.files.has(day[0]), false, "the restore took the new notes");
  assert.equal(soleHead(server, ids.old).deleted, false, "and the folder's deletion");
  server.releaseFeed();
  await recovered(timers, () => day.every((id) => soleHead(server, id) !== undefined) && soleHead(server, ids.n20)?.deleted === true &&
    soleHead(server, ids.old)?.deleted === true && soleHead(server, ids.n01)?.seq > backup && soleHead(server, ids.p1)?.seq > backup &&
    caughtUp(server, a));
  server.unreachable.delete(DEVICE_B);
  await recovered(timers, () => caughtUp(server, b) && caughtUp(server, a) && strays(server, b).length === 0);

  // What a device paired now would be given: the day, not yesterday.
  const now = await heads(server, k);
  for (const path of DAY) {
    assert.equal(live(now, path)?.text, dayText(path), `a note created after the backup is not on the server: ${story(server, a, b)}`);
  }
  assert.equal(live(now, N01)?.text, B_EDIT, `the edit made after the backup is not on the server: ${story(server, a, b)}`);
  assert.equal(live(now, P1_FINAL)?.text, P1_TEXT, `the rename made after the backup is not on the server: ${story(server, a, b)}`);
  assert.equal(live(now, P1), undefined, `the note is back under its old name: ${story(server, a, b)}`);
  assert.equal(live(now, N20), undefined, `the note deleted after the backup is back: ${story(server, a, b)}`);
  assert.equal(soleHead(server, ids.old)?.deleted, true, `the folder deleted after the backup is back: ${story(server, a, b)}`);
  assert.equal(now.some((entry) => entry.forked), false, `something is left forked: ${story(server, a, b)}`);
  // Two devices re-sending one lost version publish ONE: the second is
  // answered with the first's (#114), not forked beside it and merged shut.
  for (const id of [ids.n01, ids.p1, ids.n20, ids.old, ...day]) {
    assert.equal(server.files.get(id).versions.filter((version) => version.seq > backup).length, 1,
      `a lost version was published twice after the restore: ${story(server, a, b)}`);
  }

  // Nothing on either device was deleted, overwritten, doubled or brought
  // back -- the replay of the rebuilt journal re-applied none of yesterday --
  // and every record names what the server now holds.
  for (const device of [a, b]) {
    for (const path of DAY) assert.equal(device.host.text(path), dayText(path));
    assert.equal(device.host.text(N01), B_EDIT);
    assert.equal(device.host.text(P1_FINAL), P1_TEXT);
    assert.equal(device.host.text(P1), null, `the rename was undone on a device: ${story(server, a, b)}`);
    assert.equal(device.host.text(N20), null, `the deleted note came back on a device: ${story(server, a, b)}`);
    assert.equal(device.host.hasFolder("Old"), false, `the deleted folder came back on a device: ${story(server, a, b)}`);
    assert.deepEqual(copies(device.host), [], `a conflict copy of yesterday appeared: ${story(server, a, b)}`);
    assert.deepEqual(strays(server, device), [], `a record names a version the server lost: ${story(server, a, b)}`);
    // Bounded and said: one START and one SUMMARY per run, with the budget.
    assert.ok(device.host.logs.some((line) => /^restore decision=start verdict=restored reason=\w+ .*budget_requests=1000 budget_ms=600000$/.test(line)));
    assert.ok(device.host.logs.some((line) => /^restore decision=summary verdict=restored .*budget_requests=1000 duration_ms=\d+ budget_ms=600000$/.test(line)));
    assert.equal(device.host.notices.filter((message) => RESTORED_NOTICE.test(message)).length, 1, "one notice per device");
  }
  // The first device re-sent the day: five notes, the edit, the rename, the
  // new folder, a note's deletion and a folder's.
  assert.match(a.host.logs.find((line) => line.startsWith("restore decision=summary")), / resent=10 notes=6 renames=1 tombstones=2 folders=1 /);
});

test("a device offline through the restore notices when it reconnects, gets what it missed and re-sends its work (S75, B)", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  a.host.write(N01, N01_TEXT, 1000);
  a.host.write(N20, N20_TEXT, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => [N01, N20].every((path) => settled(a, path) && settled(b, path) && b.host.text(path) !== null) &&
    caughtUp(server, a));
  const backup = server.seq;
  const ids = { n01: a.state.fileByPath(N01).fileId, n20: a.state.fileByPath(N20).fileId };

  // The first device is closed for the day. The second edits one note,
  // creates another and deletes a third -- and then loses its network, with
  // its engine running, as a laptop does.
  a.engine.stop();
  const before = b.state.fileByPath(N01).versionId;
  b.host.write(N01, B_EDIT, 6000);
  b.host.write(B_NEW, B_NEW_TEXT, 6000);
  b.host.remove(N20);
  await timers.run(STEP_MS, () => settled(b, B_NEW) && b.state.fileByPath(N01).versionId !== before &&
    b.state.fileByPath(N20) === undefined && caughtUp(server, b));
  const cursor = b.state.data.lastSeq;
  server.unreachable.add(DEVICE_B);
  server.releaseFeed();
  await timers.run(STEP_MS, () => b.host.logs.some((line) => line.startsWith("feed decision=retry")));

  // The restore, and a burst on the restored server from the first device:
  // its versions take the seqs the second device already read past.
  server.restoreTo(backup);
  await a.engine.start();
  const burst = ["Burst/b01.md", "Burst/b02.md", "Burst/b03.md", "Burst/b04.md"];
  for (const path of burst) a.host.write(path, `${path}\n`, 7000);
  await timers.run(STEP_MS, () => burst.every((path) => settled(a, path)) && caughtUp(server, a));
  assert.ok(server.journal.some((frame) => frame.seq > backup && frame.seq <= cursor), "the burst reuses seqs the device read past");

  // The network comes back.
  server.unreachable.delete(DEVICE_B);
  await recovered(timers, () => burst.every((path) => b.host.text(path) === `${path}\n`) &&
    a.host.text(B_NEW) === B_NEW_TEXT && a.host.text(N01) === B_EDIT && a.host.text(N20) === null);

  for (const path of burst) {
    assert.equal(b.host.text(path), `${path}\n`, `a note written on the restored server never reached the device: ${story(server, a, b)}`);
  }
  const now = await heads(server, k);
  assert.equal(live(now, B_NEW)?.text, B_NEW_TEXT, `the note created after the backup is not on the server: ${story(server, a, b)}`);
  assert.equal(live(now, N01)?.text, B_EDIT, `the edit made after the backup is not on the server: ${story(server, a, b)}`);
  assert.equal(soleHead(server, ids.n20)?.deleted, true, `the deletion made after the backup is not on the server: ${story(server, a, b)}`);
  assert.equal(a.host.text(B_NEW), B_NEW_TEXT);
  assert.equal(a.host.text(N01), B_EDIT);
  assert.equal(a.host.text(N20), null);
  assert.ok(b.host.logs.some((line) => /^feed decision=restored reason=(mark_replaced|unseen_entry) /.test(line)), story(server, a, b));
  assert.equal(b.host.logs.some((line) => line.includes("read_or_write_failed")), false,
    `the loss was reported as a read or write failure: ${story(server, a, b)}`);
  assert.equal(b.host.notices.filter((message) => RESTORED_NOTICE.test(message)).length, 1);
  assert.equal(a.host.logs.some((line) => line.startsWith("restore decision=start")), false,
    "the device whose history the restore kept is not alarmed");
});

test("a change another device made on the restored server is kept, never replaced by the one re-sent over it", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  a.host.write(N01, N01_TEXT, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, N01) && settled(b, N01) && b.host.text(N01) === N01_TEXT);
  const backup = server.seq;
  const fileId = a.state.fileByPath(N01).fileId;

  // After the backup, the second device edits the note and the first pulls it.
  b.host.write(N01, B_EDIT, 6000);
  await timers.run(STEP_MS, () => a.host.text(N01) === B_EDIT && settled(a, N01) && caughtUp(server, a) && caughtUp(server, b));
  a.engine.stop();
  b.engine.stop();

  // The restore. A device paired afterwards is given yesterday's note and
  // edits ANOTHER line of it: a legitimate change the restored server holds,
  // which neither device under test has seen.
  server.restoreTo(backup);
  const [yesterday] = server.files.get(fileId).heads;
  await server.publish({
    fileId, path: N01, bytes: enc(C_EDIT), mtime: LATER, parents: [yesterday],
    domainKey: k.domainKey, manifestKey: k.manifestKey, deviceId: OTHER_DEVICE,
  });

  await a.engine.start();
  await b.engine.start();
  const holdsBoth = (device) => texts(device.host).some((text) => text?.includes("as the second device edited")) &&
    texts(device.host).some((text) => text?.includes("as a device paired after the restore edited"));
  await recovered(timers, () => holdsBoth(a) && holdsBoth(b));

  // The later device's change survives on every device and on the server...
  for (const device of [a, b]) {
    assert.ok(texts(device.host).some((text) => text?.includes("as a device paired after the restore edited")),
      `the change made on the restored server was lost or never arrived: ${story(server, a, b)}`);
  }
  const now = (await heads(server, k)).filter((entry) => !entry.deleted);
  assert.ok(now.some((entry) => entry.text.includes("as a device paired after the restore edited")),
    `the re-sent version replaced the change made on the restored server: ${story(server, a, b)}`);
  // ...and so does the edit the restore took, which the devices re-sent.
  assert.ok(now.some((entry) => entry.text.includes("as the second device edited")),
    `the edit made after the backup never reached the restored server: ${story(server, a, b)}`);
});

test("a deletion this device published or applied is re-sent to a restored server, note and folder alike (#145)", async () => {
  const r = await rig(), timers = new FakeTimers();
  const engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  const theirs = "7a".repeat(16), theirFolder = "7b".repeat(16);
  const folder = (deleted, parents) => r.server.publishManifest({ fileId: theirFolder, parents, sids: [], bytes: 0, deviceId: OTHER_DEVICE,
    manifestKey: r.keys.manifestKey, manifest: { v: 2, kind: "directory", path: "Theirs", domain: KEYS.domainId, size: 0, chunks: [], sha256: "", deleted } });
  r.host.seed("Notes/mine.md", "MINE SENTINEL", 1000);
  r.host.explicitFolders.add("Old");
  const first = await r.server.publish({ fileId: theirs, path: "Notes/theirs.md", bytes: enc("THEIRS SENTINEL"), mtime: r.host.clock,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const made = await folder(false, []);
  await engine.start();
  await timers.run(STEP_MS, () => r.state.fileByPath("Notes/mine.md") !== undefined && r.host.text("Notes/theirs.md") !== null &&
    r.state.folderByPath("Old") !== undefined && r.state.folderByPath("Theirs") !== undefined && caughtUp(r.server, r));
  const backup = r.server.seq;
  const mine = r.state.fileByPath("Notes/mine.md").fileId;
  const old = r.state.folderByPath("Old").fileId;

  // The day's deletions: a note and a folder here, a note on another device.
  r.host.files.delete("Notes/mine.md");
  engine.deleted("Notes/mine.md");
  r.host.explicitFolders.delete("Old");
  engine.folderDeleted("Old");
  await r.server.publishTombstone({ fileId: theirs, path: "Notes/theirs.md", manifestKey: r.keys.manifestKey, parents: [first.version_id] });
  await folder(true, [made.version_id]);
  await timers.run(STEP_MS, () => [mine, old, theirs, theirFolder].every((id) => r.state.data.graves[id]?.ts !== undefined) && caughtUp(r.server, r));
  assert.equal(r.state.data.graves[old].folder, true);
  assert.equal(r.state.data.graves[theirFolder].folder, true);

  r.server.restoreTo(backup);
  r.server.releaseFeed();
  await recovered(timers, () => [mine, old, theirs, theirFolder].every((id) => soleHead(r.server, id)?.deleted === true) && caughtUp(r.server, r));

  for (const [name, id] of Object.entries({ mine, old, theirs, theirFolder })) {
    assert.equal(soleHead(r.server, id)?.deleted, true, `the ${name} deletion was not re-sent: ${r.host.logs.filter((l) => l.startsWith("restore")).join(" | ")}`);
  }
  assert.equal(r.host.text("Notes/mine.md"), null, "nothing deleted here came back");
  assert.equal(r.host.text("Notes/theirs.md"), null);
  assert.equal(r.host.explicitFolders.has("Old"), false);
  assert.equal(r.host.hasFolder("Theirs"), false);
  assert.deepEqual(r.host.notices.filter((notice) => RESTORED_NOTICE.test(notice)).map((notice) => RESTORED_NOTICE.exec(notice)[1]), ["4"]);
  await halt(engine, r.server, timers);
});

test("a normal restart over history retention pruned sends one probe and publishes nothing (#145)", async () => {
  const r = await rig();
  let timers = new FakeTimers();
  r.state.data.syncFolders = ["Notes"];
  const publish = (fileId, path, text, mtime, parents = []) => r.server.publish({ fileId, path, bytes: enc(text), mtime, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER_DEVICE });
  const S = "5b".repeat(16), M = "6c".repeat(16), G = "7d".repeat(16), H = "8e".repeat(16);
  // The folder is this device's before anything arrives in it, so the
  // restart's own reconcile pass owes the server nothing.
  r.host.explicitFolders.add("Notes");
  let engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start();

  // Two notes this device keeps BEHIND their history on purpose: another
  // device moved each out of the folders this device syncs and went on
  // editing it there, forty days ago. And one note it is current on.
  const history = { [S]: [], [M]: [] };
  for (const id of [S, M]) history[id].push(await publish(id, `Notes/${id}.md`, `${id} one\n`, OLD));
  const g1 = await publish(G, "Notes/G.md", "G one\n", OLD + 500);
  for (let n = 2; n <= 12; n++) {
    for (const id of [S, M]) {
      history[id].push(await publish(id, `Archive/${id}.md`, `${id} edit ${n}\n`, OLD + n * 1000, [history[id].at(-1).version_id]));
    }
  }
  await timers.run(STEP_MS, () => caughtUp(r.server, r) && r.state.fileByPath("Notes/G.md") !== undefined &&
    r.state.folderByPath("Notes") !== undefined);
  assert.equal(r.state.fileByPath(`Notes/${S}.md`).versionId, history[S][0].version_id, "the record stays behind the move");
  await halt(engine, r.server, timers);

  // A record from 1.1.2 knows no server time; and a file retention buried
  // long ago, which this device still records (a note it kept while its
  // folder was outside the selection).
  delete r.state.fileByPath(`Notes/${M}.md`).ts;
  r.host.seed("Notes/H.md", "H SENTINEL", 1000);
  // A real pushed record holds the digest of these bytes. Sync now verifies
  // it even when its metadata matches (#179), so an empty digest would now
  // model an unpushed local edit rather than a retention-pruned old version.
  const hDigest = await sidDigest([(await c.encryptChunk(r.keys.domainKey, enc("H SENTINEL"))).sid]);
  r.state.setFile("Notes/H.md", { fileId: H, versionId: "9f".repeat(32), mtime: 1000, size: 10, sha256: hDigest, ts: OLD });

  // Retention: each moved note keeps its ten newest versions.
  for (const id of [S, M]) {
    const pruned = new Set(history[id].slice(0, 2).map((frame) => frame.version_id));
    const file = r.server.files.get(id);
    file.versions = file.versions.filter((version) => !pruned.has(version.version_id));
    r.server.journal = r.server.journal.filter((frame) => !pruned.has(frame.version_id));
  }

  // A normal restart. Its reads pass a gate that can hold a long poll's
  // answer once it carries entries, as a real server's answer to a woken
  // poll does -- the fake answers a wake-up empty and the next read carries
  // them.
  const since = r.server.requests.length;
  const sent = () => r.server.requests.slice(since);
  let hold = null;
  ({ engine, timers } = engineOver(r, async (request) => {
    const response = await r.server.request(request);
    if (hold !== null && request.url.includes("&wait=55&") && JSON.parse(response.text).changes.length > 0) await hold;
    return response;
  }));
  await engine.start();
  await timers.run(STEP_MS, () => sent().some((request) => request.target === "/v1/changes?since=" + r.state.data.lastSeq + "&wait=55&limit=1000"));
  const probes = sent().filter((request) => /^\/v1\/changes\?since=\d+&wait=0&limit=2$/.test(request.target));
  assert.equal(probes.length, 1, "one probe");
  assert.ok(r.host.logs.some((line) => /^feed decision=verified mark_seq=\d+ cursor=\d+ requests=1 duration_ms=\d+$/.test(line)), r.host.logs.join(" | "));

  // Another device writes the note this device is current on, and the page
  // carrying it is in flight when the repair pass meets the version retention
  // pruned under the moved note. That page is answered AFTER the suspicion:
  // G's version is not a head any more when the check looks.
  let open;
  hold = new Promise((resolve) => { open = resolve; });
  await publish(G, "Notes/G.md", "G two\n", LATER, [g1.version_id]);
  await timers.run(STEP_MS, () => sent().filter((request) => request.target.includes("&wait=55&")).length >= 2);
  await engine.syncNow();
  assert.ok(r.host.logs.some((line) => /^repair decision=lost reason=unknown_version verdict=suspected /.test(line)), r.host.logs.join(" | "));
  open();
  await timers.run(STEP_MS, () => r.host.logs.some((line) => line.startsWith("restore decision=summary")) && r.host.text("Notes/G.md") === "G two\n");

  const summary = r.host.logs.find((line) => line.startsWith("restore decision=summary"));
  assert.match(summary, / resent=0 /);
  for (const [why, count] of [["superseded", 1], ["unknown_position", 1], ["held", 1], ["absent_unproven", 1]]) {
    assert.match(summary, new RegExp(` skipped_${why}=${count} `), summary);
  }
  assert.deepEqual(sent().filter((request) => request.method !== "GET" && !request.target.startsWith("/v1/chunks/exists") &&
    request.target !== "/v1/devices/heartbeat").map((request) => `${request.method} ${request.target}`), [], "nothing was published");
  assert.equal(r.host.notices.some((notice) => RESTORED_NOTICE.test(notice)), false);
  assert.equal(r.state.data.feedMark.replay, false, "and the feed is not re-read");
  await halt(engine, r.server, timers);
});

test("the probe reads the mark once, and a second time only when the mark's own entry is gone (#145)", async () => {
  const cases = {
    "a journal that still holds the mark": [() => {}, null, 1],
    "one that moved on past the cursor": [async (r) => { await other(r); }, null, 1],
    // Retention never prunes a version younger than OBSYNC_RETENTION_DAYS,
    // whatever the count (`storage/gc.rs`, `plan`): a note edited many times
    // since the mark still holds the mark where it was.
    "a note edited many times since the mark": [async (r, mark) => {
      for (let n = 3; n <= 14; n++) {
        await r.server.publish({ fileId: mark.fileId, path: "Notes/marked.md", bytes: enc(`MARK ${n}`), mtime: r.host.clock,
          domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, parents: r.server.files.get(mark.fileId).heads });
      }
    }, null, 1],
    "a head behind the cursor": [(r, mark) => { r.server.seq += 2; r.state.data.lastSeq = r.server.seq; r.server.restoreTo(mark.seq + 1); }, "restored:head_behind", 1],
    "a head behind the mark": [(r, mark) => { r.server.restoreTo(mark.seq - 2); }, "restored:seq_ahead", 1],
    "another version where the mark was": [async (r, mark) => { r.server.restoreTo(mark.seq - 1); await other(r); }, "restored:mark_replaced", 1],
    // Both with the head back past the cursor, as a busy restored server's is.
    "a version after the mark this device never read": [async (r, mark) => {
      r.server.seq += 3; r.state.data.lastSeq = r.server.seq; r.server.restoreTo(mark.seq); await other(r);
      r.server.seq = r.state.data.lastSeq + 2;
    }, "restored:unseen_entry", 1],
    "the mark gone and a version this device never read": [async (r, mark) => {
      r.server.seq += 3; r.state.data.lastSeq = r.server.seq; r.server.restoreTo(mark.seq - 1); r.server.seq += 1; await other(r);
      r.server.seq = r.state.data.lastSeq + 2;
    }, "restored:unseen_entry", 1],
    "the mark's version held at another seq": [(r, mark) => {
      r.server.journal = r.server.journal.filter((frame) => frame.seq !== mark.seq);
    }, "restored:mark_moved", 2],
    "the mark's version lost, too young to collect": [(r, mark) => {
      r.server.restoreTo(mark.seq - 1); r.server.seq = r.state.data.lastSeq + 3;
    }, "restored:mark_lost", 2],
    "the mark's version gone, old enough for retention": [(r, mark) => {
      r.server.restoreTo(mark.seq - 1); r.server.seq = r.state.data.lastSeq + 3; r.state.data.feedMark = { ...mark, ts: OLD };
    }, "suspected:mark_gone", 2],
    "no mark yet": [(r) => { r.state.data.feedMark = null; }, null, 0],
    "a replay under way": [(r, mark) => { r.state.data.feedMark = { ...mark, replay: true }; r.server.restoreTo(mark.seq - 2); }, null, 0],
  };
  const other = (r) => r.server.publish({ fileId: "3e".repeat(16), path: "Notes/other.md", bytes: enc("OTHER"), mtime: r.host.clock,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  for (const [name, [arrange, expected, reads]] of Object.entries(cases)) {
    const r = await rig();
    for (const n of [1, 2]) {
      await r.server.publish({ fileId: "2d".repeat(16), path: "Notes/marked.md", bytes: enc(`MARK ${n}`), mtime: r.host.clock,
        domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, parents: r.server.files.get("2d".repeat(16))?.heads ?? [] });
    }
    const last = r.server.journal.at(-1);
    const mark = { seq: last.seq, fileId: last.file_id, versionId: last.version_id, ts: last.ts, replay: false };
    r.state.data.feedMark = mark;
    r.state.data.lastSeq = r.server.seq;
    await arrange(r, mark);
    const since = r.server.requests.length;
    const verdict = await probeFeed(r.context);
    assert.equal(verdict === null ? null : `${verdict.verdict}:${verdict.reason}`, expected, name);
    assert.equal(r.server.requests.length - since, reads, `${name}: reads`);
  }
});

test("the check re-sends only what it can prove lost, from parents it can prove this device processed (#145)", async () => {
  const r = await rig();
  const lost = () => c.hex(c.randomBytes(32));
  const anchor = await r.server.publish({ fileId: "1f".repeat(16), path: "Notes/anchor.md", bytes: enc("ANCHOR"), mtime: r.host.clock,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.state.data.feedMark = { seq: anchor.seq, fileId: anchor.file_id, versionId: anchor.version_id, ts: anchor.ts, replay: false };
  const record = (path, fileId, ts) => {
    r.host.seed(path, `${path} SENTINEL`, 1000);
    r.state.setFile(path, { fileId, versionId: lost(), mtime: 1000, size: `${path} SENTINEL`.length, sha256: "", ...(ts === undefined ? {} : { ts }) });
  };
  const A = "a1".repeat(16), N = "b2".repeat(16), Y = "c3".repeat(16), O = "d4".repeat(16), grave = "e5".repeat(16);
  // A note the server lacks entirely; one it holds only as written after the
  // mark, by another device; a grave for a file it lacks; and, under a mere
  // suspicion, notes it lacks that are young and old.
  record("Notes/absent.md", A, anchor.ts);
  await r.server.publish({ fileId: N, path: "Notes/n.md", bytes: enc("LATER"), mtime: LATER, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  record("Notes/n.md", N, anchor.ts - 1000);
  r.state.bury(grave, { versionId: lost(), path: "Notes/gone.md", folder: false, ts: anchor.ts });
  const posts = () => r.server.requests.filter((request) => request.method === "POST" && /^\/v1\/files\/[0-9a-f]{32}\/versions$/.test(request.target))
    .map((request) => request.target.split("/")[3]);

  assert.equal(await recoverLost(r.context, { verdict: "restored", reason: "test" }, new Set(), () => true), 1);
  assert.deepEqual(posts(), [A], "only the note the server lacks entirely, on a proved restore");
  assert.deepEqual(r.server.files.get(A).versions[0].parents, [], "with no parents to name");
  const reason = (id) => /reason=(\w+)/.exec(r.host.logs.find((line) => line.startsWith("restore path_class=") && line.endsWith(`file=${id}`)))[1];
  assert.equal(reason(N), "no_ancestor", "nothing this device processed to name as a parent");
  assert.equal(reason(grave), "absent", "nothing left to delete");

  r.state.forgetPath("Notes/absent.md");
  r.state.forgetPath("Notes/n.md");
  record("Notes/young.md", Y, anchor.ts);
  record("Notes/old.md", O, OLD);
  assert.equal(await recoverLost(r.context, { verdict: "suspected", reason: "test" }, new Set(), () => true), 1);
  assert.deepEqual(posts(), [A, Y], "a version too young for retention is proof enough");
  assert.equal(reason(O), "absent_unproven", "an old one is not");
});

test("a device updated from 1.1.2 has no mark: no probe, and its first feed entry writes one (#145)", async () => {
  const r = await rig(), timers = new FakeTimers();
  assert.equal(r.state.data.feedMark, null);
  r.state.data.lastSeq = r.server.seq;
  let engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start();
  const frame = await r.server.publish({ fileId: "4a".repeat(16), path: "Notes/first.md", bytes: enc("FIRST"), mtime: r.host.clock,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await timers.run(STEP_MS, () => r.state.data.feedMark !== null);
  assert.deepEqual(r.state.data.feedMark, { seq: frame.seq, fileId: frame.file_id, versionId: frame.version_id, ts: frame.ts, replay: false });
  const probes = () => r.server.requests.filter((request) => /&wait=0&limit=2$/.test(request.target)).length;
  assert.equal(probes(), 0, "no mark, no probe");
  assert.equal(r.host.logs.some((line) => /^restore |^feed decision=(restored|suspected)/.test(line)), false);
  await halt(engine, r.server, timers);
  // An untracked poll from the previous engine can finish signing after
  // stopAndWait. Wait for the replacement's probe as well as its new poll;
  // an old request arriving late cannot establish that startup completed.
  const beforeRestart = r.server.requests.length;
  engine = new SyncEngine({ ...r, timers, now: () => r.host.clock });
  await engine.start();
  await timers.run(STEP_MS, () => probes() > 0 && r.server.requests.slice(beforeRestart).some((request) => request.target === `/v1/changes?since=${r.server.seq}&wait=55&limit=1000`) &&
    r.server.feedWaiters.length > 0);
  assert.equal(probes(), 1, "the next start asks once");
  await halt(engine, r.server, timers);
});

test("a record naming a version the server no longer holds takes the identical head it does hold (#145)", async () => {
  // Another device re-sent this note to the restored server first; this one
  // holds the same bytes under the version the restore took, whose id sorts
  // first. Two HEADS with one content settle on the lower id (#110); a
  // version the server does not hold is not a head, and is never the one kept.
  const r = await rig();
  const fileId = "4b".repeat(16), text = "SAME BYTES SENTINEL", lost = "00".repeat(32);
  const head = await r.server.publish({ fileId, path: "Notes/same.md", bytes: enc(text), mtime: r.host.clock,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.host.seed("Notes/same.md", text, 1000);
  r.state.setFile("Notes/same.md", { fileId, versionId: lost, mtime: 1000, size: text.length, sha256: "", ts: head.ts - 1000 });
  await applyChange(r.context, head);
  assert.equal(r.state.fileByPath("Notes/same.md").versionId, head.version_id);
  assert.equal(r.state.fileByPath("Notes/same.md").ts, head.ts, "with that version's server time");
  assert.deepEqual(copies(r.host), []);
  assert.equal(r.server.files.get(fileId).heads.length, 1, "and nothing posted to settle a pair that is not one");
});

/** An engine over `rig`'s state and vault, sending through `request`. */
function engineOver(r, request = r.server.request) {
  const timers = new FakeTimers();
  const transport = new Transport({
    request, serverUrl: () => r.state.data.serverUrl, edgeHeaders: () => [], now: () => r.host.clock,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    sleep: async () => undefined, maxAttempts: 2, log: (line) => r.host.logs.push(line),
  });
  return { engine: new SyncEngine({ state: r.state, transport, host: r.host, now: () => r.host.clock, timers }), timers };
}

/** `chflags uchg`: the rename over this note is refused, EPERM (#144). */
function lock(host, path) {
  const real = host.writer.bind(host);
  host.writer = async (asked) => {
    const writer = await real(asked);
    if (asked !== path) return writer;
    return { ...writer, commit: async () => { throw Object.assign(new Error("EPERM: sentinel refusal"), { code: "EPERM" }); } };
  };
}

test("an entry this device parked moves the mark, so the next start finds the journal as it left it (#144, #145)", async () => {
  const r = await rig();
  const X = "5d".repeat(16), path = "Notes/locked.md";
  const version = (text, parents = []) => r.server.publish({ fileId: X, path, bytes: enc(text), mtime: r.host.clock, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER_DEVICE });
  let { engine, timers } = engineOver(r);
  const first = await version("LOCKED ONE");
  await engine.start();
  await timers.run(STEP_MS, () => r.host.text(path) === "LOCKED ONE");
  lock(r.host, path);
  // The newest entry is one this device cannot write: parked, and the last
  // thing the feed consumed.
  const second = await version("LOCKED TWO", [first.version_id]);
  await timers.run(STEP_MS, () => r.state.data.parked[X] !== undefined && r.state.data.lastSeq === r.server.seq);
  assert.equal(r.state.data.feedMark?.versionId, second.version_id, "the mark is the entry the feed parked");
  await halt(engine, r.server, timers);

  ({ engine, timers } = engineOver(r));
  await engine.start();
  await timers.run(STEP_MS, () => r.host.logs.some((line) => /^feed decision=(verified|restored|suspected) /.test(line)));
  assert.ok(r.host.logs.some((line) => /^feed decision=verified /.test(line)), r.host.logs.filter((line) => line.startsWith("feed")).join(" | "));
  assert.equal(r.host.logs.some((line) => line.startsWith("restore decision=")), false, "a parked entry is no sign of a rebuilt journal");
  await halt(engine, r.server, timers);
});

test("a restore is answered one pull at a time, never beside a parked record's retry (#144, #145)", async () => {
  const r = await rig();
  const X = "5c".repeat(16), path = "Notes/locked.md";
  let gate = null, held = 0, failPolls = false;
  // The retry pass's read of the parked file waits at a gate; the long poll
  // can be made to fail, so the loop sits in its backoff and not in a page.
  const { engine, timers } = engineOver(r, async (request) => {
    if (failPolls && request.url.includes("&wait=55&")) throw new Error("fake: connection reset");
    if (gate !== null && request.method === "GET" && request.url.endsWith(`/v1/files/${X}`)) { held++; await gate; }
    return r.server.request(request);
  });
  const version = (text, parents = []) => r.server.publish({ fileId: X, path, bytes: enc(text), mtime: r.host.clock, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: OTHER_DEVICE });
  const first = await version("LOCKED ONE");
  await engine.start();
  await timers.run(STEP_MS, () => r.host.text(path) === "LOCKED ONE");
  lock(r.host, path);
  await version("LOCKED TWO", [first.version_id]);
  await timers.run(STEP_MS, () => r.state.data.parked[X] !== undefined && r.state.data.lastSeq === r.server.seq);

  // The loop reads, fails, waits and asks again -- never inside a page.
  failPolls = true;
  r.server.releaseFeed();
  await timers.run(STEP_MS, () => r.host.logs.some((line) => line.startsWith("feed decision=retry reason=")));
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  void engine.syncNow();
  await timers.run(STEP_MS, () => held > 0);
  // The server goes back behind the last entry this device read, and the
  // loop's next probe proves it while the retry pass still holds the pull.
  r.server.restoreTo(r.state.data.feedMark.seq - 1);
  await timers.run(STEP_MS, () => r.host.logs.some((line) => line.startsWith("feed decision=restored")));
  await timers.run(STEP_MS);
  assert.equal(r.host.logs.some((line) => line.startsWith("restore decision=start")), false, "the check waits for the pull in hand");
  failPolls = false;
  release();
  await timers.run(STEP_MS, () => r.host.logs.some((line) => line.startsWith("restore decision=summary")));
  const retried = r.host.logs.findIndex((line) => line.startsWith("feed decision=retried "));
  const checked = r.host.logs.findIndex((line) => line.startsWith("restore decision=start"));
  assert.ok(retried !== -1 && retried < checked, r.host.logs.filter((line) => /^(feed|restore) decision/.test(line)).join(" | "));
  await halt(engine, r.server, timers);
});

test("an entry is behind the mark by the server's time, and by seq within one millisecond (#145)", () => {
  const mark = { seq: 10, fileId: "", versionId: "", ts: 5000, replay: true };
  assert.equal(seenBefore({ seq: 99, ts: 4999 }, mark), true, "earlier, whatever seq it reused");
  assert.equal(seenBefore({ seq: 10, ts: 5000 }, mark), true, "the mark itself");
  assert.equal(seenBefore({ seq: 9, ts: 5000 }, mark), true, "the same millisecond, before it");
  assert.equal(seenBefore({ seq: 11, ts: 5000 }, mark), false, "the same millisecond, after it");
  assert.equal(seenBefore({ seq: 1, ts: 5001 }, mark), false, "later, whatever seq it reused");
});
