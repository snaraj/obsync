/**
 * The manifest-to-record binding: what a decrypted manifest must AGREE with
 * before this device spends a byte of memory, a chunk request, or a write.
 *
 * Every hostile case here is a manifest this vault's key decrypts happily —
 * built with the test vault key and sealed against the record's own AAD, the
 * way a compromised paired device would build one — that disagrees with the
 * authenticated record it rides in. The record is what the server accounts,
 * retains, and will authorize on; the manifest is data another device wrote.
 * Each case asserts the same four things: the change is refused, nothing
 * reached the vault, no remote-only entry was invented, and one log line
 * names the reason.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, fetchRemoteOnly, bindManifestToRecord } = require("../build/sync/pull.js");
const { pushDelete, pushFile } = require("../build/sync/push.js");
const { CHUNK_MAX, CHUNK_MIN } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
/** A well-formed 32-byte id that names no chunk the server holds. */
const sid = (n) => String(n).padStart(2, "0").repeat(32);
const OTHER_DEVICE = "ffffffffffffffffffffffffffffffff";
const OTHER_DOMAIN = "fedcba9876543210fedcba9876543210";

/** A manifest with honest defaults; a caller overrides exactly what it attacks. */
function manifest(fields) {
  return {
    v: 1,
    path: "Notes/Bound.md",
    size: 0,
    mtime: 1757200001000,
    domain: KEYS.domainId,
    chunks: [],
    sha256: "",
    deleted: false,
    ...fields,
  };
}

/** Land one forged version and apply it, then report what the device did. */
async function hostile({ fileId, manifest: m, sids, bytes, domainId, deleted, policy }) {
  const { host, server, state, context, keys: k } = await rig(policy ? { isMobile: true, policy } : {});
  const frame = await server.publishManifest({
    fileId,
    manifest: m,
    sids,
    parents: [],
    deviceId: OTHER_DEVICE,
    manifestKey: k.manifestKey,
    bytes,
    ...(domainId === undefined ? {} : { domainId }),
    ...(deleted === undefined ? {} : { deleted }),
  });
  const result = await applyChange(context, frame);
  return { result, host, server, state, context, keys: k, frame };
}

/** The whole refusal contract, asserted once so no case can assert less. */
function assertRefused({ result, host, state }, fileId, reason) {
  assert.equal(result, "refused", `expected a refusal, got ${result}`);
  assert.equal(host.files.size, 0, "not one byte reached the vault");
  assert.deepEqual(host.trashed, [], "and nothing was deleted either");
  assert.deepEqual(Object.keys(state.data.files), [], "the version was not recorded");
  assert.deepEqual(Object.keys(state.data.remoteOnly), [], "and no remote-only entry was invented");
  assert.ok(
    host.logs.some((line) => line.includes(`decision=refused reason=${reason} file=${fileId}`)),
    `the refusal should name ${reason}: ${host.logs.join(" | ")}`,
  );
  assert.equal(host.notices.length, 1, "the user is told once");
}

/**
 * A deterministic incompressible fixture: the gear hash finds real cut points
 * in it, so a file this size is many chunks of different sizes rather than a
 * run of maximum-size ones. 21 MiB is the smallest size that gives BOTH more
 * chunks than one batch may hold and a final chunk below `CHUNK_MIN`, which
 * is the one place the chunker is allowed to emit a short window.
 */
const FIXTURE_BYTES = 21 << 20;
let fixtureCache = null;
function fixture() {
  if (fixtureCache) return fixtureCache;
  const bytes = new Uint8Array(FIXTURE_BYTES);
  let x = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    bytes[i] = x >>> 24;
  }
  fixtureCache = bytes;
  return bytes;
}

/**
 * Chunk DOWNLOADS of every shape — the single `GET /v1/chunks/{sid}` and the
 * batched `POST /v1/chunks/get` — and neither the existence probe nor an
 * upload, so a test that also pushes still counts only what it pulled.
 */
function chunkFetches(requests) {
  return requests.filter(
    (request) =>
      (request.method === "GET" && request.target.startsWith("/v1/chunks/")) ||
      request.target === "/v1/chunks/get",
  );
}

/** How many sids each of those fetches asked for, in order. */
function fetchSizes(requests) {
  return chunkFetches(requests).map((request) =>
    request.target === "/v1/chunks/get" ? JSON.parse(request.json).sids.length : 1,
  );
}

