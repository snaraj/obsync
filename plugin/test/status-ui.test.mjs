/**
 * What the person sees of the status (#156, #182, #209, and the owner's
 * 2026-09-26 requirement): one icon of one fixed width that never flickers
 * while typing, whose words are its tooltip; a click that opens Show sync
 * status, which stays true while open and offers the next step; commands the
 * palette finds under "obsync"; a Sync now that always answers; and, on a
 * phone, the same indicator in the header of the view in front.
 *
 * WHAT IS EXERCISED. The real indicator, plugin class and dialog, over the
 * sandbox's non-rendering Obsidian stub: an icon is a recorded name, a
 * tooltip a recorded string, a timer a row in a table the test fires.
 * Pixels, the turning wheel and Reduce Motion are the rig's to prove
 * (REPORT, live validation).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KEYS, memorySecrets, sandbox, statusItem } from "./fake.mjs";

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };

/** A renderer `window` whose timers fire only when the test moves the clock. */
function clockWindow() {
  let now = 0, next = 1;
  const timers = new Map();
  const listeners = new Map();
  return {
    now: () => now,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener() {},
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}

function box(t) {
  const made = sandbox();
  t.after(() => rmSync(made.home, { recursive: true, force: true }));
  const win = clockWindow();
  const previous = globalThis.window;
  globalThis.window = win;
  t.after(() => { globalThis.window = previous; });
  return { ...made, win, obsidian: made.require("obsidian") };
}

// --- the indicator ---------------------------------------------------------

test("one icon in one fixed-width box in every state: no text node, the words are its tooltip", (t) => {
  const b = box(t);
  const { Indicator } = b.require(join(b.home, "build/ui/indicator.js"));
  const indicator = new Indicator(b.win.now);
  const el = statusItem();
  indicator.attach(el);
  const seen = [];
  for (const [state, icon] of [["synced", "check"], ["offline", "cloud-off"], ["attention", "circle-alert"],
    ["paused", "circle-pause"], ["quiet", "cloud"], ["synced", "check"]]) {
    indicator.update(state, `obsync: ${state} SENTINEL`);
    assert.equal(el.attributes["data-state"], state, "shown at once: nothing but syncing waits");
    assert.equal(el.icon, icon);
    assert.deepEqual(el.children, [{ svg: icon }], "the icon is its one child");
    assert.equal(el.label, `obsync: ${state} SENTINEL`);
    seen.push([...el.classes].sort().join(" "));
  }
  assert.deepEqual(el.texts, [], "never a text node: the width cannot follow the words");
  assert.deepEqual(new Set(seen), new Set(["mod-clickable obsync-status"]), "the same classes, so the same width, in every state");
});

test("a burst of saves that each sync in under half a second never shows the wheel (owner, 2026-09-26)", (t) => {
  const b = box(t);
  const { Indicator, SYNCING_AFTER_MS } = b.require(join(b.home, "build/ui/indicator.js"));
  const indicator = new Indicator(b.win.now);
  const el = statusItem();
  indicator.attach(el);
  indicator.update("synced", "obsync: idle");
  const states = [];
  for (let save = 0; save < 20; save++) {
    indicator.update("syncing", "obsync: syncing 1");
    b.win.advance(SYNCING_AFTER_MS - 200);
    states.push(el.attributes["data-state"]);
    indicator.update("synced", "obsync: idle");
    b.win.advance(200);
    states.push(el.attributes["data-state"]);
  }
  b.win.advance(5000);
  assert.deepEqual(new Set(states), new Set(["synced"]), "a check throughout, however fast the typing");
  assert.equal(el.attributes["data-state"], "synced");
  assert.ok(!el.tooltips.includes("obsync: syncing 1"), "and the words did not flicker either");
});

test("a transfer shows the wheel once it has run half a second, and holds it long enough to be seen", (t) => {
  const b = box(t);
  const { Indicator, SYNCING_AFTER_MS, SYNCING_HOLD_MS } = b.require(join(b.home, "build/ui/indicator.js"));
  const indicator = new Indicator(b.win.now);
  const el = statusItem();
  indicator.attach(el);
  indicator.update("synced", "obsync: idle");
  indicator.update("syncing", "obsync: syncing 3");
  // A page counted down note by note: the half second runs from the first
  // moment of work, not from the latest count, or a long pull never shows.
  b.win.advance(300);
  indicator.update("syncing", "obsync: syncing 2");
  b.win.advance(SYNCING_AFTER_MS - 300 - 1);
  assert.equal(el.attributes["data-state"], "synced", "not before half a second of work");
  b.win.advance(1);
  assert.equal(el.attributes["data-state"], "syncing");
  assert.equal(el.label, "obsync: syncing 2", "with the words that are true when it shows");
  indicator.update("syncing", "obsync: syncing 1");
  assert.equal(el.label, "obsync: syncing 1", "the count moves at once while the wheel shows");
  indicator.update("synced", "obsync: idle");
  b.win.advance(SYNCING_HOLD_MS - 1);
  assert.equal(el.attributes["data-state"], "syncing", "held, so a short transfer is not a flash");
  b.win.advance(1);
  assert.equal(el.attributes["data-state"], "synced");
  // Absence and a refusal never wait.
  indicator.update("syncing", "obsync: syncing 1");
  b.win.advance(SYNCING_AFTER_MS);
  indicator.update("offline", "obsync: offline — retrying");
  assert.equal(el.attributes["data-state"], "offline");
});

test("the stylesheet gives the indicator one width in every state, and Reduce Motion stops the wheel", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const base = rules.find((rule) => rule.selector.endsWith(".obsync-status"));
  assert.ok(base, "the indicator's own rule");
  for (const property of ["width", "min-width", "max-width"]) {
    assert.match(base.body, new RegExp(`(^|[\\s;])${property}:\\s*2em;`), property);
  }
  for (const rule of rules.filter((candidate) => candidate !== base && candidate.selector.includes(".obsync-status["))) {
    assert.doesNotMatch(rule.body, /(^|[\s;])(width|min-width|max-width|padding|margin|font-size)\s*:/,
      `${rule.selector} changes only colour or motion, never the box`);
  }
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"), "a Reduce Motion rule");
  assert.match(reduced, /\.obsync-status\[data-state="syncing"\] svg\s*\{\s*animation:\s*none;/);
  assert.match(css, /animation:\s*obsync-turn\s+1\.[5-9]s\s+linear\s+infinite;/, "one slow turn in 1.5 to 2 seconds");
  for (const rule of rules.filter((candidate) => candidate.selector.includes(".obsync-status"))) {
    for (const [, value] of rule.body.matchAll(/(?:^|[\s;])color:\s*([^;]+);/g)) assert.match(value, /^var\(--[a-z-]+\)$/, "the theme's colours only");
  }
});

// --- the plugin: click, commands, Sync now, a phone ------------------------

async function plugin(t, { mobile = false, view = null, data = null } = {}) {
  const b = box(t);
  b.obsidian.Platform.isMobile = mobile;
  t.after(() => { b.obsidian.Platform.isMobile = false; });
  const Plugin = b.require(join(b.home, "build/main.js")).default;
  const { ApiError } = b.require(join(b.home, "build/transport.js"));
  let sent = 0;
  let verified = { checked: 0, sent: 0 };
  b.require(join(b.home, "build/sync/engine.js")).SyncEngine = class {
    constructor(options) { this.options = options; }
    get context() { return { state: this.options.state }; }
    async start() {}
    stop() {}
    async stopAndWait() {}
    async syncNow() { return sent; }
    async verifyAll() { return verified; }
    wake() {}
    current() { return { kind: "idle" }; }
  };
  const instance = new Plugin();
  const load = instance.onload.bind(instance);
  instance.onload = async () => { await load(); await instance.firstStart; };
  const commands = [], hooks = new Map(), item = statusItem();
  const views = { active: view };
  instance.loadData = async () => data ?? ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid", edgeHeaders: [] });
  instance.saveData = async () => {};
  instance.addCommand = (command) => commands.push(command);
  instance.addSettingTab = instance.registerObsidianProtocolHandler = () => {};
  instance.registerEvent = () => {};
  instance.addStatusBarItem = () => item;
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: {
    on: (event, fn) => { hooks.set(event, fn); return {}; }, getLeavesOfType: () => [], onLayoutReady: (listed) => listed(),
    getActiveViewOfType: () => views.active,
  } };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.4" };
  instance.checkForUpdate = async () => {};
  instance.log = () => {};
  t.after(() => instance.onunload());
  await instance.onload();
  return { ...b, instance, commands, hooks, item, views, ApiError, sending: (count) => { sent = count; }, verifying: (found) => { verified = found; } };
}

