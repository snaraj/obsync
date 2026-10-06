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
import { diskWatchdog, FakeTimers, rig, sandbox, scratch, until } from "./fake.mjs";

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
async function native(t, hooks = {}, { mobile = false, trashOption = "none", editorTimers } = {}) {
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
    readFile: async (path, ...rest) => {
      if (hooks.readFile) await hooks.readFile(root, path);
      return fsPromises.readFile(path, ...rest);
    },
    rename: async (from, to) => {
      // Before the rename lands is the only window left in which a save can
      // reach the file the removal is about; the hooks open it on purpose.
      if (hooks.beforeRename) await hooks.beforeRename(root, from, to);
      await fsPromises.rename(from, to);
      if (hooks.afterRename) await hooks.afterRename(root, from, to);
    },
    // A disk that answers an open late, or not at all; `opened` sees the real handle.
    open: async (path, flags, mode) => {
      if (hooks.open) await hooks.open(root, path, flags);
      const handle = await fsPromises.open(path, flags, mode);
      if (hooks.opened) hooks.opened(path, flags, handle);
      return handle;
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
      if (hooks.afterWrite) await hooks.afterWrite(root, path);
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
      workspace: { getLeavesOfType: () => [], trigger: () => {} },
    },
    manifest: { version: "1.0.7" },
    platformName: () => (mobile ? "ios" : "linux"),
    deviceName: () => "sentinel-device",
  };
  const host = new ObsidianHost(plugin, mobile ? null : { base: root, path: nodePath, fs: { promises } }, editorTimers);
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
  const leaves = [];
  const baselines = new WeakMap();
  // The public modify notification enters the native reload handler, which
  // updates its saved baseline and combines input typed during the disk write.
  // Real Obsidian end-to-end runs remain the authority for that host behavior.
  vault.trigger = (event, file) => {
    assert.equal(event, "modify");
    for (const { view } of leaves) {
      if (view.file?.path !== file.path) continue;
      const next = readFileSync(join(root, file.path), "utf8").replace(/\r\n?/g, "\n");
      const prior = baselines.get(view), current = view.getViewData();
      baselines.set(view, next);
      if (current === next) continue;
      const combined = require("../build/sync/conflict.js").threeWayMerge(prior, current, next);
      if (!combined.ok) throw Error("synthetic native reload overlap");
      view.setViewData(combined.text, false);
    }
  };
  const openEditor = (path, text) => {
    const { MarkdownView } = box.require("obsidian");
    const view = new MarkdownView();
    view.file = { path };
    view.getViewData = () => text.value;
    baselines.set(view, text.value);
    // What the editor shows becomes what it was given, as Obsidian's does.
    view.setViewData = (data) => { text.value = data; };
    vault.read =async (file) => readFileSync(join(root, file.path), "utf8");
    leaves.push({ view });
    plugin.app.workspace.getLeavesOfType = () => leaves;
    return view;
  };
  const applyIncoming = (change) => box.require(join(box.home, "build/sync/pull.js")).applyChange(r.context, change);
  return { ...r, root, systemBin, host, seed, contents, hidden, logs, trashed, notices, openEditor, applyIncoming, EditorBusy: box.require(join(box.home, "build/sync/pull.js")).EditorBusy };
}

for (const mobile of [false, true]) for (const effect of ["none", "input", "rebind"])
  test(`a confirmed local save refreshes native consumers without another save (${mobile}, ${effect})`, async (t) => {
    const timers = new FakeTimers(), r = await native(t, {}, { mobile, editorTimers: timers });
    r.seed(NOTE, "old", 1000);
    r.seed("Notes/Elsewhere.md", "OTHER", 1000);
    const buffer = { value: "new local text" }, view = r.openEditor(NOTE, buffer);
    const second = effect === "rebind" ? r.openEditor(NOTE, buffer) : null;
    let saves = 0, queued = 0;
    const previews = [];
    view.save = async () => { saves++; writeFileSync(join(r.root, NOTE), buffer.value); };
    r.host.plugin.engine = { editorSaved(path) { assert.equal(path, NOTE); queued++; } };
    r.host.plugin.app.workspace.trigger = (event, file, text) => {
      assert.equal(queued, 1, "publication is queued before reentrant consumers run");
      previews.push({ event, path: file.path, text });
      assert.equal(readFileSync(join(r.root, NOTE), "utf8"), "new local text");
      if (effect === "input") {
        r.host.editorActivity.record(view, "beforeinput");
        buffer.value += " unsaved";
      }
      if (second) second.file = { path: "Notes/Elsewhere.md" };
    };
    t.after(() => r.host.stopEditorSaves());
    r.host.editorActivity.record(view, "beforeinput");
    await timers.run(5, () => queued === 1 && r.host.editorActivity.saving.size === 0);
    r.host.stopEditorSaves();
    assert.deepEqual(previews, [{ event: "quick-preview", path: NOTE, text: "new local text" }]);
    assert.equal(saves, 1);
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), "new local text");
    assert.equal(readFileSync(join(r.root, "Notes/Elsewhere.md"), "utf8"), "OTHER");
    assert.equal(buffer.value, "new local text" + (effect === "input" ? " unsaved" : ""));
  });

