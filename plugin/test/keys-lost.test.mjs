/**
 * A device killed between obsync's two writes (issue #230). A save that
 * changes a credential writes the secret entry first and the data file
 * second, and on a desktop the secret entry lands in Chromium's local storage,
 * which reaches disk lazily, while the data file is a file write. A process
 * killed in between comes back with a data file naming the revision one past
 * the entry's newest. That used to stop loading for good, `identity_mismatch`,
 * with nothing to press (CI run 36311421025, the Linux leg with no keyring).
 *
 * Pinned here: that one signature -- this installation's entry, the data file
 * exactly one revision ahead of it -- loads as a device that holds no
 * credential and says why, never with a credential taken from an older
 * revision; every other disagreement keeps the stop; the next save is as safe
 * across a crash as any other; and the device pairs again from there.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { KEYS, memorySecrets, sandbox, statusItem } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { State, StateStorageError, KEYS_LOST } = require("../build/state.js");
const clone = (value) => structuredClone(value);
const tick = () => new Promise(setImmediate);
const SERVER = "https://sync.example.invalid";
const reason = (code) => (error) => error instanceof StateStorageError && error.reason === code;
/** A load that must go on: its stop is the defect itself, so it fails as an assertion. */
const loads = (opening) => opening.catch((error) => assert.fail(`loading stopped: ${error.reason ?? error.message}`));

/**
 * Obsidian's secret storage as a desktop keeps it: a write reads back at once
 * but reaches disk later, so a process killed before then loses it. `flush`
 * is the disk catching up; `crash` is the process ending before it did.
 */
function lazySecrets() {
  const disk = new Map(), memory = new Map(), sets = [];
  return {
    disk, sets,
    getSecret: (id) => memory.has(id) ? memory.get(id) : disk.get(id) ?? null,
    setSecret: (id, value) => { sets.push(id); memory.set(id, value); },
    flush: () => { for (const [id, value] of memory) disk.set(id, value); memory.clear(); },
    crash: () => { memory.clear(); },
  };
}

const PAIRED = () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, deviceName: "Study laptop",
  serverUrl: SERVER, edgeHeaders: [{ name: "X-Service", value: "EDGE SENTINEL" }], lastSeq: 7,
  files: { "Notes/a.md": { fileId: "12".repeat(16), versionId: "34".repeat(32), size: 4, mtime: 1, sha256: "" } },
  folders: { Notes: { fileId: "56".repeat(16), versionId: "78".repeat(32) } },
  syncFolders: ["Notes"], policy: { perFileMaxBytes: 11, totalBudgetBytes: 22 }, recoveryPhrase: "confirmed" });

/** One vault's two stores and Obsidian's record of the reference it holds; the data file is a file write. */
function device(metadata = null) {
  let data = clone(metadata);
  const secrets = lazySecrets(), writes = [], failures = [];
  let held = null, refuse = null;
  const store = {
    loadData: async () => clone(data),
    saveData: async (value) => {
      if (refuse !== null) { const error = refuse; refuse = null; throw error; }
      writes.push(clone(value)); data = clone(value);
    },
  };
  const probe = { holds: (ref) => held === ref, hold: (ref) => { held = ref; } };
  return { secrets, writes, failures, data: () => clone(data), setData: (value) => { data = clone(value); },
    failNextWrite: () => { refuse = new Error("the data file write failed"); },
    open: () => State.open(store, false, secrets, (error) => failures.push(error.reason), () => true, undefined, probe) };
}

/** A paired device whose credential change reached the data file and not the disk under the secret entry. */
async function crashedChange() {
  const d = device(PAIRED());
  const state = await d.open();
  await d.open();
  d.secrets.flush();
  state.data.edgeHeaders = [{ name: "X-Service", value: "NEW EDGE SENTINEL" }];
  await state.save();
  d.secrets.crash();
  return d;
}

