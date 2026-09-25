/**
 * Two devices, one server, one rename (issue #96).
 *
 * THE BLIND SPOT THIS FILE CLOSES. Every other engine test drives the watcher
 * by hand — `engine.changed(...)`, `engine.deleted(...)`, `engine.renamed(...)`
 * — against a vault that never answers back. A real Obsidian vault is an EVENT
 * SOURCE: the write and the trash the PULL path performs come back to the same
 * device as `create` and `delete` events, and Obsidian delivers them while the
 * operation that caused them is still running. The vault here does exactly
 * that, and the plugin's own `registerVaultEvents` is what turns those events
 * into engine calls, so what is tested is the real path from a vault event to
 * a posted version.
 *
 * DELIVERY IS A PARAMETER, NOT AN ASSUMPTION. `immediate` is what Obsidian's
 * own API does (`FileManager.trashFile` triggers `delete` before its promise
 * resolves); `deferred` is a watcher-shaped notification that arrives a turn
 * later. The invariant is asserted under both, because a fix that only held
 * for one ordering would not be a fix.
 *
 * WHAT THE INVARIANT IS. A rename is a MOVE: it keeps the file id and changes
 * the path inside the manifest. No device may ever publish a tombstone for a
 * file that was only renamed — a tombstone is what every other device obeys,
 * and obeying it deletes the user's note everywhere.
 *
 * WHAT IS AND IS NOT A PLATFORM HERE. Both devices are the same hand-written
 * vault (`EventVault`), one configured desktop (`isMobile` false, concurrency
 * 4) and one mobile (`isMobile` true, concurrency 2). That exercises the real
 * `registerVaultEvents`, the real transport signing and the real engine on
 * both configurations; it does NOT exercise `ObsidianHost` — the Node `fs`
 * writer, the adapter writer, `FileManager.trashFile` — or the native event
 * timing of either platform. Those stay a real-device acceptance run
 * (`docs/validation.md`), and this file says nothing about them.
 *
 * The two-device rig itself lives in `fake.mjs`, beside the fakes it is made
 * of, because `offline.test.mjs` drives the same two devices.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { DEVICE_B, FakeServer, KEYS, SECRET_B, STEP_MS, pair, rig, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);

/** An identity the fixture never enrols, and a secret no device holds. */
const UNENROLLED = "deadbeefdeadbeefdeadbeefdeadbeef";
const SECRET_C = "5e".repeat(32);

/**
 * Wait for a move to land everywhere -- or stop the moment a tombstone
 * appears, so the assertion that follows reports the note that was deleted
 * instead of a ten-second timeout for a file that is never coming.
 */
const landed = (server, condition) => () => tombstones(server).length > 0 || condition();

/** Every tombstone the server holds: what a renamed file must never produce. */
const tombstones = (server) => server.journal.filter((frame) => frame.deleted);

/**
 * Every tombstone naming one of these FILE ids. Since 1.1.0 a folder rename
 * legitimately publishes a folder tombstone (issue #104), so the invariant is
 * stated about the files that must survive rather than about the count of
 * deleted frames — which makes it sharper, not looser: it names them.
 */
const tombstonesFor = (server, ids) =>
  server.journal.filter((frame) => frame.deleted && ids.includes(frame.file_id));

/** What the two devices did to each other, for a failure that has to be read. */
const story = (server, a, b) =>
  [`journal=${server.journal.map((frame) => `${frame.seq}${frame.deleted ? ":tombstone" : ""}`).join(",")}`,
    `desktop_trashed=${JSON.stringify(a.host.trashed)}`,
    `phone_trashed=${JSON.stringify(b.host.trashed)}`,
    `desktop_files=${JSON.stringify([...a.host.files.keys()])}`,
    `phone_files=${JSON.stringify([...b.host.files.keys()])}`].join(" ");

const BODY = "# A note\nwith a body that must survive its own rename\n";
const EDITED = "# A note\nrenamed AND rewritten in one move, which is not a rename\n";

for (const delivery of ["immediate", "deferred"]) {
  test(`a renamed note moves on the other device and neither publishes a tombstone (${delivery} vault events)`, async (t) => {
    const { server, timers, a, b } = await pair(t, delivery);

    // The desktop writes a note; the phone receives it.
    a.host.write("Note.md", BODY, 1000);
    await a.engine.start();
    await b.engine.start();
    await timers.run(STEP_MS, () =>
      b.host.text("Note.md") === BODY && settled(a, "Note.md") && settled(b, "Note.md"));
    const fileId = a.state.fileByPath("Note.md").fileId;
    assert.equal(b.state.fileByPath("Note.md").fileId, fileId, "one file, one identity");

    // The desktop renames it. Nothing else happens on either device.
    a.host.rename("Note.md", "Renamed.md");
    await timers.run(STEP_MS, landed(server, () =>
      b.host.text("Renamed.md") === BODY && settled(a, "Renamed.md") && settled(b, "Renamed.md")));
    await timers.run(STEP_MS);

    assert.deepEqual(tombstones(server), [], `a rename published a tombstone: ${story(server, a, b)}`);
    assert.equal(b.host.text("Renamed.md"), BODY, `the phone lost the note: ${story(server, a, b)}`);
    assert.equal(a.host.text("Renamed.md"), BODY, `the desktop lost the note: ${story(server, a, b)}`);
    assert.equal(b.host.text("Note.md"), null, "and it is not left behind under the old name");
    assert.equal(a.state.fileByPath("Renamed.md").fileId, fileId, "the desktop kept the file id");
    assert.equal(b.state.fileByPath("Renamed.md").fileId, fileId, "the phone moved it instead of copying it");
    assert.equal(b.state.fileByPath("Note.md"), undefined);
    assert.equal(server.vaultFiles().length, 1, "no second file was created");
    assert.equal(server.files.get(fileId).heads.length, 1, "and the file did not fork");
    assert.equal(
      server.files.get(fileId).versions.some((version) => version.deleted),
      false,
      "no version of this file id says deleted",
    );
    // NOTHING IN THE TRASH (issue #108). Until 1.1.0 the phone applied a
    // rename by writing the new name and trashing the old, so every rename
    // made on one device left a full copy of the note in every other
    // device's system trash -- on mobile, somewhere the user can barely
    // reach. It is one host rename now, so the trash is untouched and the
    // bytes are never downloaded again.
    assert.deepEqual(b.host.trashed, [], `the phone trashed the old name: ${story(server, a, b)}`);
    assert.ok(
      b.host.logs.some((line) => line.includes("path_class=file") && line.includes("decision=renamed")),
      b.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
    );
    // The phone's own vault told it the pull's RENAME had happened; it
    // recognised the echo instead of publishing it (requirement 12). This
    // was a delete echo before the rename became one operation.
    assert.ok(
      b.host.logs.some((line) => line.includes("decision=echo_suppressed") && line.includes("event=rename")),
      b.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
    );
  });
}

