import assert from "node:assert/strict";
import { test } from "node:test";
import { secretFacts, assertCustody, verifyConcurrentNativeCustody, installCustodyRefusalProbe, custodyRefusalFacts, verifyNativeCustodyRefusal, editorBounds, pairingCodes, assertPairingCodes } from "./obsidian-evidence.mjs";

test("pairing comparison reads visible role-specific prompts and refuses missing, ambiguous or mismatched codes", () => {
  const creator = "Approve only if the new device shows the code 123 456.";
  const claimant = "Waiting for approval on the other device. Its prompt shows the code 123 456: if it shows another, choose Reject there.";
  let modals = [];
  globalThis.document = { querySelectorAll: (selector) => {
    assert.equal(selector, ".modal:not(.mod-settings)"); return modals;
  } };
  const modal = (textContent, width = 200, height = 100) => ({ textContent, getBoundingClientRect: () => ({ width, height }) });
  try {
    assert.deepEqual(pairingCodes(), { creator: [], claimant: [] });
    modals = [modal(creator)];
    assert.deepEqual(pairingCodes(), { creator: ["123 456"], claimant: [] });
    modals = [modal(claimant.replace("123 456", "234 567"))];
    assert.deepEqual(pairingCodes(), { creator: [], claimant: ["234 567"] });
    modals = [modal(creator), modal(claimant), modal("Invitation 999 999"), modal(creator, 0), modal(claimant, 200, 0)];
    const matched = pairingCodes();
    assert.deepEqual(matched, { creator: ["123 456"], claimant: ["123 456"] });
    assertPairingCodes(matched);
    modals = [modal(creator), modal(claimant.replace("123 456", "123 457"))];
    assert.throws(() => assertPairingCodes(pairingCodes()), /approval refused/);
    modals = [modal(creator + creator), modal(claimant)];
    assert.throws(() => assertPairingCodes(pairingCodes()), /approval refused/);
    for (const bad of [
      { creator: [], claimant: [] }, { creator: ["123 456"], claimant: [] },
      { creator: [], claimant: ["123 456"] }, { creator: ["123 456"], claimant: ["123 456", "123 456"] },
      { creator: ["123456"], claimant: ["123456"] },
    ]) assert.throws(() => assertPairingCodes(bad), /approval refused/);
    modals = [modal(creator.replace("123 456", "1234 567")), modal(claimant.replace("123 456", "123 4567"))];
    assert.deepEqual(pairingCodes(), { creator: [], claimant: [] });
  } finally { delete globalThis.document; }
});

const required = { encrypted: true };
const valid = { encrypted: true, outerEncrypted: true, backend: "none reported", plain: false,
  stored: true, wrapped: true, plainRoot: false, revisionMatches: true, pinMatches: true, cleanupComplete: true };

function custodyFixture() {
  const id = "12".repeat(16), ref = `obsync-private-sync-v1-${id}-os`, prefix = "obsync-native-custody-v1:";
  const packet = prefix + Buffer.from([1, 2, 3]).toString("base64");
  const current = { revision: 7, serverUrl: "https://synthetic.invalid", deviceId: "34".repeat(16),
    vrk: "56".repeat(32), deviceSecret: "78".repeat(32), edgeHeaders: [{ value: "NEVER_RETURN_THE_SYNTHETIC_SECRET" }] };
  const custody = { suite: 2, phase: "active", generation: "90".repeat(16), enrollment: null, rotation: null, history: null };
  const metadata = { storageVersion: 3, credentialFormat: "native-desktop-v1", credentialEnvelopeVersion: 2,
    credentialCleanupPending: false, installationId: id, credentialRef: ref, credentialRevision: 7,
    serverUrl: current.serverUrl, deviceId: current.deviceId, sealPin: { suite: 2, phase: "active", generation: custody.generation } };
  const envelope = { version: 2, installationId: id, current, custody };
  const entries = new Map([[ref, packet]]), calls = [];
  const safe = { isEncryptionAvailable: () => true, decryptString(bytes) {
    assert.equal(this, safe, "native decrypt retains actual receiver");
    assert.ok(Buffer.isBuffer(bytes), "native decrypt uses the built-in Buffer");
    assert.deepEqual([...bytes], [1, 2, 3], "native decrypt receives the actual packet");
    calls.push("decrypt"); return JSON.stringify(envelope);
  } };
  const state = { paired: true, data: structuredClone(current), custody2: () => structuredClone(custody) };
  const app = { loadLocalStorage: () => "opaque-outer-ciphertext", plugins: { plugins: {
    "obsync-private-sync": { loadData: async () => metadata, state },
  } }, secretStorage: { getSecret: key => { assert.ok(key.length <= 64, "actual host reference ceiling is 64 characters"); calls.push("get"); return entries.get(key) ?? null; },
    isEncryptionAvailable: () => true, adapter: { safeStorage: safe } } };
  return { app, metadata, envelope, state, entries, safe, calls, ref, packet };
}

test("native wrapped custody refuses raw roots, missing verification, stale pins and incomplete cleanup", () => {
  assertCustody(valid, required);
  for (const key of ["encrypted", "stored", "wrapped", "plainRoot", "revisionMatches", "pinMatches", "cleanupComplete"]) {
    assert.throws(() => assertCustody({ ...valid, [key]: !valid[key] }, required), /custody/, key);
  }
  assertCustody({ ...valid, plain: true, outerEncrypted: false }, required);
});

test("custody independently decrypts wrapped native bytes and binds metadata, revision, authority and owned cleanup", async () => {
  const { createRequire } = await import("node:module");
  const oldRequire = globalThis.require; globalThis.require = createRequire(import.meta.url);
  const r = custodyFixture(); globalThis.app = r.app;
  try {
    await assert.doesNotReject(() => secretFacts(true, "darwin"), "valid native packet must decrypt on the actual receiver");
    r.calls.length = 0;
    assert.deepEqual(await secretFacts(true, "darwin"), valid);
    assert.deepEqual(r.calls, ["get", "decrypt", "get", "get", "get"]);
    assert.equal(JSON.stringify(await secretFacts(true, "darwin")).includes("NEVER_RETURN_THE_SYNTHETIC_SECRET"), false);
    r.app.loadLocalStorage = () => JSON.stringify({ [r.ref]: r.packet });
    r.app.secretStorage.isEncryptionAvailable = () => false;
    const wrappedOuterFallback = await secretFacts(true, "darwin");
    assert.equal(wrappedOuterFallback.plain, true); assert.equal(wrappedOuterFallback.outerEncrypted, false);
    assertCustody(wrappedOuterFallback, required); // Outer plaintext contains only inner native ciphertext.
    r.app.loadLocalStorage = () => JSON.stringify({ [r.ref]: JSON.stringify(r.envelope) });
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/, "plaintext outer owned entry cannot pass");
    r.app.loadLocalStorage = () => "opaque-outer-ciphertext";
    for (const [holder, key, value, field] of [
      [r.metadata, "credentialRevision", 6, "revisionMatches"], [r.metadata, "credentialRevision", 0, "revisionMatches"],
      [r.metadata, "serverUrl", "https://wrong.invalid", "revisionMatches"], [r.metadata, "deviceId", "ab".repeat(16), "revisionMatches"],
      [r.envelope, "installationId", "cd".repeat(16), "revisionMatches"], [r.envelope, "version", 1, "revisionMatches"],
      [r.state.data, "vrk", "ef".repeat(32), "pinMatches"], [r.state.data, "deviceSecret", "ef".repeat(32), "pinMatches"],
      [r.state.data, "deviceId", "ef".repeat(16), "pinMatches"], [r.state.data, "serverUrl", "https://wrong.invalid", "pinMatches"],
      [r.state.data, "edgeHeaders", [], "pinMatches"], [r.metadata.sealPin, "suite", 1, "pinMatches"],
      [r.envelope.custody, "suite", 1, "pinMatches"], [r.envelope.custody, "enrollment", {}, "pinMatches"],
      [r.envelope.custody, "rotation", {}, "pinMatches"],
      [r.metadata.sealPin, "generation", "ef".repeat(16), "pinMatches"], [r.metadata.sealPin, "phase", "draft", "pinMatches"],
      [r.state, "paired", false, "pinMatches"], [r.metadata, "credentialCleanupPending", true, "cleanupComplete"],
    ]) {
      const before = holder[key]; holder[key] = value;
      assert.equal((await secretFacts(true, "darwin"))[field], false, `native custody must reject ${key} disagreement`);
      holder[key] = before;
    }
    for (const revision of [0, -1, 0.5, "7"]) {
      r.metadata.credentialRevision = r.envelope.current.revision = revision;
      assert.equal((await secretFacts(true, "darwin")).revisionMatches, false, "native revision must be a positive safe integer");
    }
    r.metadata.credentialRevision = r.envelope.current.revision = 7;
    const generation = r.metadata.sealPin.generation;
    r.metadata.sealPin.generation = r.envelope.custody.generation = "invalid";
    assert.equal((await secretFacts(true, "darwin")).pinMatches, false, "native generation must be exactly 16 bytes of lowercase hex");
    r.metadata.sealPin.generation = r.envelope.custody.generation = generation;
    const root = r.envelope.current.vrk, device = r.envelope.current.deviceId, secret = r.envelope.current.deviceSecret;
    for (const key of ["vrk", "deviceId", "deviceSecret"]) {
      r.envelope.current[key] = r.state.data[key] = "invalid";
      if (key === "deviceId") r.metadata.deviceId = "invalid";
      assert.equal((await secretFacts(true, "darwin")).pinMatches, false, `native ${key} must have its exact lowercase hex width`);
      r.envelope.current.vrk = r.state.data.vrk = root;
      r.envelope.current.deviceId = r.state.data.deviceId = r.metadata.deviceId = device;
      r.envelope.current.deviceSecret = r.state.data.deviceSecret = secret;
    }
    const accepted = r.state.custody2;
    r.state.custody2 = () => ({ ...structuredClone(r.envelope.custody), initializeMap: true });
    assert.equal((await secretFacts(true, "darwin")).pinMatches, false, "whole acknowledged custody must match native plaintext");
    r.state.custody2 = accepted;
    const oldRef = r.ref.replace(/-os$/, "");
    for (const ref of [oldRef, oldRef + "-claim"]) {
      r.entries.set(ref, "NEVER_RETURN_THE_SYNTHETIC_SECRET");
      const facts = await secretFacts(true, "darwin");
      assert.equal(facts.cleanupComplete, false); assert.equal(facts.plainRoot, true);
      assert.throws(() => assertCustody(facts, required), /custody/);
      r.entries.delete(ref);
    }
    for (const secret of [null, JSON.stringify(r.envelope), "NEVER_RETURN_THE_SYNTHETIC_SECRET", "obsync-native-custody-v1:",
      "obsync-native-custody-v1:AB==", "obsync-native-custody-v1:AQID\n", "A".repeat("obsync-native-custody-v1:".length) + "AQID"]) {
      r.entries.set(r.ref, secret);
      await assert.rejects(() => secretFacts(true, "darwin"), error => error.message === "native credential envelope could not be verified" &&
        !Object.hasOwn(error, "cause"), "malformed stored text gets a fixed value-free failure");
    }
    r.entries.set(r.ref, r.packet);
    for (const key of ["credentialFormat", "credentialEnvelopeVersion", "storageVersion", "installationId", "credentialRef"]) {
      const before = r.metadata[key]; r.metadata[key] = "NEVER_RETURN_THE_SYNTHETIC_SECRET";
      r.calls.length = 0;
      await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/);
      assert.deepEqual(r.calls, [], "invalid metadata never selects a native credential reference");
      r.metadata[key] = before;
    }
    const installation = r.metadata.installationId;
    r.metadata.installationId = r.envelope.installationId = "invalid";
    r.metadata.credentialRef = "obsync-private-sync-v1-invalid-os";
    r.entries.set(r.metadata.credentialRef, r.packet); r.calls.length = 0;
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/);
    assert.deepEqual(r.calls, [], "malformed installation cannot select even a coherent supplied native reference");
    r.metadata.installationId = r.envelope.installationId = installation; r.metadata.credentialRef = r.ref;
    r.safe.decryptString = () => { throw Error("NEVER_RETURN_THE_SYNTHETIC_SECRET"); };
    await assert.rejects(() => secretFacts(true, "darwin"), error => error.message === "native credential envelope could not be verified" && !Object.hasOwn(error, "cause"));
  } finally { delete globalThis.app; if (oldRequire === undefined) delete globalThis.require; else globalThis.require = oldRequire; }
});

