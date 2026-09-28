/**
 * The empty file a phone's dropped write leaves is never sent, whatever becomes
 * of the parked record (#242; review of 90d2042, finding 2).
 *
 * The guard once lived in the parked record's reason, and two things change
 * that reason or end the record while the empty file still stands: a later
 * head too large to fetch under the pull lock goes to the download lane
 * (`downloading`), and a rename on another device lands the version under a
 * new name and releases the record. The reviewer's probes, kept as tests: a
 * zero-byte version under the original file id in the first case, and a new
 * zero-byte note under the old name in the second.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine, LARGE_APPLY_BYTES } = require("../build/sync/engine.js");
const { Transport } = require("../build/transport.js");
const { decodeRecordManifest } = require("../build/sync/pull.js");
const { bytesSource, chunkStream } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const ID = "17".repeat(16);
const PATH = "Notes/n17.md";
const NEXT = "Notes/renamed.md";
const enc = (text) => new TextEncoder().encode(text);

/** A phone whose writes of `PATH` stay empty, with a download of it parked as `write_dropped`. */
async function dropped(t, existing) {
  const r = await rig({ isMobile: true });
  const timers = new FakeTimers();
  let block = false, blocked = false, release;
  const wire = new Promise((done) => { release = done; });
  const transport = new Transport({
    request: async (request) => {
      const target = request.url.replace(/^https?:\/\/[^/]+/, "");
      if (block && ((request.method === "GET" && target.startsWith("/v1/chunks/")) ||
        (request.method === "POST" && target === "/v1/chunks/get"))) { blocked = true; await wire; }
      return r.server.request(request);
    },
    serverUrl: () => r.state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [], now: () => r.host.clock, sleep: async () => undefined, maxAttempts: 2,
  });
  const engine = new SyncEngine({ state: r.state, host: r.host, transport, timers, now: () => r.host.clock });
  t.after(async () => { engine.stop(); block = false; release(); await engine.stopAndWait(); });
  const foreign = (path, text, parents = []) => r.server.publish({ fileId: ID, path, bytes: enc(text),
    mtime: 1757200001000, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const base = existing ? await foreign(PATH, "original remote text") : null;
  r.host.seed("Notes/starter.md", "starter", 1000);
  await engine.start();
  await timers.run(1000, () => r.state.fileByPath("Notes/starter.md") !== undefined &&
    (!existing || r.host.text(PATH) === "original remote text"));
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path, size) => {
    const pending = await writer(path, size);
    if (path !== PATH) return pending;
    return { ...pending, commit: async () => {
      r.host.seed(PATH, "", 9000);
      throw Object.assign(new Error("write_dropped: sentinel"), { code: "write_dropped" });
    } };
  };
  const first = await foreign(PATH, "new remote text", base ? [base.version_id] : []);
  await timers.run(1000, () => r.state.data.lastSeq >= first.seq && r.state.data.parked[ID]?.reason === "write_dropped");
  assert.equal(r.host.text(PATH), "");
  return { ...r, timers, engine, foreign, first, writer,
    block: () => { block = true; }, blocked: () => blocked,
    ours: () => r.server.journal.filter((frame) => frame.device_id === KEYS.deviceId && frame.file_id === ID) };
}

for (const existing of [false, true]) {
  test(`a rename on another device leaves the empty file unsent under the old name (existing=${existing})`, async (t) => {
    const r = await dropped(t, existing);
    const moved = await r.foreign(NEXT, "new remote text", [r.first.version_id]);
    await r.timers.run(1000, () => r.state.data.lastSeq >= moved.seq);
    r.host.writer = r.writer;
    const before = r.server.journal.length;
    if (r.host.text(PATH) !== null) await r.engine.pushOne(PATH);
    const empty = [];
    for (const frame of r.server.journal.slice(before)) {
      if (frame.device_id !== KEYS.deviceId) continue;
      const manifest = await decodeRecordManifest(r.context, frame);
      if (manifest.v === 1 && !manifest.deleted && manifest.size === 0) empty.push({ path: manifest.path, fileId: frame.file_id });
    }
    assert.deepEqual(empty, [], `parked=${JSON.stringify(r.state.data.parked)} files=${JSON.stringify([...r.host.files.keys()])}`);
  });
}

for (const existing of [false, true]) {
  test(`a local rename takes the mark with the empty file, and it stays unsent (existing=${existing}, review of d62f201)`, async (t) => {
    const r = await dropped(t, existing);
    assert.equal(r.state.data.dropped[PATH], ID);
    const before = r.server.journal.length;
    assert.equal(await r.host.move(PATH, NEXT), "moved");
    r.engine.renamed(PATH, NEXT);
    await r.timers.run(1000);
    const empty = [];
    for (const frame of r.server.journal.slice(before)) {
      if (frame.device_id !== KEYS.deviceId) continue;
      const manifest = await decodeRecordManifest(r.context, frame);
      if (manifest.v === 1 && !manifest.deleted && manifest.size === 0) empty.push({ path: manifest.path, fileId: frame.file_id });
    }
    assert.deepEqual(empty, [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    assert.deepEqual(r.state.data.dropped, { [NEXT]: ID });
    assert.deepEqual((await r.reload()).data.dropped, { [NEXT]: ID }, "the moved mark was not saved for the next start");
  });
}

test("a larger head sent to the download lane keeps the empty file unsent", async (t) => {
  const r = await dropped(t, true);
  const bytes = new Uint8Array(LARGE_APPLY_BYTES + 1).fill(73);
  const chunks = [];
  for await (const plaintext of chunkStream(bytesSource(bytes))) {
    const part = await c.encryptChunk(r.keys.domainKey, plaintext);
    r.server.chunks.set(part.sid, part.ciphertext);
    chunks.push({ sid: part.sid, cid: c.hex(part.cid), len: plaintext.length });
  }
  const manifest = { v: 1, path: PATH, size: bytes.length, mtime: 12000, domain: KEYS.domainId,
    chunks, sha256: c.hex(await c.sha256(bytes)), deleted: false };
  r.block();
  const large = await r.server.publishManifest({ fileId: ID, manifest, sids: chunks.map((chunk) => chunk.sid),
    parents: [r.first.version_id], deviceId: "ff".repeat(16), manifestKey: r.keys.manifestKey, bytes: bytes.length });
  await r.timers.run(1000, () => r.state.data.lastSeq >= large.seq && r.blocked());
  const parked = JSON.stringify(r.state.data.parked);
  const before = r.ours().length;
  let done = false;
  const pushing = r.engine.pushOne(PATH).catch(() => undefined).finally(() => { done = true; });
  await r.timers.run(1000, () => done || r.ours().length > before);
  assert.deepEqual(r.ours().slice(before).map((frame) => ({ bytes: frame.bytes, parents: frame.parents })), [],
    `the empty file was sent while parked=${parked}`);
  assert.ok(r.host.logs.includes(`push path_class=file decision=skipped reason=write_dropped file=${ID}`), r.host.logs.join(" | "));
  await pushing;
});
