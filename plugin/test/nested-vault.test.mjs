/**
 * A vault inside a vault, both syncing with obsync (issue #180).
 *
 * S96: the folder `Sub` of a synced vault, opened as a vault of its own and
 * paired with the same server, downloaded the whole vault into itself; the
 * outer vault published those downloads as new notes under `Sub/`, and `Sub`
 * downloaded them again one level deeper. Within seconds every device held
 * `Sub/Sub/Sub/…` 98 levels deep, from 977 version posts, and nothing said so.
 *
 * Both ends are closed here, each through the REAL `ObsidianHost` over a
 * REAL directory: the inner vault refuses to be set up, paired or started
 * (the pairing half is in `pairing-claim.test.mjs`), and the outer vault
 * neither publishes nor applies anything in a folder that holds
 * `.obsidian/plugins/obsync-private-sync/` -- driven by the real engine, with
 * a real feed from the fake server, on desktop and on a phone's adapter.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeTimers, KEYS, SETUP_TOKEN, STEP_MS, memorySecrets, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile, pushFolder } = require("../build/sync/push.js");
const { SyncEngine, SCAN_MS } = require("../build/sync/engine.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const PLUGIN = [".obsidian", "plugins", "obsync-private-sync"];
const OUTER = "OUTER NOTE SENTINEL\n";
const INNER = "INNER NOTE SENTINEL\n";
const REMOTE = "REMOTE NOTE SENTINEL\n";

const refusal = (name) =>
  `This folder is inside the synced vault "${name}". Syncing it too would copy that vault into itself. ` +
  "Open the outer vault instead, or use Selected folders there.";

/** Every file and folder under `root`, as Obsidian's index holds them: hidden names left out. */
function walk(root, folder = "") {
  const out = { files: [], folders: [] };
  for (const name of readdirSync(folder === "" ? root : join(root, folder))) {
    if (name.startsWith(".")) continue;
    const path = folder === "" ? name : `${folder}/${name}`;
    const found = statSync(join(root, path));
    if (found.isDirectory()) {
      out.folders.push(path);
      const below = walk(root, path);
      out.files.push(...below.files);
      out.folders.push(...below.folders);
    } else {
      out.files.push({ path, stat: { mtime: Math.round(found.mtimeMs), size: found.size } });
    }
  }
  return out;
}

/**
 * A real vault directory under the real host -- desktop, or a phone's adapter
 * over the same directory -- with the rig's state, server and keys behind it.
 */