/**
 * THE OTHER HALF OF #108. The atomic rename is taken only when the source
 * still holds exactly what this device recorded there. A source carrying an
 * unpushed edit is the delete-versus-edit case (#98), and a rename that moved
 * that file would carry those bytes away under a name their author never gave
 * them -- or, once the other device pulled the move back, lose them.
 */
/**
 * A RENAME THAT ALSO CHANGES THE TEXT IS NOT A RENAME (issue #108). The
 * host's atomic rename moves the bytes that are already here, so it is taken
 * only when the source holds exactly what the incoming version carries. A
 * version that renamed AND edited has to be downloaded; renaming to its name
 * would leave the OLD text under the NEW name, on every device that applied
 * it, with nothing to say the text was ever different.
 */
test("a remote rename that also edits the note downloads it rather than renaming", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate");

  a.host.write("Note.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text("Note.md") === BODY && settled(a, "Note.md") && settled(b, "Note.md"));
  const fileId = a.state.fileByPath("Note.md").fileId;

  // One version that moves the note and changes it: the desktop renames it
  // and types into it before the phone has heard about either.
  a.host.rename("Note.md", "Renamed.md");
  await timers.run(STEP_MS, () => settled(a, "Renamed.md"));
  a.host.write("Renamed.md", EDITED, 5000);
  await timers.run(STEP_MS, () => settled(a, "Renamed.md") && a.host.text("Renamed.md") === EDITED);
  // WAIT ON WHAT IS ASSERTED, NOT ON A PROXY FOR IT. The bytes land before
  // the record does, so waiting for the TEXT and then asserting on the RECORD
  // asserts on a half-finished apply: whether it holds is decided by how many
  // turns the apply took, which is a property of the machine and of any
  // mutation under test rather than of the product. Both halves are waited
  // for here.
  await timers.run(STEP_MS, () => b.host.text("Renamed.md") === EDITED && settled(b, "Renamed.md"));

  assert.equal(b.host.text("Renamed.md"), EDITED,
    `the phone kept the text from before the rename: ${story(server, a, b)}`);
  assert.equal(b.host.text("Note.md"), null, "the old name is not left behind");
  assert.equal(b.state.fileByPath("Renamed.md").fileId, fileId, "one file id throughout");
  assert.deepEqual(tombstones(server), [], `an edited rename published a tombstone: ${story(server, a, b)}`);
});

/**
 * THE SAME GUARD, WITH A DETERMINISTIC KILL (review round 1, finding 2).
 *
 * The two-device test above renames, waits for that push to settle, and only
 * then edits, so it publishes TWO versions and the content proof is exercised
 * only when timing happens to coalesce them: the reviewer ran `M72` four
 * times on pinned Node and it survived twice. ONE version that renames AND
 * edits is the input that cannot be coalesced away -- it is one frame, and
 * the only thing standing between it and silent data loss is the proof that
 * the source holds this version's content. Without it the device renames the
 * entry, records the NEW version id over the OLD bytes, downloads nothing,
 * and shows the user no notice at all: that edit never arrives, on that
 * device, ever.
 *
 * The frame is built directly rather than driven through a second vault,
 * because a vault that fires events is exactly what lets a test coalesce two
 * versions into one and lose the discriminator again.
 */
