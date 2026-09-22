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
import { DEVICE_B, FakeServer, KEYS, SECRET_B, STEP_MS, pair, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const c = require("../build/crypto.js");

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
  await assert.rejects(claim(server, UNENROLLED, SECRET_C), /unenrolled device/);
  await assert.rejects(claim(server, UNENROLLED, KEYS.deviceSecret), /unenrolled device/);

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

  assert.equal(tombstones(server).length, 3, `a real deletion was swallowed: ${story(server, a, b)}`);
  assert.deepEqual(
    tombstones(server).map((frame) => frame.file_id).sort(),
    Object.values(ids).sort(),
    "each deleted note was published under its own file id",
  );
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
  // Once, not once per note: three refusals are one decision to the user.
  assert.equal(a.host.notices.length, 1, a.host.notices.join(" | "));
  assert.match(a.host.notices[0], /moved out of the folders this device syncs.*Nothing was deleted/s);
});
