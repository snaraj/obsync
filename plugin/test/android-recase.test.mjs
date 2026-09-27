/**
 * A capitals-only rename RECEIVED by Android, on the real host (issue #219).
 *
 * Android's shared storage folds capitals, and Obsidian above it answers for
 * the folded name: the case-sensitive `exists` the host asked said every such
 * destination was taken, the version waited beside its name for good, and the
 * device kept the old capitals while its status said synced. Neither Obsidian
 * rename can re-case a name there directly; two of the VAULT's renames through
 * a hidden name can, and keep its index true.
 *
 * These tests run the real `ObsidianHost`, the real engine and the plugin's
 * real vault-event handler over `PhoneVault` (`phone.mjs`), which answers the
 * way the measured emulator did, beside a Mac-like desktop from `fake.mjs`
 * that makes the renames. A phone that keeps the two spellings apart
 * (`folds: false`, an iPhone or iPad) is the control.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { KEYS, STEP_MS, memorySecrets, pair, sandbox, settled } from "./fake.mjs";
import { PhoneVault } from "./phone.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");

const PHONE = "c0ffee00c0ffee00c0ffee00c0ffee00";
const PHONE_SECRET = "5a".repeat(32);
const BODY = "RECASE SENTINEL: a note whose capitals another device changed\n";
const OTHER = "RECASE SENTINEL: the second note in the folder\n";
const THEIRS = "RECASE SENTINEL: a DIFFERENT note already at the new spelling\n";
const CLASH = "RECASE SENTINEL: a hidden file that is not obsync's\n";

/** Every path the server was ever sent, decrypted: the hidden name must be in none. */
async function sentPaths(server, manifestKey) {
  const out = [];
  for (const frame of server.journal) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(
      manifestKey, frame.file_id, binder, c.unhex(frame.manifest_nonce), c.unbase64(frame.manifest_ct),
    ));
    out.push({ path: manifest.path, deleted: frame.deleted, folder: manifest.v === 2, device: frame.device_id });
  }
  return out;
}

/**
 * The Android device: its own state over `store` (the data file a reload
 * reads back), the real host, engine and vault handler over `vault`.
 * Obsidian drops a plugin's vault handlers when it unloads, so a reload
 * starts from none.
 */
async function phone(t, r, fresh = false) {
  const { box, server, timers, vault, store } = r;
  const main = box.require(join(box.home, "build/main.js"));
  const { State } = box.require(join(box.home, "build/state.js"));
  const { Transport } = box.require(join(box.home, "build/transport.js"));
  const { SyncEngine } = box.require(join(box.home, "build/sync/engine.js"));
  const state = await State.open({
    loadData: async () => store.data,
    saveData: async (value) => { store.data = JSON.parse(JSON.stringify(value)); },
  }, true, store.secrets);
  if (fresh) {
    Object.assign(state.data, { vrk: KEYS.vrk, deviceId: PHONE, deviceSecret: PHONE_SECRET, serverUrl: "https://sync.example.invalid" });
  }
  const logs = [];
  const notices = [];
  const plugin = new main.default();
  Object.assign(plugin, {
    app: { vault, fileManager: vault.fileManager, workspace: { getLeavesOfType: () => [] } },
    state,
    manifest: { id: "obsync-private-sync", version: "1.1.4" },
    log: (line) => logs.push(line),
    registerEvent: () => undefined,
    platformName: () => "android",
    deviceName: () => "phone",
  });
  const host = new main.ObsidianHost(plugin, null);
  host.notify = (message) => notices.push(message);
  plugin.host = host;
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: PHONE, secret: Uint8Array.from(Buffer.from(PHONE_SECRET, "hex")) }),
    edgeHeaders: () => [],
    now: () => vault.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => logs.push(line),
  });
  const engine = new SyncEngine({ state, transport, host, now: () => vault.clock, timers });
  plugin.engine = engine;
  vault.listeners.clear();
  plugin.registerVaultEvents();
  t.after(() => engine.stop());
  return { vault, host, state, transport, engine, plugin, logs, notices };
}

/** A Mac-like desktop, the Android device beside it, one server, one clock. */
async function rig(t, { folds = true, delivery = "immediate" } = {}) {
  const { server, timers, a, keys } = await pair(t, "immediate", { caseSensitiveA: false });
  server.addDevice(PHONE, PHONE_SECRET, "android", "android");
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const vault = new PhoneVault(box.require("obsidian"), { folds, delivery });
  const r = { server, timers, a, keys, box, vault, store: { data: null, secrets: memorySecrets() } };
  r.b = await phone(t, r, true);
  return r;
}

