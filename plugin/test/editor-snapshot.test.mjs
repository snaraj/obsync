import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { pushFile } = require("../build/sync/push.js");
const { assembleBytes, decodeRecordManifest } = require("../build/sync/pull.js");
const path = "Notes/Snapshot.md";

async function fixture() {
  const r = await rig();
  r.host.seed(path, "BASE", 1000);
  const base = await pushFile(r.context, path);
  r.host.seed(path, "BASE first", 2000);
  r.host.typing = () => true;
  r.host.editorReady = async () => true;
  return { ...r, base };
}

test("a complete saved editor snapshot publishes while later typing stays dirty", async () => {
  const r = await fixture(), put = r.transport.putChunk.bind(r.transport);
  r.transport.putChunk = async (...args) => { await put(...args); r.host.seed(path, "BASE first second", 3000); };
  const pushed = await pushFile(r.context, path);
  assert.equal(pushed.status, "pushed");
  const file = await r.transport.getFile(r.base.fileId);
  const version = file.versions.find((v) => v.version_id === pushed.versionId);
  const manifest = await decodeRecordManifest(r.context, { ...version, file_id: file.file_id, domain_id: file.domain_id });
  assert.equal(new TextDecoder().decode(await assembleBytes(r.context, manifest)), "BASE first");
  assert.deepEqual(version.parents, [r.base.versionId]);
  assert.equal(r.host.text(path), "BASE first second");
  assert.equal(r.state.fileByPath(path).mtime, 2000);
  assert.equal((await r.reload()).fileByPath(path).mtime, 2000);
  r.transport.putChunk = put;
  const next = await pushFile(r.context, path);
  const after = await r.transport.getFile(r.base.fileId);
  assert.deepEqual(after.heads, [next.versionId]);
  assert.deepEqual(after.versions.find((v) => v.version_id === next.versionId).parents, [pushed.versionId]);
});

for (const reason of ["not_typing", "unsaved", "unrecorded", "changed_during_capture", "same_stat_different_bytes", "deleted"]) {
  test(`snapshot publication retains the growing-file refusal for ${reason}`, async () => {
    const r = await fixture();
    if (reason === "not_typing") r.host.typing = () => false;
    if (reason === "unsaved") r.host.editorReady = async () => false;
    if (reason === "unrecorded") r.state.forgetPath(path);
    if (reason === "changed_during_capture") {
      r.host.editorReady = async () => { r.host.seed(path, "CHANGED BEFORE CAPTURE", 2500); return true; };
    }
    if (reason === "same_stat_different_bytes") {
      r.host.editorReady = async () => { r.host.seed(path, "BASE other", 2000); return true; };
    }
    const put = r.transport.putChunk.bind(r.transport);
    r.transport.putChunk = async (...args) => {
      await put(...args);
      if (reason === "deleted") r.host.files.delete(path);
      else r.host.seed(path, "LATER SAVE", 3000);
    };
    const before = r.server.journal.length;
    assert.equal((await pushFile(r.context, path)).status, "growing");
    assert.equal(r.server.journal.length, before, "no version describes an unproven snapshot");
  });
}


test("publishing a previously confirmed snapshot does not wait for newer unsaved input", async () => {
  const r = await fixture(), put = r.transport.putChunk.bind(r.transport);
  r.host.editorReady = async () => false;
  r.host.savedSnapshot = (name, bytes) => name === path && new TextDecoder().decode(bytes) === "BASE first";
  r.transport.putChunk = async (...args) => { await put(...args); r.host.seed(path, "BASE first second", 3000); };
  const pushed = await pushFile(r.context, path);
  assert.equal(pushed.status, "pushed");
  assert.equal(r.state.fileByPath(path).mtime, 2000);
  assert.equal(r.host.text(path), "BASE first second");
  assert.deepEqual((await r.transport.getFile(r.base.fileId)).heads, [pushed.versionId]);
});
