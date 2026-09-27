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
    this.inputEl = { listeners: {}, attributes: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, setAttribute(name, value) { this.attributes[name] = value; } };
    this.buttonEl = { focus: () => { this.focused = true; }, remove: () => { this.removed = true; } };
  }
  /** Type a value, then leave the field: the input's `change` event. */
  commit(value) { this.change(value); for (const fn of this.inputEl.listeners.change ?? []) fn(); }
  setDisabled(value) { this.disabled = value; return this; }
  setIcon(value) { this.icon = value; return this; }
  setTooltip(value) { this.tooltip = value; return this; }
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
    addText: add("text"), addTextArea: add("textarea"), addDropdown: add("dropdown"), addButton: add("button"), addExtraButton: add("extra"),
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
    forgottenDevice: false,
    statusText: () => "idle",
    updateLine: () => null,
    heldDeletionLine: () => null,
    confirmHeldDeletions: () => { calls.push("confirmHeldDeletions"); },
    restoreHeldDeletions: async () => { calls.push("restoreHeldDeletions"); },
    deviceName: () => "macos-1a2b",
    platformName: () => "macos",
    listDevices: async () => { calls.push("listDevices"); return []; },
    revokeDevice: async (id) => { calls.push(`revoke:${id}`); },
    saveDeviceSettings: async (name) => { calls.push(`saveDevice:${name}`); },
    saveSyncFolders: async (folders) => { calls.push(`saveSyncFolders:${JSON.stringify(folders)}`); return "saved"; },
    scopeWaitText: () => "Saving…",
    cancelScopeChange: () => { calls.push("cancelScopeChange"); },
    setUpAccount: async (token, account) => { calls.push(`setUp:${token}:${account}`); },
    openDashboard: async () => { calls.push("openDashboard"); },
    openSetupGuide: () => { calls.push("openSetupGuide"); },
    openPluginManager: () => { calls.push("openPluginManager"); },
    wake: (reason) => { calls.push(`wake:${reason}`); },
    watchers: new Set(),
    onStatusChange(watcher) { this.watchers.add(watcher); return () => { this.watchers.delete(watcher); }; },
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
  s.render("Setup or recover");
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
  assert.equal(visible("Setup or recover"), true);
  for (const name of ["Name", "Largest file to download", "Total to keep on this device", "Save to server"]) assert.equal(visible(name), false, name);
  assert.equal(devices(), false);
  assert.equal(visible("Update available"), false);

  s.plugin.state.data.deviceId = "1122334455667788990011223344ffff";
  s.plugin.state.paired = true;
  s.plugin.updateLine = () => "Self Hosted Private Sync 9.9.9 is available (this device runs 1.0.2).";
  assert.equal(visible("Setup or recover"), false);
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

