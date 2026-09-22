/**
 * The settings tab as Obsidian 1.13 sees it: one list of definitions the app
 * renders and indexes. These tests read that list and drive the rows with
 * recording widgets, so what is asserted is what a person would see and click.
 * No Obsidian: `Setting` and the widgets are hand-written fakes.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

const tick = () => new Promise(setImmediate);

class Component {
  constructor(kind) { this.kind = kind; this.disabled = false; }
  setDisabled(value) { this.disabled = value; return this; }
  setButtonText(value) { this.text = value; return this; }
  setCta() { this.cta = true; return this; }
  setDestructive() { this.destructive = true; return this; }
  setValue(value) { this.value = value; return this; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  addOption(key) { (this.options ??= []).push(key); return this; }
  onChange(handler) { this.change = handler; return this; }
  onClick(handler) { this.click = handler; return this; }
}

/** Give the sandbox's bare `Setting` the widget factories, recording every widget made. */
function widgets(obsidian) {
  const made = [];
  const add = (kind) => function (callback) { const component = new Component(kind); made.push(component); callback(component); return this; };
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { this.name = value; return this; },
    setDesc(value) { this.desc = value; return this; },
    setHeading() { return this; },
    addText: add("text"), addTextArea: add("textarea"), addDropdown: add("dropdown"), addButton: add("button"),
  });
  return made;
}

function stubPlugin(overrides = {}) {
  const calls = [];
  const plugin = {
    manifest: { id: "obsync-private-sync", name: "Self Hosted Private Sync" },
    isMobile: false,
    state: {
      data: { serverUrl: "", edgeHeaders: [], syncFolders: undefined, deviceId: null, vrk: null, policy: { perFileMaxBytes: 0, totalBudgetBytes: 0 } },
      paired: false,
      save: async () => { calls.push("state.save"); },
      localBytes: () => 0,
    },
    transport: { account: async () => ({ name: "obsync", device_count: 1 }) },
    statusText: () => "idle",
    updateLine: () => null,
    heldDeletionLine: () => null,
    confirmHeldDeletions: () => { calls.push("confirmHeldDeletions"); },
    deviceName: () => "macos-1a2b",
    platformName: () => "macos",
    listDevices: async () => { calls.push("listDevices"); return []; },
    revokeDevice: async (id) => { calls.push(`revoke:${id}`); },
    saveDeviceSettings: async (name) => { calls.push(`saveDevice:${name}`); },
    saveSyncFolders: async (folders) => { calls.push(`saveSyncFolders:${JSON.stringify(folders)}`); },
    setUpAccount: async (token, account) => { calls.push(`setUp:${token}:${account}`); },
    openDashboard: async () => { calls.push("openDashboard"); },
    openPluginManager: () => { calls.push("openPluginManager"); },
    ...overrides,
  };
  return { plugin, calls };
}

function open(t, overrides) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const obsidian = box.require("obsidian");
  const made = widgets(obsidian);
  const { plugin, calls } = stubPlugin(overrides);
  const settings = box.require(join(box.home, "build/ui/settings.js"));
  const tab = new settings.ObsyncSettingTab({}, plugin);
  let updates = 0;
  tab.update = () => { updates++; };
  const rows = () => tab.getSettingDefinitions().flatMap((group) => group.items.map((item) => ({ ...item, group })));
  const row = (name) => { const found = rows().find((item) => item.name === name); assert.ok(found, `row ${name}`); return found; };
  const render = (name) => { made.length = 0; const result = row(name).render(new obsidian.Setting({})); return { result, made: [...made] }; };
  const button = (list, text) => { const found = list.find((c) => c.kind === "button" && c.text === text); assert.ok(found, `button ${text}`); return found; };
  return { box, obsidian, plugin, calls, settings, tab, rows, row, render, button, updates: () => updates };
}

test("the tab keeps the id and name Obsidian gives it, before and after every draft is used", async (t) => {
  // Obsidian sets `id` and `name` on the tab in its constructor and reads
  // them for the sidebar entry and the settings search; a subclass field
  // initializer runs after that constructor, so a draft field with either
  // name erases them (a real 1.13.4 showed a blank entry and a crashing
  // search). The API declaration lists neither, so only this test sees it.
  const s = open(t);
  assert.equal(s.tab.id, "obsync-private-sync");
  assert.equal(s.tab.name, "Self Hosted Private Sync");
  s.plugin.state.data.deviceId = "11".repeat(16);
  s.plugin.state.paired = true;
  s.render("Name").made[0].change("Kitchen");
  s.render("First-time setup");
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change("Notes");
  s.render("Device list");
  await tick();
  s.tab.hide();
  assert.equal(s.tab.id, "obsync-private-sync");
  assert.equal(s.tab.name, "Self Hosted Private Sync");
  assert.deepEqual(Object.keys(s.tab).filter((key) => ["id", "name", "app", "plugin", "containerEl", "icon", "settingItems", "navEl", "setting"].includes(key)).sort(), ["app", "id", "name", "plugin"], "no draft field shares a name with a tab member");
});

