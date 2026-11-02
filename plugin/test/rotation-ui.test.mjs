/** Compiled dialogs over a recording Obsidian UI port; native acceptance is separate. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox, KEYS } from "./fake.mjs";
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function ui(t, custody = null) {
  const box = sandbox(); t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian"), made = [], opened = [], text = [], drawn = [];
  // A selection records what it holds, as the page's would (#364).
  const doc = { selected: null, getSelection: () => ({ selectAllChildren(el) { doc.selected = el; } }) };
  const element = (tag, attributes = {}) => ({ tag, ...attributes, ownerDocument: doc, empty() {}, setText(value) { text.push(value); },
    createEl(child, attributes = {}) { text.push(attributes.text ?? ""); const el = element(child, attributes); drawn.push(el); return el; } });
  const add = kind => function (callback) {
    const w = { kind, inputEl: { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } },
      setValue(value) { this.value = value; return this; }, setPlaceholder() { return this; }, setCta() { this.cta = true; return this; },
      setDisabled(value) { this.disabled = value; return this; },
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
  const notices = [], logs = [];
  const plugin = { state: { data: { deviceId: KEYS.deviceId }, custody2: () => custody },
    notices: { show: notice => notices.push(notice.text) }, log: line => logs.push(line) };
  const show = modal => { modal.contentEl = element("div"); modal.onOpen(); return modal; };
  return { dialogs, plugin, show, made, opened, text, drawn, doc, notices, logs, box,
    button: value => made.find(w => w.text === value), input: kind => made.find(w => w.kind === kind),
    latest: kind => made.findLast(w => w.kind === kind) };
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

// --- the backup as a block to carry away, and the way back to it (#364) ---

const backupOf = async r => r.box.require(join(r.box.home, "build/recoveryBackup.js"));
const pendingAt = phase => ({ phase, rotation: { newRoot: KEYS.vrk, intent: { operation: "31".repeat(16) } } });

/** A RotationModal whose every drawing a test can wait for, drawn first. */
async function rotation(r) {
  const modal = new r.dialogs.RotationModal({}, r.plugin);
  const render = modal.render.bind(modal); let ready;
  modal.render = () => ready = render(); modal.drawn = () => ready;
  r.show(modal); await ready; return modal;
}

function clipboard(t, writeText) {
  const written = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: writeText === undefined ? undefined : { writeText: text => { written.push(text); return writeText(text); } } });
  t.after(() => { delete navigator.clipboard; });
  return written;
}

test("the new backup is a selectable block whose Copy writes all of it, marker and 24 words, with nothing added (#364)", async t => {
  const r = ui(t, pendingAt("draft")); const written = clipboard(t, async () => {});
  await rotation(r);
  const codec = await backupOf(r), expected = await codec.encodeRecoveryBackup(r.box.require(join(r.box.home, "build/crypto.js")).unhex(KEYS.vrk));
  const blocks = r.drawn.filter(el => el.tag === "pre");
  assert.deepEqual(blocks.map(el => [el.cls, el.text]), [["obsync-code", expected]], "one block, styled to select whole");
  await r.button("Copy").click();
  assert.deepEqual(written, [expected], "exactly the backup shown");
  assert.match(written[0], /^obsync-recovery-v2( [a-z]+){24}$/, "the marker and 24 words, single-spaced, no line breaks");
  assert.equal(Buffer.from(await codec.parseRecoveryBackup(written[0])).toString("hex"), KEYS.vrk, "the copy recovers this key");
  assert.deepEqual(r.notices, ["recovery backup copied. Save it away from this device, then copy something else over it."]);
  assert.equal(r.doc.selected, null, "a copy that worked selects nothing");
  r.button("Select").click();
  assert.equal(r.doc.selected, blocks[0], "Select selects the whole block");
  assert.deepEqual(r.logs, []);
});

test("a refused or missing clipboard selects the backup instead and says how to copy it (#364)", async t => {
  for (const [writeText, reason] of [[async () => { throw new DOMException("refused", "NotAllowedError"); }, "NotAllowedError"], [undefined, "TypeError"]]) {
    const r = ui(t, pendingAt("draft")); clipboard(t, writeText);
    await rotation(r);
    await r.button("Copy").click();
    assert.equal(r.doc.selected, r.drawn.find(el => el.tag === "pre"), reason);
    assert.deepEqual(r.notices, ["this device refused clipboard access, so the backup is selected instead: press Ctrl+C or Cmd+C, or press and hold it and choose Copy."], reason);
    assert.deepEqual(r.logs, [`backup decision=copy_refused reason=${reason}`], "the refusal is logged by name, never with the backup");
  }
});

