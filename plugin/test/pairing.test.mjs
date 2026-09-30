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
  // Refusals say what to paste, never what failed to decode (issue #154).
  assert.throws(() => pairing.decodePairingCode(code.slice(0, 40)), /^Error: That pairing code is incomplete\. Copy all of it again/);
  assert.throws(() => pairing.decodePairingCode("not a code!"), /^Error: That is not a pairing code\. Paste the code, or the link/);
  for (const bad of ["not a code!", code.slice(0, 40)]) {
    assert.throws(() => pairing.decodePairingCode(bad), (error) => !/base32|character|bytes/.test(error.message));
  }
});

test("a pasted pairing link, or a code in quotes, decodes to the code it carries (#154)", () => {
  const secret = bytes("101112131415161718191a1b1c1d1e1f");
  const code = pairing.encodePairingCode(PAIRING_ID, ENROLL_TOKEN, secret);
  const want = pairing.decodePairingCode(code);
  for (const pasted of [
    pairing.pairingLink(code),
    `  ${pairing.pairingLink(code)}\n`,
    `obsidian://obsync-private-sync?code=${code}`,
    `obsidian://obsync-private-sync/pair?x=1&code=${code}&y=2`,
    `"${code}"`, `“${code}”`, `<${code}>`, `'${code}'`,
  ]) {
    assert.deepEqual(pairing.decodePairingCode(pasted), want, pasted);
  }
});

test("the match code is six digits of HKDF over the secret, the pairing and the claimant (#152)", async () => {
  const secret = bytes("101112131415161718191a1b1c1d1e1f");
  const device = "aabbccddeeff00112233445566778899";
  const code = await pairing.matchCode(secret, PAIRING_ID, device);
  assert.match(code, /^\d{3} \d{3}$/);
  const derived = await c.hkdf(secret, c.utf8("obsync/v1/pair-match"), c.utf8(`${PAIRING_ID}:${device}`), 4);
  const expected = String(new DataView(derived.buffer).getUint32(0) % 1_000_000).padStart(6, "0");
  assert.equal(code.replace(" ", ""), expected, "both ends derive it the same way, with no wire field");
  assert.equal(await pairing.matchCode(secret, PAIRING_ID, device), code, "deterministic");
  // Each input moves it: another claimant, another pairing, another secret.
  const others = [
    await pairing.matchCode(secret, PAIRING_ID, "aabbccddeeff00112233445566778898"),
    await pairing.matchCode(secret, "fe".repeat(16), device),
    await pairing.matchCode(bytes("101112131415161718191a1b1c1d1e1e"), PAIRING_ID, device),
  ];
  for (const other of others) assert.notEqual(other, code);
});

test("platform words read as what a person calls the device; anything else is a device (#152)", () => {
  assert.deepEqual(
    ["macos", "windows", "linux", "ios", "ipados", "android"].map(pairing.platformLabel),
    ["Mac", "Windows PC", "Linux PC", "iPhone", "iPad", "Android"],
  );
  for (const hostile of ["__proto__", "constructor", "hasOwnProperty", "", "MACOS"]) {
    assert.equal(pairing.platformLabel(hostile), "device", hostile);
  }
});

test("a device tag is four unambiguous characters, made fresh each time (#152)", () => {
  const tags = new Set();
  for (let draw = 0; draw < 200; draw++) {
    const tag = pairing.newDeviceTag();
    assert.match(tag, /^[2-9A-HJKMNP-TV-Z]{4}$/);
    tags.add(tag);
  }
  assert.ok(tags.size > 190, `only ${tags.size} distinct tags in 200 draws`);
});

test("a pasted setup token loses quotes, spaces and line breaks, and nothing else (#154)", () => {
  const token = "ab".repeat(32);
  for (const pasted of [token, ` ${token} `, `"${token}"`, `“${token}”`, `'${token}'\n`,
    `${token.slice(0, 30)}\n${token.slice(30)}`, `${token.slice(0, 10)} ${token.slice(10)}`]) {
    assert.equal(pairing.pastedToken(pasted), token, JSON.stringify(pasted));
  }
  assert.equal(pairing.pastedToken("other-server-token"), "other-server-token");
});