test("definitions are pure groups of named rows, and drawing a row returns nothing", (t) => {
  const s = open(t);
  const groups = s.tab.getSettingDefinitions();
  s.tab.getSettingDefinitions();
  assert.deepEqual(s.calls, [], "listing the rows reads nothing and saves nothing");
  assert.deepEqual(groups.map((group) => group.type), ["group", "group", "group", "group", "group"]);
  assert.deepEqual(groups.map((group) => group.heading), ["Server", "Sync folders on this device", "This device", "Devices", "Vault key"]);
  for (const item of s.rows()) {
    assert.ok(typeof item.name === "string" && item.name !== "", "every row has a name for search");
    if (item.render === undefined) continue;
    // Obsidian's Setting is thenable; a render that returned it would be
    // awaited by whoever holds the definitions.
    assert.equal(s.render(item.name).result, undefined, `${item.name} returns nothing`);
  }
});

test("the first run shows setup and hides what needs an enrolment; pairing inverts it", (t) => {
  const s = open(t);
  const visible = (name) => { const item = s.row(name); return item.visible === undefined ? true : item.visible(); };
  const devices = () => s.tab.getSettingDefinitions().find((group) => group.heading === "Devices").visible();
  assert.equal(visible("First-time setup"), true);
  for (const name of ["Name", "Largest file to download", "Total to keep on this device", "Save to server"]) assert.equal(visible(name), false, name);
  assert.equal(devices(), false);
  assert.equal(visible("Update available"), false);

  s.plugin.state.data.deviceId = "1122334455667788990011223344ffff";
  s.plugin.state.paired = true;
  s.plugin.updateLine = () => "Self Hosted Private Sync 9.9.9 is available (this device runs 1.0.2).";
  assert.equal(visible("First-time setup"), false);
  for (const name of ["Name", "Largest file to download", "Total to keep on this device", "Save to server"]) assert.equal(visible(name), true, name);
  assert.equal(devices(), true);
  assert.equal(visible("Update available"), true);
  assert.equal(s.row("Update available").desc, "Self Hosted Private Sync 9.9.9 is available (this device runs 1.0.2).");
});

test("the update row carries the button that opens Obsidian's Community plugins page", (t) => {
  // The sentence alone was the whole row, and on a phone that page is several
  // taps away; a row that says an update exists has to be able to reach it.
  const s = open(t);
  s.plugin.updateLine = () => "Self Hosted Private Sync 9.9.9 is available (this device runs 1.0.2).";
  const { made } = s.render("Update available");
  const button = s.button(made, "Open Community plugins");

  assert.equal(s.calls.length, 0, "drawing the row opens nothing");
  button.click();

  assert.deepEqual(s.calls, ["openPluginManager"]);
});

test("the held-deletions row is absent until a pass holds some, and its button confirms them", (t) => {
  // The row is a question the user should never be asked idly: a settings
  // page that always offers "Confirm deletions" teaches the click, and the
  // click removes notes from every device (issue #123).
  const s = open(t);
  const shown = () => s.row("Deletions held back").visible();
  assert.equal(shown(), false, "the row was offered with nothing to decide");

  s.plugin.heldDeletionLine = () => "obsync can no longer see 7 note(s) it syncs here and has NOT told your other devices.";
  assert.equal(shown(), true, "the row is hidden while there is something to decide");
  assert.equal(s.row("Deletions held back").desc,
    "obsync can no longer see 7 note(s) it syncs here and has NOT told your other devices.");
  const { made } = s.render("Deletions held back");
  const button = s.button(made, "Confirm deletions");
  assert.equal(button.destructive, true, "confirming removes notes from every device");

  assert.equal(s.calls.length, 0, "drawing the row published nothing");
  button.click();
  assert.deepEqual(s.calls, ["confirmHeldDeletions"]);
});

