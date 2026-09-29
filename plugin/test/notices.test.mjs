/**
 * Sync notices that name what exists, say one thing once, and speak only for
 * what this device did (issue #164).
 *
 * Each of these sent a person looking for a file or a problem that was not
 * there: a copy named a second before its owner renamed it, an `error` flash
 * for a note that had merely moved, two notices for one deletion, and a fresh
 * device announcing merges it took no part in. Item 2 of the issue -- the
 * device name in a copy's name -- is the pairing lane's.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FakeTimers, KEYS, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { COPY_SETTLE_MS, announceCopies, applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");

const enc = (text) => new TextEncoder().encode(text);
const NOTE = "Notes/Same.md";
const MINE = "the note this device made\n";
const THEIRS = "the different note the other device made\n";
const LOWER = "11".repeat(16);
const HIGHER = "33".repeat(16);

const copies = (host) => [...host.files.keys()].filter((path) => path.includes("(conflict from"));

/**
 * This device holds the LOWER id at `NOTE` and another device's note arrives
 * there: this device keeps the name and the copy's name is the other device's
 * to settle, by moving its own note aside (`samename.test.mjs`). The context
 * carries the engine's copy map.
 */
async function keeper() {
  const r = await rig();
  r.context.copies = new Map();
  r.host.seed(NOTE, MINE, 2000);
  await pushFile(r.context, NOTE);
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), fileId: LOWER });
  const frame = await r.server.publish({
    fileId: HIGHER, path: NOTE, bytes: enc(THEIRS), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, frame), "conflict_copy");
  return { r, frame };
}

