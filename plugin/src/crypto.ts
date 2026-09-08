/**
 * Device cryptography, exactly `docs/architecture.md` section 3.
 *
 * Every primitive is the platform's WebCrypto (`crypto.subtle`,
 * `crypto.getRandomValues`): AES-256-GCM, HMAC-SHA-256, HKDF-SHA-256,
 * SHA-256. There is no JavaScript cipher, no homegrown AES, and no runtime
 * dependency. Homegrown code here is limited to byte encodings (hex, base32,
 * base64) and byte concatenation.
 *
 * BYTE CONVENTIONS. A Rust implementation of this module must encode the
 * following identically, so they are spelled out rather than implied:
 *
 * - Every salt and every literal `info` is the UTF-8 encoding of the ASCII
 *   string shown, with NO trailing NUL and no length prefix. `"obsync/v1/
 *   domain"` is exactly the 16 bytes `6f 62 73 79 6e 63 2f 76 31 2f 64 6f 6d
 *   61 69 6e`.
 * - `domain_id` and `pairing_id` are identifiers that travel as lowercase
 *   hex TEXT. Where they are used as HKDF `info` they are the UTF-8 bytes of
 *   that text (32 ASCII bytes for a 16-byte id), NOT the decoded 16 bytes.
 * - `cid` is raw binary (32 bytes) and is used as HKDF `info` in raw form.
 * - An empty `info` is a zero-length byte string, not the byte 0x00.
 * - HKDF output of length L is the first L bytes of the expand stream, so
 *   `HKDF(..., 12)` equals `HKDF(..., 32)[0..12]` — the derivation of the
 *   chunk nonce is written as a 12-byte derivation for that reason.
 * - Every hash and MAC that leaves this module as text is LOWERCASE hex.
 *
 * PLATFORM. Identical on every Obsidian platform: WebCrypto is present in
 * Electron (desktop) and in the iOS/iPadOS/Android WebView. Nothing here
 * touches the filesystem, so desktop and mobile behaviour cannot diverge.
 */

/**
 * A byte string backed by a plain (non-shared) ArrayBuffer, which is what
 * WebCrypto's `BufferSource` requires under `strict`.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Domain-separation labels. Changing one is a wire-format break. */
export const LABEL = {
  domain: "obsync/v1/domain",
  manifest: "obsync/v1/manifest",
  domainMap: "obsync/v1/domainmap",
  domainMapId: "obsync/v1/domain-map",
  chunk: "obsync/v1/chunk",
  nonce: "obsync/v1/nonce",
  pair: "obsync/v1/pair",
  signature: "obsync/v1",
} as const;

/** AES-GCM nonce length in bytes, for every use in this protocol. */
export const NONCE_BYTES = 12;
/** Every symmetric key in obsync is 32 bytes. */
export const KEY_BYTES = 32;

export function utf8(text: string): Bytes {
  return TEXT_ENCODER.encode(text);
}

export function fromUtf8(bytes: Bytes): string {
  return TEXT_DECODER.decode(bytes);
}

export function concat(...parts: Bytes[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Constant-time equality: one accumulator, no branch on data. */
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const HEX_DIGITS = "0123456789abcdef";

export function hex(bytes: Bytes): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    out += HEX_DIGITS[byte >> 4];
    out += HEX_DIGITS[byte & 15];
  }
  return out;
}

