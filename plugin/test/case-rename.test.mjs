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
import { FakeTimers, STEP_MS, pair, published, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { SCAN_MS, SyncEngine } = require("../build/sync/engine.js");
const { caseOnly, caseOnlyLastComponent } = require("../build/vaultPath.js");
const { caseTwinRoot, inFolderCaseScope } = require("../build/syncScope.js");

const enc = (text) => new TextEncoder().encode(text);
const FOREIGN = "ffffffffffffffffffffffffffffffff";

const BODY = "# A note\nthat must survive a rename of its folder's case\n";
const OTHER = "second note\n";
/** The note in the folder a 1.0.x rename left behind on a case-sensitive device. */
const TWIN = "the twin folder's own note\n";
const EDITED = "# A note\nedited on the device that holds both spellings\n";
const EDITED_B = "second note\nedited on the device that folds them\n";

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

/**
 * The same rename, for a folder with NOTHING in it: no file moves, so the
 * folder's own two records are the whole of what the other device will ever
 * hear about it.
 */
const quietRenameEmptyFolder = (host, from, to) => {
  for (const folder of [...host.explicitFolders].filter((path) => path === from || path.startsWith(`${from}/`))) {
    host.explicitFolders.delete(folder);
    host.explicitFolders.add(to + folder.slice(from.length));
  }
};

/**
 * Wait on the CONDITION, not on a guess about how many event-loop turns some
 * other work takes: a count that is enough on an idle machine is not enough
 * when the suite runs forty files at once, and a test that fails under load
 * adds a phantom kill to every mutant in the matrix
 * (`plugin/test/mutants/run.sh`).
 */
const until = async (condition, what) => {
  for (let turn = 0; turn < 5000; turn++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(what);
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

  // The folder record can re-case both vaults before either note's move
  // reaches the server. Keep that window longer than one quiet drain, so
  // a path-only settlement predicate cannot silently pass on an idle host.
  const post = b.transport.postVersion.bind(b.transport);
  b.transport.postVersion = async (id, body) => {
    if (ids.includes(id)) await new Promise((resolve) => setTimeout(resolve, 400));
    return post(id, body);
  };
  b.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () =>
    a.host.files.has("team docs/One.md") && a.host.files.has("team docs/Two.md") &&
    ids.every((id, index) => {
      const frames = server.journal.filter((frame) => frame.file_id === id);
      const moved = frames.at(-1);
      const path = ["team docs/One.md", "team docs/Two.md"][index];
      return frames.length >= 2 && [a, b].every((device) =>
        device.state.fileByPath(path)?.versionId === moved.version_id &&
        device.state.data.lastSeq >= moved.seq);
    }));
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

  // AND A REMOVAL RESOLVES ITS NAME THE WAY THE FILESYSTEM DOES (review
  // round 3, finding 2). `trashFolder` is handed a path, and the walk that
  // resolves it finds the one directory entry whatever capitalisation was
  // asked for -- which is how a tombstone for `Team docs` took the folder a
  // re-case had just produced. A fake that compared names exactly answered
  // `removed` while leaving that folder standing, so a pair test passed
  // where the real host deleted the user's folder.
  for (const r of [folding, apart]) {
    r.host.files.clear();
    r.host.explicitFolders.clear();
    await r.host.createFolder("Team docs");
  }
  assert.equal(await folding.host.trashFolder("team docs"), true, "the folding host refused a name it answers for");
  assert.deepEqual([...folding.host.explicitFolders], [], "the folding host removed nothing at the folded name");
  assert.equal(await apart.host.trashFolder("team docs"), true, "a folder nothing holds is already gone");
  assert.deepEqual([...apart.host.explicitFolders], ["Team docs"], "a host that keeps them apart removed the other entry");
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
  // NOTHING ABOUT THIS RENAME IS OUT OF SCOPE ANY MORE, which is both halves
  // of it: each note's OLD name judged against the selection the rename left
  // behind (round 2, finding 1), and the folder record for the selected
  // folder ITSELF, which `inSyncScope` refused because it never places a
  // folder inside itself -- so the rename went out as moves with no record,
  // and every folding receiver refused them (round 3, finding 1).
  assert.deepEqual(
    b.host.logs.filter((line) => line.includes("reason=outside_sync_scope")),
    [],
    b.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
  assert.equal(
    b.state.data.folders["team docs"] === undefined,
    false,
    `the selected folder has no record of its own: ${story(server, a, b)}`,
  );
});

/**
 * THE RECEIVER, WHICH THE TEST ABOVE NEVER LOOKED AT (review round 3,
 * finding 1).
 *
 * The sender's half was right and the wire was still wrong: `inSyncScope`
 * never places a folder inside itself, so for a device whose selection IS
 * `Team docs` the folder was out of scope on BOTH sides of its own rename.
 * `folderDeleted` and `folderCreated` both returned at `tracked`, no
 * tombstone, no record and no barrier existed, and the moves went out alone
 * -- which is exactly the shape the receiver refuses, because only a folder
 * record may re-case a directory. A folding peer logged `case_move_refused`
 * twice, kept the notes at their pre-move versions, and told the user to
 * "update every device to this version" on a 1.1.0/1.1.0 pair; the selecting
 * device's later edits under its own folder were refused too.
 */
test("a case-only rename of a SELECTED folder reaches a folding receiver as one folder", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  b.state.data.syncFolders = ["Team docs"];
  a.host.write("Team docs/One.md", BODY, 1000);
  a.host.write("Team docs/Two.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md") && settled(b, "Team docs/Two.md"));

  b.host.renameFolder("Team docs", "team docs");
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(
    a.host.logs.filter((line) => line.includes("case_move_refused")).length,
    0,
    a.host.notices.join(" | ") || story(server, a, b),
  );
  assert.deepEqual(
    [...a.host.files.keys()].sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the receiver kept the old spelling: ${story(server, a, b)}`,
  );
  for (const path of ["team docs/One.md", "team docs/Two.md"]) {
    assert.equal(
      a.state.fileByPath(path)?.versionId,
      b.state.fileByPath(path)?.versionId,
      `the receiver holds the version BEFORE the move: ${story(server, a, b)}`,
    );
  }
  assert.ok(
    a.host.logs.some((line) => line.includes("path_class=folder") && line.includes("decision=case_renamed")),
    a.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);

  // AND THE EDITS THAT FOLLOW IT. The third refusal was the one that made
  // this a P2: with the folder refused, every later edit the selecting device
  // made under its own selection was refused on the other one too.
  b.host.write("team docs/One.md", "edited after the rename\n", 7000);
  await timers.run(STEP_MS, () => a.host.text("team docs/One.md") === "edited after the rename\n");
  assert.equal(
    a.host.logs.filter((line) => line.includes("case_move_refused")).length,
    0,
    a.host.notices.join(" | ") || story(server, a, b),
  );
});

/**
 * THE OTHER DIRECTION: the whole-vault device renames the folder that IS the
 * phone's selection, and the phone must follow it.
 *
 * A record naming `team docs` is admitted against a selection that spells it
 * `Team docs` only so far as the string goes; the VAULT decides the rest
 * (`syncScope.ts`, `inFolderCaseScope`). Here it folds case, so the two
 * spellings are one directory -- this device's own selected folder -- and the
 * re-case applies and takes the selection with it. Left behind, the selection
 * would name a folder this vault no longer shows and every file under it
 * would leave the scope in the same tick.
 */
test("a case-only rename of the folder a device SELECTS is applied there, and the selection follows", async (t) => {
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

  a.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () =>
    b.host.logs.some((line) => line.includes("decision=case_renamed")) &&
    settled(b, "team docs/One.md") && settled(b, "team docs/Two.md"));
  await timers.run(SCAN_MS);

  assert.deepEqual(b.state.data.syncFolders, ["team docs"], `the selection did not follow: ${story(server, a, b)}`);
  assert.deepEqual(
    [...b.host.files.keys()].sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the selecting device kept the old spelling: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    ["team docs/One.md", "team docs/Two.md"].map((path) => b.state.fileByPath(path)?.fileId),
    ids,
    `the notes lost their identity: ${story(server, a, b)}`,
  );
  // Followed by whichever half got there first, and idempotent by
  // construction: the vault reports the re-case to this plugin's own rename
  // handler, whose `followSelection` is the same one, and the pull path's
  // call then finds no selected folder left to move. A host that reports
  // nothing -- which is every host, for the per-file moves a folder re-case
  // fans out into -- leaves the pull path as the only one that can.
  assert.ok(
    b.host.logs.some((line) => line.includes("scope decision=followed_re") && line.includes("folders=1 selected=1")),
    b.host.logs.filter((line) => line.startsWith("scope")).join(" | "),
  );
  assert.equal(
    b.host.logs.some((line) => line.includes("reason=moved_out_of_scope")),
    false,
    `the selecting device dropped its own notes: ${b.host.logs.filter((line) => line.includes("scope")).join(" | ")}`,
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
});

/**
 * THE CONTROL, one level down: a SUBFOLDER of the selected folder, which was
 * never out of scope and must stay exactly as it was.
 */
test("a case-only rename of a subfolder of the selected folder still carries its record", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  b.state.data.syncFolders = ["Team docs"];
  a.host.write("Team docs/Sub/One.md", BODY, 1000);
  a.host.write("Team docs/Sub/Two.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/Sub/One.md") && settled(b, "Team docs/Sub/Two.md"));

  b.host.renameFolder("Team docs/Sub", "Team docs/sub");
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.deepEqual(b.state.data.syncFolders, ["Team docs"], "the selection moved for a folder inside it");
  assert.equal(
    a.host.logs.filter((line) => line.includes("case_move_refused")).length,
    0,
    a.host.notices.join(" | ") || story(server, a, b),
  );
  assert.deepEqual(
    [...a.host.files.keys()].sort(),
    ["Team docs/sub/One.md", "Team docs/sub/Two.md"],
    `the receiver kept the old spelling: ${story(server, a, b)}`,
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
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
 * AN EMPTY FOLDER RENAMED BY CASE WHILE OBSIDIAN WAS CLOSED (review round 3,
 * finding 2).
 *
 * The start-up pass published the record for the folder it now sees BEFORE
 * the tombstone for the record it no longer does -- two loops, the first
 * enqueue starting the drain -- so the wire order was the opposite of the
 * handler's. A folding receiver applied the record as a re-case and then took
 * the tombstone for the spelling it had just left: the removal's walk
 * resolves to the ONE directory entry the re-case produced, which is empty,
 * so it was deleted there; the receiver's own next pass tombstoned the record
 * it had just written, and the renaming device obeyed that. The folder was
 * gone on both devices, for renaming it in Finder.
 *
 * The pass now emits the tombstone first and the record behind it as a wire
 * barrier, which is exactly what the handler sends for a rename this device
 * was told about (`docs/protocol.md`).
 */
test("an EMPTY folder renamed by case while Obsidian was closed survives on both devices", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  a.host.makeFolder("Team docs");
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.state.data.folders["Team docs"] !== undefined);
  assert.ok(b.host.explicitFolders.has("Team docs"), "the empty folder never reached the other device");

  quietRenameEmptyFolder(a.host, "Team docs", "team docs");
  await a.engine.syncNow();
  await timers.run(STEP_MS, () => b.state.data.folders["team docs"] !== undefined);
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  // THE FOLDER IS STILL THERE, on both devices, spelled the new way.
  assert.deepEqual([...b.host.explicitFolders], ["team docs"], `the receiver deleted the folder: ${story(server, a, b)}`);
  assert.deepEqual([...a.host.explicitFolders], ["team docs"], `the renaming device lost it too: ${story(server, a, b)}`);
  assert.equal(b.state.data.folders["Team docs"], undefined, "the old record outlived the rename");
  assert.equal(a.state.data.folders["team docs"] === undefined, false, "the new record was never written");
  // IN THE HANDLER'S ORDER the receiver removes the empty folder it was told
  // to remove and then creates the one it was told about -- in that order,
  // which is why it ends with a folder at all. The order this repair
  // replaced had it re-case first and take the tombstone for the name it had
  // just left, against the one entry the re-case produced.
  assert.deepEqual(
    b.host.logs
      .filter((line) => line.startsWith("folder path_class=folder"))
      .map((line) => (/decision=([a-z_]+)/.exec(line) ?? [])[1]),
    ["created", "removed", "created"],
    b.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
  );

  // AND THE ORDER IT WENT IN, which is what makes the above true: the
  // tombstone for the old record, then the record for the new spelling.
  const oldId = await c.folderFileId(keys.manifestKey, "Team docs");
  const newId = await c.folderFileId(keys.manifestKey, "team docs");
  const tombstone = server.journal.findIndex((frame) => frame.file_id === oldId && frame.deleted);
  const record = server.journal.findIndex((frame) => frame.file_id === newId && !frame.deleted);
  assert.notEqual(tombstone, -1, `no tombstone was published: ${story(server, a, b)}`);
  assert.notEqual(record, -1, `no record was published: ${story(server, a, b)}`);
  assert.ok(tombstone < record, `the record was published before the tombstone it replaces: ${story(server, a, b)}`);
});

/**
 * THE PULL PATH'S OWN FOLLOW, with no vault events behind it at all.
 *
 * The rig has no watcher: nothing reports the re-case back to this plugin's
 * rename handler, which is also the truth on a real host for the per-file
 * moves a folder re-case fans out into and on any host whose report is late
 * or dropped. So the selection has exactly one thing that can move it, and
 * this is it -- left behind, it names a folder this vault no longer shows and
 * every file under it leaves the scope in the same tick (review round 3,
 * finding 1). The admission is the other half: a folder record naming
 * `team docs` reaches this code at all only because the string rule tolerates
 * one capitalisation of a selection root, and the VAULT decides the rest.
 */
test("a folder record that re-cases the folder this device selects moves the selection with it", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.state.data.syncFolders = ["Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const one = r.state.fileByPath("Team docs/One.md");
  // THE ORDER A RE-CASE REALLY ARRIVES IN, which is also the whole of what
  // tells it from a SECOND folder of that name on a device that keeps the two
  // spellings apart (review round 4, finding 1): the peer's record for the
  // folder as it was, that record's TOMBSTONE, and only then the record under
  // the new spelling. Both senders of a re-case publish it this way
  // (`sync/engine.ts`, `folderRenamed` and `recaseFolders`;
  // `docs/protocol.md`).
  const created = await folderRecord(r, "Team docs");
  assert.equal(await applyChange(r.context, created), "applied");
  assert.equal(
    await applyChange(r.context, await folderRecord(r, "Team docs", { deleted: true, parents: [created.version_id] })),
    "skipped",
    "the folder held a note, so the tombstone keeps it and retires the record alone",
  );

  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "applied");

  assert.deepEqual(r.state.data.syncFolders, ["team docs"], "the selection did not follow the folder record");
  assert.deepEqual([...r.host.files.keys()], ["team docs/One.md"], "the directory entry was not re-cased");
  assert.equal(r.state.fileByPath("team docs/One.md").fileId, one.fileId, "the note lost its identity");
  assert.ok(
    r.host.logs.some((line) => line.includes("scope decision=followed_recase folders=1 selected=1")),
    r.host.logs.filter((line) => line.startsWith("scope")).join(" | "),
  );
  assert.deepEqual(r.host.trashed, [], "a re-case trashed something");
  // AND THE RETIREMENT IS SPENT. It admitted this record and nothing else: a
  // second record one capitalisation off the folder, arriving behind it, is a
  // twin again.
  assert.deepEqual(r.state.data.retiredRoots, {}, "the retirement outlived the record that took it");
  // And the note under it is still this device's to sync: a selection left at
  // the old spelling is what would take it out of scope.
  await pushFile(r.context, "team docs/One.md");
});

/**
 * A DEVICE THAT KEEPS THE TWO SPELLINGS APART REFUSES IT, and that is the
 * same rule rather than a second one: there, `team docs` is a different
 * directory that this device does not sync, the vault says so by holding
 * nothing at that name, and the record is skipped exactly as it was before.
 */
test("a folder record one capitalisation off the selection is refused where the two are two folders", async (t) => {
  const r = await rig({ caseSensitive: true });
  r.state.data.syncFolders = ["Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  // The peer's whole rename, in order, so what refuses it here is the VAULT
  // and not the admission rule: the record is admitted exactly as it is on a
  // folding host -- the tombstone retired this device's own record for the
  // folder it selects -- and then refused because nothing here wears the name
  // the record asks for (review round 4, finding 1).
  const created = await folderRecord(r, "Team docs");
  assert.equal(await applyChange(r.context, created), "applied");
  assert.equal(
    await applyChange(r.context, await folderRecord(r, "Team docs", { deleted: true, parents: [created.version_id] })),
    "skipped",
  );

  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "skipped");

  assert.deepEqual(r.state.data.syncFolders, ["Team docs"], "the selection followed a folder this vault does not have");
  assert.deepEqual([...r.host.files.keys()], ["Team docs/One.md"], "the vault was touched");
  assert.equal(r.state.data.folders["team docs"], undefined, "a record was kept for a folder outside the selection");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=not_synced") && line.includes("reason=outside_sync_scope")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  // AND IT SAYS NOTHING TO THE USER, which is what `CHANGELOG.md` and
  // `docs/troubleshooting.md` now say plainly: this device keeps its folder
  // under the old spelling and stops receiving what the other device puts in
  // it until the folder is renamed here to match (review round 4, finding 4).
  assert.deepEqual(r.host.notices, [], "a receiver that keeps the two apart was told something");
});

/**
 * THE CASE-TWIN, and the difference between a folder renamed and a folder
 * that was always there (review round 4, finding 1).
 *
 * A device whose filesystem KEEPS the two spellings apart can hold both
 * `Team docs` and `team docs` -- it is what a 1.0.x rename leaves behind, and
 * `docs/troubleshooting.md` tells the user to expect it. Its record for the
 * twin is one capitalisation off the folder a folding phone selects, and the
 * phone's vault can only answer that the two are one entry HERE: it cannot
 * say whether the sender means this folder. Admitted on that answer alone,
 * the phone re-cased its own folder, moved its SELECTION onto the twin, and
 * from then on skipped every change the other device made under the folder it
 * really selected, while its own edits came back there as conflict copies.
 * Silently, on both devices.
 *
 * WHAT TELLS THEM APART IS THE TOMBSTONE. A re-case is a rename, and a rename
 * retires the old name first (`docs/protocol.md`); a twin arrives while this
 * device's own record for its selected folder is still live. All three shapes
 * the reviewer measured are here: the upgrade shape, a sibling renamed INTO
 * the twin, and the twin created beside it.
 */
test("a case-twin of the selected folder, from a device that keeps the two apart, moves no selection", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: true, caseSensitiveB: false,
  });
  b.state.data.syncFolders = ["Team docs"];
  a.host.write("Team docs/One.md", BODY, 1000);
  a.host.write("Team docs/Two.md", OTHER, 1000);
  a.host.write("team docs/Y.md", TWIN, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md") && settled(b, "Team docs/Two.md"));
  await timers.run(SCAN_MS);

  assert.deepEqual(
    b.state.data.syncFolders,
    ["Team docs"],
    `the selection followed a folder this device never selected: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    [...b.host.files.keys()].sort(),
    ["Team docs/One.md", "Team docs/Two.md"],
    `the twin's note arrived, or the selected folder's did not: ${story(server, a, b)}`,
  );
  // THE NOTE THE DEFECT LOST, and then the edits after it: the folder the
  // phone selected keeps syncing in both directions.
  a.host.write("Team docs/One.md", EDITED, 3000);
  await timers.run(STEP_MS, () => b.host.text("Team docs/One.md") === EDITED);
  b.host.write("Team docs/Two.md", EDITED_B, 3100);
  await timers.run(STEP_MS, () => a.host.text("Team docs/Two.md") === EDITED_B);
  assert.equal(a.host.text("team docs/Y.md"), TWIN, "the twin was touched");
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 3, `a note was published twice: ${story(server, a, b)}`);
  // AND THE USER IS TOLD, once, in words that name both spellings.
  const told = b.host.notices.filter((notice) => notice.includes("differ only in capitalisation"));
  assert.equal(told.length, 1, b.host.notices.join(" | "));
  assert.ok(told[0].includes('"team docs"') && told[0].includes('"Team docs"'), told[0]);
});

