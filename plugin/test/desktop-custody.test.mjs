import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KEYS } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { State, StateStorageError } = require("../build/state.js");
const { desktopSecretStore, DESKTOP_CUSTODY_PREFIX } = require("../build/desktopCustody.js");
const { deriveDomainMapKey, domainMapIds, unhex } = require("../build/crypto.js");
const reason = code => error => error instanceof StateStorageError && error.reason === code;
const legacy = () => ({ vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
  serverUrl: "https://sync.example.invalid", edgeHeaders: [{ name: "X-Service", value: "LOCAL EDGE SENTINEL" }] });

// Synthetic native service only: real Node crypto, not a claim about an OS backend.
function fixture(initial = null) {
  let metadata = structuredClone(initial);
  const key = Buffer.alloc(32, 37), entries = new Map(), calls = [], hooks = {}, failures = [];
  const native = {
    available: true, backend: "gnome_libsecret",
    isEncryptionAvailable() { assert.equal(this, native); if (hooks.available) return hooks.available(); return this.available; },
    getSelectedStorageBackend() { assert.equal(this, native); return this.backend; },
    encryptString(value) {
      assert.equal(this, native); calls.push(["encrypt"]); if (hooks.encrypt) return hooks.encrypt(value);
      const iv = randomBytes(16), cipher = createCipheriv("aes-256-cbc", key, iv);
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final()]);
    },
    decryptString(value) {
      assert.equal(this, native); assert.equal(Buffer.isBuffer(value), true); if (hooks.decrypt) return hooks.decrypt(value);
      const decipher = createDecipheriv("aes-256-cbc", key, value.subarray(0, 16));
      return Buffer.concat([decipher.update(value.subarray(16)), decipher.final()]).toString("utf8");
    },
  };
  const validId = id => { if (typeof id !== "string" || id.length > 64 || !/^[a-z0-9-]+$/.test(id)) throw new Error("synthetic host refused secret ID"); };
  const raw = { adapter: { safeStorage: native },
    getSecret(id) { calls.push(["get", id]); return hooks.get ? hooks.get(id, entries.get(id) ?? null) : entries.get(id) ?? null; },
    setSecret(id, value) { validId(id); calls.push(["set", id, value]); if (hooks.set) hooks.set(id, value); entries.set(id, value); },
  };
  const store = {
    loadData: async () => { calls.push(["load"]); return structuredClone(metadata); },
    saveData: async value => { calls.push(["metadata", structuredClone(value)]); if (hooks.save) await hooks.save(value); metadata = structuredClone(value); },
  };
  const wrapped = desktopSecretStore(raw, "macos");
  return { raw, native, wrapped, entries, calls, hooks, store, failures, metadata: () => structuredClone(metadata),
    replace: value => { metadata = structuredClone(value); },
    open: (secrets = wrapped, mobile = false, held) => State.open(store, mobile, secrets, error => failures.push(error.reason), () => true, undefined, held),
  };
}
async function legacyStore(suite2 = false) {
  const r = fixture(suite2 ? null : legacy()); const state = await r.open(r.raw);
  if (suite2) { const generation = (await domainMapIds(await deriveDomainMapKey(unhex(KEYS.vrk)))).fileId;
    await state.stageEnrollment2(KEYS.vrk, "pair"); await state.adoptSuite2({ root: KEYS.vrk, generation,
      deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, purpose: "pair" }); }
  r.calls.length = 0; return r;
}
const writes = r => r.calls.filter(([op]) => op === "set" || op === "metadata");

