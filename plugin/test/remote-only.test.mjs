/**
 * Remote-only classification, and the local copy a newer version above the
 * ceiling finds here (issues #100 and #161).
 *
 * A phone downloaded a 376 MB intermediate version of a video because it was
 * under the 512 MiB ceiling, then correctly classed the finished 874 MiB
 * version remote-only -- and left the truncated file in the vault with no
 * marker (issue #100). 1.0.8 answered by trashing that copy, silently, and so
 * a PDF the user had fetched past the ceiling on purpose went to the trash
 * the moment someone updated it, without a word (issue #161). Excluding never
 * deletes: the copy stays, with its record, and is named as the older version
 * it is -- in "Show remote-only files" and in one notice offering Fetch.
 *
 * PLATFORM. The ceiling is device policy and defaults to unlimited on
 * desktop, so this is a mobile-shaped decision by default; the branch is
 * platform-independent code and runs here on both host shapes, because a
 * desktop user who sets a ceiling gets exactly the same behaviour.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, fetchRemoteOnly, remoteOnlyList } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

const enc = (text) => new TextEncoder().encode(text);
const FILE = "16".repeat(16);
const PATH = "Attachments/clip.bin";
const BIG = "a payload that is well past the ceiling";

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
  const second = async (path = PATH) => server.publish({
    fileId: FILE,
    path,
    bytes: enc(BIG),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [first.version_id],
  });
  return { ...rigged, first, second };
}

for (const isMobile of [true, false]) {
  test(`a version above the ceiling keeps the older local copy, and says so (${isMobile ? "mobile" : "desktop"} host)`, async () => {
    const { host, state, context, first, second } = await twoVersions({ isMobile });
    assert.equal(host.text(PATH), "small", "v1 landed under the ceiling");

    assert.equal(await applyChange(context, await second()), "remote_only");

    assert.equal(host.text(PATH), "small", "the copy the user had was taken away");
    assert.deepEqual(host.trashed, [], "a file went to the trash for being older");
    assert.equal(state.fileByPath(PATH).versionId, first.version_id, "the record no longer says what the copy is");
    assert.deepEqual(state.data.remoteOnly[FILE], { path: PATH, size: BIG.length });
  });
}

test("the older copy is named as older, in the list and in one notice offering Fetch", async () => {
  const { host, context, second } = await twoVersions();
  assert.equal(await applyChange(context, await second()), "remote_only");

  const listed = remoteOnlyList(context);
  assert.deepEqual(listed.map(({ kind, why }) => ({ kind, why })), [{ kind: "older", why: "a newer version is on the server" }]);
  assert.equal(host.notices.length, 1, host.notices.join(" | "));
  assert.equal(
    host.notices[0],
    `obsync did not download the newer version of ${PATH} (${BIG.length} B): it is above this device's per-file ceiling (16 B). ` +
      "This device keeps its older copy. Fetch the newer one when you need it, here or under Show remote-only files.",
  );
  assert.deepEqual(host.asked.map(({ actions }) => actions), [[{ kind: "fetch", fileId: FILE }]]);

  const line = host.logs.find((entry) => entry.includes("decision=remote_only"));
  assert.ok(line, host.logs.join(" | "));
  assert.match(line, /local=kept_older/);
  assert.match(line, /reason=per_file/);
  assert.match(line, /duration_ms=\d+/);
});

test("Fetch replaces the older copy with the newer version, and the next newer one is said again", async () => {
  const { host, server, state, context, keys: k, second } = await twoVersions();
  const v2 = await second();
  await applyChange(context, v2);

  assert.equal(await fetchRemoteOnly(context, FILE), PATH);

  assert.equal(host.text(PATH), BIG);
  assert.deepEqual(host.trashed, []);
  assert.equal(state.fileByPath(PATH).versionId, v2.version_id);
  assert.equal(state.data.remoteOnly[FILE], undefined, "it is no longer remote-only");
  assert.deepEqual(remoteOnlyList(context), []);

  const v3 = await server.publish({
    fileId: FILE, path: PATH, bytes: enc(`${BIG}, and then some more`), mtime: 1757200003000,
    domainKey: k.domainKey, manifestKey: k.manifestKey, parents: [v2.version_id],
  });
  assert.equal(await applyChange(context, v3), "remote_only");
  assert.equal(host.text(PATH), BIG, "the fetched file was taken away by its next version");
  assert.equal(host.notices.length, 2, "a file fetched on purpose was superseded without a word");
});

test("Fetch refuses an older copy edited here, and keeps the edit", async () => {
  const { host, state, context, first, second } = await twoVersions();
  await applyChange(context, await second());
  host.seed(PATH, "edited here and never pushed", 1757200009000);

  await assert.rejects(fetchRemoteOnly(context, FILE), /has changes on this device that are not on the server yet/);

  assert.equal(host.text(PATH), "edited here and never pushed");
  assert.equal(state.fileByPath(PATH).versionId, first.version_id);
});

test("Fetch of a copy renamed on the other device moves it first, and leaves no second file", async () => {
  const { host, state, context, second } = await twoVersions();
  await applyChange(context, await second("Attachments/renamed.bin"));
  assert.equal(host.text(PATH), "small", "the older copy stays under the name it has");

  assert.equal(await fetchRemoteOnly(context, FILE), "Attachments/renamed.bin");

  assert.equal(host.text("Attachments/renamed.bin"), BIG);
  assert.equal(host.files.has(PATH), false, "the older copy was left behind as a second file");
  assert.equal(state.fileByPath(PATH), undefined);
  assert.equal(state.pathByFileId(FILE), "Attachments/renamed.bin");
  assert.ok(context.moved.has(`${PATH}\u0000Attachments/renamed.bin`), "the move's watcher echo is not marked");
});

test("Fetch never replaces a different file standing at the name", async () => {
  const { host, context, keys: k, server } = await rig({ isMobile: true, policy: { perFileMaxBytes: 16, totalBudgetBytes: 0 } });
  await applyChange(context, await server.publish({
    fileId: FILE, path: PATH, bytes: enc(BIG), mtime: 1757200002000, domainKey: k.domainKey, manifestKey: k.manifestKey,
  }));
  host.seed(PATH, "a different file the user made here", 1757200005000);

  await assert.rejects(fetchRemoteOnly(context, FILE), /Another file is already at Attachments\/clip\.bin/);
  assert.equal(host.text(PATH), "a different file the user made here");
});

test("an edit of the older copy is published on the version it was made from, and nothing is lost", async () => {
  // What #100 feared, made visible instead of made impossible: the edit forks
  // the file, the server keeps both heads, and a device that can hold the
  // newer version settles the pair as every fork is settled.
  const { host, server, context, first, second } = await twoVersions();
  const v2 = await second();
  await applyChange(context, v2);

  host.seed(PATH, "typed here after the fact", 1757200003000);
  const outcome = await pushFile(context, PATH);

  assert.equal(outcome.status, "pushed");
  assert.equal(outcome.fileId, FILE, "the edit became a file of its own");
  const file = server.files.get(FILE);
  assert.deepEqual(file.versions.find((version) => version.version_id === outcome.versionId).parents, [first.version_id]);
  assert.deepEqual([...file.heads].sort(), [outcome.versionId, v2.version_id].sort(), "one side of the fork was lost");
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
  assert.deepEqual(state.data.remoteOnly[FILE], { path: PATH, size: BIG.length });
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
    bytes: enc(BIG),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");
  assert.deepEqual(host.trashed, []);
  assert.deepEqual(host.notices, [], "a file this device never had is not news");
  assert.match(host.logs.find((entry) => entry.includes("decision=remote_only")), /local=none/);
});

/**
 * The "Remote only" view with recording widgets: what a person reads. Each
 * heading stands above the entries it is true of, and only those (#161).
 */
