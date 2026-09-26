/**
 * Two devices, one server, one of them closed while the other writes (#98).
 *
 * THE INVARIANT. A pull must never replace bytes that no version on the server
 * contains. Everything else here is a way of arranging those bytes: a note
 * typed while the app was closed, a note edited between the vault event and
 * the push that would carry it, a note created under a name another device
 * chose at the same moment. In every one of them the local content exists on
 * exactly one device, so a write over it is not a sync decision at all -- it
 * is a deletion with no undo, and not even the server's history can give it
 * back, because the server was never told.
 *
 * WHY THE SERVER CANNOT HELP. obsyncd flags a file `conflicted` when a posted
 * version's parents are not its current heads. A device that was closed posted
 * nothing, so the version the other device wrote is an honest, unforked child
 * of the parent this device last recorded: the feed hands it over with
 * `conflicted: false` and every field agreeing. The competing edit is visible
 * only HERE, in the gap between a local file and the record this device keeps
 * of what it last pushed for it.
 *
 * WHAT IS AND IS NOT A PLATFORM HERE. The device-level tests run the same
 * hand-written vault twice, one configured desktop (`isMobile` false,
 * concurrency 4) and one mobile (`isMobile` true, concurrency 2), so what they
 * exercise is the real engine, the real transport signing and the real
 * `registerVaultEvents` on both configurations. `ObsidianHost` -- the Node
 * `fs` writer, the adapter writer, `FileManager.trashFile` -- is NOT
 * exercised, and neither is either platform's native event timing; those stay
 * a real-device acceptance run (`docs/validation.md`). The decision this file
 * is about lives in `sync/`, above the `VaultHost` port, and needs only
 * `host.stat`, which both hosts already implement.
 *
 * The two-device rig, the vault that answers back and the virtual clock all
 * live in `fake.mjs`; `rename.test.mjs` drives the same two devices.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { basename, join } from "node:path";
import { DEVICE_B, STEP_MS, pair, rig, sandbox, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { conflictCopyPath } = require("../build/sync/conflict.js");

const enc = (text) => new TextEncoder().encode(text);

const ANCHOR = "# An anchor note\nso both vaults are known to agree first\n";
const BASE = "# Shared note\nthe line both devices start from\n";
const DESKTOP_LINE = "a line typed on the desktop while the app was closed\n";
const PHONE_LINE = "a line typed on the phone in the meantime\n";
const DESKTOP_NEW = "a note the desktop made while it was closed\n";
const PHONE_NEW = "a different note the phone made under the same name\n";
const SHARED = "Shared.md";
const SAME = "Same name.md";
const NOTE = "Notes/One.md";
const MOVED = "Notes/Two.md";
const MINE = "the bytes this device has and the server does not\n";
const THEIRS = "the bytes the other device published\n";
const THEIRS_AGAIN = "the bytes the other device published next\n";
const EDITED = "the bytes the user typed into the conflict copy\n";
const SQUATTER = "a note the user already kept under that name\n";
// Two sentinels of EXACTLY the same length, and one that is longer at the
// same modification time: the two halves of the stat comparison, separated.
const EQUAL_OLD = "sentinel line one\n";
const EQUAL_NEW = "sentinel line two\n";
const LONGER = "sentinel line one, with more after it\n";

/** The name a conflict copy of `path` takes on its `attempt`-th try here. */
const copyName = (r, path, attempt) => conflictCopyPath(path, "iPhone", new Date(r.host.clock), attempt);

/** One version published by the other device, over `rig`'s fixture keys. */
const foreign = (r, { fileId, path, text, mtime, parents = [] }) => r.server.publish({
  fileId, path, bytes: enc(text), mtime, parents,
  domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
});

/** Every conflict copy in a vault, which is where a kept version lands. */
const copies = (host) => [...host.files.keys()].filter((path) => path.includes("(conflict from"));

/**
 * Every version the server holds, decrypted the way another device reads it.
 *
 * This is the second half of the invariant and it cannot be taken on trust: a
 * device that kept its own bytes but never published them has only moved the
 * loss to the next reinstall. Reading the ciphertext back proves the content
 * really is on the server, and it proves it through the real manifest key and
 * the real chunk key rather than through a counter of journal frames.
 */
async function published(server, k) {
  const out = [];
  for (const frame of server.journal) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const json = await c.decryptManifest(
      k.manifestKey,
      frame.file_id,
      binder,
      c.unhex(frame.manifest_nonce),
      c.unbase64(frame.manifest_ct),
    );
    const manifest = JSON.parse(json);
    const parts = [];
    for (const chunk of manifest.chunks) {
      parts.push(await c.decryptChunk(k.domainKey, c.unhex(chunk.cid), server.chunks.get(chunk.sid)));
    }
    out.push({ path: manifest.path, text: parts.map((part) => new TextDecoder().decode(part)).join("") });
  }
  return out;
}

/** Does the server hold a version carrying exactly these bytes? */
const holds = (versions, text) => versions.some((version) => version.text === text);

/**
 * Wait for the resolution -- or stop the moment the local bytes are gone, so
 * the assertion that follows reports the note that was replaced instead of a
 * ten-second timeout for a conflict copy that is never coming.
 */
const kept = (host, path, text, condition) => () => host.text(path) !== text || condition();

/** What the two devices did to each other, for a failure that has to be read. */
const story = (server, a, b) =>
  [`journal=${server.journal.length}`,
    `desktop_files=${JSON.stringify([...a.host.files.keys()])}`,
    `phone_files=${JSON.stringify([...b.host.files.keys()])}`,
    `desktop_decisions=${a.host.logs.filter((line) => line.startsWith("pull")).join(" / ")}`].join(" ");

