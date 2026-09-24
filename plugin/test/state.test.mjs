/**
 * Local state and device policy: that a corrupt data file degrades to a
 * resync instead of a crash, that saves serialise instead of interleaving,
 * and that the ceilings do what the settings tab says they do.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { memorySecrets } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { GRAVES_MAX, State, defaultData, isPushed, parseData } = require("../build/state.js");
const policy = require("../build/policy.js");

function store() {
  const writes = [];
  let held = null;
  return {
    writes,
    secrets: memorySecrets(),
    loadData: async () => held,
    saveData: async (value) => {
      writes.push(JSON.parse(JSON.stringify(value)));
      await new Promise((resolve) => setImmediate(resolve));
      held = JSON.parse(JSON.stringify(value));
    },
  };
}

test("a fresh device starts with its platform's defaults", () => {
  const desktop = defaultData(false);
  assert.equal(desktop.vrk, null);
  assert.equal(desktop.lastSeq, 0);
  assert.deepEqual(desktop.policy, { perFileMaxBytes: 0, totalBudgetBytes: 0 });
  const mobile = defaultData(true);
  assert.deepEqual(mobile.policy, { perFileMaxBytes: 512 * 1024 * 1024, totalBudgetBytes: 50 * 1024 * 1024 * 1024 });
});

test("a corrupt or partial data file degrades to a resync, never a crash", () => {
  for (const junk of [null, undefined, 42, "text", [], { files: 7 }, { policy: "loose" }]) {
    const data = parseData(junk, false);
    assert.equal(data.vrk, null);
    assert.deepEqual(data.files, {});
    assert.deepEqual(data.policy, { perFileMaxBytes: 0, totalBudgetBytes: 0 });
  }
  const mixed = parseData(
    {
      vrk: "aa".repeat(32),
      deviceId: 5,
      deviceName: { not: "a name" },
      serverUrl: "https://example.invalid",
      lastSeq: "nine",
      edgeHeaders: [{ name: "X-A", value: "1" }, { name: 7 }, "nope"],
      files: {
        good: { fileId: "f", versionId: "v", mtime: 3, size: 4, sha256: "s" },
        bad: { fileId: 5 },
        alsoBad: "no",
      },
      remoteOnly: { r: { path: "p", size: 2 }, broken: {} },
      policy: { perFileMaxBytes: 100, totalBudgetBytes: "lots" },
    },
    false,
  );
  assert.equal(mixed.vrk, "aa".repeat(32));
  assert.equal(mixed.deviceId, null, "a non-string device id is dropped");
  assert.equal(mixed.deviceName, null, "a non-string device name is dropped");
  assert.equal(mixed.lastSeq, 0, "a non-numeric sequence resets");
  assert.deepEqual(mixed.edgeHeaders, [{ name: "X-A", value: "1" }]);
  assert.deepEqual(Object.keys(mixed.files), ["good"]);
  assert.deepEqual(Object.keys(mixed.remoteOnly), ["r"]);
  assert.deepEqual(mixed.policy, { perFileMaxBytes: 100, totalBudgetBytes: 0 });
});

/**
 * The name a note waits for beside its own (issue #149) is read back like
 * every other path in the data file: as input, and a name that is not a vault
 * path is dropped rather than handed to a move.
 */
test("a remembered waiting name survives a load only when it is a vault path", () => {
  const data = parseData({
    files: {
      "Notes/Copy.md": { fileId: "f", versionId: "v", mtime: 1, size: 2, sha256: "s", name: "Notes/Name.md" },
      "Notes/Other.md": { fileId: "g", versionId: "v", mtime: 1, size: 2, sha256: "s", name: "../outside.md" },
      "Notes/Plain.md": { fileId: "h", versionId: "v", mtime: 1, size: 2, sha256: "s" },
    },
  }, false);
  assert.equal(data.files["Notes/Copy.md"].name, "Notes/Name.md");
  assert.equal(data.files["Notes/Other.md"].name, undefined, "a name outside the vault was kept");
  assert.equal("name" in data.files["Notes/Plain.md"], false);
});

