/**
 * Pairing codes, the sealed vault-key envelope, and the BIP-0039 recovery
 * phrase — including the published all-zero and all-one mnemonics, which
 * prove the encoding is the standard one and not merely self-consistent.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pairing = require("../build/pairing.js");
const { WORDLIST } = require("../build/wordlist.js");
const c = require("../build/crypto.js");

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const PAIRING_ID = "fedcba9876543210fedcba9876543210";
const ENROLL_TOKEN = "1122334455667788990011223344556677889900112233445566778899001122";

test("the vendored wordlist is the canonical BIP-0039 English list", () => {
  const file = readFileSync(join(here, "..", "vendor", "bip39", "english.txt"));
  assert.equal(
    createHash("sha256").update(file).digest("hex"),
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda",
    "vendor/bip39/english.txt no longer matches the published checksum",
  );
  const words = file.toString("utf8").split("\n").filter((word) => word !== "");
  assert.equal(words.length, 2048);
  assert.deepEqual(Array.from(WORDLIST), words, "src/wordlist.ts drifted from the vendored file");
  assert.deepEqual(words, [...words].sort(), "the list is sorted");
});

test("a pairing code carries exactly the three parts", () => {
  const secret = pairing.newPairingSecret();
  assert.equal(secret.length, 16);
  const code = pairing.encodePairingCode(PAIRING_ID, ENROLL_TOKEN, secret);
  assert.equal(code.length, 103, "64 bytes of base32, unpadded");
  assert.equal(/^[A-Z2-7]+$/.test(code), true, "RFC 4648 uppercase alphabet");
  const decoded = pairing.decodePairingCode(code);
  assert.equal(decoded.pairingId, PAIRING_ID);
  assert.equal(decoded.enrollToken, ENROLL_TOKEN);
  assert.deepEqual(decoded.pairingSecret, secret);
});

test("a code survives the way people retype it, and a short one is refused", () => {
  const secret = bytes("101112131415161718191a1b1c1d1e1f");
  const code = pairing.encodePairingCode(PAIRING_ID, ENROLL_TOKEN, secret);
  const mangled = `${code.slice(0, 20).toLowerCase()} ${code.slice(20, 60)}-${code.slice(60)}`;
  assert.deepEqual(pairing.decodePairingCode(mangled), pairing.decodePairingCode(code));
  assert.throws(() => pairing.decodePairingCode(code.slice(0, 40)), /too short/);
  assert.throws(() => pairing.decodePairingCode("not a code!"), /invalid character/);
});

test("the pairing link is an obsidian URI carrying the code", () => {
  const code = pairing.encodePairingCode(PAIRING_ID, ENROLL_TOKEN, new Uint8Array(16));
  const link = pairing.pairingLink(code);
  assert.equal(link.startsWith("obsidian://obsync/pair?code="), true);
  assert.equal(new URL(link).searchParams.get("code"), code);
});

test("the envelope opens only with the right pairing secret and id", async () => {
  const secret = pairing.newPairingSecret();
  const envelope = { vrk: "00".repeat(32), domains: { "0123456789abcdef0123456789abcdef": "" } };
  const sealed = await pairing.sealEnvelope(secret, PAIRING_ID, envelope);
  assert.equal(sealed.nonce.length, 24);
  assert.deepEqual(await pairing.openEnvelope(secret, PAIRING_ID, sealed.envelope, sealed.nonce), envelope);

  const other = pairing.newPairingSecret();
  await assert.rejects(() => pairing.openEnvelope(other, PAIRING_ID, sealed.envelope, sealed.nonce));
  await assert.rejects(() =>
    pairing.openEnvelope(secret, "00000000000000000000000000000000", sealed.envelope, sealed.nonce),
  );

  // The key really is HKDF(PS, "obsync/v1/pair", pairing_id).
  const derived = await c.pairingKey(secret, PAIRING_ID);
  assert.equal(derived.length, 32);
  assert.equal(
    c.hex(derived),
    c.hex(await c.hkdf(secret, c.utf8("obsync/v1/pair"), c.utf8(PAIRING_ID), 32)),
  );
});

test("an envelope without a vault key is refused", async () => {
  const secret = pairing.newPairingSecret();
  const sealed = await pairing.sealEnvelope(secret, PAIRING_ID, { domains: {} });
  await assert.rejects(
    () => pairing.openEnvelope(secret, PAIRING_ID, sealed.envelope, sealed.nonce),
    /no vault key/,
  );
});

test("the recovery phrase matches the published BIP-0039 vectors", async () => {
  const zeros = await pairing.recoveryPhrase(new Uint8Array(32));
  assert.equal(zeros.length, 24);
  assert.equal(zeros.join(" "), `${"abandon ".repeat(23)}art`);

  const ones = await pairing.recoveryPhrase(Uint8Array.from({ length: 32 }, () => 0xff));
  assert.equal(ones.join(" "), `${"zoo ".repeat(23)}vote`);

  const eighties = await pairing.recoveryPhrase(Uint8Array.from({ length: 32 }, () => 0x80));
  assert.equal(
    eighties.join(" "),
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd " +
      "amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
  );
});

test("a phrase round-trips to the same vault key", async () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = pairing.newVaultKey();
    assert.equal(key.length, 32);
    const words = await pairing.recoveryPhrase(key);
    assert.equal(words.length, 24);
    for (const word of words) assert.ok(WORDLIST.includes(word), word);
    assert.deepEqual(await pairing.entropyFromPhrase(words), key);
    assert.deepEqual(await pairing.entropyFromPhrase(pairing.normalisePhrase(`  ${words.join("  ")}\n`)), key);
  }
});

test("a mistyped, reordered or truncated phrase is refused by the checksum", async () => {
  const key = bytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
  const words = await pairing.recoveryPhrase(key);

  const swapped = [...words];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  await assert.rejects(() => pairing.entropyFromPhrase(swapped), /checksum/);

  const wrongWord = [...words];
  wrongWord[5] = WORDLIST[(WORDLIST.indexOf(wrongWord[5]) + 1) % 2048];
  await assert.rejects(() => pairing.entropyFromPhrase(wrongWord), /checksum/);

  await assert.rejects(() => pairing.entropyFromPhrase(words.slice(0, 23)), /expected 24 words/);
  await assert.rejects(() => pairing.entropyFromPhrase([...words, "abandon"]), /expected 24 words/);
  await assert.rejects(
    () => pairing.entropyFromPhrase([...words.slice(0, 23), "notaword"]),
    /is not a recovery word/,
  );
  await assert.rejects(() => pairing.recoveryPhrase(new Uint8Array(16)), /32 bytes/);
});

test("checksum rejection is not a coincidence of one key", async () => {
  // Every single-word substitution in a phrase must fail: with an 8-bit
  // checksum a wrong word passes with probability 1/256, so a run of these
  // proves the checksum is actually consulted.
  let rejected = 0;
  const key = pairing.newVaultKey();
  const words = await pairing.recoveryPhrase(key);
  for (let position = 0; position < 24; position++) {
    for (const step of [1, 977, 2047]) {
      const candidate = [...words];
      candidate[position] = WORDLIST[(WORDLIST.indexOf(candidate[position]) + step) % 2048];
      try {
        const entropy = await pairing.entropyFromPhrase(candidate);
        // A collision is allowed by the format, but the key must then differ.
        assert.notDeepEqual(entropy, key);
      } catch (error) {
        assert.match(String(error), /checksum/);
        rejected++;
      }
    }
  }
  assert.ok(rejected > 60, `only ${rejected} of 72 substitutions were rejected`);
});

test("a domain id is 16 fresh bytes of hex", () => {
  const first = pairing.newDomainId();
  assert.equal(c.isHex(first, 16), true);
  assert.notEqual(first, pairing.newDomainId());
});
