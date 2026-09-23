/**
 * Remote-only classification and the local copy it used to leave behind
 * (issue #100).
 *
 * A phone downloaded a 376 MB intermediate version of a video because it was
 * under the 512 MiB ceiling, then correctly classed the finished 874 MiB
 * version remote-only -- and left the truncated file in the vault with no
 * marker. The device then showed two truths at once: the file explorer listed
 * a local file, "Show remote-only files" listed the same path as absent, and
 * one touch of that file would publish a version whose parent is not the
 * latest.
 *
 * PLATFORM. The ceiling is device policy and defaults to unlimited on
 * desktop, so this is a mobile-shaped decision by default; the branch is
 * platform-independent code and runs here on both host shapes, because a
 * desktop user who sets a ceiling gets exactly the same behaviour.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, remoteOnlyList } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

const enc = (text) => new TextEncoder().encode(text);
const FILE = "16".repeat(16);
const PATH = "Attachments/clip.bin";

/** v1 small enough to land, v2 above the ceiling: the reported sequence. */
async function twoVersions({ isMobile = true, ceiling = 16 } = {}) {
  const rigged = await rig({ isMobile, policy: { perFileMaxBytes: ceiling, totalBudgetBytes: 0 } });
  const { server, context, keys: k } = rigged;
  const first = await server.publish({
    fileId: FILE,
    path: PATH,
    bytes: enc("small"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, first), "applied");
  const second = async () => server.publish({
    fileId: FILE,
    path: PATH,
    bytes: enc("a payload that is well past the ceiling"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [first.version_id],
  });
  return { ...rigged, first, second };
}

for (const isMobile of [true, false]) {
  test(`a version above the ceiling trashes the older local copy (${isMobile ? "mobile" : "desktop"} host)`, async () => {
    const { host, state, context, second } = await twoVersions({ isMobile });
    assert.equal(host.text(PATH), "small", "v1 landed under the ceiling");

    assert.equal(await applyChange(context, await second()), "remote_only");

    assert.equal(host.files.has(PATH), false, "no file is left claiming to be this one");
    assert.equal(state.fileByPath(PATH), undefined);
    assert.deepEqual(state.data.remoteOnly[FILE], { path: PATH, size: 39 });
  });
}

test("the local copy is trashed through the host and the path is forgotten", async () => {
  const { host, state, context, second } = await twoVersions();
  assert.equal(host.files.has(PATH), true);

  assert.equal(await applyChange(context, await second()), "remote_only");

  assert.equal(host.files.has(PATH), false, "the stale copy is gone from the vault");
  assert.deepEqual(host.trashed, [PATH], "and it went to the trash, not to an unlink");
  assert.equal(state.fileByPath(PATH), undefined, "the path is forgotten");
  assert.deepEqual(state.data.remoteOnly[FILE], { path: PATH, size: 39 });
  assert.equal(remoteOnlyList(context).length, 1, "one truth, in the remote-only list");

  const line = host.logs.find((entry) => entry.includes("decision=remote_only"));
  assert.ok(line, host.logs.join(" | "));
  assert.match(line, /local=trashed/);
  assert.match(line, /reason=per_file/);
  assert.match(line, /duration_ms=\d+/);
});

test("a later local file at that path cannot publish a version whose parent is not the latest", async () => {
  const { host, server, state, context, first, second } = await twoVersions();
  await applyChange(context, await second());

  // The user puts something at that path again. With the record forgotten it
  // is a new file, never a child of v1 -- which is what stopped the other
  // device receiving a conflict copy of stale content.
  host.seed(PATH, "typed here after the fact", 1757200003000);
  const outcome = await pushFile(context, PATH);
  assert.equal(outcome.status, "pushed");
  assert.notEqual(outcome.fileId, FILE, "a new file id, not the remote-only one");
  const posted = server.files.get(outcome.fileId).versions[0];
  assert.deepEqual(posted.parents, [], "and no parent at all, least of all the stale one");
  assert.equal(
    server.files.get(FILE).versions.some((version) => version.parents.includes(first.version_id) &&
      version.device_id === state.data.deviceId),
    false,
    "this device published nothing onto the remote-only file",
  );
});

test("a local copy holding bytes this device never pushed is kept, not trashed", async () => {
  const { host, state, context, second } = await twoVersions();
  // An edit made here and not yet pushed: the record and the file disagree,
  // so no version anywhere holds these bytes (issues #98 and #106).
  host.seed(PATH, "edited here and never pushed", 1757200009000);

  assert.equal(await applyChange(context, await second()), "remote_only");

  assert.equal(host.text(PATH), "edited here and never pushed", "the unpushed edit survives");
  assert.deepEqual(host.trashed, [], "nothing was trashed");
  assert.notEqual(state.fileByPath(PATH), undefined, "the record stays, so the queued push has a parent");
  assert.deepEqual(state.data.remoteOnly[FILE], { path: PATH, size: 39 });
  const line = host.logs.find((entry) => entry.includes("decision=remote_only"));
  assert.match(line, /local=kept_local_edit/);
});

test("a remote-only classification with no local copy trashes nothing and says so", async () => {
  const { host, context, keys: k, server } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 16, totalBudgetBytes: 0 },
  });
  const frame = await server.publish({
    fileId: FILE,
    path: PATH,
    bytes: enc("a payload that is well past the ceiling"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");
  assert.deepEqual(host.trashed, []);
  assert.match(host.logs.find((entry) => entry.includes("decision=remote_only")), /local=none/);
});