test("desktop admission refuses absent/throwing/nonboolean capabilities before state read, writes or enrollment", async () => {
  for (const change of [r => r.native.available = false, r => r.native.available = "true", r => r.native.available = 1,
    r => r.hooks.available = () => { throw new Error("private marker"); }, r => delete r.raw.adapter,
    r => delete r.native.encryptString, r => delete r.native.decryptString, r => delete r.native.isEncryptionAvailable]) {
    const r = fixture(legacy()); change(r); let enrollments = 0;
    await assert.rejects(r.open().then(() => enrollments++), reason("desktop_custody_unavailable"));
    assert.equal(enrollments, 0); assert.deepEqual(r.calls, []); assert.deepEqual(r.metadata(), legacy());
  }
  for (const backend of ["basic_text", "unknown", undefined, "kwallet4", "GNOME_LIBSECRET"]) {
    const r = fixture(); r.native.backend = backend;
    await assert.rejects(r.open(desktopSecretStore(r.raw, "linux")), reason("desktop_custody_unavailable")); assert.deepEqual(r.calls, []);
  }
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    const r = fixture(); r.native.backend = backend;
    await assert.doesNotReject(r.open(desktopSecretStore(r.raw, "linux"))); assert.equal(r.metadata().storageVersion, 3);
  }
  const r = fixture(); await assert.rejects(r.open(desktopSecretStore(r.raw, "android")), reason("desktop_custody_unavailable")); assert.deepEqual(r.calls, []);
  delete r.native.getSelectedStorageBackend;
  await assert.rejects(r.open(desktopSecretStore(r.raw, "linux")), reason("desktop_custody_unavailable")); assert.deepEqual(r.calls, []);
});

test("transform failures and direct plaintext writes never reach public storage or metadata", async () => {
  for (const encrypted of [() => { throw new Error("private marker"); }, () => "not bytes", () => new Uint8Array()]) {
    const r = fixture(legacy()); r.hooks.encrypt = encrypted;
    assert.throws(() => r.wrapped.desktopCustody.seal("synthetic"), reason("desktop_custody_encrypt_failed"));
    await assert.rejects(r.open(), reason("desktop_custody_encrypt_failed")); assert.deepEqual(writes(r), []); assert.deepEqual(r.metadata(), legacy());
  }
  const r = fixture(); assert.throws(() => r.wrapped.setSecret("obsync-test", KEYS.vrk), reason("invalid_desktop_envelope")); assert.deepEqual(r.calls, []);
  const cipher = r.wrapped.desktopCustody.seal("synthetic"); r.hooks.decrypt = () => 5;
  assert.throws(() => r.wrapped.desktopCustody.open(cipher), reason("desktop_custody_decrypt_failed"));
  r.hooks.decrypt = () => { throw new Error("private marker"); };
  assert.throws(() => r.wrapped.desktopCustody.open(cipher), reason("desktop_custody_decrypt_failed"));
  for (const value of ["plain", DESKTOP_CUSTODY_PREFIX, DESKTOP_CUSTODY_PREFIX + "YQ", DESKTOP_CUSTODY_PREFIX + "YR==", DESKTOP_CUSTODY_PREFIX + "YQ==\n", DESKTOP_CUSTODY_PREFIX + "===="]) {
    assert.throws(() => r.wrapped.desktopCustody.open(value), reason("invalid_desktop_envelope"));
  }
  const sameLengthWrongPrefix = "x".repeat(DESKTOP_CUSTODY_PREFIX.length) + cipher.slice(DESKTOP_CUSTODY_PREFIX.length);
  assert.throws(() => r.wrapped.desktopCustody.open(sameLengthWrongPrefix), reason("invalid_desktop_envelope"));
  const mobile = fixture(); await assert.rejects(mobile.open(mobile.wrapped, true), reason("invalid_desktop_envelope")); assert.deepEqual(mobile.calls, []);
});

test("encryption lost after admission refuses before any actual public write", async () => {
  const r = fixture(legacy()); let checks = 0;
  r.hooks.available = () => ++checks < 4;
  await assert.rejects(r.open(), reason("desktop_custody_unavailable"));
  assert.ok(checks > 1); assert.deepEqual(writes(r), []); assert.deepEqual(r.metadata(), legacy());
  const duringNative = fixture(legacy());
  duringNative.hooks.encrypt = () => { duringNative.native.available = false; throw new Error("native service disappeared"); };
  await assert.rejects(duringNative.open(), reason("desktop_custody_encrypt_failed"));
  assert.deepEqual(writes(duringNative), []); assert.deepEqual(duringNative.metadata(), legacy());
});

