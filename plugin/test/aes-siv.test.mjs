/** Published oracles: RFC5297 AppendixA and NIST AES_CMAC.pdf, not roundtrips alone.
 * https://www.rfc-editor.org/rfc/rfc5297.html#appendix-A
 * https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/AES_CMAC.pdf
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { aesCmac, aesSivEncrypt: seal, aesSivDecrypt: open, SIV_MAX_AD, SIV_PLAINTEXT_MAX, SIV_CIPHERTEXT_MAX, SIV_MAX_AD_BYTES } = require("../build/aesSiv.js");
const unhex = text => new Uint8Array(Buffer.from(text.replaceAll(" ", ""), "hex"));
const hex = bytes => Buffer.from(bytes).toString("hex");
const pattern = n => Uint8Array.from({ length: n }, (_, i) => (i * 17 + 3) & 255);
const key = pattern(64), ad = [new TextEncoder().encode("kind:synthetic"), pattern(31)];

const nistMessage = unhex("6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51 30c81c46a35ce411e5fbc1191a0a52ef f69f2445df4f9b17ad2b417be66c3710");
const nist = [
  ["2b7e151628aed2a6abf7158809cf4f3c", ["bb1d6929e95937287fa37d129b756746", "070a16b46b4d4144f79bdd9dd04a287c", "7d85449ea6ea19c823a7bf78837dfade", "51f0bebf7e3b9d92fc49741779363cfe"]],
  ["8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b", ["d17ddf46adaacde531cac483de7a9367", "9e99a7bf31e710900662f65e617c5184", "3d75c194ed96070444a9fa7ec740ecf8", "a1d5df0eed790f794d77589659f39a11"]],
  ["603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4", ["028962f61b7bf89efc6b551f4667d983", "28a7023f452e8f82bd4bf28d8c37c35c", "156727dc0878944a023c1fe03bad6d93", "e1992190549f6ed5696a2c056c315410"]],
];
for (const [raw, tags] of nist) for (const [i, length] of [0, 16, 20, 64].entries()) {
  test(`NIST CMAC AES-${raw.length * 4} ${length}B`, async () => assert.equal(hex(await aesCmac(unhex(raw), nistMessage.slice(0, length))), tags[i]));
}

const rfc = [
  { key: "fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff", ad: ["101112131415161718191a1b1c1d1e1f2021222324252627"], plaintext: "112233445566778899aabbccddee", sealed: "85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c" },
  { key: "7f7e7d7c7b7a79787776757473727170404142434445464748494a4b4c4d4e4f", ad: ["00112233445566778899aabbccddeeffdeaddadadeaddadaffeeddccbbaa99887766554433221100", "102030405060708090a0", "09f911029d74e35bd84156c5635688c0"], plaintext: "7468697320697320736f6d6520706c61696e7465787420746f20656e6372797074207573696e67205349562d414553", sealed: "7bdb6e3b432667eb06f4d14bff2fbd0fcb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d" },
];
for (const [i, vector] of rfc.entries()) test(`RFC5297 AppendixA.${i + 1} exact tag/ciphertext and plaintext`, async () => {
  const raw = unhex(vector.key), components = vector.ad.map(unhex), plaintext = unhex(vector.plaintext);
  assert.equal(hex(await seal(raw, plaintext, components)), vector.sealed);
  assert.deepEqual(await open(raw, unhex(vector.sealed), components), plaintext);
});

test("AES-SIV-CMAC-512 fixed independent EVP boundary oracles", async () => {
  const vector = require("./fixtures/aes-siv-512.json"), raw = unhex(vector.key), components = vector.ad.map(unhex);
  for (const row of vector.cases) {
    assert.equal(hex(await seal(raw, unhex(row.plaintext), components)), row.sealed);
    assert.deepEqual(await open(raw, unhex(row.sealed), components), unhex(row.plaintext));
  }
});

test("sealing and opening use no RNG when randomness fails or repeats", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "getRandomValues");
  t.after(() => { if (descriptor) Object.defineProperty(crypto, "getRandomValues", descriptor); else delete crypto.getRandomValues; });
  let calls = 0;
  const vector = rfc[0], raw = unhex(vector.key), plaintext = unhex(vector.plaintext), components = vector.ad.map(unhex);
  for (const mode of ["unavailable", "repeated"]) {
    crypto.getRandomValues = buffer => {
      calls++;
      if (mode === "unavailable") throw new Error("synthetic RNG unavailable");
      buffer.fill(0); return buffer;
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      let sealed, opened;
      await assert.doesNotReject(async () => { sealed = await seal(raw, plaintext, components); }, mode);
      assert.equal(hex(sealed), vector.sealed, mode);
      await assert.doesNotReject(async () => { opened = await open(raw, sealed, components); }, mode);
      assert.deepEqual(opened, plaintext, mode);
    }
    assert.equal(calls, 0, `no hidden randomness dependency: ${mode}`);
  }
});

test("RFC intermediate CMAC values fix the CBC prepared-block selection", async () => {
  const macKey = unhex(rfc[0].key).slice(0, 16);
  assert.equal(hex(await aesCmac(macKey, new Uint8Array(16))), "0e04dfafc1efbf040140582859bf073a");
  assert.equal(hex(await aesCmac(macKey, unhex(rfc[0].ad[0]))), "f1f922b7f5193ce64ff80cb47d93f23b");
});

test("empty/short/aligned/unaligned/large payloads and all RFC key widths repeat exactly", async () => {
  for (const width of [32, 48, 64]) for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 1024, 65537]) {
    const raw = pattern(width), plaintext = pattern(length), sealed = await seal(raw, plaintext, ad);
    assert.equal(sealed.length, plaintext.length + 16);
    assert.deepEqual(await seal(raw, plaintext, ad), sealed);
    assert.deepEqual(await open(raw, sealed, ad), plaintext);
  }
  assert.notDeepEqual(await seal(key, new Uint8Array()), await seal(key, new Uint8Array(), [new Uint8Array()]));
});

test("wrong key/AD order/kind/count/boundaries and every tag byte never release plaintext", async () => {
  const plaintext = pattern(33), sealed = await seal(key, plaintext, ad);
  const wrongKey = key.slice(); wrongKey[0] ^= 1;
  for (const [raw, components] of [[wrongKey, ad], [key, [...ad].reverse()], [key, [pattern(14), ad[1]]], [key, []], [key, [...ad, new Uint8Array()]], [key, [ad[0].slice(0, -1), new Uint8Array([ad[0].at(-1)]), ad[1]]]]) {
    await assert.rejects(open(raw, sealed, components), /siv: authentication failed/);
  }
  for (let at = 0; at < sealed.length; at++) {
    const changed = sealed.slice(); changed[at] ^= 1;
    await assert.rejects(open(key, changed, ad), /siv: authentication failed/);
  }
  // Masked counter bits still belong to the FULL unmasked authentication tag.
  for (const at of [8, 12]) { const changed = sealed.slice(); changed[at] ^= 0x80; await assert.rejects(open(key, changed, ad), /siv: authentication failed/); }
  // Empty plaintext makes every altered tag byte independently observable:
  // CTR has no bytes to transform, so a prefix-only tag comparison must fail.
  const empty = await seal(key, new Uint8Array(), ad);
  for (let at = 0; at < 16; at++) { const changed = empty.slice(); changed[at] ^= 1; await assert.rejects(open(key, changed, ad), /siv: authentication failed/); }
  for (let length = 0; length < 16; length++) await assert.rejects(open(key, sealed.slice(0, length), ad), /siv: truncated tag/);
  await assert.rejects(open(key, sealed.slice(0, -1), ad), /siv: authentication failed/);
});

test("strict key/input/AD ceilings refuse before any native operation and accept exact limits", async t => {
  assert.equal(SIV_MAX_AD, 126);
  assert.equal(SIV_PLAINTEXT_MAX, 8 << 20);
  assert.equal(SIV_CIPHERTEXT_MAX, (8 << 20) + 16);
  assert.equal(SIV_MAX_AD_BYTES, 8 << 20);
  const subtle = crypto.subtle, original = subtle.importKey.bind(subtle); let imports = 0; const handles = [];
  const descriptor = Object.getOwnPropertyDescriptor(subtle, "importKey");
  subtle.importKey = (...args) => { imports++; handles.push({ name: args[2], extractable: args[3] }); return original(...args); };
  t.after(() => { if (descriptor) Object.defineProperty(subtle, "importKey", descriptor); else delete subtle.importKey; });
  for (const width of [0, 16, 31, 33, 47, 49, 63, 65]) {
    await assert.rejects(seal(pattern(width), pattern(1)), /siv: invalid key length/);
    await assert.rejects(open(pattern(width), pattern(16)), /siv: invalid key length/);
  }
  for (const width of [0, 15, 17, 23, 25, 31, 33]) await assert.rejects(aesCmac(pattern(width), pattern(1)), /siv: invalid key length/);
  await assert.rejects(seal(key, pattern(SIV_PLAINTEXT_MAX + 1)), /siv: input too large/);
  await assert.rejects(aesCmac(pattern(16), pattern(SIV_PLAINTEXT_MAX + 1)), /siv: input too large/);
  await assert.rejects(open(key, pattern(SIV_CIPHERTEXT_MAX + 1)), /siv: input too large/);
  for (const operation of [seal, open]) {
    const input = pattern(operation === seal ? 1 : 16);
    await assert.rejects(operation(key, input, Array.from({ length: SIV_MAX_AD + 1 }, () => new Uint8Array())), /siv: too many AD components/);
    await assert.rejects(operation(key, input, [pattern(SIV_MAX_AD_BYTES), pattern(1)]), /siv: input too large/);
    await assert.rejects(operation(key, input, "not a vector"), /siv: too many AD components/);
    await assert.rejects(operation(key, new Uint8Array(new SharedArrayBuffer(16))), /siv: invalid bytes/);
    await assert.rejects(operation(key, input, ["not bytes"]), /siv: invalid bytes/);
  }
  assert.equal(imports, 0, "invalid inputs never reach native key import");
  const plaintext = pattern(SIV_PLAINTEXT_MAX), sealed = await seal(key, plaintext);
  assert.equal(sealed.length, SIV_CIPHERTEXT_MAX);
  assert.deepEqual(await open(key, sealed), plaintext);
  assert.deepEqual(await open(key, await seal(key, pattern(1), Array.from({ length: SIV_MAX_AD }, () => new Uint8Array())), Array.from({ length: SIV_MAX_AD }, () => new Uint8Array())), pattern(1));
  const fullAd = [pattern(SIV_MAX_AD_BYTES)];
  assert.deepEqual(await open(key, await seal(key, pattern(1), fullAd), fullAd), pattern(1));
  assert.ok(handles.every(handle => handle.extractable === false), "native mode keys are never exportable");
  assert.deepEqual([...new Set(handles.map(handle => handle.name))].sort(), ["AES-CBC", "AES-CTR"]);
});

test("key/plaintext/AD/sealed buffers are captured before the first native await", async () => {
  const raw = key.slice(), plaintext = pattern(33), components = ad.map(a => a.slice());
  const expected = await seal(raw, plaintext, components);
  const sealing = seal(raw, plaintext, components);
  raw.fill(0); plaintext.fill(0); components.forEach(a => a.fill(0)); components.length = 0;
  assert.deepEqual(await sealing, expected);
  const encrypted = expected.slice(), openingKey = key.slice(), openingAd = ad.map(a => a.slice());
  const opening = open(openingKey, encrypted, openingAd);
  encrypted.fill(0); openingKey.fill(0); openingAd.forEach(a => a.fill(0)); openingAd.length = 0;
  let opened;
  await assert.doesNotReject(async () => { opened = await opening; });
  assert.deepEqual(opened, pattern(33));
  const cmacKey = pattern(16), message = pattern(31), tag = await aesCmac(cmacKey, message);
  const pending = aesCmac(cmacKey, message); cmacKey.fill(0); message.fill(0);
  assert.deepEqual(await pending, tag);
});

test("accepted Node Buffer views are copied as bytes, not retained through Buffer.slice", async () => {
  const raw = Buffer.from(key), plaintext = Buffer.from(pattern(33)), components = ad.map(a => Buffer.from(a));
  const expected = await seal(key, pattern(33), ad), pending = seal(raw, plaintext, components);
  raw.fill(0); plaintext.fill(0); components.forEach(a => a.fill(0));
  assert.deepEqual(await pending, expected);
  const source = Buffer.from(expected), opening = open(key, source, ad);
  source.fill(0);
  assert.deepEqual(await opening, pattern(33));
});

test("failed tag verification wipes private native plaintext; native failures have no fallback", async t => {
  const sealed = await seal(key, pattern(31), ad); sealed[0] ^= 1;
  const subtle = crypto.subtle, original = subtle.decrypt.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "decrypt");
  let candidate;
  subtle.decrypt = async (...args) => { const buffer = await original(...args); candidate = new Uint8Array(buffer); return buffer; };
  t.after(() => { if (descriptor) Object.defineProperty(subtle, "decrypt", descriptor); else delete subtle.decrypt; });
  await assert.rejects(open(key, sealed, ad), /siv: authentication failed/);
  assert.ok(candidate && candidate.length === 31);
  assert.ok(candidate.every(byte => byte === 0), "unverified bytes wiped after refusal");
  const unavailable = new DOMException("synthetic unsupported native CTR", "NotSupportedError");
  subtle.decrypt = async () => { throw unavailable; };
  await assert.rejects(open(key, sealed, ad), error => error === unavailable);
});

test("8MiB payload uses one native bulk CBC per CMAC, with no per-block await", async t => {
  const subtle = crypto.subtle, original = subtle.encrypt.bind(subtle), descriptor = Object.getOwnPropertyDescriptor(subtle, "encrypt"), calls = [];
  subtle.encrypt = (...args) => { const algorithm = args[0]; calls.push({ name: algorithm.name, size: args[2].byteLength, ...(algorithm.name === "AES-CBC" ? { iv: hex(algorithm.iv) } : { length: algorithm.length, mask8: algorithm.counter[8] & 0x80, mask12: algorithm.counter[12] & 0x80 }) }); return original(...args); };
  t.after(() => { if (descriptor) Object.defineProperty(subtle, "encrypt", descriptor); else delete subtle.encrypt; });
  await seal(key, pattern(SIV_PLAINTEXT_MAX), []);
  assert.deepEqual(calls, [{ name: "AES-CBC", size: 16, iv: "00".repeat(16) }, { name: "AES-CBC", size: 16, iv: "00".repeat(16) }, { name: "AES-CBC", size: SIV_PLAINTEXT_MAX, iv: "00".repeat(16) }, { name: "AES-CTR", size: SIV_PLAINTEXT_MAX, length: 128, mask8: 0, mask12: 0 }]);
});
