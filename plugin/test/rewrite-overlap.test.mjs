/** The typing device can see the peer's automatic answer first (native S89). */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { pauseId } = require("../build/sync/pause.js");
const c = require("../build/crypto.js");
const NOTE = "Notes/overlap.md", PEER = "ff".repeat(16);
const BASE = "stamp: base\n\nABCD\n\nend\n";
const OURS = "stamp: ours\n\nABCDEFGH\n\nend\n";

async function peer(r, text, parents, answer) {
  const bytes = new TextEncoder().encode(text);
  const { cid, sid, ciphertext } = await c.encryptChunk(r.keys.domainKey, bytes);
  r.server.chunks.set(sid, ciphertext);
  const manifest = { v: 1, path: NOTE, domain: r.context.domainId, size: bytes.length, mtime: r.host.clock,
    chunks: [{ sid, cid: c.hex(cid), len: bytes.length }], sha256: c.hex(await c.sha256(bytes)), deleted: false };
  if (answer) manifest.answer = true;
  return r.server.publishManifest({ fileId: r.base.fileId, manifest, sids: [sid], parents, deviceId: PEER,
    manifestKey: r.keys.manifestKey, bytes: bytes.length });
}

async function fork({ typed = true, answer = true, clean = false, pushed = true } = {}) {
  const r = await rig();
  r.host.seed(NOTE, BASE, r.host.clock - 60_000);
  r.base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, OURS, r.host.clock);
  if (pushed) await pushFile(r.context, NOTE);
  if (typed) r.host.inputAt.set(NOTE, r.host.clock);
  r.frame = await peer(r, clean ? BASE.replace("end", "remote end") : BASE.replace("stamp: base", "stamp: theirs"), [r.base.versionId], answer);
  return r;
}

test("an authenticated automatic answer holds a competing typed branch before replacing or copying it", async () => {
  const r = await fork();
  assert.equal(await applyChange(r.context, r.frame), "skipped");
  assert.equal(r.host.text(NOTE), OURS);
  assert.equal(r.host.files.size, 1);
  const held = { [r.base.fileId]: { path: NOTE, remote: true } };
  assert.deepEqual(r.state.data.paused, held);
  assert.deepEqual((await r.reload()).data.paused, held, "persist the editor's Resume role before returning");
  assert.equal(r.host.notices.length, 1);
  assert.match(r.host.notices[0], /while you were typing.*Sync now.*Resume/);
  assert.match(r.host.logs.find((line) => line.includes("reason=peer_rewrite_overlap")), /duration_ms=0 budget_ms=5000$/);
  const id = await pauseId(r.context, r.base.fileId);
  assert.equal(r.server.files.get(id).heads.length, 1);
  await applyChange(r.context, r.frame);
  assert.equal(r.host.notices.length, 1);
  assert.equal(r.server.files.get(id).versions.length, 1);
});

test("an automatic answer also holds an unpushed typed overlap before deferring it", async () => {
  const r = await fork({ pushed: false });
  assert.equal(await applyChange(r.context, r.frame), "skipped");
  assert.equal(r.host.text(NOTE), OURS);
  assert.deepEqual(r.state.data.paused, { [r.base.fileId]: { path: NOTE, remote: true } });
});

for (const [name, facts] of [
  ["a competing user edit has no automatic-answer flag", { answer: false }],
  ["a passive editor is not trusted typing", { typed: false }],
  ["an automatic answer that merges cleanly needs no hold", { clean: true }],
]) test(name, async () => {
  const r = await fork(facts);
  r.host.editors.set(NOTE, r.host.text(NOTE));
  await applyChange(r.context, r.frame);
  assert.deepEqual(r.state.data.paused, {});
  assert.ok(!r.host.notices.some((line) => line.startsWith("obsync paused")));
  if (facts.clean) {
    assert.equal(r.host.text(NOTE), OURS.replace("end", "remote end"));
    assert.equal(r.host.files.size, 1);
  }
});