/** Notes made on the desktop, synced to the phone. */
async function seeded(t, notes, options) {
  const r = await rig(t, options);
  for (const [path, text] of Object.entries(notes)) r.a.host.write(path, text, 1000);
  await r.a.engine.start();
  await r.b.engine.start();
  await r.timers.run(STEP_MS, () => Object.entries(notes).every(([path, text]) =>
    r.vault.text(path) === text && settled(r.a, path) && settled(r.b, path)));
  r.ids = Object.fromEntries(Object.keys(notes).map((path) => [path, r.a.state.fileByPath(path).fileId]));
  return r;
}

const story = (r) => [
  `phone_disk=${JSON.stringify(r.vault.entries())}`,
  `phone_index=${JSON.stringify(r.vault.indexed())}`,
  `phone_records=${JSON.stringify(r.b.state.data.files)}`,
  `phone_log=${JSON.stringify(r.b.logs.filter((line) => /^(vault|pull|watch|push|reconcile|feed)/.test(line)))}`,
].join(" ");

test("the Android fake answers as the emulator did, and the iPhone fake keeps two spellings apart", async () => {
  const box = sandbox();
  try {
    const android = new PhoneVault(box.require("obsidian"));
    android.seed("X/Probe.md", BODY);
    android.seed("X/Folder/a.md", OTHER);
    assert.equal(await android.adapter.exists("X/probe.md", true), true, "the case-sensitive flag answers for the folded name");
    assert.deepEqual(await android.adapter.list("X"), { files: ["X/Probe.md"], folders: ["X/Folder"] });
    assert.equal(android.text("x/folder/A.md"), OTHER);
    await assert.rejects(android.adapter.rename("X/Probe.md", "X/probe.md"), { message: "Destination file already exists!" });
    await assert.rejects(android.rename(android.getAbstractFileByPath("X/Folder"), "X/folder"), { message: "Destination file already exists!" });
    await assert.rejects(android.rename(android.getAbstractFileByPath("X/Probe.md"), "X/probe.md"), { message: "Destination file already exists!" });
    // Two vault renames through a hidden name: re-cased, two events, a clean index.
    const file = android.getAbstractFileByPath("X/Probe.md");
    await android.rename(file, "X/.obsync-recase-x.md");
    assert.ok(android.getAbstractFileByPath("X/.obsync-recase-x.md"), "the hidden name left the index");
    await android.rename(file, "X/probe.md");
    const folder = android.getAbstractFileByPath("X/Folder");
    await android.rename(folder, "X/.obsync-recase-y");
    await android.rename(folder, "X/folder");
    assert.deepEqual(android.events.map(([name, path, old]) => `${name} ${old} -> ${path}`), [
      "rename X/Probe.md -> X/.obsync-recase-x.md", "rename X/.obsync-recase-x.md -> X/probe.md",
      "rename X/Folder -> X/.obsync-recase-y", "rename X/.obsync-recase-y -> X/folder",
    ]);
    assert.deepEqual(android.indexed(), ["X", "X/folder", "X/folder/a.md", "X/probe.md"]);
    // Two ADAPTER renames: the disk is re-cased and the old spelling stays in the index.
    await android.adapter.rename("X/probe.md", "X/.t");
    await android.adapter.rename("X/.t", "X/PROBE.md");
    assert.deepEqual(android.entries(), ["X", "X/PROBE.md", "X/folder", "X/folder/a.md"]);
    assert.deepEqual(android.indexed(), ["X", "X/PROBE.md", "X/folder", "X/folder/a.md", "X/probe.md"]);
    android.write("X/.hidden", new TextEncoder().encode(CLASH), 1, false);
    android.restart();
    assert.deepEqual(android.indexed(), ["X", "X/PROBE.md", "X/folder", "X/folder/a.md"], "a restart indexed a hidden name or kept a ghost");

    const iphone = new PhoneVault(box.require("obsidian"), { folds: false });
    iphone.seed("X/Probe.md", BODY);
    assert.equal(await iphone.adapter.exists("X/probe.md", true), false);
    await iphone.rename(iphone.getAbstractFileByPath("X/Probe.md"), "X/probe.md");
    assert.deepEqual(iphone.entries(), ["X", "X/probe.md"]);
  } finally {
    rmSync(box.home, { recursive: true, force: true });
  }
});