for (const [what, act] of [
  ["renames a sibling INTO the twin", (host) => host.renameFolder("Other", "team docs")],
  ["creates the twin beside it", (host) => { host.makeFolder("team docs"); host.write("team docs/Y.md", TWIN, 2000); }],
]) {
  test(`a device that keeps the two spellings apart ${what}: the phone's selection and notes are untouched`, async (t) => {
    const { server, timers, a, b, keys } = await pair(t, "immediate", {
      isMobileB: false, caseSensitiveA: true, caseSensitiveB: false,
    });
    b.state.data.syncFolders = ["Team docs"];
    a.host.write("Team docs/One.md", BODY, 1000);
    a.host.write("Team docs/Two.md", OTHER, 1000);
    a.host.write("Other/X.md", "a sibling folder's note\n", 1000);
    await a.engine.start();
    await b.engine.start();
    await timers.run(STEP_MS, () => settled(b, "Team docs/One.md") && settled(b, "Team docs/Two.md"));
    const ids = ["Team docs/One.md", "Team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId);

    act(a.host);
    await timers.run(SCAN_MS);
    await timers.run(SCAN_MS);

    assert.deepEqual(b.state.data.syncFolders, ["Team docs"], `the selection moved: ${story(server, a, b)}`);
    assert.deepEqual([...b.host.files.keys()].sort(), ["Team docs/One.md", "Team docs/Two.md"], story(server, a, b));
    // The desktop's edit under the folder the phone selected still arrives,
    // and the phone's own edit lands on the desktop's note rather than
    // forking into a conflict copy inside the twin.
    a.host.write("Team docs/One.md", EDITED, 3000);
    await timers.run(STEP_MS, () => b.host.text("Team docs/One.md") === EDITED);
    b.host.write("Team docs/Two.md", EDITED_B, 3100);
    await timers.run(STEP_MS, () => a.host.text("Team docs/Two.md") === EDITED_B);
    assert.deepEqual(
      ["Team docs/One.md", "Team docs/Two.md"].map((path) => b.state.fileByPath(path).fileId),
      ids,
      `a note under the selected folder changed identity: ${story(server, a, b)}`,
    );
    assert.equal(
      [...a.host.files.keys()].filter((path) => path.includes("conflict")).length,
      0,
      `the phone's edit arrived as a conflict copy: ${story(server, a, b)}`,
    );
  });
}

/**
 * AND THE RETIREMENT IS THE FOLDER'S OWN, not "a tombstone went past".
 *
 * Two selected roots, and the peer retires the record for ONE of them: the
 * other's case-twin is still a twin, and admitting it because some tombstone
 * had been applied would be the same defect with one more step.
 */
test("a tombstone for another selected folder admits no case-twin of this one", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.state.data.syncFolders = ["Other", "Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  r.host.seed("Other/X.md", OTHER, 1000);
  await pushFile(r.context, "Team docs/One.md");
  await pushFile(r.context, "Other/X.md");
  const team = await folderRecord(r, "Team docs");
  assert.equal(await applyChange(r.context, team), "applied");
  const other = await folderRecord(r, "Other");
  assert.equal(await applyChange(r.context, other), "applied");

  // The peer retires `Other` -- and only `Other`.
  assert.equal(
    await applyChange(r.context, await folderRecord(r, "Other", { deleted: true, parents: [other.version_id] })),
    "skipped",
  );
  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "skipped");

  assert.deepEqual(r.state.data.syncFolders, ["Other", "Team docs"], "the selection followed another folder's tombstone");
  assert.deepEqual([...r.host.files.keys()].sort(), ["Other/X.md", "Team docs/One.md"], "the vault was re-cased");
  assert.equal(r.state.folderByPath("team docs"), undefined, "a record was written for the twin");
  assert.equal(r.host.notices.length, 1, r.host.notices.join(" | "));
});