test("every setup and pairing refusal reads as what happened and what to do, never a code (#154)", () => {
  const { ApiError } = require("../build/transport.js");
  const codes = ["bad_setup_token", "already_set_up", "not_set_up", "unknown_pairing", "pairing_expired",
    "already_claimed", "stale_timestamp", "edge_required", "device_revoked"];
  const texts = new Set();
  for (const code of codes) {
    const text = pairing.refusalText(new ApiError(400, code, "server detail sentinel"));
    assert.ok(text.length > 40, code);
    assert.ok(!text.includes(code) && !text.includes("server detail sentinel") && !/\b\d{3}\b/.test(text), text);
    texts.add(text);
  }
  assert.equal(texts.size, codes.length, "each refusal has its own words");
  assert.match(pairing.refusalFor("pairing_expired"), /expired.*Pair a new device/);
  assert.match(pairing.refusalFor("unknown_pairing"), /does not match a pairing.*Pair a new device/);
  assert.match(pairing.refusalFor("already_set_up"), /Pair a new device.*Pair this device/);
  const unknown = pairing.refusalText(new ApiError(418, "teapot_code", "sentinel"));
  assert.ok(!unknown.includes("teapot_code") && !unknown.includes("418"), unknown);
  assert.equal(pairing.refusalText(new Error("this plugin's own words")), "this plugin's own words");
  for (const empty of [new Error(""), "", null, { name: "OperationError" }]) {
    assert.match(pairing.refusalText(empty), /^Something went wrong on this device before anything was shared/);
  }
});

/*
 * A CERTIFICATE THIS DEVICE DOES NOT TRUST (the #201 CI lane: Check read
 * `0 unreachable: network=net::ERR_CERT_AUTHORITY_INVALID` after 85 s). Each
 * platform's own words for an unknown authority are that one failure, said
 * the same way by the status, Check, setup and pairing; absence, a wrong name
 * and an expired certificate are not it, and nothing but absence is offline.
 */
test("a certificate from an authority this device does not trust is said as that, on every path and platform", () => {
  const { ApiError, CERT_UNTRUSTED, certificateRefusal } = require("../build/transport.js");
  const { refusalStatus, refusalText } = require("../build/sync/engine.js");
  assert.equal(CERT_UNTRUSTED, "This device does not trust your server's certificate, so it refused the connection. " +
    "Trust that certificate on this device. See Troubleshooting, \"The certificate is not trusted on this device\".");
  const untrusted = [
    "network=net::ERR_CERT_AUTHORITY_INVALID",
    "network=The certificate for this server was signed by an unknown certifying authority.",
    "network=java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.",
  ];
  for (const reason of untrusted) {
    const error = new ApiError(0, "unreachable", reason);
    assert.equal(certificateRefusal(error), CERT_UNTRUSTED, reason);
    assert.deepEqual(refusalStatus(error), { kind: "error", code: "certificate", message: CERT_UNTRUSTED }, reason);
    assert.equal(refusalText(error), CERT_UNTRUSTED, reason);
    assert.equal(pairing.refusalText(error), CERT_UNTRUSTED, reason);
  }
  for (const reason of ["network=net::ERR_CONNECTION_REFUSED", "timeout budget_ms=10000"]) {
    assert.deepEqual(refusalStatus(new ApiError(0, "unreachable", reason)), { kind: "offline" }, reason);
  }
  // Only the transport's own verdict: a server's refusal naming it is the server's refusal.
  assert.equal(certificateRefusal(new ApiError(400, "bad_request", "ERR_CERT_AUTHORITY_INVALID")), null);
  assert.equal(certificateRefusal(new Error("network=net::ERR_CERT_AUTHORITY_INVALID")), null);
});

/*
 * A CERTIFICATE FOR ANOTHER NAME, AND ONE OUT OF DATE (#229). Check said
 * "Nothing answered at <url>" and the status read offline, when something had
 * answered and this device's own TLS refused what it showed. Each platform's
 * words for each refusal are that refusal, said the same way by the status,
 * Check, setup and pairing; the desktop's are Chromium's, the phones' are the
 * platforms' documented messages. Absence, a timeout and every other TLS
 * failure still read as absence: none of them is named for what it is not.
 */