test("a bare host name becomes an https URL; an explicit scheme is kept; mobile refuses http", (t) => {
  const s = open(t);
  const { normalizeServerUrl } = s.settings;
  for (const [typed, stored] of [
    ["sync.example.org", "https://sync.example.org"],
    ["  sync.example.org:8443/  ", "https://sync.example.org:8443"],
    ["https://sync.example.org//", "https://sync.example.org"],
    ["http://lan.example.test:8080", "http://lan.example.test:8080"],
    ["   ", ""],
  ]) assert.equal(normalizeServerUrl(typed), stored, typed);

  const field = () => s.render("Server URL").made.find((c) => c.kind === "text");
  field().change("sync.example.org");
  assert.equal(s.plugin.state.data.serverUrl, "https://sync.example.org");
  assert.deepEqual(s.calls, ["state.save"]);

  s.plugin.isMobile = true;
  field().change("http://lan.example.test");
  assert.equal(s.plugin.state.data.serverUrl, "https://sync.example.org", "refused, not stored");
  assert.deepEqual(s.obsidian.notices, ["Mobile Obsidian only reaches HTTPS servers."]);
  field().change("phone.example.org");
  assert.equal(s.plugin.state.data.serverUrl, "https://phone.example.org", "completed to https, so accepted on mobile");
});

test("leaving a server is offered only to an enrolled device, and both routes are destructive-safe", (t) => {
  const s = open(t);
  const row = () => s.rows().find((item) => item.name === "Leave this server");
  assert.ok(row(), "the row is indexed for the settings search either way");
  assert.equal(row().visible(), false, "there is nothing to leave before enrolment");
  assert.equal(row().group.heading, "This device");

  s.plugin.state.data.deviceId = "11".repeat(16);
  assert.equal(row().visible(), true);
  const made = s.render("Leave this server").made;
  assert.deepEqual(made.map((component) => component.text), ["Leave", "Switch server"]);
  assert.equal(s.button(made, "Leave").destructive, true, "leaving is never a plain button");
  assert.match(row().desc, /Every note stays in this vault/);
  assert.deepEqual(s.calls, [], "drawing the row asks the server nothing");
});

test("Set up applies an unsaved folder selection first, in that order, and keeps the token until enrolment", async (t) => {
  const s = open(t);
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change("Notes\n\nAttachments/");
  let setup = s.render("First-time setup");
  setup.made.find((c) => c.kind === "text").change("  TOKEN SENTINEL  ");
  s.button(setup.made, "Set up").click();
  await tick();
  assert.deepEqual(s.calls, ['saveSyncFolders:["Notes","Attachments/"]', "setUp:TOKEN SENTINEL:obsync"]);
  assert.equal(s.updates(), 1);
  // Enrolment did not happen (the stub leaves deviceId null), so the pasted token is still there.
  setup = s.render("First-time setup");
  assert.equal(setup.made.find((c) => c.kind === "text").value, "TOKEN SENTINEL");

  // The same selection, once saved, is not saved again.
  s.plugin.state.data.syncFolders = ["Notes", "Attachments/"];
  s.calls.length = 0;
  s.plugin.setUpAccount = async () => { s.calls.push("setUp"); s.plugin.state.data.deviceId = "11".repeat(16); };
  s.button(s.render("First-time setup").made, "Set up").click();
  await tick();
  assert.deepEqual(s.calls, ["setUp"]);
  assert.equal(s.render("Name").made[0].value, "macos-1a2b", "the enrolled rows draw");
});

test("a folder selection the device refuses stops Set up and Pair this device before they act", async (t) => {
  const s = open(t, { saveSyncFolders: async () => { throw new Error("SCOPE REFUSAL SENTINEL"); } });
  let opened = 0;
  s.box.require(join(s.box.home, "build/ui/modals.js")).PairClaimModal.prototype.open = () => { opened++; };
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change("Notes");
  s.button(s.render("First-time setup").made, "Set up").click();
  s.button(s.render("Pairing").made, "Pair this device").click();
  await tick();
  assert.deepEqual(s.calls, []);
  assert.equal(opened, 0);
  assert.deepEqual(s.obsidian.notices, ["SCOPE REFUSAL SENTINEL", "SCOPE REFUSAL SENTINEL"]);

  // With nothing to apply, Pair this device opens the dialog at once.
  s.render("Folder selection").made[0].change("whole");
  s.button(s.render("Pairing").made, "Pair this device").click();
  await tick();
  assert.equal(opened, 1);
});