/** A view whose header takes actions, as `ItemView.addAction` does. */
function header(obsidian) {
  const view = new obsidian.ItemView();
  view.actions = [];
  view.addAction = (icon, title, callback) => {
    const el = statusItem();
    el.addEventListener("click", callback);
    view.actions.push({ icon, title, el });
    return el;
  };
  return view;
}

test("clicking the indicator opens Show sync status (#156)", async (t) => {
  const p = await plugin(t);
  let opened = 0;
  p.instance.showStatus = () => { opened++; };
  p.item.click();
  assert.equal(opened, 1);
  assert.ok(p.item.classes.has("mod-clickable"), "and it looks like something to click");
});

test("the palette finds every command under 'obsync', and their ids have not changed (#156)", async (t) => {
  const p = await plugin(t);
  assert.deepEqual(p.commands.map((command) => command.id), ["sync-now", "verify-all", "export-copy", "restore-history", "pair-device", "pair-this-device", "show-recovery-phrase",
    "open-dashboard", "open-setup-guide", "remote-only", "status", "leave-server", "switch-server",
    "notices-everything", "notices-needs-me", "merges-once", "merges-every", "merges-off", "recent"]);
  for (const command of p.commands) assert.match(command.name, /obsync/, command.name);
  assert.equal(p.commands.find((command) => command.id === "status").name, "Show sync status (obsync)");
});

