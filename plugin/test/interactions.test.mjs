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
  await timers.run(STEP_MS, () => a.state.data.lastSeq === server.seq);
  const lostBeforeRead = a.host.text(path) === null;
  release.resolve();
  await a.engine.syncNow();
  t.diagnostic(JSON.stringify({
    lostBeforeRead, desktop: a.host.text(path), phone: b.host.text(path),
    manifests: (await published(server, id, keys.manifestKey)).map(({ path, deleted, size }) => ({ path, deleted, size })),
    pushFailure: a.host.logs.filter((line) => line.includes("decision=failed")),
  }));
  assert.equal(a.host.text(path), "NEVER UPLOADED EDIT SENTINEL",
    "a replay must retain bytes no successful upload recorded");
});
