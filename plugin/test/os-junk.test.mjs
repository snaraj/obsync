/**
 * What an operating system writes into a folder by itself (issue #184).
 *
 * Finder leaves `.DS_Store` in every folder it has shown, and Windows
 * Explorer leaves `Thumbs.db` and `desktop.ini`. None of them is a note, and
 * none of them is synced -- but a folder is removed only when it is EMPTY
 * (#104), so a folder another device deleted stayed here, empty in Obsidian's
 * file list and holding only `.DS_Store`, for good and without a word (S86).
 * These tests run the REAL desktop host over a real temporary vault, the real
 * mobile host over an adapter, and the real pull path over the fake server.
 *
 * #104's rule stands for everything else: a folder holding a hidden file, an
 * unsynced note or another plugin's data is kept, and now the device says so
 * once, naming the folder and how many items keep it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as realFsPromises } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeServer, KEYS, fakeState, keys, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { inSyncScope } = require("../build/syncScope.js");
const { osJunk } = require("../build/vaultPath.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const OTHER_DEVICE = "ffffffffffffffffffffffffffffffff";

/** The real desktop host over a real vault directory, and a pull context against the fake server. */
async function vault(t) {
  const box = sandbox();
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { applyChange } = box.require(join(box.home, "build", "sync", "pull.js"));
  const { pushFile } = box.require(join(box.home, "build", "sync", "push.js"));
  const root = mkdtempSync(join(tmpdir(), "obsync-junk-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const logs = [];
  const notices = [];
  const adapter = {
    getBasePath: () => root,
    stat: async (path) => {
      try {
        const found = statSync(join(root, path));
        return { type: found.isFile() ? "file" : "folder", mtime: Math.round(found.mtimeMs), size: found.size };
      } catch {
        return null;
      }
    },
    readBinary: async (path) => {
      const bytes = readFileSync(join(root, path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    remove: async (path) => unlinkSync(join(root, path)),
    // The adapter's own removal as Obsidian 1.13.4's desktop adapter makes it:
    // `fs.rm`, which without `recursive` refuses EVERY directory with
    // `EISDIR`, empty or not (read off a live rig, issue #266). Modelled as
    // `rmdir(2)`, this fixture hid that the host's fallback never worked.
    rmdir: async (path, recursive) => realFsPromises.rm(join(root, path), { recursive }),
  };
  const plugin = {
    state: { data: {} },
    app: {
      vault: {
        adapter,
        getFiles: () => [],
        getAbstractFileByPath: () => null,
        getFileByPath: () => null,
        // Obsidian's index holds no dot-named path and none of this vault, so
        // the host takes the adapter's non-recursive removal: the path on
        // which a `.DS_Store` stops `rmdir` outright.
        getFolderByPath: () => null,
        getAllFolders: () => [],
        getConfig: (key) => (key === "trashOption" ? "none" : undefined),
      },
      fileManager: { trashFile: async () => assert.fail("the vault cache had no entry to trash") },
      workspace: { getLeavesOfType: () => [] },
    },
    log: (line) => logs.push(line),
  };
  const host = new ObsidianHost(plugin, { fs: { promises: { ...realFsPromises } }, path: nodePath, base: root });
  host.notify = (message) => notices.push(message);
  const server = new FakeServer();
  const { state } = await fakeState(false);
  plugin.state = state;
  const k = await keys();
  const context = {
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      sleep: async () => undefined,
      maxAttempts: 2,
    }),
    host,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    domainId: KEYS.domainId,
    mapFileId: k.map.fileId,
    deviceId: KEYS.deviceId,
    concurrency: 4,
    authored: new Set(),
    written: new Set(),
    trashed: new Set(),
    moved: new Set(),
    createdFolders: new Set(),
    refused: new Set(),
    merges: new Map(),
    pushedAt: new Map(),
    answering: new Map(),
    arrivals: new Map(),
    forked: new Set(),
    deviceNames: new Map([[OTHER_DEVICE, "MacBook"]]),
    now: () => 1757200000000,
    deviceNameFor: (id) => (id === OTHER_DEVICE ? "MacBook" : "another device"),
  };
  /** The other device's record for a folder, or its tombstone. */
  const folder = async (path, { deleted = false, parents = [] } = {}) =>
    server.publishManifest({
      fileId: await c.folderFileId(k.manifestKey, path),
      manifest: { v: 2, kind: "directory", path, domain: KEYS.domainId, size: 0, chunks: [], sha256: "", deleted },
      sids: [],
      parents,
      deviceId: OTHER_DEVICE,
      manifestKey: k.manifestKey,
      bytes: 0,
    });
  let notes = 0;
  const note = (path, body, extra = {}) => server.publish({
    fileId: String(++notes).padStart(2, "0").repeat(16),
    path,
    bytes: enc(body),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    deviceId: OTHER_DEVICE,
    ...extra,
  });
  return { root, host, logs, notices, context, server, state, folder, note, applyChange, pushFile, keys: k };
}

/** A folder the other device made, here with `names` written into it by the operating system. */
async function kept(v, path, names) {
  const created = await v.folder(path);
  assert.equal(await v.applyChange(v.context, created), "applied");
  for (const name of names) writeFileSync(join(v.root, path, name), "written by the operating system\n");
  return created;
}

test("the one list names what an operating system writes, and nothing a user would", () => {
  for (const name of [".DS_Store", "Icon\r", "._Report.md", "Thumbs.db", "thumbs.db", "desktop.ini", "Desktop.ini"]) {
    assert.equal(osJunk(name), true, JSON.stringify(name));
  }
  for (const name of [".hidden", ".obsidian", "Icon", "Thumbs.md", "desktop.ini.md", "notes.db", "_DS_Store", "Report.md"]) {
    assert.equal(osJunk(name), false, JSON.stringify(name));
  }
});

// Finder's `Icon\r` is a name no Windows volume can hold (Win32 refuses a
// control character in a file name), so a Windows vault never meets it.
const finder = process.platform === "win32" ? ["._One.md", ".DS_Store"] : ["._One.md", "Icon\r", ".DS_Store"];
for (const names of [[".DS_Store"], ["Thumbs.db", "desktop.ini"], finder]) {
  test(`a folder deleted on another device goes, with only ${JSON.stringify(names)} in it (#184)`, async (t) => {
    const v = await vault(t);
    const created = await kept(v, "Projects/Beta", names);

    const tombstone = await v.folder("Projects/Beta", { deleted: true, parents: [created.version_id] });
    assert.equal(await v.applyChange(v.context, tombstone), "deleted", v.logs.join(" | "));

    assert.equal(existsSync(join(v.root, "Projects", "Beta")), false, "a folder holding only OS files was kept");
    assert.ok(
      v.logs.includes(`host path_class=folder decision=cleared reason=os_junk files=${names.length}`),
      v.logs.join(" | "),
    );
    assert.deepEqual(v.notices, [], "a folder that went said something");
  });
}

test("a folder holding something else is kept, with the OS files, and the user is told once with the count (#184)", async (t) => {
  const v = await vault(t);
  const created = await kept(v, "Projects/Beta", [".DS_Store", ".another-apps-data"]);

  const tombstone = await v.folder("Projects/Beta", { deleted: true, parents: [created.version_id] });
  assert.equal(await v.applyChange(v.context, tombstone), "skipped");

  assert.deepEqual(readdirSync(join(v.root, "Projects", "Beta")).sort(), [".DS_Store", ".another-apps-data"]);
  assert.ok(v.logs.some((line) => line.includes("folder path_class=folder decision=kept reason=not_empty items=1")), v.logs.join(" | "));
  assert.equal(v.notices.length, 1, v.notices.join(" | "));
  assert.ok(v.notices[0].includes('"Projects/Beta"'), v.notices[0]);
  assert.ok(v.notices[0].includes("MacBook deleted it"), v.notices[0]);
  assert.ok(v.notices[0].includes("1 item "), v.notices[0]);

  // Made and deleted again there: still the one notice for this folder.
  const again = await v.folder("Projects/Beta", { parents: [tombstone.version_id] });
  assert.equal(await v.applyChange(v.context, again), "applied");
  const tombstoneAgain = await v.folder("Projects/Beta", { deleted: true, parents: [again.version_id] });
  assert.equal(await v.applyChange(v.context, tombstoneAgain), "skipped");
  assert.equal(v.notices.length, 1, v.notices.join(" | "));
});

test("a folder whose note's own deletion is still on its way says nothing, and goes with the note (#184)", async (t) => {
  const v = await vault(t);
  const created = await kept(v, "Projects/Beta", [".DS_Store"]);
  const live = await v.note("Projects/Beta/Plan.md", "a plan\n");
  assert.equal(await v.applyChange(v.context, live), "applied");

  // The folder's tombstone overtook the note's on the wire.
  const tombstone = await v.folder("Projects/Beta", { deleted: true, parents: [created.version_id] });
  assert.equal(await v.applyChange(v.context, tombstone), "skipped");
  assert.deepEqual(v.notices, [], "a folder kept for a note whose deletion is on its way raised a notice");

  const gone = await v.server.publishTombstone({
    fileId: live.file_id, path: "Projects/Beta/Plan.md", manifestKey: v.keys.manifestKey, parents: [live.version_id],
  });
  assert.equal(await v.applyChange(v.context, gone), "deleted");
  assert.equal(existsSync(join(v.root, "Projects", "Beta")), false, "the emptied folder was left behind with its .DS_Store");
  assert.deepEqual(v.notices, []);
});

test("Windows' own files are not synced in either direction (#184)", async (t) => {
  const v = await vault(t);
  mkdirSync(join(v.root, "Photos"));
  writeFileSync(join(v.root, "Photos", "Thumbs.db"), "thumbnail cache\n");
  for (const path of ["Photos/Thumbs.db", "Photos/desktop.ini", "Photos/DESKTOP.INI"]) {
    assert.equal(inSyncScope(path, undefined), false, path);
  }
  assert.equal(inSyncScope("Photos/Thumbs.md", undefined), true);
  await assert.rejects(v.pushFile(v.context, "Photos/Thumbs.db"), /outside_sync_scope/);
  assert.equal(v.server.journal.length, 0, "a thumbnail cache was published");

  const incoming = await v.note("Photos/desktop.ini", "[.ShellClassInfo]\n");
  assert.equal(await v.applyChange(v.context, incoming), "skipped");
  assert.equal(existsSync(join(v.root, "Photos", "desktop.ini")), false, "another device's desktop.ini was written here");
  assert.deepEqual(v.notices, [], "a file nobody syncs raised a notice");
});

/** The mobile host over an adapter that lists a folder's children and refuses to remove a non-empty one. */
async function mobile(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const files = new Set();
  const folders = new Set();
  const children = (path) => [...files, ...folders].filter((candidate) => candidate.startsWith(`${path}/`) &&
    !candidate.slice(path.length + 1).includes("/"));
  const adapter = {
    stat: async (path) => (files.has(path) ? { type: "file" } : folders.has(path) ? { type: "folder" } : null),
    list: async (path) => ({
      files: children(path).filter((candidate) => files.has(candidate)),
      folders: children(path).filter((candidate) => folders.has(candidate)),
    }),
    remove: async (path) => { files.delete(path); },
    rmdir: async (path) => {
      if (children(path).length > 0) throw new Error("fixture: directory not empty");
      folders.delete(path);
    },
  };
  const plugin = {
    state: { data: {} },
    app: {
      vault: { adapter, getFolderByPath: () => null },
      fileManager: { trashFile: async () => assert.fail("no cache entry") },
    },
    log: () => undefined,
  };
  return { host: new ObsidianHost(plugin, null), files, folders };
}

test("the mobile host removes a folder holding only OS files, and counts what keeps any other (#184)", async (t) => {
  const { host, files, folders } = await mobile(t);
  folders.add("Beta");
  files.add("Beta/.DS_Store");
  files.add("Beta/._Plan.md");
  assert.equal(await host.trashFolder("Beta"), 0);
  assert.deepEqual([...files, ...folders], [], "a folder holding only OS files was kept");

  folders.add("Gamma");
  folders.add("Gamma/Inner");
  files.add("Gamma/.DS_Store");
  files.add("Gamma/.plugin-data");
  assert.equal(await host.trashFolder("Gamma"), 2, "the folder was not kept, or not counted");
  assert.deepEqual([...files].sort(), ["Gamma/.DS_Store", "Gamma/.plugin-data"], "a kept folder lost a file");
});

/**
 * AN EMPTY FOLDER OBSIDIAN HAS NOT INDEXED YET IS REMOVED, ONCE (issue #266).
 *
 * A device paired later replays the history fast enough that a folder the
 * pull path made moments ago is not in Obsidian's index yet, so the host
 * removes it itself. The adapter's own removal refused every directory with
 * `EISDIR`, the page failed and retried, and the folder stayed for good. The
 * walked directory goes by `rmdir(2)`: an entry that arrives meanwhile keeps
 * it, and one already gone is no failure.
 */
test("an empty folder Obsidian has not indexed goes, and a removal that finds it gone or filled fails nothing (#266)", async (t) => {
  const v = await vault(t);
  mkdirSync(join(v.root, "W201", "Sub2"), { recursive: true });
  assert.equal(await v.host.trashFolder("W201/Sub2"), 0);
  assert.equal(existsSync(join(v.root, "W201", "Sub2")), false, "the empty folder stayed");
  assert.equal(await v.host.trashFolder("W201/Sub2"), 0, "a folder already gone was a failure");

  const fs = v.host.desktop.fs.promises;
  const rmdir = fs.rmdir;
  t.after(() => { fs.rmdir = rmdir; });
  // Gone between the listing and the removal: removed, not a failure.
  mkdirSync(join(v.root, "W201", "Gone"));
  fs.rmdir = async (target) => { rmSync(target, { recursive: true }); return rmdir(target); };
  assert.equal(await v.host.trashFolder("W201/Gone"), 0);
  // Filled between the listing and the removal: kept, with what arrived.
  mkdirSync(join(v.root, "W201", "Filled"));
  fs.rmdir = async (target) => { writeFileSync(join(target, "Arrived.md"), "ARRIVED\n"); return rmdir(target); };
  assert.equal(await v.host.trashFolder("W201/Filled"), 1, "a folder that filled up was not kept");
  assert.equal(readFileSync(join(v.root, "W201", "Filled", "Arrived.md"), "utf8"), "ARRIVED\n");
  assert.deepEqual(v.notices, []);
});