/**
 * AND IT IS A RECORD THIS DEVICE HELD. A tombstone for a folder this device
 * has no record for retires nothing, so it opens no window: the device that
 * sent it may be renaming a folder of its own that this one has never
 * published or received a record for.
 */
test("a tombstone for a folder record this device does not hold admits no case-twin", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.state.data.syncFolders = ["Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  assert.equal(r.state.folderByPath("Team docs"), undefined, "this rig already holds the record, so it proves nothing");

  const created = await folderRecord(r, "Team docs");
  assert.equal(
    await applyChange(r.context, await folderRecord(r, "Team docs", { deleted: true, parents: [created.version_id] })),
    "skipped",
  );
  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "skipped");

  assert.deepEqual(r.state.data.syncFolders, ["Team docs"], "the selection followed a tombstone for a record this device never had");
  assert.deepEqual([...r.host.files.keys()], ["Team docs/One.md"], "the vault was re-cased");
  assert.deepEqual(r.state.data.retiredRoots, {}, "a retirement was armed for a record this device does not hold");
});

/**
 * AND THE TOMBSTONE IS THE ONE THAT RETIRES THIS DEVICE'S OWN RECORD. A
 * folder record IS its path and its file id is derived from that path, so a
 * tombstone under any OTHER id retires nothing this device holds -- and a
 * window opened by it would be a window opened by a stranger.
 */
