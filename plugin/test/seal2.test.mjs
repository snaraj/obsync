import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const s = require("../build/seal2.js"), c = require("../build/crypto.js"), mode = require("../build/aesSiv.js");
const root = () => new Uint8Array(32).fill(7);
const P = new TextEncoder().encode("suite2 frozen metadata");
const G = "11".repeat(16), D = "22".repeat(16), F = "33".repeat(16);
const A = "aa".repeat(32), B = "bb".repeat(32), X = "cc".repeat(32), Y = "dd".repeat(32);
const record = () => ({ generation: G, domainId: D, fileId: F, parents: [B, A], sids: [Y, X, Y] });
const scope = () => ({ generation: G, domainId: D });
const point = (n) => { const out = new Uint8Array(65).fill(n); out[0] = 4; return out; };
const pairing = () => ({ pairingId: F, claimantPublic: point(1), creatorPublic: point(2) });
const fromHex = (text) => new Uint8Array(Buffer.from(text, "hex"));
const u32 = (n) => { const out = Buffer.alloc(4); out.writeUInt32BE(n); return out; };
// Independent spelling: prefix bytes, kind, G/D/F, counted parents, counted ordered SIDs.
const EXPECTED_T = Buffer.concat([Buffer.from("6f6273796e632f7365616c2f320001", "hex"),
  Buffer.from(G + D + F, "hex"), u32(2), Buffer.from(A + B, "hex"), u32(3), Buffer.from(Y + X + Y, "hex")]);

async function nativeKdf(base, label, info, length) {
  const key = await crypto.subtle.importKey("raw", base, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256",
    salt: new TextEncoder().encode(label), info }, key, length * 8));
}
const contextInfo = async (context) => new Uint8Array(await crypto.subtle.digest("SHA-256", context));
async function refused(operation, message, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.message, message, label);
    assert.ok(!Object.hasOwn(error, "cause"), "wrapper failures must retain no source cause");
    return true;
  }, label);
}

test("record layout is exact counted big-endian bytes and parent order canonical", () => {
  assert.deepEqual(Buffer.from(s.recordContext(1, record())), EXPECTED_T, "record context must match independently spelled bytes");
  const sorted = record(); sorted.parents.reverse();
  assert.deepEqual(s.recordContext(1, sorted), s.recordContext(1, record()), "parent order must canonicalize");
  const reversed = record(); reversed.sids.reverse(); // palindromic list is intentionally unchanged
  reversed.sids = [X, Y, Y];
  assert.notDeepEqual(s.recordContext(1, reversed), s.recordContext(1, record()), "SID order must remain significant");
  assert.deepEqual(Buffer.from(s.recordContext(1, reversed)), Buffer.concat([EXPECTED_T.subarray(0, 135), Buffer.from(X + Y + Y, "hex")]),
    "asymmetric SID order must match independently spelled bytes");
  assert.equal(s.recordContext(1, record()).length, 15 + 48 + 8 + 5 * 32, "SID repeats must retain their count");
});

test("record count limits are exact and reject duplicates, sparse lists and malformed hex", () => {
  const full = record(); full.parents = Array.from({ length: 64 }, (_, n) => n.toString(16).padStart(64, "0"));
  full.sids = Array(65536).fill(X);
  const encoded = s.recordContext(1, full);
  assert.equal(encoded.length, 71 + 32 * (64 + 65536), "maximum lists must encode without variadic argument limits");
  assert.equal(new DataView(encoded.buffer).getUint32(63), 64, "parent count must be U32 big-endian");
  assert.equal(new DataView(encoded.buffer).getUint32(67 + 64 * 32), 65536, "SID count must be U32 big-endian");
  const invalid = [null, { ...record(), parents: [A, A] }, { ...full, parents: [...full.parents, "ff".repeat(32)] },
    { ...full, sids: Array(65537).fill(X) }, { ...record(), sids: Array(1) }, { ...record(), parents: [{}] }];
  for (const field of ["generation", "domainId", "fileId"]) {
    for (const value of [G.toUpperCase().replace("11", "AA"), "1".repeat(31), "g".repeat(32), "11".repeat(17), 12]) invalid.push({ ...record(), [field]: value });
  }
  invalid.push({ ...record(), parents: [A.toUpperCase()] }, { ...record(), sids: ["x".repeat(64)] });
  for (const value of invalid) assert.throws(() => s.recordContext(1, value), /seal2: invalid context/, "invalid record context must be refused");
  assert.throws(() => s.recordContext(3, record()), /seal2: invalid context/, "unknown record kind must be refused");
});