test("parallel overlap detection announces one hold without duplicating notices", async () => {
  const r = await fork();
  await Promise.all([applyChange(r.context, r.frame), applyChange(r.context, r.frame)]);
  assert.equal(r.host.notices.length, 1);
  assert.equal(r.host.files.size, 1);
  assert.deepEqual(r.state.data.paused, { [r.base.fileId]: { path: NOTE, remote: true } });
});

for (const typed of [false, true]) test(`a received hold uses the target note's current answer proof (typing: ${typed})`, async () => {
  const r = await rig();
  r.host.seed(NOTE, BASE, r.host.clock - 60_000);
  r.base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, OURS, r.host.clock);
  await pushFile(r.context, NOTE);
  r.context.answering.set(r.base.fileId, { mtime: r.host.clock, arrived: r.host.clock - 1000 });
  if (typed) r.host.inputAt.set(NOTE, r.host.clock);
  const id = await pauseId(r.context, r.base.fileId);
  const manifest = { v: 3, kind: "pause", target: r.base.fileId, paused: true, path: NOTE,
    domain: r.context.domainId, size: 0, chunks: [], sha256: "", deleted: false };
  const frame = await r.server.publishManifest({ fileId: id, manifest, sids: [], parents: [], deviceId: PEER,
    manifestKey: r.keys.manifestKey, bytes: 0 });
  await applyChange(r.context, frame);
  const held = typed ? { path: NOTE, remote: true } : { path: NOTE };
  assert.deepEqual(r.state.data.paused, { [r.base.fileId]: held });
  assert.deepEqual((await r.reload()).data.paused, r.state.data.paused);
  assert.equal(r.host.text(NOTE), OURS);
  assert.equal(r.host.notices.length, 1);
  assert.equal(r.server.files.get(id).versions.length, 1, "classifying a received pause must not publish another control");
});

const { resumePaused, decryptRecordManifest } = require("../build/sync/pull.js");
const HELD = "stamp: held later\n\nABCDEFGH plus independent held text\n\nend\n";
async function heldFork() {
  const r = await fork();
  r.recorded = r.state.fileByPath(NOTE);
  r.host.seed(NOTE, HELD, r.host.clock + 1000);
  return r;
}

test("background Resume preserves its latest snapshot before adopting the single peer branch", async () => {
  const r = await heldFork();
  assert.equal(await resumePaused(r.context, r.base.fileId), "kept_beside");
  assert.equal(r.host.text(NOTE), BASE.replace("stamp: base", "stamp: theirs"));
  assert.equal(r.state.fileByPath(NOTE).versionId, r.frame.version_id);
  const copies = [...r.host.files.keys()].filter((path) => path !== NOTE);
  assert.equal(copies.length, 1);
  assert.equal(r.host.text(copies[0]), HELD);
  const id = r.state.fileByPath(copies[0]).fileId;
  const file = r.server.files.get(id);
  const texts = await Promise.all(file.versions.map(async (version) => {
    const manifest = await decryptRecordManifest(r.context, { ...version, file_id: id, domain_id: file.domain_id });
    const bytes = await Promise.all(manifest.chunks.map((chunk) => c.decryptChunk(r.keys.domainKey, c.unhex(chunk.cid), r.server.chunks.get(chunk.sid))));
    return new TextDecoder().decode(Buffer.concat(bytes));
  }));
  assert.deepEqual(new Set(texts), new Set([OURS, HELD]), "both the recorded and latest held bytes stay in history");
});

for (const mode of ["multiple", "own", "missing"]) test(`Resume does not select ${mode} competing heads as the one peer branch`, async () => {
  const r = await heldFork();
  const file = r.server.files.get(r.base.fileId);
  if (mode === "multiple") await peer(r, BASE.replace("stamp: base", "stamp: third"), [r.base.versionId], false);
  if (mode === "own") file.versions.find((v) => v.version_id === r.frame.version_id).device_id = r.context.deviceId;
  if (mode === "missing") file.versions = file.versions.filter((v) => v.version_id !== r.frame.version_id);
  await resumePaused(r.context, r.base.fileId);
  assert.equal(r.host.text(NOTE), OURS, "leave ambiguous or missing heads to ordinary reconciliation");
  assert.equal(r.state.fileByPath(NOTE).versionId, r.recorded.versionId);
});

