import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { pushFile, PUSH_WINDOW_BYTES } = require("../build/sync/push.js");
const { assembleBytes, decodeRecordManifest } = require("../build/sync/pull.js");
const { CHUNK_MAX } = require("../build/chunker.js");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async check => {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 1));
  return check();
};
function noise(size) {
  const bytes = new Uint8Array(size);
  let x = 1;
  for (let i = 0; i < size; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; bytes[i] = x >>> 24; }
  return bytes;
}

test("a bounded next window is read while one existence check waits, and the receiver reconstructs exact bytes (#325)", async () => {
  const r = await rig(), held = deferred(), bytes = noise(64 << 20);
  r.host.seed("pipeline.bin", bytes, 1000);
  let readBytes = 0, atCheck = 0, checks = 0, peakChecks = 0;
  const source = r.host.source.bind(r.host);
  r.host.source = (path, size) => {
    const file = source(path, size);
    return { size, read: async (at, size) => { const b = await file.read(at, size); readBytes += b.length; return b; } };
  };
  const missing = r.transport.missingChunks.bind(r.transport);
  r.transport.missingChunks = async (...args) => {
    checks++; peakChecks = Math.max(peakChecks, checks);
    try { if (atCheck === 0) { atCheck = readBytes; await held.promise; } return await missing(...args); }
    finally { checks--; }
  };
  const pushing = pushFile(r.context, "pipeline.bin");
  let outcome;
  try {
    assert.ok(await until(() => atCheck > 0), "the first existence check was reached");
    assert.ok(await until(() => readBytes > atCheck), "reading waited for the existence response");
    assert.ok(readBytes <= PUSH_WINDOW_BYTES + 2 * CHUNK_MAX, "existence wait bypassed the read/ciphertext window");
    assert.equal(r.server.files.size, 1, "a version was published before its chunks landed");
  } finally { held.resolve(); outcome = await pushing; }
  assert.equal(peakChecks, 1, "existence checks became an unbounded parallel lane");
  assert.equal(readBytes, bytes.length, "the pipeline reread source bytes");
  assert.equal(outcome.status, "pushed");
  const record = r.server.journal.find(row => row.version_id === outcome.versionId);
  const manifest = await decodeRecordManifest(r.context, record);
  assert.deepEqual(await assembleBytes(r.context, manifest), bytes);
});

for (const failure of ["existence", "upload"]) test(`a rejected ${failure} cannot disappear while the next window encrypts (#325)`, async () => {
  const r = await rig(), error = new Error("SENTINEL rejected " + failure);
  r.host.seed("pipeline.bin", noise(48 << 20), 1000);
  const method = failure === "existence" ? "missingChunks" : "putChunk";
  let rejected = false;
  const original = r.transport[method].bind(r.transport);
  r.transport[method] = async (...args) => {
    if (!rejected) { rejected = true; throw error; }
    return original(...args);
  };
  await assert.rejects(pushFile(r.context, "pipeline.bin"), caught => caught === error);
  assert.ok(rejected);
  assert.equal(r.server.files.size, 1, "a failed chunk batch posted a version");
  assert.equal(r.state.fileByPath("pipeline.bin"), undefined, "failed bytes were acknowledged locally");
});

test("an existence request in flight is drained by stop before the push returns (#325)", async () => {
  const r = await rig(), halt = new AbortController();
  r.host.seed("pipeline.bin", noise(48 << 20), 1000);
  let waiting = false;
  const request = r.transport.options.request;
  r.transport.options.request = async sent => {
    if (sent.url.endsWith("/v1/chunks/exists")) { waiting = true; await new Promise(() => undefined); }
    return request(sent);
  };
  const pushing = pushFile({ ...r.context, signal: halt.signal }, "pipeline.bin");
  const rejected = assert.rejects(pushing, error => error.code === "cancelled");
  try { assert.ok(await until(() => waiting)); }
  finally { halt.abort(); await rejected; }
  assert.equal(r.server.files.size, 1);
  assert.equal(r.state.fileByPath("pipeline.bin"), undefined);
});