test("native evidence bounds before decoding, native decrypt and JSON parsing, retaining canonical packets", async () => {
  const { createRequire } = await import("node:module"), requireBuffer = createRequire(import.meta.url);
  const oldRequire = globalThis.require, r = custodyFixture(); globalThis.app = r.app;
  let decodes = 0, decrypts = 0;
  globalThis.require = name => { assert.equal(name, "buffer"); return { Buffer: { from(...args) {
    decodes++; return requireBuffer("buffer").Buffer.from(...args);
  } } }; };
  r.safe.decryptString = () => { decrypts++; return JSON.stringify(r.envelope); };
  try {
    r.entries.set(r.ref, "obsync-native-custody-v1:");
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/);
    assert.equal(decodes, 0, "empty packet refuses before decoder allocation");
    r.entries.set(r.ref, "obsync-native-custody-v1:" + "A".repeat((16 << 20) * 2 + 4));
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/);
    assert.equal(decodes, 0, "encoded budget refuses before decoder allocation");
    r.entries.set(r.ref, "obsync-native-custody-v1:" + Buffer.alloc((16 << 20) + 1).toString("base64"));
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/, "decoded budget refuses a canonical oversized packet");
    assert.equal(decrypts, 0, "decoded budget refuses before native decrypt");
    r.entries.set(r.ref, r.packet);
    r.safe.decryptString = () => new String(JSON.stringify(r.envelope));
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/, "native plaintext must be an actual string");
    r.safe.decryptString = () => JSON.stringify({ ...r.envelope, padding: "A".repeat(16 << 20) });
    await assert.rejects(() => secretFacts(true, "darwin"), /could not be verified/, "plaintext budget refuses otherwise valid JSON");
  } finally { delete globalThis.app; if (oldRequire === undefined) delete globalThis.require; else globalThis.require = oldRequire; }
});

test("native custody backend observation is Linux-only and unsupported caller platforms fail before credential access", async () => {
  const { createRequire } = await import("node:module"); const oldRequire = globalThis.require;
  globalThis.require = createRequire(import.meta.url);
  const r = custodyFixture(); globalThis.app = r.app;
  let positiveBackendReads = 0;
  Object.defineProperty(r.safe, "getSelectedStorageBackend", { configurable: true, get() {
    positiveBackendReads++; throw Error("Linux-only API");
  } });
  try {
    for (const platform of ["darwin", "win32"]) {
      await assert.doesNotReject(() => secretFacts(true, platform), "non-Linux native evidence must never use Linux backend API");
      assertCustody(await secretFacts(true, platform), required);
      assert.equal(positiveBackendReads, 0, "non-Linux positive evidence must not even read the Linux backend API");
    }
    r.calls.length = 0;
    for (const platform of [undefined, "unknown", "NEVER_RETURN_THE_SYNTHETIC_SECRET"]) {
      await assert.rejects(() => secretFacts(true, platform), error => error.message === "native custody evidence requires a declared desktop platform");
      assert.deepEqual(r.calls, [], "unsupported native platform cannot select credentials");
    }
    Object.defineProperty(r.safe, "getSelectedStorageBackend", { configurable: true, value: () => "gnome_libsecret" });
    assertCustody(await secretFacts(true, "linux"), { ...required, backend: "gnome_libsecret" });
  } finally { delete globalThis.app; if (oldRequire === undefined) delete globalThis.require; else globalThis.require = oldRequire; }
  for (const platform of ["darwin", "win32"]) {
    const n = refusalRenderer(), page = await probePage(n); n.safe.isEncryptionAvailable = () => true;
    let backendReads = 0;
    Object.defineProperty(n.safe, "getSelectedStorageBackend", { get() { backendReads++; throw Error("Linux-only API"); } });
    try {
      await assert.doesNotReject(page.run(installCustodyRefusalProbe, "http://127.0.0.1:1", true, platform),
        "non-Linux injected observer must not whitelist a Linux backend");
      assert.equal(backendReads, 0, "non-Linux observer must not even read the Linux backend API");
      assert.equal(n.safe.isEncryptionAvailable(), false);
    } finally { if (n.window.obsyncCustodyRefusal) await page.run(() => window.obsyncCustodyRefusal.restore()); }
  }
  for (const platform of [undefined, "unknown"]) {
    const n = refusalRenderer(), page = await probePage(n);
    await assert.rejects(page.run(installCustodyRefusalProbe, "http://127.0.0.1:1", false, platform),
      error => error.message === "native custody observer installation refused: platform",
      "observer admission requires a declared actual native platform");
    assert.equal(n.window.obsyncCustodyRefusal, undefined);
  }
  {
    const n = refusalRenderer(), page = await probePage(n);
    await assert.rejects(page.run(installCustodyRefusalProbe, "http://127.0.0.1:1", true, "darwin"),
      error => error.message === "native custody observer installation refused: availability",
      "injected unavailable control requires actual availability before injection");
    assert.equal(n.window.obsyncCustodyRefusal, undefined);
  }
  for (const flag of [null, undefined, 0, "false", {}]) {
    const n = refusalRenderer(), page = await probePage(n); n.safe.isEncryptionAvailable = () => flag;
    await assert.rejects(page.run(installCustodyRefusalProbe, "http://127.0.0.1:1", false, "darwin"),
      error => error.message === "native custody observer installation refused: availability",
      "native availability must be an actual boolean before observer admission");
    assert.equal(n.window.obsyncCustodyRefusal, undefined);
  }
  for (const backend of ["basic_text", "unknown", undefined, "NEVER_RETURN_THE_SYNTHETIC_SECRET"]) {
    const n = refusalRenderer(), page = await probePage(n); n.safe.isEncryptionAvailable = () => true;
    n.safe.getSelectedStorageBackend = () => backend;
    await assert.rejects(page.run(installCustodyRefusalProbe, "http://127.0.0.1:1", true, "linux"),
      error => error.message === "native custody observer installation refused: availability",
      "Linux injected positive control requires an actually protected backend");
    assert.equal(n.window.obsyncCustodyRefusal, undefined);
  }
});

