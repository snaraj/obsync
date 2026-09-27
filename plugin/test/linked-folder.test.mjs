/**
 * A folder that is a LINK to somewhere else, on the real desktop host
 * (issue #167).
 *
 * Nothing inside a linked folder ever left this device: every file under it
 * fails the no-follow component walk (`vaultPath.ts`). Its NAME did. Obsidian
 * indexes a link to a folder as a folder and reports it with a create event,
 * and the create event published a folder record on the string rule alone --
 * so every other device made a real, empty folder of that name, and a note
 * made there later came back to this device as a change it had to refuse. The
 * start-up listing already refused the link; the create event now asks the
 * same question before anything names it on the server, and the user is told
 * once which folder stays on this device.
 *
 * Desktop only: mobile reaches the vault through Obsidian's adapter, and
 * neither phone's storage offers a vault a symbolic link to make.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as realFsPromises } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeTimers, KEYS, STEP_MS, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const OTHER_DEVICE = "ffffffffffffffffffffffffffffffff";

/** Every name under `root`, following nothing: what Obsidian's index shows of the vault. */
function walk(root, folder = "") {
  const out = { files: [], folders: [] };
  for (const name of readdirSync(folder === "" ? root : join(root, folder))) {
    if (name.startsWith(".")) continue;
    const path = folder === "" ? name : `${folder}/${name}`;
    // Obsidian follows a link when it indexes, so a link to a folder is a
    // folder in its tree (S45): the reason the create event fired at all.
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
 * The real desktop host over a real vault holding a link, with the rig's
 * server and state behind it. The host, the engine and the transport come
 * from ONE sandbox copy of `build/`, as the shipped bundle gives the plugin
 * one of each class: a host's `VaultPathError` from another copy is not the
 * pull path's, and the feed would read a refusal as a failure.
 */
async function vault(t) {
  const r = await rig();
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-linked-"));
  const outside = mkdtempSync(join(tmpdir(), "obsync-linked-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { SyncEngine } = box.require(join(box.home, "build", "sync", "engine.js"));
  const { Transport } = box.require(join(box.home, "build", "transport.js"));
  const logs = [];
  const notices = [];
  const plugin = {
    state: r.state,
    log: (line) => logs.push(line),
    app: {
      vault: {
        adapter: {},
        getFiles: () => walk(root).files,
        getAllFolders: () => walk(root).folders.map((path) => ({ path })),
        getAbstractFileByPath: () => null,
        getFileByPath: () => null,
        getFolderByPath: () => null,
      },
      workspace: { getLeavesOfType: () => [] },
      fileManager: { trashFile: async () => assert.fail("nothing here is trashed") },
    },
    manifest: { version: "1.1.4" },
    platformName: () => "macos",
    deviceName: () => "sentinel-device",
  };
  const host = new ObsidianHost(plugin, { base: root, path: nodePath, fs: { promises: realFsPromises } });
  host.notify = (message) => notices.push(message);
  r.context.host = host;
  const timers = new FakeTimers();
  const transport = new Transport({
    request: r.server.request,
    serverUrl: () => r.state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => r.host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => logs.push(line),
  });
  const engine = new SyncEngine({ state: r.state, transport, host, now: () => timers.now, timers });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  const linked = (message) => message.startsWith("obsync doesn't sync linked folders");
  return { ...r, root, outside, host, logs, notices, engine, timers, linked };
}

test("a linked folder's create event publishes nothing, and the user is told once (#167)", async (t) => {
  const v = await vault(t);
  mkdirSync(join(v.root, "Notes"));
  writeFileSync(join(v.root, "Notes", "Real.md"), "a real note\n");
  writeFileSync(join(v.outside, "outside-note.md"), "a note that lives outside the vault\n");
  symlinkSync(v.outside, join(v.root, "Notes", "linked"), "dir");
  await v.engine.start();
  await v.timers.run(STEP_MS, () => v.state.fileByPath("Notes/Real.md") !== undefined);

  // What Obsidian delivers when the link appears, and again for good measure.
  v.engine.folderCreated("Notes/linked");
  await v.timers.run(STEP_MS);
  v.engine.folderCreated("Notes/linked");
  await v.timers.run(STEP_MS);

  const linkedId = await c.folderFileId(v.keys.manifestKey, "Notes/linked");
  assert.equal(v.server.files.has(linkedId), false, "the linked folder's name was published");
  assert.equal(v.state.folderByPath("Notes/linked"), undefined, "a record was kept for a link");
  assert.equal(v.state.fileByPath("Notes/linked/outside-note.md"), undefined, "a file behind the link was synced");
  assert.ok(
    v.logs.includes("host path_class=folder decision=not_synced reason=symlink_component"),
    v.logs.filter((line) => line.startsWith("host")).join(" | "),
  );
  const told = v.notices.filter(v.linked);
  assert.equal(told.length, 1, v.notices.join(" | "));
  assert.ok(told[0].includes('"Notes/linked"'), told[0]);
  assert.ok(told[0].includes("stays on this device only"), told[0]);
  // And the real folder beside it is published as ever.
  assert.equal(v.server.files.has(await c.folderFileId(v.keys.manifestKey, "Notes")), true, "the real folder was not published");
});

test("a record an earlier version published for a link is retired at the next start (#167)", async (t) => {
  const v = await vault(t);
  mkdirSync(join(v.root, "Notes"));
  symlinkSync(v.outside, join(v.root, "Notes", "linked"), "dir");
  // What 1.1.3 left: this device's own record for the link's name, on the
  // server and in its state, which every other device made a real folder of.
  const fileId = await c.folderFileId(v.keys.manifestKey, "Notes/linked");
  const legacy = await v.server.publishManifest({
    fileId,
    manifest: { v: 2, kind: "directory", path: "Notes/linked", domain: v.context.domainId, size: 0, chunks: [], sha256: "", deleted: false },
    sids: [], parents: [], deviceId: KEYS.deviceId, manifestKey: v.keys.manifestKey, bytes: 0,
  });
  v.state.setFolder("Notes/linked", { fileId, versionId: legacy.version_id });
  v.state.data.lastSeq = legacy.seq;

  await v.engine.start();
  await v.timers.run(STEP_MS, () => v.state.folderByPath("Notes/linked") === undefined);

  const retired = v.server.journal.filter((frame) => frame.file_id === fileId && frame.deleted);
  assert.equal(retired.length, 1, "the link's old record was not retired");
  assert.deepEqual(retired[0].parents, [legacy.version_id]);
  assert.equal(v.notices.filter(v.linked).length, 1, v.notices.join(" | "));
});

test("a peer's folder named like a link here writes nothing through it, and a note made in the link stays here (#167)", async (t) => {
  const v = await vault(t);
  symlinkSync(v.outside, join(v.root, "Shared"), "dir");
  await v.engine.start();
  await v.timers.run(STEP_MS);

  // The other device has a REAL folder of that name, and a note in it.
  const folder = await v.server.publishManifest({
    fileId: await c.folderFileId(v.keys.manifestKey, "Shared"),
    manifest: { v: 2, kind: "directory", path: "Shared", domain: v.context.domainId, size: 0, chunks: [], sha256: "", deleted: false },
    sids: [], parents: [], deviceId: OTHER_DEVICE, manifestKey: v.keys.manifestKey, bytes: 0,
  });
  const note = await v.server.publish({
    fileId: "5a".repeat(16), path: "Shared/new.md", bytes: enc("made on the other device\n"), mtime: 1757200001000,
    domainKey: v.keys.domainKey, manifestKey: v.keys.manifestKey,
  });
  await v.timers.run(STEP_MS, () => v.state.data.lastSeq >= note.seq);
  // Refused, each in its own words, and the feed moved on past both.
  assert.equal(
    v.logs.filter((line) => line.includes("decision=refused reason=symlink_component")).length >= 2,
    true,
    v.logs.join(" | "),
  );
  assert.deepEqual(readdirSync(v.outside), [], "the other device's note was written through the link");

  // A note made HERE, in the linked folder: it is the user's, and it stays.
  writeFileSync(join(v.root, "Shared", "local.md"), "made in the link on this device\n");
  v.engine.changed("Shared/local.md");
  await v.timers.run(STEP_MS);
  await v.timers.run(STEP_MS);

  assert.equal(readFileSync(join(v.outside, "local.md"), "utf8"), "made in the link on this device\n");
  assert.deepEqual(readdirSync(v.outside), ["local.md"]);
  assert.equal(
    v.server.journal.filter((frame) => frame.device_id !== OTHER_DEVICE && frame.seq > folder.seq).length,
    0,
    "this device published something from the link",
  );
  assert.equal(v.notices.filter(v.linked).length, 1, v.notices.join(" | "));
  assert.equal(existsSync(join(v.root, "Shared", "new.md")), false);
});
