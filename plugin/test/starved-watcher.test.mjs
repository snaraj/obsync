/**
 * What obsync changes on a desktop's disk is LISTED by Obsidian while the
 * operating system's file events do not arrive (issue #253).
 *
 * WHAT A USER SAW. On a Mac whose `fseventsd` was overloaded, a note obsync
 * downloaded was on the disk, recorded and synced, and the status read `idle`
 * -- but Obsidian did not list it: not in the file explorer, search or the
 * quick switcher, twenty minutes later. Obsidian hears of a change made
 * outside it only from those events, and the desktop writer renames a whole,
 * synced temp file into place with the filesystem.
 *
 * THE MODEL. Obsidian 1.13.4's own desktop index, ported from the app rather
 * than invented: the adapter's `files` map, its one queue, and
 * `reconcileInternalFile` with what it calls (`reconcileFile`, the creation
 * and deletion halves, `listRecursive`), feeding the vault's `fileMap` through
 * `Vault.onChange` -- `create`, `modify` and `delete` events exactly as the
 * app raises them. Its watcher is starved from the start: no OS event reaches
 * it unless a test delivers one (`late`). The receiving device is the REAL
 * `ObsidianHost` over a real temporary vault, the real engine and the plugin's
 * own `registerVaultEvents`; the sending device is the fake desktop vault.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { lstat, readdir, rename as renameFile, rm, unlink } from "node:fs/promises";
import { promises as fsPromises, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { dirname, join } from "node:path";
import { KEYS, STEP_MS, memorySecrets, pair, sandbox, settled } from "./fake.mjs";

const RECEIVER = "cccccccccccccccccccccccccccccccc";
const RECEIVER_SECRET = "5d".repeat(32);

/** Does this volume fold case? Obsidian asks the same way (`testInsensitive`). */
function folds(root) {
  const probe = join(root, ".OBSYNCTEST");
  writeFileSync(probe, "");
  const answer = existsSync(join(root, ".obsynctest"));
  unlinkSync(probe);
  return answer;
}

const parentOf = (path) => { const at = path.lastIndexOf("/"); return at === -1 ? "" : path.slice(0, at); };
const hidden = (path) => path.split("/").some((part) => part.startsWith("."));

/**
 * Obsidian 1.13.4's desktop index over `root`: `FileSystemAdapter`'s index
 * half and `Vault.onChange`. `calls` holds every name the plugin asked to be
 * reconciled; the adapter's own operations reconcile through `own`, as the
 * app's do, and are not counted there.
 */
