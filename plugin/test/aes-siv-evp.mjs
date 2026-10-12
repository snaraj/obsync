/** Explicit test-only differential run; requires compiled fixtures/siv-reference.c.
 * Build with system OpenSSL EVP headers/libcrypto, then:
 * node test/aes-siv-evp.mjs /absolute/path/to/siv-reference
 * Not a runtime dependency, automatic skip, or substitute for native phone acceptance.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { aesSivEncrypt: seal, aesSivDecrypt: open, SIV_PLAINTEXT_MAX } = require("../build/aesSiv.js");
const helper = process.argv[2];
assert.ok(helper, "provide the independently linked EVP helper");
const pattern = n => Uint8Array.from({ length: n }, (_, i) => (i * 19 + 7) & 255);
const hex = bytes => Buffer.from(bytes).toString("hex");
const unhex = text => new Uint8Array(Buffer.from(text, "hex"));
const invoke = (mode, raw, input, ad) => spawnSync(helper, [mode, hex(raw), ...ad.map(hex)], { input: Buffer.from(input), maxBuffer: SIV_PLAINTEXT_MAX + 2048, timeout: 10000 });
const reference = (mode, raw, input, ad) => {
  const result = invoke(mode, raw, input, ad);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `independent EVP ${mode} refused a valid case`);
  return new Uint8Array(result.stdout);
};
const provenance = spawnSync(helper, ["--version"], { encoding: "utf8", timeout: 10000 });
assert.equal(provenance.status, 0);
assert.match(provenance.stdout, /^OpenSSL .* AES-256-SIV provider=default\s*$/);
// Validate the wrapper itself against the published 32-byte-key examples.
const rfc = [
  ["fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff", ["101112131415161718191a1b1c1d1e1f2021222324252627"], "112233445566778899aabbccddee", "85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c"],
  ["7f7e7d7c7b7a79787776757473727170404142434445464748494a4b4c4d4e4f", ["00112233445566778899aabbccddeeffdeaddadadeaddadaffeeddccbbaa99887766554433221100", "102030405060708090a0", "09f911029d74e35bd84156c5635688c0"], "7468697320697320736f6d6520706c61696e7465787420746f20656e6372797074207573696e67205349562d414553", "7bdb6e3b432667eb06f4d14bff2fbd0fcb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d"],
];
for (const [raw, ad, plaintext, expected] of rfc) assert.equal(hex(reference("seal", unhex(raw), unhex(plaintext), ad.map(unhex))), expected);
let cases = 0, crossDecrypts = 0;
const started = performance.now();
for (const width of [32, 48, 64]) for (const size of [0, 1, 15, 16, 17, 31, 32, 33, 255, 256, 4097]) for (const ad of [[], [new Uint8Array()], [pattern(15)], [pattern(16), pattern(17)]]) {
  const raw = pattern(width), plaintext = pattern(size), actual = await seal(raw, plaintext, ad), independent = reference("seal", raw, plaintext, ad);
  assert.deepEqual(actual, independent, `key=${width} size=${size} components=${ad.length}`);
  assert.deepEqual(await open(raw, independent, ad), plaintext);
  assert.deepEqual(reference("open", raw, actual, ad), plaintext);
  cases++; crossDecrypts += 2;
}
const raw = pattern(64), plaintext = pattern(SIV_PLAINTEXT_MAX), ad = [pattern(9), pattern(48)];
const actual = await seal(raw, plaintext, ad), independent = reference("seal", raw, plaintext, ad);
assert.deepEqual(actual, independent);
assert.deepEqual(await open(raw, independent, ad), plaintext);
assert.deepEqual(reference("open", raw, actual, ad), plaintext);
cases++; crossDecrypts += 2;
const small = await seal(raw, pattern(33), ad), negatives = [];
for (const at of [0, 8, 12, 15, 16, small.length - 1]) { const damaged = small.slice(); damaged[at] ^= 1; negatives.push([raw, damaged, ad]); }
const wrongKey = raw.slice(); wrongKey[0] ^= 1;
negatives.push([wrongKey, small, ad], [raw, small, [...ad].reverse()], [raw, small.slice(0, 15), ad], [raw, small.slice(0, -1), ad]);
for (const [key, input, associated] of negatives) {
  const result = invoke("open", key, input, associated);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "independent EVP authentication refusal");
  assert.equal(result.stdout.length, 0, "no unauthenticated plaintext output");
}
console.log(JSON.stringify({ node: process.version, node_openssl: process.versions.openssl, independent: provenance.stdout.trim(), rfc_wrapper_vectors: 2, differential_cases: cases, cross_decryptions: crossDecrypts, independent_negative_cases: negatives.length, payload_max: SIV_PLAINTEXT_MAX, elapsed_ms: Math.round(performance.now() - started) }));