test("saves serialise and never lose the newest state", async () => {
  const backing = store();
  const state = await State.open(backing, false, backing.secrets);
  state.data.lastSeq = 1;
  const first = state.save();
  state.data.lastSeq = 2;
  const second = state.save();
  state.data.lastSeq = 3;
  const third = state.save();
  await Promise.all([first, second, third]);

  assert.ok(backing.writes.length <= 3, "requests coalesce");
  assert.equal(backing.writes[backing.writes.length - 1].lastSeq, 3, "the last write holds the newest state");
  const reloaded = await State.open(backing, false, backing.secrets);
  assert.equal(reloaded.data.lastSeq, 3);
});

test("the file index answers by path and by file id", async () => {
  const state = await State.open(store(), false, memorySecrets());
  state.setFile("a/b.md", { fileId: "f1", versionId: "v1", mtime: 1, size: 10, sha256: "s1" });
  state.setFile("c.md", { fileId: "f2", versionId: "v2", mtime: 2, size: 20, sha256: "s2" });
  assert.equal(state.fileByPath("a/b.md").fileId, "f1");
  assert.equal(state.pathByFileId("f2"), "c.md");
  assert.equal(state.pathByFileId("nope"), undefined);
  assert.equal(state.localBytes(), 30);
  state.forgetPath("a/b.md");
  assert.equal(state.fileByPath("a/b.md"), undefined);
  assert.equal(state.localBytes(), 20);
});

test("recording a file clears its remote-only entry", async () => {
  const state = await State.open(store(), false, memorySecrets());
  state.data.remoteOnly["f1"] = { path: "big.bin", size: 99 };
  state.setFile("big.bin", { fileId: "f1", versionId: "v", mtime: 1, size: 99, sha256: "s" });
  assert.equal(state.data.remoteOnly["f1"], undefined);
});

test("the feed mark, the graves and a record's server time load only when well formed (#145)", () => {
  const ID = "ab".repeat(16), VERSION = "cd".repeat(32);
  const mark = { seq: 7, fileId: ID, versionId: VERSION, ts: 1757200000000, replay: false };
  const good = parseData({
    feedMark: mark,
    graves: {
      [ID]: { versionId: VERSION, path: "Notes/gone.md", folder: false, ts: 5 },
      ["ef".repeat(16)]: { versionId: VERSION, path: "Notes", folder: true },
      "not-an-id": { versionId: VERSION, path: "Notes/x.md", folder: false },
      ["01".repeat(16)]: { versionId: "short", path: "Notes/x.md", folder: false },
      ["02".repeat(16)]: { versionId: VERSION, path: "../outside.md", folder: false },
      ["03".repeat(16)]: { versionId: VERSION, path: "Notes/x.md" },
    },
    files: {
      "a.md": { fileId: "f", versionId: "v", mtime: 1, size: 2, sha256: "s", ts: 9 },
      "b.md": { fileId: "f", versionId: "v", mtime: 1, size: 2, sha256: "s", ts: "nine" },
    },
  }, false);
  assert.deepEqual(good.feedMark, mark);
  assert.deepEqual(Object.keys(good.graves), [ID, "ef".repeat(16)], "a grave names a request path and a publication");
  assert.equal(good.graves[ID].ts, 5);
  assert.equal(good.graves["ef".repeat(16)].ts, undefined);
  assert.equal(good.files["a.md"].ts, 9);
  assert.equal("ts" in good.files["b.md"], false, "an unreadable time is no time");
  // No mark is a device that has not read the feed yet -- a 1.1.2 data file
  // among them -- and never a mark of zero.
  for (const broken of [{ ...mark, seq: 0 }, { ...mark, seq: 1.5 }, { ...mark, fileId: "f" }, { ...mark, versionId: ID },
    { ...mark, ts: "late" }, { ...mark, replay: 1 }, { seq: 7 }, "mark", null]) {
    assert.equal(parseData({ feedMark: broken }, false).feedMark, null, JSON.stringify(broken));
  }
  assert.equal(parseData({}, false).feedMark, null);
  assert.deepEqual(parseData({}, false).graves, {});
});

