/**
 * A note deleted on another device while it is open and being typed in here
 * (issue #146).
 *
 * WHAT A USER SAW (S16 run 1). The desktop typed into an open note; Obsidian
 * saved it on its two-second debounce and the device published every save.
 * The other device received the last save and deleted the note: a tombstone
 * whose parent IS the version the editor last saved, so a plain fast-forward.
 * The desktop applied it 0.7 s after that save and the tab turned into "No
 * file". The keystrokes typed since the save existed only in the editor, and
 * everything typed afterwards went nowhere. Delete-versus-edit already keeps a
 * note whose FILE holds an edit that is not published (`local_edit`); nothing
 * asked about the editor.
 *
 * THE RULE. A deletion that fast-forwards over the version this device holds
 * is not applied while the note is open in an editor here AND either the
 * editor holds text its file does not, or this device published an edit of it
 * within `EDITING_WINDOW_MS`. The note is kept and published again under the
 * same file id -- the existing delete-versus-edit revive -- so it comes back on
 * the device that deleted it. Past the window, or with no editor open on it,
 * a deletion is a deletion.
 *
 * WHAT IS AND IS NOT A PLATFORM HERE. The device-level tests run the real
 * engine on both configurations the two-device rig has, the desktop typing and
 * the phone typing. The editor is the fake host's `editors` map, which answers
 * `editing` the way `ObsidianHost` does: the last block below drives the real
 * `ObsidianHost.editing` over fake workspace leaves, the same on desktop and
 * mobile because it reads only Obsidian's public workspace and vault.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { STEP_MS, pair, rig, sandbox, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const c = require("../build/crypto.js");
const { EDITING_WINDOW_MS, applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

const enc = (text) => new TextEncoder().encode(text);

const NOTE = "Notes/n15.md";
const BASE = "# n15\nthe line both devices start from\n";
/** What the editor's last save wrote, and the device published. */
const SAVED = `${BASE} t001 t002 t003 t004`;
/** What the editor holds now: the keystrokes inside the save debounce. */
const TYPED = `${SAVED} t005 t006 t0`;

/** Every version the server holds of the vault's notes, decrypted, oldest first. */
async function versions(server, k) {
  const out = [];
  for (const frame of server.journal) {
    if (frame.file_id === k.map.fileId) continue;
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(
      k.manifestKey,
      frame.file_id,
      binder,
      c.unhex(frame.manifest_nonce),
      c.unbase64(frame.manifest_ct),
    ));
    if (manifest.v === 2) continue;
    const parts = [];
    for (const chunk of manifest.chunks) {
      parts.push(await c.decryptChunk(k.domainKey, c.unhex(chunk.cid), server.chunks.get(chunk.sid)));
    }
    const text = manifest.deleted ? null : parts.map((part) => new TextDecoder().decode(part)).join("");
    out.push({ fileId: frame.file_id, versionId: frame.version_id, parents: frame.parents, deleted: manifest.deleted, text });
  }
  return out;
}

const pulls = (host) => host.logs.filter((line) => line.startsWith("pull")).join(" | ");

// --- the reported case, on two devices ---------------------------------------

for (const typist of ["desktop", "phone"]) {
  for (const buffer of ["unsaved", "saved"]) {
    test(`a note open on the ${typist} and typed in survives a deletion on the other device (${buffer} editor)`, async (t) => {
      const { server, timers, a, b, keys: k } = await pair(t);
      const [typing, deleting] = typist === "desktop" ? [a, b] : [b, a];
      typing.host.write(NOTE, BASE, 1000);
      await typing.engine.start();
      await deleting.engine.start();
      await timers.run(STEP_MS, () =>
        deleting.host.text(NOTE) === BASE && settled(typing, NOTE) && settled(deleting, NOTE));

      // The editor's debounce saves, and this device publishes the save.
      typing.host.write(NOTE, SAVED, 2000);
      await timers.run(STEP_MS, () =>
        deleting.host.text(NOTE) === SAVED && typing.state.fileByPath(NOTE)?.mtime === 2000);
      // The user is still typing: the newest keystrokes are only in the
      // editor (`unsaved`), or the editor has just saved them (`saved`).
      typing.host.editors.set(NOTE, buffer === "unsaved" ? TYPED : SAVED);
      // S16's own interval: the deletion lands 0.7 s after the last save.
      typing.host.clock += 700;

      // The other device deletes the note it has just received.
      deleting.host.remove(NOTE);
      await timers.run(STEP_MS, () =>
        typing.host.text(NOTE) === null || (deleting.host.text(NOTE) === SAVED && settled(deleting, NOTE)));

      assert.equal(typing.host.text(NOTE), SAVED, `the note was deleted under the cursor: ${pulls(typing.host)}`);
      assert.equal(deleting.host.text(NOTE), SAVED, `the kept note never came back: ${pulls(deleting.host)}`);
      const line = typing.host.logs.find((entry) => entry.includes("reason=open_editing"));
      assert.ok(line, pulls(typing.host));
      assert.match(line, /^pull path_class=tombstone decision=local_edit_kept reason=open_editing /);
      assert.match(line, new RegExp(` editor=${buffer} age_ms=700 budget_ms=${EDITING_WINDOW_MS} published=pushed `));
      assert.deepEqual(typing.host.notices.filter(notice => notice.includes(NOTE)), []);

      // The next save reaches the other device without meeting the deletion again.
      typing.host.editors.delete(NOTE);
      typing.host.write(NOTE, TYPED, 3000);
      await timers.run(STEP_MS, () =>
        deleting.host.text(NOTE) === TYPED);
      assert.equal(typing.host.text(NOTE), TYPED);
      assert.equal(typing.host.notices.length, 0, "no repeated deletion notices (#178)");
      assert.equal((await server.noteFiles(k.manifestKey)).length, 1, "one note, still one file id");
      assert.ok((await versions(server, k)).some((version) => version.text === TYPED));
    });
  }
}

