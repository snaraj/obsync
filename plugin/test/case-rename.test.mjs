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
import { STEP_MS, pair, published, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { SCAN_MS } = require("../build/sync/engine.js");
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
  // THE DIRECTORY ENTRY IS WHAT CHANGED, and the folder record is what
  // changed it (#124, review round 1 finding 1): a per-file rename cannot,
  // because `rename(2)` resolves the directory components of its destination.
  // The moves that follow then name a path this device already holds, with
  // content it already holds, and fetch nothing.
  assert.ok(
    a.host.logs.some((line) => line.includes("path_class=folder") && line.includes("decision=case_renamed")),
    a.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
  );
  assert.ok(pull.some((line) => line.includes("decision=held")), pull.join(" | "));
  assert.equal(
    pull.some((line) => line.includes("decision=case_move_refused")),
    false,
    `the desktop refused the move its own folder record had already made: ${pull.join(" | ")}`,
  );
  // Renaming this device's own entry is not a move this device publishes.
  assert.ok(
    a.host.logs.some((line) => line.includes("decision=echo_suppressed") && line.includes("event=rename")),
    a.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
});

// --- the livelock: two devices that BOTH fold case ----------------------

/**
 * THE DEFECT THIS SUITE MISSED, and the reason the fake now models
 * `rename(2)` (review round 1, finding 1).
 *
 * Two devices that fold case, one case-only folder rename. The receiving
 * device applied it as a per-file move, which on a folding volume renames the
 * entry the LAST component names and resolves the directories above it: the
 * directory kept its old spelling while the records took the new one, the
 * scan's `(mtime, size)` pairing read that difference as a rename and
 * published it BACK, and the device that made the rename applied that as
 * another no-op and published again -- one new version per note every
 * `SCAN_MS`, on both devices, with every note re-downloaded each time, until
 * the account quota answered 507. Two full scan cycles with a frozen journal
 * is the assertion that answers it; `realfs-case.test.mjs` is the same
 * assertion over a real case-folding filesystem.
 */
test("a case-only folder rename between two devices that both fold case settles, and neither publishes it back", async (t) => {
  const { server, timers, a, b, ids, keys } = await seeded(t, {
    caseSensitiveA: false, caseSensitiveB: false, isMobileB: false,
  });

  b.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () =>
    a.host.files.has("team docs/One.md") && a.host.files.has("team docs/Two.md") &&
    settled(a, "team docs/One.md") && settled(a, "team docs/Two.md"));
  // Drain everything the rename started before the journal is frozen, so the
  // assertion below is about the SCAN and not about work still in flight.
  await timers.run(SCAN_MS);
  const quiet = server.journal.length;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(server.journal.length, quiet, `a device published the rename back: ${story(server, a, b)}`);
  for (const device of [a, b]) {
    assert.deepEqual(
      [...device.host.files.keys()].sort(),
      ["team docs/One.md", "team docs/Two.md"],
      `a device kept the old spelling on disk: ${story(server, a, b)}`,
    );
    assert.deepEqual(
      Object.keys(device.state.data.files).sort(),
      ["team docs/One.md", "team docs/Two.md"],
      `a device's records disagree with its own vault: ${story(server, a, b)}`,
    );
  }
  for (const id of ids) {
    assert.equal(
      (await published(server, id, keys.manifestKey)).length,
      2,
      `a note grew more than its push and its move: ${story(server, a, b)}`,
    );
  }
  // AND BOTH DEVICES HOLD THE SAME VERSION. The folder record is published
  // BEFORE the moves under it (`main.ts`) for exactly this: a move that
  // reaches a device whose directory is still spelled the old way is refused,
  // and a device left recording the version BEFORE the move would fork the
  // note the next time the user touched it.
  for (const path of ["team docs/One.md", "team docs/Two.md"]) {
    assert.equal(
      a.state.fileByPath(path).versionId,
      b.state.fileByPath(path).versionId,
      `the two devices hold different versions of one note: ${story(server, a, b)}`,
    );
  }
  for (const device of [a, b]) {
    assert.equal(
      device.host.logs.filter((line) => line.startsWith("scan decision=queued")).every((line) => line.includes("moved=0")),
      true,
      device.host.logs.filter((line) => line.startsWith("scan")).join(" | "),
    );
  }
});

