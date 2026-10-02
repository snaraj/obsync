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
    out.push({ path: manifest.path, deleted: frame.deleted, folder: manifest.v === 2, device: frame.device_id, size: manifest.size });
  }
  return out;
}

/**
 * The Android device: its own state over `store` (the data file a reload
 * reads back), the real host, engine and vault handler over `vault`.
 * Obsidian drops a plugin's vault handlers when it unloads, so a reload
 * starts from none.
 */
async function phone(t, r, fresh = false, id = PHONE, secret = PHONE_SECRET) {
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
    Object.assign(state.data, { vrk: KEYS.vrk, deviceId: id, deviceSecret: secret, serverUrl: "https://sync.example.invalid" });
  }
  const logs = [];
  const notices = [];
  // Set by `kill`: the process is gone, and nothing it had under way reaches the server.
  let dead = false;
  const plugin = new main.default();
  Object.assign(plugin, {
    app: { vault, fileManager: vault.fileManager, workspace: { getLeavesOfType: () => [] } },
    state,
    // Obsidian gives every loaded plugin the vault path it was loaded from.
    manifest: { id: "obsync-private-sync", version: "1.1.4", dir: ".obsidian/plugins/obsync-private-sync" },
    log: (line) => logs.push(line),
    registerEvent: () => undefined,
    platformName: () => "android",
    deviceName: () => "phone",
  });
  const host = new main.ObsidianHost(plugin, null);
  // What the person reads: each notice's words, as its toast says them (`notices.ts`).
  const words = box.require(join(box.home, "build/notices.js"));
  host.notify = (notice) => notices.push(words.toastText(notice));
  plugin.host = host;
  const transport = new Transport({
    request: async (request) => {
      if (dead) throw new Error("sentinel: this process was stopped");
      // A request the test says never arrives.
      if (r.lost?.(request)) throw new Error("sentinel: no route");
      return await server.request(request);
    },
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id, secret: Uint8Array.from(Buffer.from(secret, "hex")) }),
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
  // Android ending the app: no save, no request, no further write of its own.
  const kill = () => { dead = true; engine.stop(); };
  return { vault, host, state, transport, engine, plugin, logs, notices, kill };
}

/** A Mac-like desktop, the Android device beside it, one server, one clock. */
async function rig(t, options = {}) {
  const { server, timers, a, keys } = await pair(t, "immediate", { caseSensitiveA: false });
  server.addDevice(PHONE, PHONE_SECRET, "android", "android");
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const vault = new PhoneVault(box.require("obsidian"), options);
  const r = { server, timers, a, keys, box, vault, store: { data: null, secrets: memorySecrets() } };
  r.b = await phone(t, r, true);
  return r;
}

/**
 * Notes made on the desktop, synced to the phone -- IN ONE ORDER ON EVERY RUN.
 * The desktop's posts run side by side and the server journals them as they
 * complete, so a loaded machine journaled `Team docs/Sub` before `Team docs`:
 * the phone then made `Team docs` on its way to the subfolder and gave it a
 * record of its own, as a pull that makes a folder does. The server answered
 * with the version it held, so nothing changed, but the phone had posted.
 * Here each folder's record lands before the next level is made, and the
 * notes before the phone starts reading.
 */
async function seeded(t, notes, options) {
  const r = await rig(t, options);
  await r.a.engine.start();
  const folders = [...new Set(Object.keys(notes).flatMap((path) =>
    path.split("/").slice(0, -1).map((_, depth, parts) => parts.slice(0, depth + 1).join("/"))))];
  for (const folder of folders.sort((x, y) => x.split("/").length - y.split("/").length)) {
    r.a.host.makeFolder(folder);
    await r.timers.run(STEP_MS, () => r.a.state.folderByPath(folder) !== undefined);
  }
  for (const [path, text] of Object.entries(notes)) r.a.host.write(path, text, 1000);
  await r.timers.run(STEP_MS, () => Object.keys(notes).every((path) => settled(r.a, path)));
  await r.b.engine.start();
  await r.timers.run(STEP_MS, () => Object.entries(notes).every(([path, text]) => r.vault.text(path) === text && settled(r.b, path)));
  r.ids = Object.fromEntries(Object.keys(notes).map((path) => [path, r.a.state.fileByPath(path).fileId]));
  return r;
}

const story = (r) => [
  `phone_disk=${JSON.stringify(r.vault.entries())}`,
  `phone_index=${JSON.stringify(r.vault.indexed())}`,
  `phone_records=${JSON.stringify(r.b.state.data.files)}`,
  `phone_log=${JSON.stringify(r.b.logs.filter((line) => /^(vault|pull|watch|push|reconcile|feed|folder|scope)/.test(line)))}`,
  `phone_folders=${JSON.stringify(Object.keys(r.b.state.data.folders))}`,
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
    // Two vault renames through a hidden name, BACK TO BACK: re-cased, two
    // renames reported, and the watcher's late reconcile of the old name
    // indexes it again -- a second entry for one file (6 of 20 live).
    const file = android.getAbstractFileByPath("X/Probe.md");
    await android.rename(file, "X/.obsync-recase-x.md");
    await android.rename(file, "X/probe.md");
    await android.settle();
    assert.deepEqual(android.entries(), ["X", "X/Folder", "X/Folder/a.md", "X/probe.md"]);
    assert.deepEqual(android.indexed(), ["X", "X/Folder", "X/Folder/a.md", "X/Probe.md", "X/probe.md"], "no ghost where the emulator left one");
    assert.notEqual(android.getAbstractFileByPath("X/Probe.md"), file, "the ghost is a second entry, not the renamed one");
    assert.equal(await android.adapter.exists("X/Probe.md", true), true);
    await android.adapter.reconcileDeletion("X/Probe.md", "X/Probe.md", true);
    // The same with a turn and the queue let run between the steps: clean (0 of 20 live).
    await android.rename(file, "X/.obsync-recase-z.md");
    await android.settle();
    assert.ok(android.getAbstractFileByPath("X/.obsync-recase-z.md"), "the hidden name left the index before 100 ms");
    await android.rename(file, "X/PROBE.md");
    await android.settle(150);
    assert.deepEqual(android.indexed(), ["X", "X/Folder", "X/Folder/a.md", "X/PROBE.md"]);
    // A folder's rename reports the folder and every entry under it.
    const before = android.events.length;
    await android.rename(android.getAbstractFileByPath("X/Folder"), "X/Other");
    assert.deepEqual(android.events.slice(before).map(([name, path, old]) => `${name} ${old} -> ${path}`),
      ["rename X/Folder -> X/Other", "rename X/Folder/a.md -> X/Other/a.md"]);
    // A hidden name the index holds leaves it 100 ms after the watcher sees it.
    await android.rename(file, "X/.obsync-recase-w.md");
    await android.settle(150);
    assert.equal(android.getAbstractFileByPath("X/.obsync-recase-w.md"), null);
    await android.adapter.rename("X/.obsync-recase-w.md", "X/probe.md");
    await android.settle();
    assert.deepEqual(android.indexed(), ["X", "X/Other", "X/Other/a.md", "X/probe.md"], "the watcher did not index the name the adapter's rename left out");
    // Deleting a ghost deletes the note: the ghost's `delete`, then the note's, 100 ms later.
    await android.adapter.rename("X/probe.md", "X/.v");
    await android.adapter.rename("X/.v", "X/Probe.md");
    await android.settle();
    const ghost = android.getAbstractFileByPath("X/probe.md");
    assert.ok(ghost && android.getAbstractFileByPath("X/Probe.md"));
    const deletes = android.events.length;
    await android.fileManager.trashFile(ghost);
    assert.deepEqual(android.entries(), ["X", "X/Other", "X/Other/a.md"], "a removal of the ghost left the note");
    await android.settle(150);
    assert.deepEqual(android.events.slice(deletes).map(([name, path]) => `${name} ${path}`), ["delete X/probe.md", "delete X/Probe.md"]);
    android.write("X/.hidden", new TextEncoder().encode(CLASH), 1, false);
    android.seed("X/Kept.md", BODY);
    android.index.set("X/KEPT.md", android.entry("X/KEPT.md", false));
    android.restart();
    assert.deepEqual(android.indexed(), ["X", "X/Kept.md", "X/Other", "X/Other/a.md"], "a restart indexed a hidden name or kept a ghost");
    const blind = new PhoneVault(box.require("obsidian"), { indexApi: false });
    assert.equal(blind.adapter.reconcileDeletion, undefined);

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
  const r = await seeded(t, { "Team docs/One.md": BODY, "Team docs/Two.md": OTHER, "Team docs/Sub/Three.md": CLASH });
  const before = r.vault.events.length;
  const three = ["team docs/One.md", "team docs/Two.md", "team docs/Sub/Three.md"];

  r.a.host.renameFolder("Team docs", "team docs");
  await r.timers.run(STEP_MS, () => three.every((path) => settled(r.b, path)) && r.vault.entries().includes("team docs"));
  await r.timers.run(STEP_MS);
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);

  assert.deepEqual(r.vault.entries(), ["team docs", "team docs/One.md", "team docs/Sub", "team docs/Sub/Three.md", "team docs/Two.md"], story(r));
  assert.deepEqual(r.vault.indexed(), ["team docs", "team docs/One.md", "team docs/Sub", "team docs/Sub/Three.md", "team docs/Two.md"], `the index is not clean: ${story(r)}`);
  assert.deepEqual(Object.keys(r.b.state.data.files).sort(), [...three].sort());
  assert.deepEqual(three.map((path) => r.b.state.fileByPath(path).fileId),
    [r.ids["Team docs/One.md"], r.ids["Team docs/Two.md"], r.ids["Team docs/Sub/Three.md"]]);
  assert.deepEqual(Object.keys(r.b.state.data.folders).sort(), ["team docs", "team docs/Sub"], story(r));
  // The live run's echo: Obsidian reports every entry under the folder too,
  // and each report taken again published the moves and a subfolder's
  // records back as the phone's own.
  assert.deepEqual(await phonePosts(r), [], `the phone published a rename it only applied: ${story(r)}`);
  assert.equal((await r.server.noteFiles(r.keys.manifestKey)).length, 3);
  assert.ok(r.b.logs.some((line) => /^vault path_class=folder decision=recased via=temp /.test(line)), story(r));
  assert.ok(r.b.logs.some((line) => line.startsWith("folder path_class=folder decision=case_renamed files=3")), story(r));
  assert.deepEqual(r.vault.events.slice(before).map(([name]) => name), Array(10).fill("rename"), JSON.stringify(r.vault.events.slice(before)));
  assert.deepEqual(r.b.notices, []);
});