test("a crash that loses a pairing's secret write loads with no credential, keeping everything but the pairing (#230)", async () => {
  const d = device();
  const state = await d.open();
  state.data.serverUrl = SERVER;
  state.data.syncFolders = ["Notes"];
  state.data.deviceName = "Study laptop";
  state.data.policy = { perFileMaxBytes: 11, totalBudgetBytes: 22 };
  await state.save();
  d.secrets.flush();
  // Pairing keeps the key and the credential in one save, and the first sync
  // records what it syncs.
  Object.assign(state.data, { vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, lastSeq: 3 });
  state.setFile("Notes/a.md", { fileId: "12".repeat(16), versionId: "34".repeat(32), size: 4, mtime: 1, sha256: "" });
  await state.save();
  d.secrets.crash();
  const named = d.data(), entry = d.secrets.disk.get(named.credentialRef), writes = d.writes.length;
  assert.equal(named.credentialRevision, 3);
  assert.equal(JSON.parse(entry).current.revision, 2, "the fixture really did lose the write");

  const recovered = await loads(d.open());
  assert.deepEqual(recovered.keysLost, { dataRevision: 3, secretRevision: 2 });
  assert.equal(recovered.paired, false);
  assert.equal(recovered.copied, false, "it is not a copy, and is not told it is one");
  assert.deepEqual({ ...recovered.data }, {
    vrk: null, deviceId: null, deviceSecret: null, deviceName: "Study laptop", deviceTag: null,
    serverUrl: SERVER, edgeHeaders: [], lastSeq: 0, files: {}, folders: {}, remoteOnly: {},
    retiredRoots: {}, folderBarriers: [], folderRemovals: {}, parked: {}, dropped: {}, paused: {}, departed: {}, replaying: null,
    heldDeletions: [], feedMark: null, graves: {},
    syncFolders: ["Notes"], policy: { perFileMaxBytes: 11, totalBudgetBytes: 22 }, recoveryPhrase: "unconfirmed",
    notices: { level: "everything", merges: "once" },
  });
  assert.deepEqual(d.failures, [], "a recovery is not a stop");
  assert.equal(d.writes.length, writes, "nothing is written until the person acts");
  assert.deepEqual(d.data(), named);
  assert.equal(d.secrets.disk.get(named.credentialRef), entry, "and nothing is deleted");
});

test("a credential change lost to a crash never falls back to the credential an older revision holds (#230)", async () => {
  const d = await crashedChange();
  const named = d.data(), entry = JSON.parse(d.secrets.disk.get(named.credentialRef));
  assert.equal(entry.current.deviceSecret, KEYS.deviceSecret, "revision 1 holds a live credential");

  const recovered = await loads(d.open());
  assert.deepEqual(recovered.keysLost, { dataRevision: 2, secretRevision: 1 });
  assert.equal(recovered.paired, false);
  for (const field of ["vrk", "deviceId", "deviceSecret"]) assert.equal(recovered.data[field], null, field);
  assert.deepEqual(recovered.data.edgeHeaders, []);
  const held = JSON.stringify(recovered.data);
  for (const secret of [KEYS.vrk, KEYS.deviceSecret, "EDGE SENTINEL"]) assert.equal(held.includes(secret), false, secret);
  assert.equal(recovered.data.serverUrl, SERVER, "the server it pairs again with stays");
  assert.deepEqual(d.failures, []);
});

test("every other disagreement with the secret entry still stops loading, and changes nothing (#230)", async () => {
  const ahead = await crashedChange();
  const base = ahead.data(), ref = base.credentialRef;
  const entry = ahead.secrets.disk.get(ref), envelope = JSON.parse(entry);
  const other = "99".repeat(16);
  for (const [name, metadata, stored, code] of [
    ["two revisions ahead", { ...base, credentialRevision: 3 }, entry, "identity_mismatch"],
    ["the server disagrees at the revision held", { ...base, credentialRevision: 1, serverUrl: "https://other.example.invalid" }, entry, "identity_mismatch"],
    ["the device disagrees at the revision held", { ...base, credentialRevision: 1, deviceId: other }, entry, "identity_mismatch"],
    ["the device disagrees at the previous revision",
      { ...base, credentialRevision: 1, deviceId: other },
      JSON.stringify({ ...envelope, current: { ...envelope.current, revision: 2 }, previous: envelope.current }), "identity_mismatch"],
    ["behind the previous revision",
      { ...base, credentialRevision: 1 },
      JSON.stringify({ ...envelope, current: { ...envelope.current, revision: 3 }, previous: { ...envelope.current, revision: 2 } }), "identity_mismatch"],
    ["one ahead of another installation's entry", base, JSON.stringify({ ...envelope, installationId: other }), "invalid_envelope"],
  ]) {
    const d = device(metadata);
    d.secrets.disk.set(ref, stored);
    await assert.rejects(d.open(), reason(code), name);
    assert.deepEqual(d.failures, [code], name);
    assert.deepEqual(d.writes, [], name);
    assert.deepEqual(d.data(), metadata, name);
    assert.equal(d.secrets.disk.get(ref), stored, name);
  }
});