/*
 * A FRESH DEVICE FINDS ITS WAY IN FROM THE PALETTE (issue #154): searching
 * "pair" listed only Pair a new device, the command for the device that
 * already syncs. Pair this device opens the dialog that takes the code; on a
 * device that syncs already it opens nothing and says why, and where to go.
 */
test("Pair this device in the palette opens the code dialog, and on a device that syncs only says so (#154)", async (t) => {
  for (const syncing of [false, true]) {
    const p = await plugin(t, syncing ? {} : { data: { serverUrl: "https://sync.example.invalid", edgeHeaders: [] } });
    const opened = [], logs = [];
    p.obsidian.Modal.prototype.open = function open() { opened.push(this.constructor.name); };
    p.instance.log = (line) => logs.push(line);
    const before = p.obsidian.notices.length;
    const command = p.commands.find((candidate) => candidate.id === "pair-this-device");
    assert.equal(command.name, "Pair this device (obsync)");
    command.callback();
    if (!syncing) {
      assert.deepEqual(opened, ["PairClaimModal"], "a fresh device did not get the code dialog");
      assert.deepEqual(p.obsidian.notices.slice(before), []);
      continue;
    }
    assert.deepEqual(opened, [], "a device that syncs opened the code dialog");
    assert.deepEqual(p.obsidian.notices.slice(before), [
      `obsync: This device already syncs with https://sync.example.invalid as "${p.instance.deviceName()}", so nothing was claimed. ` +
        "To add another device, choose Pair a new device here. To pair this one again, use Leave this server in obsync's settings first.",
    ]);
    assert.deepEqual(logs, ["pairing role=claimant decision=refused reason=already_paired source=palette", "notice decision=shown kind=confirm stays_ms=10250"]);
  }
});