/** A public TextFileView save/load model with the adapter's actual ordering.
 * No private native editor fields are touched by the product under test. */
async function queuedEditor(t, afterRename = () => {}) {
  let arrived = () => {};
  const events = [];
  // Disk/queue operations can exceed the 5 ms save interval on any host.
  // Advance saving explicitly so tests own which side of that boundary they
  // exercise, rather than accidentally saving the injected pending input.
  const timers = new FakeTimers();
  const r = await native(t, {
    afterRename: async () => arrived(),
    opened: (path, flags, handle) => {
      if (!path.endsWith(nodePath.sep + nodePath.normalize(NOTE))) return;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        assert.equal(flags, "r+", "final durability needs a writable, nontruncating existing-file handle on Windows too");
        events.push("fsync"); await sync();
      };
    },
  }, { editorTimers: timers });
  const original = "A: local\nB: \n", incoming = "A: local\nB: remote\n";
  r.seed(NOTE, original, 1000);
  const buffer = { value: original }, view = r.openEditor(NOTE, buffer), file = view.file;
  const vault = r.host.plugin.app.vault, adapter = vault.adapter;
  let baseline = original, saving = false, saveAgain = false;
  adapter.promise = Promise.resolve();
  adapter.queue = (action) => (adapter.promise = adapter.promise.then(action, action));
  vault.read = (file) => adapter.queue(async () => readFileSync(join(r.root, file.path), "utf8"));
  view.save = async () => {
    if (saving) { saveAgain = true; return; }
    const text = view.getViewData(), file = view.file;
    if (text === baseline) return;
    saving = true;
    baseline = text;
    events.push("baseline");
    try {
      await adapter.promise;
      await adapter.queue(async () => writeFileSync(join(r.root, file.path), text));
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; await view.save(); }
    }
  };
  const reads = [];
  vault.trigger = (_event, file) => {
    if (saving || file !== view.file) return;
    const loading = vault.read(file).then((text) => {
      const prior = baseline;
      baseline = text;
      if (text === prior || text === buffer.value) return;
      if (buffer.value !== prior) events.push("external_notice");
      const merged = require("../build/sync/conflict.js").threeWayMerge(prior, buffer.value, text);
      assert.equal(merged.ok, true);
      view.setViewData(merged.text, false);
    });
    reads.push(loading);
  };
  r.host.plugin.engine = { editorSaved() {} };
  r.host.editorActivity.record(view, "beforeinput");
  let ready = false;
  timers.now += 5;
  await timers.run(0, () => ready || (void r.host.editorReady(NOTE).then((value) => { ready = value; }), false));
  assert.equal(await r.host.editorReady(NOTE), true, "fixture acquired an actual save/read receipt");
  t.after(() => r.host.stopEditorSaves());
  arrived = () => {
    afterRename({ ...r, buffer, view, adapter, vault });
    // An OS event can be delivered as soon as rename completes. The reload
    // action queues behind any currently owned native adapter action.
    void adapter.queue(async () => { events.push("watcher"); vault.trigger("modify", file); });
  };
  const write = async () => {
    const writer = await r.host.writer(NOTE, enc(incoming).length);
    try { await writer.write(enc(incoming)); return await writer.commit(2000, enc(original)); }
    finally { await writer.abort(); }
  };
  return { ...r, original, incoming, buffer, view, adapter, vault, events, reads, write, timers };
}

