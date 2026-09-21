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
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FakeHost, FakeServer, FakeTimers, KEYS, fakeState, keys, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");

/**
 * The virtual clock steps in 50 ms, not in seconds: a pull takes milliseconds
 * on a real device and the debounce is 500 ms, so a clock that jumped a second
 * per turn would model a vault whose own echo overtakes the pull that caused
 * it. Stepping small keeps that ordering real; the waits below still walk the
 * clock past 500 ms, so the debounce and the echo gate are exercised.
 */
const STEP_MS = 50;

const DEVICE_B = "00112233445566778899aabbccddeeff";
const SECRET_B = "3c".repeat(32);

/**
 * A vault that behaves like Obsidian's: every mutation, the plugin's own
 * included, comes back to this device as a vault event.
 */
class Vault extends FakeHost {
  constructor({ delivery = "immediate", obsidian, ...options } = {}) {
    super(options);
    this.delivery = delivery;
    this.obsidian = obsidian;
    this.listeners = new Map();
    /** Paths whose `delete` event this vault never delivers (a watcher miss). */
    this.silent = new Set();
  }

  on(name, handler) {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
    return { name };
  }

  emit(name, ...args) {
    const fire = () => {
      for (const handler of this.listeners.get(name) ?? []) handler(...args);
    };
    if (this.delivery === "immediate") fire();
    else setTimeout(fire, 0);
  }

  entry(path, folder = false) {
    const file = folder ? new this.obsidian.TFolder() : new this.obsidian.TFile();
    file.path = path;
    return file;
  }

  // --- what the plugin does to the vault, and what comes back ------------

  async trash(path) {
    const existed = this.files.has(path);
    await super.trash(path);
    if (existed && !this.silent.has(path)) this.emit("delete", this.entry(path));
  }

  async writer(path) {
    const writer = await super.writer(path);
    return { ...writer, commit: async (mtime) => this.commit(writer, path, mtime) };
  }

  async createWriter(path, size, check) {
    const writer = await super.createWriter(path, size, check);
    return { ...writer, commit: async (mtime) => this.commit(writer, path, mtime) };
  }

  async commit(writer, path, mtime) {
    const existed = this.files.has(path);
    const stat = await writer.commit(mtime);
    this.emit(existed ? "modify" : "create", this.entry(path));
    return stat;
  }

  // --- what the USER does to the vault -----------------------------------

  /** Type a note, or edit one. */
  write(path, text, mtime) {
    const existed = this.files.has(path);
    this.seed(path, text, mtime);
    this.emit(existed ? "modify" : "create", this.entry(path));
  }

  /** Rename a note through its inline title: one event, one file. */
  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    this.emit("rename", this.entry(to), from);
  }

  /** Rename a folder: every file under it moves, and Obsidian fires ONE event. */
  renameFolder(from, to) {
    for (const path of [...this.files.keys()].filter((candidate) => candidate.startsWith(`${from}/`))) {
      this.files.set(to + path.slice(from.length), this.files.get(path));
      this.files.delete(path);
    }
    this.emit("rename", this.entry(to, true), from);
  }

  /** Delete a note, the way the user's own delete command does. */
  remove(path) {
    this.files.delete(path);
    this.emit("delete", this.entry(path));
  }
}

/**
 * One device: its vault, its state, its own device secret, its engine, and
 * the plugin's real vault-event registration wired between the two.
 */
async function device(box, server, timers, { id, secret, name, delivery, isMobile = false }) {
  const obsidian = box.require("obsidian");
  const host = new Vault({ delivery, obsidian, isMobile, deviceName: name });
  const { state } = await fakeState(isMobile);
  state.data.deviceId = id;
  state.data.deviceSecret = secret;
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id, secret: Uint8Array.from(Buffer.from(secret, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const engine = new SyncEngine({ state, transport, host, now: () => host.clock, timers });
  // The plugin's own handlers, not a copy of them: `registerVaultEvents` is
  // what maps a vault event onto an engine call, including the fan-out a
  // folder rename needs, and it is part of what issue #96 is about.
  const plugin = new (box.require(join(box.home, "build/main.js")).default)();
  plugin.app = { vault: host };
  plugin.registerEvent = () => undefined;
  plugin.state = state;
  plugin.engine = engine;
  plugin.registerVaultEvents();
  return { host, state, transport, engine, plugin };
}

/** Two paired devices against one server, both running. */
async function pair(t, delivery) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const server = new FakeServer();
  const k = await keys();
  await server.seedDomainMap(k.map, KEYS.domainId);
  server.addDevice(DEVICE_B, SECRET_B, "phone");
  const timers = new FakeTimers();
  const a = await device(box, server, timers, {
    id: KEYS.deviceId, secret: KEYS.deviceSecret, name: "desktop", delivery,
  });
  const b = await device(box, server, timers, {
    id: DEVICE_B, secret: SECRET_B, name: "phone", delivery, isMobile: true,
  });
  t.after(() => { a.engine.stop(); b.engine.stop(); });
  return { server, timers, a, b, keys: k };
}

/**
 * Has this device finished recording the file it pushed or pulled? A version
 * reaches the server, and so the other device, BEFORE its author writes its
 * own record, so a wait that named only the other vault could read a state
 * one statement too early.
 */
const settled = (device, path) => device.state.fileByPath(path) !== undefined;

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

    assert.equal(tombstones(server).length, 1, `the new note's deletion was swallowed: ${story(server, a, b)}`);
    assert.equal(tombstones(server)[0].file_id, fileId);
    assert.equal(a.host.text("Renamed.md"), BODY, "and the renamed note was not touched");
    assert.equal(b.host.text("Renamed.md"), BODY);
  });
}