/** What the phone published: nothing, whatever it applied. */
const phonePosts = async (r) => (await sentPaths(r.server, r.keys.manifestKey)).filter((sent) => sent.device === PHONE);

for (const delivery of ["immediate", "deferred"]) {
  test(`Android receives a capitals-only rename of a note: new spelling on disk, in the index and in the records, nothing sent (${delivery} events)`, async (t) => {
    const r = await seeded(t, { "CaseMove/Rename me.md": BODY, "CaseMove/Other.md": OTHER }, { delivery });
    const id = r.ids["CaseMove/Rename me.md"];
    const before = r.vault.events.length;

    r.a.host.rename("CaseMove/Rename me.md", "CaseMove/rename me.md");
    await r.timers.run(STEP_MS, () => settled(r.b, "CaseMove/rename me.md") && r.vault.entries().includes("CaseMove/rename me.md"));
    await r.timers.run(STEP_MS);
    // And the pass a start makes, which is the one that publishes deletions.
    await r.b.engine.syncNow();
    await r.timers.run(STEP_MS);

    assert.deepEqual(r.vault.entries(), ["CaseMove", "CaseMove/Other.md", "CaseMove/rename me.md"], story(r));
    assert.deepEqual(r.vault.indexed(), ["CaseMove", "CaseMove/Other.md", "CaseMove/rename me.md"], `the index is not clean: ${story(r)}`);
    assert.equal(r.vault.text("CaseMove/rename me.md"), BODY);
    const record = r.b.state.fileByPath("CaseMove/rename me.md");
    assert.equal(record?.fileId, id, `the record did not follow the note: ${story(r)}`);
    assert.equal(record.name, undefined, `the note waits beside its name: ${story(r)}`);
    assert.equal(r.b.state.fileByPath("CaseMove/Rename me.md"), undefined);
    assert.equal(r.b.state.data.pendingRecase, undefined);
    assert.deepEqual(await phonePosts(r), [], `the phone published a rename it only applied: ${story(r)}`);
    assert.equal((await r.server.noteFiles(r.keys.manifestKey)).length, 2, `the note was copied: ${story(r)}`);
    assert.equal((await sentPaths(r.server, r.keys.manifestKey)).filter((sent) => sent.deleted).length, 0);
    // Two vault renames through one hidden name, and one rename to the engine.
    const events = r.vault.events.slice(before);
    const renames = events.filter(([name]) => name === "rename");
    assert.equal(renames.length, 2, JSON.stringify(events));
    assert.match(renames[0][1], /^CaseMove\/\.obsync-recase-[0-9a-f]{16}\.md$/);
    assert.deepEqual([renames[0][2], renames[1][1], renames[1][2]], ["CaseMove/Rename me.md", "CaseMove/rename me.md", renames[0][1]]);
    assert.deepEqual(events.filter(([name]) => name !== "rename"), [], "the re-case was reported as more than two renames");
    assert.equal(r.b.logs.filter((line) => line === "watch path_class=file decision=echo_suppressed event=rename").length, 1, story(r));
    assert.equal(r.b.logs.filter((line) => /^vault path_class=file decision=recased via=temp duration_ms=\d+$/.test(line)).length, 1, story(r));
    assert.deepEqual(r.b.notices, []);
  });
}

