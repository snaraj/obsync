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
import { createHash } from "node:crypto";
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
  // Text merges (#339); a NUL byte keeps every round a fork with no merge,
  // so each resolution is counted and its content kept, never combined.
  r.host.seed(NOTE, "the line this device wrote\0\n", 2000);
  await pushFile(r.context, NOTE);

  const results = [];
  for (let round = 1; round <= 6; round++) {
    const theirs = await r.server.publish({
      fileId: base.fileId,
      path: NOTE,
      bytes: enc(`the line the other device wrote, round ${round}\0\n`),
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
  const told = r.host.notices.filter((notice) => notice.includes("stopped combining edits"));
  assert.equal(told.length, 1, "the user is told once, not once per version");
  // What was seen, and no cause this device cannot see: every device here is
  // current, and a notice that blamed an out-of-date one sent S89 looking for
  // one (issue #179).
  assert.match(told[0], /combined more than 5 times in a minute without changing here\./);
  assert.doesNotMatch(told[0], /up to date/);
  // And the breaker never drops content. Tripped, it merges nothing more, and
  // the pair is still settled by the rule every device shares (issue #135):
  // one version is the note, the other a copy, the fork closed.
  assert.ok(["skipped", "applied"].includes(results[5]), results.join(","));
  assert.ok(!r.host.logs.slice(r.host.logs.indexOf(storms[0])).some((line) => line.includes("decision=merged")));
  const kept = [...r.host.files.keys()].map((path) => r.host.text(path));
  for (const text of ["the line this device wrote\0\n", ...[1, 2, 3, 4, 5, 6].map((round) => `the line the other device wrote, round ${round}\0\n`)]) {
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
 * Unless this device's own history reaches past that version's (#339). A key
 * typed and deleted here before the other device's version arrived makes the
 * merge come out as the incoming bytes, while the version holding the typed
 * key is in no history of theirs. Adopted, the record forgot the deletion, and
 * a later version of theirs that had merged the typed key fast-forwarded it
 * back into the note (live desktop run, 2026-10-08). The merge is posted, so
 * that later version meets the deletion and the key stays deleted.
 */
for (const editor of [false, true]) test(`a key typed and deleted here stays deleted when the other device later merges the version that held it (#339, ${editor ? "saved editor" : "ordinary merge"})`, async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");

  const r = await rig();
  const NOTE = "Notes/Typo.md";
  r.host.seed(NOTE, "0\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "0T\n", 2000);
  const typed = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "0\n", 3000);
  await pushFile(r.context, NOTE);
  if (editor) {
    r.host.inputAt.set(NOTE, r.host.clock);
    r.host.editorReady = async () => true;
  }
  const publish = (text, parents, mtime) => r.server.publish({ fileId: base.fileId, path: NOTE,
    bytes: new TextEncoder().encode(text), mtime, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const theirs = await publish("0y\n", [base.versionId], 4000);
  await applyChange(r.context, theirs);
  assert.equal(r.host.text(NOTE), "0y\n");
  assert.ok(r.host.logs.some((line) => /^pull decision=not_adopted reason=own_history file=[0-9a-f]+ seq=\d+$/.test(line)), r.host.logs.join(" | "));
  // The other device merged the version holding the typed key, then typed on.
  const merged = await publish("0Ty\n", [typed.versionId, theirs.version_id].sort(), 5000);
  await applyChange(r.context, await publish("0Tyz\n", [merged.version_id], 6000));
  assert.equal(r.host.text(NOTE), "0yz\n", r.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
  assert.deepEqual([...r.host.files.keys()], [NOTE]);
});

/**
 * A CRISS-CROSS WHOSE SECOND ANCESTOR LEFT THE LISTING (#339, Android
 * emulator, 2026-10-08). Two merges of one pair share two newest ancestors,
 * and so do the two merges below them; the server lists only its newest
 * versions. Merged over the one ancestor it listed, a base older than two
 * keys both heads held wrote those keys twice, and the merge over that base
 * took both copies out: two typed keys lost on every device. The ancestry is
 * now completed before the bases are chosen.
 */
test("two typed keys both heads hold survive a criss-cross whose second ancestor is no longer listed (#339)", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile, sidDigest } = require("../build/sync/push.js");
  const { encryptChunk } = require("../build/crypto.js");

  const r = await rig();
  const NOTE = "Notes/Criss.md";
  const x = (...ranges) => ranges.flatMap(([a, b]) => [...Array(b - a + 1)].map((_, i) => String.fromCodePoint(0x4e00 + a + i))).join("");
  const y = (...ranges) => ranges.flatMap(([a, b]) => [...Array(b - a + 1)].map((_, i) => String.fromCodePoint(0xac00 + a + i))).join("");
  const doc = (line) => `# Both\nfixed\n0${line}\n`;
  r.host.seed(NOTE, doc(x([0, 5], [8, 9]) + y([0, 5], [8, 11])), 1000);
  const root = await pushFile(r.context, NOTE);
  let at = 2000;
  const publish = async (line, parents) => (await r.server.publish({ fileId: root.fileId, path: NOTE,
    bytes: new TextEncoder().encode(doc(line)), mtime: at += 1000, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey })).version_id;
  // The phone types three keys, the third a typo; the desktop types three of its own.
  const m1 = await publish(x([0, 5], [8, 9]) + y([0, 5], [8, 14]), [root.versionId]);
  let m2 = await publish(x([0, 5], [8, 10]) + y([0, 5], [8, 11]), [root.versionId]);
  for (const k of [11, 12]) m2 = await publish(x([0, 5], [8, k]) + y([0, 5], [8, 11]), [m2]);
  // The desktop merges the two; the phone deletes its typo, types on, and merges the same two.
  const ca2 = await publish(x([0, 5], [8, 12]) + y([0, 5], [8, 14]), [m1, m2].sort());
  let phone = await publish(x([0, 5], [8, 9]) + y([0, 5], [8, 13]), [m1]);
  for (const k of [16, 17]) phone = await publish(x([0, 5], [8, 9]) + y([0, 5], [8, 13], [16, k]), [phone]);
  const ca1 = await publish(x([0, 5], [8, 12]) + y([0, 5], [8, 13], [16, 17]), [phone, m2].sort());
  // Each merges those two merges and types on.
  const p1 = await publish(x([0, 5], [8, 13], [16, 21]) + y([0, 5], [8, 13], [16, 17]), [ca1, ca2].sort());
  let p2 = await publish(x([0, 5], [8, 12]) + y([0, 5], [8, 13], [16, 18]), [ca1, ca2].sort());
  for (const k of [19, 20]) p2 = await publish(x([0, 5], [8, 12]) + y([0, 5], [8, 13], [16, k]), [p2]);
  // This device stands on the desktop's head, and the server lists ten versions and every head.
  const held = doc(x([0, 5], [8, 13], [16, 21]) + y([0, 5], [8, 13], [16, 17]));
  r.host.seed(NOTE, held, at += 1000);
  const { sid } = await encryptChunk(r.keys.domainKey, new TextEncoder().encode(held));
  r.state.setFile(NOTE, { fileId: root.fileId, versionId: p1, mtime: at, size: new TextEncoder().encode(held).length, sha256: await sidDigest([sid]) });
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (...args) => {
    const file = await getFile(...args);
    return { ...file, versions: file.versions.filter((version, i) => i < 10 || file.heads.includes(version.version_id)) };
  };
  assert.ok(!(await getFile(root.fileId)).versions.slice(0, 10).some((version) => version.version_id === m1), "the second ancestor is still listed");
  const incoming = r.server.journal.find((entry) => entry.version_id === p2);
  await applyChange(r.context, incoming);
  const story = r.host.logs.filter((line) => line.startsWith("pull")).join(" | ");
  assert.equal(r.host.text(NOTE), doc(x([0, 5], [8, 13], [16, 21]) + y([0, 5], [8, 13], [16, 20])), story);
  // The base of the two merges below was itself found from both of theirs, the unlisted one included.
  assert.ok(r.host.logs.some((line) => /^pull decision=merge_base reason=criss_cross level=2 ok=true /.test(line)), story);
});

/**
 * And a deletion made here and not pushed yet is published before anything is
 * adopted (#339). The note here lost a key the version this device published
 * still holds; the incoming version, older than that key, comes out as the
 * merge. Adopted, the note matched its record, so the deletion was never sent,
 * and the published version brought the key back for good once the other
 * device merged it.
 */
test("a key deleted here and not pushed yet stays deleted when the other device later merges the version that held it (#339)", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");

  const r = await rig();
  const NOTE = "Notes/Typo.md";
  r.host.seed(NOTE, "0\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "0T\n", 2000);
  const typed = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "0\n", 3000);
  const publish = (text, parents, mtime) => r.server.publish({ fileId: base.fileId, path: NOTE,
    bytes: new TextEncoder().encode(text), mtime, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const theirs = await publish("0y\n", [base.versionId], 4000);
  await applyChange(r.context, theirs);
  await pushFile(r.context, NOTE);
  const merged = await publish("0Ty\n", [typed.versionId, theirs.version_id].sort(), 5000);
  await applyChange(r.context, await publish("0Tyz\n", [merged.version_id], 6000));
  assert.equal(r.host.text(NOTE), "0yz\n", r.host.logs.filter((line) => /^(pull|push)/.test(line)).join(" | "));
  assert.deepEqual([...r.host.files.keys()], [NOTE]);
});

/**
 * The same where two heads hold one text (`converged`): this device's head
 * stands when the other's would forget a key typed and deleted here. That rule
 * otherwise takes the smaller id, and ids are random, so the rig is built again
 * until the other's sorts first; a third head keeps the pair from closing.
 */
test("of two heads holding one text, the one remembering a key typed and deleted here stands (#339)", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");
  const NOTE = "Notes/Typo.md";

  for (let attempt = 0; ; attempt++) {
    assert.ok(attempt < 40, "the other device's id never sorted first");
    const r = await rig();
    r.host.seed(NOTE, "0\n", 1000);
    const base = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "0T\n", 2000);
    const typed = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "0\n", 3000);
    const local = await pushFile(r.context, NOTE);
    const publish = (text, parents, mtime) => r.server.publish({ fileId: base.fileId, path: NOTE,
      bytes: new TextEncoder().encode(text), mtime, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
    const theirs = await publish("0\n", [base.versionId], 4000);
    if (theirs.version_id > local.versionId) continue;
    await publish("1\n", [base.versionId], 4500);
    await applyChange(r.context, theirs);
    assert.equal(r.state.fileByPath(NOTE).versionId, local.versionId, "the record left the head that remembers the deletion");
    const merged = await publish("0T\n", [typed.versionId, theirs.version_id].sort(), 5000);
    await applyChange(r.context, await publish("0Tz\n", [merged.version_id], 6000));
    assert.equal(r.host.text(NOTE), "0z\n", r.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
    return;
  }
});

/**
 * Nor is a note that holds the other head's text only because of a deletion
 * made here and not pushed yet (#339): the version this device published still
 * holds the key. Standing on the other head, the deletion went out as an edit
 * of THAT head, and the published version brought the key back once merged.
 * Two heads are closed by a merge carrying the deletion; a third head here
 * keeps them open, as a third device typing does.
 */
test("a key deleted here and not pushed yet is no agreement with a head holding the same text (#339)", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");
  const NOTE = "Notes/Typo.md";

  for (let attempt = 0; ; attempt++) {
    assert.ok(attempt < 40, "the other device's id never sorted first");
    const r = await rig();
    r.host.seed(NOTE, "0\n", 1000);
    const base = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "0T\n", 2000);
    const typed = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "0\n", 3000);
    const publish = (text, parents, mtime) => r.server.publish({ fileId: base.fileId, path: NOTE,
      bytes: new TextEncoder().encode(text), mtime, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
    const theirs = await publish("0\n", [base.versionId], 4000);
    if (theirs.version_id > typed.versionId) continue;
    await publish("1\n", [base.versionId], 4500);
    await applyChange(r.context, theirs);
    assert.ok(r.host.logs.some((line) => line.startsWith("pull decision=deferred reason=unpublished_edit stage=identical_bytes ")), r.host.logs.join(" | "));
    await pushFile(r.context, NOTE);
    const merged = await publish("0T\n", [typed.versionId, theirs.version_id].sort(), 5000);
    await applyChange(r.context, await publish("0Tz\n", [merged.version_id], 6000));
    assert.equal(r.host.text(NOTE), "0z\n", r.host.logs.filter((line) => /^(pull|push)/.test(line)).join(" | "));
    return;
  }
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
  const notices = () => r.host.notices.filter((notice) => notice.includes("stopped combining edits"));

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

    // Keep the ordering fixed so a random manifest nonce cannot change the
    // guard this case exercises. Either holder may close a compared pair.
    twins.sort((left, right) => (left.version_id < right.version_id ? -1 : 1));
    const [ours, theirs] = twins;
    const record = r.state.fileByPath(NOTE);
    r.state.setFile(NOTE, { ...record, versionId: ours.version_id });

    const file = r.server.files.get(base.fileId);
    if (shape === "a third divergent head") file.heads = [ours.version_id, theirs.version_id, third.version_id];
    if (shape === "our version already retired") file.heads = [theirs.version_id, third.version_id];
    if (shape === "their version already retired") {
      file.heads = [ours.version_id, third.version_id];
      // A complete current-head view now skips this obsolete feed entry
      // before reconciliation (history-catchup.test.mjs). Keep exercising
      // the closing guard through its conservative incomplete-view path:
      // an unreadable third head must never be retired without comparison.
      const getFile = r.transport.getFile.bind(r.transport);
      r.transport.getFile = async id => {
        const view = await getFile(id);
        return { ...view, versions: view.versions.filter(version => version.version_id !== third.version_id) };
      };
    }
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
 * Either holder must close exactly the two heads it compared, even when the
 * other holder is offline. If both race, the server keeps one closing frame.
 */
for (const holder of ["smaller", "larger", "both"]) {
  test(`the equal-byte shortcut closes exactly two compared heads with ${holder} holders online`, async () => {
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
    const [ours, theirs] = holder === "larger" ? [...twins].reverse() : twins;
    r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: ours.version_id });
    r.server.files.get(base.fileId).heads = [ours.version_id, theirs.version_id];

    const before = r.server.journal.length;
    if (holder === "both") {
      const other = await rig();
      other.host.seed(NOTE, SHARED, 1000);
      other.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: theirs.version_id });
      other.context.transport = r.transport;
      const post = r.transport.postVersion.bind(r.transport);
      let posts = 0;
      let release;
      const joined = new Promise(resolve => { release = resolve; });
      // Both compare the original fork before either receipt can arrive.
      // The timeout releases a broken single-publisher implementation so its
      // missing second post becomes an assertion, not a cancelled test.
      const timeout = setTimeout(release, 500);
      r.transport.postVersion = async (...args) => {
        if (++posts === 2) release();
        await joined;
        return post(...args);
      };
      try {
        assert.deepEqual(await Promise.all([
          applyChange(r.context, theirs), applyChange(other.context, ours),
        ]), ["skipped", "skipped"]);
      } finally { clearTimeout(timeout); }
      assert.equal(posts, 2, "one holder waited for the other device to close the fork");
      assert.equal(r.server.deduplicated.length, 1, "concurrent closures were not deduplicated");
      assert.equal(r.state.fileByPath(NOTE).versionId, other.state.fileByPath(NOTE).versionId);
    } else {
      assert.equal(await applyChange(r.context, theirs), "skipped");
    }
    assert.equal(r.server.journal.length, before + 1, "one fork must cost one closing frame");
    assert.ok(
      r.host.logs.some((line) => line.includes("decision=resolved reason=identical_heads")),
      r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
    );
    assert.equal(r.server.files.get(base.fileId).heads.length, 1, "the fork was left open");
  });
}

/*
 * THE MERGE'S NAME (issue #151). A merge and a closing version carry a path
 * too, and posting the merging device's own path renamed the note back on the
 * device that had moved it: S03 ended with the renamed note under its old
 * name on both devices. The name is merged three ways against the same
 * ancestor the text is.
 */
const NAMED = "Notes/p1.md";
const MOVED = "Notes/p1 renamed.md";

/** A note at `from`, one version of this device's own on it, and one of the other's. */
async function renamedFork({ ours, theirs, from = NAMED, mine = BASE, other = BASE }) {
  const { rig, published } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");
  const r = await rig();
  r.host.seed(from, BASE, 1000);
  const base = await pushFile(r.context, from);
  if (ours !== from) {
    // This device moved the note, as the rename handler records it.
    r.host.files.set(ours, r.host.files.get(from));
    r.host.files.delete(from);
    r.state.setFile(ours, { ...r.state.fileByPath(from), mtime: -1, sha256: "" });
    r.state.forgetPath(from);
  }
  r.host.seed(ours, mine, 2000);
  const own = await pushFile(r.context, ours, true);
  const frame = await r.server.publish({
    fileId: base.fileId, path: theirs, bytes: new TextEncoder().encode(other), mtime: 3000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const newest = async () => (await published(r.server, base.fileId, r.keys.manifestKey)).at(-1);
  return { r, base, own, frame, newest, apply: () => applyChange(r.context, frame) };
}

test("a merge carries the name the other device moved the note to, and the note moves here (#151)", async () => {
  const { r, base, newest, apply } = await renamedFork({ ours: NAMED, theirs: MOVED, mine: DESKTOP });

  assert.equal(await apply(), "merged");

  const merged = await newest();
  assert.equal(merged.path, MOVED, "the merge renamed the note back");
  assert.equal(merged.sha256, digestOf(DESKTOP));
  assert.equal(r.host.text(MOVED), DESKTOP, "the note is not under the name its merge carries");
  assert.equal(r.host.text(NAMED), null, "the note stayed under its old name too");
  assert.equal(r.state.pathByFileId(base.fileId), MOVED);
  assert.equal(r.state.fileByPath(MOVED).name, undefined, "a note at its own name waits for it");
  assert.deepEqual(r.server.files.get(base.fileId).heads.length, 1);
  // Named where the merge put it, by its title (`notices.ts`).
  assert.deepEqual(r.host.said.filter((notice) => notice.kind === "combined").map((notice) => notice.paths), [[MOVED]], r.host.notices.join(" | "));
  assert.ok(!r.host.notices.some((notice) => notice.includes("renamed differently")), "one move is no disagreement");
});

test("a merge whose name is taken here still carries it, and the note waits beside it (#151)", async () => {
  const { r, base, newest, apply } = await renamedFork({ ours: NAMED, theirs: MOVED, mine: DESKTOP });
  r.host.seed(MOVED, "an unrelated note already wearing that name\n", 500);

  assert.equal(await apply(), "merged");

  assert.equal((await newest()).path, MOVED, "the merge carried the name it could not take here");
  assert.equal(r.host.text(MOVED), "an unrelated note already wearing that name\n", "the other note was replaced");
  assert.equal(r.host.text(NAMED), DESKTOP);
  assert.equal(r.state.fileByPath(NAMED).name, MOVED, "the note does not remember the name it waits for");
  assert.equal(r.state.fileByPath(NAMED).fileId, base.fileId);
});

test("a merge that comes out as the other device's bytes, under a name taken here, waits beside it (#151)", async () => {
  const { r, base, frame, apply } = await renamedFork({ ours: NAMED, theirs: MOVED, other: DESKTOP });
  r.host.seed(MOVED, "an unrelated note already wearing that name\n", 500);

  assert.equal(await apply(), "applied");

  assert.equal(r.host.text(NAMED), DESKTOP);
  assert.equal(r.state.fileByPath(NAMED).versionId, frame.version_id);
  assert.equal(r.state.fileByPath(NAMED).name, MOVED, "the note will publish its old name back at its next edit");
  assert.equal(r.state.fileByPath(NAMED).fileId, base.fileId);
});

test("a note whose last write the vault has not reported yet is not moved by the merge (#151)", async () => {
  const { r, base, newest, apply } = await renamedFork({ ours: NAMED, theirs: MOVED });
  // A write of this device's own at that name, not reported back yet: a move
  // now would let that report describe whatever takes the name next (#149).
  r.context.written.add(`${NAMED}:2000:${BASE.length}`);

  assert.equal(await apply(), "skipped");

  assert.equal((await newest()).path, MOVED, "the closing version still carries the settled name");
  assert.equal(r.host.text(NAMED), BASE, "the note moved before the vault reported its write");
  assert.equal(r.state.fileByPath(NAMED).name, MOVED);
  assert.equal(r.state.pathByFileId(base.fileId), NAMED);
});

test("identical heads that differ only by a rename close the fork under the moved name (#151)", async () => {
  const { r, base, own, frame, newest, apply } = await renamedFork({ ours: NAMED, theirs: MOVED });

  assert.equal(await apply(), "skipped");

  const closing = await newest();
  assert.equal(closing.path, MOVED, "the closing version renamed the note back");
  assert.deepEqual(r.server.files.get(base.fileId).versions[0].parents, [own.versionId, frame.version_id].sort());
  assert.equal(r.server.files.get(base.fileId).heads.length, 1, "the fork was left open");
  assert.equal(r.host.text(MOVED), BASE);
  assert.equal(r.host.text(NAMED), null);
  assert.equal(r.state.pathByFileId(base.fileId), MOVED);
  assert.deepEqual(r.host.trashed, [], "a rename trashed the note");
});

for (const [ours, theirs] of [["Jobs/p1.md", "Work/p1.md"], ["Work/p1.md", "Jobs/p1.md"]]) {
  test(`two renames of one note settle on the name that sorts first, from either side (ours ${ours}, #151 #174)`, async () => {
    const { r, base, newest, apply } = await renamedFork({ ours, theirs, from: "Beta/p1.md" });

    assert.equal(await apply(), "skipped");

    assert.equal((await newest()).path, "Jobs/p1.md", "the devices can settle on different names");
    assert.equal(r.host.text("Jobs/p1.md"), BASE);
    assert.equal(r.host.text("Work/p1.md"), null);
    assert.equal(r.state.pathByFileId(base.fileId), "Jobs/p1.md");
    const told = r.host.notices.filter((notice) => notice.includes("renamed differently"));
    assert.deepEqual(told, [`obsync: "Beta" was renamed differently here ("${ours.split("/")[0]}") and on iPhone ` +
      `("${theirs.split("/")[0]}"); every device now uses "Jobs", and nothing was copied or deleted. To use the other ` +
      "name, rename it again."]);
    assert.ok(r.host.logs.some((line) => line.startsWith(`pull decision=renamed_twice kept=${ours.startsWith("Jobs") ? "ours" : "theirs"} base=known`)),
      r.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
  });
}

test("a rename this device has not published yet goes out before the pair is settled (#151)", async () => {
  const { r, base, frame, apply } = await renamedFork({ ours: NAMED, theirs: MOVED });
  // Moved again here, after this device's head was posted, and not pushed.
  r.host.files.set("Notes/Mine.md", r.host.files.get(NAMED));
  r.host.files.delete(NAMED);
  r.state.setFile("Notes/Mine.md", { ...r.state.fileByPath(NAMED), mtime: -1, sha256: "" });
  r.state.forgetPath(NAMED);
  const before = r.server.journal.length;

  assert.equal(await apply(), "skipped");

  assert.equal(r.server.journal.length, before, "the pair was closed under a name the other device never saw");
  assert.equal(r.host.text("Notes/Mine.md"), BASE, "the note was moved");
  assert.equal(r.state.fileByPath("Notes/Mine.md").sha256, "", "the rename can no longer be pushed");
  assert.ok(r.host.logs.includes(`pull decision=deferred reason=unpublished_rename file=${base.fileId} seq=${frame.seq}`),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
});

/*
 * AND A BOUND ON CLOSING. A device older than the rule closes a pair under its
 * own name, which is no twin of this device's closing, so each side closes
 * the other's closing for ever -- and every one of those versions is new
 * progress by its author, which the merge breaker does not count. Closings of
 * one file are counted on their own.
 */
test("one file's identical heads are closed at most five times in a minute from here (#151)", async () => {
  const { rig } = await import("./fake.mjs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { applyChange } = require("../build/sync/pull.js");
  const { pushFile } = require("../build/sync/push.js");
  const r = await rig();
  const SHARED = "the bytes every head carries\n";
  r.host.seed(NAMED, SHARED, 1000);
  const { fileId } = await pushFile(r.context, NAMED);
  const round = async (mtime) => {
    const head = r.state.fileByPath(NAMED).versionId;
    await pushFile(r.context, NAMED, true);
    const theirs = await r.server.publish({
      fileId, path: NAMED, bytes: new TextEncoder().encode(SHARED), mtime, parents: [head],
      domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
    return await settle(theirs);
  };
  const settle = async (theirs) => {
    const before = r.server.journal.length;
    assert.equal(await applyChange(r.context, theirs), "skipped");
    return r.server.journal.length - before;
  };

  const closed = [];
  for (let n = 1; n <= 6; n++) closed.push(await round(4000 + n));
  assert.deepEqual(closed, [1, 1, 1, 1, 1, 0], r.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
  assert.ok(r.host.logs.some((line) => line.startsWith(`pull decision=refused reason=closing_storm file=${fileId} count=6 window_ms=60000`)));
  assert.equal(r.host.text(NAMED), SHARED, "nothing was lost");
  const told = r.host.notices.filter((notice) => notice.startsWith("obsync: stopped renaming"));
  assert.deepEqual(told, ['obsync: stopped renaming "p1": iPhone keeps giving it a different name. Every device has the same ' +
    "text and nothing was deleted; update obsync on every device, and the name settles at the next edit."]);

  // The window passes, and the next pair is closed again.
  r.host.clock += 60_001;
  const open = [...r.server.files.get(fileId).heads];
  assert.equal(open.length, 2, "round six left no pair open");
  await pushFile(r.context, NAMED, true, open);
  const theirs = await r.server.publish({
    fileId, path: NAMED, bytes: new TextEncoder().encode(SHARED), mtime: 6000, parents: open,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await settle(theirs), 1);
  assert.equal(r.server.files.get(fileId).heads.length, 1);
});

/** The digest a single-chunk manifest carries. */
function digestOf(text) {
  return createHash("sha256").update(text).digest("hex");
}