test("one version that renames AND edits is downloaded, not applied as a bare rename", async (t) => {
  const r = await rig();
  r.host.seed("Note.md", BODY, 1000);
  await pushFile(r.context, "Note.md");
  const local = r.state.fileByPath("Note.md");

  const frame = await r.server.publish({
    fileId: local.fileId,
    path: "Renamed.md",
    bytes: enc(EDITED),
    mtime: 5000,
    parents: [local.versionId],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, frame), "applied");

  assert.equal(
    r.host.text("Renamed.md"),
    EDITED,
    "the edit that rode the rename was not applied: this device recorded the new version over the OLD bytes",
  );
  assert.equal(r.host.text("Note.md"), null, "the old name is not left behind");
  assert.equal(r.state.fileByPath("Renamed.md").versionId, frame.version_id);
  assert.equal(r.state.fileByPath("Renamed.md").fileId, local.fileId, "one file id throughout");
  // The decision says a download happened, not a rename: a mutant that took
  // the rename shortcut here logs `decision=renamed` and fetches nothing.
  assert.ok(
    r.host.logs.some((line) => line.includes("path_class=file") && line.includes("decision=applied")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("a rename over an unpushed local edit keeps both, and renames nothing", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate");

  a.host.write("Note.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text("Note.md") === BODY && settled(a, "Note.md") && settled(b, "Note.md"));

  // The phone stops listening and its user edits the note; the desktop, which
  // never sees that edit, renames it.
  b.engine.stop();
  b.host.write("Note.md", "TYPED ON THE PHONE SENTINEL", 5000);
  a.host.rename("Note.md", "Renamed.md");
  await timers.run(STEP_MS, () => settled(a, "Renamed.md"));

  await b.engine.start();
  await timers.run(STEP_MS, () => [...b.host.files.values()].some((file) =>
    new TextDecoder().decode(file.bytes) === BODY && b.host.text("Note.md") !== BODY));
  await timers.run(STEP_MS);

  // WHAT THE COMPOSED HEAD DOES, stated rather than assumed: the phone's own
  // edit keeps the name it was typed under, and the version the desktop
  // renamed arrives beside it as a named conflict copy. Both notes exist on
  // this device, nothing was trashed, and no tombstone exists -- which is
  // delete-versus-edit keeping both (#98), reached because the source could
  // not be proved and the rename path was therefore never taken.
  assert.equal(b.host.text("Note.md"), "TYPED ON THE PHONE SENTINEL",
    `the phone's own edit was carried away by the rename: ${story(server, a, b)}`);
  assert.ok(
    [...b.host.files.entries()].some(([path, file]) =>
      path !== "Note.md" && new TextDecoder().decode(file.bytes) === BODY),
    `the renamed version reached the phone under no name at all: ${story(server, a, b)}`,
  );
  assert.equal(
    b.host.logs.some((line) => line.includes("decision=renamed")),
    false,
    `a source holding an unpushed edit was renamed: ${b.host.logs.filter((line) => line.startsWith("pull")).join(" | ")}`,
  );
  assert.deepEqual(b.host.trashed, [], `keeping both trashed something: ${story(server, a, b)}`);
  assert.deepEqual(tombstones(server), [], `keeping both published a tombstone: ${story(server, a, b)}`);
});

test("a renamed folder moves every file it holds, and only the folder is tombstoned", async (t) => {
  const { server, timers, a, b, keys: k } = await pair(t, "immediate");

  a.host.write("Notes/One.md", "first\n", 1000);
  a.host.write("Notes/Two.md", "second\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text("Notes/One.md") === "first\n" && b.host.text("Notes/Two.md") === "second\n" &&
    settled(a, "Notes/One.md") && settled(a, "Notes/Two.md"));
  const ids = ["Notes/One.md", "Notes/Two.md"].map((path) => a.state.fileByPath(path).fileId);

  a.host.renameFolder("Notes", "Archive");
  await timers.run(STEP_MS, () => tombstonesFor(server, ids).length > 0 || (
    b.host.text("Archive/One.md") === "first\n" && b.host.text("Archive/Two.md") === "second\n" &&
    settled(b, "Archive/One.md") && settled(b, "Archive/Two.md")));
  await timers.run(STEP_MS, () => b.host.hasFolder("Archive") && !b.host.hasFolder("Notes"));
  await timers.run(STEP_MS);

  assert.deepEqual(tombstonesFor(server, ids), [], `a folder rename tombstoned a note: ${story(server, a, b)}`);
  for (const [index, path] of ["Archive/One.md", "Archive/Two.md"].entries()) {
    assert.equal(a.host.text(path), index === 0 ? "first\n" : "second\n", `the desktop lost ${path}`);
    assert.equal(b.host.text(path), index === 0 ? "first\n" : "second\n", `the phone lost ${path}`);
    assert.equal(b.state.fileByPath(path).fileId, ids[index], "each file kept its identity");
  }
  assert.deepEqual([...b.host.files.keys()].filter((path) => path.startsWith("Notes/")), []);
  // Two notes and two folder records — the tombstoned `Notes` and the live
  // `Archive`. Neither note was re-uploaded under a new identity, which is
  // what `ids` above pins.
  assert.deepEqual(
    server.vaultFiles().sort(),
    [...ids, await c.folderFileId(k.manifestKey, "Notes"), await c.folderFileId(k.manifestKey, "Archive")].sort(),
    "a file was duplicated",
  );
  // The folder moved too, on both devices, and only the FOLDER record was
  // tombstoned to do it (issue #104).
  assert.equal(b.host.hasFolder("Archive"), true, `the phone has no Archive: ${story(server, a, b)}`);
  assert.equal(b.host.hasFolder("Notes"), false, `the phone kept an empty Notes: ${story(server, a, b)}`);
  assert.equal(b.state.folderByPath("Archive") !== undefined, true, "the phone recorded the new folder");
  assert.equal(b.state.folderByPath("Notes"), undefined, "and forgot the old one");
  assert.equal(tombstones(server).length, 1, "exactly one tombstone, and it is the folder's");
  assert.equal(tombstones(server)[0].file_id, await c.folderFileId(k.manifestKey, "Notes"));
});

test("a deletion the user makes after a pull-applied move is still published", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate");

  a.host.write("Note.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Note.md") === BODY && settled(a, "Note.md"));
  a.host.rename("Note.md", "Renamed.md");
  await timers.run(STEP_MS, () => b.host.text("Renamed.md") === BODY && settled(b, "Renamed.md"));
  const fileId = b.state.fileByPath("Renamed.md").fileId;

  // The user really deletes it, on the device that just applied the move.
  // Suppressing the move's own echo must not suppress this.
  b.host.remove("Renamed.md");
  await timers.run(STEP_MS, () =>
    a.host.text("Renamed.md") === null && !settled(a, "Renamed.md") && !settled(b, "Renamed.md"));
  // Quiet first: the device that OBEYS a tombstone trashes a file too, and
  // that removal is echoed back to it like any other. ONE tombstone means
  // one, measured after there is nothing left in flight to add a second.
  await timers.run(STEP_MS);

  assert.equal(tombstones(server).length, 1, `the user's own deletion was swallowed: ${story(server, a, b)}`);
  assert.equal(tombstones(server)[0].file_id, fileId);
  assert.equal(a.host.text("Renamed.md"), null, "the desktop obeyed it");
  assert.equal(a.state.fileByPath("Renamed.md"), undefined);
  assert.equal(b.state.fileByPath("Renamed.md"), undefined);
});

/**
 * THE DESKTOP'S OWN MOVE, AS ITS WATCHER REPORTS IT. `ObsidianHost` moves a
 * note with the filesystem, and Obsidian's desktop watcher reports that as
 * the old name deleted and the new one created -- never the rename the pull
 * path armed its mark for. The delete is the move's echo: recognised as one,
 * it is never decided as a deletion (2026-09-24 run: `removed=5` for five
 * pulled renames, each saved only because the record had moved first), and
 * the mark is spent rather than left to expire.
 */
for (const delivery of ["immediate", "deferred"]) {
  test(`a pulled rename the desktop watcher reports as a delete is its echo, not a deletion (${delivery} vault events)`, async (t) => {
    const { server, timers, a, b } = await pair(t, delivery, { isMobileB: false });
    b.host.watcherMoves = true;
    a.host.write("Note.md", BODY, 1000);
    await a.engine.start();
    await b.engine.start();
    await timers.run(STEP_MS, () => b.host.text("Note.md") === BODY && settled(a, "Note.md"));
    a.host.rename("Note.md", "Renamed.md");
    await timers.run(STEP_MS, landed(server, () => b.host.text("Renamed.md") === BODY && settled(b, "Renamed.md")));
    await timers.run(STEP_MS);

    assert.deepEqual(tombstones(server), [], story(server, a, b));
    const watch = b.host.logs.filter((line) => line.startsWith("watch"));
    assert.ok(watch.some((line) => line.includes("decision=echo_suppressed event=delete reason=moved")), watch.join(" | "));
    assert.ok(!watch.some((line) => line.includes("reason=vanished")), `the move was decided as a deletion: ${watch.join(" | ")}`);
    assert.equal(b.state.fileByPath("Renamed.md").fileId, a.state.fileByPath("Renamed.md").fileId);
  });
}

test("a pending change whose note moved before its rename event follows the live note instead of deleting it", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate");
  a.host.write("Note.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => settled(a, "Note.md") && settled(b, "Note.md"));
  await timers.run(STEP_MS);
  const id = a.state.fileByPath("Note.md").fileId;
  const emit = a.host.emit.bind(a.host);
  a.host.emit = (name, ...args) => { if (name !== "rename") emit(name, ...args); };
  a.engine.changed("Note.md");
  a.host.rename("Note.md", "Renamed.md");
  await timers.run(STEP_MS, landed(server, () =>
    b.host.text("Renamed.md") === BODY && settled(a, "Renamed.md") && settled(b, "Renamed.md")));
  await timers.run(STEP_MS);
  assert.deepEqual(tombstones(server), [], story(server, a, b));
  for (const device of [a, b]) {
    assert.equal(device.host.text("Renamed.md"), BODY);
    assert.equal(device.state.fileByPath("Renamed.md").fileId, id);
    assert.deepEqual(device.host.trashed, []);
  }
});

test("a note typed where a pulled rename left, and deleted, is deleted everywhere though the move's delete never came", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false });
  b.host.watcherMoves = true;
  b.host.silent.add("Note.md");
  a.host.write("Note.md", BODY, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Note.md") === BODY && settled(a, "Note.md"));
  a.host.rename("Note.md", "Renamed.md");
  await timers.run(STEP_MS, () => b.host.text("Renamed.md") === BODY && settled(b, "Renamed.md"));

  const other = "a different note\n";
  b.host.write("Note.md", other, 4000);
  await timers.run(STEP_MS, () => a.host.text("Note.md") === other && settled(b, "Note.md"));
  const fileId = b.state.fileByPath("Note.md").fileId;
  b.host.silent.delete("Note.md");
  b.host.remove("Note.md");
  await timers.run(STEP_MS, () => a.host.text("Note.md") === null);
  await timers.run(STEP_MS);

  assert.equal(tombstones(server).length, 1, `the new note's deletion was swallowed: ${story(server, a, b)}`);
  assert.equal(tombstones(server)[0].file_id, fileId);
  assert.equal(a.host.text("Renamed.md"), BODY, "and the renamed note was not touched");
});

