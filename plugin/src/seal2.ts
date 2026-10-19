/** Suite-2 byte contexts and SIV wrappers only; no wire decoder or adoption. */
import { bytesEqual, concat, hex, hkdf, hmacSha256, sha256, unhex, utf8 } from "./crypto";
import type { Bytes } from "./crypto";
import { aesSivDecrypt, aesSivEncrypt, SIV_CIPHERTEXT_MAX, SIV_PLAINTEXT_MAX } from "./aesSiv";

export interface RecordContext {
  generation: string; domainId: string; fileId: string;
  parents: readonly string[]; sids: readonly string[];
}
export interface ChunkScope { generation: string; domainId: string }
export interface PairingContext { pairingId: string; claimantPublic?: Bytes; creatorPublic?: Bytes }

const PREFIX = utf8("obsync/seal/2\0");
const SIV_LABEL = utf8("obsync/seal-v2/siv");
const CID_LABEL = utf8("obsync/seal-v2/chunk-id");
const BASE_LABEL = utf8("obsync/seal-v2/chunk-base");

function id(value: string, size: number): Bytes {
  if (typeof value !== "string" || value.length !== size * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error("seal2: invalid context");
  }
  return unhex(value);
}

function snapshot(value: Bytes, min: number, max: number, failure: string): Bytes {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.length < min || value.length > max) {
    throw new Error(failure);
  }
  return new Uint8Array(value);
}

function joined(kind: number, fields: readonly Bytes[]): Bytes {
  const out = new Uint8Array(PREFIX.length + 1 + fields.reduce((n, field) => n + field.length, 0));
  out.set(PREFIX); out[PREFIX.length] = kind;
  let at = PREFIX.length + 1;
  for (const field of fields) { out.set(field, at); at += field.length; }
  return out;
}

/** Counted parents are unique/canonical; chunk order and repeated SIDs survive. */
export function recordContext(kind: 1 | 2, context: RecordContext): Bytes {
  if (!context || typeof context !== "object") throw new Error("seal2: invalid context");
  if (kind !== 1 && kind !== 2) throw new Error("seal2: invalid context");
  const generation = id(context.generation, 16), domain = id(context.domainId, 16), file = id(context.fileId, 16);
  if (!Array.isArray(context.parents) || context.parents.length > 64 ||
      !Array.isArray(context.sids) || context.sids.length > 65536) throw new Error("seal2: invalid context");
  const parents = [...context.parents];
  if (parents.some((parent) => typeof parent !== "string")) throw new Error("seal2: invalid context");
  parents.sort();
  const parentBytes = parents.map((parent) => id(parent, 32));
  const sidBytes = [...context.sids].map((sid) => id(sid, 32));
  if (new Set(parents).size !== parents.length) throw new Error("seal2: invalid context");
  if (kind === 2 && (context.fileId !== context.generation || sidBytes.length !== 0)) throw new Error("seal2: invalid context");
  const out = new Uint8Array(PREFIX.length + 1 + 48 + 8 + 32 * (parentBytes.length + sidBytes.length));
  out.set(joined(kind, [generation, domain, file]));
  const view = new DataView(out.buffer);
  let at = PREFIX.length + 1 + 48;
  view.setUint32(at, parentBytes.length, false); at += 4;
  for (const parent of parentBytes) { out.set(parent, at); at += 32; }
  view.setUint32(at, sidBytes.length, false); at += 4;
  for (const sid of sidBytes) { out.set(sid, at); at += 32; }
  return out;
}

export function chunkContext(scope: ChunkScope, cid: Bytes): Bytes {
  if (!scope || typeof scope !== "object") throw new Error("seal2: invalid context");
  return joined(3, [id(scope.generation, 16), id(scope.domainId, 16), snapshot(cid, 32, 32, "seal2: invalid context")]);
}

/** Role bytes are available for envelopes; details deliberately bind only ID. */
export function pairingContext(kind: 4 | 5, context: PairingContext): Bytes {
  if (!context || typeof context !== "object") throw new Error("seal2: invalid context");
  if (kind !== 4 && kind !== 5) throw new Error("seal2: invalid context");
  const pairing = id(context.pairingId, 16);
  if (kind === 5) return joined(kind, [pairing]);
  const claimant = snapshot(context.claimantPublic as Bytes, 65, 65, "seal2: invalid context");
  const creator = snapshot(context.creatorPublic as Bytes, 65, 65, "seal2: invalid context");
  if (claimant[0] !== 4 || creator[0] !== 4) throw new Error("seal2: invalid context");
  return joined(kind, [pairing, claimant, creator]);
}