// --- the two device-level shapes reported on real devices -------------------

test("a note written while this device was closed survives one the other device made at the same path", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  // One note both devices already agree on, so what follows is the only
  // divergence in the vault.
  a.host.write("Anchor.md", ANCHOR, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text("Anchor.md") === ANCHOR && settled(a, "Anchor.md") && settled(b, "Anchor.md"));

  // The desktop app is closed. Its user writes a note the plugin has never
  // seen: no record, nothing on the server, nothing anywhere else.
  a.engine.stop();
  a.host.write(SAME, DESKTOP_NEW, 2000);

  // The phone, still running, creates a DIFFERENT note under that same name.
  b.host.write(SAME, PHONE_NEW, 3000);
  await timers.run(STEP_MS, () => settled(b, SAME));

  // The desktop comes back.
  await a.engine.start();
  await timers.run(STEP_MS, () =>
    copies(a.host).length >= 1 && copies(b.host).length >= 1 && settled(a, SAME) && settled(b, SAME));
  await timers.run(STEP_MS);

  // Neither device's bytes were replaced, and both notes are on both devices.
  // WHICH name each ends up under is the tie-break's business and has its own
  // suite (`samename.test.mjs`); what this one holds is that nothing is lost.
  for (const device of [a, b]) {
    const texts = [...device.host.files.keys()].map((path) => device.host.text(path));
    assert.ok(texts.includes(DESKTOP_NEW), `the desktop's note is missing on one device: ${story(server, a, b)}`);
    assert.ok(texts.includes(PHONE_NEW), `the phone's note is missing on one device: ${story(server, a, b)}`);
  }

  const versions = await published(server, k);
  assert.ok(holds(versions, DESKTOP_NEW), `the desktop's bytes reached no version: ${story(server, a, b)}`);
  assert.ok(holds(versions, PHONE_NEW));
  assert.equal(server.vaultFiles().length, 3, "two notes sharing a name are two files, plus the anchor");
});

test("an edit made while this device was closed survives one the other device made to the same note", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  a.host.write(SHARED, BASE, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text(SHARED) === BASE && settled(a, SHARED) && settled(b, SHARED));
  const before = a.state.fileByPath(SHARED).versionId;
  assert.equal(b.state.fileByPath(SHARED).versionId, before, "one note, one version, on both devices");

  // The desktop app is closed. Its user appends a line to the tracked note:
  // the record still names the version the file no longer holds.
  a.engine.stop();
  a.host.write(SHARED, BASE + DESKTOP_LINE, 2000);

  // The phone appends a different line and publishes it. Its version's parent
  // IS the version the desktop recorded, so the server sees no conflict.
  b.host.write(SHARED, BASE + PHONE_LINE, 3000);
  await timers.run(STEP_MS, () => b.state.fileByPath(SHARED).versionId !== before);
  assert.equal(
    server.files.get(a.state.fileByPath(SHARED).fileId).heads.length,
    1,
    "the server holds one head and reports no conflict: this is the blind spot",
  );

  // The desktop comes back. Both lines end the same place on both devices
  // (issue #135): the lower version id is the note everywhere and the other
  // line is ONE copy everywhere. 1.1.2 kept each device's own line under the
  // name, which is two different notes for good.
  await a.engine.start();
  const settledAlike = () =>
    copies(a.host).length === 1 && copies(b.host).length === 1 &&
    a.host.text(SHARED) === b.host.text(SHARED) && a.state.fileByPath(SHARED).versionId !== before;
  await timers.run(STEP_MS, settledAlike);
  await timers.run(STEP_MS);

  const both = [BASE + DESKTOP_LINE, BASE + PHONE_LINE];
  for (const device of [a, b]) {
    assert.deepEqual(
      [device.host.text(SHARED), device.host.text(copies(device.host)[0])].sort(), [...both].sort(),
      `a line is on neither the note nor its copy: ${story(server, a, b)}`,
    );
  }
  assert.equal(a.host.text(SHARED), b.host.text(SHARED), `the two devices hold different notes: ${story(server, a, b)}`);
  assert.deepEqual(copies(a.host), copies(b.host), "the two devices hold the copy under different names");
  assert.equal(server.files.get(a.state.fileByPath(SHARED).fileId).heads.length, 1, "the fork was left open");

  const versions = await published(server, k);
  assert.ok(
    holds(versions, BASE + DESKTOP_LINE),
    `the desktop's line reached no version, so history cannot restore it: ${story(server, a, b)}`,
  );
  assert.equal(server.vaultFiles().length, 2, "one note and one copy, each one file");
});

