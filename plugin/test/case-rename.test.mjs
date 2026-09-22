/**
 * A folder renamed by CASE ONLY, across two host models (issue #124).
 *
 * THE HOST MODEL IS THE SUBJECT. `Team docs` and `team docs` are ONE
 * directory entry on a case-insensitive volume (the owner's desktop) and TWO
 * on a case-sensitive one (the phone). Every step of a move -- the lookup of
 * the local file, the create-only writer's "destination exists", the removal
 * of the source, the vault listing the startup scan reads -- answers
 * differently on the two, and a rename that is one operation on one of them
 * must not become a delete and a create on the other. `FakeHost` carries that
 * one difference (`caseSensitive`), and `pair` hands each device its own.
 *
 * WHAT MUST BE TRUE ON BOTH. A case-only rename is a MOVE: one file id, one
 * directory entry, the old spelling gone. No device may end a case-only
 * rename holding two directories for one recorded folder, and none may lose
 * the note to a removal of the entry it has just written into.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { caseOnly } = require("../build/vaultPath.js");

const enc = (text) => new TextEncoder().encode(text);
const FOREIGN = "ffffffffffffffffffffffffffffffff";

const BODY = "# A note\nthat must survive a rename of its folder's case\n";
const OTHER = "second note\n";

const c = require("../build/crypto.js");

/**
 * Every NOTE tombstone the server holds: what a renamed file must never
 * produce. Folder records are tombstoned in their own right from 1.1.0
 * (#104) -- a folder record IS its path, so renaming a folder retires the
 * old record and publishes the new one, and that is how the other device
 * ends with ONE folder rather than two. Only the manifest says which kind a
 * frame is, so it is decrypted rather than guessed at from the frame.
 */
const tombstones = async (server, manifestKey) => {
  const out = [];
  for (const frame of server.journal) {
    if (!frame.deleted) continue;
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(
      manifestKey, frame.file_id, binder, c.unhex(frame.manifest_nonce), c.unbase64(frame.manifest_ct),
    ));
    if (manifest.v !== 2) out.push(frame);
  }
  return out;
};

const story = (server, a, b) =>
  [`journal=${server.journal.map((frame) => `${frame.seq}${frame.deleted ? ":tombstone" : ""}`).join(",")}`,
    `desktop_files=${JSON.stringify([...a.host.files.keys()])}`,
    `phone_files=${JSON.stringify([...b.host.files.keys()])}`,
    `desktop_records=${JSON.stringify(Object.keys(a.state.data.files))}`,
    `phone_records=${JSON.stringify(Object.keys(b.state.data.files))}`].join(" ");

/**
 * The rename the plugin never heard about: made in Finder, or while Obsidian
 * was closed, or dropped by the host's own index. The vault holds the new
 * spelling and no event was delivered, so the startup scan is the only thing
 * that will ever see it.
 */
const quietRenameFolder = (host, from, to) => {
  const moved = [...host.files.keys()]
    .filter((path) => path.startsWith(`${from}/`))
    .map((path) => [to + path.slice(from.length), host.files.get(path), path]);
  for (const [, , path] of moved) host.files.delete(path);
  for (const [path, file] of moved) host.files.set(path, file);
};

