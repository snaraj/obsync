import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { KEYS } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { State, StateStorageError } = require("../build/state.js");
const clone = (value) => structuredClone(value);
/** A storage stop, by its logged reason: the words shown carry no code (#168). */
const reason = (code) => (error) => error instanceof StateStorageError && error.reason === code;
const legacy = () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
  serverUrl: "https://sync.example.invalid", edgeHeaders: [{ name: "X-Service", value: "LOCAL TOKEN SENTINEL" }],
  lastSeq: 7, files: { "Notes/note.md": { fileId: "12".repeat(16), versionId: "34".repeat(32), size: 4, mtime: 1, sha256: "" } },
  syncFolders: ["Notes"] });

function backing(initial = null) {
  let metadata = clone(initial);
  const entries = new Map(), calls = [], writes = [], failures = [];
  const hooks = { get: null, set: null, save: null };
  const secrets = {
    getSecret(id) {
      calls.push(["get", id]);
      return hooks.get ? hooks.get(id) : entries.get(id) ?? null;
    },
    setSecret(id, value) {
      calls.push(["set", id]);
      if (hooks.set) hooks.set(id, value);
      entries.set(id, value);
    },
  };
  const store = {
    loadData: async () => clone(metadata),
    saveData: async (value) => {
      calls.push(["metadata"]);
      if (hooks.save) await hooks.save(value);
      writes.push(clone(value)); metadata = clone(value);
    },
  };
  return { store, secrets, hooks, calls, writes, failures, entries,
    metadata: () => clone(metadata), replaceMetadata: (value) => { metadata = clone(value); },
    open: () => State.open(store, false, secrets, (error) => failures.push(error.reason)) };
}

async function persisted() {
  const r = backing(legacy());
  await r.open();
  return { metadata: r.metadata(), envelope: r.entries.get(r.metadata().credentialRef) };
}

function restored(record) {
  const r = backing(record.metadata);
  r.entries.set(record.metadata.credentialRef, record.envelope);
  return r;
}

test("new and migrated state persist only bookkeeping and one exact owned credential reference", async () => {
  for (const initial of [null, legacy()]) {
    const r = backing(initial), state = await r.open();
    const metadata = r.metadata(), ref = metadata.credentialRef;
    assert.match(metadata.installationId, /^[0-9a-f]{32}$/);
    assert.equal(ref, `obsync-private-sync-v1-${metadata.installationId}`);
    assert.equal(metadata.storageVersion, 1);
    assert.equal(metadata.credentialRevision, 1);
    for (const field of ["vrk", "deviceSecret", "edgeHeaders"]) assert.equal(Object.hasOwn(metadata, field), false);
    assert.equal(JSON.stringify(metadata).includes("LOCAL TOKEN SENTINEL"), false);
    assert.deepEqual(r.calls.map(([operation]) => operation), ["get", "get", "set", "get", "metadata"]);
    assert.ok(r.calls.filter(([operation]) => operation !== "metadata").every(([, id]) => id === ref));
    const envelope = JSON.parse(r.entries.get(ref));
    assert.equal(envelope.current.vrk, initial?.vrk ?? null);
    assert.equal(envelope.current.deviceSecret, initial?.deviceSecret ?? null);
    assert.deepEqual(envelope.current.edgeHeaders, initial?.edgeHeaders ?? []);
    assert.equal(envelope.current.serverUrl, state.data.serverUrl);
    assert.equal(envelope.previous, null);
    const reloaded = await r.open();
    assert.deepEqual(reloaded.data, state.data);
    assert.equal(r.writes.length, 1, "loading a valid reference does not rewrite or re-enroll");
  }
});

test("credential-only enrollment and key-only recovery survive migration and reload", async () => {
  for (const patch of [{ vrk: null }, { deviceId: null, deviceSecret: null }]) {
    const r = backing({ ...legacy(), ...patch });
    const state = await r.open();
    assert.equal(state.paired, false);
    assert.deepEqual((await r.open()).data, state.data);
    assert.equal(state.data.vrk, patch.vrk === null ? null : KEYS.vrk);
    assert.equal(state.data.deviceSecret, patch.deviceSecret === null ? null : KEYS.deviceSecret);
  }
});

test("invalid references and plaintext-bearing metadata refuse before any secret lookup", async () => {
  const record = await persisted();
  for (const patch of [
    { storageVersion: 2 }, { installationId: "../other", credentialRef: "obsync-private-sync-v1-../other" }, { credentialRevision: 0 },
    { credentialRevision: 1.5 }, { credentialRef: "unrelated-entry" },
    { credentialRef: "obsync-private-sync-v1-" + "99".repeat(16) },
    { serverUrl: null }, { vrk: null }, { deviceSecret: null }, { edgeHeaders: [] }, { enrollment: { root: KEYS.vrk } }, { root: KEYS.vrk },
  ]) {
    const r = restored(record); r.replaceMetadata({ ...record.metadata, ...patch });
    await assert.rejects(r.open(), StateStorageError);
    assert.deepEqual(r.calls, []);
    assert.equal(r.writes.length, 0);
  }
});

test("missing, malformed, mismatched or incomplete envelopes never reset identity", async () => {
  const record = await persisted(), valid = JSON.parse(record.envelope);
  const missing = { ...valid.current, unexpected: true }; delete missing.vrk;
  for (const envelope of [null, "not JSON", "{}", JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, current: missing }), JSON.stringify({ ...valid, previous: valid.current }),
    ...[{ version: 2 }, { installationId: "99".repeat(16) }].map((patch) => JSON.stringify({ ...valid, ...patch })),
    ...[{ revision: 2 },
      { serverUrl: "https://other.example.invalid" }, { deviceId: "99".repeat(16) },
      { vrk: "bad" }, { deviceSecret: null }, { edgeHeaders: null }, { edgeHeaders: [{ name: "X", value: 7 }] }]
      .map((patch) => JSON.stringify({ ...valid, current: { ...valid.current, ...patch } }))]) {
    const r = restored(record);
    if (envelope === null) r.entries.delete(record.metadata.credentialRef);
    else r.entries.set(record.metadata.credentialRef, envelope);
    await assert.rejects(r.open(), StateStorageError);
    assert.deepEqual(r.calls, [["get", record.metadata.credentialRef]]);
    assert.deepEqual(r.metadata(), record.metadata);
    assert.equal(r.writes.length, 0);
  }
});

test("damaged legacy identity is refused instead of silently becoming a fresh device", async () => {
  for (const metadata of ["corrupt", [], { ...legacy(), vrk: 7 }, { ...legacy(), deviceSecret: "bad" },
    { ...legacy(), deviceId: null }, { ...legacy(), edgeHeaders: "bad" }]) {
    const r = backing(metadata);
    await assert.rejects(r.open(), StateStorageError);
    assert.deepEqual(r.metadata(), metadata);
    assert.deepEqual(r.calls, []);
  }
});

test("unavailable storage and migration failures keep legacy metadata intact", async () => {
  await assert.rejects(State.open(backing().store, false, undefined), reason("unavailable"));
  for (const fault of ["get", "set", "readback", "metadata", "occupied"]) {
    const initial = legacy(), r = backing(initial);
    if (fault === "get") r.hooks.get = () => { throw new Error("host unavailable"); };
    if (fault === "set") r.hooks.set = () => { throw new Error("host unavailable"); };
    if (fault === "readback") r.hooks.get = () => null;
    if (fault === "metadata") r.hooks.save = async () => { throw new Error("write failed"); };
    if (fault === "occupied") r.hooks.get = () => "already occupied";
    await assert.rejects(r.open(), StateStorageError);
    assert.deepEqual(r.metadata(), initial);
    assert.equal(r.writes.length, 0);
    assert.equal(r.failures.length, 1);
    if (fault !== "metadata") assert.ok(r.calls.every(([operation]) => operation !== "metadata"));
  }
});

test("bookkeeping saves leave secret bytes untouched and failed metadata writes reload the prior state", async () => {
  const r = backing(legacy()), state = await r.open();
  const ref = r.metadata().credentialRef, before = r.entries.get(ref);
  state.data.lastSeq = 8;
  await state.save();
  assert.equal(r.entries.get(ref), before);
  assert.equal(r.calls.filter(([operation]) => operation === "set").length, 1);
  assert.equal(r.metadata().credentialRevision, 1);
  r.hooks.save = async () => { throw new Error("metadata failed"); };
  state.data.lastSeq = 9;
  await assert.rejects(state.save(), reason("metadata_write_failed"));
  r.hooks.save = null;
  assert.equal((await r.open()).data.lastSeq, 8);
  assert.equal(r.entries.get(ref), before);
});

test("failed credential transitions block the active state but reload its prior valid identity", async () => {
  for (const fault of ["set", "get", "readback", "metadata"]) {
    const r = backing(legacy()), state = await r.open(), previous = r.metadata();
    if (fault === "set") r.hooks.set = () => { throw new Error("write failed"); };
    if (fault === "get") r.hooks.get = () => { throw new Error("read failed"); };
    if (fault === "readback") {
      let reads = 0;
      r.hooks.get = (id) => ++reads === 1 ? r.entries.get(id) : "different";
    }
    if (fault === "metadata") r.hooks.save = async () => { throw new Error("uncertain metadata write"); };
    state.data.lastSeq = 8;
    state.data.vrk = "ab".repeat(32);
    await assert.rejects(state.save(), StateStorageError);
    assert.equal(state.paired, false);
    assert.throws(() => state.assertAvailable(), StateStorageError);
    const count = r.calls.length;
    await assert.rejects(state.save(), StateStorageError);
    assert.equal(r.calls.length, count, "no silent retry after uncertain persistence");
    assert.equal(state.data.vrk, "ab".repeat(32), "failure must not erase the in-memory key");
    assert.deepEqual(r.metadata(), previous);
    assert.equal(r.failures.length, 1);
    r.hooks.get = r.hooks.set = r.hooks.save = null;
    const reloaded = await r.open();
    assert.equal(reloaded.data.lastSeq, 7);
    assert.equal(reloaded.data.vrk, KEYS.vrk);
  }
});

