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
  constructor(kind) {
    this.kind = kind; this.disabled = false;
    this.inputEl = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); } };
    this.buttonEl = { focus: () => { this.focused = true; } };
  }
  /** Type a value, then leave the field: the input's `change` event. */
  commit(value) { this.change(value); for (const fn of this.inputEl.listeners.change ?? []) fn(); }
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
    openSetupGuide: () => { calls.push("openSetupGuide"); },
    openPluginManager: () => { calls.push("openPluginManager"); },
    logs: [],
    log(line) { this.logs.push(line); },
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
  // Obsidian's index of this vault's folders, keyed by the spelling the
  // directory keeps, and a host on a volume that FOLDS case -- the owner's
  // Mac -- whose lookup finds that one entry by either spelling (`main.ts`,
  // `spelling`). A test on a volume that keeps spellings apart replaces it.
  const vault = { folders: ["Notes", "Attachments", "Attachments/Sub"], getFolderByPath: (path) => (vault.folders.includes(path) ? { path } : null) };
  plugin.host ??= { spelling: async (path) => vault.folders.find((folder) => folder.toLowerCase() === path.toLowerCase()) ?? null };
  const tab = new settings.ObsyncSettingTab({ vault }, plugin);
  let updates = 0;
  tab.update = () => { updates++; };
  const rows = () => tab.getSettingDefinitions().flatMap((group) => group.items.map((item) => ({ ...item, group })));
  const row = (name) => { const found = rows().find((item) => item.name === name); assert.ok(found, `row ${name}`); return found; };
  const render = (name) => { made.length = 0; const setting = new obsidian.Setting({}); const result = row(name).render(setting); return { result, made: [...made], setting }; };
  const button = (list, text) => { const found = list.find((c) => c.kind === "button" && c.text === text); assert.ok(found, `button ${text}`); return found; };
  return { box, obsidian, plugin, calls, settings, tab, rows, row, render, button, made, vault, updates: () => updates };
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
  assert.deepEqual(groups.map((group) => group.type), ["group", "group", "group", "group", "group", "group"]);
  assert.deepEqual(groups.map((group) => group.heading), ["Get started", "Server", "Sync folders on this device", "This device", "Devices", "Vault key"]);
  for (const item of s.rows()) {
    assert.ok(typeof item.name === "string" && item.name !== "", "every row has a name for search");
    if (item.render === undefined) continue;
    // Obsidian's Setting is thenable; a render that returned it would be
    // awaited by whoever holds the definitions.
    assert.equal(s.render(item.name).result, undefined, `${item.name} returns nothing`);
  }
});

test("the setup guide is the first row on every platform, paired or not, and a press asks the plugin to open it", (t) => {
  for (const isMobile of [false, true]) {
    const s = open(t, { isMobile });
    for (const paired of [false, true]) {
      s.plugin.state.paired = paired;
      const first = s.tab.getSettingDefinitions()[0];
      assert.equal(first.heading, "Get started");
      assert.equal(first.visible, undefined, "the group never hides");
      assert.deepEqual(first.items.map((item) => [item.name, item.visible]), [["Setup guide", undefined]]);
    }
    s.button(s.render("Setup guide").made, "Open the guide").click();
    assert.deepEqual(s.calls, ["openSetupGuide"], isMobile ? "mobile" : "desktop");
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
    // Copied from a browser: only the origin is the server's address (#137).
    ["https://sync.example.org:8443/readyz", "https://sync.example.org:8443"],
    ["HTTPS://SYNC.Example.ORG:8443/login?token=SENTINEL#top", "https://sync.example.org:8443"],
    ["Https://phone.example.org", "https://phone.example.org"],
    ["sync.example.org:8443/dashboard/", "https://sync.example.org:8443"],
  ]) assert.equal(normalizeServerUrl(typed), stored, typed);

  const field = () => s.render("Server URL").made.find((c) => c.kind === "text");
  field().commit("sync.example.org");
  assert.equal(s.plugin.state.data.serverUrl, "https://sync.example.org");
  assert.deepEqual(s.calls, ["state.save"]);

  s.plugin.isMobile = true;
  field().commit("http://lan.example.test");
  assert.equal(s.plugin.state.data.serverUrl, "https://sync.example.org", "refused, not stored");
  assert.deepEqual(s.obsidian.notices, ["Mobile Obsidian only reaches HTTPS servers."]);
  field().commit("phone.example.org");
  assert.equal(s.plugin.state.data.serverUrl, "https://phone.example.org", "completed to https, so accepted on mobile");
});

