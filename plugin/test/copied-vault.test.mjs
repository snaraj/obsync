/**
 * A copied vault, or one whose folder was renamed outside Obsidian (issue
 * #168). Obsidian registers either as a new vault id, whose secret storage and
 * local storage hold nothing, so the data file names a credential this vault
 * never held. That used to stop the plugin in `onload` with a storage error,
 * no status bar, no settings tab, and advice not to do the one thing that
 * fixes it (S37, S88).
 *
 * Pinned here: the state tells a copy (a well-formed reference this vault
 * never held, no secret behind it) from a fault (a reference it held whose
 * secret is gone), a copy loads unpaired and never as the device it names,
 * nothing is written until the person pairs or starts fresh, and the compiled
 * plugin gives a copy its status bar and settings tab while a fault keeps the
 * protective stop.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { KEYS, sandbox, statusItem } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { State, StateStorageError } = require("../build/state.js");
const clone = (value) => structuredClone(value);
const tick = () => new Promise(setImmediate);

const ORIGINAL = () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, deviceName: "Study laptop",
  serverUrl: "https://sync.example.invalid", edgeHeaders: [{ name: "X-Service", value: "EDGE SENTINEL" }], lastSeq: 7,
  files: { "Notes/a.md": { fileId: "12".repeat(16), versionId: "34".repeat(32), size: 4, mtime: 1, sha256: "" } },
  folders: { Notes: { fileId: "56".repeat(16), versionId: "78".repeat(32) } },
  feedMark: { seq: 7, fileId: "12".repeat(16), versionId: "34".repeat(32), ts: 5, replay: false },
  syncFolders: ["Notes"], policy: { perFileMaxBytes: 11, totalBudgetBytes: 22 }, recoveryPhrase: "confirmed",
  notices: { level: "needs-me", merges: "every" } });

/** One vault as Obsidian keeps it: a data file, a secret store and a local-storage record, each per vault id. */
function vault(metadata = null) {
  let data = clone(metadata);
  const secrets = new Map(), calls = [], writes = [], failures = [];
  let held = null;
  const store = {
    loadData: async () => clone(data),
    saveData: async (value) => { writes.push(clone(value)); data = clone(value); },
  };
  const native = {
    getSecret: (id) => { calls.push(["get", id]); return secrets.get(id) ?? null; },
    setSecret: (id, value) => { calls.push(["set", id]); secrets.set(id, value); },
  };
  const probe = { holds: (ref) => held === ref, hold: (ref) => { calls.push(["hold", ref]); held = ref; } };
  return { store, native, probe, secrets, calls, writes, failures, data: () => clone(data), held: () => held,
    open: () => State.open(store, false, native, (error) => failures.push(error.reason), () => true, undefined, probe) };
}

/** A vault that has synced: migrated, reopened, its reference held. */
async function synced() {
  const original = vault(ORIGINAL());
  await original.open();
  await original.open();
  return original;
}

/** Its folder copied, or renamed in Finder: the data file only. */
const copyOf = (original) => vault(original.data());

test("a reference this vault never held, with no secret behind it, loads as an unpaired copy and writes nothing (#168)", async () => {
  const original = await synced();
  const copy = copyOf(original);
  const state = await copy.open();

  assert.equal(state.copied, true);
  assert.equal(state.paired, false);
  // Never the device the reference names: its identity, key and every record
  // on the server go; what the person chose for this vault stays.
  assert.deepEqual({ ...state.data }, {
    vrk: null, deviceId: null, deviceSecret: null, deviceName: null, deviceTag: null,
    serverUrl: "https://sync.example.invalid", edgeHeaders: [], lastSeq: 0, files: {}, folders: {}, remoteOnly: {},
    retiredRoots: {}, folderBarriers: [], folderRemovals: {}, parked: {}, dropped: {}, paused: {}, departed: {}, replaying: null,
    heldDeletions: [], feedMark: null, graves: {},
    syncFolders: ["Notes"], policy: { perFileMaxBytes: 11, totalBudgetBytes: 22 }, recoveryPhrase: "unconfirmed",
    notices: { level: "needs-me", merges: "every" },
  });
  assert.deepEqual(copy.writes, [], "nothing is written until the person acts");
  assert.deepEqual(copy.data(), original.data());
  assert.deepEqual(copy.failures, [], "a copy is not a failure");
  assert.equal(copy.held(), null);
  const ref = original.data().credentialRef;
  assert.deepEqual(copy.calls.map(([op]) => op), ["get", "get"], "its own reference, then a fresh one is checked free");
  assert.equal(copy.calls[0][1], ref);
  assert.notEqual(copy.calls[1][1], ref);
  assert.ok(!JSON.stringify(state.data).includes("EDGE SENTINEL"));
});