test("Android receives a capitals-only FOLDER rename: the folder and the notes under it take the new spelling, nothing sent", async (t) => {
  const r = await seeded(t, { "Team docs/One.md": BODY, "Team docs/Two.md": OTHER });
  const before = r.vault.events.length;

  r.a.host.renameFolder("Team docs", "team docs");
  await r.timers.run(STEP_MS, () => ["team docs/One.md", "team docs/Two.md"].every((path) => settled(r.b, path)) &&
    r.vault.entries().includes("team docs"));
  await r.timers.run(STEP_MS);
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);

  assert.deepEqual(r.vault.entries(), ["team docs", "team docs/One.md", "team docs/Two.md"], story(r));
  assert.deepEqual(r.vault.indexed(), ["team docs", "team docs/One.md", "team docs/Two.md"], `the index is not clean: ${story(r)}`);
  assert.deepEqual(Object.keys(r.b.state.data.files).sort(), ["team docs/One.md", "team docs/Two.md"]);
  assert.deepEqual(["team docs/One.md", "team docs/Two.md"].map((path) => r.b.state.fileByPath(path).fileId),
    [r.ids["Team docs/One.md"], r.ids["Team docs/Two.md"]]);
  assert.deepEqual(Object.keys(r.b.state.data.folders), ["team docs"], story(r));
  assert.deepEqual(await phonePosts(r), [], `the phone published a rename it only applied: ${story(r)}`);
  assert.equal((await r.server.noteFiles(r.keys.manifestKey)).length, 2);
  assert.ok(r.b.logs.some((line) => /^vault path_class=folder decision=recased via=temp /.test(line)), story(r));
  assert.ok(r.b.logs.some((line) => line.startsWith("folder path_class=folder decision=case_renamed files=2")), story(r));
  assert.deepEqual(r.vault.events.slice(before).map(([name]) => name), ["rename", "rename"], JSON.stringify(r.vault.events.slice(before)));
  assert.deepEqual(r.b.notices, []);
});

test("an iPhone with a DIFFERENT note at the new spelling still answers occupied, keeps both, and the same-name rule applies", async (t) => {
  const r = await seeded(t, { "CaseMove/Rename me.md": BODY }, { folds: false });
  // A note made on the phone under the new spelling, not yet sent: on
  // storage that keeps the two spellings apart it is a second entry.
  r.vault.seed("CaseMove/rename me.md", THEIRS, 5000);
  assert.deepEqual(r.vault.entries(), ["CaseMove", "CaseMove/Rename me.md", "CaseMove/rename me.md"]);

  r.a.host.rename("CaseMove/Rename me.md", "CaseMove/rename me.md");
  await r.timers.run(STEP_MS, () => r.b.logs.some((line) => line.startsWith("pull path_class=file decision=case_move_occupied ")));
  await r.timers.run(STEP_MS);

  const texts = r.vault.entries().map((path) => r.vault.text(path)).filter((text) => text !== null);
  assert.ok(texts.includes(BODY) && texts.includes(THEIRS), `a note was lost: ${story(r)}`);
  assert.equal(r.vault.text("CaseMove/rename me.md"), THEIRS, `the other note was written over: ${story(r)}`);
  assert.equal(r.vault.renames.some(([, to]) => to.includes(".obsync-recase-")), false, "an iPhone re-cased through a hidden name");
  assert.equal(r.b.logs.some((line) => line.includes("reason=recase_failed")), false, story(r));
  assert.ok(r.b.logs.some((line) => line.includes("same_name_tiebreak")), `the same-name rule did not apply: ${story(r)}`);
});

/** A re-case whose second step, and the put-back after it, fail: the stop between the two renames. */
async function interrupted(t) {
  const r = await seeded(t, { "CaseMove/Rename me.md": BODY, "CaseMove/Other.md": OTHER });
  // What the data file said at the instant of the first rename.
  let written;
  r.vault.fault = (from, to) => {
    if (to.includes("/.obsync-recase-")) written = structuredClone(r.store.data.pendingRecase);
    return from.includes("/.obsync-recase-");
  };
  r.a.host.rename("CaseMove/Rename me.md", "CaseMove/rename me.md");
  await r.timers.run(STEP_MS, () => r.b.logs.some((line) => /^vault path_class=file decision=failed reason=put_back /.test(line)));
  const temp = r.b.state.data.pendingRecase?.temp;
  assert.match(temp ?? "", /^CaseMove\/\.obsync-recase-[0-9a-f]{16}\.md$/, story(r));
  assert.deepEqual(written, { from: "CaseMove/Rename me.md", temp, to: "CaseMove/rename me.md" }, "the re-case was not written down before its first rename");
  assert.deepEqual(r.vault.entries(), ["CaseMove", "CaseMove/Other.md", temp].sort());
  // THE HOLD: a pass that publishes deletions finds the note as recorded.
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);
  assert.equal(r.b.state.fileByPath("CaseMove/Rename me.md")?.fileId, r.ids["CaseMove/Rename me.md"], story(r));
  // And the feed asking for the rename again while the way back still fails:
  // it waits, and nothing is written beside the hidden entry.
  await r.timers.run(STEP_MS, () => r.b.logs.some((line) => /^vault path_class=file decision=failed reason=rename /.test(line)));
  await r.timers.run(STEP_MS);
  assert.deepEqual(r.vault.entries(), ["CaseMove", "CaseMove/Other.md", temp].sort(), `a copy was written while the re-case was held: ${story(r)}`);
  r.b.engine.stop();
  r.vault.fault = null;
  return { ...r, temp };
}