test("graves are capped oldest first, and a file recorded again has none", async () => {
  const state = await State.open(store(), false, memorySecrets());
  const id = (n) => n.toString(16).padStart(32, "0");
  let dropped = 0;
  for (let n = 1; n <= GRAVES_MAX + 3; n++) dropped += state.bury(id(n), { versionId: "cd".repeat(32), path: `Notes/${n}.md`, folder: false });
  assert.equal(dropped, 3);
  assert.equal(Object.keys(state.data.graves).length, GRAVES_MAX);
  assert.deepEqual(Object.keys(state.data.graves).slice(0, 2), [id(4), id(5)], "the oldest go first");
  state.setFile("Notes/9.md", { fileId: id(9), versionId: "v", mtime: 1, size: 1, sha256: "s" });
  state.setFolder("Notes/10", { fileId: id(10), versionId: "v" });
  assert.equal(state.data.graves[id(9)], undefined, "a note alive again is no deletion to re-send");
  assert.equal(state.data.graves[id(10)], undefined);
  const many = {};
  for (let n = 1; n <= GRAVES_MAX + 2; n++) many[id(n)] = { versionId: "cd".repeat(32), path: `Notes/${n}.md`, folder: false };
  const reloaded = parseData({ graves: many }, false);
  assert.equal(Object.keys(reloaded.graves).length, GRAVES_MAX, "a data file holding more than the cap loads the newest");
  assert.equal(reloaded.graves[id(1)], undefined);
  assert.equal(reloaded.graves[id(GRAVES_MAX + 2)].path, `Notes/${GRAVES_MAX + 2}.md`);
});

test("pushed means the record matches the bytes the vault holds now", () => {
  const record = { fileId: "f1", versionId: "v1", mtime: 5, size: 7, sha256: "s" };
  assert.equal(isPushed(record, 5, 7), true);
  assert.equal(isPushed(undefined, 5, 7), false, "a file with no record was never pushed");
  assert.equal(isPushed(record, 6, 7), false, "a newer mtime is an edit");
  assert.equal(isPushed(record, 5, 8), false, "the same mtime with another size is an edit too");
  assert.equal(isPushed({ ...record, mtime: -1 }, 5, 7), false, "a rename waiting to be published is unpushed");
});

