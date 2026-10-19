/** Compiled dialogs over a recording Obsidian UI port; native acceptance is separate. */
import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox, KEYS } from "./fake.mjs";
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function ui(t, custody = null) {
  const box = sandbox(); t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian"), made = [], opened = [], text = [];
  const element = () => ({ empty() {}, createEl(_tag, attributes = {}) { text.push(attributes.text ?? ""); return element(); }, setText(value) { text.push(value); } });
  const add = kind => function (callback) {
    const w = { kind, inputEl: { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } },
      setValue(value) { this.value = value; return this; }, setPlaceholder() { return this; }, setCta() { this.cta = true; return this; },
      setButtonText(value) { this.text = value; return this; }, setDestructive() { this.destructive = true; return this; },
      setIcon() { return this; }, setTooltip() { return this; }, onChange(fn) { this.change = fn; return this; }, onClick(fn) { this.click = fn; return this; } };
    made.push(w); callback(w); return this;
  };
  Object.assign(obsidian.Setting.prototype, { setName(value) { text.push(value); return this; }, setDesc(value) { text.push(value); return this; },
    addText: add("text"), addTextArea: add("textarea"), addButton: add("button"), addExtraButton: add("extra") });
  obsidian.Modal.prototype.open = function () { opened.push(this); };
  obsidian.Modal.prototype.close = function () { this.onClose(); };
  obsidian.Modal.prototype.setTitle = function (value) { this.title = value; };
  const dialogs = box.require(join(box.home, "build/ui/rotation.js"));
  const plugin = { state: { data: { deviceId: KEYS.deviceId }, custody2: () => custody } };
  const show = modal => { modal.contentEl = element(); modal.onOpen(); return modal; };
  return { dialogs, plugin, show, made, opened, text, box,
    button: value => made.find(w => w.text === value), input: kind => made.find(w => w.kind === kind) };
}

test("revocation presents explicit strong and access-only consequences; no action runs on open", t => {
  const r = ui(t); let access = 0;
  r.show(new r.dialogs.RevokeModal({}, r.plugin, "22".repeat(16), "Synthetic device", () => access++));
  assert.equal(access, 0); assert.ok(r.button("Rotate key").cta);
  assert.ok(r.text.some(value => /decrypt future ciphertext if it obtains it elsewhere/.test(value)));
  assert.ok(r.text.some(value => /Every retained device must pair again/.test(value)));
  r.button("Rotate key").click(); assert.equal(access, 0); assert.equal(r.opened[0].target, "22".repeat(16));
  const s = ui(t); s.show(new s.dialogs.RevokeModal({}, s.plugin, "22".repeat(16), "Synthetic device", () => access++));
  s.button("Block access").click(); assert.equal(access, 1);
});

test("self revocation cannot stage a rotation that retains this device", t => {
  const r = ui(t); r.show(new r.dialogs.RevokeModal({}, r.plugin, KEYS.deviceId, "This device", () => {}));
  assert.equal(Boolean(r.button("Rotate key")), false, "self revocation cannot offer key rotation"); assert.ok(r.button("Block access"));
  assert.ok(r.text.some(value => /Rotate from a retained device/.test(value)));
});

test("legacy recovery fields disable learning, mask tokens, serialize clicks and reject closed-dialog continuation", async t => {
  const r = ui(t), wait = deferred(); let calls = 0, captured, current;
  r.plugin.recoverLegacyForUpgrade = async (token, backup, check) => { calls++; captured = [token, backup]; current = check; await wait.promise; check(); };
  const modal = r.show(new r.dialogs.LegacyUpgradeModal({}, r.plugin));
  for (const w of [r.input("text"), r.input("textarea")]) assert.deepEqual(w.inputEl.attributes,
    { autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false" });
  assert.equal(r.input("text").inputEl.type, "password");
  r.input("text").change("TOKEN"); r.input("textarea").change("OLD BACKUP");
  const button = r.button("Recover for upgrade"); button.click(); button.click();
  assert.equal(calls, 1); assert.deepEqual(captured, ["TOKEN", "OLD BACKUP"]); assert.equal(r.input("text").value, "");
  modal.close(); assert.throws(current, /closed/); wait.resolve(); await tick();
  assert.equal(r.opened.length, 0); button.click(); assert.equal(calls, 1);
});

test("legacy recovery opens the pending transition only after successful completion", async t => {
  const r = ui(t), wait = deferred();
  r.plugin.recoverLegacyForUpgrade = () => wait.promise;
  r.show(new r.dialogs.LegacyUpgradeModal({}, r.plugin)); r.button("Recover for upgrade").click();
  assert.equal(r.opened.length, 0); wait.resolve(); await tick();
  assert.equal(r.opened.length, 1); assert.ok(r.opened[0] instanceof r.dialogs.RotationModal);
});

test("previous-key retirement passes the complete backup and a live-dialog guard once", async t => {
  const r = ui(t, { history: { suite: 2 } }), wait = deferred(); let calls = 0, guard;
  r.plugin.retireHistoryBackup = async (backup, check) => { assert.equal(backup, "COMPLETE OLD BACKUP"); calls++; guard = check; await wait.promise; check(); };
  const modal = r.show(new r.dialogs.PreviousKeyModal({}, r.plugin, "retire"));
  assert.ok(r.text.some(value => /including obsync-recovery-v2/.test(value)));
  r.input("textarea").change("COMPLETE OLD BACKUP");
  const pending = r.button("Remove previous key").click(); await r.button("Remove previous key").click();
  assert.equal(calls, 1); modal.close(); assert.throws(guard, /closed/); wait.resolve(); await pending;
});

test("only a local draft offers cancellation; prepared transition offers seeding and access recovery", async t => {
  for (const phase of ["draft", "prepared"]) {
    const pin = { phase, rotation: { newRoot: KEYS.vrk, intent: { operation: "31".repeat(16) } } };
    const r = ui(t, pin); const modal = new r.dialogs.RotationModal({}, r.plugin);
    const render = modal.render.bind(modal); let ready; modal.render = () => ready = render(); r.show(modal); await ready;
    assert.equal(Boolean(r.button("Cancel unprepared transition")), phase === "draft");
    assert.equal(Boolean(r.button("Re-encrypt current versions")), phase === "prepared");
    assert.equal(Boolean(r.button("Recover transition access")), phase === "prepared");
    assert.ok(r.text.some(value => /Sync is stopped/.test(value)));
  }
});