test("an uncertain metadata acknowledgement reloads exactly the revision actually recorded", async () => {
  const r = backing(legacy()), state = await r.open();
  state.data.vrk = "ab".repeat(32);
  r.hooks.save = async (snapshot) => { r.replaceMetadata(snapshot); throw new Error("acknowledgement lost"); };
  await assert.rejects(state.save(), reason("metadata_write_failed"));
  assert.equal(state.paired, false);
  r.hooks.save = null;
  assert.equal((await r.open()).data.vrk, "ab".repeat(32));
  assert.equal(r.metadata().credentialRevision, 2);
});

test("the single owned entry retains only the current and previous valid credential records", async () => {
  const r = backing(legacy()), state = await r.open(), first = r.metadata();
  for (const key of ["ab", "cd"]) { state.data.vrk = key.repeat(32); await state.save(); }
  const envelope = JSON.parse(r.entries.get(first.credentialRef));
  assert.deepEqual(Object.keys(envelope).sort(), ["current", "installationId", "previous", "version"]);
  assert.equal(envelope.current.revision, 3);
  assert.equal(envelope.previous.revision, 2);
  assert.equal(envelope.current.vrk, "cd".repeat(32));
  assert.equal(envelope.previous.vrk, "ab".repeat(32));
  assert.equal(r.entries.size, 1);
  r.replaceMetadata(first);
  await assert.rejects(r.open(), reason("identity_mismatch"));
});

test("the previous credential record is collapsed only once the current one holds none", async () => {
  const r = backing(legacy()), state = await r.open(), ref = r.metadata().credentialRef;
  const held = () => JSON.parse(r.entries.get(ref));
  state.data.vrk = "ab".repeat(32);
  await state.save();
  assert.equal(held().previous.deviceSecret, KEYS.deviceSecret, "the fixture really did keep it");

  // A live credential is a revision an interrupted write may still be named
  // by, so history is never collapsed under it.
  await assert.rejects(() => state.forgetPreviousCredential(), reason("credential_present"));
  assert.equal(held().previous.revision, 1, "and nothing was dropped");

  state.forgetPairing();
  await state.save();
  await state.forgetPreviousCredential();

  const envelope = held();
  assert.equal(envelope.previous, null);
  assert.equal(envelope.current.revision, 3);
  assert.equal(r.metadata().credentialRevision, 3, "metadata names the revision that survived");
  assert.equal(JSON.stringify(envelope).includes(KEYS.deviceSecret), false);
  assert.equal(JSON.stringify(envelope).includes("LOCAL TOKEN SENTINEL"), false);
  assert.equal(envelope.current.vrk, "ab".repeat(32), "the vault key is not a credential");
  assert.equal(r.entries.size, 1, "one owned entry, still");
  // Collapsing again is a no-op rather than a second write.
  const calls = r.calls.length;
  await state.forgetPreviousCredential();
  assert.equal(r.calls.length, calls);
  assert.equal((await restored({ metadata: r.metadata(), envelope: r.entries.get(ref) }).open()).paired, false);
});

test("a native entry changed by something else is not overwritten while collapsing", async () => {
  const r = backing(legacy()), state = await r.open(), ref = r.metadata().credentialRef;
  state.forgetPairing();
  await state.save();
  // Another writer advanced the entry between the save and this write.
  const foreign = JSON.parse(r.entries.get(ref));
  foreign.current = { ...foreign.current, revision: foreign.current.revision + 1 };
  r.entries.set(ref, JSON.stringify(foreign));
  const before = r.entries.get(ref);
  await assert.rejects(() => state.forgetPreviousCredential(), reason("secret_changed"));
  assert.equal(r.entries.get(ref), before, "the other writer's entry stands");
});

test("an inactive load does not migrate or touch the secret store", async () => {
  const r = backing(legacy());
  await assert.rejects(State.open(r.store, false, r.secrets, () => {}, () => false), reason("inactive_load"));
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.metadata(), legacy());
});

test("concurrent writes use detached snapshots and persist the newest matching revision", async () => {
  const r = backing(legacy()), state = await r.open();
  let entered, release;
  const saving = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let paused = false;
  r.hooks.save = async (snapshot) => { if (!paused) { paused = true; entered(snapshot); await held; } };
  state.data.lastSeq = 8;
  const first = state.save();
  const snapshot = await saving;
  state.data.lastSeq = 9;
  state.data.files["Notes/note.md"].size = 99;
  state.data.vrk = "ab".repeat(32);
  const second = state.save();
  state.data.lastSeq = 10;
  const third = state.save();
  const before = clone(snapshot);
  release();
  await Promise.all([first, second, third]);
  assert.equal(before.lastSeq, 8);
  assert.equal(before.files["Notes/note.md"].size, 4);
  assert.deepEqual(snapshot, before, "later mutations never leak into an in-flight metadata object");
  const reloaded = await r.open();
  assert.equal(reloaded.data.lastSeq, 10);
  assert.equal(reloaded.data.files["Notes/note.md"].size, 99);
  assert.equal(reloaded.data.vrk, "ab".repeat(32));
  assert.equal(r.metadata().credentialRevision, 2, "only the credential transition advances its revision");
});

test("an externally changed owned entry is refused before it can be overwritten", async () => {
  const r = backing(legacy()), state = await r.open(), ref = r.metadata().credentialRef;
  const sets = r.calls.filter(([operation]) => operation === "set").length;
  r.entries.set(ref, "externally changed local sentinel");
  state.data.vrk = "ab".repeat(32);
  await assert.rejects(state.save(), reason("secret_changed"));
  assert.equal(r.entries.get(ref), "externally changed local sentinel");
  assert.equal(r.calls.filter(([operation]) => operation === "set").length, sets);
});

test("exhausted credential revisions fail without changing native or metadata stores", async () => {
  const record = await persisted(), envelope = JSON.parse(record.envelope);
  envelope.current.revision = record.metadata.credentialRevision = Number.MAX_SAFE_INTEGER;
  record.envelope = JSON.stringify(envelope);
  const r = restored(record), state = await r.open();
  state.data.vrk = "ab".repeat(32);
  await assert.rejects(state.save(), reason("revision_exhausted"));
  assert.equal(r.entries.get(record.metadata.credentialRef), record.envelope);
  assert.deepEqual(r.metadata(), record.metadata);
});

// Suite 2 authority remains entirely inside the one owned secret envelope.
const c = require("../build/crypto.js");
const { accountRecovery } = require("../build/accountRecovery.js");
const root2 = "ab".repeat(32);
const generationOf = async root => (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(root)))).fileId;
const enrollment2 = async (root = KEYS.vrk) => ({ root, generation: await generationOf(root), deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, purpose: "pair" });
const intent2 = async () => ({ lineage: await generationOf(KEYS.vrk), operation: "23".repeat(16),
  oldGeneration: await generationOf(KEYS.vrk), newGeneration: await generationOf(root2), targetDeviceId: "45".repeat(16), recoveryVerifier: (await accountRecovery(root2)).verifier });
const pending2 = async (phase = "draft") => {
  const r = backing(legacy()), state = await r.open();
  await state.stageRotation(root2, await intent2());
  for (const next of ["prepare_unknown", "prepared", "seeding", "commit_unknown"]) {
    if (state.custody2().phase === phase) break;
    if (next === "prepared") await state.markRotationPrepared({ cutoff: 7, inventoryHash: "78".repeat(32), inventoryHeads: 2 });
    else if (next === "commit_unknown") await state.markRotationCommit({ catalogPages: 1, catalogHash: "89".repeat(32) });
    else await state.rotationPhase(next);
  }
  const record = { metadata: r.metadata(), envelope: r.entries.get(r.metadata().credentialRef) };
  assert.equal(JSON.parse(record.envelope).version, 2, "staged authority must actually reach the owned secret envelope");
  assert.deepEqual(JSON.parse(record.envelope).custody, state.custody2(), "acknowledged phase/root matches retained secret bytes");
  return { r, state, record };
};

test("suite2 atomic enrollment pins exact derived authority; legacy state stays version1", async () => {
  const r = backing(), state = await r.open(), old = clone(state.data);
  for (const patch of [{ generation: "00".repeat(16) }, { root: "BAD" }, { deviceId: null }, { deviceSecret: "ff" }, { extra: true }]) {
    await assert.rejects(state.adoptSuite2({ ...await enrollment2(), ...patch }), StateStorageError);
    assert.deepEqual(state.data, old, "refused enrollment changes nothing");
    assert.equal(r.metadata().storageVersion, 1);
  }
  await state.stageEnrollment2(KEYS.vrk, "pair"); await state.adoptSuite2(await enrollment2());
  const metadata = r.metadata(), envelope = JSON.parse(r.entries.get(metadata.credentialRef));
  assert.equal(metadata.storageVersion, 2); assert.equal(envelope.version, 2); assert.equal(envelope.previous, null);
  assert.deepEqual(metadata.sealPin, { suite: 2, generation: await generationOf(KEYS.vrk), phase: "active" });
  assert.deepEqual((await r.open()).custody2(), state.custody2());
  assert.equal((await backing(legacy()).open()).custody2(), null);
  await assert.rejects(state.adoptSuite2(await enrollment2(root2)), reason("pin_replacement"));
  const paired = await backing(legacy()).open();
  await assert.rejects(paired.adoptSuite2(await enrollment2(root2)), reason("pin_replacement"));
});