for (const mode of ["deleted", "moved", "large"]) test(`the ${mode} peer head cannot replace the note during background Resume`, async () => {
  const r = await heldFork();
  const manifest = await decryptRecordManifest(r.context, r.frame);
  if (mode === "deleted") { manifest.deleted = true; manifest.chunks = []; manifest.size = 0; manifest.sha256 = ""; }
  if (mode === "moved") manifest.path = "Notes/elsewhere.md";
  if (mode === "large") {
    const bytes = new Uint8Array(8 * 1024 * 1024), tail = new Uint8Array([10]);
    const first = await c.encryptChunk(r.keys.domainKey, bytes), last = await c.encryptChunk(r.keys.domainKey, tail);
    for (const chunk of [first, last]) r.server.chunks.set(chunk.sid, chunk.ciphertext);
    manifest.chunks = [{ sid: first.sid, cid: c.hex(first.cid), len: bytes.length }, { sid: last.sid, cid: c.hex(last.cid), len: 1 }];
    manifest.size = bytes.length + 1;
    manifest.sha256 = c.hex(await c.sha256(Buffer.concat([bytes, tail])));
  }
  await r.server.publishManifest({ fileId: r.base.fileId, manifest, sids: manifest.chunks.map((ch) => ch.sid),
    parents: [r.frame.version_id], deviceId: PEER, manifestKey: r.keys.manifestKey, bytes: manifest.size });
  await assert.rejects(resumePaused(r.context, r.base.fileId), /resume_peer_shape/);
  assert.equal(r.host.text(NOTE), HELD);
  assert.equal(r.state.fileByPath(NOTE).versionId, r.recorded.versionId);
  assert.match(r.host.logs.at(-1), /decision=refused reason=resume_peer_shape.*budget_bytes=8388608/);
});

test("a save during peer-head download is kept in the main note", async () => {
  const r = await heldFork();
  const get = r.transport.getChunk.bind(r.transport);
  const changed = HELD + "saved while fetching peer\n";
  r.transport.getChunk = async (sid) => {
    if (r.frame.sids.includes(sid)) r.host.seed(NOTE, changed, r.host.clock + 2000);
    return get(sid);
  };
  assert.equal(await resumePaused(r.context, r.base.fileId), "saved_meanwhile");
  assert.equal(r.host.text(NOTE), changed);
  assert.equal(r.state.fileByPath(NOTE).versionId, r.recorded.versionId);
});

test("a hold cannot attribute another local file at the same name to its target", async () => {
  const r = await rig();
  r.host.seed(NOTE, BASE, r.host.clock - 60_000);
  const local = await pushFile(r.context, NOTE);
  r.context.arrivals.set(NOTE, r.host.clock - 1000);
  r.host.seed(NOTE, HELD, r.host.clock);
  const target = "cc".repeat(16), id = await pauseId(r.context, target);
  assert.notEqual(local.fileId, target);
  const manifest = { v: 3, kind: "pause", target, paused: true, path: NOTE,
    domain: r.context.domainId, size: 0, chunks: [], sha256: "", deleted: false };
  const frame = await r.server.publishManifest({ fileId: id, manifest, sids: [], parents: [], deviceId: PEER,
    manifestKey: r.keys.manifestKey, bytes: 0 });
  await applyChange(r.context, frame);
  assert.deepEqual(r.state.data.paused, { [target]: { path: NOTE, remote: true } });
  assert.equal(r.state.fileByPath(NOTE).fileId, local.fileId);
  assert.equal(r.host.text(NOTE), HELD);
});

// An ordinary typed same-line overlap must still wait for its own push to
// fork the file, not make a copy of a version which has not been published.
test("an unflagged overlap over an unpushed typed edit waits for its publication", async () => {
  const r = await fork({ answer: false, pushed: false });
  assert.equal(await applyChange(r.context, r.frame), "skipped");
  assert.equal(r.host.files.size, 1);
  assert.equal(r.host.text(NOTE), OURS);
  assert.deepEqual(r.state.data.paused, {});
  assert.ok(r.context.forked.has(r.base.fileId));
});
