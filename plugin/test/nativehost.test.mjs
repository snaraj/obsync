/**
 * The same-name move and the settled write, on the REAL host (round 3).
 *
 * The third review round made the point the fake vault cannot make: the
 * guards proved in `samename.test.mjs` are guards in `pull.ts`, and the
 * operations they guard belong to `main.ts`, which does asynchronous work of
 * its own inside each one. A stat taken in the pull path is the last word
 * only if the host's operation is atomic, and neither of these is:
 *
 *  - `trash` looks the file up in the vault and hands it to
 *    `FileManager.trashFile`, which honours the user's deletion preference
 *    and moves the file into a bin. A save landing in there is removed as if
 *    it were the content the pull path had just copied (finding 1).
 *  - the desktop writer renames its temp over the target and then STATS THE
 *    NAME to answer. An in-place save between the two keeps the inode, so
 *    the identity check passes while the metadata describes other bytes, and
 *    the record then declares those bytes to be the incoming version
 *    (finding 2).
 *
 * So these tests drive the real `ObsidianHost` over a real temporary vault,
 * with the real pull path above it and the fake server beside it, and inject
 * the save INSIDE the host's operation through the filesystem seam the host
 * already takes for its constructor. The control tests inject at the window
 * the round-2 guards do cover, so a repair that moved the blind spot rather
 * than closing it fails one of them.
 *
 * The cases, the injection points and the sentinels are the reviewer's, from
 * the regression attached to receipt 5771502579 on PR #120.
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
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

const enc = (text) => new TextEncoder().encode(text);
const NOTE = "Notes/Same.md";
const MINE = "LOCAL ORIGINAL SENTINEL\n";
const THEIRS = "FOREIGN ORIGINAL SENTINEL\n";
const EDIT = "LOCAL CONCURRENT EDIT SENTINEL, present nowhere else\n";
const HIGHER = "33".repeat(16);
const LOWER = "11".repeat(16);

/**
 * A real vault directory under the real host, wired into the rig's state,
 * server and keys. `hooks` fire INSIDE the host's own filesystem calls.
 */
async function native(t, hooks = {}) {
  const r = await rig();
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-native-"));
  mkdirSync(join(root, "Notes"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const logs = [];
  const trashed = [];
  const promises = {
    ...fsPromises,
    link: async (...args) => {
      await fsPromises.link(...args);
      if (hooks.afterLink) await hooks.afterLink(root, ...args);
    },
    rename: async (...args) => {
      await fsPromises.rename(...args);
      if (hooks.afterRename) await hooks.afterRename(root, ...args);
    },
  };
  const vault = {
    getFileByPath: (path) => (existsSync(join(root, path)) ? { path } : null),
    adapter: { remove: (path) => fsPromises.unlink(join(root, path)) },
  };
  const plugin = {
    state: r.state,
    log: (line) => logs.push(line),
    app: {
      vault,
      fileManager: {
        // The vault's own trash: asynchronous, and doing work of its own
        // before the file stops existing.
        trashFile: async (file) => {
          if (hooks.beforeTrash) await hooks.beforeTrash(root, file.path);
          trashed.push({ path: file.path, bytes: readFileSync(join(root, file.path), "utf8") });
          await fsPromises.unlink(join(root, file.path));
        },
      },
    },
    manifest: { version: "1.0.7" },
    platformName: () => "linux",
    deviceName: () => "sentinel-device",
  };
  const host = new ObsidianHost(plugin, { base: root, path: nodePath, fs: { promises } });
  const notices = [];
  host.notify = (message) => notices.push(message);
  r.context.host = host;
  const seed = (path, text, mtime) => {
    writeFileSync(join(root, path), text);
    utimesSync(join(root, path), mtime / 1000, mtime / 1000);
  };
  /** Every note the user can see, which is every name that is not hidden. */
  const contents = () =>
    readdirSync(join(root, "Notes"))
      .filter((name) => !name.startsWith("."))
      .map((name) => readFileSync(join(root, "Notes", name), "utf8"));
  const hidden = () => readdirSync(join(root, "Notes")).filter((name) => name.startsWith("."));
  return { ...r, root, host, seed, contents, hidden, logs, trashed, notices };
}

/**
 * The other half of the pair: this device holds the LOWER id, so its own note
 * KEEPS the name and the incoming file is the one given a name of its own.
 * Every later version of that id lands at the name this device gave it, which
 * is `updateSettled`, which is where the writer's answer is recorded.
 */
async function settle(r) {
  r.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), fileId: LOWER });
  const first = await r.server.publish({
    fileId: HIGHER,
    path: NOTE,
    bytes: enc(THEIRS),
    mtime: 4000,
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, first), "conflict_copy");
  return { first, copy: r.state.pathByFileId(HIGHER) };
}

