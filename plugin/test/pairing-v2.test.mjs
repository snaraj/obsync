/**
 * Pairing v2: the ephemeral P-256 key exchange that stops a leaked code alone
 * from opening the vault-key envelope (`docs/protocol.md`, "Pairing").
 *
 * The chain is exercised against the platform's own WebCrypto: a known-answer
 * derived key from fixed JWK keys, a creator-seal/claimant-open round trip, the
 * AAD and shared-secret binding that makes a substituted OR stripped key fail,
 * the match code that shows the two screens a different number when a key is
 * substituted or stripped, the capability marker in the pairing secret, and the
 * legacy fallback for a 1.1.4 peer.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { sandbox } from "./fake.mjs";
import { pairingV2Vector } from "./fixtures/generate-pairing-v2.mjs";

const require = createRequire(import.meta.url);
const box = sandbox();
const c = require(`${box.home}/build/crypto.js`);
const p = require(`${box.home}/build/pairing.js`);

// The known-answer vector: sentinel P-256 scalars (01 01 … 01 for the
// claimant, 02 02 … 02 for the creator), the counting pairing secret and id,
// and what they derive. Frozen in fixtures/pairing-v2.json, and checked below
// against fixtures/generate-pairing-v2.mjs, which recomputes it with Node's
// WebCrypto alone.
const KAT = JSON.parse(readFileSync(new URL("./fixtures/pairing-v2.json", import.meta.url), "utf8"));

const VRK = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";

/** Rebuild a PairingKeyExchange (its pair and its public-key text) from a fixed JWK. */
async function fixed(privJwk, raw) {
  const pubJwk = { ...privJwk, d: undefined, key_ops: [] };
  const privateKey = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return { pair: { privateKey, publicKey }, publicKey: raw };
}

test("the frozen vector is exactly what its sentinel inputs derive (fixtures/generate-pairing-v2.mjs)", async () => {
  assert.deepEqual(await pairingV2Vector(), KAT);
  // The scalars really are the sentinels, not keys that merely sit beside them.
  assert.equal(Buffer.from(KAT.claimantPriv.d, "base64url").toString("hex"), "01".repeat(32));
  assert.equal(Buffer.from(KAT.creatorPriv.d, "base64url").toString("hex"), "02".repeat(32));
});

test("the v2 derived key matches the known-answer vector (fixed keys)", async () => {
  const claimant = await fixed(KAT.claimantPriv, KAT.claimantRaw);
  const creatorPub = await c.importPairingPublicKey(c.unbase64url(KAT.creatorRaw));
  // ECDH is symmetric, so the claimant's private half and the creator's public
  // half derive the same key the generator computed the other way round.
  const key = await c.derivePairingV2Key(claimant.pair, creatorPub, c.unhex(KAT.psHex), KAT.pairingId);
  assert.equal(c.hex(key), KAT.derivedKeyHex);
});

test("a creator seals the vault key and only the claimant opens it", async () => {
  const claimant = await fixed(KAT.claimantPriv, KAT.claimantRaw);
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const ps = c.unhex(KAT.psHex);
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, ps, KAT.pairingId, { vrk: VRK });
  const opened = await p.openEnvelopeV2(claimant, KAT.creatorRaw, ps, KAT.pairingId, sealed.envelope, sealed.nonce);
  assert.equal(opened.vrk, VRK);
});

test("a substituted creator key fails the open (AAD and shared secret both bind it)", async () => {
  const claimant = await fixed(KAT.claimantPriv, KAT.claimantRaw);
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const attacker = await p.newPairingKeyExchange();
  const ps = c.unhex(KAT.psHex);
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, ps, KAT.pairingId, { vrk: VRK });
  await assert.rejects(() => p.openEnvelopeV2(claimant, attacker.publicKey, ps, KAT.pairingId, sealed.envelope, sealed.nonce));
});

test("an envelope sealed for one claimant does not open for another", async () => {
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const other = await p.newPairingKeyExchange();
  const ps = c.unhex(KAT.psHex);
  // Sealed for the fixed claimant; a different device holds a different key.
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, ps, KAT.pairingId, { vrk: VRK });
  await assert.rejects(() => p.openEnvelopeV2(other, KAT.creatorRaw, ps, KAT.pairingId, sealed.envelope, sealed.nonce));
});

test("the pairing secret alone does not open a v2 envelope", async () => {
  // A copy of the code and a record of the approval give PS, the pairing id,
  // both public keys and the sealed envelope, but neither private key: the
  // PS-only (legacy) open is refused.
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const ps = c.unhex(KAT.psHex);
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, ps, KAT.pairingId, { vrk: VRK });
  await assert.rejects(() => p.openEnvelope(ps, KAT.pairingId, sealed.envelope, sealed.nonce));
});