test("the reviewer's case: a manifest that under-declares its size walks through no ceiling", async () => {
  const fileId = "20".repeat(16);
  const payload = enc("this payload is larger than sixteen bytes");
  assert.equal(payload.length, 41);
  const { host, server, state, context, keys: k } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 16, totalBudgetBytes: 0 },
  });
  // The chunk is real and correctly encrypted: only the manifest lies, and it
  // lies about the one number every ceiling is measured against.
  const { cid, sid: only, ciphertext } = await c.encryptChunk(k.domainKey, payload);
  server.chunks.set(only, ciphertext);
  const frame = await server.publishManifest({
    fileId,
    manifest: manifest({
      path: "Attachments/large.bin",
      size: 1,
      chunks: [{ sid: only, cid: c.hex(cid), len: payload.length }],
      sha256: c.hex(await c.sha256(payload)),
    }),
    sids: [only],
    parents: [],
    deviceId: OTHER_DEVICE,
    manifestKey: k.manifestKey,
    bytes: payload.length,
  });

  const result = await applyChange(context, frame);
  assertRefused({ result, host, state }, fileId, "record_bytes");
  assert.equal(host.files.has("Attachments/large.bin"), false, "the 41 bytes were never written");
  assert.deepEqual(fetchSizes(server.requests), [], "and the refusal came before the first chunk request");
});

test("a refused manifest costs zero chunk requests, on every fetch path", async () => {
  // Two chunks, so a pass through the binding would use the BATCHED fetch and
  // not the single GET: the count has to be zero on both paths.
  const fileId = "21".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX + CHUNK_MIN,
      chunks: [
        { sid: sid(1), cid: sid(9), len: CHUNK_MAX },
        { sid: sid(2), cid: sid(8), len: CHUNK_MIN },
      ],
    }),
    sids: [sid(1), sid(2)],
    bytes: CHUNK_MAX + CHUNK_MIN + 1,
  });
  assertRefused(outcome, fileId, "record_bytes");
  assert.deepEqual(fetchSizes(outcome.server.requests), [], "nothing was fetched for a version that was refused");
});

test("a manifest whose chunk order is not the record's is refused", async () => {
  const fileId = "22".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX + CHUNK_MIN,
      chunks: [
        { sid: sid(2), cid: sid(8), len: CHUNK_MAX },
        { sid: sid(1), cid: sid(9), len: CHUNK_MIN },
      ],
    }),
    sids: [sid(1), sid(2)],
    bytes: CHUNK_MAX + CHUNK_MIN,
  });
  assertRefused(outcome, fileId, "record_sid_order");
});

test("a manifest missing one of the record's chunks is refused", async () => {
  const fileId = "23".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX,
      chunks: [{ sid: sid(1), cid: sid(9), len: CHUNK_MAX }],
    }),
    sids: [sid(1), sid(2)],
    bytes: CHUNK_MAX,
  });
  assertRefused(outcome, fileId, "record_sid_count");
});

test("a manifest naming a chunk the record does not is refused", async () => {
  const fileId = "24".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX + CHUNK_MIN,
      chunks: [
        { sid: sid(1), cid: sid(9), len: CHUNK_MAX },
        { sid: sid(3), cid: sid(7), len: CHUNK_MIN },
      ],
    }),
    sids: [sid(1)],
    bytes: CHUNK_MAX + CHUNK_MIN,
  });
  assertRefused(outcome, fileId, "record_sid_count");
});

test("a record outside this engine's domain is refused before it is read", async () => {
  const fileId = "25".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({ size: 4, chunks: [{ sid: sid(1), cid: sid(9), len: 4 }], domain: OTHER_DOMAIN }),
    sids: [sid(1)],
    bytes: 4,
    domainId: OTHER_DOMAIN,
  });
  assertRefused(outcome, fileId, "record_domain");
});

test("a manifest naming a domain other than its record's is refused", async () => {
  const fileId = "26".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({ size: 4, chunks: [{ sid: sid(1), cid: sid(9), len: 4 }], domain: OTHER_DOMAIN }),
    sids: [sid(1)],
    bytes: 4,
    domainId: KEYS.domainId,
  });
  assertRefused(outcome, fileId, "manifest_domain");
});

test("a tombstone record carrying a live manifest is refused, and deletes nothing", async () => {
  const fileId = "27".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({ size: 4, chunks: [{ sid: sid(1), cid: sid(9), len: 4 }] }),
    sids: [sid(1)],
    bytes: 4,
    deleted: true,
  });
  assertRefused(outcome, fileId, "record_deleted");
});

