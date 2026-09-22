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
import { STEP_MS, pair, rig, settled } from "./fake.mjs";

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
async function collision(ours, theirs) {
  const r = await rig();
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
    r.host.logs.some((line) => line.includes("decision=move_aside_refused reason=source_changed")),
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
    r.host.logs.some((line) => line.includes("decision=move_aside_refused reason=source_changed")),
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



test("two devices that name one note twice converge, and stay converged", async (t) => {
  const { server, timers, a, b } = await pair(t);
  const SAME = "Same name.md";
  const DESKTOP = "the note the desktop made\n";
  const PHONE = "the note the phone made\n";

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
  // At most one rename was published: one version of one id carries a path
  // that is not the one it was created under.
  const renames = a.host.logs.concat(b.host.logs).filter((line) => line.includes("role=rename"));
  assert.equal(renames.length, 1, `${renames.length} devices renamed: ${renames.join(" | ")}`);

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
