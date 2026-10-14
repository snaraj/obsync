import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rig, KEYS, openPublishedManifest } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const c = require("../build/crypto.js");

async function fixture({ migrated = true, text = "recovered private bytes\n" } = {}) {
  const r = await rig(), bytes = c.utf8(text), fileId = "91".repeat(16), path = "Recovered/Note.md";
  const original = await r.server.publish({ fileId, path, bytes, mtime: 1000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId: KEYS.deviceId });
  const manifest = await openPublishedManifest(original, r.keys.manifestKey, r.context.generation);
  if (migrated) manifest.migration_origin = "92".repeat(16) + "93".repeat(32);
  const change = await r.server.publishManifest({ fileId, manifest, sids: original.sids, parents: [],
    deviceId: KEYS.deviceId, manifestKey: r.keys.manifestKey, bytes: bytes.length });
  return { ...r, path, bytes, original, change };
}

for (const text of ["recovered private bytes\n", ""]) test(`a coordinator reads its authenticated reseed into a blank vault (${text.length} bytes)`, async () => {
  const r = await fixture({ text });
  assert.equal(r.state.custody2().history, null, "reading a reseed must not require the old key");
  assert.equal(await applyChange(r.context, r.change), "applied", "an unheld reseed is incoming content, not an own echo");
  assert.deepEqual(await r.host.read(r.path), r.bytes, "recovery must deliver exact authenticated bytes");
  assert.equal(r.state.fileByPath(r.path).versionId, r.change.version_id);
  assert.equal(await applyChange(r.context, r.change), "echo", "the same held reseed remains an echo");
});

test("ordinary own writes and in-flight authored versions remain echoes", async () => {
  const ordinary = await fixture({ migrated: false });
  assert.equal(await applyChange(ordinary.context, ordinary.change), "echo", "a missing migration pointer grants no replay exception");
  assert.equal(await ordinary.host.stat(ordinary.path), null);
  const authored = await fixture(); authored.context.authored.add(authored.change.version_id);
  assert.equal(await applyChange(authored.context, authored.change), "echo", "an in-flight local publication stays an echo");
  assert.equal(await authored.host.stat(authored.path), null);
});

test("a coordinator restores an authenticated empty-folder seed and then treats its held version as an echo", async () => {
  const r = await rig(), path = "Recovered empty folder";
  const fileId = await c.folderFileId(r.keys.manifestKey, path);
  const manifest = { v: 2, kind: "directory", path, domain: r.context.domainId, size: 0, chunks: [], sha256: "", deleted: false,
    migration_origin: "92".repeat(16) + "93".repeat(32) };
  const change = await r.server.publishManifest({ fileId, manifest, sids: [], parents: [], deviceId: KEYS.deviceId,
    manifestKey: r.keys.manifestKey, bytes: 0 });
  assert.equal(await applyChange(r.context, change), "applied", "an unheld empty-folder seed must apply");
  assert.equal(r.state.folderByPath(path).versionId, change.version_id);
  assert.equal(await applyChange(r.context, change), "echo", "a held folder seed remains an echo");
});

test("a reseed outside the selection waits for widening and never falls back to the old key", async () => {
  const r = await fixture(); r.state.data.syncFolders = ["Selected"];
  assert.equal(await applyChange(r.context, r.change), "skipped");
  assert.equal(await r.host.stat(r.path), null, "excluded bytes must not be fetched into the vault");
  delete r.state.data.syncFolders;
  assert.equal(await applyChange(r.context, r.change), "applied", "scope expansion must deliver the coordinator's reseed");
  assert.deepEqual(await r.host.read(r.path), r.bytes);
});

test("a server cannot grant the reseed exception with a forged pointer or damaged ciphertext", async () => {
  for (const mutation of [
    change => { change.migration_origin = "92".repeat(48); },
    change => { const packet = c.unbase64(change.manifest_ct); packet[packet.length - 1] ^= 1; change.manifest_ct = c.base64(packet); },
  ]) {
    const r = await fixture({ migrated: false }); mutation(r.change);
    assert.notEqual(await applyChange(r.context, r.change), "applied", "only a current-key authenticated pointer admits a reseed");
    assert.equal(await r.host.stat(r.path), null); assert.equal(r.state.fileByPath(r.path), undefined);
  }
});

test("paused and departed notes keep their guards when the coordinator sees a reseed", async () => {
  for (const mode of ["paused", "departed"]) {
    const r = await fixture();
    r.state.data[mode][r.change.file_id] = { path: r.path, versionId: r.change.version_id, size: r.bytes.length };
    assert.equal(await applyChange(r.context, r.change), "skipped", `${mode} must still prevent apply`);
    assert.equal(await r.host.stat(r.path), null);
  }
});

// A receipt for an earlier version cannot suppress authenticated incoming content.
test("an older grave does not turn a different authenticated reseed into an echo", async () => {
  const r = await fixture();
  r.state.bury(r.change.file_id, { versionId: r.original.version_id, path: r.path, folder: false });
  assert.notEqual(r.original.version_id, r.change.version_id);
  assert.equal(await applyChange(r.context, r.change), "applied");
  assert.deepEqual(await r.host.read(r.path), r.bytes);
  assert.equal(r.state.fileByPath(r.path).versionId, r.change.version_id);
  assert.equal(r.state.data.graves[r.change.file_id], undefined);
});