/**
 * The other half of the suppression: it is owed ONE delete event, and a vault
 * event can go missing — that is why startup reconciliation exists at all. A
 * suppression that waited for a lost event forever would swallow the deletion
 * of whatever file occupies that path next, so anything arriving there ends
 * it. Both ways of arriving are driven, because both entry points clear it.
 */
for (const arrival of ["typed", "renamed onto it"]) {
  test(`a note ${arrival} where a pull trashed one is still deleted when the user deletes it`, async (t) => {
    const { server, timers, a, b } = await pair(t, "immediate");

    // The phone never hears about its own trash.
    a.host.write("Note.md", BODY, 1000);
    await a.engine.start();
    await b.engine.start();
    await timers.run(STEP_MS, () => b.host.text("Note.md") === BODY && settled(a, "Note.md"));
    b.host.silent.add("Note.md");
    a.host.rename("Note.md", "Renamed.md");
    await timers.run(STEP_MS, () => b.host.text("Renamed.md") === BODY && settled(b, "Renamed.md"));

    // A different note, put where the pull trashed one, and then deleted.
    const other = "a different note\n";
    if (arrival === "typed") {
      b.host.write("Note.md", other, 4000);
    } else {
      b.host.write("Other.md", other, 4000);
      await timers.run(STEP_MS, () => settled(b, "Other.md") && a.host.text("Other.md") === other);
      b.host.rename("Other.md", "Note.md");
    }
    await timers.run(STEP_MS, () => a.host.text("Note.md") === other && settled(b, "Note.md"));
    const fileId = b.state.fileByPath("Note.md").fileId;
    b.host.remove("Note.md");
    await timers.run(STEP_MS, () => a.host.text("Note.md") === null);
    // The same quiet window: the desktop obeying this tombstone trashes its
    // copy, and that removal must not come back as a second tombstone.
    await timers.run(STEP_MS);

    assert.equal(tombstones(server).length, 1, `the new note's deletion was swallowed: ${story(server, a, b)}`);
    assert.equal(tombstones(server)[0].file_id, fileId);
    assert.equal(a.host.text("Renamed.md"), BODY, "and the renamed note was not touched");
    assert.equal(b.host.text("Renamed.md"), BODY);
  });
}

/**
 * THE FIXTURE'S OWN GUARD, pinned by its refusals.
 *
 * Everything above rests on the fake server telling the two devices apart: it
 * holds one secret PER ENROLLED DEVICE and verifies every request against the
 * device that CLAIMS it. Valid traffic alone does not prove that -- a fixture
 * that admitted an unenrolled identity, or never compared the signature at
 * all, would let a two-device test pass while proving nothing about which
 * device did what, and the tombstone assertions above are exactly assertions
 * about WHICH DEVICE published a version. So the refusals are driven here,
 * through the product's own signer, with sentinel identities and secrets.
 */
