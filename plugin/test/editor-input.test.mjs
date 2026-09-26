/** #179: an open passive Markdown view is distinct from real editor input. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { memorySecrets, sandbox } from "./fake.mjs";

function surface() {
  const handlers = new Map();
  return { handlers, addEventListener(type, fn) {
    const entries = handlers.get(type) ?? []; entries.push(fn); handlers.set(type, entries);
  }, emit(type, target, isTrusted = true) {
    for (const fn of handlers.get(type) ?? []) fn({ type, target, isTrusted });
  } };
}

async function fixture(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost, default: Plugin } = box.require(join(box.home, "build/main.js"));
  const { MarkdownView } = box.require("obsidian");
  const { EDITING_WINDOW_MS } = box.require(join(box.home, "build/sync/pull.js"));
  const main = surface(), popout = surface(), leaves = [], registered = [], hooks = new Map();
  const instance = new Plugin();
  instance.loadData = async () => null;
  instance.saveData = async () => {};
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText() {} });
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: {
    on: (event, callback) => { hooks.set(event, callback); return {}; },
    getLeavesOfType: () => leaves, onLayoutReady: (ready) => ready(),
  } };
  instance.manifest = { version: "1.1.3" };
  instance.checkForUpdate = async () => {};
  instance.log = () => {};
  instance.registerDomEvent = (win, type, fn, capture) => { registered.push({ win, type, capture }); win.addEventListener(type, fn); };
  const host = new ObsidianHost(instance, null);
  let now = 20_000;
  const realNow = Date.now, realWindow = globalThis.window;
  Date.now = () => now; globalThis.window = main;
  t.after(() => { Date.now = realNow; globalThis.window = realWindow; instance.onunload(); });
  function view(path, win = main) {
    const node = { nodeType: 1 };
    const view = Object.assign(new MarkdownView(), { file: { path }, containerEl: {
      contains: (target) => { if (target !== null && !target?.nodeType) throw new TypeError("contains needs a DOM Node"); return target === node; }, ownerDocument: { defaultView: win },
    } });
    leaves.push({ view }); return { view, node };
  }
  return { host, instance, main, popout, leaves, hooks, view, registered, window: EDITING_WINDOW_MS,
    advance: (ms) => { now += ms; } };
}

for (const type of ["keydown", "beforeinput"]) test(`${type} protects saved typing, then expires; a passive view is not typing`, async (t) => {
  const r = await fixture(t), a = r.view("Notes/a.md"), b = r.view("Notes/b.md");
  r.host.trackInput(r.main);
  assert.equal(r.host.typing("Notes/a.md"), false);
  r.main.emit(type, a.node);
  assert.equal(r.host.typing("Notes/a.md"), true);
  assert.equal(r.host.typing("Notes/b.md"), false);
  r.advance(r.window - 1);
  assert.equal(r.host.typing("Notes/a.md"), true, "saved debounce stays protected");
  r.advance(1);
  assert.equal(r.host.typing("Notes/a.md"), false, "an old input cannot exempt a plugin forever");
  r.main.emit(type, b.node);
  assert.equal(r.host.typing("Notes/b.md"), true);
});

test("IME remains typing beyond the save window, then compositionend starts the save allowance", async (t) => {
  const r = await fixture(t), a = r.view("Notes/a.md");
  r.host.trackInput(r.main);
  r.main.emit("compositionstart", a.node);
  r.advance(r.window * 3);
  assert.equal(r.host.typing("Notes/a.md"), true);
  r.main.emit("compositionend", a.node);
  assert.equal(r.host.typing("Notes/a.md"), true);
  r.advance(r.window);
  assert.equal(r.host.typing("Notes/a.md"), false);
});

test("focusout ends a cancelled composition but does not manufacture input in a passive view", async (t) => {
  const r = await fixture(t), a = r.view("Notes/a.md");
  r.host.trackInput(r.main);
  r.main.emit("focusout", a.node);
  assert.equal(r.host.typing("Notes/a.md"), false);
  r.main.emit("compositionstart", a.node);
  r.advance(r.window * 3);
  r.main.emit("focusout", a.node);
  assert.equal(r.host.typing("Notes/a.md"), true);
  r.advance(r.window);
  assert.equal(r.host.typing("Notes/a.md"), false);
});

test("synthetic input, unrelated nodes, missing targets and non-Markdown leaves do not claim typing", async (t) => {
  const r = await fixture(t), a = r.view("Notes/a.md");
  r.host.trackInput(r.main);
  r.main.emit("beforeinput", a.node, false);
  assert.equal(r.host.typing("Notes/a.md"), false, "plugin dispatch is not physical input");
  r.main.emit("beforeinput", null);
  r.main.emit("beforeinput", {});
  r.main.emit("beforeinput", { nodeType: 1 });
  assert.equal(r.host.typing("Notes/a.md"), false, "other UI is not this editor");
  const empty = r.view("Notes/empty.md");
  empty.view.file = null;
  r.main.emit("beforeinput", empty.node);
  assert.equal(r.host.typing("Notes/empty.md"), false);
  r.leaves.splice(0, 1, { view: { file: { path: "Notes/a.md" }, containerEl: { contains: () => { throw new Error("deferred view read"); } } } });
  r.main.emit("beforeinput", a.node);
  assert.equal(r.host.typing("Notes/a.md"), false);
});

test("input tracks the view's current file, all windows, and has one listener per window", async (t) => {
  const r = await fixture(t), a = r.view("Notes/a.md", r.popout);
  r.host.trackInput(r.main); r.host.trackInput(r.popout); r.host.trackInput(r.popout);
  assert.ok([...r.popout.handlers.values()].every((handlers) => handlers.length === 1));
  assert.ok(r.registered.every(({ capture }) => capture === true), "CodeMirror may stop bubbling");
  r.popout.emit("beforeinput", a.node);
  assert.equal(r.host.typing("Notes/a.md"), true);
  // A view switched to a different file must not carry the previous file's input.
  a.view.file = { path: "Notes/b.md" };
  assert.equal(r.host.typing("Notes/a.md"), false);
  assert.equal(r.host.typing("Notes/b.md"), false);
  a.view.file = { path: "Notes/a.md" };
  r.popout.emit("compositionstart", a.node);
  a.view.file = { path: "Notes/b.md" };
  assert.equal(r.host.typing("Notes/b.md"), false, "an old file's composition does not protect the new file");
});

test("onload binds the primary window, pre-existing popouts, and newly opened windows", async (t) => {
  const r = await fixture(t), a = r.view("Notes/a.md", r.popout);
  await r.instance.onload(); await r.instance.firstStart;
  assert.equal(r.main.handlers.get("beforeinput")?.length, 1);
  assert.equal(r.popout.handlers.get("beforeinput")?.length, 1);
  r.popout.emit("beforeinput", a.node);
  assert.equal(r.instance.host.typing("Notes/a.md"), true);
  const opened = surface(), b = r.view("Notes/b.md", opened);
  r.hooks.get("window-open")({}, opened);
  opened.emit("beforeinput", b.node);
  assert.equal(r.instance.host.typing("Notes/b.md"), true);
});
