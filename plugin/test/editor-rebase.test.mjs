import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange, assembleBytes, decodeRecordManifest } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const enc = (s) => new TextEncoder().encode(s);
const path = "Notes/Typing.md";
const base = "A: \nB: \n";
const published = "A: one\nB: \n";
const latest = "A: one two\nB: \n";
const remote = "A: \nB: remote\n";

async function fixture() {
  const r = await rig();
  r.host.seed(path, base, 1000);
  const first = await pushFile(r.context, path);
  r.host.seed(path, published, 2000);
  const own = await pushFile(r.context, path);
  const incoming = await r.server.publish({ fileId: first.fileId, path, bytes: enc(remote), mtime: 3000,
    parents: [first.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  r.host.typing = (p) => p === path;
  r.host.editorReady = async () => true;
  const queued = [];
  r.context.queueLocal = (p) => queued.push(p);
  return { ...r, own, incoming, queued };
}

async function stored(r, id) {
  const file = await r.transport.getFile(r.own.fileId);
  const version = file.versions.find((v) => v.version_id === id);
  const manifest = await decodeRecordManifest(r.context, { ...version, file_id: file.file_id, domain_id: file.domain_id });
  return { version, manifest, text: new TextDecoder().decode(await assembleBytes(r.context, manifest)) };
}

test("newer saved typing stays local until published as a child of the acknowledged merge", async () => {
  const r = await fixture();
  r.host.seed(path, latest, 4000);
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(path), "A: one two\nB: remote\n");
  const record = r.state.fileByPath(path), merge = await stored(r, record.versionId);
  assert.equal(merge.text, "A: one\nB: remote\n", "unpublished typing is not silently attached to older parents");
  assert.deepEqual([...merge.version.parents].sort(), [r.own.versionId, r.incoming.version_id].sort());
  assert.ok(merge.manifest.mtime >= 0, "local dirty sentinel never enters the remote manifest");
  assert.equal(record.mtime, -1);
  assert.equal((await r.reload()).fileByPath(path).mtime, -1, "restart retains the pending local work");
  assert.deepEqual(r.queued, [path]);
  const pushed = await pushFile(r.context, path);
  const next = await stored(r, pushed.versionId);
  assert.deepEqual(next.version.parents, [record.versionId]);
  assert.equal(next.text, "A: one two\nB: remote\n");
  assert.equal((await r.transport.getFile(r.own.fileId)).heads.length, 1);
  assert.deepEqual([...r.host.files.keys()].filter((p) => p.includes("conflict")), []);
});

test("a save during download is rebased at commit instead of restarting network preparation", async () => {
  const r = await fixture(), get = r.transport.getChunk.bind(r.transport);
  r.transport.getChunk = async (...args) => { const bytes = await get(...args); r.host.seed(path, latest, 4000); return bytes; };
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(path), "A: one two\nB: remote\n");
  assert.deepEqual(r.queued, [path]);
});

test("merge preparation owns its publication turn while a newer save waits to upload", async () => {
  const r = await fixture();
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const get = r.transport.getChunk.bind(r.transport);
  r.transport.getChunk = async (...args) => { enter(); await gate; return get(...args); };
  const applying = applyChange(r.context, r.incoming);
  await entered;
  r.host.seed(path, latest, 4000);
  const uploading = pushFile(r.context, path);
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(r.state.fileByPath(path).versionId, r.own.versionId);
  } finally { release(); }
  assert.equal(await applying, "merged");
  const pushed = await uploading;
  const next = await stored(r, pushed.versionId);
  assert.equal(next.text, "A: one two\nB: remote\n");
  assert.deepEqual((await r.transport.getFile(r.own.fileId)).heads, [pushed.versionId]);
  const merge = await stored(r, next.version.parents[0]);
  assert.equal(merge.text, "A: one\nB: remote\n");
});

for (const reason of ["unsaved", "changed_during_stage", "parent_advanced"]) test(`editor rebase refuses ${reason} without replacing local bytes`, async () => {
  const r = await fixture();
  r.host.seed(path, latest, 4000);
  if (reason === "unsaved") {
    let checks = 0;
    r.host.editorReady = async () => ++checks === 1;
  }
  else {
    const original = r.host.writer.bind(r.host);
    r.host.writer = async (...args) => {
      const writer = await original(...args);
      return { ...writer, write: async (bytes) => {
        await writer.write(bytes);
        if (reason === "changed_during_stage") r.host.seed(path, "NEWER LOCAL", 5000);
        else r.state.setFile(path, { ...r.state.fileByPath(path), versionId: "ab".repeat(32) });
      } };
    };
  }
  await assert.rejects(applyChange(r.context, r.incoming), (e) => e.reason === "active_editor");
  assert.equal(r.host.text(path), reason === "changed_during_stage" ? "NEWER LOCAL" : latest);
  assert.deepEqual(r.queued, []);
});