/** Two notes in one folder, on both devices, with their file ids. */
async function seeded(t, options, folder = "Team docs") {
  const devices = await pair(t, "immediate", options);
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

test("a case-only folder rename the desktop publishes leaves the phone one folder", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t, { caseSensitiveA: false });

  a.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () =>
    b.host.text("team docs/One.md") === BODY && b.host.text("team docs/Two.md") === OTHER &&
    settled(b, "team docs/One.md") && settled(b, "team docs/Two.md"));
  await timers.run(STEP_MS);

  assert.deepEqual(await tombstones(server, keys.manifestKey), [], `a case-only rename published a tombstone: ${story(server, a, b)}`);
  assert.deepEqual(
    [...b.host.files.keys()].sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the phone kept both spellings: ${story(server, a, b)}`,
  );
  assert.equal(b.host.text("team docs/One.md"), BODY);
  assert.deepEqual(
    ["team docs/One.md", "team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId),
    ids,
    `the phone copied the notes instead of moving them: ${story(server, a, b)}`,
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
});

test("a case-only folder rename the desktop only DISCOVERS leaves the phone one folder", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t, { caseSensitiveA: false });

  quietRenameFolder(a.host, "Team docs", "team docs");
  await a.engine.syncNow();
  await timers.run(STEP_MS, () =>
    b.host.text("team docs/One.md") === BODY && b.host.text("team docs/Two.md") === OTHER);
  await timers.run(STEP_MS);

  assert.deepEqual(await tombstones(server, keys.manifestKey), [], `a discovered case-only rename published a tombstone: ${story(server, a, b)}`);
  assert.deepEqual(
    [...b.host.files.keys()].sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the phone kept both spellings: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    ["team docs/One.md", "team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId),
    ids,
    `the rename was published as two new files: ${story(server, a, b)}`,
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
});

test("a case-only rename on the phone reaches the case-insensitive desktop as one entry", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t, { caseSensitiveA: false });

  b.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () => settled(a, "team docs/One.md") && settled(a, "team docs/Two.md"));
  await timers.run(STEP_MS);

  assert.deepEqual(await tombstones(server, keys.manifestKey), [], `the incoming case-only rename published a tombstone: ${story(server, a, b)}`);
  assert.equal(a.host.text("team docs/One.md"), BODY, `the desktop lost the note: ${story(server, a, b)}`);
  assert.equal(a.host.text("team docs/Two.md"), OTHER, `the desktop lost the note: ${story(server, a, b)}`);
  assert.deepEqual(
    [...a.host.files.keys()].sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the desktop entry did not change case in place: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    ["team docs/One.md", "team docs/Two.md"].map((path) => a.state.fileByPath(path).fileId),
    ids,
    `the desktop did not keep the file ids: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    a.host.notices.filter((message) => message.includes("conflict")),
    [],
    `a case-only rename raised a conflict: ${a.host.notices.join(" | ")}`,
  );
  // The same-name rule settles two DIFFERENT notes wearing one name. One
  // note wearing one name in two spellings is not that, and a device that
  // asks the rule anyway settles the move at the old spelling for good.
  const pull = a.host.logs.filter((line) => line.startsWith("pull"));
  assert.equal(
    pull.some((line) => line.includes("same_name_tiebreak") || line.includes("applied_beside")),
    false,
    `the same-name rule fired for a case-only move: ${pull.join(" | ")}`,
  );
  assert.ok(pull.some((line) => line.includes("decision=case_move_moved")), pull.join(" | "));
  // Renaming this device's own entry is not a move this device publishes.
  assert.ok(
    a.host.logs.some((line) => line.includes("decision=echo_suppressed") && line.includes("event=rename")),
    a.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
});

// --- the host models themselves -----------------------------------------

test("the two host models answer a second spelling differently, or these tests prove nothing", async (t) => {
  const folding = await rig({ caseSensitive: false });
  const apart = await rig({ caseSensitive: true });
  for (const r of [folding, apart]) r.host.seed("Team docs/One.md", "one\n", 1000);

  assert.notEqual(await folding.host.stat("team docs/One.md"), null, "a folding host answers for both spellings");
  assert.equal(await apart.host.stat("team docs/One.md"), null, "a host that keeps them apart answers for neither");
  assert.equal(await folding.host.read("team docs/One.md").then((b) => b.length), 4);
  await assert.rejects(() => apart.host.read("team docs/One.md"));

  // One entry, renamed in place, against two entries where one is created.
  assert.equal(await folding.host.move("Team docs/One.md", "team docs/One.md"), "moved");
  assert.deepEqual([...folding.host.files.keys()], ["team docs/One.md"]);
  assert.equal(await apart.host.move("Team docs/One.md", "team docs/One.md"), "moved");
  assert.deepEqual([...apart.host.files.keys()], ["team docs/One.md"]);
});

test("a rename refuses a destination a DIFFERENT file already wears", async (t) => {
  const r = await rig({ caseSensitive: true });
  r.host.seed("Team docs/One.md", "one\n", 1000);
  r.host.seed("team docs/One.md", "another note entirely\n", 1000);

  assert.equal(await r.host.move("Team docs/One.md", "team docs/One.md"), "occupied");
  assert.equal(r.host.text("Team docs/One.md"), "one\n", "the source was not moved");
  assert.equal(r.host.text("team docs/One.md"), "another note entirely\n", "the destination was not replaced");
  assert.equal(await r.host.move("Team docs/Gone.md", "team docs/Gone.md"), "missing");
});

// --- the case rule ------------------------------------------------------