test("native payload bounds refuse before public writes and normal bytes round-trip", () => {
  const r = fixture(), inner = "x".repeat(256 << 10);
  assert.doesNotThrow(() => assert.equal(r.wrapped.desktopCustody.open(r.wrapped.desktopCustody.seal(inner)), inner));
  r.calls.length = 0;
  assert.throws(() => r.wrapped.desktopCustody.seal("x".repeat((16 << 20) + 1)), reason("desktop_custody_encrypt_failed"));
  assert.deepEqual(r.calls, []);
  r.hooks.encrypt = () => new Uint8Array((16 << 20) + 1);
  assert.throws(() => r.wrapped.desktopCustody.seal("small"), reason("desktop_custody_encrypt_failed"));
  assert.deepEqual(writes(r), []);
  assert.throws(() => r.wrapped.desktopCustody.open(DESKTOP_CUSTODY_PREFIX + "A".repeat((16 << 20) * 2 + 4)), reason("invalid_desktop_envelope"));
});

test("encoded envelope budget refuses before allocating decoded bytes", () => {
  const r = fixture(), original = globalThis.Uint8Array; let allocations = 0;
  globalThis.Uint8Array = new Proxy(original, { construct(target, args) { allocations++; return Reflect.construct(target, args); } });
  try {
    assert.throws(() => r.wrapped.desktopCustody.open(DESKTOP_CUSTODY_PREFIX + "A".repeat((16 << 20) * 2 + 4)), reason("invalid_desktop_envelope"));
    assert.equal(allocations, 0, "oversized persisted strings are refused before a decoded allocation");
  } finally { globalThis.Uint8Array = original; }
});

test("decoded envelope budget refuses before invoking native decryption", () => {
  const r = fixture(); let nativeCalls = 0; r.hooks.decrypt = () => { nativeCalls++; return "synthetic"; };
  const oversized = Buffer.alloc((16 << 20) + 1).toString("base64");
  assert.throws(() => r.wrapped.desktopCustody.open(DESKTOP_CUSTODY_PREFIX + oversized), reason("invalid_desktop_envelope"));
  assert.equal(nativeCalls, 0);
});

test("new desktop storage is format3 ciphertext even when the outer host persists its input plainly", async () => {
  const r = fixture(legacy()); let state;
  await assert.doesNotReject(async () => { state = await r.open(); });
  const metadata = r.metadata(), stored = r.entries.get(metadata.credentialRef);
  assert.equal(metadata.storageVersion, 3); assert.equal(metadata.credentialFormat, "native-desktop-v1");
  assert.equal(metadata.credentialEnvelopeVersion, 1); assert.equal(metadata.credentialCleanupPending, false);
  assert.equal(metadata.credentialRef, `obsync-private-sync-v1-${metadata.installationId}-os`);
  assert.equal(metadata.credentialRef.length, 58); assert.equal((metadata.credentialRef + "-claim").length, 64);
  assert.ok(stored.startsWith(DESKTOP_CUSTODY_PREFIX));
  const encryptedAt = r.calls.findIndex(([op]) => op === "encrypt"), publicAt = r.calls.findIndex(([op]) => op === "set");
  assert.ok(encryptedAt >= 0 && publicAt > encryptedAt, "actual native encryption precedes the public write");
  for (const sentinel of [KEYS.vrk, KEYS.deviceSecret, "LOCAL EDGE SENTINEL"]) {
    assert.equal(stored.includes(sentinel), false); assert.equal(JSON.stringify(metadata).includes(sentinel), false);
  }
  assert.deepEqual(JSON.parse(r.wrapped.desktopCustody.open(stored)).current.vrk, KEYS.vrk);
  assert.equal((await r.open()).data.vrk, state.data.vrk);
  const metaCount = writes(r).length; state.data.lastSeq++; await state.save();
  assert.equal(r.entries.get(metadata.credentialRef), stored, "bookkeeping does not re-encrypt physical secret bytes");
  assert.equal(writes(r).length, metaCount + 1);
});

test("public writes obey the actual host's lowercase token and 64-character ceiling", () => {
  const r = fixture(), accepted = "a".repeat(64);
  r.raw.setSecret(accepted, "synthetic"); assert.equal(r.raw.getSecret(accepted), "synthetic");
  for (const id of ["a".repeat(65), "A", "with space", ""]) {
    assert.throws(() => r.raw.setSecret(id, "synthetic")); assert.equal(r.raw.getSecret(id), null, "no invented public-get ID validation");
  }
});