test("suite2 missing/copied/revision+1/previous/stripped authority never falls back or rewrites bytes", async () => {
  const { record } = await pending2(), valid = JSON.parse(record.envelope);
  for (const [label, change] of [
    ["missing", r => r.entries.clear()],
    ["corrupt", r => r.entries.set(record.metadata.credentialRef, "not JSON")],
    ["revision+1", r => r.replaceMetadata({ ...record.metadata, credentialRevision: record.metadata.credentialRevision + 1 })],
    ["previous revision", r => r.replaceMetadata({ ...record.metadata, credentialRevision: record.metadata.credentialRevision - 1 })],
    ["previous root record", r => r.entries.set(record.metadata.credentialRef, JSON.stringify({ ...valid, previous: { ...valid.current, revision: valid.current.revision - 1 } }))],
    ["stripped pin", r => { const m = clone(record.metadata); delete m.sealPin; r.replaceMetadata(m); }],
    ["metadata downgraded", r => { const m = clone(record.metadata); m.storageVersion = 1; delete m.sealPin; r.replaceMetadata(m); }],
    ["envelope downgraded", r => { const e = clone(valid); e.version = 1; delete e.custody; r.entries.set(record.metadata.credentialRef, JSON.stringify(e)); }],
    ["pin mismatch", r => r.replaceMetadata({ ...record.metadata, sealPin: { ...record.metadata.sealPin, phase: "prepared" } })],
    ["pin unknown field", r => r.replaceMetadata({ ...record.metadata, sealPin: { ...record.metadata.sealPin, extra: true } })],
  ]) {
    const r = restored(record); change(r); const before = r.metadata(), secret = [...r.entries];
    await assert.rejects(State.open(r.store, false, r.secrets, undefined, undefined, undefined, { holds: () => false, hold: () => {} }), StateStorageError, label);
    assert.deepEqual(r.metadata(), before, label); assert.deepEqual([...r.entries], secret, label); assert.equal(r.writes.length, 0, label);
  }
  const r = backing(); const state = await r.open(); await state.stageEnrollment2(KEYS.vrk, "pair"); await state.adoptSuite2(await enrollment2());
  const active = { metadata: r.metadata(), envelope: r.entries.get(r.metadata().credentialRef) };
  for (const delta of [-1, 1]) { const x = restored(active); x.replaceMetadata({ ...active.metadata, credentialRevision: active.metadata.credentialRevision + delta }); await assert.rejects(x.open(), StateStorageError); }
});

test("suite2 exact custody schema and every root/generation binding refuse before adoption", async () => {
  const { record } = await pending2(), valid = JSON.parse(record.envelope);
  const oldVerifier = (await accountRecovery(KEYS.vrk)).verifier;
  const mutations = [
    e => e.custody.extra = true, e => e.custody.suite = 1, e => e.custody.phase = "unknown", e => e.custody.generation = "AB".repeat(16),
    e => e.custody.rotation.extra = true, e => e.custody.rotation.fromSuite = 3, e => { e.custody.rotation.newRoot = KEYS.vrk; e.custody.rotation.intent.recoveryVerifier = oldVerifier; },
    e => e.custody.rotation.intent.extra = true, e => e.custody.rotation.intent.operation = "00", e => e.custody.rotation.intent.lineage = "AB".repeat(16),
    e => e.custody.rotation.intent.targetDeviceId = 7, e => e.custody.rotation.intent.recoveryVerifier = "00", e => e.custody.rotation.intent.recoveryVerifier = "67".repeat(32), e => e.custody.rotation.intent.oldGeneration = "00".repeat(16),
    e => e.custody.rotation.intent.newGeneration = "00".repeat(16), e => e.custody.rotation = null, e => e.custody.phase = "active", e => e.custody.phase = "enrollment",
    e => e.custody.initializeMap = true,
    e => e.current.vrk = root2, e => e.current.deviceId = e.current.deviceSecret = null,
    e => e.custody.history = { root: KEYS.vrk, generation: e.custody.rotation.intent.oldGeneration },
    e => e.custody.history = { root: root2, generation: e.custody.generation, suite: 2 },
    e => e.custody.history = { root: root2, generation: "00".repeat(16) },
  ];
  for (const mutate of mutations) {
    const r = restored(record), envelope = clone(valid); mutate(envelope);
    const bytes = JSON.stringify(envelope); r.entries.set(record.metadata.credentialRef, bytes);
    r.replaceMetadata({ ...record.metadata, deviceId: envelope.current.deviceId, sealPin: { ...record.metadata.sealPin, phase: envelope.custody.phase } });
    await assert.rejects(r.open(), StateStorageError); assert.equal(r.entries.get(record.metadata.credentialRef), bytes); assert.equal(r.writes.length, 0);
  }
  const self = restored(record), same = clone(valid);
  same.custody.rotation.newRoot = KEYS.vrk; same.custody.rotation.intent.recoveryVerifier = (await accountRecovery(KEYS.vrk)).verifier; same.custody.generation = same.custody.rotation.intent.oldGeneration; same.custody.rotation.intent.newGeneration = same.custody.generation;
  self.entries.set(record.metadata.credentialRef, JSON.stringify(same)); self.replaceMetadata({ ...record.metadata, sealPin: { ...record.metadata.sealPin, generation: same.custody.generation } });
  await assert.rejects(self.open(), StateStorageError, "rotation cannot retain the old generation");
  const fresh = backing(legacy()), initial = await fresh.open(), before = [...fresh.entries], metadata = fresh.metadata();
  await assert.rejects(initial.stageRotation(root2, { ...await intent2(), recoveryVerifier: "67".repeat(32) }), StateStorageError);
  assert.deepEqual([...fresh.entries], before); assert.deepEqual(fresh.metadata(), metadata);
  const r = restored(record), state = await r.open(), exposed = state.custody2();
  exposed.rotation.newRoot = KEYS.vrk; exposed.rotation.intent.operation = "99".repeat(16);
  assert.deepEqual(state.custody2(), valid.custody, "returned custody cannot mutate authority");
});

test("suite2 phases persist before exposure; pending identity/server/root substitutions and generic Leave refuse", async () => {
  const { r, state, record } = await pending2();
  assert.throws(() => state.forgetPairing(), reason("rotation_pending"));
  await assert.rejects(state.stageRotation(root2, await intent2()), reason("rotation_pending"));
  await assert.rejects(state.rotationPhase("seeding"), reason("invalid_rotation_phase"));
  await assert.rejects(state.activateRotation(), reason("invalid_rotation_phase"));
  await assert.rejects(state.retireHistoryRoot("00".repeat(16)), reason("invalid_history_retirement"));
  let release; r.hooks.save = () => new Promise(resolve => { release = resolve; });
  const moving = state.rotationPhase("prepare_unknown");
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.custody2().phase, "draft", "unacknowledged phase stays private");
  const busy = assert.rejects(state.rotationPhase("prepare_unknown"), reason("custody_busy"));
  release(); await moving; r.hooks.save = null; await busy;
  assert.equal(state.custody2().phase, "prepare_unknown");
  await assert.rejects(state.cancelRotationDraft(), reason("rotation_pending"));
  for (const patch of [{ serverUrl: "https://other.example.invalid" }, { vrk: root2 }, { deviceId: "99".repeat(16) }, { deviceSecret: "99".repeat(32) }, { edgeHeaders: [] }]) {
    const x = restored(record), current = await x.open(), before = [...x.entries]; Object.assign(current.data, patch);
    await assert.rejects(current.save(), StateStorageError); assert.deepEqual([...x.entries], before); assert.deepEqual(x.metadata(), record.metadata);
  }
  const x = restored(record), current = await x.open(); current.data.lastSeq = 9; await current.save();
  assert.equal(x.metadata().lastSeq, 9); assert.equal(x.metadata().credentialRevision, record.metadata.credentialRevision);
});

test("suite2 explicit draft cancellation restores only prior authority; completed rotation keeps one history-only root", async () => {
  for (const priorSuite of [1, 2]) {
    const r = backing(priorSuite === 1 ? legacy() : null), state = await r.open(); if (priorSuite === 2) { await state.stageEnrollment2(KEYS.vrk, "pair"); await state.adoptSuite2(await enrollment2()); }
    await state.stageRotation(root2, { ...await intent2(), targetDeviceId: null });
    const restarted = await r.open(); await restarted.cancelRotationDraft();
    assert.equal(r.metadata().storageVersion, priorSuite); assert.equal(restarted.data.vrk, KEYS.vrk);
    assert.equal(restarted.custody2()?.generation ?? null, priorSuite === 1 ? null : await generationOf(KEYS.vrk));
    assert.equal((await r.open()).data.vrk, KEYS.vrk);
  }
  const { r, state } = await pending2("commit_unknown"); await state.activateRotation();
  const active = state.custody2(); assert.equal(state.data.vrk, root2); assert.equal(active.phase, "active"); assert.equal(active.rotation, null);
  assert.deepEqual(active.history, { root: KEYS.vrk, generation: await generationOf(KEYS.vrk), suite: 1 });
  assert.deepEqual((await r.open()).custody2(), active);
  await assert.rejects(state.stageRotation("cd".repeat(32), await intent2()), reason("rotation_pending"));
  const metadataText = JSON.stringify(r.metadata());
  for (const sentinel of [KEYS.vrk, root2, KEYS.deviceSecret, "LOCAL TOKEN SENTINEL", "newRoot", "history", "custody"]) assert.equal(metadataText.includes(sentinel), false, sentinel);
  await assert.rejects(state.retireHistoryRoot(active.generation), reason("invalid_history_retirement"));
  await state.retireHistoryRoot(active.history.generation);
  assert.equal((await r.open()).custody2().history, null);
  await assert.rejects(state.retireHistoryRoot(undefined), reason("invalid_history_retirement"));
  await state.stageRotation("cd".repeat(32), { ...await intent2(), oldGeneration: await generationOf(root2), newGeneration: await generationOf("cd".repeat(32)), recoveryVerifier: (await accountRecovery("cd".repeat(32))).verifier });
  assert.equal(state.custody2().phase, "draft", "explicitly preserved old backup permits the next bounded rotation");
});