test("Sync now always answers once: sent, nothing to send, or the server not answering (#182)", async (t) => {
  const p = await plugin(t);
  const notices = () => p.obsidian.notices.filter((notice) => notice.startsWith("obsync:"));
  // Each press below comes after the last answer went: read, or its time up.
  const press = async (everything) => { for (const toast of p.obsidian.raised) toast.hide(); await p.instance.syncNow(everything); };
  p.sending(2);
  await press();
  assert.deepEqual(notices(), ["obsync: sent 2 changes."]);
  p.sending(0);
  await press();
  assert.equal(notices().at(-1), "obsync: nothing to send; this device is up to date.");
  // Deletions still held back: the engine's question about them answers the
  // press (#172), and "up to date" beside it was false (the rig, 2026-09-27).
  p.instance.state.data.heldDeletions = ["Notes/gone.md"];
  const holding = notices().length;
  await press();
  assert.deepEqual(notices().slice(holding), [], "up to date, beside deletions it still holds back");
  p.sending(2);
  await press();
  assert.deepEqual(notices().slice(holding), ["obsync: sent 2 changes."]);
  p.instance.state.data.heldDeletions = [];
  p.sending(0);
  // The server stops answering: the press answers at once, and only once.
  p.instance.transport.options.reachable(false);
  const before = notices().length;
  await press();
  assert.deepEqual(notices().slice(before), ["obsync: Your server is not answering. Sync resumes by itself when it is back."]);
});

test("presses in a row with the same answer are one toast that counts them, never a stack (lab L, 1.1.5)", async (t) => {
  // Seen live: twenty-nine presses of Sync now stacked twenty-nine "nothing to send" toasts.
  const p = await plugin(t);
  // Under the quietest settings: the answer to a press is always said.
  p.instance.state.data.notices = { level: "needs-me", merges: "off" };
  const answers = () => p.obsidian.raised.filter((toast) => toast.message.startsWith("obsync: nothing to send"));
  p.sending(0);
  for (let pressed = 1; pressed <= 20; pressed++) await p.instance.syncNow();
  assert.equal(answers().length, 1, "one toast");
  assert.equal(answers()[0].message, "obsync: nothing to send; this device is up to date (20 times).");
  assert.equal(answers()[0].hidden, false);
  // Another answer is a toast of its own; the same one once that toast went is a new one.
  p.sending(2);
  await p.instance.syncNow();
  assert.equal(p.obsidian.raised.at(-1).message, "obsync: sent 2 changes.");
  answers()[0].hide();
  p.sending(0);
  await p.instance.syncNow();
  assert.equal(answers().length, 2);
  assert.equal(answers()[1].message, "obsync: nothing to send; this device is up to date.");
  // Recent counts them as the toast did, so fifty presses never push a warning out of it.
  assert.deepEqual(p.instance.notices.recent().filter((entry) => entry.text.startsWith("nothing to send")).map((entry) => entry.text),
    ["nothing to send; this device is up to date.", "nothing to send; this device is up to date (20 times)."], "Recent has every answer, counted");
});

test("Verify all files is its own command and answers once with what it checked and found (#197)", async (t) => {
  const p = await plugin(t);
  const notices = () => p.obsidian.notices.filter((notice) => notice.startsWith("obsync:"));
  const verify = p.commands.find((command) => command.id === "verify-all");
  assert.equal(verify.name, "Verify all files (obsync)");
  // Each press below comes after the last answer went: read, or its time up.
  const press = async () => { for (const toast of p.obsidian.raised) toast.hide(); await p.instance.syncNow(true); };
  p.sending(9);
  p.verifying({ checked: 3, sent: 0 });
  await verify.callback();
  await new Promise(setImmediate);
  assert.deepEqual(notices(), ["obsync: checked 3 files; none had changed."], "the command ran the full check, not Sync now");
  p.verifying({ checked: 1, sent: 1 });
  await press();
  assert.equal(notices().at(-1), "obsync: checked 1 file; 1 had changed and was sent.");
  p.verifying({ checked: 4, sent: 2 });
  await press();
  assert.equal(notices().at(-1), "obsync: checked 4 files; 2 had changed and were sent.");
  p.instance.transport.options.reachable(false);
  const before = notices().length;
  await press();
  assert.deepEqual(notices().slice(before), ["obsync: Your server is not answering. Sync resumes by itself when it is back."]);
});