test("only a difference of case is a difference of case", async () => {
  assert.equal(caseOnly("Team docs/One.md", "team docs/One.md"), true);
  assert.equal(caseOnly("Team docs/One.md", "Team docs/One.md"), false, "the same path is not a move");
  assert.equal(caseOnly("Team docs/One.md", "team docs/Two.md"), false, "the name changed too");
  assert.equal(caseOnly("Team docs/One.md", "Archive/One.md"), false);
  // NFC and NFD spell one name with a different number of code points, and a
  // host that folds case does not promise to fold those together.
  assert.equal(caseOnly("Notes/Cafe\u0301.md", "notes/Caf\u00e9.md"), false, "NFD is not a case change");
  assert.equal(caseOnly("Notes/Caf\u00e9.md", "notes/caf\u00e9.md"), true, "and case still is, inside one form");
  // A dotted capital I lowercases to TWO code points, so the two names below
  // fold to the same string at different lengths. The length gate is what
  // keeps that out: one of them is a name this device cannot claim is the
  // other's entry, in either direction.
  assert.equal(caseOnly("Notes/\u0130stanbul.md", "notes/istanbul.md"), false);
  assert.equal(caseOnly("Notes/\u0130.md", "Notes/i\u0307.md"), false, "a fold that changes length is not a case change");
});

// --- hostile: two notes whose names differ only in case -----------------