async function seal(base: Bytes, context: Bytes, plaintext: Bytes): Promise<Bytes> {
  try {
    const key = await hkdf(base, SIV_LABEL, await sha256(context), 64);
    return await aesSivEncrypt(key, plaintext, [context]);
  } catch { throw new Error("seal2: seal failed"); }
}

async function open(base: Bytes, context: Bytes, ciphertext: Bytes): Promise<Bytes> {
  try {
    const key = await hkdf(base, SIV_LABEL, await sha256(context), 64);
    return await aesSivDecrypt(key, ciphertext, [context]);
  } catch { throw new Error("seal2: open failed"); }
}

export async function sealRecord(base: Bytes, kind: 1 | 2, context: RecordContext, plaintext: Bytes): Promise<Bytes> {
  return seal(snapshot(base, 32, 32, "seal2: invalid key"), recordContext(kind, context),
    snapshot(plaintext, 0, SIV_PLAINTEXT_MAX, "seal2: invalid input"));
}

export async function openRecord(base: Bytes, kind: 1 | 2, context: RecordContext, ciphertext: Bytes): Promise<Bytes> {
  return open(snapshot(base, 32, 32, "seal2: invalid key"), recordContext(kind, context),
    snapshot(ciphertext, 16, SIV_CIPHERTEXT_MAX, "seal2: invalid input"));
}

export async function sealPairing(base: Bytes, kind: 4 | 5, context: PairingContext, plaintext: Bytes): Promise<Bytes> {
  return seal(snapshot(base, 32, 32, "seal2: invalid key"), pairingContext(kind, context),
    snapshot(plaintext, 0, SIV_PLAINTEXT_MAX, "seal2: invalid input"));
}

export async function openPairing(base: Bytes, kind: 4 | 5, context: PairingContext, ciphertext: Bytes): Promise<Bytes> {
  return open(snapshot(base, 32, 32, "seal2: invalid key"), pairingContext(kind, context),
    snapshot(ciphertext, 16, SIV_CIPHERTEXT_MAX, "seal2: invalid input"));
}

async function chunkKeys(domainKey: Bytes, scope: Bytes): Promise<[Bytes, Bytes]> {
  try {
    return await Promise.all([hkdf(domainKey, CID_LABEL, scope, 32), hkdf(domainKey, BASE_LABEL, scope, 32)]);
  } catch { throw new Error("seal2: derive failed"); }
}

export async function encryptChunk2(domainKey: Bytes, scope: ChunkScope, plaintext: Bytes): Promise<{ cid: Bytes; sid: string; ciphertext: Bytes }> {
  const key = snapshot(domainKey, 32, 32, "seal2: invalid key");
  if (!scope || typeof scope !== "object") throw new Error("seal2: invalid context");
  const scopeBytes = concat(id(scope.generation, 16), id(scope.domainId, 16));
  const input = snapshot(plaintext, 0, SIV_PLAINTEXT_MAX, "seal2: invalid input");
  const [idKey, base] = await chunkKeys(key, scopeBytes);
  try {
    const cid = await hmacSha256(idKey, input);
    // Use captured scope bytes; never reread caller fields after deriving keys.
    const context = joined(3, [scopeBytes, cid]);
    const ciphertext = await seal(base, context, input);
    return { cid, sid: hex(await sha256(ciphertext)), ciphertext };
  } catch { throw new Error("seal2: seal failed"); }
}

export async function decryptChunk2(domainKey: Bytes, scope: ChunkScope, cid: Bytes, ciphertext: Bytes): Promise<Bytes> {
  const key = snapshot(domainKey, 32, 32, "seal2: invalid key");
  const context = chunkContext(scope, cid);
  const scopeBytes = context.slice(PREFIX.length + 1, PREFIX.length + 1 + 32);
  const expected = context.slice(-32);
  const input = snapshot(ciphertext, 16, SIV_CIPHERTEXT_MAX, "seal2: invalid input");
  const [idKey, base] = await chunkKeys(key, scopeBytes);
  const plaintext = await open(base, context, input);
  let actual: Bytes;
  try { actual = await hmacSha256(idKey, plaintext); }
  catch { throw new Error("seal2: open failed"); }
  if (!bytesEqual(actual, expected)) throw new Error("seal2: cid mismatch");
  return plaintext;
}