function obsidianIndex(root, obsidian, { insensitive = folds(root), api = true } = {}) {
  const { TFile, TFolder } = obsidian;
  const listeners = new Map();
  const events = [];
  /** What search and backlinks would index: each note's text as of its last `create` or `modify` (the metadata cache's own trigger). */
  const metadata = {};
  const rootFolder = Object.assign(new TFolder(), { path: "/", name: "", children: [], parent: null });
  const fileMap = { "/": rootFolder };
  const emit = (name, file, ...rest) => {
    events.push(`${name} ${file.path}`);
    if ((name === "create" || name === "modify") && file instanceof TFile) {
      try { metadata[file.path] = readFileSync(join(root, file.path), "utf8"); } catch { metadata[file.path] = null; }
    }
    for (const handler of listeners.get(name) ?? []) handler(file, ...rest);
  };
  const attach = (file) => {
    const parent = fileMap[parentOf(file.path) || "/"];
    file.parent = parent instanceof TFolder ? parent : null;
    file.parent?.children.push(file);
  };
  const detach = (file) => {
    if (file.parent) file.parent.children = file.parent.children.filter((child) => child !== file);
    file.parent = null;
  };
  /** `Vault.onChange`, the four reports the index raises. */
  const onChange = (kind, path, _old, stat) => {
    if (kind === "folder-created") {
      const folder = Object.assign(new TFolder(), { path, name: path.slice(path.lastIndexOf("/") + 1), children: [] });
      fileMap[path] = folder;
      attach(folder);
      emit("create", folder);
    } else if (kind === "file-created") {
      const file = Object.assign(new TFile(), { path, name: path.slice(path.lastIndexOf("/") + 1), stat });
      fileMap[path] = file;
      attach(file);
      emit("create", file);
    } else if (kind === "modified") {
      if (!Object.hasOwn(fileMap, path)) return;
      fileMap[path].stat = stat;
      emit("modify", fileMap[path]);
    } else if (kind === "file-removed" || kind === "folder-removed") {
      const gone = fileMap[path];
      if (gone === undefined) return;
      detach(gone);
      delete fileMap[path];
      emit("delete", gone);
    }
  };
  const adapter = {
    files: { "/": { type: "folder", realpath: "/" } },
    promise: Promise.resolve(),
    insensitive,
    calls: [],
    /** Errors the app would have sent to `console.error`. */
    errors: [],
    getBasePath: () => root,
    getRealPath(path) {
      for (let at = path; at; at = parentOf(at)) {
        if (Object.hasOwn(this.files, at)) return this.files[at].realpath + path.slice(at.length);
      }
      return path;
    },
    trigger(kind, path, old, stat) { onChange(kind, path, old, stat); },
    removeFile(path) {
      const known = this.files[path];
      delete this.files[path];
      if (known) this.trigger(known.type === "file" ? "file-removed" : "folder-removed", path);
    },
    own(path) { return enqueue(() => this.reconcileFile(this.getRealPath(path), path)); },
    async reconcileFile(real, path, now = true) {
      this.trigger("raw", path);
      if (hidden(path)) return this.reconcileDeletion(real, path, now);
      const up = parentOf(path);
      if (up !== "" && !this.files[path]) await this.reconcileFile(parentOf(real), up, now);
      try {
        const full = join(root, real);
        if (this.insensitive) {
          const names = (await readdir(dirname(full))).map((name) => name.normalize("NFC"));
          if (!names.includes(path.slice(path.lastIndexOf("/") + 1))) return this.reconcileDeletion(real, path, now);
        }
        const stat = await lstat(full);
        if (stat.isFile()) this.reconcileFileCreation(real, path, stat);
        else if (stat.isDirectory()) await this.reconcileFolderCreation(real, path);
      } catch (error) {
        if (error.code === "ENOENT") await this.reconcileDeletion(real, path, now);
        else this.errors.push(error);
      }
    },
    reconcileFileCreation(real, path, stat) {
      const seen = { ctime: Math.round(stat.birthtimeMs), mtime: Math.round(stat.mtimeMs), size: stat.size };
      const known = this.files[path];
      if (known) {
        known.realpath = real;
        if (known.type === "file") {
          if (known.mtime !== seen.mtime || known.size !== seen.size) {
            Object.assign(known, { mtime: seen.mtime, size: seen.size });
            this.trigger("modified", path, path, seen);
          }
          return;
        }
        this.removeFile(path);
      }
      this.files[path] = { type: "file", realpath: real, ...seen };
      this.trigger("file-created", path, path, seen);
    },
    async reconcileFolderCreation(real, path) {
      if (Object.hasOwn(this.files, path)) {
        this.files[path].realpath = real;
        return;
      }
      this.files[path] = { type: "folder", realpath: real };
      this.trigger("folder-created", path);
      await this.listRecursive(real);
    },
    async listRecursive(real) {
      const names = await readdir(join(root, real));
      await Promise.all(names.map(async (name) => {
        const childReal = real === "" ? name : `${real}/${name}`;
        const child = childReal.normalize("NFC");
        if (hidden(child)) return this.reconcileDeletion(childReal, child);
        try {
          const stat = await lstat(join(root, childReal));
          if (stat.isFile()) this.reconcileFileCreation(childReal, child, stat);
          else if (stat.isDirectory()) await this.reconcileFolderCreation(childReal, child);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await this.reconcileDeletion(childReal, child, true);
        }
      }));
    },
    async reconcileDeletion(real, path, now = true) {
      if (path === "/") return;
      const known = this.files[path];
      if (!known) return;
      if (!now) {
        setTimeout(() => void enqueue(() => this.reconcileFile(real, path)), 100);
        return;
      }
      if (known.type === "folder") for (const other of Object.keys(this.files)) if (other.startsWith(`${path}/`)) this.removeFile(other);
      this.removeFile(path);
    },
    /** The operating system's event for `path`, delivered as the app's watcher delivers one. */
    late(path) {
      return new Promise((resolve) => setTimeout(() => resolve(enqueue(() => this.reconcileFile(path, path, false))), 0));
    },
    // The adapter's own operations the desktop host reaches: each reconciles
    // what it touched, as Obsidian's do.
    exists: async (path) => existsSync(join(root, path)),
    async remove(path) { await unlink(join(root, path)); await this.own(path); },
    async trashSystem() { return false; },
    async trashLocal(path) { await this.remove(path); },
    async rmdir(path, recursive) { await rm(join(root, path), { recursive }); await this.own(path); },
  };
  /** The adapter's one queue: every operation, and every reconcile, waits for the one before. */
  function enqueue(action) {
    const run = () => action();
    const next = adapter.promise.then(run, run);
    adapter.promise = next;
    return next;
  }
  // The two members the plugin asks for by name, where this Obsidian has them.
  if (api) {
    adapter.queue = enqueue;
    adapter.reconcileInternalFile = (path) => {
      adapter.calls.push(path);
      return adapter.reconcileFile(adapter.getRealPath(path), path);
    };
  }
  const vault = {
    adapter,
    configDir: ".obsidian",
    fileMap,
    events,
    metadata,
    trigger: emit,
    on(name, handler) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return { name };
    },
    getAbstractFileByPath: (path) => fileMap[path] ?? null,
    getFileByPath: (path) => (fileMap[path] instanceof TFile ? fileMap[path] : null),
    getFolderByPath: (path) => (fileMap[path] instanceof TFolder ? fileMap[path] : null),
    getFiles: () => Object.values(fileMap).filter((entry) => entry instanceof TFile),
    getAllFolders: (includeRoot) => Object.values(fileMap).filter((entry) => entry instanceof TFolder && (includeRoot || entry !== rootFolder)),
    read: async (file) => readFileSync(join(root, file.path), "utf8"),
    getConfig: (key) => (key === "trashOption" ? "none" : undefined),
  };
  const fileManager = {
    // The "Deleted files" preference is "none": the vault's own removal, which reconciles.
    trashFile: async (entry) => {
      await rm(join(root, entry.path), { recursive: true });
      await adapter.own(entry.path);
    },
  };
  /** Obsidian's first listing of the vault at startup (`listAll`). */
  const listAll = () => enqueue(() => adapter.listRecursive(""));
  return { vault, adapter, fileManager, listAll };
}