function view(t, entries) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const obsidian = box.require("obsidian");
  const shown = [];
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { shown.push(`  ${value}`); return this; },
    setDesc(value) { shown[shown.length - 1] += ` | ${value}`; return this; },
    addButton() { return this; },
  });
  const contentEl = { empty() { shown.length = 0; }, createEl(tag, { text }) { shown.push(text); } };
  const modals = box.require(join(box.home, "build/ui/modals.js"));
  const pull = box.require(join(box.home, "build/sync/pull.js"));
  pull.remoteOnlyList = () => entries;
  const modal = new modals.RemoteOnlyModal({}, { syncContext: () => ({}) });
  modal.contentEl = contentEl;
  modal.setTitle = () => undefined;
  modal.onOpen();
  return { shown, headings: modals.REMOTE_ONLY_HEADINGS };
}

test("ceilings set to 0 do not call an available file larger than this device allows", async (t) => {
  const { host, state, context, second } = await twoVersions();
  await applyChange(context, await second());
  host.files.delete(PATH);
  state.forgetPath(PATH);
  state.data.policy = { perFileMaxBytes: 0, totalBudgetBytes: 0 };
  const entries = remoteOnlyList(context);
  assert.deepEqual(entries.map(({ kind, why }) => ({ kind, why })), [{ kind: "available", why: "available" }]);

  const { shown, headings } = view(t, entries);
  const [, limit] = headings.find(([kind]) => kind === "limit");
  const [, available] = headings.find(([kind]) => kind === "available");
  assert.equal(shown.includes(limit), false, "an available file sits under the larger-than-allowed heading");
  assert.deepEqual(shown, [available, `  ${PATH} | 39 B — available`]);
});

test("each kind of entry is shown under its own heading", (t) => {
  const { shown, headings } = view(t, [
    { fileId: "a".repeat(32), path: "A/older.pdf", size: 5, kind: "older", why: "a newer version is on the server" },
    { fileId: "b".repeat(32), path: "B/huge.mov", size: 6, kind: "limit", why: "above this device's per-file ceiling (1 MiB)" },
    { fileId: "c".repeat(32), path: "C/fits.png", size: 7, kind: "available", why: "available" },
  ]);
  const text = Object.fromEntries(headings);
  assert.deepEqual(shown, [
    text.older, "  A/older.pdf | 5 B — a newer version is on the server",
    text.limit, "  B/huge.mov | 6 B — above this device's per-file ceiling (1 MiB)",
    text.available, "  C/fits.png | 7 B — available",
  ]);
  assert.match(text.limit, /larger than this device allows/);
  assert.doesNotMatch(text.available, /larger than/);
  assert.doesNotMatch(text.older, /larger than/);
});
