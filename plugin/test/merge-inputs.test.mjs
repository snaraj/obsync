import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { assembleMergeInputs } = require("../build/sync/pull.js");
const { CHUNK_MAX } = require("../build/chunker.js");
const { ApiError } = require("../build/transport.js");
const { encryptChunk, hex, sha256 } = require("../build/crypto.js");
const text = bytes => new TextDecoder().decode(bytes);

async function fixture() {
  const r = await rig();
  const manifests = [];
  for (const value of ["base", "peer", "mine"]) {
    const bytes = new TextEncoder().encode(value);
    const chunk = await encryptChunk(r.keys.domainKey, bytes);
    r.server.chunks.set(chunk.sid, chunk.ciphertext);
    manifests.push({v:1,path:"Notes/Typing.md",size:bytes.length,mtime:1000,
      domain:r.keys.domainId,chunks:[{sid:chunk.sid,cid:hex(chunk.cid),len:bytes.length}],
      sha256:hex(await sha256(bytes)),deleted:false});
  }
  return {...r, manifests};
}

for (const count of [2, 3]) test(`a merge reads ${count} authenticated inputs in one bounded request`, async () => {
  const r = await fixture(), asked = [], get = r.transport.getChunks.bind(r.transport);
  r.transport.getChunks = (...args) => { asked.push(args); return get(...args); };
  r.transport.getChunk = () => { throw Error("unexpected individual request"); };
  const manifests = r.manifests.slice(0, count);
  assert.deepEqual((await assembleMergeInputs(r.context, manifests)).map(text), ["base", "peer", "mine"].slice(0,count));
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0][0], manifests.map(m => m.chunks[0].sid));
  assert.equal(asked[0][1], undefined);
  assert.equal(asked[0][3], manifests.reduce((n,m) => n + m.size + 16, 0));
  assert.ok(r.host.logs.some(line => /^pull decision=merge_inputs_read sids=[23] budget_bytes=\d+ duration_ms=\d+$/.test(line)));
});

test("equal merge inputs share one fetched body but are verified against their own declarations", async () => {
  const r = await fixture(), asked = [], get = r.transport.getChunks.bind(r.transport);
  r.transport.getChunks = (...args) => { asked.push(args); return get(...args); };
  const input = [r.manifests[0], r.manifests[1], r.manifests[0]];
  assert.deepEqual((await assembleMergeInputs(r.context, input)).map(text), ["base", "peer", "base"]);
  assert.equal(asked[0][0].length, 2);
  assert.equal(asked[0][3], 40);
  await assert.rejects(assembleMergeInputs(r.context, [input[0], {...input[0], chunks:[{...input[0].chunks[0],len:3}]}]),
    error => error.reason === "chunk_len_actual");
});

for (const kind of ["empty", "one", "four", "multiple_chunks", "large", "outside_scope"]) test(`merge inputs refuse ${kind} before fetching`, async () => {
  const r = await fixture();
  let calls = 0;
  r.transport.getChunks = async () => { calls++; throw Error("unadmitted request"); };
  let inputs = r.manifests;
  if (kind === "empty") inputs = [];
  if (kind === "one") inputs = inputs.slice(0,1);
  if (kind === "four") inputs = [...inputs, inputs[0]];
  if (kind === "multiple_chunks") inputs[0] = {...inputs[0], chunks:[...inputs[0].chunks,...inputs[0].chunks]};
  if (kind === "large") inputs[0] = {...inputs[0], size:CHUNK_MAX+1};
  if (kind === "outside_scope") { r.state.data.syncFolders = ["Allowed"]; }
  await assert.rejects(assembleMergeInputs(r.context, inputs));
  assert.equal(calls,0);
  assert.equal(r.host.files.size,0);
});

for (const kind of ["missing", "ciphertext", "cid", "length"]) test(`a batch's ${kind} failure never becomes merge text`, async () => {
  const r = await fixture(), get = r.transport.getChunks.bind(r.transport);
  if (kind === "cid") r.manifests[0].chunks[0].cid = "ab".repeat(32);
  if (kind === "length") r.manifests[0].chunks[0].len--;
  r.transport.getChunks = async (...args) => {
    const bodies = await get(...args);
    if (kind === "missing") bodies[0] = null;
    if (kind === "ciphertext") { bodies[0] = bodies[0].slice(); bodies[0][0] ^= 1; }
    return bodies;
  };
  let singles = 0;
  r.transport.getChunk = () => { singles++; throw Error("invalid body retried"); };
  await assert.rejects(assembleMergeInputs(r.context, r.manifests), error => kind === "missing" ? error.code === "unknown_chunk" : kind === "length" ? error.reason === "chunk_len_actual" : error.name === "OperationError");
  assert.equal(singles,0);
  assert.equal(r.host.files.size,0);
});

for (const code of ["bad_multipart", "part_mismatch", "response_too_large", "batch_too_large", "not_found"]) test(`a ${code} endpoint falls back to verified individual reads`, async () => {
  const r = await fixture();
  r.transport.getChunks = async () => { throw new ApiError(code === "not_found" ? 404 : 413, code, "test refusal"); };
  assert.deepEqual((await assembleMergeInputs(r.context, r.manifests)).map(text), ["base", "peer", "mine"]);
  assert.ok(r.host.logs.some(line => line.includes(`decision=merge_inputs_refused reason=${code}`)));
});

for (const code of ["unreachable", "cancelled", "not_paired", "bad_signature", "replayed_nonce", "unknown_chunk", "not_found"]) test(`a ${code} merge batch starts no fallback requests`, async () => {
  const r = await fixture();
  r.transport.getChunks = async () => { throw new ApiError(0, code, "test stop"); };
  let singles = 0;
  r.transport.getChunk = () => { singles++; throw Error("unexpected retry"); };
  await assert.rejects(assembleMergeInputs(r.context,r.manifests), error => error.code === code);
  assert.equal(singles,0);
});

test("a stopped merge carries cancellation and discards a late batch answer", async () => {
  const r = await fixture(), get = r.transport.getChunks.bind(r.transport), controller = new AbortController();
  r.context.signal = controller.signal;
  r.transport.getChunks = async (...args) => {
    assert.equal(args[2].signal,controller.signal);
    const bodies = await get(...args);
    controller.abort();
    return bodies;
  };
  await assert.rejects(assembleMergeInputs(r.context,r.manifests), error => error.code === "cancelled");
  assert.equal(r.host.files.size,0);
});


test("an unexpected programming failure in the batch is propagated unchanged", async () => {
  const r = await fixture(), failure = new Error("fixture programming failure");
  r.transport.getChunks = async () => { throw failure; };
  let singles = 0;
  r.transport.getChunk = () => { singles++; throw Error("unexpected retry"); };
  await assert.rejects(assembleMergeInputs(r.context,r.manifests), error => error === failure);
  assert.equal(singles,0);
});
