/**
 * Two notes, one name, and the rule that settles it (issue #113).
 *
 * Two devices that each create a note at the same path while one of them is
 * closed produce two FILES with one name. Keeping both is right and is what
 * 1.0.5 and 1.0.6 do; what neither did was give the pair distinct names, so
 * every later edit of either note arrived at an occupied path and made another
 * copy -- three of one note inside a few minutes, on real devices, on both
 * sides at once.
 *
 * THE RULE. The lower file id keeps the path. Both devices hold both ids, so
 * both compute the same answer without negotiating: the holder of the higher
 * id moves its own file aside and publishes that move; the holder of the lower
 * id writes the incoming one as a copy, records it under the incoming id, and
 * publishes nothing for it. Exactly one rename is ever published.
 *
 * Both vantage points are driven here, because a rule that only works from one
 * side is not a rule.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { DEVICE_B, STEP_MS, digest, pair, published, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { conflictCopyPath } = require("../build/sync/conflict.js");

const enc = (text) => new TextEncoder().encode(text);
const NOTE = "Notes/Same.md";
const MINE = "the note this device made\n";
const THEIRS = "the different note the other device made\n";
const OTHER = "Notes/Other.md";
const LOWER = "11".repeat(16);
const HIGHER = "33".repeat(16);

const copies = (host) => [...host.files.keys()].filter((path) => path.includes("(conflict from"));

/** One device holding `ours` at `NOTE`, and one foreign version of `theirs`. */
async function collision(ours, theirs, options = {}) {
  const r = await rig(options);
  r.host.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  // A pushed file id is random; which one sorts lower is the whole decision,
  // so it is pinned rather than left to the fixture's luck.
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), fileId: ours });
  const frame = await r.server.publish({
    fileId: theirs, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  return { r, frame };
}

test("the holder of the lower id keeps the path and records the other note", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  const before = r.server.journal.length;

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), MINE, "the lower id did not keep the name");
  const copy = copies(r.host)[0];
  assert.equal(r.host.text(copy), THEIRS, "the other device's note is not beside it");
  // Recorded under the INCOMING id: without this the copy is a file no record
  // explains, and the next startup scan publishes it as a third file id.
  assert.equal(r.state.fileByPath(copy).fileId, HIGHER);
  assert.equal(r.state.pathByFileId(HIGHER), copy);
  assert.equal(r.state.fileByPath(NOTE).fileId, LOWER);
  assert.equal(r.server.journal.length, before, "the keeping device published something");
  assert.ok(
    r.host.logs.some((line) => line.includes(`decision=same_name_tiebreak winner=${LOWER} role=keep`)),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("the holder of the higher id moves its own note aside and yields the path", async () => {
  const { r, frame } = await collision(HIGHER, LOWER);

  assert.equal(await applyChange(r.context, frame), "applied");

  assert.equal(r.host.text(NOTE), THEIRS, "the lower id did not take the name");
  const moved = copies(r.host)[0];
  assert.equal(r.host.text(moved), MINE, "this device's own note was not kept");
  assert.equal(r.state.fileByPath(moved).fileId, HIGHER, "the moved note kept its identity");
  assert.equal(r.state.fileByPath(NOTE).fileId, LOWER);
  assert.equal(r.state.pathByFileId(HIGHER), moved);
  // Dirty on purpose: the next push publishes the move as a version of this
  // device's own id, which is the one rename either device ever publishes.
  assert.equal(r.state.fileByPath(moved).mtime, -1);
  assert.equal(r.state.fileByPath(moved).sha256, "");
  // And the old name's removal is marked, or the vault's own delete event
  // becomes a tombstone for a file that is alive one name over (#96).
  assert.ok(r.context.trashed.has(NOTE));
  assert.ok(
    r.host.logs.some((line) => line.includes(`decision=same_name_tiebreak winner=${LOWER} role=rename`)),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("a later version of the other note lands on its own name, not on a new copy", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];

  // The other device edits its note again, before it has published its rename.
  const next = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(`${THEIRS}and a second line\n`), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, next), "applied");

  assert.deepEqual(copies(r.host), [copy], "a second copy was made for a note already settled here");
  assert.equal(r.host.text(copy), `${THEIRS}and a second line\n`, "the update did not reach the settled note");
  assert.equal(r.host.text(NOTE), MINE, "and this device's own note is untouched");
});

test("the published rename arrives as a plain move, not another copy", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];

  // The other device publishes the rename of ITS note to a name of its own.
  const renamed = "Notes/Same (conflict from iPhone, 2026-01-02 0304).md";
  const move = await r.server.publish({
    fileId: HIGHER, path: renamed, bytes: enc(THEIRS), mtime: 6000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, move), "applied");

  assert.equal(r.host.text(renamed), THEIRS, "the rename did not land");
  assert.equal(r.host.text(copy), null, "the old copy was left behind as a duplicate");
  assert.equal(r.host.text(NOTE), MINE);
  assert.equal(r.state.pathByFileId(HIGHER), renamed);
  assert.deepEqual(r.state.pathByFileId(LOWER), NOTE);
});

test("a rename whose name this device already chose is a no-op, not a second file", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];

  // The other device renames to exactly the name this device already gave it:
  // both derive it from the same device's name and the same minute.
  const move = await r.server.publish({
    fileId: HIGHER, path: copy, bytes: enc(THEIRS), mtime: 6000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, move), "applied");

  assert.deepEqual(copies(r.host), [copy], "the coinciding rename made another file");
  assert.equal(r.host.text(copy), THEIRS);
  assert.equal(r.host.text(NOTE), MINE);
});

