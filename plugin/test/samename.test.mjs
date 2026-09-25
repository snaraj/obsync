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
import { DEVICE_B, KEYS, STEP_MS, digest, pair, published, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, settleBeside } = require("../build/sync/pull.js");
const { pushFile, sidDigest } = require("../build/sync/push.js");
const { conflictCopyPath } = require("../build/sync/conflict.js");
const { QUIET_MS } = require("../build/sync/engine.js");

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

  // Not written over, and not copied either: a descendant arriving over an
  // edit not yet pushed is left for that edit's push, which forks the file,
  // and the fork is settled then (issue #135). Nothing is lost on the way.
  assert.equal(await applyChange(r.context, next), "skipped");
  assert.equal(r.host.text(NOTE), USER, "the save was overwritten by a later version of that id");
  assert.equal(r.state.fileByPath(NOTE).sha256, "", "the save could be pushed as unchanged");
  const pushed = await pushFile(r.context, NOTE);
  await applyChange(r.context, { ...next, heads: r.server.files.get(ours.fileId).heads, conflicted: pushed.ack.conflicted });
  // USER replaces the common ancestor's first line; the peer only appends
  // another line. These adjacent edits now merge. Requiring THEIRS itself
  // to survive would require keeping the base text the user replaced.
  assert.equal(r.host.text(NOTE), `${USER}and another line\n`,
    "the local replacement and the peer's added line did not both survive");
  assert.deepEqual(copies(r.host), [], "independent adjacent edits need no copy");
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
  // A refusal is terminal. The name is free to write into only because the
  // move RENAMED the note out of it, so a device that moved nothing must
  // never reach the write at that name -- not even to find it occupied.
  assert.ok(
    !r.host.logs.some((line) => line.includes("decision=vacated_name_taken")),
    `a move that never happened went on to take the name: ${r.host.logs.filter((line) => line.startsWith("pull")).join(" | ")}`,
  );
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
  // And the refusal is terminal: this device's note is still under its own
  // name, so the write at that name -- which exists only for a name a move
  // VACATED -- must not be attempted at all.
  assert.ok(
    !r.host.logs.some((line) => line.includes("decision=vacated_name_taken")),
    `a refused move went on to take the name: ${r.host.logs.filter((line) => line.startsWith("pull")).join(" | ")}`,
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
    return await read(path);
  };
  // HELD AT THE MANIFEST POST, not inside the read, and the difference is
  // this train's. The push is held so that a second request for this path
  // arrives while it is in flight, which is the only state `pushOne`'s join
  // is about. Held inside the READ, the edit below changes the file under
  // that push -- and from 1.1.0 the end-of-read guard abandons a push whose
  // file moved (#99), so there is no completed push left to join and the
  // mutant that deletes the join survives. The post is after the read, after
  // the chunk upload and after that guard: the bytes and the stat this push
  // will publish are all taken, which is also where a slow upload sits.
  const post = a.transport.postVersion.bind(a.transport);
  a.transport.postVersion = async (...args) => {
    if (waiting) { waiting = false; entered.resolve(); await held.promise; }
    return await post(...args);
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
  // The user edits the note while that publish is still in flight. The
  // watcher's quiet period has to pass before the edit is queued at all
  // (#99), so the clock is advanced through it with the push still held --
  // which is what puts the second request INSIDE the first push.
  a.host.write(SAME, LATER, 4000);
  await timers.run(QUIET_MS + STEP_MS);
  await timers.run(STEP_MS);

  // AND NOT BY THE PERIODIC SCAN. From 1.1.0 a filesystem scan queues a dirty
  // file every `SCAN_MS` (#101), which would make "the edit reached the
  // server" true by a route that has nothing to do with a push in flight.
  // This pins that the scan was not that route. It does NOT prove the join
  // itself: with `pushOne`'s memory deleted the drain still reaches this edit
  // by re-enqueueing it, so no input here tells the two apart -- mutant M25
  // survives at this head and is reported as a finding rather than covered
  // by an assertion that does not discriminate.
  const queuedByScan = () =>
    a.host.logs.filter((line) => /^scan decision=queued .* queued=[1-9]/.test(line)).length;
  const scansBefore = queuedByScan();

  held.resolve();
  await timers.run(STEP_MS, () => settled(a, SAME));
  const record = () => a.state.fileByPath(SAME);
  await timers.run(STEP_MS, () => record()?.size === enc(LATER).length);
  await timers.run(STEP_MS);
  assert.equal(queuedByScan(), scansBefore,
    "the periodic scan carried this edit, so nothing here proves the push join");

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

/*
 * ONE NAME, ONE CONTENT (issue #131).
 *
 * Two devices that start with the same notes -- a vault copied by hand, or one
 * moved over from another sync tool -- publish every note under their own id
 * before either pulls the other's. The rule above kept one and copied the
 * other beside it: a conflict copy of identical bytes for every note. Equal
 * chunk-id digests are equal bytes, so the pair now settles on the lower id
 * with no copy: its holder does nothing, and the holder of the higher id
 * records the name under the lower one and retires its own id.
 */

const SAME_TEXT = "the same note on both devices\n";

/** This device holding `ours` at NOTE, published and recorded clean; and the other device's twin. */
async function twins(ours, theirs, theirText = SAME_TEXT) {
  const r = await rig();
  const bytes = r.host.seed(NOTE, SAME_TEXT, 2000);
  const own = await r.server.publish({
    fileId: ours, path: NOTE, bytes, mtime: 2000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  r.state.setFile(NOTE, {
    fileId: ours, versionId: own.version_id, mtime: 2000, size: bytes.length, sha256: await sidDigest(own.sids),
  });
  const frame = await r.server.publish({
    fileId: theirs, path: NOTE, bytes: enc(theirText), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  return { r, own, frame };
}

const pullLog = (r) => r.host.logs.filter((line) => line.startsWith("pull")).join(" | ");

test("identical notes: the holder of the lower id keeps the name and writes nothing", async () => {
  const { r, own, frame } = await twins(LOWER, HIGHER);
  const before = r.server.journal.length;

  assert.equal(await applyChange(r.context, frame), "skipped");

  assert.deepEqual(copies(r.host), [], `an identical note was copied: ${pullLog(r)}`);
  assert.equal(r.host.text(NOTE), SAME_TEXT);
  assert.equal(r.host.files.get(NOTE).mtime, 2000, "the note was rewritten");
  assert.equal(r.state.fileByPath(NOTE).fileId, LOWER);
  assert.equal(r.state.fileByPath(NOTE).versionId, own.version_id);
  assert.equal(r.state.pathByFileId(HIGHER), undefined, "the duplicate id was recorded");
  assert.equal(r.server.journal.length, before, "the keeping device published something");
  assert.ok(pullLog(r).includes(`decision=converged reason=identical_same_name role=keep keeper=${LOWER}`), pullLog(r));
});

test("identical notes: the holder of the higher id adopts the lower id and retires its own", async () => {
  const { r, own, frame } = await twins(HIGHER, LOWER);

  assert.equal(await applyChange(r.context, frame), "applied");

  assert.deepEqual(copies(r.host), [], `an identical note was copied: ${pullLog(r)}`);
  assert.equal(r.host.text(NOTE), SAME_TEXT);
  assert.equal(r.host.files.get(NOTE).mtime, 2000, "the note was rewritten");
  assert.ok(!r.context.trashed.has(NOTE), "the note was trashed");
  const record = r.state.fileByPath(NOTE);
  assert.equal(record.fileId, LOWER, "the name is not recorded under the id that keeps it");
  assert.equal(record.versionId, frame.version_id);
  assert.equal(record.mtime, 2000);
  assert.equal(r.state.pathByFileId(HIGHER), undefined, "the retired id is still recorded");
  // One tombstone for this device's own id, on the version it recorded: that
  // is what keeps a device paired later from being handed the duplicate.
  const walk = await published(r.server, HIGHER, r.keys.manifestKey);
  assert.equal(walk.length, 2, "the duplicate id was not retired exactly once");
  assert.equal(walk.at(-1).deleted, true);
  assert.deepEqual(r.server.files.get(HIGHER).versions[0].parents, [own.version_id]);
  const lower = await published(r.server, LOWER, r.keys.manifestKey);
  assert.equal(lower.length, 1, "the id that keeps the name was touched");
  assert.ok(
    pullLog(r).includes(`decision=converged reason=identical_same_name role=yield keeper=${LOWER} retired=${HIGHER} tombstone=posted`),
    pullLog(r),
  );
});

test("one differing byte still keeps both notes, from either side", async () => {
  // Same length, so only the content decides.
  const DIFFERENT = "the same note on both devicez\n";
  assert.equal(DIFFERENT.length, SAME_TEXT.length);
  for (const [ours, theirs] of [[LOWER, HIGHER], [HIGHER, LOWER]]) {
    const { r, frame } = await twins(ours, theirs, DIFFERENT);
    await applyChange(r.context, frame);
    const texts = [NOTE, ...copies(r.host)].map((path) => r.host.text(path)).sort();
    assert.deepEqual(texts, [SAME_TEXT, DIFFERENT].sort(), `a note was lost or merged: ${pullLog(r)}`);
    assert.ok(!pullLog(r).includes("identical_same_name"), pullLog(r));
    assert.equal((await published(r.server, HIGHER, r.keys.manifestKey)).at(-1).deleted, false);
  }
});

test("a note with an edit not yet pushed is never taken for its recorded twin", async () => {
  // The record still says the note IS the shared version; the disk says
  // otherwise. Converging would record the edit as a version it is not and
  // retire the id that carries it. Once by mtime, once by size.
  for (const [text, mtime] of [["the same note on both devicex\n", 3000], ["the same note, typed on\n", 2000]]) {
    const { r, frame } = await twins(HIGHER, LOWER);
    r.host.seed(NOTE, text, mtime);
    await applyChange(r.context, frame);
    assert.ok(!pullLog(r).includes("identical_same_name"), pullLog(r));
    assert.equal((await published(r.server, HIGHER, r.keys.manifestKey)).at(-1).deleted, false, "the edited id was retired");
    const texts = [...r.host.files.keys()].map((path) => r.host.text(path));
    assert.ok(texts.includes(text), `the unpushed edit was lost: ${pullLog(r)}`);
  }
});

test("a tombstone that cannot be posted costs a duplicate id, never the note", async () => {
  const { r, frame } = await twins(HIGHER, LOWER);
  const post = r.context.transport.postVersion.bind(r.context.transport);
  r.context.transport.postVersion = async () => { throw new Error("offline"); };

  assert.equal(await applyChange(r.context, frame), "applied");
  r.context.transport.postVersion = post;

  assert.deepEqual(copies(r.host), []);
  assert.equal(r.host.text(NOTE), SAME_TEXT);
  assert.equal(r.state.fileByPath(NOTE).fileId, LOWER);
  assert.equal((await published(r.server, HIGHER, r.keys.manifestKey)).length, 1);
  assert.ok(pullLog(r).includes("tombstone=failed"), pullLog(r));
});

test("two devices that start with the same note converge on one, with no copy", async (t) => {
  const { server, timers, a, b, keys } = await pair(t, "immediate", { isMobileB: false });
  const WELCOME = "Welcome.md";
  const TEXT = "the note both vaults already held\n";

  a.host.write(WELCOME, TEXT, 1000);
  b.host.write(WELCOME, TEXT, 1500);
  await a.engine.start();
  await timers.run(STEP_MS, () => settled(a, WELCOME));
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(b, WELCOME) && settled(a, WELCOME));
  await timers.run(STEP_MS);

  const story = () => `desktop=${JSON.stringify([...a.host.files.keys()])} ` +
    `laptop=${JSON.stringify([...b.host.files.keys()])} versions=${server.journal.length}`;
  for (const device of [a, b]) {
    assert.deepEqual([...device.host.files.keys()], [WELCOME], `a copy was made: ${story()}`);
    assert.equal(device.host.text(WELCOME), TEXT);
  }
  assert.equal(a.state.fileByPath(WELCOME).fileId, b.state.fileByPath(WELCOME).fileId, `the devices track different ids: ${story()}`);
  // One live note on the server: any second id is retired.
  const live = [];
  for (const id of await server.noteFiles(keys.manifestKey)) {
    if (!(await published(server, id, keys.manifestKey)).at(-1).deleted) live.push(id);
  }
  assert.equal(live.length, 1, `not exactly one live note: ${story()}`);

  // And a later edit on either side applies plainly on the other.
  a.host.write(WELCOME, `${TEXT}a later line\n`, 7000);
  await timers.run(STEP_MS, () => b.host.text(WELCOME) === `${TEXT}a later line\n`);
  await timers.run(STEP_MS);
  b.host.write(WELCOME, `${TEXT}a later line\nand another\n`, 8000);
  await timers.run(STEP_MS, () => a.host.text(WELCOME) === `${TEXT}a later line\nand another\n`);
  await timers.run(STEP_MS);
  for (const device of [a, b]) {
    assert.deepEqual([...device.host.files.keys()], [WELCOME], `a later edit made a copy: ${story()}`);
  }
});

/*
 * THE SAME PAIR, MADE BY ONE DEVICE'S OWN QUEUE (issue #131). A note this
 * device never published is being pushed when the pull adopts another
 * device's version of the same bytes at that name. Posting on would publish
 * the note twice, and recording the post would replace the adoption.
 */

/** A rig holding NOTE unpublished, and an adoption of `adoptedId` ready to land mid-push. */
async function adoptionRace(adoptedId) {
  const r = await rig();
  const bytes = r.host.seed(NOTE, SAME_TEXT, 2000);
  const other = await r.server.publish({
    fileId: adoptedId, path: NOTE, bytes, mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const adopt = async () => r.state.setFile(NOTE, {
    fileId: adoptedId, versionId: other.version_id, mtime: 2000, size: bytes.length, sha256: await sidDigest(other.sids),
  });
  return { r, other, adopt };
}

test("an adoption that lands while the push reads it publishes nothing", async () => {
  const { r, other, adopt } = await adoptionRace(HIGHER);
  const read = r.host.read.bind(r.host);
  r.host.read = async (path) => { const bytes = await read(path); await adopt(); return bytes; };
  const before = r.server.vaultFiles().length;

  const outcome = await pushFile(r.context, NOTE);

  assert.equal(outcome.status, "unchanged");
  assert.equal(outcome.fileId, HIGHER);
  assert.equal(r.server.vaultFiles().length, before, "the note was published under a second id");
  assert.equal(r.state.fileByPath(NOTE).versionId, other.version_id, "the adoption was replaced");
  assert.ok(r.host.logs.some((line) => line.includes("reason=recorded_during_read")), r.host.logs.join(" | "));
});

for (const [adoptedId, role] of [["00".repeat(16), "keep"], ["ff".repeat(16), "yield"]]) {
  test(`an adoption that lands while the push posts settles the pair on the lower id (${role})`, async () => {
    const { r, other, adopt } = await adoptionRace(adoptedId);
    const post = r.context.transport.postVersion.bind(r.context.transport);
    let posted = null;
    r.context.transport.postVersion = async (fileId, version) => {
      const sent = await post(fileId, version);
      if (posted === null && fileId !== adoptedId) { posted = fileId; await adopt(); }
      return sent;
    };

    const outcome = await pushFile(r.context, NOTE);

    assert.ok(posted !== null, "the push posted nothing, so the window was never reached");
    const [keeper, loser] = [adoptedId, posted].sort();
    assert.equal(r.state.fileByPath(NOTE).fileId, keeper, "the name is not recorded under the lower id");
    assert.equal(outcome.fileId, keeper);
    assert.equal(r.host.text(NOTE), SAME_TEXT);
    // The higher id is retired, once, on the version this device knew; the
    // lower keeps every version it had.
    const lost = await published(r.server, loser, r.keys.manifestKey);
    assert.equal(lost.at(-1).deleted, true, "the higher id was not retired");
    assert.equal(lost.filter((manifest) => manifest.deleted).length, 1);
    assert.equal((await published(r.server, keeper, r.keys.manifestKey)).at(-1).deleted, false, "the lower id was retired");
    const known = loser === adoptedId ? other.version_id : r.server.files.get(loser).versions[1].version_id;
    assert.deepEqual(r.server.files.get(loser).versions[0].parents, [known]);
    assert.ok(
      r.host.logs.some((line) => line.includes(`reason=recorded_during_post role=${role} keeper=${keeper} retired=${loser} tombstone=posted`)),
      r.host.logs.join(" | "),
    );
  });
}

test("a record that names no version is never retired, however alike the bytes", async () => {
  const { r, frame } = await twins(HIGHER, LOWER);
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: "" });
  await applyChange(r.context, frame);
  assert.ok(!pullLog(r).includes("identical_same_name"), pullLog(r));
  assert.equal((await published(r.server, HIGHER, r.keys.manifestKey)).at(-1).deleted, false);
});

for (const window of ["read", "post"]) {
  for (const [adoptedId, role] of [["00".repeat(16), "lower"], ["ff".repeat(16), "higher"]]) {
    test(`a record of other bytes landing during the push ${window} is not deduplicated (${role} id)`, async () => {
      const r = await rig();
      r.host.seed(NOTE, MINE, 2000);
      const bytes = enc(THEIRS);
      const other = await r.server.publish({ fileId: adoptedId, path: NOTE, bytes, mtime: 4000,
        domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
      const adopt = async () => r.state.setFile(NOTE, {
        fileId: adoptedId, versionId: other.version_id, mtime: 4000,
        size: bytes.length, sha256: await sidDigest(other.sids),
      });
      if (window === "read") {
        const read = r.host.read.bind(r.host);
        r.host.read = async path => { const result = await read(path); await adopt(); return result; };
      }
      const post = r.transport.postVersion.bind(r.transport);
      let posted;
      r.transport.postVersion = async (id, version) => {
        const result = await post(id, version);
        if (posted === undefined && id !== adoptedId) {
          posted = id;
          if (window === "post") await adopt();
        }
        return result;
      };

      const outcome = await pushFile(r.context, NOTE);
      assert.ok(posted !== undefined, "the intended upload boundary was not reached");
      assert.equal(role === "lower" ? adoptedId < posted : adoptedId > posted, true);
      assert.equal(outcome.status, "pushed", "a push was dropped for a record of other bytes");
      assert.equal(outcome.fileId, posted);
      assert.equal(r.host.text(NOTE), MINE);
      assert.equal(r.server.journal.some(frame => frame.deleted), false, "different content was retired as a duplicate");
      for (const id of [adoptedId, posted]) assert.equal(r.server.files.get(id).versions[0].deleted, false);
      assert.equal((await r.reload()).fileByPath(NOTE).fileId, posted);
      assert.ok(!r.host.logs.some(line => /reason=recorded_during_(read|post)/.test(line)), r.host.logs.join(" | "));
    });
  }
}

/*
 * ONE NOTE, TWO IDS, ACROSS VERSIONS (issue #147).
 *
 * The rule above leaves the pair's HIGHER id to its own device to retire, and
 * a device on 1.1.1 has no such rule: it goes on editing the note under its
 * own id. The holder of the lower id waited for a retirement that never came,
 * and every later edit met the name as a collision -- a conflict copy each
 * time, which updating the older device did not stop, because both feeds were
 * past the pair. An EDIT of the twin is what settles it: its parent held these
 * very bytes at this very name, so the device that made it holds that id and
 * is not retiring it.
 */

const SHARED = "Shared.md";

/**
 * S13 after its first step. Both vaults hold the note: the desktop (a) under
 * the LOWER id, which it keeps as the #131 rule says, retiring nothing; the
 * laptop (b) under the HIGHER id, which it never retires. b stands for 1.1.1:
 * its feed is past a's version and it tracks its own, which is where 1.1.1
 * left the real laptop, and what it does from here -- publish its edits under
 * that id, pass over a tombstone for an id it does not track, apply a version
 * of the id it tracks -- is what 1.1.1 does too.
 */
async function skewed(t) {
  const { server, timers, a, b, keys } = await pair(t, "immediate", { isMobileB: false });
  const bytes = enc(SAME_TEXT);
  const versions = {};
  for (const [device, fileId, deviceId, mtime] of [[a, LOWER, KEYS.deviceId, 1000], [b, HIGHER, DEVICE_B, 1500]]) {
    device.host.write(SHARED, SAME_TEXT, mtime);
    const version = await server.publish({
      fileId, path: SHARED, bytes, mtime, deviceId, domainKey: keys.domainKey, manifestKey: keys.manifestKey,
    });
    device.state.setFile(SHARED, {
      fileId, versionId: version.version_id, mtime, size: bytes.length, sha256: await sidDigest(version.sids),
    });
    versions[fileId] = version;
  }
  a.state.data.lastSeq = versions[LOWER].seq;
  b.state.data.lastSeq = server.seq;
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.includes("identical_same_name role=keep")));
  const story = () => `desktop=${JSON.stringify([...a.host.files.keys()])} laptop=${JSON.stringify([...b.host.files.keys()])} ` +
    `| desktop: ${pullLog(a)} | laptop: ${pullLog(b)}`;
  return { server, timers, a, b, keys, versions, story };
}

/** One edit on `from`, waited for on `to` until it lands at the name or beside it. */
async function edit(timers, from, to, text, mtime) {
  from.host.write(SHARED, text, mtime);
  await timers.run(STEP_MS, () => to.host.text(SHARED) === text || copies(to.host).length > 0);
  await timers.run(STEP_MS);
}

/** One id for the note on both devices, the same text, and no copy anywhere. */
function one(a, b, text, story) {
  for (const device of [a, b]) {
    assert.deepEqual(copies(device.host), [], `a copy was made: ${story()}`);
    assert.equal(device.host.text(SHARED), text, `the edit did not reach the note: ${story()}`);
  }
  assert.equal(a.state.fileByPath(SHARED).fileId, b.state.fileByPath(SHARED).fileId, `the devices track different ids: ${story()}`);
  return a.state.fileByPath(SHARED).fileId;
}

test("mixed versions: the older device's edit settles the pair on its id, with no copy", async (t) => {
  const { server, timers, a, b, keys, versions, story } = await skewed(t);
  const FROM_B = `${SAME_TEXT}typed on the laptop\n`;

  await edit(timers, b, a, FROM_B, 3000);

  assert.equal(one(a, b, FROM_B, story), HIGHER, `the pair did not settle on the id the laptop edits: ${story()}`);
  // The desktop retired its own id once, on the version it recorded; the
  // laptop's id carries every version it had.
  const lower = await published(server, LOWER, keys.manifestKey);
  assert.equal(lower.filter((manifest) => manifest.deleted).length, 1, `the desktop's id was not retired once: ${story()}`);
  assert.deepEqual(server.files.get(LOWER).versions[0].parents, [versions[LOWER].version_id]);
  assert.equal((await published(server, HIGHER, keys.manifestKey)).at(-1).deleted, false);
  assert.ok(pullLog(a).includes(`decision=converged reason=edited_twin keeper=${HIGHER} retired=${LOWER} tombstone=posted`), story());

  // And every later edit, from either side, is an ordinary update.
  const FROM_A = `${FROM_B}and on the desktop\n`;
  await edit(timers, a, b, FROM_A, 4000);
  one(a, b, FROM_A, story);
  const AGAIN = `${FROM_A}and the laptop again\n`;
  await edit(timers, b, a, AGAIN, 5000);
  assert.equal(one(a, b, AGAIN, story), HIGHER);
});

test("an update in place: once the older device runs this version, the newer device's edit settles the pair too", async (t) => {
  const { server, timers, a, b, keys, versions, story } = await skewed(t);
  // The laptop is updated where it stands: same device, same state, a new
  // engine. Nothing re-meets the pair -- both feeds are past it -- so the two
  // ids are still two after the restart, exactly as on the real laptop.
  b.engine.stop();
  await b.engine.start();
  await timers.run(STEP_MS);
  assert.notEqual(a.state.fileByPath(SHARED).fileId, b.state.fileByPath(SHARED).fileId, "precondition: the pair is split");
  const FROM_A = `${SAME_TEXT}typed on the desktop\n`;

  await edit(timers, a, b, FROM_A, 3000);

  assert.equal(one(a, b, FROM_A, story), LOWER, `the pair did not settle on the id the desktop edits: ${story()}`);
  const higher = await published(server, HIGHER, keys.manifestKey);
  assert.equal(higher.filter((manifest) => manifest.deleted).length, 1, `the laptop's id was not retired once: ${story()}`);
  assert.deepEqual(server.files.get(HIGHER).versions[0].parents, [versions[HIGHER].version_id]);
  assert.ok(pullLog(b).includes(`decision=converged reason=edited_twin keeper=${LOWER} retired=${HIGHER} tombstone=posted`), story());

  const FROM_B = `${FROM_A}and on the laptop\n`;
  await edit(timers, b, a, FROM_B, 4000);
  assert.equal(one(a, b, FROM_B, story), LOWER);
});

const EDIT = `${SAME_TEXT}and a line typed on the other device\n`;

/**
 * This device holding `ours` at NOTE, clean; the other device's `theirs` made
 * as a twin of it and then edited, unseen here until the edit arrives.
 */
async function editedTwin(ours, theirs, { parentText = SAME_TEXT, parentPath = NOTE, parentKey } = {}) {
  const r = await rig();
  const bytes = r.host.seed(NOTE, SAME_TEXT, 2000);
  const own = await r.server.publish({
    fileId: ours, path: NOTE, bytes, mtime: 2000, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  r.state.setFile(NOTE, {
    fileId: ours, versionId: own.version_id, mtime: 2000, size: bytes.length, sha256: await sidDigest(own.sids),
  });
  const parent = await r.server.publish({
    fileId: theirs, path: parentPath, bytes: enc(parentText), mtime: 3000,
    domainKey: r.keys.domainKey, manifestKey: parentKey ?? r.keys.manifestKey,
  });
  const frame = await r.server.publish({
    fileId: theirs, path: NOTE, bytes: enc(EDIT), mtime: 5000, parents: [parent.version_id],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  return { r, own, frame };
}

test("an edit of the twin is taken as an update, from either side, and only this device's id is retired", async () => {
  for (const [ours, theirs] of [[LOWER, HIGHER], [HIGHER, LOWER]]) {
    const { r, own, frame } = await editedTwin(ours, theirs);

    assert.equal(await applyChange(r.context, frame), "applied", pullLog(r));

    assert.deepEqual(copies(r.host), [], `the twin's edit was copied: ${pullLog(r)}`);
    assert.equal(r.host.text(NOTE), EDIT, "the edit did not reach the note");
    const record = r.state.fileByPath(NOTE);
    assert.equal(record.fileId, theirs, "the name is not recorded under the id that was edited");
    assert.equal(record.versionId, frame.version_id);
    assert.equal(r.state.pathByFileId(ours), undefined, "the retired id is still recorded");
    const walk = await published(r.server, ours, r.keys.manifestKey);
    assert.equal(walk.length, 2, "this device's id was not retired exactly once");
    assert.equal(walk.at(-1).deleted, true);
    assert.deepEqual(r.server.files.get(ours).versions[0].parents, [own.version_id]);
    assert.equal((await published(r.server, theirs, r.keys.manifestKey)).at(-1).deleted, false, "the edited id was retired");
  }
});

test("an edit that is not provably of this very note keeps both, and retires nothing", async () => {
  const cases = {
    "a different note": { parentText: THEIRS },
    "a twin somewhere else": { parentPath: "Notes/Elsewhere.md" },
    "a parent this vault cannot read": { parentKey: new Uint8Array(32).fill(7) },
    "an unpushed edit here": { local: "the same note on both devices, and typed on here\n" },
  };
  for (const [name, { local, ...options }] of Object.entries(cases)) {
    const { r, frame } = await editedTwin(LOWER, HIGHER, options);
    if (local !== undefined) r.host.seed(NOTE, local, 2500);

    await applyChange(r.context, frame);

    const texts = [...r.host.files.keys()].map((path) => r.host.text(path)).sort();
    assert.deepEqual(texts, [EDIT, local ?? SAME_TEXT].sort(), `${name}: a note was lost or merged: ${pullLog(r)}`);
    assert.equal((await published(r.server, LOWER, r.keys.manifestKey)).at(-1).deleted, false, `${name}: this device's id was retired`);
    assert.ok(!pullLog(r).includes("edited_twin"), `${name}: ${pullLog(r)}`);
  }
});

// --- beside is temporary (issue #149) ----------------------------------------

/**
 * The vault has reported the copy this device wrote. The engine consumes
 * that echo when the vault's own event for the write arrives; this rig has
 * no engine, so the test says when it happened.
 */
const reported = (r) => r.context.written.clear();

/** The other device renames this device's own note at the name to another. */
const renameAway = (r) => r.server.publish({
  fileId: LOWER, path: OTHER, bytes: enc(MINE), mtime: 7000, parents: [r.state.fileByPath(NOTE).versionId],
  domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
});

test("a copy beside its name takes it as soon as the note holding the name is renamed away", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];
  assert.equal(r.state.fileByPath(copy).name, NOTE, "the copy does not remember the name it waits for");
  assert.equal((await r.reload()).fileByPath(copy).name, NOTE, "and a restart forgets it");
  reported(r);
  // Waiting is not a refusal: while the name is held, nothing is tried or said.
  await settleBeside(r.context, 0);
  assert.equal(r.host.logs.filter((line) => line.includes("beside")).length, 0, pullLog(r));

  assert.equal(await applyChange(r.context, await renameAway(r)), "applied");

  assert.equal(r.host.text(OTHER), MINE, "the rename did not land");
  assert.equal(r.host.text(NOTE), THEIRS, `the copy did not take its name: ${pullLog(r)}`);
  assert.equal(r.host.text(copy), null, "and left a duplicate behind");
  assert.equal(r.state.pathByFileId(HIGHER), NOTE);
  assert.equal(r.state.fileByPath(NOTE).name, undefined, "it still waits for the name it has");
  assert.deepEqual(r.host.trashed, [], "a move trashed something");
  assert.ok(r.host.logs.some((line) => line === `pull path_class=file decision=renamed_from_beside file=${HIGHER} seq=${r.server.seq}`),
    pullLog(r));
});

test("a name another record still holds is not taken, even once its file is gone", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];
  reported(r);
  // Deleted here, and its deletion not published yet: its record still
  // stands, and it is what that tombstone is posted from.
  r.host.files.delete(NOTE);
  await settleBeside(r.context, 0);
  assert.equal(r.host.text(copy), THEIRS);
  assert.equal(r.state.fileByPath(NOTE)?.fileId, LOWER, "the record of a deletion still to be published was replaced");
});

test("a copy beside its name that holds an unpushed edit stays where it is", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];
  reported(r);
  r.host.seed(copy, "the user's own words\n", 9000);

  assert.equal(await applyChange(r.context, await renameAway(r)), "applied");

  assert.equal(r.host.text(copy), "the user's own words\n", "an unpushed edit was moved to another name");
  assert.equal(r.host.text(NOTE), null);
  assert.equal(r.state.pathByFileId(HIGHER), copy);
});

test("a move to the freed name that fails is logged, and the version that freed it stays applied", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];
  reported(r);
  const move = r.host.move.bind(r.host);
  r.host.move = async (from, to) => {
    if (from === copy) throw new Error("the disk refused");
    return move(from, to);
  };

  assert.equal(await applyChange(r.context, await renameAway(r)), "applied");

  assert.equal(r.host.text(OTHER), MINE);
  assert.equal(r.host.text(copy), THEIRS);
  assert.ok(r.host.logs.includes(`pull path_class=file decision=beside_kept reason=failed file=${HIGHER} seq=${r.server.seq}`),
    pullLog(r));
});