/**
 * The receiving laptop: the real `ObsidianHost` and engine over a real vault
 * directory whose Obsidian index is `obsidianIndex`, enrolled on `server`.
 */
async function receiver(t, { server, timers, a }, { iterate = true, ...options } = {}) {
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-starved-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  server.addDevice(RECEIVER, RECEIVER_SECRET, "laptop", "macos");
  const { State } = box.require(join(box.home, "build/state.js"));
  let stored = null;
  const state = await State.open({ loadData: async () => stored, saveData: async (value) => { stored = JSON.parse(JSON.stringify(value)); } }, false, memorySecrets());
  Object.assign(state.data, { vrk: KEYS.vrk, deviceId: RECEIVER, deviceSecret: RECEIVER_SECRET, serverUrl: "https://sync.example.invalid" });
  const logs = [];
  const { Transport } = box.require(join(box.home, "build/transport.js"));
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: RECEIVER, secret: Uint8Array.from(Buffer.from(RECEIVER_SECRET, "hex")) }),
    edgeHeaders: () => [],
    now: () => a.host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => logs.push(line),
  });
  const obsidian = box.require("obsidian");
  const index = obsidianIndex(root, obsidian, options);
  const main = box.require(join(box.home, "build/main.js"));
  const plugin = new main.default();
  // The workspace: its leaves, and `iterateAllLeaves` unless a test takes it away.
  const leaves = [];
  const workspace = { getLeavesOfType: (type) => (type === "markdown" ? leaves : []), trigger: () => {} };
  if (iterate) workspace.iterateAllLeaves = (visit) => leaves.forEach(visit);
  plugin.app = { vault: index.vault, fileManager: index.fileManager, workspace };
  plugin.manifest = { id: "obsync-private-sync", version: "1.1.4", dir: ".obsidian/plugins/obsync-private-sync" };
  plugin.state = state;
  plugin.log = (line) => logs.push(line);
  plugin.platformName = () => "macos";
  plugin.deviceName = () => "receiver";
  plugin.registerEvent = () => undefined;
  const hooks = {};
  const promises = {
    ...fsPromises,
    rename: async (from, to) => {
      await fsPromises.rename(from, to);
      if (hooks.afterRename) await hooks.afterRename(from, to);
    },
    rmdir: async (path, ...rest) => {
      if (hooks.beforeRmdir) await hooks.beforeRmdir(path);
      await fsPromises.rmdir(path, ...rest);
    },
  };
  const host = new main.ObsidianHost(plugin, { base: root, path: nodePath, fs: { promises } });
  const notices = [];
  host.notify = (message) => notices.push(message);
  plugin.host = host;
  const { SyncEngine } = box.require(join(box.home, "build/sync/engine.js"));
  const engine = new SyncEngine({ state, transport, host, now: () => a.host.clock, timers });
  plugin.engine = engine;
  plugin.registerVaultEvents();
  t.after(() => engine.stop());
  await index.listAll();
  const posted = () => server.journal.filter((frame) => frame.device_id === RECEIVER);
  const text = (path) => { try { return readFileSync(join(root, path), "utf8"); } catch { return null; } };
  return { root, state, engine, host, plugin, logs, notices, hooks, posted, text, obsidian, leaves, ...index };
}

const listed = (r, path) => r.vault.getAbstractFileByPath(path);
const story = (r) => [...r.logs.filter((line) => /^(pull|watch|vault|folder|push|host|editor)/.test(line)), ...r.vault.events.map((e) => `event ${e}`)].join(" | ");