test("a certificate for another name or out of date is said as that, on every path and platform (#229)", () => {
  const { ApiError, CERT_OUT_OF_DATE, CERT_WRONG_NAME, certificateRefusal } = require("../build/transport.js");
  const { refusalStatus, refusalText } = require("../build/sync/engine.js");
  assert.equal(CERT_WRONG_NAME, "This device refused your server's certificate because it was made for another name than " +
    "the one in the Server URL. Use the name it was made for in the Server URL, or make the certificate again for this " +
    "name. See Troubleshooting, \"The certificate is for another name\".");
  assert.equal(CERT_OUT_OF_DATE, "This device refused your server's certificate because it has expired or is not valid " +
    "yet. Renew the certificate on your server, or check that this device's date and time are right.");
  const refused = [
    // Chromium, on desktop.
    ["network=net::ERR_CERT_COMMON_NAME_INVALID", CERT_WRONG_NAME],
    ["network=net::ERR_CERT_DATE_INVALID", CERT_OUT_OF_DATE],
    // Apple: the trust evaluation's words for a name, the URL system's for a date.
    ["network=“192.168.1.10” certificate name does not match input", CERT_WRONG_NAME],
    ["network=The certificate for this server has expired. You might be connecting to a server that is pretending to be " +
      "“sync.example.invalid” which could put your confidential information at risk.", CERT_OUT_OF_DATE],
    ["network=The certificate for this server is not yet valid. You might be connecting to a server that is pretending to " +
      "be “sync.example.invalid” which could put your confidential information at risk.", CERT_OUT_OF_DATE],
    // Android.
    ["network=javax.net.ssl.SSLPeerUnverifiedException: Hostname 192.168.1.10 not verified:", CERT_WRONG_NAME],
    ["network=javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: timestamp check failed",
      CERT_OUT_OF_DATE],
  ];
  for (const [reason, words] of refused) {
    const error = new ApiError(0, "unreachable", reason);
    assert.equal(certificateRefusal(error), words, reason);
    assert.deepEqual(refusalStatus(error), { kind: "error", code: "certificate", message: words }, reason);
    assert.equal(refusalText(error), words, `${reason}: Check and the device list`);
    assert.equal(pairing.refusalText(error), words, `${reason}: setup and pairing`);
  }
  for (const reason of ["network=net::ERR_CONNECTION_REFUSED", "network=net::ERR_CONNECTION_TIMED_OUT",
    "timeout budget_ms=10000", "network=net::ERR_CERT_REVOKED", "network=net::ERR_SSL_PROTOCOL_ERROR",
    "network=The certificate for this server is invalid. You might be connecting to a server that is pretending to be " +
      "“sync.example.invalid” which could put your confidential information at risk."]) {
    const error = new ApiError(0, "unreachable", reason);
    assert.equal(certificateRefusal(error), null, reason);
    assert.deepEqual(refusalStatus(error), { kind: "offline" }, `${reason}: absence, and retried as absence`);
  }
  assert.equal(certificateRefusal(new ApiError(400, "bad_request", "ERR_CERT_DATE_INVALID")), null);
});

/*
 * A REQUEST THAT DID NOT COME THROUGH THE SERVER'S EDGE (`421 edge_required`,
 * #228). A first pairing said so; a running device and a restart said only
 * that changes could not be read, or that the server refused. One set of
 * words now, from one constant: pairing's, and the status adds that it retries.
 */
test("pairing, the status and Check say an edge refusal in the same words (#228)", () => {
  const { ApiError, EDGE_REQUIRED } = require("../build/transport.js");
  const { RESUMES, refusalStatus, refusalText } = require("../build/sync/engine.js");
  assert.equal(EDGE_REQUIRED, "This server only answers through its access-controlled edge, and this request did not come " +
    "through it. Check the Server URL and the Custom request headers in obsync settings, and that your route to the server " +
    "goes through that edge.");
  const error = new ApiError(421, "edge_required", "edge connecting-address header missing");
  assert.equal(pairing.refusalText(error), EDGE_REQUIRED);
  assert.deepEqual(refusalStatus(error), { kind: "error", code: "edge", message: `${EDGE_REQUIRED} ${RESUMES}` });
  assert.equal(refusalText(error), EDGE_REQUIRED, "Check and the device list say pairing's words exactly");
});

test("a held claim is read back exactly, and anything else is no claim (#153)", () => {
  const claim = { pairingId: PAIRING_ID, pairingSecret: "10".repeat(16), deviceId: "aa".repeat(16),
    deviceSecret: "0f".repeat(32), serverUrl: "https://sync.example.invalid", claimedAt: 1757200000000 };
  assert.deepEqual(pairing.readClaim(JSON.stringify({ ...claim, extra: "dropped" })), claim);
  for (const bad of [null, "", "{", "null", "[]", JSON.stringify({ ...claim, pairingSecret: "10" }),
    JSON.stringify({ ...claim, deviceId: "ZZ".repeat(16) }), JSON.stringify({ ...claim, claimedAt: "1" }),
    JSON.stringify({ ...claim, serverUrl: 7 }), JSON.stringify({ ...claim, deviceSecret: undefined })]) {
    assert.equal(pairing.readClaim(bad), null, String(bad));
  }
});

test("the pairing link is an obsidian URI carrying the code", () => {
  const code = pairing.encodePairingCode(PAIRING_ID, ENROLL_TOKEN, new Uint8Array(16));
  const link = pairing.pairingLink(code);
  assert.equal(link.startsWith("obsidian://obsync-private-sync/pair?code="), true);
  assert.equal(new URL(link).searchParams.get("code"), code);
  const manifest = JSON.parse(readFileSync(join(here, "..", "..", "manifest.json"), "utf8"));
  assert.equal(new URL(link).hostname, manifest.id);
});