test("a copy the other device renames aside is announced once, under the name it ends with", async () => {
  const { r, frame } = await keeper();
  const first = copies(r.host)[0];
  announceCopies(r.context);
  assert.deepEqual(r.host.notices, [], "the copy was named before the device that owns its name had moved it");

  // The other device moves its own note aside and publishes that move: the
  // copy here is renamed to the name that device chose.
  const renamed = "Notes/Same (conflict from laptop, 2026-01-02 0304).md";
  const move = await r.server.publish({
    fileId: HIGHER, path: renamed, bytes: enc(THEIRS), mtime: 6000,
    parents: [frame.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  assert.equal(await applyChange(r.context, move), "applied");
  assert.notEqual(first, renamed, "the fixture must rename the copy for this to prove anything");
  announceCopies(r.context);

  assert.deepEqual(r.host.notices, [`obsync kept both versions of ${NOTE}. The other device's copy is "${renamed}".`]);
  assert.equal(r.host.text(renamed), THEIRS, "the named file is not the copy");
  announceCopies(r.context, true);
  assert.equal(r.host.notices.length, 1, "the copy was announced twice");
});

test("a copy nobody renames is announced where it is once the wait is over", async () => {
  // A phone cannot move its note aside (`moveAside`), so no rename ever comes
  // and the name this device gave the copy is final.
  const { r } = await keeper();
  const copy = copies(r.host)[0];
  r.host.clock += COPY_SETTLE_MS - 1;
  announceCopies(r.context);
  assert.deepEqual(r.host.notices, [], "announced before the owner of the name had its chance to move it");
  r.host.clock += 1;
  announceCopies(r.context);
  assert.deepEqual(r.host.notices, [`obsync kept both versions of ${NOTE}. The other device's copy is "${copy}".`]);
});

/** One engine over the rig, one fake clock, and every status it reports. */
async function engineOver(t, notes) {
  const r = await rig();
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({
    state: r.state,
    transport: new Transport({
      request: r.server.request,
      serverUrl: () => r.state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => r.host.clock,
      sleep: async () => undefined,
    }),
    host: r.host,
    timers,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => engine.stop());
  for (const path of notes) r.host.seed(path, `${path}\n`, 1000);
  await engine.start();
  await timers.run(1000, () => notes.every((path) => r.state.fileByPath(path) !== undefined));
  return { ...r, timers, engine, statuses };
}

test("a push whose note went away before its turn stands down, and never says error", async (t) => {
  const d = await engineOver(t, ["Notes/n05.md"]);
  // The note leaves between being queued and being read: a folder moved, a
  // rename's other half not yet heard. The listing still names it, which is
  // how a push is queued for a path that is gone by its turn.
  const stat = await d.host.stat("Notes/n05.md");
  d.host.files.delete("Notes/n05.md");
  const list = d.host.list.bind(d.host);
  d.host.list = async () => [...(await list()), stat];
  d.statuses.length = 0;

  await d.engine.syncNow();
  await d.timers.run(1000);

  assert.ok(
    d.host.logs.includes("push path_class=file decision=stood_down reason=path_gone"),
    d.host.logs.filter((line) => line.startsWith("push")).join(" | "),
  );
  assert.deepEqual(d.statuses.filter((status) => status.kind === "error"), [], "a note that moved flashed an error");
  assert.equal(d.host.logs.some((line) => line.includes("decision=failed")), false, d.host.logs.join(" | "));
  assert.equal(d.host.logs.some((line) => line.includes("Notes/n05.md")), false, "a vault path reached the log");
});

test("one deletion met twice while the edit here cannot be sent gives one notice, and a true one", async () => {
  const r = await rig();
  const FILE = "13".repeat(16);
  const created = await r.server.publish({
    fileId: FILE, path: "Notes/n16.md", bytes: enc("from the other device\n"), mtime: 1757200001000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  await applyChange(r.context, created);
  // An edit here the revive cannot publish: the note is still being written
  // at every read (issue #99), so each revive stands down as `growing`.
  r.host.seed("Notes/n16.md", "typed here\n", 1757200009000);
  const read = r.host.read.bind(r.host);
  let typed = 0;
  r.host.read = async (path) => {
    const bytes = await read(path);
    r.host.seed(path, `typed here${" and more".repeat(++typed)}\n`, 1757200009000 + typed);
    return bytes;
  };
  const tombstone = await r.server.publishTombstone({
    fileId: FILE, path: "Notes/n16.md", manifestKey: r.keys.manifestKey, parents: [created.version_id],
  });

  // The feed delivers it, and a push's own reconciliation delivers it again.
  assert.equal(await applyChange(r.context, tombstone), "skipped");
  assert.equal(await applyChange(r.context, tombstone), "skipped");

  assert.deepEqual(r.host.trashed, [], "the edit was deleted");
  assert.equal(r.host.notices.length, 1, r.host.notices.join(" | "));
  assert.match(r.host.notices[0], /^obsync did not delete Notes\/n16\.md: it holds changes this device has not uploaded yet/);
});

test("a fresh device replaying a fork other devices made announces no merge of its own", async () => {
  // Two other devices edited one note from the same version before this one
  // was paired: the first download meets the fork and resolves it, and the
  // person here edited neither side (S49).
  const r = await rig();
  const FILE = "24".repeat(16);
  const publish = (bytes, parents, mtime) => r.server.publish({
    fileId: FILE, path: "Notes/Shared.md", bytes: enc(bytes), mtime, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const base = await publish("one\ntwo\nthree\n", [], 1757200001000);
  const left = await publish("ONE\ntwo\nthree\n", [base.version_id], 1757200002000);
  const right = await publish("one\ntwo\nTHREE\n", [base.version_id], 1757200003000);

  for (const frame of [base, left]) await applyChange(r.context, frame);
  assert.equal(await applyChange(r.context, { ...right, conflicted: true }), "merged");

  assert.equal(r.host.text("Notes/Shared.md"), "ONE\ntwo\nTHREE\n", "the fork was not merged");
  assert.deepEqual(r.host.notices, [], "a merge this device took no part in was announced");
  assert.ok(
    r.host.logs.some((line) => line.startsWith("pull decision=merged") && line.endsWith("announced=false")),
    r.host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("a merge of an edit made here is still announced", async () => {
  // The other half of the rule: the same fork, with one side typed here and
  // not pushed yet, is this device's news.
  const r = await rig();
  r.host.noticeSettings = { level: "everything", merges: "once" };
  const FILE = "25".repeat(16);
  const publish = (bytes, parents, mtime) => r.server.publish({
    fileId: FILE, path: "Notes/Shared.md", bytes: enc(bytes), mtime, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const base = await publish("one\ntwo\nthree\n", [], 1757200001000);
  const left = await publish("ONE\ntwo\nthree\n", [base.version_id], 1757200002000);
  for (const frame of [base, left]) await applyChange(r.context, frame);
  r.host.seed("Notes/Shared.md", "ONE\ntwo\nthree\nfour\n", 1757200005000);
  const right = await publish("one\ntwo\nTHREE\n", [base.version_id], 1757200003000);

  assert.equal(await applyChange(r.context, { ...right, conflicted: true }), "merged");
  // By its title and the other device's name, never a path or an id (owner, 2026-09-29).
  assert.deepEqual(r.host.notices, ["obsync: combined your edits to \"Shared\" with iPhone's."]);
  assert.deepEqual(r.host.said, [{
    kind: "combined", text: "combined your edits to {notes} with {device}'s.", paths: ["Notes/Shared.md"], device: "iPhone",
  }]);
  assert.deepEqual(r.host.toasts.map((toast) => [toast.text, toast.ms]), [["obsync: combined your edits to \"Shared\" with iPhone's.", 8000]]);
});

test("one question about held deletions is on screen at a time, and it goes when nothing is held or the plugin unloads", async (t) => {
  // The owner's rig, 2026-09-27: eight "holding back N deletions" notices
  // stacked down the screen, one per engine start and Sync now.
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const main = box.require(join(box.home, "build", "main.js"));
  const { raised } = box.require("obsidian");
  const plugin = { state: { data: {} }, log: () => undefined, act: () => undefined };
  plugin.notices = main.noticeChannel(plugin);
  const host = new main.ObsidianHost(plugin, null);
  const held = [{ kind: "delete_everywhere" }, { kind: "restore_here" }];
  const from = raised.length;
  host.notify("obsync: you deleted 119 notes. Delete them on your other devices too?", held);
  host.notify("obsync is still holding back 119 deletions from your other devices. Delete them there too?", held);
  host.notify("obsync put 2 note(s) back on this device, and deleted nothing anywhere.");
  host.notify("obsync is still holding back 227 deletions from your other devices. Delete them there too?", held);
  const shown = () => raised.slice(from).map((notice) => !notice.hidden);
  assert.deepEqual(shown(), [false, false, true, true], "only the newest question, and the statement, are on screen");
  host.closeQuestion();
  assert.deepEqual(shown(), [false, false, true, false], "nothing held, no question");
  // An offer to fetch a file asks something else, and a held-deletions question never takes it away.
  host.notify("obsync: a file is waiting on the server.", [{ kind: "fetch", fileId: "ab".repeat(16) }]);
  host.notify("obsync is still holding back 1 deletions from your other devices. Delete them there too?", held);
  assert.deepEqual(shown().slice(-2), [true, true]);
  // A plugin that unloads takes its question with it; the next load asks afresh.
  const loaded = new main.default();
  loaded.host = host;
  loaded.onunload();
  assert.deepEqual(shown().slice(-2), [true, false]);
});