/**
 * A device older than 1.1.0 publishes no folder record at all, so its
 * case-only folder rename reaches this one as the per-file moves alone. A
 * note's version does not get to re-case a directory -- the directory holds
 * notes this version says nothing about -- so this device changes NOTHING,
 * says so in one decision and one notice, and above all records no spelling
 * its own vault does not show, which is what would bounce.
 */
test("a case-only folder move with no folder record behind it is refused, and never published back", async (t) => {
  const { server, timers, a, keys } = await seeded(t, {
    caseSensitiveA: false, caseSensitiveB: false, isMobileB: false,
  });
  await timers.run(SCAN_MS);
  const record = a.state.fileByPath("Team docs/One.md");

  await server.publish({
    fileId: record.fileId,
    path: "team docs/One.md",
    bytes: enc(BODY),
    mtime: 1000,
    parents: [record.versionId],
    domainKey: keys.domainKey,
    manifestKey: keys.manifestKey,
  });
  await timers.run(STEP_MS, () =>
    a.host.logs.some((line) => line.includes("decision=case_move_refused")));
  const quiet = server.journal.length;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(server.journal.length, quiet, `the refusal was published back as a rename: ${story(server, a, a)}`);
  assert.deepEqual(
    [...a.host.files.keys()].sort(),
    ["Team docs/One.md", "Team docs/Two.md"],
    `a note's move re-cased the directory: ${story(server, a, a)}`,
  );
  assert.deepEqual(
    Object.keys(a.state.data.files).sort(),
    ["Team docs/One.md", "Team docs/Two.md"],
    `a record took a spelling this vault does not show: ${story(server, a, a)}`,
  );
  assert.equal(a.state.fileByPath("Team docs/One.md").versionId, record.versionId, "a refused version was recorded anyway");
  assert.equal(
    a.host.notices.filter((message) => message.includes("capitalisation")).length,
    1,
    `the user was told ${a.host.notices.length} times, or not at all: ${a.host.notices.join(" | ")}`,
  );
});

/** The peer's folder record, exactly as `pushFolder` builds one. */
const folderRecord = async (r, path, { deleted = false, parents = [] } = {}) =>
  r.server.publishManifest({
    fileId: await c.folderFileId(r.keys.manifestKey, path),
    manifest: {
      v: 2, kind: "directory", path, domain: "0123456789abcdef0123456789abcdef",
      size: 0, chunks: [], sha256: "", deleted,
    },
    sids: [],
    parents,
    deviceId: FOREIGN,
    manifestKey: r.keys.manifestKey,
    bytes: 0,
  });

/**
 * A RENAME THAT CHANGED NO BYTE DOWNLOADS NO BYTE (review round 1, finding
 * 3). The changelog's promise for a rename is that nothing is downloaded and
 * nothing is trashed; a case-only rename went on to `materialise` anyway,
 * because the rename shortcut requires the paths to differ and this one had
 * just made them the same. For a 900 MB note on a phone that was 900 MB of
 * the user's data for a name.
 */