test("early availability returns reduced facts without reading plugin metadata or credentials", async () => {
  let available = false;
  globalThis.app = {
    loadLocalStorage: () => '{"synthetic":"NEVER_RETURN_THE_SYNTHETIC_SECRET"}',
    plugins: { get plugins() { throw new Error("early metadata access forbidden"); } },
    secretStorage: { getSecret() { throw new Error("early credential access forbidden"); },
      isEncryptionAvailable: () => available, adapter: { safeStorage: { isEncryptionAvailable: () => available } } },
  };
  try {
    const found = await secretFacts(false, "linux");
    assert.deepEqual(found, { encrypted: false, outerEncrypted: false, backend: "none reported", stored: true,
      plain: true, wrapped: false, plainRoot: null, revisionMatches: null, pinMatches: null, cleanupComplete: null });
    assert.ok(!JSON.stringify(found).includes("NEVER_RETURN"));
    available = true; assert.equal((await secretFacts(false, "linux")).encrypted, true);
    app.secretStorage.adapter.safeStorage.getSelectedStorageBackend = () => "NEVER_RETURN_THE_SYNTHETIC_SECRET";
    assert.equal((await secretFacts(false, "linux")).backend, "unrecognized");
    app.secretStorage.adapter.safeStorage.isEncryptionAvailable = () => ({ value: "NEVER_RETURN_THE_SYNTHETIC_SECRET" });
    assert.equal((await secretFacts(false, "linux")).encrypted, null);
    assert.ok(!JSON.stringify(await secretFacts(false, "linux")).includes("NEVER_RETURN"));
  } finally { delete globalThis.app; }
});

function refusalRenderer() {
  let blob = null, refusal = false, backup = false;
  const actual = { set: 0, save: 0 }, safe = { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => "basic_text",
    encryptString() { assert.fail("negative probe must not encrypt root material"); }, decryptString() { assert.fail("negative probe must not decrypt credentials"); } };
  class Plugin {
    constructor() { this.manifest = { id: "obsync-private-sync", dir: ".obsidian/plugins/obsync-private-sync" }; }
    saveData(data) { return app.vault.writePluginData(this.manifest.dir, data, { mtime: 1 }); }
  }
  const app = { vault: { configDir: ".obsidian", writePluginData() {
    assert.equal(this, app.vault, "native metadata receiver is retained");
    actual.save++; throw Error("synthetic failed save");
  } }, workspace: { layoutReady: true }, plugins: { plugins: {} }, loadLocalStorage: () => blob,
    secretStorage: { adapter: { safeStorage: safe }, getSecret() { return null; }, setSecret() { actual.set++; throw Error("synthetic failed set"); } } };
  const window = { app, fetch: globalThis.fetch };
  const document = { querySelectorAll: selector => selector === "button" ? [{ textContent: "Trust" }]
    : selector === ".notice" ? refusal ? [{ textContent: "obsync: cannot use operating-system encryption for this vault's sync credentials. Sync is stopped before enrollment or credential storage." }] : []
    : selector === ".modal pre" && backup ? [{ textContent: "obsync-recovery-v2 synthetic" }] : [] };
  return { app, window, document, safe, Plugin, actual, setBlob: value => { blob = value; },
    refuse: value => { refusal = value; }, backup: value => { backup = value; } };
}

async function probePage(r) {
  const vm = await import("node:vm");
  const context = vm.createContext({ app: r.app, window: r.window, document: r.document, URL, AbortSignal,
    fetch: (...args) => r.window.fetch(...args), require: () => { throw Error("MODULE_NOT_FOUND"); } });
  return { run: async (fn, ...args) => {
    context.args = args; return vm.runInContext(`(${fn})(...args)`, context);
  } };
}

test("preactivation custody observer counts actual public boundaries and restores native methods, including declared unavailable injection", async () => {
  const r = refusalRenderer(), page = await probePage(r), origin = "http://127.0.0.1:1";
  const before = { set: r.app.secretStorage.setSecret, save: r.app.vault.writePluginData, fetch: r.window.fetch };
  try {
    await page.run(installCustodyRefusalProbe, origin, false, "linux");
    try { r.app.secretStorage.setSecret("synthetic", "NEVER_RETURN_THE_SYNTHETIC_SECRET"); } catch {}
    try { new r.Plugin().saveData({ synthetic: true }); } catch {}
    try { r.app.vault.writePluginData(".obsidian/plugins/synthetic-other", { synthetic: true }); } catch {}
    await r.window.fetch(origin + "/v1/setup").catch(() => {});
    const facts = await page.run(custodyRefusalFacts);
    assert.equal(facts.publicWrites, 1, "public-write observer counts BEFORE rejected native write");
    assert.equal(facts.metadataWrites, 1, "metadata observer counts BEFORE rejected native save");
    assert.equal(facts.transportRequests, 1, "source-origin request attempt is counted even when connection fails");
    assert.equal(r.actual.set, 1); assert.equal(r.actual.save, 2, "unrelated plugin save delegates but is not counted");
    assert.ok(!JSON.stringify(facts).includes("NEVER_RETURN"));
    await page.run(() => window.obsyncCustodyRefusal.restore());
    assert.equal(r.app.secretStorage.setSecret, before.set); assert.equal(r.app.vault.writePluginData, before.save);
    for (const wrong of ["config", "method"]) {
      if (wrong === "config") r.app.vault.configDir = ".synthetic-other";
      else r.app.vault.writePluginData = undefined;
      await assert.rejects(page.run(installCustodyRefusalProbe, origin, false, "linux"),
        error => error.message === "native custody observer installation refused: interface",
        "metadata observation must require the exact owned directory and native dispatch");
      assert.equal(r.window.obsyncCustodyRefusal, undefined);
      assert.equal(r.app.secretStorage.setSecret, before.set);
      r.app.vault.configDir = ".obsidian"; r.app.vault.writePluginData = before.save;
    }
    for (const boundary of ["public", "metadata", "transport"]) {
      const f = refusalRenderer(), ownPage = await probePage(f);
      const [owner, key] = boundary === "public" ? [f.app.secretStorage, "setSecret"]
        : boundary === "metadata" ? [f.app.vault, "writePluginData"] : [f.window, "fetch"];
      const restored = [f.app.secretStorage.setSecret, f.app.vault.writePluginData, f.window.fetch];
      const original = owner[key];
      Object.defineProperty(owner, key, { configurable: true, get: () => original, set: () => {} });
      await assert.rejects(ownPage.run(installCustodyRefusalProbe, origin, false, "linux"),
        error => error.message === "native custody observer installation refused: install",
        `${boundary} ignored native setter must refuse observer admission`);
      assert.equal(f.window.obsyncCustodyRefusal, undefined, "failed observer leaves no accepted zero-counter probe");
      assert.deepEqual([f.app.secretStorage.setSecret, f.app.vault.writePluginData, f.window.fetch], restored,
        "failed installation restores all native observer methods");
      assert.equal(owner[key], original, "ignored native setter retains its original method");
    }
    r.app.vault.writePluginData = async function () {
      assert.equal(this, r.app.vault, "asynchronous native metadata receiver is retained");
      throw Error("synthetic asynchronous save failure");
    };
    await page.run(installCustodyRefusalProbe, origin, false, "linux");
    await assert.rejects(new r.Plugin().saveData({ synthetic: true }), /synthetic asynchronous save failure/);
    assert.equal((await page.run(custodyRefusalFacts)).metadataWrites, 1,
      "metadata observer counts BEFORE asynchronously rejected native save");
    await page.run(() => window.obsyncCustodyRefusal.restore());
    r.app.vault.writePluginData = before.save;
    assert.equal(r.window.fetch, before.fetch); assert.equal(r.window.obsyncCustodyRefusal, undefined);
    r.safe.isEncryptionAvailable = () => true;
    const availability = r.safe.isEncryptionAvailable;
    r.safe.getSelectedStorageBackend = () => "gnome_libsecret";
    await page.run(installCustodyRefusalProbe, origin, true, "linux");
    assert.equal(r.safe.isEncryptionAvailable(), false, "explicit injected probe actually reports false");
    assert.equal((await page.run(custodyRefusalFacts)).unavailable, true);
    await page.run(() => window.obsyncCustodyRefusal.restore());
    assert.equal(r.safe.isEncryptionAvailable, availability, "injected native method is exactly restored");
    r.app.plugins.plugins["obsync-private-sync"] = {};
    await assert.rejects(page.run(installCustodyRefusalProbe, origin, false, "linux"), /native custody observer installation refused:/, "no blind plugin startup window");
    delete r.app.plugins.plugins["obsync-private-sync"];
    Object.defineProperty(r.safe, "isEncryptionAvailable", { configurable: false, writable: false, value: availability });
    await assert.rejects(page.run(installCustodyRefusalProbe, origin, true, "linux"), /native custody observer installation refused:/,
      "unsupported injection leaves no partial observer");
    assert.equal(r.app.secretStorage.setSecret, before.set); assert.equal(r.app.vault.writePluginData, before.save);
    assert.equal(r.window.fetch, before.fetch); assert.equal(r.window.obsyncCustodyRefusal, undefined);
    assert.equal(r.safe.isEncryptionAvailable, availability);
  } finally { if (r.window.obsyncCustodyRefusal) await page.run(() => window.obsyncCustodyRefusal.restore()); }
});

