/** Recovery journeys through the real plugin, state, transport and engine. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { hkdfSync, createHash } from "node:crypto";
import { FakeHost, FakeServer, FakeTimers, KEYS, SETUP_TOKEN, memorySecrets, sandbox, rig, keys } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { accountRecovery, forgottenCredential, FORGOTTEN_DEVICE } = require("../build/accountRecovery.js");
const { ApiError, Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const tick = () => new Promise(setImmediate);
const unpaired = { deviceId: null, deviceSecret: null };
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
  instance.app = { workspace: { onLayoutReady: (done) => done() }, secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}), getName: () => "Recovery QA", getMarkdownFiles: () => [...host.files.keys()].filter((path) => path.endsWith(".md")) } };
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
    instance, server, host, box, logs, metadata: () => structuredClone(stored), notices: obsidian.notices,
    starts: () => starts,
    posts: () => server.requests.filter((request) => request.method !== "GET"),
  };
}


test("recovery proof is domain separated from the vault key and the server retains only its hash", async () => {
  const derived = await accountRecovery(KEYS.vrk);
  const expected = Buffer.from(hkdfSync("sha256", Buffer.from(KEYS.vrk, "hex"), "obsync/v1/account-recovery", "", 32)).toString("hex");
  assert.equal(derived.proof, expected);
  assert.notEqual(derived.proof, KEYS.vrk);
  assert.equal(derived.verifier, createHash("sha256").update(Buffer.from(expected, "hex")).digest("hex"));
  assert.notEqual((await accountRecovery("ab".repeat(32))).proof, derived.proof);
});

test("an updated paired device registers recovery before its last credential leaves", async (t) => {
  const r = await plugin(t);
  const k = await keys();
  await r.server.seedDomainMap(k.map, KEYS.domainId);
  // Use the actual successful engine start, including automatic registration.
  delete r.instance.startEngine;
  t.after(async () => { await r.instance.engine?.stopAndWait(); });
  await r.instance.startEngine();
  const derived = await accountRecovery(KEYS.vrk);
  assert.equal(r.server.recoveryVerifier, derived.verifier);
  const registration = r.server.requests.find((request) => request.target.endsWith("/v1/account/recovery"));
  assert.ok(registration);
  const wire = registration.json;
  assert.equal(wire.includes(derived.proof), false);
  assert.equal(wire.includes(KEYS.vrk), false);
  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  assert.equal(r.server.devices[0].revoked, true);
  assert.equal(r.instance.state.data.deviceId, null);
  await r.instance.setServerUrl("https://sync.example.invalid");
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.notEqual(r.instance.state.data.deviceId, KEYS.deviceId);
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  assert.ok(r.notices.some((text) => text.includes("Account recovered")));
});

test("forgotten credentials show recovery and reset metadata without touching notes, key or address", async (t) => {
  const r = await plugin(t, { metadata: { lastSeq: 42, edgeHeaders: [{ name: "X-Edge", value: "TEST" }] } });
  r.host.seed("kept.md", "local unsent content", 1);
  r.instance.state.data.files["kept.md"] = { fileId: "12".repeat(16), versionId: "34".repeat(32), mtime: 1, size: 20, sha256: "" };
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  r.instance.setStatus({ kind: "idle" });
  assert.match(r.instance.statusText(), /no longer recognises/);
  const { ObsyncSettingTab } = r.box.require(join(r.box.home, "build/ui/settings.js"));
  const tab = new ObsyncSettingTab(r.instance.app, r.instance);
  const row = tab.getSettingDefinitions().flatMap((g) => g.items).find((item) => item.name === "Setup or recover");
  assert.ok(row.visible(), "the rejected non-null ID must not hide recovery");
  await r.instance.resetForgottenEnrollment();
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  assert.equal(r.instance.state.data.serverUrl, "https://sync.example.invalid");
  assert.deepEqual(r.instance.state.data.edgeHeaders, [{ name: "X-Edge", value: "TEST" }]);
  assert.equal(r.instance.state.data.deviceId, null);
  assert.equal(r.metadata().lastSeq, 0);
  assert.deepEqual(r.metadata().files, {});
  assert.equal(r.host.text("kept.md"), "local unsent content");
  assert.deepEqual(r.host.trashed, []);
  assert.equal(r.server.requests.length, 0, "reset does not retry rejected authentication");
});

test("setup recovers a forgotten enrollment with its retained key, without uninstalling", async (t) => {
  const r = await plugin(t);
  await r.instance.registerAccountRecovery();
  r.server.devices[0].revoked = true;
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.notEqual(r.instance.state.data.deviceId, KEYS.deviceId);
  assert.equal(r.instance.forgottenDevice, false);
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  assert.ok(r.notices.some((text) => text.includes("Account recovered")));
});

test("wrong token, wrong vault key and an unregistered legacy account never enrol a recovery device", async (t) => {
  for (const reason of ["token", "key", "legacy"]) {
    const server = new FakeServer();
    if (reason !== "legacy") server.recoveryVerifier = (await accountRecovery(KEYS.vrk)).verifier;
    const r = await plugin(t, { server, metadata: { ...unpaired, vrk: reason === "key" ? "ab".repeat(32) : KEYS.vrk } });
    await r.instance.setUpAccount(reason === "token" ? "wrong-token" : SETUP_TOKEN, "obsync");
    assert.equal(server.devices.length, 1, reason);
    assert.equal(r.instance.state.data.deviceId, null, reason);
    assert.equal(server.requests.length, 1, "no automatic retry");
  }
});

test("a lost first setup response retains its pre-request key for an explicit recovery attempt", async (t) => {
  const server = new FakeServer({ claimed: false });
  const r = await plugin(t, { server, metadata: { ...unpaired, vrk: null } });
  const original = r.instance.transport.setup.bind(r.instance.transport);
  r.instance.transport.setup = async (...args) => {
    assert.ok(r.instance.state.data.vrk, "the key is durable before the server is asked");
    await original(...args);
    return { outcome: "lost", status: 0, reason: "connection closed" };
  };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  const retained = r.instance.state.data.vrk;
  assert.equal(r.instance.state.data.deviceId, null);
  assert.equal(server.devices.length, 1);
  assert.equal(server.recoveryVerifier, (await accountRecovery(retained)).verifier);
  r.instance.transport.setup = original;
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.instance.state.data.vrk, retained);
  assert.ok(r.instance.state.data.deviceId);
  assert.equal(server.devices.length, 2, "one new device only after an explicit second action");
});

test("a failed key save creates no server account", async (t) => {
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: { ...unpaired, vrk: null } });
  r.instance.state.save = async () => { throw new Error("disk full"); };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.server.requests.length, 0);
  assert.equal(r.server.claimed, false);
});

test("double clicking setup does not mint two devices", async (t) => {
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: unpaired });
  await Promise.all([r.instance.setUpAccount(SETUP_TOKEN, "obsync"), r.instance.setUpAccount(SETUP_TOKEN, "obsync")]);
  assert.equal(r.server.devices.length, 1);
  assert.equal(r.server.requests.filter((request) => request.target.endsWith("/v1/setup")).length, 1);
});

test("the feed stops on a forgotten credential and never reports a reachable server as offline", async () => {
  const r = await rig();
  const timers = new FakeTimers(), statuses = [];
  let refusals = 0;
  const transport = new Transport({
    request: (request) => {
      if (request.url.includes("/v1/changes?")) { refusals++; return Promise.resolve(r.server.error(401, "bad_signature", "signature does not match")); }
      return r.server.request(request);
    },
    serverUrl: () => "https://sync.example.invalid", device: () => ({ id: KEYS.deviceId, secret: Buffer.from(KEYS.deviceSecret, "hex") }), edgeHeaders: () => [], maxAttempts: 2,
  });
  const engine = new SyncEngine({ state: r.state, host: r.host, timers, transport, onStatus: (status) => statuses.push(status) });
  await engine.start();
  for (let turn = 0; turn < 50 && !statuses.some((s) => s.code === "forgotten_device"); turn++) await tick();
  assert.equal(refusals, 1);
  assert.ok(statuses.some((s) => s.code === "forgotten_device"));
  assert.equal(statuses.some((s) => s.kind === "offline"), false);
  assert.equal(engine.started, false);
  await timers.run(6000);
  assert.equal(refusals, 1, "no authentication retry loop");
  engine.stop();
});

test("only explicit device authentication refusals are classified as forgotten", () => {
  const error = (status, code) => new ApiError(status, code, "test");
  assert.equal(forgottenCredential(error(401, "bad_signature")), true);
  assert.equal(forgottenCredential(error(403, "device_revoked")), true);
  for (const e of [error(0, "unreachable"), error(403, "edge_refused"), error(401, "bad_setup_token"), error(500, "bad_signature"), new Error("bad_signature")]) assert.equal(forgottenCredential(e), false);
});


test("a key changed while setup waits cannot adopt the old key's credential", async (t) => {
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: unpaired });
  const setup = r.instance.transport.setup.bind(r.instance.transport);
  r.instance.transport.setup = async (...args) => {
    const response = await setup(...args);
    r.instance.state.data.vrk = "ab".repeat(32);
    return response;
  };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.instance.state.data.deviceId, null);
  assert.ok(r.notices.some((text) => text.includes("response was not adopted")));
});

test("revoking this device directly exposes recovery without restarting the plugin", async (t) => {
  const r = await plugin(t);
  await r.instance.registerAccountRecovery();
  await r.instance.revokeDevice(KEYS.deviceId);
  assert.equal(r.instance.forgottenDevice, true);
  assert.match(r.instance.statusText(), /no longer recognises/);
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.notEqual(r.instance.state.data.deviceId, KEYS.deviceId);
});

test("both devices can switch in order and leave no active credential on the old server", async (t) => {
  const server = new FakeServer();
  const otherId = "ab".repeat(16), otherSecret = "bc".repeat(32);
  server.addDevice(otherId, otherSecret, "second");
  const a = await plugin(t, { server });
  const b = await plugin(t, { server, metadata: { deviceId: otherId, deviceSecret: otherSecret } });
  for (const r of [a, b]) {
    await r.instance.registerAccountRecovery();
    assert.deepEqual(await r.instance.leaveServer({ discardUnpushed: false, localOnly: false }), { decision: "left", revoked: true });
    await r.instance.setServerUrl("https://new.example.invalid");
    assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  }
  assert.equal(server.devices.filter((device) => !device.revoked).length, 0);
});

test("startup authentication refusal identifies a forgotten device without scheduling reconnect", async (t) => {
  const r = await plugin(t);
  r.server.secrets.clear();
  delete r.instance.startEngine;
  await r.instance.startEngine();
  assert.equal(r.instance.forgottenDevice, true);
  assert.match(r.instance.statusText(), /no longer recognises/);
  assert.equal(r.instance.engine, null);
  const before = r.server.requests.length;
  await r.instance.startEngine();
  assert.equal(r.server.requests.length, before);
});


test("an old server without recovery registration can still sync while its last-device safeguard remains", async (t) => {
  const r = await plugin(t);
  const k = await keys();
  await r.server.seedDomainMap(k.map, KEYS.domainId);
  const { ApiError: BoxError } = r.box.require(join(r.box.home, "build/transport.js"));
  r.instance.transport.registerRecovery = async () => { throw new BoxError(404, "not_found", "old server"); };
  delete r.instance.startEngine;
  t.after(async () => { await r.instance.engine?.stopAndWait(); });
  await r.instance.startEngine();
  assert.equal(r.instance.engine.started, true);
  assert.equal(r.instance.forgottenDevice, false);
  assert.equal(r.server.recoveryVerifier, null);
  assert.ok(r.logs.includes("recovery decision=unavailable reason=not_found"));
  assert.equal((await r.instance.leaveServer({ discardUnpushed: false, localOnly: false })).reason, "last_device");
});

test("a forgotten credential permits restoring the phrase before re-enrollment", async (t) => {
  const r = await plugin(t);
  r.server.secrets.clear();
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  await r.instance.restoreVaultKey("ab".repeat(32));
  assert.equal(r.instance.state.data.vrk, "ab".repeat(32));
  assert.equal(r.server.requests.length, 0, "an unusable old credential cannot gate phrase restoration");
});

test("recovery reset refuses an active enrollment and an in-progress restore", async (t) => {
  const r = await plugin(t);
  await r.instance.resetForgottenEnrollment();
  assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  r.instance.restoring = {};
  await assert.rejects(r.instance.resetForgottenEnrollment(), /Finish the current restore/);
  assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
});

test("recovery reset waits for the old engine writer even after the engine reference was cleared", async (t) => {
  const r = await plugin(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  r.instance.engine = { stop() {}, stopAndWait: () => held };
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  let reset = false;
  const done = r.instance.resetForgottenEnrollment().then(() => { reset = true; });
  for (let i = 0; i < 20; i++) await tick();
  try {
    assert.equal(reset, false);
    assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
  } finally { release(); await done; }
  assert.equal(r.instance.state.data.deviceId, null);
});

test("a vault-key change during proof derivation sends no stale proof", async (t) => {
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: unpaired });
  const recovery = r.box.require(join(r.box.home, "build/accountRecovery.js"));
  const original = recovery.accountRecovery;
  recovery.accountRecovery = async (vrk) => {
    const proof = await original(vrk);
    r.instance.state.data.vrk = "ab".repeat(32);
    return proof;
  };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.server.requests.length, 0);
  assert.equal(r.instance.state.data.deviceId, null);
});

test("a rejected recovery registration also exposes the forgotten-device action", async (t) => {
  const r = await plugin(t);
  r.server.secrets.clear();
  await r.instance.registerAccountRecovery();
  assert.equal(r.instance.forgottenDevice, true);
  assert.match(r.instance.statusText(), /no longer recognises/);
});

test("a forgotten device can claim pairing only after its stale enrollment is cleared", async (t) => {
  const r = await plugin(t, { metadata: { lastSeq: 42 } });
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  const { PairClaimModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  const { encodePairingCode } = r.box.require(join(r.box.home, "build/pairing.js"));
  const modal = new PairClaimModal(r.instance.app, r.instance, encodePairingCode("11".repeat(16), "22".repeat(32), new Uint8Array(16)));
  modal.contentEl = { empty() {} };
  modal.close = () => modal.onClose();
  let claims = 0;
  r.instance.transport.pairingClaim = async () => {
    claims++;
    assert.equal(r.instance.state.data.deviceId, null);
    assert.equal(r.instance.state.data.lastSeq, 0);
    modal.waiting = false;
    return { outcome: "ok", value: { device_id: "bc".repeat(16), device_secret: "cd".repeat(32) } };
  };
  await modal.claim();
  assert.equal(claims, 1);
  assert.equal(r.instance.state.data.deviceId, "bc".repeat(16));
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
});

test("registration does not bind a proof after its vault key was replaced", async (t) => {
  const r = await plugin(t);
  const recovery = r.box.require(join(r.box.home, "build/accountRecovery.js"));
  const original = recovery.accountRecovery;
  recovery.accountRecovery = async (vrk) => {
    const result = await original(vrk);
    r.instance.state.data.vrk = "ab".repeat(32);
    return result;
  };
  await r.instance.registerAccountRecovery();
  assert.equal(r.server.requests.length, 0);
  assert.equal(r.server.recoveryVerifier, null);
});

test("closing pairing while its forgotten identity resets prevents a claim", async (t) => {
  const r = await plugin(t);
  r.instance.setStatus({ kind: "error", code: "forgotten_device", message: FORGOTTEN_DEVICE });
  const { PairClaimModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  const { encodePairingCode } = r.box.require(join(r.box.home, "build/pairing.js"));
  const modal = new PairClaimModal(r.instance.app, r.instance, encodePairingCode("11".repeat(16), "22".repeat(32), new Uint8Array(16)));
  modal.contentEl = { empty() {} };
  modal.close = () => modal.onClose();
  const reset = r.instance.resetForgottenEnrollment.bind(r.instance);
  r.instance.resetForgottenEnrollment = async () => { await reset(); modal.close(); };
  let claims = 0;
  r.instance.transport.pairingClaim = async () => { claims++; throw new Error("unexpected claim"); };
  await modal.claim();
  assert.equal(claims, 0);
  assert.equal(r.instance.state.data.deviceId, null);
});