for (const concurrent of [false, true]) test(`a queued durable editor write advances the saved baseline before native reload (typing=${concurrent})`, async (t) => {
  const r = await queuedEditor(t, ({ host, buffer, view }) => {
    if (concurrent) {
      host.editorActivity.record(view, "beforeinput");
      buffer.value = "A: local typed\nB: \n";
    }
  });
  const previews = [];
  r.host.plugin.app.workspace.trigger = (event, file, text) => previews.push({ event, file, text });
  await r.write();
  await r.adapter.promise; await Promise.all(r.reads);
  const expected = concurrent ? "A: local typed\nB: remote\n" : r.incoming;
  assert.equal(r.buffer.value, expected);
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), expected);
  assert.deepEqual(previews, [{ event: "quick-preview", file: r.view.file, text: expected }], "live-preview consumers receive the complete current buffer");
  assert.ok(r.events.indexOf("baseline") < r.events.indexOf("watcher"));
  assert.ok(r.events.lastIndexOf("fsync") > r.events.indexOf("baseline"), "the public editor save is flushed too");
  assert.equal(r.events.includes("external_notice"), false);
  assert.ok(!r.logs.some((line) => /editor_left|editor_reload_unconfirmed/.test(line)), r.logs.join(" | "));
  assert.deepEqual(r.hidden(), []);
});

for (const reason of ["input", "disk", "composition"]) test(`a queued writer rechecks ${reason} after waiting for earlier adapter work`, async (t) => {
  const r = await queuedEditor(t);
  const queue = r.adapter.queue;
  let injected = false;
  r.adapter.queue = (action) => queue(async () => {
    if (!injected) {
      injected = true;
      if (reason === "input") { r.host.editorActivity.record(r.view, "beforeinput"); r.buffer.value += "unsaved"; }
      if (reason === "disk") r.seed(NOTE, "different saved bytes", 4000);
      if (reason === "composition") r.host.editorActivity.record(r.view, "compositionstart");
    }
    return action();
  });
  await assert.rejects(r.write(), (error) => error instanceof r.EditorBusy);
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), reason === "disk" ? "different saved bytes" : r.original);
  assert.equal(r.events.includes("baseline"), false);
  assert.deepEqual(r.hidden(), []);
  if (reason === "input") {
    r.timers.now += 5;
    await r.timers.run(0, () => readFileSync(join(r.root, NOTE), "utf8") === r.original + "unsaved");
    assert.equal(r.buffer.value, r.original + "unsaved", "the refused incoming write leaves the later local save intact");
  }
});

test("a view rebound while a write queues never receives the old note's text or save", async (t) => {
  const r = await queuedEditor(t), queue = r.adapter.queue;
  r.adapter.queue = (action) => queue(async () => {
    r.view.file = { path: "Notes/Elsewhere.md" };
    return action();
  });
  await r.write(); await r.adapter.promise;
  assert.equal(r.buffer.value, r.original);
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), r.incoming);
  assert.equal(r.events.includes("baseline"), false);
});

for (const reason of ["composition", "pause"]) test(`a native bridge never saves ${reason} input begun during rename`, async (t) => {
  const r = await queuedEditor(t, ({ host, buffer, view }) => {
    host.editorActivity.record(view, reason === "composition" ? "compositionstart" : "beforeinput");
    buffer.value = "A: local pending\nB: \n";
    if (reason === "pause") { host.stopEditorSaves(); host.plugin.engine = null; }
  });
  await r.write(); await r.adapter.promise; await Promise.all(r.reads);
  assert.equal(r.events.includes("baseline"), false, "only native save owns that unsaved input");
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), r.incoming);
  assert.equal(r.buffer.value, "A: local pending\nB: remote\n");
});

test("a synchronous tab change during display update never saves the former note into the new tab", async (t) => {
  const r = await queuedEditor(t), update = r.view.setViewData;
  r.seed("Notes/Elsewhere.md", "OTHER NOTE", 1000);
  r.view.setViewData = (text, clear) => { update(text, clear); r.view.file = { path: "Notes/Elsewhere.md" }; };
  await r.write(); await r.adapter.promise;
  assert.equal(readFileSync(join(r.root, "Notes/Elsewhere.md"), "utf8"), "OTHER NOTE");
  assert.equal(r.events.includes("baseline"), false);
});