test("an unpushed local edit at the settled name is kept, not replaced", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];

  // The user opens the copy and edits it, before anything pushes it.
  r.host.seed(copy, "the user's own words\n", 9000);
  const next = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(`${THEIRS}another line\n`), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, next), "conflict_copy");

  assert.equal(r.host.text(copy), "the user's own words\n", "an unpushed edit was replaced");
  assert.equal(r.host.text(NOTE), MINE);
});

/**
 * The record has to survive the session that made it (review round 2,
 * finding 6).
 *
 * The record for the copy is what keeps the next version of that id an
 * ordinary update, a later rename a plain move, and the copy out of the
 * startup scan's hands -- and a record that exists only in memory is a record
 * the next start does not have. The feed saves after each change it applies,
 * but the OTHER caller of this path does not: a push whose acknowledgement
 * says another device wrote first goes `pushNow -> reconcileFile ->
 * applyChange` (`engine.ts`) and returns without a save of its own. So the
 * write is asserted where it has to be true: in the stored metadata, and in
 * the state a fresh start reads back out of it.
 */
test("the copy's record is stored, not only held in memory", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  const copy = copies(r.host)[0];
  const stored = r.saved();
  assert.notEqual(stored, null, "nothing was written to disk at all");
  assert.equal(stored.files[copy]?.fileId, HIGHER, "the record was never stored");
  const restarted = await r.reload();
  assert.equal(restarted.fileByPath(copy)?.fileId, HIGHER, "the record did not survive a restart");
  assert.equal(restarted.pathByFileId(HIGHER), copy, "a restart would meet the copy as a file no record explains");
});

// --- a note this device has never published -------------------------------

/**
 * The shape the startup race actually takes, and the reason 1.0.6 diverged.
 *
 * A device that was closed pulls the other device's version while its own
 * reconciliation is still publishing the note it made under that name -- the
 * push queue and the change feed run side by side and either can win. The
 * pulling device then holds a file with NO file id, cannot apply the rule at
 * all, and keeps both under a name it picks alone, while the other device,
 * whose file is published, applies the rule and picks a different one. Both
 * devices keep both notes and neither ever agrees with the other about their
 * names.
 *
 * So the local file is published FIRST -- the queue was about to do it
 * anyway -- and then the ordinary rule decides. A minted file id is random,
 * so these pin the incoming one at the ends of the range instead: every id
 * this device can mint sorts above 32 zeros and below 32 f's.
 */
const LOWEST = "00".repeat(16);
const HIGHEST = "ff".repeat(16);

/** A rig whose pull path can publish, exactly as the engine's does. */
async function publishing() {
  const r = await rig();
  const pushed = [];
  r.context.publish = async (path) => { pushed.push(path); await pushFile(r.context, path); };
  return { r, pushed };
}

test("a note this device never published is given an id before the rule decides", async () => {
  const { r, pushed } = await publishing();
  r.host.seed(NOTE, MINE, 2000);
  const frame = await r.server.publish({
    fileId: HIGHEST, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.deepEqual(pushed, [NOTE], "the unpublished note was not published before the decision");
  const mine = r.state.fileByPath(NOTE);
  assert.ok(mine !== undefined && mine.fileId < HIGHEST, "this device did not end up holding an id");
  assert.equal(r.host.text(NOTE), MINE, "and it keeps the name, because its id sorts lower");
  const copy = copies(r.host)[0];
  assert.equal(r.host.text(copy), THEIRS);
  assert.equal(r.state.fileByPath(copy).fileId, HIGHEST);
  assert.ok(
    r.host.logs.some((line) => line.includes(`decision=same_name_tiebreak winner=${mine.fileId} role=keep`)),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("and it yields the name once it has one, when the other id sorts lower", async () => {
  const { r } = await publishing();
  r.host.seed(NOTE, MINE, 2000);
  const frame = await r.server.publish({
    fileId: LOWEST, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "applied");

  assert.equal(r.host.text(NOTE), THEIRS, "the lower id did not take the name");
  const moved = copies(r.host)[0];
  assert.equal(r.host.text(moved), MINE, "this device's own note was not kept");
  // Published under its own id and then moved: the record is left dirty so
  // the push that follows carries the rename, which is what lets the other
  // device follow the move instead of copying the note again.
  const ours = r.state.fileByPath(moved);
  assert.ok(ours.fileId > LOWEST);
  assert.equal(ours.mtime, -1);
  assert.equal(r.state.fileByPath(NOTE).fileId, LOWEST);
  assert.ok(r.server.vaultFiles().includes(ours.fileId), "the moved note was never published");
});

test("a note that cannot be published keeps both, and the copy is still recorded", async () => {
  const r = await rig();
  r.context.publish = async () => { throw new Error("sentinel: the server is unreachable"); };
  r.host.seed(NOTE, MINE, 2000);
  const frame = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), MINE, "the note that could not be published was not touched");
  const copy = copies(r.host)[0];
  assert.equal(r.host.text(copy), THEIRS);
  // Recorded even here: an unrecorded copy is a file the next startup scan
  // publishes as a file id of its own -- a THIRD note for one name.
  assert.equal(r.state.fileByPath(copy).fileId, HIGHER);
  assert.ok(
    r.host.logs.some((line) => line.includes(`decision=not_identified file=${HIGHER}`)),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );

  // And the next version of that id updates the copy rather than making one.
  const next = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(`${THEIRS}and more\n`), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, next), "applied");
  assert.deepEqual(copies(r.host), [copy], "the recorded copy was copied a second time");
  assert.equal(r.host.text(copy), `${THEIRS}and more\n`);
});

test("a publisher that leaves no record is not taken at its word", async () => {
  const r = await rig();
  // Succeeds, and publishes nothing -- the shape of a push that found the
  // file gone, or refused the path, without raising. The rule needs the id it
  // was promised, not the promise, so the answer is the one for a note that
  // could not be identified at all: both kept, and the copy recorded.
  r.context.publish = async () => undefined;
  r.host.seed(NOTE, MINE, 2000);
  const frame = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), MINE);
  const copy = copies(r.host)[0];
  assert.equal(r.host.text(copy), THEIRS);
  assert.equal(r.state.fileByPath(copy).fileId, HIGHER, "the copy was left for the next scan to publish as a third note");
  assert.equal(r.state.fileByPath(NOTE), undefined, "a note that was never published was recorded as if it had been");
});