test("validated legacy envelopes and claims wrap before ACK and exact old-entry cleanup", async () => {
  for (const suite2 of [false, true]) {
    const r = await legacyStore(suite2), old = r.metadata(), oldBytes = r.entries.get(old.credentialRef);
    const claim = '{"legacy":"CLAIM SENTINEL"}'; r.entries.set(old.credentialRef + "-claim", claim);
    let state; await assert.doesNotReject(async () => { state = await r.open(); });
    const meta = r.metadata(), stored = r.entries.get(meta.credentialRef);
    assert.equal(meta.credentialEnvelopeVersion, suite2 ? 2 : 1); assert.equal(meta.credentialCleanupPending, false);
    assert.equal(meta.credentialRevision, old.credentialRevision); assert.equal(state.data.vrk, KEYS.vrk);
    assert.equal(r.wrapped.desktopCustody.open(stored), JSON.stringify(JSON.parse(oldBytes)));
    assert.equal(state.heldClaim(), claim); assert.ok(r.entries.get(meta.credentialRef + "-claim").startsWith(DESKTOP_CUSTODY_PREFIX));
    assert.equal(r.entries.get(old.credentialRef), ""); assert.equal(r.entries.get(old.credentialRef + "-claim"), "");
    const sequence = writes(r), ack = sequence.findIndex(([op, data]) => op === "metadata" && data.credentialCleanupPending === true);
    const clear = sequence.findIndex(([op, id, value]) => op === "set" && id === old.credentialRef && value === "");
    assert.ok(ack >= 0 && clear > ack); assert.equal(sequence.at(-1)[1].credentialCleanupPending, false);
    assert.ok(sequence.filter(([op]) => op === "set").every(([, id]) => [old.credentialRef, old.credentialRef + "-claim", meta.credentialRef, meta.credentialRef + "-claim"].includes(id)));
  }
});

test("a lone wrapper marker cannot be ignored as fresh legacy metadata", async () => {
  for (const metadata of [{ credentialFormat: "native-desktop-v1" }, { credentialEnvelopeVersion: 2 }, { credentialCleanupPending: false }]) {
    const r = fixture(metadata); await assert.rejects(r.open(), reason("invalid_metadata")); assert.deepEqual(writes(r), []);
  }
});

test("every migration crash boundary preserves authority and resumes exactly after reload", async () => {
  for (const fault of ["claim-write", "claim-readback", "new-write", "new-readback", "metadata", "lost-metadata-ack", "old-clear", "old-readback", "claim-clear", "final-metadata", "lost-final-ack"]) {
    const r = await legacyStore(true), original = r.metadata(), old = original.credentialRef, next = old + "-os";
    r.entries.set(old + "-claim", "CLAIM SENTINEL"); let used = false;
    r.hooks.set = (id, value) => {
      if (!used && ((fault === "claim-write" && id === next + "-claim") || (fault === "new-write" && id === next) ||
        (fault === "old-clear" && id === old && value === "") || (fault === "claim-clear" && id === old + "-claim" && value === ""))) { used = true; throw new Error("synthetic interrupted write"); }
    };
    r.hooks.get = (id, value) => {
      if (!used && ((fault === "new-readback" && id === next && value !== null) || (fault === "claim-readback" && id === next + "-claim" && value !== null) ||
        (fault === "old-readback" && id === old && value === ""))) { used = true; return "wrong readback"; } return value;
    };
    r.hooks.save = async value => {
      const target = value.credentialCleanupPending ? ["metadata", "lost-metadata-ack"] : ["final-metadata", "lost-final-ack"];
      if (!used && target.includes(fault)) { used = true; if (fault.startsWith("lost")) r.replace(value); throw new Error("synthetic interrupted ACK"); }
    };
    await assert.rejects(r.open(), error => error instanceof StateStorageError &&
      (!fault.includes("readback") || error.reason === "secret_readback_failed") && !error.message.includes("nothing was sent or changed") &&
      error.message.includes("local notes are unchanged"), fault); assert.equal(used, true, fault);
    assert.equal(r.failures.length, 1, "one observable refusal at " + fault);
    r.hooks.set = r.hooks.get = r.hooks.save = null;
    const state = await r.open(); assert.equal(state.data.vrk, KEYS.vrk, fault); assert.equal(state.custody2().phase, "active", fault);
    assert.equal(r.metadata().credentialCleanupPending, false, fault); assert.equal(r.entries.get(old), "", fault); assert.equal(r.entries.get(old + "-claim"), "", fault);
    const again = await r.open(); assert.equal(again.data.deviceSecret, KEYS.deviceSecret, fault);
  }
});

