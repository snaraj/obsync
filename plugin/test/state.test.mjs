/**
 * Local state and device policy: that a corrupt data file degrades to a
 * resync instead of a crash, that saves serialise instead of interleaving,
 * and that the ceilings do what the settings tab says they do.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { State, defaultData, parseData } = require("../build/state.js");
const policy = require("../build/policy.js");

function store() {
  const writes = [];
  let held = null;
  return {
    writes,
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
      serverUrl: "https://example.invalid",
      lastSeq: "nine",
      edgeHeaders: [{ name: "X-A", value: "1" }, { name: 7 }, "nope"],
      files: {
        good: { fileId: "f", versionId: "v", mtime: 3, size: 4, sha256: "s" },
        bad: { fileId: 5 },
        alsoBad: "no",
      },
      domains: { d: "", e: 9 },
      remoteOnly: { r: { path: "p", size: 2 }, broken: {} },
      policy: { perFileMaxBytes: 100, totalBudgetBytes: "lots" },
    },
    false,
  );
  assert.equal(mixed.vrk, "aa".repeat(32));
  assert.equal(mixed.deviceId, null, "a non-string device id is dropped");
  assert.equal(mixed.lastSeq, 0, "a non-numeric sequence resets");
  assert.deepEqual(mixed.edgeHeaders, [{ name: "X-A", value: "1" }]);
  assert.deepEqual(Object.keys(mixed.files), ["good"]);
  assert.deepEqual(mixed.domains, { d: "" });
  assert.deepEqual(Object.keys(mixed.remoteOnly), ["r"]);
  assert.deepEqual(mixed.policy, { perFileMaxBytes: 100, totalBudgetBytes: 0 });
});

test("saves serialise and never lose the newest state", async () => {
  const backing = store();
  const state = await State.open(backing, false);
  state.data.lastSeq = 1;
  const first = state.save();
  state.data.lastSeq = 2;
  const second = state.save();
  state.data.lastSeq = 3;
  const third = state.save();
  await Promise.all([first, second, third]);

  assert.ok(backing.writes.length <= 3, "requests coalesce");
  assert.equal(backing.writes[backing.writes.length - 1].lastSeq, 3, "the last write holds the newest state");
  const reloaded = await State.open(backing, false);
  assert.equal(reloaded.data.lastSeq, 3);
});

test("the file index answers by path and by file id", async () => {
  const state = await State.open(store(), false);
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
  const state = await State.open(store(), false);
  state.data.remoteOnly["f1"] = { path: "big.bin", size: 99 };
  state.setFile("big.bin", { fileId: "f1", versionId: "v", mtime: 1, size: 99, sha256: "s" });
  assert.equal(state.data.remoteOnly["f1"], undefined);
});

test("paired means a key, a device and a secret", async () => {
  const state = await State.open(store(), false);
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
