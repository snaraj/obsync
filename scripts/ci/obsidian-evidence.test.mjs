import assert from "node:assert/strict";
import { test } from "node:test";
import { secretFacts, assertCustody, editorBounds, pairingCodes, assertPairingCodes } from "./obsidian-evidence.mjs";

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

const required = { encrypted: true, plain: false };
const valid = { encrypted: true, plain: false, stored: true, revisionMatches: true };

test("encrypted custody refuses empty, plaintext, unavailable and stale storage", () => {
  assertCustody(valid, required);
  for (const key of Object.keys(valid)) {
    assert.throws(() => assertCustody({ ...valid, [key]: !valid[key] }, required), /custody/);
  }
});

test("custody returns facts only, checks the persisted revision, and sanitizes malformed envelopes", async () => {
  const sentinel = "NEVER_RETURN_THE_SYNTHETIC_SECRET";
  let revision = 7, saved = 7, secret = JSON.stringify({ current: { revision: 7, key: sentinel } });
  globalThis.app = {
    loadLocalStorage: () => "encrypted-opaque-bytes",
    plugins: { plugins: { "obsync-private-sync": { loadData: async () => ({ credentialRef: "test-ref", credentialRevision: revision }) } } },
    secretStorage: {
      getSecret: (ref) => { assert.equal(ref, "test-ref"); return secret; },
      isEncryptionAvailable: () => true,
    },
  };
  try {
    const facts = await secretFacts();
    assert.equal(facts.revisionMatches, true);
    assert.equal(facts.backend, "none reported");
    assert.equal(JSON.stringify(facts).includes(sentinel), false);
    assert.equal(facts.plain, false);
    app.secretStorage.adapter = { getSelectedStorageBackend: () => { throw new TypeError("not a function"); } };
    const windows = await secretFacts();
    assert.equal(windows.backend, "unavailable");
    assertCustody(windows, required);
    assert.throws(() => assertCustody(windows, { ...required, backend: "gnome_libsecret" }), /custody/);
    app.secretStorage.isEncryptionAvailable = () => false;
    const unencrypted = await secretFacts();
    assert.throws(() => assertCustody(unencrypted, required), /custody/);
    assert.equal(unencrypted.encrypted, false);
    app.secretStorage.isEncryptionAvailable = () => true;
    app.secretStorage.adapter.getSelectedStorageBackend = () => "gnome_libsecret";
    assertCustody(await secretFacts(), { ...required, backend: "gnome_libsecret" });
    for ([revision, saved] of [[7, 6], [0, 0], [-1, -1], [1.5, 1.5], ["7", "7"]]) {
      secret = JSON.stringify({ current: { revision: saved } });
      assert.equal((await secretFacts()).revisionMatches, false);
    }
    secret = null;
    assert.equal((await secretFacts()).revisionMatches, false);
    secret = sentinel;
    await assert.rejects(secretFacts, (error) => error.message === "credential envelope is not valid JSON");
    app.loadLocalStorage = () => '{"secret":"synthetic"}';
    secret = null;
    assert.equal((await secretFacts()).plain, true);
    app.loadLocalStorage = () => "";
    assert.equal((await secretFacts()).stored, false);
  } finally { delete globalThis.app; }
});

test("early availability returns reduced facts without reading plugin metadata or credentials", async () => {
  let available = false;
  globalThis.app = {
    loadLocalStorage: () => '{"synthetic":"NEVER_RETURN_THE_SYNTHETIC_SECRET"}',
    plugins: { get plugins() { throw new Error("early metadata access forbidden"); } },
    secretStorage: {
      getSecret() { throw new Error("early credential access forbidden"); },
      isEncryptionAvailable: () => available,
    },
  };
  try {
    const found = await secretFacts(false);
    assert.deepEqual(found, { encrypted: false, backend: "none reported", stored: true, plain: true, revisionMatches: null });
    assert.ok(!JSON.stringify(found).includes("NEVER_RETURN"));
    available = true;
    assert.equal((await secretFacts(false)).encrypted, true);
    delete app.secretStorage;
    assert.equal((await secretFacts(false)).encrypted, null, "not yet exposed is unknown, never green");
  } finally { delete globalThis.app; }
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
    verifyNativeRedirects: async (page) => {
      assert.equal(page, "a"); redirects++; redirectChecked = true;
      if (redirectFails) throw new Error("synthetic native redirect refusal");
    },
    setServer: async () => { assert.equal(redirectChecked, true, "native redirect check precedes enrollment"); enrollments++; },
    secretFacts: secretFactsMarker, diagnose: (instance, phase, found) => { observed.push(instance.name + ":" + phase); assert.deepEqual(found, valid); },
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
    for (const platform of ["linux", "win32"]) {
      localProcess.platform = platform;
      await assert.rejects(vm.runInNewContext(`(${main})()`, context), /macOS custody requires native macOS/);
    }
    localProcess.platform = "darwin";
    environment.OBSYNC_E2E_LAUNCH_ORDER = "serialized";
    launches.length = 0; observed.length = 0; localProcess.exitCode = undefined;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined);
    assert.deepEqual(launches, ["launch-a", "ready-a", "launch-b", "ready-b"]);
    assert.deepEqual(observed, ["a:enrolled", "b:enrolled"]);
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
    if (bad || failedHalt || failedTransfer || warning) {
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
    for (const badField of ["encrypted", "plain", "revisionMatches"]) await run({ store: "macos", bad, badField });
  }
});
