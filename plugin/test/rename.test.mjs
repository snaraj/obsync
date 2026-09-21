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

/** What the two devices did to each other, for a failure that has to be read. */
const story = (server, a, b) =>
  [`journal=${server.journal.map((frame) => `${frame.seq}${frame.deleted ? ":tombstone" : ""}`).join(",")}`,
    `desktop_trashed=${JSON.stringify(a.host.trashed)}`,
    `phone_trashed=${JSON.stringify(b.host.trashed)}`,
    `desktop_files=${JSON.stringify([...a.host.files.keys()])}`,
    `phone_files=${JSON.stringify([...b.host.files.keys()])}`].join(" ");

const BODY = "# A note\nwith a body that must survive its own rename\n";

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
    // The phone's own vault told it the pull's trash had happened; it
    // recognised the echo instead of publishing it (requirement 12).
    assert.ok(
      b.host.logs.some((line) => line.includes("decision=echo_suppressed") && line.includes("event=delete")),
      b.host.logs.filter((line) => line.startsWith("watch")).join(" | "),
    );
  });
}

test("a renamed folder moves every file it holds, and neither device publishes a tombstone", async (t) => {
  const { server, timers, a, b } = await pair(t, "immediate");

  a.host.write("Notes/One.md", "first\n", 1000);
  a.host.write("Notes/Two.md", "second\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () =>
    b.host.text("Notes/One.md") === "first\n" && b.host.text("Notes/Two.md") === "second\n" &&
    settled(a, "Notes/One.md") && settled(a, "Notes/Two.md"));
  const ids = ["Notes/One.md", "Notes/Two.md"].map((path) => a.state.fileByPath(path).fileId);

  a.host.renameFolder("Notes", "Archive");
  await timers.run(STEP_MS, landed(server, () =>
    b.host.text("Archive/One.md") === "first\n" && b.host.text("Archive/Two.md") === "second\n" &&
    settled(b, "Archive/One.md") && settled(b, "Archive/Two.md")));
  await timers.run(STEP_MS);

  assert.deepEqual(tombstones(server), [], `a folder rename published a tombstone: ${story(server, a, b)}`);
  for (const [index, path] of ["Archive/One.md", "Archive/Two.md"].entries()) {
    assert.equal(a.host.text(path), index === 0 ? "first\n" : "second\n", `the desktop lost ${path}`);
    assert.equal(b.host.text(path), index === 0 ? "first\n" : "second\n", `the phone lost ${path}`);
    assert.equal(b.state.fileByPath(path).fileId, ids[index], "each file kept its identity");
  }
  assert.deepEqual([...b.host.files.keys()].filter((path) => path.startsWith("Notes/")), []);
  assert.equal(server.vaultFiles().length, 2, "no files were duplicated");
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