test("a note pulled into a new folder while the watcher is starved is listed at once, its folders with it, and is not sent back", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  await a.engine.start();
  const r = await receiver(t, devices);
  await r.engine.start();
  a.host.write("Inbox/New/note.md", "PULLED NOTE SENTINEL\n", 1000);
  a.host.write("Root.md", "ROOT NOTE SENTINEL\n", 1001);
  await timers.run(STEP_MS, () => r.text("Inbox/New/note.md") !== null && r.text("Root.md") !== null &&
    settled(r, "Inbox/New/note.md") && settled(r, "Root.md"));
  await timers.run(STEP_MS);

  const { TFile, TFolder } = r.obsidian;
  for (const path of ["Inbox/New/note.md", "Root.md"]) assert.ok(listed(r, path) instanceof TFile, `${path} is on the disk but not listed: ${story(r)}`);
  for (const path of ["Inbox", "Inbox/New"]) assert.ok(listed(r, path) instanceof TFolder, `${path} is not listed: ${story(r)}`);
  // The file explorer's tree, not only the lookup: each entry hangs under its folder.
  assert.ok(listed(r, "Inbox/New").children.includes(listed(r, "Inbox/New/note.md")));
  assert.ok(listed(r, "Inbox").children.includes(listed(r, "Inbox/New")));
  for (const path of ["Inbox/New/note.md", "Root.md"]) assert.ok(r.adapter.calls.includes(path), `${path} was never reconciled: ${story(r)}`);
  // The create it raised is the pull's own echo: nothing is published back.
  assert.deepEqual(r.posted(), [], `the receiver published what it received: ${story(r)}`);
  assert.equal(r.logs.filter((line) => line.startsWith("watch path_class=file decision=echo_suppressed")).length, 2, story(r));
  assert.ok(r.logs.some((line) => /^vault path_class=file decision=listed reason=not_listed budget_ms=60000 duration_ms=\d+$/.test(line)), story(r));
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.adapter.errors, []);
});

test("the late OS event finds the index right and raises nothing; an edit to a listed note no view shows is reindexed at once (#267)", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  await a.engine.start();
  const r = await receiver(t, devices);
  await r.engine.start();
  a.host.write("Notes/late.md", "FIRST SENTINEL\n", 1000);
  await timers.run(STEP_MS, () => settled(r, "Notes/late.md") && listed(r, "Notes/late.md") !== null);
  const before = r.vault.events.length;
  // The watcher catches up: every name the write touched is reported.
  for (const path of ["Notes", "Notes/late.md"]) await r.adapter.late(path);
  await timers.run(STEP_MS);
  assert.deepEqual(r.vault.events.slice(before), [], "the late event raised a second create or a modify");

  // An edit to a note Obsidian lists and no view shows: one reconcile, and
  // the one modify a watcher would have raised, so search reads the new words.
  const calls = r.adapter.calls.length;
  a.host.write("Notes/late.md", "SECOND SENTINEL, longer\n", 2000);
  await timers.run(STEP_MS, () => r.text("Notes/late.md") === "SECOND SENTINEL, longer\n" && r.state.fileByPath("Notes/late.md")?.mtime === 2000);
  await timers.run(STEP_MS);
  assert.equal(r.adapter.calls.length, calls + 1, story(r));
  assert.deepEqual(r.vault.events.slice(before), ["modify Notes/late.md"], story(r));
  assert.equal(r.vault.metadata["Notes/late.md"], "SECOND SENTINEL, longer\n", `search still reads the old words: ${story(r)}`);
  assert.equal(listed(r, "Notes/late.md").stat.size, "SECOND SENTINEL, longer\n".length);
  assert.ok(r.logs.some((line) => /^vault path_class=file decision=reindexed reason=bytes_changed budget_ms=60000 duration_ms=\d+$/.test(line)), story(r));
  // The modify is the write's own echo, and its late event raises no second.
  assert.equal(r.logs.filter((line) => line === "watch path_class=file decision=echo_suppressed").length, 2, story(r));
  await r.adapter.late("Notes/late.md");
  await timers.run(STEP_MS);
  assert.deepEqual(r.vault.events.slice(before), ["modify Notes/late.md"], story(r));
  assert.deepEqual(r.posted(), [], `the receiver published what it received: ${story(r)}`);
});