test("a failed attempt keeps the pasted backup but never the setup token; a press while one runs is refused, visibly (#364)", async t => {
  const r = ui(t, pendingAt("draft")), wait = deferred(); const calls = [];
  r.plugin.prepareRotation = async (token, backup) => { calls.push([token, backup]); if (calls.length === 1) { await wait.promise; throw new Error("REFUSED"); } };
  const modal = await rotation(r);
  const token = r.input("text"); token.value = "TOKEN"; token.change("TOKEN"); r.input("textarea").change("PASTED BACKUP");
  const prepare = r.button("Prepare transition"); prepare.click(); prepare.click();
  assert.deepEqual(calls, [["TOKEN", "PASTED BACKUP"]], "one submission");
  assert.equal(prepare.disabled, true); assert.equal(prepare.text, "Working…", "the press says it is running");
  assert.equal(token.value, "", "the token leaves the screen at once");
  wait.resolve(); await tick(); await modal.drawn();
  assert.ok(r.text.includes("REFUSED"));
  assert.equal(r.latest("textarea").value, "PASTED BACKUP", "the readback survives the refusal");
  assert.equal(r.latest("text").value, "", "the token does not");
  r.made.findLast(w => w.text === "Prepare transition").click(); await tick(); await modal.drawn();
  assert.deepEqual(calls[1], ["", "PASTED BACKUP"], "the retry carries the readback and no remembered token");
  assert.equal(r.latest("textarea").value, "", "a success lets the readback go");
  r.latest("textarea").change("AGAIN"); modal.close(); modal.onOpen(); await modal.drawn();
  assert.equal(r.latest("textarea").value, "", "closing the dialog lets it go too");
});

test("a commit ends on a completion screen, never the start of another transition (#364)", async t => {
  let custody = pendingAt("commit_unknown"); const r = ui(t); r.plugin.state.custody2 = () => custody;
  r.plugin.commitRotation = async () => { custody = { phase: "active" }; };
  const modal = await rotation(r); let closed = 0; modal.close = () => { closed++; };
  r.input("textarea").change("PASTED BACKUP"); r.button("Commit new key").click(); await tick(); await modal.drawn();
  assert.ok(r.text.some(value => /^Encryption change complete\. .*Pair each retained device again/.test(value)));
  assert.equal(r.made.findLast(w => w.kind === "button").text, "Done");
  assert.equal(r.made.filter(w => w.text === "Stage encryption transition").length, 0);
  r.made.findLast(w => w.kind === "button").click(); assert.equal(closed, 1);
});

test("a refused legacy, access or previous-key recovery retries with the backup still shown, never an empty one (#364)", async t => {
  const r = ui(t, pendingAt("prepared")); const seen = [];
  r.plugin.recoverLegacyForUpgrade = async (_token, backup) => { seen.push(["legacy", backup]); throw new Error("REFUSED"); };
  r.plugin.recoverRotationAccess = async (_token, backup) => { seen.push(["access", backup]); throw new Error("REFUSED"); };
  r.plugin.pairAfterRotation = async backup => { seen.push(["previous", backup]); throw new Error("REFUSED"); };
  const flows = [["legacy", new r.dialogs.LegacyUpgradeModal({}, r.plugin), "Recover for upgrade"],
    ["previous", new r.dialogs.PreviousKeyModal({}, r.plugin, "replace"), "Continue to pairing"]];
  await rotation(r); r.button("Recover transition access").click(); flows.push(["access", r.opened[0], "Recover access"]);
  for (const [name, modal, action] of flows) {
    r.made.length = 0; r.text.length = 0; r.show(modal); r.input("textarea").change(`${name} BACKUP`);
    r.button(action).click();
    if (name !== "previous") assert.ok(r.text.includes("Working…"), `${name} says it is running`);
    await tick(); await tick();
    r.button(action).click(); await tick(); await tick();
    assert.deepEqual(seen.filter(([flow]) => flow === name), [[name, `${name} BACKUP`], [name, `${name} BACKUP`]], name);
  }
});

test("the backup block selects whole on every platform: iOS WebKit reads only the prefixed property (#364)", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/\.obsync-code\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /(^|[\s;])-webkit-user-select:\s*text;\s*-webkit-user-select:\s*all;/, "a WebKit without `all` keeps `text`, never body's `none`");
  assert.match(rule, /(^|[\s;])user-select:\s*all;/);
});
