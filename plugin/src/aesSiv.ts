/**
 * RFC 5297 AES-SIV-CMAC, using ONLY native WebCrypto AES-CBC/AES-CTR.
 * This mode module chooses no protocol context, key derivation or migration.
 * The 128-bit tag precedes the ciphertext; identical key/AD/plaintext repeats
 * deterministically. Equality leaks, replay/freshness and aggregate key
 * lifetime limits remain the caller's protocol concerns.
 */
import type { Bytes } from "./crypto";

const BLOCK = 16;
/** RFC 5297 section 2.6: AD plus plaintext is at most 127 S2V components. */
export const SIV_MAX_AD = 126;
/** The mode's largest payload is the product's existing 8 MiB chunk. */
export const SIV_PLAINTEXT_MAX = 8 << 20;
export const SIV_CIPHERTEXT_MAX = SIV_PLAINTEXT_MAX + BLOCK;
/** A bounded AD vector, independent of the caller's smaller context format. */
export const SIV_MAX_AD_BYTES = 8 << 20;

function bytes(value: Bytes): void {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) throw new Error("siv: invalid bytes");
}

function bounded(value: Bytes, ceiling = SIV_PLAINTEXT_MAX): void {
  bytes(value);
  if (value.length > ceiling) throw new Error("siv: input too large");
}

function keyBytes(value: Bytes, lengths: readonly number[]): Bytes {
  bytes(value);
  if (!lengths.includes(value.length)) throw new Error("siv: invalid key length");
  return new Uint8Array(value);
}

function associated(vector: readonly Bytes[]): Bytes[] {
  if (!Array.isArray(vector) || vector.length > SIV_MAX_AD) throw new Error("siv: too many AD components");
  let left = SIV_MAX_AD_BYTES;
  for (const component of vector) {
    bounded(component, left);
    left -= component.length;
  }
  return vector.map(component => new Uint8Array(component));
}

/** Big-endian GF(2^128) doubling; reduction polynomial ends in 0x87. */
function double(block: Bytes): Bytes {
  const out = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) out[i] = ((block[i] as number) << 1) | ((block[i + 1] ?? 0) >>> 7);
  out[BLOCK - 1] = (out[BLOCK - 1] as number) ^ (0x87 * ((block[0] as number) >>> 7));
  return out;
}

function xor(left: Bytes, right: Bytes): Bytes {
  const out = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) out[i] = (left[i] as number) ^ (right[i] as number);
  return out;
}

/** Both tags are exactly 16 bytes; inspect all bytes before deciding. */
function matches(left: Bytes, right: Bytes): boolean {
  let difference = 0;
  for (let i = 0; i < BLOCK; i++) difference |= (left[i] as number) ^ (right[i] as number);
  return difference === 0;
}

interface Cmac { key: CryptoKey; complete: Bytes; partial: Bytes; }

async function cmacKey(raw: Bytes): Promise<Cmac> {
  const key = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["encrypt"]);
  // CBC's FIRST block is AES(K, 0); its second is PKCS#7 and is ignored.
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(BLOCK) }, key, new Uint8Array(BLOCK)));
  const complete = double(encrypted.slice(0, BLOCK));
  return { key, complete, partial: double(complete) };
}

async function cmac(handle: Cmac, message: Bytes): Promise<Bytes> {
  const size = Math.max(BLOCK, Math.ceil(message.length / BLOCK) * BLOCK);
  const prepared = new Uint8Array(size);
  prepared.set(message);
  const complete = message.length > 0 && message.length % BLOCK === 0;
  if (!complete) prepared[message.length] = 0x80;
  const mask = complete ? handle.complete : handle.partial;
  for (let i = 0; i < BLOCK; i++) prepared[size - BLOCK + i] = (prepared[size - BLOCK + i] as number) ^ (mask[i] as number);
  // One native bulk CBC, not one asynchronous operation per block. Native
  // PKCS#7 adds a block: CMAC selects the LAST PREPARED chaining block.
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(BLOCK) }, handle.key, prepared));
  return encrypted.slice(size - BLOCK, size);
}

/** NIST SP800-38B AES-CMAC; full 128-bit tag, AES-128/192/256 keys. */
export async function aesCmac(raw: Bytes, message: Bytes): Promise<Bytes> {
  const key = keyBytes(raw, [16, 24, 32]);
  bounded(message);
  const captured = new Uint8Array(message);
  return cmac(await cmacKey(key), captured);
}

async function s2v(handle: Cmac, plaintext: Bytes, ad: readonly Bytes[]): Promise<Bytes> {
  let d = await cmac(handle, new Uint8Array(BLOCK));
  for (const component of ad) d = xor(double(d), await cmac(handle, component));
  let last: Bytes;
  if (plaintext.length >= BLOCK) {
    last = new Uint8Array(plaintext);
    // xorend covers the final 16 bytes even for an unaligned plaintext.
    for (let i = 0; i < BLOCK; i++) last[last.length - BLOCK + i] = (last[last.length - BLOCK + i] as number) ^ (d[i] as number);
  } else {
    const padded = new Uint8Array(BLOCK);
    padded.set(plaintext);
    padded[plaintext.length] = 0x80;
    last = xor(double(d), padded);
  }
  return cmac(handle, last);
}

function counter(tag: Bytes): Bytes {
  const out = new Uint8Array(tag);
  out[8] = (out[8] as number) & 0x7f;
  out[12] = (out[12] as number) & 0x7f;
  return out;
}

async function keys(raw: Bytes): Promise<{ mac: Cmac; ctr: CryptoKey }> {
  const half = raw.length / 2;
  const mac = await cmacKey(raw.slice(0, half));
  const ctr = await crypto.subtle.importKey("raw", raw.slice(half), "AES-CTR", false, ["encrypt", "decrypt"]);
  return { mac, ctr };
}

/** Deterministic use: any nonce, if chosen by the caller, is its final AD item. */
export async function aesSivEncrypt(raw: Bytes, plaintext: Bytes, vector: readonly Bytes[] = []): Promise<Bytes> {
  const key = keyBytes(raw, [32, 48, 64]);
  bounded(plaintext);
  const captured = new Uint8Array(plaintext), ad = associated(vector);
  const handle = await keys(key);
  const tag = await s2v(handle.mac, captured, ad);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: counter(tag), length: 128 }, handle.ctr, captured));
  const out = new Uint8Array(BLOCK + ciphertext.length);
  out.set(tag);
  out.set(ciphertext, BLOCK);
  return out;
}

/** Decrypted bytes stay private until the original, UNMASKED tag matches S2V. */
export async function aesSivDecrypt(raw: Bytes, sealed: Bytes, vector: readonly Bytes[] = []): Promise<Bytes> {
  const key = keyBytes(raw, [32, 48, 64]);
  bounded(sealed, SIV_CIPHERTEXT_MAX);
  if (sealed.length < BLOCK) throw new Error("siv: truncated tag");
  const captured = new Uint8Array(sealed), ad = associated(vector);
  const tag = captured.subarray(0, BLOCK), ciphertext = captured.subarray(BLOCK);
  const handle = await keys(key);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: counter(tag), length: 128 }, handle.ctr, ciphertext));
  try {
    if (!matches(tag, await s2v(handle.mac, plaintext, ad))) throw new Error("siv: authentication failed");
    return plaintext;
  } catch (error) {
    plaintext.fill(0);
    throw error;
  }
}