// --- and the vault that is already exactly this version ---------------------

/**
 * A vault whose local state was lost or replaced meets EVERY one of its own
 * notes as a file with no id, and every one of them is byte for byte the
 * version the server holds. Publishing each as a new file and then renaming
 * whichever loses would double the vault and scatter its names over a lost
 * bookkeeping file, so a local file that IS this version is recorded as it,
 * and nothing is written, published or moved.
 */
test("a local file that is already this version is recorded, not copied or published", async () => {
  const { r, pushed } = await publishing();
  r.host.seed(NOTE, THEIRS, 4000);
  const before = r.server.journal.length;
  const frame = await r.server.publish({
    fileId: HIGHEST, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "applied");

  assert.deepEqual(copies(r.host), [], "a note identical to the version was copied beside itself");
  assert.deepEqual(pushed, [], "and published as a second file id");
  assert.equal(r.state.fileByPath(NOTE).fileId, HIGHEST, "the local file was not adopted under the version's id");
  assert.equal(r.state.fileByPath(NOTE).versionId, frame.version_id);
  assert.equal(r.server.journal.length, before + 1, "something was published");
  assert.ok(
    r.host.logs.some((line) => line.includes(`decision=adopted reason=identical_bytes file=${HIGHEST}`)),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("a local file of the same length that is NOT this version is never adopted", async () => {
  const { r } = await publishing();
  // Exactly as long as the incoming version and not the same bytes: the
  // length is what makes the comparison affordable, the digest is what
  // decides it.
  const same = THEIRS.replace("different", "DIFFERENT");
  assert.equal(same.length, THEIRS.length);
  assert.notEqual(same, THEIRS, "the fixture must differ from the version it resembles");
  r.host.seed(NOTE, same, 4000);
  const frame = await r.server.publish({
    fileId: HIGHEST, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), same, "the local note was replaced by a version it only resembles");
  assert.equal(r.host.text(copies(r.host)[0]), THEIRS);
  assert.notEqual(r.state.fileByPath(NOTE).fileId, HIGHEST, "two different notes were recorded as one file");
});

/**
 * What the record SAYS about a file has to be true of the bytes that were
 * proved (review round 2, finding 2).
 *
 * Adoption reads the local file, hashes it against the manifest's
 * authenticated digest, and records that file as this version. The read and
 * the record are two operations, and a save that lands between them replaces
 * the bytes the proof was about: recording the file's CURRENT size and
 * modification time against the older version says "this file is that version
 * and nothing has happened since", which is exactly the sentence the pull path
 * reads before it writes over a file. The next version of that id then
 * overwrote the user's replacement without keeping a copy.
 *
 * The metadata recorded is now bound to the bytes that were read: the file is
 * stat-ed again after the read and adoption is refused when it moved.
 */
test("a note replaced while it is being adopted is not marked as that version", async () => {
  const { r } = await publishing();
  const EDIT = "the note the user typed while obsync was looking at the old one\n";
  r.host.seed(NOTE, THEIRS, 4000);
  const frame = await r.server.publish({
    fileId: HIGHEST, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const read = r.host.read.bind(r.host);
  let once = true;
  r.host.read = async (path) => {
    const bytes = await read(path);
    // The user's editor saves over the note after obsync has read the bytes
    // it is about to call proof, and before it records anything about them.
    if (path === NOTE && once) {
      once = false;
      r.host.seed(NOTE, EDIT, 9999);
    }
    return bytes;
  };

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), EDIT, "the replacement was adopted as a version it is not");
  assert.notEqual(r.state.fileByPath(NOTE)?.fileId, HIGHEST, "the replacement was recorded as that version");
  assert.equal(r.host.text(copies(r.host)[0]), THEIRS, "the version was not kept beside it");

  // And the proof: the next version of that id must not land on the edit.
  const child = await r.server.publish({
    fileId: HIGHEST, path: NOTE, bytes: enc(`${THEIRS}and a child version\n`), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  await applyChange(r.context, child);

  assert.equal(r.host.text(NOTE), EDIT, "a later version of that id overwrote the edit");
});

test("a copy replaced while it is being matched is not recorded as the version", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  // The name this device would give the incoming version is already occupied
  // by exactly its bytes -- one foreign head resolved twice, which is what the
  // reuse path exists for -- and the user replaces that copy while obsync is
  // reading it to prove the match.
  const taken = conflictCopyPath(NOTE, "iPhone", new Date(r.host.clock), 1);
  r.host.seed(taken, THEIRS, 4000);
  const EDIT = "the user's own words, typed into the copy\n";
  const read = r.host.read.bind(r.host);
  let once = true;
  r.host.read = async (path) => {
    const bytes = await read(path);
    if (path === taken && once) {
      once = false;
      r.host.seed(taken, EDIT, 9999);
    }
    return bytes;
  };

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(taken), EDIT, "the replacement was written over");
  assert.equal(r.state.fileByPath(taken), undefined, "the replacement was recorded as the version it is not");
  const landed = copies(r.host).filter((path) => path !== taken);
  assert.equal(landed.length, 1, `the version was not written at a name of its own: ${JSON.stringify(copies(r.host))}`);
  assert.equal(r.host.text(landed[0]), THEIRS);
  assert.equal(r.state.fileByPath(landed[0]).fileId, HIGHER);
});

/**
 * The same bind, on the path every vault uses every day: an ordinary version
 * written over a file this device tracks. The record that follows the write
 * must describe the bytes the WRITE put there. A save that lands between the
 * two would otherwise be recorded as the version, and the next version of that
 * file id lands on it without keeping a copy.
 */
test("a save that lands on a version as it is written is not recorded as that version", async () => {
  const r = await rig();
  const USER = "what the user typed a moment after the pull landed\n";
  r.host.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  const ours = r.state.fileByPath(NOTE);
  const writer = r.host.writer.bind(r.host);
  let once = true;
  r.host.writer = async (path) => {
    const open = await writer(path);
    return {
      ...open,
      commit: async (mtime) => {
        const stat = await open.commit(mtime);
        if (path === NOTE && once) {
          once = false;
          r.host.seed(NOTE, USER, 9999);
        }
        return stat;
      },
    };
  };
  const frame = await r.server.publish({
    fileId: ours.fileId, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    parents: [ours.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, frame), "applied");
  assert.equal(r.host.text(NOTE), USER, "the fixture did not model a save landing on the write");

  // The record must not claim those bytes are the version that was written,
  // so the NEXT version of that id finds a local edit and keeps both.
  const next = await r.server.publish({
    fileId: ours.fileId, path: NOTE, bytes: enc(`${THEIRS}and another line\n`), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, next), "conflict_copy");
  assert.equal(r.host.text(NOTE), USER, "the save was overwritten by a later version of that id");
  assert.equal(r.host.text(copies(r.host)[0]), `${THEIRS}and another line\n`);
});

/**
 * And the third caller: a version landing on the copy this device settled
 * under the incoming id, which is precisely the file a user opens and types
 * into (issue #98). Same bind, same consequence if it is missed.
 */
test("a save that lands on a settled copy as it is written is not recorded as that version", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];
  const USER = "what the user typed into the copy a moment after it updated\n";
  const writer = r.host.writer.bind(r.host);
  let once = true;
  r.host.writer = async (path) => {
    const open = await writer(path);
    return {
      ...open,
      commit: async (mtime) => {
        const stat = await open.commit(mtime);
        if (path === copy && once) {
          once = false;
          r.host.seed(copy, USER, 9999);
        }
        return stat;
      },
    };
  };
  const next = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(`${THEIRS}a second line\n`), mtime: 5000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, next), "applied");
  assert.equal(r.host.text(copy), USER, "the fixture did not model a save landing on the write");

  const third = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(`${THEIRS}a third line\n`), mtime: 6000,
    parents: [next.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, third), "conflict_copy");
  assert.equal(r.host.text(copy), USER, "the save was overwritten by a later version of that id");
});

