/**
 * Regenerates `pairing-v2.json`, the pairing v2 known-answer vector.
 *
 *   node plugin/test/fixtures/generate-pairing-v2.mjs
 *
 * Every input is a visible sentinel, never a real key: the two P-256 private
 * scalars are the bytes 01 01 … 01 and 02 02 … 02 (both in range), the pairing
 * secret is the v2 marker 0b 5c followed by 01 … 0e, and the pairing id counts
 * 0123…ef twice. Everything else -- the public points, the raw uncompressed
 * keys the wire carries, and the derived envelope key -- follows from those,
 * computed here with Node's built-in WebCrypto only, independently of the
 * plugin's own code: `K = HKDF-SHA-256(ikm = ECDH(claimant, creator), salt =
 * PS, info = "obsync/v2/pair" || pairing_id)` (`docs/protocol.md`, "Pairing
 * v2").
 *
 * `pairing-v2.test.mjs` checks the committed JSON against this function on
 * every run, so the vector is regenerable rather than taken on trust.
 * Importing this file does nothing: it only writes when run directly.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const subtle = globalThis.crypto.subtle;

/** 01 01 … 01 and 02 02 … 02: obviously sentinels, and valid P-256 scalars. */
const CLAIMANT_SCALAR = new Uint8Array(32).fill(0x01);
const CREATOR_SCALAR = new Uint8Array(32).fill(0x02);
const PS_HEX = "0b5c0102030405060708090a0b0c0d0e";
const PAIRING_ID = "0123456789abcdef0123456789abcdef";
const LABEL = "obsync/v2/pair";

/**
 * A PKCS #8 P-256 private key holding only the scalar (RFC 5915, the public
 * key omitted): the one form WebCrypto imports from a scalar alone, which it
 * then exports as a full JWK with the public point it computed.
 */
function pkcs8(scalar) {
  const head = Uint8Array.from([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
    0x01, 0x04, 0x20,
  ]);
  const out = new Uint8Array(head.length + scalar.length);
  out.set(head);
  out.set(scalar, head.length);
  return out;
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const unhex = (text) => Uint8Array.from(Buffer.from(text, "hex"));

async function party(scalar) {
  const key = await subtle.importKey("pkcs8", pkcs8(scalar), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", key);
  const priv = { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y, key_ops: ["deriveBits"], ext: true };
  const pub = await subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { key, pub, priv, raw: b64url(new Uint8Array(await subtle.exportKey("raw", pub))) };
}

/** The whole vector, in the shape `pairing-v2.test.mjs` reads. */
export async function pairingV2Vector() {
  const claimant = await party(CLAIMANT_SCALAR);
  const creator = await party(CREATOR_SCALAR);
  const shared = await subtle.deriveBits({ name: "ECDH", public: creator.pub }, claimant.key, 256);
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const info = new TextEncoder().encode(LABEL + PAIRING_ID);
  const derived = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: unhex(PS_HEX), info }, ikm, 256);
  return {
    claimantPriv: claimant.priv,
    claimantRaw: claimant.raw,
    creatorPriv: creator.priv,
    creatorRaw: creator.raw,
    psHex: PS_HEX,
    pairingId: PAIRING_ID,
    derivedKeyHex: Buffer.from(derived).toString("hex"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(join(here, "pairing-v2.json"), `${JSON.stringify(await pairingV2Vector(), null, 2)}\n`);
}
