import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { ApiError } = require("../build/transport.js");
const NOTE = "Notes/Typing.md";

async function windowedFork(length = 12, older = 0) {
  const r = await rig();
  const history = [];
  for (let i = 0; i < older; i++) {
    r.host.seed(NOTE, `Older note ${i}`, 100 + i);
    history.push((await pushFile(r.context, NOTE)).versionId);
  }
  r.host.seed(NOTE, "Shared: START|", 1000);
  const base = await pushFile(r.context, NOTE);
  for (let i = 1; i <= length; i++) {
    r.host.seed(NOTE, "Shared: START|" + "A".repeat(i), 1000 + i);
    await pushFile(r.context, NOTE);
  }
  let incoming, parent = base.versionId;
  for (let i = 1; i <= length; i++) {
    incoming = await r.server.publish({ fileId: base.fileId, path: NOTE,
      bytes: new TextEncoder().encode("Shared: START|" + "a".repeat(i)), mtime: 2000 + i,
      parents: [parent], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
    parent = incoming.version_id;
  }
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async id => {
    const file = await getFile(id);
    return { ...file, versions: file.versions.filter((v, i) => i < 10 || file.heads.includes(v.version_id)) };
  };
  const reads = [], getVersion = r.transport.getVersion.bind(r.transport);
  r.transport.getVersion = async (file, version) => { reads.push(version); return getVersion(file, version); };
  return { ...r, base, incoming, reads, history };
}

test("typing merges after its common base leaves the ten-version listing", async () => {
  const r = await windowedFork();
  const listing = await r.transport.getFile(r.base.fileId);
  assert.ok(!listing.versions.some(v => v.version_id === r.base.versionId));
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Shared: START|" + "A".repeat(12) + "a".repeat(12));
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.equal([...r.host.files.keys()].filter(p => p.includes("(conflict")).length, 0);
  assert.ok(r.reads.includes(r.base.versionId));
  assert.equal(new Set(r.reads).size, r.reads.length);
  assert.ok(r.host.logs.some(line => line.includes("reason=merge_ancestry")));
});

test("a retained ancestor read failure is retried without publishing a conflict", async () => {
  const r = await windowedFork();
  r.transport.getVersion = async () => { throw new ApiError(503, "unavailable", "synthetic outage"); };
  await assert.rejects(applyChange(r.context, r.incoming), e => e.status === 503);
  assert.equal([...r.host.files.keys()].filter(p => p.includes("(conflict")).length, 0);
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 2);
});

test("an ancestor response cannot substitute a different version", async () => {
  const r = await windowedFork();
  const getVersion = r.transport.getVersion.bind(r.transport);
  let replies = 0;
  r.transport.getVersion = async (...args) => {
    if (++replies > 65) throw new Error("ancestor response loop");
    return { ...await getVersion(...args), version_id: "00".repeat(32) };
  };
  await assert.rejects(applyChange(r.context, r.incoming), e => e.code === "invalid_ancestry");
  assert.equal([...r.host.files.keys()].filter(p => p.includes("(conflict")).length, 0);
});

for (const [name, parents] of [["non-array", null], ["too many", Array(65).fill("00".repeat(32))],
  ["malformed", ["not-an-id"]], ["non-string", [17]], ["array-shaped", [Array(64).fill("a")]]]) {
  test(`an ancestor response rejects ${name} parents`, async () => {
    const r = await windowedFork();
    const getVersion = r.transport.getVersion.bind(r.transport);
    r.transport.getVersion = async (...args) => ({ ...await getVersion(...args), parents });
    await assert.rejects(applyChange(r.context, r.incoming), e => e.code === "invalid_ancestry");
    assert.equal([...r.host.files.keys()].filter(p => p.includes("(conflict")).length, 0);
  });
}

test("ancestry traversal stops at the shared frontier instead of reading older history", async () => {
  const r = await windowedFork(12, 20);
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.ok(r.reads.includes(r.base.versionId));
  assert.ok(!r.reads.some(id => r.history.includes(id)));
  assert.equal(r.host.text(NOTE), "Shared: START|" + "A".repeat(12) + "a".repeat(12));
});

test("missing historical ancestors keep both edits instead of guessing a base", async () => {
  const r = await windowedFork();
  r.transport.getVersion = async () => { throw new ApiError(404, "unknown_version", "synthetic retention"); };
  await applyChange(r.context, r.incoming);
  assert.ok([...r.host.files.keys()].some(p => p.includes("(conflict")));
  assert.ok(r.host.logs.some(line => line.includes("reason=merge_ancestor")));
});

test("ancestry reads stop at the fixed budget on a long private branch", async () => {
  const r = await windowedFork(80);
  await applyChange(r.context, r.incoming);
  assert.equal(r.reads.length, 64);
  assert.ok(r.host.logs.some(line => line.includes("reason=merge_ancestry_limit")));
  assert.ok([...r.host.files.keys()].some(p => p.includes("(conflict")));
});

test("a long live feed retains own echoes and superseded peer edits for the final merge", async () => {
  const r = await windowedFork(80);
  const original = r.host.text(NOTE);
  const frames = [...r.server.journal];
  const own = frames.filter(frame => frame.device_id === r.context.deviceId);
  const peers = frames.filter(frame => frame.device_id !== r.context.deviceId && frame.version_id !== r.incoming.version_id);
  assert.equal(own.length, 81);
  assert.equal(peers.length, 79);
  for (const frame of own) assert.equal(await applyChange(r.context, frame), "echo");
  for (const frame of peers) assert.equal(await applyChange(r.context, frame), "skipped");
  assert.equal(r.host.text(NOTE), original, "caching feed history must not apply obsolete edits");
  assert.equal(r.host.files.size, 1);
  assert.equal(r.reads.length, 0);
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Shared: START|" + "A".repeat(80) + "a".repeat(80));
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.equal(r.host.files.size, 1, "ordinary live history must not displace typing into copies");
  assert.equal(r.reads.length, 0, "already received ancestry needs no historical requests");
  assert.match(r.host.logs.find(line => line.includes("reason=merge_ancestry ")) ?? "", /reads=0 recalled=[1-9]\d* held_chars=\d+ budget_reads=64 budget_chars=8388608 duration_ms=\d+$/);
  assert.ok(!r.host.logs.some(line => line.includes("reason=merge_ancestry_limit")));
});

test("a served page skips superseded tracked edits without native disk or head reads", async () => {
  const r = await windowedFork(80);
  const page = await r.transport.changes(0, 0, 1000);
  const peers = page.changes.filter(frame => frame.device_id !== r.context.deviceId && frame.version_id !== r.incoming.version_id);
  assert.equal(peers.length, 79);
  const original = r.host.text(NOTE), stat = r.host.stat, nested = r.host.inNestedVault, getFile = r.transport.getFile;
  r.host.stat = r.host.inNestedVault = r.transport.getFile = async () => { throw Error("obsolete frame issued external work"); };
  for (const frame of peers) assert.equal(await applyChange(r.context, frame), "skipped");
  assert.equal(r.host.text(NOTE), original);
  assert.equal(r.host.files.size, 1);
  r.host.stat = stat; r.host.inNestedVault = nested; r.transport.getFile = getFile;
  for (const frame of page.changes.filter(frame => frame.device_id === r.context.deviceId)) {
    assert.equal(await applyChange(r.context, frame), "echo");
  }
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Shared: START|" + "A".repeat(80) + "a".repeat(80));
  assert.equal(r.reads.length, 0);
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
});

test("cached peer ancestry skips an obsolete page after our head advances", async () => {
  const r = await windowedFork(80);
  const page = await r.transport.changes(0, 0, 1000);
  for (const frame of page.changes.filter(frame => frame.device_id === r.context.deviceId)) {
    assert.equal(await applyChange(r.context, frame), "echo");
  }
  r.host.seed(NOTE, "Shared: START|" + "A".repeat(81), 4000);
  await pushFile(r.context, NOTE);
  const peers = page.changes.filter(frame => frame.device_id !== r.context.deviceId && frame.version_id !== r.incoming.version_id);
  assert.ok(peers.every(frame => !frame.heads.includes(r.state.fileByPath(NOTE).versionId)));
  const stat = r.host.stat, nested = r.host.inNestedVault, getFile = r.transport.getFile;
  r.host.stat = r.host.inNestedVault = r.transport.getFile = async () => { throw Error("obsolete advanced-head frame issued external work"); };
  for (const frame of peers) assert.equal(await applyChange(r.context, frame), "skipped");
  r.host.stat = stat; r.host.inNestedVault = nested; r.transport.getFile = getFile;
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Shared: START|" + "A".repeat(81) + "a".repeat(80));
  assert.equal(r.host.files.size, 1);
  assert.equal(r.reads.length, 0);
});

test("cached ancestry visits repeated edges once during obsolete-page classification", async () => {
  const r = await windowedFork(80);
  const page = await r.transport.changes(0, 0, 1000);
  let traversals = 0;
  for (const frame of page.changes) {
    frame.parents = new Proxy([...frame.parents, ...frame.parents], {
      get(target, key, receiver) {
        if (key === Symbol.iterator && ++traversals > 200) throw Error("cached ancestry repeated edge work");
        return Reflect.get(target, key, receiver);
      },
    });
    r.context.authored.add(frame.version_id);
    assert.equal(await applyChange(r.context, frame), "echo");
  }
  r.host.seed(NOTE, "Shared: START|" + "A".repeat(81), 4000);
  await pushFile(r.context, NOTE);
  const cached = page.changes.filter(frame => frame.device_id !== r.context.deviceId).at(-2);
  const frame = { ...cached, parents: cached.parents.slice(0, cached.parents.length / 2) };
  traversals = 0;
  r.host.inNestedVault = async () => { throw Error("obsolete advanced-head frame issued external work"); };
  assert.equal(await applyChange(r.context, frame), "skipped");
  assert.ok(traversals > 0 && traversals <= 81);
});

for (const reason of ["linear", "missing", "budget", "empty_held", "empty_heads", "current_head"]) {
  test(`cached ancestry cannot bypass validation with ${reason} evidence`, async () => {
    const r = await windowedFork(reason === "budget" ? 513 : 2);
    const page = await r.transport.changes(0, 0, 2000);
    const original = r.state.fileByPath(NOTE);
    // Populate history as echoes, without applying peer bytes or disk work.
    for (const frame of page.changes) {
      if (reason === "missing" && frame.version_id === r.base.versionId) continue;
      r.context.authored.add(frame.version_id);
      assert.equal(await applyChange(r.context, frame), "echo");
    }
    r.state.setFile(NOTE, { ...original, versionId: reason === "linear" ? r.base.versionId
      : reason === "empty_held" ? "" : original.versionId });
    const heads = reason === "empty_heads" ? [] : reason === "current_head"
      ? [r.incoming.version_id] : ["ab".repeat(32)];
    r.host.inNestedVault = async () => { throw Error("native path validation reached"); };
    await assert.rejects(applyChange(r.context, { ...r.incoming, heads }), /native path validation reached/);
  });
}

for (const kind of ["folder", "deletion", "answer", "move", "current_head", "unknown_heads", "older_local"]) {
  test(`the obsolete-edit shortcut retains native validation for ${kind}`, async () => {
    const r = await windowedFork(2);
    const { decodeRecordManifest } = require("../build/sync/pull.js");
    const manifest = await decodeRecordManifest(r.context, r.incoming);
    if (kind === "folder") Object.assign(manifest, { v: 2, kind: "directory", size: 0, chunks: [], sha256: "" });
    if (kind === "deletion") Object.assign(manifest, { deleted: true, size: 0, chunks: [], sha256: "" });
    if (kind === "answer") manifest.answer = true;
    if (kind === "move") manifest.path = "Notes/Moved.md";
    const frame = await r.server.publishManifest({ fileId: r.base.fileId, manifest,
      sids: manifest.chunks.map(chunk => chunk.sid), bytes: manifest.size,
      parents: [r.incoming.version_id], manifestKey: r.keys.manifestKey,
      deviceId: "ff".repeat(16) });
    const local = r.state.fileByPath(NOTE).versionId;
    // The page may carry obsolete frames, current heads or no head evidence.
    const heads = kind === "current_head" ? [local, frame.version_id]
      : kind === "unknown_heads" ? [] : kind === "older_local" ? ["ab".repeat(16)] : [local];
    r.host.inNestedVault = async () => { throw Error("native path validation reached"); };
    await assert.rejects(applyChange(r.context, { ...frame, heads }), /native path validation reached/);
  });
}

test("repeated ancestry edges are traversed once, including a hostile cycle", async () => {
  const r = await windowedFork();
  const getFile = r.transport.getFile.bind(r.transport);
  const local = r.state.fileByPath(NOTE).versionId;
  let traversals = 0;
  r.transport.getFile = async (...args) => {
    const file = await getFile(...args);
    const head = file.versions.find(v => v.version_id === local);
    head.parents = new Proxy([local, ...head.parents], {
      get(target, key, receiver) {
        if (key === "map") return fn => {
          if (++traversals > 128) throw new Error("ancestry traversal loop");
          return target.map(fn);
        };
        return Reflect.get(target, key, receiver);
      },
    });
    return file;
  };
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.ok(traversals <= 64);
});

async function crossedWindow(length = 1) {
  const r = await rig();
  r.host.seed(NOTE, "Shared: START|", 1000);
  const first = await pushFile(r.context, NOTE);
  let clock = 2000;
  const publish = (text, parents) => r.server.publish({ fileId: first.fileId, path: NOTE,
    bytes: new TextEncoder().encode(text), mtime: clock++, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const base = await publish("Shared: START|X", [first.versionId]);
  let a = base, b = base;
  for (let i = 0; i < length; i++) {
    a = await publish("Shared: START|XL", [a.version_id]);
    b = await publish("Shared: START|XR", [b.version_id]);
  }
  const left = await publish("Shared: START|XL", [a.version_id, first.versionId]);
  const right = await publish("Shared: START|XR", [b.version_id, first.versionId]);
  const { sidDigest } = require("../build/sync/push.js");
  const bytes = r.host.seed(NOTE, "Shared: START|XL", clock);
  r.state.setFile(NOTE, { fileId: first.fileId, versionId: left.version_id,
    mtime: clock, size: bytes.length, sha256: await sidDigest(left.sids) });
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (...args) => {
    const file = await getFile(...args);
    return { ...file, versions: file.versions.filter(v => file.heads.includes(v.version_id)) };
  };
  return { ...r, first, base, left, right };
}

test("a fetched child precedes its already-fetched parent when choosing the merge base", async () => {
  const r = await crossedWindow();
  assert.equal(await applyChange(r.context, r.right), "merged");
  assert.equal(r.host.text(NOTE), "Shared: START|XLR");
  assert.equal([...r.host.files.keys()].filter(p => p.includes("(conflict")).length, 0);
});

test("a partial ancestry graph is discarded when its newer common base is unavailable", async () => {
  const r = await crossedWindow();
  const getVersion = r.transport.getVersion.bind(r.transport);
  r.transport.getVersion = async (file, id) => {
    if (id === r.base.version_id) throw new ApiError(404, "unknown_version", "synthetic retention");
    return getVersion(file, id);
  };
  assert.notEqual(await applyChange(r.context, r.right), "merged");
  assert.ok([...r.host.files.keys()].some(p => p.includes("(conflict")));
});

test("a criss-cross merge loads the shared pair's omitted ancestor", async () => {
  const r = await rig();
  const lines = (one, five) => `${one}\ntwo\nthree\nfour\n${five}\n`;
  r.host.seed(NOTE, lines("one", "five"), 1000);
  const base = await pushFile(r.context, NOTE);
  let clock = 2000;
  const publish = (text, parents) => r.server.publish({ fileId: base.fileId, path: NOTE,
    bytes: new TextEncoder().encode(text), mtime: clock++, parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const a = await publish(lines("ONE", "five"), [base.versionId]);
  const b = await publish(lines("one", "FIVE"), [base.versionId]);
  const left = await publish(lines("a ONE", "FIVE"), [a.version_id, b.version_id]);
  const right = await publish(lines("ONE", "b FIVE"), [a.version_id, b.version_id]);
  const { sidDigest } = require("../build/sync/push.js");
  const bytes = r.host.seed(NOTE, lines("a ONE", "FIVE"), clock);
  r.state.setFile(NOTE, { fileId: base.fileId, versionId: left.version_id,
    mtime: clock, size: bytes.length, sha256: await sidDigest(left.sids) });
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (...args) => {
    const file = await getFile(...args);
    return { ...file, versions: file.versions.filter(v => v.version_id !== base.versionId) };
  };
  assert.equal(await applyChange(r.context, right), "merged");
  assert.equal(r.host.text(NOTE), lines("a ONE", "b FIVE"));
  assert.ok(r.host.logs.some(line => line.includes("reason=merge_ancestry")));
});

test("a partial ancestry graph is discarded when its newer base exceeds the read budget", async () => {
  const r = await crossedWindow(40);
  assert.notEqual(await applyChange(r.context, r.right), "merged");
  assert.ok(r.host.logs.some(line => line.includes("reason=merge_ancestry_limit")));
  assert.ok([...r.host.files.keys()].some(p => p.includes("(conflict")));
});