test("suite2 torn save fails stopped without previous-revision recovery; exact acknowledged bytes reload", async () => {
  for (const fault of ["set", "readback", "metadata", "lost-ack"]) {
    const { r, state, record } = await pending2();
    if (fault === "set") r.hooks.set = () => { throw new Error("synthetic disk full"); };
    if (fault === "readback") { let reads = 0; r.hooks.get = id => ++reads === 1 ? r.entries.get(id) : "synthetic wrong readback"; }
    if (fault === "metadata") r.hooks.save = async () => { throw new Error("synthetic disk full"); };
    if (fault === "lost-ack") r.hooks.save = async snapshot => { r.replaceMetadata(snapshot); throw new Error("synthetic lost acknowledgement"); };
    await assert.rejects(state.rotationPhase("prepare_unknown"), StateStorageError);
    assert.equal(state.custody2().phase, "draft"); assert.equal(state.paired, false); assert.throws(() => state.assertAvailable(), StateStorageError);
    assert.equal(state.data.vrk, KEYS.vrk); r.hooks.set = r.hooks.get = r.hooks.save = null;
    if (fault === "set") assert.equal((await r.open()).custody2().phase, "draft");
    else if (fault === "lost-ack") assert.equal((await r.open()).custody2().phase, "prepare_unknown");
    else { const before = r.metadata(), secret = [...r.entries]; await assert.rejects(r.open(), StateStorageError); assert.deepEqual(r.metadata(), before); assert.deepEqual([...r.entries], secret); }
    assert.equal(JSON.stringify(r.metadata()).includes(root2), false);
    assert.equal(JSON.parse(r.entries.get(record.metadata.credentialRef)).custody.rotation.newRoot, root2);
  }
});

test("suite2 active pin/history binding and failed first adoption/cancellation preserve the stopped transaction", async () => {
  const { r, state } = await pending2("commit_unknown"); await state.activateRotation();
  const record = { metadata: r.metadata(), envelope: r.entries.get(r.metadata().credentialRef) };
  for (const mutate of [e => e.custody.generation = "00".repeat(16), e => e.custody.history.root = root2,
    e => e.custody.history.generation = "00".repeat(16), e => e.custody.history.extra = true, e => delete e.custody.history.suite, e => e.custody.history.suite = 3,
    e => e.custody.history = { root: root2, generation: e.custody.generation, suite: 2 }, e => e.custody.initializeMap = "false", e => e.custody.phase = "draft"]) {
    const x = restored(record), envelope = JSON.parse(record.envelope); mutate(envelope);
    x.entries.set(record.metadata.credentialRef, JSON.stringify(envelope));
    x.replaceMetadata({ ...record.metadata, sealPin: { ...record.metadata.sealPin, generation: envelope.custody.generation, phase: envelope.custody.phase } });
    await assert.rejects(x.open(), StateStorageError);
  }
  for (const operation of ["adopt", "cancel"]) {
    const x = backing(), current = await x.open();
    if (operation === "cancel") {
      await current.stageEnrollment2(KEYS.vrk, "pair"); await current.adoptSuite2(await enrollment2());
      await current.stageRotation(root2, await intent2());
    }
    if (operation === "adopt") await current.stageEnrollment2(KEYS.vrk, "pair");
    const previous = x.metadata(); x.hooks.save = async () => { throw new Error("synthetic disk full"); };
    await assert.rejects(operation === "adopt" ? current.adoptSuite2(await enrollment2()) : current.cancelRotationDraft(), StateStorageError);
    assert.deepEqual(x.metadata(), previous); assert.equal(current.paired, false);
    x.hooks.save = null; await assert.rejects(x.open(), StateStorageError, "torn cross-version or phase cancellation cannot resume either authority");
  }
});

test("suite2 async custody/load derivation rechecks the session lease and externally changed secret", async () => {
  const { record } = await pending2();
  const x = restored(record), lease = { holder: null, writing: Promise.resolve() };
  const old = await State.open(x.store, false, x.secrets, undefined, undefined, lease);
  const moving = old.rotationPhase("prepare_unknown");
  const refused = assert.rejects(moving, StateStorageError);
  const current = await State.open(x.store, false, x.secrets, undefined, undefined, lease);
  await refused;
  assert.equal(current.custody2().phase, "draft"); assert.deepEqual(x.metadata(), record.metadata);
  const y = restored(record); let live = true;
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey");
  subtle.importKey = (...args) => { live = false; return original(...args); };
  try { await assert.rejects(State.open(y.store, false, y.secrets, undefined, () => live), reason("inactive_load")); }
  finally { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; }
  const z = restored(record), selected = await z.open(), before = z.metadata();
  const changed = selected.rotationPhase("prepare_unknown");
  queueMicrotask(() => z.entries.set(record.metadata.credentialRef, "synthetic external write"));
  await assert.rejects(changed, reason("secret_changed"));
  assert.equal(z.entries.get(record.metadata.credentialRef), "synthetic external write"); assert.deepEqual(z.metadata(), before);
});

test("suite2 detached enrollment survives restart and gives initialization authority only to new setup", async () => {
  for (const purpose of ["new", "recover", "pair"]) {
    const r = backing(), state = await r.open(); await state.stageEnrollment2(KEYS.vrk, purpose);
    assert.equal(state.data.vrk, null); assert.equal(state.paired, false); assert.equal(state.custody2().phase, "enrollment");
    const restarted = await r.open(), staged = restarted.stagedEnrollment2();
    assert.deepEqual(staged, { root: KEYS.vrk, purpose, generation: await generationOf(KEYS.vrk) });
    staged.root = root2; assert.equal(restarted.stagedEnrollment2().root, KEYS.vrk);
    assert.throws(() => restarted.forgetPairing(), reason("rotation_pending"));
    await assert.rejects(restarted.stageEnrollment2(root2, purpose), reason("pin_replacement"));
    await assert.rejects(restarted.adoptSuite2({ ...await enrollment2(), purpose: purpose === "new" ? "recover" : "new" }), reason("pin_replacement"));
    await restarted.adoptSuite2({ ...await enrollment2(), purpose });
    assert.equal(restarted.stagedEnrollment2(), null); assert.equal(restarted.custody2().initializeMap, purpose === "new");
    if (purpose === "new") {
      await assert.rejects(restarted.stageRotation(root2, await intent2()), reason("rotation_pending"));
      await assert.rejects(restarted.finishMapInitialization("00".repeat(16)), reason("invalid_map_initialization"));
      const again = await r.open(); assert.equal(again.custody2().initializeMap, true);
      await again.finishMapInitialization(await generationOf(KEYS.vrk));
      assert.equal((await r.open()).custody2().initializeMap, false);
      await assert.rejects(again.stageEnrollment2(KEYS.vrk, "new"), reason("pin_replacement"));
      await assert.rejects(again.adoptSuite2({ ...await enrollment2(), purpose: "new" }), reason("pin_replacement"));
      await assert.rejects(again.finishMapInitialization(await generationOf(KEYS.vrk)), reason("invalid_map_initialization"));
    } else await assert.rejects(restarted.finishMapInitialization(await generationOf(KEYS.vrk)), reason("invalid_map_initialization"));
    for (const sentinel of [KEYS.vrk, KEYS.deviceSecret, "LOCAL TOKEN SENTINEL", "initializeMap", "enrollment"]) assert.equal(JSON.stringify(r.metadata()).includes(sentinel), false);
  }
  const r = backing({ deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret }), state = await r.open();
  await state.stageEnrollment2(KEYS.vrk, "pair");
  await assert.rejects(state.adoptSuite2({ ...await enrollment2(), deviceSecret: "99".repeat(32) }), reason("pin_replacement"));
  await state.adoptSuite2(await enrollment2()); assert.equal(state.paired, true);
  for (const purpose of ["new", "recover"]) {
    const x = backing({ deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret }), pending = await x.open();
    await assert.rejects(pending.stageEnrollment2(KEYS.vrk, purpose), StateStorageError);
  }
});