test("a tombstone that still carries chunks or a size is refused, and deletes nothing", async () => {
  // Both sides agree the file is deleted, so the record/manifest tombstone
  // check passes; the SHAPE is what is wrong. A tombstone with chunks would
  // buy fetches for a file that does not exist, and a tombstone with a size
  // would count against a budget for nothing.
  const fileId = "f".repeat(32);
  const withChunks = await hostile({
    fileId,
    manifest: manifest({ deleted: true, size: 4, chunks: [{ sid: sid(1), cid: sid(9), len: 4 }] }),
    sids: [sid(1)],
    bytes: 4,
    deleted: true,
  });
  assertRefused(withChunks, fileId, "chunk_count");
  // A size with no chunks is caught one check earlier, by the length sum:
  // the shape check above is the one that a tombstone WITH chunks needs.
  const withSize = await hostile({
    fileId,
    manifest: manifest({ deleted: true, size: 41, chunks: [] }),
    sids: [],
    bytes: 41,
    deleted: true,
  });
  assertRefused(withSize, fileId, "chunk_len_sum");
});

test("a live record carrying a tombstone manifest is refused, and deletes nothing", async () => {
  const fileId = "28".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({ deleted: true }),
    sids: [],
    bytes: 0,
    deleted: false,
  });
  assertRefused(outcome, fileId, "record_deleted");
});

test("a manifest whose size is not the record's byte count is refused", async () => {
  const fileId = "29".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({ size: 4, chunks: [{ sid: sid(1), cid: sid(9), len: 4 }] }),
    sids: [sid(1)],
    bytes: 5,
  });
  assertRefused(outcome, fileId, "record_bytes");
});

test("a manifest whose size is not the sum of its chunk lengths is refused", async () => {
  const fileId = "2a".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({ size: 1, chunks: [{ sid: sid(1), cid: sid(9), len: 41 }] }),
    sids: [sid(1)],
    bytes: 1,
  });
  assertRefused(outcome, fileId, "chunk_len_sum");
});

test("a declared chunk length of zero is refused", async () => {
  const fileId = "2b".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX + CHUNK_MIN,
      chunks: [
        { sid: sid(1), cid: sid(9), len: CHUNK_MAX },
        { sid: sid(2), cid: sid(8), len: CHUNK_MIN },
        { sid: sid(3), cid: sid(7), len: 0 },
      ],
    }),
    sids: [sid(1), sid(2), sid(3)],
    bytes: CHUNK_MAX + CHUNK_MIN,
  });
  assertRefused(outcome, fileId, "chunk_len_zero");
});

test("a declared chunk length above the chunk ceiling is refused", async () => {
  const fileId = "2c".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX + 1 + CHUNK_MIN,
      chunks: [
        { sid: sid(1), cid: sid(9), len: CHUNK_MAX + 1 },
        { sid: sid(2), cid: sid(8), len: CHUNK_MIN },
      ],
    }),
    sids: [sid(1), sid(2)],
    bytes: CHUNK_MAX + 1 + CHUNK_MIN,
  });
  assertRefused(outcome, fileId, "chunk_len_ceiling");
});

test("a chunk count the chunker could not have produced is refused", async () => {
  const fileId = "2d".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: 20,
      chunks: [
        { sid: sid(1), cid: sid(9), len: 10 },
        { sid: sid(2), cid: sid(8), len: 10 },
      ],
    }),
    sids: [sid(1), sid(2)],
    bytes: 20,
  });
  assertRefused(outcome, fileId, "chunk_count");
});

test("a chunk shorter than the chunker's minimum window is refused", async () => {
  const fileId = "2e".repeat(16);
  const outcome = await hostile({
    fileId,
    manifest: manifest({
      size: CHUNK_MAX + 100,
      chunks: [
        { sid: sid(1), cid: sid(9), len: 100 },
        { sid: sid(2), cid: sid(8), len: CHUNK_MAX },
      ],
    }),
    sids: [sid(1), sid(2)],
    bytes: CHUNK_MAX + 100,
  });
  assertRefused(outcome, fileId, "chunk_len_short");
});

test("a chunk that decrypts to a different length than it declared is refused", async () => {
  const fileId = "2f".repeat(16);
  const { host, server, state, context, keys: k } = await rig();
  const payload = enc("eleven-byte");
  const { cid, sid: only, ciphertext } = await c.encryptChunk(k.domainKey, payload);
  server.chunks.set(only, ciphertext);
  // Consistent on every field the record can see: only the BYTES disagree,
  // and only once they have been fetched and decrypted.
  const frame = await server.publishManifest({
    fileId,
    manifest: manifest({ size: 12, chunks: [{ sid: only, cid: c.hex(cid), len: 12 }] }),
    sids: [only],
    parents: [],
    deviceId: OTHER_DEVICE,
    manifestKey: k.manifestKey,
    bytes: 12,
  });

  const result = await applyChange(context, frame);
  assertRefused({ result, host, state }, fileId, "chunk_len_actual");
  assert.deepEqual(fetchSizes(server.requests), [1], "it took a fetch to see this one, and exactly one");
});

