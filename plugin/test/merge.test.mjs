/**
 * Two devices merging the same concurrent edit, and the storm that was (#110).
 *
 * THE INVARIANT. A concurrent edit is resolved a BOUNDED number of times. One
 * fork produces at most one merge per device; after that the file is quiet.
 * Sync that never settles is not a slower sync: it fills the server's journal,
 * burns the battery and the network on both devices, and can push an account
 * into its quota, which takes the vault offline for every note.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { STEP_MS, pair, settled } from "./fake.mjs";

const BASE = "one\ntwo\nthree\n";
/** Edits in DIFFERENT hunks, so the three-way merge is clean on both sides. */
const DESKTOP = "ONE\ntwo\nthree\n";
const PHONE = "one\ntwo\nTHREE\n";

/** Every version the server holds for one file. */
const versions = (server, fileId) => server.files.get(fileId)?.versions.length ?? 0;

const story = (server, fileId, a, b) =>
  [`versions=${versions(server, fileId)}`,
    `heads=${server.files.get(fileId)?.heads.length}`,
    `desktop=${JSON.stringify(a.host.text("Shared.md"))}`,
    `phone=${JSON.stringify(b.host.text("Shared.md"))}`,
    `merge_notices=${a.host.notices.filter((n) => n.includes("merged")).length}` +
      `/${b.host.notices.filter((n) => n.includes("merged")).length}`,
    `desktop_decisions=${decisions(a)}`, `phone_decisions=${decisions(b)}`].join(" ");

/** Every decision the pull path took on this device, in order. */
const decisions = (device) => device.host.logs
  .filter((line) => line.startsWith("pull"))
  .map((line) => (line.match(/decision=\S+( reason=\S+)?/) ?? [line])[0]).join(",");

test("two devices resolving one concurrent edit settle instead of looping", async (t) => {
  const { server, timers, a, b } = await pair(t);

  a.host.write("Shared.md", BASE, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text("Shared.md") === BASE && settled(a, "Shared.md") && settled(b, "Shared.md"));
  const fileId = a.state.fileByPath("Shared.md").fileId;
  const first = a.state.fileByPath("Shared.md").versionId;
  const before = versions(server, fileId);

  // The desktop is closed and its user edits the first line; the phone edits
  // the last one and publishes. Two heads, and a merge that comes out clean.
  a.engine.stop();
  a.host.write("Shared.md", DESKTOP, 2000);
  b.host.write("Shared.md", PHONE, 3000);
  await timers.run(STEP_MS, () => b.state.fileByPath("Shared.md").versionId !== first);

  await a.engine.start();
  // Let the fork resolve, then watch two quiet windows: a loop shows up as a
  // version count that never stops moving.
  await timers.run(STEP_MS, () => versions(server, fileId) >= 4);
  await timers.run(STEP_MS);
  const quiet = versions(server, fileId);
  await timers.run(STEP_MS);

  assert.equal(
    versions(server, fileId), quiet,
    `the file is still gaining versions: ${story(server, fileId, a, b)}`,
  );
  // Five at most on top of what the note already had, and every one of them
  // named: the two concurrent edits, one resolution from each device when
  // both race, and the single version that closes the fork. Fewer when one
  // device gets there first. The loop produced hundreds.
  assert.ok(
    quiet - before <= 5,
    `one concurrent edit cost ${quiet - before} versions: ${story(server, fileId, a, b)}`,
  );
  assert.equal(server.files.get(fileId).heads.length, 1, `the file is still forked: ${story(server, fileId, a, b)}`);
  // Both devices hold the same text, which is the point of merging at all...
  assert.equal(a.host.text("Shared.md"), b.host.text("Shared.md"), story(server, fileId, a, b));
  // ...and the same HEAD. Stopping is not enough: two devices that each
  // adopted the other's head would have swapped, and the next real edit would
  // reconcile against the wrong base.
  assert.equal(
    a.state.fileByPath("Shared.md").versionId,
    b.state.fileByPath("Shared.md").versionId,
    `the devices settled on different heads: ${story(server, fileId, a, b)}`,
  );

  // And the next edit is an ordinary one: it applies on the other device with
  // no merge and no conflict copy.
  const merges = () => a.host.logs.concat(b.host.logs).filter((line) => line.includes("decision=merged")).length;
  const copies = () => [...a.host.files.keys(), ...b.host.files.keys()].filter((path) => path.includes("(conflict from"));
  const merged = merges();
  // The copy the desktop made when it started is issue #98's guard doing its
  // job: the phone's version was kept beside an edit this device had not
  // pushed yet. What must not happen is ANOTHER one from here on.
  const kept = copies();
  const after = "ONE\ntwo\nTHREE\nfour\n";
  a.host.write("Shared.md", after, 5000);
  await timers.run(STEP_MS, () => b.host.text("Shared.md") === after);
  await timers.run(STEP_MS);

  assert.equal(b.host.text("Shared.md"), after, `a later edit did not simply apply: ${story(server, fileId, a, b)}`);
  assert.equal(merges(), merged, "a later edit still went through a merge");
  assert.deepEqual(copies(), kept, "a later edit produced a new conflict copy");
});

