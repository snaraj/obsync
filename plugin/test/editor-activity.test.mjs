import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
const { EditorActivity, EDITOR_SAVE_MS, EDITOR_SAVE_WAIT_MS, EDITOR_SAVE_MAX_CHARS } = createRequire(import.meta.url)("../build/editorActivity.js");

const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = { text: "local", disk: "local", enabled: true, saves: 0, notifications: [], logs: [], armed: new Set() };
  r.view = { file: { path: "Notes/test.md" }, getViewData: () => r.text, save: async () => { r.saves++; r.disk = r.text; } };
  r.views = [r.view];
  r.read = async () => r.disk;
  r.activity = new EditorActivity({
    views: (path) => r.views.filter((view) => view.file?.path === path),
    read: (file) => r.read(file), enabled: () => r.enabled,
    saved: (path) => r.notifications.push(path), log: (line) => r.logs.push(line),
  }, { set: (fn, ms) => {
    const handle = setTimeout(() => { r.armed.delete(handle); fn(); }, ms);
    r.armed.add(handle); return handle;
  }, clear: (handle) => { r.armed.delete(handle); clearTimeout(handle); } });
  r.input = (kind = "beforeinput") => r.activity.record(r.view, kind);
  r.ready = () => r.activity.ready("Notes/test.md");
  r.tick = async (ms = EDITOR_SAVE_MS) => { t.mock.timers.tick(ms); await drain(); };
  t.after(() => r.activity.stop());
  return r;
}

test("input revisions change only with text input and survive native saves and reloads", async (t) => {
  const r = fixture(t), path = r.view.file.path;
  assert.equal(r.activity.revision(path), undefined);
  r.input("keydown");
  assert.equal(r.activity.revision(path), undefined, "navigation is not text progress");
  r.input();
  const first = r.activity.revision(path);
  assert.deepEqual(first, {}, "the identity contains no input or note data");
  await r.tick();
  r.activity.expectRefresh(r.view, r.text, "remote");
  r.activity.holdReload(path)("confirmed");
  for (const kind of ["keydown", "compositionstart", "compositionend", "focusout"]) r.input(kind);
  assert.equal(r.activity.revision(path), first, "save, reload and composition bookkeeping are not new text input");
  r.input();
  assert.notEqual(r.activity.revision(path), first);
});

for (const reason of ["disabled", "closed", "rebound", "stopped", "other_path"]) {
  test(`input revisions do not outlive ${reason}`, (t) => {
    const r = fixture(t), path = r.view.file.path;
    r.input();
    assert.notEqual(r.activity.revision(path), undefined);
    if (reason === "disabled") r.enabled = false;
    if (reason === "closed") r.views = [];
    if (reason === "rebound") r.view.file = { path };
    if (reason === "stopped") r.activity.stop();
    assert.equal(r.activity.revision(reason === "other_path" ? "Other.md" : path), undefined);
  });
}

for (const phase of ["scheduled", "saving"]) test(`readiness joins the ${phase} save without polling or a second save`, async (t) => {
  const r = fixture(t);
  let release;
  if (phase === "saving") r.view.save = async () => { r.saves++; await new Promise(resolve => { release = resolve; }); r.disk = r.text; };
  r.input();
  if (phase === "saving") await r.tick();
  let reads = 0, settled = false;
  r.read = async () => { reads++; return r.disk; };
  const ready = r.activity.settle("Notes/test.md").then(value => { settled = true; return value; });
  await drain();
  assert.equal(settled, false);
  assert.equal(reads, 0, "waiting must not occupy the native adapter queue");
  if (phase === "scheduled") await r.tick();
  else { release(); await drain(); }
  assert.equal(settled, true, "completion wakes the waiting reconciliation immediately");
  assert.equal(await ready, true);
  assert.equal(r.saves, 1);
  assert.equal(r.activity.saveWaiters.size, 0);
  assert.equal(r.armed.size, 0, "early completion cancels the deadline timer");
  assert.match(r.logs.at(-1), /^editor decision=ready reason=save_completion duration_ms=\d+ budget_ms=100$/);
  assert.equal(r.activity.recent(r.view), true, "no idle-input wait");
});

