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
  // And the breaker never drops content. Tripped, it merges nothing more, and
  // the pair is still settled by the rule every device shares (issue #135):
  // one version is the note, the other a copy, the fork closed.
  assert.ok(["skipped", "applied"].includes(results[5]), results.join(","));
  assert.ok(!r.host.logs.slice(r.host.logs.indexOf(storms[0])).some((line) => line.includes("decision=merged")));
  const kept = [...r.host.files.keys()].map((path) => r.host.text(path));
  for (const text of ["the line this device wrote\n", ...[1, 2, 3, 4, 5, 6].map((round) => `the line the other device wrote, round ${round}\n`)]) {
    assert.ok(kept.includes(text), `${JSON.stringify(text)} is in no file: ${JSON.stringify(kept)}`);
  }
  assert.equal(r.server.files.get(base.fileId).heads.length, 1, "the fork was left open");
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

/**
 * The breaker is a WINDOW, and the notice is once. A log line that prints
 * `window_ms=60000` proves neither: it is a constant in a template string.
 * What proves them is driving past the limit twice inside one window, then
 * walking the clock past it and watching the count start again.
 */
test("the breaker speaks once per window and forgets when the window passes", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");

  const r = await rig();
  const NOTE = "Notes/Window.md";
  r.host.seed(NOTE, "the line both sides start from\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "the line this device wrote\n", 2000);
  await pushFile(r.context, NOTE);

  const fork = async (round) => {
    const theirs = await r.server.publish({
      fileId: base.fileId,
      path: NOTE,
      bytes: new TextEncoder().encode(`the other device, round ${round}\n`),
      mtime: 4000 + round,
      parents: [base.versionId],
      domainKey: r.keys.domainKey,
      manifestKey: r.keys.manifestKey,
    });
    return applyChange(r.context, theirs);
  };
  const storms = () => r.host.logs.filter((line) => line.includes("reason=merge_storm"));
  const notices = () => r.host.notices.filter((notice) => notice.includes("stopped merging"));

  // Seven inside one window: five are merged or kept, and rounds six and seven
  // are both over the limit. Two trips, ONE notice.
  for (let round = 1; round <= 7; round++) await fork(round);
  assert.equal(storms().length, 2, storms().join(" | "));
  assert.match(storms()[1], /count=7 window_ms=60000/);
  assert.equal(notices().length, 1, "the user was told once per version instead of once per storm");

  // The window passes. The next fork starts a fresh tally, so it is resolved
  // rather than refused: a breaker that never forgets is a breaker that stops
  // syncing a note for good.
  r.host.clock += 60_001;
  await fork(8);
  assert.equal(storms().length, 2, `the tally survived its own window: ${storms().join(" | ")}`);
  assert.equal(notices().length, 1);
});

/**
 * Closing a fork means naming heads as parents, and a head named as a parent
 * is a head retired. Retiring one whose bytes were never compared would throw
 * away someone's note, so the shortcut closes EXACTLY the two heads it
 * compared and nothing else. Three shapes say so.
 */
for (const shape of ["a third divergent head", "our version already retired", "their version already retired"]) {
  test(`the equal-byte shortcut publishes no closing version when ${shape}`, async () => {
    const { rig } = await import("./fake.mjs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { applyChange } = require("../build/sync/pull.js");
    const { pushFile } = require("../build/sync/push.js");

    const r = await rig();
    const NOTE = "Notes/Heads.md";
    const SHARED = "the bytes both heads carry\n";
    r.host.seed(NOTE, SHARED, 1000);
    const base = await pushFile(r.context, NOTE);

    // Two heads carrying the SAME bytes, and a third carrying different ones.
    const publish = (text, mtime) => r.server.publish({
      fileId: base.fileId, path: NOTE, bytes: new TextEncoder().encode(text),
      mtime, parents: [base.versionId],
      domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
    const twins = [await publish(SHARED, 4000), await publish(SHARED, 4001)];
    const third = await publish("a third device's own line\n", 5000);

    // Which of the twins this device holds is not left to chance: the closing
    // version is published by the holder of the SMALLER id, so this device
    // must hold it for the guard below to be the thing under test at all.
    twins.sort((left, right) => (left.version_id < right.version_id ? -1 : 1));
    const [ours, theirs] = twins;
    const record = r.state.fileByPath(NOTE);
    r.state.setFile(NOTE, { ...record, versionId: ours.version_id });

    const file = r.server.files.get(base.fileId);
    if (shape === "a third divergent head") file.heads = [ours.version_id, theirs.version_id, third.version_id];
    if (shape === "our version already retired") file.heads = [theirs.version_id, third.version_id];
    if (shape === "their version already retired") file.heads = [ours.version_id, third.version_id];
    const before = r.server.journal.length;

    assert.equal(await applyChange(r.context, theirs), "skipped");
    assert.ok(
      r.host.logs.some((line) => line.includes("decision=converged reason=identical_bytes")),
      "the records did not converge at all",
    );
    assert.equal(
      r.server.journal.length, before,
      "a closing version was published over a head whose bytes were never compared",
    );
    assert.ok(
      !r.host.logs.some((line) => line.includes("decision=resolved")),
      r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
    );
    // The third device's line is still a head nobody threw away.
    assert.ok(r.server.files.get(base.fileId).heads.includes(third.version_id));
  });
}

/**
 * The positive control for the same guard: exactly the two heads it compared,
 * both current, and this device holding the smaller id. That is the one shape
 * that may publish a closing version, and it must.
 */
test("the equal-byte shortcut does close a fork of exactly the two heads it compared", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");

  const r = await rig();
  const NOTE = "Notes/Heads.md";
  const SHARED = "the bytes both heads carry\n";
  r.host.seed(NOTE, SHARED, 1000);
  const base = await pushFile(r.context, NOTE);
  const publish = (mtime) => r.server.publish({
    fileId: base.fileId, path: NOTE, bytes: new TextEncoder().encode(SHARED), mtime,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const twins = [await publish(4000), await publish(4001)];
  twins.sort((left, right) => (left.version_id < right.version_id ? -1 : 1));
  const [ours, theirs] = twins;
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: ours.version_id });
  r.server.files.get(base.fileId).heads = [ours.version_id, theirs.version_id];

  assert.equal(await applyChange(r.context, theirs), "skipped");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=resolved reason=identical_heads")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  assert.equal(r.server.files.get(base.fileId).heads.length, 1, "the fork was left open");
});