test("suite2 enrollment schema, same-root retry, held-root replacement and unknown matched phase refuse safely", async () => {
  const r = backing(), state = await r.open(); await state.stageEnrollment2(KEYS.vrk, "recover");
  await assert.rejects(state.stageEnrollment2("BAD", "recover"), StateStorageError);
  const record = { metadata: r.metadata(), envelope: r.entries.get(r.metadata().credentialRef) }, valid = JSON.parse(record.envelope);
  const mutations = [e => e.custody.enrollment.extra = true, e => e.custody.enrollment.root = root2,
    e => e.custody.enrollment.purpose = "unknown", e => e.custody.initializeMap = true, e => e.custody.initializeMap = "false",
    e => e.custody.phase = "active", e => e.custody.rotation = { newRoot: root2, intent: {}, fromSuite: 1 }];
  for (const mutate of mutations) {
    const x = restored(record), envelope = clone(valid); mutate(envelope); x.entries.set(record.metadata.credentialRef, JSON.stringify(envelope));
    x.replaceMetadata({ ...record.metadata, sealPin: { ...record.metadata.sealPin, phase: envelope.custody.phase } });
    await assert.rejects(x.open(), StateStorageError); assert.equal(x.writes.length, 0);
  }
  const { record: rotating } = await pending2(), x = restored(rotating), envelope = JSON.parse(rotating.envelope); envelope.custody.phase = "unknown";
  x.entries.set(rotating.metadata.credentialRef, JSON.stringify(envelope)); x.replaceMetadata({ ...rotating.metadata, sealPin: { ...rotating.metadata.sealPin, phase: "unknown" } });
  await assert.rejects(x.open(), StateStorageError, "unknown matching phase still refuses");
  const restarted = await r.open(), revision = r.metadata().credentialRevision; await restarted.stageEnrollment2(KEYS.vrk, "recover");
  assert.equal(r.metadata().credentialRevision, revision, "identical enrollment retries retain exact secret revision");
  const held = backing({ vrk: KEYS.vrk }), unpaired = await held.open();
  await assert.rejects(unpaired.stageEnrollment2(root2, "recover"), reason("pin_replacement"));
  await assert.rejects(unpaired.stageEnrollment2(KEYS.vrk, "new"), reason("pin_replacement"));
  await unpaired.stageEnrollment2(KEYS.vrk, "recover");
  const y = backing(), concurrent = await y.open();
  const attempts = await Promise.allSettled([concurrent.stageEnrollment2(KEYS.vrk, "recover"), concurrent.stageEnrollment2(root2, "recover")]);
  assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1, "concurrent detached roots cannot overwrite one another");
});

const preparedReceipt = (inventoryHeads = 257) => ({ cutoff: 9, inventoryHash: "91".repeat(32), inventoryHeads });
const commitReceipt = (catalogPages = 2) => ({ catalogPages, catalogHash: "92".repeat(32) });

test("rotation receipts bind exact phase, counts and immutable restart scope", async () => {
  const { r, state } = await pending2("prepare_unknown");
  const priorMetadata = r.metadata(), priorSecret = [...r.entries];
  await assert.rejects(state.rotationPhase("prepared"), reason("invalid_rotation_phase"));
  await assert.rejects(state.markRotationCommit(commitReceipt()), reason("invalid_rotation_phase"));
  for (const patch of [{ cutoff: -1 }, { cutoff: 1.5 }, { cutoff: Number.MAX_SAFE_INTEGER + 1 }, { inventoryHash: "91".repeat(31) },
    { inventoryHash: "AF".repeat(32) }, { inventoryHeads: -1 }, { inventoryHeads: 65537 }, { inventoryHeads: 0.5 }, { extra: true }]) {
    await assert.rejects(state.markRotationPrepared({ ...preparedReceipt(), ...patch }), StateStorageError);
    assert.deepEqual(r.metadata(), priorMetadata); assert.deepEqual([...r.entries], priorSecret);
  }
  const input = preparedReceipt(), moving = state.markRotationPrepared(input); input.cutoff = 50;
  await moving; assert.deepEqual(state.custody2().rotation.prepared, preparedReceipt(), "receipt captured before async key validation");
  let revision = r.metadata().credentialRevision;
  await state.markRotationPrepared({ inventoryHeads: 257, inventoryHash: "91".repeat(32), cutoff: 9 });
  assert.equal(r.metadata().credentialRevision, revision, "same receipt retry does not invent a revision");
  await assert.rejects(state.markRotationPrepared({ ...preparedReceipt(), cutoff: 10 }), reason("invalid_rotation_phase"));
  const restarted = await r.open(); assert.deepEqual(restarted.custody2().rotation.prepared, preparedReceipt());
  await restarted.rotationPhase("seeding");
  await assert.rejects(restarted.rotationPhase("commit_unknown"), reason("invalid_rotation_phase"));
  for (const patch of [{ catalogPages: 0 }, { catalogPages: 1 }, { catalogPages: 258 }, { catalogPages: 1.5 },
    { catalogPages: Number.MAX_SAFE_INTEGER + 1 }, { catalogHash: "BAD" }, { catalogHash: "AF".repeat(32) }, { extra: true }]) {
    await assert.rejects(restarted.markRotationCommit({ ...commitReceipt(), ...patch }), StateStorageError);
    assert.equal(restarted.custody2().phase, "seeding");
  }
  const commit = commitReceipt(), saved = restarted.markRotationCommit(commit); commit.catalogHash = "00".repeat(32);
  await saved; assert.deepEqual(restarted.custody2().rotation.commit, commitReceipt());
  revision = r.metadata().credentialRevision;
  await restarted.markRotationCommit({ catalogHash: "92".repeat(32), catalogPages: 2 });
  await restarted.markRotationPrepared(preparedReceipt());
  assert.equal(r.metadata().credentialRevision, revision);
  await assert.rejects(restarted.markRotationCommit({ ...commitReceipt(), catalogHash: "93".repeat(32) }), reason("invalid_rotation_phase"));
  const again = await r.open(); assert.deepEqual(again.custody2().rotation, restarted.custody2().rotation);
  const exposed = again.custody2(); exposed.rotation.prepared.cutoff = 60; exposed.rotation.commit.catalogPages = 50;
  assert.deepEqual(again.custody2().rotation.prepared, preparedReceipt()); assert.deepEqual(again.custody2().rotation.commit, commitReceipt());
  for (const count of [0, 1, 65536]) {
    const { state: current } = await pending2("prepare_unknown"); await current.markRotationPrepared(preparedReceipt(count)); await current.rotationPhase("seeding");
    if (count === 0) await assert.rejects(current.markRotationCommit(commitReceipt(1)), StateStorageError);
    await current.markRotationCommit(commitReceipt(Math.ceil(count / 256)));
    assert.equal(current.custody2().rotation.commit.catalogPages, Math.ceil(count / 256));
  }
});

test("matched rotation metadata cannot authorize absent, extra or wrong-phase receipts", async () => {
  for (const phase of ["draft", "prepare_unknown", "prepared", "seeding", "commit_unknown"]) {
    const { record } = await pending2(phase);
    const changes = [e => delete e.custody.rotation.prepared, e => delete e.custody.rotation.commit,
      e => e.custody.rotation.prepared = { ...preparedReceipt(), extra: true }, e => e.custody.rotation.commit = { ...commitReceipt(), extra: true }];
    if (["draft", "prepare_unknown"].includes(phase)) changes.push(e => e.custody.rotation.prepared = preparedReceipt());
    else changes.push(e => e.custody.rotation.prepared = null, e => e.custody.rotation.prepared.cutoff = -1,
      e => e.custody.rotation.prepared.inventoryHash = "BAD", e => e.custody.rotation.prepared.inventoryHeads = 65537);
    if (phase === "commit_unknown") changes.push(e => e.custody.rotation.commit = null, e => e.custody.rotation.commit.catalogPages = 0,
      e => e.custody.rotation.commit.catalogHash = "BAD");
    else changes.push(e => e.custody.rotation.commit = commitReceipt());
    for (const change of changes) {
      const x = restored(record), envelope = JSON.parse(record.envelope); change(envelope);
      const bytes = JSON.stringify(envelope); x.entries.set(record.metadata.credentialRef, bytes);
      await assert.rejects(x.open(), StateStorageError, phase); assert.equal(x.entries.get(record.metadata.credentialRef), bytes);
      assert.deepEqual(x.metadata(), record.metadata); assert.equal(x.writes.length, 0);
    }
  }
});

test("rotation receipts remain private until metadata acknowledgment and torn saves never choose server scope", async () => {
  for (const mark of ["prepared", "commit"]) {
    const { r, state, record } = await pending2(mark === "prepared" ? "prepare_unknown" : "seeding");
    const before = state.custody2(); let release;
    r.hooks.save = () => new Promise(resolve => release = resolve);
    const moving = mark === "prepared" ? state.markRotationPrepared(preparedReceipt()) : state.markRotationCommit(commitReceipt(1));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(state.custody2(), before); release(); await moving; r.hooks.save = null;
    assert.notDeepEqual(state.custody2(), before);
    const x = restored(record), stopped = await x.open(); x.hooks.save = async () => { throw new Error("synthetic receipt write fault"); };
    await assert.rejects(mark === "prepared" ? stopped.markRotationPrepared(preparedReceipt()) : stopped.markRotationCommit(commitReceipt(1)), StateStorageError);
    assert.deepEqual(stopped.custody2(), before); assert.throws(() => stopped.assertAvailable());
    await assert.rejects(mark === "prepared" ? stopped.markRotationPrepared(preparedReceipt()) : stopped.markRotationCommit(commitReceipt(1)), StateStorageError);
    x.hooks.save = null; await assert.rejects(x.open(), StateStorageError); assert.deepEqual(x.metadata(), record.metadata);
  }
});

const syncReset = { lastSeq: 0, files: {}, folders: {}, retiredRoots: {}, folderBarriers: [], folderRemovals: {},
  parked: {}, paused: {}, departed: {}, replaying: null, heldDeletions: [], feedMark: null, graves: {}, remoteOnly: {} };