test("the first save after a recovery takes an installation of its own, and a crash in it recovers again (#230)", async () => {
  const d = await crashedChange();
  const lost = d.data(), before = d.secrets.disk.get(lost.credentialRef);

  // A save whose secret write landed and whose data file did not: the data
  // file still names the lost revision, and the device recovers again.
  const first = await loads(d.open());
  d.failNextWrite();
  await assert.rejects(first.save(), reason("metadata_write_failed"));
  d.secrets.flush();
  d.failures.length = 0;
  const again = await loads(d.open());
  assert.deepEqual(again.keysLost, { dataRevision: 2, secretRevision: 1 });
  assert.deepEqual(d.failures, []);

  await again.save();
  assert.equal(again.keysLost, null, "the first save ends it");
  const saved = d.data();
  assert.notEqual(saved.installationId, lost.installationId, "an installation of its own");
  assert.equal(saved.credentialRevision, 1);
  assert.equal(saved.deviceId, null);
  d.secrets.flush();
  assert.equal(JSON.parse(d.secrets.disk.get(saved.credentialRef)).current.deviceSecret, null);
  assert.equal(d.secrets.disk.get(lost.credentialRef), before, "the old entry is left exactly as it was");
  const reopened = await loads(d.open());
  assert.equal(reopened.keysLost, null);
  assert.equal(reopened.copied, false);
  assert.deepEqual(d.failures, []);
});

// ---- the compiled plugin ------------------------------------------------------

function plugin(t, metadata, secrets, localStorage) {
  secrets.adapter ??= memorySecrets().adapter;
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const requests = [];
  box.require(join(box.home, "build/fetchHttp.js")).fetchHttp = async (request) => { requests.push(request); return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }; };
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
    secretStorage: secrets,
    loadLocalStorage: (key) => localStorage.get(key) ?? null,
    saveLocalStorage: (key, value) => { localStorage.set(key, value); },
    vault: { adapter: {}, on: () => ({}), getName: () => "Crash test vault", getMarkdownFiles: () => [] },
    workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed() },
  };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.4" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  return { box, obsidian, instance, requests, writes, tabs, bars, logs, data: () => clone(data) };
}

/** A paired device, set up by the compiled plugin, killed right after a credential change. */
async function crashedPlugin(t) {
  const secrets = lazySecrets(), localStorage = new Map();
  const before = plugin(t, PAIRED(), secrets, localStorage);
  await before.instance.onload();
  assert.equal(before.instance.state.paired, true);
  secrets.flush();
  before.instance.state.data.edgeHeaders = [];
  await before.instance.state.save();
  secrets.crash();
  const after = plugin(t, before.data(), secrets, localStorage);
  const setCount = secrets.sets.length, oldBytes = new Map(secrets.disk);
  await assert.rejects(after.instance.onload(), error => error.reason === "pin_mismatch");
  assert.equal(secrets.sets.length, setCount, "the torn desktop state wrote no secret");
  assert.deepEqual(secrets.disk, oldBytes);
  await tick();
  return { ...after, secrets, localStorage, lost: before.data(), oldBytes };
}

test("the compiled desktop refuses a lost wrapped revision, says why once and signs nothing (#230)", async t => {
  const p = await crashedPlugin(t);
  assert.equal(p.data().storageVersion, 3);
  assert.equal(p.obsidian.notices.length, 1);
  assert.match(p.obsidian.notices[0], /encrypted credential storage.*Sync is stopped; local notes are unchanged/);
  assert.ok(!p.obsidian.notices[0].includes("nothing was sent or changed"));
  assert.deepEqual(p.logs.filter(line => line.startsWith("state ")), ["state decision=stopped reason=pin_mismatch"]);
  assert.ok(!p.logs.some(line => line.includes(KEYS.deviceId) || line.includes(p.lost.installationId)));
  assert.deepEqual(p.tabs, []); assert.deepEqual(p.bars, []);
  assert.equal(p.instance.state, undefined, "no root or older credential was adopted");
  assert.equal(p.instance.transport, undefined); assert.deepEqual(p.requests, []); assert.deepEqual(p.writes, []);
});