/**
 * The breaker, driven by forks rather than by an argument: six versions of one
 * file, each conflicting with what this device holds. The sixth is past the
 * limit, and from there the device keeps both sides instead of merging.
 */
test("more than a handful of resolutions of one file in a window stops the merging", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");
  const enc = (text) => new TextEncoder().encode(text);

  const r = await rig();
  const NOTE = "Notes/Storm.md";
  r.host.seed(NOTE, "the line both sides start from\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "the line this device wrote\n", 2000);
  await pushFile(r.context, NOTE);

  const results = [];
  for (let round = 1; round <= 6; round++) {
    const theirs = await r.server.publish({
      fileId: base.fileId,
      path: NOTE,
      bytes: enc(`the line the other device wrote, round ${round}\n`),
      mtime: 4000 + round,
      parents: [base.versionId],
      domainKey: r.keys.domainKey,
      manifestKey: r.keys.manifestKey,
    });
    results.push(await applyChange(r.context, theirs));
  }

  const storms = r.host.logs.filter((line) => line.includes("reason=merge_storm"));
  assert.equal(storms.length, 1, r.host.logs.filter((l) => l.startsWith("pull")).join(" | "));
  assert.match(storms[0], /decision=refused reason=merge_storm file=[0-9a-f]{32} count=6 window_ms=60000/);
  assert.equal(
    r.host.notices.filter((notice) => notice.includes("stopped merging")).length, 1,
    "the user is told once, not once per version",
  );
  // And the breaker never drops content: both sides are still kept.
  assert.equal(results[5], "conflict_copy");
  assert.equal(r.host.text(NOTE), "the line this device wrote\n");
});

/**
 * The other half of the same rule. When the merge comes out as the INCOMING
 * version's own bytes, that version already carries this device's edit: what
 * looked like a fork is a fast-forward onto it, and posting a third version
 * saying the same thing is what the loop was made of.
 */
test("a merge that comes out as the other device's bytes is adopted, not posted", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");

  const r = await rig();
  const NOTE = "Notes/Ahead.md";
  r.host.seed(NOTE, "one\ntwo\n", 1000);
  const first = await pushFile(r.context, NOTE);
  // A second version of the SAME bytes, so this device's head is not an
  // ancestor of theirs and the graph reports a fork.
  const ours = await pushFile(r.context, NOTE, true);
  assert.notEqual(ours.versionId, first.versionId);

  const theirs = await r.server.publish({
    fileId: first.fileId,
    path: NOTE,
    bytes: new TextEncoder().encode("one\ntwo\nthree\n"),
    mtime: 4000,
    parents: [first.versionId],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  const before = r.server.journal.length;

  assert.equal(await applyChange(r.context, theirs), "applied");
  assert.equal(r.server.journal.length, before, "a version was posted for content that already existed");
  assert.equal(r.host.text(NOTE), "one\ntwo\nthree\n");
  assert.equal(r.state.fileByPath(NOTE).versionId, theirs.version_id, "the record did not advance onto it");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=applied reason=incoming_holds_merge")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});
