import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { State } = require("../build/state.js"), { Transport } = require("../build/transport.js");
const { recoverLegacyUpgrade } = require("../build/legacyUpgrade.js");
const c = require("../build/crypto.js"), dm = require("../build/domainmap.js");
const { recoveryPhrase } = require("../build/pairing.js");
const OLD = "29".repeat(32), DEVICE = "13".repeat(16), SECRET = "37".repeat(32), ACCOUNT = "17".repeat(16);
const profile = { name: "Synthetic recovery", platform: "test", app_version: "1.1.7" };
const response = (value, status = 200) => ({ status, headers: {}, text: JSON.stringify(value), arrayBuffer: new ArrayBuffer(0) });

async function fixture(options = {}) {
  let metadata = null, current = true, failSave = false, state;
  const secrets = new Map(), requests = [];
  const store = { loadData: async () => structuredClone(metadata), saveData: async value => {
    if (failSave) throw new Error("synthetic save refusal"); metadata = structuredClone(value);
  } };
  const custody = { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) };
  state = await State.open(store, false, custody);
  state.data.serverUrl = "https://example.invalid"; await state.save();
  const map = await dm.domainMapKeys(c.unhex(OLD)), parents = [], sids = [];
  const encrypted = await c.encryptManifest(map.key, map.fileId, await c.contentVersionId(map.fileId, parents, sids), JSON.stringify(dm.defaultDomainMap("42".repeat(16))));
  const versionId = await c.versionId(map.fileId, parents, encrypted.ciphertext, sids);
  const version = { version_id: versionId, parents, sids, manifest_ct: c.base64(encrypted.ciphertext), manifest_nonce: c.hex(encrypted.nonce),
    bytes: 0, deleted: false, device_id: DEVICE, ts: 1000 };
  const file = { file_id: map.fileId, domain_id: map.domainId, heads: [versionId], versions: [version] };
  const transport = new Transport({ serverUrl: () => state.data.serverUrl, device: () => null, edgeHeaders: () => [], maxAttempts: 1,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) },
    sleep: ms => new Promise(done => setTimeout(done, ms).unref()), request: async request => {
      requests.push(request);
      assert.equal(state.data.deviceId, null, "the recovered grant stays detached during every server read");
      assert.equal(state.custody2(), null);
      const path = new URL(request.url).pathname;
      const override = await options.reply?.(request, { path, state, map, file, version });
      if (override !== undefined) return override;
      if (path === "/v1/setup" && request.method === "GET") return response({ recover_only: true, seal_suite: 2 });
      if (path === "/v1/rotation/capabilities") return response({ rotation_protocol: 1, seal_suite: 2 });
      if (path === "/v1/setup") return response({ recovered: true, account_id: ACCOUNT, device_id: DEVICE, device_secret: SECRET });
      assert.equal(request.headers["X-Obsync-Device"], DEVICE);
      if (path === "/v1/account") return response({ account_id: ACCOUNT });
      if (path === `/v1/files/${map.fileId}`) return response(file);
      if (path === `/v1/files/${map.fileId}/versions/${versionId}`) return response(version);
      assert.fail(`unexpected route ${path}`);
    } });
  const backup = (await recoveryPhrase(c.unhex(OLD))).join(" ");
  return { requests, backup, map, get state() { return state; }, end: () => { current = false; }, fail: () => { failSave = true; },
    reload: async () => { failSave = false; state = await State.open(store, false, custody); },
    run: (text = backup) => recoverLegacyUpgrade({ state, transport, token: "synthetic-token", backup: text, profile,
      assertCurrent: () => { if (!current) throw new Error("session ended"); } }) };
}

test("legacy recovery authenticates old map then atomically stages a stopped fresh-root draft", async () => {
  const r = await fixture(); await r.run();
  const pin = r.state.custody2();
  assert.equal(pin.phase, "draft"); assert.equal(pin.rotation.fromSuite, 1); assert.equal(pin.rotation.prepared, null);
  assert.equal(pin.initializeMap, false); assert.equal(pin.history, null);
  assert.equal(r.state.data.vrk, OLD); assert.equal(r.state.data.deviceId, DEVICE);
  assert.notEqual(pin.rotation.newRoot, OLD); assert.equal(pin.rotation.intent.oldGeneration, r.map.fileId);
  const posts = r.requests.filter(row => row.method !== "GET"); assert.equal(posts.length, 1);
  const sent = JSON.parse(posts[0].body); assert.equal(sent.recover_only, true);
  assert.equal(Object.hasOwn(sent, "seal_suite"), false); assert.equal(Object.hasOwn(sent, "generation"), false);
  assert.equal(posts[0].body.includes(OLD), false); assert.equal(posts[0].body.includes(pin.rotation.newRoot), false);
  await r.reload(); assert.deepEqual(r.state.custody2(), pin);
});

