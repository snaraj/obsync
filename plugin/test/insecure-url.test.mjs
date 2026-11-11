/**
 * Plain HTTP is refused at the transport, not only in Settings.
 *
 * The Server URL row refused a non-loopback `http://` address (#136), but the
 * state loaded any address it found and every request went to it: an address
 * saved before that rule, or edited in the data file, sent the device's
 * signature and a pairing or setup token across the network in the clear.
 * One predicate now judges the address Settings saves, the one a load finds,
 * and every request (`insecureServerUrl`, `transport.ts`).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { KEYS, memorySecrets, sandbox, statusItem } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { INSECURE_SERVER_URL, Transport, insecureServerUrl, serverUrlRefusal } = require("../build/transport.js");
const clone = (value) => structuredClone(value);
const tick = () => new Promise(setImmediate);

/** Plain HTTP that leaves this computer, as Settings refuses it and as a data file may still hold it. */
const ACROSS = [
  "http://lan.example.test:8080", "http://10.0.0.1:8080", "HTTP://LAN.example.test", "http://lan.example.test:8080/",
  "http://lan.example.test/obsync", "http://localhost.example.test:8080", "http://127.0.0.1.example.test", "http://user@lan.example.test",
];
/** Plain HTTP to this computer itself, which Settings takes on a desktop. */
const LOOPBACK = ["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080", "http://127.1.2.3", "http://localhost:8080/"];
const SECURE = ["https://sync.example.test", "https://sync.example.test:8443/", "Https://sync.example.test"];

/** A transport over a request function that records every request and answers 200. */
function transport(serverUrl, isMobile, sent = []) {
  const request = async (call) => { sent.push(call.url); return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(2) }; };
  const logs = [];
  const t = new Transport({ request, serverUrl: () => serverUrl, isMobile, device: () => ({ id: "11".repeat(16), secret: new Uint8Array(32) }),
    edgeHeaders: () => [], log: (line) => logs.push(line), maxAttempts: 1, sleep: async () => {} });
  return { t, sent, logs };
}

test("the transport judges an address exactly as the Server URL row does, on a desktop and on a phone", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { normalizeServerUrl } = box.require(join(box.home, "build/ui/settings.js"));
  for (const isMobile of [false, true]) {
    for (const url of [...ACROSS, ...LOOPBACK, ...SECURE]) {
      const saved = normalizeServerUrl(url);
      const settingsRefuses = saved.startsWith("http://") && serverUrlRefusal(saved, isMobile) !== null;
      assert.equal(insecureServerUrl(url, isMobile), settingsRefuses, `${url} on ${isMobile ? "a phone" : "a desktop"}`);
    }
  }
  // Not this rule's to refuse: fetchHttp refuses what is not HTTP(S) or does not parse, with its own words.
  for (const url of ["", "ftp://sync.example.test", "not a url", "javascript:alert(1)"]) assert.equal(insecureServerUrl(url, false), false, url);
});

test("a plain HTTP address that leaves this computer is refused before any request, for every route (#136)", async () => {
  for (const isMobile of [false, true]) {
    for (const url of [...ACROSS, ...(isMobile ? LOOPBACK : [])]) {
      const { t, sent, logs } = transport(url, isMobile);
      for (const call of [() => t.account(), () => t.changes(0), () => t.setup("22".repeat(32), "Synthetic", { name: "Test", platform: "linux", app_version: "test" })]) {
        await assert.rejects(call(), (error) => {
          assert.equal(error.code, "insecure_server_url", `${url}: ${error.message}`);
          assert.equal(error.detail, INSECURE_SERVER_URL);
          return true;
        });
      }
      assert.deepEqual(sent, [], `${url} on ${isMobile ? "a phone" : "a desktop"}: a request left the device`);
      assert.ok(logs.length > 0 && logs.every((line) => line === "http decision=refused reason=insecure_server_url"), logs.join(" | "));
      assert.ok(logs.every((line) => !line.includes("example.test") && !line.includes("10.0.0.1")), "the address reached the log");
    }
  }
});