test("a case-only rename downloads nothing: the note is already here, under this very name", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const local = r.state.fileByPath("Team docs/One.md");
  let fetched = 0;
  const getChunk = r.transport.getChunk.bind(r.transport);
  r.transport.getChunk = async (...args) => {
    fetched++;
    return getChunk(...args);
  };

  const change = await r.server.publish({
    fileId: local.fileId,
    path: "Team docs/ONE.md",
    bytes: enc(BODY),
    mtime: 1000,
    parents: [local.versionId],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, change), "applied");

  assert.equal(fetched, 0, `a rename that changed no byte fetched ${fetched} chunks`);
  assert.deepEqual([...r.host.files.keys()], ["Team docs/ONE.md"], "the entry was not renamed in place");
  assert.equal(r.host.text("Team docs/ONE.md"), BODY);
  assert.deepEqual(r.host.trashed, [], "a rename trashed something");
  assert.equal(r.state.fileByPath("Team docs/ONE.md").versionId, change.version_id);
  assert.equal(r.state.fileByPath("Team docs/One.md"), undefined, "the old record was left behind");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=held")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

/**
 * NEVER ASSUMED, ALWAYS ASKED. A host that answered `moved` for a rename it
 * did not make -- a filesystem that folds more than case, an adapter that
 * lies, a future host -- would otherwise have this device write records its
 * own listing contradicts, which is the livelock. The vault is asked what it
 * shows, and nothing is recorded until it says the new spelling.
 */
test("a host that reports a folder rename it did not make records nothing", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  r.host.moveFolder = async () => "moved";

  const change = await folderRecord(r, "team docs");
  assert.equal(await applyChange(r.context, change), "refused");

  assert.ok(
    r.host.logs.some((line) => line.includes("decision=case_refused") && line.includes("reason=not_respelled")),
    r.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
  );
  assert.deepEqual([...r.host.files.keys()], ["Team docs/One.md"]);
  assert.deepEqual(Object.keys(r.state.data.files), ["Team docs/One.md"], "a record took the spelling anyway");
  assert.equal(r.state.folderByPath("team docs"), undefined, "a folder record was written for a rename that did not happen");
  // The echo marks were taken back, or the user's own next rename of that
  // folder would be suppressed as this device's own.
  assert.equal(r.context.moved.size, 0, "a rename that did not happen left an echo marker armed");
  assert.equal(r.context.createdFolders.size, 0);
  assert.equal(r.context.trashed.size, 0);
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

  // A RENAME RENAMES ITS LAST COMPONENT, and that is the whole of what
  // `rename(2)` does: the directory components of the destination are
  // RESOLVED -- a folding volume finds the directory by either spelling and
  // leaves the name it keeps alone -- so a move that differs from its source
  // in a directory component alone succeeds and changes nothing. A fake that
  // rewrote its listing to the whole requested path modelled a filesystem
  // that does not exist, and hid a livelock the real one produced (#124,
  // review round 1 finding 1). Proved against a real case-insensitive APFS
  // directory in `realfs-case.test.mjs`.
  assert.equal(await folding.host.move("Team docs/One.md", "team docs/One.md"), "moved");
  assert.deepEqual(
    [...folding.host.files.keys()],
    ["Team docs/One.md"],
    "the folding host re-cased a DIRECTORY component from a file's rename",
  );
  // The last component, on the same host, really is renamed.
  assert.equal(await folding.host.move("team docs/One.md", "Team docs/ONE.md"), "moved");
  assert.deepEqual([...folding.host.files.keys()], ["Team docs/ONE.md"]);
  // And the host that keeps them apart moves the file into a second
  // directory, because there the two names are two entries.
  assert.equal(await apart.host.move("Team docs/One.md", "team docs/One.md"), "moved");
  assert.deepEqual([...apart.host.files.keys()], ["team docs/One.md"]);
  // The directory entry itself is the folder record's to rename, and only
  // that operation changes what the folding host shows.
  await folding.host.moveFolder("Team docs", "team docs");
  assert.deepEqual([...folding.host.files.keys()], ["team docs/ONE.md"]);
  assert.equal(await folding.host.spelling("TEAM DOCS/one.md"), "team docs/ONE.md");
  assert.equal(await apart.host.spelling("TEAM DOCS/one.md"), null);
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

// --- what the rename PUBLISHES, and in what order ------------------------

/**
 * A SELECTED folder, renamed by capitalisation alone, on the device that
 * makes the rename (review round 2, finding 1).
 *
 * Obsidian reports a folder rename ONCE, and this plugin fans that one event
 * out into two halves: the folder records (`folderRenamed`) and the files
 * under them (`renamedFolder`). BOTH move the selection with the folder, and
 * each judges a path by the selection in force on its own side of the move.
 * So whichever half runs first is the one that moves the selection, and a
 * half that read the selection for itself afterwards judged every OLD name
 * against the selection the rename leaves behind -- out of scope, so `renamed`
 * took its "not a rename at all" branch and published each note as a NEW file
 * with a new id. The old ids were never retired, the records stayed at the old
 * spelling, and `survey` re-offered the same rename every `SCAN_MS` for good.
 * That is #124's own symptom, reintroduced for anyone who syncs a selected
 * folder. The selection is captured once, in the handler, before either half
 * runs (`main.ts`).
 */
test("a case-only rename of a SELECTED folder publishes moves, not new notes", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  b.state.data.syncFolders = ["Team docs"];
  a.host.write("Team docs/One.md", BODY, 1000);
  a.host.write("Team docs/Two.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md") && settled(b, "Team docs/Two.md"));
  const ids = ["Team docs/One.md", "Team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId);

  b.host.renameFolder("Team docs", "team docs");
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(
    (await server.noteFiles(keys.manifestKey)).length,
    2,
    `a note was published as a NEW file: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    ["team docs/One.md", "team docs/Two.md"].map((path) => b.state.fileByPath(path)?.fileId),
    ids,
    `the sender minted new ids: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    Object.keys(b.state.data.files).sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `records left at the old spelling: ${story(server, a, b)}`,
  );
  assert.deepEqual(b.state.data.syncFolders, ["team docs"], "the selection did not follow the folder");
  // The line the defect printed every SCAN_MS: each note's OLD name judged
  // against the selection the rename left behind. (The folder record for the
  // selected folder itself is out of scope on both sides by the scope rule --
  // `inSyncScope` never places a folder inside itself -- and says so here as
  // it did before.)
  assert.equal(
    b.host.logs.filter((line) =>
      line.includes("reason=outside_sync_scope") &&
      (line.includes("event=rename_from") || line.includes("_state"))).length,
    0,
    b.host.logs.filter((line) => line.includes("outside_sync_scope")).slice(0, 4).join(" | "),
  );
});

/**
 * THE ORDER IS A WIRE ORDER, NOT AN ENQUEUE ORDER (review round 2, finding 2).
 *
 * `drainQueue` takes `concurrency` paths per batch and runs them under
 * `Promise.all`, so the journal's order is COMPLETION order: the folder record
 * and the first moves were posted together and whichever answered first landed
 * first. When a move won, the receiver refused it (`case_move_refused
 * reason=folder_case`), told the user to update a device that was already up
 * to date, and re-cased with the PRE-move version ids -- after which a
 * deletion on one side was answered on the other with `delete_vs_edit` and a
 * notice that was not true. The folder record is now a barrier: nothing queued
 * behind it is posted until the server has acknowledged it.
 *
 * THE TRANSPORT IS THE HOSTILE INPUT. The folder record's own post is held up
 * until the moves have posted -- which, with the barrier, they cannot -- so
 * the hold is bounded by a generous number of event-loop turns and then
 * released. At `368a6a8`'s order the two moves complete within a handful of
 * those turns and the folder record lands last; here they are not sent at all
 * until it has landed, so the bound is what ends the hold and the order on the
 * wire is the one the protocol states.
 */
test("the folder record reaches the server before the moves under it, whatever the transport does", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  a.host.write("Team docs/One.md", BODY, 1000);
  a.host.write("Team docs/Two.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md") && settled(b, "Team docs/Two.md"));
  const ids = ["Team docs/One.md", "Team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId);
  const folderId = await c.folderFileId(keys.manifestKey, "team docs");

  const turns = async (count) => {
    for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const post = b.transport.postVersion.bind(b.transport);
  const posted = new Set();
  let release;
  const movesPosted = new Promise((resolve) => { release = resolve; });
  b.transport.postVersion = async (fileId, body) => {
    // The folder record's post loses the race, or waits for the bound.
    if (fileId === folderId) await Promise.race([movesPosted, turns(300)]);
    const out = await post(fileId, body);
    posted.add(fileId);
    if (ids.every((id) => posted.has(id))) release();
    return out;
  };

  // Only the frames this rename adds: the notes' own first versions are
  // already in the journal, and the question is where the MOVES landed.
  const before = server.journal.length;
  const at = (id) => server.journal.findIndex(
    (frame, index) => index >= before && frame.file_id === id && !frame.deleted);
  b.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () =>
    a.host.logs.some((line) => line.includes("decision=case_renamed")) &&
    [folderId, ...ids].every((id) => at(id) !== -1));

  for (const id of ids) {
    assert.ok(
      at(folderId) < at(id),
      `a move was journaled before the folder record: ${story(server, a, b)}`,
    );
  }
  // The receiver has now read every frame this rename produced: what it made
  // of them is the rest of this test, and a feed still catching up is not.
  await timers.run(STEP_MS, () => a.state.data.lastSeq >= server.journal[server.journal.length - 1].seq);
  assert.equal(
    a.host.logs.some((line) => line.includes("case_move_refused")),
    false,
    a.host.notices.join(" | ") || story(server, a, b),
  );
  for (const path of ["team docs/One.md", "team docs/Two.md"]) {
    assert.equal(
      a.state.fileByPath(path)?.versionId,
      b.state.fileByPath(path)?.versionId,
      `the receiver holds the version BEFORE the move: ${story(server, a, b)}`,
    );
  }
});