test("the push queue remembers only the publications the window can still read", async (t) => {
  const { timers, a } = await pair(t);
  await a.engine.start();
  const T0 = a.host.clock;
  const publish = async (path, text, at) => {
    a.host.clock = at;
    a.host.write(path, text, at);
    await timers.run(STEP_MS, () => a.state.fileByPath(path)?.mtime === at);
  };
  await publish("Notes/kept typing.md", "one\n", T0);
  await publish("Notes/left alone.md", "one\n", T0 + 1);
  // Published again at the end of the window: it must move behind the note
  // above, or it stands at the front and the trim stops at it for good.
  await publish("Notes/kept typing.md", "two\n", T0 + EDITING_WINDOW_MS);
  await publish("Notes/last.md", "one\n", T0 + EDITING_WINDOW_MS + 2);

  assert.deepEqual(
    [...a.engine.context.pushedAt.entries()],
    [["Notes/kept typing.md", T0 + EDITING_WINDOW_MS], ["Notes/last.md", T0 + EDITING_WINDOW_MS + 2]],
    "a publication older than the window was kept, so the map grows for the life of the plugin",
  );
});

// --- the decision, one device ------------------------------------------------

/**
 * One device holding the note, an editor open on it (or not), and a
 * fast-forward tombstone from the other device. `publishedAgo` is how long ago
 * the push queue published this device's last edit of it, which the queue
 * itself records (the device-level tests above run it); `undefined` is none
 * this session.
 */
async function openNote({ editor, publishedAgo, isMobile = false }) {
  const r = await rig({ isMobile });
  r.host.seed(NOTE, SAVED, 1000);
  const pushed = await pushFile(r.context, NOTE);
  if (publishedAgo !== undefined) r.context.pushedAt.set(NOTE, r.host.clock - publishedAgo);
  if (editor !== undefined) r.host.editors.set(NOTE, editor);
  const tombstone = await r.server.publishTombstone({
    fileId: pushed.fileId,
    path: NOTE,
    manifestKey: r.keys.manifestKey,
    parents: [pushed.versionId],
  });
  return { ...r, pushed, tombstone };
}