test("real loopback custody refusal requires native reachability, zero writes and requests, visible refusal and no adopted root", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  for (const fault of ["", "public", "metadata", "transport", "server", "state", "root", "blob", "disk", "available", "control-status", "control-arrival",  "no-log", "no-visible", "oversize", "cleanup"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-custody-probe-"));
    const plugin = path.join(root, ".obsidian", "plugins", "obsync-private-sync"); fs.mkdirSync(plugin, { recursive: true });
    const r = refusalRenderer(), page = await probePage(r), clicked = [];
    let origin = "", logged = false;
    const metadata = path.join(plugin, "data.json"), originalFetch = r.window.fetch;
    if (fault === "transport") r.window.fetch = (...args) => args[0].endsWith("/v1/setup") ? Promise.reject(Error("synthetic pre-dispatch rejection")) : originalFetch(...args);
    if (fault === "available") { r.safe.isEncryptionAvailable = () => true; r.safe.getSelectedStorageBackend = () => "gnome_libsecret"; }
    const click = () => {};
    const instance = { vault: root, main: async () => ({ run: async (fn, ...args) => {
      if (fn.toString().includes("/__control")) {
        origin = args[0];
        if (fault === "control-arrival") return true;
        if (fault === "control-status") { await page.run(fn, ...args); return false; }
      }
      if (fault === "cleanup" && fn.toString().includes("obsyncCustodyRefusal.restore")) return false;
      return page.run(fn, ...args);
    } }), pluginLog: () => logged ? ["obsync state decision=stopped reason=desktop_custody_unavailable"] : [],
      anywhere: async (fn, label) => {
        if (fn !== click) return page.run(fn, label);
        clicked.push("trust"); logged = fault !== "no-log"; r.refuse(fault !== "no-visible");
        if (fault === "public") try { r.app.secretStorage.setSecret("synthetic", "NEVER_RETURN_THE_SYNTHETIC_SECRET"); } catch {}
        if (fault === "metadata") try { new r.Plugin().saveData({ root: "synthetic" }); } catch {}
        if (fault === "transport") await r.window.fetch(origin + "/v1/setup").catch(() => {});
        if (fault === "server") await globalThis.fetch(origin + "/v1/setup", { method: "POST", body: "synthetic" });
        if (fault === "oversize") await assert.rejects(globalThis.fetch(origin + "/v1/setup", { method: "POST", body: "A".repeat(65537) }), /fetch failed/, "fixture discards and closes oversized bodies");
        if (fault === "state") r.app.plugins.plugins["obsync-private-sync"] = { state: { data: { vrk: null }, custody2: () => null } };
        if (fault === "root") r.backup(true);
        if (fault === "blob") r.setBlob("synthetic-changed");
        if (fault === "disk") fs.writeFileSync(metadata, '{"synthetic":"changed"}');
        return true;
      } };
    try {
      const operation = verifyNativeCustodyRefusal(instance, "Trust", click, async (_, probe) => {
        const value = await probe(); if (!value) throw Error("synthetic refusal not ready"); return value;
      });
      if (fault) await assert.rejects(operation, /side effects|required evidence|control failed|refusal not ready|cleanup refused/, `custody probe refuses ${fault}`);
      else assert.deepEqual(await operation, { refused: true, publicWrites: 0, metadataWrites: 0, transportRequests: 0,
        sourceRequests: 0, enrollments: 0, rootAbsent: true, nativeControl: true, injected: false });
      if (fault === "cleanup") await page.run(() => window.obsyncCustodyRefusal.restore());
      assert.equal(r.window.obsyncCustodyRefusal, undefined, "observer removed after success/failure");
      assert.equal(r.app.secretStorage.setSecret.name, "setSecret", "original actual public method restored");
      if (origin) await assert.rejects(globalThis.fetch(origin + "/__control"), /fetch failed/, "negative fixture listening socket closes");
      if (fault.startsWith("control-")) assert.deepEqual(clicked, [], "missing native reachability cannot activate plugin");
    } finally {
      if (r.window.obsyncCustodyRefusal) await page.run(() => window.obsyncCustodyRefusal.restore());
      fs.rmSync(root, { recursive: true });
    }
  }
});

test("custody native evaluator arms a bounded watchdog and always restores hooks and closes the fixture", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-custody-watchdog-"));
  let unblock, enter; const entered = new Promise(resolve => { enter = resolve; });
  const originalTimer = globalThis.setTimeout; let armed = false;
  const r = refusalRenderer(), realPage = await probePage(r), metadataDir = path.join(root, ".obsidian", "plugins", "obsync-private-sync");
  fs.mkdirSync(metadataDir, { recursive: true });
  const instance = { vault: root, main: async () => ({ run(fn, ...args) {
    if (fn.toString().includes("workspace")) { enter(); return new Promise(resolve => { unblock = resolve; }); }
    return realPage.run(fn, ...args);
  } }), anywhere: async () => { r.refuse(true); return true; }, pluginLog: () => ["obsync state decision=stopped reason=desktop_custody_unavailable"] };
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 5000) { armed = true; return originalTimer(callback, 0, ...args); }
    return originalTimer(callback, ms, ...args);
  };
  const observed = verifyNativeCustodyRefusal(instance, "Trust", () => {}, async (_, probe) => probe())
    .then(value => ({ value }), error => ({ error }));
  try {
    const preparation = await Promise.race([entered.then(() => "entered"), observed.then(() => "settled")]);
    assert.equal(preparation, "entered", "watchdog fixture must reach the evaluator before its guard assertions");
    await Promise.resolve();
    assert.equal(armed, true, "native evaluator must arm its 5000ms watchdog");
    assert.match((await observed).error?.message ?? "", /native custody evaluator exceeded 5000ms/,
      "stalled native evaluator must refuse with its bounded failure");
    assert.equal(r.window.obsyncCustodyRefusal, undefined);
  } finally {
    globalThis.setTimeout = originalTimer; unblock?.(true); await observed;
    if (r.window.obsyncCustodyRefusal) await realPage.run(() => window.obsyncCustodyRefusal.restore());
    fs.rmSync(root, { recursive: true });
  }
});