test("on a phone the indicator is in the header of the view in front, moves with it, and a tap opens Show sync status (#209)", async (t) => {
  const p = await plugin(t, { mobile: true });
  const one = header(p.obsidian), two = header(p.obsidian);
  p.views.active = one;
  p.hooks.get("active-leaf-change")();
  assert.equal(one.actions.length, 1);
  const shown = one.actions[0].el;
  assert.equal(shown.attributes["data-state"], "synced", "the same states as the desktop item");
  let opened = 0;
  p.instance.showStatus = () => { opened++; };
  shown.click();
  assert.equal(opened, 1);
  p.instance.setStatus({ kind: "offline" });
  assert.equal(shown.attributes["data-state"], "offline", "and it follows the status");
  p.views.active = two;
  p.hooks.get("active-leaf-change")();
  assert.equal(shown.removed, true, "gone from the view left behind");
  assert.equal(two.actions[0].el.attributes["data-state"], "offline");
});

test("on a phone a refusal that needs the person is said once in a notice; on a desktop the bar says it (#209)", async (t) => {
  const phone = await plugin(t, { mobile: true });
  const clock = { kind: "error", code: "clock", message: "CLOCK SENTINEL" };
  phone.instance.setStatus(clock);
  phone.instance.setStatus({ ...clock });
  phone.instance.setStatus({ kind: "error", message: "a parked file names itself in its own notice" });
  assert.deepEqual(phone.obsidian.notices.filter((notice) => notice.includes("SENTINEL")), ["obsync: CLOCK SENTINEL"]);
  assert.equal(phone.obsidian.raised.find((toast) => toast.message.includes("SENTINEL")).message, "obsync: CLOCK SENTINEL",
    "the same refusal still standing is not said again");
  // It ends, and its toast goes with it; Recent keeps the line (#308). "Your
  // server is out of storage" stood for hours over a phone syncing again.
  const up = () => phone.obsidian.raised.filter((toast) => toast.message.includes("SENTINEL") && !toast.hidden).map((toast) => toast.message);
  phone.instance.setStatus({ kind: "idle" });
  assert.deepEqual(up(), [], "a refusal that ended left its toast up");
  assert.ok(phone.instance.notices.recent().some((entry) => entry.text.includes("CLOCK SENTINEL")), "Recent lost the refusal");
  // Back: a toast of its own, the only one up.
  phone.instance.setStatus(clock);
  assert.equal(phone.obsidian.notices.filter((notice) => notice.includes("SENTINEL")).length, 2, "again, when it comes back");
  assert.deepEqual(up(), ["obsync: CLOCK SENTINEL"]);
  // Another refusal in its place: its toast, and the first one's goes.
  phone.instance.setStatus({ kind: "error", code: "storage", message: "STORAGE SENTINEL" });
  assert.deepEqual(up(), ["obsync: STORAGE SENTINEL"]);

  const desktop = await plugin(t);
  desktop.instance.setStatus(clock);
  assert.deepEqual(desktop.obsidian.notices.filter((notice) => notice.includes("SENTINEL")), []);
  assert.equal(desktop.item.attributes["data-state"], "attention");
});

// --- Show sync status ------------------------------------------------------

class Component {
  setButtonText(value) { this.text = value; return this; }
  setCta() { return this; }
  onClick(handler) { this.click = handler; return this; }
}

