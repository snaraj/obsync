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
 * Every removal here is permanent unless a test says otherwise: the vault's
 * "Deleted files" preference is set to delete, so nothing is recoverable from
 * a bin afterwards. The issue #138 tests set the other two.
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
async function native(t, hooks = {}, { mobile = false, trashOption = "none" } = {}) {
  const r = await rig({ isMobile: mobile });
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-native-"));
  // The system bin is outside the vault, as the operating system's is.
  const systemBin = mkdtempSync(join(tmpdir(), "obsync-system-bin-"));
  mkdirSync(join(root, "Notes"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(systemBin, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const logs = [];
  const trashed = [];
  /**
   * Every destructive call lands here, whichever primitive made it: the
   * vault's `trashFile`, or the adapter's `remove`, `trashSystem` and
   * `trashLocal`. A bin keeps the file under its own name and nothing else,
   * flat, as Obsidian's `.trash` and the system bin both do.
   */
  const bin = async (path, where) => {
    if (hooks.beforeTrash) await hooks.beforeTrash(root, path);
    trashed.push({ path, bytes: readFileSync(join(root, path), "utf8"), bin: where });
    if (where === "none") return fsPromises.unlink(join(root, path));
    const into = where === "system" ? systemBin : join(root, ".trash");
    mkdirSync(into, { recursive: true });
    await fsPromises.rename(join(root, path), join(into, path.slice(path.lastIndexOf("/") + 1)));
  };
  const promises = {
    ...fsPromises,
    unlink: async (path) => {
      if (hooks.beforeUnlink) await hooks.beforeUnlink(root, path);
      return fsPromises.unlink(path);
    },
    link: async (from, to) => {
      // The seam for a filesystem that cannot give a second name: the hold
      // is the only link this path makes for a name of its own.
      if (hooks.link) await hooks.link(from, to);
      await fsPromises.link(from, to);
      if (hooks.afterLink) await hooks.afterLink(root, from, to);
    },
    rename: async (from, to) => {
      // Before the rename lands is the only window left in which a save can
      // reach the file the removal is about; the hooks open it on purpose.
      if (hooks.beforeRename) await hooks.beforeRename(root, from, to);
      await fsPromises.rename(from, to);
      if (hooks.afterRename) await hooks.afterRename(root, from, to);
    },
  };
  /** Obsidian's mobile surface: no filesystem, one adapter, one create. */
  const adapter = {
    // `sensitive` is the adapter's own case-SENSITIVE existence check
    // (Obsidian 1.7.2), and the only thing a phone can ask to tell one entry
    // wearing another spelling from a second file wearing that exact name.
    exists: async (path, sensitive) => {
      if (sensitive !== true) return existsSync(join(root, path));
      const at = path.lastIndexOf("/");
      const folder = at === -1 ? "" : path.slice(0, at);
      if (!existsSync(join(root, folder))) return false;
      return readdirSync(join(root, folder)).includes(path.slice(at + 1));
    },
    rename: async (from, to) => fsPromises.rename(join(root, from), join(root, to)),
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
    // The adapter's three removals. The system bin can be refused -- it is
    // absent or disabled on some hosts -- and says so with `false`, or here
    // also with a throw.
    remove: (path) => bin(path, "none"),
    trashLocal: (path) => bin(path, "local"),
    trashSystem: async (path) => {
      if (hooks.systemBin === "false") return false;
      if (hooks.systemBin === "throws") throw new Error("system bin unavailable");
      await bin(path, "system");
      return true;
    },
    // The adapter's own directory listing, which is how a PHONE asks what a
    // vault really spells a name (`ObsidianHost.spelling`): one level, with
    // vault-relative paths, exactly as Obsidian answers it. Absent here, this
    // fake modelled a mobile adapter that does not exist and the host's
    // mobile branch went untested under it.
    list: async (path) => {
      const at = path === "/" ? root : join(root, path);
      const out = { files: [], folders: [] };
      for (const name of readdirSync(at)) {
        const child = path === "/" ? name : `${path}/${name}`;
        (statSync(join(root, child)).isDirectory() ? out.folders : out.files).push(child);
      }
      return out;
    },
  };
  const vault = {
    // Obsidian indexes no name with a dot-named component (checked on a real
    // 1.13.4: a file at `Phone/.obsync-gone-probe.tmp` exists on disk and
    // `getFileByPath` answers `null`). A fake that indexed them hid issue
    // #138: every bound removal reached the vault by a hidden name.
    getFileByPath: (path) =>
      path.split("/").some((part) => part.startsWith(".")) || !existsSync(join(root, path)) ? null : { path },
    // The "Deleted files" preference: "unset" answers `undefined`, as a vault
    // whose preference was never changed may; "absent" models an Obsidian
    // that no longer offers this lookup at all.
    ...(trashOption === "absent"
      ? {}
      : { getConfig: (key) => (key === "trashOption" && trashOption !== "unset" ? trashOption : undefined) }),
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
        // The vault's own trash, after the user's "Deleted files" preference:
        // by default here PERMANENT -- no bin, no restore, the name and its
        // inode gone unless something else is holding it.
        trashFile: async (file) => {
          if (trashOption === "none") return adapter.remove(file.path);
          if (trashOption === "local" || !(await adapter.trashSystem(file.path))) await adapter.trashLocal(file.path);
        },
      },
      // No editor is open on anything here (issue #146).
      workspace: { getLeavesOfType: () => [] },
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
  const openEditor = (path, text) => {
    const { MarkdownView } = box.require("obsidian");
    const view = new MarkdownView();
    view.file = { path };
    view.getViewData = () => text.value;
    vault.read = async (file) => readFileSync(join(root, file.path), "utf8");
    plugin.app.workspace.getLeavesOfType = () => [{ view }];
    return view;
  };
  const applyIncoming = (change) => box.require(join(box.home, "build/sync/pull.js")).applyChange(r.context, change);
  return { ...r, root, systemBin, host, seed, contents, hidden, logs, trashed, notices, openEditor, applyIncoming };
}

for (const mobile of [false, true]) {
  for (const fork of [false, true]) {
    for (const late of [false, true]) {
      test(`incoming ${fork ? "merge" : "fast-forward"} waits for unsaved native editor text (${mobile ? "mobile" : "desktop"}, ${late ? "during download" : "before download"})`, async (t) => {
        const r = await native(t, {}, { mobile });
        const baseText = "Shared: START|";
        r.seed(NOTE, baseText, 1000);
        const base = await pushFile(r.context, NOTE);
        if (fork) {
          r.seed(NOTE, baseText + "A", 2000);
          await pushFile(r.context, NOTE);
        }
        const disk = readFileSync(join(r.root, NOTE), "utf8");
        const buffered = { value: disk + (late ? "" : "B") };
        r.openEditor(NOTE, buffered);
        if (late) {
          const writer = r.host.writer.bind(r.host);
          r.host.writer = async (path) => {
            const pending = await writer(path);
            return { ...pending, write: async (bytes) => {
              await pending.write(bytes);
              if (path === NOTE) buffered.value = disk + "B";
            } };
          };
        }
        const before = structuredClone(r.state.fileByPath(NOTE));
        const incoming = await r.server.publish({
          fileId: base.fileId, path: NOTE, bytes: enc(baseText + "a"), mtime: 3000,
          parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
        });
        assert.equal(await r.host.editing(NOTE), late ? "saved" : "unsaved");
        await assert.rejects(r.applyIncoming(incoming), { name: "Unwritable", reason: "active_editor" });
        assert.equal(readFileSync(join(r.root, NOTE), "utf8"), disk, "no external write reaches the pending editor");
        assert.equal(buffered.value, disk + "B");
        assert.deepEqual(r.state.fileByPath(NOTE), before, "no incoming receipt describes unwritten text");
        assert.deepEqual(r.hidden(), [], "a deferred write leaves no temp file");
        // The engine persists this per-note refusal before advancing its feed.

        r.seed(NOTE, buffered.value, 4000);
        assert.equal(await r.host.editing(NOTE), "saved");
        await pushFile(r.context, NOTE);
        await r.applyIncoming(incoming);
        const result = readFileSync(join(r.root, NOTE), "utf8");
        assert.ok(result.includes("B") && result.includes("a"), "both the saved keystroke and peer text survive");
        if (fork) assert.ok(result.includes("A"));
        assert.equal(r.server.files.get(base.fileId).heads.length, 1, "the later save converges the fork");
        assert.deepEqual(r.hidden(), []);
      });
    }
  }
}

for (const mobile of [false, true]) {
  test(`a saved native editor with recent input defers until that input settles (${mobile ? "mobile" : "desktop"})`, async (t) => {
    const r = await native(t, {}, { mobile });
    r.seed(NOTE, "Shared: START|", 1000);
    const base = await pushFile(r.context, NOTE);
    const buffered = { value: "Shared: START|" };
    const view = r.openEditor(NOTE, buffered);
    r.host.inputAt.set(view, { path: NOTE, at: Date.now() });
    const incoming = await r.server.publish({
      fileId: base.fileId, path: NOTE, bytes: enc("Shared: START|a"), mtime: 3000,
      parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
    assert.equal(await r.host.editing(NOTE), "saved");
    assert.equal(r.host.typing(NOTE), true);
    await assert.rejects(r.applyIncoming(incoming), { name: "Unwritable", reason: "active_editor" });
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), buffered.value);
    assert.deepEqual(r.hidden(), []);
    r.host.inputAt.delete(view);
    assert.equal(await r.applyIncoming(incoming), "applied");
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), "Shared: START|a");
    assert.deepEqual(r.hidden(), []);
  });
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
      // INSIDE the destructive call, and into the file it is about: a rename
      // does not close an editor's descriptor, so a program that still holds
      // the note open writes THERE, wherever its name has gone. Nothing this
      // device checked before the call can see it.
      if (injected) return;
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
  assert.equal(r.trashed.length, 1, "the removal happened once");
  assert.equal(r.trashed[0].bytes, MINE, "the removal took bytes other than the ones it copied");
  // AND IT NEVER NAMED A FILE THE USER CAN SEE. The vault is handed the
  // hidden name the note was moved to, so whatever an editor writes at the
  // note's own name afterwards is not what the removal is about.
  assert.ok(
    r.trashed[0].path.startsWith("Notes/.obsync-"),
    `the destructive call named a visible file: ${r.trashed[0].path}`,
  );
  assert.deepEqual(r.hidden(), [], "a hold or a moved file was left behind");
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
 * A FILESYSTEM THAT REFUSES THE MOVE ITSELF. The whole promise rests on one
 * atomic rename: it is what takes the name out of every editor's way before
 * anything is deleted. A host that cannot make that move has no way to aim a
 * removal at anything but the live name, so it is an unheld path like a
 * phone's -- nothing is removed, the hold is dropped, and the caller keeps
 * both notes instead.
 */
test("a move refused with EXDEV removes nothing, and the note survives the window", async (t) => {
  let refused = false;
  let entered = false;
  const r = await native(t, {
    beforeRename: async (root, from, to) => {
      // Only the removal's own move is refused: the writers rename their
      // temporary files too, and a filesystem that refused those would
      // refuse the conflict copy rather than the removal.
      if (!to.includes(".obsync-gone-")) return;
      refused = true;
      const error = new Error("rename EXDEV");
      error.code = "EXDEV";
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

  assert.ok(refused, "the test never reached the move it exists for");
  assert.equal(entered, false, "a removal was aimed at a name that had not moved");
  assert.deepEqual(r.trashed, [], "a note was removed on a host that could not move it");
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), MINE, "the note did not keep its own name");
  assert.ok(r.contents().includes(THEIRS), "the other device's version was not kept beside it");
  assert.ok(
    r.logs.some((line) => line.includes("host path_class=file decision=kept reason=move_refused")),
    `the host did not report the refused move: ${JSON.stringify(r.logs)}`,
  );
  assert.deepEqual(r.hidden(), [], "a hold or a moved file was left behind");
});

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
/**
 * The reviewer's follow-up case, from receipt 5772520551, at the boundary
 * this head leaves. Their body is unchanged except for its guard: it fired
 * only while the destructive call named `Notes/Same.md`, and the repair is
 * that no destructive call ever names it again. The injection is therefore
 * unconditional -- same instant, inside the removal, and aimed at the name
 * the user's editor writes to. It fails at `2b56875`, where the removal
 * still names the note and unlinks the replacement.
 */
test("follow-up: a replacing save inside permanent removal remains in the vault", async (t) => {
  let replaced = false;
  const r = await native(t, {
    beforeTrash: async (root, path) => {
      if (replaced) return;
      replaced = true;
      // This hook runs inside FileManager.trashFile, after removeHeld has
      // completed its final source identity and metadata check.
      const temp = join(root, "Notes", ".editor-save.tmp");
      // The file the removal is about, which is no longer at the note's own
      // name: that name is free, which is the repair.
      const before = statSync(join(root, path));
      writeFileSync(temp, EDIT);
      utimesSync(temp, 9.999, 9.999);
      renameSync(temp, join(root, NOTE));
      const after = statSync(join(root, NOTE));
      assert.notEqual(after.ino, before.ino, "the save must replace the inode");
      assert.notEqual(after.size, before.size);
      assert.notEqual(after.mtimeMs, before.mtimeMs);
    },
  });
  const frame = await collide(r);
  const result = await applyChange(r.context, frame);
  assert.ok(replaced, "the test never entered the removal boundary");
  assert.ok(
    r.contents().includes(EDIT),
    `replacing save absent; result=${result}; permanently_removed=${JSON.stringify(r.trashed)}; live=${JSON.stringify(r.contents())}; hidden=${JSON.stringify(r.hidden())}; logs=${JSON.stringify(r.logs)}`,
  );
});

/**
 * The window the repair leaves in front of the move: a save that REPLACES
 * the note after it was copied and before the rename takes it away. The
 * rename then moves the replacement, whose bytes no version holds, and the
 * proof afterwards is what notices: it goes back under its own name and the
 * move is refused.
 */
test("a replacement that lands before the move is put back, not removed", async (t) => {
  let replaced = false;
  const r = await native(t, {
    beforeRename: async (root, from) => {
      if (replaced || !from.endsWith(NOTE.slice(NOTE.lastIndexOf("/") + 1))) return;
      replaced = true;
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
    `the replacement was not put back; result=${result}; live=${JSON.stringify(r.contents())}`,
  );
  assert.deepEqual(r.trashed, [], "a file the hold did not have was removed");
  assert.ok(
    r.logs.some((line) => line.includes("host path_class=file decision=kept reason=source_replaced")),
    `the host did not report the replacement: ${JSON.stringify(r.logs)}`,
  );
  assert.ok(r.contents().includes(THEIRS), "the other device's version was not kept beside it");
  assert.deepEqual(r.hidden(), [], "a hold or a moved file was left behind");
});

/**
 * And the same window for an IN-PLACE save, which keeps the inode: the
 * rename carries that inode away with the new bytes in it, and the proof
 * afterwards compares metadata, not only identity.
 */
test("an in-place save before the move is put back, not removed", async (t) => {
  let edited = false;
  const r = await native(t, {
    beforeRename: async (root, from) => {
      if (edited || !from.endsWith(NOTE.slice(NOTE.lastIndexOf("/") + 1))) return;
      edited = true;
      writeFileSync(join(root, NOTE), EDIT);
      utimesSync(join(root, NOTE), 9.999, 9.999);
    },
  });
  const frame = await collide(r);

  const result = await applyChange(r.context, frame);

  assert.ok(edited, "the test never reached the window it exists for");
  assert.equal(
    readFileSync(join(r.root, NOTE), "utf8"),
    EDIT,
    `the edit was not put back; result=${result}; live=${JSON.stringify(r.contents())}`,
  );
  assert.deepEqual(r.trashed, [], "a file that no longer held the copied bytes was removed");
  assert.ok(
    r.logs.some((line) => line.includes("host path_class=file decision=kept reason=source_changed")),
    `the host did not report the edit: ${JSON.stringify(r.logs)}`,
  );
  assert.deepEqual(r.hidden(), [], "a hold or a moved file was left behind");
});

/**
 * AND THE CASE UNDER THAT ONE: a restore that cannot land anywhere.
 *
 * The reviewer's blocked-restore case is answered by giving the restore more
 * than one name to try, so it lands. This one takes the names away
 * altogether -- every restoring `link` is refused -- and asks the question
 * the repair is really about: the hold is the LAST name of bytes no version
 * holds, so it is released only when those bytes are somewhere else. Here
 * they are nowhere else, so the hidden name stays, and the answer is `kept`.
 */
test("a restore that lands nowhere keeps the hold rather than releasing it", async (t) => {
  let edited = false;
  const r = await native(t, {
    link: async (from) => {
      // Only the restores are refused: the hold itself, and the conflict
      // copy's own publication, are links too, and a filesystem that refused
      // those would refuse the copy rather than the restore.
      if (!from.includes(".obsync-hold-") && !from.includes(".obsync-gone-")) return;
      const error = new Error("link EPERM");
      error.code = "EPERM";
      throw error;
    },
    beforeTrash: async (root, path) => {
      if (edited) return;
      edited = true;
      writeFileSync(join(root, path), EDIT);
      utimesSync(join(root, path), 9.999, 9.999);
    },
  });
  const frame = await collide(r);

  const result = await applyChange(r.context, frame);

  assert.ok(edited, "the held-inode save was never made");
  assert.ok(
    r.trashed.every((entry) => entry.path.includes(".obsync-gone-")),
    `a deletion was aimed at a live name: ${JSON.stringify(r.trashed)}`,
  );
  const held = r.hidden().map((name) => readFileSync(join(r.root, "Notes", name), "utf8"));
  assert.ok(
    held.includes(EDIT),
    `the only copy of the edit was released; result=${result}; hidden=${JSON.stringify(held)}; ` +
      `live=${JSON.stringify(r.contents())}; logs=${JSON.stringify(r.logs)}`,
  );
  assert.ok(
    r.logs.some((line) => line.includes("decision=kept reason=held")),
    `the host did not report that it is still holding those bytes: ${JSON.stringify(r.logs)}`,
  );
});

/**
 * THE REVIEWER'S OWN INPUT CASES for round 5's findings 1 and 2 (PR #120,
 * comment 5778412397), carried verbatim under the header they were given:
 * a save that takes the restore destination between the look and the write,
 * a restore blocked at every name it has, and a save an editor makes through
 * its own descriptor after this device's last look at the hold. The only
 * fixture seam they add is a hook immediately before the real unlink.
 */
test("review: restoring a changed moved file does not overwrite a later save", async (t) => {
  const LATER = "LATER SAVE WHILE RESTORING SENTINEL, EXISTS NOWHERE ELSE\n";
  let firstEdit = false, laterEdit = false;
  const r = await native(t, {
    beforeRename: async (root, from, to) => {
      if (from === join(root, NOTE) && to.includes(".obsync-gone-") && !firstEdit) {
        firstEdit = true;
        writeFileSync(join(root, NOTE), EDIT);
        utimesSync(join(root, NOTE), 9.999, 9.999);
      }
    },
    // ONE EDIT, and it is the repair's own doing: the put-back is no longer
    // a rename, so the second window moved with it. The restore is a `link`
    // now, and this hook fires in the same place the reviewer's did -- after
    // the caller decided on this destination, before the call that takes it.
    link: async (from, to) => {
      if (!from.includes(".obsync-gone-") || !to.endsWith(NOTE) || laterEdit) return;
      laterEdit = true;
      writeFileSync(to, LATER, { flag: "wx" });
      utimesSync(to, 12.345, 12.345);
    },
  });
  const frame = await collide(r);
  const result = await applyChange(r.context, frame);
  assert.ok(firstEdit && laterEdit, "both save windows must have been exercised");
  assert.ok(r.contents().includes(EDIT), "the first edit must survive its restore");
  assert.ok(r.contents().includes(LATER),
    `restore overwrote later save; result=${result}; live=${JSON.stringify(r.contents())}; hidden=${JSON.stringify(r.hidden())}; logs=${JSON.stringify(r.logs)}`);
});

test("review: a blocked restore retains the only hold containing the later edit", async (t) => {
  let edited = false;
  const r = await native(t, {
    beforeTrash: async (root, path) => {
      if (edited) return;
      edited = true;
      // An in-place write reaches the held inode after it moved.
      writeFileSync(join(root, path), EDIT);
      utimesSync(join(root, path), 9.999, 9.999);
      writeFileSync(join(root, NOTE), "NEW OCCUPANT SENTINEL\n", { flag: "wx" });
      writeFileSync(join(root, "Notes/Same (obsync kept).md"), "EXISTING KEPT SENTINEL\n", { flag: "wx" });
    },
  });
  const frame = await collide(r);
  const result = await applyChange(r.context, frame);
  assert.ok(edited, "the held-inode save must have been injected");
  const allFiles = readdirSync(join(r.root, "Notes")).map(name => ({ name, text: readFileSync(join(r.root, "Notes", name), "utf8") }));
  assert.ok(allFiles.some(file => file.text === EDIT),
    `last hold discarded after restore failure; result=${result}; files=${JSON.stringify(allFiles)}; logs=${JSON.stringify(r.logs)}`);
});


test("review: a descriptor save after the final hold stat remains reachable", async (t) => {
  let handle, edited = false;
  const r = await native(t, {
    beforeUnlink: async (root, path) => {
      if (!path.includes(".obsync-hold-") || edited) return;
      edited = true;
      // removeHeld has already accepted its final hold stat. The editor
      // still owns its original descriptor and saves before drop unlinks.
      await handle.write(EDIT, 0, "utf8");
      await handle.truncate(new TextEncoder().encode(EDIT).length);
      await handle.utimes(9.999, 9.999);
    },
  });
  const frame = await collide(r);
  handle = await fsPromises.open(join(r.root, NOTE), "r+");
  let result;
  try { result = await applyChange(r.context, frame); }
  finally { await handle.close(); }
  assert.ok(edited, "the save must occur before the final hold is removed");
  const allFiles = readdirSync(join(r.root, "Notes")).map(name => ({ name, text: readFileSync(join(r.root, "Notes", name), "utf8") }));
  assert.ok(allFiles.some(file => file.text === EDIT),
    `descriptor save lost after final check; result=${result}; files=${JSON.stringify(allFiles)}; logs=${JSON.stringify(r.logs)}`);
});

// --- where a bound removal goes (issue #138) ------------------------------

/**
 * A NOTE ANOTHER DEVICE DELETED GOES WHERE "DELETED FILES" SAYS, under its
 * own name. The bound removal moves the note to a hidden name before anything
 * is deleted, and Obsidian indexes no hidden name, so the call that honours
 * the preference -- `FileManager.trashFile` -- is never reachable by that
 * name. Through 1.1.2 the host fell to the adapter's permanent `remove`
 * instead: every remote deletion on a desktop was permanent, whatever the
 * setting said (the 2026-09-24 battery, S10). A sibling note keeps `Notes`
 * from being pruned, so what is left in it afterwards can be read.
 */
async function deleteRemotely(r) {
  r.seed("Notes/Keep.md", "SIBLING SENTINEL\n", 1000);
  r.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  const live = r.state.fileByPath(NOTE);
  const tombstone = await r.server.publishTombstone({
    fileId: live.fileId,
    path: NOTE,
    manifestKey: r.keys.manifestKey,
    parents: [live.versionId],
  });
  return await applyChange(r.context, tombstone);
}

/** The note's text in each place a removal can put it, by its own name. */
function whereItWent(r) {
  const at = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  return { vault: at(join(r.root, NOTE)), local: at(join(r.root, ".trash", "Same.md")), system: at(join(r.systemBin, "Same.md")) };
}

for (const [trashOption, bin] of [["local", "local"], ["system", "system"], ["unset", "system"], ["absent", "system"], ["none", "none"]]) {
  const named = trashOption === "unset" ? "never set" : trashOption === "absent" ? "unreadable" : `"${trashOption}"`;
  test(`a note deleted on another device goes where "Deleted files" says: ${named}`, async (t) => {
    const r = await native(t, {}, { trashOption });

    assert.equal(await deleteRemotely(r), "deleted");

    assert.deepEqual(
      whereItWent(r),
      { vault: null, local: bin === "local" ? MINE : null, system: bin === "system" ? MINE : null },
      `trashed=${JSON.stringify(r.trashed)}; logs=${JSON.stringify(r.logs)}`,
    );
    assert.deepEqual(r.trashed.map((entry) => entry.bin), [bin], "the removal was not made once, into that bin");
    assert.ok(
      r.logs.includes(`host path_class=file decision=trashed bin=${bin}`),
      `the host did not say where the note went: ${JSON.stringify(r.logs)}`,
    );
    assert.deepEqual(r.hidden(), [], "a hold or the removal's hidden folder was left behind");
  });
}

/**
 * A SYSTEM BIN THAT REFUSES. Some hosts have none, or have it disabled; the
 * adapter answers `false`. Obsidian's own trash then falls back to the vault's
 * `.trash`, and so does this: a refusal is never read as leave to delete.
 */
for (const refusal of ["false", "throws"]) {
  test(`a system bin that refuses (${refusal}) sends the note to the vault's .trash instead`, async (t) => {
    const r = await native(t, { systemBin: refusal }, { trashOption: "system" });

    assert.equal(await deleteRemotely(r), "deleted");

    assert.deepEqual(whereItWent(r), { vault: null, local: MINE, system: null }, JSON.stringify(r.logs));
    assert.deepEqual(r.trashed.map((entry) => entry.bin), ["local"]);
    assert.ok(
      r.logs.includes("host path_class=file decision=trashed bin=local reason=system_refused"),
      `the fallback was not reported: ${JSON.stringify(r.logs)}`,
    );
    assert.deepEqual(r.hidden(), [], "a hold or the removal's hidden folder was left behind");
  });
}

/**
 * The hidden folder is removed only while it is empty. Anything else that
 * lands in it during the removal stays where it is, and the log says so.
 */
test("a hidden folder something else wrote into is kept, and reported", async (t) => {
  const r = await native(
    t,
    { beforeTrash: async (root, path) => writeFileSync(join(root, nodePath.dirname(path), "stray"), "STRAY SENTINEL\n") },
    { trashOption: "local" },
  );

  assert.equal(await deleteRemotely(r), "deleted");

  assert.equal(whereItWent(r).local, MINE);
  const left = r.hidden().filter((name) => name.startsWith(".obsync-gone-"));
  assert.equal(left.length, 1, `the folder was not kept: ${JSON.stringify(r.hidden())}`);
  assert.equal(readFileSync(join(r.root, "Notes", left[0], "stray"), "utf8"), "STRAY SENTINEL\n");
  assert.ok(
    r.logs.includes("host path_class=folder decision=kept reason=rmdir_refused"),
    `the kept folder was not reported: ${JSON.stringify(r.logs)}`,
  );
});

/**
 * THE HIDDEN FOLDER IS PART OF THE CHAIN. It is a directory this removal
 * made, and the vault's deletion is aimed through it, so it is proved the
 * way every directory above it is: a link put in its place -- here, before
 * the move goes through it -- refuses the removal, and nothing is handed to
 * the vault's deletion by a name that leads out of the vault.
 */
test("a hidden folder swapped for a link refuses the removal", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "obsync-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  let swapped = false;
  const r = await native(
    t,
    {
      beforeRename: async (root, from, to) => {
        const folder = nodePath.dirname(to);
        if (swapped || !nodePath.basename(folder).startsWith(".obsync-gone-")) return;
        swapped = true;
        rmSync(folder, { recursive: true });
        symlinkSync(outside, folder);
      },
    },
    { trashOption: "local" },
  );
  r.seed(NOTE, MINE, 2000);
  const stat = statSync(join(r.root, NOTE));

  await assert.rejects(
    r.host.trash(NOTE, { path: NOTE, mtime: Math.round(stat.mtimeMs), size: stat.size }),
    (error) => error.refusal === "symlink_component",
  );

  assert.ok(swapped, "the test never reached the move it exists for");
  assert.deepEqual(r.trashed, [], "the vault's deletion was aimed through a link out of the vault");
  assert.ok(
    r.logs.includes("host path_class=file decision=restore_failed reason=chain"),
    `the refusal was not reported: ${JSON.stringify(r.logs)}`,
  );
  // And the hold still names the note inside the vault.
  const held = r.hidden().filter((name) => name.startsWith(".obsync-hold-"));
  assert.deepEqual(held.map((name) => readFileSync(join(r.root, "Notes", name), "utf8")), [MINE]);
});

// --- the case-only rename on the real host (issue #124) -----------------

/**
 * WHAT THIS PROVES THAT THE FAKE CANNOT. `caseSensitive` in `fake.mjs` is a
 * model of a filesystem; these run on the one under the test process. On
 * macOS that is a folding volume and `Case.md` and `case.md` are one entry;
 * on the Linux runners they are two. Both are covered by the same
 * assertions, because the guarantee is the same on both: after the rename
 * the directory holds the new spelling, holds no other, and the file that
 * arrives there is the one that left -- by inode, which is the fact a fake
 * vault has none of.
 */
const CASED = "Notes/Case.md";
const LOWER_CASED = "Notes/case.md";

for (const mobile of [false, true]) {
  const platform = mobile ? "a phone" : "a desktop";

  test(`${platform} renames one entry into another case and keeps the file`, async (t) => {
    const r = await native(t, {}, { mobile });
    r.seed(CASED, MINE, 2000);
    const before = statSync(join(r.root, CASED));

    assert.equal(await r.host.move(CASED, LOWER_CASED), "moved");

    assert.deepEqual(
      readdirSync(join(r.root, "Notes")).filter((name) => !name.startsWith(".")),
      ["case.md"],
      "the directory did not end with exactly the new spelling",
    );
    assert.equal(readFileSync(join(r.root, LOWER_CASED), "utf8"), MINE);
    const after = statSync(join(r.root, LOWER_CASED));
    assert.equal(after.ino, before.ino, "the note was copied and deleted rather than renamed");
  });

  test(`${platform} refuses a rename onto a file that is already there`, async (t) => {
    const r = await native(t, {}, { mobile });
    r.seed(CASED, MINE, 2000);
    r.seed("Notes/Other.md", THEIRS, 2000);

    assert.equal(await r.host.move(CASED, "Notes/Other.md"), "occupied");
    assert.equal(readFileSync(join(r.root, "Notes/Other.md"), "utf8"), THEIRS, "the destination was replaced");
    assert.equal(readFileSync(join(r.root, CASED), "utf8"), MINE, "the source was moved anyway");
    assert.equal(await r.host.move("Notes/Absent.md", "Notes/Arrived.md"), "missing");
  });

  test(`${platform} applies an incoming case-only move as one entry`, async (t) => {
    const r = await native(t, {}, { mobile });
    r.seed(CASED, MINE, 2000);
    await pushFile(r.context, CASED);
    const record = r.state.fileByPath(CASED);
    const change = await r.server.publish({
      fileId: record.fileId,
      path: LOWER_CASED,
      bytes: enc(MINE),
      mtime: 2000,
      parents: [record.versionId],
      domainKey: r.keys.domainKey,
      manifestKey: r.keys.manifestKey,
    });

    assert.equal(await applyChange(r.context, change), "applied");

    assert.deepEqual(
      readdirSync(join(r.root, "Notes")).filter((name) => !name.startsWith(".")),
      ["case.md"],
      `the vault did not end with one entry: ${JSON.stringify(readdirSync(join(r.root, "Notes")))}`,
    );
    assert.equal(readFileSync(join(r.root, LOWER_CASED), "utf8"), MINE, "the note lost its bytes");
    assert.equal(r.state.fileByPath(CASED), undefined, "the old spelling is still recorded");
    assert.equal(r.state.fileByPath(LOWER_CASED).fileId, record.fileId, "the file id did not follow the move");
    assert.deepEqual(r.trashed, [], "a case-only move removed a file");
    assert.ok(
      r.logs.some((line) => line.includes("decision=case_move_moved")),
      `the host did not report the rename: ${JSON.stringify(r.logs)}`,
    );
  });
}