export function unhex(text: string): Bytes {
  if (text.length % 2 !== 0) throw new Error("hex: odd length");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX_DIGITS.indexOf(text[2 * i] as string);
    const lo = HEX_DIGITS.indexOf(text[2 * i + 1] as string);
    if (hi < 0 || lo < 0) throw new Error("hex: not lowercase hex");
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** True for exactly `bytes` lowercase-hex characters. Used to validate wire input. */
export function isHex(text: string, bytes: number): boolean {
  if (text.length !== bytes * 2) return false;
  for (let i = 0; i < text.length; i++) {
    if (HEX_DIGITS.indexOf(text[i] as string) < 0) return false;
  }
  return true;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** RFC 4648 base64 with padding. Homegrown so no `btoa` binary-string round trip is needed. */
export function base64(bytes: Bytes): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

export function unbase64(text: string): Bytes {
  const clean = text.endsWith("==") ? text.slice(0, -2) : text.endsWith("=") ? text.slice(0, -1) : text;
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = B64_ALPHABET.indexOf(clean[i] as string);
    if (value < 0) throw new Error("base64: invalid character");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, uppercase, UNPADDED. The pairing-code encoding. */
export function base32(bytes: Bytes): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | (bytes[i] as number);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function unbase32(text: string): Bytes {
  const clean = text.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = B32_ALPHABET.indexOf(clean[i] as string);
    if (value < 0) throw new Error("base32: invalid character");
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function hmacSha256(key: Bytes, data: Bytes): Promise<Bytes> {
  const handle = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", handle, data));
}

/** HKDF-SHA-256 (RFC 5869 extract-and-expand), `length` bytes of output. */
export async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const handle = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    handle,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function aesGcmEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes): Promise<Bytes> {
  const handle = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const out = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    handle,
    plaintext,
  );
  return new Uint8Array(out);
}

async function aesGcmDecrypt(key: Bytes, nonce: Bytes, ciphertext: Bytes, aad: Bytes): Promise<Bytes> {
  const handle = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const out = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    handle,
    ciphertext,
  );
  return new Uint8Array(out);
}

/** `K_d = HKDF(VRK, salt="obsync/v1/domain", info=utf8(domain_id))`. */
export function deriveDomainKey(vrk: Bytes, domainId: string): Promise<Bytes> {
  return hkdf(vrk, utf8(LABEL.domain), utf8(domainId), KEY_BYTES);
}

/**
 * `K_m,d = HKDF(K_d, salt="obsync/v1/manifest", info=utf8(domain_id))`:
 * the manifest key of ONE domain (`docs/architecture.md` 5.1 item 2).
 *
 * It derives from the domain key, not from `VRK`, and that is the whole
 * point. A holder of `K_d` reads that domain's file names and its chunks and
 * can derive neither for a domain it was not given; a vault-wide manifest key
 * would have handed over every filename in the vault with the first share.
 * v0.1 grants nobody anything, but the format is what the genesis release
 * writes, so it is decided here rather than migrated later.
 */
export function deriveManifestKey(domainKey: Bytes, domainId: string): Promise<Bytes> {
  return hkdf(domainKey, utf8(LABEL.manifest), utf8(domainId), KEY_BYTES);
}

/**
 * `K_map = HKDF(VRK, salt="obsync/v1/domainmap", info="")`: the key of the
 * path-to-domain map (`docs/architecture.md` 5.1 item 3).
 *
 * It derives from `VRK` and from nothing a recipient could ever be given, so
 * the map that says which paths live in which domain is readable by the owner
 * alone. It is also the AEAD key of the map object itself: the map is one
 * encrypted blob, not a file with chunks, so no second derivation exists.
 */
export function deriveDomainMapKey(vrk: Bytes): Promise<Bytes> {
  return hkdf(vrk, utf8(LABEL.domainMap), new Uint8Array(0), KEY_BYTES);
}

/**
 * The map object's two reserved identifiers, from one
 * `HMAC(K_map, "obsync/v1/domain-map")`: the first 16 bytes are its file id
 * and the last 16 are the domain id its file record carries.
 *
 * One MAC and a split rather than two derivations, because the two ids are
 * used together and never apart. Both are unguessable without `VRK`, and both
 * are server-visible: to the server the map is one more opaque file, which is
 * exactly what lets it travel through the ordinary file mechanism.
 */
export async function domainMapIds(mapKey: Bytes): Promise<{ fileId: string; domainId: string }> {
  const mac = await hmacSha256(mapKey, utf8(LABEL.domainMapId));
  return { fileId: hex(mac.subarray(0, 16) as Bytes), domainId: hex(mac.subarray(16, 32) as Bytes) };
}

/** `K_pair = HKDF(PS, salt="obsync/v1/pair", info=utf8(pairing_id))`. */
export function pairingKey(pairingSecret: Bytes, pairingId: string): Promise<Bytes> {
  return hkdf(pairingSecret, utf8(LABEL.pair), utf8(pairingId), KEY_BYTES);
}

/**
 * `cid = HMAC-SHA-256(K_d, P)`: the keyed content id of a plaintext chunk.
 * It never reaches the server: it travels only inside the encrypted manifest
 * (see `encryptChunk`).
 */
export function chunkCid(domainKey: Bytes, plaintext: Bytes): Promise<Bytes> {
  return hmacSha256(domainKey, plaintext);
}

async function chunkKeyAndNonce(domainKey: Bytes, cid: Bytes): Promise<{ key: Bytes; nonce: Bytes }> {
  const key = await hkdf(domainKey, utf8(LABEL.chunk), cid, KEY_BYTES);
  const nonce = await hkdf(key, utf8(LABEL.nonce), new Uint8Array(0), NONCE_BYTES);
  return { key, nonce };
}

/**
 * Deterministic chunk encryption, `docs/architecture.md` 3.2. Identical
 * plaintext in the same domain yields an identical `sid` on every device, so
 * the server deduplicates without learning anything about the plaintext.
 *
 * `cid` is returned because it is REQUIRED to decrypt: `K_c` derives from it
 * and it cannot be recomputed from the ciphertext. It is recorded per chunk
 * inside the encrypted manifest (`chunker`/`sync` write `{sid, cid, len}`),
 * never in a server-visible field.
 */
export async function encryptChunk(
  domainKey: Bytes,
  plaintext: Bytes,
): Promise<{ cid: Bytes; sid: string; ciphertext: Bytes }> {
  const cid = await chunkCid(domainKey, plaintext);
  const { key, nonce } = await chunkKeyAndNonce(domainKey, cid);
  const ciphertext = await aesGcmEncrypt(key, nonce, plaintext, utf8(LABEL.chunk));
  return { cid, sid: hex(await sha256(ciphertext)), ciphertext };
}

/**
 * Inverse of `encryptChunk`. AES-GCM authenticates the ciphertext; the `cid`
 * recomputation additionally proves the plaintext is the one the manifest
 * named, so a manifest that points a chunk entry at the wrong chunk fails
 * here instead of silently producing the wrong bytes.
 */
export async function decryptChunk(domainKey: Bytes, cid: Bytes, ciphertext: Bytes): Promise<Bytes> {
  const { key, nonce } = await chunkKeyAndNonce(domainKey, cid);
  const plaintext = await aesGcmDecrypt(key, nonce, ciphertext, utf8(LABEL.chunk));
  if (!bytesEqual(await chunkCid(domainKey, plaintext), cid)) throw new Error("chunk: cid mismatch");
  return plaintext;
}

/** AAD for a manifest: the raw 16 file-id bytes followed by the raw 32 version-id bytes. */
function manifestAad(fileId: string, versionId: string): Bytes {
  return concat(unhex(fileId), unhex(versionId));
}

/**
 * Encrypt a file manifest under `K_m,d`, the manifest key of the file's own
 * domain, with a fresh random 12-byte nonce and `aad = file_id || version_id`.
 *
 * `versionId` is the CONTENT version id (`contentVersionId`), not the
 * protocol `version_id` of `versionId()`: the protocol id hashes
 * `manifest_ct`, so binding the manifest to it would be circular. See the
 * note on `contentVersionId`.
 */
export async function encryptManifest(
  manifestKey: Bytes,
  fileId: string,
  versionId: string,
  json: string,
): Promise<{ nonce: Bytes; ciphertext: Bytes }> {
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = await aesGcmEncrypt(
    manifestKey,
    nonce,
    utf8(json),
    manifestAad(fileId, versionId),
  );
  return { nonce, ciphertext };
}

export async function decryptManifest(
  manifestKey: Bytes,
  fileId: string,
  versionId: string,
  nonce: Bytes,
  ciphertext: Bytes,
): Promise<string> {
  return fromUtf8(
    await aesGcmDecrypt(manifestKey, nonce, ciphertext, manifestAad(fileId, versionId)),
  );
}

/**
 * Seal the domain map into the slot a manifest occupies, under `K_map` and
 * the same AAD (`docs/architecture.md` 5.1 item 3).
 *
 * THE NONCE IS DERIVED, not random: `HKDF(K_map, "obsync/v1/nonce",
 * SHA-256(aad || plaintext))[0..12]`. Two devices that write the same map at
 * the same moment then produce the same bytes and the same version id and
 * collide harmlessly, exactly as two devices producing the same chunk do
 * (`encryptChunk`). Deriving from the AAD as well as the plaintext is what
 * keeps that safe: a key and nonce repeat only for a message identical in
 * both, and two different messages under one key and nonce would leak the
 * GCM authentication key.
 */
export async function encryptDomainMap(
  mapKey: Bytes,
  fileId: string,
  versionId: string,
  json: string,
): Promise<{ nonce: Bytes; ciphertext: Bytes }> {
  const aad = manifestAad(fileId, versionId);
  const plaintext = utf8(json);
  const nonce = await hkdf(mapKey, utf8(LABEL.nonce), await sha256(concat(aad, plaintext)), NONCE_BYTES);
  return { nonce, ciphertext: await aesGcmEncrypt(mapKey, nonce, plaintext, aad) };
}

/** Inverse of `encryptDomainMap`. A wrong key or a wrong binder fails here. */
export async function decryptDomainMap(
  mapKey: Bytes,
  fileId: string,
  versionId: string,
  nonce: Bytes,
  ciphertext: Bytes,
): Promise<string> {
  return fromUtf8(await aesGcmDecrypt(mapKey, nonce, ciphertext, manifestAad(fileId, versionId)));
}

function sortedParentBytes(parents: string[]): Bytes {
  // Lowercase hex sorts in the same order as the bytes it encodes, so a
  // string sort is the byte-ascending sort the protocol asks for.
  const sorted = [...parents].sort();
  return concat(...sorted.map(unhex));
}

/**
 * `version_id = SHA-256(file_id || sorted parents || manifest_ct || sids)`,
 * `docs/architecture.md` 3.4. The server recomputes this exact preimage and
 * refuses a mismatch with `422 version_id_mismatch`, so the byte order here
 * is a wire contract: 16 file-id bytes, each 32-byte parent id ascending,
 * the manifest ciphertext, then each 32-byte sid IN MANIFEST ORDER (sids are
 * not sorted: their order is the file's chunk order).
 */
export async function versionId(
  fileId: string,
  parents: string[],
  manifestCt: Bytes,
  sids: string[],
): Promise<string> {
  return hex(
    await sha256(
      concat(unhex(fileId), sortedParentBytes(parents), manifestCt, concat(...sids.map(unhex))),
    ),
  );
}

/**
 * The manifest-AAD binder: the protocol `version_id` preimage MINUS
 * `manifest_ct`.
 *
 * `docs/architecture.md` 3.4 asks for `aad = file_id || version_id` while
 * defining `version_id` over `manifest_ct`; taken literally the manifest
 * ciphertext would have to exist before it could be computed. Dropping the
 * self-referential term is the only resolution that keeps both the AAD
 * binding and the server-recomputable `version_id`. The AAD still binds a
 * manifest to its file, its parents, and its exact chunk list, so a manifest
 * cannot be replayed onto another file, another point in the version graph,
 * or another chunk set. A puller can compute it from the change-feed record
 * before it decrypts.
 */
export async function contentVersionId(
  fileId: string,
  parents: string[],
  sids: string[],
): Promise<string> {
  return hex(
    await sha256(concat(unhex(fileId), sortedParentBytes(parents), concat(...sids.map(unhex)))),
  );
}

/** `hex(SHA-256(body))`, the body-hash term of a request signature. */
export async function bodyHash(body: Bytes): Promise<string> {
  return hex(await sha256(body));
}

/**
 * Request signature, `docs/protocol.md` "Authentication":
 *
 *   HMAC-SHA-256(device_secret,
 *     "obsync/v1\n" + METHOD + "\n" + path_and_query + "\n" + ts + "\n"
 *     + nonce + "\n" + hex(SHA-256(body)))
 *
 * `target` is the request target exactly as sent, query included. `ts` is
 * unix SECONDS in decimal. There is no unsigned request path: `transport`
 * signs every device call, and this function has no "skip" mode by design
 * (AGENTS.md requirement 4).
 */
export async function signRequest(
  deviceSecret: Bytes,
  method: string,
  target: string,
  ts: number,
  nonce: string,
  bodySha256: string,
): Promise<string> {
  const preimage = `${LABEL.signature}\n${method}\n${target}\n${ts}\n${nonce}\n${bodySha256}`;
  return hex(await hmacSha256(deviceSecret, utf8(preimage)));
}
