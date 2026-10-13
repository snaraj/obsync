/** Real local custody and Transport, bounded synthetic HTTP; no app/device acceptance claim. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { State, StateStorageError } = require("../build/state.js");
const { Transport } = require("../build/transport.js");
const { resumeRotationCredential } = require("../build/rotationRecovery.js");
const { accountRecovery } = require("../build/accountRecovery.js");
const { encodeRecoveryBackup } = require("../build/recoveryBackup.js");
const c = require("../build/crypto.js");
const OLD = "11".repeat(32), ROOT = "22".repeat(32), ID = "33".repeat(16), SECRET = "44".repeat(32), NEW_ID = "55".repeat(16), NEW_SECRET = "66".repeat(32);
const PROFILE = { name: "Test coordinator", platform: "macos", app_version: "1.1.5" };
const receipt = { cutoff: 7, inventoryHash: "77".repeat(32), inventoryHeads: 1 };
const catalog = { catalogPages: 1, catalogHash: "88".repeat(32) };
async function succeeds(promise) { let result; await assert.doesNotReject(async () => result = await promise); return result; }
const generation = async root => (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(root)))).fileId;
const response = (value, status = 200) => ({ status, headers: {}, text: JSON.stringify(value), arrayBuffer: new ArrayBuffer(0) });

async function fixture(phase = "prepared", heads = 1) {
  let metadata = { vrk: OLD, deviceId: ID, deviceSecret: SECRET, serverUrl: "https://sync.example.invalid", edgeHeaders: [{ name: "X-Service", value: "synthetic-edge" }] };
  const entries = new Map(), writes = [], calls = [], hooks = { save: null, set: null, setup: null, status: null }, sent = [];
  const store = { loadData: async () => structuredClone(metadata), saveData: async value => {
    if (hooks.save) await hooks.save(value); metadata = structuredClone(value); writes.push(structuredClone(value)); } };
  const secrets = { getSecret: id => entries.get(id) ?? null, setSecret: (id, value) => { if (hooks.set) hooks.set(id, value); entries.set(id, value); } };
  const localReceipt = { ...receipt, inventoryHeads: heads }, localCatalog = { ...catalog, catalogPages: Math.ceil(heads / 256) };
  let state = await State.open(store, false, secrets);
  const intent = { lineage: await generation(OLD), operation: "99".repeat(16), oldGeneration: await generation(OLD), newGeneration: await generation(ROOT),
    targetDeviceId: null, recoveryVerifier: (await accountRecovery(ROOT)).verifier };
  if (phase !== "absent") {
    await state.stageRotation(ROOT, intent);
    if (phase !== "draft") await state.rotationPhase("prepare_unknown");
    if (!["draft", "prepare_unknown"].includes(phase)) await state.markRotationPrepared(localReceipt);
    if (["seeding", "commit_unknown"].includes(phase)) await state.rotationPhase("seeding");
    if (phase === "commit_unknown") await state.markRotationCommit(localCatalog);
  }
  let lastRequest, stopped = 0, live = true;
  const assertCurrent = () => { if (!live) throw new Error("synthetic superseded session"); state.assertAvailable(); };
  const transport = new Transport({ serverUrl: () => state.data.serverUrl, device: () => ({ id: state.data.deviceId, secret: c.unhex(state.data.deviceSecret) }),
    edgeHeaders: () => state.data.edgeHeaders, maxAttempts: 1, sleep: () => new Promise(() => {}),
    request: async request => {
      sent.push(request); assertCurrent(); assert.equal(stopped, calls.filter(call => call === "setup").length + (request.url.endsWith("/v1/setup") ? 1 : 0), "each explicit action stops sync before resume HTTP");
      if (request.url.endsWith("/v1/setup")) {
        calls.push("setup"); lastRequest = JSON.parse(request.body);
        const retained = state.custody2().rotation.resume;
        assert.equal(retained.id, lastRequest.rotation.resume_id, "resume ID must be durably acknowledged before HTTP");
        assert.deepEqual(retained.profile, lastRequest.device, "persisted exact profile goes on wire");
        assert.equal(lastRequest.recover_only, true); assert.equal(lastRequest.seal_suite, 2);
        assert.deepEqual(lastRequest.rotation, { operation: intent.operation, previous_map: intent.oldGeneration, current_map: intent.newGeneration,
          target: null, recovery_verifier: intent.recoveryVerifier, seal_suite: 2, resume_id: retained.id });
        if (hooks.setup) { const answer = await hooks.setup(lastRequest); if (answer) return response(answer, 201); }
        return response({ account_id: "ab".repeat(16), recovered: true, device_id: NEW_ID, device_secret: NEW_SECRET }, 201);
      }
      assert.equal(request.url, `https://sync.example.invalid/v1/rotation/${intent.operation}`, "only exact pending status, never current map");
      calls.push("status");
      const header = name => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
      assert.equal(header("X-Obsync-Device"), NEW_ID, "new grant proves itself without premature local adoption"); assert.ok(header("X-Obsync-Sig"));
      assert.equal(state.data.deviceId, ID, "old local credential stays until verified readback and ACK");
      const status = { intent: { operation: intent.operation, previous_map: intent.oldGeneration, current_map: intent.newGeneration, target: null,
        recovery_verifier: intent.recoveryVerifier, seal_suite: 2 }, coordinator: NEW_ID, cutoff: receipt.cutoff, inventory_hash: receipt.inventoryHash,
        inventory_heads: heads, catalog_pages: phase === "commit_unknown" ? localCatalog.catalogPages : 0, catalog_heads: phase === "commit_unknown" ? heads : 0,
        catalog_last: phase === "commit_unknown" ? ["bc".repeat(16), "cd".repeat(32)] : null, catalog_hash: phase === "commit_unknown" ? catalog.catalogHash : "de".repeat(32),
        committed: false, resume_id: lastRequest.rotation.resume_id };
      if (hooks.status) await hooks.status(status);
      return response(status);
    } });
  const options = { state, transport, token: "synthetic-owner-token", backup: await encodeRecoveryBackup(c.unhex(ROOT)), profile: PROFILE,
    assertCurrent, stopSync: async () => { stopped++; } };
  return { options, hooks, calls, sent, writes, entries, intent, store, secrets, state: () => state, metadata: () => structuredClone(metadata), replaceMetadata: value => { metadata = structuredClone(value); }, stopped: () => stopped,
    invalidate: () => { live = false; }, request: () => structuredClone(lastRequest), restart: async () => { state = await State.open(store, false, secrets); options.state = state; return state; } };
}

test("pending recovery proves exact scoped grant and preserves phase/root/receipts without ordinary sync", async () => {
  for (const phase of ["prepare_unknown", "prepared", "seeding", "commit_unknown"]) {
    const r = await fixture(phase), before = r.state().custody2();
    assert.equal(await succeeds(resumeRotationCredential(r.options)), "resumed"); assert.deepEqual(r.calls, ["setup", "status"]); assert.equal(r.stopped(), 1);
    assert.equal(r.state().data.vrk, OLD); assert.equal(r.state().data.deviceId, NEW_ID); assert.equal(r.state().data.deviceSecret, NEW_SECRET);
    const after = r.state().custody2(); assert.equal(after.rotation.newRoot, ROOT); assert.deepEqual(after.rotation.intent, before.rotation.intent);
    assert.equal(after.phase, phase === "prepare_unknown" ? "prepared" : phase); assert.deepEqual(after.rotation.prepared, receipt);
    assert.deepEqual(after.rotation.commit, before.rotation.commit); assert.deepEqual(after.rotation.resume.profile, PROFILE);
    const restart = await r.restart(); assert.deepEqual(restart.custody2(), after); assert.equal(restart.data.deviceId, NEW_ID);
  }
});

test("lost resume retries persisted ID and normalized profile after restart/plugin upgrade", async () => {
  const r = await fixture(); r.options.profile = { name: " Test coordinator ", platform: "macos", app_version: " 1.1.5 " };
  r.hooks.setup = async () => { throw new Error("synthetic response lost"); };
  assert.equal(await succeeds(resumeRotationCredential(r.options)), "lost"); assert.deepEqual(r.calls, ["setup"]); assert.equal(r.state().data.deviceId, ID);
  const first = r.request(); const state = await r.restart();
  r.options.profile = { name: "Renamed coordinator", platform: "macos", app_version: "9.9.9" }; r.hooks.setup = null;
  assert.equal(await succeeds(resumeRotationCredential(r.options)), "resumed"); assert.deepEqual(r.request(), first); assert.equal(state.custody2().rotation.resume.id, first.rotation.resume_id);
  assert.equal(r.sent.filter(request => request.url.endsWith("/v1/setup")).length, 2);
});

test("wrong backup refuses before proof KDF, resume persistence or network", async () => {
  const r = await fixture(), before = r.metadata(), secret = [...r.entries]; r.options.backup = await encodeRecoveryBackup(c.unhex(OLD));
  const subtle = crypto.subtle, original = subtle.deriveBits.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "deriveBits"); let derivations = 0;
  subtle.deriveBits = (...args) => { derivations++; return original(...args); };
  try { await assert.rejects(resumeRotationCredential(r.options)); }
  finally { if (descriptor) Object.defineProperty(subtle, "deriveBits", descriptor); else delete subtle.deriveBits; }
  assert.equal(derivations, 0); assert.deepEqual(r.calls, []); assert.deepEqual(r.metadata(), before); assert.deepEqual([...r.entries], secret);
});

test("draft, absent custody, invalid backup and profile cannot request ordinary enrollment", async () => {
  for (const phase of ["draft", "absent"]) { const r = await fixture(phase); await assert.rejects(resumeRotationCredential(r.options)); assert.deepEqual(r.calls, []); }
  for (const patch of [{ backup: "synthetic not a backup" }, { profile: { ...PROFILE, extra: true } }, { profile: { ...PROFILE, platform: "unknown" } },
    { profile: { ...PROFILE, name: "" } }, { profile: { ...PROFILE, name: "n".repeat(65) } }, { profile: { ...PROFILE, name: "control\nname" } },
    { profile: { ...PROFILE, app_version: "v".repeat(33) } }]) {
    const r = await fixture(); Object.assign(r.options, patch); await assert.rejects(resumeRotationCredential(r.options)); assert.deepEqual(r.calls, []);
  }
});

test("substituted status intent/coordinator/resume/cutoff/inventory or commit catalog refuses before credential adoption", async () => {
  for (const mutate of [s => s.intent.target = "ef".repeat(16), s => s.coordinator = "ef".repeat(16), s => s.resume_id = null,
    s => s.resume_id = "ef".repeat(16), s => s.cutoff++, s => s.inventory_hash = "ef".repeat(32), s => s.inventory_heads = 2,
    s => s.committed = true, s => s.catalog_hash = "ef".repeat(32), s => { s.catalog_pages = 0; s.catalog_heads = 0; s.catalog_last = null; }]) {
    const r = await fixture("commit_unknown"); r.hooks.status = mutate;
    await assert.rejects(resumeRotationCredential(r.options)); assert.equal(r.state().data.deviceId, ID); assert.equal(r.state().data.vrk, OLD);
    assert.equal(r.state().custody2().phase, "commit_unknown"); assert.deepEqual(r.calls, ["setup", "status"]);
  }
  const counts = await fixture("prepared"); counts.hooks.status = s => { s.inventory_heads = 2; };
  await assert.rejects(resumeRotationCredential(counts.options)); assert.equal(counts.state().data.deviceId, ID);
  const pages = await fixture("commit_unknown", 257); pages.hooks.status = s => { s.catalog_pages = 3; };
  await assert.rejects(resumeRotationCredential(pages.options)); assert.equal(pages.state().data.deviceId, ID);
  const r = await fixture("prepare_unknown"); r.hooks.status = s => { s.committed = true; s.inventory_heads = 0; };
  await assert.rejects(resumeRotationCredential(r.options)); assert.equal(r.state().custody2().phase, "prepare_unknown"); assert.equal(r.state().data.deviceId, ID);
});

test("recovery refuses stale session or concurrent durable receipt/phase changes before adoption", async () => {
  for (const change of [r => r.invalidate(), r => { r.state().data.serverUrl = "https://other.example.invalid"; },
    r => { r.state().data.edgeHeaders = []; }, r => r.state().rotationPhase("seeding")]) {
    const r = await fixture(); r.hooks.setup = async () => change(r);
    await assert.rejects(resumeRotationCredential(r.options)); assert.deepEqual(r.calls, ["setup"]); assert.equal(r.sent.length, 1, "no credential-bearing read after local authority changes"); assert.equal(r.state().data.deviceId, ID);
  }
});

test("resume record/storage failure sends no HTTP; credential save failure retains acknowledged old authority", async () => {
  for (const at of ["resume", "credential", "lost-ack"]) {
    const r = await fixture(), before = r.state().custody2();
    r.hooks.save = async value => { if ((at === "resume" && value.deviceId === ID) || (at !== "resume" && value.deviceId === NEW_ID)) { if (at === "lost-ack") r.replaceMetadata(value); throw new Error("synthetic custody fault"); } };
    await assert.rejects(resumeRotationCredential(r.options), StateStorageError); assert.equal(r.state().data.deviceId, ID); assert.equal(r.state().data.vrk, OLD);
    assert.equal(r.state().custody2().phase, before.phase); assert.throws(() => r.state().assertAvailable());
    assert.deepEqual(r.calls, at === "resume" ? [] : ["setup", "status"]); r.hooks.save = null;
    if (at === "lost-ack") { const again = await r.restart(); assert.equal(again.data.deviceId, NEW_ID); assert.equal(again.data.vrk, OLD); }
    else await assert.rejects(r.restart(), StateStorageError);
  }
});

test("non-recovery or malformed setup credentials never reach status or local adoption", async () => {
  for (const patch of [{ recovered: false }, { recovered: undefined }, { account_id: "BAD" }, { device_id: "BAD" }, { device_secret: "BAD" }]) {
    const r = await fixture(); r.hooks.setup = () => ({ account_id: "ab".repeat(16), recovered: true, device_id: NEW_ID, device_secret: NEW_SECRET, ...patch });
    await assert.rejects(resumeRotationCredential(r.options)); assert.deepEqual(r.calls, ["setup"]); assert.equal(r.sent.length, 1, "no credential-bearing read after local authority changes"); assert.equal(r.state().data.deviceId, ID);
  }
});