test("a pulled rename, deletion and new empty folder under a starved watcher leave the listing true and send nothing back", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  a.host.write("Notes/keep.md", "KEEP SENTINEL\n", 1000);
  a.host.write("Notes/gone.md", "GONE SENTINEL, other length\n", 1001);
  await a.engine.start();
  const r = await receiver(t, devices);
  await r.engine.start();
  await timers.run(STEP_MS, () => settled(r, "Notes/keep.md") && settled(r, "Notes/gone.md"));
  // Listed before the starvation, as a person's notes are: the watcher reports them.
  for (const path of ["Notes", "Notes/keep.md", "Notes/gone.md"]) await r.adapter.late(path);
  await timers.run(STEP_MS);
  assert.ok(listed(r, "Notes/keep.md") !== null && listed(r, "Notes/gone.md") !== null);

  a.host.rename("Notes/keep.md", "Notes/kept.md");
  a.host.remove("Notes/gone.md");
  a.host.makeFolder("Empty");
  await timers.run(STEP_MS, () => settled(r, "Notes/kept.md") && r.text("Notes/gone.md") === null &&
    r.state.folderByPath("Empty") !== undefined && existsSync(join(r.root, "Empty")));
  await timers.run(STEP_MS);
  const { TFile, TFolder } = r.obsidian;
  assert.ok(listed(r, "Notes/kept.md") instanceof TFile, `the renamed note is not listed: ${story(r)}`);
  assert.equal(listed(r, "Notes/keep.md"), null, `the old name is still listed: ${story(r)}`);
  assert.equal(listed(r, "Notes/gone.md"), null, `the deleted note is still listed: ${story(r)}`);
  assert.ok(listed(r, "Empty") instanceof TFolder, `the new folder is not listed: ${story(r)}`);

  // And a folder renamed: its note moves, and the old folder goes once empty.
  a.host.renameFolder("Notes", "Archive");
  await timers.run(STEP_MS, () => settled(r, "Archive/kept.md") && r.state.folderByPath("Archive") !== undefined &&
    r.state.folderByPath("Notes") === undefined && !existsSync(join(r.root, "Notes")));
  await timers.run(STEP_MS);
  assert.ok(listed(r, "Archive/kept.md") instanceof TFile, `the moved note is not listed: ${story(r)}`);
  assert.ok(listed(r, "Archive") instanceof TFolder, story(r));
  for (const path of ["Notes", "Notes/kept.md"]) assert.equal(listed(r, path), null, `${path} is still listed: ${story(r)}`);
  assert.deepEqual(r.posted(), [], `the receiver published what it received: ${story(r)}`);
  assert.equal(r.engine.heldDeletionCount, 0);
  assert.deepEqual(r.notices, []);
  // The names this host moved or removed were taken out as its own: no engine heard a note's deletion.
  assert.ok(!r.logs.some((line) => /^watch path_class=file .*event=delete/.test(line)), story(r));
});

test("a folder removed while Obsidian did not list it stays unlisted when its late event lists it first (#266, #253)", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  await a.engine.start();
  const r = await receiver(t, devices);
  await r.engine.start();
  await timers.run(STEP_MS);
  // A folder this disk holds that Obsidian never listed: another program made it while the watcher starved.
  mkdirSync(join(r.root, "Gone"));
  assert.equal(listed(r, "Gone"), null);
  // Its event arrives late: after the host found the folder unlisted, before the removal.
  r.hooks.beforeRmdir = async (path) => {
    if (path.endsWith(`${nodePath.sep}Gone`)) await r.adapter.late("Gone");
  };
  assert.equal(await r.host.trashFolder("Gone"), 0);
  assert.equal(existsSync(join(r.root, "Gone")), false, "the folder is removed");
  assert.equal(listed(r, "Gone"), null, `the removed folder is still listed: ${story(r)}`);
  assert.ok(r.logs.some((line) => /^vault path_class=folder decision=unlisted reason=still_listed /.test(line)), story(r));
  // With no late event the listing already agrees: one lookup, nothing logged.
  r.hooks.beforeRmdir = undefined;
  mkdirSync(join(r.root, "Quiet"));
  const before = r.logs.length;
  assert.equal(await r.host.trashFolder("Quiet"), 0);
  assert.equal(existsSync(join(r.root, "Quiet")), false);
  assert.equal(listed(r, "Quiet"), null);
  assert.ok(!r.logs.slice(before).some((line) => line.startsWith("vault path_class=folder")), story(r));
});

test("a name a watcher that keeps up has already reported costs a lookup, not a reconcile", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  a.host.write("Notes/keep.md", "KEEP SENTINEL\n", 1000);
  await a.engine.start();
  const r = await receiver(t, devices);
  await r.engine.start();
  await timers.run(STEP_MS, () => settled(r, "Notes/keep.md"));
  for (const path of ["Notes", "Notes/keep.md"]) await r.adapter.late(path);
  // The new name is reported before the host asks; the old one waits out the app's 100 ms.
  r.hooks.afterRename = async (_from, to) => { if (to.endsWith(`${nodePath.sep}kept.md`)) await r.adapter.late("Notes/kept.md"); };
  const calls = r.adapter.calls.length;
  a.host.rename("Notes/keep.md", "Notes/kept.md");
  await timers.run(STEP_MS, () => settled(r, "Notes/kept.md") && listed(r, "Notes/keep.md") === null);
  await timers.run(STEP_MS);
  assert.deepEqual(r.adapter.calls.slice(calls), ["Notes/keep.md"], story(r));
  assert.deepEqual(r.posted(), [], story(r));
});