for (const effect of ["rebind", "input", "composition"]) test(`a synchronous preview consumer ${effect} never forces a stale public save`, async (t) => {
  const r = await queuedEditor(t);
  r.seed("Notes/Elsewhere.md", "OTHER NOTE", 1000);
  let delivered = 0;
  let savesAtDelivery = 0;
  r.host.plugin.app.workspace.trigger = (event, file, text) => {
    assert.equal(event, "quick-preview");
    assert.equal(file.path, NOTE);
    assert.equal(text, r.incoming);
    delivered++;
    savesAtDelivery = r.events.filter((event) => event === "baseline").length;
    if (effect === "rebind") r.view.file = { path: "Notes/Elsewhere.md" };
    if (effect === "input") r.buffer.value += "NEW INPUT";
    if (effect === "composition") r.host.editorActivity.record(r.view, "compositionstart");
  };
  await r.write(); await r.adapter.promise; await Promise.all(r.reads);
  assert.equal(delivered, 1);
  assert.equal(savesAtDelivery, 1, "preview follows the completed saved-baseline transition");
  assert.equal(r.events.filter((event) => event === "baseline").length, savesAtDelivery, "no later public save can overwrite reentrant edits or a rebound view");
  assert.equal(readFileSync(join(r.root, "Notes/Elsewhere.md"), "utf8"), "OTHER NOTE");
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), r.incoming);
  if (effect === "input") assert.equal(r.buffer.value, r.incoming + "NEW INPUT");
});