test("a reference this vault held whose secret is gone is a storage fault that stops loading, and never a copy (#168)", async () => {
  const original = await synced();
  const ref = original.data().credentialRef;
  assert.equal(original.held(), ref, "opening the vault records the reference it holds");
  original.secrets.delete(ref);
  const before = original.data(), writes = original.writes.length;
  await assert.rejects(original.open(), (error) => {
    assert.ok(error instanceof StateStorageError);
    assert.equal(error.reason, "missing_secret");
    // What happened and what to do; no raw code, and no longer a ban on the
    // step that gets a vault whose credentials are truly gone syncing again.
    assert.equal(error.message.includes("missing_secret"), false);
    assert.equal(/Do not|delete the credential reference/.test(error.message), false);
    assert.match(error.message, /Sync is stopped, and nothing was sent or changed\. Reload Obsidian\./);
    assert.match(error.message, /pair this device again/);
    return true;
  });
  assert.deepEqual(original.failures, ["missing_secret"]);
  assert.deepEqual(original.data(), before);
  assert.equal(original.writes.length, writes);
});

test("only a missing secret can be a copy: a damaged one this vault never held is still a fault (#168)", async () => {
  const original = await synced();
  const copy = copyOf(original);
  copy.secrets.set(original.data().credentialRef, "not JSON");
  await assert.rejects(copy.open(), /could not read or save/);
  assert.deepEqual(copy.failures, ["load_failed"]);
  assert.deepEqual(copy.writes, []);
});

test("a copy's first save gives it an installation of its own, and it opens normally from then on (#168)", async () => {
  const original = await synced();
  const copy = copyOf(original);
  const state = await copy.open();
  state.data.serverUrl = "";
  await state.save();
  assert.equal(state.copied, false);
  const saved = copy.data();
  assert.notEqual(saved.installationId, original.data().installationId);
  assert.equal(saved.credentialRef, `obsync-private-sync-v1-${saved.installationId}`);
  assert.equal(saved.deviceId, null);
  assert.equal(JSON.parse(copy.secrets.get(saved.credentialRef)).current.deviceId, null);
  const reopened = await copy.open();
  assert.equal(reopened.copied, false);
  assert.equal(copy.held(), saved.credentialRef, "and holds its own reference");
  assert.deepEqual(original.secrets.has(saved.credentialRef), false, "the original is untouched");
});

test("a vault upgraded from 1.1.3 records the reference it holds on its first open, so a later loss is a fault (#168)", async () => {
  // 1.1.3 recorded nothing: a vault with its secret present loads as always,
  // and from then on it is known to hold its reference.
  const upgraded = await synced();
  const fresh = vault(upgraded.data());
  for (const [id, value] of upgraded.secrets) fresh.secrets.set(id, value);
  const state = await fresh.open();
  assert.equal(state.copied, false);
  assert.equal(state.paired, true);
  assert.equal(fresh.held(), upgraded.data().credentialRef);
  fresh.secrets.clear();
  await assert.rejects(fresh.open(), /could not read or save/);
});

// ---- the compiled plugin ------------------------------------------------------

function plugin(t, metadata, { localStorage = new Map(), secrets = new Map() } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const requests = [];
  obsidian.requestUrl = async (request) => { requests.push(request); return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }; };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  let data = clone(metadata);
  const writes = [], tabs = [], bars = [], logs = [];
  instance.loadData = async () => clone(data);
  instance.saveData = async (value) => { writes.push(clone(value)); data = clone(value); };
  instance.addCommand = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addSettingTab = (tab) => { tabs.push(tab); };
  instance.addStatusBarItem = () => { const bar = statusItem(); bars.push(bar); return bar; };
  instance.app = {
    secretStorage: { getSecret: (id) => secrets.get(id) ?? null, setSecret: (id, value) => { secrets.set(id, value); } },
    loadLocalStorage: (key) => localStorage.get(key) ?? null,
    saveLocalStorage: (key, value) => { localStorage.set(key, value); },
    vault: { adapter: {}, on: () => ({}) },
    workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed() },
  };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.4" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  return { box, obsidian, instance, requests, writes, tabs, bars, logs, localStorage, secrets, data: () => clone(data) };
}