function dialog(t, status) {
  const b = box(t);
  const drawn = [], made = [];
  Object.assign(b.obsidian.Setting.prototype, {
    setName(value) { drawn.push(value); return this; },
    setDesc(value) { drawn.push(value); return this; },
    addButton(make) { const button = new Component(); made.push(button); make(button); return this; },
  });
  const { StatusModal } = b.require(join(b.home, "build/ui/modals.js"));
  const watchers = new Set(), calls = [];
  const current = { status };
  const plugin = {
    state: { data: { serverUrl: "https://sync.example.invalid", deviceId: KEYS.deviceId, vrk: KEYS.vrk, recoveryPhrase: "confirmed", parked: {}, paused: {}, files: {}, remoteOnly: {}, lastSeq: 7,
      policy: { perFileMaxBytes: 0, totalBudgetBytes: 0 } }, localBytes: () => 0 },
    statusText: () => `${current.status.kind} TEXT`,
    deviceName: () => "iPhone EDVF",
    currentStatus: () => current.status,
    nextRetryAt: () => current.retryAt ?? null,
    onStatusChange: (watcher) => { watchers.add(watcher); return () => watchers.delete(watcher); },
    retry: () => calls.push("retry"),
    openSettings: () => calls.push("settings"),
    notices: { recent: () => current.recent ?? [] },
    openNote: (path) => calls.push(`open:${path}`),
    showRecent: () => calls.push("recent"),
  };
  const classed = [];
  const element = () => ({ createEl: (tag, attributes = {}) => {
    drawn.push(attributes.text ?? tag);
    if (attributes.cls !== undefined) classed.push([attributes.text, attributes.cls]);
    return element();
  }, empty: () => { drawn.length = 0; made.length = 0; classed.length = 0; } });
  const modal = new StatusModal({}, plugin);
  modal.contentEl = element();
  modal.setTitle = () => {};
  modal.close = () => { calls.push("close"); modal.onClose(); };
  const change = (next) => { current.status = next; for (const watcher of [...watchers]) watcher(); };
  const button = () => made.at(-1);
  return { modal, drawn, calls, watchers, change, button, current, classed, plugin };
}

test("Show sync status names this device as every other screen does, its id smaller beneath for support (iPhone pass, 2026-09-26)", (t) => {
  const d = dialog(t, { kind: "idle" });
  d.modal.onOpen();
  const at = d.drawn.indexOf("This device");
  assert.deepEqual(d.drawn.slice(at, at + 3), ["This device", "iPhone EDVF", KEYS.deviceId], "the name first, then the id");
  const worded = () => d.classed.filter(([text]) => text !== undefined);
  assert.deepEqual(worded(), [[KEYS.deviceId, "setting-item-description"]], "the id is the smaller line, and only it");
  d.plugin.state.data.deviceId = null;
  d.change({ kind: "idle" });
  const unpaired = d.drawn.indexOf("This device");
  assert.equal(d.drawn[unpaired + 1], "not paired");
  assert.deepEqual(worded(), []);
});

test("Show sync status stays true while open, and offers the next step for the state it shows (#156)", (t) => {
  const d = dialog(t, { kind: "offline" });
  d.modal.onOpen();
  assert.ok(d.drawn.includes("offline TEXT"));
  assert.ok(d.drawn.includes("Your server is not answering"));
  assert.ok(d.drawn.includes("obsync tries again by itself, and at once when this device's network comes back."));
  assert.equal(d.button().text, "Retry now");
  d.button().click();
  assert.deepEqual(d.calls, ["retry"]);
  d.current.retryAt = new Date(2026, 8, 26, 14, 5, 30).getTime();
  d.change({ kind: "offline" });
  assert.ok(d.drawn.some((line) => /^obsync tries again by itself at \S.*, and at once when/.test(line)), "with when the next try runs");

  d.change({ kind: "idle" });
  assert.ok(d.drawn.includes("idle TEXT"), "redrawn when the status moved on");
  assert.ok(!d.drawn.includes("offline TEXT"));
  assert.equal(d.button(), undefined, "nothing to do while all is well");

  for (const [status, text, call] of [
    [{ kind: "error", code: "credential_rejected", message: "REVOKED" }, "Pair again", ["close", "settings"]],
    [{ kind: "error", code: "edge", message: "EDGE" }, "Open settings", ["close", "settings"]],
    [{ kind: "error", code: "clock", message: "CLOCK" }, "Retry now", ["retry"]],
  ]) {
    d.calls.length = 0;
    d.change(status);
    assert.ok(d.drawn.includes(status.message), status.message);
    assert.equal(d.button().text, text, status.code);
    d.button().click();
    assert.deepEqual(d.calls, call, status.code);
    if (call.includes("close")) d.modal.onOpen();
  }
  d.modal.onClose();
  assert.equal(d.watchers.size, 0, "closed, it stops listening");
});