/**
 * "UPDATE THAT DEVICE AND THE TWO AGREE AGAIN" IS ABOUT THE NOTES, NOT ONLY
 * ABOUT THE SPELLING (review round 2, findings 2 and 4).
 *
 * Every version that named the other spelling while the two disagreed was
 * refused and the feed moved past it. Nothing re-delivered it: a note edited
 * on the older device during the disagreement stayed at its pre-disagreement
 * text here until something touched it again, while the changelog and the
 * troubleshooting guide promised convergence. The folder record that re-cases
 * the directory now asks the server for the head of every record it carried.
 */
test("a folder record re-cased here brings down the versions refused while the spellings disagreed", async (t) => {
  const r = await rig({ caseSensitive: false });
  const EDITED = "# A note\nedited on the other device while the two disagreed\n";
  r.host.seed("Team docs/One.md", BODY, 1000);
  r.host.seed("Team docs/Two.md", OTHER, 1000);
  await pushFile(r.context, "Team docs/One.md");
  await pushFile(r.context, "Team docs/Two.md");
  const one = r.state.fileByPath("Team docs/One.md");
  const two = r.state.fileByPath("Team docs/Two.md");

  // A device that publishes no folder record: the move, and then an edit made
  // there while the two devices spelled the folder differently.
  const moved = await r.server.publish({
    fileId: one.fileId, path: "team docs/One.md", bytes: enc(BODY), mtime: 1000,
    parents: [one.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, moved), "refused");
  const edited = await r.server.publish({
    fileId: one.fileId, path: "team docs/One.md", bytes: enc(EDITED), mtime: 2000,
    parents: [moved.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, edited), "refused");
  assert.equal(r.host.text("Team docs/One.md"), BODY, "a refused version was written anyway");

  // The other device is updated, and publishes the folder record.
  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "applied");

  assert.equal(r.host.text("team docs/One.md"), EDITED, `the meantime edit never arrived: ${r.host.logs.filter((line) => line.startsWith("folder")).join(" | ")}`);
  assert.equal(r.state.fileByPath("team docs/One.md").versionId, edited.version_id, "the record still names the version the disagreement froze");
  assert.equal(r.state.fileByPath("team docs/Two.md").versionId, two.versionId, "a note nothing happened to was given another version");
  assert.equal(r.host.text("team docs/Two.md"), OTHER, "a note nothing happened to was rewritten");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=heads_refetched") && line.includes("records=2") && line.includes("applied=1")),
    r.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
  );
  assert.deepEqual(r.host.trashed, [], "converging trashed something");
});