test("a queued writer never bridges bytes replaced after rename with identical metadata", async (t) => {
  const foreign = "A: LOCAL\nB: REMOTE\n";
  const r = await queuedEditor(t, ({ root }) => {
    const target = join(root, NOTE), stat = statSync(target);
    writeFileSync(target, foreign); utimesSync(target, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  });
  assert.equal(foreign.length, r.incoming.length);
  await r.write(); await r.adapter.promise; await Promise.all(r.reads);
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), foreign);
  assert.equal(r.events.includes("baseline"), false, "the public save must not replace foreign bytes");
  assert.ok(r.logs.some((line) => line.includes("editor_left reason=file_changed")));
});

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
          r.host.writer = async (path, size) => {
            const pending = await writer(path, size);
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

// AN EDITOR OBSYNC WROTE UNDER SHOWS WHAT IT WROTE (issue #252).
// A starved file watcher left an open note's editor on the text it showed
// before obsync's write: every later version was held as unsaved, behind
// "syncing 1", and a keystroke would have saved the old text over the new.
// Each view still showing what it showed when the write was judged safe loads
// the written text. `TextFileView.data` follows every keystroke (measured on
// Obsidian 1.13.4), as it does here, so it says nothing of typing: a view that
// differs from its file holds typing, and the version waits for it.
/**
 * `disk` synced and open, idle, in an editor, beside an editor of another
 * note that nothing may load; `during` runs as each write lands. `arrive`
 * publishes and applies the next version.
 */
async function openIdle(t, mobile, disk, during, readingTemp) {
  const act = async () => during?.(r);
  // Every read but the note's own is of the temp obsync is about to rename.
  const readFile = async (root, path) => { if (path !== join(root, NOTE)) await readingTemp?.(r); };
  const r = await native(t, { afterRename: act, afterWrite: act, readFile }, { mobile });
  r.seed(NOTE, disk, 1000);
  const base = await pushFile(r.context, NOTE);
  // An editor keeps one `\n` where its file has `\r\n`.
  r.shown = { value: disk.replace(/\r\n/g, "\n") };
  r.view = r.openEditor(NOTE, r.shown);
  Object.defineProperty(r.view, "data", { get: () => r.shown.value, set: () => {}, configurable: true });
  r.loaded = [];
  r.previews = [];
  r.host.plugin.app.workspace.trigger = (event, file, text) => r.previews.push({ event, file, text });
  r.view.setViewData = (data, clear) => { r.loaded.push([data, clear]); r.shown.value = data; };
  r.seed("Notes/Other.md", "OTHER NOTE SENTINEL\n", 1000);
  const other = r.openEditor("Notes/Other.md", { value: "OTHER NOTE SENTINEL\n" });
  // Recorded, not thrown: a throw inside a load is the refresh's own failure to log.
  r.foreign = [];
  other.setViewData = (data) => r.foreign.push(data);
  let parent = base.versionId;
  r.arrive = async (text, mtime) => {
    const incoming = await r.server.publish({
      fileId: base.fileId, path: NOTE, bytes: enc(text), mtime,
      parents: [parent], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
    parent = r.version = incoming.version_id;
    return r.applyIncoming(incoming);
  };
  return r;
}

for (const mobile of [false, true]) {
  const on = mobile ? "mobile" : "desktop";
  // Compared line endings aside, or every CRLF note open anywhere reads as typed in.
  for (const eol of ["\n", "\r\n"]) {
    test(`an open editor nothing was typed into takes each incoming version, and shows it (${on}, ${eol === "\n" ? "LF" : "CRLF"})`, async (t) => {
      const r = await openIdle(t, mobile, `idle one${eol}idle two${eol}`);
      for (const [n, next] of [`idle one${eol}newer${eol}idle two${eol}`, `idle one${eol}newer${eol}newest${eol}idle two${eol}`].entries()) {
        assert.equal(await r.host.editing(NOTE), "saved");
        await r.arrive(next, 3000 + n);
        assert.equal(readFileSync(join(r.root, NOTE), "utf8"), next);
        // A starved watcher reloads nothing: the editor shows it because obsync loaded it.
        assert.deepEqual(r.loaded, [[next.replace(/\r\n/g, "\n"), false]], `the editor did not load version ${n + 1}`);
        assert.deepEqual(r.previews, [{ event: "quick-preview", file: r.view.file, text: next.replace(/\r\n/g, "\n") }], "passive live-preview consumers receive each confirmed version");
        r.loaded.length = 0;
        r.previews.length = 0;
      }
      assert.equal(r.logs.filter((line) => line === "host path_class=file decision=editor_refreshed views=1").length, 2, r.logs.join(" | "));
      assert.deepEqual(r.foreign, [], "an editor of another note was loaded");
      assert.ok(!r.logs.some((line) => line.includes("reason=editor_refresh")), r.logs.join(" | "));
    });
  }

  test(`an editor Obsidian already reloaded is not loaded again (${on})`, async (t) => {
    const next = "again one\nnewer\nagain two\n";
    const r = await openIdle(t, mobile, "again one\nagain two\n", (r) => { r.shown.value = next; });
    await r.arrive(next, 3000);
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), next);
    assert.deepEqual(r.loaded, [], "a second load puts the cursor back at the start of a note already shown");
    assert.ok(!r.logs.some((line) => line.includes("editor_refreshed")), r.logs.join(" | "));
  });

  test(`a version that changes only line endings is written, and the editor showing it is not loaded again (${on})`, async (t) => {
    const r = await openIdle(t, mobile, "ends one\r\nends two\r\n");
    await r.arrive("ends one\nends two\n", 3000);
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), "ends one\nends two\n");
    assert.deepEqual(r.loaded, [], "a second load puts the cursor back at the start of a note already shown");
  });

  test(`typing that starts while the version lands survives the native reload (${on})`, async (t) => {
    const typed = "race one\nrace two\ntyped now\n";
    const r = await openIdle(t, mobile, "race one\nrace two\n", (r) => { r.shown.value = typed; });
    await r.arrive("race one\nnewer\nrace two\n", 3000);
    const merged = "race one\nnewer\nrace two\ntyped now\n";
    assert.deepEqual(r.loaded, [[merged, false]]);
    assert.equal(r.shown.value, merged);
  });

  // Live, 2026-09-28: a build that read `data` as "what the view last loaded
  // or saved" took every view for untouched, wrote a merge under typing on an
  // iPhone, and the note came back interleaved.
  test(`unsaved typing holds the version back though the view's data follows it (${on}, live 2026-09-28)`, async (t) => {
    const r = await openIdle(t, mobile, "kept one\nkept two\n");
    r.shown.value = "kept one\nkept two\ntyped\n";
    assert.equal(r.view.data, r.shown.value, "the fake's data follows typing, as Obsidian's does");
    assert.equal(await r.host.editing(NOTE), "unsaved");
    await assert.rejects(r.arrive("kept one\nnewer\nkept two\n", 3000), { name: "Unwritable", reason: "active_editor" });
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), "kept one\nkept two\n");
    assert.deepEqual(r.loaded, []);
  });
}

test("preview delivery rechecks a second view rebound by the first consumer", async (t) => {
  const r = await openIdle(t, false, MINE);
  const second = r.openEditor(NOTE, { value: MINE });
  const previews = [];
  r.host.plugin.app.workspace.trigger = (event, file, text) => {
    previews.push({ event, path: file.path, text });
    second.file = { path: "Notes/Other.md" };
  };
  await r.arrive(THEIRS, 3000);
  assert.deepEqual(previews, [{ event: "quick-preview", path: NOTE, text: THEIRS }]);
  assert.equal(readFileSync(join(r.root, "Notes/Other.md"), "utf8"), "OTHER NOTE SENTINEL\n");
});

