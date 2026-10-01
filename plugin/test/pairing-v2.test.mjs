/**
 * Pairing v2: the ephemeral P-256 key exchange that stops a leaked code alone
 * from opening the vault-key envelope (`docs/protocol.md`, "Pairing").
 *
 * The chain is exercised against the platform's own WebCrypto: a known-answer
 * derived key, commitment and match code from fixed JWK keys, a creator-seal /
 * claimant-open round trip, the AAD and shared-secret binding that makes a
 * substituted OR stripped key fail, the commitment the code carries to the
 * creator's key, and the code's length rules: 1.1.5 pairs this way only, and
 * a code from before it is refused. The ORDER that makes the match code an authentication -- the creator
 * fixes the claim before its key goes out -- is the dialogs', and is tested
 * there (`pairing-vault-ui.test.mjs`, `pairing-claim.test.mjs`).
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

test("the pairing secret and both public keys alone do not open an envelope", async () => {
  // A copy of the code and a record of the exchange give PS, the pairing id,
  // both public keys and the sealed envelope, but neither private key: a
  // key pair of the reader's own, against either public key, opens nothing.
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const reader = await p.newPairingKeyExchange();
  const ps = c.unhex(KAT.psHex);
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, ps, KAT.pairingId, { vrk: VRK });
  await assert.rejects(() => p.openEnvelopeV2(reader, KAT.creatorRaw, ps, KAT.pairingId, sealed.envelope, sealed.nonce));
  await assert.rejects(() => p.openEnvelopeV2(reader, KAT.claimantRaw, ps, KAT.pairingId, sealed.envelope, sealed.nonce));
});

test("the wrong pairing secret fails the open", async () => {
  const claimant = await fixed(KAT.claimantPriv, KAT.claimantRaw);
  const creator = await fixed(KAT.creatorPriv, KAT.creatorRaw);
  const sealed = await p.sealEnvelopeV2(creator, KAT.claimantRaw, c.unhex(KAT.psHex), KAT.pairingId, { vrk: VRK });
  const wrongPs = c.unhex("0b5c0102030405060708090a0b0c0dff");
  await assert.rejects(() => p.openEnvelopeV2(claimant, KAT.creatorRaw, wrongPs, KAT.pairingId, sealed.envelope, sealed.nonce));
});

test("the commitment and the match code are the known-answer vector's", async () => {
  assert.equal(c.hex(await p.pairingCommitment(KAT.pairingId, KAT.creatorRaw)), KAT.commitmentHex);
  assert.equal(await p.matchCodeV2(c.unhex(KAT.psHex), KAT.pairingId, KAT.claimantRaw, KAT.creatorRaw), KAT.matchCode);
});

test("the match code takes its two keys by role, and the raw keys, not their spelling", async () => {
  const ps = c.unhex(KAT.psHex);
  // The two keys trade places: another input, another vector.
  assert.notEqual(await p.matchCodeV2(ps, KAT.pairingId, KAT.creatorRaw, KAT.claimantRaw), KAT.matchCode);
  // The same point spelled with its spare low bits set is the same key; a key
  // that is not a point never reaches the derivation.
  const respelled = `${KAT.creatorRaw.slice(0, -1)}${String.fromCharCode(KAT.creatorRaw.at(-1).charCodeAt(0) + 1)}`;
  assert.equal(c.hex(c.unbase64url(respelled)), c.hex(c.unbase64url(KAT.creatorRaw)), "the spare bits carry nothing");
  assert.equal(await p.matchCodeV2(ps, KAT.pairingId, KAT.claimantRaw, respelled), KAT.matchCode);
  await assert.rejects(() => p.matchCodeV2(ps, KAT.pairingId, KAT.claimantRaw, "not a key"));
});

test("the commitment holds its own key for its own pairing, and refuses another key, another pairing, a non-key", async () => {
  const commitment = c.unhex(KAT.commitmentHex);
  assert.equal(commitment.length, p.COMMITMENT_BYTES);
  assert.equal(await p.keptCommitment(commitment, KAT.pairingId, KAT.creatorRaw), true);
  // The claimant's key is a valid point, and not the one committed to.
  assert.equal(await p.keptCommitment(commitment, KAT.pairingId, KAT.claimantRaw), false);
  // The same key revealed in another pairing is not this commitment's.
  assert.equal(await p.keptCommitment(commitment, "fe".repeat(16), KAT.creatorRaw), false);
  const flipped = Uint8Array.from(commitment); flipped[15] ^= 1;
  assert.equal(await p.keptCommitment(flipped, KAT.pairingId, KAT.creatorRaw), false, "every byte of it is compared");
  await assert.rejects(() => p.keptCommitment(commitment, KAT.pairingId, "not a key"));
});

test("a code carries its commitment; one from before 1.1.5 says so, and one cut short is refused", () => {
  const id = KAT.pairingId, token = "11".repeat(32), ps = c.unhex(KAT.psHex), commitment = c.unhex(KAT.commitmentHex);
  const code = p.encodePairingCode(id, token, ps, commitment);
  assert.equal(code.length, 128);
  assert.deepEqual(p.decodePairingCode(code), { pairingId: id, enrollToken: token, pairingSecret: ps, commitment });
  // What a device before 1.1.5 makes: the same three parts and no commitment.
  const older = c.base32(Uint8Array.from([...c.unhex(id), ...c.unhex(token), ...ps]));
  assert.equal(older.length, 103);
  assert.throws(() => p.decodePairingCode(older), (error) => error.message === p.OLDER_CREATOR);
  // A code cut anywhere short of its commitment pairs nothing.
  for (const cut of [100, 105, 110, 120, 127]) {
    assert.throws(() => p.decodePairingCode(code.slice(0, cut)), /incomplete/, String(cut));
  }
});

test("a creator's pairing secret is sixteen bytes, all of them random", () => {
  const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const secret = p.newPairingSecret();
    assert.equal(secret.length, 16);
    seen.add(c.hex(secret.subarray(0, 2)));
  }
  // The 1.1.5 pre-release marker fixed these two bytes; nothing does now.
  assert.ok(seen.size > 1, "the first two bytes vary");
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

// Issue #290: the server stamps in whole seconds, so a sync that starts in
// the second of its sign-in leaves `last_seen` equal to `last_sign_in`. Its
// heartbeat is the evidence, and nothing else is.
test("a heartbeat in the second of the sign-in counts as kept; no heartbeat, a revoked row or a pending one never does", () => {
  const row = (fields) => ({ state: "active", revoked: false, last_sign_in: 1000, last_seen: 1000, ...fields });
  assert.equal(p.keptOutcome(row({ last_heartbeat: 1000 })), "kept", "the same second as the sign-in");
  assert.equal(p.keptOutcome(row({ last_heartbeat: 1000, last_sign_in: null, last_seen: null })), "kept");
  assert.equal(p.keptOutcome(row({})), "open", "a server that does not list the field: the comparison alone");
  assert.equal(p.keptOutcome(row({ last_heartbeat: null })), "open", "no heartbeat yet");
  assert.equal(p.keptOutcome(row({ last_heartbeat: "1000" })), "open", "only a number is a heartbeat");
  assert.equal(p.keptOutcome(row({ last_heartbeat: 1000, state: "revoked", revoked: true })), "dropped");
  assert.equal(p.keptOutcome(row({ last_heartbeat: 1000, revoked: true })), "dropped");
  assert.equal(p.keptOutcome(row({ last_heartbeat: 1000, state: "pending" })), "open");
  assert.equal(p.keptOutcome(row({ last_heartbeat: 1000, state: undefined })), "open");
});