function oldCatalog(state) {
  for (const [key, empty] of Object.entries(syncReset)) state.data[key] = key === "lastSeq" ? 77 : Array.isArray(empty) ? ["OLD REMOTE ID"] : { "OLD REMOTE ID": "OLD REMOTE BODY" };
  state.data.files = legacy().files;
  state.data.dropped = { "Notes/local.md": "15".repeat(16) };
  state.data.pendingRecase = { from: "Notes/a.md", temp: "Notes/.obsync-case-deadbeef", to: "Notes/A.md" };
  state.data.pendingScope = { folders: ["Local"] };
}
function assertSyncReset(data) { for (const [key, value] of Object.entries(syncReset)) assert.deepEqual(data[key], value, key); }

test("rotation activation atomically persists a fresh catalog but preserves local safety and settings", async () => {
  const { r, state } = await pending2("commit_unknown"); oldCatalog(state); await state.save();
  const local = { dropped: clone(state.data.dropped), pendingRecase: clone(state.data.pendingRecase), pendingScope: clone(state.data.pendingScope), syncFolders: clone(state.data.syncFolders) };
  const old = clone(state.data), prior = state.custody2(); let release, staged;
  r.hooks.save = snapshot => { staged = clone(snapshot); return new Promise(resolve => release = resolve); };
  const moving = state.activateRotation(); while (!release) await new Promise(resolve => setImmediate(resolve));
  assertSyncReset(staged); assert.equal(staged.sealPin.generation, prior.generation);
  for (const key of Object.keys(syncReset)) assert.deepEqual(state.data[key], old[key], "old catalog remains until durable acknowledgement: " + key);
  assert.deepEqual(state.custody2(), prior); release(); await moving; r.hooks.save = null;
  assertSyncReset(state.data); assert.equal(JSON.stringify(r.metadata()).includes("OLD REMOTE"), false);
  for (const [key, value] of Object.entries(local)) assert.deepEqual(state.data[key], value, key);
  const again = await r.open(); assertSyncReset(again.data); assert.equal(again.data.vrk, root2);
  assert.equal(again.data.deviceId, KEYS.deviceId); assert.equal(again.data.deviceSecret, KEYS.deviceSecret);
  assert.equal(again.data.serverUrl, legacy().serverUrl); assert.deepEqual(again.data.edgeHeaders, legacy().edgeHeaders);
  assert.deepEqual(again.data.dropped, local.dropped); assert.equal(again.custody2().history.root, KEYS.vrk);
});

test("rotation activation write refusal or lost acknowledgment exposes no new pin or cleared old catalog", async () => {
  for (const lost of [false, true]) {
    const { r, state } = await pending2("commit_unknown"); oldCatalog(state); await state.save();
    const old = clone(state.data), prior = state.custody2(), metadata = r.metadata();
    r.hooks.save = async snapshot => { if (lost) r.replaceMetadata(snapshot); throw new Error("synthetic activation fault"); };
    await assert.rejects(state.activateRotation(), StateStorageError); assert.deepEqual(state.custody2(), prior);
    for (const key of Object.keys(syncReset)) assert.deepEqual(state.data[key], old[key], key);
    assert.throws(() => state.assertAvailable()); assert.equal(state.paired, false); r.hooks.save = null;
    if (lost) { const again = await r.open(); assertSyncReset(again.data); assert.equal(again.data.vrk, root2); }
    else { assert.deepEqual(r.metadata(), metadata); await assert.rejects(r.open(), StateStorageError); }
  }
});

test("explicit replacement stages legacy or suite2 authority atomically with suite-tagged history", async () => {
  for (const priorSuite of [1, 2]) {
    const r = backing(priorSuite === 1 ? legacy() : null), state = await r.open();
    if (priorSuite === 2) { await state.stageEnrollment2(KEYS.vrk, "pair"); await state.adoptSuite2(await enrollment2()); }
    oldCatalog(state); await state.save();
    const before = clone(state.data), custodyBefore = state.custody2(), oldGeneration = await generationOf(KEYS.vrk);
    let release, staged; r.hooks.save = snapshot => { staged = clone(snapshot); return new Promise(resolve => release = resolve); };
    const moving = assert.doesNotReject(state.stageReplacementEnrollment2(root2, "pair", oldGeneration));
    let ended = false; moving.then(() => ended = true, () => ended = true);
    while (!release && !ended) await new Promise(resolve => setImmediate(resolve));
    if (ended) await moving;
    assert.deepEqual(state.data, before, "old identity/catalog remains visible until acknowledgment"); assert.deepEqual(state.custody2(), custodyBefore);
    assertSyncReset(staged); assert.equal(staged.deviceId, null); release(); await moving; r.hooks.save = null;
    assertSyncReset(state.data); assert.equal(state.data.vrk, null); assert.equal(state.data.deviceId, null); assert.equal(state.data.deviceSecret, null);
    assert.equal(state.paired, false); assert.deepEqual(state.custody2().history, { root: KEYS.vrk, generation: oldGeneration, suite: priorSuite });
    assert.deepEqual(state.stagedEnrollment2(), { root: root2, generation: await generationOf(root2), purpose: "pair" });
    assert.deepEqual(state.data.dropped, before.dropped); assert.deepEqual(state.data.pendingScope, before.pendingScope);
    assert.equal(state.data.serverUrl, before.serverUrl); assert.deepEqual(state.data.edgeHeaders, before.edgeHeaders);
    const again = await r.open(); assert.deepEqual(again.custody2(), state.custody2()); assertSyncReset(again.data);
    await again.adoptSuite2({ ...await enrollment2(root2), deviceId: "55".repeat(16), deviceSecret: "66".repeat(32) });
    assert.equal(again.custody2().initializeMap, false); assert.equal(again.custody2().history.suite, priorSuite);
    await assert.rejects(again.stageReplacementEnrollment2(KEYS.vrk, "pair", await generationOf(root2)), reason("pin_replacement"));
    for (const marker of [KEYS.vrk, root2, KEYS.deviceSecret, "LOCAL TOKEN SENTINEL", "history", "enrollment"]) assert.equal(JSON.stringify(r.metadata()).includes(marker), false);
  }
});

test("explicit replacement refuses wrong old authority, purpose, pending state and settings substitution", async () => {
  const r = backing(legacy()), state = await r.open(), before = clone(state.data), metadata = r.metadata(), secrets = [...r.entries];
  for (const [root, purpose, expected] of [[root2, "recover", await generationOf(KEYS.vrk)], [root2, "new", await generationOf(KEYS.vrk)],
    [KEYS.vrk, "pair", await generationOf(KEYS.vrk)], [root2, "pair", "00".repeat(16)], ["BAD", "pair", await generationOf(KEYS.vrk)]]) {
    await assert.rejects(state.stageReplacementEnrollment2(root, purpose, expected), root === "BAD" ? StateStorageError : reason("pin_replacement"));
    assert.doesNotThrow(() => state.assertAvailable(), "invalid action is refused before a storage transaction starts");
    assert.deepEqual(state.data, before); assert.deepEqual(r.metadata(), metadata); assert.deepEqual([...r.entries], secrets);
  }
  for (const phase of ["draft", "prepare_unknown", "prepared", "seeding", "commit_unknown"]) {
    const { state: pending } = await pending2(phase);
    await assert.rejects(pending.stageReplacementEnrollment2(root2, "pair", await generationOf(KEYS.vrk)), reason("pin_replacement"));
  }
  const unpaired = await backing({ vrk: KEYS.vrk }).open();
  await assert.rejects(unpaired.stageReplacementEnrollment2(root2, "pair", await generationOf(KEYS.vrk)), reason("pin_replacement"));
  const fresh = backing(), init = await fresh.open(); await init.stageEnrollment2(KEYS.vrk, "new"); await init.adoptSuite2({ ...await enrollment2(), purpose: "new" });
  await assert.rejects(init.stageReplacementEnrollment2(root2, "pair", await generationOf(KEYS.vrk)), reason("pin_replacement"));
  for (const patch of [{ serverUrl: "https://elsewhere.example.invalid" }, { edgeHeaders: [] }]) {
    const x = backing(legacy()), current = await x.open(), oldMetadata = x.metadata(), oldSecret = [...x.entries]; Object.assign(current.data, patch);
    await assert.rejects(current.stageReplacementEnrollment2(root2, "pair", await generationOf(KEYS.vrk)), reason("rotation_identity_changed"));
    assert.deepEqual(x.metadata(), oldMetadata); assert.deepEqual([...x.entries], oldSecret); assert.throws(() => current.assertAvailable());
  }
});

test("explicit replacement storage failures preserve old visible authority and never infer a completed transition", async () => {
  for (const fault of ["secret", "metadata", "lost-ack"]) {
    const r = backing(legacy()), state = await r.open(); oldCatalog(state); await state.save();
    const before = clone(state.data), metadata = r.metadata();
    if (fault === "secret") r.hooks.set = () => { throw new Error("synthetic secret write fault"); };
    else r.hooks.save = async snapshot => { if (fault === "lost-ack") r.replaceMetadata(snapshot); throw new Error("synthetic replacement write fault"); };
    await assert.rejects(state.stageReplacementEnrollment2(root2, "pair", await generationOf(KEYS.vrk)), StateStorageError);
    assert.deepEqual(state.data, before); assert.equal(state.custody2(), null); assert.equal(state.paired, false); assert.throws(() => state.assertAvailable());
    r.hooks.set = r.hooks.save = null;
    if (fault === "secret") { assert.deepEqual(r.metadata(), metadata); assert.equal((await r.open()).data.vrk, KEYS.vrk); }
    else if (fault === "lost-ack") { const again = await r.open(); assertSyncReset(again.data); assert.equal(again.data.vrk, null); assert.equal(again.custody2().history.suite, 1); }
    else { assert.deepEqual(r.metadata(), metadata); await assert.rejects(r.open(), StateStorageError); }
  }
});

