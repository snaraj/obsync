/**
 * Regenerates `crypto.json`, the cross-implementation vector file.
 *
 *   cd plugin && npm run build && node test/fixtures/generate.mjs
 *
 * The vectors are the contract between this plugin and the Rust core: the
 * server's `obsyncd export` must reproduce every value here from the same
 * inputs. Every input is a visible sentinel (counting bytes, fixed strings),
 * never a real key.
 *
 * Importing this file does nothing: it only writes when run directly, so the
 * test runner cannot rewrite the fixtures it is checking.
 */

import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const crypto_ = require("../../build/crypto.js");
const chunker = require("../../build/chunker.js");

/** 00 01 02 … 1f: obviously a sentinel, never a key. */
const VRK = Uint8Array.from({ length: 32 }, (_, i) => i);
const DOMAIN_ID = "0123456789abcdef0123456789abcdef";
/**
 * A SECOND domain, because the manifest key is now per domain
 * (`docs/architecture.md` 5.1 item 2). One domain cannot show that the
 * derivation is scoped; two can, and the plugin test proves the two manifest
 * keys differ as well as matching these bytes.
 */
const SECOND_DOMAIN_ID = "9876543210abcdef9876543210abcdef";
const FILE_ID = "00112233445566778899aabbccddeeff";
const DEVICE_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 ^ i);
const PAIRING_SECRET = Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i);
const PAIRING_ID = "fedcba9876543210fedcba9876543210";

/**
 * A deterministic byte stream: xorshift32 (13, 17, 5) seeded with 0x0b5ec1,
 * taking the low byte of each state. A second implementation reproduces it in
 * five lines, which is what makes the chunk-boundary vector portable.
 */
