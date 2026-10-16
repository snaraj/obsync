/** Recovery journeys through the real plugin, state, transport and engine. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { hkdfSync, createHash } from "node:crypto";
import { FakeHost, FakeServer, FakeTimers, KEYS, RECOVERY_HOLD_MS, SETUP_TOKEN, memorySecrets, sandbox, rig, keys, statusItem } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { accountRecovery, forgottenCredential, FORGOTTEN_DEVICE } = require("../build/accountRecovery.js");
const { ApiError, Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const tick = () => new Promise(setImmediate);
const unpaired = { deviceId: null, deviceSecret: null };
async function plugin(t, { server = new FakeServer(), host = new FakeHost(), metadata = {}, legacy = false, registered = true } = {}) {
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
  instance.app = { workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (done) => done() }, secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}), getName: () => "Recovery QA", getMarkdownFiles: () => [...host.files.keys()].filter((path) => path.endsWith(".md")) } };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.3" };
  instance.checkForUpdate = async () => {};
  instance.startEngine = async () => { starts++; };
  instance.log = (line) => logs.push(line);
  if (!legacy && stored.vrk !== null) {
    const desired = structuredClone(stored), { State } = box.require(join(box.home, "build/state.js")), c = box.require(join(box.home, "build/crypto.js"));
    stored = { ...desired, vrk: null, deviceId: null, deviceSecret: null };
    const initial = await State.open(instance, false, instance.app.secretStorage);
    await initial.stageEnrollment2(desired.vrk, "pair");
    await initial.adoptSuite2({ root: desired.vrk, generation: (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(desired.vrk)))).fileId,
      deviceId: desired.deviceId ?? KEYS.deviceId, deviceSecret: desired.deviceSecret ?? KEYS.deviceSecret, purpose: "pair" });
    if (desired.deviceId === null) { initial.data.deviceId = null; initial.data.deviceSecret = null; await initial.save(); }
  }
  if (!legacy && server.claimed) {
    const k = await keys(); await server.seedDomainMap(k.map, KEYS.domainId);
    if (registered && !server.recoveryArmed && server.recoveryVerifier === null) {
      server.recoveryVerifier = (await accountRecovery(KEYS.vrk)).verifier; server.recoveryAt = server.clock - RECOVERY_HOLD_MS;
    }
  }
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

test("legacy registration protects the last credential; ordinary recovery requires explicit upgrade", async (t) => {
  const r = await plugin(t, { legacy: true });
  await r.instance.registerAccountRecovery();
  const derived = await accountRecovery(KEYS.vrk);
  assert.equal(r.server.recoveryVerifier, derived.verifier);
  const registration = r.server.requests.find((request) => request.target.endsWith("/v1/account/recovery"));
  assert.ok(registration);
  const wire = registration.json;
  assert.equal(wire.includes(derived.proof), false);
  assert.equal(wire.includes(KEYS.vrk), false);
  // The key is new, so the server keeps its only device for the hold (1.1.5):
  // the leave is refused by name and this device keeps its credential.
  const held = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  assert.deepEqual([held.decision, held.reason], ["refused", "recovery_too_new"]);
  assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
  assert.equal(r.server.devices[0].revoked, false);
  r.server.clock += RECOVERY_HOLD_MS;
  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  assert.equal(r.server.devices[0].revoked, true);
  assert.equal(r.instance.state.data.deviceId, null);
  await r.instance.setServerUrl("https://sync.example.invalid");
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.instance.state.data.deviceId, null);
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  assert.ok(r.notices.some((text) => /older vault key.*explicit encryption upgrade/.test(text)));
});

test("forgotten credentials show recovery and reset metadata without touching notes, key or address", async (t) => {
  const r = await plugin(t, { metadata: { lastSeq: 42, edgeHeaders: [{ name: "X-Edge", value: "TEST" }] } });
  r.host.seed("kept.md", "local unsent content", 1);
  r.instance.state.data.files["kept.md"] = { fileId: "12".repeat(16), versionId: "34".repeat(32), mtime: 1, size: 20, sha256: "" };
  r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
  r.instance.setStatus({ kind: "idle" });
  assert.match(r.instance.statusText(), /no longer recognises/);
  const { ObsyncSettingTab } = r.box.require(join(r.box.home, "build/ui/settings.js"));
  const tab = new ObsyncSettingTab(r.instance.app, r.instance);
  const row = tab.getSettingDefinitions().flatMap((g) => g.items).find((item) => item.name === "Setup or recover");
  assert.ok(row.visible(), "the rejected non-null ID must not hide recovery");
  // The handle requests signed with goes with the credential (#197).
  let forgotten = 0;
  r.instance.transport.forgetDevice = () => { forgotten++; };
  await r.instance.resetForgottenEnrollment();
  assert.equal(forgotten, 1, "the signing handle was dropped with the credential");
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
  r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.notEqual(r.instance.state.data.deviceId, KEYS.deviceId);
  assert.equal(r.instance.forgottenDevice, false);
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  assert.ok(r.notices.some((text) => text.includes("Recovered this vault's enrollment")));
});

test("a wrong token and a wrong vault key never enrol a recovery device", async (t) => {
  for (const reason of ["token", "key"]) {
    const server = new FakeServer();
    server.recoveryVerifier = (await accountRecovery(KEYS.vrk)).verifier;
    const r = await plugin(t, { server, metadata: { ...unpaired, vrk: reason === "key" ? "ab".repeat(32) : KEYS.vrk } });
    await r.instance.setUpAccount(reason === "token" ? "wrong-token" : SETUP_TOKEN, "obsync");
    assert.equal(server.devices.length, 1, reason);
    assert.equal(r.instance.state.data.deviceId, null, reason);
    assert.equal(server.requests.filter(request => request.method === "POST").length, 1, "no automatic enrollment retry");
    assert.equal(server.requests.filter(request => request.method === "GET" && request.target === "/v1/setup").length, 1, "credential-free capability read");
  }
});

test("an operator-cleared account re-enrols the restored key, which then carries the hold and can be warned about (1.1.5)", async (t) => {
  // The state `obsyncd recovery reset apply` leaves: no verifier, one re-enrolment armed.
  const server = new FakeServer();
  server.resetRecovery();
  const r = await plugin(t, { server, metadata: { ...unpaired, vrk: KEYS.vrk } });
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  // The restored key re-enrols and registers the verifier it derives, timed,
  // which spends the arm.
  assert.notEqual(r.instance.state.data.deviceId, null);
  assert.equal(server.recoveryVerifier, (await accountRecovery(KEYS.vrk)).verifier);
  assert.notEqual(server.recoveryAt, null);
  assert.equal(server.recoveryArmed, false);
  assert.ok(r.notices.some((text) => text.includes("Recovered this vault's enrollment")));
  // The request carried the proof, because the key was restored, not freshly made.
  const setup = server.requests.find((request) => request.method === "POST" && request.target.endsWith("/v1/setup"));
  assert.ok(JSON.parse(setup.json).recovery_proof, "a restored key proves the vault");
});

test("an account with no key that no one has reset refuses the restored key, and says how to get in (1.1.5)", async (t) => {
  // An account set up before any key was registered, and never reset: the
  // server answers recovery_unavailable, as 1.1.4 did.
  const server = new FakeServer();
  const r = await plugin(t, { server, registered: false, metadata: { ...unpaired, vrk: KEYS.vrk } });
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.instance.state.data.deviceId, null);
  assert.equal(server.devices.length, 1, "no device was enrolled");
  assert.equal(server.recoveryVerifier, null, "no key was chosen");
  assert.ok(r.logs.includes("setup decision=failed reason=recovery_unavailable"), r.logs.join(" | "));
  const told = r.notices.join(" | ");
  assert.match(told, /Pair a new device.*Pair this device/, told);
  assert.match(told, /reset its recovery key/, told);
  assert.ok(!/\b(401|403|409)\b|recovery_unavailable/.test(told), told);
});

test("setup against a certificate this device does not trust says so, never 'the server refused this step'", async (t) => {
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: { ...unpaired, vrk: null } });
  const { ApiError, CERT_UNTRUSTED } = r.box.require(join(r.box.home, "build/transport.js"));
  r.instance.transport.setup2 = async () => { throw new ApiError(0, "unreachable", "network=net::ERR_CERT_AUTHORITY_INVALID"); };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.instance.state.data.deviceId, null);
  assert.deepEqual(r.notices, [`obsync: ${CERT_UNTRUSTED}`]);
});

test("a lost first setup response retains its pre-request key for an explicit recovery attempt", async (t) => {
  const server = new FakeServer({ claimed: false });
  const r = await plugin(t, { server, metadata: { ...unpaired, vrk: null } });
  const original = r.instance.transport.setup2.bind(r.instance.transport);
  r.instance.transport.setup2 = async (...args) => {
    assert.ok(r.instance.state.stagedEnrollment2()?.root, "the detached key is durable before the server is asked");
    await original(...args);
    return { outcome: "lost", status: 0, reason: "connection closed" };
  };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  const retained = r.instance.state.stagedEnrollment2().root;
  assert.equal(r.instance.state.data.deviceId, null);
  assert.equal(server.devices.length, 1);
  assert.equal(server.recoveryVerifier, (await accountRecovery(retained)).verifier);
  r.instance.transport.setup2 = original;
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync", "recover-first-setup");
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
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: { ...unpaired, vrk: null } });
  await Promise.all([r.instance.setUpAccount(SETUP_TOKEN, "obsync"), r.instance.setUpAccount(SETUP_TOKEN, "obsync")]);
  assert.equal(r.server.devices.length, 1);
  assert.equal(r.server.requests.filter((request) => request.method === "POST" && request.target.endsWith("/v1/setup")).length, 1);
});

test("the feed stops on a forgotten credential and never reports a reachable server as offline", { timeout: 5000 }, async (t) => {
  const r = await rig();
  const timers = new FakeTimers(), statuses = [];
  let observed;
  const forgotten = new Promise((resolve) => { observed = resolve; });
  let refusals = 0;
  const transport = new Transport({
    request: (request) => {
      if (request.url.includes("/v1/changes?")) { refusals++; return Promise.resolve(r.server.error(401, "bad_signature", "signature does not match")); }
      return r.server.request(request);
    },
    serverUrl: () => "https://sync.example.invalid", device: () => ({ id: KEYS.deviceId, secret: Buffer.from(KEYS.deviceSecret, "hex") }), edgeHeaders: () => [], maxAttempts: 2,
  });
  const engine = new SyncEngine({ state: r.state, host: r.host, timers, transport, onStatus: (status) => {
    statuses.push(status);
    if (status.code === "credential_rejected" || status.kind === "offline") observed();
  } });
  t.after(() => engine.stop());
  await engine.start();
  // HMAC signing runs on WebCrypto's worker pool. A fixed count of immediate
  // turns can finish before that pool answers on a loaded Linux CI host.
  // Observe either classification so an incorrect offline retry fails the
  // assertions below instead of leaving this witness waiting indefinitely.
  await forgotten;
  assert.equal(refusals, 1);
  assert.ok(statuses.some((s) => s.code === "credential_rejected"));
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
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: { ...unpaired, vrk: null } });
  const setup = r.instance.transport.setup2.bind(r.instance.transport);
  r.instance.transport.setup2 = async (...args) => {
    const response = await setup(...args);
    r.instance.state.data.vrk = "ab".repeat(32);
    return response;
  };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.instance.state.data.deviceId, null);
  assert.ok(r.notices.some((text) => /staged vault changed|enrollment was not adopted/.test(text)));
});

test("revoking this device directly exposes recovery without restarting the plugin", async (t) => {
  const r = await plugin(t);
  await r.instance.registerAccountRecovery();
  r.server.clock += RECOVERY_HOLD_MS;
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
  // Registered a week ago: the hold has passed (1.1.5).
  server.recoveryVerifier = (await accountRecovery(KEYS.vrk)).verifier;
  server.recoveryAt = server.clock - RECOVERY_HOLD_MS;
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


test("legacy registration refusal retains last-device protection; live sync requires upgrade", async (t) => {
  const r = await plugin(t, { legacy: true });
  const { ApiError: BoxError } = r.box.require(join(r.box.home, "build/transport.js"));
  r.instance.transport.registerRecovery = async () => { throw new BoxError(404, "not_found", "old server"); };
  await r.instance.registerAccountRecovery();
  delete r.instance.startEngine;
  t.after(async () => { await r.instance.engine?.stopAndWait(); });
  await r.instance.startEngine();
  assert.equal(r.instance.engine, null, "legacy main never starts a live engine");
  assert.equal(r.instance.forgottenDevice, false);
  assert.equal(r.server.recoveryVerifier, null);
  assert.ok(r.logs.includes("recovery decision=unavailable reason=not_found"));
  assert.equal((await r.instance.leaveServer({ discardUnpushed: false, localOnly: false })).reason, "last_device");
});

test("a forgotten credential permits restoring the phrase before re-enrollment", async (t) => {
  const r = await plugin(t);
  r.server.secrets.clear();
  r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
  await r.instance.resetForgottenEnrollment();
  const { encodeRecoveryBackup } = r.box.require(join(r.box.home, "build/recoveryBackup.js"));
  await r.instance.stageRecoveryBackup(await encodeRecoveryBackup(Uint8Array.from(Buffer.from(KEYS.vrk, "hex"))));
  assert.equal(r.instance.state.stagedEnrollment2().root, KEYS.vrk);
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
  assert.equal(r.server.requests.length, 0, "an unusable old credential cannot gate phrase restoration");
});

test("recovery reset refuses an active enrollment and an in-progress restore", async (t) => {
  const r = await plugin(t);
  await r.instance.resetForgottenEnrollment();
  assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
  r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
  r.instance.restoring = {};
  await assert.rejects(r.instance.resetForgottenEnrollment(), /Finish the current restore/);
  assert.equal(r.instance.state.data.deviceId, KEYS.deviceId);
});

test("recovery reset waits for the old engine writer even after the engine reference was cleared", async (t) => {
  const r = await plugin(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  r.instance.engine = { stop() {}, stopAndWait: () => held };
  r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
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
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: { ...unpaired, vrk: null } });
  const recovery = r.box.require(join(r.box.home, "build/accountRecovery.js"));
  const original = recovery.accountRecovery;
  recovery.accountRecovery = async (vrk) => {
    const proof = await original(vrk);
    r.instance.state.data.vrk = "ab".repeat(32);
    return proof;
  };
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.equal(r.server.requests.filter(request => request.method === "POST").length, 0, "changed local authority sends no proof");
  assert.equal(r.instance.state.data.deviceId, null);
});

test("a rejected recovery registration also exposes the forgotten-device action", async (t) => {
  const r = await plugin(t, { legacy: true });
  r.server.secrets.clear();
  await r.instance.registerAccountRecovery();
  assert.equal(r.instance.forgottenDevice, true);
  assert.match(r.instance.statusText(), /no longer recognises/);
});

test("a forgotten device can claim pairing only after its stale enrollment is cleared", async (t) => {
  const r = await plugin(t, { metadata: { lastSeq: 42 } });
  r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
  const { PairClaimModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  const { encodePairingCode } = r.box.require(join(r.box.home, "build/pairing.js"));
  const modal = new PairClaimModal(r.instance.app, r.instance, encodePairingCode("11".repeat(16), "22".repeat(32), new Uint8Array(16), new Uint8Array(16)));
  modal.contentEl = { empty() {}, createEl: () => ({ setText() {} }) };
  modal.close = () => modal.onClose();
  let claims = 0;
  r.instance.transport.pairingClaim2 = async () => {
    claims++;
    assert.equal(r.instance.state.data.deviceId, null);
    assert.equal(r.instance.state.data.lastSeq, 0);
    return { outcome: "ok", value: { device_id: "bc".repeat(16), device_secret: "cd".repeat(32) } };
  };
  // The claim is HELD until its key arrives (#153); this one is refused at once.
  const { ApiError: Refused } = r.box.require(join(r.box.home, "build/transport.js"));
  r.instance.transport.pairingEnvelope = async () => { throw new Refused(401, "bad_signature", "gone"); };
  const previous = globalThis.window;
  globalThis.window = { ...previous, setTimeout: (fn) => { fn(); return 0; } };
  t.after(() => { globalThis.window = previous; });
  await modal.claim();
  assert.equal(claims, 1);
  assert.equal(r.instance.state.data.deviceId, null, "no credential is kept before its key");
  assert.equal(r.instance.state.data.vrk, KEYS.vrk);
});

async function rejectedRotationClaim(t, { unknown = 0, answer = null, closedBeforeClaim = false, invalidCode = false } = {}) {
  const r = await plugin(t), instance = r.instance;
  const pairing = r.box.require(join(r.box.home, "build/pairing.js"));
  const c = r.box.require(join(r.box.home, "build/crypto.js"));
  const { encodeRecoveryBackup } = r.box.require(join(r.box.home, "build/recoveryBackup.js"));
  const { PairClaimModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  const oldGeneration = instance.state.custody2().generation, nextRoot = "ab".repeat(32);
  const nextGeneration = (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(nextRoot)))).fileId;
  const pairingId = "12".repeat(16), token = "34".repeat(32), secret = new Uint8Array(16).fill(56);
  const creator = await pairing.newPairingKeyExchange(), claimed = { device_id: "cd".repeat(16), device_secret: "ef".repeat(32) };
  const code = pairing.encodePairingCode(pairingId, token, secret, await pairing.pairingCommitment(pairingId, creator.publicKey));
  let modal, claimantKey, observed, finished = 0;
  const questions = [], calls = [], resumed = [];
  r.host.seed("Local.md", "LOCAL RETAINED NOTE", 1000);
  const obsidian = r.box.require("obsidian"), { ConfirmModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  obsidian.Setting.prototype.addButton = function (build) {
    const button = { setButtonText(value) { this.text = value; return this; }, setDestructive() { this.destructive = true; return this; }, onClick(fn) { this.click = fn; return this; } };
    (this.el.buttons ??= []).push(button); build(button); return this;
  };
  ConfirmModal.prototype.open = function () {
    this.contentEl = { buttons: [], empty() {}, createEl() {} };
    this.setTitle = title => { this.title = title; }; this.close = () => this.onClose(); this.onOpen();
    questions.push(this.title); calls.push("consent");
    assert.equal(instance.state.paired, false, "consent precedes activation");
    assert.equal(instance.state.data.deviceId, null);
    assert.equal(instance.state.custody2().history.root, KEYS.vrk);
    const button = this.contentEl.buttons.find(button => button.text === answer);
    assert.ok(button, "a real consent answer is required"); button.click();
  };
  PairClaimModal.prototype.open = function () { modal = this; };
  instance.transport.pairingClaim2 = async (_id, _token, info) => {
    calls.push("claim"); claimantKey = info.claimant_pub;
    observed = { paired: instance.state.paired, deviceId: instance.state.data.deviceId, custody: instance.state.custody2() };
    return { outcome: "ok", value: claimed };
  };
  instance.transport.pairingEnvelope = async () => { calls.push("envelope"); return { outcome: "ok", value: {
    ...(await pairing.sealEnvelope2(creator, claimantKey, secret, pairingId, { v: 2, vrk: nextRoot, generation: nextGeneration })), creator_pub: creator.publicKey,
  } }; };
  instance.transport.revokeDevice = async deviceId => { assert.equal(deviceId, claimed.device_id); calls.push("revoke-new-claim"); return { outcome: "ok", value: undefined }; };
  instance.notesUnknownTo2 = async (root, generation) => {
    assert.equal(root, nextRoot); assert.equal(generation, nextGeneration);
    assert.equal(instance.state.paired, false); assert.equal(instance.state.data.deviceId, null);
    assert.deepEqual(instance.state.custody2().history, { root: KEYS.vrk, generation: oldGeneration, suite: 2 });
    calls.push("survey"); return unknown;
  };
  instance.restartEngine = async () => { finished++; };
  r.server.secrets.clear();
  delete instance.startEngine;
  await instance.startEngine(); // Real transport authentication refusal reaches the production status handler.
  assert.equal(instance.forgottenDevice, true); assert.equal(instance.state.paired, true);
  assert.equal(instance.state.data.deviceId, KEYS.deviceId); assert.equal(instance.state.custody2().phase, "active");
  assert.equal(instance.engine, null);
  const start = instance.startEngine.bind(instance);
  instance.startEngine = async () => {
    if (instance.forgottenDevice) return start(); // Actual rejected-credential gate must keep old sync stopped.
    assert.equal(instance.state.data.vrk, nextRoot, "only the newly adopted generation may restart");
    assert.equal(instance.state.data.deviceId, claimed.device_id); resumed.push(nextRoot);
  };
  await instance.pairAfterRotation(await encodeRecoveryBackup(c.unhex(KEYS.vrk)), () => {});
  assert.ok(modal instanceof PairClaimModal, "actual replacement entry opens the actual claimant dialog");
  modal.code = invalidCode ? "incomplete code" : code;
  modal.contentEl = { empty() {}, createEl: () => ({ setText() {} }) };
  modal.close = () => modal.onClose();
  const previous = globalThis.window;
  globalThis.window = { ...previous, setTimeout: fn => { fn(); return 0; } };
  try { if (closedBeforeClaim) modal.close(); await modal.claim(); await instance.waiting?.done; }
  finally { globalThis.window = previous; }
  assert.equal(r.host.text("Local.md"), "LOCAL RETAINED NOTE");
  return { ...r, instance, oldGeneration, nextGeneration, nextRoot, observed, finished, claimed, questions, calls, resumed };
}

test("Pair after rotation preserves a rejected old enrollment until authenticated replacement stages history", async (t) => {
  const { instance, observed, oldGeneration, nextRoot, claimed, finished, ...r } = await rejectedRotationClaim(t);
  assert.equal(instance.state.paired, true, r.logs.join(" | "));
  assert.equal(observed.paired, true, "the rejected old credential remains local until explicit replacement staging");
  assert.equal(observed.deviceId, KEYS.deviceId);
  assert.equal(observed.custody.generation, oldGeneration);
  assert.equal(instance.state.data.vrk, nextRoot);
  assert.equal(instance.state.data.deviceId, claimed.device_id);
  assert.deepEqual(instance.state.custody2().history, { root: KEYS.vrk, generation: oldGeneration, suite: 2 });
  assert.equal(instance.forgottenDevice, false);
  assert.equal(instance.rotating, false);
  assert.equal(finished, 1);
});

test("a rejected replacement still requires ordinary upload consent and retains old history on accept or cancel", async t => {
  for (const answer of ["Pair and upload", "Cancel"]) {
    const r = await rejectedRotationClaim(t, { unknown: 1, answer });
    const pin = r.instance.state.custody2(), accepted = answer === "Pair and upload";
    assert.deepEqual(r.questions, ["Add this vault's notes to the server's vault?"]);
    assert.deepEqual(r.calls, ["claim", "envelope", "survey", "consent", ...(accepted ? [] : ["revoke-new-claim"])]);
    assert.equal(r.observed.paired, true); assert.equal(r.observed.deviceId, KEYS.deviceId);
    assert.deepEqual(pin.history, { root: KEYS.vrk, generation: r.oldGeneration, suite: 2 });
    assert.equal(pin.phase, accepted ? "active" : "enrollment");
    assert.equal(r.instance.state.paired, accepted);
    assert.equal(r.instance.state.data.deviceId, accepted ? r.claimed.device_id : null);
    assert.equal(r.instance.state.data.deviceSecret, accepted ? r.claimed.device_secret : null);
    assert.equal(r.instance.state.data.vrk, accepted ? r.nextRoot : null);
    assert.equal(r.instance.forgottenDevice, !accepted); assert.equal(r.instance.rotating, !accepted);
    assert.equal(r.finished, accepted ? 1 : 0); assert.equal(r.instance.engine, null);
    assert.deepEqual(r.resumed, accepted ? [r.nextRoot] : []);
    const { State } = r.box.require(join(r.box.home, "build/state.js"));
    const { desktopSecretStore } = r.box.require(join(r.box.home, "build/desktopCustody.js"));
    const reopened = await State.open({ loadData: async () => r.metadata(), saveData: async () => assert.fail("unexpected recovery metadata write") }, false,
      desktopSecretStore(r.instance.app.secretStorage, r.instance.platformName()));
    assert.deepEqual(reopened.custody2().history, pin.history, "old history survives a real persisted-state reload");
    assert.equal(reopened.custody2().phase, pin.phase);
  }
});

test("closing or refusing a rejected replacement before its envelope preserves old authority without restarting it", async t => {
  for (const options of [{ closedBeforeClaim: true }, { invalidCode: true }]) {
    const r = await rejectedRotationClaim(t, options);
    assert.deepEqual(r.calls, []); assert.equal(r.finished, 0);
    assert.equal(r.instance.state.data.deviceId, KEYS.deviceId); assert.equal(r.instance.state.data.vrk, KEYS.vrk);
    assert.equal(r.instance.state.custody2().phase, "active"); assert.equal(r.instance.state.custody2().history, null);
    assert.equal(r.instance.forgottenDevice, true); assert.equal(r.instance.engine, null);
    assert.deepEqual(r.posts(), [], "a rejected old credential is not re-authorized or used for an enrollment");
  }
});

test("registration does not bind a proof after its vault key was replaced", async (t) => {
  const r = await plugin(t, { legacy: true });
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
  for (const incomplete of [false, true]) {
    const r = await plugin(t);
    r.instance.setStatus({ kind: "error", code: "credential_rejected", message: FORGOTTEN_DEVICE });
    const { PairClaimModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
    const { encodePairingCode } = r.box.require(join(r.box.home, "build/pairing.js"));
    const code = incomplete ? "incomplete code" : encodePairingCode("11".repeat(16), "22".repeat(32), new Uint8Array(16), new Uint8Array(16));
    const modal = new PairClaimModal(r.instance.app, r.instance, code);
    modal.contentEl = { empty() {}, createEl: () => ({ setText() {} }) };
    modal.close = () => modal.onClose();
    const reset = r.instance.resetForgottenEnrollment.bind(r.instance);
    r.instance.resetForgottenEnrollment = async () => { await reset(); modal.close(); };
    let claims = 0;
    r.instance.transport.pairingClaim2 = async () => { claims++; throw new Error("unexpected claim"); };
    await modal.claim();
    assert.deepEqual(r.notices, [], "a cancelled dialog must not report a validation error");
    assert.equal(claims, 0);
    assert.equal(r.instance.state.data.deviceId, null);
  }
});

// ---- issues #152, #154: what setup sends, and what its refusals say ---------

const RAW_CODE = /\b(401|403|409)\b|bad_setup_token|already_set_up|recovery_unavailable|bad_recovery_proof/;

test("a setup token pasted with quotes and a line break sets up, under this device's own name (#152, #154)", async (t) => {
  const server = new FakeServer({ claimed: false });
  const r = await plugin(t, { server, metadata: { ...unpaired, vrk: null } });
  await r.instance.setUpAccount(`“${SETUP_TOKEN.slice(0, 20)}\n  ${SETUP_TOKEN.slice(20)}” `, "obsync");
  assert.ok(r.instance.state.data.deviceId, r.notices.join(" | "));
  const setup = JSON.parse(server.requests.find((request) => request.method === "POST" && request.target === "/v1/setup").json);
  assert.equal(setup.setup_token, SETUP_TOKEN);
  assert.match(setup.device.name, /^Mac [2-9A-HJKMNP-TV-Z]{4}$/, "never the bare platform");
  assert.equal(setup.device.name, r.instance.deviceName(), "the server holds the name this device shows");
  assert.equal(r.metadata().deviceTag, setup.device.name.slice("Mac ".length), "kept before it was sent");
});

test("a second computer's setup is told to pair instead, naming both commands, never a code (#154)", async (t) => {
  for (const registered of [true, false]) {
    const server = new FakeServer();
    if (registered) server.recoveryVerifier = (await accountRecovery(KEYS.vrk)).verifier;
    const r = await plugin(t, { server, metadata: { ...unpaired, vrk: null } });
    await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
    assert.equal(r.instance.state.data.deviceId, null);
    const told = r.notices.join(" | ");
    assert.match(told, /already holds a vault.*Pair a new device.*Pair this device/, told);
    assert.match(told, /complete recovery backup/, "the current suite2 backup is an explicit alternative");
    assert.ok(!RAW_CODE.test(told), told);
    assert.ok(!/recovery words|recovery phrase/.test(told), "a key made for this setup restored nothing");
    // Persisted new intent supplies only its own derived proof. The server
    // refuses occupied authority instead of choosing a vault or recovery mode.
    assert.ok(r.logs.some((line) => /^setup decision=failed reason=recover_only_required$/.test(line)));
    const setup = r.server.requests.find((request) => request.method === "POST" && request.target.endsWith("/v1/setup"));
    assert.equal(JSON.parse(setup.json).recover_only, false, "only persisted local new intent may initialize; the server must refuse occupied authority");
    assert.ok(JSON.parse(setup.json).recovery_proof, "new authority derives its future recovery proof, without selecting the occupied account");
  }
});

test("a setup token from elsewhere is refused in words (#154)", async (t) => {
  const r = await plugin(t, { server: new FakeServer({ claimed: false }), metadata: { ...unpaired, vrk: null } });
  await r.instance.setUpAccount("another-servers-token", "obsync");
  const told = r.notices.join(" | ");
  assert.match(told, /did not accept that setup token.*obsyncd setup-token/, told);
  assert.ok(!RAW_CODE.test(told), told);
});

/** Settings and Show sync status, recorded: every name and description drawn, and every button. */
function recordDrawing(obsidian) {
  const drawn = [], buttons = [];
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { drawn.push(value); return this; },
    setDesc(value) { drawn.push(value); return this; },
    addButton(make) {
      const button = { setButtonText(value) { button.text = value; return button; }, setCta() { return button; },
        setDisabled() { return button; }, onClick(handler) { button.click = handler; return button; } };
      buttons.push(button); make(button); return this;
    },
  });
  return { drawn, buttons };
}