async function vault(t, { mobile = false } = {}) {
  const r = await rig({ isMobile: mobile });
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-nested-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { TFolder } = box.require("obsidian");
  const logs = [];
  const notices = [];
  const adapter = {
    exists: async (path) => existsSync(join(root, path)),
    mkdir: async (path) => fsPromises.mkdir(join(root, path), { recursive: true }),
    stat: async (path) => {
      if (!existsSync(join(root, path))) return null;
      const found = statSync(join(root, path));
      return { type: found.isFile() ? "file" : "folder", mtime: Math.round(found.mtimeMs), size: found.size };
    },
    readBinary: async (path) => {
      const bytes = readFileSync(join(root, path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    writeBinary: async (path, data, options) => {
      writeFileSync(join(root, path), new Uint8Array(data));
      if (options?.mtime) utimesSync(join(root, path), options.mtime / 1000, options.mtime / 1000);
    },
    list: async (path) => {
      const below = walk(root, path);
      return { files: below.files.map((file) => file.path), folders: below.folders };
    },
  };
  const plugin = {
    state: r.state,
    log: (line) => logs.push(line),
    app: {
      vault: {
        adapter,
        getFiles: () => walk(root).files,
        getAllFolders: () => walk(root).folders.map((path) => ({ path })),
        getAbstractFileByPath: (path) => (walk(root).folders.includes(path) ? Object.assign(new TFolder(), { path, children: [] }) : null),
        getFileByPath: () => null,
        getFolderByPath: () => null,
      },
      // No editor is open on anything here (issue #146).
      workspace: { getLeavesOfType: () => [], onLayoutReady: (done) => done() },
    },
    manifest: { version: "1.1.3" },
    platformName: () => (mobile ? "android" : "macos"),
    deviceName: () => "sentinel-device",
  };
  const host = new ObsidianHost(plugin, mobile ? null : { base: root, path: nodePath, fs: { promises: fsPromises } });
  host.notify = (message) => notices.push(message);
  r.context.host = host;
  const counts = { scans: 0 };
  if (!mobile) {
    const scan = host.scan.bind(host);
    host.scan = async () => { counts.scans++; return scan(); };
  }
  const seed = (path, text, mtime = 1757200000000) => {
    mkdirSync(join(root, nodePath.dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
    utimesSync(join(root, path), mtime / 1000, mtime / 1000);
  };
  /** Make `folder` a vault of its own that has obsync: its own `.obsidian/plugins/obsync-private-sync/`. */
  const nest = (folder) => mkdirSync(join(root, folder, ...PLUGIN), { recursive: true });
  let ids = 0;
  /** Another device's version of `path`. */
  const remote = (path, body = REMOTE, { fileId = String(++ids).padStart(2, "0").repeat(16), parents = [] } = {}) =>
    r.server.publish({ fileId, path, bytes: enc(body), mtime: 1757200001000, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const read = (path) => readFileSync(join(root, path), "utf8");
  return { ...r, root, host, logs, notices, counts, seed, nest, remote, read };
}

/** The real engine over the rig, on a virtual clock, stopped when the test ends. */
function engineFor(t, r) {
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  return { engine, timers };
}

/** Every path THIS device published, read off the server's own journal. */
async function ownPaths(r) {
  const paths = [];
  for (const frame of r.server.journal) {
    if (frame.device_id !== KEYS.deviceId) continue;
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(
      r.keys.manifestKey, frame.file_id, binder, c.unhex(frame.manifest_nonce), c.unbase64(frame.manifest_ct),
    ));
    paths.push(manifest.path);
  }
  return paths.sort();
}

const chunkPuts = (r) => r.server.requests.filter((request) => request.method === "PUT" && request.target.startsWith("/v1/chunks/")).length;
const excluded = (r) => r.logs.filter((line) => line === "host path_class=folder decision=excluded reason=nested_vault");
const notSynced = (r) => r.logs.filter((line) => line === "host path_class=file decision=not_synced reason=nested_vault");
const story = (r) => `root=${JSON.stringify(walk(r.root))} logs=${r.logs.join(" | ")}`;

test("a folder that is a vault of its own is neither published nor written into, and is named once (#180)", async (t) => {
  const r = await vault(t);
  r.seed("Notes/a.md", OUTER);
  r.seed("Sub/s1.md", INNER);
  r.nest("Sub");
  const intoSub = await r.remote("Sub/remote.md");
  const intoNotes = await r.remote("Notes/remote.md");

  const { engine, timers } = engineFor(t, r);
  await engine.start();
  await timers.run(STEP_MS, () => r.state.data.lastSeq >= intoNotes.seq && r.state.fileByPath("Notes/a.md") !== undefined);

  // The watcher's way in: a note the inner vault just wrote.
  r.seed("Sub/new.md", INNER, 1757200002000);
  const beforeChange = notSynced(r).length;
  engine.changed("Sub/new.md");
  await timers.run(STEP_MS, () => notSynced(r).length > beforeChange);
  await timers.run(SCAN_MS);
  const quiet = notSynced(r).length;
  const scans = r.counts.scans;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  // THE OUTER HALF OF THE LOOP, BOTH WAYS. Nothing of `Sub` left this device
  // -- not a version, not a byte -- and nothing from the feed landed in it.
  assert.deepEqual(await ownPaths(r), ["Notes", "Notes/a.md"], story(r));
  assert.equal(chunkPuts(r), 1, `bytes of the nested vault were uploaded: ${story(r)}`);
  assert.equal(r.read("Notes/remote.md"), REMOTE, "the rest of the vault syncs as it always did");
  assert.deepEqual(readdirSync(join(r.root, "Sub")).sort(), [".obsidian", "new.md", "s1.md"], story(r));
  assert.equal(r.read("Sub/s1.md"), INNER);
  assert.ok(
    r.logs.includes(`pull path_class=manifest decision=not_synced reason=nested_vault file=${intoSub.file_id} seq=${intoSub.seq}`),
    story(r),
  );

  // NEVER SILENT, AND NEVER ONCE PER NOTE: one notice naming the folder, one log line that does not.
  assert.equal(r.notices.length, 1, r.notices.join(" | "));
  assert.match(r.notices[0], /^obsync does not sync "Sub": that folder is a vault of its own with obsync installed/);
  assert.equal(excluded(r).length, 1, story(r));

  // The periodic scan does not list it at all, so it asks nothing about it again.
  assert.ok(r.counts.scans >= scans + 2, `the periodic scan did not run: ${story(r)}`);
  assert.ok(quiet > 0, `the watcher's note was never asked about: ${story(r)}`);
  assert.equal(notSynced(r).length, quiet, `every scan asked again about the nested vault: ${story(r)}`);
});

test("notes synced before their folder became a vault of its own are never renamed, deleted or moved out by sync (#180)", async (t) => {
  const r = await vault(t);
  // S96 exactly: `Sub/s1.md` and `Sub/s2.md` synced first, THEN `Sub` opened as a vault.
  r.seed("Sub/s1.md", INNER);
  r.seed("Sub/s2.md", OUTER);
  await pushFolder(r.context, "Sub");
  await pushFile(r.context, "Sub/s1.md");
  await pushFile(r.context, "Sub/s2.md");
  const s1 = r.state.fileByPath("Sub/s1.md");
  const s2 = r.state.fileByPath("Sub/s2.md");
  r.nest("Sub");
  // Another device moves one note out of `Sub`, and edits the other.
  const out = await r.remote("Notes/s1.md", INNER, { fileId: s1.fileId, parents: [s1.versionId] });
  const edit = await r.remote("Sub/s2.md", REMOTE, { fileId: s2.fileId, parents: [s2.versionId] });
  const before = r.server.journal.length;

  const { engine, timers } = engineFor(t, r);
  await engine.start();
  await timers.run(STEP_MS, () => r.state.data.lastSeq >= edit.seq);
  assert.equal(r.read("Sub/s1.md"), INNER, `a note was moved out of the nested vault: ${story(r)}`);
  assert.equal(existsSync(join(r.root, "Notes/s1.md")), false, story(r));
  assert.equal(r.read("Sub/s2.md"), OUTER, `the nested vault's note was overwritten: ${story(r)}`);
  for (const frame of [out, edit]) {
    assert.ok(r.logs.includes(`pull path_class=manifest decision=not_synced reason=nested_vault file=${frame.file_id} seq=${frame.seq}`), story(r));
  }

  // The inner vault renames one note and deletes the other; this vault sees both.
  renameSync(join(r.root, "Sub/s1.md"), join(r.root, "Sub/s1b.md"));
  engine.renamed("Sub/s1.md", "Sub/s1b.md");
  unlinkSync(join(r.root, "Sub/s2.md"));
  engine.deleted("Sub/s2.md");
  await timers.run(SCAN_MS);

  // Nothing after the start: no folder tombstone for `Sub` at the reconcile,
  // no version for the rename, no tombstone for the deletion.
  assert.equal(r.server.journal.length, before, story(r));
  assert.deepEqual(await ownPaths(r), ["Sub", "Sub/s1.md", "Sub/s2.md"], story(r));
  assert.notEqual(r.state.folderByPath("Sub"), undefined, "the folder's record was not given up either");
  assert.ok(r.logs.includes("push path_class=file decision=not_synced reason=nested_vault"), story(r));
  assert.equal(r.notices.length, 1, r.notices.join(" | "));
});

test("on a phone the adapter says which folder is a vault of its own, in both directions (#180)", async (t) => {
  const r = await vault(t, { mobile: true });
  r.seed("Notes/a.md", OUTER);
  r.seed("Sub/s1.md", INNER);
  r.nest("Sub");
  assert.equal(await r.host.syncable("Sub/s1.md"), false);
  assert.equal(await r.host.syncable("Sub", "folder"), false, "the folder's own record is its too");
  assert.equal(await r.host.syncable("Notes/a.md"), true);
  const intoSub = await r.remote("Sub/remote.md");
  const intoNotes = await r.remote("Notes/remote.md");
  assert.equal(await applyChange(r.context, intoSub), "skipped");
  assert.equal(await applyChange(r.context, intoNotes), "applied");
  assert.equal(existsSync(join(r.root, "Sub/remote.md")), false, story(r));
  assert.equal(r.read("Notes/remote.md"), REMOTE);
  assert.equal(r.notices.length, 1, r.notices.join(" | "));
  assert.equal(excluded(r).length, 1, story(r));
});

test("the ancestor check finds this plugin above the vault root, and nothing else (#180)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "obsync-ancestors-"));
  const box = sandbox();
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const make = (...parts) => mkdirSync(join(base, ...parts), { recursive: true });
  const plugin = { state: { data: {} }, log: () => undefined };
  const enclosing = (...parts) =>
    new ObsidianHost(plugin, { fs: { promises: fsPromises }, path: nodePath, base: join(base, ...parts) }).enclosingVault();

  make("A", ...PLUGIN);
  make("A", "Deep", "Vault");
  assert.equal(await enclosing("A", "Deep", "Vault"), "A", "two folders up");

  // An Obsidian vault above, with another plugin only.
  make("B", ".obsidian", "plugins", "another-plugin");
  make("B", "Vault");
  assert.equal(await enclosing("B", "Vault"), null);

  // `.obsidian` above is a LINK to a folder holding the plugin: not followed.
  make("Elsewhere", "plugins", "obsync-private-sync");
  make("C", "Vault");
  symlinkSync(join(base, "Elsewhere"), join(base, "C", ".obsidian"), "dir");
  assert.equal(await enclosing("C", "Vault"), null);

  // The plugin's name above is a file, not a folder.
  make("D", ".obsidian", "plugins");
  writeFileSync(join(base, "D", ".obsidian", "plugins", "obsync-private-sync"), "");
  make("D", "Vault");
  assert.equal(await enclosing("D", "Vault"), null);

  // The vault's OWN plugin folder is not a folder above it.
  make("E", "Vault", ...PLUGIN);
  assert.equal(await enclosing("E", "Vault"), null);

  // A phone sees nothing outside its vault.
  assert.equal(await new ObsidianHost(plugin, null).enclosingVault(), null);
});

/**
 * The real plugin, loaded over a vault at `root` on the real desktop host,
 * with every request it makes recorded and none of them answered by a server.
 */
async function loaded(t, root, metadata) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  obsidian.notices.length = 0;
  const requests = [], logs = [], bar = [];
  obsidian.requestUrl = async (request) => {
    requests.push(request.url);
    return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) };
  };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  let stored = structuredClone(metadata);
  instance.loadData = async () => structuredClone(stored);
  instance.saveData = async (value) => { stored = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText: (text) => bar.push(text) });
  instance.app = { workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (done) => done() }, secretStorage: memorySecrets(), vault: { adapter: { getBasePath: () => root }, on: () => ({}) } };
  instance.manifest = { version: "1.1.3" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  t.after(() => instance.onunload());
  await instance.onload();
  await instance.firstStart;
  return { instance, requests, logs, bar, notices: obsidian.notices };
}

/** `Outer` has obsync; `Outer/Sub` is the vault being loaded. */
function nestedRoot(t) {
  const outer = join(mkdtempSync(join(tmpdir(), "obsync-inner-")), "Outer");
  t.after(() => rmSync(nodePath.dirname(outer), { recursive: true, force: true }));
  mkdirSync(join(outer, ...PLUGIN), { recursive: true });
  mkdirSync(join(outer, "Sub", ...PLUGIN), { recursive: true });
  return join(outer, "Sub");
}

test("a vault paired before the check existed stops at every start inside a synced vault, with one notice (#180)", async (t) => {
  const p = await loaded(t, nestedRoot(t), {
    vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
    serverUrl: "https://sync.example.invalid", edgeHeaders: [],
  });
  await p.instance.syncNow();
  await p.instance.restartEngine();

  assert.deepEqual(p.requests, [], "nothing reached the server");
  assert.equal(p.instance.engine, null);
  assert.equal(p.instance.statusText(), `error — ${refusal("Outer")}`);
  assert.deepEqual(p.notices, [`obsync: ${refusal("Outer")}`], "one notice, not one per start");
  assert.equal(p.logs.filter((line) => /^engine decision=refused reason=nested_vault duration_ms=\d+$/.test(line)).length, 3, p.logs.join(" | "));
  assert.ok(!p.logs.some((line) => line.startsWith("engine decision=retry_scheduled")), "no timer knocks again");
});

test("first-time setup inside a synced vault refuses before the setup request (#180)", async (t) => {
  const p = await loaded(t, nestedRoot(t), { serverUrl: "https://sync.example.invalid" });
  await p.instance.setUpAccount(SETUP_TOKEN, "Local account");

  assert.deepEqual(p.requests, [], "the one-time setup token was not spent");
  assert.equal(p.instance.state.data.deviceId, null);
  assert.deepEqual(p.notices, [`obsync: ${refusal("Outer")}`]);
  assert.ok(p.logs.some((line) => /^setup decision=refused reason=nested_vault duration_ms=\d+$/.test(line)), p.logs.join(" | "));
});