test("a corrupt/different pre-ACK candidate is preserved instead of overwritten", async () => {
  for (const wrong of ["corrupt", "different"]) {
    const r = await legacyStore(), before = r.metadata(), oldBytes = r.entries.get(before.credentialRef), next = before.credentialRef + "-os";
    const value = wrong === "corrupt" ? "damaged" : r.wrapped.desktopCustody.seal(JSON.stringify({ ...JSON.parse(oldBytes), installationId: "ff".repeat(16) }));
    r.entries.set(next, value); r.calls.length = 0;
    await assert.rejects(r.open(), StateStorageError); assert.deepEqual(writes(r), []); assert.equal(r.entries.get(next), value); assert.equal(r.entries.get(before.credentialRef), oldBytes);
    await assert.rejects(r.open(), StateStorageError); assert.deepEqual(writes(r), []);
  }
  const r = await legacyStore(), old = r.metadata().credentialRef;
  r.entries.set(old + "-claim", "OLD CLAIM");
  r.entries.set(old + "-os-claim", r.wrapped.desktopCustody.seal("DIFFERENT CLAIM")); r.calls.length = 0;
  await assert.rejects(r.open(), reason("secret_changed")); assert.deepEqual(writes(r), []);
});

test("physical wrapped candidate changed after ACK prevents old-root cleanup", async () => {
  const r = await legacyStore(true), before = r.metadata(), prior = r.entries.get(before.credentialRef);
  r.hooks.save = async metadata => {
    if (metadata.credentialCleanupPending) {
      const raw = r.entries.get(metadata.credentialRef);
      r.entries.set(metadata.credentialRef, r.wrapped.desktopCustody.seal(r.wrapped.desktopCustody.open(raw)));
    }
  };
  await assert.rejects(r.open(), reason("secret_changed"));
  assert.equal(r.entries.get(before.credentialRef), prior, "plaintext authority was not cleared after a concurrent candidate write");
});

test("cleanup marker cannot conceal plaintext residue or authorize deleting a different authority", async () => {
  for (const pending of [false, true]) {
    const r = await legacyStore(true), old = r.metadata().credentialRef; await r.open();
    const metadata = r.metadata(), inner = JSON.parse(r.wrapped.desktopCustody.open(r.entries.get(metadata.credentialRef)));
    inner.current.deviceId = "ab".repeat(16); r.entries.set(old, JSON.stringify(inner)); r.replace({ ...metadata, credentialCleanupPending: pending }); r.calls.length = 0;
    await assert.rejects(r.open(), reason("desktop_cleanup_mismatch")); assert.deepEqual(writes(r), []); assert.notEqual(r.entries.get(old), "");
  }
  const r = await legacyStore(true), old = r.metadata().credentialRef;
  r.entries.set(old + "-claim", "ORIGINAL CLAIM"); await r.open();
  r.entries.set(old + "-claim", "SUBSTITUTED CLAIM"); r.replace({ ...r.metadata(), credentialCleanupPending: true }); r.calls.length = 0;
  await assert.rejects(r.open(), reason("desktop_cleanup_mismatch")); assert.deepEqual(writes(r), []);
  assert.equal(r.entries.get(old + "-claim"), "SUBSTITUTED CLAIM");
});