/** The original vault, set up by the compiled plugin itself: its data file, secret store and local storage. */
async function syncedPlugin(t) {
  const original = plugin(t, ORIGINAL());
  await original.instance.onload();
  assert.equal(original.instance.state.paired, true);
  return original;
}

test("the compiled plugin gives a copy its status bar and settings tab, says what happened once, and syncs nothing (#168)", async (t) => {
  const original = await syncedPlugin(t);
  const copy = plugin(t, original.data());
  await copy.instance.onload();
  await tick();

  assert.equal(copy.tabs.length, 1, "the settings tab is there");
  assert.equal(copy.bars.length, 1, "and the status bar");
  assert.equal(copy.bars[0].label, "obsync: not paired");
  const { COPIED_VAULT } = copy.box.require(join(copy.box.home, "build/ui/settings.js"));
  assert.equal(COPIED_VAULT, "This vault is a copy, or its folder was renamed. It will not sync as the original. Pair it as a new device, or start fresh.");
  assert.deepEqual(copy.obsidian.notices, [`obsync: ${COPIED_VAULT} Both are in obsync's settings, under This device.`]);
  assert.ok(copy.logs.includes("state decision=not_paired reason=copied_vault"));
  assert.equal(copy.instance.state.data.deviceId, null);
  assert.equal(copy.instance.transport.options.device(), null, "nothing can sign as the original device");
  assert.deepEqual(copy.requests, []);
  assert.deepEqual(copy.writes, []);
});

test("Settings offers a copy Pair this device and Start fresh, and Start fresh leaves an unpaired vault of its own (#168)", async (t) => {
  const original = await syncedPlugin(t);
  const copy = plugin(t, original.data());
  await copy.instance.onload();
  const tab = copy.tabs[0];
  let updates = 0;
  tab.update = () => { updates++; };
  const buttons = [];
  Object.assign(copy.obsidian.Setting.prototype, {
    addButton(callback) {
      const button = { setButtonText(value) { button.text = value; return button; }, setDisabled() { return button; }, onClick(handler) { button.click = handler; return button; } };
      buttons.push(button); callback(button); return this;
    },
  });
  const pairing = () => tab.getSettingDefinitions().flatMap((g) => g.items).find((item) => item.name === "Pairing");
  const { COPIED_VAULT } = copy.box.require(join(copy.box.home, "build/ui/settings.js"));
  assert.equal(pairing().desc, COPIED_VAULT);
  pairing().render(new copy.obsidian.Setting({}));
  assert.deepEqual(buttons.map((b) => b.text), ["Pair this device", "Start fresh"]);

  buttons[1].click();
  await tick(); await tick();
  const saved = copy.data();
  assert.notEqual(saved.installationId, original.data().installationId, "an installation of its own");
  assert.equal(saved.serverUrl, "", "the copied server address goes too");
  assert.equal(saved.deviceId, null);
  assert.equal(copy.instance.state.copied, false);
  assert.ok(copy.obsidian.notices.includes("obsync: this vault starts fresh. It is not paired with any server, and your notes are unchanged. Set it up or pair it here when you are ready."));
  assert.ok(copy.logs.includes("state decision=started_fresh reason=copied_vault"));
  assert.equal(updates, 1);
  assert.match(pairing().desc, /^Not paired yet\./);

  // The next start is an ordinary unpaired vault, not a copy again.
  const notices = copy.obsidian.notices.length;
  await copy.instance.onload();
  assert.equal(copy.instance.state.copied, false);
  assert.equal(copy.obsidian.notices.length, notices);
  assert.deepEqual(copy.writes.length, 1, "reopening writes nothing");
});

test("a storage fault keeps the protective stop: no tab, no status bar, and words that no longer forbid pairing again (#168)", async (t) => {
  const original = await syncedPlugin(t);
  // The same vault id and profile, with Obsidian's secret storage emptied.
  const faulted = plugin(t, original.data(), { localStorage: original.localStorage });
  await assert.rejects(faulted.instance.onload(), (error) => error.reason === "missing_secret");
  assert.deepEqual(faulted.tabs, []);
  assert.deepEqual(faulted.bars, []);
  assert.equal(faulted.obsidian.notices.length, 1);
  const [notice] = faulted.obsidian.notices;
  assert.match(notice, /^obsync could not read or save this vault's sync credentials in Obsidian's secret storage\. Sync is stopped/);
  assert.equal(/missing_secret|Do not/.test(notice), false, notice);
  assert.ok(faulted.logs.includes("state decision=stopped reason=missing_secret"));
  assert.deepEqual(faulted.writes, []);
});