test("a version of a file this device tracks lands where it put it, not at a second path", async () => {
  const { r } = await publishing();
  // The incoming version RENAMES a file this device tracks at `OTHER` onto a
  // name an untracked file of the same content occupies. Recording it there --
  // by adopting that file, or by copying beside it -- would leave one file id
  // with two records, which no path can read.
  r.host.seed(OTHER, THEIRS, 3000);
  const first = await r.server.publish({
    fileId: LOWEST, path: OTHER, bytes: enc(THEIRS), mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, first), "applied");
  r.host.seed(NOTE, THEIRS, 4000);
  const renamed = await r.server.publish({
    fileId: LOWEST, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    parents: [first.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  await applyChange(r.context, renamed);

  const records = Object.entries(r.state.data.files).filter(([, record]) => record.fileId === LOWEST);
  assert.equal(records.length, 1, `one file id, ${records.length} records: ${JSON.stringify(records.map(([path]) => path))}`);
});

test("when no name is free this device keeps its own note and takes none", async () => {
  const { r, frame } = await collision(HIGHER, LOWER);
  // Every derived name occupied, so the move this device owes has nowhere to
  // go. Losing the tie-break is not a licence to write over the note.
  for (let attempt = 1; attempt <= 20; attempt++) {
    r.host.seed(conflictCopyPath(NOTE, "this device", new Date(r.host.clock), attempt), `squatter ${attempt}\n`, 3000);
    r.host.seed(conflictCopyPath(NOTE, "iPhone", new Date(r.host.clock), attempt), `squatter ${attempt}\n`, 3000);
  }

  assert.equal(await applyChange(r.context, frame), "refused");

  assert.equal(r.host.text(NOTE), MINE, "the note was moved or replaced with nowhere to put it");
  assert.equal(r.state.fileByPath(NOTE).fileId, HIGHER, "and this device still holds it under its own id");
  assert.match(r.host.notices.join(" "), /could not place/);
});

/**
 * The window between the copy and the trash (review round 2, finding 1).
 *
 * Moving this device's own note aside is a create-only copy and then a trash
 * of the original, and those are two operations with a gap between them. A
 * note open in the editor is saved on a timer, so the user can type into the
 * original inside that gap -- and those bytes exist on this device and nowhere
 * else, because the push that would carry them has not run. The trash is what
 * takes them.
 *
 * So the source is stat-ed before the copy and again immediately before the
 * trash, and a source that moved REFUSES the move: the note stays where it is
 * with the new text in it, nothing is trashed, and the answer falls back to
 * keeping both exactly as 1.0.6 did.
 */
test("an edit typed while the note is being moved aside is never trashed", async () => {
  const { r, frame } = await collision(HIGHER, LOWER);
  const TYPED = `${MINE}a line typed while the move was running\n`;
  const createWriter = r.host.createWriter.bind(r.host);
  let typed = false;
  r.host.createWriter = async (target, size, check) => {
    const writer = await createWriter(target, size, check);
    return {
      ...writer,
      commit: async (mtime) => {
        const stat = await writer.commit(mtime);
        // The user types into the original, after the copy of it has landed
        // and before the trash that would take the original away.
        if (!typed) {
          typed = true;
          r.host.seed(NOTE, TYPED, 9000);
        }
        return stat;
      },
    };
  };

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), TYPED, "the edit was trashed with the note it was typed into");
  assert.deepEqual(r.host.trashed, [], "a file holding bytes that exist nowhere else was trashed");
  // The record is untouched and now disagrees with the file, which is what
  // makes the queued push carry those bytes.
  assert.equal(r.state.fileByPath(NOTE).fileId, HIGHER, "this device stopped tracking its own note");
  assert.notEqual(r.state.fileByPath(NOTE).mtime, 9000, "the edit was recorded as if it had been pushed");
  // Both notes still exist, and so does the older text the refused move had
  // already copied: nothing this device held was removed.
  assert.equal(r.host.text(copies(r.host).find((path) => path.includes("iPhone"))), THEIRS);
  assert.equal(r.host.text(copies(r.host).find((path) => path.includes("this device"))), MINE);
  assert.ok(
    // The exact reason, not a prefix of it: "the note changed before the
    // removal was attempted" and "it changed inside the removal" are two
    // different accounts of two different windows, and the device has to
    // give the one that happened (requirement 12).
    r.host.logs.some((line) => line.includes("decision=move_aside_refused reason=source_changed file=")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

/**
 * The size of the LOCAL note, which the incoming version says nothing about
 * (review round 2, finding 4).
 *
 * A 21-byte note arriving from another device can collide with a local note of
 * any size at all, and the desktop host reads a whole file by allocating its
 * whole size (`main.ts`). Reading a multi-GiB note into memory to copy it one
 * name over is the one thing the push path is carefully built never to do --
 * it streams in 8 MiB windows, which is why a 20 GB archive costs what a note
 * costs -- and the move aside must obey the same bound.
 *
 * The vault below MODELS such a note rather than allocating one: it reports
 * the size, serves windows, and refuses a whole-file read above the bound
 * exactly as a device short of memory would. A move that needs the whole file
 * cannot pass it.
 */
test("a note far larger than memory is moved aside a window at a time", async () => {
  const { r, frame } = await collision(HIGHER, LOWER);
  const BOUND = 8 << 20;
  const SIZE = 3 * 1024 ** 3;
  // Paths whose size is modelled, mapped to it.
  const modelled = new Map([[NOTE, SIZE]]);
  const stat = r.host.stat.bind(r.host);
  r.host.stat = async (path) => {
    const size = modelled.get(path);
    return size === undefined ? stat(path) : { path, mtime: 2000, size };
  };
  const read = r.host.read.bind(r.host);
  let wholeFileReads = 0;
  r.host.read = async (path) => {
    const size = modelled.get(path);
    if (size !== undefined && size > BOUND) {
      wholeFileReads++;
      throw new Error(`sentinel: ${size} bytes is past what this device can hold`);
    }
    return read(path);
  };
  // One window, reused: the vault hands out a view of it, so what this test
  // holds in memory is one window no matter how large the note is.
  const window = new Uint8Array(BOUND).fill(0x61);
  let widest = 0;
  r.host.source = (path, size) => ({
    size,
    read: async (offset, length) => {
      widest = Math.max(widest, length);
      return window.subarray(0, Math.min(length, window.length));
    },
  });
  const createWriter = r.host.createWriter.bind(r.host);
  let copied = null;
  r.host.createWriter = async (target, size, check) => {
    if (size <= BOUND) return createWriter(target, size, check);
    let written = 0;
    return {
      write: async (bytes) => { check(); written += bytes.length; },
      commit: async (mtime) => {
        check();
        if (modelled.has(target) || r.host.files.has(target)) throw new Error("destination exists");
        modelled.set(target, written);
        copied = { path: target, written };
        return { path: target, mtime, size: written };
      },
      abort: async () => undefined,
    };
  };

  assert.equal(await applyChange(r.context, frame), "applied");

  assert.equal(wholeFileReads, 0, "the whole local note was read into memory to move it");
  assert.notEqual(copied, null, "the local note was never copied to its new name");
  assert.equal(copied.written, SIZE, "the move did not carry the whole note");
  assert.ok(widest <= BOUND, `a window of ${widest} bytes is not a bounded read`);
  // And the ordinary answer still holds: the incoming note has the name, this
  // device's note is at the copy name, recorded dirty for the push to carry.
  assert.equal(r.host.text(NOTE), THEIRS, "the 21-byte incoming version did not take the name");
  assert.equal(r.state.fileByPath(copied.path).fileId, HIGHER);
  assert.equal(r.state.fileByPath(copied.path).mtime, -1);
  assert.ok(r.context.trashed.has(NOTE));
});

/**
 * A device that cannot bind a removal never moves its own note (round 3,
 * finding 1, re-opened).
 *
 * The move is a copy and then a removal, and the removal is only safe where
 * the host can keep the file reachable across the vault's own trash and put
 * it back if a save landed inside it. A phone has no second name to give a
 * file, so it has no way to undo a removal that took a note the user was
 * typing into -- and a narrowed window is not a closed one. So it does not
 * remove anything: the pair is settled the way 1.0.6 settled it, both notes
 * kept, and the incoming note is recorded so its next version updates that
 * copy instead of making another.
 *
 * The cost is a name: this device and the one that CAN move can hold the
 * pair under different names until the mover publishes its rename, which is
 * issue #122's divergence one case wider. It is stated in the changelog.
 */
test("a device that cannot bind a removal keeps both instead of moving its own note", async () => {
  const { r, frame } = await collision(HIGHER, LOWER, { isMobile: true });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), MINE, "this device's own note was moved by a device that cannot move it");
  assert.deepEqual(r.host.trashed, [], "a device that cannot bind a removal removed something");
  const copy = copies(r.host);
  assert.equal(copy.length, 1, "the other device's note was not kept beside it");
  assert.equal(r.host.text(copy[0]), THEIRS);
  assert.equal(r.state.fileByPath(copy[0]).fileId, LOWER, "the copy was not recorded under the incoming id");
  assert.equal(r.state.fileByPath(NOTE).fileId, HIGHER, "this device stopped tracking its own note");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=move_aside_refused reason=unheld")),
    r.host.logs.join(" | "),
  );
  // Nothing was copied aside first, either: a device that will refuse does
  // not fill the vault with a copy of its own note it cannot use.
  assert.equal(copies(r.host).length, 1, "the refusing device also copied its own note aside");
});

/**
 * The same collision on a device that cannot stream (round 3, finding 3)./**
 * The same collision on a device that cannot stream (round 3, finding 3).
 *
 * The window above is a window in THIS file: the loop asks the host for 8 MiB
 * at a time and hands the host 8 MiB at a time. On mobile the host underneath
 * it allocates the declared size in one `Uint8Array` and reads the whole file
 * to serve any range (`main.ts`), so the loop buys nothing there -- a 21-byte
 * incoming version, colliding with a 3 GiB local note, asks a 512 MiB device
 * for a 3 GiB buffer. Admission weighed the INCOMING size and says nothing
 * about the local file.
 *
 * The vault below models the large note rather than allocating one, and fails
 * the test if the move asks for the buffer at all: the refusal has to come
 * BEFORE the allocation and before the read, not from either of them.
 */
test("a local note past this device's ceiling is left where it is", async () => {
  const { r, frame } = await collision(HIGHER, LOWER, { isMobile: true });
  // A host that CAN bind a removal and still buffers whole files. The two
  // capabilities are separate questions and this is the one the ceiling
  // answers: today's phone refuses the move earlier, because it cannot bind
  // the removal at all (below), and this keeps the bound itself proven for
  // any host that answers the first question yes and the second no.
  r.host.bindsRemoval = true;
  const SIZE = 3 * 1024 ** 3;
  const stat = r.host.stat.bind(r.host);
  r.host.stat = async (path) => (path === NOTE ? { path, mtime: 2000, size: SIZE } : stat(path));
  const create = r.host.createWriter.bind(r.host);
  let asked = 0;
  r.host.createWriter = async (path, size, check) => {
    if (size === SIZE) {
      asked++;
      throw new Error("sentinel: a whole-file buffer past this device's ceiling");
    }
    return create(path, size, check);
  };
  const touched = [];
  const source = r.host.source.bind(r.host);
  r.host.source = (path, size) => {
    touched.push(path);
    return source(path, size);
  };
  const read = r.host.read.bind(r.host);
  r.host.read = async (path) => {
    touched.push(path);
    return read(path);
  };

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(asked, 0, "the move asked for a buffer past this device's ceiling");
  assert.ok(!touched.includes(NOTE), "the local note was read whole to copy it");
  assert.equal(r.host.text(NOTE), MINE, "the local note did not stay where it is");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=move_aside_refused reason=per_file")),
    `no ceiling refusal in the log: ${JSON.stringify(r.host.logs)}`,
  );
  assert.ok(
    r.host.notices.some((notice) => notice.includes("512 MiB")),
    `the user was not told which ceiling refused it: ${JSON.stringify(r.host.notices)}`,
  );
  // Nothing is lost by refusing: the other device's version is beside it and
  // this device's note keeps its name, which is what 1.0.6 did for this pair.
  assert.equal(copies(r.host).length, 1);
  assert.equal(r.host.text(copies(r.host)[0]), THEIRS);
});

/**
 * The other end of the same window: the note is rewritten WHILE it is being
 * copied, so the copy itself cannot complete. The create-only writer's byte
 * budget refuses a copy that does not match the size it was opened for, and a
 * source that ends before that size is abandoned rather than committed torn.
 * Both are the same refusal as an edit landing a moment later.
 */
test("a note truncated while it is being copied aside is refused, not torn", async () => {
  const { r, frame } = await collision(HIGHER, LOWER);
  const SHORTER = "gone\n";
  const windows = r.host.source.bind(r.host);
  let served = 0;
  r.host.source = (path, size) => {
    const source = windows(path, size);
    return {
      size,
      read: async (offset, length) => {
        // The first window is served from a note the user has just cut down.
        if (path === NOTE && served++ === 0) r.host.seed(NOTE, SHORTER, 9000);
        return source.read(offset, length);
      },
    };
  };

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), SHORTER, "the note this device holds was not left as the user left it");
  assert.deepEqual(r.host.trashed, [], "a note that could not be copied was trashed anyway");
  assert.deepEqual(
    copies(r.host).filter((path) => path.includes("this device")), [],
    "a torn copy of a moving note was published",
  );
  assert.equal(r.host.text(copies(r.host)[0]), THEIRS, "the other device's note was not kept");
  assert.ok(
    // The exact reason, not a prefix of it: "the note changed before the
    // removal was attempted" and "it changed inside the removal" are two
    // different accounts of two different windows, and the device has to
    // give the one that happened (requirement 12).
    r.host.logs.some((line) => line.includes("decision=move_aside_refused reason=source_changed file=")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

// --- and the same thing, on two engines, from both sides at once ------------

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

/**
 * The push the pull path asks for, while the queue is already making it.
 *
 * Both find a file with no record, both mint a file id and both post it: two
 * files on the server for one note, one of them orphaned by the record the
 * other leaves -- the THIRD id this whole change exists to prevent. The queue
 * and the feed run side by side by design, and this is exactly the moment
 * they meet, so the push is shared rather than repeated.
 */
test("a note the queue is already pushing is not published a second time", async (t) => {
  const { server, timers, a, b } = await pair(t);
  const SAME = "Same name.md";

  a.host.write("Anchor.md", "so both vaults agree first\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Anchor.md") !== null && settled(a, "Anchor.md"));

  a.engine.stop();
  a.host.write(SAME, "the note the desktop made\n", 2000);
  b.host.write(SAME, "the note the phone made\n", 3000);
  await timers.run(STEP_MS, () => settled(b, SAME));

  // Hold the desktop's own push inside its read of that note, so the version
  // from the phone arrives while the queue is still publishing it.
  const held = deferred();
  const entered = deferred();
  const read = a.host.read.bind(a.host);
  let first = true;
  a.host.read = async (path) => {
    if (path === SAME && first) { first = false; entered.resolve(); await held.promise; }
    return read(path);
  };

  await a.engine.start();
  await timers.run(STEP_MS, () => !first);
  await entered.promise;
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.includes("reason=no_record")));
  held.resolve();
  await timers.run(STEP_MS, () => settled(a, SAME) && settled(b, SAME));
  await timers.run(STEP_MS);

  assert.equal(
    server.vaultFiles().length, 3,
    `one note was published under two file ids: ${JSON.stringify([...a.host.files.keys()])}`,
  );
});