test("wrapped missing/raw/stale/pin-substituted bytes refuse without downgrade, overwrite or mobile adoption", async () => {
  for (const mutate of [r => r.entries.delete(r.metadata().credentialRef),
    r => r.entries.set(r.metadata().credentialRef, r.wrapped.desktopCustody.open(r.entries.get(r.metadata().credentialRef))),
    r => r.replace({ ...r.metadata(), credentialRevision: r.metadata().credentialRevision + 1 }),
    r => r.replace({ ...r.metadata(), credentialEnvelopeVersion: 1 }),
    r => r.replace({ ...r.metadata(), credentialFormat: "unknown" }),
    r => r.replace({ ...r.metadata(), sealPin: { ...r.metadata().sealPin, generation: "aa".repeat(16) } }),
    r => r.replace({ ...r.metadata(), credentialCleanupPending: "false" }),
    r => { const m = r.metadata(), e = JSON.parse(r.wrapped.desktopCustody.open(r.entries.get(m.credentialRef))); e.custody.enrollment = { root: "aa".repeat(32), purpose: "pair" }; r.entries.set(m.credentialRef, r.wrapped.desktopCustody.seal(JSON.stringify(e))); }]) {
    const r = await legacyStore(true); await r.open(); mutate(r); const snapshot = [...r.entries]; r.calls.length = 0;
    await assert.rejects(r.open(), StateStorageError); assert.deepEqual(writes(r), []); assert.deepEqual([...r.entries], snapshot);
  }
  const r = await legacyStore(true); await r.open(); r.calls.length = 0;
  await assert.rejects(r.open(r.raw, true), reason("invalid_desktop_envelope")); await assert.rejects(r.open(r.raw), reason("invalid_desktop_envelope"));
  await assert.rejects(r.open(r.wrapped, true), reason("invalid_desktop_envelope")); assert.deepEqual(writes(r), []);
});

test("ambiguous legacy desktop migration refuses instead of stranding plaintext under a previous installation", async () => {
  for (const kind of ["lost-revision", "missing-main-with-claim"]) {
    const r = await legacyStore(), before = r.metadata();
    if (kind === "lost-revision") r.replace({ ...before, credentialRevision: before.credentialRevision + 1 });
    else { r.entries.delete(before.credentialRef); r.entries.set(before.credentialRef + "-claim", "LEGACY CLAIM SENTINEL"); }
    const snapshot = [...r.entries], metadata = r.metadata(); r.calls.length = 0; let adoption = 0;
    await assert.rejects(r.open(r.wrapped, false, { holds: () => false, hold: () => {} }).then(() => adoption++), error => reason("desktop_legacy_inconsistent")(error) &&
      error.message.includes("saved bytes are unchanged") && error.message.includes("fresh vault"));
    assert.equal(adoption, 0); assert.deepEqual(writes(r), []); assert.deepEqual([...r.entries], snapshot); assert.deepEqual(r.metadata(), metadata);
  }
  const r = await legacyStore(), prior = r.metadata(); r.entries.delete(prior.credentialRef); r.calls.length = 0;
  const held = { holds: () => false, hold: () => {} };
  const copy = await State.open(r.store, false, r.wrapped, () => {}, () => true, undefined, held);
  assert.equal(copy.copied, true); assert.equal(copy.data.vrk, null); assert.equal(copy.data.deviceId, null); assert.deepEqual(writes(r), []);
  await copy.save(); assert.equal(r.metadata().storageVersion, 3); assert.equal(r.metadata().credentialEnvelopeVersion, 1);
});

test("all secondary desktop writers wrap and concurrent checks compare physical ciphertext", async () => {
  const r = await legacyStore(), state = await r.open(), ref = r.metadata().credentialRef;
  assert.equal(state.holdClaim("CLAIM SENTINEL"), true); assert.equal(state.heldClaim(), "CLAIM SENTINEL");
  assert.ok(r.entries.get(ref + "-claim").startsWith(DESKTOP_CUSTODY_PREFIX)); assert.equal(state.holdClaim(null), true);
  state.forgetPairing(); await state.save(); await assert.doesNotReject(state.forgetPreviousCredential());
  assert.equal(JSON.parse(r.wrapped.desktopCustody.open(r.entries.get(ref))).previous, null);
  const samePlain = r.wrapped.desktopCustody.open(r.entries.get(ref)); r.entries.set(ref, r.wrapped.desktopCustody.seal(samePlain)); r.calls.length = 0;
  await assert.rejects(state.save(), reason("secret_changed")); assert.deepEqual(writes(r), []);
});