const turns = async (n) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

/**
 * WORK ASKED FOR WHILE THE PHONE APPLIES A RECEIVED RENAME (#244). The vault
 * reports a rename the pull makes before the host's call returns, and that
 * report spends the rename's echo mark; the records follow the entry only after
 * the adapter's next answers -- a `list` for a folder, a `stat` for a note. A
 * pass, or the watcher's deletion burst, comparing the vault with the records
 * in between found the entry moved and nothing recorded there, and published
 * the move as the phone's own (5 of 20 folder re-cases under load); a listing
 * taken just BEFORE the rename and compared after it pairs the move backwards.
 * Here each point's answer -- `call`, once `when` holds -- is held, as a slow
 * bridge holds it, until its `act` is done or 100 turns have passed. Every
 * `when` also asks that the records still name the old place, so each `act`
 * runs inside the pull or not at all, and the test says which.
 */
function during(r, ...points) {
  r.vault.lag = async (name, path) => {
    const point = points.find((candidate) => candidate.work === undefined && candidate.call === name && candidate.when(path));
    if (point === undefined) return;
    point.work = point.act();
    await Promise.race([point.work, turns(100)]);
  };
  return points;
}

/** Until `done` holds, or 1000 turns. */
const until = async (done) => { for (let i = 0; i < 1000 && !done(); i++) await turns(1); };

/** The last line `later` matches comes after the first `first` matches: the pull finished before that work began. */
function after(logs, first, later) {
  const done = logs.findIndex((line) => first.test(line));
  const began = logs.findLastIndex((line) => later.test(line));
  assert.ok(done !== -1 && done < began, `the pull finished at ${done}, the work began at ${began}: ${logs.join(" | ")}`);
}

const PASS = /^reconcile decision=start /;
const BURST = /^watch decision=settled reason=vanished /;

test("a pass asked for while Android applies a received FOLDER re-case waits for it, and nothing is sent (#244)", async (t) => {
  const r = await seeded(t, { "Team docs/One.md": BODY, "Team docs/Two.md": OTHER, "Team docs/Sub/Three.md": CLASH });
  const three = ["team docs/One.md", "team docs/Two.md", "team docs/Sub/Three.md"];
  const [pass] = during(r, {
    call: "list",
    when: () => r.vault.entries().includes("team docs") && r.b.state.fileByPath("Team docs/One.md") !== undefined,
    act: () => {
      const work = r.b.engine.reconcile();
      // What the phone's clock says passed while the pass waited.
      r.vault.clock += 250;
      return work;
    },
  });

  r.a.host.renameFolder("Team docs", "team docs");
  await r.timers.run(STEP_MS, () => pass.work !== undefined && three.every((path) => settled(r.b, path)));
  await pass.work;
  await r.timers.run(STEP_MS);

  assert.deepEqual(await phonePosts(r), [], `the phone published a rename it only applied: ${story(r)}`);
  after(r.b.logs, /^folder path_class=folder decision=case_renamed /, PASS);
  assert.deepEqual(r.b.logs.filter((line) => line.includes("decision=waited")),
    ["reconcile decision=waited reason=pull_lock duration_ms=250 budget_ms=5000"], story(r));
  assert.deepEqual(Object.keys(r.b.state.data.files).sort(), [...three].sort(), story(r));
  assert.deepEqual(Object.keys(r.b.state.data.folders).sort(), ["team docs", "team docs/Sub"], story(r));
  assert.deepEqual(r.b.notices, []);
});

for (const folds of [true, false]) {
  test(`a scan, a pass and a deletion burst asked for while ${folds ? "Android" : "an iPhone"} applies a received note rename wait for it, and nothing is sent (#244)`, async (t) => {
    const r = await seeded(t, { "Notes/Old name.md": BODY, "Notes/Other.md": OTHER }, { folds });
    const id = r.ids["Notes/Old name.md"];
    // Every debounce the seeding left has settled: the burst below is the one this test starts.
    await r.timers.run(STEP_MS);
    const report = Object.assign(Object.create(Object.getPrototypeOf(r.vault.getFileByPath("Notes/Old name.md"))), { path: "Notes/Old name.md" });
    const recorded = () => r.b.state.fileByPath("Notes/Old name.md") !== undefined;
    const [scan, pass] = during(r, {
      // The pull asks where the note may go, before it moves it: the scan
      // brought forward by the app coming to the front lists the vault now.
      call: "list",
      when: (path) => path === "Notes" && r.vault.text("Notes/Old name.md") === BODY && recorded() && r.server.files.get(id).versions.length === 2,
      act: async () => {
        r.b.engine.wake("foreground");
        await until(() => r.b.engine.scanHandle !== null);
      },
    }, {
      // The note is at its new name, its record still at the old one.
      call: "stat",
      when: (path) => path === "Notes/New name.md" && r.vault.text(path) === BODY && recorded(),
      act: async () => {
        // The watcher's late report of the pull's own write, naming the note
        // where it was then: its debounce finds the note gone from there, and
        // the burst that follows asks where it went.
        r.vault.emit("modify", report);
        await Promise.all([r.b.engine.reconcile(), until(() => r.b.logs.some((line) => BURST.test(line)))]);
      },
    });

    r.a.host.rename("Notes/Old name.md", "Notes/New name.md");
    await r.timers.run(STEP_MS, () => scan.work !== undefined && pass.work !== undefined && settled(r.b, "Notes/New name.md"));
    await Promise.all([scan.work, pass.work]);
    await r.timers.run(STEP_MS);

    assert.deepEqual(await phonePosts(r), [], `the phone published a rename it only applied: ${story(r)}`);
    const applied = new RegExp(`^pull path_class=file bytes=\\d+ decision=renamed file=${id} `);
    after(r.b.logs, applied, PASS);
    after(r.b.logs, applied, BURST);
    assert.ok(r.b.logs.includes("watch path_class=file decision=deferred reason=missing_during_settle"), `the report's debounce did not settle inside the window: ${story(r)}`);
    assert.notEqual(r.b.engine.scanHandle, null, "the scan never finished");
    assert.deepEqual(r.b.logs.filter((line) => line.startsWith("scan decision=queued ")), [], story(r));
    assert.equal(r.b.state.fileByPath("Notes/New name.md")?.fileId, id, story(r));
    assert.equal(r.b.state.fileByPath("Notes/Old name.md"), undefined);
    assert.deepEqual(r.b.notices, []);
  });
}