test("the held-deletions row is absent until a pass holds some, and offers both answers", (t) => {
  // The row is a question the user should never be asked idly: a settings
  // page that always offers "Delete everywhere" teaches the click, and the
  // click removes notes from every device (issue #123). Its other answer puts
  // the notes back here (issue #162).
  const s = open(t);
  const shown = () => s.row("Deletions held back").visible();
  assert.equal(shown(), false, "the row was offered with nothing to decide");

  s.plugin.heldDeletionLine = () => "7 note(s) deleted or missing here are still on your other devices: obsync has NOT told them.";
  assert.equal(shown(), true, "the row is hidden while there is something to decide");
  assert.equal(s.row("Deletions held back").desc,
    "7 note(s) deleted or missing here are still on your other devices: obsync has NOT told them.");
  const { made } = s.render("Deletions held back");
  const everywhere = s.button(made, "Delete everywhere");
  const here = s.button(made, "Restore here");
  assert.equal(everywhere.destructive, true, "confirming removes notes from every device");
  assert.notEqual(here.destructive, true, "putting notes back is not the destructive answer");

  assert.equal(s.calls.length, 0, "drawing the row published nothing");
  here.click();
  everywhere.click();
  assert.deepEqual(s.calls, ["restoreHeldDeletions", "confirmHeldDeletions"]);
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
  // Adopted, and a request waiting to retry is sent to it now (#186).
  assert.deepEqual(s.calls, ["state.save", "wake:address"]);

  s.plugin.isMobile = true;
  field().commit("http://lan.example.test");
  assert.equal(s.plugin.state.data.serverUrl, "https://sync.example.org", "refused, not stored");
  assert.deepEqual(s.calls, ["state.save", "wake:address"], "a refused address wakes nothing");
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

test("a header pasted from a command line or wrapped in quotes is unwrapped, saved once, and the person is told (#183)", (t) => {
  // S69: `-H "X-Id: abc"` was saved as the header `-H "X-Id` and dropped by
  // the request layer; every prefix with a colon was saved on the way.
  for (const [typed, headers, told] of [
    ['-H "X-Id: abc"', [{ name: "X-Id", value: "abc" }], "Trimmed a pasted -H and quotes from line 1."],
    ["  --header='X-Id: abc' \\", [{ name: "X-Id", value: "abc" }], "Trimmed a pasted --header and a trailing \\ and quotes from line 1."],
    ["“X-Id: abc”", [{ name: "X-Id", value: "abc" }], "Trimmed quotes from line 1."],
    ["X-Id: abc\n\n  -H X-Secret:  two words  ", [{ name: "X-Id", value: "abc" }, { name: "X-Secret", value: "two words" }], "Trimmed a pasted -H from line 3."],
    ['X-Id: "abc"', [{ name: "X-Id", value: '"abc"' }], null],
    ["", [], null],
  ]) {
    const s = open(t);
    s.plugin.state.data.edgeHeaders = [{ name: "X-Before", value: "kept" }];
    const area = s.render("Edge service-token headers").made.find((c) => c.kind === "textarea");
    assert.equal(area.value, "X-Before: kept");
    // Key by key; emptying the box is one change to "".
    for (let i = Math.min(1, typed.length); i <= typed.length; i++) area.change(typed.slice(0, i));
    assert.deepEqual(s.plugin.state.data.edgeHeaders, [{ name: "X-Before", value: "kept" }], "nothing is stored per keystroke");
    assert.deepEqual(s.calls, []);
    for (const fn of area.inputEl.listeners.change) fn();
    assert.deepEqual(s.plugin.state.data.edgeHeaders, headers, typed);
    assert.deepEqual(s.calls, ["state.save"], "saved once, when the field is left");
    assert.deepEqual(s.obsidian.notices, told === null ? [] : [`Edge service-token headers saved. ${told}`], typed);
    assert.equal(area.value, headers.map((h) => `${h.name}: ${h.value}`).join("\n"), "the field shows what is kept");
    assert.ok(s.plugin.logs.includes(`edge decision=kept headers=${headers.length} trimmed=${told === null ? 0 : 1}`), s.plugin.logs.join("\n"));
  }
});

test("a header that cannot be sent is refused as it is entered, naming the line and the character, and nothing is saved (#183)", (t) => {
  for (const [typed, refusal, reason] of [
    ["X-Id: “abc”", "line 1, character 7, is a curly quote (“). Use straight quotes, or none.", "not_ascii"],
    ['  -H "X-Id: “a”"', "line 1, character 13, is a curly quote (“). Use straight quotes, or none.", "not_ascii"],
    ["X-Ok: 1\nX-Id: café", 'line 2, character 10, is "é" (U+00E9), and a header can carry only plain ASCII letters, digits and punctuation. Retype it.', "not_ascii"],
    ["X-Id: a b", "line 1, character 8, is an invisible character (U+00A0). Delete it and type the line again.", "not_ascii"],
    ["X-Id: a\u0007b", "line 1, character 8, is an invisible character (U+0007). Delete it and type the line again.", "not_ascii"],
    ["X-Id: 😀", 'line 1, character 7, is "😀" (U+1F600), and a header can carry only plain ASCII letters, digits and punctuation. Retype it.', "not_ascii"],
    ["X-Id abc", "line 1 has no colon. Write one header per line as Name: value, for example X-Access-Id: 1234.", "no_colon"],
    [": abc", "line 1 has no header name before the colon. Write one header per line as Name: value, for example X-Access-Id: 1234.", "no_name"],
    ["X-Id:", "line 1 has no value after the colon. Write one header per line as Name: value, for example X-Access-Id: 1234.", "no_value"],
    ["X Id: abc", "line 1: a header name cannot contain a space. Write one header per line as Name: value, for example X-Access-Id: 1234.", "bad_name"],
    ['"X-Id: abc', 'line 1: a header name cannot contain a quote ("). Write one header per line as Name: value, for example X-Access-Id: 1234.', "bad_name"],
    ["X-Id(1): abc", 'line 1: a header name cannot contain "(". Write one header per line as Name: value, for example X-Access-Id: 1234.', "bad_name"],
    ["Content-Type: text/plain", "line 1: obsync sets Content-Type itself, so it cannot be an edge header. Remove that line.", "own_header"],
    ["x-obsync-device: 00", "line 1: obsync sets x-obsync-device itself, so it cannot be an edge header. Remove that line.", "own_header"],
    ["HOST: elsewhere", "line 1: obsync sets HOST itself, so it cannot be an edge header. Remove that line.", "own_header"],
    ["content-length: 0", "line 1: obsync sets content-length itself, so it cannot be an edge header. Remove that line.", "own_header"],
  ]) {
    const s = open(t);
    s.plugin.state.data.edgeHeaders = [{ name: "X-Before", value: "kept" }];
    const area = s.render("Edge service-token headers").made.find((c) => c.kind === "textarea");
    area.commit(typed);
    assert.deepEqual(s.obsidian.notices, [`Edge service-token headers were not saved: ${refusal}`], typed);
    assert.deepEqual(s.plugin.state.data.edgeHeaders, [{ name: "X-Before", value: "kept" }], typed);
    assert.deepEqual(s.calls, [], "a refusal saves nothing");
    assert.ok(s.plugin.logs.includes(`edge decision=refused reason=${reason}`), s.plugin.logs.join("\n"));
  }
});

test("edge headers typed and left behind are adopted when Settings closes, and a refused draft is not kept (#183)", (t) => {
  const s = open(t);
  s.render("Edge service-token headers").made.find((c) => c.kind === "textarea").change("-H 'X-Id: abc'");
  s.tab.hide();
  assert.deepEqual(s.plugin.state.data.edgeHeaders, [{ name: "X-Id", value: "abc" }]);
  assert.deepEqual(s.calls, ["state.save"]);
  s.render("Edge service-token headers").made.find((c) => c.kind === "textarea").change("X-Id: “abc”");
  s.tab.hide();
  assert.deepEqual(s.plugin.state.data.edgeHeaders, [{ name: "X-Id", value: "abc" }]);
  s.tab.hide();
  assert.deepEqual(s.calls, ["state.save"], "a field nobody typed into adopts nothing");
  assert.equal(s.render("Edge service-token headers").made.find((c) => c.kind === "textarea").value, "X-Id: abc");
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
  assert.match(s.obsidian.notices.at(-1), /^Reached your obsync server\. Next: Setup or recover/);

  s.plugin.state.paired = true;
  await check();
  assert.deepEqual(asked, ["manifest", "account"]);
  assert.equal(s.obsidian.notices.at(-1), 'Reached "obsync", 2 device(s).');
});

test("Check reads 'Checking…' at once, asks with a person's patience, and answers in words, never a code (#182)", async (t) => {
  let answer;
  const asked = [];
  const s = open(t, {
    transport: { account: (patience) => { asked.push(patience); return new Promise((resolve, reject) => { answer = { resolve, reject }; }); } },
  });
  const { ApiError } = s.box.require(join(s.box.home, "build/transport.js"));
  s.plugin.state.data.serverUrl = "https://sync.example.org";
  s.plugin.state.paired = true;
  const press = () => {
    const drawn = s.render("Connection");
    const check = s.button(drawn.made, "Check");
    check.click();
    return { setting: drawn.setting, check };
  };
  let { setting, check } = press();
  assert.equal(setting.desc, "Checking…", "the press shows at once");
  assert.equal(check.disabled, true, "and is not pressed twice");
  assert.deepEqual(asked, [{ interactive: true }], "two attempts inside ten seconds, not the background's minute and a half");
  answer.reject(new ApiError(0, "unreachable", "network=ERR_CONNECTION_REFUSED SENTINEL"));
  await tick(); await tick();
  assert.equal(s.obsidian.notices.at(-1),
    "Nothing answered at https://sync.example.org. Check the Server URL, port included; if it has worked before, your server may be switched off or out of this network's reach.");
  assert.doesNotMatch(s.obsidian.notices.join("\n"), /unreachable|SENTINEL|^0 /);
  assert.equal(setting.desc, "idle", "the row says the status again");
  assert.equal(check.disabled, false);

  ({ setting, check } = press());
  answer.reject(new ApiError(403, "device_revoked", "REVOKED SENTINEL"));
  await tick(); await tick();
  assert.match(s.obsidian.notices.at(-1), /removed/i, "a refusal is named for what it is");
  assert.doesNotMatch(s.obsidian.notices.at(-1), /device_revoked|SENTINEL|403/);

  ({ setting, check } = press());
  answer.reject(new ApiError(418, "teapot", "TEAPOT SENTINEL"));
  await tick(); await tick();
  assert.equal(s.obsidian.notices.at(-1), "Your server refused this request; the obsync log names the reason.");
});

test("the Connection row says what the status bar says while Settings is open, and stops following when it closes (#182)", (t) => {
  let words = "idle";
  const s = open(t, { statusText: () => words });
  const { setting } = s.render("Connection");
  assert.equal(s.plugin.watchers.size, 1);
  words = "offline — retrying";
  for (const watcher of s.plugin.watchers) watcher();
  assert.equal(setting.desc, "offline — retrying", "it used to read idle for as long as the tab was open");
  s.render("Connection");
  assert.equal(s.plugin.watchers.size, 1, "a redraw replaces its watcher, not adds one");
  s.tab.hide();
  assert.equal(s.plugin.watchers.size, 0);
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

test("Set up applies an unsaved folder selection first, in that order, and the token is gone after the attempt", async (t) => {
  const s = open(t);
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change("Notes\n\nAttachments");
  let setup = s.render("Setup or recover");
  setup.made.find((c) => c.kind === "text").change("  TOKEN SENTINEL  ");
  s.button(setup.made, "Set up or recover").click();
  await tick();
  // The selection is checked against the vault first (#150), so what the save
  // receives is its canonical form.
  assert.deepEqual(s.calls, ['saveSyncFolders:["Attachments","Notes"]', "setUp:TOKEN SENTINEL:obsync"]);
  assert.equal(s.updates(), 1);
  // Enrolment did not happen (the stub leaves deviceId null), and the refused
  // token is not drawn again (#169): a retry is a fresh paste.
  setup = s.render("Setup or recover");
  assert.equal(setup.made.find((c) => c.kind === "text").value, "");

  // The same selection, once saved, is not saved again.
  s.plugin.state.data.syncFolders = ["Attachments", "Notes"];
  s.calls.length = 0;
  s.plugin.setUpAccount = async () => { s.calls.push("setUp"); s.plugin.state.data.deviceId = "11".repeat(16); };
  s.button(s.render("Setup or recover").made, "Set up or recover").click();
  await tick();
  assert.deepEqual(s.calls, ["setUp"]);
  assert.equal(s.render("Name").made[0].value, "macos-1a2b", "the enrolled rows draw");
});

for (const outcome of ["refused", "enrolled"]) test(`the setup token is masked, can be shown to check it, and is gone after the attempt, ${outcome} (#169)`, async (t) => {
  // A refused token stayed in the field in plain text, and the screenshots
  // people took to ask for help carried it (S41, S35); the token is also the
  // dashboard's recovery sign-in.
  const s = open(t);
  s.plugin.setUpAccount = async (token) => {
    s.calls.push(`setUp:${token}`);
    // The real one reports every refusal in a notice and never throws.
    if (outcome === "enrolled") s.plugin.state.data.deviceId = "11".repeat(16);
  };
  const setup = s.render("Setup or recover");
  const field = setup.made.find((c) => c.kind === "text");
  const eye = setup.made.find((c) => c.kind === "extra");
  assert.equal(field.inputEl.type, "password", "a pasted token is never drawn in plain text");
  assert.equal(field.placeholder, "Setup token");
  eye.click();
  assert.deepEqual([field.inputEl.type, eye.tooltip], ["text", "Hide"], "Show reveals the paste to check it");
  eye.click();
  assert.deepEqual([field.inputEl.type, eye.tooltip], ["password", "Show"]);

  field.change("  TOKEN SENTINEL  ");
  s.button(setup.made, "Set up or recover").click();
  await tick();
  assert.deepEqual(s.calls, ["setUp:TOKEN SENTINEL"]);
  const again = s.render("Setup or recover").made.find((c) => c.kind === "text");
  assert.deepEqual([again.value, again.inputEl.type], ["", "password"], "the token is not drawn again");
});

test("a setup token typed and left behind is gone when Settings closes (#169)", (t) => {
  const s = open(t);
  s.render("Setup or recover").made.find((c) => c.kind === "text").change("TOKEN SENTINEL");
  assert.equal(s.render("Setup or recover").made.find((c) => c.kind === "text").value, "TOKEN SENTINEL", "kept while the tab is open");
  s.tab.hide();
  assert.equal(s.render("Setup or recover").made.find((c) => c.kind === "text").value, "");
  assert.deepEqual(s.calls, [], "closing sends nothing");
});

test("the switch-server dialog masks its setup token and empties it after every attempt (#169)", async (t) => {
  const s = open(t);
  const { AccountSetupModal } = s.box.require(join(s.box.home, "build/ui/modals.js"));
  const modal = new AccountSetupModal({}, s.plugin);
  modal.contentEl = { createEl: () => ({}), empty() {} };
  modal.setTitle = () => {};
  let closed = 0;
  modal.close = () => { closed++; };
  s.made.length = 0;
  modal.onOpen();
  const field = s.made.find((c) => c.kind === "text");
  assert.equal(field.inputEl.type, "password");
  assert.deepEqual(field.inputEl.attributes, LITERAL, "and the keyboard learns nothing (#208)");
  assert.ok(s.made.some((c) => c.kind === "extra" && c.tooltip === "Show"));
  field.value = " TOKEN SENTINEL "; // what the input holds once pasted
  field.change(field.value);
  s.button(s.made, "Set up or recover").click();
  await tick();
  assert.deepEqual(s.calls, ["setUp:TOKEN SENTINEL:obsync"]);
  assert.equal(field.value, "", "the refused token is cleared from the open dialog");
  assert.equal(closed, 0, "a refusal keeps the dialog open for a fresh paste");
  s.button(s.made, "Set up or recover").click();
  await tick();
  assert.deepEqual(s.calls, ["setUp:TOKEN SENTINEL:obsync", "setUp::obsync"], "a second press never resends the old token");
});

/** What a phone keyboard is told about a code or a secret: no capitals, no corrections, no suggestions, nothing learned (#208). */
const LITERAL = { autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false" };

test("every code or secret field in Settings keeps the phone keyboard from capitalising, correcting or learning it (#208)", (t) => {
  // Android 15, Obsidian 1.13.8: the setup token's input type read 0xc0a1 --
  // sentence capitals, autocorrect, suggestions and learning all on.
  const s = open(t);
  const field = (row, kind) => s.render(row).made.find((c) => c.kind === kind);
  assert.deepEqual(field("Server URL", "text").inputEl.attributes, { ...LITERAL, inputmode: "url" });
  for (const [row, kind] of [["Setup or recover", "text"], ["Edge service-token headers", "textarea"], ["Selected folders", "textarea"]]) {
    assert.deepEqual(field(row, kind).inputEl.attributes, LITERAL, row);
  }
  // A name is prose: the keyboard may help with it.
  s.plugin.state.data.deviceId = "11".repeat(16);
  assert.deepEqual(field("Name", "text").inputEl.attributes, {});
});

test("the pairing code and the recovery phrase box keep the phone keyboard out as well (#208)", (t) => {
  const s = open(t);
  const { PairClaimModal, VaultKeyModal } = s.box.require(join(s.box.home, "build/ui/modals.js"));
  s.plugin.captureSession = () => ({ assertCurrent() {} });
  for (const modal of [new PairClaimModal({}, s.plugin), new VaultKeyModal({}, s.plugin)]) {
    modal.contentEl = { createEl: () => ({}), empty() {} };
    modal.setTitle = () => {};
    s.made.length = 0;
    modal.onOpen();
    const input = s.made.find((c) => c.kind === "text" || c.kind === "textarea");
    assert.deepEqual(input.inputEl.attributes, LITERAL, modal.constructor.name);
  }
});

test("a folder selection the device refuses stops Set up and Pair this device before they act", async (t) => {
  const s = open(t, { saveSyncFolders: async () => { throw new Error("SCOPE REFUSAL SENTINEL"); } });
  let opened = 0;
  s.box.require(join(s.box.home, "build/ui/modals.js")).PairClaimModal.prototype.open = () => { opened++; };
  s.render("Folder selection").made[0].change("selected");
  s.render("Selected folders").made[0].change("Notes");
  s.button(s.render("Setup or recover").made, "Set up or recover").click();
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
  const updated = s.updates();
  s.button(s.render("Device list").made, "Refresh").click();
  assert.equal(s.updates(), updated + 1, "Refresh redraws at once: 'Reading the device list…' replaces what was shown (#182)");
  assert.equal(s.row("Device list").desc, "Reading the device list…");
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

test("the device list is read with a person's patience, and a server not answering is said in words (#182)", async (t) => {
  const asked = [];
  const s = open(t, { listDevices: async (patience) => { asked.push(patience); throw new ApiError(0, "unreachable", "network=ERR_TIMED_OUT SENTINEL"); } });
  const { ApiError } = s.box.require(join(s.box.home, "build/transport.js"));
  s.plugin.state.data.deviceId = "11".repeat(16);
  s.plugin.state.paired = true;
  s.render("Device list");
  await tick();
  assert.deepEqual(asked, [{ interactive: true }]);
  assert.equal(s.row("Device list").desc, "The device list is unavailable: Your server is not answering. Sync resumes by itself when it is back.");
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

for (const failure of [false, true]) test(`folder Save ${failure ? "failure" : "success"} names what it waits for, offers Cancel, and settles without assimilating the host button`, async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const s = open(t, {
    scopeWaitText: () => "Stopping the upload of Attachments/video2.bin…",
    saveSyncFolders: async (folders) => {
      s.calls.push("save");
      assert.deepEqual(folders, ["Notes"]);
      await held;
      if (failure) throw new Error("SAVE FAILURE SENTINEL");
      return "saved";
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
  assert.equal(button.text, "Stopping the upload of Attachments/video2.bin…", "the wait says what it is for (#185)");
  const cancel = s.button(s.made, "Cancel");
  assert.equal(cancel.removed, undefined, "and a Cancel stands beside it while it waits");
  release();
  for (let waited = 0; button.disabled && waited < 20; waited++) await tick();
  assert.equal(thenCalls, 0, "a Promise continuation returned a native thenable component");
  assert.equal(button.disabled, false);
  assert.equal(button.text, "Save");
  assert.equal(cancel.removed, true, "the Cancel goes with the wait");
  assert.deepEqual(s.calls, ["save"]);
  assert.equal(s.updates(), failure ? 0 : 1);
  assert.deepEqual(s.obsidian.notices, [failure ? "SAVE FAILURE SENTINEL" : "Folder selection saved on this device."]);
});

test("Cancel while a folder Save waits keeps the selection there was, and says so (#185)", async (t) => {
  let cancelled;
  const withdrawn = new Promise((resolve) => { cancelled = resolve; });
  const s = open(t, {
    saveSyncFolders: async () => { s.calls.push("save"); await withdrawn; return "withdrawn"; },
    cancelScopeChange: () => { s.calls.push("cancelScopeChange"); cancelled(); },
  });
  s.plugin.state.data.syncFolders = ["Notes"];
  const button = s.button(s.render("Save on this device").made, "Save");
  button.click();
  await tick();
  const cancel = s.button(s.made, "Cancel");
  cancel.click();
  assert.equal(cancel.disabled, true, "one press of Cancel");
  for (let waited = 0; button.disabled && waited < 20; waited++) await tick();
  assert.deepEqual(s.calls, ["save", "cancelScopeChange"]);
  assert.deepEqual(s.obsidian.notices, ["Folder selection unchanged: sync goes on with the folders it had."]);
  assert.equal(cancel.removed, true);
  assert.equal(button.text, "Save");
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


test("re-enrollment replaces a cached revoked-device error with the recovered account list", async (t) => {
  const s = open(t, { listDevices: async () => { throw new Error("device_revoked"); } });
  s.plugin.state.data.deviceId = "11".repeat(16);
  s.plugin.state.paired = true;
  s.render("Device list");
  await tick();
  assert.match(s.row("Device list").desc, /device_revoked/);
  s.plugin.setUpAccount = async () => { s.plugin.state.data.deviceId = "22".repeat(16); };
  s.plugin.listDevices = async () => [{ device_id: "22".repeat(16), name: "Recovered", platform: "macos", app_version: "1.1.3", last_seen: 0, revoked: false }];
  s.button(s.render("Setup or recover").made, "Set up or recover").click();
  await tick();
  s.render("Device list");
  await tick();
  assert.equal(s.row("Device list").desc, "1 device on this account.");
  assert.ok(s.row("Recovered (this device)"));
});

for (const changed of ["deviceId", "serverUrl"]) for (const failed of [false, true]) {
  test(`a previous ${changed} device-list ${failed ? "error" : "response"} cannot replace the recovered account`, async (t) => {
    let finish, refuse;
    const s = open(t, { listDevices: () => new Promise((resolve, reject) => { finish = resolve; refuse = reject; }) });
    s.plugin.state.data.deviceId = "11".repeat(16);
    s.plugin.state.data.serverUrl = "https://old.example.org";
    s.plugin.state.paired = true;
    s.render("Device list");
    s.plugin.state.data[changed] = changed === "deviceId" ? "22".repeat(16) : "https://new.example.org";
    if (failed) refuse(new Error("old identity refusal"));
    else finish([{ device_id: "11".repeat(16), name: "Old identity", platform: "macos", app_version: "1.1.3", last_seen: 0, revoked: false }]);
    await tick();
    assert.equal(s.row("Device list").desc, "Reading the device list…");
    assert.ok(!s.rows().some((row) => row.name.startsWith("Old identity")));
    s.plugin.listDevices = async () => [];
    s.render("Device list");
    await tick();
    assert.equal(s.row("Device list").desc, "0 devices on this account.");
  });
}


test("closing a completed pairing redraws settings for the new identity", async (t) => {
  const s = open(t, { listDevices: async () => { throw new Error("old refused identity"); } });
  s.plugin.state.data.deviceId = "11".repeat(16);
  s.render("Device list"); await tick();
  let modal;
  const { PairClaimModal } = s.box.require(join(s.box.home, "build/ui/modals.js"));
  PairClaimModal.prototype.open = function () { modal = this; };
  s.button(s.render("Pairing").made, "Pair this device").click(); await tick();
  assert.ok(modal);
  s.plugin.state.data.deviceId = "22".repeat(16);
  modal.contentEl = { empty() {} };
  modal.onClose();
  assert.equal(s.row("Device list").desc, "Reading the device list…");
});

test("the Recovery phrase row reads Not confirmed with a Show and confirm button until the words are confirmed (#170)", (t) => {
  const s = open(t);
  const { RECOVERY_UNCONFIRMED } = s.box.require(join(s.box.home, "build/ui/modals.js"));
  const opened = [];
  s.obsidian.Modal.prototype.open = function () { opened.push(this); };
  const show = () => s.render("Recovery phrase").made.find((c) => c.text === "Show" || c.text === "Show and confirm");
  s.plugin.state.data.vrk = "00".repeat(32);
  for (const state of [undefined, "unconfirmed", "skipped"]) {
    s.plugin.state.data.recoveryPhrase = state;
    assert.equal(s.row("Recovery phrase").desc, RECOVERY_UNCONFIRMED, String(state));
    assert.match(RECOVERY_UNCONFIRMED, /^Not confirmed — Show and confirm\. /);
    const button = show();
    assert.deepEqual([button.text, button.cta, button.disabled], ["Show and confirm", true, false], String(state));
    opened.length = 0;
    button.click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].confirmFirst, true, "the button opens the dialog to confirm");
    const before = s.updates();
    opened[0].afterClose();
    assert.equal(s.updates(), before + 1, "closing it redraws the row");
  }
  s.plugin.state.data.recoveryPhrase = "confirmed";
  assert.match(s.row("Recovery phrase").desc, /^24 words that are the vault key\./);
  assert.deepEqual([show().text, show().cta], ["Show", undefined]);
  opened.length = 0;
  show().click();
  assert.equal(opened[0].confirmFirst, false);

  s.plugin.state.data.vrk = null;
  s.plugin.state.data.recoveryPhrase = undefined;
  assert.match(s.row("Recovery phrase").desc, /^This device holds no vault key\./, "no key, nothing to confirm");
  assert.deepEqual([show().text, show().disabled], ["Show", true]);
});
