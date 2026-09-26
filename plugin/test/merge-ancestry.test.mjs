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