test("actual simultaneous custody accepts only boolean false plus zero effects and independently observed native controls", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  for (const fault of ["", "both-true", "both-false", "wrong-platform", "unknown", "unknown-after-install", "throw", "missing-get", "control-status", "control-arrival", "install-return", "public", "metadata", "transport", "server", "state", "root", "blob", "disk", "no-log", "no-visible", "notice-hidden", "oversize", "occupied", "public-readback", "metadata-readback", "control-source", "public-counter", "metadata-counter", "transport-counter", "control-server", "public-cleanup", "selective-clear", "cleanup-public-counter", "cleanup-metadata-counter", "cleanup-transport", "cleanup-server", "metadata-cleanup", "metadata-origin", "cleanup", "exception-cleanup", "late-install"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-concurrent-custody-"));
    const peers = [], trusted = [], events = []; let origin = "";
    try {
      for (const name of ["a", "b"]) {
        const vault = path.join(root, name), directory = path.join(vault, ".obsidian", "plugins", "obsync-private-sync");
        fs.mkdirSync(directory, { recursive: true });
        const r = refusalRenderer(), page = await probePage(r), entries = new Map();
        const sourceFetch = r.window.fetch;
        r.window.fetch = (...args) => sourceFetch(...args).then(response => {
          if (response.headers.get("access-control-allow-origin") !== "*") throw Error("synthetic native CORS refused");
          return response;
        });
        if (name === "b" && ["transport", "cleanup-transport"].includes(fault)) r.window.fetch = (...args) =>
          args[0].endsWith(fault === "transport" ? "/v1/setup" : "/synthetic-cleanup")
            ? Promise.reject(Error("synthetic pre-dispatch refusal")) : sourceFetch(...args);
        const available = fault === "both-true" ? true : fault === "both-false" ? false : name === "a";
        r.safe.isEncryptionAvailable = () => name === "b" && fault === "unknown" ? "false" : available;
        if (name === "b" && fault === "throw") r.safe.isEncryptionAvailable = () => { throw Error("synthetic native error"); };
        const ref = "obsync-private-sync-v1-" + "0".repeat(32) + "-os";
        r.app.secretStorage.getSecret = key => entries.get(key) ?? null;
        let clears = 0;
        r.app.secretStorage.setSecret = function (key, value) {
          assert.equal(this, r.app.secretStorage, "actual public control retains receiver");
          if (value === "") {
            clears++;
            if (!(name === "b" && (["public-cleanup", "exception-cleanup"].includes(fault) || (fault === "selective-clear" && clears === 1)))) entries.delete(key);
          }
          else if (!(name === "b" && fault === "public-readback")) entries.set(key, value);
        };
        if (name === "b" && fault === "missing-get") delete r.app.secretStorage.getSecret;
        r.app.vault.writePluginData = async function (dir, data) {
          assert.equal(this, r.app.vault, "actual metadata control retains receiver");
          assert.equal(dir, ".obsidian/plugins/obsync-private-sync");
          if (name === "b" && ["metadata-readback", "exception-cleanup"].includes(fault) && data.obsyncNativeCounterControl) return;
          if (name === "b" && fault === "metadata-cleanup" && !data.obsyncNativeCounterControl) return;
          if (name === "b" && fault === "metadata-origin" && !data.obsyncNativeCounterControl) data = { serverUrl: "https://synthetic.invalid" };
          fs.writeFileSync(path.join(directory, "data.json"), name === "b" && fault === "metadata" ? JSON.stringify(data) : JSON.stringify(data, null, 2));
          if (name === "b" && !data.obsyncNativeCounterControl && fault === "cleanup-transport") await r.window.fetch(origin + "/synthetic-cleanup").catch(() => {});
          if (name === "b" && !data.obsyncNativeCounterControl && fault === "cleanup-server") await globalThis.fetch(origin + "/synthetic-cleanup");
        };
        let factReads = 0;
        const instance = { name, vault, main: async () => ({ run: async (fn, ...args) => {
          if (fn === custodyRefusalFacts && name === "b" && fault === "notice-hidden" && ++factReads === 2) r.refuse(false);
          if (fn.toString().includes("/__control")) {
            origin = args[0];
            if (name === "b" && fault === "control-arrival") return true;
            if (name === "b" && fault === "control-status") { await page.run(fn, ...args); return false; }
          }
          if (name === "b" && fault === "unknown-after-install" && fn.toString().includes("=> window.obsyncCustodyRefusal.available")) return undefined;
          if (fn === installCustodyRefusalProbe) events.push("install-" + name);
          const result = await page.run(fn, ...args);
          if (fn === installCustodyRefusalProbe && name === "b" && fault === "install-return") return undefined;
          if (fn === installCustodyRefusalProbe && name === "b" && fault === "late-install") {
            r.app.plugins.plugins["obsync-private-sync"] = { state: { data: { vrk: "synthetic" }, custody2: () => ({}) } };
          }
          if (fn.toString().includes("__observer-control") && name === "b") {
            if (fault === "control-source") return false;
            if (fault === "public-counter") r.window.obsyncCustodyRefusal.seen.publicWrites = 0;
            if (fault === "metadata-counter") r.window.obsyncCustodyRefusal.seen.metadataWrites = 0;
            if (fault === "transport-counter") r.window.obsyncCustodyRefusal.seen.transportRequests = 0;
            if (fault === "control-server") await globalThis.fetch(origin + "/synthetic-extra");
          }
          if (fn.toString().includes("native public control cleanup refused") && name === "b") {
            if (fault === "cleanup-public-counter") r.window.obsyncCustodyRefusal.seen.publicWrites = 1;
            if (fault === "cleanup-metadata-counter") r.window.obsyncCustodyRefusal.seen.metadataWrites = 1;
          }
          if (fn.toString().includes("const restored = window.obsyncCustodyRefusal.restore") && name === "b" && fault === "cleanup") return false;
          return result;
        } }), pluginLog: () => name === "b" && fault === "no-log" ? [] : ["obsync state decision=stopped reason=desktop_custody_unavailable"],
          anywhere: async (fn, label) => {
            if (fn !== click) return page.run(fn, label);
            events.push("trust-" + name); trusted.push(name); r.refuse(!(name === "b" && fault === "no-visible"));
            if (name === "b") {
              if (fault === "public") r.app.secretStorage.setSecret("synthetic", "fixed-nonsecret");
              if (fault === "metadata") await r.app.vault.writePluginData(".obsidian/plugins/obsync-private-sync", { serverUrl: origin });
              if (fault === "transport") await r.window.fetch(origin + "/v1/setup").catch(() => {});
              if (fault === "server") await globalThis.fetch(origin + "/v1/setup");
              if (fault === "oversize") await assert.rejects(globalThis.fetch(origin + "/v1/setup", { method: "POST", body: "A".repeat(65537) }),
                /fetch failed/, "concurrent source body must be bounded before receipt");
              if (fault === "state") r.app.plugins.plugins["obsync-private-sync"] = { state: { data: { vrk: null }, custody2: () => null } };
              if (fault === "root") r.backup(true);
              if (fault === "blob") r.setBlob("synthetic-change");
              if (fault === "disk") fs.writeFileSync(path.join(directory, "data.json"), '{"synthetic":true}');
              if (fault === "occupied") entries.set(ref, "fixed-nonsecret-occupied");
            }
            return true;
          } };
        peers.push({ instance, r, entries });
      }
      const operation = verifyConcurrentNativeCustody(peers[0].instance, peers[1].instance, "Trust", click,
        async (_, probe) => { if (!await probe()) throw Error("synthetic concurrent wait refused"); }, fault === "wrong-platform" ? "linux" : "darwin");
      if (!["", "both-true", "both-false"].includes(fault)) {
        let expected = /refused|failed|occupied|boolean availability/;
        if (["public", "metadata", "transport", "server", "state", "root", "blob", "disk", "notice-hidden", "oversize", "late-install"].includes(fault))
          expected = error => error.message === "concurrent custody pre-control refusal evidence failed";
        if (fault === "exception-cleanup") expected = error => error.message === "concurrent custody observer restoration refused";
        if (fault === "wrong-platform") expected = error => error.message === "concurrent custody requires actual macOS";
        if (["public-counter", "metadata-counter", "transport-counter", "control-source", "control-server"].includes(fault))
          expected = error => error.message === "native observer positive control counts refused";
        if (fault === "public-readback") expected = error => error.message === "native public-write control refused";
        if (fault === "metadata-readback") expected = error => error.message === "native metadata control readback refused";
        if (fault === "occupied") expected = error => error.message === "owned control reference occupied";
        if (fault === "missing-get") expected = error => error.message === "native custody observer installation refused: interface";
        if (["unknown", "throw"].includes(fault)) expected = error => error.message === "native custody observer installation refused: availability";
        if (fault === "unknown-after-install") expected = error => error.message === "concurrent custody requires actual boolean availability";
        if (fault === "install-return") expected = error => error.message === "concurrent custody observer not installed";
        await assert.rejects(operation, expected, "actual concurrent custody must reject " + fault);
      } else {
        await assert.doesNotReject(operation, "honest concurrent native outcome must pass its exact branch");
        const result = await operation;
        if (fault === "both-true") {
          assert.equal(result.refused, false, "both available peers must return to the full positive journey"); assert.deepEqual(result.availability, [true, true]);
          assert.deepEqual(trusted, [], "available peers remain untouched for the original full positive journey");
        } else {
          assert.equal(result.refused, true, "actual false must enter the independently verified refusal branch"); assert.equal(result.source, "synthetic-http");
          assert.deepEqual(result.availability, fault === "both-false" ? [false, false] : [true, false]);
          assert.equal(result.sourceRequestsBeforeControls, 0); assert.equal(result.sourceRequestsAfterControls, 2);
          assert.equal(result.preControl.length, 2);
          assert.ok(result.preControl.every(p => p.publicWrites === 0 && p.metadataWrites === 0 && p.transportRequests === 0 && p.rootAbsent && p.stateAbsent && p.blobUnchanged && p.metadataUnchanged));
          assert.deepEqual(result.controls, { publicWritesPerPeer: 1, metadataWritesPerPeer: 1, sourceRequestsPerPeer: 1,
            cleanupPublicWritesPerPeer: 1, cleanupMetadataWritesPerPeer: 1 });
          assert.deepEqual(trusted, fault === "both-false" ? ["a", "b"] : ["b"], "available peers cannot be activated on refusal branch");
          assert.ok(events.indexOf("install-b") < events.indexOf("trust-" + trusted[0]), "both real observers precede first activation");
          assert.ok(!JSON.stringify(result).includes("obsync-native-counter-control"), "control values stay inside their owned fixture");
        }
      }
      for (const p of peers) {
        assert.equal(p.r.window.obsyncCustodyRefusal, undefined, "both observers restore on acceptance and refusal");
        assert.equal(p.entries.has("obsync-private-sync-v1-" + "0".repeat(32) + "-os"),
          p.instance.name === "b" && ["occupied", "public-cleanup", "exception-cleanup"].includes(fault),
          "owned control is removed on failure; foreign occupation and refused cleanup are preserved");
        assert.equal(fs.existsSync(path.join(p.instance.vault, ".obsidian/plugins/obsync-private-sync/data.json")), false, "original absent metadata is restored");
      }
      if (origin) await assert.rejects(globalThis.fetch(origin + "/__control"), /fetch failed/, "concurrent synthetic source closes on every outcome");
    } finally {
      for (const p of peers) if (p.r.window.obsyncCustodyRefusal) p.r.window.obsyncCustodyRefusal.restore();
      fs.rmSync(root, { recursive: true });
    }
  }
  for (const platform of [undefined, "unknown", "linux", "win32"]) {
    await assert.rejects(() => verifyConcurrentNativeCustody(null, null, "Trust", click, null, platform),
      error => error.message === "concurrent custody requires actual macOS", "wrong native platform cannot select simultaneous refusal");
  }
  function click() {}
});

test("both custody helpers preserve bind errors without waiting for close on an unbound listener", async () => {
  const { default: http } = await import("node:http"), { EventEmitter } = await import("node:events");
  const create = http.createServer, error = Object.assign(Error("synthetic listener bind failure"), { code: "EPERM" });
  let closes = 0;
  http.createServer = () => {
    const server = new EventEmitter(); server.listening = false;
    server.listen = () => { queueMicrotask(() => server.emit("error", error)); return server; };
    server.close = () => { closes++; return server; }; // Deliberately never calls back when unbound.
    return server;
  };
  try {
    for (const helper of [
      () => verifyNativeCustodyRefusal({ vault: "/unused-synthetic" }, "Trust", null, null),
      () => verifyConcurrentNativeCustody(null, null, "Trust", null, null, "darwin"),
    ]) {
      let timer;
      try {
        const outcome = await Promise.race([helper().then(() => ({ passed: true }), error => ({ error })),
          new Promise(resolve => { timer = setTimeout(() => resolve({ hung: true }), 50); })]);
        assert.equal(outcome.error, error, "original listener bind error must survive bounded cleanup");
        assert.equal(closes, 0, "unbound listener cleanup must never wait on close");
      } finally { clearTimeout(timer); }
    }
  } finally { http.createServer = create; }
});