test("map context encodes kind2 and requires generation identity plus empty SIDs", () => {
  const map = { ...record(), fileId: G, sids: [] };
  const encoded = s.recordContext(2, map);
  assert.equal(encoded[14], 2, "map kind must be distinct");
  assert.throws(() => s.recordContext(2, { ...map, fileId: F }), /seal2: invalid context/, "map file ID must equal generation");
  assert.throws(() => s.recordContext(2, { ...map, sids: [X] }), /seal2: invalid context/, "map SIDs must remain empty");
});

test("pairing context binds ordered roles and details bind only pairing ID", () => {
  const ctx = pairing();
  const expected = Buffer.concat([Buffer.from("obsync/seal/2\0"), Buffer.from([4]), Buffer.from(F, "hex"), Buffer.from(point(1)), Buffer.from(point(2))]);
  assert.deepEqual(Buffer.from(s.pairingContext(4, ctx)), expected, "envelope context must preserve role order");
  assert.deepEqual(Buffer.from(s.pairingContext(5, { pairingId: F })),
    Buffer.concat([Buffer.from("obsync/seal/2\0"), Buffer.from([5]), Buffer.from(F, "hex")]), "details context must contain no unavailable role key");
  for (const bad of [null, { ...ctx, claimantPublic: point(1).slice(1) }, { ...ctx, creatorPublic: new Uint8Array(65) },
    { ...ctx, creatorPublic: new Uint8Array(66) }, { ...ctx, claimantPublic: undefined }, { ...ctx, pairingId: "FF".repeat(16) }]) {
    assert.throws(() => s.pairingContext(4, bad), /seal2: invalid context/, "malformed pairing identity/key must be refused");
  }
  assert.throws(() => s.pairingContext(3, ctx), /seal2: invalid context/, "unknown pairing kind must be refused");
});

test("record packet is frozen, deterministic and follows independent native HKDF mapping", async () => {
  const packet = await s.sealRecord(root(), 1, record(), P);
  const key = await nativeKdf(root(), "obsync/seal-v2/siv", await contextInfo(new Uint8Array(EXPECTED_T)), 64);
  assert.deepEqual(packet, await mode.aesSivEncrypt(key, P, [new Uint8Array(EXPECTED_T)]), "wrapper must use exact 64-byte KDF and one context AD component");
  assert.equal(c.hex(packet), "fa053c53d171d98886317c4b613c91ea121c83cb7ba3521fafc67c401ff5398d8df1f3475496", "record packet must match frozen expected bytes");
  assert.deepEqual(await s.sealRecord(root(), 1, record(), P), packet, "same record input must seal deterministically");
  assert.deepEqual(await s.openRecord(root(), 1, record(), packet), P, "record control must open");
  const other = new TextEncoder().encode("different plaintext under identical context");
  const changed = await s.sealRecord(root(), 1, record(), other);
  assert.notDeepEqual(changed, packet, "different plaintext must not reuse the same packet");
  assert.deepEqual(await s.openRecord(root(), 1, record(), changed), other, "same context with varied plaintext must remain ordinary SIV");
});

test("record substitution and old flattened parent/SID partition confusion refuse", async () => {
  const initial = { ...record(), parents: [A], sids: [B] };
  const moved = { ...initial, parents: [], sids: [A, B] };
  assert.equal((await c.contentVersionId(F, initial.parents, initial.sids)),
    await c.contentVersionId(F, moved.parents, moved.sids), "control must preserve old flattened binder");
  assert.notDeepEqual(s.recordContext(1, initial), s.recordContext(1, moved), "count framing must distinguish parent/SID partition");
  const packet = await s.sealRecord(root(), 1, initial, P);
  for (const ctx of [moved, { ...initial, generation: D }, { ...initial, domainId: G }, { ...initial, fileId: D },
    { ...initial, parents: [X] }, { ...initial, sids: [X] }]) {
    await refused(() => s.openRecord(root(), 1, ctx, packet), "seal2: open failed", "changed record binding must refuse before plaintext return");
  }
  await refused(() => s.openRecord(new Uint8Array(32).fill(8), 1, initial, packet), "seal2: open failed", "wrong scope key must refuse");
  const map = { ...initial, fileId: G, sids: [] };
  const mapPacket = await s.sealRecord(root(), 2, map, P);
  await refused(() => s.openRecord(root(), 1, map, mapPacket), "seal2: open failed", "cross-kind record use must refuse");
});

