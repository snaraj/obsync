/** #179: one copy with history, never an overwrite of an independent edit. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { pushFile, postManifest, sidDigest } = require("../build/sync/push.js");
const { resumePaused, decryptRecordManifest } = require("../build/sync/pull.js");
const { conflictFileId, decryptChunk, unhex } = require("../build/crypto.js");
const { CHUNK_MAX } = require("../build/chunker.js");
const NOTE = "Notes/held.md", COPY = "Notes/held (conflict from peer).md";
const BASE = "baseline\n", HELD = "baseline with later body edits\n";

async function prepared() {
  const r = await rig();
  r.host.seed(NOTE, BASE, 1000);
  r.note = await pushFile(r.context, NOTE);
  const source = r.server.files.get(r.note.fileId);
  const version = source.versions.find(entry => entry.version_id === r.note.versionId);
  r.baseline = await decryptRecordManifest(r.context, { ...version, file_id: r.note.fileId, domain_id: source.domain_id });
  r.copyId = await conflictFileId(r.keys.manifestKey, r.note.fileId, r.note.versionId);
  r.root = await postManifest(r.context, r.copyId, [], version.sids, { ...r.baseline, path: COPY }, version.bytes, true);
  r.host.seed(COPY, BASE, 1000);
  r.state.setFile(COPY, { fileId: r.copyId, versionId: r.root.versionId, mtime: 1000, size: BASE.length, sha256: await sidDigest(version.sids) });
  r.host.seed(NOTE, HELD, 2000);
  return r;
}

async function remote(r, text, parents = [r.root.versionId], options = {}) {
  return r.server.publish({ fileId: r.copyId, path: COPY, bytes: new TextEncoder().encode(text), mtime: 3000, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, ...options });
}
async function history(r) {
  const file = r.server.files.get(r.copyId), texts = [];
  for (const version of file.versions) {
    const manifest = await decryptRecordManifest(r.context, { ...version, file_id: r.copyId, domain_id: file.domain_id });
    const chunks = await Promise.all(manifest.chunks.map(async chunk => decryptChunk(r.keys.domainKey, unhex(chunk.cid), await r.transport.getChunk(chunk.sid))));
    texts.push(new TextDecoder().decode(Buffer.concat(chunks)));
  }
  return texts;
}

for (const alreadyHeld of [false, true]) test(`Resume advances one proven copy and retains older body text in history (retry: ${alreadyHeld})`, async () => {
  const r = await prepared();
  if (alreadyHeld) {
    const posted = await remote(r, HELD);
    r.host.seed(COPY, HELD, 3000);
    r.state.setFile(COPY, { ...r.state.fileByPath(COPY), versionId: posted.version_id, mtime: 3000, size: HELD.length, sha256: await sidDigest(posted.sids) });
  }
  assert.equal(await resumePaused(r.context, r.note.fileId), "kept_beside");
  assert.equal(r.host.text(NOTE), BASE);
  assert.equal(r.host.text(COPY), HELD);
  assert.equal(r.host.files.size, 2);
  const file = r.server.files.get(r.copyId);
  assert.equal(file.heads.length, 1);
  assert.deepEqual(file.versions.find(entry => entry.version_id === file.heads[0]).parents, [r.root.versionId]);
  assert.deepEqual(new Set(await history(r)), new Set([BASE, HELD]));
});

test("an unpublished same-metadata edit of the preserved copy refuses Resume", async () => {
  const r = await prepared();
  r.host.seed(COPY, "my edits\n", 1000); // same size and timestamp as BASE
  await assert.rejects(resumePaused(r.context, r.note.fileId), /resume_copy_local_edit/);
  assert.equal(r.host.text(COPY), "my edits\n");
  assert.equal(r.host.text(NOTE), HELD);
  assert.deepEqual(await history(r), [BASE]);
});

for (const state of ["empty", "split", "missing", "edited", "deleted", "moved"]) test(`a ${state} preserved-copy head refuses Resume without consuming it`, async () => {
  const r = await prepared();
  if (state === "split") { await remote(r, HELD, []); }
  if (state === "edited") await remote(r, "independent remote edit\n");
  if (state === "deleted") {
    const tombstone = await r.server.publishTombstone({ fileId: r.copyId, path: COPY, parents: [r.root.versionId], manifestKey: r.keys.manifestKey });
    assert.equal(tombstone.deleted, true, "the fixture must publish an actual tombstone");
  }
  if (state === "moved") await remote(r, BASE, undefined, { path: "Notes/elsewhere.md" });
  const get = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (id) => {
    const file = await get(id);
    if (id === r.copyId && state === "empty") return { ...file, heads: [] };
    if (id === r.copyId && state === "missing") return { ...file, heads: ["ef".repeat(32)] };
    return file;
  };
  const versions = r.server.files.get(r.copyId).versions.length;
  await assert.rejects(resumePaused(r.context, r.note.fileId), new RegExp("resume_copy_" + (["empty", "split"].includes(state) ? "heads" : state === "missing" ? "missing_head" : "remote_edit")));
  assert.equal(r.server.files.get(r.copyId).versions.length, versions);
  assert.equal(r.host.text(COPY), BASE);
  assert.equal(r.host.text(NOTE), HELD);
});

for (const shape of ["missing", "large", "identity"]) test(`a ${shape} local preserved copy is not overwritten by Resume`, async () => {
  const r = await prepared();
  if (shape === "missing") r.host.files.delete(COPY);
  if (shape === "large") {
    const stat = r.host.stat.bind(r.host), read = r.host.read.bind(r.host);
    r.host.stat = async path => path === COPY ? { ...await stat(path), size: CHUNK_MAX + 1 } : stat(path);
    r.host.read = async path => { assert.notEqual(path, COPY, "oversize copy must not be read"); return read(path); };
  }
  if (shape === "identity") {
    const get = r.state.fileByPath.bind(r.state);
    const replacement = { ...get(COPY), fileId: "ed".repeat(16) };
    r.state.fileByPath = path => path === COPY ? replacement : get(path);
  }
  await assert.rejects(resumePaused(r.context, r.note.fileId), /resume_copy_(identity|local_budget)/);
  assert.equal(r.host.text(NOTE), HELD);
  assert.equal(r.host.text(COPY), shape === "missing" ? null : BASE);
  assert.ok(r.host.logs.some(line => line.includes(`decision=refused reason=resume_copy_${shape === "identity" ? "identity" : "local_budget"}`)), "the refusal has a specific structured diagnostic");
});

for (const race of ["metadata", "same_metadata", "identity"]) test(`a ${race} save during copy preparation leaves both notes intact`, async () => {
  const r = await prepared(), make = r.host.writer.bind(r.host);
  r.host.writer = async path => {
    const writer = await make(path), write = writer.write.bind(writer);
    if (path === COPY) writer.write = async bytes => {
      await write(bytes);
      if (race === "identity") r.state.setFile(COPY, { ...r.state.fileByPath(COPY), versionId: "aa".repeat(32) });
      else r.host.seed(COPY, race === "metadata" ? BASE : "my edits\n", race === "metadata" ? 9000 : 1000);
    };
    return writer;
  };
  await assert.rejects(resumePaused(r.context, r.note.fileId), /resume_copy_saved_meanwhile/);
  assert.equal(r.host.text(COPY), race !== "same_metadata" ? BASE : "my edits\n");
  assert.equal(r.host.text(NOTE), HELD);
  assert.deepEqual(await history(r), [BASE]);
});

test("an independent head racing the copy publication is retained and leaves the note held", async () => {
  const r = await prepared(), post = r.transport.postVersion.bind(r.transport);
  r.transport.postVersion = async (id, body) => {
    if (id === r.copyId) await remote(r, "racing remote copy edit\n");
    return post(id, body);
  };
  await assert.rejects(resumePaused(r.context, r.note.fileId), /resume_copy_publication/);
  assert.equal(r.host.text(NOTE), HELD);
  assert.equal(r.server.files.get(r.copyId).heads.length, 2);
  assert.deepEqual(new Set(await history(r)), new Set([BASE, HELD, "racing remote copy edit\n"]));
});

test("a growing copy whose last recorded bytes already equal the held snapshot refuses Resume", async () => {
  const r = await prepared(), posted = await remote(r, HELD);
  r.host.seed(COPY, HELD, 3000);
  r.state.setFile(COPY, { ...r.state.fileByPath(COPY), versionId: posted.version_id, mtime: 3000, size: HELD.length, sha256: await sidDigest(posted.sids) });
  const make = r.host.writer.bind(r.host), missing = r.transport.missingChunks.bind(r.transport);
  r.host.writer = async path => {
    const writer = await make(path), commit = writer.commit.bind(writer);
    if (path === COPY) writer.commit = async (...args) => {
      const result = await commit(...args);
      r.host.seed(COPY, "an edit just after copy commit\n", 9000);
      return result;
    };
    return writer;
  };
  r.transport.missingChunks = async (...args) => {
    r.host.seed(COPY, "a copy still growing during upload\n", 10000);
    return missing(...args);
  };
  await assert.rejects(resumePaused(r.context, r.note.fileId), /resume_copy_publication/);
  assert.equal(r.host.text(NOTE), HELD);
  assert.equal(r.host.text(COPY), "a copy still growing during upload\n");
});

test("a copy removed during publication does not authorize replacing the held note", async () => {
  const r = await prepared(), post = r.transport.postVersion.bind(r.transport);
  r.transport.postVersion = async (id, body) => {
    const result = await post(id, body);
    if (id === r.copyId) { r.host.files.delete(COPY); r.state.forgetPath(COPY); }
    return result;
  };
  await assert.rejects(resumePaused(r.context, r.note.fileId), /resume_copy_publication/);
  assert.equal(r.host.text(NOTE), HELD);
  assert.equal(r.host.text(COPY), null);
  assert.ok((await history(r)).includes(HELD), "acknowledged held bytes remain in server history");
});


test("Resume selects the copy parent after its older upload has acknowledged", async () => {
  const r = await prepared(), post = r.transport.postVersion.bind(r.transport);
  r.host.seed(COPY, HELD, 3000);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  r.transport.postVersion = async (...args) => { entered(); await gate; return post(...args); };
  const older = pushFile(r.context, COPY);
  await started;
  const resuming = resumePaused(r.context, r.note.fileId);
  await new Promise(setImmediate);
  release(); await older;
  assert.equal(await resuming, "kept_beside");
  assert.equal(r.server.files.get(r.copyId).heads.length, 1);
  assert.equal(r.server.files.get(r.copyId).versions.length, 2);
  assert.equal(r.host.text(COPY), HELD);
});