/** The end every interruption must reach: the rename made, recorded, and nothing deleted or sent. */
async function converged(r, again) {
  await r.timers.run(STEP_MS, () => settled(again, "CaseMove/rename me.md") && r.vault.entries().includes("CaseMove/rename me.md"));
  await r.timers.run(STEP_MS);
  assert.deepEqual(r.vault.entries(), ["CaseMove", "CaseMove/Other.md", "CaseMove/rename me.md"], story({ ...r, b: again }));
  assert.deepEqual(r.vault.indexed(), ["CaseMove", "CaseMove/Other.md", "CaseMove/rename me.md"], story({ ...r, b: again }));
  assert.equal(again.state.fileByPath("CaseMove/rename me.md").fileId, r.ids["CaseMove/Rename me.md"]);
  assert.equal(again.state.data.pendingRecase, undefined);
  assert.equal(r.store.data.pendingRecase, undefined);
  const sent = await sentPaths(r.server, r.keys.manifestKey);
  assert.deepEqual(sent.filter((frame) => frame.deleted && !frame.folder), [], "a tombstone was posted");
  assert.deepEqual(sent.filter((frame) => frame.path.includes(".obsync-recase-")), [], "a request carried the hidden name");
  assert.deepEqual(sent.filter((frame) => frame.device === PHONE), [], "the phone published what it only applied");
}

/** Put back by the start itself, before the pass that publishes deletions -- not later, by whatever renames next. */
function returnedFirst(again) {
  const returned = again.logs.findIndex((line) => /^vault path_class=file decision=returned via=temp /.test(line));
  const pass = again.logs.findIndex((line) => line.startsWith("reconcile decision=start "));
  assert.ok(returned !== -1 && pass !== -1 && returned < pass, `put back at ${returned}, start pass at ${pass}: ${again.logs.join(" | ")}`);
}

test("a re-case stopped between its renames is put back at the next start, then made, and nothing is deleted", async (t) => {
  const r = await interrupted(t);
  const again = await phone(t, r);
  assert.deepEqual(again.state.data.pendingRecase?.temp, r.temp, "the reload lost the pending re-case");
  await again.engine.start();
  returnedFirst(again);
  await converged(r, again);
});

test("a re-case stopped between its renames is put back after Obsidian restarts, when the index no longer holds the hidden name", async (t) => {
  const r = await interrupted(t);
  r.vault.restart();
  assert.equal(r.vault.getAbstractFileByPath(r.temp), null, "a restart indexed a hidden name");
  const again = await phone(t, r);
  await again.engine.start();
  returnedFirst(again);
  await converged(r, again);
});

test("a re-case that cannot be put back is kept and said once, and no pass deletes it until it can", async (t) => {
  const r = await interrupted(t);
  r.vault.restart();
  // An adapter whose rename leaves the index to the next restart.
  r.vault.adapterIndexes = false;
  const again = await phone(t, r);
  await again.engine.start();
  await r.timers.run(STEP_MS);
  await again.engine.syncNow();
  await r.timers.run(STEP_MS);
  assert.ok(again.logs.some((line) => /^vault path_class=file decision=failed reason=not_indexed via=temp /.test(line)), story({ ...r, b: again }));
  assert.deepEqual(again.notices.filter((message) => message.startsWith("obsync could not finish renaming")), [
    'obsync could not finish renaming "CaseMove/Rename me.md" to "CaseMove/rename me.md" on this device. Nothing was deleted. Restart Obsidian to finish.',
  ]);
  assert.deepEqual(again.state.data.pendingRecase?.temp, r.temp, "a failed recovery forgot the re-case");
  assert.equal(r.vault.text("CaseMove/Rename me.md"), BODY);
  assert.equal(again.state.fileByPath("CaseMove/Rename me.md")?.fileId, r.ids["CaseMove/Rename me.md"], story({ ...r, b: again }));
  const sent = await sentPaths(r.server, r.keys.manifestKey);
  assert.deepEqual(sent.filter((frame) => frame.deleted && !frame.folder), [], `a tombstone was posted while the re-case was pending: ${story({ ...r, b: again })}`);
  // Obsidian restarts and shows the note: the rename the feed still holds is
  // asked for again, lets the re-case go, and is made.
  again.engine.stop();
  r.vault.restart();
  r.vault.adapterIndexes = true;
  const third = await phone(t, r);
  await third.engine.start();
  await converged(r, third);
  assert.ok(third.logs.some((line) => /^vault path_class=file decision=recovered via=temp /.test(line)), story({ ...r, b: third }));
});