test("rotation activation tags history suite without trial decryption or legacy guessing", async () => {
  const r = backing(), state = await r.open(); await state.stageEnrollment2(KEYS.vrk, "pair"); await state.adoptSuite2(await enrollment2());
  await state.stageRotation(root2, await intent2()); await state.rotationPhase("prepare_unknown");
  await state.markRotationPrepared(preparedReceipt(0)); await state.rotationPhase("seeding"); await state.markRotationCommit(commitReceipt(0));
  await state.activateRotation(); assert.equal(state.custody2().history.suite, 2); assert.equal((await r.open()).custody2().history.suite, 2);
});

test("replacement rechecks its held root after asynchronous derivation", async () => {
  const r = backing(legacy()), state = await r.open(), before = r.metadata(), secret = [...r.entries];
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey");
  const expected = await generationOf(KEYS.vrk);
  let changed = false;
  subtle.importKey = (...args) => { if (!changed) { changed = true; state.data.vrk = root2; } return original(...args); };
  try { await assert.rejects(state.stageReplacementEnrollment2(root2, "pair", expected), reason("pin_replacement")); }
  finally { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; }
  assert.equal(changed, true); assert.deepEqual(r.metadata(), before); assert.deepEqual([...r.entries], secret);
});

test("replacement cannot overwrite a rotation acknowledged during its asynchronous derivation", async () => {
  const r = backing(legacy()), state = await r.open(), expected = await generationOf(KEYS.vrk), third = "cd".repeat(32);
  const intent = { ...await intent2(), newGeneration: await generationOf(third), recoveryVerifier: (await accountRecovery(third)).verifier };
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey");
  let changed = false;
  subtle.importKey = (...args) => {
    if (!changed) { changed = true; return state.stageRotation(third, intent).then(() => original(...args)); }
    return original(...args);
  };
  try { await assert.rejects(state.stageReplacementEnrollment2(root2, "pair", expected), reason("pin_replacement")); }
  finally { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; }
  assert.equal(changed, true); assert.equal(state.custody2().phase, "draft"); assert.equal(state.custody2().rotation.newRoot, third);
  assert.equal((await r.open()).custody2().rotation.newRoot, third); assert.equal(state.data.vrk, KEYS.vrk);
});

const resumeProfile = { name: "Test coordinator", platform: "macos", app_version: "1.1.5" };
const resumeId = "97".repeat(16);
test("rotation resume request is strict, normalized, immutable and durable across restart", async () => {
  const { r, state } = await pending2("prepared"), before = r.metadata(), bytes = [...r.entries];
  for (const [id, profile] of [["BAD", resumeProfile], ["AF".repeat(16), resumeProfile], [resumeId, { ...resumeProfile, extra: true }],
    [resumeId, { ...resumeProfile, name: "" }], [resumeId, { ...resumeProfile, name: "a".repeat(65) }], [resumeId, { ...resumeProfile, name: "a\nb" }],
    [resumeId, { ...resumeProfile, app_version: "x".repeat(33) }], [resumeId, { ...resumeProfile, platform: "unknown" }]]) {
    await assert.rejects(state.stageRotationResume(id, profile), id === "BAD" || id === "AF".repeat(16) ? reason("invalid_rotation_phase") : StateStorageError); assert.deepEqual(r.metadata(), before); assert.deepEqual([...r.entries], bytes);
  }
  await assert.doesNotReject(state.stageRotationResume(resumeId, { ...resumeProfile, name: " Test coordinator ", app_version: " 1.1.5 " }));
  assert.deepEqual(state.custody2().rotation.resume, { id: resumeId, profile: resumeProfile });
  const revision = r.metadata().credentialRevision;
  await state.stageRotationResume(resumeId, { app_version: "1.1.5", platform: "macos", name: "Test coordinator" });
  assert.equal(r.metadata().credentialRevision, revision);
  await assert.rejects(state.stageRotationResume("98".repeat(16), resumeProfile), reason("rotation_identity_changed"));
  await assert.rejects(state.stageRotationResume(resumeId, { ...resumeProfile, app_version: "2.0.0" }), reason("rotation_identity_changed"));
  assert.deepEqual((await r.open()).custody2().rotation.resume, state.custody2().rotation.resume);
  const returned = state.custody2(); returned.rotation.resume.profile.name = "changed";
  assert.equal(state.custody2().rotation.resume.profile.name, resumeProfile.name);
  const { state: draft } = await pending2(); await assert.rejects(draft.stageRotationResume(resumeId, resumeProfile), reason("invalid_rotation_phase"));
  assert.equal(JSON.stringify(r.metadata()).includes("Test coordinator"), false);
});

test("matched pending envelope refuses malformed resume request/profile and draft recovery authority", async () => {
  const { r, state } = await pending2("prepared"); await state.stageRotationResume(resumeId, resumeProfile);
  const record = { metadata: r.metadata(), envelope: r.entries.get(r.metadata().credentialRef) };
  for (const mutate of [e => delete e.custody.rotation.resume, e => e.custody.rotation.resume.extra = true,
    e => e.custody.rotation.resume.id = "BAD", e => e.custody.rotation.resume.profile.extra = true, e => e.custody.rotation.resume.profile.name = " spaced ",
    e => e.custody.rotation.resume.profile.name = "a\nb", e => e.custody.rotation.resume.profile.platform = "unknown", e => e.custody.rotation.resume.profile.app_version = "v".repeat(33),
    e => { e.custody.phase = "draft"; e.custody.rotation.prepared = null; }]) {
    const x = restored(record), envelope = JSON.parse(record.envelope); mutate(envelope); const bytes = JSON.stringify(envelope);
    x.entries.set(record.metadata.credentialRef, bytes); x.replaceMetadata({ ...record.metadata, sealPin: { ...record.metadata.sealPin, phase: envelope.custody.phase } });
    await assert.rejects(x.open(), StateStorageError); assert.equal(x.entries.get(record.metadata.credentialRef), bytes); assert.equal(x.writes.length, 0);
  }
});

test("pending credential adoption binds operation/resume and preserves pin/root/receipts until ACK", async () => {
  const { r, state } = await pending2("prepared"), operation = state.custody2().rotation.intent.operation;
  const credential = { deviceId: "98".repeat(16), deviceSecret: "99".repeat(32) };
  await assert.rejects(state.adoptRotationCredential(operation, resumeId, credential), reason("rotation_identity_changed"));
  assert.doesNotThrow(() => state.assertAvailable(), "missing resume authority is refused before a custody write");
  await state.stageRotationResume(resumeId, resumeProfile);
  for (const [op, id, value] of [["BAD", resumeId, credential], [operation, "BAD", credential], [operation, resumeId, { ...credential, deviceId: "BAD" }],
    [operation, resumeId, { ...credential, deviceSecret: "BAD" }], [operation, resumeId, { ...credential, extra: true }],
    [operation, resumeId, { ...credential, deviceId: state.custody2().rotation.intent.targetDeviceId }]]) {
    await assert.rejects(state.adoptRotationCredential(op, id, value), reason("rotation_identity_changed"));
  }
  for (const patch of [{ serverUrl: "https://changed.example.invalid" }, { edgeHeaders: [] }]) {
    const { r: x, state: changed } = await pending2("prepared"); await changed.stageRotationResume(resumeId, resumeProfile);
    const before = x.metadata(), bytes = [...x.entries]; Object.assign(changed.data, patch);
    await assert.rejects(changed.adoptRotationCredential(operation, resumeId, credential), reason("rotation_identity_changed"));
    assert.deepEqual(x.metadata(), before); assert.deepEqual([...x.entries], bytes);
  }
  const before = state.custody2(), root = state.data.vrk; let release;
  r.hooks.save = () => new Promise(resolve => release = resolve);
  const frozenCredential = { ...credential };
  const saving = assert.doesNotReject(state.adoptRotationCredential(operation, resumeId, credential));
  credential.deviceId = "aa".repeat(16); credential.deviceSecret = "bb".repeat(32);
  let ended = false; saving.then(() => ended = true, () => ended = true);
  while (!release && !ended) await new Promise(resolve => setImmediate(resolve)); if (ended) await saving;
  assert.equal(state.data.deviceId, KEYS.deviceId); assert.deepEqual(state.custody2(), before); release(); await saving; r.hooks.save = null;
  assert.equal(state.data.deviceId, frozenCredential.deviceId); assert.equal(state.data.deviceSecret, frozenCredential.deviceSecret); assert.equal(state.data.vrk, root);
  assert.deepEqual(state.custody2(), before); assert.equal((await r.open()).data.deviceId, frozenCredential.deviceId);
  const { state: unknown } = await pending2("prepare_unknown"); await unknown.stageRotationResume(resumeId, resumeProfile);
  await assert.rejects(unknown.adoptRotationCredential(operation, resumeId, credential), reason("rotation_identity_changed"));
});