test("a folder tombstone under another file id opens no window", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.state.data.syncFolders = ["Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  assert.equal(await applyChange(r.context, await folderRecord(r, "Team docs")), "applied");
  const own = r.state.folderByPath("Team docs");

  const foreign = await r.server.publishManifest({
    fileId: "ab".repeat(16),
    manifest: {
      v: 2, kind: "directory", path: "Team docs", domain: "0123456789abcdef0123456789abcdef",
      size: 0, chunks: [], sha256: "", deleted: true,
    },
    sids: [],
    parents: [],
    deviceId: FOREIGN,
    manifestKey: r.keys.manifestKey,
    bytes: 0,
  });
  assert.notEqual(foreign.file_id, own.fileId, "the fixture retired the record this device holds after all");
  assert.equal(await applyChange(r.context, foreign), "skipped");
  assert.deepEqual(r.state.data.retiredRoots, {}, "a window opened for a record this device does not hold");

  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "skipped");
  assert.deepEqual(r.state.data.syncFolders, ["Team docs"], "the selection followed a twin through a stranger's window");
  assert.deepEqual([...r.host.files.keys()], ["Team docs/One.md"], "the vault was re-cased");
});

/**
 * AN ANCESTOR IS NOT A LAST COMPONENT (review round 4, finding 2).
 *
 * `rename(2)` resolves the directory components of its destination, so no
 * host can apply a difference that lies in an ancestor: the rename lands
 * where it started. Admitted anyway, this device asked its host to make that
 * move, the fake reported the no-op as a rename from a path to ITSELF, and
 * the handler wrote each note's record under the new key and forgot it under
 * the old one -- the same key -- so both records vanished and the next pass
 * published the notes as NEW files. The tolerance stops at the last
 * component, and the record is refused before anything is moved.
 */