test("a re-case whose name something else took meanwhile is kept under its hidden name, said once, and deletes nothing", async (t) => {
  const r = await interrupted(t);
  // Another app writes a note under the folded name while the entry is away.
  r.vault.seed("CaseMove/RENAME ME.md", THEIRS, 7000);
  const again = await phone(t, r);
  await again.engine.start();
  await r.timers.run(STEP_MS);
  await again.engine.syncNow();
  await r.timers.run(STEP_MS);
  const hidden = r.temp.slice(r.temp.lastIndexOf("/") + 1);
  assert.ok(again.logs.some((line) => /^vault path_class=file decision=failed reason=occupied via=temp /.test(line)), story({ ...r, b: again }));
  assert.deepEqual(again.notices.filter((message) => message.startsWith("obsync could not finish renaming")), [
    'obsync could not finish renaming "CaseMove/Rename me.md" to "CaseMove/rename me.md" on this device. Nothing was ' +
      `deleted: something else there took that name first, so the note is kept in the same folder as "${hidden}", which ` +
      "Obsidian does not show. Rename the other one, then restart Obsidian to finish.",
  ]);
  assert.equal(r.vault.text(r.temp), BODY, "the note under the hidden name was touched");
  assert.equal(r.vault.text("CaseMove/RENAME ME.md"), THEIRS);
  assert.deepEqual(again.state.data.pendingRecase?.temp, r.temp);
  assert.equal(again.state.fileByPath("CaseMove/Rename me.md")?.fileId, r.ids["CaseMove/Rename me.md"], story({ ...r, b: again }));
  const sent = await sentPaths(r.server, r.keys.manifestKey);
  assert.deepEqual(sent.filter((frame) => frame.deleted && !frame.folder), [], `a tombstone was posted: ${story({ ...r, b: again })}`);
  assert.deepEqual(sent.filter((frame) => frame.path.includes(".obsync-recase-")), []);
});

test("Android answers a rename onto a DIFFERENT entry's folded name occupied, and renames nothing through a hidden name", async (t) => {
  const r = await rig(t);
  r.vault.seed("Notes/Probe.md", BODY);
  // The one entry `Other/probe.md` folds to, and it is not the source.
  r.vault.seed("Other/PROBE.md", THEIRS);
  r.vault.seed("Other/Folder/a.md", OTHER);
  r.vault.seed("Notes/folder/b.md", OTHER);

  assert.equal(await r.b.host.move("Notes/Probe.md", "Other/probe.md"), "occupied");
  assert.equal(await r.b.host.moveFolder("Notes/folder", "Other/folder"), "occupied");
  assert.deepEqual(r.vault.renames, [], "a different entry's name was taken for a re-case");
  assert.equal(r.vault.text("Other/PROBE.md"), THEIRS);
  assert.equal(r.vault.text("Notes/Probe.md"), BODY);
  assert.equal(r.b.logs.some((line) => line.startsWith("vault ")), false, r.b.logs.join(" | "));
});