test("pairing role, ID, key and kind substitution refuse", async () => {
  const ctx = pairing(), packet = await s.sealPairing(root(), 4, ctx, P);
  assert.deepEqual(await s.openPairing(root(), 4, ctx, packet), P, "envelope control must open");
  for (const bad of [{ ...ctx, pairingId: G }, { ...ctx, claimantPublic: ctx.creatorPublic, creatorPublic: ctx.claimantPublic },
    { ...ctx, creatorPublic: point(3) }]) {
    await refused(() => s.openPairing(root(), 4, bad, packet), "seal2: open failed", "changed pairing binding must refuse");
  }
  await refused(() => s.openPairing(new Uint8Array(32).fill(8), 4, ctx, packet), "seal2: open failed", "wrong pairing key must refuse");
  const details = await s.sealPairing(root(), 5, { pairingId: F }, P);
  assert.deepEqual(await s.openPairing(root(), 5, { pairingId: F }, details), P, "details control must open without role keys");
  await refused(() => s.openPairing(root(), 4, ctx, details), "seal2: open failed", "cross-kind pairing use must refuse");
});

test("chunk uses separated CID/base labels and private counted generation/domain context", async () => {
  const result = await s.encryptChunk2(root(), scope(), P);
  const publicScope = fromHex(G + D);
  const idKey = await nativeKdf(root(), "obsync/seal-v2/chunk-id", publicScope, 32);
  const base = await nativeKdf(root(), "obsync/seal-v2/chunk-base", publicScope, 32);
  assert.notDeepEqual(idKey, base, "chunk HMAC and KDF bases must be separated");
  const expectedCid = await c.hmacSha256(idKey, P);
  assert.deepEqual(result.cid, expectedCid, "CID must use independently derived ID key");
  const context = Buffer.concat([Buffer.from("obsync/seal/2\0"), Buffer.from([3]), Buffer.from(G + D, "hex"), Buffer.from(expectedCid)]);
  assert.deepEqual(Buffer.from(s.chunkContext(scope(), result.cid)), context, "private chunk context must match exact bytes");
  const key = await nativeKdf(base, "obsync/seal-v2/siv", await contextInfo(new Uint8Array(context)), 64);
  assert.deepEqual(result.ciphertext, await mode.aesSivEncrypt(key, P, [new Uint8Array(context)]), "chunk packet must use separated base and private context");
  assert.equal(result.sid, c.hex(await c.sha256(result.ciphertext)), "SID must hash complete SIV packet");
  assert.deepEqual(await s.decryptChunk2(root(), scope(), result.cid, result.ciphertext), P, "chunk control must open");
  assert.deepEqual(await s.encryptChunk2(root(), scope(), P), result, "same chunk input must seal deterministically");
  for (const changed of [{ generation: D, domainId: D }, { generation: G, domainId: G }]) {
    const next = await s.encryptChunk2(root(), changed, P);
    assert.notDeepEqual(next.cid, result.cid, "chunk ID must separate generation/domain");
    await refused(() => s.decryptChunk2(root(), changed, result.cid, result.ciphertext), "seal2: open failed", "changed chunk scope must refuse");
  }
  const changedCid = result.cid.slice(); changedCid[0] ^= 1;
  await refused(() => s.decryptChunk2(root(), scope(), changedCid, result.ciphertext), "seal2: open failed", "changed chunk CID must refuse");
});

test("a valid SIV packet with a dishonest CID is refused after mode authentication", async () => {
  const wrongCid = new Uint8Array(32), context = s.chunkContext(scope(), wrongCid);
  const base = await nativeKdf(root(), "obsync/seal-v2/chunk-base", fromHex(G + D), 32);
  const key = await nativeKdf(base, "obsync/seal-v2/siv", await contextInfo(context), 64);
  const packet = await mode.aesSivEncrypt(key, P, [context]);
  assert.deepEqual(await mode.aesSivDecrypt(key, packet, [context]), P, "dishonest CID fixture must have authentic SIV bytes");
  await refused(() => s.decryptChunk2(root(), scope(), wrongCid, packet), "seal2: cid mismatch", "authenticated plaintext must satisfy keyed CID before return");
});

