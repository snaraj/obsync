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
 * the regression attached to receipt 5771502579 on PR #120, and the coverage
 * their response (5771836148) asked for: the paths where the host CANNOT
 * hold the file -- a phone, and a filesystem that refuses a second name --
 * and a save that replaces the source inode instead of writing into it.
 * Every removal here is permanent: the vault's "Deleted files" preference is
 * set to delete, so nothing is recoverable from a bin afterwards.
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
async function native(t, hooks = {}, { mobile = false } = {}) {
  const r = await rig({ isMobile: mobile });
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
    link: async (from, to) => {
      // The seam for a filesystem that cannot give a second name: the hold
      // is the only link this path makes for a name of its own.
      if (hooks.link) await hooks.link(from, to);
      await fsPromises.link(from, to);
      if (hooks.afterLink) await hooks.afterLink(root, from, to);
    },
    rename: async (...args) => {
      await fsPromises.rename(...args);
      if (hooks.afterRename) await hooks.afterRename(root, ...args);
    },
  };
  /** Obsidian's mobile surface: no filesystem, one adapter, one create. */
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
    remove: (path) => fsPromises.unlink(join(root, path)),
  };
  const vault = {
    getFileByPath: (path) => (existsSync(join(root, path)) ? { path } : null),
    adapter,
    createBinary: async (path, data, options) => {
      writeFileSync(join(root, path), new Uint8Array(data), { flag: "wx" });
      if (options?.mtime) utimesSync(join(root, path), options.mtime / 1000, options.mtime / 1000);
      const found = statSync(join(root, path));
      return { path, stat: { mtime: Math.round(found.mtimeMs), size: found.size } };
    },
  };
  const plugin = {
    state: r.state,
    log: (line) => logs.push(line),
    app: {
      vault,
      fileManager: {
        // The vault's own trash, with the user's "Deleted files" preference
        // set to PERMANENT: no bin, no restore, the name and its inode gone
        // unless something else is holding it.
        trashFile: async (file) => {
          if (hooks.beforeTrash) await hooks.beforeTrash(root, file.path);
          trashed.push({ path: file.path, bytes: readFileSync(join(root, file.path), "utf8") });
          await fsPromises.unlink(join(root, file.path));
        },
      },
    },
    manifest: { version: "1.0.7" },
    platformName: () => (mobile ? "ios" : "linux"),
    deviceName: () => "sentinel-device",
  };
  const host = new ObsidianHost(plugin, mobile ? null : { base: root, path: nodePath, fs: { promises } });
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
  assert.ok(
    r.logs.some((line) => line.includes("host path_class=file decision=kept reason=restored")),
    `the host did not report the restore: ${JSON.stringify(r.logs)}`,
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

/**
 * A PHONE, where there is no second name to give (round 3, finding 1, as
 * re-opened by receipt 5771836148).
 *
 * The mobile host reaches the vault through Obsidian's adapter and has no
 * `link`: nothing it can do keeps the file reachable across the vault's own
 * trash, so it cannot put back a save that lands inside one. It therefore
 * removes NOTHING. The save below is injected at the boundary the desktop
 * path protects, and the assertion is that the boundary is never reached:
 * the note keeps its name and its text, and the pair is kept as 1.0.6 kept
 * it.
 */
test("a mobile host removes nothing, and the note survives the window", async (t) => {
  let entered = false;
  const r = await native(
    t,
    {
      beforeTrash: async (root, path) => {
        entered = true;
        writeFileSync(join(root, path), EDIT);
        utimesSync(join(root, path), 9.999, 9.999);
      },
    },
    { mobile: true },
  );
  const frame = await collide(r);

  assert.equal(await applyChange(r.context, frame), "conflict_copy");

  assert.equal(entered, false, "a device that cannot bind a removal entered the removal anyway");
  assert.deepEqual(r.trashed, [], "a phone removed a note it could not put back");
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), MINE, "the note did not keep its own name");
  assert.ok(r.contents().includes(THEIRS), "the other device's version was not kept beside it");
  assert.ok(
    r.logs.some((line) => line.includes("decision=move_aside_refused reason=unheld")),
    `no unheld refusal in the log: ${JSON.stringify(r.logs)}`,
  );
  assert.deepEqual(r.hidden(), [], "a hold was left in the vault");
});

