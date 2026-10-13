/**
 * One server, one vault, one key (issues #140 and #141).
 *
 * A device that met a record sealed under a key it does not hold retried that
 * record for ever under "offline"; "Create a new vault key", or another
 * vault's phrase, wrote a second domain map into a server that already held a
 * vault; and pairing a second vault uploaded all of it into the first. What is
 * pinned here is each guard at the level it lives: the feed through the real
 * engine, the key and the survey through the real compiled plugin over the
 * strict fake obsyncd, and the dialog through the real modal class.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  DEVICE_B,
  FakeHost,
  FakeServer,
  FakeTimers,
  KEYS,
  channel,
  SECRET_B,
  SETUP_TOKEN,
  keys,
  memorySecrets,
  rig,
  sandbox,
  statusItem,
} from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const c = require("../build/crypto.js");
const dm = require("../build/domainmap.js");
const { encodeRecoveryBackup } = require("../build/recoveryBackup.js");

const enc = (text) => new TextEncoder().encode(text);
const tick = () => new Promise(setImmediate);

/** Another vault's key: what "Create a new vault key" or a foreign phrase leaves on a device. */
const OTHER_VRK = "ab".repeat(32);
const OTHER_DOMAIN = "fedcba9876543210fedcba9876543210";

function transportFor(server, deviceId, secretHex) {
  return new Transport({
    request: server.request,
    serverUrl: () => "https://sync.example.invalid",
    device: () => ({ id: deviceId, secret: Uint8Array.from(Buffer.from(secretHex, "hex")) }),
    edgeHeaders: () => [],
    sleep: async () => undefined,
    maxAttempts: 2,
  });
}

// ---- the feed ---------------------------------------------------------------

test("records sealed under another vault key are skipped by name, and the feed keeps receiving (#140)", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  server.addDevice(DEVICE_B, SECRET_B, "Study laptop");
  // S15: B pressed "Create a new vault key". Its engine wrote a second map
  // into this account, then a note, both under a key this device never held.
  const other = Uint8Array.from(Buffer.from(OTHER_VRK, "hex"));
  await dm.saveDomainMap(transportFor(server, DEVICE_B, SECRET_B), await dm.domainMapKeys(other), dm.defaultDomainMap(OTHER_DOMAIN));
  const otherDomainKey = await c.deriveDomainKey(other, OTHER_DOMAIN);
  const bytes = enc("sealed elsewhere\n");
  const chunk = await c.encryptChunk(otherDomainKey, bytes);
  server.chunks.set(chunk.sid, chunk.ciphertext);
  const foreign = await server.publishManifest({
    fileId: "21".repeat(16),
    manifest: {
      v: 1, path: "Notes/from B.md", size: bytes.length, mtime: 1757200001000, domain: OTHER_DOMAIN,
      chunks: [{ sid: chunk.sid, cid: c.hex(chunk.cid), len: bytes.length }], sha256: c.hex(await c.sha256(bytes)), deleted: false,
    },
    sids: [chunk.sid], parents: [], deviceId: DEVICE_B,
    manifestKey: await c.deriveManifestKey(otherDomainKey, OTHER_DOMAIN), bytes: bytes.length,
  });
  const map = server.journal[0];
  // Then an ordinary change from a device holding this vault's key.
  const ordinary = await server.publish({
    fileId: "22".repeat(16), path: "Notes/after.md", bytes: enc("still arrives\n"), mtime: 1757200002000,
    domainKey: k.domainKey, manifestKey: k.manifestKey,
  });

  const statuses = [];
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state, host, timers, now: () => host.clock, onStatus: (status) => statuses.push(status.kind),
    transport: transportFor(server, KEYS.deviceId, KEYS.deviceSecret),
  });
  await engine.start();
  await timers.run(1000, () => host.text("Notes/after.md") === "still arrives\n" && state.data.lastSeq >= ordinary.seq, 3000);

  assert.equal(host.files.has("Notes/from B.md"), false, "nothing unreadable was written");
  for (const refused of [map, foreign]) {
    assert.ok(
      host.logs.includes(`pull path_class=manifest decision=refused reason=undecryptable file=${refused.file_id} seq=${refused.seq}`),
      `seq ${refused.seq} is skipped with a reason`,
    );
  }
  assert.equal(host.notices.length, 1, "one notice for the device, not one per record");
  assert.deepEqual(host.toasts.map((toast) => [toast.text, toast.ms]), [[host.notices[0], 0]], "it needs the person: shown under the quietest settings, until dismissed");
  assert.match(host.notices[0], /cannot read changes from Study laptop: they are locked with a different vault key/);
  assert.match(host.notices[0], /On Study laptop, restore this vault's recovery phrase/);
  assert.equal(statuses.includes("offline"), false, "a reachable server is never reported offline");
  assert.equal(host.logs.some((line) => line.startsWith("feed decision=retry")), false, "nothing was retried");
  engine.stop();
});