test("reopening a torn wrapped revision remains stopped with prior bytes intact, never a keysLost fallback", async t => {
  const p = await crashedPlugin(t), again = plugin(t, p.data(), p.secrets, p.localStorage), sets = p.secrets.sets.length;
  await assert.rejects(again.instance.onload(), error => error.reason === "pin_mismatch");
  assert.deepEqual(again.tabs, []); assert.deepEqual(again.bars, []); assert.deepEqual(again.requests, []); assert.deepEqual(again.writes, []);
  assert.equal(again.instance.state, undefined); assert.deepEqual(again.data(), p.lost);
  assert.equal(p.secrets.sets.length, sets); assert.deepEqual(p.secrets.disk, p.oldBytes);
  assert.equal(again.obsidian.notices.length, 1); assert.match(again.obsidian.notices[0], /verified recovery or pairing flow in a fresh vault/);
});

test("a fresh vault explicitly pairs after a wrapped-revision failure while preserving the stopped vault bytes (#230)", async (t) => {
  const stopped = await crashedPlugin(t), secrets = lazySecrets(), localStorage = new Map();
  const fresh = plugin(t, null, secrets, localStorage); await fresh.instance.onload();
  const p = { ...fresh, secrets, localStorage };
  assert.equal(p.data().storageVersion, 3); assert.equal(p.instance.state.paired, false);
  const { instance, box } = p;
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const { PairClaimModal } = box.require(join(box.home, "build/ui/modals.js"));
  const pairingId = "12".repeat(16), token = "34".repeat(32), secret = new Uint8Array(16).fill(56);
  const claimed = { device_id: "cd".repeat(16), device_secret: "ef".repeat(32) };
  const crypto = box.require(join(box.home, "build/crypto.js"));
  const generation = (await crypto.domainMapIds(await crypto.deriveDomainMapKey(crypto.unhex(KEYS.vrk)))).fileId;
  // The other device's side of a pairing: its key, committed to in the code,
  // and the vault key sealed for the key this claim sends.
  const creator = await pairing.newPairingKeyExchange();
  let claimantKey = null;
  const calls = [];
  Object.assign(instance.transport, {
    pairingClaim2: async (id, enrollToken, info) => {
      calls.push("claim"); assert.equal(id, pairingId); assert.equal(enrollToken, token);
      claimantKey = info.claimant_pub;
      return { outcome: "ok", value: claimed };
    },
    pairingEnvelope: async () => {
      calls.push("envelope");
      const sealed = await pairing.sealEnvelope2(creator, claimantKey, secret, pairingId, { v: 2, vrk: KEYS.vrk, generation: generation });
      return { outcome: "ok", value: { ...sealed, creator_pub: creator.publicKey } };
    },
    revokeDevice: async (id) => { calls.push(`revoke:${id}`); return { outcome: "ok", value: undefined }; },
  });
  Object.assign(instance, {
    nestedRefusal: async () => null,
    notesUnknownTo2: async () => 0,
    restartEngine: async () => { calls.push("restart"); },
  });
  const previous = globalThis.window;
  globalThis.window = { ...previous, setTimeout: (resolve) => resolve() };
  t.after(() => { globalThis.window = previous; });
  const code = pairing.encodePairingCode(pairingId, token, secret, await pairing.pairingCommitment(pairingId, creator.publicKey));
  const modal = new PairClaimModal(instance.app, instance, code);
  Object.assign(modal, { contentEl: { createEl: () => ({ setText: () => {} }), empty: () => {} }, close: () => modal.onClose() });
  await modal.claim();
  await instance.waiting?.done;
  globalThis.window = previous;
  assert.deepEqual(calls, ["claim", "envelope", "restart"], "paired, and nothing revoked: the lost credential is the person's to revoke");
  assert.equal(instance.state.paired, true);
  assert.equal(instance.state.keysLost, null);

  // The next start is an ordinary paired device, and the entry before the crash is untouched.
  p.secrets.flush();
  const restarted = plugin(t, p.data(), p.secrets, p.localStorage);
  await restarted.instance.onload();
  const state = restarted.instance.state;
  assert.equal(state.paired, true);
  assert.equal(state.keysLost, null);
  assert.deepEqual([state.data.deviceId, state.data.deviceSecret, state.data.vrk], [claimed.device_id, claimed.device_secret, KEYS.vrk]);
  assert.notEqual(p.data().installationId, stopped.lost.installationId);
  assert.deepEqual(stopped.secrets.disk, stopped.oldBytes, "the stopped vault's older wrapped authority was neither adopted nor erased");
  assert.deepEqual(restarted.obsidian.notices, []);
});
