import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { KEYS } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { State, StateStorageError } = require("../build/state.js");
const clone = (value) => structuredClone(value);
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
    { serverUrl: null }, { vrk: null }, { deviceSecret: null }, { edgeHeaders: [] },
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
  await assert.rejects(State.open(backing().store, false, undefined), /unavailable/);
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
  await assert.rejects(state.save(), /metadata_write_failed/);
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
  await assert.rejects(state.save(), /metadata_write_failed/);
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
  await assert.rejects(r.open(), /identity_mismatch/);
});

test("an inactive load does not migrate or touch the secret store", async () => {
  const r = backing(legacy());
  await assert.rejects(State.open(r.store, false, r.secrets, () => {}, () => false), /inactive_load/);
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
  await assert.rejects(state.save(), /secret_changed/);
  assert.equal(r.entries.get(ref), "externally changed local sentinel");
  assert.equal(r.calls.filter(([operation]) => operation === "set").length, sets);
});

test("exhausted credential revisions fail without changing native or metadata stores", async () => {
  const record = await persisted(), envelope = JSON.parse(record.envelope);
  envelope.current.revision = record.metadata.credentialRevision = Number.MAX_SAFE_INTEGER;
  record.envelope = JSON.stringify(envelope);
  const r = restored(record), state = await r.open();
  state.data.vrk = "ab".repeat(32);
  await assert.rejects(state.save(), /revision_exhausted/);
  assert.equal(r.entries.get(record.metadata.credentialRef), record.envelope);
  assert.deepEqual(r.metadata(), record.metadata);
});