test("plain http is refused on every platform, loopback on a desktop excepted", (t) => {
  const s = open(t);
  const field = () => s.render("Server URL").made.find((c) => c.kind === "text");
  const { serverUrlRefusal } = s.settings;
  // A desktop: plain http crosses the network in the clear, so it is refused (#136).
  field().commit("http://lan.example.test:8080");
  assert.equal(s.plugin.state.data.serverUrl, "", "refused, not stored");
  assert.deepEqual(s.obsidian.notices.length, 1);
  assert.match(s.obsidian.notices[0], /^Use your server's https address\. Plain HTTP would send the setup token/);
  // Only this computer itself may be reached in plain http: the README's one-computer trial.
  for (const url of ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080", "http://127.1.2.3"]) {
    field().commit(url);
    assert.equal(s.plugin.state.data.serverUrl, url, `${url} is loopback`);
  }
  for (const url of ["http://127.0.0.1.example.test", "http://localhost.example.test:8080", "http://10.0.0.1:8080", "ftp://sync.example.org"]) {
    assert.notEqual(serverUrlRefusal(url, false), null, `${url} is not loopback`);
  }
  // A phone refuses even loopback, and takes the scheme a keyboard capitalised.
  s.plugin.isMobile = true;
  assert.equal(serverUrlRefusal("http://127.0.0.1:8080", true), "Mobile Obsidian only reaches HTTPS servers.");
  field().commit("Https://phone.example.org");
  assert.equal(s.plugin.state.data.serverUrl, "https://phone.example.org");
});

test("an address typed one key at a time is adopted once, when the field is left or Settings closes", (t) => {
  const s = open(t);
  s.plugin.state.data.serverUrl = "https://before.example.org";
  const field = s.render("Server URL").made.find((c) => c.kind === "text");
  const type = (text) => { for (let i = 1; i <= text.length; i++) field.change(text.slice(0, i)); };
  type("http://lan.example.test:8080");
  assert.equal(s.plugin.state.data.serverUrl, "https://before.example.org", "no prefix is stored while typing");
  assert.deepEqual(s.obsidian.notices, [], "and nothing is said while typing");
  for (const fn of field.inputEl.listeners.change) fn();
  assert.equal(s.plugin.state.data.serverUrl, "https://before.example.org", "a refused address leaves the one before it");
  assert.equal(s.obsidian.notices.length, 1, "one notice, when the person is done");
  // A loopback address typed key by key raises nothing on the way.
  type("http://127.0.0.1:8080");
  for (const fn of field.inputEl.listeners.change) fn();
  assert.equal(s.plugin.state.data.serverUrl, "http://127.0.0.1:8080");
  assert.equal(s.obsidian.notices.length, 1);
  // Closing Settings is leaving the field: a draft is adopted, not lost.
  const again = s.render("Server URL").made.find((c) => c.kind === "text");
  again.change("sync.example.org");
  s.tab.hide();
  assert.equal(s.plugin.state.data.serverUrl, "https://sync.example.org");
  // And a field nobody typed into adopts nothing.
  const saves = s.calls.filter((c) => c === "state.save").length;
  s.tab.hide();
  assert.equal(s.calls.filter((c) => c === "state.save").length, saves);
});

test("Check asks the server without a credential before setup, and says to type an address first", async (t) => {
  const asked = [];
  const s = open(t, {
    transport: {
      account: async () => { asked.push("account"); return { name: "obsync", device_count: 2 }; },
      pluginManifest: async () => { asked.push("manifest"); return { version: "1.1.3" }; },
    },
  });
  const check = () => { s.button(s.render("Connection").made, "Check").click(); return tick(); };
  await check();
  assert.deepEqual(asked, [], "no address, no request");
  assert.deepEqual(s.obsidian.notices, ["Type your server's address in Server URL first."]);

  s.plugin.state.data.serverUrl = "https://sync.example.org";
  await check();
  assert.deepEqual(asked, ["manifest"], "before setup the signed read would only say 'not paired'");
  assert.match(s.obsidian.notices.at(-1), /^Reached your obsync server\. Next: First-time setup/);

  s.plugin.state.paired = true;
  await check();
  assert.deepEqual(asked, ["manifest", "account"]);
  assert.equal(s.obsidian.notices.at(-1), 'Reached "obsync", 2 device(s).');
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
  s.render("Selected folders").made[0].change("Notes\n\nAttachments");
  let setup = s.render("First-time setup");
  setup.made.find((c) => c.kind === "text").change("  TOKEN SENTINEL  ");
  s.button(setup.made, "Set up").click();
  await tick();
  // The selection is checked against the vault first (#150), so what the save
  // receives is its canonical form.
  assert.deepEqual(s.calls, ['saveSyncFolders:["Attachments","Notes"]', "setUp:TOKEN SENTINEL:obsync"]);
  assert.equal(s.updates(), 1);
  // Enrolment did not happen (the stub leaves deviceId null), so the pasted token is still there.
  setup = s.render("First-time setup");
  assert.equal(setup.made.find((c) => c.kind === "text").value, "TOKEN SENTINEL");

  // The same selection, once saved, is not saved again.
  s.plugin.state.data.syncFolders = ["Attachments", "Notes"];
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
  assert.deepEqual(s.calls, ['saveSyncFolders:["Attachments/Sub","Notes"]'], "canonical, and checked against the vault (#150)");
});

// ---- issue #150: a selection is checked against the vault before it is saved ----

/**
 * Every question the tab asks, drawn for real (`ConfirmModal.onOpen`) into
 * recording widgets and answered by pressing the button a test names. A test
 * that names none expects no question at all.
 */
function questions(s, answer) {
  const asked = [];
  s.obsidian.Modal.prototype.open = function () {
    const drawn = [];
    this.contentEl = { createEl: (tag, { text = "" } = {}) => { drawn.push(text); return {}; }, empty: () => {} };
    this.setTitle = (title) => { this.title = title; };
    this.close = () => this.onClose();
    s.made.length = 0;
    this.onOpen();
    const buttons = [...s.made];
    // What Obsidian does once `onOpen` returns: the focus goes to the first button.
    buttons[0].buttonEl.focus();
    asked.push({ title: this.title, text: drawn.join("\n"), buttons });
    if (answer === null) assert.fail(`no question was expected, and "${this.title}" was asked`);
    buttons.find((button) => button.text === answer).click();
  };
  return asked;
}

/** Type a selection and press Save, as S30 did. */
async function saveTyped(s, text) {
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change(text);
  const save = s.button(s.render("Save on this device").made, "Save");
  save.click();
  await tick();
  return save;
}

test("a folder the vault does not have is asked about first, Cancel holds the focus, and Cancel saves nothing", async (t) => {
  // S30c: `Nopes` was stored with "saved" and a bare `idle`, and nothing synced.
  const s = open(t);
  const asked = questions(s, "Cancel");
  const save = await saveTyped(s, "Nopes");

  assert.equal(asked.length, 1, "the save never asked");
  assert.equal(asked[0].title, '"Nopes" is not a folder in this vault. Save anyway?');
  const [cancel, anyway] = asked[0].buttons;
  assert.equal(anyway.text, "Save anyway");
  assert.equal(cancel.text, "Cancel");
  assert.equal(cancel.focused, true, "Enter is never the answer that saves");
  assert.equal(anyway.focused, undefined);
  assert.deepEqual(s.calls, [], "a declined selection was saved");
  assert.deepEqual(s.obsidian.notices, [], "and nothing claimed it was");
  assert.deepEqual(s.plugin.logs, ["scope decision=declined reason=not_a_folder folders=1"]);
  assert.equal(save.disabled, false);
  assert.equal(save.text, "Save");

  // Saving anyway is the person's own click, and saves exactly what they typed.
  questions(s, "Save anyway");
  save.click();
  await tick();
  assert.deepEqual(s.calls, ['saveSyncFolders:["Nopes"]']);
  assert.deepEqual(s.obsidian.notices, ["Folder selection saved on this device."]);
  assert.equal(s.plugin.logs.at(-1), "scope decision=confirmed reason=not_a_folder folders=1");

  // A FILE by that name is not a folder either: the host's lookup finds the
  // entry, and the index does not hold it as a folder.
  s.calls.length = 0;
  const lookup = s.plugin.host.spelling;
  s.plugin.host.spelling = async (path) => (path === "readme.md" ? "Readme.md" : lookup(path));
  const again = questions(s, "Cancel");
  await saveTyped(s, "readme.md");
  assert.equal(again[0]?.title, '"readme.md" is not a folder in this vault. Save anyway?');
  assert.deepEqual(s.calls, []);
});

test("a folder typed in another case is saved the way the vault spells it, and the person is told", async (t) => {
  // S30a: `notes` for the real `Notes` was saved as typed, and the scan then
  // republished the folder's notes under that spelling with older text.
  const s = open(t);
  s.vault.folders.push("Notes/Daily");
  questions(s, null);
  await saveTyped(s, "notes\nNotes/Daily");

  // Re-cased, and then one canonical selection: the parent covers its child.
  assert.deepEqual(s.calls, ['saveSyncFolders:["Notes"]'], "the typed spelling was saved");
  assert.deepEqual(s.obsidian.notices, [
    'Folder selection saved on this device. "notes" is saved as "Notes", the way this vault spells it.',
  ]);
  assert.deepEqual(s.plugin.logs, ["scope decision=recased reason=vault_spelling folders=1"]);

  // A name the index holds exactly is the vault's own, whatever the host's
  // lookup says: a Finder-made accented folder is decomposed on disk and
  // composed in the index, and the lookup matches neither form to the other.
  s.calls.length = 0;
  s.obsidian.notices.length = 0;
  s.vault.folders.push("Espa\u00f1ol");
  s.plugin.host.spelling = async () => null;
  await saveTyped(s, "Espa\u00f1ol");
  assert.deepEqual(s.calls, ['saveSyncFolders:["Espa\u00f1ol"]']);
  assert.deepEqual(s.obsidian.notices, ["Folder selection saved on this device."]);

  // A volume that keeps two spellings apart has no `notes` at all: that is a
  // folder the vault does not have, asked about, never quietly swapped for
  // another folder the person did not name.
  s.calls.length = 0;
  s.plugin.host.spelling = async (path) => (s.vault.folders.includes(path) ? path : null);
  const asked = questions(s, "Cancel");
  await saveTyped(s, "notes");
  assert.equal(asked[0]?.title, '"notes" is not a folder in this vault. Save anyway?');
  assert.deepEqual(s.calls, []);
});

test("an empty selection is saved and says that nothing syncs", async (t) => {
  // S30d: stored `[]`, notice only "saved", and a bare `idle`.
  const s = open(t);
  questions(s, null);
  await saveTyped(s, "\n  \n");

  assert.deepEqual(s.calls, ["saveSyncFolders:[]"]);
  assert.deepEqual(s.obsidian.notices, [
    "Folder selection saved on this device. No folder is selected, so nothing syncs on this device.",
  ]);
});

test("a hidden folder is refused in plain words, before any question, with the refusal's code in the log", async (t) => {
  // S30f: "refused: not a vault path (hidden_segment)".
  const s = open(t);
  questions(s, null);
  await saveTyped(s, "Notes\n.obsidian");

  assert.deepEqual(s.calls, [], "the refused selection reached the save");
  assert.equal(s.obsidian.notices.length, 1);
  assert.match(s.obsidian.notices[0], /^That selection cannot be saved: each line must be a folder inside this vault/);
  assert.match(s.obsidian.notices[0], /names start with a dot/);
  assert.equal(/hidden_segment|\(/.test(s.obsidian.notices[0]), false, s.obsidian.notices[0]);
  assert.deepEqual(s.plugin.logs, ["scope decision=refused reason=hidden_segment"]);
});

test("a ceiling typed key by key is kept and saved only when the field is left, so a typo never becomes a one-byte ceiling", async (t) => {
  // 2026-09-24 verification of the 1.1.3 train (S31 step 1, real keys): every
  // keystroke that read as a size was kept, so `1 MX` passed through `1` and
  // stayed a one-byte ceiling after its refusal, and a kept `1 MB` reached
  // data.json only with some later, unrelated save.
  const s = open(t);
  s.plugin.state.data.deviceId = "11".repeat(16);
  const policy = s.plugin.state.data.policy;
  const { setting, made: [field] } = s.render("Largest file to download");
  const type = (text) => { for (let i = 1; i <= text.length; i++) field.change(text.slice(0, i)); };
  const leave = () => { for (const fn of field.inputEl.listeners.change ?? []) fn(); };

  type("1 MX");
  assert.equal(policy.perFileMaxBytes, 0, "a keystroke was kept as the ceiling");
  leave();
  assert.equal(policy.perFileMaxBytes, 0, "the refused typo left its prefix as the ceiling");
  assert.equal(s.obsidian.notices.length, 1);
  assert.deepEqual(s.calls.filter((c) => c === "state.save"), [], "a refusal saves nothing");

  type("1 MB");
  assert.equal(policy.perFileMaxBytes, 0, "a keystroke was kept as the ceiling");
  leave();
  await tick();
  assert.equal(policy.perFileMaxBytes, 1_000_000);
  assert.equal(s.calls.filter((c) => c === "state.save").length, 1, "the kept ceiling was not saved");
  assert.match(setting.desc, /Currently 977 KiB\./, "the row still names the ceiling it had");
  assert.equal(s.plugin.logs.at(-1), "policy decision=kept field=perFileMaxBytes bytes=1000000");

  leave();
  await tick();
  assert.equal(s.calls.filter((c) => c === "state.save").length, 1, "leaving an unchanged field saves again");
});

test("a download ceiling takes decimal and binary units, and an unreadable one is refused out loud, never dropped", async (t) => {
  // S31 step 1: `1 MB` stayed in the field, nothing was stored, and after a
  // restart the row read "unlimited".
  const s = open(t);
  const { parseBytes, formatBytes } = s.box.require(join(s.box.home, "build/policy.js"));
  for (const [typed, bytes] of [
    ["1 MB", 1_000_000], ["1mb", 1_000_000], ["10 KB", 10_000], ["1.5 GB", 1_500_000_000], ["2 TB", 2_000_000_000_000],
    ["1 MiB", 1 << 20], ["512 KiB", 512 * 1024], ["7", 7], ["unlimited", 0], ["0", 0],
    ["1 MX", null], ["MB", null], ["", null], ["-1 MB", null],
  ]) assert.equal(parseBytes(typed), bytes, JSON.stringify(typed));

  s.plugin.state.data.deviceId = "11".repeat(16);
  const policy = s.plugin.state.data.policy;
  for (const [row, key, typed, bytes] of [
    ["Largest file to download", "perFileMaxBytes", "1 MB", 1_000_000],
    ["Total to keep on this device", "totalBudgetBytes", "2 GB", 2_000_000_000],
  ]) {
    const field = s.render(row).made[0];
    field.commit(typed);
    assert.equal(policy[key], bytes, `${row}: ${typed}`);
    assert.deepEqual(s.obsidian.notices, [], "an accepted value raises nothing");

    field.commit("1 MX");
    assert.equal(policy[key], bytes, "an unreadable value changes nothing");
    assert.deepEqual(s.obsidian.notices, [
      `${row}: "1 MX" is not a size. Type a number with B, KB, MB, GB, KiB, MiB or GiB, or 0 for unlimited.`,
    ]);
    assert.equal(field.value, formatBytes(bytes), "and the field shows what is kept, not what was refused");
    assert.equal(s.plugin.logs.at(-1), `policy decision=refused reason=unreadable_size field=${key}`);
    s.obsidian.notices.length = 0;
  }
});