test("a name is the host's own only while the host takes it out: the person's later deletion there is sent", async (t) => {
  const devices = await pair(t);
  const { server, timers, a } = devices;
  a.host.write("Notes/gone.md", "GONE SENTINEL\n", 1000);
  await a.engine.start();
  const r = await receiver(t, devices);
  await r.engine.start();
  await timers.run(STEP_MS, () => settled(r, "Notes/gone.md") && listed(r, "Notes/gone.md") !== null);
  a.host.remove("Notes/gone.md");
  await timers.run(STEP_MS, () => r.text("Notes/gone.md") === null && !settled(r, "Notes/gone.md"));
  await timers.run(STEP_MS);
  assert.equal(listed(r, "Notes/gone.md"), null, story(r));
  // The person makes a note of their own at that name in Obsidian, and deletes it again.
  writeFileSync(join(r.root, "Notes/gone.md"), "MINE SENTINEL, a note of my own\n");
  await r.adapter.own("Notes/gone.md");
  await timers.run(STEP_MS, () => settled(r, "Notes/gone.md"));
  const mine = r.state.fileByPath("Notes/gone.md").fileId;
  await unlink(join(r.root, "Notes/gone.md"));
  await r.adapter.own("Notes/gone.md");
  await timers.run(STEP_MS, () => server.journal.some((frame) => frame.file_id === mine && frame.deleted && frame.device_id === RECEIVER));
});

test("the person renaming or deleting the note between its rename and the reconcile leaves no ghost and fails nothing", async (t) => {
  for (const act of ["rename", "recase", "delete"]) {
    const devices = await pair(t);
    const { timers, a } = devices;
    await a.engine.start();
    const r = await receiver(t, devices);
    await r.engine.start();
    const path = "Notes/Raced.md";
    // Inside the host's own rename, after it lands: the person's file manager.
    r.hooks.afterRename = async (_from, to) => {
      if (!to.endsWith(`${nodePath.sep}Raced.md`)) return;
      r.hooks.afterRename = undefined;
      // Before the reconcile the write queues, whatever the host checks between.
      const queued = r.adapter.queue;
      r.adapter.queue = function (action) {
        r.adapter.queue = queued;
        return queued.call(this, async () => {
          if (act === "rename") await renameFile(join(r.root, path), join(r.root, "Notes/Moved away.md"));
          if (act === "recase") await renameFile(join(r.root, path), join(r.root, "Notes/raced.md"));
          if (act === "delete") await unlink(join(r.root, path));
          return action();
        });
      };
    };
    a.host.write(path, "RACED SENTINEL\n", 1000);
    await timers.run(STEP_MS, () => settled(r, path));
    await timers.run(STEP_MS);
    assert.equal(listed(r, path), null, `${act}: a name the disk no longer has is listed: ${story(r)}`);
    if (act === "recase" && r.adapter.insensitive) assert.equal(listed(r, "Notes/raced.md"), null, "listed under a spelling nothing reported");
    assert.ok(r.logs.some((line) => line.startsWith("vault path_class=file decision=unchanged reason=not_listed")), `${act}: ${story(r)}`);
    assert.deepEqual(r.adapter.errors, []);
    assert.ok(!r.logs.some((line) => line.includes("decision=failed")), `${act}: ${story(r)}`);
  }
});

test("without Obsidian's reconcile nothing changes, and that is said once", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  await a.engine.start();
  const r = await receiver(t, devices, { api: false });
  await r.engine.start();
  for (const [index, path] of ["One.md", "Two.md", "Three.md"].entries()) a.host.write(path, `ABSENT API SENTINEL ${index}\n`, 1000 + index);
  await timers.run(STEP_MS, () => ["One.md", "Two.md", "Three.md"].every((path) => settled(r, path)));
  await timers.run(STEP_MS);
  for (const path of ["One.md", "Two.md", "Three.md"]) {
    assert.equal(r.text(path)?.startsWith("ABSENT API SENTINEL"), true);
    assert.equal(listed(r, path), null, "listed with no reconcile to list it");
  }
  assert.deepEqual(r.logs.filter((line) => line.startsWith("vault ")), ["vault path_class=file decision=skipped reason=no_reconcile"]);
  assert.deepEqual(r.posted(), []);
});