test("a consistent manifest still applies, single chunk and many", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const small = await server.publish({
    fileId: "31".repeat(16),
    path: "Notes/Honest.md",
    bytes: enc("bound to its record\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, small), "applied");
  assert.equal(host.text("Notes/Honest.md"), "bound to its record\n");

  // A real multi-chunk file, pushed by the real push path and pulled back:
  // the binding has to accept exactly what an honest device produces, short
  // final window and all, and the batched fetch has to reassemble it byte for
  // byte.
  const big = fixture();
  host.seed("Attachments/big.bin", big, 1000);
  const pushed = await pushFile(context, "Attachments/big.bin");
  const frame = server.journal.find((entry) => entry.version_id === pushed.versionId);
  assert.equal(frame.sids.length, 5, "the fixture is more chunks than one batch may hold");
  state.forgetPath("Attachments/big.bin");
  host.files.delete("Attachments/big.bin");

  const before = server.requests.length;
  assert.equal(await applyChange(context, { ...frame, device_id: OTHER_DEVICE }), "applied");
  assert.deepEqual(host.files.get("Attachments/big.bin").bytes, big, "every byte came back");
  assert.equal(state.fileByPath("Attachments/big.bin").versionId, pushed.versionId);

  // The memory bound, measured rather than asserted in a comment: a batch is
  // capped at floor(32 MiB / (CHUNK_MAX + 16)) = 3 chunks, counted at the CEILING, so this
  // file takes two requests. Budgeting by the declared lengths would have put
  // all five (21 MiB declared) into one, and a chunk list of zeros into one
  // of 64.
  const batches = fetchSizes(server.requests.slice(before));
  assert.deepEqual(batches, [3, 2], `two fetches, capped by count: ${batches.join(",")}`);
});

test("four distinct maximal encrypted chunks fit bounded pulls with the existing tag", async () => {
  const { host, server, state, context } = await rig();
  const original = new Uint8Array(4 * CHUNK_MAX);
  for (let i = 0; i < 4; i++) original.fill(17 * (i + 1), i * CHUNK_MAX, (i + 1) * CHUNK_MAX);
  host.seed("Attachments/maximal.bin", original, 1000);
  const pushed = await pushFile(context, "Attachments/maximal.bin");
  assert.equal(pushed.status, "pushed");
  const frame = server.journal.find((entry) => entry.version_id === pushed.versionId);
  assert.equal(new Set(frame.sids).size, 4, "ordinary CDC produces four distinct chunks");
  assert.deepEqual(frame.sids.map((sid) => server.chunks.get(sid).length), new Array(4).fill(8 * 1024 * 1024 + 16));
  await assert.rejects(context.transport.getChunks(frame.sids), (error) => error.code === "batch_too_large");
  state.forgetPath("Attachments/maximal.bin");
  host.files.delete("Attachments/maximal.bin");
  const written = [];
  const create = host.writer.bind(host);
  host.writer = async (...args) => {
    const writer = await create(...args);
    return { ...writer, write: async (part) => { written.push(part.length); await writer.write(part); } };
  };
  const before = server.requests.length;
  assert.equal(await applyChange(context, { ...frame, device_id: OTHER_DEVICE }), "applied");
  assert.deepEqual(fetchSizes(server.requests.slice(before)), [3, 1]);
  assert.deepEqual(written, new Array(4).fill(CHUNK_MAX));
  assert.deepEqual(host.files.get("Attachments/maximal.bin").bytes, original);
  assert.equal(state.fileByPath("Attachments/maximal.bin").versionId, pushed.versionId);
  assert.equal(server.files.get(frame.file_id).versions.length, 1);
});

test("the fake wire contract rejects one byte above the ciphertext upload ceiling", async () => {
  const { server, context } = await rig();
  const body = new Uint8Array(8 * 1024 * 1024 + 17).fill(81);
  const sid = c.hex(await c.sha256(body));
  await assert.rejects(context.transport.putChunk(sid, body), (error) => error.code === "body_too_large");
  assert.equal(server.chunks.has(sid), false);
});

test("what an honest device posts is exactly what its manifest says", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed("Notes/Ideas.md", "# Ideas\n", 1000);
  host.seed("Notes/Empty.md", "", 1000);
  host.seed("Attachments/big.bin", fixture(), 1000);
  host.seed("gone.md", "briefly here\n", 1000);

  await pushFile(context, "Notes/Ideas.md");
  await pushFile(context, "Notes/Empty.md");
  await pushFile(context, "Attachments/big.bin");
  await pushFile(context, "gone.md");
  // A rename posts a new version of the same file with a new path inside it.
  host.seed("Notes/Renamed.md", "# Ideas\n", 2000);
  context.state.setFile("Notes/Renamed.md", context.state.fileByPath("Notes/Ideas.md"));
  context.state.forgetPath("Notes/Ideas.md");
  await pushFile(context, "Notes/Renamed.md", true);
  await pushDelete(context, "gone.md");

  assert.ok(server.journal.length >= 6, `every push landed a version: ${server.journal.length}`);
  for (const frame of server.journal) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const json = await c.decryptManifest(
      k.manifestKey,
      frame.file_id,
      binder,
      Uint8Array.from(Buffer.from(frame.manifest_nonce, "hex")),
      c.unbase64(frame.manifest_ct),
    );
    const posted = JSON.parse(json);
    // The claim: the binding never trips on honest traffic, empty files and
    // tombstones and 12 MiB archives included.
    bindManifestToRecord(frame, posted, KEYS.domainId);
    assert.deepEqual(posted.chunks.map((chunk) => chunk.sid), frame.sids, posted.path);
    assert.equal(posted.size, frame.bytes, posted.path);
    assert.equal(posted.deleted, frame.deleted, posted.path);
  }
});