/**
 * And the edit that arrives while that shared push is in flight (review round
 * 2, finding 3).
 *
 * Sharing the push is right -- two pushes of one unpublished file mint two
 * file ids -- but the second request is not the first one repeated. The push
 * in flight took its snapshot before that request existed, so what caused the
 * request is not in it: the watcher's trigger for a real edit was consumed by
 * a push that could not carry it, and the engine went idle with the edit still
 * dirty and nothing queued. Nothing is lost locally, and nothing leaves the
 * device either, until something else touches that note.
 *
 * A path asked for while it is being pushed is now remembered, and ONE
 * follow-up push runs when the one in flight finishes.
 */
test("an edit made while a note is being pushed is not left behind", async (t) => {
  const { server, timers, a, keys } = await pair(t);
  const SAME = "Same name.md";
  const MADE = "the note the desktop made\n";
  const LATER = "the note the desktop made, and then edited\n";

  // The note was made while this device was closed, and its FIRST push fails:
  // a moment offline, which is exactly the state in which the feed can deliver
  // a collision for a note that still has no id. The queue empties, so no
  // drain is holding that path when the pull path asks for it.
  a.host.write(SAME, MADE, 2000);
  const read = a.host.read.bind(a.host);
  const held = deferred();
  const entered = deferred();
  let broken = true;
  let waiting = true;
  a.host.read = async (path) => {
    if (path === SAME && broken) {
      broken = false;
      throw new Error("sentinel: the note could not be read");
    }
    const bytes = await read(path);
    // Held AFTER the snapshot -- the stat and the bytes this push will publish
    // are both taken -- which is where a slow upload sits.
    if (path === SAME && waiting) { waiting = false; entered.resolve(); await held.promise; }
    return bytes;
  };
  await a.engine.start();
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.includes("push path_class=file decision=failed")));

  // Now the other device's note of that name arrives. This device has no id
  // for its own note, so the pull path publishes it out of the queue's turn
  // (`identify`), and that publish is the one being held. Its id sorts above
  // anything this device can mint, so this device keeps the name and moves
  // nothing: the only thing that can carry the edit is a push of this path.
  await server.publish({
    fileId: HIGHEST, path: SAME, bytes: enc("the note the phone made\n"), mtime: 3000,
    domainKey: keys.domainKey, manifestKey: keys.manifestKey, deviceId: DEVICE_B,
  });
  await timers.run(STEP_MS, () => !waiting);
  await entered.promise;

  // The user edits the note while that publish is still in flight, and the
  // watcher's debounce and the queue both run to completion on it.
  a.host.write(SAME, LATER, 4000);
  await timers.run(STEP_MS);

  held.resolve();
  await timers.run(STEP_MS, () => settled(a, SAME));
  const record = () => a.state.fileByPath(SAME);
  await timers.run(STEP_MS, () => record()?.size === enc(LATER).length);
  await timers.run(STEP_MS);

  const story = () => `vault=${JSON.stringify([...a.host.files.keys()])} ` +
    `record=${JSON.stringify(record())} versions=${server.journal.length}`;
  assert.equal(a.host.text(SAME), LATER, `the note is not the edited one: ${story()}`);
  // The edit reached the SERVER, which is the only place it could come back
  // from: one of the published versions of this note carries its digest.
  const mine = await published(server, record().fileId, keys.manifestKey);
  assert.ok(
    mine.some((manifest) => manifest.sha256 === digest(LATER)),
    `the edit never left the device: ${JSON.stringify(mine.map((m) => m.size))} ${story()}`,
  );
  // And the engine is not idle with a dirty file: the record agrees with it.
  const stat = await a.host.stat(SAME);
  assert.equal(record().mtime, stat.mtime, `the engine is idle with a dirty file: ${story()}`);
  assert.equal(record().size, stat.size, `the engine is idle with a dirty file: ${story()}`);
  // Two notes and nothing else: the follow-up push is a version of this one,
  // never a second file id for it.
  assert.equal(server.vaultFiles().length, 2, `a third file id was published: ${story()}`);
});