test("a reconcile that throws is logged, and the write it follows stands", async (t) => {
  const devices = await pair(t);
  const { timers, a } = devices;
  await a.engine.start();
  const r = await receiver(t, devices);
  r.adapter.reconcileInternalFile = async () => { throw new TypeError("RECONCILE SENTINEL"); };
  await r.engine.start();
  a.host.write("Thrown.md", "STANDS SENTINEL\n", 1000);
  await timers.run(STEP_MS, () => settled(r, "Thrown.md"));
  await timers.run(STEP_MS);
  assert.equal(r.text("Thrown.md"), "STANDS SENTINEL\n");
  assert.equal(r.state.fileByPath("Thrown.md").mtime, 1000);
  assert.ok(r.logs.some((line) => /^vault path_class=file decision=failed reason=reconcile error=TypeError budget_ms=60000 duration_ms=\d+$/.test(line)), story(r));
  assert.ok(!r.logs.some((line) => line.includes("RECONCILE SENTINEL")), "the message is not logged, only its kind");
  assert.deepEqual(r.posted(), []);
});

test("a hidden name or the config folder is never reconciled", async (t) => {
  const devices = await pair(t);
  const r = await receiver(t, devices);
  for (const path of [".obsidian/app.json", ".obsidian", "Notes/.hidden/note.md", ".trash/old.md"]) {
    await r.host.reconcile(path, "file", true);
    await r.host.reconcile(path, "file", false);
  }
  assert.deepEqual(r.adapter.calls, []);
  assert.deepEqual(r.logs, []);
});

test("a copy this device writes beside a note is listed while the watcher is starved", async (t) => {
  const devices = await pair(t);
  const r = await receiver(t, devices);
  const bytes = new TextEncoder().encode("COPY SENTINEL\n");
  const writer = await r.host.createWriter("Copies/copy.md", bytes.length, () => {});
  await writer.write(bytes);
  const stat = await writer.commit(1000);
  await writer.abort();
  assert.equal(stat.path, "Copies/copy.md");
  assert.ok(listed(r, "Copies/copy.md") instanceof r.obsidian.TFile, story(r));
  assert.ok(listed(r, "Copies") instanceof r.obsidian.TFolder, story(r));
});

test("a folder re-cased on the disk is listed under its new spelling and not the old", async (t) => {
  const devices = await pair(t);
  const r = await receiver(t, devices);
  await fsPromises.mkdir(join(r.root, "Team docs"), { recursive: true });
  writeFileSync(join(r.root, "Team docs/One.md"), "ONE SENTINEL\n");
  await r.adapter.late("Team docs");
  await r.adapter.promise;
  assert.ok(listed(r, "Team docs/One.md") !== null);
  assert.equal(await r.host.moveFolder("Team docs", "team docs"), "moved");
  assert.ok(listed(r, "team docs") instanceof r.obsidian.TFolder, story(r));
  assert.ok(listed(r, "team docs/One.md") instanceof r.obsidian.TFile, story(r));
  assert.equal(listed(r, "Team docs"), null, story(r));
  assert.equal(listed(r, "Team docs/One.md"), null, story(r));
});

/**
 * A markdown editor on `path` as Obsidian 1.13.4's `TextFileView` takes its
 * file's `modify` (`onModify` -> `loadFileInternal`): a view whose last load
 * or save holds the bytes read does nothing; one with typing that differs
 * from both gets the app's merge and its notice (`merges`); any other is
 * reloaded (`loads`).
 */
function openEditor(r, path) {
  const view = new r.obsidian.MarkdownView();
  const disk = readFileSync(join(r.root, path), "utf8");
  Object.assign(view, { file: r.vault.getAbstractFileByPath(path), data: disk, lastSavedData: disk, dirty: false, loads: [], merges: 0 });
  view.getViewData = () => view.data;
  view.setViewData = (data) => { view.data = data; view.loads.push(data); };
  view.type = (text) => { view.data += text; view.dirty = true; };
  r.vault.on("modify", (file) => {
    if (file !== view.file) return;
    let bytes = readFileSync(join(r.root, file.path), "utf8");
    const last = view.lastSavedData;
    view.lastSavedData = bytes;
    if (last === bytes) return;
    if (view.dirty && view.data !== bytes && view.data !== last) {
      // This fixture only appends local typing while a remote earlier line
      // changes. Model that disjoint native merge with a literal append;
      // do not use the product merge implementation as its own oracle.
      assert.ok(view.data.startsWith(last), "fixture supports appended local input only");
      view.merges++;
      bytes += view.data.slice(last.length);
    }
    if (view.data !== bytes) view.setViewData(bytes);
  });
  r.leaves.push({ view });
  return view;
}

const BEFORE = "first line\nold words SENTINEL\n";
const AFTER = "first line\nnew words SENTINEL, longer\n";

