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
import { createRequire } from "node:module";
import { DEVICE_B, STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

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
  await timers.run(STEP_MS, kept(a.host, SAME, DESKTOP_NEW, () =>
    settled(a, SAME) && copies(a.host).length === 1 && copies(b.host).length === 1));
  await timers.run(STEP_MS);

  assert.equal(a.host.text(SAME), DESKTOP_NEW, `the desktop's note was replaced: ${story(server, a, b)}`);
  const copy = copies(a.host)[0];
  assert.match(copy, /^Same name \(conflict from phone, \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
  assert.equal(a.host.text(copy), PHONE_NEW, "and the phone's note is kept beside it");
  assert.equal(b.host.text(SAME), PHONE_NEW, `the phone's note was replaced: ${story(server, a, b)}`);
  assert.equal(b.host.text(copies(b.host)[0]), DESKTOP_NEW, "and the desktop's reached the phone");

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

  // The desktop comes back.
  await a.engine.start();
  await timers.run(STEP_MS, kept(a.host, SHARED, BASE + DESKTOP_LINE, () =>
    copies(a.host).length === 1 && copies(b.host).length === 1 &&
    a.state.fileByPath(SHARED).versionId !== before));
  await timers.run(STEP_MS);

  assert.equal(
    a.host.text(SHARED), BASE + DESKTOP_LINE,
    `the desktop's line was replaced by the phone's: ${story(server, a, b)}`,
  );
  assert.equal(a.host.text(copies(a.host)[0]), BASE + PHONE_LINE, "and the phone's line is kept beside it");
  assert.equal(b.host.text(SHARED), BASE + PHONE_LINE, `the phone's line was replaced: ${story(server, a, b)}`);
  assert.equal(b.host.text(copies(b.host)[0]), BASE + DESKTOP_LINE);

  const versions = await published(server, k);
  assert.ok(
    holds(versions, BASE + DESKTOP_LINE),
    `the desktop's line reached no version, so history cannot restore it: ${story(server, a, b)}`,
  );
  assert.equal(server.vaultFiles().length, 1, "one note, still one file");
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
  await timers.run(0, kept(a.host, SHARED, BASE + DESKTOP_LINE, () => copies(a.host).length === 1));

  assert.equal(
    a.host.text(SHARED), BASE + DESKTOP_LINE,
    `the feed overtook the debounce and replaced the edit: ${story(server, a, b)}`,
  );
  assert.equal(a.host.text(copies(a.host)[0]), BASE + PHONE_LINE);

  // And the edit the guard kept still reaches the server when the debounce
  // fires: keeping bytes on one device is only half of not losing them.
  await timers.run(STEP_MS, () => a.state.fileByPath(SHARED).versionId !== record.versionId);
  assert.ok(
    holds(await published(server, k), BASE + DESKTOP_LINE),
    `the kept edit was never published: ${story(server, a, b)}`,
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
    async arrange({ host, context }) {
      host.seed(NOTE, MINE, 2000);
      await pushFile(context, NOTE);
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
];

for (const { reason, what, arrange } of reasons) {
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

    assert.equal(await applyChange(r.context, frame), "conflict_copy");
    assert.equal(r.host.text(NOTE), MINE, "the local bytes are exactly as they were");
    const copy = copies(r.host)[0];
    assert.match(copy, /^Notes\/One \(conflict from iPhone, \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    assert.equal(r.host.text(copy), THEIRS, "and the other device's version is kept beside them");
    assert.match(r.host.notices.join(" "), /kept both versions/);
    assert.ok(
      r.host.logs.some((line) => line.includes(`decision=local_edit_kept reason=${reason}`)),
      r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
    );
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