function claim(server, id, secret) {
  return new Transport({
    request: server.request,
    serverUrl: () => "https://sync.example.invalid",
    device: () => ({ id, secret: Uint8Array.from(Buffer.from(secret, "hex")) }),
    edgeHeaders: () => [],
    now: () => 1757200000000,
    // One attempt: the refusal is the answer, and retrying it would only
    // bury the reason under `gave_up`.
    maxAttempts: 1,
    sleep: async () => undefined,
    log: () => undefined,
  }).devices();
}

test("the fixture server verifies each request against the device that claims it", async () => {
  const server = new FakeServer();
  server.addDevice(DEVICE_B, SECRET_B, "phone");

  // Controls: each enrolled device, signing with its own secret, is served.
  assert.equal((await claim(server, KEYS.deviceId, KEYS.deviceSecret)).devices.length, 2);
  assert.equal((await claim(server, DEVICE_B, SECRET_B)).devices.length, 2);

  // An identity the server never enrolled is refused, whatever it signs with.
  await assert.rejects(claim(server, UNENROLLED, SECRET_C), /bad_signature/);
  await assert.rejects(claim(server, UNENROLLED, KEYS.deviceSecret), /bad_signature/);

  // Each enrolled device signing with the OTHER one's secret is refused: one
  // device cannot post as the other, which is what makes a per-device
  // assertion about a published version mean anything.
  await assert.rejects(claim(server, DEVICE_B, KEYS.deviceSecret), /bad signature/);
  await assert.rejects(claim(server, KEYS.deviceId, SECRET_B), /bad signature/);

  // And the refusals cost the caller nothing but the refusal: no device was
  // enrolled, renamed or revoked by any of them.
  assert.deepEqual(server.devices.map((device) => device.device_id), [KEYS.deviceId, DEVICE_B]);
});

/**
 * A SELECTED FOLDER THAT MOVES (issue #91).
 *
 * The device that renames a folder it also SELECTED is the one case where the
 * rename fan-out above meets the folder selection: every file under the folder
 * leaves the selection in the same tick, and until 1.0.6 the device answered
 * that with a tombstone per file — which every other device obeys, so renaming
 * a selected folder deleted its notes everywhere. The selection therefore
 * FOLLOWS the folder it names, and when it cannot follow (a destination no
 * device may sync) the exit is not published at all.
 *
 * Only the renaming device restricts itself here: the phone syncs the whole
 * vault, because another device's selection is its own and nothing in this
 * fix changes it.
 */
const NOTES = { "One.md": "first\n", "Two.md": "second\n", "Three.md": "third\n" };

/** Three notes in one selected folder, synced to both devices. */
async function selectedFolder(t, folder = "Notes") {
  const rig = await pair(t, "immediate");
  const { timers, a, b } = rig;
  a.state.data.syncFolders = [folder];
  a.plugin.log = (line) => a.host.logs.push(line);
  for (const [name, body] of Object.entries(NOTES)) a.host.write(`${folder}/${name}`, body, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => Object.entries(NOTES).every(([name, body]) =>
    b.host.text(`${folder}/${name}`) === body && settled(a, `${folder}/${name}`) && settled(b, `${folder}/${name}`)));
  const ids = Object.fromEntries(Object.keys(NOTES).map((name) => [name, a.state.fileByPath(`${folder}/${name}`).fileId]));
  return { ...rig, ids };
}

for (const [destination, what] of [["Journal", "renamed"], ["Archive/Notes", "moved into another folder"]]) {
  test(`a selected folder ${what} keeps its notes on every device, and the selection follows it`, async (t) => {
    const { server, timers, a, b, ids, keys } = await selectedFolder(t);

    a.host.renameFolder("Notes", destination);
    await timers.run(STEP_MS, landed(server, () => Object.entries(NOTES).every(([name, body]) =>
      b.host.text(`${destination}/${name}`) === body && settled(a, `${destination}/${name}`) &&
      settled(b, `${destination}/${name}`))));
    await timers.run(STEP_MS);

    assert.deepEqual(tombstones(server), [], `moving a selected folder published a tombstone: ${story(server, a, b)}`);
    for (const [name, body] of Object.entries(NOTES)) {
      assert.equal(a.host.text(`${destination}/${name}`), body, `the desktop lost ${name}`);
      assert.equal(b.host.text(`${destination}/${name}`), body, `the phone lost ${name}: ${story(server, a, b)}`);
      assert.equal(a.state.fileByPath(`${destination}/${name}`).fileId, ids[name], "the desktop kept the file id");
      assert.equal(b.state.fileByPath(`${destination}/${name}`).fileId, ids[name], "the phone moved it instead of copying it");
      assert.equal(b.state.fileByPath(`Notes/${name}`), undefined);
    }
    assert.deepEqual([...b.host.files.keys()].filter((path) => path.startsWith("Notes/")), []);
    // Notes only: a folder rename retires the old folder record and
    // publishes the new one, which is not a note being copied (#104).
    assert.equal((await server.noteFiles(keys.manifestKey)).length, 3, "no files were duplicated");
    // The selection is what the device syncs from now on, so it names the
    // folder that exists (requirement 12 says so in one line).
    assert.deepEqual(a.state.data.syncFolders, [destination]);
    assert.ok(
      a.host.logs.some((line) => line.includes("scope decision=followed_rename folders=1 selected=1")),
      a.host.logs.filter((line) => line.startsWith("scope")).join(" | "),
    );
    assert.deepEqual(b.state.data.syncFolders, undefined, "the phone's own selection is untouched");
  });
}

