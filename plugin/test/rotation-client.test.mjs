/** Coordinator transaction tests use real State, seals and resealer; transport is bounded in-memory IO. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fakeState, FakeServer, KEYS, keys } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { RotationClient, rotationInventoryHash } = require("../build/rotationClient.js");
const { encodeRecoveryBackup } = require("../build/recoveryBackup.js");
const c = require("../build/crypto.js");
const digest = value => createHash("sha256").update(value).digest("hex");
const EMPTY = digest("");
const sorted = rows => rows.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
const OK = value => ({ outcome: "ok", value: structuredClone(value) });
const LOST = { outcome: "lost", reason: "synthetic lost reply", attempts: 1 };

async function fixture() {
  const storage = await fakeState();
  let state = storage.state, active = true, stops = 0, status;
  const server = new FakeServer(), k = await keys(), calls = [], pages = [];
  await server.seedDomainMap(k.map, KEYS.domainId);
  const content = new TextEncoder().encode("private rotation content\n");
  const source = await server.publish({ fileId: "21".repeat(16), path: "Private.md", bytes: content,
    mtime: 1700000000000, domainKey: k.domainKey, manifestKey: k.manifestKey });
  const inventory = sorted([...server.files].flatMap(([file, record]) => record.heads.map(version => [file, version])));
  state.data.files["Private.md"] = { fileId: source.file_id, versionId: source.version_id, mtime: 1700000000000, size: content.length };
  await state.save();
  const transport = {
    rotationCapabilities2: async () => { calls.push("capabilities"); },
    getFile: async file => {
      const found = server.files.get(file); if (!found) throw new Error("unknown_file");
      return structuredClone({ file_id: file, ...found, conflicted: found.heads.length > 1 });
    },
    getVersion: async (file, version) => {
      const found = server.files.get(file)?.versions.find(row => row.version_id === version);
      if (!found) throw new Error("unknown_version"); return structuredClone(found);
    },
    getChunk: async sid => {
      const found = server.chunks.get(sid); if (!found) throw new Error("unknown_chunk"); return found.slice();
    },
    putChunk: async (sid, bytes) => { calls.push("chunk"); assert.equal(digest(bytes), sid); server.chunks.set(sid, bytes.slice()); },
    prepareRotation: async (intent, coordinator, token) => {
      calls.push("prepare"); assert.equal(token, "owner-token"); assert.equal(state.custody2().phase, "prepare_unknown");
      status ??= { intent: structuredClone(intent), coordinator, cutoff: server.seq,
        inventory_hash: digest(inventory.map(row => `${JSON.stringify(row)}\n`).join("")), inventory_heads: inventory.length,
        catalog_pages: 0, catalog_heads: 0, catalog_last: null, catalog_hash: EMPTY, committed: false, resume_id: null };
      return OK(status);
    },
    rotationStatus: async () => { calls.push("status"); return structuredClone(status); },
    rotationInventory: async (_, page) => ({ ...status, operation: status.intent.operation, page,
      heads: structuredClone(inventory.slice(page * 256, (page + 1) * 256)) }),
    postVersion: async (file, post) => {
      calls.push("version"); assert.equal(state.custody2().phase, "seeding"); assert.equal(post.accept_existing, false);
      const found = server.files.get(file) ?? { domain_id: post.domain_id, heads: [], versions: [] };
      if (!found.heads.includes(post.version_id)) {
        found.heads.push(post.version_id);
        found.versions.unshift({ ...structuredClone(post), device_id: KEYS.deviceId, ts: 1700000000001 });
      }
      server.files.set(file, found); return OK({ version_id: post.version_id, heads: found.heads, conflicted: found.heads.length > 1 });
    },
    rotationCatalog: async (_, __, page, entries) => {
      calls.push("catalog");
      if (pages[page]) assert.deepEqual(entries, pages[page]); else pages[page] = structuredClone(entries);
      status.catalog_pages = pages.length; status.catalog_heads = pages.flat().length;
      status.catalog_last = pages.flat().at(-1)?.slice(0, 2) ?? null;
      status.catalog_hash = digest(Buffer.concat(pages.map(rows => createHash("sha256").update(JSON.stringify(rows)).digest())));
      return OK(status);
    },
    commitRotation: async (sent, token) => {
      calls.push("commit"); assert.equal(token, "owner-token"); assert.equal(state.custody2().phase, "commit_unknown");
      assert.equal(sent.catalog_hash, status.catalog_hash); status.committed = true; return OK(status);
    },
  };
  const check = () => { if (!active) throw new Error("session ended"); };
  const make = () => new RotationClient(state, transport, check, async () => { stops++; });
  let client = make();
  return { server, transport, inventory, calls, pages, content,
    get client() { return client; }, get state() { return state; }, get status() { return status; }, get stops() { return stops; },
    backup: () => encodeRecoveryBackup(c.unhex(state.custody2().rotation.newRoot)),
    end: () => { active = false; },
    reload: async () => { state = await storage.reload(); client = make(); },
    stage: async () => { await client.start("33".repeat(16)); },
    prepare: async () => { await client.prepare("owner-token", await encodeRecoveryBackup(c.unhex(state.custody2().rotation.newRoot))); },
  };
}

test("fresh-root staging is local and wrong backup cannot prepare", async () => {
  const r = await fixture(); await r.stage();
  const pin = r.state.custody2();
  assert.equal(pin.phase, "draft"); assert.notEqual(pin.rotation.newRoot, KEYS.vrk);
  assert.equal(r.state.data.vrk, KEYS.vrk); assert.deepEqual(r.calls, ["capabilities"]);
  await assert.rejects(() => r.client.prepare("owner-token", "stripped backup"));
  const wrong = await encodeRecoveryBackup(c.unhex(KEYS.vrk));
  await assert.rejects(() => r.client.prepare("owner-token", wrong), /does not match/);
  assert.deepEqual(r.calls, ["capabilities"]); assert.equal(r.state.custody2().phase, "draft");
});

test("only an unprepared draft can cancel without mutating the server", async () => {
  const r = await fixture(); await r.stage(); await r.client.cancelDraft();
  assert.equal(r.state.custody2().phase, "active"); assert.equal(r.state.data.vrk, KEYS.vrk);
  assert.deepEqual(r.calls, ["capabilities"]);
  await r.stage(); await r.prepare();
  const before = r.state.custody2(), calls = [...r.calls];
  await assert.rejects(() => r.client.cancelDraft(), /could not be verified/);
  assert.deepEqual(r.state.custody2(), before); assert.deepEqual(r.calls, calls);
});

test("full reseed requires persisted commit receipt and reload before activation", async () => {
  const r = await fixture(); await r.stage(); const backup = await r.backup(); await r.prepare();
  assert.equal(r.state.custody2().phase, "prepared");
  await r.client.seed();
  assert.equal(r.state.custody2().phase, "commit_unknown");
  assert.deepEqual(r.state.custody2().rotation.commit, { catalogPages: r.pages.length, catalogHash: r.status.catalog_hash });
  assert.equal(r.pages.flat().length, r.inventory.length); assert.ok(r.calls.includes("chunk"));
  assert.ok(r.state.data.files["Private.md"], "old acknowledged catalog retained before commit");
  await assert.rejects(() => r.client.commit("owner-token", backup), /Restart Obsidian/);
  assert.equal(r.calls.includes("commit"), false);
  await r.reload(); await r.client.commit("owner-token", backup);
  assert.equal(r.state.custody2().phase, "active"); assert.equal(r.state.custody2().history.root, KEYS.vrk);
  assert.notEqual(r.state.data.vrk, KEYS.vrk); assert.deepEqual(r.state.data.files, {});
  assert.equal(r.calls.filter(x => x === "commit").length, 1);
});

test("lost prepare and commit replies are settled by exact status reads", async () => {
  const r = await fixture(); await r.stage(); const backup = await r.backup();
  const prepare = r.transport.prepareRotation;
  r.transport.prepareRotation = async (...args) => { await prepare(...args); return LOST; };
  await r.prepare(); assert.equal(r.state.custody2().phase, "prepared");
  await r.client.seed(); await r.reload();
  const commit = r.transport.commitRotation;
  r.transport.commitRotation = async (...args) => { await commit(...args); return LOST; };
  await r.client.commit("owner-token", backup); assert.equal(r.state.custody2().phase, "active");
  assert.equal(r.calls.filter(x => x === "prepare").length, 1); assert.equal(r.calls.filter(x => x === "commit").length, 1);
});

test("prepared cutoff and inventory cannot be replaced after a reload", async () => {
  for (const field of ["cutoff", "inventory_hash", "inventory_heads"]) {
    const r = await fixture(); await r.stage(); await r.prepare(); await r.reload();
    r.status[field] = typeof r.status[field] === "number" ? r.status[field] + 1 : "f0".repeat(32);
    await assert.rejects(() => r.client.seed(), /could not be verified/);
    assert.equal(r.calls.includes("version"), false); assert.equal(r.state.data.vrk, KEYS.vrk);
  }
});

test("incomplete or reordered inventory refuses before resealing", async () => {
  for (const change of [rows => rows.slice(1), rows => rows.reverse(), rows => [rows[0], rows[0]]]) {
    const r = await fixture(); await r.stage(); await r.prepare();
    const read = r.transport.rotationInventory;
    r.transport.rotationInventory = async (...args) => { const page = await read(...args); page.heads = change(page.heads); return page; };
    await assert.rejects(() => r.client.seed(), /could not be verified/);
    assert.equal(r.calls.includes("version"), false);
  }
});

test("every posted manifest needs exact resulting ciphertext and record readback", async () => {
  for (const field of ["manifest_ct", "seal_suite", "parents", "sids", "bytes", "deleted", "version_id"]) {
    const r = await fixture(); await r.stage(); await r.prepare();
    const read = r.transport.getVersion;
    r.transport.getVersion = async (file, version) => {
      const got = await read(file, version);
      if (r.inventory.some(([old]) => old === file)) return got;
      const bad = { manifest_ct: Buffer.alloc(16).toString("base64"), seal_suite: 1, parents: ["11".repeat(32)],
        sids: ["12".repeat(32)], bytes: got.bytes + 1, deleted: !got.deleted, version_id: "13".repeat(32) };
      got[field] = bad[field]; return got;
    };
    await assert.rejects(() => r.client.seed());
    assert.equal(r.state.custody2().rotation.commit, null); assert.equal(r.calls.includes("commit"), false);
  }
});

test("file readback binds domain and head membership", async () => {
  for (const field of ["file_id", "domain_id", "heads"]) {
    const r = await fixture(); await r.stage(); await r.prepare();
    const read = r.transport.getFile;
    r.transport.getFile = async file => {
      const got = await read(file);
      if (!r.inventory.some(([old]) => old === file)) got[field] = field === "heads" ? [] : "f1".repeat(16);
      return got;
    };
    await assert.rejects(() => r.client.seed()); assert.equal(r.state.custody2().rotation.commit, null);
  }
});

test("catalog substitution or premature committed status cannot activate a root", async () => {
  for (const field of ["catalog_hash", "catalog_pages", "catalog_heads", "catalog_last", "committed"]) {
    const r = await fixture(); await r.stage(); await r.prepare();
    const upload = r.transport.rotationCatalog;
    r.transport.rotationCatalog = async (...args) => {
      await upload(...args);
      r.status[field] = { catalog_hash: "f2".repeat(32), catalog_pages: 2, catalog_heads: 0, catalog_last: null, committed: true }[field];
      return OK(r.status);
    };
    await assert.rejects(() => r.client.seed(), /could not be verified/);
    assert.equal(r.state.data.vrk, KEYS.vrk); assert.equal(r.state.custody2().rotation.commit, null);
  }
});

test("restart compares catalog receipt before commit, including an already committed reply", async () => {
  for (const field of ["catalog_hash", "catalog_pages", "inventory_hash", "cutoff"]) {
    const r = await fixture(); await r.stage(); const backup = await r.backup(); await r.prepare(); await r.client.seed(); await r.reload();
    r.status.committed = true;
    r.status[field] = typeof r.status[field] === "number" ? r.status[field] + 1 : "f3".repeat(32);
    await assert.rejects(() => r.client.commit("owner-token", backup), /could not be verified/);
    assert.equal(r.state.data.vrk, KEYS.vrk); assert.equal(r.calls.includes("commit"), false);
  }
});

test("ended session cannot proceed from staging preflight to local pin", async () => {
  const r = await fixture();
  r.transport.rotationCapabilities2 = async () => { r.end(); };
  await assert.rejects(r.stage, /session ended/);
  assert.equal(r.state.custody2().phase, "active"); assert.equal(r.state.data.vrk, KEYS.vrk);
});

test("source commitment uses fixed canonical rows and bounded unique global order", async () => {
  const row = ["12".repeat(16), "34".repeat(32)];
  assert.equal(await rotationInventoryHash([row]), digest(`${JSON.stringify(row)}\n`));
  assert.equal(await rotationInventoryHash([]), EMPTY);
  for (const rows of [[row, row], [["invalid", row[1]]], Array(65537).fill(row)]) {
    await assert.rejects(() => rotationInventoryHash(rows), /could not be verified/);
  }
});

test("persisted prepared hash refuses a coherent substituted retained inventory before publication", async () => {
  const r = await fixture(), k = await keys(), source = r.inventory.find(([file]) => file === "21".repeat(16));
  const older = [...source];
  const newer = await r.server.publish({ fileId: source[0], path: "Private.md", bytes: r.content, mtime: 1700000000001,
    parents: [source[1]], domainKey: k.domainKey, manifestKey: k.manifestKey });
  source[1] = newer.version_id; // Prepare now captures the real current head; the older native version remains retained.
  await r.stage(); await r.prepare();
  source[1] = older[1];
  r.status.inventory_hash = await rotationInventoryHash(r.inventory); // Coherent count, row order, packets and new hash.
  await assert.rejects(r.client.seed(), /could not be verified/, "prepared inventory hash must reject coherent retained-version substitution");
  assert.equal(r.calls.some(call => ["version", "chunk", "catalog"].includes(call)), false, "substituted inventory must refuse before any publication");
  assert.equal(r.state.custody2().phase, "prepared", "refused inventory substitution must preserve prepared custody");
  assert.equal(r.state.data.vrk, KEYS.vrk);
});

test("persisted prepared hash and count refuse a coherent inventory omitting a valid head", async () => {
  const r = await fixture(), k = await keys(); await r.stage(); await r.prepare();
  const map = r.inventory.find(([file]) => file === k.generation);
  r.inventory.splice(0, r.inventory.length, map);
  r.status.inventory_heads = r.inventory.length;
  r.status.inventory_hash = await rotationInventoryHash(r.inventory);
  await assert.rejects(r.client.seed(), /could not be verified/, "prepared receipt must reject coherent omission of a valid source head");
  assert.equal(r.calls.some(call => ["version", "chunk", "catalog"].includes(call)), false, "omitted inventory must refuse before any publication");
  assert.equal(r.state.custody2().phase, "prepared"); assert.equal(r.state.data.vrk, KEYS.vrk);
});
