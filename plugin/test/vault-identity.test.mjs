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
  SECRET_B,
  SETUP_TOKEN,
  keys,
  memorySecrets,
  rig,
  sandbox,
} from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const c = require("../build/crypto.js");
const dm = require("../build/domainmap.js");

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
  assert.match(host.notices[0], /cannot read changes from "Study laptop": they are sealed with a different vault key/);
  assert.match(host.notices[0], /On "Study laptop", restore this vault's recovery phrase/);
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
  instance.addStatusBarItem = () => ({ setText() {} });
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

test("a phrase that opens nothing on this server is refused before it replaces the key (#140)", async (t) => {
  const { server } = await holdingVault();
  const p = await plugin(t, { server });

  await assert.rejects(() => p.instance.restoreVaultKey(OTHER_VRK), /These 24 words do not open the vault on this server/);
  assert.equal(p.instance.state.data.vrk, KEYS.vrk, "the key on this device was not changed");
  assert.equal(p.starts(), 0, "no engine started, so no second map was written");
  assert.deepEqual(p.posts(), [], "and nothing was sent but reads");
  assert.ok(p.logs.some((line) => /^vaultkey decision=refused reason=opens_nothing_here duration_ms=\d+$/.test(line)));

  // The phrase this server's vault was sealed with is restored as before.
  await p.instance.restoreVaultKey(KEYS.vrk);
  assert.equal(p.instance.state.data.vrk, KEYS.vrk);
  assert.equal(p.starts(), 1);
  assert.ok(p.logs.some((line) => /^vaultkey decision=restored duration_ms=\d+$/.test(line)));
});

test("any phrase is restored where there is no vault to strand (#140)", async (t) => {
  // A server whose account holds nothing yet: the key starts the vault.
  const empty = await plugin(t, { server: new FakeServer(), metadata: { vrk: null } });
  await empty.instance.restoreVaultKey(OTHER_VRK);
  assert.equal(empty.instance.state.data.vrk, OTHER_VRK);
  assert.equal(empty.starts(), 1);

  // A device with no credential has no server to ask, and asks nothing.
  const { server } = await holdingVault();
  const unpaired = await plugin(t, { server, metadata: { vrk: null, deviceId: null, deviceSecret: null } });
  await unpaired.instance.restoreVaultKey(OTHER_VRK);
  assert.equal(unpaired.instance.state.data.vrk, OTHER_VRK);
  assert.deepEqual(server.requests, []);
});

test("a server holding only a vault's map still has a vault to strand, and one holding none has not (#140)", async (t) => {
  const server = new FakeServer();
  const p = await plugin(t, { server });
  // Setup moves obsyncd's journal head with account and device frames before
  // any version exists: a fresh account is not a vault yet.
  server.seq = 2;
  assert.equal(await p.instance.vaultKeyStrands(OTHER_VRK), false);
  // The map a first start writes, through the feed like any version.
  await dm.saveDomainMap(p.instance.transport, (await keys()).map, dm.defaultDomainMap(KEYS.domainId));
  assert.equal(await p.instance.vaultKeyStrands(OTHER_VRK), true);
  assert.equal(await p.instance.vaultKeyStrands(KEYS.vrk), false);
});

// ---- the key: Create, in the dialog ------------------------------------------

class Component {
  constructor() { this.buttonEl = { focus: () => { this.focused = true; } }; }
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
  Object.assign(obsidian.Setting.prototype, { setName() { return this; }, addTextArea: add, addButton: add });
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
    vaultKeyStrands: async (vrk) => { calls.push(`strands:${vrk}`); return strands; },
    adoptVaultKey: async (vrk) => { calls.push(`adopt:${vrk}`); },
    restoreVaultKey: async (vrk) => { calls.push(`restore:${vrk}`); },
    log: (line) => logs.push(line),
  };
  const modal = new VaultKeyModal({}, plugin);
  modal.contentEl = drawing();
  modal.setTitle = () => {};
  modal.close = () => modal.onClose();
  modal.onOpen();
  const button = (text) => made.find((component) => component.text === text);
  return { modal, made, button, opened, asked, calls, logs, notices: obsidian.notices, box };
}