/** A receiver holding `Notes/n.md` at `BEFORE`, listed as a person's notes are (the watcher reported it), then A's edit to it. */
async function editListed(t, options, arm = () => undefined) {
  const devices = await pair(t);
  const { timers, a } = devices;
  a.host.write("Notes/n.md", BEFORE, 1000);
  await a.engine.start();
  const r = await receiver(t, devices, options);
  await r.engine.start();
  await timers.run(STEP_MS, () => settled(r, "Notes/n.md"));
  for (const path of ["Notes", "Notes/n.md"]) await r.adapter.late(path);
  await timers.run(STEP_MS);
  const view = arm(r);
  const calls = r.adapter.calls.length;
  const applied = () => r.logs.filter((line) => line.startsWith("pull path_class=file") && line.includes("decision=applied")).length;
  const before = applied();
  a.host.write("Notes/n.md", AFTER, 2000);
  await timers.run(STEP_MS, () => r.text("Notes/n.md") === AFTER && r.state.fileByPath("Notes/n.md")?.mtime === 2000);
  // The host's native refresh deadline uses wall time. Do not advance the
  // simulated thirty-second scan past it while the real one-second reload is
  // still pending; wait for the pull receipt, not merely the written bytes.
  const deadline = performance.now() + 2500;
  while (applied() === before && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await timers.run(0);
  }
  assert.ok(applied() > before, `incoming write did not finish: ${story(r)}`);
  await timers.run(STEP_MS);
  assert.deepEqual(r.posted(), [], `the receiver published what it received: ${story(r)}`);
  return { r, view, timers, reconciled: r.adapter.calls.length - calls };
}

test("a listed open note reconciles once and preserves typing begun during the write (#267)", async (t) => {
  for (const typing of [false, true]) {
    const { r, view, timers, reconciled } = await editListed(t, {}, (r) => {
      const view = openEditor(r, "Notes/n.md");
      // Typing begun after the write was judged safe, before anything could reconcile.
      if (typing) r.hooks.afterRename = async (_from, to) => { if (to.endsWith(`${nodePath.sep}n.md`)) view.type("TYPED"); };
      return view;
    });
    assert.equal(reconciled, 1, `typing=${typing}: the native index must describe the incoming bytes: ${story(r)}`);
    assert.equal(view.merges, typing ? 1 : 0, `typing=${typing}: native merge ownership`);
    assert.deepEqual(view.loads, [typing ? `${AFTER}TYPED` : AFTER], `typing=${typing}: ${story(r)}`);
    assert.equal(view.data, typing ? `${AFTER}TYPED` : AFTER);
    assert.equal(r.vault.metadata["Notes/n.md"], AFTER, story(r));
    const events = r.vault.events.length;
    await r.adapter.late("Notes/n.md");
    assert.equal(r.vault.events.length, events, "a late OS event must not reload the editor again");
    // The host retained both edits, and the character merge recognises it:
    // the refresh is confirmed and the pane keeps its bridge (#339). The line
    // merge refused this suffix shape and demoted the pane to native saving
    // for the rest of its life.
    assert.ok(r.logs.includes("host path_class=file decision=editor_refreshed views=1"), story(r));
    assert.ok(!r.logs.some((line) => line.includes("reason=editor_reload_unconfirmed")), story(r));
    assert.equal(r.host.editorActivity.nativeOnly.get(view), undefined, `typing=${typing}: a confirmed pane was demoted: ${story(r)}`);
    if (typing) assert.equal(await r.host.editorReady("Notes/n.md"), false, "unsaved typing remains protected");
    assert.ok(!r.logs.some((line) => line.includes("reason=editor_refresh error=")), story(r));
  }
});

test("a view opened while the reconcile waits read the new bytes and ignores its modify (#267)", async (t) => {
  let view = null;
  const { r, reconciled } = await editListed(t, {}, (r) => {
    r.hooks.afterRename = async (_from, to) => {
      if (!to.endsWith(`${nodePath.sep}n.md`)) return;
      r.hooks.afterRename = undefined;
      const queued = r.adapter.queue;
      r.adapter.queue = function (action) {
        r.adapter.queue = queued;
        return queued.call(this, async () => { view = openEditor(r, "Notes/n.md"); view.type("TYPED"); return action(); });
      };
    };
  });
  assert.equal(reconciled, 1, story(r));
  assert.deepEqual(view.loads, [], "the view was reloaded");
  assert.equal(view.merges, 0);
  assert.equal(view.data, `${AFTER}TYPED`);
  assert.equal(r.vault.metadata["Notes/n.md"], AFTER, story(r));
});

test("a host without leaf iteration still updates its native file index (#267)", async (t) => {
  const { r, reconciled } = await editListed(t, { iterate: false });
  assert.equal(reconciled, 1, story(r));
  assert.equal(r.vault.metadata["Notes/n.md"], AFTER);
  const events = r.vault.events.length;
  await r.adapter.late("Notes/n.md");
  assert.equal(r.vault.events.length, events);
});