for (const isMobile of [false, true]) {
  const platform = isMobile ? "mobile" : "desktop";

  test(`an open note holding unsaved typing is kept however long ago it was published (${platform})`, async () => {
    const r = await openNote({ editor: TYPED, isMobile });

    assert.equal(await applyChange(r.context, r.tombstone), "skipped");

    assert.equal(r.host.text(NOTE), SAVED, "the file under the editor was deleted");
    assert.deepEqual(r.host.trashed, []);
    const after = (await versions(r.server, r.keys)).at(-1);
    assert.deepEqual(
      [after.fileId, after.parents, after.deleted, after.text],
      [r.pushed.fileId, [r.pushed.versionId, r.tombstone.version_id], false, SAVED],
      "the note was not published again under its own id, so it stays deleted everywhere else",
    );
    assert.equal(r.state.fileByPath(NOTE).versionId, after.versionId);
    assert.match(
      pulls(r.host),
      new RegExp(`decision=local_edit_kept reason=open_editing editor=unsaved age_ms=-1 budget_ms=${EDITING_WINDOW_MS} published=pushed`),
    );
    assert.equal(r.host.notices.length, 0, "settled deletion is silent (#178)");
  });

  test(`an open note published from here within the window is kept, to its last millisecond (${platform})`, async () => {
    const r = await openNote({ editor: SAVED, publishedAgo: EDITING_WINDOW_MS, isMobile });

    assert.equal(await applyChange(r.context, r.tombstone), "skipped");

    assert.equal(r.host.text(NOTE), SAVED);
    assert.match(
      pulls(r.host),
      new RegExp(`reason=open_editing editor=saved age_ms=${EDITING_WINDOW_MS} budget_ms=${EDITING_WINDOW_MS} published=pushed`),
    );
  });

  test(`a deletion applies once the last save is past the window, or without an editor (${platform})`, async () => {
    const cases = [
      ["saved past the window", { editor: SAVED, publishedAgo: EDITING_WINDOW_MS + 1 }, ` editor=saved age_ms=${EDITING_WINDOW_MS + 1} budget_ms=${EDITING_WINDOW_MS}`],
      ["open, never edited here", { editor: SAVED }, ` editor=saved age_ms=-1 budget_ms=${EDITING_WINDOW_MS}`],
      ["no editor, published just now", { publishedAgo: 0 }, ""],
    ];
    for (const [name, options, fields] of cases) {
      const r = await openNote({ ...options, isMobile });

      assert.equal(await applyChange(r.context, r.tombstone), "deleted", name);

      assert.equal(r.host.text(NOTE), null, name);
      assert.equal(r.state.fileByPath(NOTE), undefined, name);
      assert.equal(r.host.notices.length, 0, `${name}: an ordinary deletion says nothing`);
      assert.ok(
        r.host.logs.includes(`pull path_class=tombstone decision=deleted seq=${r.tombstone.seq}${fields}`),
        `${name}: ${pulls(r.host)}`,
      );
    }
  });
}

test("a deletion past a version this device never applied publishes nothing older over it", async () => {
  const r = await openNote({ editor: TYPED, publishedAgo: 0 });
  // Another device published a newer version and then deleted it; this one
  // holds the older one. Keeping it would publish SAVED over the newer text.
  const newer = await r.server.publish({
    fileId: r.pushed.fileId,
    path: NOTE,
    bytes: enc(`${SAVED} and a newer line from the other device`),
    mtime: 3000,
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
    parents: [r.pushed.versionId],
  });
  const tombstone = await r.server.publishTombstone({
    fileId: r.pushed.fileId,
    path: NOTE,
    manifestKey: r.keys.manifestKey,
    parents: [newer.version_id],
  });
  const journal = r.server.journal.length;

  assert.equal(await applyChange(r.context, tombstone), "deleted");

  assert.equal(r.server.journal.length, journal, "a version older than the newest one was published over it");
  assert.equal(r.host.notices.length, 0);
});

// --- the real host's answer ------------------------------------------------------

/**
 * `ObsidianHost.editing` over fake workspace leaves. A view is an instance of
 * the stub's `MarkdownView` with the two members the host reads: the note it
 * shows and what its save would write.
 */
async function obsidianHost(t, leaves, disk) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { MarkdownView } = box.require("obsidian");
  const asked = [];
  const plugin = {
    state: { data: {} },
    app: {
      vault: { read: async (file) => { asked.push(file.path); return disk; } },
      workspace: {
        getLeavesOfType: (type) => {
          asked.push(type);
          return leaves(MarkdownView).map((view) => ({ view }));
        },
      },
    },
    log: () => undefined,
  };
  return { host: new ObsidianHost(plugin, null), asked };
}

const view = (MarkdownView, path, text) => Object.assign(new MarkdownView(), { file: { path }, getViewData: () => text });

test("the host says unsaved when an editor on the note would write what its file does not", async (t) => {
  const { host, asked } = await obsidianHost(t, (MarkdownView) => [
    view(MarkdownView, "Notes/other.md", SAVED),
    view(MarkdownView, NOTE, SAVED),
    view(MarkdownView, NOTE, TYPED),
  ], SAVED);
  assert.equal(await host.editing(NOTE), "unsaved");
  assert.deepEqual(asked, ["markdown", NOTE], "the file is read once, and only for the note asked about");
});

test("the host says saved when every editor on the note holds its file, line endings aside", async (t) => {
  const { host } = await obsidianHost(t, (MarkdownView) => [
    view(MarkdownView, NOTE, SAVED),
    view(MarkdownView, NOTE, SAVED),
  ], SAVED.replaceAll("\n", "\r\n"));
  assert.equal(await host.editing(NOTE), "saved");
});

test("the host says no editor for another note's editor, or a leaf that is not loaded", async (t) => {
  const { host, asked } = await obsidianHost(t, (MarkdownView) => [
    view(MarkdownView, "Notes/other.md", TYPED),
    // A deferred leaf: Obsidian has not built its editor, so it holds nothing typed.
    { file: { path: NOTE }, getViewData: () => TYPED },
  ], SAVED);
  assert.equal(await host.editing(NOTE), null);
  assert.deepEqual(asked, ["markdown"], "nothing was read for a note no editor shows");
});