for (const reason of ["composition", "disabled", "reloading", "no_pending_save"]) {
  test(`readiness does not wait for ${reason}`, async (t) => {
    const r = fixture(t);
    r.input();
    if (reason === "composition") r.input("compositionstart");
    if (reason === "disabled") r.enabled = false;
    if (reason === "reloading") r.activity.holdReload("Notes/test.md");
    if (reason === "no_pending_save") r.activity.stop();
    let result;
    void r.activity.settle("Notes/test.md").then(value => { result = value; });
    await drain();
    assert.equal(result, false);
    assert.equal(r.activity.saveWaiters.size, 0);
  });
}

test("save completion waits have a fixed deadline and no wake or timer residue", async (t) => {
  const r = fixture(t); let release;
  r.view.save = async () => { r.saves++; await new Promise(resolve => { release = resolve; }); r.disk = r.text; };
  r.input(); await r.tick();
  let settled = false;
  const ready = r.activity.settle("Notes/test.md").then(value => { settled = true; return value; });
  await drain();
  await r.tick(EDITOR_SAVE_WAIT_MS - 1); assert.equal(settled, false);
  await r.tick(1); assert.equal(settled, true, "the original deadline cannot move");
  assert.equal(await ready, false);
  assert.equal(r.activity.saveWaiters.size, 0);
  assert.match(r.logs.at(-1), /^editor decision=deferred reason=save_completion duration_ms=\d+ budget_ms=100$/);
  release(); await drain();
  assert.equal(await r.ready(), true, "timeout did not disable the later valid save");
  assert.equal(r.saves, 1);
});

test("an already saved editor needs neither a wait nor another save", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  assert.equal(await r.activity.settle("Notes/test.md"), true);
  assert.equal(r.saves, 1);
  assert.equal(r.armed.size, 0);
  assert.equal(r.activity.saveWaiters.size, 0);
});

for (const reason of ["stopped", "disabled", "rebound", "closed", "new_pane", "composition", "failed", "wrong_disk", "new_input"]) {
  test(`save completion cannot admit ${reason}`, async (t) => {
    const r = fixture(t); let release;
    r.view.save = async () => { r.saves++; await new Promise(resolve => { release = resolve; });
      if (reason === "failed") throw Error("synthetic save failure");
      r.disk = reason === "wrong_disk" ? "other bytes" : r.text;
    };
    r.input(); await r.tick();
    const ready = r.activity.settle("Notes/test.md"); await drain();
    if (reason === "stopped") r.activity.stop();
    if (reason === "disabled") r.enabled = false;
    if (reason === "rebound") r.view.file = { path: "Notes/test.md" };
    if (reason === "closed") r.views = [];
    if (reason === "new_pane") r.views.push({ file: r.view.file, getViewData: () => r.text });
    if (reason === "composition") r.input("compositionstart");
    if (reason === "new_input") { r.text += " newer"; r.input(); }
    release(); await drain();
    await r.tick(EDITOR_SAVE_WAIT_MS);
    assert.equal(await ready, false);
    assert.equal(r.activity.saveWaiters.size, 0);
    assert.equal(r.notifications.length, reason === "new_pane" ? 1 : 0,
      "a valid local save may complete, but a changed pane set still refuses the waiting write");
  });
}

test("continuous input cannot extend the save completion deadline", async (t) => {
  assert.equal(EDITOR_SAVE_WAIT_MS, 100, "native readiness wait has a fixed bounded contract");
  const r = fixture(t); let release;
  r.view.save = async () => { r.saves++; await new Promise(resolve => { release = resolve; }); };
  r.input(); await r.tick();
  let settled = false;
  const ready = r.activity.settle("Notes/test.md").then(value => { settled = true; return value; }); await drain();
  for (let i = 0; i < 20; i++) { r.input(); await r.tick(EDITOR_SAVE_WAIT_MS / 20); }
  assert.equal(settled, true, "continuous input cannot keep a waiter alive");
  assert.equal(await ready, false);
  assert.equal(r.activity.saveWaiters.size, 0);
  r.activity.stop(); release(); await drain();
});

test("stopping releases all simultaneous save waiters before the save finishes", async (t) => {
  const r = fixture(t); let release;
  r.view.save = async () => { await new Promise(resolve => { release = resolve; }); };
  r.input(); await r.tick();
  const waits = [r.activity.settle("Notes/test.md"), r.activity.settle("Notes/test.md")];
  await drain(); assert.equal(r.activity.saveWaiters.size, 2);
  r.activity.stop();
  assert.equal(r.activity.saveWaiters.size, 0, "stop wakes waiters synchronously");
  assert.deepEqual(await Promise.all(waits), [false, false]);
  assert.equal(r.activity.saveWaiters.size, 0);
  release(); await drain();
});

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