const upgradeCredential = { deviceId: "81".repeat(16), deviceSecret: "82".repeat(32) };
test("legacy recovery stages both roots and received credential directly into pending suite2 draft after ACK", async () => {
  for (const held of [null, KEYS.vrk]) {
    const r = backing({ ...legacy(), vrk: held, deviceId: null, deviceSecret: null }), state = await r.open(), prior = clone(state.data);
    let release; r.hooks.save = () => new Promise(resolve => release = resolve);
    const credential = { ...upgradeCredential }, intent = await intent2(), saving = assert.doesNotReject(state.stageLegacyUpgrade(KEYS.vrk, root2, credential, intent));
    credential.deviceSecret = "83".repeat(32); intent.operation = "84".repeat(16);
    let ended = false; saving.then(() => ended = true, () => ended = true);
    while (!release && !ended) await new Promise(resolve => setImmediate(resolve)); if (ended) await saving;
    assert.deepEqual(state.data, prior); assert.equal(state.custody2(), null); release(); await saving; r.hooks.save = null;
    const pending = state.custody2(); assert.equal(pending.phase, "draft"); assert.equal(pending.rotation.fromSuite, 1); assert.equal(pending.rotation.newRoot, root2);
    assert.deepEqual(pending.rotation.intent, await intent2()); assert.equal(pending.rotation.resume, null); assert.equal(pending.initializeMap, false);
    assert.equal(state.data.vrk, KEYS.vrk); assert.equal(state.data.deviceId, upgradeCredential.deviceId); assert.equal(state.data.deviceSecret, upgradeCredential.deviceSecret);
    assert.deepEqual(state.data.files, prior.files, "old catalog remains available solely to stopped rotation reseeding");
    assert.deepEqual((await r.open()).custody2(), pending); assert.throws(() => state.forgetPairing(), reason("rotation_pending"));
    const text = JSON.stringify(r.metadata()); for (const sentinel of [KEYS.vrk, root2, upgradeCredential.deviceSecret, "newRoot", "rotation"]) assert.equal(text.includes(sentinel), false);
  }
});

test("legacy upgrade refuses pinned/paired/different-root authority, invalid grant or nonbinding immutable intent", async () => {
  for (const initial of [legacy(), { ...legacy(), vrk: "ab".repeat(32), deviceId: null, deviceSecret: null }]) {
    const r = backing(initial), state = await r.open(), before = r.metadata(), secret = [...r.entries];
    await assert.rejects(state.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, await intent2()), reason("pin_replacement"));
    assert.deepEqual(r.metadata(), before); assert.deepEqual([...r.entries], secret);
  }
  const r = backing(), state = await r.open(); await state.stageEnrollment2(KEYS.vrk, "pair");
  await assert.rejects(state.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, await intent2()), reason("pin_replacement"));
  const x = backing({ ...legacy(), deviceId: null, deviceSecret: null }), current = await x.open(), before = x.metadata(), secret = [...x.entries];
  for (const [oldRoot, newRoot, credential, intent] of [["BAD", root2, upgradeCredential, await intent2()], [KEYS.vrk, KEYS.vrk, upgradeCredential, await intent2()],
    [KEYS.vrk, root2, { ...upgradeCredential, extra: true }, await intent2()], [KEYS.vrk, root2, { ...upgradeCredential, deviceId: "BAD" }, await intent2()],
    [KEYS.vrk, root2, { ...upgradeCredential, deviceSecret: "BAD" }, await intent2()], [KEYS.vrk, root2, upgradeCredential, null],
    [KEYS.vrk, root2, upgradeCredential, { ...await intent2(), targetDeviceId: upgradeCredential.deviceId }],
    [KEYS.vrk, root2, upgradeCredential, { ...await intent2(), recoveryVerifier: "85".repeat(32) }]]) {
    await assert.rejects(current.stageLegacyUpgrade(oldRoot, newRoot, credential, intent), intent === null || credential.extra || credential.deviceId === "BAD" || credential.deviceSecret === "BAD" || credential.deviceId === intent.targetDeviceId ? reason("pin_replacement") : StateStorageError); assert.deepEqual(x.metadata(), before); assert.deepEqual([...x.entries], secret);
  }
  for (const patch of [{ deviceId: upgradeCredential.deviceId }, { deviceSecret: upgradeCredential.deviceSecret }]) {
    const z = backing({ ...legacy(), deviceId: null, deviceSecret: null }), incomplete = await z.open(); Object.assign(incomplete.data, patch);
    await assert.rejects(incomplete.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, await intent2()), reason("pin_replacement"));
  }
  for (const patch of [{ serverUrl: "https://other.example.invalid" }, { edgeHeaders: [] }]) {
    const z = backing({ ...legacy(), deviceId: null, deviceSecret: null }), changed = await z.open(), prior = z.metadata(), bytes = [...z.entries]; Object.assign(changed.data, patch);
    await assert.rejects(changed.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, await intent2()), reason("rotation_identity_changed"));
    assert.deepEqual(z.metadata(), prior); assert.deepEqual([...z.entries], bytes);
  }
});

test("legacy draft staging storage faults preserve visible prior authority and retain strict pending bytes", async () => {
  for (const lost of [false, true]) {
    const r = backing({ ...legacy(), vrk: null, deviceId: null, deviceSecret: null }), state = await r.open(), prior = clone(state.data), before = r.metadata();
    r.hooks.save = async snapshot => { if (lost) r.replaceMetadata(snapshot); throw new Error("synthetic legacy draft fault"); };
    await assert.rejects(state.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, await intent2()), StateStorageError);
    assert.deepEqual(state.data, prior); assert.equal(state.custody2(), null); assert.throws(() => state.assertAvailable()); r.hooks.save = null;
    if (lost) { const again = await r.open(); assert.equal(again.custody2().phase, "draft"); assert.equal(again.data.vrk, KEYS.vrk); }
    else { assert.deepEqual(r.metadata(), before); await assert.rejects(r.open(), StateStorageError); }
  }
});

test("legacy draft rechecks local root after native validation before any grant adoption", async () => {
  const r = backing({ ...legacy(), vrk: null, deviceId: null, deviceSecret: null }), state = await r.open(), intent = await intent2(), before = r.metadata(), bytes = [...r.entries];
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey"); let changed = false;
  subtle.importKey = (...args) => { if (!changed) { changed = true; state.data.vrk = "ab".repeat(32); } return original(...args); };
  try { await assert.rejects(state.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, intent), reason("pin_replacement")); }
  finally { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; }
  assert.equal(changed, true); assert.deepEqual(r.metadata(), before); assert.deepEqual([...r.entries], bytes); assert.equal(state.data.deviceId, null);
});

test("ordinary suite2 adoption keeps all credential fields private until acknowledgment", async () => {
  const r = backing(), state = await r.open(); await state.stageEnrollment2(KEYS.vrk, "pair");
  let release; r.hooks.save = () => new Promise(resolve => release = resolve);
  const prior = clone(state.data), custodyBefore = state.custody2(), saving = assert.doesNotReject(state.adoptSuite2(await enrollment2()));
  let ended = false; saving.then(() => ended = true, () => ended = true);
  while (!release && !ended) await new Promise(resolve => setImmediate(resolve)); if (ended) await saving;
  assert.deepEqual(state.data, prior); assert.deepEqual(state.custody2(), custodyBefore); assert.equal(state.paired, false);
  release(); await saving; r.hooks.save = null;
  assert.equal(state.data.vrk, KEYS.vrk); assert.equal(state.data.deviceId, KEYS.deviceId); assert.equal(state.paired, true);
  const x = backing(), stopped = await x.open(); await stopped.stageEnrollment2(KEYS.vrk, "pair"); const before = clone(stopped.data);
  x.hooks.save = async () => { throw new Error("synthetic adoption metadata fault"); };
  await assert.rejects(stopped.adoptSuite2(await enrollment2()), StateStorageError); assert.deepEqual(stopped.data, before); assert.throws(() => stopped.assertAvailable());
  x.hooks.save = null; await assert.rejects(x.open(), StateStorageError);
});

test("rotation activation retains old public root before acknowledgment and on save refusal", async () => {
  const { r, state } = await pending2("commit_unknown"), prior = state.data.vrk; let release;
  r.hooks.save = () => new Promise(resolve => release = resolve);
  const saving = assert.doesNotReject(state.activateRotation()); let ended = false; saving.then(() => ended = true, () => ended = true);
  while (!release && !ended) await new Promise(resolve => setImmediate(resolve)); if (ended) await saving;
  assert.equal(state.data.vrk, prior); release(); await saving; r.hooks.save = null; assert.equal(state.data.vrk, root2);
  const { r: x, state: stopped } = await pending2("commit_unknown"); x.hooks.save = async () => { throw new Error("synthetic activation metadata fault"); };
  await assert.rejects(stopped.activateRotation(), StateStorageError); assert.equal(stopped.data.vrk, KEYS.vrk); assert.throws(() => stopped.assertAvailable());
});

test("legacy upgrade private admission cannot overwrite a persisted paired or different-root authority", async () => {
  for (const prior of [legacy(), { ...legacy(), vrk: "ab".repeat(32), deviceId: null, deviceSecret: null }]) {
    const r = backing(prior), state = await r.open(), metadata = r.metadata(), bytes = [...r.entries];
    state.data.vrk = KEYS.vrk; state.data.deviceId = null; state.data.deviceSecret = null;
    await assert.rejects(state.stageLegacyUpgrade(KEYS.vrk, root2, upgradeCredential, await intent2()), reason("rotation_identity_changed"));
    assert.deepEqual(r.metadata(), metadata); assert.deepEqual([...r.entries], bytes);
  }
});