test("forgetting a pairing drops the identity and everything derived from it, and nothing else", async () => {
  const state = await State.open(store(), false, memorySecrets());
  Object.assign(state.data, {
    vrk: "aa".repeat(32), deviceId: "bb".repeat(16), deviceSecret: "cc".repeat(32),
    deviceName: "Study laptop", serverUrl: "https://sync.example.invalid",
    edgeHeaders: [{ name: "X-Edge", value: "EDGE SENTINEL" }], lastSeq: 9,
    files: { "Notes/a.md": { fileId: "f1", versionId: "v1", mtime: 1, size: 2, sha256: "s" } },
    // A FOLDER RECORD IS A PAIRING FACT TOO (#104): its file id is derived
    // from the domain's manifest key, so it means nothing to a different
    // server and must go with the identity, exactly as `files` does.
    folders: { "Notes": { fileId: "f3", versionId: "v3" } },
    remoteOnly: { f2: { path: "Notes/big.bin", size: 3 } },
    // AND THE BOOKKEEPING ABOUT WORK IN FLIGHT, which names records on the
    // server this device is leaving: a retirement admits a folder record one
    // capitalisation off a selected folder, and a barrier is a record still
    // owed (`sync/pull.ts`, `sync/engine.ts`; review round 4).
    retiredRoots: { Notes: "f3" }, folderBarriers: ["Notes"],
    // And a parked record, which names a version on the server being left
    // (`sync/engine.ts`, `park`; issue #144).
    parked: { f5: { path: "Notes/locked.md", reason: "EPERM" } },
    // And the feed mark and the graves (#145), which name entries and
    // versions on the server being left: a mark kept for the next server
    // would read its journal as a restored one.
    feedMark: { seq: 9, fileId: "f1", versionId: "v1", ts: 5, replay: false },
    graves: { f4: { versionId: "v4", path: "Notes/gone.md", folder: false } },
    syncFolders: ["Notes"], policy: { perFileMaxBytes: 11, totalBudgetBytes: 22 },
  });

  state.forgetPairing();

  assert.deepEqual(
    { ...state.data },
    {
      vrk: "aa".repeat(32), deviceId: null, deviceSecret: null, deviceName: "Study laptop",
      serverUrl: "", edgeHeaders: [], lastSeq: 0, files: {}, folders: {}, remoteOnly: {},
      retiredRoots: {}, folderBarriers: [], parked: {}, feedMark: null, graves: {},
      syncFolders: ["Notes"], policy: { perFileMaxBytes: 11, totalBudgetBytes: 22 },
    },
  );
  assert.equal(state.paired, false);
});

test("paired means a key, a device and a secret", async () => {
  const state = await State.open(store(), false, memorySecrets());
  assert.equal(state.paired, false);
  state.data.vrk = "aa".repeat(32);
  assert.equal(state.paired, false);
  state.data.deviceId = "d";
  assert.equal(state.paired, false);
  state.data.deviceSecret = "s";
  assert.equal(state.paired, true);
});

test("ceilings admit and refuse exactly at their boundary", () => {
  const mobile = { perFileMaxBytes: 100, totalBudgetBytes: 1000 };
  assert.deepEqual(policy.admit(mobile, 0, 100), { ok: true });
  assert.deepEqual(policy.admit(mobile, 0, 101), { ok: false, reason: "per_file" });
  assert.deepEqual(policy.admit(mobile, 950, 50), { ok: true });
  assert.deepEqual(policy.admit(mobile, 950, 51), { ok: false, reason: "budget" });
  const unlimited = { perFileMaxBytes: 0, totalBudgetBytes: 0 };
  assert.deepEqual(policy.admit(unlimited, 1e15, 1e15), { ok: true });
  assert.match(policy.admissionReason(mobile, "per_file"), /per-file ceiling \(100 B\)/);
  assert.match(policy.admissionReason(mobile, "budget"), /total budget \(1000 B\)/);
});

test("byte sizes read and write the way the settings field shows them", () => {
  assert.equal(policy.formatBytes(0), "unlimited");
  assert.equal(policy.formatBytes(512 * 1024 * 1024), "512 MiB");
  assert.equal(policy.formatBytes(50 * 1024 * 1024 * 1024), "50 GiB");
  assert.equal(policy.formatBytes(1536), "1.5 KiB");
  assert.equal(policy.parseBytes("512 MiB"), 512 * 1024 * 1024);
  assert.equal(policy.parseBytes("50gib"), 50 * 1024 * 1024 * 1024);
  assert.equal(policy.parseBytes("2048"), 2048);
  assert.equal(policy.parseBytes("unlimited"), 0);
  assert.equal(policy.parseBytes("0"), 0);
  assert.equal(policy.parseBytes(""), null, "a half-typed value is not a ceiling of zero");
  assert.equal(policy.parseBytes("lots"), null);
  assert.equal(policy.parseBytes("12 parsecs"), null);
  for (const bytes of [0, 1023, 1024, 512 * 1024 * 1024, 50 * 1024 * 1024 * 1024]) {
    assert.equal(policy.parseBytes(policy.formatBytes(bytes)), bytes, `${bytes} round-trips`);
  }
});