test("legacy upgrade refuses current-format backup and held-key mismatch before any request", async () => {
  const r = await fixture(); await assert.rejects(() => r.run("obsync-recovery-v2 invalid"));
  r.state.data.vrk = "30".repeat(32);
  await assert.rejects(() => r.run(), /does not match/); assert.equal(r.requests.length, 0);
});

test("recovery-only support precedes the token; detached grant must also prove rotation support", async () => {
  for (const endpoint of ["/v1/setup", "/v1/rotation/capabilities"]) {
    const r = await fixture({ reply: (request, { path }) => path === endpoint ? response({}) : undefined });
    await assert.rejects(() => r.run()); assert.equal(r.requests.filter(row => row.method === "POST").length, endpoint === "/v1/setup" ? 0 : 1);
    assert.equal(r.state.data.deviceId, null); assert.equal(r.state.custody2(), null);
  }
});

test("lost legacy recovery response is not retried or adopted", async () => {
  const r = await fixture({ reply: request => { if (request.method === "POST") throw new Error("synthetic lost reply"); } });
  await assert.rejects(() => r.run()); assert.equal(r.requests.filter(row => row.method === "POST").length, 1);
  assert.equal(r.state.custody2(), null); assert.equal(r.state.data.deviceId, null);
});

test("malformed or non-recovered enrollment never reaches account readback", async () => {
  for (const patch of [{ recovered: false }, { account_id: "bad" }, { device_secret: "bad" }]) {
    const r = await fixture({ reply: request => request.method === "POST"
      ? response({ recovered: true, account_id: ACCOUNT, device_id: DEVICE, device_secret: SECRET, ...patch }) : undefined });
    await assert.rejects(() => r.run()); assert.equal(r.requests.some(row => row.url.endsWith("/v1/account")), false);
    assert.equal(r.state.data.deviceId, null);
  }
});

test("account identity and legacy format cannot be substituted by recovery response", async () => {
  for (const patch of [{ account_id: "99".repeat(16) }, { seal_suite: 2 }, { seal_suite: 1 }, { generation: "99".repeat(16) }]) {
    const r = await fixture({ reply: (_, { path }) => path === "/v1/account" ? response({ account_id: ACCOUNT, ...patch }) : undefined });
    await assert.rejects(() => r.run(), /not an older vault/); assert.equal(r.state.data.deviceId, null);
    assert.equal(r.requests.some(row => row.url.includes("/v1/files/")), false);
  }
});

test("missing, tampered or wrongly bound old map never creates a local upgrade", async () => {
  for (const mode of ["missing", "packet", "domain"]) {
    const r = await fixture({ reply: (_, { path, file, version }) => {
      if (!path.includes("/v1/files/")) return;
      if (mode === "missing") return response({ error: "unknown_file" }, 404);
      if (mode === "domain") return response({ ...file, domain_id: "99".repeat(16) });
      if (path.includes("/versions/")) return response({ ...version, manifest_ct: c.base64(new Uint8Array(32)) });
    } });
    await assert.rejects(() => r.run()); assert.equal(r.state.custody2(), null); assert.equal(r.state.data.deviceId, null);
  }
});

test("session, address, headers and root changes during readback cannot adopt", async () => {
  for (const field of ["session", "serverUrl", "edgeHeaders", "vrk"]) {
    let end;
    const r = await fixture({ reply: (_, { path, state }) => {
      if (path !== "/v1/account") return;
      if (field === "session") end(); else state.data[field] = field === "edgeHeaders" ? [{ name: "X-QA", value: "changed" }] : "changed";
    } }); end = r.end;
    await assert.rejects(() => r.run(), /device changed|session ended/);
    assert.ok(r.requests.at(-1).url.endsWith("/v1/account"), "identity change must stop before another request");
    assert.equal(r.state.data.deviceId, null); assert.equal(r.state.custody2(), null);
  }
});

test("failed local persistence cannot expose the recovered credential as live", async () => {
  const r = await fixture(); r.fail(); await assert.rejects(() => r.run());
  assert.equal(r.state.data.deviceId, null); assert.throws(() => r.state.assertAvailable());
  await assert.rejects(r.reload, error => error.reason === "pin_mismatch");
});