/**
 * A DESKTOP FILESYSTEM THAT REFUSES THE SECOND NAME. exFAT, some network
 * mounts and some container filesystems answer `link` with EPERM or EXDEV,
 * and an adapter can simply not have it. The host cannot tell in advance --
 * it asks -- and a refusal there is the same answer as a phone's: nothing is
 * removed, and the save that would have landed inside the removal is still
 * in the vault under its own name.
 */
for (const refusal of ["EPERM", "EXDEV", "unsupported"]) {
  test(`a hold refused with ${refusal} removes nothing, and the note survives the window`, async (t) => {
    let entered = false;
    const r = await native(t, {
      link: async (from, to) => {
        // Only the HOLD is refused: the conflict copy's own publication is a
        // link too, and a filesystem that refused that would refuse the copy
        // rather than the removal.
        if (!to.includes(".obsync-hold-")) return;
        if (refusal === "unsupported") throw new TypeError("fs.promises.link is not a function");
        const error = new Error(`link ${refusal}`);
        error.code = refusal;
        throw error;
      },
      beforeTrash: async (root, path) => {
        entered = true;
        writeFileSync(join(root, path), EDIT);
        utimesSync(join(root, path), 9.999, 9.999);
      },
    });
    const frame = await collide(r);

    assert.equal(await applyChange(r.context, frame), "conflict_copy");

    assert.equal(entered, false, "the removal ran without a hold behind it");
    assert.deepEqual(r.trashed, [], "a note was removed with no way to put it back");
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), MINE);
    assert.ok(r.contents().includes(THEIRS), "the other device's version was not kept beside it");
    assert.ok(
      r.logs.some((line) => line.includes("host path_class=file decision=kept reason=unheld")),
      `the host did not report the unheld removal: ${JSON.stringify(r.logs)}`,
    );
    assert.deepEqual(r.hidden(), [], "a hold was left in the vault");
  });
}

/**
 * A SAVE THAT REPLACES THE FILE rather than writing into it.
 *
 * Editors save either way. An in-place save keeps the inode, and the hold
 * sees it (above). A write-temp-then-rename save leaves a DIFFERENT file at
 * the name, whose bytes the hold does not have and no version holds either:
 * preserving "the held inode" would be preserving the wrong thing, and the
 * removal would take a note that exists nowhere else. So the name is
 * re-identified against the hold immediately before the removal -- same
 * device, same inode -- and a replacement keeps everything where it is.
 */
test("a save that replaces the source between the hold and the removal is preserved", async (t) => {
  let replaced = false;
  const r = await native(t, {
    afterLink: async (root, from, to) => {
      if (!to.includes(".obsync-hold-") || replaced) return;
      replaced = true;
      // The editor's own save: a temp file, then a rename over the note.
      const temp = join(root, "Notes", ".editor-save.tmp");
      writeFileSync(temp, EDIT);
      utimesSync(temp, 9.999, 9.999);
      renameSync(temp, join(root, NOTE));
    },
  });
  const frame = await collide(r);

  const result = await applyChange(r.context, frame);

  assert.ok(replaced, "the test never reached the window it exists for");
  assert.equal(
    readFileSync(join(r.root, NOTE), "utf8"),
    EDIT,
    `the replacing save was removed; result=${result}; live=${JSON.stringify(r.contents())}`,
  );
  assert.deepEqual(r.trashed, [], "the removal took a file the hold did not have");
  assert.ok(
    r.logs.some((line) => line.includes("host path_class=file decision=kept reason=source_replaced")),
    `the host did not report the replacement: ${JSON.stringify(r.logs)}`,
  );
  assert.ok(r.contents().includes(THEIRS), "the other device's version was not kept beside it");
  assert.deepEqual(r.hidden(), [], "the hold was left in the vault");
});