/** A descendant of `parent`, for the file that was given a name of its own. */
function descend(r, parent, text, mtime) {
  return r.server.publish({
    fileId: HIGHER,
    path: NOTE,
    bytes: enc(THEIRS + text),
    mtime,
    parents: [parent],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
}

/** This device holds the HIGHER id, so its own note is the one that moves. */
async function collide(r) {
  r.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), fileId: HIGHER });
  return await r.server.publish({
    fileId: LOWER,
    path: NOTE,
    bytes: enc(THEIRS),
    mtime: 4000,
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
}

test("control: a native move refuses an edit that arrives before its last stat", async (t) => {
  let injected = false;
  const r = await native(t, {
    afterLink: async (root) => {
      // The first link is the conflict copy taking its name: the window the
      // round-2 guard covers, because a stat still follows it.
      if (injected) return;
      injected = true;
      writeFileSync(join(root, NOTE), EDIT);
      utimesSync(join(root, NOTE), 9.999, 9.999);
    },
  });
  const frame = await collide(r);
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  assert.ok(injected);
  assert.ok(r.contents().includes(EDIT), "the edit was not kept where the user made it");
  assert.deepEqual(r.trashed, [], "the move removed a file it had been told had changed");
});

test("a native move preserves an edit arriving inside the trash operation", async (t) => {
  let injected = false;
  const r = await native(t, {
    beforeTrash: async (root, path) => {
      // INSIDE `trashFile`, which no check made before the call can see.
      if (path !== NOTE || injected) return;
      injected = true;
      writeFileSync(join(root, path), EDIT);
      utimesSync(join(root, path), 9.999, 9.999);
    },
  });
  const frame = await collide(r);
  const result = await applyChange(r.context, frame);
  assert.ok(injected, "the test never entered the trash boundary");
  assert.ok(
    r.contents().includes(EDIT),
    `edit absent from live vault; result=${result}; live=${JSON.stringify(r.contents())}`,
  );
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), EDIT, "the edit is not under its own name");
  assert.ok(
    r.logs.some((line) => line.includes("decision=move_aside_refused reason=source_changed_in_trash")),
    `no refusal in the log: ${JSON.stringify(r.logs)}`,
  );
  // The move did not happen, so this device keeps its own file id at its own
  // name and the pair is kept as 1.0.6 kept it: a copy beside, nothing gone.
  assert.equal(r.state.fileByPath(NOTE).fileId, HIGHER);
  assert.ok(r.contents().includes(THEIRS), "the other device's version was not kept beside it");
  assert.deepEqual(r.hidden(), [], "the hold was left in the vault");
});

test("an ordinary native move drops its hold and leaves the copy behind", async (t) => {
  const r = await native(t);
  const frame = await collide(r);
  assert.equal(await applyChange(r.context, frame), "applied");
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), THEIRS, "the incoming version did not take the name");
  assert.ok(r.contents().includes(MINE), "this device's own note was not moved aside");
  assert.deepEqual(r.trashed.map((entry) => entry.path), [NOTE]);
  assert.equal(r.trashed[0].bytes, MINE, "the removal took bytes other than the ones it copied");
  assert.deepEqual(r.hidden(), [], "a hold was left behind by a move that completed");
});

test("a native settled write records the metadata of the bytes it committed", async (t) => {
  let armed = false;
  let injected = false;
  let copy;
  const r = await native(t, {
    afterRename: async (root, from, to) => {
      // An ordinary in-place editor save: it keeps the INODE, so the writer's
      // identity proof still holds while the bytes under it are someone
      // else's. The window is inside the host's own commit.
      if (!armed || injected || to !== join(root, copy)) return;
      injected = true;
      writeFileSync(to, EDIT);
      utimesSync(to, 9.999, 9.999);
    },
  });
  const settled = await settle(r);
  copy = settled.copy;
  armed = true;
  const second = await descend(r, settled.first.version_id, "SECOND\n", 5000);
  assert.equal(await applyChange(r.context, second), "applied");
  assert.ok(injected, "the test never entered the writer's commit");
  assert.equal(readFileSync(join(r.root, copy), "utf8"), EDIT);
  const recorded = r.state.fileByPath(copy);
  assert.notEqual(recorded.mtime, 9999, `the save's metadata was recorded as the version's: ${JSON.stringify(recorded)}`);
  assert.ok(
    r.logs.some((line) => line.includes("decision=write_superseded")),
    `no superseded write in the log: ${JSON.stringify(r.logs)}`,
  );
  // And the record's whole point: the NEXT version of that id finds a file
  // that does not match what this device wrote, so it copies beside rather
  // than replacing bytes no version holds.
  const third = await descend(r, second.version_id, "THIRD\n", 6000);
  const result = await applyChange(r.context, third);
  assert.ok(
    r.contents().includes(EDIT),
    `edit absent from live vault; result=${result}; recorded=${JSON.stringify(recorded)}; live=${JSON.stringify(r.contents())}`,
  );
});

test("control: a native settled copy protects a save made after commit returns", async (t) => {
  const r = await native(t);
  const settled = await settle(r);
  const make = r.host.writer.bind(r.host);
  let injected = false;
  r.host.writer = async (path) => {
    const writer = await make(path);
    return {
      ...writer,
      commit: async (mtime) => {
        const stat = await writer.commit(mtime);
        // The window round 2 covers: the save lands after the commit has
        // answered, so the answer is right and the RECORD is what protects
        // the file.
        if (path === settled.copy && !injected) {
          injected = true;
          r.seed(settled.copy, EDIT, 9999);
        }
        return stat;
      },
    };
  };
  const second = await descend(r, settled.first.version_id, "SECOND\n", 5000);
  assert.equal(await applyChange(r.context, second), "applied");
  const third = await descend(r, second.version_id, "THIRD\n", 6000);
  assert.equal(await applyChange(r.context, third), "conflict_copy");
  assert.ok(injected);
  assert.ok(r.contents().includes(EDIT));
});