test("two devices that name one note twice converge, and stay converged", async (t) => {
  // TWO DEVICES THAT CAN BOTH MOVE A NOTE ASIDE. Which of the two ids sorts
  // higher is a coin toss -- they are random -- so the device that must move
  // is decided by the draw, and a device that cannot bind a removal keeps
  // both instead (`moveAside`, round 3 finding 1). Converging on ONE pair of
  // names is what this pair can promise; the other pair's answer, and its
  // cost, is the test below.
  const { server, timers, a, b, keys } = await pair(t, "immediate", { isMobileB: false });
  const SAME = "Same name.md";
  const DESKTOP = "the note the desktop made\n";
  const PHONE = "the note the laptop made\n";

  a.host.write("Anchor.md", "so both vaults agree first\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Anchor.md") !== null && settled(a, "Anchor.md"));

  a.engine.stop();
  a.host.write(SAME, DESKTOP, 2000);
  b.host.write(SAME, PHONE, 3000);
  await timers.run(STEP_MS, () => settled(b, SAME));
  await a.engine.start();
  await timers.run(STEP_MS, () =>
    copies(a.host).length >= 1 && copies(b.host).length >= 1 && settled(a, SAME) && settled(b, SAME));
  await timers.run(STEP_MS);

  const story = () => `desktop=${JSON.stringify([...a.host.files.keys()])} ` +
    `phone=${JSON.stringify([...b.host.files.keys()])} versions=${server.journal.length}`;

  // Both notes exist on both devices, under the SAME two names.
  const names = (device) => [...device.host.files.keys()].filter((path) => path !== "Anchor.md").sort();
  assert.deepEqual(names(a), names(b), `the two devices disagree about the names: ${story()}`);
  for (const device of [a, b]) {
    const texts = names(device).map((path) => device.host.text(path)).sort();
    assert.deepEqual(texts, [DESKTOP, PHONE].sort(), `a note is missing: ${story()}`);
  }
  // Two notes, two file ids, and nothing published a third.
  assert.equal(server.vaultFiles().length, 3, `a third file id was published: ${story()}`);
  // Exactly one rename was PUBLISHED, and by the device whose file moved.
  // Measured on the server, not in the logs: a log line is a device's account
  // of its own decision, while the manifests are what the other device will
  // act on, and "one rename" is a claim about those (review round 2,
  // finding 5). One file id's published path changes, exactly once, and it is
  // the higher of the two ids that contested the name.
  const walks = new Map();
  for (const id of server.vaultFiles()) {
    walks.set(id, (await published(server, id, keys.manifestKey)).map((manifest) => manifest.path));
  }
  const story2 = () => JSON.stringify([...walks]);
  const moves = (walk) => walk.filter((path, index) => index > 0 && path !== walk[index - 1]).length;
  const renamed = [...walks].filter(([, walk]) => moves(walk) > 0);
  assert.equal(renamed.length, 1, `not exactly one file id published a rename: ${story2()}`);
  const [mover, walk] = renamed[0];
  assert.equal(moves(walk), 1, `the rename was published more than once: ${story2()}`);
  assert.equal(walk[0], SAME, `the renamed note did not start at the shared name: ${story2()}`);
  assert.notEqual(walk[walk.length - 1], SAME, `the renamed note did not end elsewhere: ${story2()}`);
  const contested = [...walks].filter(([, each]) => each[0] === SAME).map(([id]) => id).sort();
  assert.equal(contested.length, 2, `the pair did not contest one name: ${story2()}`);
  assert.equal(mover, contested[1], `the holder of the LOWER id published the rename: ${story2()}`);
  // And the name it moved to is the one both devices ended up using for it.
  assert.ok(names(a).includes(walk[walk.length - 1]), `the published name is not in the vault: ${story()}`);

  // And a later edit on EITHER side applies plainly on the other: no merge,
  // no new copy. That is what "converged" has to mean.
  const before = [...a.host.files.keys(), ...b.host.files.keys()].length;
  const kept = names(a).find((path) => a.host.text(path) === DESKTOP);
  a.host.write(kept, `${DESKTOP}a later line\n`, 7000);
  await timers.run(STEP_MS, () => b.host.text(kept) === `${DESKTOP}a later line\n`);
  await timers.run(STEP_MS);
  assert.equal(b.host.text(kept), `${DESKTOP}a later line\n`, `a later edit did not reach the phone: ${story()}`);
  assert.equal([...a.host.files.keys(), ...b.host.files.keys()].length, before, `a later edit made a copy: ${story()}`);

  const other = names(b).find((path) => b.host.text(path) === PHONE);
  b.host.write(other, `${PHONE}a later line\n`, 8000);
  await timers.run(STEP_MS, () => a.host.text(other) === `${PHONE}a later line\n`);
  await timers.run(STEP_MS);
  assert.equal(a.host.text(other), `${PHONE}a later line\n`, `a later edit did not reach the desktop: ${story()}`);
  assert.equal([...a.host.files.keys(), ...b.host.files.keys()].length, before, `a later edit made a copy: ${story()}`);
});