for (const reason of ["dirty", "composition", "saving", "buffer_changed", "stale_receipt"]) {
  test(`known ${reason} input refuses readiness without queuing a native read`, async (t) => {
    const r = fixture(t);
    r.input(); await r.tick();
    if (reason === "dirty") r.input();
    if (reason === "composition") r.input("compositionstart");
    if (reason === "buffer_changed") r.text += "new input";
    if (reason === "stale_receipt") r.activity.stop();
    let release;
    if (reason === "saving") {
      r.view.save = () => new Promise(resolve => { release = resolve; });
      r.input(); await r.tick();
      const now = Date.now();
      t.mock.method(Date, "now", () => now + 11_000);
    }
    r.read = async () => { throw Error("busy readiness queued a native read"); };
    assert.equal(await r.ready(), false);
    r.read = async () => r.disk;
    release?.(); await drain();
  });
}

for (const reason of ["composition", "disabled", "stopped", "rebound", "native_only"]) {
  test(`the refresh bridge refuses ${reason} save ownership`, async (t) => {
    const r = fixture(t);
    r.input();
    assert.equal(r.activity.canRefresh(r.view), true);
    if (reason === "composition") r.input("compositionstart");
    if (reason === "disabled") r.enabled = false;
    if (reason === "stopped") r.activity.stop();
    if (reason === "rebound") r.view.file = { path: "Notes/test.md" };
    if (reason === "native_only") r.activity.holdReload("Notes/test.md")("unconfirmed");
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
  release("confirmed"); await r.tick();
  assert.equal(r.saves, 2);
  assert.equal(r.disk, r.text);
  const next = r.activity.holdReload("Notes/test.md");
  release("confirmed");
  assert.equal(await r.ready(), false, "an old release cannot clear the next reload");
  next("confirmed");
});

test("a failed native reload disables extra saves for only that view and file", async (t) => {
  const r = fixture(t);
  r.input(); await r.tick();
  const release = r.activity.holdReload("Notes/test.md");
  release("unconfirmed"); r.input(); await r.tick();
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
  release("confirmed");
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
  if (reason === "failed_refresh") r.activity.holdReload("Notes/test.md")("unconfirmed");
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), false);
});


test("new typing in a rebound view cannot authorize the previous file's saved snapshot", async (t) => {
  const r = fixture(t); r.input(); await r.tick();
  r.view.file = { path: "Notes/test.md" };
  r.input();
  assert.equal(r.activity.savedSnapshot("Notes/test.md", "local"), false);
  assert.equal(await r.ready(), false);
});


for (const state of ["saved", "typing", "composition", "native_only", "rebound", "stopped"]) {
  test(`superseded reload releases only eligible save ownership (${state})`, async (t) => {
    const r = fixture(t);
    r.input(); await r.tick();
    if (state === "native_only") r.activity.holdReload("Notes/test.md")("unconfirmed");
    const release = r.activity.holdReload("Notes/test.md");
    if (state === "typing") { r.text += " new input"; r.input(); }
    if (state === "composition") { r.text += " unfinished"; r.input("compositionstart"); }
    if (state === "rebound") r.view.file = { path: "Notes/elsewhere.md" };
    if (state === "stopped") r.activity.stop();
    release("superseded");
    if (state === "saved") assert.equal(await r.ready(), false, "supersession revokes the old receipt before resaving");
    await r.tick();
    const eligible = state === "saved" || state === "typing";
    assert.equal(r.saves, eligible ? 2 : 1);
    assert.equal(r.notifications.length, eligible ? 2 : 1);
    if (eligible) {
      assert.equal(await r.ready(), true);
      assert.equal(r.activity.canRefresh(r.view), true);
      assert.equal(r.disk, r.text);
    }
    if (state !== "stopped") assert.ok(r.logs.some(line => /^editor decision=reload_released outcome=superseded views=1 duration_ms=\d+ budget_ms=0$/.test(line)));
    const next = r.activity.holdReload("Notes/test.md");
    release("confirmed");
    assert.equal(r.activity.reloading.has("Notes/test.md"), true, "a stale release cannot clear a later hold");
    next("confirmed");
  });
}