test("a selected folder the user really deletes still tombstones every note it held", async (t) => {
  const { server, timers, a, b, ids } = await selectedFolder(t);

  a.host.removeFolder("Notes");
  await timers.run(STEP_MS, () => Object.keys(NOTES).every((name) =>
    b.host.text(`Notes/${name}`) === null && !settled(a, `Notes/${name}`) && !settled(b, `Notes/${name}`)));
  await timers.run(STEP_MS);

  assert.equal(
    tombstonesFor(server, Object.values(ids)).length,
    3,
    `a real deletion was swallowed: ${story(server, a, b)}`,
  );
  assert.deepEqual(
    tombstonesFor(server, Object.values(ids)).map((frame) => frame.file_id).sort(),
    Object.values(ids).sort(),
    "each deleted note was published under its own file id",
  );
  // THE SELECTED FOLDER HAS A RECORD OF ITS OWN (review round 3, finding 1),
  // so deleting it retires that record as well and the phone is left with no
  // empty folder standing where the notes were. Four deleted frames: three
  // notes and the folder.
  assert.equal(tombstones(server).length, 4, `the selected folder's record was not retired: ${story(server, a, b)}`);
  assert.deepEqual(b.host.trashed.slice(-1), ["Notes"], `the phone kept the emptied folder: ${story(server, a, b)}`);
  assert.deepEqual([...b.host.files.keys()], [], "the phone obeyed every one of them");
  assert.deepEqual(a.state.data.syncFolders, ["Notes"], "and the selection did not follow a deletion");
});

test("a selected folder renamed where no device may sync publishes nothing and says so once", async (t) => {
  const { server, timers, a, b, ids } = await selectedFolder(t);
  const published = server.journal.length;

  // A hidden destination is one this version syncs in neither direction
  // (`vaultPath.ts`), so the selection cannot follow it. The notes are still
  // there, under a name this device may not read, and a tombstone for a live
  // note is the one answer that loses them.
  a.host.renameFolder("Notes", ".Journal");
  await timers.run(STEP_MS, () => Object.keys(NOTES).every((name) => !settled(a, `Notes/${name}`)));
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), [], `an unfollowable rename published a tombstone: ${story(server, a, b)}`);
  assert.equal(server.journal.length, published, "and published nothing else either");
  assert.deepEqual(a.state.data.syncFolders, ["Notes"], "the selection stayed where it is");
  for (const name of Object.keys(NOTES)) {
    assert.equal(a.host.text(`.Journal/${name}`), NOTES[name], "the note is alive under its hidden name");
    assert.equal(a.state.fileByPath(`.Journal/${name}`), undefined, "which this device does not track");
    assert.equal(b.host.text(`Notes/${name}`), NOTES[name], `the phone kept its copy of ${name}`);
    assert.equal(b.state.fileByPath(`Notes/${name}`).fileId, ids[name]);
  }
  assert.ok(
    a.host.logs.some((line) => line.includes("scope decision=not_followed reason=hidden_segment folders=1")),
    a.host.logs.filter((line) => line.startsWith("scope")).join(" | "),
  );
  assert.equal(
    a.host.logs.filter((line) => line.includes("rename path_class=file decision=not_published reason=moved_out_of_scope")).length,
    3,
    a.host.logs.filter((line) => line.startsWith("rename")).join(" | "),
  );
  // The selected folder's own record says it in the same words: the folder is
  // ALIVE under its hidden name, so its tombstone is one every other device
  // would obey (review round 3, finding 1).
  assert.equal(
    a.host.logs.filter((line) =>
      line.includes("folder path_class=folder decision=not_published reason=moved_out_of_scope")).length,
    1,
    a.host.logs.filter((line) => line.startsWith("folder")).join(" | "),
  );
  assert.equal(a.state.data.folders["Notes"], undefined, "a record for a folder this device cannot see was kept");
  // Once, not once per note: three refusals are one decision to the user.
  assert.equal(a.host.notices.length, 1, a.host.notices.join(" | "));
  assert.match(a.host.notices[0], /moved out of the folders this device syncs.*Nothing was deleted/s);
});

/**
 * NAMES THAT TRADE PLACES (issue #149).
 *
 * A swap -- Draft to tmp, Final to Draft, tmp to Final, in one call -- reaches
 * the other device as two versions and never as three: the move through tmp
 * is gone before either push reads it. The first to arrive names a note the
 * receiver still holds under the other id, so it landed beside its name, at
 * the name the receiver already gave it; the second found its name held by
 * THAT note and did the same, and nothing ever tried either name again. The
 * two devices then showed the notes under opposite names for good, and the
 * receiver's next edit published its old name back as a rename.
 *
 * A NAME MAP is what two devices that agree hold identically: every tracked
 * path with the file id recorded there, and the text on the disk under it.
 */
const nameMap = (device) => Object.fromEntries(Object.entries(device.state.data.files)
  .map(([path, record]) => [path, `${record.fileId}:${device.host.text(path)}`]).sort());

/** Both devices have heard everything, and neither owes the server anything. */
const quiet = (server, a, b) => [a, b].every((device) => device.state.data.lastSeq === server.seq &&
  Object.values(device.state.data.files).every((record) => record.mtime !== -1));

/** A note's file id, pinned before its first push: which id is lower decides the same-name rule. */
const pin = (device, path, fileId) =>
  device.state.setFile(path, { fileId, versionId: "", mtime: -1, size: 0, sha256: "" });

const LOW = "00".repeat(16);
const HIGH = "ff".repeat(16);
const DRAFT = "# Draft\nthe draft's own text\n";
const FINAL = "# Final\nthe final text, which is longer than the draft's\n";