test("concurrent custody evaluator has a bounded watchdog and restores partial preparation", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-concurrent-watchdog-"));
  const r = refusalRenderer(), page = await probePage(r), originalTimer = globalThis.setTimeout;
  let unblock, enter, armed = false, blocked = false; const entered = new Promise(resolve => { enter = resolve; });
  try {
    const directory = path.join(root, ".obsidian/plugins/obsync-private-sync"); fs.mkdirSync(directory, { recursive: true });
    const instance = { vault: root, main: async () => ({ run(fn, ...args) {
      if (fn.toString().includes("workspace") && !blocked) { blocked = true; enter(); return new Promise(resolve => { unblock = resolve; }); }
      return page.run(fn, ...args);
    } }), anywhere: async (fn, ...args) => page.run(fn, ...args), pluginLog: () => [] };
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 5000) { armed = true; return originalTimer(callback, 0, ...args); }
      return originalTimer(callback, ms, ...args);
    };
    const observed = verifyConcurrentNativeCustody(instance, instance, "Trust", () => {}, async (_, probe) => probe(), "darwin")
      .then(value => ({ value }), error => ({ error }));
    try {
      const preparation = await Promise.race([entered.then(() => "entered"), observed.then(() => "settled")]);
      assert.equal(preparation, "entered", "watchdog fixture must reach the evaluator before its guard assertions");
      await Promise.resolve();
      assert.equal(armed, true, "concurrent native evaluator must arm its 5000ms watchdog");
      assert.match((await observed).error?.message ?? "", /concurrent custody evaluator exceeded 5000ms/,
        "stalled concurrent evaluator must refuse with its bounded failure");
    } finally { globalThis.setTimeout = originalTimer; unblock?.(true); await observed; }
    assert.equal(r.window.obsyncCustodyRefusal, undefined);
    assert.equal(fs.existsSync(path.join(directory, "data.json")), false, "partial metadata preparation is restored");
  } finally { globalThis.setTimeout = originalTimer; fs.rmSync(root, { recursive: true }); }
});

test("workspace readiness does not initialize native secret storage before product setup", async () => {
  const fs = await import("node:fs"), vm = await import("node:vm");
  const source = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const ready = source.slice(source.indexOf("async function openVault("), source.indexOf("\nasync function setServer("));
  const events = [], pluginState = () => {}, marker = () => {};
  const context = { secretFacts: marker, pluginState, PLUGIN_ID: "test", LABELS: { trust: "trust" }, click() {},
    diagnose() { assert.fail("no diagnostic native initialization before enrollment"); },
    until: async (_, probe) => probe(),
  };
  const app = { workspace: { layoutReady: true }, get secretStorage() { assert.fail("native storage initialization before product setup"); } };
  const renderer = { app, window: { app, get electron() { assert.fail("native storage bridge before product setup"); } },
    navigator: { userAgent: "obsidian/1.13.7 Electron/43.3.0" } };
  const main = { run: async (fn) => {
    assert.notEqual(fn, marker, "no native availability read before product setup");
    if (fn === pluginState) { events.push("plugin"); return true; }
    if (fn.toString().includes("navigator.userAgent")) events.push("agent");
    else events.push("workspace");
    return vm.runInNewContext(`(${fn})()`, renderer);
  } };
  const instance = { name: "a", main: async () => main, anywhere: async () => { events.push("trust"); return true; } };
  const program = vm.runInNewContext(`(${ready})`, context);
  await program(instance, true); // An obsolete caller cannot re-enable the initializing observation.
  assert.deepEqual(events, ["workspace", "trust", "plugin", "agent"]);
  events.length = 0;
  await program(instance);
  assert.deepEqual(events, ["workspace", "trust", "plugin", "agent"]);
});

test("captures refuse dialogs, notices, wrong editors, hidden and out-of-viewport content", () => {
  let footer = "1 words9 characters";
  let blockers = [], rect = { x: 20, y: 40, width: 800, height: 500, right: 820, bottom: 540 };
  const editor = { getBoundingClientRect: () => rect };
  const view = { file: { path: "e2e/test.md" }, editor: { getValue: () => "synthetic" }, containerEl: { querySelector: () => editor } };
  globalThis.app = { workspace: { activeLeaf: { view } } };
  globalThis.document = {
    querySelectorAll: (selector) => {
      assert.equal(selector, ".modal-container, .notice-container .notice"); return blockers;
    },
    querySelector: (selector) => {
      assert.equal(selector, ".status-bar-item.plugin-word-count");
      return footer === null ? null : { textContent: footer };
    },
  };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;
  const bounds = () => editorBounds("e2e/test.md", "synthetic");
  try {
    assert.deepEqual(bounds(), { x: 20, y: 40, width: 800, height: 500, scale: 1 });
    for (const stale of [null, "", "49 words249 characters", "1 words8 characters", "1 words19 characters"]) {
      footer = stale; assert.equal(bounds(), null, "a stale or absent native count cannot pass capture");
    }
    footer = "1 words9 characters";
    assert.ok(bounds(), "the native counter eventually catches up");
    blockers = [editor]; assert.equal(bounds(), null);
    blockers = [{ getBoundingClientRect: () => ({ width: 0, height: 0 }) }]; assert.ok(bounds());
    blockers = [];
    for (const field of ["x", "y", "width", "height", "right", "bottom"]) {
      const original = rect;
      rect = { ...rect, [field]: ["right", "bottom"].includes(field) ? 2000 : field === "width" || field === "height" ? 0 : -1 };
      assert.equal(bounds(), null, field); rect = original;
    }
    view.file.path = "private.md"; assert.equal(bounds(), null); view.file.path = "e2e/test.md";
    view.editor.getValue = () => "unexpected"; assert.equal(bounds(), null); view.editor.getValue = () => "synthetic";
    view.containerEl.querySelector = () => null; assert.equal(bounds(), null);
    app.workspace.activeLeaf = null; assert.equal(bounds(), null);
  } finally {
    for (const key of ["app", "document", "innerWidth", "innerHeight"]) delete globalThis[key];
  }
});

