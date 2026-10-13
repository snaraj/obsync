import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createHash, createHmac } from "node:crypto";
const require = createRequire(import.meta.url);
const { State } = require("../build/state.js");
const { Transport } = require("../build/transport.js");
const { enroll2 } = require("../build/enrollment2.js");
const { domainMapKeys } = require("../build/domainmap.js");
const { sealRecord } = require("../build/seal2.js");
const c = require("../build/crypto.js");
const ROOT = "29".repeat(32), ID = "13".repeat(16), SECRET = "37".repeat(32), ACCOUNT = "17".repeat(16);
const profile = { name: "Synthetic device", platform: "test", app_version: "1.1.7" };
const response = (body, status = 200) => ({ status, headers: {}, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0) });

async function fixture(purpose = "new", options = {}) {
  let metadata = null;
  const secrets = new Map(), calls = [], bodies = [];
  const store = { loadData: async () => structuredClone(metadata), saveData: async value => {
    if (options.failSave?.(value)) throw new Error("synthetic storage failure");
    metadata = structuredClone(value); calls.push("save");
  } };
  const custody = { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) };
  let state = await State.open(store, false, custody);
  state.data.serverUrl = "https://example.invalid"; await state.save();
  await state.stageEnrollment2(ROOT, purpose);
  const generation = state.stagedEnrollment2().generation;
  let current = true;
  const assertCurrent = () => { if (!current) throw new Error("ended"); };
  const transport = new Transport({ serverUrl: () => state.data.serverUrl, device: () => null, edgeHeaders: () => [],
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle) },
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms).unref(); }), maxAttempts: 2, request: async request => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`); bodies.push(request);
      assert.equal(state.data.deviceId, null, "credential is detached during every readback");
      const custom = await options.reply?.(request, { path, state, generation });
      if (custom !== undefined) return custom;
      if (path === "/v1/setup" && request.method === "GET") return response({ recover_only: true, seal_suite: 2 });
      if (path === "/v1/setup") return response({ account_id: ACCOUNT, device_id: ID, device_secret: SECRET, recovered: purpose === "recover" });
      if (path === "/v1/account") {
        const preimage = ["obsync/v1", "GET", path, request.headers["X-Obsync-Ts"], request.headers["X-Obsync-Nonce"], createHash("sha256").update("").digest("hex")].join("\n");
        assert.equal(request.headers["X-Obsync-Device"], ID);
        assert.equal(request.headers["X-Obsync-Sig"], createHmac("sha256", Buffer.from(SECRET, "hex")).update(preimage).digest("hex"));
        return response({ account_id: ACCOUNT, seal_suite: 2, generation });
      }
      if (path.startsWith("/v1/files/")) {
        const keys = await domainMapKeys(c.unhex(ROOT));
        const parents = [], sids = [];
        const packet = await sealRecord(keys.key, 2, { generation, domainId: keys.domainId, fileId: keys.fileId, parents, sids },
          c.utf8(JSON.stringify({ v: 1, domains: [{ id: "42".repeat(16), paths: [""] }] })));
        const version_id = await c.versionId(keys.fileId, parents, packet, sids);
        return response({ file_id: keys.fileId, domain_id: keys.domainId, heads: [version_id], versions: [{ version_id, parents, sids,
          domain_id: keys.domainId, manifest_ct: c.base64(packet), seal_suite: 2, bytes: 0, deleted: false }] });
      }
      throw new Error("unexpected endpoint");
    } });
  return { calls, bodies, transport, generation, get state() { return state; },
    end: () => { current = false; },
    reload: async () => { state = await State.open(store, false, custody); },
    run: (action = "enroll") => enroll2(state, transport, "synthetic-token", "Synthetic account", profile, assertCurrent, action) };
}

test("new setup preserves pre-request intent, signs with detached credential, and grants only local initialization", async () => {
  const r = await fixture();
  await r.run();
  assert.equal(r.state.data.vrk, ROOT);
  assert.equal(r.state.data.deviceId, ID);
  assert.equal(r.state.custody2().initializeMap, true);
  const post = r.bodies.find(r => r.method === "POST");
  const wire = JSON.parse(post.body);
  assert.equal(wire.seal_suite, 2); assert.equal(wire.generation, r.generation); assert.equal(wire.recover_only, false);
  assert.equal(post.body.includes(ROOT), false, "root never leaves the client");
  assert.equal(r.calls.some(call => call.includes("/v1/files/")), false);
});

test("restored backup authenticates existing suite2 map before adoption and cannot initialize", async () => {
  const r = await fixture("recover");
  await r.run();
  assert.equal(r.state.custody2().initializeMap, false);
  assert.ok(r.calls.some(call => call.includes("/v1/files/")));
  assert.equal(JSON.parse(r.bodies.find(r => r.method === "POST").body).recover_only, true);
});

test("missing map on recovery remains staged across restart even if server says new account", async () => {
  const r = await fixture("recover", { reply: (request, { path }) => {
    if (path.startsWith("/v1/files/")) return response({ error: "unknown_file" }, 404);
    if (path === "/v1/setup" && request.method === "POST") return response({ account_id: ACCOUNT, device_id: ID, device_secret: SECRET, recovered: false });
  } });
  await assert.rejects(r.run, /missing_map/);
  await r.reload();
  assert.equal(r.state.data.deviceId, null); assert.equal(r.state.data.vrk, null);
  assert.equal(r.state.stagedEnrollment2().purpose, "recover");
});

test("lost first setup is not retried; explicit persisted-new retry retains initialization authority", async () => {
  let lose = true;
  const r = await fixture("new", { reply: request => {
    if (request.method === "POST" && lose) throw new Error("synthetic lost response");
  } });
  await assert.rejects(r.run);
  assert.equal(r.bodies.filter(request => request.method === "POST").length, 1);
  await r.reload(); lose = false;
  await r.run("recover-first-setup");
  assert.equal(r.state.custody2().initializeMap, true);
  assert.equal(r.bodies.filter(request => request.method === "POST").length, 2);
  assert.deepEqual(r.bodies.filter(request => request.method === "POST").map(request => JSON.parse(request.body).recover_only), [false, true]);
});

test("explicit first-setup recovery cannot be inferred or used with a restored backup", async () => {
  const r = await fixture("recover");
  await assert.rejects(() => r.run("recover-first-setup"), /Only this device/);
  await assert.rejects(() => r.run("automatic-fallback"), /Only this device/);
  assert.equal(r.bodies.length, 0);
});

test("capability downgrade refuses before one-time enrollment", async () => {
  for (const capability of [{ recover_only: true }, { recover_only: true, seal_suite: "2" }, { recover_only: false, seal_suite: 2 }, null]) {
    const r = await fixture("new", { reply: (request, { path }) => path === "/v1/setup" ? response(capability) : undefined });
    await assert.rejects(r.run, /required encrypted vault format/);
    assert.equal(r.bodies.length, 1); assert.equal(r.state.data.deviceId, null);
  }
});

test("wrong account, generation, suite or malformed credential never adopts", async () => {
  for (const patch of [{ account_id: "99".repeat(16) }, { generation: "99".repeat(16) }, { seal_suite: 1 }, { seal_suite: undefined }]) {
    const r = await fixture("new", { reply: (request, { path, generation }) => path === "/v1/account"
      ? response({ account_id: ACCOUNT, generation, seal_suite: 2, ...patch }) : undefined });
    await assert.rejects(r.run, /did not confirm/); assert.equal(r.state.data.deviceId, null);
  }
  const r = await fixture("new", { reply: (request, { path }) => path === "/v1/setup" && request.method === "POST"
    ? response({ account_id: ACCOUNT, device_id: ID, device_secret: "bad" }) : undefined });
  await assert.rejects(r.run, /credential refused/); assert.equal(r.state.data.deviceId, null);
});

test("ended session while setup answers cannot make a credential live", async () => {
  let end = () => {};
  const r = await fixture("new", { reply: request => { if (request.method === "POST") end(); } });
  end = r.end;
  await assert.rejects(r.run, /ended/);
  assert.equal(r.state.data.deviceId, null);
  assert.equal(r.calls.includes("GET /v1/account"), false);
});

test("local identity changes during setup or account readback never adopt the returned grant", async () => {
  for (const phase of ["setup", "account"]) for (const field of ["vrk", "deviceId", "deviceSecret", "serverUrl", "edgeHeaders"]) {
    const r = await fixture("new", { reply: (request, { path, state }) => {
      if ((phase === "setup" && request.method === "POST") || (phase === "account" && path === "/v1/account")) {
        state.data[field] = field === "edgeHeaders" ? [{ name: "X-QA", value: "changed" }] : "changed";
      }
    } });
    await assert.rejects(r.run, /staged vault changed/);
    assert.notEqual(r.state.data.deviceId, ID); assert.equal(r.state.stagedEnrollment2().purpose, "new");
  }
});

test("failed adoption persistence never activates a credential and refuses ambiguous restart", async () => {
  let fail = false;
  const r = await fixture("recover", { failSave: () => fail }); fail = true;
  await assert.rejects(r.run); fail = false;
  assert.equal(r.state.data.deviceId, null); assert.equal(r.state.data.vrk, null);
  assert.throws(() => r.state.assertAvailable());
  await assert.rejects(r.reload, error => error.reason === "pin_mismatch");
});
