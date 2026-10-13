/** Live suite2 pairing codecs; published GCM vectors remain explicit legacy tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), p = require("../build/pairing.js"), c = require("../build/crypto.js"), s = require("../build/seal2.js");
const id = "12".repeat(16), root = "34".repeat(32), ps = new Uint8Array(16).fill(56);
const generation = (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(root)))).fileId;
const payload = { v: 2, vrk: root, generation }, details = { name: "Test recipient", notes: 7 };
const creator = await p.newPairingKeyExchange(), claimant = await p.newPairingKeyExchange(), stranger = await p.newPairingKeyExchange();
const raw = text => p.checkedPublicKey(text);
const context = { pairingId: id, claimantPublic: raw(claimant.publicKey), creatorPublic: raw(creator.publicKey) };
const base = await c.derivePairingV2Key(creator.pair, await c.importPairingPublicKey(raw(claimant.publicKey)), ps, id);
const rootPacket = async bytes => ({ seal_suite: 2, envelope: c.base64(await s.sealPairing(base, 4, context, bytes)) });
const detailsBase = await c.hkdf(ps, c.utf8("obsync/v1/pair-vault"), c.utf8(id), 32);
const detailsPacket = async bytes => ({ seal_suite: 2, envelope: c.base64(await s.sealPairing(detailsBase, 5, { pairingId: id }, bytes)) });

async function succeeds(promise) {
  let result; await assert.doesNotReject(async () => { result = await promise; }); return result;
}

test("suite2 root/details packets are deterministic, kind-separated and use no legacy nonce or RNG", async t => {
  const random = crypto.getRandomValues.bind(crypto), descriptor = Object.getOwnPropertyDescriptor(crypto, "getRandomValues");
  crypto.getRandomValues = () => { throw new Error("synthetic unavailable nonce RNG"); };
  t.after(() => { if (descriptor) Object.defineProperty(crypto, "getRandomValues", descriptor); else delete crypto.getRandomValues; });
  const sealed = await succeeds(p.sealEnvelope2(creator, claimant.publicKey, ps, id, payload));
  assert.deepEqual(Object.keys(sealed).sort(), ["envelope", "seal_suite"]); assert.equal(sealed.seal_suite, 2);
  assert.deepEqual(await succeeds(p.sealEnvelope2(creator, claimant.publicKey, ps, id, payload)), sealed);
  assert.deepEqual(await succeeds(p.openEnvelope2(claimant, creator.publicKey, ps, id, sealed)), payload);
  const vault = await succeeds(p.sealPairingVault2(ps, id, details));
  assert.equal(vault.seal_suite, 2); assert.equal(Object.hasOwn(vault, "nonce"), false);
  assert.equal(JSON.stringify(vault).includes(details.name), false);
  assert.deepEqual(await succeeds(p.openPairingVault2(ps, id, vault)), details);
  assert.deepEqual(await succeeds(p.sealPairingVault2(ps, id, details)), vault);
  await assert.rejects(p.openPairingVault2(ps, id, sealed));
  await assert.rejects(p.openEnvelope2(claimant, creator.publicKey, ps, id, vault));
  assert.equal(typeof random, "function");
});

test("suite2 closed wire refuses legacy/missing/mixed/unknown before native key work, without a decoder fallback", async t => {
  const sealed = await succeeds(p.sealEnvelope2(creator, claimant.publicKey, ps, id, payload)), vault = await succeeds(p.sealPairingVault2(ps, id, details));
  const legacy = await p.sealEnvelopeLegacyV2(creator, claimant.publicKey, ps, id, { vrk: root });
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey"); let imports = 0;
  subtle.importKey = (...args) => { imports++; return original(...args); };
  t.after(() => { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; });
  for (const packet of [null, undefined, {}, legacy, { envelope: sealed.envelope }, { ...sealed, seal_suite: 1 }, { ...sealed, seal_suite: 3 },
    { ...sealed, nonce: "00".repeat(12) }, { ...sealed, nonce: undefined }, { ...sealed, envelope: "" }, { ...sealed, envelope: "A".repeat(8193) },
    { ...sealed, envelope: sealed.envelope.replace(/=+$/, "") + "\n" }]) {
    await assert.rejects(p.openEnvelope2(claimant, creator.publicKey, ps, id, packet));
  }
  for (const packet of [null, {}, { envelope: vault.envelope }, { ...vault, seal_suite: 1 }, { ...vault, nonce: "00".repeat(12) }, { ...vault, envelope: "A".repeat(2049) }]) await assert.rejects(p.openPairingVault2(ps, id, packet));
  assert.equal(imports, 0, "invalid wire never reaches native key import");
});

test("suite2 root plaintext validates exact fields, lower hex, version and independently derived generation before adoption", async () => {
  for (const value of [null, [], {}, { vrk: root }, { ...payload, v: 1 }, { ...payload, vrk: "G".repeat(64) },
    { ...payload, vrk: "AB".repeat(32) }, { ...payload, generation: "AB".repeat(16) }, { ...payload, generation: "00".repeat(16) },
    { ...payload, history: root }, { ...payload, root }, { ...payload, generation: null }]) {
    await assert.rejects(p.checkedEnvelope2(value), /invalid suite-2 vault envelope/);
    const sealed = await rootPacket(c.utf8(JSON.stringify(value)));
    await assert.rejects(p.openEnvelope2(claimant, creator.publicKey, ps, id, sealed), /invalid suite-2 vault envelope/);
  }
  await assert.rejects(p.openEnvelope2(claimant, creator.publicKey, ps, id, await rootPacket(c.utf8("not JSON"))));
});

test("suite2 wrong role/key/PS/ID, every tag byte and changed ciphertext never release a root", async () => {
  const sealed = await succeeds(p.sealEnvelope2(creator, claimant.publicKey, ps, id, payload));
  for (const [ours, peer, secret, pairingId] of [[stranger, creator.publicKey, ps, id], [claimant, stranger.publicKey, ps, id],
    [creator, claimant.publicKey, ps, id], [claimant, creator.publicKey, new Uint8Array(16), id], [claimant, creator.publicKey, ps, "00".repeat(16)]]) await assert.rejects(p.openEnvelope2(ours, peer, secret, pairingId, sealed));
  const packet = c.unbase64(sealed.envelope);
  for (let i = 0; i < packet.length; i++) { const damaged = packet.slice(); damaged[i] ^= 1; await assert.rejects(p.openEnvelope2(claimant, creator.publicKey, ps, id, { ...sealed, envelope: c.base64(damaged) })); }
});

test("suite2 strict details and fatal UTF8 refuse authenticated malformed content", async () => {
  for (const value of [null, [], { ...details, extra: true }, { ...details, notes: -1 }, { ...details, notes: 1.5 }, { ...details, name: "control\ntext" }, { ...details, name: "" }]) {
    await assert.rejects(p.sealPairingVault2(ps, id, value), /invalid vault details/);
    await assert.rejects(p.openPairingVault2(ps, id, await detailsPacket(c.utf8(JSON.stringify(value)))), /invalid vault details/);
  }
  const malformedDetails = c.concat(c.utf8('{"name":"bad'), new Uint8Array([255]), c.utf8('","notes":0}'));
  await assert.rejects(p.openPairingVault2(ps, id, await detailsPacket(malformedDetails)));
  const malformedRoot = c.concat(c.utf8('{"v":2,"vrk":"'), new Uint8Array([255]), c.utf8('","generation":"' + generation + '"}'));
  await assert.rejects(p.openEnvelope2(claimant, creator.publicKey, ps, id, await rootPacket(malformedRoot)));
});

test("suite2 seal captures PS, role keys and root/details values before its first native await", async () => {
  const secret = ps.slice(), value = { ...payload }, ours = { pair: { ...creator.pair }, publicKey: creator.publicKey };
  const sealed = p.sealEnvelope2(ours, claimant.publicKey, secret, id, value);
  secret.fill(0); value.vrk = "99".repeat(32); value.generation = "00".repeat(16); ours.publicKey = stranger.publicKey; ours.pair.privateKey = stranger.pair.privateKey;
  let packet; await assert.doesNotReject(async () => { packet = await sealed; });
  assert.deepEqual(await succeeds(p.openEnvelope2(claimant, creator.publicKey, ps, id, packet)), payload);
  const mutableSecret = ps.slice(), mutableDetails = { ...details }, vault = p.sealPairingVault2(mutableSecret, id, mutableDetails);
  mutableSecret.fill(0); mutableDetails.name = "changed";
  assert.deepEqual(await succeeds(p.openPairingVault2(ps, id, await vault)), details);
  for (const bad of [new Uint8Array(15), new Uint8Array(17), new Uint8Array(new SharedArrayBuffer(16)), "not bytes"]) await assert.rejects(p.sealPairingVault2(bad, id, details), /invalid secret/);
  for (const bad of ["../MARKER", "AB".repeat(16), "00", null]) await assert.rejects(p.sealPairingVault2(ps, bad, details), /invalid pairing identity/);
});

test("suite2 malformed root/gen formats reject before native KDF", async t => {
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey"); let imports = 0;
  subtle.importKey = (...args) => { imports++; return original(...args); };
  t.after(() => { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; });
  for (const patch of [{ generation: "AB".repeat(16) }, { generation: "00" }, { vrk: "G".repeat(64) }, { vrk: "AB".repeat(32) }]) await assert.rejects(p.checkedEnvelope2({ ...payload, ...patch }));
  assert.equal(imports, 0, "malformed enrollment fields cannot reach key derivation");
});