test("a FOLDER re-case stopped between its renames holds the folder records under it, then is put back and made", async (t) => {
  const r = await seeded(t, { "Team docs/One.md": BODY, "Team docs/Sub/Three.md": OTHER });
  assert.ok(r.b.state.folderByPath("Team docs/Sub"), "the fixture has no folder record under the folder");
  r.vault.fault = (from) => from.includes(".obsync-recase-");
  r.a.host.renameFolder("Team docs", "team docs");
  await r.timers.run(STEP_MS, () => r.b.logs.some((line) => /^vault path_class=folder decision=failed reason=put_back /.test(line)));
  assert.match(r.b.state.data.pendingRecase?.temp ?? "", /^\.obsync-recase-[0-9a-f]{16}$/, story(r));
  // The pass that publishes deletions, while the folder wears a hidden name.
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);
  assert.deepEqual(await phonePosts(r), [], `the phone published while the folder was held: ${story(r)}`);
  assert.ok(r.b.state.folderByPath("Team docs/Sub"), story(r));
  r.b.engine.stop();
  r.vault.fault = null;

  const again = await phone(t, r);
  await again.engine.start();
  assert.ok(again.logs.some((line) => /^vault path_class=folder decision=returned via=temp /.test(line)), again.logs.join(" | "));
  await r.timers.run(STEP_MS, () => ["team docs/One.md", "team docs/Sub/Three.md"].every((path) => settled(again, path)));
  await r.timers.run(STEP_MS);
  assert.deepEqual(r.vault.entries(), ["team docs", "team docs/One.md", "team docs/Sub", "team docs/Sub/Three.md"], story({ ...r, b: again }));
  assert.deepEqual(r.vault.indexed(), ["team docs", "team docs/One.md", "team docs/Sub", "team docs/Sub/Three.md"], story({ ...r, b: again }));
  assert.deepEqual(Object.keys(again.state.data.folders).sort(), ["team docs", "team docs/Sub"], story({ ...r, b: again }));
  assert.deepEqual(await phonePosts(r), [], `the phone published what it only applied: ${story({ ...r, b: again })}`);
});

test("a saved pending re-case is read back only as two spellings of one name and a hidden name of its own shape beside them", () => {
  const { parseData } = require("../build/state.js");
  const read = (pendingRecase) => parseData({ pendingRecase }, true).pendingRecase;
  const good = { from: "Notes/Probe.md", temp: "Notes/.obsync-recase-0123456789abcdef.md", to: "Notes/probe.md" };
  assert.deepEqual(read(good), good);
  assert.deepEqual(read({ from: "Team docs", temp: ".obsync-recase-0123456789abcdef", to: "team docs" }),
    { from: "Team docs", temp: ".obsync-recase-0123456789abcdef", to: "team docs" });
  for (const [what, hostile] of [
    ["two different names", { ...good, to: "Notes/Other.md" }],
    ["the same name twice", { ...good, to: good.from }],
    ["a hidden name in another folder", { ...good, temp: "Other/.obsync-recase-0123456789abcdef.md" }],
    ["a name not of the re-case's shape", { ...good, temp: "Notes/.obsidian" }],
    ["a visible name", { ...good, temp: "Notes/obsync-recase-0123456789abcdef.md" }],
    ["a path out of the vault", { ...good, from: "../Probe.md", to: "../probe.md" }],
    ["no hidden name", { from: good.from, to: good.to }],
  ]) assert.equal(read(hostile), undefined, what);
  assert.equal(read("Notes/Probe.md"), undefined);
  assert.equal(parseData({}, true).pendingRecase, undefined);
});

test("a hidden file already wearing a candidate name is never renamed over", async (t) => {
  const r = await seeded(t, { "CaseMove/Rename me.md": BODY });
  const taken = `CaseMove/.obsync-recase-${"11".repeat(8)}.md`;
  r.vault.write(taken, new TextEncoder().encode(CLASH), 1000, false);
  // The next two 8-byte draws: the taken name, then a free one.
  const real = globalThis.crypto;
  const planned = [0x11, 0x22];
  Object.defineProperty(globalThis, "crypto", {
    value: { subtle: real.subtle, getRandomValues: (bytes) => bytes.length === 8 && planned.length > 0 ? bytes.fill(planned.shift()) : real.getRandomValues(bytes) },
    configurable: true, writable: true,
  });
  t.after(() => Object.defineProperty(globalThis, "crypto", { value: real, configurable: true, writable: true }));

  r.a.host.rename("CaseMove/Rename me.md", "CaseMove/rename me.md");
  await r.timers.run(STEP_MS, () => settled(r.b, "CaseMove/rename me.md") && r.vault.entries().includes("CaseMove/rename me.md"));
  Object.defineProperty(globalThis, "crypto", { value: real, configurable: true, writable: true });

  assert.equal(r.vault.text(taken), CLASH, "the hidden file was renamed over");
  assert.deepEqual(r.vault.renames.map(([, to]) => to), [`CaseMove/.obsync-recase-${"22".repeat(8)}.md`, "CaseMove/rename me.md"]);
  assert.deepEqual(r.vault.entries(), ["CaseMove", taken, "CaseMove/rename me.md"].sort(), story(r));
});