for (const mobile of [false, true]) test(`a legacy recovery key this device did not register is a security warning, said once and standing until its own registration succeeds (${mobile ? "mobile" : "desktop"}, 1.1.5)`, async (t) => {
  const r = await plugin(t, { legacy: true });
  const obsidian = r.box.require("obsidian");
  const platform = obsidian.Platform.isMobile;
  obsidian.Platform.isMobile = mobile;
  t.after(() => { obsidian.Platform.isMobile = platform; });
  const { RECOVERY_MISMATCH } = r.box.require(join(r.box.home, "build/accountRecovery.js"));
  // Another credential registered first; the server cannot tell which key is the vault's.
  r.server.recoveryVerifier = "b6".repeat(32);
  r.server.recoveryAt = r.server.clock;

  // The quietest notices a person can choose keep nothing of it off the screen (requirement 4).
  r.instance.state.data.notices = { level: "needs-me", merges: "off" };
  const item = r.instance.statusEl;
  assert.equal(item.getAttribute("data-state"), "synced");
  await r.instance.registerAccountRecovery();
  assert.equal(r.instance.recoveryMismatch, true);
  assert.deepEqual(r.notices, [`obsync security warning: ${RECOVERY_MISMATCH}`]);
  const toast = obsidian.raised.at(-1);
  assert.equal(toast.duration, 0, "it stays until the person dismisses it");
  assert.equal(toast.hidden, false);
  assert.deepEqual(r.logs, ["notice decision=shown kind=security stays_ms=0", "recovery decision=refused reason=recovery_mismatch warning=shown"]);
  // WHILE IT STANDS, THE STATUS ITEM IS THE ALERT, never the check (lab J,
  // finding A), and its words say where the warning is.
  assert.equal(item.getAttribute("data-state"), "attention");
  assert.equal(item.label, "obsync: idle — security warning: see Show sync status");
  assert.match(RECOVERY_MISMATCH, /Another device set a different recovery key/);
  assert.match(RECOVERY_MISMATCH, /a device may be compromised/);
  assert.match(RECOVERY_MISMATCH, /revoke any device you do not recognise/);
  assert.match(RECOVERY_MISMATCH, /ask whoever runs your server to clear the recovery key/);
  assert.match(RECOVERY_MISMATCH, /Troubleshooting page, "Another device set a different recovery key"/);

  // Every start asks again, and the warning stands without a second toast.
  await r.instance.registerAccountRecovery();
  assert.equal(r.notices.length, 1);
  assert.equal(r.logs.at(-1), "recovery decision=refused reason=recovery_mismatch warning=standing");

  // Settings and Show sync status carry it, first, with the guide one press away.
  const { drawn, buttons } = recordDrawing(obsidian);
  const { ObsyncSettingTab } = r.box.require(join(r.box.home, "build/ui/settings.js"));
  const tab = new ObsyncSettingTab(r.instance.app, r.instance);
  // A group of its own under the guide, so a hidden one leaves no trace in another group.
  const group = () => tab.getSettingDefinitions()[1];
  const row = () => group().items.find((item) => item.name === "Security warning");
  assert.equal(group().heading, "Security");
  assert.equal(group().visible(), true);
  assert.equal(group().items.length, 1);
  assert.equal(row().desc, RECOVERY_MISMATCH);
  const opened = [];
  r.instance.openSetupGuide = () => { opened.push("guide"); };
  row().render(new obsidian.Setting({}));
  assert.equal(buttons.at(-1).text, "Open the guide");
  buttons.at(-1).click();
  const { StatusModal } = r.box.require(join(r.box.home, "build/ui/modals.js"));
  const element = () => ({ createEl: () => element(), empty: () => { drawn.length = 0; } });
  const modal = new StatusModal({}, r.instance);
  Object.assign(modal, { contentEl: element(), setTitle: () => {}, close: () => modal.onClose() });
  const before = buttons.length;
  modal.onOpen();
  assert.deepEqual(drawn.slice(0, 2), ["Security warning", RECOVERY_MISMATCH], "above everything else");
  assert.equal(buttons[before].text, "Open the guide", "the modal's first button is the warning's");
  buttons[before].click();
  assert.deepEqual(opened, ["guide", "guide"]);

  // The operator's reset: the server forgets the key, this device's next
  // registration stands, and the warning ends everywhere it was said.
  r.server.resetRecovery();
  await r.instance.registerAccountRecovery();
  assert.equal(r.instance.recoveryMismatch, false);
  assert.equal(r.server.recoveryVerifier, (await accountRecovery(KEYS.vrk)).verifier);
  assert.equal(r.server.recoveryArmed, false, "this device's registration spent the arm");
  assert.deepEqual(r.logs.slice(-2), ["recovery decision=registered", "recovery decision=cleared reason=registered warning=cleared"]);
  assert.equal(group().visible(), false);
  // Its words stay in Recent, which is what was said; the warning itself is gone.
  assert.equal(drawn.includes("Security warning"), false, "Show sync status redrew without it");
  assert.equal(toast.hidden, true, "and its toast goes with it");
  assert.equal(item.getAttribute("data-state"), "synced", "and the alert with it");
  assert.equal(item.label, "obsync: idle");
  modal.onClose();
  assert.equal(r.notices.length, 1, "nothing more is said");
});

