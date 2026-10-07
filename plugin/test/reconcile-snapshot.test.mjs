import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { SyncEngine } = require("../build/sync/engine.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const NOTE = "Notes/Live.md";
const enc = text => new TextEncoder().encode(text);

async function fork() {
  const r = await rig();
  r.host.seed(NOTE, "A:\nB:\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "A: local\nB:\n", 2000);
  const local = await pushFile(r.context, NOTE);
  const incoming = await r.server.publish({ fileId: base.fileId, path: NOTE,
    bytes: enc("A:\nB: remote\n"), mtime: 3000, parents: [base.versionId],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const snapshot = await r.transport.getFile(base.fileId);
  let reads = 0;
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (...args) => { reads++; return getFile(...args); };
  return { ...r, base, local, incoming, snapshot, reads: () => reads };
}

test("push reconciliation uses its freshly read head snapshot once", async () => {
  const r = await fork();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host });
  engine.need = () => r.context;
  await engine.reconcileFile(r.base.fileId);
  assert.equal(r.host.text(NOTE), "A: local\nB: remote\n");
  assert.equal(r.reads(), 1, "the caller already fetched both heads and their ancestry");
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.ok(r.host.logs.some(line => line.includes("reason=head_snapshot_reused")));
});

test("a supplied current snapshot merges without another head request", async () => {
  const r = await fork();
  assert.equal(await applyChange(r.context, r.incoming, r.snapshot), "merged");
  assert.equal(r.host.text(NOTE), "A: local\nB: remote\n");
  assert.equal(r.reads(), 0);
});

for (const reason of ["file", "domain", "incoming_absent", "local_absent", "not_head"]) {
  test(`a reconciliation snapshot with ${reason} is not reusable`, async () => {
    const r = await fork(), snapshot = structuredClone(r.snapshot);
    if (reason === "file") snapshot.file_id = "ab".repeat(16);
    if (reason === "domain") snapshot.domain_id = "ab".repeat(16);
    if (reason === "incoming_absent") snapshot.versions = snapshot.versions.filter(v => v.version_id !== r.incoming.version_id);
    if (reason === "local_absent") snapshot.versions = snapshot.versions.filter(v => v.version_id !== r.local.versionId);
    if (reason === "not_head") snapshot.heads = [r.local.versionId];
    assert.equal(await applyChange(r.context, r.incoming, snapshot), "merged");
    assert.equal(r.host.text(NOTE), "A: local\nB: remote\n");
    assert.equal(r.reads(), 1, "unknown parents and unrelated snapshots need a fresh graph");
    assert.ok(!r.host.logs.some(line => line.includes("reason=head_snapshot_reused")));
  });
}

test("a peer advancing after the snapshot keeps its newer edit through the next merge", async () => {
  const r = await fork();
  const next = await r.server.publish({ fileId: r.base.fileId, path: NOTE,
    bytes: enc("A:\nB: remote newer\n"), mtime: 4000, parents: [r.incoming.version_id],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  assert.equal(await applyChange(r.context, r.incoming, r.snapshot), "merged");
  assert.equal(r.host.text(NOTE), "A: local\nB: remote\n");
  assert.equal(await applyChange(r.context, next), "merged");
  assert.equal(r.host.text(NOTE), "A: local\nB: remote newer\n");
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.deepEqual([...r.host.files.keys()], [NOTE]);
});

async function descendant() {
  const r = await rig();
  r.host.seed(NOTE, "A:\nB:\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "A: local\nB:\n", 2000);
  const incoming = await r.server.publish({ fileId: base.fileId, path: NOTE,
    bytes: enc("A:\nB: remote\n"), mtime: 3000, parents: [base.versionId],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const snapshot = await r.transport.getFile(base.fileId);
  let reads = 0;
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (...args) => { reads++; return getFile(...args); };
  return { ...r, base, incoming, snapshot, reads: () => reads };
}

test("a descendant over unpushed local input reuses the supplied graph", async () => {
  const r = await descendant();
  assert.equal(await applyChange(r.context, r.incoming, r.snapshot), "skipped");
  assert.equal(r.host.text(NOTE), "A: local\nB:\n");
  assert.equal(r.reads(), 0);
  assert.equal(r.context.forked.has(r.base.fileId), true);
  await pushFile(r.context, NOTE);
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host });
  engine.need = () => r.context;
  await engine.reconcileFile(r.base.fileId);
  assert.equal(r.host.text(NOTE), "A: local\nB: remote\n");
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.deepEqual([...r.host.files.keys()], [NOTE]);
});

for (const reason of ["file", "domain", "incoming_absent", "local_absent", "not_head"]) {
  test(`a descendant snapshot with ${reason} is fetched again`, async () => {
    const r = await descendant(), snapshot = structuredClone(r.snapshot);
    if (reason === "file") snapshot.file_id = "ab".repeat(16);
    if (reason === "domain") snapshot.domain_id = "ab".repeat(16);
    if (reason === "incoming_absent") snapshot.versions = snapshot.versions.filter(v => v.version_id !== r.incoming.version_id);
    if (reason === "local_absent") snapshot.versions = snapshot.versions.filter(v => v.version_id !== r.base.versionId);
    if (reason === "not_head") snapshot.heads = [r.base.versionId];
    assert.equal(await applyChange(r.context, r.incoming, snapshot), "skipped");
    assert.equal(r.host.text(NOTE), "A: local\nB:\n");
    assert.equal(r.reads(), 1);
    assert.ok(!r.host.logs.some(line => line.includes("reason=head_snapshot_reused")));
  });
}