test("an editor is not given a version another write replaced before its rename was checked (desktop)", async (t) => {
  const r = await openIdle(t, false, "lost one\nlost two\n",
    (r) => writeFileSync(join(r.root, NOTE), "SAVE THAT LANDED SENTINEL, longer than ours\n"));
  await r.arrive("lost one\nnewer\nlost two\n", 3000);
  assert.deepEqual(r.logs.filter((line) => line.startsWith("host path_class=file decision=")),
    ["host path_class=file decision=write_superseded"], "one outcome, one line");
  assert.deepEqual(r.loaded, [], "the editor was given bytes that are not its file's");
});

// REVIEW OF dec081c: each window the refresh opened, pinned where it opened.
test("typing begun while obsync reads what it will write holds the version back (desktop, review of dec081c)", async (t) => {
  const typed = "read one\nread two\ntyped while it read\n";
  const r = await openIdle(t, false, "read one\nread two\n", undefined, (r) => { r.shown.value = typed; });
  await assert.rejects(r.arrive("read one\nnewer\nread two\n", 3000), { name: "Unwritable", reason: "active_editor" });
  assert.equal(readFileSync(join(r.root, NOTE), "utf8"), "read one\nread two\n", "the version was written under typing");
  assert.deepEqual(r.loaded, []);
  assert.equal(r.shown.value, typed);
});

for (const mobile of [false, true]) {
  const on = mobile ? "mobile" : "desktop";

  test(`a load that fails leaves the landed version standing, and says so (${on}, review of dec081c)`, async (t) => {
    const r = await openIdle(t, mobile, "fail one\nfail two\n");
    r.view.setViewData = () => { throw new Error("LOAD FAILURE SENTINEL"); };
    const next = "fail one\nnewer\nfail two\n";
    await r.arrive(next, 3000);
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), next);
    assert.equal(r.state.fileByPath(NOTE).versionId, r.version, "the applied version was not recorded");
    assert.ok(r.logs.some((line) => /^host path_class=file decision=failed reason=editor_refresh error=Error duration_ms=\d+$/.test(line)), r.logs.join(" | "));
  });

  test(`a leaf a load moves to another note is not loaded with this one (${on}, review of dec081c)`, async (t) => {
    const r = await openIdle(t, mobile, "two one\ntwo two\n");
    const second = r.openEditor(NOTE, { value: "two one\ntwo two\n" });
    const wrong = [];
    second.setViewData = (data) => wrong.push(data);
    const load = r.view.setViewData;
    r.view.setViewData = (data, clear) => { load(data, clear); second.file = { path: "Notes/Other.md" }; };
    await r.arrive("two one\nnewer\ntwo two\n", 3000);
    assert.equal(r.loaded.length, 1);
    assert.deepEqual(wrong, [], "a leaf that now shows another note was loaded with this one");
  });

  test(`an editor is not given a version a same-size save replaced after it landed (${on}, review of dec081c)`, async (t) => {
    const same = "SIZE ONE\nNEWER\nSIZE TWO\n";
    const r = await openIdle(t, mobile, "size one\nsize two\n", (r) => {
      // Same size and, on a desktop, the same mtime: nothing but the bytes differ.
      const target = join(r.root, NOTE);
      const { mtimeMs } = statSync(target);
      writeFileSync(target, same);
      utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
    });
    const next = "size one\nnewer\nsize two\n";
    assert.equal(same.length, next.length);
    await r.arrive(next, 3000);
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), same);
    assert.ok(!r.logs.includes("host path_class=file decision=write_superseded"), "the identity check caught it, so this pins nothing");
    assert.deepEqual(r.loaded, [], "the editor was given bytes that are not its file's");
    assert.ok(r.logs.some((line) => /^host path_class=file decision=editor_left reason=file_changed duration_ms=\d+$/.test(line)), r.logs.join(" | "));
  });
}