test("a version that lands while this device's own edit is still waiting to be pushed does not replace it", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  a.host.write(SHARED, BASE, 1000);
  await a.engine.start();
  await timers.run(STEP_MS, () => settled(a, SHARED));
  const record = a.state.fileByPath(SHARED);

  // The user types. The vault event is 500 ms away from its push, and the
  // virtual clock does not move again until the feed has done its worst: the
  // engine is running, so this is the race a live device runs every time.
  a.host.write(SHARED, BASE + DESKTOP_LINE, 2000);
  await server.publish({
    fileId: record.fileId,
    path: SHARED,
    bytes: enc(BASE + PHONE_LINE),
    mtime: 3000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [record.versionId],
    deviceId: DEVICE_B,
  });
  // The feed meets the edit first and leaves it for its push (issue #135):
  // nothing is written over it and nothing is copied yet.
  await timers.run(0, kept(a.host, SHARED, BASE + DESKTOP_LINE, () =>
    a.host.logs.some((line) => line.includes("decision=deferred reason=unpushed_edit"))));
  assert.equal(
    a.host.text(SHARED), BASE + DESKTOP_LINE,
    `the feed overtook the debounce and replaced the edit: ${story(server, a, b)}`,
  );

  // The edit reaches the server intact when the debounce fires -- keeping
  // bytes on one device is only half of not losing them -- and the fork that
  // makes is settled by rule: both lines kept, one as the note, one copy.
  await timers.run(STEP_MS, () =>
    copies(a.host).length === 1 && server.files.get(record.fileId).heads.length === 1);
  assert.ok(
    holds(await published(server, k), BASE + DESKTOP_LINE),
    `the kept edit was never published: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    [a.host.text(SHARED), a.host.text(copies(a.host)[0])].sort(), [BASE + DESKTOP_LINE, BASE + PHONE_LINE].sort(),
    `a line is on neither the note nor its copy: ${story(server, a, b)}`,
  );
});

// --- the three ways local bytes can exist nowhere else ----------------------

/**
 * Each case arranges one reason and returns the version the other device
 * publishes over it. They are driven directly rather than through two engines
 * because which reason fires in a live race is a matter of which loop wins,
 * and a guard is proved one clause at a time.
 */
const reasons = [
  {
    reason: "no_record",
    what: "a note this device never pushed",
    async arrange({ host }) {
      host.seed(NOTE, MINE, 2000);
      return { fileId: "22".repeat(16), parents: [] };
    },
  },
  {
    reason: "other_file",
    what: "a note this device tracks under another identity",
    async arrange({ host, context, state }) {
      host.seed(NOTE, MINE, 2000);
      await pushFile(context, NOTE);
      // Which file id sorts lower decides who keeps the name (#113), and a
      // pushed id is random, so it is pinned: this device holds the lower one
      // and therefore keeps its note exactly where it is.
      state.setFile(NOTE, { ...state.fileByPath(NOTE), fileId: "11".repeat(16) });
      return { fileId: "22".repeat(16), parents: [] };
    },
  },
  {
    reason: "local_edit",
    what: "a note edited since it was last pushed",
    async arrange({ host, context }) {
      host.seed(NOTE, "an older line\n", 1000);
      const pushed = await pushFile(context, NOTE);
      host.seed(NOTE, MINE, 2000);
      return { fileId: pushed.fileId, parents: [pushed.versionId] };
    },
  },
  // The two halves of `(mtime, size)`, separated. Together they are what
  // keeps EITHER comparison from being dead weight: a test that moves both
  // dimensions at once passes with either one deleted (review round 1).
  {
    reason: "local_edit",
    what: "a note edited to exactly the same size",
    mine: EQUAL_NEW,
    async arrange({ host, context }) {
      host.seed(NOTE, EQUAL_OLD, 1000);
      const pushed = await pushFile(context, NOTE);
      host.seed(NOTE, EQUAL_NEW, 2000);
      return { fileId: pushed.fileId, parents: [pushed.versionId] };
    },
  },
  {
    reason: "local_edit",
    what: "a note edited without its modification time moving",
    mine: LONGER,
    async arrange({ host, context }) {
      host.seed(NOTE, EQUAL_OLD, 1000);
      const pushed = await pushFile(context, NOTE);
      host.seed(NOTE, LONGER, 1000);
      return { fileId: pushed.fileId, parents: [pushed.versionId] };
    },
  },
];

for (const { reason, what, arrange, mine = MINE } of reasons) {
  test(`a pull never replaces ${what} (${reason})`, async () => {
    const r = await rig();
    const { fileId, parents } = await arrange(r);
    const frame = await r.server.publish({
      fileId,
      path: NOTE,
      bytes: enc(THEIRS),
      mtime: 4000,
      domainKey: r.keys.domainKey,
      manifestKey: r.keys.manifestKey,
      parents,
    });

    const result = await applyChange(r.context, frame);
    assert.equal(r.host.text(NOTE), mine, "the local bytes are exactly as they were");
    assert.ok(
      r.host.logs.some((line) => line.includes(`decision=local_edit_kept reason=${reason}`)),
      r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
    );
    if (reason === "local_edit") {
      // A descendant of the version recorded, over an edit not yet pushed:
      // not a fork yet, so nothing is copied here (issue #135). The record is
      // left so the push cannot answer `unchanged`, the push forks the file,
      // and that fork is settled by rule -- both texts kept, one copy.
      assert.equal(result, "skipped");
      assert.deepEqual(copies(r.host), [], "a version that is not a fork yet was copied");
      assert.equal(r.state.fileByPath(NOTE).sha256, "", "the push could come back unchanged");
      const pushed = await pushFile(r.context, NOTE);
      assert.equal(pushed.ack.conflicted, true, "the edit was not published onto the version it was made on");
      await applyChange(r.context, { ...frame, conflicted: true });
      assert.deepEqual(copies(r.host).length, 1);
      assert.deepEqual([r.host.text(NOTE), r.host.text(copies(r.host)[0])].sort(), [mine, THEIRS].sort());
      assert.equal(r.server.files.get(fileId).heads.length, 1, "the fork was left open");
      return;
    }
    assert.equal(result, "conflict_copy");
    const copy = copies(r.host)[0];
    assert.match(copy, /^Notes\/One \(conflict from iPhone, \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    assert.equal(r.host.text(copy), THEIRS, "and the other device's version is kept beside them");
    assert.match(r.host.notices.join(" "), /kept both versions/);
  });
}

// --- what the graph says, and the flag that cannot ---------------------------

test("a head this device already merged is not applied again when the feed replays it", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(context, NOTE);
  const theirs = await server.publish({
    fileId: base.fileId,
    path: NOTE,
    bytes: enc("one\ntwo\nTHREE\n"),
    mtime: 2000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  const mine = await pushFile(context, NOTE);
  assert.equal(mine.ack.conflicted, true, "the server keeps both heads");

  // What the push's own reconciliation does with the foreign head.
  assert.equal(await applyChange(context, { ...theirs, conflicted: true }), "merged");
  assert.equal(host.text(NOTE), "ONE\ntwo\nTHREE\n");

  // The feed then delivers that same version, carrying the flag the server
  // computed when it was journaled -- before this device had forked anything.
  const frame = server.journal.find((entry) => entry.version_id === theirs.version_id);
  assert.equal(frame.conflicted, false, "the frame the feed carries says no conflict");
  assert.equal(await applyChange(context, frame), "skipped");
  assert.equal(
    host.text(NOTE), "ONE\ntwo\nTHREE\n",
    "the replay threw away a merge this device had already made",
  );
  assert.deepEqual(copies(host), [], "and it invented no conflict copy of something already merged");
});

test("a version whose parents this device skipped is still applied, not kept as a conflict", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed(NOTE, "one\n", 1000);
  const base = await pushFile(context, NOTE);
  const publish = (bytes, mtime, parents) => server.publish({
    fileId: base.fileId, path: NOTE, bytes: enc(bytes), mtime, parents,
    domainKey: k.domainKey, manifestKey: k.manifestKey,
  });

  // A version this device never applied -- one a ceiling held back, one whose
  // manifest was refused, one outside the folders it syncs -- leaves its
  // record an ANCESTOR of what comes next rather than its parent. That is a
  // fast-forward, and treating it as a fork would bury a vault in copies.
  const skipped = await publish("two\n", 2000, [base.versionId]);
  const next = await publish("three\n", 3000, [skipped.version_id]);

  assert.equal(await applyChange(context, next), "applied");
  assert.equal(host.text(NOTE), "three\n");
  assert.equal(state.fileByPath(NOTE).versionId, next.version_id);
  assert.deepEqual(copies(host), []);
});

test("a move never trashes a local file this device has not pushed", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed(NOTE, "an older line\n", 1000);
  const pushed = await pushFile(context, NOTE);
  // Edited here, not yet pushed; the other device renamed the same file.
  host.seed(NOTE, MINE, 2000);
  const moved = await server.publish({
    fileId: pushed.fileId,
    path: MOVED,
    bytes: enc("an older line\n"),
    mtime: 3000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [pushed.versionId],
  });

  // Applying the move writes at the new path and removes the old one, and the
  // removal is the same loss one path over: the trash is not the vault, and
  // the push that would have carried this edit finds nothing left to read.
  assert.equal(await applyChange(context, moved), "conflict_copy");
  assert.equal(host.text(NOTE), MINE, "the unpushed edit is still in the vault");
  assert.deepEqual(host.trashed, [], "and it was not moved to the trash either");
  assert.equal(state.fileByPath(NOTE).versionId, pushed.versionId, "its record still names its parent");
  assert.match(copies(host)[0], /^Notes\/Two \(conflict from iPhone, \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
});

/**
 * The positive control for the whole guard. A file that still matches its
 * record is the ordinary case, and it must go straight through: a guard that
 * fired on it would turn every update into a conflict copy, which is the
 * failure mode opposite to the one this change repairs.
 */
test("a version over a file that still matches its record is applied, not kept", async () => {
  const r = await rig();
  r.host.seed(NOTE, EQUAL_OLD, 1000);
  const pushed = await pushFile(r.context, NOTE);
  const record = r.state.fileByPath(NOTE);
  const stat = await r.host.stat(NOTE);
  assert.equal(record.mtime, stat.mtime, "the control really is unchanged in both dimensions");
  assert.equal(record.size, stat.size);

  const frame = await foreign(r, {
    fileId: pushed.fileId, path: NOTE, text: THEIRS, mtime: 4000, parents: [pushed.versionId],
  });
  assert.equal(await applyChange(r.context, frame), "applied");
  assert.equal(r.host.text(NOTE), THEIRS);
  assert.deepEqual(copies(r.host), [], "and no conflict copy was invented");
});

// --- the conflict copy is a destination too ---------------------------------

/**
 * The copy's name is DERIVED and minute-resolution, so it is a place the user
 * may already have something -- including the copy an earlier version of this
 * same file left, which they may have opened and edited. Writing it through
 * the ordinary overwriting writer destroyed exactly the bytes this change
 * exists to protect (review round 1, finding 1).
 */
test("a conflict copy never replaces whatever is already at its name", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const taken = copyName(r, NOTE, 1);
  r.host.seed(taken, SQUATTER, 3000);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(NOTE), MINE, "the local note is untouched");
  assert.equal(r.host.text(taken), SQUATTER, "and so is the file already at the copy's name");
  assert.equal(r.host.text(copyName(r, NOTE, 2)), THEIRS, "the copy took the next free name");
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=conflict_copy") && line.includes("name_attempt=2")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("an edited conflict copy survives the next version that would take its name", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);

  const first = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, first), "conflict_copy");
  const copy = copyName(r, NOTE, 1);
  assert.equal(r.host.text(copy), THEIRS);

  // The user opens that copy and edits it. Nothing has pushed it yet, so
  // those bytes exist on this device and nowhere else.
  r.host.seed(copy, EDITED, 5000);

  // The same device publishes again, inside the same minute, so the name the
  // copy would be given is the one the user's edit is sitting in.
  const second = await foreign(r, {
    fileId: "22".repeat(16), path: NOTE, text: THEIRS_AGAIN, mtime: 6000,
    parents: [first.version_id],
  });
  assert.equal(await applyChange(r.context, second), "conflict_copy");

  assert.equal(r.host.text(copy), EDITED, "the edited copy was replaced by the second remote version");
  assert.equal(r.host.text(NOTE), MINE, "and the note it was a copy of is untouched");
  assert.equal(r.host.text(copyName(r, NOTE, 2)), THEIRS_AGAIN, "the second version took the next name");
});

/**
 * The other side of that guard: one foreign head is resolved twice by design
 * -- the feed delivers a head the push's own reconciliation already handled --
 * and the second pass must not grow an identical second copy. The occupant is
 * recognised by the size and modification time this very manifest would
 * write, so only a byte-identical copy of THIS version is reused.
 */
/**
 * A note this device pushed and then edited before the other device's version
 * of it arrived: the shape a REPLAYED head actually meets. A version of a
 * file id this device does not track at all is recorded where its copy lands
 * (#113), so the feed's second delivery of it is skipped outright and never
 * reaches the occupant check; the check's subject is this shape, where the
 * record at the name is this device's own edited file and both passes take
 * the keep-both path. The version RENAMES the note (to `MOVED`): one that only
 * edits it is left for this edit's push since issue #135, and a rename over an
 * edit made here is still kept as both.
 */
async function editedHere(r) {
  r.host.seed(NOTE, "an older line\n", 1000);
  const pushed = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, MINE, 2000);
  return { fileId: pushed.fileId, parents: [pushed.versionId] };
}

test("resolving the same foreign version twice leaves one copy, not two", async () => {
  const r = await rig();
  const { fileId, parents } = await editedHere(r);
  const frame = await foreign(r, { fileId, path: MOVED, text: THEIRS, mtime: 4000, parents });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.deepEqual(copies(r.host), [copyName(r, MOVED, 1)]);
  assert.equal(r.host.text(copyName(r, MOVED, 1)), THEIRS);
  assert.equal(r.host.text(NOTE), MINE);
});

/**
 * And the reason the look is not the guard. A name that is free when it is
 * checked and taken when the write lands is a race an existence check cannot
 * close; only a create-exclusive publication can, and that is what the host's
 * `createWriter` is (`main.ts`: `link` on desktop, `Vault.createBinary` on
 * mobile, neither of which can replace a destination).
 */
test("a name that appears between the look and the write is still not replaced", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const taken = copyName(r, NOTE, 1);
  r.host.seed(taken, SQUATTER, 3000);
  const stat = r.host.stat.bind(r.host);
  let lied = false;
  r.host.stat = async (path) => {
    if (path === taken && !lied) { lied = true; return null; }
    return stat(path);
  };

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(taken), SQUATTER, "the write went through the look and replaced the occupant");
  assert.equal(r.host.text(NOTE), MINE);
  assert.equal(r.host.text(copyName(r, NOTE, 2)), THEIRS, "the refused commit earned the next name");
});

// --- the copy's name is not an identity (issue #109, finding 1) --------------

/** As long as what this version would write, and not what it would write. */
const sameLength = (text, filler) => filler.padEnd(text.length - 1, ".") + "\n";

/**
 * `(size, mtime)` is what a vault reports ABOUT a file, never what is in it.
 * Reusing an occupied name on that alone made this device announce a copy it
 * had not written, skip the version, and never fetch or authenticate one chunk
 * of it -- while the feed advanced past it.
 */
test("an occupied name whose bytes are not this version's is not mistaken for it", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const decoy = sameLength(THEIRS, "an unrelated note");
  assert.equal(decoy.length, THEIRS.length, "the decoy is exactly as long as the version");
  r.host.seed(copyName(r, NOTE, 1), decoy, 4000);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(r.host.text(copyName(r, NOTE, 1)), decoy, "the occupant was replaced or claimed");
  assert.equal(r.host.text(copyName(r, NOTE, 2)), THEIRS, "the version reached the vault");
  assert.equal(r.host.text(NOTE), MINE);
  assert.ok(
    r.server.requests.some((request) => request.target.startsWith("/v1/chunks/")),
    "no chunk was fetched, so nothing was authenticated either",
  );
});

test("a second version with the same size and modification time still reaches the vault", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const next = sameLength(THEIRS, "the second version");
  assert.equal(next.length, THEIRS.length);

  const one = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, one), "conflict_copy");
  const two = await foreign(r, {
    fileId: "22".repeat(16), path: NOTE, text: next, mtime: 4000, parents: [one.version_id],
  });
  // The copy this device made is RECORDED under that file id (#113), so the
  // next version of it is an ordinary update of the note it made -- where
  // 1.0.6 wrote a second copy for every edit, and a third for the next one.
  assert.equal(await applyChange(r.context, two), "applied");

  assert.equal(r.host.text(copyName(r, NOTE, 1)), next, "the second version was never written");
  assert.deepEqual(copies(r.host), [copyName(r, NOTE, 1)], "the second version made another copy");
  assert.equal(r.host.text(NOTE), MINE);
});

/**
 * The content check is what makes the replay control above sound: an occupant
 * that hashes to the manifest's authenticated `sha256` IS this version, so
 * there is nothing to write, and that is the ONLY reuse accepted.
 */
test("a corrupted chunk raises its authentication error instead of being called a copy", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  const sid = frame.sids[0];
  const tampered = Uint8Array.from(r.server.chunks.get(sid));
  tampered[0] ^= 0xff;
  r.server.chunks.set(sid, tampered);

  await assert.rejects(applyChange(r.context, frame));
  assert.deepEqual(copies(r.host), [], "a copy was claimed for content that never authenticated");
  assert.equal(r.host.text(NOTE), MINE);
});

test("a writer that cannot be created where nothing exists is an error, not twenty attempts", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  let attempts = 0;
  r.host.createWriter = async () => {
    attempts++;
    throw new Error("sentinel writer failure");
  };

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  await assert.rejects(applyChange(r.context, frame), /sentinel writer failure/);
  assert.equal(attempts, 1, "a real failure was retried into the whole name budget");
  assert.deepEqual(copies(r.host), []);
});

test("the twentieth name is still usable when the first nineteen are taken", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  for (let i = 1; i <= 19; i++) r.host.seed(copyName(r, NOTE, i), `occupied ${i}\n`, 9000);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  assert.equal(r.host.text(copyName(r, NOTE, 20)), THEIRS, "the last name in the budget was not reachable");
});

test("every name taken means the copy is refused, and nothing is claimed", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  for (let i = 1; i <= 20; i++) r.host.seed(copyName(r, NOTE, i), `occupied ${i}\n`, 9000);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "refused");

  assert.equal(r.host.text(NOTE), MINE);
  for (let i = 1; i <= 20; i++) assert.equal(r.host.text(copyName(r, NOTE, i)), `occupied ${i}\n`);
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=refused") && line.includes("reason=no_free_conflict_name")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  assert.match(r.host.notices.join(" "), /could not place the other device's copy/);
});

test("the copy's writer is released on success as well as on failure", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const create = r.host.createWriter.bind(r.host);
  const released = [];
  r.host.createWriter = async (path, size, check) => {
    const writer = await create(path, size, check);
    return { ...writer, abort: async () => { released.push(path); return writer.abort(); } };
  };

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  assert.deepEqual(released, [copyName(r, NOTE, 1)], "the writer's owned temporary was never released");
});

// --- the same two outcomes through the REAL desktop host --------------------

/**
 * The simple fake cannot show finding 2 at all: it has no temporary file. The
 * desktop host does -- it publishes with `link`, which leaves its own
 * `.obsync-*.tmp` name pointing at the same inode as the published copy and
 * hands the removal to `abort`. So the cleanup contract is pinned HERE,
 * against the real `ObsidianHost` over a throwaway vault on a real
 * filesystem, where the residue is a directory entry a test can read.
 */
function desktopVault(t, r) {
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-copy-host-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  mkdirSync(join(root, "Notes"));
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  const logs = [];
  const vault = { adapter: {
    exists: async (path) => existsSync(join(root, path)),
    mkdir: async (path) => fsp.mkdir(join(root, path), { recursive: true }),
    writeBinary: async () => assert.fail("the overwriting adapter was used"),
  } };
  const host = new ObsidianHost(
    { state: r.state, app: { vault }, log: (line) => logs.push(line) },
    { base: root, path: nodePath, fs: { promises: fsp } },
  );
  return { root, host, logs, context: { ...r.context, host } };
}

/** Every name in the folder, including the ones a vault hides. */
const folder = (root) => readdirSync(join(root, "Notes")).sort();

test("a conflict copy through the real desktop host leaves no temporary behind", async (t) => {
  const r = await rig();
  const { root, context } = desktopVault(t, r);
  writeFileSync(join(root, NOTE), MINE);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(context, frame), "conflict_copy");

  const copy = copyName(r, NOTE, 1);
  assert.equal(readFileSync(join(root, copy), "utf8"), THEIRS, "the copy did not land");
  assert.equal(readFileSync(join(root, NOTE), "utf8"), MINE, "the local note was touched");
  assert.deepEqual(
    folder(root), [basename(NOTE), basename(copy)].sort(),
    "a second, hidden name for the copy's plaintext was left in the vault",
  );
});

test("a failed conflict copy through the real desktop host leaves neither copy nor temporary", async (t) => {
  const r = await rig();
  const { root, context } = desktopVault(t, r);
  writeFileSync(join(root, NOTE), MINE);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  const tampered = Uint8Array.from(r.server.chunks.get(frame.sids[0]));
  tampered[0] ^= 0xff;
  r.server.chunks.set(frame.sids[0], tampered);

  await assert.rejects(applyChange(context, frame));
  assert.deepEqual(folder(root), [basename(NOTE)], "the failed copy left residue in the vault");
  assert.equal(readFileSync(join(root, NOTE), "utf8"), MINE);
});

/**
 * The same shortcut failing the OTHER way, which is what real devices showed:
 * a vault gives a file the timestamp IT chooses, not the one the manifest
 * carries, so a replayed head whose copy was already written did not look
 * like itself and was copied a second time under the next ordinal. Content is
 * the only identity that survives a host's own bookkeeping.
 */
test("a replayed head whose copy carries a different timestamp is still one copy", async () => {
  const r = await rig();
  const { fileId, parents } = await editedHere(r);
  const frame = await foreign(r, { fileId, path: MOVED, text: THEIRS, mtime: 4000, parents });

  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  const copy = copyName(r, MOVED, 1);
  r.host.files.get(copy).mtime = 4321;

  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  assert.deepEqual(copies(r.host), [copy], "one head was written as two copies");
  assert.equal(r.host.text(copy), THEIRS);
});

// --- what the occupant check is allowed to READ (issue #112, review round 1) -

/** Record every whole-file read the pull path makes, and let it through. */
function watchReads(r) {
  const read = r.host.read.bind(r.host);
  const paths = [];
  r.host.read = async (path) => { paths.push(path); return read(path); };
  return paths;
}

/**
 * Recognising an occupant by content means READING it, and a read is a whole
 * file in memory. So the two cheap facts come first and decide alone: a
 * version with no whole-file digest, or of a different length than what is
 * sitting there, is not this version's copy and is never opened. Without them
 * an occupied name is an instruction from another device to load an arbitrary
 * local file whole.
 */
test("a multi-chunk version never reads the file occupying its copy name", async () => {
  const r = await rig();
  const c = require("../build/crypto.js");
  r.host.seed(NOTE, MINE, 2000);

  // Two real chunks -- the record binding admits a second one only above
  // CHUNK_MAX -- with a whole-file digest supplied anyway: authenticated,
  // bound to its record, and still multi-chunk.
  const first = new Uint8Array(8 << 20).fill(7);
  const last = new Uint8Array(64).fill(9);
  const sealed = [await c.encryptChunk(r.keys.domainKey, first), await c.encryptChunk(r.keys.domainKey, last)];
  for (const chunk of sealed) r.server.chunks.set(chunk.sid, chunk.ciphertext);
  const size = first.length + last.length;
  const manifest = {
    v: 1, path: NOTE, size, mtime: 4000, domain: "0123456789abcdef0123456789abcdef",
    chunks: [
      { sid: sealed[0].sid, cid: c.hex(sealed[0].cid), len: first.length },
      { sid: sealed[1].sid, cid: c.hex(sealed[1].cid), len: last.length },
    ],
    sha256: c.hex(await c.sha256(new Uint8Array([...first, ...last]))),
    deleted: false,
  };
  // Something is already at the copy's name, exactly as long as the version.
  r.host.seed(copyName(r, NOTE, 1), new Uint8Array(size).fill(3), 4000);
  const watched = watchReads(r);

  const frame = await r.server.publishManifest({
    fileId: "22".repeat(16), manifest, sids: manifest.chunks.map((chunk) => chunk.sid),
    parents: [], deviceId: "ffffffffffffffffffffffffffffffff", manifestKey: r.keys.manifestKey, bytes: size,
  });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.ok(
    !watched.includes(copyName(r, NOTE, 1)),
    "the occupied name was read whole to compare a version that carries no comparable digest",
  );
  assert.equal(r.host.text(copyName(r, NOTE, 2)).length, size, "and the version took the next name");
});

test("an occupant of a different length is never read to compare it", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  // Far longer than the incoming version, and sitting at its copy's name.
  r.host.seed(copyName(r, NOTE, 1), new Uint8Array(2 << 20).fill(5), 4000);
  const watched = watchReads(r);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.ok(
    !watched.includes(copyName(r, NOTE, 1)),
    "a 2 MiB occupant was loaded whole to be compared with a 37-byte version",
  );
  assert.equal(r.host.text(copyName(r, NOTE, 2)), THEIRS);
});

test("a single-chunk version of the same length IS read, and its copy reused", async () => {
  const r = await rig();
  const { fileId, parents } = await editedHere(r);
  const frame = await foreign(r, { fileId, path: MOVED, text: THEIRS, mtime: 4000, parents });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  const watched = watchReads(r);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  assert.ok(watched.includes(copyName(r, MOVED, 1)), "the positive control never compared the occupant at all");
  assert.deepEqual(copies(r.host), [copyName(r, MOVED, 1)]);
});

// --- a cleanup that fails is still said out loud ---------------------------

/** Make the writer's own cleanup fail, and count the copies it published. */
function brokenCleanup(r) {
  const create = r.host.createWriter.bind(r.host);
  r.host.createWriter = async (path, size, check) => {
    const writer = await create(path, size, check);
    return { ...writer, abort: async () => { throw new Error("sentinel cleanup failure"); } };
  };
}

test("a cleanup failure after a published copy keeps the copy and is logged", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  brokenCleanup(r);

  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  assert.equal(await applyChange(r.context, frame), "conflict_copy", "a published copy was withdrawn over its temp");
  assert.equal(r.host.text(copyName(r, NOTE, 1)), THEIRS);
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=copy_temp_not_removed published=true")),
    `residue left silently: ${r.host.logs.filter((line) => line.startsWith("pull")).join(" | ")}`,
  );
});

test("a cleanup failure after a failed write keeps the original failure and is logged", async () => {
  const r = await rig();
  r.host.seed(NOTE, MINE, 2000);
  const frame = await foreign(r, { fileId: "22".repeat(16), path: NOTE, text: THEIRS, mtime: 4000 });
  const tampered = Uint8Array.from(r.server.chunks.get(frame.sids[0]));
  tampered[0] ^= 0xff;
  r.server.chunks.set(frame.sids[0], tampered);
  brokenCleanup(r);

  // The authentication failure is the cause; the cleanup error must not bury it.
  await assert.rejects(applyChange(r.context, frame), (error) => !/sentinel cleanup failure/.test(error.message));
  assert.deepEqual(copies(r.host), []);
  assert.ok(
    r.host.logs.some((line) => line.includes("decision=copy_temp_not_removed published=false")),
    `residue left silently: ${r.host.logs.filter((line) => line.startsWith("pull")).join(" | ")}`,
  );
});

// --- a remote deletion over an unpushed local edit (#106) -------------------

test("a remote delete over an unpushed local edit keeps the edit and republishes it", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed(NOTE, "an older line\n", 1000);
  const pushed = await pushFile(context, NOTE);
  // Edited here and not yet pushed; the other device deleted the same note.
  host.seed(NOTE, MINE, 2000);
  const tombstone = await server.publishTombstone({
    fileId: pushed.fileId,
    path: NOTE,
    manifestKey: k.manifestKey,
    parents: [pushed.versionId],
  });

  assert.equal(await applyChange(context, tombstone), "skipped");

  assert.equal(host.text(NOTE), MINE, "the unpushed edit is still in the vault");
  assert.deepEqual(host.trashed, [], "and it never went to the trash");
  const versions = await published(server, k);
  assert.ok(holds(versions, MINE), "the server holds a version carrying those bytes");
  assert.equal(state.fileByPath(NOTE).fileId, pushed.fileId, "published under the same file id, so it revives");
  assert.notEqual(state.fileByPath(NOTE).versionId, pushed.versionId, "and the record moved to the new version");

  const line = host.logs.find((entry) => entry.includes("decision=local_edit_kept"));
  assert.ok(line, host.logs.join(" | "));
  assert.match(line, /path_class=tombstone/);
  assert.match(line, /reason=local_edit/);
  assert.match(line, /published=pushed/);
  assert.match(line, /duration_ms=\d+/);
  assert.equal(host.notices.length, 0, "settled delete-versus-edit is silent (#178)");
});

test("a tombstone for a file this device no longer tracks leaves the path alone", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed(NOTE, "an older line\n", 1000);
  const pushed = await pushFile(context, NOTE);
  const tombstone = async () => server.publishTombstone({
    fileId: pushed.fileId, path: NOTE, manifestKey: k.manifestKey, parents: [pushed.versionId],
  });
  assert.equal(await applyChange(context, await tombstone()), "deleted");

  // A note re-created here afterwards: no record names it, so no version
  // holds it either. A replayed tombstone must not reach for it by path.
  host.seed(NOTE, MINE, 4000);
  assert.equal(await applyChange(context, await tombstone()), "skipped");
  assert.equal(host.text(NOTE), MINE);
  // THE EMPTY PARENT GOES WITH IT (issue #104). A folder this device holds no
  // record for exists only to hold the file that is leaving, and nothing will
  // ever tombstone it, so the pull path takes it once the last file under it
  // is gone. A vault that has finished a startup reconciliation has a record
  // for every folder and the walk stops at the first one, which is why a
  // folder on a real device goes only by its own tombstone.
  assert.deepEqual(host.trashed, [NOTE, "Notes"], "only the first, tracked deletion trashed anything");
});

test("a plain remote delete still trashes the note and forgets it", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed(NOTE, "an older line\n", 1000);
  const pushed = await pushFile(context, NOTE);
  const tombstone = await server.publishTombstone({
    fileId: pushed.fileId,
    path: NOTE,
    manifestKey: k.manifestKey,
    parents: [pushed.versionId],
  });

  assert.equal(await applyChange(context, tombstone), "deleted");

  assert.equal(host.files.has(NOTE), false, "the note is gone from the vault");
  // THE EMPTY PARENT GOES WITH IT (issue #104). A folder this device holds no
  // record for exists only to hold the file that is leaving, and nothing will
  // ever tombstone it, so the pull path takes it once the last file under it
  // is gone. A vault that has finished a startup reconciliation has a record
  // for every folder and the walk stops at the first one, which is why a
  // folder on a real device goes only by its own tombstone.
  assert.deepEqual(host.trashed, [NOTE, "Notes"], "through the host's trash");
  assert.equal(state.fileByPath(NOTE), undefined, "and the path is forgotten");
  assert.equal(host.notices.length, 0, "an ordinary deletion says nothing");
  assert.ok(host.logs.some((entry) => entry.includes("path_class=tombstone decision=deleted")));
});

test("a delete raced by an edit reaches the other device as a live note", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t);

  a.host.write(SHARED, BASE, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text(SHARED) === BASE && settled(a, SHARED) && settled(b, SHARED));

  // The desktop app is closed. Its user appends a line to the tracked note.
  a.engine.stop();
  a.host.write(SHARED, BASE + DESKTOP_LINE, 2000);

  // The phone deletes the note, and its tombstone's parent IS the version the
  // desktop recorded, so the server sees no conflict at all.
  b.host.remove(SHARED);
  await timers.run(STEP_MS, () => b.state.fileByPath(SHARED) === undefined);

  // The desktop comes back.
  await a.engine.start();
  await timers.run(STEP_MS, kept(a.host, SHARED, BASE + DESKTOP_LINE, () =>
    b.host.text(SHARED) === BASE + DESKTOP_LINE));
  await timers.run(STEP_MS);

  assert.equal(
    a.host.text(SHARED), BASE + DESKTOP_LINE,
    `the desktop's line was trashed by the phone's delete: ${story(server, a, b)}`,
  );
  assert.equal(
    b.host.text(SHARED), BASE + DESKTOP_LINE,
    `the revived note never reached the phone: ${story(server, a, b)}`,
  );
  assert.ok(
    holds(await published(server, k), BASE + DESKTOP_LINE),
    `the desktop's line reached no version: ${story(server, a, b)}`,
  );
  assert.equal(server.vaultFiles().length, 1, "one note, still one file id");
  const file = server.files.get(server.vaultFiles()[0]);
  assert.equal(file.heads.length, 1, JSON.stringify({heads:file.heads,versions:file.versions.map(v=>({id:v.version_id,parents:v.parents,deleted:v.deleted,device:v.device_id}))}));
  assert.ok(file.versions.some(version => version.deleted), "the deletion is retained in history");
  a.host.write(SHARED, BASE + DESKTOP_LINE + "a later edit\n", 9000);
  await timers.run(STEP_MS, () => b.host.text(SHARED) === BASE + DESKTOP_LINE + "a later edit\n");
  assert.equal(file.heads.length, 1, "later edits do not reopen the deletion fork");
  assert.ok(![...a.host.notices, ...b.host.notices].some(notice => /did not delete|was kept and published/.test(notice)));
});