test("wrappers snapshot key, plaintext, ciphertext, context lists and pairing role bytes", async () => {
  const expected = await s.sealRecord(root(), 1, record(), P);
  const key = root(), input = P.slice(), ctx = record();
  const pending = s.sealRecord(key, 1, ctx, input);
  key.fill(0); input.fill(0); ctx.parents.fill(X); ctx.sids.fill(A); ctx.generation = D;
  assert.deepEqual(await pending, expected, "record seal must capture mutable inputs before await");
  const sealed = expected.slice(), openKey = root(), openCtx = record();
  const opened = s.openRecord(openKey, 1, openCtx, sealed);
  sealed.fill(0); openKey.fill(0); openCtx.sids.fill(A);
  assert.deepEqual(await opened, P, "record open must capture mutable inputs before await");
  const pairCtx = pairing(), pairInput = P.slice(), pairKey = root();
  const pairExpected = await s.sealPairing(root(), 4, pairing(), P);
  const pairPending = s.sealPairing(pairKey, 4, pairCtx, pairInput);
  pairCtx.claimantPublic.fill(0); pairCtx.creatorPublic.fill(0); pairKey.fill(0); pairInput.fill(0);
  assert.deepEqual(await pairPending, pairExpected, "pairing seal must capture role bytes before await");
  const chunkExpected = await s.encryptChunk2(root(), scope(), P);
  const chunkScope = scope(), chunkKey = root(), chunkInput = P.slice();
  const chunkPending = s.encryptChunk2(chunkKey, chunkScope, chunkInput);
  chunkScope.generation = D; chunkScope.domainId = G; chunkKey.fill(0); chunkInput.fill(0);
  assert.deepEqual(await chunkPending, chunkExpected, "chunk seal must not reread scope after await");
  const chunkBytes = chunkExpected.ciphertext.slice(), chunkCid = chunkExpected.cid.slice(), decryptKey = root();
  const chunkOpened = s.decryptChunk2(decryptKey, scope(), chunkCid, chunkBytes);
  chunkBytes.fill(0); chunkCid.fill(0); decryptKey.fill(0);
  assert.deepEqual(await chunkOpened, P, "chunk open must capture CID and packet before await");
});

test("invalid key, input and context refuse before native KDF or cipher", async (t) => {
  let calls = 0;
  t.mock.method(c, "hkdf", async () => { calls++; throw new Error("native unexpectedly invoked"); });
  for (const key of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(new SharedArrayBuffer(32)), null]) {
    await refused(() => s.sealRecord(key, 1, record(), P), "seal2: invalid key", "invalid key must be refused before KDF");
  }
  await refused(() => s.sealRecord(root(), 1, { ...record(), parents: [A, A] }, P), "seal2: invalid context", "invalid context must be refused before KDF");
  await refused(() => s.sealPairing(root(), 4, { ...pairing(), creatorPublic: new Uint8Array(65) }, P), "seal2: invalid context", "invalid role shape must be refused before KDF");
  await refused(() => s.encryptChunk2(root(), scope(), new Uint8Array((8 << 20) + 1)), "seal2: invalid input", "oversized chunk must be refused before HMAC/KDF");
  await refused(() => s.openRecord(root(), 1, record(), new Uint8Array(15)), "seal2: invalid input", "truncated packet must be refused before KDF");
  await refused(() => s.openPairing(root(), 5, { pairingId: F }, new Uint8Array((8 << 20) + 17)), "seal2: invalid input", "oversized packet must be refused before KDF");
  await refused(() => s.decryptChunk2(root(), scope(), new Uint8Array(31), new Uint8Array(16)), "seal2: invalid context", "bad CID length must be refused before KDF");
  assert.equal(calls, 0, "all invalid wrapper inputs must avoid native work");
});

test("native failures stay value-free and nonce RNG is not used", async (t) => {
  t.mock.method(crypto, "getRandomValues", () => { throw new Error("nonce RNG unavailable"); });
  const packet = await s.sealRecord(root(), 1, record(), P);
  assert.deepEqual(await s.openRecord(root(), 1, record(), packet), P, "record wrapper must not require nonce RNG");
  const chunk = await s.encryptChunk2(root(), scope(), P);
  assert.deepEqual(await s.decryptChunk2(root(), scope(), chunk.cid, chunk.ciphertext), P, "chunk wrapper must not require nonce RNG");
  t.mock.method(c, "hkdf", async () => { throw new Error("SENTINEL-ROOT-MATERIAL", { cause: { plaintext: P } }); });
  await refused(() => s.sealRecord(root(), 1, record(), P), "seal2: seal failed", "seal must replace native error details");
  await refused(() => s.openRecord(root(), 1, record(), packet), "seal2: open failed", "open must replace native error details");
  await refused(() => s.encryptChunk2(root(), scope(), P), "seal2: derive failed", "chunk derivation must replace native error details");
});


test("HKDF context digest supports actual maximum counted context sealing and opening", async () => {
  const large = record(); large.parents = Array.from({ length: 64 }, (_, n) => n.toString(16).padStart(64, "0"));
  large.sids = Array(65536).fill(X);
  assert.ok(s.recordContext(1, large).length > 1024, "accepted context must exceed native HKDF info limit");
  let packet;
  await assert.doesNotReject(async () => { packet = await s.sealRecord(root(), 1, large, P); },
    "maximum accepted context must actually seal through native WebCrypto");
  assert.deepEqual(await s.openRecord(root(), 1, large, packet), P, "maximum accepted context must open");
  const changed = { ...large, sids: [...large.sids] }; changed.sids[1] = Y;
  await refused(() => s.openRecord(root(), 1, changed, packet), "seal2: open failed", "full large context must remain authenticated AD");
});