test("Create a new vault key on a server that holds a vault asks first, and Cancel keeps the key (#140)", async (t) => {
  const d = vaultKeyDialog(t, { strands: true, answer: "Cancel" });
  await d.button("Create a new vault key").click();
  await tick();

  assert.equal(d.asked.length, 1);
  const [question] = d.asked;
  assert.equal(question.title, "Create a new vault key?");
  assert.match(question.text, /a new key cannot open it/);
  assert.match(question.text, /Every device syncing that vault would stop receiving this device's changes/);
  const [cancel, create] = question.buttons;
  assert.equal(create.text, "Create a new key");
  assert.equal(create.destructive, true);
  assert.equal(create.focused, undefined);
  assert.equal(cancel.text, "Cancel");
  assert.equal(cancel.focused, true, "Cancel is the default");
  assert.equal(d.calls.length, 1, "the key was only checked");
  assert.match(d.calls[0], /^strands:[0-9a-f]{64}$/);
  assert.deepEqual(d.logs, ["vaultkey decision=declined reason=strands_vault"]);
  assert.equal(d.opened.includes("RecoveryPhraseModal"), false);
});

test("confirming Create adopts exactly the key that was checked (#140)", async (t) => {
  const d = vaultKeyDialog(t, { strands: true, answer: "Create a new key" });
  await d.button("Create a new vault key").click();
  await tick();
  const vrk = d.calls[0].slice("strands:".length);
  assert.deepEqual(d.calls, [`strands:${vrk}`, `adopt:${vrk}`]);
  assert.ok(d.opened.includes("RecoveryPhraseModal"), "the new phrase is shown to be written down");
});

test("Create on a server with no vault asks nothing, and Restore goes through the check (#140)", async (t) => {
  const d = vaultKeyDialog(t, { strands: false });
  await d.button("Create a new vault key").click();
  await tick();
  assert.deepEqual(d.asked, []);
  const vrk = d.calls[0].slice("strands:".length);
  assert.deepEqual(d.calls, [`strands:${vrk}`, `adopt:${vrk}`]);


  const r = vaultKeyDialog(t, { strands: false });
  const pairing = r.box.require(join(r.box.home, "build/pairing.js"));
  const words = await pairing.recoveryPhrase(Uint8Array.from(Buffer.from(KEYS.vrk, "hex")));
  r.made.find((component) => component.change !== undefined).change(words.join(" "));
  await r.button("Restore").click();
  assert.deepEqual(r.calls, [`restore:${KEYS.vrk}`], "a restored phrase is never adopted unchecked");
  assert.ok(r.notices.includes("Vault key restored."));
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
  assert.equal(await p.instance.notesUnknownTo(KEYS.vrk), 0);

  // Another vault: same name other bytes, a name the server lacks, a name it deleted.
  const other = new FakeHost();
  other.seed("Notes/a.md", "alphA\n");
  other.seed("Private/secret1.md", "private\n");
  other.seed("Notes/gone.md", "gone\n");
  p.instance.host = other;
  assert.equal(await p.instance.notesUnknownTo(KEYS.vrk), 3);

  assert.deepEqual(p.posts(), [], "the survey only reads");
  assert.ok(p.logs.some((line) => /^pairing role=claimant decision=surveyed local=2 unknown=0 held=2 duration_ms=\d+$/.test(line)));
  assert.ok(p.logs.some((line) => /^pairing role=claimant decision=surveyed local=3 unknown=3 held=2 duration_ms=\d+$/.test(line)));
});

test("First-time setup on a server that already holds a vault says one server holds one vault (#141)", async (t) => {
  const p = await plugin(t, { metadata: { deviceId: null, deviceSecret: null } });
  await p.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.ok(p.notices.some((notice) =>
    notice.includes("This server already holds a vault, and one server holds one vault") &&
    notice.includes("Pair this device") && notice.includes("a different vault needs a server of its own")));
  assert.equal(p.notices.some((notice) => notice.includes("already_set_up")), false, "not the raw server code");
  assert.ok(p.logs.includes("setup decision=failed reason=recovery_unavailable"));
  assert.equal(p.instance.state.data.deviceId, null);
});