for (const tracked of [false, true]) {
  test(`an index listing one file under two spellings publishes it once (${tracked ? "a tracked note renamed below the index" : "first upload"})`, async (t) => {
    const r = await rig(t);
    r.vault.seed("Notes/Probe.md", BODY, 1000);
    if (tracked) {
      await r.b.engine.start();
      await r.timers.run(STEP_MS, () => settled(r.b, "Notes/Probe.md"));
      r.b.engine.stop();
    }
    // Two adapter renames: the disk is re-cased, the index keeps both.
    await r.vault.adapter.rename("Notes/Probe.md", "Notes/.probe");
    await r.vault.adapter.rename("Notes/.probe", "Notes/probe.md");
    assert.deepEqual(r.vault.indexed(), ["Notes", "Notes/Probe.md", "Notes/probe.md"], "the fake no longer leaves the ghost it must");
    assert.deepEqual(r.vault.entries(), ["Notes", "Notes/probe.md"]);
    const again = tracked ? await phone(t, r) : r.b;
    await again.engine.start();
    await r.timers.run(STEP_MS, () => settled(again, "Notes/probe.md"));
    await r.timers.run(STEP_MS);

    const files = await r.server.noteFiles(r.keys.manifestKey);
    assert.equal(files.length, 1, `one file was published under two ids: ${story({ ...r, b: again })}`);
    const sent = await sentPaths(r.server, r.keys.manifestKey);
    assert.equal(sent.filter((frame) => !frame.folder).at(-1).path, "Notes/probe.md");
    assert.deepEqual(sent.filter((frame) => frame.deleted && !frame.folder), []);
    assert.deepEqual(Object.keys(again.state.data.files), ["Notes/probe.md"]);
    assert.ok(again.logs.includes("list decision=skipped reason=index_ghost files=1"), again.logs.join(" | "));
  });
}

test("a re-case Android could not make is refused, said once, and never published as a second note", async (t) => {
  const r = await seeded(t, { "CaseMove/Rename me.md": BODY });
  const id = r.ids["CaseMove/Rename me.md"];
  // The vault refuses even the step into a hidden name.
  r.vault.fault = (_from, to) => to.includes("/.obsync-recase-");
  r.a.host.rename("CaseMove/Rename me.md", "CaseMove/rename me.md");
  await r.timers.run(STEP_MS, () => r.b.logs.some((line) => line.includes("reason=recase_failed")));
  // And the note's next version, which asks for the same rename again.
  r.a.host.write("CaseMove/rename me.md", `${BODY}edited\n`, 9000);
  await r.timers.run(STEP_MS, () => r.b.logs.filter((line) => line.includes("reason=recase_failed")).length === 2);
  await r.timers.run(STEP_MS);

  const refusal = r.b.logs.find((line) => line.includes("reason=recase_failed"));
  assert.match(refusal, /^pull path_class=file decision=case_move_refused reason=recase_failed file=[0-9a-f]{32} seq=\d+$/);
  assert.deepEqual(r.b.notices, [
    'obsync could not change the capitals of "CaseMove/Rename me.md" to "CaseMove/rename me.md" on this device, so it ' +
      'keeps its old name here. Nothing was deleted. To match your other devices, rename it here to a different name ' +
      'first, then to "rename me.md".',
  ]);
  assert.ok(r.b.logs.some((line) => /^vault path_class=file decision=refused reason=temp_step via=temp /.test(line)), story(r));
  assert.equal(r.b.logs.some((line) => /same_name_tiebreak|applied_beside|local_edit_kept/.test(line)), false, story(r));
  assert.deepEqual(r.vault.entries(), ["CaseMove", "CaseMove/Rename me.md"], story(r));
  assert.equal(r.b.state.fileByPath("CaseMove/Rename me.md")?.fileId, id);
  assert.equal(r.b.state.fileByPath("CaseMove/Rename me.md").name, undefined);
  assert.equal(r.b.state.data.pendingRecase, undefined);
  assert.deepEqual(await phonePosts(r), [], `the phone published the note again: ${story(r)}`);
  assert.equal((await r.server.noteFiles(r.keys.manifestKey)).length, 1);
});