test("the envelope opens only with the right pairing secret and id", async () => {
  const secret = pairing.newPairingSecret();
  // The vault key is the whole envelope: which paths live in which domain
  // comes from the synced map, which this key is exactly what unlocks.
  const envelope = { vrk: "00".repeat(32) };
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
  const sealed = await pairing.sealEnvelope(secret, PAIRING_ID, {});
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


test("sealed claimant vault details bind the pairing and use a separate key (#141)", async () => {
  const secret = pairing.newPairingSecret();
  const details = { name: "Research & <plans>", notes: 123 };
  const sealed = await pairing.sealPairingVault(secret, PAIRING_ID, details);
  assert.deepEqual(await pairing.openPairingVault(secret, PAIRING_ID, sealed), details);
  assert.ok(!JSON.stringify(sealed).includes(details.name));
  assert.notEqual((await pairing.sealPairingVault(secret, PAIRING_ID, details)).nonce, sealed.nonce);
  await assert.rejects(() => pairing.openPairingVault(pairing.newPairingSecret(), PAIRING_ID, sealed));
  await assert.rejects(() => pairing.openPairingVault(secret, "00".repeat(16), sealed));
  await assert.rejects(() => pairing.openEnvelope(secret, PAIRING_ID, sealed.envelope, sealed.nonce));
  const key = await crypto.subtle.importKey("raw", await c.hkdf(secret, c.utf8("obsync/v1/pair-vault"), c.utf8(PAIRING_ID), 32), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: c.unhex(sealed.nonce), additionalData: c.utf8(PAIRING_ID) }, key, c.unbase64(sealed.envelope));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), details);
  const damaged = c.unbase64(sealed.envelope); damaged[0] ^= 1;
  await assert.rejects(() => pairing.openPairingVault(secret, PAIRING_ID, { ...sealed, envelope: c.base64(damaged) }));
});

test("claimant vault validation bounds names, counts and sealed wire data (#141)", async () => {
  const secret = pairing.newPairingSecret();
  for (const value of [null, {}, { name: "", notes: 0 }, { name: "a".repeat(257), notes: 0 }, { name: "a\n", notes: 0 },
    { name: "a\u202e", notes: 0 }, { name: 7, notes: 0 }, { name: "a", notes: -1 }, { name: "a", notes: 0.5 }, { name: "a", notes: 2 ** 53 }]) {
    await assert.rejects(() => pairing.sealPairingVault(secret, PAIRING_ID, value), /invalid vault details/);
  }
  // Each edge of the refused characters, and the neighbour just outside it.
  for (const char of ["\u0000", "\u001f", "\u007f", "\u202a", "\u2066", "\u2069"]) {
    await assert.rejects(() => pairing.sealPairingVault(secret, PAIRING_ID, { name: `a${char}b`, notes: 0 }), /invalid vault details/, JSON.stringify(char));
  }
  const shown = "a ~\u2029\u202f\u2065\u2070\u{1F600}";
  assert.equal((await pairing.openPairingVault(secret, PAIRING_ID, await pairing.sealPairingVault(secret, PAIRING_ID, { name: shown, notes: 0 }))).name, shown);
  const sealed = await pairing.sealPairingVault(secret, PAIRING_ID, { name: "a".repeat(256), notes: 0 });
  assert.equal((await pairing.openPairingVault(secret, PAIRING_ID, sealed)).name.length, 256);
  for (const value of [null, {}, { ...sealed, envelope: 12 }, { ...sealed, envelope: "A".repeat(2049) }, { ...sealed, nonce: "00" }, { ...sealed, nonce: "Z".repeat(24) }]) {
    await assert.rejects(() => pairing.openPairingVault(secret, PAIRING_ID, value), /invalid sealed vault details/);
  }
  // A hostile claimant can encrypt malformed metadata correctly; authenticity is not validity.
  const key = await crypto.subtle.importKey("raw", await c.hkdf(secret, c.utf8("obsync/v1/pair-vault"), c.utf8(PAIRING_ID), 32), "AES-GCM", false, ["encrypt"]);
  for (const text of ['null', '{"name":"","notes":0}', '{"name":"a","notes":-1}']) {
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: c.unhex(sealed.nonce), additionalData: c.utf8(PAIRING_ID) }, key, c.utf8(text));
    await assert.rejects(() => pairing.openPairingVault(secret, PAIRING_ID, { ...sealed, envelope: c.base64(new Uint8Array(encrypted)) }), /invalid vault details/);
  }
});
