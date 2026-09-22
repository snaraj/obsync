/**
 * THE REVIEWER'S OWN INPUT CASES, kept as a file of their own.
 *
 * Round 5 (PR #120, comment 5778412397) returned seven findings, three of
 * them reproduced by the cases below: a rewound feed replaying a deletion
 * over an edit this device never published, an upload that finishes after
 * its file has left the selection, and a folder rename that drops a note
 * still waiting in the debounce queue. They are the receipt's own tests,
 * carried verbatim apart from this header, so the repair is measured against
 * the input that found it rather than against a restatement of it.
 *
 * Each one is red at `3a19205` and green at the commit that names it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, rig, published, pair, STEP_MS, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine } = require("../build/sync/engine.js");
const { pushFile } = require("../build/sync/push.js");
const { applyChange } = require("../build/sync/pull.js");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("review: replay skips a historical tombstone that the tracked live version already incorporates", async (t) => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  const fileId = "65".repeat(16), path = "Notes/restored.md";
  const initial = await r.server.publish({ fileId, path,
    bytes: new TextEncoder().encode("OLD SENTINEL"), mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const deleted = await r.server.publishTombstone({ fileId, path,
    manifestKey: r.keys.manifestKey, parents: [initial.version_id] });
  const live = await r.server.publish({ fileId, path,
    bytes: new TextEncoder().encode("CURRENT LIVE SENTINEL"), mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, parents: [deleted.version_id] });
  await applyChange(r.context, live);
  assert.equal(r.host.text(path), "CURRENT LIVE SENTINEL");
  assert.equal(await applyChange(r.context, initial), "skipped", "live ancestor replay control");
  const result = await applyChange(r.context, deleted);
  t.diagnostic(JSON.stringify({ result, filePresent: r.host.files.has(path),
    trackedVersion: r.state.fileByPath(path)?.versionId ?? null }));
  assert.equal(r.host.text(path), "CURRENT LIVE SENTINEL",
    "an older tombstone must not delete a newer tracked live version during scope replay");
});

async function saveScope(r, folders) {
  const { a, server } = r;
  a.plugin.log = (line) => a.host.logs.push(line);
  a.plugin.startEngine = async () => { a.plugin.engine = a.engine; await a.engine.start(); };
  let complete = false;
  const saving = a.plugin.saveSyncFolders(folders);
  const done = saving.then((value) => { complete = true; return value; }, (error) => { complete = true; throw error; });
  const deadline = Date.now() + 10000;
  while (!complete) {
    server.releaseFeed();
    if (Date.now() > deadline) throw new Error("review: scope change failed to settle");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await done;
}

test("review: widening after an excluded remote deletion must preserve the local edit", async (t) => {
  const r = await pair(t);
  const { a, b, server, timers, keys } = r;
  const path = "Notes/local.md";
  a.state.data.syncFolders = ["Notes"];
  a.host.write(path, "SYNCED BEFORE EXCLUSION SENTINEL", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, path) && settled(b, path) &&
    b.host.text(path) === "SYNCED BEFORE EXCLUSION SENTINEL");
  const id = a.state.fileByPath(path).fileId;
  await saveScope(r, []);
  b.host.remove(path);
  await b.engine.syncNow();
  await timers.run(STEP_MS, () => a.state.data.lastSeq === server.seq);
  assert.equal(a.host.text(path), "SYNCED BEFORE EXCLUSION SENTINEL", "excluded deletion control");
  a.host.write(path, "LOCALLY EDITED WHILE EXCLUDED SENTINEL", 3000);
  await saveScope(r, ["Notes"]);
  await a.engine.syncNow();
  await timers.run(STEP_MS, () => a.state.data.lastSeq === server.seq && b.state.data.lastSeq === server.seq);
  t.diagnostic(JSON.stringify({
    desktop: a.host.text(path), phone: b.host.text(path),
    desktopFiles: [...a.host.files.keys()],
    manifests: (await published(server, id, keys.manifestKey)).map(({ path, deleted }) => ({ path, deleted })),
    desktopLogs: a.host.logs.filter((line) => /tombstone|scope|conflict/.test(line)),
  }));
  assert.ok([...a.host.files.values()].some(({ bytes }) =>
    new TextDecoder().decode(bytes) === "LOCALLY EDITED WHILE EXCLUDED SENTINEL"),
    "widening must retain the edit on the device where the user made it");
});

test("review: widening must not trash an unuploaded local edit while its source read is pending", async (t) => {
  const r = await pair(t);
  const { a, b, server, timers, keys } = r;
  const path = "Notes/local.md";
  a.state.data.syncFolders = ["Notes"];
  a.host.write(path, "SYNCED BEFORE EXCLUSION SENTINEL", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, path) && settled(b, path));
  const id = a.state.fileByPath(path).fileId;
  await saveScope(r, []);
  b.host.remove(path);
  await b.engine.syncNow();
  await timers.run(STEP_MS, () => a.state.data.lastSeq === server.seq);
  a.host.write(path, "NEVER UPLOADED EDIT SENTINEL", 3000);

  const entered = deferred(), release = deferred();
  const read = a.host.read.bind(a.host);
  a.host.read = async (candidate) => {
    if (candidate === path) {
      entered.resolve();
      await release.promise;
    }
    return read(candidate);
  };
  t.after(() => release.resolve());
  await saveScope(r, ["Notes"]);
  await entered.promise;
  // THE OBSERVATION THIS TEST EXISTS FOR, taken while the read is still
  // outstanding: the replay must not have removed the file. It is taken
  // HERE, and the feed is then let go, because 1.1.0 republishes the kept
  // bytes from inside the tombstone branch (#106) -- so the read this test
  // is holding is one the feed itself is waiting on, and draining the feed
  // first would be waiting for a read this test has promised not to finish.
  // Releasing after the observation changes nothing the test asserts and
  // removes a deadlock that only the harness can reach.
  const lostBeforeRead = a.host.text(path) === null;
  release.resolve();
  await timers.run(STEP_MS, () => a.state.data.lastSeq === server.seq);
  await a.engine.syncNow();
  t.diagnostic(JSON.stringify({
    lostBeforeRead, desktop: a.host.text(path), phone: b.host.text(path),
    manifests: (await published(server, id, keys.manifestKey)).map(({ path, deleted, size }) => ({ path, deleted, size })),
    pushFailure: a.host.logs.filter((line) => line.includes("decision=failed")),
  }));
  assert.equal(a.host.text(path), "NEVER UPLOADED EDIT SENTINEL",
    "a replay must retain bytes no successful upload recorded");
});

test("review: a pending upload must not restore tracking for a file that left the selected scope", async (t) => {
  const r = await rig();
  const path = "Notes/note.md";
  const moved = "Archive/note.md";
  r.state.data.syncFolders = ["Notes"];
  r.host.seed(path, "ORIGINAL SENTINEL", 1000);
  await pushFile(r.context, path);
  const id = r.state.fileByPath(path).fileId;
  const engine = new SyncEngine({ ...r, timers: new FakeTimers() });
  await engine.start();
  const entered = deferred(), release = deferred();
  const actual = r.transport.putChunk.bind(r.transport);
  r.transport.putChunk = async (...args) => {
    await actual(...args);
    entered.resolve();
    await release.promise;
  };
  t.after(async () => {
    release.resolve();
    const stopped = engine.stopAndWait();
    r.server.releaseFeed();
    await stopped;
  });

  r.host.seed(path, "EDIT THAT REMAINS IN THE ARCHIVE SENTINEL", 2000);
  const uploading = engine.syncNow();
  await entered.promise;
  r.host.files.set(moved, r.host.files.get(path));
  r.host.files.delete(path);
  engine.renamed(path, moved);
  assert.equal(r.state.fileByPath(path), undefined, "the rename initially drops tracking");
  release.resolve();
  await uploading;
  const trackingRestored = r.state.fileByPath(path) !== undefined;
  await engine.syncNow();
  const manifests = await published(r.server, id, r.keys.manifestKey);
  t.diagnostic(JSON.stringify({
    trackingRestored,
    manifests: manifests.map(({ path, deleted }) => ({ path, deleted })),
    movedFilePresent: r.host.files.has(moved),
    notices: r.host.notices,
  }));
  assert.equal(r.server.journal.filter((frame) => frame.deleted).length, 0,
    "moving a live file outside the selection must not publish a tombstone later");
  assert.equal(trackingRestored, false, "the old upload must not restore the forgotten path");
});

test("review: moving outside the selection after an upload settles is the safe control", async (t) => {
  const r = await rig();
  r.state.data.syncFolders = ["Notes"];
  r.host.seed("Notes/note.md", "CONTROL SENTINEL", 1000);
  await pushFile(r.context, "Notes/note.md");
  const engine = new SyncEngine({ ...r, timers: new FakeTimers() });
  await engine.start();
  t.after(async () => {
    const stopped = engine.stopAndWait();
    r.server.releaseFeed();
    await stopped;
  });
  r.host.files.set("Archive/note.md", r.host.files.get("Notes/note.md"));
  r.host.files.delete("Notes/note.md");
  engine.renamed("Notes/note.md", "Archive/note.md");
  await engine.syncNow();
  assert.equal(r.state.fileByPath("Notes/note.md"), undefined);
  assert.equal(r.server.journal.filter((frame) => frame.deleted).length, 0);
  assert.equal(r.host.text("Archive/note.md"), "CONTROL SENTINEL");
});

test("review: a scope exit during upload must preserve the other device's live note", async (t) => {
  const { server, timers, a, b, keys } = await pair(t);
  a.state.data.syncFolders = ["Notes"];
  const path = "Notes/note.md", moved = "Archive/note.md";
  a.host.write(path, "ORIGINAL PEER SENTINEL", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, path) && settled(b, path) &&
    b.host.text(path) === "ORIGINAL PEER SENTINEL");
  const id = a.state.fileByPath(path).fileId;
  const entered = deferred(), release = deferred();
  const actual = a.transport.putChunk.bind(a.transport);
  a.transport.putChunk = async (...args) => {
    await actual(...args);
    entered.resolve();
    await release.promise;
  };
  t.after(() => release.resolve());
  a.host.write(path, "EDIT MOVED OUTSIDE SCOPE SENTINEL", 2000);
  const uploading = a.engine.syncNow();
  await entered.promise;
  a.host.rename(path, moved);
  assert.equal(a.state.fileByPath(path), undefined);
  release.resolve();
  await uploading;
  // ONE EDIT, and the repair is what made it necessary: the third clause
  // waited for the DESKTOP to hold a record for this path again, which is
  // precisely what a push that outlives its path must no longer do.
  //
  // WHAT 1.1.0 CHANGES, and why this no longer waits for the edit to reach
  // the phone. The growing-file lane stats the path once more when the
  // chunks are up (#99): the file has been renamed out from under this push,
  // so the version is ABANDONED before it exists rather than posted for a
  // path the file has left. The reviewer's finding asked that a completion
  // arriving after a scope exit publish nothing and re-track nothing; the
  // composed head reaches that one step earlier, by never completing. So the
  // phone is never told anything about this path, and what it keeps is the
  // copy it already had. Every assertion below is that outcome, stated
  // whole: nothing is lost on either device, and no tombstone exists.
  await a.engine.syncNow();
  await timers.run(STEP_MS, () => b.state.data.lastSeq === server.seq);
  const manifests = (await published(server, id, keys.manifestKey))
    .map(({ path, deleted }) => ({ path, deleted }));
  t.diagnostic(JSON.stringify({
    aMoved: a.host.text(moved), aPath: a.host.text(path), bOriginal: b.host.text(path),
    aRecord: a.state.fileByPath(path) !== undefined, manifests,
    abandoned: a.host.logs.filter((line) => line.includes("reason=changed_during_read")),
  }));
  assert.equal(a.host.text(moved), "EDIT MOVED OUTSIDE SCOPE SENTINEL",
    "the edit left the scope and must still be on the disk that holds it");
  assert.equal(b.host.text(path), "ORIGINAL PEER SENTINEL",
    "the other device must retain its copy after a local scope exit");
  assert.equal(a.state.fileByPath(path), undefined,
    "the completed upload re-tracked a path its file had left");
  assert.deepEqual(manifests.filter(({ deleted }) => deleted), [],
    "a scope exit published a tombstone for the note the other device is holding");
  assert.ok(
    a.host.logs.some((line) => line.includes("decision=abandoned reason=changed_during_read")),
    `the push was not abandoned, so something was published for a path the file had left: ${
      a.host.logs.filter((line) => line.startsWith("push")).join(" | ")}`,
  );
});

test("review: a folder rename retains the pending upload of an untracked new note", async (t) => {
  const { a, b, server, timers } = await pair(t);
  a.state.data.syncFolders = ["Notes"];
  await a.engine.start();
  await b.engine.start();
  a.host.write("Notes/new.md", "NEW NOTE SENTINEL", 1000);
  assert.equal(a.state.fileByPath("Notes/new.md"), undefined, "the new note is still debouncing");
  a.host.renameFolder("Notes", "Journal");
  await timers.run(STEP_MS);
  t.diagnostic(JSON.stringify({ scope: a.state.data.syncFolders, desktop: a.host.text("Journal/new.md"),
    phone: b.host.text("Journal/new.md"), serverFiles: server.vaultFiles().length,
    desktopLogs: a.host.logs }));
  assert.equal(b.host.text("Journal/new.md"), "NEW NOTE SENTINEL", "rename must not drop the pending new note");
});