// Both pinnings, because the version that arrives FIRST is the one that
// waits, and whether the same-name rule may move the note it waits on turns
// on which of the two ids is lower.
for (const delivery of ["immediate", "deferred"]) {
  for (const [draftId, finalId] of [[LOW, HIGH], [HIGH, LOW]]) {
    test(`two notes whose names are swapped in one call show the same names on both devices (${delivery} vault events, draft id ${draftId === LOW ? "lower" : "higher"})`, async (t) => {
      const { server, timers, a, b, keys } = await pair(t, delivery);
      a.host.write("Notes/Draft.md", DRAFT, 1000);
      a.host.write("Notes/Final.md", FINAL, 1000);
      pin(a, "Notes/Draft.md", draftId);
      pin(a, "Notes/Final.md", finalId);
      await a.engine.start();
      await b.engine.start();
      await timers.run(STEP_MS, () => b.host.text("Notes/Draft.md") === DRAFT && b.host.text("Notes/Final.md") === FINAL &&
        settled(b, "Notes/Draft.md") && settled(b, "Notes/Final.md"));
      // The vault has reported the phone's own writes of both notes.
      await timers.run(STEP_MS);
      const published = server.journal.length;

      // One call, three renames: the other device is told about two of them.
      a.host.rename("Notes/Draft.md", "Notes/tmp.md");
      a.host.rename("Notes/Final.md", "Notes/Draft.md");
      a.host.rename("Notes/tmp.md", "Notes/Final.md");
      await timers.run(STEP_MS, () => quiet(server, a, b) && b.state.fileByPath("Notes/Draft.md")?.fileId === finalId)
        .catch(() => undefined);
      await timers.run(STEP_MS);

      assert.deepEqual(nameMap(b), nameMap(a), `the two devices show different names: ${story(server, a, b)}`);
      assert.equal(b.host.text("Notes/Draft.md"), FINAL);
      assert.equal(b.host.text("Notes/Final.md"), DRAFT);
      assert.equal(b.state.fileByPath("Notes/Final.md").fileId, draftId);
      assert.deepEqual(tombstones(server), [], story(server, a, b));
      assert.equal((await server.noteFiles(keys.manifestKey)).length, 2, "a swap made a file");
      // The phone only APPLIED the swap: every move it made to get there is
      // its own echo, and publishing one would move a note on the desktop.
      assert.deepEqual(server.journal.slice(published).filter((frame) => frame.device_id === DEVICE_B), [],
        `the phone published its own moves: ${story(server, a, b)}`);
      // Settled as the second version arrived, not at a later scan.
      const settledBy = b.host.logs.filter((line) => line.includes("decision=renamed_from_beside"));
      assert.ok(settledBy.length > 0 && settledBy.every((line) => /^pull path_class=file decision=renamed_from_beside file=[0-9a-f]{32} seq=\d+$/.test(line)),
        settledBy.join(" | "));

      // The phone's next edit changes the note it edited, under the name it
      // has on both devices, and renames nothing back.
      b.host.write("Notes/Draft.md", `${FINAL}an edit made after the swap\n`, 9000);
      await timers.run(STEP_MS, () => a.host.text("Notes/Draft.md") === `${FINAL}an edit made after the swap\n`)
        .catch(() => undefined);
      await timers.run(STEP_MS);
      assert.deepEqual(nameMap(b), nameMap(a), `an edit after the swap moved a name: ${story(server, a, b)}`);
      assert.equal(a.host.text("Notes/Draft.md"), `${FINAL}an edit made after the swap\n`, story(server, a, b));
    });
  }
}

/**
 * A vault that reports this device's own writes LATE: every create and modify
 * it would report is held back a second, and a name's held reports are
 * delivered the moment a move takes the note off that name -- the latest a
 * real vault can deliver them, after the move they describe is already done.
 */
function lateReports(device, timers) {
  const held = new Map();
  const deliver = (path) => {
    const due = held.get(path) ?? [];
    held.delete(path);
    for (const fire of due) fire();
  };
  const emit = device.host.emit.bind(device.host);
  device.host.emit = (name, entry, ...rest) => {
    if (name !== "create" && name !== "modify") return emit(name, entry, ...rest);
    held.set(entry.path, [...(held.get(entry.path) ?? []), () => {
      for (const handler of device.host.listeners.get(name) ?? []) handler(entry, ...rest);
    }]);
    timers.set(() => deliver(entry.path), 1000);
    return undefined;
  };
  const move = device.host.move.bind(device.host);
  device.host.move = async (from, to) => {
    const outcome = await move(from, to);
    deliver(from);
    return outcome;
  };
}

/**
 * A SWAP THAT ALSO EDITS ONE NOTE. The edited note is WRITTEN where it lands
 * on the phone, and the phone's vault may report that write only after the
 * note has moved on and another note has taken the name: a report that
 * cleared the move's echo would make the move read as the user renaming the
 * note now at that name, and publish that note's record over the other's
 * bytes. So the written note waits for its report and the swap completes a
 * scan later.
 */
test("a swap that also edits a note converges when the phone's vault reports its own writes late", async (t) => {
  const { server, timers, a, b } = await pair(t, "deferred");
  a.host.write("Notes/Draft.md", DRAFT, 1000);
  a.host.write("Notes/Final.md", FINAL, 1000);
  pin(a, "Notes/Draft.md", LOW);
  pin(a, "Notes/Final.md", HIGH);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Notes/Draft.md") === DRAFT && b.host.text("Notes/Final.md") === FINAL &&
    settled(b, "Notes/Draft.md") && settled(b, "Notes/Final.md"));
  lateReports(b, timers);
  const published = server.journal.length;

  const EDITED = `${DRAFT}edited just before the swap\n`;
  a.host.write("Notes/Draft.md", EDITED, 5000);
  a.host.rename("Notes/Draft.md", "Notes/tmp.md");
  a.host.rename("Notes/Final.md", "Notes/Draft.md");
  a.host.rename("Notes/tmp.md", "Notes/Final.md");
  await timers.run(STEP_MS, () => quiet(server, a, b) && b.state.fileByPath("Notes/Draft.md")?.fileId === HIGH &&
    b.state.fileByPath("Notes/Final.md")?.fileId === LOW).catch(() => undefined);
  await timers.run(STEP_MS);

  assert.deepEqual(nameMap(b), nameMap(a), `the two devices show different names: ${story(server, a, b)}`);
  assert.equal(b.host.text("Notes/Final.md"), EDITED, story(server, a, b));
  assert.equal(b.host.text("Notes/Draft.md"), FINAL, story(server, a, b));
  assert.deepEqual(server.journal.slice(published).filter((frame) => frame.device_id === DEVICE_B), [],
    `the phone published a move it only applied: ${story(server, a, b)}`);
  assert.ok(b.host.logs.some((line) => line.startsWith("scan path_class=file decision=renamed_from_beside")),
    b.host.logs.filter((line) => line.includes("beside")).join(" | "));
});

