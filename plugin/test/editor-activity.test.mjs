import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
const { EditorActivity, EDITOR_SAVE_MS, EDITOR_SAVE_MAX_CHARS } = createRequire(import.meta.url)("../build/editorActivity.js");

const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = { text: "local", disk: "local", enabled: true, saves: 0, notifications: [], logs: [] };
  r.view = { file: { path: "Notes/test.md" }, getViewData: () => r.text, save: async () => { r.saves++; r.disk = r.text; } };
  r.views = [r.view];
  r.read = async () => r.disk;
  r.activity = new EditorActivity({
    views: (path) => r.views.filter((view) => view.file?.path === path),
    read: (file) => r.read(file), enabled: () => r.enabled,
    saved: (path) => r.notifications.push(path), log: (line) => r.logs.push(line),
  }, { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) });
  r.input = (kind = "beforeinput") => r.activity.record(r.view, kind);
  r.ready = () => r.activity.ready("Notes/test.md");
  r.tick = async (ms = EDITOR_SAVE_MS) => { t.mock.timers.tick(ms); await drain(); };
  t.after(() => r.activity.stop());
  return r;
}

test("recent input becomes write-ready only after an awaited save and independent read", async (t) => {
  const r = fixture(t);
  r.input();
  assert.equal(await r.ready(), false, "matching disk alone is not a receipt");
  await r.tick(EDITOR_SAVE_MS - 1);
  assert.equal(r.saves, 0);
  await r.tick(1);
  assert.equal(r.saves, 1);
  assert.equal(await r.ready(), true);
  assert.equal(r.activity.recent(r.view), true, "rewrite attribution is independent");
  assert.equal(r.notifications.length, 1);
  assert.match(r.logs[0], new RegExp(`^editor decision=saved duration_ms=\\d+ budget_ms=${EDITOR_SAVE_MS}$`));
  r.input();
  assert.equal(await r.ready(), false, "even identical text with new input revokes the receipt");
});

test("continuous input coalesces saves without waiting for typing to stop", async (t) => {
  const r = fixture(t);
  for (let i = 0; i < 20; i++) { r.input(); await r.tick(EDITOR_SAVE_MS / 10); }
  assert.equal(r.saves, 2);
  assert.equal(await r.ready(), true);
});

for (const reason of ["composition", "disabled", "stopped", "rebound", "native_only"]) {
  test(`the refresh bridge refuses ${reason} save ownership`, async (t) => {
    const r = fixture(t);
    r.input();
    assert.equal(r.activity.canRefresh(r.view), true);
    if (reason === "composition") r.input("compositionstart");
    if (reason === "disabled") r.enabled = false;
    if (reason === "stopped") r.activity.stop();
    if (reason === "rebound") r.view.file = { path: "Notes/test.md" };
    if (reason === "native_only") r.activity.holdReload("Notes/test.md")(false);
    assert.equal(r.activity.canRefresh(r.view), false);
  });
}

for (const phase of ["before_save", "save", "after_save"]) test(`input during ${phase} invalidates the result and queues one replacement`, async (t) => {
  const r = fixture(t);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  if (phase === "save") r.view.save = async () => { r.saves++; await pending; r.disk = r.text; };
  else {
    let reads = 0;
    r.read = async () => { if (++reads === (phase === "before_save" ? 1 : 2)) await pending; return r.disk; };
  }
  r.input(); await r.tick();
  r.input(); r.input();
  release(); await drain();
  assert.equal(r.notifications.length, 0);
  assert.equal(await r.ready(), false);
  await r.tick();
  assert.equal(r.saves, phase === "before_save" ? 1 : 2);
  assert.equal(await r.ready(), true);
});

for (const reason of ["save_failure", "read_failure", "wrong_disk", "changed_buffer", "rebind", "closed", "disabled", "stop"]) {
  test(`a save cannot grant a receipt after ${reason}`, async (t) => {
    const r = fixture(t);
    r.view.save = async () => {
      r.saves++;
      if (reason === "save_failure") throw Error("synthetic");
      if (reason === "read_failure") r.read = async () => { throw Error("synthetic"); };
      if (reason === "wrong_disk") r.disk = "other";
      if (reason === "changed_buffer") r.text = "other";
      if (reason === "rebind") r.view.file = { path: "Notes/test.md" };
      if (reason === "closed") r.views = [];
      if (reason === "disabled") r.enabled = false;
      if (reason === "stop") r.activity.stop();
    };
    r.input(); await r.tick();
    assert.equal(r.notifications.length, 0);
    await r.tick(EDITOR_SAVE_MS * 10);
    assert.equal(r.saves, 1, "a failure cannot spin or repeatedly save");
    if (reason.endsWith("failure")) assert.match(r.logs[0], /decision=deferred reason=save_failed/);
  });
}

