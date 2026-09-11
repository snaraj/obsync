import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

class Element {
  constructor() { this.text = []; this.settings = []; }
  empty() { this.text = []; this.settings = []; }
  createEl(_tag, props) { this.text.push(props.text); return new Element(); }
  setText(text) { this.text.push(text); }
}

function ui(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const obsidian = box.require("obsidian");
  obsidian.Modal.prototype.setTitle = function (title) { this.title = title; };
  obsidian.Modal.prototype.close = function () { this.onClose(); };
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { this.name = value; return this; },
    setDesc(value) { this.description = value; return this; },
    addText(callback) { this.input = { setValue(v) { this.value = v; return this; }, setDisabled(v) { this.disabled = v; return this; }, onChange(fn) { this.change = fn; return this; } }; callback(this.input); return this; },
    addButton(callback) {
      const button = { disabled: false, setButtonText(v) { this.text = v; return this; }, setDisabled(v) { this.disabled = v; return this; }, onClick(fn) { this.click = fn; return this; } };
      (this.buttons ??= []).push(button);
      if (!this.el.settings.includes(this)) this.el.settings.push(this);
      callback(button);
      return this;
    },
  });
  const { HistoryModal } = box.require(join(box.home, "build/ui/history.js"));
  return { box, obsidian, HistoryModal };
}
const button = (modal, text) => modal.contentEl.settings.flatMap((s) => s.buttons).find((b) => b.text === text);

test("native history modal renders retained/deleted content, respects busy controls, and reports local creation only", async (t) => {
  const { obsidian, HistoryModal } = ui(t);
  const rows = [
    { path: "Notes/<local text>.md", ts: 1000, size: 0, deleted: false },
    { path: "Notes/deleted.md", ts: 1000, size: 0, deleted: true },
  ];
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let closed = 0, restored, loadCalls = 0;
  const browser = { done: false, next: async () => { loadCalls++; return pending; } };
  const plugin = { openHistory: () => browser, closeHistory: () => { closed++; },
    restoreHistory: async (_browser, entry) => { restored = entry; return { path: "Notes/copy.md", syncRequested: false }; } };
  const modal = new HistoryModal({}, plugin);
  modal.contentEl = new Element();
  modal.onOpen();
  assert.equal(modal.title, "Restore from history");
  assert.equal(button(modal, "Load next").disabled, false);
  const load = modal.load();
  const secondLoad = modal.load();
  assert.equal(loadCalls, 1, "a busy modal cannot start another page");
  assert.equal(button(modal, "Load next").disabled, true);
  assert.equal(modal.contentEl.settings.find((s) => s.input).input.disabled, true);
  resolve({ entries: rows, scanned: 20, refused: 0 });
  await secondLoad;
  await load;
  const settings = modal.contentEl.settings.filter((s) => s.name?.startsWith("Notes/"));
  assert.equal(settings[0].name, "Notes/<local text>.md", "path remains a text label");
  assert.match(settings[0].description, /0 B/);
  assert.equal(settings[0].buttons[0].disabled, false);
  assert.equal(settings[1].buttons[0].disabled, true);
  assert.ok(modal.contentEl.text.some((text) => /More may remain/.test(text)));
  await modal.restore(rows[0]);
  assert.equal(restored, rows[0]);
  assert.ok(obsidian.notices.some((text) => /Copy saved locally.*Sync is pending/.test(text)));
  assert.equal(obsidian.notices.some((text) => /successfully synced|remote sync complete/i.test(text)), false);
  assert.equal(closed, 1);
  assert.deepEqual(modal.contentEl.text, []);
});

test("closing a loading modal cancels its session and a late page cannot repopulate the UI", async (t) => {
  const { HistoryModal } = ui(t);
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let closed = 0;
  const modal = new HistoryModal({}, { openHistory: () => ({ done: false, next: () => pending }), closeHistory: () => { closed++; } });
  modal.contentEl = new Element();
  modal.onOpen();
  const loading = modal.load();
  button(modal, "Cancel and close").click();
  assert.equal(closed, 1);
  resolve({ entries: [{ path: "Notes/late.md", size: 1, deleted: false, ts: 1000 }], scanned: 1, refused: 0 });
  await loading;
  assert.deepEqual(modal.contentEl.settings, []);
  assert.deepEqual(modal.contentEl.text, []);
});

test("plugin registers the native restore command without pairing or issuing a history request", async (t) => {
  const { box } = ui(t);
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const plugin = new Plugin();
  const commands = [];
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  plugin.addCommand = (command) => commands.push(command);
  plugin.addStatusBarItem = () => new Element();
  plugin.addSettingTab = () => {};
  plugin.registerEvent = () => {};
  plugin.registerObsidianProtocolHandler = () => {};
  plugin.log = () => {};
  plugin.app = { vault: { adapter: {}, on: () => ({}) } };
  plugin.manifest = { version: "0.1.11" };
  await plugin.onload();
  assert.equal(commands.find((c) => c.id === "restore-history")?.name, "Restore from history");
  assert.throws(() => plugin.openHistory(), /paired device/);
  plugin.onunload();
});