test("a re-case of an ANCESTOR of the selected folder is refused, and nothing is published back", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  b.state.data.syncFolders = ["Docs/Team docs"];
  a.host.write("Docs/Team docs/One.md", BODY, 1000);
  a.host.write("Docs/Team docs/Two.md", OTHER, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    settled(b, "Docs/Team docs/One.md") && settled(b, "Docs/Team docs/Two.md"));
  const before = server.journal.length;

  a.host.renameFolder("Docs", "docs");
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);
  const settledAt = server.journal.length;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(server.journal.length, settledAt, `the two devices traded the rename: ${story(server, a, b)}`);
  assert.deepEqual(b.state.data.syncFolders, ["Docs/Team docs"], "the selection moved under an ancestor this device cannot re-case");
  assert.deepEqual(
    [...b.host.files.keys()].sort(),
    ["Docs/Team docs/One.md", "Docs/Team docs/Two.md"],
    story(server, a, b),
  );
  assert.equal(
    server.journal.slice(before).filter((frame) => frame.device_id === b.state.data.deviceId).length,
    0,
    `the receiver published something about an ancestor it does not sync: ${story(server, a, b)}`,
  );
  assert.equal(
    b.host.logs.some((line) => line.includes("case_ghost_forgotten")),
    false,
    b.host.logs.filter((line) => line.startsWith("reconcile") || line.startsWith("scan")).join(" | "),
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, "a note was republished under a new identity");
  // THE RECORD FOR THE SELECTION'S OWN PATH, BY ITS FILE ID, because the
  // record for the ancestor `docs` is refused here whatever the tolerance
  // does -- an assertion that read only "something was refused" would pass on
  // a device that admitted this one. A folder record IS its path and its file
  // id is derived from it, so the refusal names which record it was
  // (a name is vault content and never reaches a log, requirement 6).
  const twinId = await c.folderFileId(keys.manifestKey, "docs/Team docs");
  assert.ok(
    b.host.logs.some((line) =>
      line.includes("decision=not_synced") && line.includes("reason=outside_sync_scope") &&
      line.includes(`file=${twinId}`)),
    b.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

/**
 * THE COMPARISON ITSELF, one component at a time.
 */
test("only the last component's capitalisation is a case difference the folder rule tolerates", async () => {
  assert.equal(caseOnlyLastComponent("Team docs", "team docs"), true);
  assert.equal(caseOnlyLastComponent("Docs/Team docs", "Docs/team docs"), true);
  assert.equal(caseOnlyLastComponent("Docs/Team docs", "docs/Team docs"), false, "the ancestor differs");
  assert.equal(caseOnlyLastComponent("A/B/Team docs", "a/B/team docs"), false, "a grandparent differs");
  assert.equal(caseOnlyLastComponent("A/B/Team docs", "A/B/team docs"), true);
  assert.equal(caseOnlyLastComponent("Team docs", "Team docs"), false, "the same path is not a rename");
  assert.equal(caseOnlyLastComponent("Team docs", "Team docs/Sub"), false, "one component deeper is another folder");
  assert.equal(caseTwinRoot("team docs", ["Other", "Team docs"]), "Team docs");
  assert.equal(caseTwinRoot("docs/Team docs", ["Docs/Team docs"]), null, "an ancestor's capitalisation");
  assert.equal(caseTwinRoot("team docs", undefined), null, "a device that syncs the whole vault has no root to twin");
  assert.equal(inFolderCaseScope("docs/Team docs", ["Docs/Team docs"]), false);
  assert.equal(inFolderCaseScope("team docs", ["Team docs"]), true);
});

/**
 * A VAULT THAT REPORTS A RENAME FROM A PATH TO ITSELF (review round 4,
 * finding 2). The handler used to write the record under `to` and forget it
 * under `from` -- one key -- so the note lost its record and its identity
 * with it. Nothing about that needs an exotic host: it is what a watcher
 * reporting a no-op rename, or a host answering for the name it was asked
 * with rather than the name it has, delivers.
 */
test("a vault that reports a rename from a path to itself changes nothing", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  a.host.write("Team docs/One.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md"));
  const record = a.state.fileByPath("Team docs/One.md");
  const before = server.journal.length;

  a.host.emit("rename", a.host.entry("Team docs/One.md"), "Team docs/One.md");
  a.host.emit("rename", a.host.entry("Team docs", true), "Team docs");
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.deepEqual(a.state.fileByPath("Team docs/One.md"), record, "the note's record was rewritten by a rename onto itself");
  assert.equal(server.journal.length, before, `something was published for a rename that moved nothing: ${story(server, a, b)}`);
  assert.deepEqual([...b.host.files.keys()], ["Team docs/One.md"], story(server, a, b));
  // EACH OF THE THREE ENTRY POINTS SAYS SO ITSELF, in the order the vault
  // reported them: the file's own handler, the fan-out that moves every note
  // under a renamed folder, and the publisher of the folder's two records
  // (`sync/engine.ts`, `renamed`, `renamedFolder` and `folderRenamed`). A
  // guard missing from one of them is a line missing from this list.
  assert.deepEqual(
    a.host.logs.filter((line) => line.includes("decision=skipped reason=same_path")),
    [
      "watch path_class=file decision=skipped reason=same_path event=rename",
      "watch path_class=folder decision=skipped reason=same_path event=rename",
      "watch path_class=folder decision=skipped reason=same_path event=rename",
    ],
    a.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
});