test("IME, disabled sync, large notes and disagreeing panes retain native autosave", async (t) => {
  const r = fixture(t);
  r.input("compositionstart"); await r.tick(); assert.equal(r.saves, 0);
  r.input("beforeinput"); await r.tick(); assert.equal(r.saves, 0);
  assert.equal(await r.ready(), false);
  r.input("compositionend"); await r.tick(); assert.equal(r.saves, 1);
  r.enabled = false; r.input(); await r.tick(); assert.equal(r.saves, 1);
  r.enabled = true; r.text = "x".repeat(EDITOR_SAVE_MAX_CHARS + 1);
  r.input(); await r.tick(); assert.equal(r.saves, 1);
  r.text = "local";
  r.views.push({ file: r.view.file, getViewData: () => "other" });
  r.input(); await r.tick(); assert.equal(r.saves, 1);
});

test("stop cancels timers and invalidates completed receipts", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick(); assert.equal(await r.ready(), true);
  r.activity.stop(); assert.equal(await r.ready(), false);
  r.input(); r.activity.stop(); await r.tick(); assert.equal(r.saves, 1);
});

test("the final disk comparison rejects new input, rebinding and newly opened panes", async (t) => {
  const r = fixture(t);
  for (const change of [() => r.input(), () => { r.view.file = { path: "Notes/test.md" }; },
    () => r.views.push({ file: r.view.file, getViewData: () => r.text })]) {
    r.input(); await r.tick();
    r.read = async () => { change(); return r.disk; };
    assert.equal(await r.ready(), false);
    r.read = async () => r.disk;
    r.views = [r.view];
  }
});

test("a verified incoming refresh advances only an existing valid receipt", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  r.text = r.disk = "local plus peer";
  assert.equal(await r.ready(), false);
  r.activity.expectRefresh(r.view, "wrong", r.text);
  assert.equal(await r.ready(), false);
  r.activity.expectRefresh(r.view, "local", r.text);
  assert.equal(await r.ready(), true);
  r.input(); r.activity.expectRefresh(r.view, "local plus peer", r.text);
  assert.equal(await r.ready(), false);
});

test("a reload has one owner and blocks saves until the native buffer includes it", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  const release = r.activity.holdReload("Notes/test.md");
  assert.equal(typeof release, "function");
  assert.equal(r.activity.holdReload("Notes/test.md"), null);
  assert.equal(await r.ready(), false);
  r.text = "local with new keystroke"; r.input(); await r.tick();
  assert.equal(r.saves, 1);
  r.text = "local with new keystroke and peer";
  release(true); await r.tick();
  assert.equal(r.saves, 2);
  assert.equal(r.disk, r.text);
  const next = r.activity.holdReload("Notes/test.md");
  release(true);
  assert.equal(await r.ready(), false, "an old release cannot clear the next reload");
  next(true);
});

test("a failed native reload disables extra saves for only that view and file", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  const release = r.activity.holdReload("Notes/test.md");
  release(false); r.input(); await r.tick();
  assert.equal(r.saves, 1);
  assert.equal(await r.ready(), false);
  r.view.file = { path: "Notes/test.md" };
  r.input(); await r.tick(); assert.equal(r.saves, 2);
});

test("reload and new input during the final input check invalidate write readiness", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  assert.equal(await r.activity.ready("Notes/test.md", async () => false), false);
  assert.equal(await r.activity.ready("Notes/test.md", async () => { r.input(); return true; }), false);
  await r.tick();
  let release;
  assert.equal(await r.activity.ready("Notes/test.md", async () => { release = r.activity.holdReload("Notes/test.md"); return true; }), false);
  release(true);
});

test("a pending native reload finishes before save clears dirty input", async (t) => {
  const r = fixture(t), order = [];
  let dirty = true, pendingReload = true;
  r.disk = "old"; r.text = "old plus keystroke";
  r.read = async () => {
    if (pendingReload) {
      pendingReload = false;
      await Promise.resolve();
      order.push("native_reload");
      if (!dirty) r.text = "old";
    }
    order.push("read"); return r.disk;
  };
  r.view.save = async () => {
    order.push("save"); dirty = false; r.saves++;
    r.disk = r.text;
  };
  r.input(); await r.tick();
  assert.deepEqual(order, ["native_reload", "read", "save", "read"]);
  assert.equal(r.text, "old plus keystroke");
  assert.equal(r.disk, r.text);
  assert.equal(await r.ready(), true);
});


test("a completed saved snapshot remains publishable during later unsaved input, without granting write readiness", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), true);
  r.text = "local newer"; r.input();
  assert.equal(await r.ready(), false);
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), true);
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local newer"), false);
  await r.tick();
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local newer"), true);
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), false);
});

for (const reason of ["rebound", "closed", "disabled", "stop", "failed_refresh"]) test(`a saved snapshot cannot outlive ${reason}`, async (t) => {
  const r = fixture(t); r.input(); await r.tick();
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), true);
  if (reason === "rebound") r.view.file = { path: "Notes/test.md" };
  if (reason === "closed") r.views = [];
  if (reason === "disabled") r.enabled = false;
  if (reason === "stop") r.activity.stop();
  if (reason === "failed_refresh") r.activity.holdReload("Notes/test.md")(false);
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), false);
});


test("new typing in a rebound view cannot authorize the previous file's saved snapshot", async (t) => {
  const r = fixture(t); r.input(); await r.tick();
  r.view.file = { path: "Notes/test.md" };
  r.input();
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), false);
  assert.equal(await r.ready(), false);
});