test("the device list is read when its row is drawn, once, redrawn when it arrives, and reread on Refresh", async (t) => {
  const self = "1122334455667788990011223344ffff";
  const devices = [
    { device_id: self, name: "Kitchen", platform: "macos", app_version: "1.0.2", last_seen: 0, revoked: false },
    { device_id: "22".repeat(16), name: "Phone", platform: "ios", app_version: "1.0.1", last_seen: 1757200000000, revoked: false },
    { device_id: "33".repeat(16), name: "Old laptop", platform: "linux", app_version: "0.1.20", last_seen: 0, revoked: true },
  ];
  const s = open(t, { listDevices: async () => { s.calls.push("listDevices"); return devices; } });
  s.plugin.state.data.deviceId = self;
  s.plugin.state.paired = true;
  assert.deepEqual(s.rows().filter((item) => item.group.heading === "Devices").map((item) => item.name), ["Device list"]);
  assert.equal(s.row("Device list").desc, "Reading the device list…");

  s.render("Device list");
  s.render("Device list");
  await tick();
  assert.deepEqual(s.calls, ["listDevices"], "drawn twice, read once");
  assert.equal(s.updates(), 1, "the tab is redrawn when the list arrives");
  const names = s.rows().filter((item) => item.group.heading === "Devices").map((item) => item.name);
  assert.deepEqual(names, ["Kitchen (this device)", "Phone", "Old laptop", "Device list"]);
  assert.equal(s.row("Device list").desc, "3 devices on this account.");
  assert.equal(s.row("Old laptop").render, undefined, "a revoked device has nothing to click");
  assert.match(s.row("Old laptop").desc, /revoked/);
  const revoke = s.button(s.render("Phone").made, "Revoke");
  assert.equal(revoke.destructive, true);

  s.render("Device list");
  await tick();
  assert.deepEqual(s.calls, ["listDevices"], "a drawn list is not read again");
  s.button(s.render("Device list").made, "Refresh").click();
  await tick();
  assert.deepEqual(s.calls, ["listDevices", "listDevices"]);
});

test("an unreadable device list says so once and does not loop", async (t) => {
  const s = open(t, { listDevices: async () => { s.calls.push("listDevices"); throw new Error("LIST FAILURE SENTINEL"); } });
  s.plugin.state.data.deviceId = "11".repeat(16);
  s.plugin.state.paired = true;
  s.render("Device list");
  await tick();
  s.render("Device list");
  await tick();
  assert.deepEqual(s.calls, ["listDevices"]);
  assert.equal(s.row("Device list").desc, "The device list is unavailable: LIST FAILURE SENTINEL");
  assert.equal(s.updates(), 1);
});

test("Save to server sends the drafted name and clears the draft", async (t) => {
  const s = open(t);
  s.plugin.state.data.deviceId = "11".repeat(16);
  s.render("Name").made[0].change("Kitchen");
  s.button(s.render("Save to server").made, "Save").click();
  await tick();
  assert.deepEqual(s.calls, ["saveDevice:Kitchen"]);
  assert.deepEqual(s.obsidian.notices, ["This device's settings are saved."]);
  assert.equal(s.updates(), 1);
  assert.equal(s.render("Name").made[0].value, "macos-1a2b", "the field reads the saved name again");
});

for (const failure of [false, true]) test(`folder Save ${failure ? "failure" : "success"} settles without assimilating the host button`, async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const s = open(t, {
    saveSyncFolders: async (folders) => {
      s.calls.push("save");
      assert.deepEqual(folders, ["Notes"]);
      await held;
      if (failure) throw new Error("SAVE FAILURE SENTINEL");
    },
  });
  s.plugin.state.data.syncFolders = ["Notes"];
  // Native BaseComponent.then resolves with itself. This bounded cutoff is a
  // test safety guard: a regression fails without starving Node.
  let thenCalls = 0;
  Component.prototype.then = function (callback) { thenCalls++; callback(thenCalls <= 3 ? this : undefined); return this; };
  t.after(() => { delete Component.prototype.then; });
  const button = s.button(s.render("Save on this device").made, "Save");
  button.click();
  await tick();
  assert.equal(button.disabled, true, "held while the save waits for transfers");
  assert.equal(button.text, "Waiting for transfers…");
  release();
  for (let waited = 0; button.disabled && waited < 20; waited++) await tick();
  assert.equal(thenCalls, 0, "a Promise continuation returned a native thenable component");
  assert.equal(button.disabled, false);
  assert.equal(button.text, "Save");
  assert.deepEqual(s.calls, ["save"]);
  assert.equal(s.updates(), failure ? 0 : 1);
  assert.deepEqual(s.obsidian.notices, [failure ? "SAVE FAILURE SENTINEL" : "Folder selection saved on this device."]);
});

test("the typed folder selection reaches the save through the host's normalizePath", async (t) => {
  // A person typing `Notes/` or `/Attachments//Sub` has made a typo, not a
  // security claim: the host's own normaliser canonicalises what THIS device's
  // owner typed, and `parseSyncFolders` still judges the result. A path that
  // arrives from another device is never normalised anywhere.
  const s = open(t);
  const seen = [];
  s.obsidian.normalizePath = (path) => {
    seen.push(path);
    return path.trim().replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  };
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change("Notes/\n   \n/Attachments//Sub\n");
  s.button(s.render("Save on this device").made, "Save").click();
  await tick();
  assert.deepEqual(seen, ["Notes/", "/Attachments//Sub"], "the blank line never reached the normaliser");
  assert.deepEqual(s.calls, ['saveSyncFolders:["Notes","Attachments/Sub"]']);
});
