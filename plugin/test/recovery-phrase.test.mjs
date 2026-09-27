/**
 * Whether this device confirmed its 24 words (issue #170): the real
 * recovery-phrase dialog, the real Settings row and Show sync status, and the
 * compiled plugin's start, over the sandbox's non-rendering Obsidian stub.
 *
 * Closing the dialog used to record nothing, so a person who pressed Escape
 * on the words at setup was never asked again (S35). What is pinned: Escape
 * leaves the words unconfirmed and owes ONE notice at the next start; the
 * three-word check, or a restore from the 24 words, confirms them; Settings
 * and Show sync status say "not confirmed" until then, quietly.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KEYS, memorySecrets, sandbox } from "./fake.mjs";

const tick = () => new Promise(setImmediate);

/** The sandbox, with `Setting` widgets that record what is drawn and can be pressed. */
function box(t) {
  const b = sandbox();
  t.after(() => rmSync(b.home, { recursive: true, force: true }));
  const obsidian = b.require("obsidian");
  const made = [];
  const add = (kind) => function (callback) {
    const widget = {
      kind, inputEl: { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } },
      setName: () => widget, setValue(value) { widget.value = value; return widget; }, setPlaceholder: () => widget,
      setButtonText(value) { widget.text = value; return widget; }, setDisabled(value) { widget.disabled = value; return widget; },
      setCta() { widget.cta = true; return widget; }, setIcon: () => widget, setTooltip: () => widget,
      onChange(handler) { widget.change = handler; return widget; }, onClick(handler) { widget.click = handler; return widget; },
    };
    made.push(widget); callback(widget); return this;
  };
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { this.name = value; return this; }, setDesc(value) { this.desc = value; return this; },
    addText: add("text"), addTextArea: add("textarea"), addButton: add("button"), addExtraButton: add("extra"),
  });
  const opened = [];
  obsidian.Modal.prototype.open = function () { opened.push(this); };
  const modals = b.require(join(b.home, "build/ui/modals.js"));
  const pairing = b.require(join(b.home, "build/pairing.js"));
  const c = b.require(join(b.home, "build/crypto.js"));
  return { ...b, obsidian, made, opened, modals, words: () => pairing.recoveryPhrase(c.unhex(KEYS.vrk)) };
}

function plugin(data = {}) {
  const calls = [];
  return {
    calls,
    logs: [],
    log(line) { this.logs.push(line); },
    state: { data: { vrk: KEYS.vrk, recoveryPhrase: "unconfirmed", ...data }, save: async () => { calls.push("save"); } },
  };
}

/** A real dialog whose drawing is recorded and whose close runs `onClose`, as Escape does. */
function dialog(b, p, confirmFirst, afterClose) {
  const drawn = [];
  const element = () => ({ createEl: (tag, attributes = {}) => { drawn.push(`${tag}: ${attributes.text ?? ""}`); return element(); }, empty() {} });
  const modal = new b.modals.RecoveryPhraseModal({}, p, confirmFirst, afterClose);
  modal.contentEl = element();
  modal.setTitle = () => {};
  let closed = 0;
  modal.close = () => { closed++; modal.onClose(); };
  // The words are derived asynchronously; hold the drawing `onOpen` starts so
  // a test waits for it, not for a guessed number of turns (a loaded runner
  // took more than five).
  const render = modal.render.bind(modal);
  let ready = null;
  modal.render = () => (ready = render());
  b.made.length = 0;
  modal.onOpen();
  return { modal, drawn, closed: () => closed, ready: () => ready };
}