test("disk mismatch cannot capture or publish; a mid-capture change is discarded", async () => {
  const { captureEditor } = await import("./obsidian-evidence.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-capture-test-"));
  const output = path.join(root, "output"); fs.mkdirSync(output);
  const file = path.join(root, "note.md"); fs.writeFileSync(file, "wrong");
  let shots = 0, change = false, move = false, reads = 0;
  const page = { run: async () => ({ x: move && ++reads > 1 ? 1 : 0, y: 0, width: 500, height: 400, scale: 1 }), send: async (method) => {
    if (method === "Page.captureScreenshot") { shots++; if (change) fs.writeFileSync(file, "changed"); return { data: Buffer.from("synthetic-png").toString("base64") }; }
  } };
  const instance = { name: "a", vault: root, main: async () => page };
  const capture = () => captureEditor(instance, "cotype", "note.md", "expected", output, (_, probe) => probe());
  try {
    await assert.rejects(capture, /independent disk/);
    assert.equal(shots, 0); assert.deepEqual(fs.readdirSync(output), []);
    fs.writeFileSync(file, "expected"); change = true;
    await assert.rejects(capture, /changed during capture/);
    assert.equal(shots, 1); assert.deepEqual(fs.readdirSync(output), []);
    fs.writeFileSync(file, "expected"); change = false; move = true;
    await assert.rejects(capture, /changed during capture/);
    assert.deepEqual(fs.readdirSync(output), []); move = false;
    await capture(); assert.deepEqual(fs.readdirSync(output).sort(), ["cotype-a.json", "cotype-a.png"]);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("publication requires all six captures and every restart/custody phase", async () => {
  const { finishEvidence } = await import("./obsidian-evidence.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path"), { createHash } = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-inventory-test-"));
  const custody = { before: true, quit: true, paired: true, transferred: true, after: true };
  const png = Buffer.from("synthetic-png"), hash = createHash("sha256").update(png).digest("hex");
  try {
    for (const name of ["cotype-a", "cotype-b", "restart-a-a", "restart-a-b", "restart-b-a", "restart-b-b"]) {
      fs.writeFileSync(path.join(root, name + ".png"), png);
      fs.writeFileSync(path.join(root, name + ".json"), JSON.stringify({ editorSha256: hash, diskSha256: hash, pngSha256: hash }));
    }
    finishEvidence(root, custody);
    for (const key of Object.keys(custody)) assert.throws(() => finishEvidence(root, { ...custody, [key]: false }), /incomplete/);
    assert.throws(() => finishEvidence(root, null), /incomplete/);
    fs.writeFileSync(path.join(root, "cotype-a.png"), "changed");
    assert.throws(() => finishEvidence(root, custody), /receipt/);
    fs.writeFileSync(path.join(root, "cotype-a.png"), png);
    const receipt = path.join(root, "cotype-a.json");
    fs.writeFileSync(receipt, JSON.stringify({ editorSha256: "wrong", diskSha256: hash, pngSha256: hash }));
    assert.throws(() => finishEvidence(root, custody), /receipt/);
    fs.writeFileSync(receipt, JSON.stringify({ editorSha256: hash, diskSha256: hash, pngSha256: hash }));
    fs.rmSync(path.join(root, "restart-b-b.png"));
    assert.throws(() => finishEvidence(root, custody), /exactly six/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("native backup helper copies exactly one complete prefixed backup and never exports its text", async () => {
  const fs = await import("node:fs"), vm = await import("node:vm");
  const source = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function confirmPhrase("), source.indexOf("\nfunction pairingCode("));
  const backup = "obsync-recovery-v2 " + Array(24).fill("synthetic").join(" ");
  for (const shape of ["valid", "stripped", "short", "duplicate", "wrong-row", "no-input", "duplicate-button"]) {
    let events = 0, clicks = 0;
    const input = { value: "", dispatchEvent(event) { assert.equal(event.type, "input"); events++; } };
    const button = { textContent: "Confirm complete backup", click() { clicks++; assert.equal(input.value, backup); assert.equal(events, 1); } };
    const row = { querySelector(selector) { return selector === "textarea" ? shape === "no-input" ? null : input
      : { textContent: shape === "wrong-row" ? "Unrelated setting" : "Read back your saved backup" }; } };
    const text = shape === "stripped" ? backup.replace("obsync-recovery-v2 ", "") : shape === "short" ? backup.replace(/ synthetic$/, "") : backup;
    const modal = { querySelectorAll(selector) {
      return selector === "pre" ? [{ textContent: text }] : selector === "button" ? (shape === "duplicate-button" ? [button, button] : [button]) : [row];
    } };
    const context = { document: { querySelectorAll: () => shape === "duplicate" ? [modal, modal] : [modal] }, Event: class { constructor(type) { this.type = type; } } };
    const result = vm.runInNewContext(fn + '\nconfirmPhrase("Confirm complete backup")', context);
    assert.equal(result, shape === "valid", shape); assert.equal(clicks, shape === "valid" ? 1 : 0, shape);
    assert.equal(typeof result, "boolean", "backup never crosses the renderer boundary");
  }
});

test("the real driver requires matching prompts before approval and its restart journey before success", async () => {
  // Execute the real orchestration, substituting native boundaries only. The
  // complete inventory gate remains real, so omitting the restart call fails.
  const { finishEvidence } = await import("./obsidian-evidence.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path"), vm = await import("node:vm");
  const { createHash } = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-driver-test-"));
  const source = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main() {"), source.indexOf("\n/**\n * The two Linux cases"));
  const stores = vm.runInNewContext(source.slice(source.indexOf("const STORES = {"), source.indexOf("const UNENCRYPTED")) + "STORES");
  const png = Buffer.from("synthetic-png"), hash = createHash("sha256").update(png).digest("hex");
  const capture = (name) => {
    fs.writeFileSync(path.join(root, name + ".png"), png);
    fs.writeFileSync(path.join(root, name + ".json"), JSON.stringify({ editorSha256: hash, diskSha256: hash, pngSha256: hash }));
  };
  const environment = { OBSYNC_E2E_SECRET_STORE: "windows", OBSYNC_E2E_CAPTURES: root };
  const localProcess = { env: environment, platform: "win32", exitCode: undefined };
  let preflightTouches = 0, approvals = 0, redirects = 0, enrollments = 0;
  let backupAcknowledged = true, backupReads = 0;
  let redirectChecked = false, redirectFails = false;
  let concurrentCalls = 0, concurrentFails = false, concurrentOutcome = { refused: false, availability: [true, true] };
  const launches = [], observed = [];
  const secretFactsMarker = () => {};
  let comparison = { creator: ["123 456"], claimant: ["123 456"] };
  let nextComparison = null;
  const context = {
    process: localProcess, env: (name) => name, STORES: stores, secrets: [], started: Date.now(), proven: 0,
    fs: { readFileSync: () => { preflightTouches++; return "a".repeat(64); }, rmSync() {}, mkdirSync() {}, existsSync: () => true }, path,
    Denied: Error, scrub: String, console: { log() {}, error() {} }, Buffer, randomBytes: () => Buffer.from("test"),
    Instance: class {
      constructor(work, name) { preflightTouches++; this.name = name; this.root = root; this.vault = root; if (name === "a") redirectChecked = false; }
      launch() { launches.push("launch-" + this.name); } stop() {}
      async main() { return this.name; }
      async anywhere(fn, label) { if (fn === context.click && label === "Approve") approvals++; return true; }
      async all(fn) {
        if (fn !== pairingCodes) return [];
        const shown = { creator: this.name === "a" ? comparison.creator : [], claimant: this.name === "b" ? comparison.claimant : [] };
        if (this.name === "b" && nextComparison !== null) { comparison = nextComparison; nextComparison = null; }
        return [shown];
      }
      pluginLog() { return []; }
    },
    openVault: async (instance, ...args) => { launches.push("ready-" + instance.name); assert.equal(args.length, 0, "the actual launch path passes no native initialization flag"); return { obsidian: "test", electron: "test" }; },
    verifyConcurrentNativeCustody: async (_a, _b, _trust, _click, _until, platform) => {
      assert.equal(platform, "darwin", "simultaneous custody receives actual caller platform"); concurrentCalls++;
      if (concurrentFails) throw Error("synthetic concurrent observation refused");
      return concurrentOutcome;
    },
    verifyNativeRedirects: async (page) => {
      assert.equal(page, "a"); redirects++; redirectChecked = true;
      if (redirectFails) throw new Error("synthetic native redirect refusal");
    },
    setServer: async () => { assert.equal(redirectChecked, true, "native redirect check precedes enrollment"); enrollments++; },
    secretFacts: secretFactsMarker, holds: (instance, found, store, when) => {
      assert.equal(when, "after enrollment"); assertCustody(found, stores[store]); observed.push(instance.name + ":enrolled");
    }, diagnose() {},
    until: async (_, probe) => {
      let last;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
      }
      throw last ?? new Error("test wait exhausted");
    }, paired: () => true, inVault: async (_, fn) => {
      if (fn.toString().includes("recoveryPhrase")) { backupReads++; return backupAcknowledged; }
      return fn === secretFactsMarker ? valid : true;
    },
    fillPlaceholder() {}, click() {}, confirmPhrase() {}, pairingCode() {}, fillSetting() {}, describe() {}, notices() {},
    LABELS: { approve: "Approve" }, pairingCodes, assertPairingCodes, PLUGIN_ID: "test", SYNC_BUDGET_MS: 1, prove() {}, arrives: () => 1, leaves() {}, listing: () => [],
    cotyping: async () => { capture("cotype-a"); capture("cotype-b"); }, starvedWatcher() {}, windowsJourneys() {},
    restarted: async (_a, _b, options) => {
      assert.equal(options.launchOrder, environment.OBSYNC_E2E_LAUNCH_ORDER || "simultaneous", "restart receives the same selected launch order");
      for (const name of ["restart-a-a", "restart-a-b", "restart-b-a", "restart-b-b"]) capture(name);
      return { before: true, quit: true, paired: true, transferred: true, after: true };
    }, finishEvidence, untrusted() {},
  };
  try {
    const restarted = context.restarted;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined, "the unmodified driver completes its restart and publication gates");
    assert.equal(approvals, 1, "the matched prompts allow the actual approval path");
    assert.deepEqual(launches, ["launch-a", "launch-b", "ready-a", "ready-b"]);
    assert.deepEqual(observed, ["a:enrolled", "b:enrolled"]);
    assert.equal(redirects, 1, "the real driver must call the native redirect fixture");
    assert.equal(backupReads, 1, "the real driver must read the persisted confirmation after its click");
    backupAcknowledged = false;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "a confirmation click without acknowledged custody must refuse");
    assert.equal(approvals, 1, "unacknowledged backup cannot proceed to pairing");
    backupAcknowledged = true; localProcess.exitCode = undefined;
    const beforeEnrollment = enrollments;
    redirectFails = true;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "redirect refusal must stop the real driver");
    assert.equal(enrollments, beforeEnrollment, "redirect refusal must precede enrollment");
    assert.equal(approvals, 1, "redirect refusal must precede pairing approval");
    redirectFails = false;
    comparison = { creator: ["123 456"], claimant: ["123 457"] };
    nextComparison = { creator: ["123 456"], claimant: ["123 456"] };
    localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(nextComparison, null, "the claimant read returned its initial mismatch before becoming an honest match");
    assert.equal(localProcess.exitCode, 1, "an initial mismatch must refuse, never retry until it matches");
    assert.equal(approvals, 1, "no approval after an initial mismatch");
    for (comparison of [
      { creator: ["123 456"], claimant: ["123 457"] },
      { creator: ["123 456"], claimant: [] },
      { creator: [], claimant: ["123 456"] },
      { creator: ["123 456", "123 456"], claimant: ["123 456"] },
      { creator: ["123 456"], claimant: ["123 456", "123 456"] },
    ]) {
      localProcess.exitCode = undefined;
      await vm.runInNewContext(`(${main})()`, context);
      assert.equal(localProcess.exitCode, 1, "missing, ambiguous or mismatched prompts refuse the actual driver");
      assert.equal(approvals, 1, "no approval click after an invalid comparison");
    }
    comparison = { creator: ["123 456"], claimant: ["123 456"] };
    for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name));
    localProcess.exitCode = undefined;
    context.restarted = async () => null;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "an omitted restart must fail the real driver's success path");
    context.restarted = restarted;
    environment.OBSYNC_E2E_SECRET_STORE = "macos";
    localProcess.platform = "darwin"; localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined, "native macOS runs the same restart and publication gates");
    const previousEnrollments = enrollments, previousApprovals = approvals;
    concurrentOutcome = { refused: true, availability: [true, false], source: "synthetic-http" };
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined, "proved actual false can complete only its distinct refusal journey");
    assert.equal(enrollments, previousEnrollments, "native refusal must precede every root-bearing enrollment action");
    assert.equal(approvals, previousApprovals, "native refusal cannot reach pairing approval");
    concurrentFails = true;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "unknown or malformed native evidence cannot be caught into refusal success");
    assert.equal(enrollments, previousEnrollments, "failed observer cannot reach enrollment");
    concurrentFails = false; concurrentOutcome = { refused: false, availability: [true, true] };
    localProcess.exitCode = undefined;
    for (const platform of ["linux", "win32"]) {
      localProcess.platform = platform;
      await assert.rejects(vm.runInNewContext(`(${main})()`, context), /macOS custody requires native macOS/);
    }
    localProcess.platform = "darwin";
    environment.OBSYNC_E2E_LAUNCH_ORDER = "serialized";
    launches.length = 0; observed.length = 0; localProcess.exitCode = undefined;
    const beforeSerializedCalls = concurrentCalls;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined);
    assert.deepEqual(launches, ["launch-a", "ready-a", "launch-b", "ready-b"]);
    assert.deepEqual(observed, ["a:enrolled", "b:enrolled"]);
    assert.equal(concurrentCalls, beforeSerializedCalls, "serialized custody never selects conditional refusal");
    const ready = context.openVault;
    context.openVault = async () => { throw Error("synthetic native unavailable after positive admission"); };
    concurrentOutcome = { refused: true, availability: [false, false] };
    localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "serialized native unavailable remains a required positive failure");
    context.openVault = ready; concurrentOutcome = { refused: false, availability: [true, true] };
    environment.OBSYNC_E2E_LAUNCH_ORDER = "simultaneous";
    context.openVault = async () => { throw Error("synthetic native available then runtime stopped"); };
    localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "available true then runtime stop cannot become refusal success");
    context.openVault = ready;
    const savedCaptures = environment.OBSYNC_E2E_CAPTURES;
    delete environment.OBSYNC_E2E_CAPTURES; delete environment.OBSYNC_E2E_LAUNCH_ORDER;
    let refusalCalls = 0, failRefusal = false;
    context.verifyNativeCustodyRefusal = async (instance, label, click, until, injected) => {
      refusalCalls++; assert.equal(instance.name, "a"); assert.equal(injected, !!environment.OBSYNC_E2E_CUSTODY_PROBE);
      if (failRefusal) throw Error("synthetic custody side effect");
    };
    const beforeRefusal = { enrollments, approvals, redirects };
    environment.OBSYNC_E2E_SECRET_STORE = "none"; localProcess.platform = "linux";
    launches.length = 0; localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined, "declared Linuxnone refusal completes its dedicated evidence path");
    assert.deepEqual(launches, ["launch-a"], "unavailable case does not quietly run the positive pairing journey");
    assert.equal(refusalCalls, 1, "Linuxnone must execute actual native refusal verification");
    assert.deepEqual({ enrollments, approvals, redirects }, beforeRefusal, "refusal has no enrollment or positive-path requests");
    failRefusal = true; localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "custody side effects must fail actual negative orchestration");
    assert.deepEqual({ enrollments, approvals, redirects }, beforeRefusal);
    failRefusal = false;
    environment.OBSYNC_E2E_SECRET_STORE = "macos"; environment.OBSYNC_E2E_CUSTODY_PROBE = "unavailable";
    localProcess.platform = "darwin"; localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(refusalCalls, 3, "explicit injected control is separate from positive macOS journey");
    assert.equal(localProcess.exitCode, undefined);
    environment.OBSYNC_E2E_CUSTODY_PROBE = "unknown";
    await assert.rejects(vm.runInNewContext(`(${main})()`, context), /OBSYNC_E2E_CUSTODY_PROBE must be/);
    environment.OBSYNC_E2E_CUSTODY_PROBE = "unavailable"; environment.OBSYNC_E2E_CAPTURES = savedCaptures;
    await assert.rejects(vm.runInNewContext(`(${main})()`, context), /cannot publish successful editor captures/);
    delete environment.OBSYNC_E2E_CUSTODY_PROBE;
    environment.OBSYNC_E2E_SECRET_STORE = "none";
    await assert.rejects(vm.runInNewContext(`(${main})()`, context), /requires native Linux/);
    environment.OBSYNC_E2E_SECRET_STORE = "macos";
    for (const mode of ["unknown", "toString", "constructor"]) {
      environment.OBSYNC_E2E_LAUNCH_ORDER = mode;
      const touches = preflightTouches;
      await assert.rejects(vm.runInNewContext(`(${main})()`, context), /OBSYNC_E2E_LAUNCH_ORDER must be/);
      assert.equal(preflightTouches, touches, "invalid launch order refuses before token/profile access");
    }
    delete environment.OBSYNC_E2E_LAUNCH_ORDER;
    for (const store of ["toString", "constructor", "unknown"]) {
      environment.OBSYNC_E2E_SECRET_STORE = store;
      const touches = preflightTouches;
      await assert.rejects(vm.runInNewContext(`(${main})()`, context), /OBSYNC_E2E_SECRET_STORE must be one of/);
      assert.equal(preflightTouches, touches, "invalid modes are refused before token or profile access");
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("actual restart checks custody before and after, waits for native exit, and propagates refusal", async () => {
  const fs = await import("node:fs"), vm = await import("node:vm");
  const source = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const stores = vm.runInNewContext(source.slice(source.indexOf("const STORES = {"), source.indexOf("const UNENCRYPTED")) + "STORES");
  const restart = source.slice(source.indexOf("async function restarted("), source.indexOf("\nasync function captureEditor("));
  const holdsAt = source.indexOf("function holds(");
  const holds = source.slice(holdsAt, source.indexOf("\n}\n", holdsAt) + 2);
  const secretFactsMarker = () => {};
  async function run({ bad = "", badField = "revisionMatches", store = "windows", failedHalt = false, failedTransfer = false, warning = false, launchOrder = "simultaneous" } = {}) {
    const calls = [], closed = new Set(), captured = [], transfers = [];
    let facts = 0;
    const instance = (name) => ({ name,
      async halt() { calls.push("halt-" + name); await Promise.resolve(); if (failedHalt && name === "a") throw Error("native quit refused"); closed.add(name); },
      launch() { assert.equal(closed.size, 2, "both native processes exited before any relaunch"); calls.push("launch-" + name); },
      async all() { return warning ? ["Secrets are stored without encryption"] : []; },
    });
    const context = {
      STORES: stores, Denied: Error, assertCustody, secretFacts: secretFactsMarker, diagnose() {},
      process: { platform: store === "macos" ? "darwin" : "win32" },
      inVault: async (_, fn) => {
        if (fn !== secretFactsMarker) return true;
        facts++;
        return { ...valid, ...(bad === (facts <= 2 ? "before" : "after") ? { [badField]: !valid[badField] } : {}) };
      },
      reopen: async (instance) => calls.push("reopen-" + instance.name), paired: () => true,
      until: async (_, probe) => probe(), Buffer,
      arrives: async (receiver, file) => { if (failedTransfer) throw Error("transfer refused"); transfers.push(receiver.name + ":" + file); return 1; },
      captureEditor: async (instance, phase) => captured.push(phase + "-" + instance.name),
      notices() {}, UNENCRYPTED: "Secrets are stored without encryption", prove() {},
    };
    const program = vm.runInNewContext(`${holds}\n(${restart})`, context);
    const promise = program(instance("a"), instance("b"), { binary: "test", extra: [], homes: false, store, launchOrder });
    if (bad || failedHalt || failedTransfer) {
      await assert.rejects(promise, /custody refused|native quit refused|transfer refused|still says/);
      if (bad === "before") assert.deepEqual(calls, [], "bad saved custody prevents restart");
      if (failedHalt) assert.equal(calls.some((line) => line.startsWith("launch-")), false);
      return;
    }
    const receipt = await promise;
    assert.equal(facts, 4, "both peers were checked before and after restart");
    assert.deepEqual(calls, launchOrder === "serialized"
      ? ["halt-a", "halt-b", "launch-a", "reopen-a", "launch-b", "reopen-b"]
      : ["halt-a", "halt-b", "launch-a", "launch-b", "reopen-a", "reopen-b"]);
    assert.deepEqual(transfers, ["b:e2e/after-restart-a.md", "a:e2e/after-restart-b.md"]);
    assert.deepEqual(captured, ["restart-a-a", "restart-a-b", "restart-b-b", "restart-b-a"]);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), { before: true, quit: true, paired: true, transferred: true, after: true });
  }
  await run();
  await run({ bad: "before" }); await run({ bad: "after" });
  await run({ failedHalt: true }); await run({ failedTransfer: true }); await run({ warning: true });
  await run({ store: "macos" });
  await run({ store: "macos", launchOrder: "serialized" });
  for (const bad of ["before", "after"]) {
    for (const badField of ["encrypted", "wrapped", "plainRoot", "revisionMatches", "pinMatches", "cleanupComplete"]) await run({ store: "macos", bad, badField });
  }
});