/**
 * AND A RECORD WRITTEN FOR THAT FOLDER AGAIN ENDS THE RETIREMENT, which is
 * the other half of the rule the docs state: the window is "the tombstone for
 * this folder's record has been applied AND no record has been written for it
 * since" (`sync/pull.ts`, `admitFolderRecord`). The peer that deletes a
 * folder and makes it again has written one, and a twin arriving afterwards
 * is a twin.
 */
test("a folder record written for the selected folder again ends the retirement", async (t) => {
  const r = await rig({ caseSensitive: false });
  r.state.data.syncFolders = ["Team docs"];
  r.host.seed("Team docs/One.md", BODY, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const created = await folderRecord(r, "Team docs");
  assert.equal(await applyChange(r.context, created), "applied");
  const retired = await folderRecord(r, "Team docs", { deleted: true, parents: [created.version_id] });
  assert.equal(await applyChange(r.context, retired), "skipped");
  assert.deepEqual(Object.keys(r.state.data.retiredRoots), ["Team docs"], "the tombstone opened no window at all");

  assert.equal(await applyChange(r.context, await folderRecord(r, "Team docs", { parents: [retired.version_id] })), "applied");
  assert.deepEqual(r.state.data.retiredRoots, {}, "the record written for the folder left the window open");

  assert.equal(await applyChange(r.context, await folderRecord(r, "team docs")), "skipped");
  assert.deepEqual(r.state.data.syncFolders, ["Team docs"], "the selection followed a twin through a closed window");
  assert.deepEqual([...r.host.files.keys()], ["Team docs/One.md"], "the vault was re-cased");
  assert.equal(r.host.notices.length, 1, r.host.notices.join(" | "));
});

/**
 * AND THE FAKE DOES NOT INVENT THE EVENT. A rename whose destination differs
 * from its source in a directory component alone lands where it started: the
 * syscall succeeds -- a real case-insensitive APFS directory answers `moved`,
 * which `realfs-case.test.mjs` measures, and the product's own spelling check
 * is what refuses it -- and the watcher reports NOTHING, because nothing
 * changed. A fake that reported one handed the plugin a rename from a path to
 * itself that no host delivers.
 */
test("the fake reports no rename for a folder move that landed where it started", async (t) => {
  const { a } = await pair(t, "immediate", { isMobileB: false, caseSensitiveA: false, caseSensitiveB: false });
  a.host.write("Docs/Team docs/One.md", BODY, 1000);
  const reported = [];
  a.host.on("rename", (entry, old) => reported.push(`${old} -> ${entry.path}`));

  assert.equal(await a.host.moveFolder("Docs/Team docs", "docs/Team docs"), "moved", "the syscall succeeds on a folding volume");
  assert.deepEqual([...a.host.files.keys()], ["Docs/Team docs/One.md"], "the entry moved after all");
  assert.equal(await a.host.spelling("docs/Team docs"), "Docs/Team docs", "the vault shows the spelling it kept");
  assert.deepEqual(reported, [], "the fake reported a rename onto the same path");

  // The LAST component really is renamed, and that one is reported.
  assert.equal(await a.host.moveFolder("Docs/Team docs", "Docs/team docs"), "moved");
  assert.deepEqual(reported, ["Docs/Team docs -> Docs/team docs"]);
});

/**
 * A FOLDER RECORD'S POST CAN FAIL, AND THE BARRIER IS ITS, NOT THE ATTEMPT'S
 * (review round 3, finding 3).
 *
 * `takeBatch` deleted the barrier as it took the path and `pushNow` deleted
 * the path from `folderPublishes` before the post, so a failed post simply
 * ceased to exist: the moves queued behind it went out alone, a folding
 * receiver refused every one of them with a notice naming a cause that was
 * not the one, and nothing re-derived the record until the next start.
 * `docs/protocol.md` states the order as a promise about the WIRE, which a
 * promise that holds only when the post succeeds is not.
 *
 * Two hostile transports, the reviewer's: one that rejects the record's post
 * once, and one that holds it for a generous number of event-loop turns and
 * then rejects it. Both must end with the record on the wire BEFORE the
 * moves, and the receiver holding its notes at the versions the moves carry.
 */
for (const [what, hostile] of [
  ["rejects it once", async () => { throw new Error("fixture: the folder record's post was refused"); }],
  ["holds it and then rejects it", async (turns) => {
    await turns(300);
    throw new Error("fixture: the folder record's post was refused after a hold");
  }],
]) {
  test(`a folder record whose post fails is retried, and the moves stay behind it (${what})`, async (t) => {
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
    let refused = 0;
    b.transport.postVersion = async (fileId, body) => {
      if (fileId !== folderId) return post(fileId, body);
      if (refused === 0) {
        refused++;
        return await hostile(turns);
      }
      // THE RETRY IS SLOW TOO, which is what makes this test about the
      // BARRIER and not about who happened to answer first: a record put
      // back without its barrier is posted alongside the moves, and the
      // moves win.
      await turns(50);
      return post(fileId, body);
    };

    const before = server.journal.length;
    const at = (id) => server.journal.findIndex(
      (frame, index) => index >= before && frame.file_id === id && !frame.deleted);
    b.host.renameFolder("Team docs", "team docs");
    await timers.run(STEP_MS, () =>
      a.host.logs.some((line) => line.includes("decision=case_renamed")) &&
      [folderId, ...ids].every((id) => at(id) !== -1));

    assert.equal(refused, 1, "the hostile transport never ran");
    assert.ok(
      b.host.logs.some((line) =>
        line.includes("push path_class=folder decision=retry reason=folder_post attempt=1 budget=3")),
      b.host.logs.filter((line) => line.startsWith("push")).join(" | "),
    );
    for (const id of ids) {
      assert.ok(at(folderId) < at(id), `a move was journaled before the retried record: ${story(server, a, b)}`);
    }
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
}

/**
 * AND THE HOLD SURVIVES A RESTART (review round 4, finding 3).
 *
 * `docs/protocol.md` states the order as a promise about the WIRE, and a
 * promise that holds only for as long as one engine happens to live is not
 * the one it states. Stopped mid-drain -- Obsidian quit, the vault closed,
 * the plugin reloaded -- the barrier died with the drain and the folder
 * record died with `folderPublishes`, so the next start's pass re-derived the
 * record from the vault, queued it BEHIND the moves it exists to order, and
 * the folding receiver refused every one of them with a notice blaming a
 * version problem the pair did not have. The hold is written down now
 * (`state.ts`, `folderBarriers`) and restored at the head of the queue before
 * any file work.
 *
 * THREE RESTARTS, because the window has three shapes: the post is still in
 * flight when the engine starts again, it failed while the engine was
 * stopped, or the plugin was reloaded and a NEW engine took over the same
 * vault and the same state.
 */
for (const [what, restart] of [
  ["the post is still in flight when it starts again", { reject: "after", reload: false }],
  ["the post failed while it was stopped", { reject: "before", reload: false }],
  ["the plugin reloaded and a new engine took over", { reject: "after", reload: true }],
]) {
  test(`a folder record's hold survives a restart: ${what}`, async (t) => {
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
    let release = null;
    let held = 0;
    b.transport.postVersion = async (fileId, body) => {
      if (fileId === folderId && held === 0) {
        held++;
        await new Promise((resolve, reject) => { release = reject; });
      }
      return post(fileId, body);
    };
    const before = server.journal.length;
    const at = (id) => server.journal.findIndex(
      (frame, index) => index >= before && frame.file_id === id && !frame.deleted);

    b.host.renameFolder("Team docs", "team docs");
    await until(() => held === 1, "the folder record's post never started, so this test proves nothing");
    assert.deepEqual(
      b.state.data.folderBarriers,
      ["team docs"],
      "the hold was never written down, so no restart could restore it",
    );

    b.engine.stop();
    const fail = () => release(new Error("fixture: the folder record's post was refused"));
    if (restart.reject === "before") { fail(); await turns(20); }
    let engine = b.engine;
    if (restart.reload) {
      // A PLUGIN RELOAD: a new engine over the same vault and the same state,
      // with the vault's handlers rewired to it exactly as `onload` does.
      engine = new SyncEngine({
        state: b.state, transport: b.transport, host: b.host, now: () => b.host.clock, timers,
      });
      b.plugin.engine = engine;
      t.after(() => engine.stop());
    }
    await engine.start();
    await turns(20);
    if (restart.reject === "after") { fail(); await turns(20); }

    await timers.run(STEP_MS, () =>
      a.host.logs.some((line) => line.includes("decision=case_renamed")) &&
      [folderId, ...ids].every((id) => at(id) !== -1));
    await timers.run(SCAN_MS);
    const settledAt = server.journal.length;
    await timers.run(SCAN_MS);
    await timers.run(SCAN_MS);

    // THE WIRE ORDER, which is the promise itself.
    for (const id of ids) {
      assert.ok(
        at(folderId) < at(id),
        `a move was journaled before the record across a restart: ${story(server, a, b)}`,
      );
    }
    assert.equal(
      a.host.logs.some((line) => line.includes("case_move_refused")),
      false,
      a.host.notices.join(" | ") || story(server, a, b),
    );
    assert.deepEqual(
      [...a.host.files.keys()].sort(),
      ["team docs/One.md", "team docs/Two.md"],
      `the receiver never converged: ${story(server, a, b)}`,
    );
    for (const path of ["team docs/One.md", "team docs/Two.md"]) {
      assert.equal(
        a.state.fileByPath(path)?.versionId,
        b.state.fileByPath(path)?.versionId,
        `the two devices hold different versions: ${story(server, a, b)}`,
      );
    }
    assert.equal(server.journal.length, settledAt, `the pair traded the rename: ${story(server, a, b)}`);
    assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, "a note was republished under a new identity");
    assert.deepEqual(b.state.data.folderBarriers, [], "the hold outlived the record it was holding");
  });
}

/**
 * A DUPLICATE REPORT OF ONE RENAME, while the record's post is in flight.
 *
 * Obsidian's own index and a filesystem watcher are two sources for one
 * event, and `pushNow` takes the path out of `folderPublishes` before its
 * post -- so the second report leaves a publication queued behind a post that
 * is already carrying it. It must publish nothing of its own, leave no hold
 * behind, and send no move in front of the record.
 */
test("a folder record reported twice while its post is in flight publishes one record and keeps no hold", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", {
    isMobileB: false, caseSensitiveA: false, caseSensitiveB: false,
  });
  a.host.write("Team docs/One.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, "Team docs/One.md"));
  const folderId = await c.folderFileId(keys.manifestKey, "team docs");

  const turns = async (count) => {
    for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const post = b.transport.postVersion.bind(b.transport);
  const holds = [];
  b.transport.postVersion = async (fileId, body) => {
    if (fileId === folderId && holds.length === 0) await new Promise((resolve) => holds.push(resolve));
    return post(fileId, body);
  };
  const before = server.journal.length;

  b.host.renameFolder("Team docs", "team docs");
  await until(() => holds.length === 1, "the folder record's post never started, so this test proves nothing");
  assert.deepEqual(b.state.data.folderBarriers, ["team docs"], "the hold was never written down");
  b.host.emit("rename", b.host.entry("team docs", true), "Team docs");
  await turns(20);
  assert.deepEqual(
    b.state.data.folderBarriers,
    ["team docs"],
    "the hold was dropped while the record was still owed",
  );

  holds[0]();
  await timers.run(STEP_MS, () =>
    a.host.logs.some((line) => line.includes("decision=case_renamed")) && a.host.text("team docs/One.md") === BODY);
  await timers.run(SCAN_MS);

  assert.deepEqual(b.state.data.folderBarriers, [], "the hold outlived the record it was holding");
  assert.equal(
    server.journal.slice(before).filter((frame) => frame.file_id === folderId && !frame.deleted).length,
    1,
    `the duplicate report published a second record: ${story(server, a, b)}`,
  );
  assert.equal(a.host.logs.some((line) => line.includes("case_move_refused")), false, a.host.logs.join(" | "));
});

/**
 * AND THE QUEUE NEVER STALLS FOREVER. A retry that could be taken again for
 * ever would stop this device publishing anything under that folder, so the
 * hold is bounded: `FOLDER_POST_TRIES` attempts, then one decision, one
 * notice, and the moves go -- which the receiver refuses and SAYS it
 * refuses, while this device's next start republishes the record from the
 * reconcile pass. Expiring silently is the one outcome that is not allowed.
 */
test("a folder record whose post keeps failing expires with a decision, and the queue drains", async (t) => {
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

  const post = b.transport.postVersion.bind(b.transport);
  let attempts = 0;
  b.transport.postVersion = async (fileId, body) => {
    if (fileId === folderId) {
      attempts++;
      throw new Error("fixture: the folder record's post was refused");
    }
    return post(fileId, body);
  };

  const before = server.journal.length;
  const at = (id) => server.journal.findIndex(
    (frame, index) => index >= before && frame.file_id === id && !frame.deleted);
  b.host.renameFolder("Team docs", "team docs");
  await timers.run(STEP_MS, () => ids.every((id) => at(id) !== -1));

  assert.equal(attempts, 3, `the bound is not the one the constant states: ${b.host.logs.slice(-6).join(" | ")}`);
  assert.equal(at(folderId), -1, `the record reached the server after all: ${story(server, a, b)}`);
  assert.ok(
    b.host.logs.some((line) =>
      line.includes("push path_class=folder decision=expired reason=folder_post attempt=3 budget=3")),
    b.host.logs.filter((line) => line.startsWith("push")).join(" | "),
  );
  assert.equal(b.host.notices.filter((message) => message.includes("folder record")).length, 1, b.host.notices.join(" | "));
  // NO STALL: the queue drained, and the moves this device owed are on the
  // wire -- refused there, and said so, which is the honest outcome.
  await timers.run(STEP_MS, () =>
    a.host.logs.some((line) => line.includes("case_move_refused reason=folder_case")));
  // AND IT RECOVERS AT THE NEXT RECONCILE, once the server answers again,
  // with the record published in the order the protocol states.
  b.transport.postVersion = post;
  await b.engine.syncNow();
  await timers.run(STEP_MS, () => at(folderId) !== -1 &&
    a.host.logs.some((line) => line.includes("path_class=folder") && line.includes("decision=case_renamed")));
  assert.deepEqual(
    [...a.host.files.keys()].sort(),
    ["team docs/One.md", "team docs/Two.md"],
    `the receiver never caught up: ${story(server, a, b)}`,
  );
  assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, `files were duplicated: ${story(server, a, b)}`);
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
  // START, with the budget it is measured against, before the work rather
  // than only after it: one fetch per carried record, and the records are
  // the folder this re-case carried (requirement 12; review round 3,
  // finding 4b).
  assert.ok(
    r.host.logs.some((line) =>
      line.includes("decision=start reason=heads_refetch") &&
      line.includes("budget_records=2") && line.includes("budget_fetches=2")),
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