// ---- the key: Restore -------------------------------------------------------

/**
 * The REAL compiled plugin over the strict fake obsyncd: `onload` opens
 * `State` as the app does; the vault, the transport and the engine start are
 * replaced afterwards, so what is exercised is the plugin's own code.
 */
async function plugin(t, { server = new FakeServer(), host = new FakeHost(), metadata = {} } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const { Transport: BoxTransport } = box.require(join(box.home, "build/transport.js"));
  let stored = {
    vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
    serverUrl: "https://sync.example.invalid", ...metadata,
  };
  const instance = new Plugin();
  let starts = 0;
  const logs = [];
  instance.loadData = async () => structuredClone(stored);
  instance.saveData = async (value) => { stored = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => statusItem();
  instance.app = { workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (done) => done() }, secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) } };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.3" };
  instance.checkForUpdate = async () => {};
  instance.startEngine = async () => { starts++; };
  instance.log = (line) => logs.push(line);
  await instance.onload();
  instance.host = host;
  instance.transport = new BoxTransport({
    request: server.request,
    serverUrl: () => instance.state.data.serverUrl,
    device: () => {
      const { deviceId, deviceSecret } = instance.state.data;
      return deviceId && deviceSecret ? { id: deviceId, secret: Uint8Array.from(Buffer.from(deviceSecret, "hex")) } : null;
    },
    edgeHeaders: () => [],
    maxAttempts: 2,
  });
  starts = 0;
  logs.length = 0;
  obsidian.notices.length = 0;
  return {
    instance, server, logs, notices: obsidian.notices,
    starts: () => starts,
    posts: () => server.requests.filter((request) => request.method !== "GET"),
  };
}