test("leaving ends the recovery-key warning with the pairing it was about (1.1.5)", async (t) => {
  const server = new FakeServer();
  server.addDevice("ab".repeat(16), "bc".repeat(32), "second");
  const r = await plugin(t, { server, legacy: true });
  server.recoveryVerifier = "b6".repeat(32);
  await r.instance.registerAccountRecovery();
  assert.equal(r.instance.recoveryMismatch, true);
  const toast = r.box.require("obsidian").raised.at(-1);
  assert.equal(toast.hidden, false);
  assert.deepEqual(await r.instance.leaveServer({ discardUnpushed: false, localOnly: false }), { decision: "left", revoked: true });
  assert.equal(r.instance.recoveryMismatch, false);
  assert.equal(toast.hidden, true, "its toast goes with the pairing");
});

test("a mismatch answered after this device's credential ended says nothing (1.1.5, #233)", async (t) => {
  const r = await plugin(t, { legacy: true });
  const { ApiError: BoxError } = r.box.require(join(r.box.home, "build/transport.js"));
  r.instance.transport.registerRecovery = async () => {
    r.instance.state.data.deviceId = null;
    throw new BoxError(409, "recovery_mismatch", "this account already has recovery for a different vault key");
  };
  await r.instance.registerAccountRecovery();
  assert.equal(r.instance.recoveryMismatch, false);
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.logs, ["recovery decision=unavailable reason=recovery_mismatch session=ended"]);
});
