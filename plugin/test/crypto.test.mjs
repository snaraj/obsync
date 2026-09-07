/**
 * Device cryptography, checked three ways:
 *
 * 1. Against `fixtures/crypto.json`, the frozen cross-implementation vectors
 *    the Rust core must reproduce byte for byte.
 * 2. Against Node's `node:crypto` as an INDEPENDENT oracle — a different
 *    implementation of SHA-256, HMAC, HKDF and AES-256-GCM than the WebCrypto
 *    the plugin uses, so agreement is evidence rather than a tautology.
 * 3. Against the RFC 4648 encoding vectors.
 *
 * Node's built-in modules only: no assertion library, no mock framework.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash, createHmac, hkdfSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const c = require("../build/crypto.js");
const fixtures = JSON.parse(readFileSync(join(here, "fixtures", "crypto.json"), "utf8"));

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const utf8 = (text) => new TextEncoder().encode(text);

test("hex round-trips and refuses malformed input", () => {
  const value = Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]);
  assert.equal(c.hex(value), "000fa0ff");
  assert.deepEqual(c.unhex("000fa0ff"), value);
  assert.throws(() => c.unhex("abc"), /odd length/);
  assert.throws(() => c.unhex("00zz"), /not lowercase hex/);
  assert.equal(c.isHex("00112233445566778899aabbccddeeff", 16), true);
  assert.equal(c.isHex("00112233445566778899aabbccddeefg", 16), false);
  assert.equal(c.isHex("0011", 16), false);
});

test("base64 matches RFC 4648 and round-trips", () => {
  const cases = [
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ];
  for (const [plain, encoded] of cases) {
    assert.equal(c.base64(utf8(plain)), encoded, plain);
    assert.deepEqual(c.unbase64(encoded), utf8(plain), plain);
  }
  const random = Uint8Array.from({ length: 257 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(c.unbase64(c.base64(random)), random);
  assert.equal(c.base64(random), Buffer.from(random).toString("base64"));
});

test("base32 matches RFC 4648 unpadded and tolerates spacing", () => {
  const cases = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, encoded] of cases) {
    assert.equal(c.base32(utf8(plain)), encoded, plain);
    assert.deepEqual(c.unbase32(encoded), utf8(plain), plain);
  }
  assert.deepEqual(c.unbase32("mzxw 6ytb-oi"), utf8("foobar"));
  assert.throws(() => c.unbase32("MZXW1"), /invalid character/);
});

test("sha256, hmac and hkdf agree with node:crypto", async () => {
  const message = utf8("obsync oracle probe");
  const key = bytes("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0");
  assert.equal(c.hex(await c.sha256(message)), createHash("sha256").update(message).digest("hex"));
  assert.equal(
    c.hex(await c.hmacSha256(key, message)),
    createHmac("sha256", key).update(message).digest("hex"),
  );
  const salt = utf8("obsync/v1/domain");
  const info = utf8("0123456789abcdef0123456789abcdef");
  assert.equal(
    c.hex(await c.hkdf(key, salt, info, 32)),
    Buffer.from(hkdfSync("sha256", key, salt, info, 32)).toString("hex"),
  );
  // A 12-byte derivation is the 32-byte derivation's prefix (RFC 5869 expand).
  const long = await c.hkdf(key, salt, new Uint8Array(0), 32);
  const short = await c.hkdf(key, salt, new Uint8Array(0), 12);
  assert.deepEqual(short, long.subarray(0, 12));
});

test("constant-time comparison answers correctly", () => {
  const a = bytes("00112233");
  assert.equal(c.bytesEqual(a, bytes("00112233")), true);
  assert.equal(c.bytesEqual(a, bytes("00112234")), false);
  assert.equal(c.bytesEqual(a, bytes("80112233")), false);
  assert.equal(c.bytesEqual(a, bytes("001122")), false);
});

test("key derivation reproduces the fixtures", async () => {
  const vrk = bytes(fixtures.vrk);
  assert.equal(c.hex(await c.deriveDomainKey(vrk, fixtures.domain_id)), fixtures.domain_key);
  assert.equal(c.hex(await c.deriveManifestKey(vrk)), fixtures.manifest_key);
  assert.equal(
    c.hex(await c.pairingKey(bytes(fixtures.pairing.pairing_secret), fixtures.pairing.pairing_id)),
    fixtures.pairing.key,
  );
});

test("chunk encryption reproduces the fixtures and node:crypto agrees", async () => {
  const domainKey = bytes(fixtures.domain_key);
  for (const vector of fixtures.chunks) {
    const plaintext =
      vector.plaintext_hex === null
        ? Uint8Array.from({ length: vector.plaintext_len }, (_, i) => i % 251)
        : bytes(vector.plaintext_hex);

    const cid = await c.chunkCid(domainKey, plaintext);
    assert.equal(c.hex(cid), vector.cid, `${vector.name} cid`);
    assert.equal(
      c.hex(cid),
      createHmac("sha256", domainKey).update(plaintext).digest("hex"),
      `${vector.name} cid oracle`,
    );

    const chunkKey = await c.hkdf(domainKey, utf8("obsync/v1/chunk"), cid, 32);
    assert.equal(c.hex(chunkKey), vector.chunk_key, `${vector.name} chunk key`);
    const nonce = await c.hkdf(chunkKey, utf8("obsync/v1/nonce"), new Uint8Array(0), 12);
    assert.equal(c.hex(nonce), vector.nonce, `${vector.name} nonce`);

    const encrypted = await c.encryptChunk(domainKey, plaintext);
    assert.equal(encrypted.sid, vector.sid, `${vector.name} sid`);
    assert.equal(encrypted.ciphertext.length, vector.ciphertext_len, `${vector.name} length`);
    if (vector.ciphertext_hex !== null) {
      assert.equal(c.hex(encrypted.ciphertext), vector.ciphertext_hex, `${vector.name} ciphertext`);
    }

    // Independent AES-256-GCM: same key, nonce and AAD must give the same bytes.
    const cipher = createCipheriv("aes-256-gcm", chunkKey, nonce);
    cipher.setAAD(utf8("obsync/v1/chunk"));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const oracle = Buffer.concat([body, cipher.getAuthTag()]);
    assert.equal(c.hex(encrypted.ciphertext), oracle.toString("hex"), `${vector.name} gcm oracle`);
    assert.equal(encrypted.sid, createHash("sha256").update(oracle).digest("hex"), `${vector.name} sid oracle`);

    const back = await c.decryptChunk(domainKey, cid, encrypted.ciphertext);
    assert.deepEqual(back, plaintext, `${vector.name} round trip`);
  }
});

test("chunk decryption refuses a wrong cid and a tampered ciphertext", async () => {
  const domainKey = bytes(fixtures.domain_key);
  const plaintext = utf8("obsync fixture chunk\n");
  const { ciphertext } = await c.encryptChunk(domainKey, plaintext);
  const cid = await c.chunkCid(domainKey, plaintext);

  const wrongCid = Uint8Array.from(cid);
  wrongCid[0] ^= 1;
  await assert.rejects(() => c.decryptChunk(domainKey, wrongCid, ciphertext));

  const tampered = Uint8Array.from(ciphertext);
  tampered[3] ^= 0x40;
  await assert.rejects(() => c.decryptChunk(domainKey, cid, tampered));

  const wrongDomain = bytes(fixtures.manifest_key);
  await assert.rejects(() => c.decryptChunk(wrongDomain, cid, ciphertext));
});

test("a chunk whose cid lies about its plaintext is refused, though it decrypts", async () => {
  // The reachable case for the cid recomputation: a writer that HOLDS the
  // domain key — a compromised or buggy device — can produce a chunk that
  // authenticates perfectly under a cid that is not the MAC of its contents.
  // AES-GCM cannot catch that; recomputing `cid` does.
  const domainKey = bytes(fixtures.domain_key);
  const plaintext = utf8("honest bytes\n");
  const forgedCid = bytes("11".repeat(32));
  const chunkKey = Buffer.from(hkdfSync("sha256", domainKey, utf8("obsync/v1/chunk"), forgedCid, 32));
  const nonce = Buffer.from(hkdfSync("sha256", chunkKey, utf8("obsync/v1/nonce"), Buffer.alloc(0), 12));
  const cipher = createCipheriv("aes-256-gcm", chunkKey, nonce);
  cipher.setAAD(utf8("obsync/v1/chunk"));
  const forged = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // It really does decrypt: the tag verifies under the forged cid's key.
  const decipher = createDecipheriv("aes-256-gcm", chunkKey, nonce);
  decipher.setAAD(utf8("obsync/v1/chunk"));
  decipher.setAuthTag(forged.subarray(forged.length - 16));
  assert.deepEqual(
    Buffer.concat([decipher.update(forged.subarray(0, forged.length - 16)), decipher.final()]),
    Buffer.from(plaintext),
  );
  await assert.rejects(() => c.decryptChunk(domainKey, forgedCid, new Uint8Array(forged)), /cid mismatch/);
});

test("identical plaintext deduplicates, different plaintext does not", async () => {
  const domainKey = bytes(fixtures.domain_key);
  const one = await c.encryptChunk(domainKey, utf8("same bytes"));
  const two = await c.encryptChunk(domainKey, utf8("same bytes"));
  const other = await c.encryptChunk(domainKey, utf8("same byteS"));
  assert.equal(one.sid, two.sid);
  assert.deepEqual(one.ciphertext, two.ciphertext);
  assert.notEqual(one.sid, other.sid);
});

test("manifest encryption binds file id, parents and chunk list", async () => {
  const manifestKey = bytes(fixtures.manifest_key);
  const f = fixtures.manifest;

  assert.equal(await c.contentVersionId(f.file_id, f.parents, f.sids), f.content_version_id);
  // Parents are hashed sorted ascending, so their order at the call site
  // cannot change the id.
  assert.equal(
    await c.contentVersionId(f.file_id, [...f.parents].reverse(), f.sids),
    f.content_version_id,
  );

  const plaintext = await c.decryptManifest(
    manifestKey,
    f.file_id,
    f.content_version_id,
    bytes(f.nonce),
    bytes(f.ciphertext_hex),
  );
  assert.equal(plaintext, f.json);

  // Independent oracle over the recorded nonce and AAD.
  const aad = Buffer.concat([Buffer.from(f.file_id, "hex"), Buffer.from(f.content_version_id, "hex")]);
  const cipher = createCipheriv("aes-256-gcm", manifestKey, bytes(f.nonce));
  cipher.setAAD(aad);
  const oracle = Buffer.concat([cipher.update(utf8(f.json)), cipher.final(), cipher.getAuthTag()]);
  assert.equal(oracle.toString("hex"), f.ciphertext_hex);

  // The AAD is load-bearing: another file id cannot open it.
  await assert.rejects(() =>
    c.decryptManifest(
      manifestKey,
      "ff112233445566778899aabbccddeeff",
      f.content_version_id,
      bytes(f.nonce),
      bytes(f.ciphertext_hex),
    ),
  );
  // …and neither can another chunk list.
  const otherBinder = await c.contentVersionId(f.file_id, f.parents, [f.sids[0]]);
  await assert.rejects(() =>
    c.decryptManifest(manifestKey, f.file_id, otherBinder, bytes(f.nonce), bytes(f.ciphertext_hex)),
  );
});

test("manifest nonces are fresh per encryption", async () => {
  const manifestKey = bytes(fixtures.manifest_key);
  const first = await c.encryptManifest(manifestKey, fixtures.manifest.file_id, fixtures.manifest.content_version_id, "{}");
  const second = await c.encryptManifest(manifestKey, fixtures.manifest.file_id, fixtures.manifest.content_version_id, "{}");
  assert.equal(first.nonce.length, 12);
  assert.notEqual(c.hex(first.nonce), c.hex(second.nonce));
  assert.notEqual(c.hex(first.ciphertext), c.hex(second.ciphertext));
});

test("versionId is the documented preimage, recomputable by the server", async () => {
  const f = fixtures.manifest;
  const manifestCt = bytes(f.ciphertext_hex);
  assert.equal(await c.versionId(f.file_id, f.parents, manifestCt, f.sids), f.version_id);

  const preimage = Buffer.concat([
    Buffer.from(f.file_id, "hex"),
    ...[...f.parents].sort().map((parent) => Buffer.from(parent, "hex")),
    Buffer.from(manifestCt),
    ...f.sids.map((sid) => Buffer.from(sid, "hex")),
  ]);
  assert.equal(createHash("sha256").update(preimage).digest("hex"), f.version_id);

  // Every term changes the id.
  assert.notEqual(await c.versionId("ff" + f.file_id.slice(2), f.parents, manifestCt, f.sids), f.version_id);
  assert.notEqual(await c.versionId(f.file_id, [], manifestCt, f.sids), f.version_id);
  assert.notEqual(await c.versionId(f.file_id, f.parents, manifestCt, [...f.sids].reverse()), f.version_id);
  const flipped = Uint8Array.from(manifestCt);
  flipped[0] ^= 1;
  assert.notEqual(await c.versionId(f.file_id, f.parents, flipped, f.sids), f.version_id);
});

test("request signature matches the protocol preimage", async () => {
  const s = fixtures.signature;
  const secret = bytes(s.device_secret);
  assert.equal(
    await c.signRequest(secret, s.method, s.target, s.ts, s.nonce, s.body_sha256),
    s.sig,
  );
  const preimage = `obsync/v1\n${s.method}\n${s.target}\n${s.ts}\n${s.nonce}\n${s.body_sha256}`;
  assert.equal(createHmac("sha256", secret).update(preimage).digest("hex"), s.sig);
  assert.equal(s.body_sha256, createHash("sha256").update("{}").digest("hex"));
  assert.equal(
    await c.bodyHash(new Uint8Array(0)),
    createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
  );

  // Every term is covered: change one and the signature changes.
  for (const [method, target, ts, nonce, body] of [
    ["GET", s.target, s.ts, s.nonce, s.body_sha256],
    [s.method, `${s.target}?x=1`, s.ts, s.nonce, s.body_sha256],
    [s.method, s.target, s.ts + 1, s.nonce, s.body_sha256],
    [s.method, s.target, s.ts, `0${s.nonce.slice(1)}`, s.body_sha256],
    [s.method, s.target, s.ts, s.nonce, `0${s.body_sha256.slice(1)}`],
  ]) {
    assert.notEqual(await c.signRequest(secret, method, target, ts, nonce, body), s.sig);
  }
});

test("random bytes are the requested length and not constant", () => {
  const a = c.randomBytes(32);
  const b = c.randomBytes(32);
  assert.equal(a.length, 32);
  assert.notEqual(c.hex(a), c.hex(b));
  assert.equal(c.randomBytes(0).length, 0);
});

test("manifest decryption survives a full encrypt/decrypt cycle", async () => {
  const manifestKey = bytes(fixtures.manifest_key);
  const json = JSON.stringify({ v: 1, path: "A folder/A note.md", size: 3, deleted: false });
  const fileId = fixtures.manifest.file_id;
  const binder = await c.contentVersionId(fileId, [], []);
  const sealed = await c.encryptManifest(manifestKey, fileId, binder, json);
  assert.equal(await c.decryptManifest(manifestKey, fileId, binder, sealed.nonce, sealed.ciphertext), json);
  const decipher = createDecipheriv("aes-256-gcm", manifestKey, sealed.nonce);
  decipher.setAAD(Buffer.concat([Buffer.from(fileId, "hex"), Buffer.from(binder, "hex")]));
  decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - 16));
  const opened = Buffer.concat([
    decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16)),
    decipher.final(),
  ]);
  assert.equal(opened.toString("utf8"), json);
});
