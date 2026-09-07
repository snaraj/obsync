/**
 * Content-defined chunking: the gear table, the size envelope, determinism,
 * and the property the whole design exists for — a small edit inside a large
 * file re-uploads a couple of chunks, not the file.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stream } from "./fixtures/generate.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const chunker = require("../build/chunker.js");
const c = require("../build/crypto.js");
const fixtures = JSON.parse(readFileSync(join(here, "fixtures", "crypto.json"), "utf8"));

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function chunksOf(data) {
  const out = [];
  for await (const chunk of chunker.chunkStream(chunker.bytesSource(data))) out.push(chunk);
  return out;
}

test("the gear table is 256 deterministic entries and matches the fixture", async () => {
  const table = await chunker.gearTable();
  assert.equal(table.length, 256);
  assert.deepEqual(Array.from(table.slice(0, 8)), fixtures.chunker.gear_first_8);
  const bytes = new Uint8Array(table.length * 4);
  for (let i = 0; i < table.length; i++) {
    bytes[i * 4] = (table[i] >>> 24) & 0xff;
    bytes[i * 4 + 1] = (table[i] >>> 16) & 0xff;
    bytes[i * 4 + 2] = (table[i] >>> 8) & 0xff;
    bytes[i * 4 + 3] = table[i] & 0xff;
  }
  assert.equal(digest(bytes), fixtures.chunker.gear_sha256);

  // Entry i is the first four bytes of SHA-256(seed || byte(i)), so a second
  // implementation needs the seed string and nothing else.
  const seed = Buffer.from(chunker.GEAR_SEED, "utf8");
  for (const i of [0, 1, 42, 255]) {
    const expected = createHash("sha256").update(Buffer.concat([seed, Buffer.from([i])])).digest();
    assert.equal(table[i], expected.readUInt32BE(0), `entry ${i}`);
  }
  assert.equal(await chunker.gearTable(), table, "the table is derived once");
});

test("the size envelope is 1 MiB minimum, 8 MiB maximum, 4 MiB target", () => {
  assert.equal(chunker.CHUNK_MIN, 1 << 20);
  assert.equal(chunker.CHUNK_TARGET, 4 << 20);
  assert.equal(chunker.CHUNK_MAX, 8 << 20);
  // A 22-bit mask over the high bits: one expected cut per 4 MiB.
  assert.equal(chunker.GEAR_MASK, 0xfffffc00);
  let bits = 0;
  for (let i = 0; i < 32; i++) if ((chunker.GEAR_MASK >>> i) & 1) bits++;
  assert.equal(bits, 22);
  assert.equal(2 ** bits, chunker.CHUNK_TARGET);
});

test("a file of at most 8 MiB is exactly one chunk", async () => {
  for (const size of [0, 1, 4096, (1 << 20) + 7, 8 << 20]) {
    const data = stream(size, 0x1234);
    const chunks = await chunksOf(data);
    assert.equal(chunks.length, 1, `size ${size}`);
    assert.equal(chunks[0].length, size, `size ${size}`);
  }
});

test("a larger file is cut by content, inside the envelope, losing nothing", async () => {
  const size = fixtures.chunker.stream.size;
  const data = stream(size, fixtures.chunker.stream.seed);
  const chunks = await chunksOf(data);
  const lengths = chunks.map((chunk) => chunk.length);

  assert.deepEqual(lengths, fixtures.chunker.lengths, "boundaries match the fixture");
  assert.ok(lengths.length > 1, "the file is cut at all");
  assert.equal(
    lengths.reduce((sum, length) => sum + length, 0),
    size,
    "every byte is accounted for",
  );
  for (const [index, length] of lengths.entries()) {
    if (index < lengths.length - 1) assert.ok(length >= chunker.CHUNK_MIN, `chunk ${index} above the minimum`);
    assert.ok(length <= chunker.CHUNK_MAX, `chunk ${index} within the maximum`);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  assert.equal(digest(joined), digest(data), "the chunks reassemble the file");

  // A second pass over the same bytes gives the same boundaries.
  assert.deepEqual(await chunker.chunkLengths(chunker.bytesSource(data)), lengths);
});

test("a windowed source produces the same boundaries as a whole-buffer one", async () => {
  const data = stream(fixtures.chunker.stream.size, fixtures.chunker.stream.seed);
  // A source that answers in 512 KiB pieces, as a streaming desktop read does.
  const windowed = {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + Math.min(length, 512 << 10)),
  };
  const lengths = [];
  let position = 0;
  for await (const chunk of chunker.chunkStream({
    size: data.length,
    read: async (offset, length) => {
      const piece = await windowed.read(offset, length);
      position = offset + piece.length;
      return piece;
    },
  })) {
    lengths.push(chunk.length);
  }
  assert.deepEqual(lengths, fixtures.chunker.lengths);
  assert.equal(position, data.length);
});

test("a one-byte edit in the middle changes at most two chunks", async () => {
  const data = stream(fixtures.chunker.stream.size, fixtures.chunker.stream.seed);
  const before = (await chunksOf(data)).map(digest);

  const edited = Uint8Array.from(data);
  edited[Math.floor(edited.length / 2)] ^= 0xff;
  const afterEdit = (await chunksOf(edited)).map(digest);
  const changedByEdit = afterEdit.filter((hash) => !before.includes(hash)).length;
  assert.ok(changedByEdit <= 2, `an overwrite changed ${changedByEdit} chunks`);
  assert.ok(changedByEdit >= 1, "the edit is not invisible");

  // An insertion shifts every later byte; content-defined cutting must still
  // resynchronise instead of rewriting the tail.
  const inserted = new Uint8Array(data.length + 1);
  const at = Math.floor(data.length / 2);
  inserted.set(data.subarray(0, at), 0);
  inserted[at] = 0x2a;
  inserted.set(data.subarray(at), at + 1);
  const afterInsert = (await chunksOf(inserted)).map(digest);
  const changedByInsert = afterInsert.filter((hash) => !before.includes(hash)).length;
  assert.ok(changedByInsert <= 2, `an insertion changed ${changedByInsert} chunks`);
});

test("cutPoint honours the minimum and the maximum", async () => {
  const gear = await chunker.gearTable();
  assert.equal(chunker.cutPoint(new Uint8Array(chunker.CHUNK_MIN), gear), chunker.CHUNK_MIN);
  assert.equal(chunker.cutPoint(new Uint8Array(1024), gear), 1024);
  const oversize = stream((10 << 20), 0x7777);
  assert.ok(chunker.cutPoint(oversize, gear) <= chunker.CHUNK_MAX);
  assert.ok(chunker.cutPoint(oversize, gear) >= chunker.CHUNK_MIN);
});

test("chunk encryption over a chunked file yields per-chunk sids", async () => {
  const domainKey = Uint8Array.from(Buffer.from(fixtures.domains[0].domain_key, "hex"));
  const data = stream(12 << 20, 0x9911);
  const sids = [];
  for await (const chunk of chunker.chunkStream(chunker.bytesSource(data))) {
    sids.push((await c.encryptChunk(domainKey, chunk)).sid);
  }
  assert.ok(sids.length >= 2);
  assert.equal(new Set(sids).size, sids.length, "distinct chunks have distinct sids");
});