// The lock covers a pass's comparison, not a press's content check: that
// only queues unchanged files, and inside the lock it held another device's
// page for minutes on a phone of 7,700 notes (#244, #246). A phone's Sync now
// reads nothing unchanged any more (#246); Verify all files still does.
test("a page from another device lands while a phone's Verify all files content check runs, not after it (#244)", async (t) => {
  const r = await seeded(t, { "Check/One.md": BODY, "Notes/Two.md": OTHER });
  // THE HOLD IS THE PRESS'S. The phone's own write of the seeded notes is
  // still settling (`settle`, the watcher's debounce), and that settle asks
  // `syncable` too: on a loaded machine it came after the hold was set and
  // took it, the press ran unheld, and the guard below fired (2 of 50
  // whole-file runs, lane K). Nothing settles once the watcher has nothing pending.
  await r.timers.run(STEP_MS, () => r.b.engine.pending.size === 0);
  let held = false;
  let release;
  const check = new Promise((resolve) => { release = resolve; });
  const syncable = r.b.host.syncable.bind(r.b.host);
  r.b.host.syncable = async (path, kind) => {
    if (path === "Check/One.md" && !held) { held = true; await check; }
    return syncable(path, kind);
  };
  let pressed = false;
  const press = r.b.engine.verifyAll().then(() => { pressed = true; });
  await r.timers.run(STEP_MS, () => held);

  r.a.host.write("Notes/Two.md", THEIRS, 7000);
  await r.timers.run(STEP_MS, () => r.vault.text("Notes/Two.md") === THEIRS && settled(r.b, "Notes/Two.md"))
    .catch((error) => { throw new Error(`the page waited for the content check: ${error.message}: ${story(r)}`); });
  assert.equal(pressed, false, "the content check was not held while the page landed: this test proves nothing");
  release();
  await r.timers.run(STEP_MS, () => pressed);
  await press;

  assert.deepEqual(await phonePosts(r), [], story(r));
  assert.equal(r.a.host.text("Check/One.md"), BODY);
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
  // THE RECORD IS APPLIED WHEN THE FEED HAS MOVED PAST IT, not after a
  // quiet spell (issue #277): the rule publishes the phone's own note first
  // (`identify`), a whole push that a loaded machine did not finish inside
  // one quiet window.
  const seq = Number(/ seq=(\d+)$/.exec(r.b.logs.find((line) => line.startsWith("pull path_class=file decision=case_move_occupied ")))[1]);
  await r.timers.run(STEP_MS, () => r.b.state.data.lastSeq >= seq);

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
  // A watcher that reports nothing: the adapter's rename of a name the index
  // does not hold leaves the index to the next restart.
  r.vault.watching = false;
  const again = await phone(t, r);
  await again.engine.start();
  await r.timers.run(STEP_MS);
  await again.engine.syncNow();
  await r.timers.run(STEP_MS);
  assert.ok(again.logs.some((line) => /^vault path_class=file decision=failed reason=not_indexed via=temp /.test(line)), story({ ...r, b: again }));
  assert.deepEqual(again.notices.filter((message) => message.startsWith("obsync: could not finish renaming")), [
    'obsync: could not finish renaming "Rename me" to "rename me" here; nothing was deleted. Restart Obsidian to finish.',
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
  r.vault.watching = true;
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
  assert.deepEqual(again.notices.filter((message) => message.startsWith("obsync: could not finish renaming")), [
    'obsync: could not finish renaming "Rename me" to "rename me" here; nothing was deleted. Something else took that ' +
      `name first, so the note is kept beside it as "${hidden}", which Obsidian does not show: rename the other one, ` +
      "then restart Obsidian to finish.",
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
  // Sync now asks the feed at once (#197): the folder records wait for the
  // entry, and nothing is made where it is to come back.
  assert.ok(r.b.logs.some((line) => /^pull path_class=folder decision=held reason=recase_pending file=[0-9a-f]{32} seq=\d+$/.test(line)), story(r));
  assert.deepEqual(r.vault.entries().filter((path) => !path.startsWith(".obsync-recase-")), [], `a folder was made where the entry is to come back: ${story(r)}`);
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
  // Nor did it try: a post the server answers with a version it already
  // holds writes no frame, so the phone's own log is the witness.
  assert.deepEqual([...r.b.logs, ...again.logs].filter((line) => /decision=(published|pushed)\b/.test(line)), [], story({ ...r, b: again }));
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
    // Two adapter renames, back to back: the disk is re-cased, and the
    // watcher's late reconcile of the old name indexes it again.
    await r.vault.adapter.rename("Notes/Probe.md", "Notes/.probe");
    await r.vault.adapter.rename("Notes/.probe", "Notes/probe.md");
    await r.vault.settle();
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
    'obsync: could not change the capitals of "Rename me" to "rename me" here, so it keeps its old name; nothing was ' +
      'deleted. To match your other devices, rename it to any other name first, then to "rename me".',
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

/**
 * Re-cases whose watcher reports arrive after both steps, as a busy device's
 * can: Obsidian indexes each old name again once its re-case is made.
 */
async function lateReport(t, notes, renames, options) {
  const r = await seeded(t, notes, options);
  const before = r.vault.events.length;
  r.vault.pause();
  for (const [from, to] of renames) (notes[from] === undefined ? r.a.host.renameFolder : r.a.host.rename).call(r.a.host, from, to);
  const recorded = Object.keys(r.b.state.data.files).length;
  await r.timers.run(STEP_MS, () => renames.every(([from, to]) => r.vault.entries().includes(to)
    && !Object.keys(r.b.state.data.files).some((path) => path === from || path.startsWith(`${from}/`)))
    && Object.keys(r.b.state.data.files).length === recorded && r.b.state.data.lastSeq === r.server.journal.at(-1).seq);
  r.vault.resume();
  await r.vault.settle();
  return { ...r, before };
}

const TWO = { "CaseMove/Rename me.md": BODY, "CaseMove/Other.md": OTHER };
const RENAMED = ["CaseMove/Rename me.md", "CaseMove/rename me.md"];
const GHOSTED = ["CaseMove", "CaseMove/Other.md", "CaseMove/Rename me.md", "CaseMove/rename me.md"];

test("a report that arrives after the re-case indexes the old name again, and the host takes it out at once, sending nothing", async (t) => {
  const r = await lateReport(t, TWO, [RENAMED]);
  await r.timers.run(STEP_MS, () => r.b.logs.includes("vault path_class=file decision=unindexed reason=ghost"));
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);

  assert.deepEqual(r.vault.events.slice(r.before).filter(([name]) => name !== "rename").map(([name, path]) => `${name} ${path}`),
    ["create CaseMove/Rename me.md", "delete CaseMove/Rename me.md"], "no ghost was made: this test proves nothing");
  assert.deepEqual(r.vault.indexed(), ["CaseMove", "CaseMove/Other.md", "CaseMove/rename me.md"], `the ghost stayed: ${story(r)}`);
  assert.equal(r.vault.text("CaseMove/rename me.md"), BODY);
  assert.deepEqual(Object.keys(r.b.state.data.files).sort(), ["CaseMove/Other.md", "CaseMove/rename me.md"], story(r));
  assert.deepEqual(await phonePosts(r), [], `the phone published the ghost or its removal: ${story(r)}`);
  assert.equal(r.b.logs.filter((line) => /reason=(ghost|no_index_api|unghost)\b/.test(line)).length, 1, story(r));
  // The engine heard of neither: the removal's `delete`, taken for the
  // person's, sent it looking for a note it found under the ghost's name.
  assert.deepEqual(r.b.logs.filter((line) => /^push |reason=vanished/.test(line)), [], story(r));
  assert.deepEqual(r.b.notices, []);
});

test("a FOLDER's late report indexes its old name again with everything under it, and the host takes it out once, holding nothing", async (t) => {
  const r = await lateReport(t, { "Team docs/One.md": BODY, "Team docs/Sub/Three.md": OTHER }, [["Team docs", "team docs"]]);
  await r.timers.run(STEP_MS, () => r.b.logs.includes("vault path_class=folder decision=unindexed reason=ghost"));
  await r.timers.run(STEP_MS);
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);

  assert.deepEqual(r.vault.events.slice(r.before).filter(([name]) => name === "create").map(([, path]) => path).sort(),
    ["Team docs", "Team docs/One.md", "Team docs/Sub", "Team docs/Sub/Three.md"], "no ghost was made: this test proves nothing");
  const clean = ["team docs", "team docs/One.md", "team docs/Sub", "team docs/Sub/Three.md"];
  assert.deepEqual(r.vault.indexed(), clean, `the ghost stayed: ${story(r)}`);
  assert.deepEqual(r.vault.entries(), clean);
  assert.deepEqual(Object.keys(r.b.state.data.folders).sort(), ["team docs", "team docs/Sub"], story(r));
  assert.deepEqual(await phonePosts(r), [], `the phone published the ghost or its removal: ${story(r)}`);
  assert.deepEqual(r.b.logs.filter((line) => /reason=(ghost|no_index_api|unghost|case_twin_deleted)\b/.test(line)),
    ["vault path_class=folder decision=unindexed reason=ghost"], story(r));
  assert.deepEqual(r.b.logs.filter((line) => /^push |reason=vanished/.test(line)), [], story(r));
  assert.deepEqual(r.b.state.data.heldDeletions, []);
  assert.deepEqual(r.b.notices, []);
});

test("without Obsidian's own index call the ghost stays as before 1.1.4, that is said once, and nothing is sent", async (t) => {
  const r = await lateReport(t, TWO, [RENAMED, ["CaseMove/Other.md", "CaseMove/other.md"]], { indexApi: false });
  await r.timers.run(STEP_MS);
  await r.b.engine.syncNow();
  await r.timers.run(STEP_MS);

  assert.deepEqual(r.vault.indexed(), ["CaseMove", "CaseMove/Other.md", "CaseMove/Rename me.md", "CaseMove/other.md", "CaseMove/rename me.md"], story(r));
  assert.deepEqual(r.b.logs.filter((line) => /reason=(ghost|no_index_api|unghost)\b/.test(line)),
    ["vault path_class=file decision=fallback reason=no_index_api kept=ghost"], story(r));
  assert.deepEqual(Object.keys(r.b.state.data.files).sort(), ["CaseMove/other.md", "CaseMove/rename me.md"], story(r));
  assert.deepEqual(await phonePosts(r), [], `the phone published a ghost: ${story(r)}`);
  assert.deepEqual(r.b.notices, []);
});

for (const { kind, notes, ghost, root, left } of [
  { kind: "note", notes: TWO, ghost: "CaseMove/Rename me.md", root: "CaseMove/rename me.md", left: ["CaseMove", "CaseMove/Other.md"] },
  { kind: "folder", notes: { "Team docs/One.md": BODY, "Team docs/Sub/Three.md": OTHER, "Kept.md": THEIRS }, ghost: "Team docs", root: "team docs", left: ["Kept.md"] },
]) {
  test(`a ${kind} deleted through its ghost is held back from the other devices, asked about once, and Restore here puts it back`, async (t) => {
    const r = await lateReport(t, notes, [[ghost, root]], { indexApi: false });
    await r.timers.run(STEP_MS, () => r.vault.getAbstractFileByPath(ghost) !== null);
    await r.vault.settle();
    const whole = r.vault.entries();
    const shown = r.vault.indexed();
    assert.ok(shown.length > whole.length && shown.includes(ghost), `no ghost to delete: ${story(r)}`);
    const under = (path) => path === root || path.startsWith(`${root}/`);
    const held = Object.keys(r.b.state.data.files).filter(under);
    const deletes = r.vault.events.length;

    // The person deletes what Obsidian shows as a second copy.
    await r.vault.fileManager.trashFile(r.vault.getAbstractFileByPath(ghost));
    assert.deepEqual(r.vault.entries(), left, "the fake no longer deletes the entry with its ghost");
    await r.vault.settle(150);
    await r.timers.run(STEP_MS, () => r.b.state.data.heldDeletions.length > 0);
    await r.timers.run(STEP_MS);
    await r.b.engine.syncNow();
    await r.timers.run(STEP_MS);

    // The ghost's own deletes first, the entry's a moment later.
    const reported = r.vault.events.slice(deletes).filter(([name]) => name === "delete").map(([, path]) => path);
    assert.deepEqual([...reported].sort(), shown.filter((path) => !left.includes(path)),
      `the fake no longer reports both deletions: ${JSON.stringify(r.vault.events.slice(deletes))} ${story(r)}`);
    assert.ok(!under(reported[0]), reported.join(" | "));
    const sent = await sentPaths(r.server, r.keys.manifestKey);
    assert.deepEqual(sent.filter((frame) => frame.deleted && frame.device === PHONE), [], `deleted everywhere through its ghost: ${story(r)}`);
    for (const path of held) assert.equal(r.a.host.text(path), notes[ghost + path.slice(root.length)], `the desktop lost ${path}`);
    assert.deepEqual(r.b.state.data.heldDeletions, held, story(r));
    assert.deepEqual(r.b.logs.filter((line) => line.includes("reason=case_twin_deleted")),
      [`watch path_class=${kind === "note" ? "file" : "folder"} decision=held reason=case_twin_deleted files=${held.length} held=${held.length}`], story(r));
    // Asked once; the pass after it holds the deletion without asking again,
    // and Sync now answers for what it did not send, as it always does (#172).
    const name = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    assert.deepEqual(r.b.notices, [
      `obsync: did not delete "${name(root)}" from your other devices: it was deleted here through "${name(ghost)}", ` +
        `a second name Obsidian showed for the same ${kind}. Choose Restore here to put it back, or Delete everywhere.`,
      `obsync: ${held.length} deletion${held.length === 1 ? " is" : "s are"} still held back, so Sync now does not send them. ` +
        "Choose Delete everywhere if you meant them, or Restore here to put the notes back.",
    ], story(r));

    await r.b.plugin.restoreHeldDeletions();
    await r.timers.run(STEP_MS, () => held.every((path) => r.vault.text(path) !== null));
    await r.timers.run(STEP_MS);
    assert.deepEqual(r.vault.entries(), whole, story(r));
    assert.deepEqual(r.vault.indexed(), whole, story(r));
    assert.deepEqual(r.b.state.data.heldDeletions, []);
    assert.deepEqual(await phonePosts(r), [], `the phone published the ${kind} or its deletion: ${story(r)}`);
  });
}

test("a removal through a name the vault shows as a DIFFERENT recorded note is refused, and that note stays", async (t) => {
  const r = await seeded(t, { "Notes/probe.md": BODY });
  r.b.engine.stop();
  // A duplicate an older version published for a ghost, recorded under the
  // ghost's spelling: a tombstone for it asks for exactly this removal.
  r.b.state.data.files["Notes/Probe.md"] = { ...r.b.state.data.files["Notes/probe.md"], fileId: "ab".repeat(16) };
  assert.equal(await r.b.host.trash("Notes/Probe.md"), "kept");
  assert.equal(r.vault.text("Notes/probe.md"), BODY, "the removal took the other note");
  assert.deepEqual(r.b.logs.filter((line) => line.includes("reason=case_twin")), ["host path_class=file decision=kept reason=case_twin"]);
  // With no other note in the way, a removal is made as ever.
  delete r.b.state.data.files["Notes/Probe.md"];
  assert.equal(await r.b.host.trash("Notes/probe.md"), "removed");
  assert.equal(r.vault.text("Notes/probe.md"), null);
});

for (const folds of [true, false]) {
  const kind = folds ? "Android" : "an iPhone";
  test(`on ${kind}, a deletion for a note the phone no longer has settles as done, and the feed goes on (#234)`, async (t) => {
    const r = await seeded(t, { "Gone/Lost.md": BODY, "Gone/Kept.md": OTHER }, { folds });
    // The note leaves the phone's storage with nobody watching: the Files app,
    // or Obsidian closed. Its record stays; nothing on the phone says it went.
    r.vault.disk.delete("Gone/Lost.md");
    r.vault.index.delete("Gone/Lost.md");
    // The desktop deletes it too, then edits the other note.
    r.a.host.remove("Gone/Lost.md");
    await r.timers.run(STEP_MS, () => r.a.state.fileByPath("Gone/Lost.md") === undefined);
    r.a.host.write("Gone/Kept.md", `${OTHER}and a later line\n`, 2000);
    await r.timers.run(STEP_MS, () => r.vault.text("Gone/Kept.md") === `${OTHER}and a later line\n`);
    assert.equal(r.vault.text("Gone/Kept.md"), `${OTHER}and a later line\n`, `the feed stopped at the deletion: ${story(r)}`);
    assert.equal(r.b.state.data.files["Gone/Lost.md"], undefined, "the record of the note that went stayed");
    assert.deepEqual(r.b.logs.filter((line) => line.includes("decision=absent")), ["host path_class=file decision=absent"], story(r));
    assert.deepEqual(r.b.logs.filter((line) => line.startsWith("feed decision=retry")), [], story(r));
    assert.deepEqual(await phonePosts(r), [], `the phone published something: ${story(r)}`);
  });

  test(`on ${kind}, a deletion of a note whose name a folder has taken since is refused, and the folder stays (#284)`, async (t) => {
    const r = await seeded(t, { "Gone/Box.md": BODY, "Gone/Kept.md": OTHER }, { folds });
    const id = r.ids["Gone/Box.md"];
    await r.timers.run(STEP_MS);
    // The note gives way to a folder of that name, with a note in it, with
    // nobody watching: the phone still records a note there.
    r.vault.disk.delete("Gone/Box.md");
    r.vault.index.delete("Gone/Box.md");
    r.vault.write("Gone/Box.md/Inside.md", new TextEncoder().encode(THEIRS), 3000, false);
    r.a.host.remove("Gone/Box.md");
    await r.timers.run(STEP_MS, () => r.a.state.fileByPath("Gone/Box.md") === undefined);
    r.a.host.write("Gone/Kept.md", `${OTHER}and a later line\n`, 2000);
    await r.timers.run(STEP_MS, () => r.vault.text("Gone/Kept.md") === `${OTHER}and a later line\n`);
    assert.equal(r.vault.text("Gone/Box.md/Inside.md"), THEIRS, `the deletion took the folder: ${story(r)}`);
    assert.ok(r.b.logs.some((line) => line.startsWith(`pull path_class=manifest decision=refused reason=not_a_file file=${id} `)), story(r));
    assert.deepEqual(r.b.logs.filter((line) => line.startsWith("host path_class=file decision=")), [], story(r));
    // The page went on past it, as after #234, and the record stays: nothing was removed.
    assert.deepEqual(r.b.logs.filter((line) => line.startsWith("feed decision=retry")), [], story(r));
    assert.equal(r.b.state.data.files["Gone/Box.md"]?.fileId, id, story(r));
    assert.deepEqual(r.b.notices.map((text) => /^obsync: skipped a change from .+: it was damaged or named a file this device cannot write/.test(text)), [true], story(r));
    // The phone's own next pass finds the note gone from its storage and says
    // so: the very deletion the desktop made, the same version, and still
    // nothing removed here.
    await r.b.engine.reconcile();
    await r.timers.run(STEP_MS, () => r.b.state.data.files["Gone/Box.md"] === undefined);
    const tombstone = r.server.journal.find((frame) => frame.file_id === id && frame.deleted);
    assert.ok(r.b.logs.includes(`push path_class=tombstone decision=deleted version=${tombstone?.version_id}`), story(r));
    assert.deepEqual(await phonePosts(r), [], story(r));
    assert.equal(r.vault.text("Gone/Box.md/Inside.md"), THEIRS, story(r));
  });
}

/** Save a folder selection on the phone as Settings does, releasing the parked poll the stop waits for. */
async function saveFolders(r, folders) {
  r.b.plugin.startEngine = async () => { r.b.plugin.engine = r.b.engine; await r.b.engine.start(); };
  let done = false;
  const saving = r.b.plugin.saveSyncFolders(folders).finally(() => { done = true; });
  for (const deadline = Date.now() + 10000; !done; await new Promise((resolve) => setTimeout(resolve, 5))) {
    r.server.releaseFeed();
    if (Date.now() > deadline) throw new Error("the folder change never settled");
  }
  await saving;
}

/**
 * A NOTE THIS PHONE DELETED, AND A WIDENING AFTER IT (issue #237), as the
 * emulator ran it. The desktop wrote the note, so replaying the feed from zero
 * gives the phone the desktop's version first, with no record here to meet,
 * and the deletion after it is the phone's own: skipped as an echo, it left
 * the note back on the phone alone, at a version every other device had
 * deleted. The emulator's record had lost its file as well, so Leave counted
 * it as an edit while the status read idle, and the next start deleted it
 * again -- which, answered with the deletion the server already held, made
 * that deletion this start's own, and the replay skipped it once more.
 */
test("on Android, a widening does not bring back a note this phone deleted, nor keep the record it once did (#237)", async (t) => {
  const r = await seeded(t, { "R237/One.md": BODY, "R237/Two.md": OTHER });
  const id = r.ids["R237/One.md"];
  const live = { ...r.b.state.fileByPath("R237/One.md") };
  await r.vault.fileManager.trashFile(r.vault.getAbstractFileByPath("R237/One.md"));
  await r.timers.run(STEP_MS, () => r.a.host.text("R237/One.md") === null && r.b.state.data.lastSeq === r.server.journal.at(-1).seq);
  const deletion = r.server.journal.find((frame) => frame.file_id === id && frame.deleted);
  assert.equal(deletion?.device_id, PHONE, story(r));
  const frames = r.server.journal.length;
  const widen = async () => {
    await saveFolders(r, ["Elsewhere"]);
    await saveFolders(r, undefined);
    await r.timers.run(STEP_MS, () => r.b.state.data.lastSeq === r.server.journal.at(-1).seq);
    await r.b.engine.syncNow();
    await r.timers.run(STEP_MS);
  };
  const settledHere = async () => {
    assert.deepEqual(r.vault.entries(), ["R237", "R237/Two.md"], `the deleted note came back: ${story(r)}`);
    assert.equal(r.b.state.pathByFileId(id), undefined, story(r));
    assert.equal(r.b.state.data.graves[id]?.versionId, deletion.version_id, story(r));
    assert.deepEqual(await r.b.plugin.unpushedEdits(), [], story(r));
    assert.deepEqual(r.server.journal.slice(frames), [], `the phone sent something: ${story(r)}`);
  };

  await widen();
  await settledHere();
  // The desktop's version is history when the replay serves it: never written (#311).
  const theirs = r.server.journal.find((frame) => frame.file_id === id && !frame.deleted);
  assert.ok(r.b.logs.includes(`pull decision=skipped reason=superseded_in_feed file=${id} seq=${theirs.seq}`), story(r));

  // The emulator's state, which a replay before this one left: the record back
  // at the old version, the note on no spelling of the storage, no grave. The
  // start's walk sends the deletion for that record while the replay reads,
  // and which reaches the desktop's version first is a race, so only where
  // things end is asserted: nothing comes back, nothing is sent.
  r.b.state.setFile("R237/One.md", live);
  assert.deepEqual(await r.b.plugin.unpushedEdits(), ["R237/One.md"]);
  await widen();
  await settledHere();
  assert.equal(r.a.host.text("R237/One.md"), null);
  assert.equal(r.a.host.text("R237/Two.md"), OTHER);
  assert.deepEqual(r.b.notices, []);
});

/**
 * PAIRED AGAIN OVER THE VAULT IT KEPT, ON ANDROID (issue #241), as the
 * emulator ran J10: the phone renames a folder of notes, leaves, and is paired
 * again as a new device over its vault. The replay's first version of each
 * note names the OLD folder; written there, a copy stayed at the old name for
 * good, and every note was posted again. Nothing is written there now, and
 * nothing is posted.
 */
test("on Android, a phone paired again after renaming a folder writes nothing at the old name and posts nothing (#241)", async (t) => {
  const names = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const r = await seeded(t, Object.fromEntries(names.map((name) => [`J241/Old/${name}.md`, `${BODY}${name}\n`])));
  await r.vault.rename(r.vault.getAbstractFileByPath("J241/Old"), "J241/New");
  await r.timers.run(STEP_MS, () => names.every((name) => settled(r.a, `J241/New/${name}.md`) && settled(r.b, `J241/New/${name}.md`)) &&
    !r.a.host.hasFolder("J241/Old"));
  await r.timers.run(STEP_MS * 20);
  await r.b.engine.stopAndWait();
  r.server.devices.find((device) => device.device_id === PHONE).revoked = true;
  const seq = r.server.seq;
  const again = "d0".repeat(16);
  r.server.addDevice(again, "6b".repeat(32), "android again", "android");
  r.store = { data: null, secrets: memorySecrets() };
  const c = await phone(t, r, true, again, "6b".repeat(32));
  await c.engine.start();
  await r.timers.run(STEP_MS, () => c.state.data.lastSeq >= seq && names.every((name) => settled(c, `J241/New/${name}.md`)));
  await r.timers.run(STEP_MS * 40);
  await r.timers.run(STEP_MS, () => c.engine.current().kind === "idle" && c.state.data.lastSeq === r.server.seq);
  await r.vault.settle(150);
  const posted = r.server.journal.filter((frame) => frame.device_id === again && (frame.sids.length > 0 || frame.deleted));
  const tale = `${story({ ...r, b: c })} posted=${posted.length}`;
  assert.deepEqual(r.vault.entries().filter((path) => path.startsWith("J241/Old/")), [], tale);
  for (const name of names) assert.equal(c.state.fileByPath(`J241/New/${name}.md`)?.fileId, r.ids[`J241/Old/${name}.md`], `${name}: ${tale}`);
  assert.deepEqual(posted, [], tale);
});

/**
 * A NOTE MOVED OUT OF THE PHONE'S SELECTION, AND A WIDENING (issue #239), as
 * the emulator ran J6: published as the move, so the desktop holds it once,
 * at its new name, as the same note. Its new name deleted while it was out,
 * it comes back at its old one instead, and the phone publishes nothing.
 */
for (const fate of ["kept", "deleted"]) {
  test(`on Android, a note moved out of the selection and ${fate} there ends as one note on both devices after a widening (#239)`, async (t) => {
    const r = await seeded(t, { "Sel/n.md": BODY, "Sel/Other.md": OTHER });
    const id = r.ids["Sel/n.md"];
    // As the plugin does, a new engine per start.
    const { SyncEngine } = r.box.require(join(r.box.home, "build/sync/engine.js"));
    r.b.plugin.startEngine = async () => {
      const engine = new SyncEngine({ state: r.b.state, transport: r.b.transport, host: r.b.host, now: () => r.vault.clock, timers: r.timers });
      t.after(() => engine.stop());
      r.b.engine = r.b.plugin.engine = engine;
      await engine.start();
    };
    await saveFolders(r, ["Sel"]);
    // The note's newest version is the phone's own: its replay is an echo here.
    await r.vault.adapter.writeBinary("Sel/n.md", new TextEncoder().encode(THEIRS).buffer, { mtime: 2000 });
    await r.timers.run(STEP_MS, () => r.a.host.text("Sel/n.md") === THEIRS && r.b.state.fileByPath("Sel/n.md")?.size === THEIRS.length);
    await r.vault.adapter.mkdir("Out");
    await r.vault.rename(r.vault.getAbstractFileByPath("Sel/n.md"), "Out/n.md");
    await r.vault.settle();
    if (fate === "deleted") await r.vault.fileManager.trashFile(r.vault.getAbstractFileByPath("Out/n.md"));
    await r.timers.run(STEP_MS, () => r.b.state.data.lastSeq === r.server.journal.at(-1).seq);
    const frames = r.server.journal.length;

    await saveFolders(r, undefined);
    const idle = () => r.b.state.data.lastSeq === r.server.journal.at(-1).seq && r.a.state.data.lastSeq === r.server.journal.at(-1).seq &&
      r.a.engine.current().kind === "idle" && r.b.engine.current().kind === "idle";
    await r.timers.run(STEP_MS, idle);
    await r.timers.run(STEP_MS);
    await r.timers.run(STEP_MS, idle);
    await r.vault.settle(150);
    const at = fate === "kept" ? "Out/n.md" : "Sel/n.md";
    const notes = (paths) => paths.filter((path) => path.endsWith(".md")).sort();
    assert.deepEqual(notes(r.vault.entries()), [at, "Sel/Other.md"].sort(), story(r));
    assert.deepEqual(notes([...r.a.host.files.keys()]), [at, "Sel/Other.md"].sort(), story(r));
    assert.equal(r.b.state.fileByPath(at)?.fileId, id, story(r));
    assert.equal(r.a.state.fileByPath(at)?.fileId, id, story(r));
    assert.equal(r.vault.text(at), THEIRS);
    const sent = r.server.journal.slice(frames).filter((frame) => frame.device_id === PHONE && frame.sids.length > 0);
    assert.deepEqual(sent.map((frame) => frame.file_id), fate === "kept" ? [id] : [], story(r));
  });
}

/**
 * A PHONE'S INDEX KEPT WHAT IT SAW FIRST (#245). Android lands a download's
 * bytes after Obsidian has looked at the file, and Obsidian mobile, watching no
 * filesystem, keeps that first look -- size 0, as the emulator's index held
 * four synced 993-byte files -- until it restarts. Leave counted them as
 * unsent and every pass queued and read them. A file whose listed size or
 * mtime differs from its record is asked of the disk once, and only such a
 * file; one another app really changed stays counted, at what the disk holds,
 * and one the disk cannot answer for keeps the index's word.
 */
test("a phone whose index kept a stale size or mtime: Leave does not count the note, a pass reads nothing, and the difference is said (#245)", async (t) => {
  const r = await seeded(t, {
    "Index/One.json": BODY, "Index/Two.json": OTHER, "Index/Three.md": CLASH, "Index/Four.md": THEIRS,
    "Index/Five.md": "RECASE SENTINEL: a note nothing changed\n",
  });
  r.b.engine.stop();
  const record = (path) => r.b.state.fileByPath(path);
  // Two synced files the index misreports: an empty look, and an older mtime.
  r.vault.cached.set("Index/One.json", { mtime: record("Index/One.json").mtime, size: 0 });
  r.vault.cached.set("Index/Two.json", { mtime: record("Index/Two.json").mtime + 5000, size: record("Index/Two.json").size });
  // A file another app changed, which the index misreports too: a real edit.
  const changed = `${CLASH}changed by another app\n`;
  r.vault.write("Index/Three.md", new TextEncoder().encode(changed), 9000, false);
  r.vault.cached.set("Index/Three.md", { mtime: record("Index/Three.md").mtime, size: 0 });
  // And one the bridge will not answer for.
  r.vault.cached.set("Index/Four.md", { mtime: record("Index/Four.md").mtime, size: 0 });
  r.vault.lag = (call, path) => call === "stat" && path === "Index/Four.md" ? Promise.reject(new Error("sentinel: no answer")) : undefined;
  let stats = 0;
  const stat = r.vault.adapter.stat;
  r.vault.adapter.stat = (path) => { stats++; return stat(path); };

  assert.deepEqual(await r.b.plugin.unpushedEdits(), ["Index/Four.md", "Index/Three.md"], r.b.logs.join(" | "));
  // One line per file the disk corrected, and no path in any (requirement 6).
  assert.deepEqual(r.b.logs.filter((line) => line.startsWith("list decision=stale_index ")).sort(), [
    `list decision=stale_index size_index=0 size_disk=${BODY.length} mtime_index=1000 mtime_disk=1000`,
    `list decision=stale_index size_index=0 size_disk=${changed.length} mtime_index=1000 mtime_disk=9000`,
    `list decision=stale_index size_index=${OTHER.length} size_disk=${OTHER.length} mtime_index=6000 mtime_disk=1000`,
  ]);
  assert.equal(r.b.logs.filter((line) => /^list decision=confirmed suspects=4 stale=3 files=5 duration_ms=\d+$/.test(line)).length, 1, r.b.logs.join(" | "));
  assert.equal(stats, 4, "the disk was asked about more than the suspects");

  // A pass with the engine running reads only the file that changed.
  r.vault.lag = null;
  const reads = [];
  const read = r.vault.adapter.readBinary;
  r.vault.adapter.readBinary = (path) => { reads.push(path); return read(path); };
  const again = await phone(t, r);
  await again.engine.start();
  await r.timers.run(STEP_MS, () => r.a.host.text("Index/Three.md") === changed);
  await r.timers.run(STEP_MS);
  assert.deepEqual([...new Set(reads)], ["Index/Three.md"], again.logs.join(" | "));
  assert.deepEqual(await again.plugin.unpushedEdits(), [], again.logs.join(" | "));
  assert.deepEqual(again.notices, []);
});

/**
 * A PHONE STOPPED RIGHT AFTER A DOWNLOAD'S FIRST EMPTY WRITE (#248). Android
 * can land a download's write empty (#242); the phone writes it again, and the
 * mark that keeps the empty file from being sent reaches the data file only at
 * the next save. Android may end the app between the two. The next process
 * here is made of ONLY what was persisted before that write and the files left
 * behind -- the running one is killed at the instant the empty write lands, so
 * nothing it would have saved or sent afterwards exists.
 */
async function stoppedAfterEmptyWrite(t, existing) {
  const PATH = "Crash/Note.md";
  const r = await seeded(t, { "Crash/Kept.md": BODY, ...(existing ? { [PATH]: OTHER } : {}) });
  let left = null;
  r.vault.dropping = (path) => path === PATH;
  r.vault.onEmpty = () => {
    if (left !== null) return;
    left = { data: structuredClone(r.store.data), disk: new Map(r.vault.disk) };
    r.b.kill();
  };
  r.a.host.write(PATH, THEIRS, 5000);
  await r.timers.run(STEP_MS, () => left !== null);
  assert.equal(left.data.dropped?.[PATH], undefined, "the mark was saved before the write: this test proves nothing");
  // The next process: Obsidian indexes what the storage holds, obsync reads its data file.
  r.vault = new PhoneVault(r.box.require("obsidian"));
  r.vault.disk = left.disk;
  r.vault.restart();
  r.store = { data: left.data, secrets: r.store.secrets };
  assert.equal(r.vault.text(PATH), "", "the write did not leave the empty file");
  return { r, PATH };
}

for (const existing of [false, true]) {
  test(`a phone stopped right after a download's first empty write sends neither an empty ${existing ? "version" : "note"} nor a tombstone when it starts again (#248)`, async (t) => {
    const { r, PATH } = await stoppedAfterEmptyWrite(t, existing);
    const again = await phone(t, r);
    await again.engine.start();
    await r.timers.run(STEP_MS, () => r.vault.text(PATH) === THEIRS && settled(again, PATH))
      .catch((error) => { throw new Error(`${error.message}: ${story({ ...r, b: again })} ${again.logs.join(" | ")}`); });
    await r.timers.run(STEP_MS);
    await again.engine.syncNow();
    await r.timers.run(STEP_MS);

    const sent = (await sentPaths(r.server, r.keys.manifestKey)).filter((frame) => frame.device === PHONE && !frame.folder);
    assert.deepEqual(sent, [], `the restarted phone sent what its empty file said: ${again.logs.join(" | ")}`);
    assert.deepEqual(again.logs.filter((line) => line.includes("reason=unfinished_download")),
      [`reconcile decision=held reason=unfinished_download files=1 unverified=0 budget_ms=5000 duration_ms=0`]);
    assert.equal(r.a.host.text(PATH), THEIRS);
    assert.equal(r.vault.text(PATH), THEIRS);
    assert.equal(again.state.data.dropped[PATH], undefined, "the mark outlived the download that landed");
    assert.deepEqual(again.notices, []);
  });
}

for (const existing of [false, true]) {
  test(`${existing ? "an existing" : "a new"} note's empty file is held, unverified, when the start cannot read the feed, and nothing is sent (#248)`, async (t) => {
    const { r, PATH } = await stoppedAfterEmptyWrite(t, existing);
    // The walk of the feed the start's pass makes, and its one retry, never arrive.
    let lost = 0;
    r.lost = (request) => request.method === "GET" && request.url.includes("wait=0&limit=1000") && lost++ < 2;
    const again = await phone(t, r);
    await again.engine.start();
    await r.timers.run(STEP_MS, () => r.vault.text(PATH) === THEIRS && settled(again, PATH))
      .catch((error) => { throw new Error(`${error.message}: ${story({ ...r, b: again })} ${again.logs.join(" | ")}`); });
    await r.timers.run(STEP_MS);
    await again.engine.syncNow();
    await r.timers.run(STEP_MS);

    assert.ok(again.logs.some((line) => line.startsWith("reconcile decision=held_failed ")), again.logs.join(" | "));
    assert.deepEqual(again.logs.filter((line) => line.includes("reason=unfinished_download")),
      [`reconcile decision=held reason=unfinished_download files=1 unverified=1 budget_ms=5000 duration_ms=0`]);
    const sent = (await sentPaths(r.server, r.keys.manifestKey)).filter((frame) => frame.device === PHONE && !frame.folder);
    assert.deepEqual(sent, [], `the restarted phone sent what its empty file said: ${again.logs.join(" | ")}`);
    assert.equal(r.a.host.text(PATH), THEIRS);
    assert.equal(again.state.data.dropped[PATH], undefined, "the mark outlived the download that landed");
    assert.deepEqual(again.notices, []);
  });
}

for (const existing of [false, true]) for (const restart of ["a reload", "a restart in place"]) {
test(`${existing ? "a note emptied" : "a new note made empty"} while the phone was stopped is held when the start cannot read the feed, and the next start that can sends it, after ${restart} (#248)`, async (t) => {
  const PATH = "Crash/Fresh.md";
  const r = await seeded(t, { "Crash/Kept.md": BODY, ...(existing ? { [PATH]: OTHER } : {}) });
  r.b.kill();
  r.vault.seed(PATH, "", 7000);
  let lost = 0;
  r.lost = (request) => request.method === "GET" && request.url.includes("wait=0&limit=1000") && lost++ < 2;
  const blind = await phone(t, r);
  await blind.engine.start();
  await r.timers.run(STEP_MS, () => blind.logs.some((line) => line.includes("reason=unfinished_download")));
  await r.timers.run(STEP_MS);
  await blind.engine.syncNow();
  await r.timers.run(STEP_MS);
  const frames = r.server.journal.length;
  assert.deepEqual((await sentPaths(r.server, r.keys.manifestKey)).filter((frame) => frame.device === PHONE && !frame.folder), [],
    `a start that could not read the feed sent an empty new note: ${blind.logs.join(" | ")}`);
  assert.equal(blind.state.data.dropped[PATH], "unverified");

  // The next start reads the feed: no version is ahead at that name, so the
  // empty note is the person's own, and it is sent as it always was -- after
  // a load, and after the application's own restart in place, which keeps the
  // State and builds a new engine on it (`main.ts`, the engine start).
  let next = blind;
  const from = blind.logs.length;
  if (restart === "a reload") {
    blind.kill();
    next = await phone(t, r);
    assert.equal(next.state.data.dropped[PATH], undefined, "an unverified mark outlived its run");
    await next.engine.start();
  } else {
    await blind.engine.stopAndWait();
    const { SyncEngine } = r.box.require(join(r.box.home, "build/sync/engine.js"));
    const engine = new SyncEngine({ state: blind.state, transport: blind.transport, host: blind.host, now: () => r.vault.clock, timers: r.timers });
    blind.plugin.engine = engine;
    t.after(() => engine.stop());
    next = { ...blind, engine };
    await engine.start();
  }
  await r.timers.run(STEP_MS, () => r.server.journal.length > frames && next.state.fileByPath(PATH)?.size === 0);
  await r.timers.run(STEP_MS);
  await next.engine.syncNow();
  await r.timers.run(STEP_MS);
  const lines = restart === "a reload" ? next.logs : next.logs.slice(from);
  const sent = (await sentPaths(r.server, r.keys.manifestKey)).slice(frames);
  assert.deepEqual(sent, [{ path: PATH, deleted: false, folder: false, device: PHONE, size: 0 }], lines.join(" | "));
  assert.deepEqual(lines.filter((line) => line.includes("reason=unfinished_download")), []);
  assert.equal(next.state.data.dropped[PATH], undefined, "an unverified mark outlived its run");
  assert.equal(r.a.host.text(PATH), "");
});
}

test("a note emptied on purpose while the phone was stopped is still sent empty at its next start (#248)", async (t) => {
  const PATH = "Crash/Note.md";
  const r = await seeded(t, { "Crash/Kept.md": BODY, [PATH]: OTHER });
  // The phone's own edit, sent: its version is the newest the server holds.
  r.vault.write(PATH, new TextEncoder().encode(THEIRS), 6000, true);
  await r.timers.run(STEP_MS, () => r.server.journal.at(-1).device_id === PHONE && r.b.state.fileByPath(PATH)?.versionId === r.server.journal.at(-1).version_id);
  await r.timers.run(STEP_MS);
  r.b.kill();
  // Stopped after its push was recorded and before the feed brought the push
  // back, so that version is still ahead of the cursor the phone saved -- the
  // one case where an unfinished download and an emptied note look alike but
  // for the record. Then the person empties the note, and nothing sends it.
  const mine = r.server.journal.at(-1);
  const before = r.server.journal.filter((frame) => frame.seq < mine.seq).at(-1);
  const data = structuredClone(r.store.data);
  data.lastSeq = before.seq;
  data.feedMark = { seq: before.seq, fileId: before.file_id, versionId: before.version_id, ts: before.ts, replay: false };
  const disk = new Map(r.vault.disk);
  disk.set(PATH, { bytes: new Uint8Array(), mtime: 9000 });
  r.vault = new PhoneVault(r.box.require("obsidian"));
  r.vault.disk = disk;
  r.vault.restart();
  r.store = { data, secrets: r.store.secrets };
  const frames = r.server.journal.length;

  const again = await phone(t, r);
  await again.engine.start();
  await r.timers.run(STEP_MS, () => r.server.journal.length > frames && settled(again, PATH) && again.state.fileByPath(PATH).size === 0);
  await r.timers.run(STEP_MS);

  const sent = (await sentPaths(r.server, r.keys.manifestKey)).slice(frames);
  assert.deepEqual(sent, [{ path: PATH, deleted: false, folder: false, device: PHONE, size: 0 }], again.logs.join(" | "));
  assert.equal(r.a.host.text(PATH), "", "the note emptied on purpose did not reach the desktop");
  // The start did read the feed from the cursor its version is ahead of.
  assert.ok(again.logs.some((line) => line.startsWith(`reconcile decision=held since=${before.seq} `)), again.logs.join(" | "));
  assert.deepEqual(again.logs.filter((line) => line.includes("reason=unfinished_download")), []);
  assert.equal(again.state.data.dropped[PATH], undefined);
});

test("a note emptied on purpose while the phone runs is sent empty, even by a Sync now after the start's own read of the feed (#248)", async (t) => {
  const PATH = "Crash/Note.md";
  const r = await seeded(t, { "Crash/Kept.md": BODY, [PATH]: OTHER });
  r.b.kill();
  // A note made here while obsync was stopped: the start reads the feed for it.
  r.vault.seed("Crash/Local.md", "RECASE SENTINEL: a note made on the phone\n", 7000);
  const again = await phone(t, r);
  await again.engine.start();
  await r.timers.run(STEP_MS, () => settled(again, "Crash/Local.md"));
  assert.ok(again.logs.some((line) => line.startsWith("reconcile decision=held since=")), again.logs.join(" | "));
  const frames = r.server.journal.length;

  r.vault.write(PATH, new Uint8Array(), 9000, true);
  await again.engine.syncNow();
  await r.timers.run(STEP_MS, () => r.server.journal.length > frames && again.state.fileByPath(PATH)?.size === 0);
  await r.timers.run(STEP_MS);

  const sent = (await sentPaths(r.server, r.keys.manifestKey)).slice(frames);
  assert.deepEqual(sent, [{ path: PATH, deleted: false, folder: false, device: PHONE, size: 0 }], again.logs.join(" | "));
  assert.deepEqual(again.logs.filter((line) => line.includes("reason=unfinished_download")), []);
});

// A FILE HOLDS NO FOLDER (#282): a phone asked every note whether it held a
// config folder of its own -- one bridge call per note, which no pass could
// cache: 11 to 23 s over 7,700 notes inside every Sync now on the emulator.
test("a phone asks each folder once whether it is a vault of its own, never each note (#282)", async (t) => {
  const notes = { "A/One.md": BODY, "A/Two.md": OTHER, "B/Three.md": CLASH, "B/Sub/Four.md": THEIRS, "Five.md": "RECASE SENTINEL: a note at the vault's root\n" };
  const r = await seeded(t, notes);
  await r.timers.run(STEP_MS);
  const asked = [];
  const exists = r.vault.adapter.exists;
  r.vault.adapter.exists = (path, ...rest) => { asked.push(path); return exists(path, ...rest); };
  r.b.host.pass(true);
  try {
    for (const path of Object.keys(notes)) assert.equal(await r.b.host.syncable(path), true, path);
  } finally {
    r.b.host.pass(false);
  }
  const own = ".obsidian/plugins/obsync-private-sync";
  assert.deepEqual(asked.sort(), ["A", "B", "B/Sub"].map((folder) => `${folder}/${own}`), "one question per folder, none per note");
  // A folder still asks about itself: a folder can be a vault of its own (#180).
  asked.length = 0;
  assert.equal(await r.b.host.syncable("B/Sub", "folder"), true);
  assert.deepEqual(asked, [`B/${own}`, `B/Sub/${own}`]);
});

// BUT THE FEED ASKS A NOTE'S OWN NAME (#282): a record calls a file what the
// phone may keep as a folder by now, and a deletion applied there trashes the
// whole folder -- here a vault of its own, with its notes.
test("a deletion from another device, of a note a phone now keeps as a vault of its own, removes nothing there (#282)", async (t) => {
  const r = await seeded(t, { "Box.md": BODY, "Notes/Two.md": OTHER });
  const id = r.ids["Box.md"];
  // The note gives way to a folder of that name with nobody watching.
  r.vault.disk.delete("Box.md");
  r.vault.index.delete("Box.md");
  r.vault.write("Box.md/.obsidian/plugins/obsync-private-sync/manifest.json", new TextEncoder().encode("{}"), 3000, false);
  r.vault.write("Box.md/Inside.md", new TextEncoder().encode(THEIRS), 3000, false);
  r.a.host.remove("Box.md");
  const refused = `pull path_class=manifest decision=not_synced reason=nested_vault file=${id} `;
  await r.timers.run(STEP_MS, () => r.b.logs.some((line) => line.startsWith(refused)) || r.vault.text("Box.md/Inside.md") === null);
  assert.equal(r.vault.text("Box.md/Inside.md"), THEIRS, `the deletion reached the other vault: ${story(r)}`);
  assert.ok(r.vault.entries().includes("Box.md/.obsidian/plugins/obsync-private-sync/manifest.json"), story(r));
  assert.deepEqual(await phonePosts(r), [], story(r));
});

/**
 * SYNC NOW ON A PHONE ASKS THE DISK, FOLDER BY FOLDER (#246). Reading every
 * note again made a press minutes long on a phone of 7,700 notes, and
 * Obsidian's index alone never sees another app's edit. The press asks
 * Obsidian's `readdir` once per folder that holds a listed note -- sizes and
 * dates as the storage has them -- and reads only what differs. Anything
 * short of that shape sends the press to the index with a `stat` per suspect
 * (#245), and a folder it cannot read gets that check alone.
 */
const EDITED = "RECASE SENTINEL: edited by another app on the phone\n";
const ROOTED = "RECASE SENTINEL: a note at the vault's root\n";
const PRESSED = { "A/One.md": BODY, "A/Two.md": OTHER, "B/Three.md": CLASH, "B/Sub/Four.md": THEIRS, "Five.md": ROOTED };

/** Every adapter call a press makes, by kind and path, from now on. */
function counted(r) {
  const calls = { readBinary: [], stat: [] };
  for (const name of Object.keys(calls)) {
    const real = r.vault.adapter[name];
    r.vault.adapter[name] = (path, ...rest) => { calls[name].push(path); return real(path, ...rest); };
  }
  r.vault.readdirs.length = 0;
  return calls;
}

/** Another app writes `text` over `path`: the storage changes, Obsidian's index keeps what it saw. */
function behindIndex(r, path, text, mtime) {
  const record = r.b.state.fileByPath(path);
  r.vault.cached.set(path, { mtime: record.mtime, size: record.size });
  r.vault.write(path, new TextEncoder().encode(text), mtime, false);
}

async function pressed(r) {
  let done = false;
  const press = r.b.engine.syncNow().then(() => { done = true; });
  await r.timers.run(STEP_MS, () => done);
  await press;
  return r.b.logs.filter((line) => line.startsWith("sync_now decision=")).pop();
}

test("a phone's Sync now asks each listed folder once, reads only what differs, and says what it read (#246)", async (t) => {
  const r = await seeded(t, PRESSED);
  await r.timers.run(STEP_MS);
  behindIndex(r, "A/Two.md", EDITED, 9000);
  // Emptied by another app: size 0 against a record that held text differs (#246, #248).
  behindIndex(r, "B/Three.md", "", 9500);
  const calls = counted(r);

  const line = await pressed(r);
  await r.timers.run(STEP_MS, () => r.a.host.text("A/Two.md") === EDITED && r.a.host.text("B/Three.md") === "");

  assert.deepEqual([...r.vault.readdirs].sort(), ["", "A", "B", "B/Sub"], "one readdir per folder that holds a listed note");
  assert.deepEqual([...new Set(calls.readBinary)].sort(), ["A/Two.md", "B/Three.md"], "only what differs is read");
  assert.deepEqual(calls.stat.filter((path) => !["A/Two.md", "B/Three.md"].includes(path)), [], "no unchanged note is asked");
  assert.match(line, new RegExp(`^sync_now decision=drained .* listing=readdir folders=4 files=5 differing=2 read=2 bytes=${EDITED.length} duration_ms=\\d+ budget_ms=10000$`), line);
  assert.equal(r.a.host.text("A/Two.md"), EDITED);
  assert.equal(r.a.host.text("B/Three.md"), "");
  assert.equal(r.a.host.text("B/Sub/Four.md"), THEIRS);
  assert.ok(!r.b.logs.some((line) => line.includes("decision=fallback")), r.b.logs.join(" | "));
  assert.deepEqual(r.b.notices, []);
});

test("a phone whose Obsidian has no readdir falls back to the index and a stat per suspect, said once (#246)", async (t) => {
  const r = await seeded(t, PRESSED);
  await r.timers.run(STEP_MS);
  delete r.vault.adapter.fs;
  // One change the index saw, one it did not.
  behindIndex(r, "A/Two.md", EDITED, 9000);
  r.vault.write("B/Three.md", new TextEncoder().encode(EDITED), 9500, false);
  const calls = counted(r);

  await pressed(r);
  await r.timers.run(STEP_MS, () => r.a.host.text("B/Three.md") === EDITED);
  const line = await pressed(r);

  assert.deepEqual(r.b.logs.filter((line) => line.includes("decision=fallback")), ["sync_now decision=fallback reason=no_readdir"]);
  assert.match(line, /^sync_now decision=drained .* listing=fallback folders=0 files=5 differing=0 read=0 bytes=0 /, line);
  assert.deepEqual([...new Set(calls.readBinary)], ["B/Three.md"], "the index's change is read, and nothing else");
  assert.equal(r.a.host.text("B/Three.md"), EDITED);
  assert.equal(r.a.host.text("A/Two.md"), OTHER, "a change the index never saw waits for the next start");
  assert.deepEqual(calls.stat.filter((path) => path !== "B/Three.md"), [], "only the suspect is asked");
});

test("a readdir entry short of a date sends the whole press to the documented check (#246)", async (t) => {
  const r = await seeded(t, PRESSED);
  await r.timers.run(STEP_MS);
  r.vault.readdirFault = (folder) => folder === "B" ? "shape" : undefined;
  behindIndex(r, "A/Two.md", EDITED, 9000);
  const calls = counted(r);

  const line = await pressed(r);

  assert.deepEqual(r.b.logs.filter((line) => line.includes("decision=fallback")), ["sync_now decision=fallback reason=entry_shape"]);
  assert.match(line, /^sync_now decision=drained .* listing=fallback folders=0 files=5 differing=0 read=0 bytes=0 /, line);
  assert.deepEqual(calls.readBinary, [], "no note judged by a malformed answer");
  assert.equal(r.a.host.text("A/Two.md"), OTHER);
});

test("a folder readdir cannot read gets the documented check alone, never 'unchanged', and nothing is deleted (#246)", async (t) => {
  const r = await seeded(t, PRESSED);
  await r.timers.run(STEP_MS);
  r.vault.readdirFault = (folder) => folder === "B" ? "unreadable" : undefined;
  behindIndex(r, "A/Two.md", EDITED, 9000);
  // A change in the unreadable folder that the index saw.
  r.vault.write("B/Three.md", new TextEncoder().encode(EDITED), 9500, false);
  const calls = counted(r);

  const line = await pressed(r);
  await r.timers.run(STEP_MS, () => r.a.host.text("A/Two.md") === EDITED && r.a.host.text("B/Three.md") === EDITED);

  assert.ok(r.b.logs.includes("sync_now decision=fallback reason=folder_unreadable folders=1"), r.b.logs.join(" | "));
  assert.match(line, /^sync_now decision=drained .* listing=readdir folders=3 files=5 differing=2 read=2 /, line);
  assert.deepEqual([...new Set(calls.readBinary)].sort(), ["A/Two.md", "B/Three.md"]);
  assert.deepEqual(calls.stat.filter((path) => !["A/Two.md", "B/Three.md"].includes(path)), [], "the unreadable folder's unchanged note is not asked");
  assert.equal(r.a.host.text("A/Two.md"), EDITED);
  assert.equal(r.a.host.text("B/Three.md"), EDITED);
  assert.deepEqual((await phonePosts(r)).filter((sent) => sent.deleted), [], story(r));
  assert.ok(Object.keys(PRESSED).every((path) => r.b.state.fileByPath(path) !== undefined), story(r));
});

test("a folder the index does not list is not read by a press, even when readdir names it (#246)", async (t) => {
  const r = await seeded(t, PRESSED);
  await r.timers.run(STEP_MS);
  // A folder on the storage that Obsidian does not list -- a link, or one another app made.
  r.vault.write("A/Linked/Inside.md", new TextEncoder().encode(EDITED), 9000, false);
  const calls = counted(r);

  const line = await pressed(r);

  assert.deepEqual([...r.vault.readdirs].sort(), ["", "A", "B", "B/Sub"], "no folder below the listed ones");
  assert.match(line, /^sync_now decision=drained .* listing=readdir folders=4 files=5 differing=0 read=0 bytes=0 /, line);
  assert.deepEqual(calls.readBinary, []);
  assert.ok(!(await phonePosts(r)).some((sent) => sent.path.startsWith("A/Linked")), story(r));
});

test("a press that only verifies says it is checking, and a real change beside it is counted as syncing (#246)", async (t) => {
  const r = await seeded(t, PRESSED);
  await r.timers.run(STEP_MS);
  const statuses = [];
  r.b.engine.onStatus = (status) => statuses.push(status);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = r.vault.adapter.readBinary;
  r.vault.adapter.readBinary = async (path) => { if (path === "A/One.md") await gate; return read(path); };
  const text = (status) => { r.b.plugin.statusValue = status; return r.b.plugin.statusText(); };
  let done = false;
  const press = r.b.engine.verifyAll().then(() => { done = true; });
  // Notes queued to be read again, four at a time, none of them changed.
  await r.timers.run(STEP_MS, () => statuses.some((status) => status.checking === 4));
  assert.deepEqual(statuses.slice(-4).map(text), [1, 2, 3, 4].map((n) => `checking ${n} file${n === 1 ? "" : "s"} for changes`));

  // A real edit while the check is held: it is what "syncing" counts.
  r.vault.write("B/Three.md", new TextEncoder().encode(EDITED), 9500, true);
  await r.timers.run(STEP_MS, () => statuses.at(-1)?.pending - (statuses.at(-1)?.checking ?? 0) === 1)
    .catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(statuses)}`); });
  assert.equal(text(statuses.at(-1)), "syncing 1 file");
  release();
  await r.timers.run(STEP_MS, () => done);
  await press;
  await r.timers.run(STEP_MS);
  assert.equal(r.a.host.text("B/Three.md"), EDITED);
  assert.ok(statuses.every((status) => status.kind !== "syncing" || (status.checking ?? 0) <= status.pending), JSON.stringify(statuses));
});
