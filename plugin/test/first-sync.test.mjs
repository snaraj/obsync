import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, Prefetch } = require("../build/sync/pull.js");
const enc = (text) => new TextEncoder().encode(text);

/*
 * A FIRST READ WRITES WHAT A NOTE IS (issue #311). A device with no
 * record of a file replays the feed from zero, and every frame names its
 * file's heads as they are when the page is served. A version that is not
 * one of them is history: a later frame brings the file as it is now.
 */
const EDITED = "a1".repeat(16);
const GONE = "a2".repeat(16);
const NOTE = "Notes/Edited.md";
const DELETED = "Notes/Deleted.md";

/** Another device's vault: one note written three times, and one written and then deleted. */
async function elsewhere(r) {
  const keys = { domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey };
  const v1 = await r.server.publish({ fileId: EDITED, path: NOTE, bytes: enc("first\n"), mtime: 1000, ...keys });
  const v2 = await r.server.publish({ fileId: EDITED, path: NOTE, bytes: enc("second\n"), mtime: 2000, parents: [v1.version_id], ...keys });
  const v3 = await r.server.publish({ fileId: EDITED, path: NOTE, bytes: enc("third\n"), mtime: 3000, parents: [v2.version_id], ...keys });
  const made = await r.server.publish({ fileId: GONE, path: DELETED, bytes: enc("deleted later\n"), mtime: 1500, ...keys });
  await r.server.publishTombstone({ fileId: GONE, path: DELETED, manifestKey: r.keys.manifestKey, parents: [made.version_id] });
  return { v1, v2, v3, made };
}

/** The feed read from zero, as the engine applies it: one page, its chunks prefetched. */
async function replay(r, frames) {
  const page = frames ?? (await r.transport.changes(0, 0)).changes;
  r.context.ahead = new Prefetch(r.context, page);
  const results = [];
  for (const change of page) results.push(await applyChange(r.context, change));
  r.context.ahead = null;
  return results;
}

/** Every chunk id this device asked the server for, one at a time or in a batch. */
function asked(r) {
  return r.server.requests.flatMap((request) =>
    request.target === "/v1/chunks/get" ? JSON.parse(request.json).sids
      : request.target.startsWith("/v1/chunks/") ? [request.target.slice("/v1/chunks/".length)] : []);
}

const skipped = (r, version) => r.host.logs.some((line) =>
  line.includes(`decision=skipped reason=superseded_in_feed file=${version.file_id} seq=${version.seq}`));

test("a new device writes each note as it is now: no older version, and nothing deleted elsewhere is written and trashed (#311)", async () => {
  const r = await rig();
  const { v1, v2, v3, made } = await elsewhere(r);

  const page = (await r.transport.changes(0, 0)).changes;
  const results = await replay(r, page);
  const result = (version) => results[page.findIndex((change) => change.version_id === version.version_id)];

  assert.deepEqual([v1, v2, v3, made].map(result), ["skipped", "skipped", "applied", "skipped"], r.host.logs.join("\n"));
  assert.equal(r.host.text(NOTE), "third\n");
  assert.equal(r.state.fileByPath(NOTE).versionId, v3.version_id);
  assert.equal(r.host.files.has(DELETED), false, "the deleted note was written");
  assert.deepEqual(r.host.trashed, [], "a note deleted elsewhere went to this device's trash");
  for (const version of [v1, v2, made]) {
    assert.ok(skipped(r, version), `seq ${version.seq} was not skipped: ${r.host.logs.join("\n")}`);
    assert.equal(asked(r).includes(version.sids[0]), false, `seq ${version.seq}'s chunk was downloaded`);
  }
  assert.deepEqual(asked(r), [v3.sids[0]], "the note as it is now is the one chunk downloaded");
});

test("a note already here at an older version is adopted, and the newer ones update it, with no copy (#311, #163)", async () => {
  const r = await rig();
  r.host.seed(NOTE, "first\n", 5000);
  const { v1, v3 } = await elsewhere(r);

  await replay(r);

  assert.deepEqual([...r.host.files.keys()].filter((path) => path.includes("(conflict from")), [], r.host.logs.join("\n"));
  assert.equal(r.host.text(NOTE), "third\n");
  assert.equal(r.state.fileByPath(NOTE).versionId, v3.version_id);
  assert.equal(skipped(r, v1), false, "the version at an occupied name was skipped, not compared");
});

test("a frame that names no heads proves nothing: the version is applied as before (#311)", async () => {
  const r = await rig();
  const { v1, v2, made } = await elsewhere(r);
  const frames = (await r.transport.changes(0, 0)).changes.map((change) => ({ ...change, heads: [] }));

  await replay(r, frames);

  assert.equal(r.host.text(NOTE), "third\n");
  assert.equal(r.host.logs.some((line) => line.includes("superseded_in_feed")), false, r.host.logs.join("\n"));
  for (const version of [v1, v2]) assert.ok(asked(r).includes(version.sids[0]), `seq ${version.seq} was not applied`);
  // And their chunks still come many to a request, a note new here among them.
  const batched = r.server.requests.filter((request) => request.target === "/v1/chunks/get")
    .flatMap((request) => JSON.parse(request.json).sids);
  assert.ok(batched.includes(made.sids[0]), `the new note's chunk was fetched on its own: ${JSON.stringify(batched)}`);
});

test("a device that holds the file still takes each version it is sent (#311)", async () => {
  const r = await rig();
  const { v1, v2 } = await elsewhere(r);
  const frames = (await r.transport.changes(0, 0)).changes;
  const served = (version) => frames.find((change) => change.version_id === version.version_id);
  assert.equal(await applyChange(r.context, { ...served(v1), heads: [v1.version_id] }), "applied");

  assert.equal(await applyChange(r.context, served(v2)), "applied", r.host.logs.join("\n"));

  assert.equal(r.host.text(NOTE), "second\n");
  assert.equal(skipped(r, v2), false);
});