/** A server that holds a vault: its map, and one note in it. */
async function holdingVault() {
  const server = new FakeServer();
  const k = await keys();
  await server.seedDomainMap(k.map, KEYS.domainId);
  await server.publish({
    fileId: "11".repeat(16), path: "Notes/a.md", bytes: enc("alpha\n"), mtime: 1757200000000,
    domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  return { server, k };
}

test("a staged backup cannot replace any paired key, even when it matches (#140)", async (t) => {
  const { server } = await holdingVault();
  const p = await plugin(t, { server });
  for (const root of [OTHER_VRK, KEYS.vrk]) {
    await assert.rejects(() => p.instance.stageRecoveryBackup(encodeText(root)), error => error.reason === "pin_replacement");
    assert.equal(p.instance.state.data.vrk, KEYS.vrk, "the held key was not changed");
  }
  assert.equal(p.starts(), 0); assert.deepEqual(server.requests, []);
});

const backupTexts = new Map();
async function encodeTextFor(root) { const text = await encodeRecoveryBackup(c.unhex(root)); backupTexts.set(root, text); return text; }
function encodeText(root) { return backupTexts.get(root); }
await encodeTextFor(OTHER_VRK); await encodeTextFor(KEYS.vrk);

test("a restored backup remains detached on an empty or occupied server (#140)", async (t) => {
  for (const server of [new FakeServer(), (await holdingVault()).server]) {
    const p = await plugin(t, { server, metadata: { vrk: null, deviceId: null, deviceSecret: null } });
    await p.instance.stageRecoveryBackup(encodeText(OTHER_VRK));
    assert.equal(p.instance.state.data.vrk, null);
    assert.equal(p.instance.state.stagedEnrollment2().root, OTHER_VRK);
    assert.equal(p.instance.state.stagedEnrollment2().purpose, "recover");
    assert.equal(p.starts(), 0); assert.deepEqual(server.requests, []);
  }
});

test("new-key creation cannot replace a held key regardless of server contents (#140)", async (t) => {
  for (const server of [new FakeServer(), (await holdingVault()).server]) {
    const p = await plugin(t, { server });
    await assert.rejects(() => p.instance.stageNewVaultKey(), error => error.reason === "pin_replacement");
    assert.equal(p.instance.state.data.vrk, KEYS.vrk);
    assert.equal(p.starts(), 0); assert.deepEqual(server.requests, []);
  }
});

// ---- the key: Create, in the dialog ------------------------------------------

class Component {
  constructor() { this.buttonEl = { focus: () => { this.focused = true; } }; this.inputEl = { setAttribute() {} }; }
  setButtonText(value) { this.text = value; return this; }
  setCta() { this.cta = true; return this; }
  setDestructive() { this.destructive = true; return this; }
  setPlaceholder() { return this; }
  onChange(handler) { this.change = handler; return this; }
  onClick(handler) { this.click = handler; return this; }
}

/** The real `VaultKeyModal`, drawn into a recording element; every question it asks is answered with `answer`. */
function vaultKeyDialog(t, { strands, answer = null }) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const made = [];
  const add = function (build) { const component = new Component(); made.push(component); build(component); return this; };
  Object.assign(obsidian.Setting.prototype, { setName() { return this; }, setDesc() { return this; }, addTextArea: add, addButton: add });
  const drawing = () => {
    const drawn = [];
    return { drawn, createEl: (tag, { text = "" } = {}) => { drawn.push(text); return {}; }, empty: () => {} };
  };
  const opened = [], asked = [];
  obsidian.Modal.prototype.open = function () {
    opened.push(this.constructor.name);
    if (this.constructor.name !== "ConfirmModal") return;
    const first = made.length;
    this.contentEl = drawing();
    this.setTitle = (title) => { this.title = title; };
    this.close = () => this.onClose();
    this.onOpen();
    const buttons = made.slice(first);
    // What Obsidian does once `onOpen` returns: the focus goes to the first button.
    buttons[0].buttonEl.focus();
    asked.push({ title: this.title, text: this.contentEl.drawn.join("\n"), buttons });
    if (answer === null) assert.fail(`no question was expected, and "${this.title}" was asked`);
    buttons.find((button) => button.text === answer).click();
  };
  const { VaultKeyModal } = box.require(join(box.home, "build/ui/modals.js"));
  const calls = [], logs = [];
  const plugin = {
    captureSession: () => ({ assertCurrent() {} }),
    stageNewVaultKey: async () => { calls.push("stage:new"); if (strands) throw new Error("A held key cannot be replaced by this action."); },
    stageRecoveryBackup: async (text) => { calls.push(`stage:backup:${text}`); },
    log: (line) => logs.push(line),
  };
  plugin.notices = channel(box, plugin);
  const modal = new VaultKeyModal({}, plugin);
  modal.contentEl = drawing();
  modal.setTitle = () => {};
  modal.close = () => modal.onClose();
  modal.onOpen();
  const button = (text) => made.find((component) => component.text === text);
  return { modal, made, button, opened, asked, calls, logs, notices: obsidian.notices, box };
}

test("Create with a held key refuses without an override or showing a new backup (#140)", async (t) => {
  const d = vaultKeyDialog(t, { strands: true });
  await d.button("Create a new vault key").click();
  assert.deepEqual(d.calls, ["stage:new"]); assert.equal(d.asked.length, 0);
  assert.equal(d.opened.includes("RecoveryPhraseModal"), false);
  assert.ok(d.notices.some(text => text.includes("cannot be replaced")));
});

test("a successfully staged new key shows its backup only after staging succeeds (#140)", async (t) => {
  const d = vaultKeyDialog(t, { strands: false });
  await d.button("Create a new vault key").click();
  assert.deepEqual(d.calls, ["stage:new"]); assert.equal(d.asked.length, 0);
  assert.ok(d.opened.includes("RecoveryPhraseModal"));
});

test("Restore passes complete backup text to explicit staging and claims no live adoption (#140)", async (t) => {
  const d = vaultKeyDialog(t, { strands: false });
  d.made.find(component => component.change !== undefined).change(encodeText(KEYS.vrk));
  await d.button("Stage current backup").click();
  assert.deepEqual(d.calls, [`stage:backup:${encodeText(KEYS.vrk)}`]);
  assert.ok(d.notices.some(text => text.includes("Recovery backup staged")));
  assert.equal(d.notices.some(text => text.includes("vault key restored")), false);
});

// ---- pairing a second vault -----------------------------------------------------

test("a claimant counts the notes the server's vault does not hold, byte for byte, and posts nothing (#141)", async (t) => {
  const { server, k } = await holdingVault();
  // A file above the chunk ceiling carries no whole-file digest, so it is
  // matched by path and size (the #131 copy of a vault with a large PDF).
  const large = new Uint8Array(9 << 20).fill(7);
  await server.publishManifest({
    fileId: "12".repeat(16),
    manifest: {
      v: 1, path: "Attachments/scan.pdf", size: large.length, mtime: 1757200000000, domain: KEYS.domainId,
      chunks: [{ sid: "a1".repeat(32), cid: "b1".repeat(32), len: 8 << 20 }, { sid: "a2".repeat(32), cid: "b2".repeat(32), len: 1 << 20 }],
      sha256: "", deleted: false,
    },
    sids: ["a1".repeat(32), "a2".repeat(32)], parents: [], deviceId: "ff".repeat(16), manifestKey: k.manifestKey, bytes: large.length,
  });
  const gone = await server.publish({
    fileId: "13".repeat(16), path: "Notes/gone.md", bytes: enc("gone\n"), mtime: 1757200000000,
    domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  await server.publishTombstone({ fileId: "13".repeat(16), path: "Notes/gone.md", manifestKey: k.manifestKey, parents: [gone.version_id] });

  // A copy of the same vault: nothing new, so no question.
  const copy = new FakeHost();
  copy.seed("Notes/a.md", "alpha\n");
  copy.seed("Attachments/scan.pdf", large);
  const p = await plugin(t, { server, host: copy, metadata: { vrk: null } });
  // One host pass for the whole survey (#198): a phone asks each folder once, not once per note.
  let open = 0;
  let opened = 0;
  const inside = [];
  copy.pass = (on) => { if (on) { open++; opened++; } else open--; };
  const syncable = copy.syncable.bind(copy);
  copy.syncable = async (path) => { inside.push(open > 0); return syncable(path); };
  assert.equal(await p.instance.notesUnknownTo2(KEYS.vrk, (await keys()).generation, p.instance.transport), 0);
  assert.ok(inside.length === 2 && inside.every(Boolean), `every question inside the pass: ${JSON.stringify(inside)}`);
  assert.deepEqual([opened, open], [1, 0], "one pass, closed");

  // Another vault: same name other bytes, a name the server lacks, a name it deleted.
  const other = new FakeHost();
  other.seed("Notes/a.md", "alphA\n");
  other.seed("Private/secret1.md", "private\n");
  other.seed("Notes/gone.md", "gone\n");
  p.instance.host = other;
  assert.equal(await p.instance.notesUnknownTo2(KEYS.vrk, (await keys()).generation, p.instance.transport), 3);

  assert.deepEqual(p.posts(), [], "the survey only reads");
  assert.ok(p.logs.some((line) => /^pairing role=claimant decision=surveyed local=2 unknown=0 older=0 held=2 duration_ms=\d+$/.test(line)));
  assert.ok(p.logs.some((line) => /^pairing role=claimant decision=surveyed local=3 unknown=3 older=0 held=2 duration_ms=\d+$/.test(line)));
});

// A device paired again after the others edited while it was away holds each
// such note as it last saw it: an earlier version, which pairing takes as that
// version and uploads nothing (#194). Counted as unknown, it asked about notes
// the server holds (the Android journey J10, 2026-09-27).
test("a note held at an earlier version of the server's is the vault's, and only at its own path (#141)", async (t) => {
  const { server, k } = await holdingVault();
  const fileId = "14".repeat(16);
  const first = await server.publish({
    fileId, path: "Notes/edited.md", bytes: enc("as this device last saw it\n"), mtime: 1757200000000,
    domainKey: k.domainKey, manifestKey: k.manifestKey,
  });
  await server.publish({
    fileId, path: "Notes/edited.md", bytes: enc("edited while it was away\n"), mtime: 1757200001000,
    domainKey: k.domainKey, manifestKey: k.manifestKey, parents: [first.version_id],
  });

  const away = new FakeHost();
  away.seed("Notes/a.md", "alpha\n");
  away.seed("Notes/edited.md", "as this device last saw it\n");
  const p = await plugin(t, { server, host: away, metadata: { vrk: null } });
  assert.equal(await p.instance.notesUnknownTo2(KEYS.vrk, (await keys()).generation, p.instance.transport), 0, "an earlier version of a held note is the vault's");

  // The same bytes under another name are a note the server's vault lacks.
  const elsewhere = new FakeHost();
  elsewhere.seed("Notes/a.md", "alpha\n");
  elsewhere.seed("Private/edited.md", "as this device last saw it\n");
  p.instance.host = elsewhere;
  assert.equal(await p.instance.notesUnknownTo2(KEYS.vrk, (await keys()).generation, p.instance.transport), 1, "the note's own history, at its own path");

  // As long as an earlier version, but other bytes: not one of them.
  const other = new FakeHost();
  other.seed("Notes/a.md", "alpha\n");
  other.seed("Notes/edited.md", "as this device last saw IT\n");
  p.instance.host = other;
  assert.equal(await p.instance.notesUnknownTo2(KEYS.vrk, (await keys()).generation, p.instance.transport), 1, "an earlier version's size alone is not its bytes");

  assert.deepEqual(p.posts(), [], "the survey only reads");
  assert.ok(p.logs.some((line) => /^pairing role=claimant decision=surveyed local=2 unknown=0 older=1 held=2 duration_ms=\d+$/.test(line)));
  assert.equal(p.logs.filter((line) => / unknown=1 older=0 /.test(line)).length, 2);
});

test("a new vault key cannot take over a server that already holds a vault (#141)", async (t) => {
  // A key made for this setup, not restored from a phrase: it sends no proof,
  // so the occupied server says to pair or restore, never a second vault key.
  const p = await plugin(t, { metadata: { vrk: null, deviceId: null, deviceSecret: null } });
  await p.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.ok(p.notices.some((notice) =>
    notice.includes("This server already holds a vault") &&
    notice.includes("Pair from a syncing device") && notice.includes("new vault needs a separate server")));
  assert.equal(p.notices.some((notice) => notice.includes("already_set_up")), false, "not the raw server code");
  assert.ok(p.logs.includes("setup decision=failed reason=recover_only_required"));
  assert.equal(p.instance.state.data.deviceId, null);
});

test("Setup refuses an older server before sending a setup token (#141)", async (t) => {
  const server = new FakeServer(), request = server.request;
  let setupRequests = 0;
  server.request = async input => {
    if (new URL(input.url).pathname === "/v1/setup") {
      if (input.method === "POST") setupRequests++;
      return server.json(200, { recover_only: true });
    }
    return request(input);
  };
  const p = await plugin(t, { server, metadata: { vrk: null, deviceId: null, deviceSecret: null } });
  await p.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(setupRequests, 0, "capability downgrade refuses before a credential-bearing request");
  assert.ok(p.notices.some(text => text.includes("Update it before setup or recovery")));
  assert.equal(p.instance.state.data.deviceId, null);
  assert.equal(p.instance.state.data.deviceSecret, null);
  assert.equal(p.instance.state.data.vrk, null);
  assert.equal(p.starts(), 0);
});