test("loopback on a desktop, and https everywhere, are sent as before", async () => {
  for (const [url, isMobile] of [...LOOPBACK.map((url) => [url, false]), ...SECURE.flatMap((url) => [[url, false], [url, true]])]) {
    const { t, sent } = transport(url, isMobile);
    await t.account().catch(() => {});
    assert.equal(sent.length, 1, `${url} on ${isMobile ? "a phone" : "a desktop"} was not sent`);
    assert.ok(sent[0].endsWith("/v1/account"), sent[0]);
  }
});

// ---- the compiled plugin ------------------------------------------------------

/**
 * The compiled plugin over an admitted suite2 vault holding `serverUrl`, every
 * request that reaches the platform recorded. The engine is a stand-in whose
 * start makes the first request a real one does, through the real transport.
 */
async function plugin(t, serverUrl) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const requests = [];
  box.require(join(box.home, "build/fetchHttp.js")).fetchHttp = async (request) => {
    requests.push(request.url);
    return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(2) };
  };
  box.require(join(box.home, "build/sync/engine.js")).SyncEngine = class {
    constructor(options) { this.options = options; }
    reachability() {}
    async start() { await this.options.transport.account(); }
    stop() {}
    async stopAndWait() {}
    async syncNow() {}
    wake() {}
    current() { return { kind: "idle" }; }
  };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const instance = new Plugin();
  const load = instance.onload.bind(instance);
  instance.onload = async () => { await load(); await instance.firstStart; };
  let metadata = { vrk: null, deviceId: null, deviceSecret: null, serverUrl, edgeHeaders: [] };
  const bar = statusItem(), logs = [];
  instance.loadData = async () => clone(metadata);
  instance.saveData = async (value) => { metadata = clone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => bar;
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed() } };
  instance.manifest = { version: "1.1.13" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  t.after(() => instance.onunload());
  const { State } = box.require(join(box.home, "build/state.js")), c = box.require(join(box.home, "build/crypto.js"));
  const admitted = await State.open(instance, false, instance.app.secretStorage);
  await admitted.stageEnrollment2(KEYS.vrk, "pair");
  await admitted.adoptSuite2({ root: KEYS.vrk, generation: (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(KEYS.vrk)))).fileId,
    deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, purpose: "pair" });
  return { obsidian, instance, requests, bar, logs };
}

test("a paired device that loads a plain HTTP address says so once, keeps saying it in the status, and sends nothing", async (t) => {
  const p = await plugin(t, "http://lan.example.test:8080");
  await p.instance.onload();
  await p.instance.restartEngine();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(p.requests, [], "a request left the device");
  assert.ok(p.logs.includes("state decision=refused reason=insecure_server_url"), p.logs.join(" | "));
  assert.ok(p.logs.includes("http decision=refused reason=insecure_server_url"), "the transport did not refuse it");
  const said = p.obsidian.notices.filter((text) => text.includes("plain HTTP"));
  assert.deepEqual(said, [`obsync: t${INSECURE_SERVER_URL.slice(1)}`], p.obsidian.notices.join(" | "));
  assert.equal(p.instance.statusText(), `error — ${INSECURE_SERVER_URL}`);
  assert.ok(!p.logs.some((line) => line.includes("lan.example.test")), "the address reached the log");
});

test("a paired desktop on loopback HTTP, and one on https, load without that notice and do send", async (t) => {
  for (const url of ["http://127.0.0.1:8080", "https://sync.example.test"]) {
    const p = await plugin(t, url);
    await p.instance.onload();
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(!p.obsidian.notices.some((text) => text.includes("plain HTTP")), `${url}: ${p.obsidian.notices.join(" | ")}`);
    assert.ok(!p.logs.some((line) => line.includes("insecure_server_url")), url);
    assert.deepEqual(p.requests, [`${url}/v1/account`]);
    assert.notEqual(p.instance.statusText(), `error — ${INSECURE_SERVER_URL}`);
  }
});