test("stopping sync while staging an editor merge leaves the note and parents unchanged", async () => {
  const r = await fixture(), controller = new AbortController();
  r.context.signal = controller.signal;
  r.host.seed(path, latest, 4000);
  const original = r.host.writer.bind(r.host);
  r.host.writer = async (...args) => {
    const writer = await original(...args);
    return { ...writer, write: async (bytes) => { await writer.write(bytes); controller.abort(); } };
  };
  await assert.rejects(applyChange(r.context, r.incoming), (error) => error.code === "cancelled");
  assert.equal(r.host.text(path), latest);
  assert.equal(r.state.fileByPath(path).versionId, r.own.versionId);
  assert.deepEqual(r.queued, []);
});

test("a failed merge publication keeps both edits and can recover after state reload", async () => {
  const r = await fixture();
  r.host.seed(path, latest, 4000);
  const post = r.transport.postVersion.bind(r.transport);
  r.transport.postVersion = async () => { throw Error("synthetic unavailable"); };
  await assert.rejects(applyChange(r.context, r.incoming), /synthetic unavailable/);
  assert.equal(r.host.text(path), "A: one two\nB: remote\n");
  assert.equal(r.state.fileByPath(path).versionId, r.own.versionId, "no unacknowledged head is recorded");
  r.transport.postVersion = post;
  r.context.state = await r.reload();
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(path), "A: one two\nB: remote\n");
  const pushed = await pushFile(r.context, path);
  const file = await r.transport.getFile(r.own.fileId);
  assert.deepEqual(file.heads, [pushed.versionId]);
  assert.equal((await stored(r, pushed.versionId)).text, "A: one two\nB: remote\n");
});

test("a newer local save made while the merge is acknowledged stays dirty", async () => {
  const r = await fixture();
  r.host.seed(path, latest, 4000);
  const post = r.transport.postVersion.bind(r.transport);
  r.transport.postVersion = async (...args) => {
    r.host.seed(path, "A: one two three\nB: remote\n", 5000);
    return post(...args);
  };
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(path), "A: one two three\nB: remote\n");
  assert.notEqual(r.state.fileByPath(path).mtime, (await r.host.stat(path)).mtime);
  assert.deepEqual(r.queued, [path]);
});


test("authenticated merge preparation can run beside input when an earlier complete snapshot is proven", async () => {
  const r = await fixture(), get = r.transport.getChunk.bind(r.transport);
  r.host.seed(path, latest, 4000);
  let saved = false;
  r.host.editorReady = async () => saved;
  r.host.savedSnapshot = (name, bytes) => name === path && new TextDecoder().decode(bytes) === latest;
  r.transport.getChunk = async (...args) => { const bytes = await get(...args); saved = true; return bytes; };
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(path), "A: one two\nB: remote\n");
  assert.deepEqual(r.queued, [path]);
});

for (const completed of [true, false]) test(`network preparation uses authenticated parents while a native save ${completed ? "completes" : "remains pending"}`, async () => {
  const r = await fixture(), get = r.transport.getChunk.bind(r.transport);
  r.host.seed(path, latest, 4000);
  let ready = false, reads = 0;
  r.host.editorReady = async () => ready;
  r.host.savedSnapshot = () => false;
  r.transport.getChunk = async (...args) => {
    const bytes = await get(...args);
    reads++;
    ready = completed;
    return bytes;
  };
  if (completed) {
    assert.equal(await applyChange(r.context, r.incoming), "merged");
    assert.equal(r.host.text(path), "A: one two\nB: remote\n");
    assert.deepEqual(r.queued, [path]);
    const record = r.state.fileByPath(path), merge = await stored(r, record.versionId);
    assert.equal(merge.text, "A: one\nB: remote\n");
    assert.deepEqual([...merge.version.parents].sort(), [r.own.versionId, r.incoming.version_id].sort());
  } else {
    assert.equal(await applyChange(r.context, r.incoming), "skipped");
    assert.equal(r.host.text(path), latest);
    assert.equal(r.state.fileByPath(path).versionId, r.own.versionId);
    assert.deepEqual(r.queued, []);
  }
  assert.ok(reads > 0, "authenticated inputs were prepared even without a local save receipt");
  assert.deepEqual([...r.host.files.keys()].filter(name => name.includes("conflict")), []);
});