export function stream(length, seed = 0x0b5ec1) {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export const PLAINTEXTS = [
  { name: "empty", bytes: new Uint8Array(0) },
  { name: "note", bytes: crypto_.utf8("obsync fixture chunk\n") },
  // 4096 bytes of `i % 251`, described rather than spelled out.
  { name: "block", bytes: Uint8Array.from({ length: 4096 }, (_, i) => i % 251), spec: "byte[i] = i % 251, 4096 bytes" },
];

/** One domain's whole key ladder, as both implementations must derive it. */
async function domainVectors(domainId) {
  const domainKey = await crypto_.deriveDomainKey(VRK, domainId);
  return {
    domain_id: domainId,
    domain_key: crypto_.hex(domainKey),
    manifest_key: crypto_.hex(await crypto_.deriveManifestKey(domainKey, domainId)),
  };
}

export async function build() {
  const domains = [await domainVectors(DOMAIN_ID), await domainVectors(SECOND_DOMAIN_ID)];
  const domainKey = await crypto_.deriveDomainKey(VRK, DOMAIN_ID);
  const manifestKey = await crypto_.deriveManifestKey(domainKey, DOMAIN_ID);

  // The owner-only domain map: its key, its two reserved identifiers, and one
  // sealed sample. The sample pins the DERIVED nonce, which is what makes two
  // devices writing the same map collide harmlessly instead of conflicting.
  const mapKey = await crypto_.deriveDomainMapKey(VRK);
  const mapIds = await crypto_.domainMapIds(mapKey);
  const mapJson = JSON.stringify({
    v: 1,
    domains: [
      { id: DOMAIN_ID, paths: [""] },
      { id: SECOND_DOMAIN_ID, paths: ["Fixtures/Shared"] },
    ],
  });
  const mapBinder = await crypto_.contentVersionId(mapIds.fileId, [], []);
  const mapSealed = await crypto_.encryptDomainMap(mapKey, mapIds.fileId, mapBinder, mapJson);

  const chunks = [];
  for (const { name, bytes, spec } of PLAINTEXTS) {
    const cid = await crypto_.chunkCid(domainKey, bytes);
    const chunkKey = await crypto_.hkdf(domainKey, crypto_.utf8("obsync/v1/chunk"), cid, 32);
    const nonce = await crypto_.hkdf(chunkKey, crypto_.utf8("obsync/v1/nonce"), new Uint8Array(0), 12);
    const { sid, ciphertext } = await crypto_.encryptChunk(domainKey, bytes);
    chunks.push({
      name,
      plaintext_hex: spec ? null : crypto_.hex(bytes),
      plaintext_spec: spec ?? null,
      plaintext_len: bytes.length,
      cid: crypto_.hex(cid),
      chunk_key: crypto_.hex(chunkKey),
      nonce: crypto_.hex(nonce),
      sid,
      // sid is SHA-256(ciphertext), so it pins the ciphertext exactly; the
      // full hex is recorded for the short cases as a direct comparison.
      ciphertext_hex: bytes.length <= 64 ? crypto_.hex(ciphertext) : null,
      ciphertext_len: ciphertext.length,
    });
  }

  const manifestJson = JSON.stringify({
    v: 1,
    path: "Fixtures/Note.md",
    size: 21,
    mtime: 1757200000000,
    domain: DOMAIN_ID,
    chunks: [{ sid: chunks[1].sid, cid: chunks[1].cid, len: 21 }],
    sha256: crypto_.hex(await crypto_.sha256(PLAINTEXTS[1].bytes)),
    deleted: false,
  });
  const parents = [
    "2222222222222222222222222222222222222222222222222222222222222222",
    "1111111111111111111111111111111111111111111111111111111111111111",
  ];
  const sids = [chunks[1].sid, chunks[2].sid];
  const binder = await crypto_.contentVersionId(FILE_ID, parents, sids);
  const manifest = await crypto_.encryptManifest(manifestKey, FILE_ID, binder, manifestJson);
  const version = await crypto_.versionId(FILE_ID, parents, manifest.ciphertext, sids);

  const gear = await chunker.gearTable();
  const gearBytes = new Uint8Array(gear.length * 4);
  for (let i = 0; i < gear.length; i++) {
    gearBytes[i * 4] = (gear[i] >>> 24) & 0xff;
    gearBytes[i * 4 + 1] = (gear[i] >>> 16) & 0xff;
    gearBytes[i * 4 + 2] = (gear[i] >>> 8) & 0xff;
    gearBytes[i * 4 + 3] = gear[i] & 0xff;
  }
  const cdcSize = 24 << 20;
  const cdcLengths = await chunker.chunkLengths(chunker.bytesSource(stream(cdcSize)));

  return {
    note: "obsync v1 device-cryptography vectors. Inputs are sentinels, not keys. Regenerate with plugin/test/fixtures/generate.mjs.",
    vrk: crypto_.hex(VRK),
    domains,
    domain_map: {
      key: crypto_.hex(mapKey),
      file_id: mapIds.fileId,
      domain_id: mapIds.domainId,
      json: mapJson,
      content_version_id: mapBinder,
      nonce: crypto_.hex(mapSealed.nonce),
      ciphertext_hex: crypto_.hex(mapSealed.ciphertext),
    },
    chunks,
    manifest: {
      file_id: FILE_ID,
      parents,
      sids,
      content_version_id: binder,
      json: manifestJson,
      nonce: crypto_.hex(manifest.nonce),
      ciphertext_hex: crypto_.hex(manifest.ciphertext),
      version_id: version,
    },
    signature: {
      device_secret: crypto_.hex(DEVICE_SECRET),
      method: "POST",
      target: "/v1/files/00112233445566778899aabbccddeeff/versions",
      ts: 1757200000,
      nonce: "8d2f0a1b4c6e7f90a1b2c3d4e5f60718",
      body_sha256: crypto_.hex(await crypto_.sha256(crypto_.utf8("{}"))),
      sig: await crypto_.signRequest(
        DEVICE_SECRET,
        "POST",
        "/v1/files/00112233445566778899aabbccddeeff/versions",
        1757200000,
        "8d2f0a1b4c6e7f90a1b2c3d4e5f60718",
        crypto_.hex(await crypto_.sha256(crypto_.utf8("{}"))),
      ),
    },
    pairing: {
      pairing_secret: crypto_.hex(PAIRING_SECRET),
      pairing_id: PAIRING_ID,
      key: crypto_.hex(await crypto_.pairingKey(PAIRING_SECRET, PAIRING_ID)),
    },
    chunker: {
      seed: "obsync/v1/gear",
      gear_first_8: Array.from(gear.slice(0, 8)),
      gear_sha256: crypto_.hex(await crypto_.sha256(gearBytes)),
      stream: { generator: "xorshift32", seed: 0x0b5ec1, size: cdcSize },
      lengths: cdcLengths,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixtures = await build();
  await writeFile(join(here, "crypto.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log(
    `wrote crypto.json domains=${fixtures.domains.length} chunks=${fixtures.chunks.length} ` +
      `cdc_chunks=${fixtures.chunker.lengths.length}`,
  );
}
