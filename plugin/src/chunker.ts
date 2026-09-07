/**
 * Content-defined chunking, `docs/architecture.md` 3.3.
 *
 * A file of at most `CHUNK_MAX` (8 MiB) is exactly one chunk. A larger file
 * is cut by a gear-hash rolling window with minimum 1 MiB, target 4 MiB and
 * maximum 8 MiB, so editing the middle of a 20 GB archive re-uploads a
 * handful of chunks instead of the file. The chunk cap also keeps every
 * upload far below the 100 MB body limit a free edge zone imposes and bounds
 * device memory.
 *
 * CONSTANTS (a second implementation must match all of them):
 * - `CHUNK_MIN = 1 MiB`, `CHUNK_MAX = 8 MiB`.
 * - Cut when `hash & GEAR_MASK === 0`. `GEAR_MASK` is the top 22 bits of a
 *   32-bit word (`0xfffffc00`), so a cut is expected every 2^22 = 4 MiB.
 *   The mask uses the HIGH bits because `h = (h << 1) + gear[byte]` pushes
 *   accumulated history upward.
 * - The rolling hash consumes every byte of the chunk from its first byte,
 *   but a cut is only ACCEPTED once `CHUNK_MIN` bytes are in the chunk.
 * - `GEAR[i] = big-endian u32 of the first 4 bytes of
 *   SHA-256(utf8("obsync/v1/gear") || byte(i))` for i in 0..255. Generating
 *   the table instead of embedding it keeps both implementations honest:
 *   the table is a function of one seed string.
 *
 * PLATFORM. Identical on desktop and mobile; the difference is the
 * `ByteSource` behind it. Desktop streams 8 MiB windows out of Node's `fs`
 * (`main.ts`), mobile reads the whole file through the vault adapter
 * (`bytesSource`), which is why mobile carries a per-file ceiling
 * (`policy.ts`).
 */

import { Bytes, concat, sha256, utf8 } from "./crypto";

export const CHUNK_MIN = 1 << 20;
export const CHUNK_TARGET = 4 << 20;
export const CHUNK_MAX = 8 << 20;
export const GEAR_SEED = "obsync/v1/gear";
/** Top 22 bits of a 32-bit word: one expected cut per `CHUNK_TARGET` bytes. */
export const GEAR_MASK = 0xfffffc00;

/**
 * A random-access byte source. `read` MAY return fewer bytes than asked for;
 * `readFully` below is what the chunker uses, because a short read that was
 * treated as the end of a window would move a chunk boundary and silently
 * destroy deduplication between two devices reading the same file.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Bytes>;
}

/** Read `length` bytes, or everything that is left if the source ends early. */
export async function readFully(source: ByteSource, offset: number, length: number): Promise<Bytes> {
  const pieces: Bytes[] = [];
  let filled = 0;
  while (filled < length) {
    const piece = await source.read(offset + filled, length - filled);
    if (piece.length === 0) break;
    pieces.push(piece);
    filled += piece.length;
  }
  return pieces.length === 1 ? (pieces[0] as Bytes) : concat(...pieces);
}

export function bytesSource(data: Bytes): ByteSource {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length) as Bytes,
  };
}

let gearTableCache: Uint32Array | null = null;

/** The 256-entry gear table, derived once per session from `GEAR_SEED`. */
export async function gearTable(): Promise<Uint32Array> {
  if (gearTableCache) return gearTableCache;
  const seed = utf8(GEAR_SEED);
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const digest = await sha256(concat(seed, new Uint8Array([i])));
    table[i] =
      (((digest[0] as number) << 24) |
        ((digest[1] as number) << 16) |
        ((digest[2] as number) << 8) |
        (digest[3] as number)) >>>
      0;
  }
  gearTableCache = table;
  return table;
}

/**
 * Length of the next chunk inside `window`, which must start at a chunk
 * boundary. Returns `window.length` when no cut point is found, so the
 * caller's window length is the maximum chunk length.
 */
export function cutPoint(window: Bytes, gear: Uint32Array): number {
  const limit = Math.min(window.length, CHUNK_MAX);
  if (limit <= CHUNK_MIN) return limit;
  let hash = 0;
  for (let i = 0; i < limit; i++) {
    hash = ((hash << 1) + (gear[window[i] as number] as number)) >>> 0;
    if (i + 1 >= CHUNK_MIN && (hash & GEAR_MASK) === 0) return i + 1;
  }
  return limit;
}

/**
 * Split a source into chunk plaintexts in file order. At most
 * `CHUNK_MAX` bytes of the source plus one chunk are held at a time, so a
 * 20 GB file costs the same memory as an 8 MiB one on desktop.
 */
export async function* chunkStream(source: ByteSource): AsyncGenerator<Bytes> {
  if (source.size <= CHUNK_MAX) {
    yield await readFully(source, 0, source.size);
    return;
  }
  const gear = await gearTable();
  let position = 0;
  let window: Bytes = new Uint8Array(0);
  while (position < source.size) {
    const want = Math.min(CHUNK_MAX, source.size - position);
    if (window.length < want) {
      window = concat(window, await readFully(source, position + window.length, want - window.length));
    }
    if (window.length === 0) return;
    const cut = cutPoint(window, gear);
    yield window.subarray(0, cut) as Bytes;
    window = window.slice(cut) as Bytes;
    position += cut;
  }
}

/** Chunk lengths in file order. Used by tests and by the resume accounting. */
export async function chunkLengths(source: ByteSource): Promise<number[]> {
  const lengths: number[] = [];
  for await (const chunk of chunkStream(source)) lengths.push(chunk.length);
  return lengths;
}