/**
 * NOT BEFORE THE VAULT HAS REPORTED ITS OWN WRITE. That report can come after
 * a move, and a move whose echo it clears is read as the user renaming
 * whichever note the pull has put at that name since. So a copy whose write
 * is still unreported waits, and moves at the next pass after the report.
 */
test("a copy beside its name waits for the vault to report its write before it moves", async () => {
  const { r, frame } = await collision(LOWER, HIGHER);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copies(r.host)[0];

  assert.equal(await applyChange(r.context, await renameAway(r)), "applied");
  assert.equal(r.host.text(copy), THEIRS, "a copy moved before its write was reported");
  assert.equal(r.host.text(NOTE), null);

  reported(r);
  await settleBeside(r.context, 0);
  assert.equal(r.host.text(NOTE), THEIRS, pullLog(r));
  assert.equal(r.state.pathByFileId(HIGHER), NOTE);
});

const DRAFT_TEXT = "the draft\n";
const FINAL_TEXT = "the final text, longer\n";

/**
 * A swap as the other device publishes it: this device's two notes, Draft and
 * Final, and the two versions that trade their names. The note that was Final
 * holds the LOWER id and arrives first, so the same-name rule, were it asked,
 * would move the note it waits on.
 */
async function swapped() {
  const r = await rig();
  r.host.seed("Notes/Draft.md", DRAFT_TEXT, 1000);
  r.host.seed("Notes/Final.md", FINAL_TEXT, 1000);
  r.state.setFile("Notes/Draft.md", { fileId: HIGHER, versionId: "", mtime: -1, size: 0, sha256: "" });
  r.state.setFile("Notes/Final.md", { fileId: LOWER, versionId: "", mtime: -1, size: 0, sha256: "" });
  await pushFile(r.context, "Notes/Draft.md");
  await pushFile(r.context, "Notes/Final.md");
  const version = (fileId, path, text, from) => r.server.publish({
    fileId, path, bytes: enc(text), mtime: 1000, parents: [r.state.fileByPath(from).versionId],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const first = await version(LOWER, "Notes/Draft.md", FINAL_TEXT, "Notes/Final.md");
  const second = await version(HIGHER, "Notes/Final.md", DRAFT_TEXT, "Notes/Draft.md");
  r.server.requests.length = 0;
  assert.equal(await applyChange(r.context, first), "applied");
  assert.equal(r.state.fileByPath("Notes/Final.md").name, "Notes/Draft.md", "the first version did not wait beside its name");
  return { r, second };
}

/** Both notes under the names the other device gave them, and nothing else. */
function swappedNames(r) {
  assert.equal(r.host.text("Notes/Draft.md"), FINAL_TEXT, pullLog(r));
  assert.equal(r.host.text("Notes/Final.md"), DRAFT_TEXT, pullLog(r));
  assert.equal(r.state.fileByPath("Notes/Draft.md").fileId, LOWER);
  assert.equal(r.state.fileByPath("Notes/Final.md").fileId, HIGHER);
  assert.equal(Object.values(r.state.data.files).filter((record) => record.name !== undefined).length, 0);
  assert.deepEqual(r.host.trashed, [], "a swap trashed a note");
}

test("a swap that arrives as two versions ends with each note under its new name", async () => {
  const { r, second } = await swapped();
  assert.equal(await applyChange(r.context, second), "applied");
  swappedNames(r);
  // Names only: nothing was downloaded or written for either (issue #108).
  assert.deepEqual(r.server.requests.filter((request) => request.method === "GET" && request.target.startsWith("/v1/chunks")),
    [], pullLog(r));
  assert.deepEqual(copies(r.host), []);
  assert.ok(r.host.logs.includes(`pull path_class=file decision=parked_beside outcome=moved file=${LOWER} seq=${second.seq}`),
    pullLog(r));
});

test("the note waiting at a name steps aside to the next free name when the first is taken", async () => {
  const { r, second } = await swapped();
  // Either note of the pair may be the one that steps aside: the first name
  // each would take is taken.
  const taken = ["Notes/Draft.md", "Notes/Final.md"].map((path) => conflictCopyPath(path, "this device", new Date(r.host.clock), 1));
  for (const path of taken) r.host.seed(path, "a note the user keeps under that name\n", 500);
  assert.equal(await applyChange(r.context, second), "applied");
  swappedNames(r);
  for (const path of taken) assert.equal(r.host.text(path), "a note the user keeps under that name\n");
  assert.deepEqual(copies(r.host).sort(), [...taken].sort());
});

test("a note waiting at a name that holds an unpushed edit is not moved for the version that wants the name", async () => {
  const { r, second } = await swapped();
  r.host.seed("Notes/Final.md", `${FINAL_TEXT}typed here\n`, 9000);
  await applyChange(r.context, second);
  assert.equal(r.host.text("Notes/Final.md"), `${FINAL_TEXT}typed here\n`, "the edit was moved or replaced");
  assert.equal(r.state.fileByPath("Notes/Final.md").fileId, LOWER);
  assert.equal(r.state.pathByFileId(HIGHER), "Notes/Draft.md");
  assert.equal(r.state.fileByPath("Notes/Draft.md").name, "Notes/Final.md", pullLog(r));
});