test("the wrong pairing secret fails the open", async () => {
  const claimant = await fixed(KAT.claimantPriv, KAT.claimantRaw);
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, c.unhex(KAT.psHex), KAT.pairingId, { vrk: VRK });
  const wrongPs = c.unhex("0b5c0102030405060708090a0b0c0dff");
  await assert.rejects(() => p.openEnvelopeV2(claimant, KAT.creatorRaw, wrongPs, KAT.pairingId, sealed.envelope, sealed.nonce));
});

test("the v2 match code binds the claimant key: substitute or strip and the screens differ", async () => {
  const ps = c.unhex(KAT.psHex);
  const deviceId = "aabbccddeeff00112233445566778899";
  // Both screens with the SAME claimant key agree.
  const claimantScreen = await p.matchCodeV2(ps, KAT.pairingId, deviceId, KAT.claimantRaw);
  const creatorScreen = await p.matchCodeV2(ps, KAT.pairingId, deviceId, KAT.claimantRaw);
  assert.equal(claimantScreen, creatorScreen);
  // An interceptor that SUBSTITUTES its own key makes the creator's screen differ.
  const attacker = await p.newPairingKeyExchange();
  const substituted = await p.matchCodeV2(ps, KAT.pairingId, deviceId, attacker.publicKey);
  assert.notEqual(substituted, claimantScreen);
  // A STRIPPED key makes the creator fall back to the v1 code, which the v2
  // claimant's code never equals for these fixed inputs.
  const stripped = await p.matchCode(ps, KAT.pairingId, deviceId);
  assert.notEqual(stripped, claimantScreen);
});

test("a creator-minted pairing secret carries the v2 capability marker", () => {
  const secret = p.newPairingSecret();
  assert.equal(secret.length, 16);
  assert.equal(secret[0], p.PAIRING_V2_MARKER[0]);
  assert.equal(secret[1], p.PAIRING_V2_MARKER[1]);
  assert.equal(p.isV2Secret(secret), true);
  // A secret without the marker (a 1.1.4 creator's) reads as legacy.
  const legacy = c.unhex("00010102030405060708090a0b0c0d0e");
  assert.equal(p.isV2Secret(legacy), false);
});

test("a public key of the wrong length, prefix or alphabet is refused", () => {
  assert.doesNotThrow(() => p.checkedPublicKey(KAT.claimantRaw));
  // 64 bytes, not 65.
  assert.throws(() => p.checkedPublicKey(c.base64url(new Uint8Array(64).fill(4))));
  // 65 bytes but a compressed-point prefix.
  const bad = new Uint8Array(65); bad[0] = 0x02;
  assert.throws(() => p.checkedPublicKey(c.base64url(bad)));
  // Not base64url.
  assert.throws(() => p.checkedPublicKey("not a key!!!"));
  assert.throws(() => p.checkedPublicKey(42));
});

test("the legacy envelope still round-trips under a v2-marked secret (1.1.4 peer fallback)", async () => {
  // A v2 creator pairing with a 1.1.4 claimant seals the legacy way with the
  // same (v2-marked) PS; the legacy claimant opens it exactly as before.
  const secret = p.newPairingSecret();
  const sealed = await p.sealEnvelope(secret, KAT.pairingId, { vrk: VRK });
  const opened = await p.openEnvelope(secret, KAT.pairingId, sealed.envelope, sealed.nonce);
  assert.equal(opened.vrk, VRK);
});

test("a server version counts as v2-capable only at 1.1.5 or later, three numbers, nothing else", () => {
  for (const yes of ["1.1.5", "1.1.6", "1.1.10", "1.2.0", "2.0.0", "1.1.5-beta.1", "1.1.5+build.7"]) {
    assert.equal(p.serverPairsV2(yes), true, yes);
  }
  for (const no of ["1.1.4", "1.0.99", "0.99.99", "1.1", "1.1.5.1", "", " 1.1.5", "v1.1.5", "1.1.5x", "1.1.5 ", null, undefined, 115, {}, ["1.1.5"]]) {
    assert.equal(p.serverPairsV2(no), false, String(no));
  }
});

test("a collected key counts as kept only once the new device was seen after signing in", () => {
  const row = (fields) => ({ state: "active", revoked: false, last_sign_in: 1000, last_seen: 2000, ...fields });
  assert.equal(p.keptOutcome(row({})), "kept");
  assert.equal(p.keptOutcome(row({ last_seen: 1000 })), "open", "the sign-in alone is the survey, before any key is kept");
  assert.equal(p.keptOutcome(row({ last_seen: 999 })), "open");
  assert.equal(p.keptOutcome(row({ last_sign_in: null })), "open");
  assert.equal(p.keptOutcome(row({ last_seen: null })), "open");
  assert.equal(p.keptOutcome(row({ state: "pending" })), "open");
  assert.equal(p.keptOutcome(row({ state: undefined })), "open");
  assert.equal(p.keptOutcome(row({ revoked: true })), "dropped");
  assert.equal(p.keptOutcome(row({ state: "revoked" })), "dropped");
  assert.equal(p.keptOutcome(undefined), "dropped", "a device no longer listed took itself back");
});