test("a device that keeps two spellings apart merges and deletes neither", async (t) => {
  const r = await rig({ caseSensitive: true });
  const ours = "Team docs/One.md";
  const theirs = "team docs/One.md";
  r.host.seed(ours, "ours\n", 1000);
  r.host.seed(theirs, "a different note that only looks alike\n", 1000);
  await pushFile(r.context, ours);
  await pushFile(r.context, theirs);
  const mine = r.state.fileByPath(ours).fileId;

  // Another device moves ITS copy of our first note onto the second's name.
  const change = await r.server.publish({
    fileId: FOREIGN.slice(0, 31) + "1",
    path: theirs,
    bytes: enc("the mover\n"),
    mtime: 5000,
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  const result = await applyChange(r.context, change);

  assert.equal(r.host.text(ours), "ours\n", `the note at the other spelling was taken: ${result}`);
  assert.equal(
    r.host.text(theirs),
    "a different note that only looks alike\n",
    `a different note was replaced by an incoming version: ${result}`,
  );
  assert.equal(r.state.fileByPath(ours).fileId, mine, "and it kept its own identity");
  assert.equal(
    r.host.logs.some((line) => line.includes("decision=case_move_moved")),
    false,
    `a collision was applied as a rename: ${r.host.logs.filter((l) => l.startsWith("pull")).join(" | ")}`,
  );
});

test("a case-only move is refused, not forced, when another file wears the destination", async (t) => {
  const r = await rig({ caseSensitive: true });
  const ours = "Team docs/One.md";
  const theirs = "team docs/One.md";
  r.host.seed(ours, "ours\n", 1000);
  r.host.seed(theirs, "a different note that only looks alike\n", 1000);
  await pushFile(r.context, ours);
  await pushFile(r.context, theirs);
  const moving = r.state.fileByPath(ours).fileId;

  // OUR OWN file id, moved by another device onto the name our other note
  // already wears: the one shape where the case rule meets a real collision.
  const change = await r.server.publish({
    fileId: moving,
    path: theirs,
    bytes: enc("moved by the other device\n"),
    mtime: 5000,
    parents: [r.state.fileByPath(ours).versionId],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  await applyChange(r.context, change);

  assert.equal(
    r.host.text(theirs),
    "a different note that only looks alike\n",
    "the note that was already there was replaced",
  );
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=case_move_occupied")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  assert.equal(r.state.pathByFileId(moving), ours, "the record followed a rename that never happened");
  assert.equal(r.context.moved.size, 0, "a rename that did not happen left an echo marker armed");
});

test("a deletion beside a note whose name differs only in case is still a deletion", async (t) => {
  const { server, timers, a, b, keys } = await seeded(t, {});
  const going = a.state.fileByPath("Team docs/One.md").fileId;

  // The user deletes one note in Finder and types a DIFFERENT one whose name
  // differs from it only in case -- on a device that keeps the two apart, so
  // nothing here is one entry wearing two spellings.
  a.host.files.delete("Team docs/One.md");
  a.host.seed("team docs/One.md", "a different note entirely\n", 6000);
  await a.engine.syncNow();
  await timers.run(STEP_MS, () => b.host.text("team docs/One.md") === "a different note entirely\n");
  await timers.run(STEP_MS);

  assert.equal((await tombstones(server, keys.manifestKey)).length, 1, `the deletion was not published: ${story(server, a, b)}`);
  assert.equal((await tombstones(server, keys.manifestKey))[0].file_id, going, "a tombstone was published for the wrong file");
  assert.equal(b.host.text("Team docs/One.md"), null, "the other device kept a deleted note");
  assert.notEqual(
    a.state.fileByPath("team docs/One.md").fileId,
    going,
    "a new note was adopted under the deleted note's identity",
  );
});

test("a host that lists two spellings and answers for a third renames nothing", async (t) => {
  const { server, timers, a, b, keys } = await seeded(t, {});
  const going = a.state.fileByPath("Team docs/One.md").fileId;
  const listing = await a.host.list();

  // A host is a trust boundary: this one reports a vault that no filesystem
  // can have -- both spellings listed, and an answer for the third the
  // records hold. Ambiguity is not evidence, so nothing is renamed.
  a.host.files.delete("Team docs/One.md");
  a.host.seed("team docs/One.md", "one\n", 1000);
  a.host.seed("TEAM DOCS/One.md", "one\n", 1000);
  a.host.list = async () => [
    ...listing.filter((file) => file.path === "Team docs/Two.md"),
    { path: "team docs/One.md", mtime: 1000, size: 4 },
    { path: "TEAM DOCS/One.md", mtime: 1000, size: 4 },
  ];
  a.host.stat = async (path) => (path === "Team docs/One.md" ? { path, mtime: 1000, size: 4 } : null);
  await a.engine.syncNow();
  await timers.run(STEP_MS);

  assert.equal(
    a.host.logs.some((line) => line.includes("decision=case_renamed")),
    false,
    `an ambiguous listing was taken for a rename: ${story(server, a, b)}`,
  );
  assert.equal(
    a.state.pathByFileId(going),
    "Team docs/One.md",
    `the record moved on an ambiguous listing: ${story(server, a, b)}`,
  );
  for (const path of ["team docs/One.md", "TEAM DOCS/One.md"]) {
    assert.notEqual(a.state.fileByPath(path)?.fileId, going, `${path} was adopted under the vanished id`);
  }
});

// --- a rename that changes more than case -------------------------------

test("a rename that changes case AND text takes the ordinary move, on both host models", async (t) => {
  for (const caseSensitiveB of [true, false]) {
    await t.test(`subscriber caseSensitive=${caseSensitiveB}`, async (t2) => {
      const { timers, a, b } = await pair(t2, "immediate", { caseSensitiveA: false, caseSensitiveB });
      a.host.write("Team docs/One.md", BODY, 1000);
      await a.engine.start();
      await b.engine.start();
      await timers.run(STEP_MS, () => b.host.text("Team docs/One.md") === BODY && settled(b, "Team docs/One.md"));
      const id = a.state.fileByPath("Team docs/One.md").fileId;

      a.host.renameFolder("Team docs", "team archive");
      await timers.run(STEP_MS, () => b.host.text("team archive/One.md") === BODY && settled(b, "team archive/One.md"));
      await timers.run(STEP_MS);

      assert.deepEqual([...b.host.files.keys()], ["team archive/One.md"]);
      assert.equal(b.state.fileByPath("team archive/One.md").fileId, id);
      assert.equal(
        b.host.logs.some((line) => line.includes("decision=case_move")),
        false,
        "a move of a different name claimed the case path",
      );
    });
  }
});

// --- Unicode: a name written another way is not a name in another case ---

test("a folder renamed from NFD to NFC moves as an ordinary rename, not a case change", async (t) => {
  const nfd = "Cafe\u0301 notes";
  const nfc = "Caf\u00e9 notes";
  const { server, timers, a, b, ids, keys } = await seeded(t, { caseSensitiveA: false }, nfd);

  a.host.renameFolder(nfd, nfc);
  await timers.run(STEP_MS, () =>
    b.host.text(`${nfc}/One.md`) === BODY && settled(b, `${nfc}/One.md`));
  await timers.run(STEP_MS);

  assert.deepEqual(await tombstones(server, keys.manifestKey), [], `a normalisation rename published a tombstone: ${story(server, a, b)}`);
  assert.deepEqual(
    [...b.host.files.keys()].sort(),
    [`${nfc}/One.md`, `${nfc}/Two.md`],
    `the phone kept both spellings: ${story(server, a, b)}`,
  );
  assert.deepEqual([`${nfc}/One.md`, `${nfc}/Two.md`].map((path) => b.state.fileByPath(path).fileId), ids);
  assert.equal(
    [...a.host.logs, ...b.host.logs].some((line) => line.includes("decision=case_move")),
    false,
    "two normalisations of one name were claimed to be one entry",
  );
});

// --- recovery for a device already holding both spellings ---------------

/** The state an older version left behind: a record for an id nothing keeps. */
const GHOST = "a1".repeat(16);

test("a tombstone for the old spelling takes the live note on a folding device", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.host.seed("team docs/One.md", BODY, 1000);
  await pushFile(r.context, "team docs/One.md");
  const live = r.state.fileByPath("team docs/One.md");
  // What an older version left on the device that folds case: the id it
  // abandoned, recorded at the spelling that IS the live note's entry.
  r.state.setFile("Team docs/One.md", { ...live, fileId: GHOST });

  const tombstone = await r.server.publishTombstone({
    fileId: GHOST,
    path: "Team docs/One.md",
    manifestKey: r.keys.manifestKey,
    // THE ANCESTRY THIS HAZARD ACTUALLY HAS, stated rather than left empty.
    // The abandoned record IS the record for the abandoned id, so a deletion
    // of the stale folder descends from the version that record holds, and
    // the delete-versus-edit fork guard 1.1.0 adds never fires. Left empty,
    // the tombstone would be a fork and the guard would refuse it -- a
    // kinder answer this device cannot count on, and one that would let this
    // test pass while the documented hazard stayed unproved. The companion
    // test below pins that refusal on the shape that does fork.
    parents: [live.versionId],
  });
  assert.equal(await applyChange(r.context, tombstone), "deleted");

  // THIS is why the stale folder is not deleted before every device has
  // upgraded and scanned: the tombstone is obeyed, and on this device the
  // old spelling is the live note's own entry. A rename leaves size and
  // modification time exactly as they were, so the stale record describes
  // the live bytes and `competing` finds nothing to keep.
  assert.equal(r.host.text("team docs/One.md"), null, "the live note survived a tombstone for its own entry");
});

test("a ghost tombstone that forks from the record is refused, and the note stays", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.host.seed("team docs/One.md", BODY, 1000);
  await pushFile(r.context, "team docs/One.md");
  const live = r.state.fileByPath("team docs/One.md");
  r.state.setFile("Team docs/One.md", { ...live, fileId: GHOST });

  // The other half of the residue: a deletion whose version graph does not
  // reach the version the stale record holds. That is one side of a fork,
  // and 1.1.0 keeps both sides of a fork (#106, `pull.ts` delete-versus-edit)
  // -- which on a folding host means keeping the live note. The guard is not
  // this lane's; the composition is what puts it under this shape.
  const tombstone = await r.server.publishTombstone({
    fileId: GHOST,
    path: "Team docs/One.md",
    manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, tombstone), "skipped");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=local_edit_kept reason=delete_vs_edit")),
    `the fork guard did not refuse the ghost tombstone: ${JSON.stringify(r.host.logs)}`,
  );
  assert.equal(r.host.text("team docs/One.md"), BODY, "a forked ghost tombstone took the live note");
});

test("the startup scan drops the ghost record, publishes nothing, and disarms that tombstone", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", { caseSensitiveA: false });
  a.host.write("team docs/One.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("team docs/One.md") === BODY && settled(a, "team docs/One.md"));
  const live = a.state.fileByPath("team docs/One.md");
  a.state.setFile("Team docs/One.md", { ...live, fileId: GHOST });
  await a.state.save();

  // What an upgrade does: the plugin is reloaded and scans.
  a.engine.stop();
  await a.engine.start();
  await timers.run(STEP_MS);

  assert.equal(a.state.fileByPath("Team docs/One.md"), undefined, "the ghost record is still armed");
  assert.equal(a.host.text("team docs/One.md"), BODY, "the scan removed the live note");
  assert.deepEqual(await tombstones(server, keys.manifestKey), [], `the scan published a tombstone: ${story(server, a, b)}`);
  assert.ok(
    a.host.logs.some((line) => line.includes("decision=case_ghost_forgotten")),
    a.host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );
  assert.ok(
    a.host.notices.some((message) => message.includes("capitalisation")),
    a.host.notices.join(" | "),
  );

  // And now the tombstone the stale folder's deletion publishes elsewhere
  // reaches a device that no longer maps the old spelling to anything.
  const tombstone = await server.publishTombstone({
    fileId: GHOST,
    path: "Team docs/One.md",
    manifestKey: keys.manifestKey,
  });
  await timers.run(STEP_MS, () => a.state.data.lastSeq >= tombstone.seq);
  assert.ok(a.state.data.lastSeq >= tombstone.seq, "the tombstone never reached this device");
  assert.equal(a.host.text("team docs/One.md"), BODY, "the live note was deleted after all");
});