const N11 = "# n11\nthe note the desktop renames\n";
const FROM_LAPTOP = "from the other device, typed while it was closed\n";

/**
 * A RENAME ONTO A NAME THE OTHER DEVICE JUST USED. The laptop, closed, makes
 * Meeting; the desktop renames n11 to Meeting. The laptop cannot wait for
 * its own note to leave the name -- nobody else knows it exists -- so the two
 * notes are settled by the same-name rule on both devices, and the lower file
 * id keeps the name. Both orders are driven: n11's id is pinned below every
 * random id and above every one.
 */
for (const [order, n11] of [["lower", LOW], ["higher", HIGH]]) {
  test(`a note renamed onto a name the other device just made offline ends under one name per note on both (${order} id)`, async (t) => {
    const { server, timers, a, b } = await pair(t, "immediate", { isMobileB: false });
    a.host.write("Notes/n11.md", N11, 1000);
    pin(a, "Notes/n11.md", n11);
    await a.engine.start();
    await b.engine.start();
    await timers.run(STEP_MS, () => b.host.text("Notes/n11.md") === N11 && settled(a, "Notes/n11.md") &&
      settled(b, "Notes/n11.md"));

    b.engine.stop();
    b.host.write("Notes/Meeting.md", FROM_LAPTOP, 2000);
    a.host.rename("Notes/n11.md", "Notes/Meeting.md");
    await timers.run(STEP_MS, () => a.state.fileByPath("Notes/Meeting.md")?.mtime > 0);

    await b.engine.start();
    await timers.run(STEP_MS, () => quiet(server, a, b) && Object.keys(b.state.data.files).length === 2 &&
      JSON.stringify(nameMap(a)) === JSON.stringify(nameMap(b))).catch(() => undefined);
    await timers.run(STEP_MS);

    assert.deepEqual(nameMap(b), nameMap(a), `the two devices name the notes differently: ${story(server, a, b)}`);
    assert.equal(Object.keys(a.state.data.files).length, 2, story(server, a, b));
    assert.equal(a.state.pathByFileId(n11) === "Notes/Meeting.md", order === "lower", "the lower id did not keep the name");
    if (order === "lower") {
      // Moved onto its name as its own version arrived, not at a later scan.
      assert.ok(b.host.logs.some((line) => new RegExp(`^pull path_class=file decision=renamed_from_beside file=${n11} seq=\\d+$`).test(line)),
        b.host.logs.filter((line) => line.startsWith("pull")).join(" | "));
    }
    for (const device of [a, b]) {
      const texts = [...device.host.files.keys()].map((path) => device.host.text(path));
      assert.ok(texts.includes(N11) && texts.includes(FROM_LAPTOP), `a note is missing: ${story(server, a, b)}`);
    }

    // The laptop's next edit of n11 lands in n11 on the desktop, under the
    // name both devices show, and renames nothing back.
    const before = a.state.pathByFileId(n11);
    b.host.write(b.state.pathByFileId(n11), `${N11}an edit on the laptop\n`, 9000);
    await timers.run(STEP_MS, () => a.host.text(a.state.pathByFileId(n11) ?? "") === `${N11}an edit on the laptop\n`)
      .catch(() => undefined);
    await timers.run(STEP_MS);
    assert.equal(a.state.pathByFileId(n11), before, `a later edit renamed the note back: ${story(server, a, b)}`);
    assert.equal(a.host.text(before), `${N11}an edit on the laptop\n`, story(server, a, b));
    assert.deepEqual(nameMap(b), nameMap(a), story(server, a, b));
  });
}

/**
 * AT THE NEXT SCAN. A phone cannot move its own note aside (`moveAside`), so
 * when both devices make a note of one name it keeps both, the desktop's
 * beside its own, and the two devices name them differently -- the price
 * issue #113 states. When the user there deletes the note that held the
 * name, nothing arrives from the feed to say so; the scan finds the name
 * free and the waiting note takes it, and the names agree again.
 */
test("a note beside its name takes it at the next scan once this device's own user frees it", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate");
  a.host.write("Anchor.md", N11, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Anchor.md") === N11 && settled(b, "Anchor.md"));

  b.engine.stop();
  b.host.write("Notes/Same.md", FROM_LAPTOP, 2000);
  a.host.write("Notes/Same.md", DRAFT, 3000);
  pin(a, "Notes/Same.md", LOW);
  await timers.run(STEP_MS, () => a.state.fileByPath("Notes/Same.md")?.mtime > 0);
  await b.engine.start();
  await timers.run(STEP_MS, () => quiet(server, a, b) && b.state.pathByFileId(LOW) !== undefined &&
    Object.keys(a.state.data.files).length === 3);
  const waiting = b.state.pathByFileId(LOW);
  assert.notEqual(waiting, "Notes/Same.md", `the phone moved its own note aside: ${story(server, a, b)}`);
  assert.equal(b.state.fileByPath(waiting).name, "Notes/Same.md", "the copy does not remember the name it waits for");

  b.host.remove("Notes/Same.md");
  await timers.run(STEP_MS, () => b.state.fileByPath("Notes/Same.md")?.fileId === LOW).catch(() => undefined);

  assert.equal(b.host.text("Notes/Same.md"), DRAFT, `the waiting note never took its name: ${story(server, a, b)}`);
  assert.ok(b.host.logs.includes(`scan path_class=file decision=renamed_from_beside file=${LOW} seq=${b.state.data.lastSeq}`),
    b.host.logs.filter((line) => line.includes("beside")).join(" | "));
  assert.equal(b.host.text(waiting), null);
  await timers.run(STEP_MS, () => quiet(server, a, b)).catch(() => undefined);
  await timers.run(STEP_MS);
  assert.deepEqual(nameMap(b), nameMap(a), story(server, a, b));
});