test("Show sync status asked for again while it shows is that one dialog, brought forward and current, never a second (#269)", async (t) => {
  const p = await plugin(t);
  // Obsidian's own Modal as far as the dialog touches it: open appends the
  // container and pushes the dialog's keys; open again while shown is nothing.
  const bodies = [], keys = [], shown = [];
  let draws = 0;
  const element = () => ({ createEl: () => element(), empty: () => { draws++; } });
  Object.assign(p.obsidian.Setting.prototype, { setName() { return this; }, setDesc() { return this; }, addButton() { return this; } });
  Object.assign(p.obsidian.Modal.prototype, {
    open() {
      if (shown.includes(this)) return;
      this.scope ??= { dialog: shown.length };
      this.containerEl ??= { ownerDocument: { body: { appendChild: (el) => bodies.push(el) } } };
      this.contentEl ??= element();
      this.setTitle = () => {};
      shown.push(this);
      keys.push(["push", this.scope]);
      this.onOpen();
    },
    close() { shown.splice(shown.indexOf(this), 1); keys.push(["pop", this.scope]); this.onClose(); },
  });
  p.instance.app.keymap = { pushScope: (scope) => keys.push(["push", scope]), popScope: (scope) => keys.push(["pop", scope]) };
  const logs = [];
  p.instance.log = (line) => logs.push(line);

  // The palette, the status item, and a notice's "N more", each while it shows.
  const command = p.commands.find((candidate) => candidate.id === "status");
  command.callback();
  const [first] = shown;
  const opened = draws;
  p.item.click();
  for (let i = 0; i < 3; i++) p.instance.notices.show({ kind: "info", text: `FLOOD ${i}.` });
  p.instance.notices.show({ kind: "info", text: "ONE TOO MANY." });
  const more = p.obsidian.raised.find((notice) => /more — see Recent/.test(notice.message));
  more.containerEl.dispatch("click");
  assert.deepEqual(shown, [first], "one dialog on screen");
  assert.equal(draws, opened + 2, "drawn afresh each time it is asked for again");
  assert.deepEqual(bodies, [first.containerEl, first.containerEl], "brought in front of any other dialog, each time");
  assert.deepEqual(keys.slice(1), [["pop", first.scope], ["push", first.scope], ["pop", first.scope], ["push", first.scope]],
    "and its keys first, so Escape closes it first");
  assert.equal(logs.filter((line) => line === "status decision=forward reason=already_open").length, 2);

  // Closed, the next request opens a new one.
  first.close();
  command.callback();
  assert.equal(shown.length, 1);
  assert.notEqual(shown[0], first);

  // Recent the same way: asked for twice, one dialog, in front, drawn again.
  const recent = p.commands.find((candidate) => candidate.id === "recent");
  recent.callback();
  const listed = shown.at(-1);
  const before = draws;
  recent.callback();
  assert.equal(shown.filter((dialog) => dialog === listed).length, 1);
  assert.equal(shown.length, 2, "Show sync status and one Recent");
  assert.equal(draws, before + 1);
  assert.equal(bodies.at(-1), listed.containerEl);
  assert.equal(logs.filter((line) => line === "recent decision=forward reason=already_open").length, 1);

  p.obsidian.Platform.isDesktopApp = false; // Refusal dialog uses the same lifetime as the desktop form.
  const exporting = p.commands.find((candidate) => candidate.id === "export-copy");
  exporting.callback();
  const copy = shown.at(-1);
  exporting.callback();
  assert.equal(shown.length, 3, "one status, Recent and export dialog");
  assert.equal(bodies.at(-1), copy.containerEl);
  copy.close();
  exporting.callback();
  assert.equal(shown.length, 3);
  assert.notEqual(shown.at(-1), copy);
});