/**
 * A RECORD NAMING A FOLDER THIS VAULT SPELLS ANOTHER WAY is not a move to
 * publish (review round 2, finding 3). A version before this one materialised
 * a new note at the PEER's spelling of the folder, and the scan's
 * `(mtime, size)` pairing then read that difference as a rename and published
 * it -- a rename no device made, which a folding device answers with a
 * conflict copy, so both devices gain a duplicate. The record follows the
 * vault instead, nothing is published, and the note keeps its id.
 */
test("a record naming a folder this vault spells another way follows the vault, and nothing is published", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", { caseSensitiveA: false });
  a.host.write("Team docs/One.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, "Team docs/One.md") && b.host.text("Team docs/One.md") === BODY);
  // The note the peer published under its own spelling, written where the
  // vault shows the folder and recorded where the manifest named it.
  a.host.seed("Team docs/New.md", OTHER, 1500);
  a.state.setFile("team docs/New.md", {
    fileId: GHOST, versionId: "ab".repeat(32), mtime: 1500, size: OTHER.length, sha256: "",
  });
  await a.state.save();
  const quiet = server.journal.length;

  a.engine.stop();
  await a.engine.start();
  await timers.run(STEP_MS);
  await timers.run(SCAN_MS);

  assert.equal(a.state.fileByPath("team docs/New.md"), undefined, `the record kept a spelling the vault does not show: ${story(server, a, b)}`);
  assert.equal(a.state.fileByPath("Team docs/New.md")?.fileId, GHOST, `the note lost its identity: ${story(server, a, b)}`);
  assert.equal(server.journal.length, quiet, `the difference was published: ${story(server, a, b)}`);
  assert.equal(a.host.text("Team docs/New.md"), OTHER, "the note was rewritten");
  assert.ok(
    a.host.logs.some((line) => line.includes("decision=not_paired") && line.includes("reason=folder_case")),
    a.host.logs.filter((line) => line.startsWith("reconcile") || line.startsWith("scan")).join(" | "),
  );
});