for (const mobile of [false, true]) {
  test(`a saved native editor with recent input defers until that input settles (${mobile ? "mobile" : "desktop"})`, async (t) => {
    const r = await native(t, {}, { mobile });
    r.seed(NOTE, "Shared: START|", 1000);
    const base = await pushFile(r.context, NOTE);
    const buffered = { value: "Shared: START|" };
    const view = r.openEditor(NOTE, buffered);
    r.host.editorActivity.record(view, "beforeinput");
    const incoming = await r.server.publish({
      fileId: base.fileId, path: NOTE, bytes: enc("Shared: START|a"), mtime: 3000,
      parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
    assert.equal(await r.host.editing(NOTE), "saved");
    assert.equal(r.host.typing(NOTE), true);
    await assert.rejects(r.applyIncoming(incoming), { name: "Unwritable", reason: "active_editor" });
    assert.equal(readFileSync(join(r.root, NOTE), "utf8"), buffered.value);
    assert.deepEqual(r.hidden(), []);
    r.host.editorActivity.inputs.delete(view);
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
      if (!from.includes(".obsync-gone-") || !to.endsWith(join(NOTE)) || laterEdit) return;
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
  const outside = scratch("obsync-outside-");
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

/**
 * A CHANGE PAST ITS BUDGET IS AWAITED, NEVER READ AS REFUSED (review of
 * a0dc7fc2, finding 1). The move into the hidden folder LANDS here, and only
 * its answer is held, as a disk that loses an acknowledgement holds it. Taken
 * for a refusal, the removal said "nothing moved", released the hold and left
 * the note under a hidden name with nothing keeping it. Awaited, the hold
 * stays for as long as the answer is out, and the removal ends as it would
 * have when the answer comes.
 */
test("a move into the hidden folder that landed but answered after its budget is awaited, and the hold stays until it answers", async (t) => {
  let answer = null;
  const r = await native(t, {
    afterRename: (root, from, to) => (nodePath.basename(nodePath.dirname(to)).startsWith(".obsync-gone-")
      ? new Promise((resolve) => { answer = resolve; })
      : undefined),
  });
  const dog = diskWatchdog(t);
  r.seed(NOTE, MINE, 2000);
  const stat = statSync(join(r.root, NOTE));
  const outcome = r.host.trash(NOTE, { path: NOTE, mtime: Math.round(stat.mtimeMs), size: stat.size }).then((v) => v, (e) => e);
  await until(() => answer !== null);
  assert.notEqual(answer, null, "the removal never moved the note");
  assert.equal(existsSync(join(r.root, NOTE)), false, "the move had not landed");

  dog.at(15_000);
  dog.tick();
  assert.ok(r.logs.includes("host decision=overrun call=rename duration_ms=15000 budget_ms=15000 outcome=awaited"), JSON.stringify(r.logs));
  const early = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50))]);
  assert.equal(early, "still waiting", `the removal ended on a guess: ${early}`);
  assert.equal(r.logs.includes("host path_class=file decision=kept reason=move_refused"), false, "the landed move was read as refused");
  const held = r.hidden().filter((name) => name.startsWith(".obsync-hold-"));
  assert.deepEqual(held.map((name) => readFileSync(join(r.root, "Notes", name), "utf8")), [MINE], "the hold was released while the move was out");

  answer();
  assert.equal(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting after its answer"), 2000))]), "removed");
  assert.ok(r.logs.includes("host decision=late call=rename duration_ms=15000 budget_ms=15000 outcome=answered"), JSON.stringify(r.logs));
  assert.deepEqual(r.hidden(), [], "a hold or a moved file was left behind");
  assert.deepEqual(r.trashed.map((entry) => entry.bytes), [MINE]);
});

/**
 * A STALLED READ OF THE HOLD SAYS NOTHING OF IT (review of a0dc7fc2, finding
 * 1). Its open is the last look before the hold is released; read as "the
 * hold is gone", the removal ended `removed` with the hold still on the disk
 * and nothing left to look at it. It fails instead, the hold stays, and the
 * handle the open brings when it answers at last is closed, as nobody is
 * left to close it.
 */
test("a stalled open of the hold fails the removal and leaves the hold, and the handle it brings late is closed", async (t) => {
  let gate = null;
  let late = null;
  const r = await native(t, {
    open: (root, path, flags) => (flags === "r" && nodePath.basename(path).startsWith(".obsync-hold-") && gate === null
      ? new Promise((resolve) => { gate = resolve; })
      : undefined),
    opened: (path, flags, handle) => { if (nodePath.basename(path).startsWith(".obsync-hold-")) late = handle; },
  });
  const dog = diskWatchdog(t);
  r.seed(NOTE, MINE, 2000);
  const stat = statSync(join(r.root, NOTE));
  const outcome = r.host.trash(NOTE, { path: NOTE, mtime: Math.round(stat.mtimeMs), size: stat.size }).then((v) => v, (e) => e);
  await until(() => gate !== null);
  assert.notEqual(gate, null, "the removal never opened the hold");

  dog.at(15_000);
  dog.tick();
  const error = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting after its budget"), 2000))]);
  assert.equal(error?.code, "disk_stalled", `the removal ended as ${error}`);
  assert.ok(r.logs.includes("host decision=stalled call=open duration_ms=15000 budget_ms=15000"), JSON.stringify(r.logs));
  assert.equal(r.logs.includes("host path_class=file decision=restore_failed reason=hold_gone"), false, "a stalled open was read as a hold gone");
  const held = r.hidden().filter((name) => name.startsWith(".obsync-hold-"));
  assert.deepEqual(held.map((name) => readFileSync(join(r.root, "Notes", name), "utf8")), [MINE], "the hold went with the stall");

  gate();
  await until(() => late !== null && late.fd === -1);
  assert.equal(late?.fd, -1, "the handle the late open brought was left open");
  assert.ok(r.logs.includes("host decision=late call=open duration_ms=15000 budget_ms=15000 outcome=answered"), JSON.stringify(r.logs));
});

/**
 * A STOP WAITS FOR A CHANGE STILL OUT (review of a0dc7fc2, finding 1). A
 * download's deletion is stopped while its move is unanswered, past its
 * budget: the apply does not end until the disk answers the move, so nothing
 * that stops or starts after it acts on a move that may still land.
 */
test("a stop that comes while a deletion's move is unanswered past its budget waits for the move", async (t) => {
  let answer = null;
  const r = await native(t, {
    afterRename: (root, from, to) => (nodePath.basename(nodePath.dirname(to)).startsWith(".obsync-gone-")
      ? new Promise((resolve) => { answer = resolve; })
      : undefined),
  });
  const dog = diskWatchdog(t);
  r.seed("Notes/Keep.md", "SIBLING SENTINEL\n", 1000);
  r.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  const live = r.state.fileByPath(NOTE);
  const tombstone = await r.server.publishTombstone({ fileId: live.fileId, path: NOTE, manifestKey: r.keys.manifestKey, parents: [live.versionId] });
  const halt = new AbortController();
  let ended = false;
  const applied = applyChange({ ...r.context, signal: halt.signal }, tombstone).then((v) => v, (e) => e).finally(() => { ended = true; });
  await until(() => answer !== null);
  assert.notEqual(answer, null, "the deletion never moved the note");

  halt.abort();
  dog.at(15_000);
  dog.tick();
  assert.ok(r.logs.includes("host decision=overrun call=rename duration_ms=15000 budget_ms=15000 outcome=awaited"), JSON.stringify(r.logs));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ended, false, "the stopped apply ended while its move was still out");

  answer();
  await Promise.race([applied, new Promise((resolve) => setTimeout(resolve, 2000))]);
  assert.equal(ended, true, "the apply never ended after its move answered");
  assert.equal(existsSync(join(r.root, NOTE)), false);
  assert.deepEqual(r.hidden(), [], "a hold or a moved file was left behind");
  assert.deepEqual(r.trashed.map((entry) => entry.bytes), [MINE], "the note's bytes went anywhere but the deletion it was meant for");
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

for (const mobile of [false, true]) for (const open of [false, true]) for (const sameSize of [false, true]) {
  test(`a staged merge cannot replace a newer saved input (${mobile ? "mobile" : "desktop"}, ${open ? "open" : "closed"}, ${sameSize ? "same-size" : "grown"})`, async (t) => {
    const r = await native(t, {}, { mobile });
    const old = "A: old\nB: base\n", newer = sameSize ? "A: NEW\nB: base\n" : "A: old plus input\nB: base\n";
    r.seed(NOTE, old, 1000);
    const shown = { value: old };
    if (open) r.openEditor(NOTE, shown);
    const incoming = enc("A: old\nB: peer\n"), writer = await r.host.writer(NOTE, incoming.length);
    try {
      await writer.write(incoming);
      // Identical metadata makes this a byte-precondition test, not a stat test.
      r.seed(NOTE, newer, 1000); shown.value = newer;
      await assert.rejects(writer.commit(2000, enc(old)), { name: "Error" });
      assert.equal(readFileSync(join(r.root, NOTE), "utf8"), newer);
      assert.equal(shown.value, newer);
      assert.ok(r.logs.some(line => line.includes("reason=merge_input_changed")));
    } finally { await writer.abort(); }
    assert.deepEqual(r.hidden(), []);
  });
}
