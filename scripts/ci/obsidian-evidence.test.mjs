import assert from "node:assert/strict";
import { test } from "node:test";
import { secretFacts, assertCustody, editorBounds } from "./obsidian-evidence.mjs";

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

test("captures refuse dialogs, notices, wrong editors, hidden and out-of-viewport content", () => {
  let blockers = [], rect = { x: 20, y: 40, width: 800, height: 500, right: 820, bottom: 540 };
  const editor = { getBoundingClientRect: () => rect };
  const view = { file: { path: "e2e/test.md" }, editor: { getValue: () => "synthetic" }, containerEl: { querySelector: () => editor } };
  globalThis.app = { workspace: { activeLeaf: { view } } };
  globalThis.document = { querySelectorAll: (selector) => {
    assert.equal(selector, ".modal-container, .notice-container .notice"); return blockers;
  } };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;
  const bounds = () => editorBounds("e2e/test.md", "synthetic");
  try {
    assert.deepEqual(bounds(), { x: 20, y: 40, width: 800, height: 500, scale: 1 });
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

test("the real driver cannot report success when its restart journey is omitted", async () => {
  // Execute the real orchestration, substituting native boundaries only. The
  // complete inventory gate remains real, so omitting the restart call fails.
  const { finishEvidence } = await import("./obsidian-evidence.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path"), vm = await import("node:vm");
  const { createHash } = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsync-driver-test-"));
  const source = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main() {"), source.indexOf("\n/**\n * The two Linux cases"));
  const png = Buffer.from("synthetic-png"), hash = createHash("sha256").update(png).digest("hex");
  const capture = (name) => {
    fs.writeFileSync(path.join(root, name + ".png"), png);
    fs.writeFileSync(path.join(root, name + ".json"), JSON.stringify({ editorSha256: hash, diskSha256: hash, pngSha256: hash }));
  };
  const environment = { OBSYNC_E2E_SECRET_STORE: "windows", OBSYNC_E2E_CAPTURES: root };
  const localProcess = { env: environment, platform: "win32", exitCode: undefined };
  const context = {
    process: localProcess, env: (name) => name, STORES: { windows: {} }, secrets: [], started: Date.now(), proven: 0,
    fs: { readFileSync: () => "a".repeat(64), rmSync() {}, mkdirSync() {}, existsSync: () => true }, path,
    Denied: Error, scrub: String, console: { log() {}, error() {} }, Buffer, randomBytes: () => Buffer.from("test"),
    Instance: class { constructor() { this.root = root; this.vault = root; } launch() {} stop() {} async anywhere() { return true; } async all() { return []; } pluginLog() { return []; } },
    openVault: async () => ({ obsidian: "test", electron: "test" }), setServer: async () => {},
    until: async (_, probe) => probe(), paired: () => true, inVault: async () => true,
    fillPlaceholder() {}, click() {}, confirmPhrase() {}, pairingCode() {}, fillSetting() {}, describe() {}, notices() {},
    LABELS: {}, PLUGIN_ID: "test", SYNC_BUDGET_MS: 1, prove() {}, arrives: () => 1, leaves() {}, listing: () => [],
    cotyping: async () => { capture("cotype-a"); capture("cotype-b"); }, starvedWatcher() {}, windowsJourneys() {},
    restarted: async () => {
      for (const name of ["restart-a-a", "restart-a-b", "restart-b-a", "restart-b-b"]) capture(name);
      return { before: true, quit: true, paired: true, transferred: true, after: true };
    }, finishEvidence, untrusted() {},
  };
  try {
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, undefined, "the unmodified driver completes its restart and publication gates");
    for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name));
    localProcess.exitCode = undefined;
    context.restarted = async () => null;
    await vm.runInNewContext(`(${main})()`, context);
    assert.equal(localProcess.exitCode, 1, "an omitted restart must fail the real driver's success path");
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("actual restart checks custody before and after, waits for native exit, and propagates refusal", async () => {
  const fs = await import("node:fs"), vm = await import("node:vm");
  const source = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("async function restarted("), source.indexOf("\nasync function captureEditor("));
  const holdsAt = source.indexOf("function holds(");
  const holds = source.slice(holdsAt, source.indexOf("\n}\n", holdsAt) + 2);
  const secretFactsMarker = () => {};
  async function run({ bad = "", failedHalt = false, failedTransfer = false, warning = false } = {}) {
    const calls = [], closed = new Set(), captured = [], transfers = [];
    let facts = 0;
    const instance = (name) => ({ name,
      async halt() { calls.push("halt-" + name); await Promise.resolve(); if (failedHalt && name === "a") throw Error("native quit refused"); closed.add(name); },
      launch() { assert.equal(closed.size, 2, "both native processes exited before any relaunch"); calls.push("launch-" + name); },
      async all() { return warning ? ["Secrets are stored without encryption"] : []; },
    });
    const context = {
      STORES: { windows: required }, Denied: Error, assertCustody, secretFacts: secretFactsMarker,
      inVault: async (_, fn) => {
        if (fn !== secretFactsMarker) return true;
        facts++;
        return { ...valid, revisionMatches: bad === (facts <= 2 ? "before" : "after") ? false : true };
      },
      reopen: async (instance) => calls.push("reopen-" + instance.name), paired: () => true,
      until: async (_, probe) => probe(), Buffer,
      arrives: async (receiver, file) => { if (failedTransfer) throw Error("transfer refused"); transfers.push(receiver.name + ":" + file); return 1; },
      captureEditor: async (instance, phase) => captured.push(phase + "-" + instance.name),
      notices() {}, UNENCRYPTED: "Secrets are stored without encryption", prove() {},
    };
    const program = vm.runInNewContext(`${holds}\n(${restart})`, context);
    const promise = program(instance("a"), instance("b"), { binary: "test", extra: [], homes: false, store: "windows" });
    if (bad || failedHalt || failedTransfer || warning) {
      await assert.rejects(promise, /custody refused|native quit refused|transfer refused|still says/);
      if (bad === "before") assert.deepEqual(calls, [], "bad saved custody prevents restart");
      if (failedHalt) assert.equal(calls.some((line) => line.startsWith("launch-")), false);
      return;
    }
    const receipt = await promise;
    assert.equal(facts, 4, "both peers were checked before and after restart");
    assert.deepEqual(calls, ["halt-a", "halt-b", "launch-a", "launch-b", "reopen-a", "reopen-b"]);
    assert.deepEqual(transfers, ["b:e2e/after-restart-a.md", "a:e2e/after-restart-b.md"]);
    assert.deepEqual(captured, ["restart-a-a", "restart-a-b", "restart-b-b", "restart-b-a"]);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), { before: true, quit: true, paired: true, transferred: true, after: true });
  }
  await run();
  await run({ bad: "before" }); await run({ bad: "after" });
  await run({ failedHalt: true }); await run({ failedTransfer: true }); await run({ warning: true });
});