test("an on-demand fetch binds the manifest to the file's own domain", async () => {
  const { host, server, state, context, keys: k } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 16, totalBudgetBytes: 0 },
  });
  const fileId = "32".repeat(16);
  const frame = await server.publish({
    fileId,
    path: "Attachments/held.bin",
    bytes: enc("this payload is larger than sixteen bytes"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");

  // `GET /v1/files/{id}` states the domain once, on the file. Move it, and
  // the on-demand fetch refuses rather than reading a version from a domain
  // this engine holds no key for.
  server.files.get(fileId).domain_id = OTHER_DOMAIN;
  await assert.rejects(() => fetchRemoteOnly(context, fileId), /record_domain/);
  assert.equal(host.files.has("Attachments/held.bin"), false, "nothing was written on the way out");

  server.files.get(fileId).domain_id = KEYS.domainId;
  assert.equal(await fetchRemoteOnly(context, fileId), "Attachments/held.bin");
  assert.equal(host.text("Attachments/held.bin"), "this payload is larger than sixteen bytes");
  assert.equal(state.data.remoteOnly[fileId], undefined);
});

test("a merge base above one chunk keeps both sides instead of holding it whole", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const fileId = "33".repeat(16);
  const path = "Notes/Ancestor.md";
  // A version graph another device shaped: a multi-chunk ANCESTOR under a
  // small, perfectly mergeable head. Nothing here is malformed -- the base
  // record and its manifest agree on every field -- it is simply too big to
  // assemble in memory, which is the one thing `isMergeableText` never sees.
  const base = await server.publishManifest({
    fileId,
    manifest: manifest({
      path,
      size: CHUNK_MAX + CHUNK_MIN,
      chunks: [
        { sid: sid(1), cid: sid(9), len: CHUNK_MAX },
        { sid: sid(2), cid: sid(8), len: CHUNK_MIN },
      ],
    }),
    sids: [sid(1), sid(2)],
    parents: [],
    deviceId: OTHER_DEVICE,
    manifestKey: k.manifestKey,
    bytes: CHUNK_MAX + CHUNK_MIN,
  });
  const mine = await server.publish({
    fileId,
    path,
    bytes: enc("my line\n"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.version_id],
  });
  const theirs = await server.publish({
    fileId,
    path,
    bytes: enc("their line\n"),
    mtime: 1757200003000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.version_id],
  });
  host.seed(path, "my line\n", 2000);
  state.setFile(path, { fileId, versionId: mine.version_id, mtime: 2000, size: 8, sha256: "" });

  assert.equal(await applyChange(context, theirs), "conflict_copy");
  assert.equal(host.text(path), "my line\n", "our edit is untouched");
  const copy = [...host.files.keys()].find((name) => name.includes("conflict from"));
  assert.equal(host.text(copy), "their line\n");
  assert.ok(
    host.logs.some((line) => line.includes(`reason=base_above_one_chunk bytes=${CHUNK_MAX + CHUNK_MIN}`)),
    `the refusal to merge names its reason and its size: ${host.logs.join(" | ")}`,
  );
  assert.equal(fetchSizes(server.requests).length, 1, "only their one chunk was ever fetched");
});