/**
 * THE CONTROL FOR THE RULE ABOVE. On a host that keeps the two spellings
 * apart, `Team docs` and `team docs` are TWO folders and a note moved from one
 * to the other really moved: the pairing is a move to publish, and declining
 * it would strand the note on this device alone. The host answers `null` for
 * the name its own listing dropped, which is the fact that tells the two
 * hosts apart (`caseRenamed`, and `recordsOnly` beside it).
 */
test("a note moved between two folders that differ only in case is a move, where the two are two folders", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", { caseSensitiveA: true, isMobileB: false, caseSensitiveB: true });
  a.host.write("Team docs/One.md", BODY, 1000);
  a.host.write("team docs/Other.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, "Team docs/One.md") && settled(a, "team docs/Other.md"));
  const one = a.state.fileByPath("Team docs/One.md");

  // Moved with a tool Obsidian never reported: the scan is the only thing
  // that will see it, and BOTH folders already hold a note this device syncs.
  const file = a.host.files.get("Team docs/One.md");
  a.host.files.delete("Team docs/One.md");
  a.host.files.set("team docs/One.md", file);
  a.engine.stop();
  await a.engine.start();
  await timers.run(STEP_MS, () => b.host.text("team docs/One.md") === BODY);

  assert.equal(a.state.fileByPath("team docs/One.md")?.fileId, one.fileId, `the move was declined: ${story(server, a, b)}`);
  assert.equal(a.state.fileByPath("Team docs/One.md"), undefined, `the record stayed in the old folder: ${story(server, a, b)}`);
  assert.equal(b.state.pathByFileId(one.fileId), "team docs/One.md", `the other device never heard of the move: ${story(server, a, b)}`);
  assert.deepEqual(await tombstones(server, keys.manifestKey), [], "the move was published as a deletion");
});