test("Escape on the words at setup leaves them unconfirmed, owed one reminder; passing the check confirms them (#170)", async (t) => {
  const b = box(t);
  const words = await b.words();
  const p = plugin();
  const d = dialog(b, p, true);
  await d.ready();
  const fields = b.made.filter((w) => w.kind === "text");
  assert.equal(fields.length, 3, "the three-word check is drawn");
  for (const field of fields) {
    // A recovery word a phone keyboard learned would sit in its dictionary (#208).
    assert.deepEqual(field.inputEl.attributes, { autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false" });
  }
  d.modal.onClose(); // Escape, the cross, a tap outside
  assert.equal(p.state.data.recoveryPhrase, "skipped");
  assert.deepEqual(p.calls, ["save"], "the skip is persisted");
  assert.deepEqual(p.logs, ["phrase decision=skipped"]);

  // Opened again from Settings: a wrong word changes nothing, the right ones confirm.
  const again = dialog(b, p, true);
  await again.ready();
  const [w3, w11, w20] = b.made.filter((w) => w.kind === "text");
  const confirm = b.made.find((w) => w.kind === "button" && w.text === "I have written it down");
  w3.change(words[2]); w11.change("wrong"); w20.change(words[19]);
  confirm.click();
  assert.equal(p.state.data.recoveryPhrase, "skipped");
  assert.equal(again.closed(), 0);
  w11.change(` ${words[10].toUpperCase()} `);
  confirm.click();
  assert.equal(p.state.data.recoveryPhrase, "confirmed");
  assert.equal(again.closed(), 1);
  assert.equal(p.state.data.recoveryPhrase, "confirmed", "closing after the check does not undo it");
  assert.deepEqual(p.calls, ["save", "save"]);
  assert.deepEqual(p.logs, ["phrase decision=skipped", "phrase decision=confirmed"]);
  assert.ok(b.obsidian.notices.includes("Recovery phrase confirmed."));
});

test("the words shown from the palette offer the check to an unconfirmed device, and closing them records nothing (#170)", async (t) => {
  const b = box(t);
  for (const [state, check] of [["unconfirmed", true], ["skipped", true], ["confirmed", false]]) {
    const p = plugin({ recoveryPhrase: state });
    let after = 0;
    const d = dialog(b, p, false, () => { after++; });
    await d.ready();
    assert.equal(d.drawn.filter((line) => line.startsWith("li: ")).length, 24);
    assert.equal(b.made.filter((w) => w.kind === "text").length, check ? 3 : 0, state);
    d.modal.onClose();
    assert.equal(p.state.data.recoveryPhrase, state, "only a dialog opened to confirm records a skip");
    assert.deepEqual(p.calls, []);
    assert.equal(after, 1, "the opener is told the dialog closed");
  }
  // A device with no key has nothing to confirm or skip.
  const p = plugin({ vrk: null });
  const d = dialog(b, p, true);
  await d.ready();
  d.modal.onClose();
  assert.equal(p.state.data.recoveryPhrase, "unconfirmed");
  assert.deepEqual(p.calls, []);
});

test("Show sync status lists an unconfirmed phrase as a to-do that opens the check, and nothing once confirmed (#170)", (t) => {
  const b = box(t);
  const drawn = [];
  const element = () => ({ createEl: (tag, attributes = {}) => { drawn.push(attributes.text ?? tag); return element(); }, empty() {} });
  for (const [data, listed] of [[{}, true], [{ recoveryPhrase: "skipped" }, true], [{ recoveryPhrase: "confirmed" }, false], [{ vrk: null }, false]]) {
    const p = plugin(data);
    Object.assign(p.state.data, { serverUrl: "", deviceId: null, parked: {}, paused: {}, files: {}, remoteOnly: {}, lastSeq: 0, policy: { perFileMaxBytes: 0, totalBudgetBytes: 0 } });
    p.state.localBytes = () => 0;
    p.statusText = () => "idle";
    const modal = new b.modals.StatusModal({}, p);
    modal.contentEl = element();
    modal.setTitle = () => {};
    let closed = 0;
    modal.close = () => { closed++; };
    b.made.length = 0;
    modal.onOpen();
    const todo = b.made.find((w) => w.text === "Show and confirm");
    assert.equal(todo !== undefined, listed, JSON.stringify(data));
    if (!listed) continue;
    b.opened.length = 0;
    todo.click();
    assert.equal(closed, 1);
    assert.equal(b.opened[0].constructor.name, "RecoveryPhraseModal");
    assert.equal(b.opened[0].confirmFirst, true);
  }
});

async function fixture(t, initial) {
  const b = sandbox();
  t.after(() => rmSync(b.home, { recursive: true, force: true }));
  const obsidian = b.require("obsidian");
  obsidian.Modal.prototype.open = () => {};
  const Plugin = b.require(join(b.home, "build/main.js")).default;
  const instance = new Plugin();
  let metadata = structuredClone(initial);
  instance.loadData = async () => structuredClone(metadata);
  instance.saveData = async (value) => { metadata = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText() {} });
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: () => {} } };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.4" };
  instance.startEngine = async () => {};
  const logs = [];
  instance.log = (line) => logs.push(line);
  return { obsidian, instance, logs, metadata: () => structuredClone(metadata) };
}

test("the start after a skipped confirmation says so once, and never again on its own (#170)", async (t) => {
  const r = await fixture(t, { vrk: KEYS.vrk, deviceId: null, deviceSecret: null, serverUrl: "", recoveryPhrase: "skipped" });
  await r.instance.onload();
  await tick();
  const reminders = () => r.obsidian.notices.filter((message) => message.startsWith("obsync: your 24-word recovery phrase is not confirmed."));
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0], /Open obsync's settings, Vault key, and choose Show and confirm\./);
  assert.equal(r.metadata().recoveryPhrase, "unconfirmed", "the reminder is spent");
  assert.ok(r.logs.includes("phrase decision=reminded"));
  await r.instance.onload();
  await tick();
  assert.equal(reminders().length, 1, "the next start says nothing");
  assert.equal(r.instance.state.data.recoveryPhrase, "unconfirmed", "Settings still says it");
});

test("a device upgraded from 1.1.3 reads as not confirmed without a notice; a confirmed one stays quiet (#170)", async (t) => {
  for (const [stored, expected] of [[undefined, "unconfirmed"], ["confirmed", "confirmed"], ["yes", "unconfirmed"], [true, "unconfirmed"]]) {
    const r = await fixture(t, { vrk: KEYS.vrk, deviceId: null, deviceSecret: null, serverUrl: "", ...(stored === undefined ? {} : { recoveryPhrase: stored }) });
    await r.instance.onload();
    await tick();
    assert.equal(r.instance.state.data.recoveryPhrase, expected, String(stored));
    assert.deepEqual(r.obsidian.notices, [], String(stored));
  }
});

test("a new vault key is a phrase to confirm; restoring one from its 24 words confirms it (#170)", async (t) => {
  const r = await fixture(t, { vrk: KEYS.vrk, deviceId: null, deviceSecret: null, serverUrl: "", recoveryPhrase: "confirmed" });
  await r.instance.onload();
  await r.instance.adoptVaultKey(KEYS.vrk);
  assert.equal(r.metadata().recoveryPhrase, "confirmed", "the same key keeps its confirmation");
  await r.instance.adoptVaultKey("ab".repeat(32));
  assert.equal(r.metadata().recoveryPhrase, "unconfirmed", "another key's words were never confirmed here");
  await r.instance.restoreVaultKey("cd".repeat(32));
  assert.equal(r.metadata().recoveryPhrase, "confirmed", "typing all 24 words back is the confirmation");
});
