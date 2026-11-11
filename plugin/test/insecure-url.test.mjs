/**
 * Plain HTTP is refused at the transport and at the adapter, not only in
 * Settings, and an address that does not parse is refused, never passed on.
 *
 * The Server URL row refused a non-loopback `http://` address (#136), but the
 * state loaded any address it found and every request went to it: an address
 * saved before that rule, or edited in the data file, sent the device's
 * signature and a pairing or setup token across the network in the clear.
 * The first repair judged the BASE and let what did not parse through: a held
 * `http://` became the base `http:`, and `http:` + `/v1/setup` is
 * `http:/v1/setup`, which a URL parser reads as `http://v1/setup` -- plain
 * HTTP to a host nobody typed (review of #388, finding 1). One rule, failing
 * closed, now judges what Settings saves, what a load finds, the base and the
 * whole URL of every request, and the URL the adapter is handed
 * (`addressRefusal`, `transport.ts`).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { KEYS, memorySecrets, sandbox, statusItem } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { INSECURE_SERVER_URL, MALFORMED_SERVER_URL, Transport, addressRefusal, serverUrlRefusal } = require("../build/transport.js");
const { fetchHttp } = require("../build/fetchHttp.js");
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

/** A transport over a request function that records every request and answers 200, and counts each read of the device secret. */
function transport(serverUrl, isMobile, sent = []) {
  const request = async (call) => { sent.push(call.url); return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(2) }; };
  const logs = [], secret = { reads: 0 };
  const t = new Transport({ request, serverUrl: () => serverUrl, isMobile, device: () => { secret.reads++; return { id: "11".repeat(16), secret: new Uint8Array(32) }; },
    edgeHeaders: () => [], log: (line) => logs.push(line), maxAttempts: 1, sleep: async () => {} });
  return { t, sent, logs, secret };
}

test("the transport judges an address exactly as the Server URL row does, on a desktop and on a phone", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { normalizeServerUrl } = box.require(join(box.home, "build/ui/settings.js"));
  for (const isMobile of [false, true]) {
    for (const url of [...ACROSS, ...LOOPBACK, ...SECURE]) {
      const saved = normalizeServerUrl(url);
      assert.equal(addressRefusal(url, isMobile) === null, serverUrlRefusal(saved, isMobile) === null, `${url} on ${isMobile ? "a phone" : "a desktop"}`);
    }
  }
  // What does not parse as an http(s) address is refused by the same rule, in Settings too: never passed along.
  for (const url of ["ftp://sync.example.test", "not a url", "javascript:alert(1)", "http:", "https:", "//sync.example.test"]) {
    assert.equal(addressRefusal(url, false), "malformed", url);
    assert.notEqual(serverUrlRefusal(url, false), null, url);
  }
  assert.equal(serverUrlRefusal("", false), null, "an empty address is not configured, not refused");
});

/**
 * Stored bases that are not a whole http(s) address, each with the code its
 * refusal carries. `http://` and `http:/` lose their slashes to the base's
 * trim and become `http:`; the backslash forms parse, as plain HTTP to
 * another computer; the trailing space parses as a base and not as a URL.
 */
const MALFORMED = [
  ["http:", "malformed"], ["http:/", "malformed"], ["http://", "malformed"], ["http:// ", "malformed"], ["http://\t", "malformed"],
  ["http:\\\\lan.example.test", "insecure"], ["http:/\\\\lan.example.test", "insecure"], ["//lan.example.test", "malformed"],
  ["http://:8080", "malformed"], ["HTTP:", "malformed"], ["HTTP://", "malformed"], ["Http:\\\\lan.example.test", "insecure"],
  ["https:", "malformed"], ["https:/", "malformed"], ["HTTPS://", "malformed"], ["https://sync.example.test ", "malformed"],
  ["https://user:pw@sync.example.test", "malformed"],
];
const PROFILE = { name: "Test", platform: "linux", app_version: "test" };
/** A setup, a pairing claim and a signed sync read: the three kinds of request a stored base is used for. */
const ROUTES = [
  ["setup", (t) => t.setup("22".repeat(32), "Synthetic", PROFILE)],
  ["pairing", (t) => t.pairingClaim2("33".repeat(16), "44".repeat(32), { ...PROFILE, vault: { envelope: "AA", nonce: "AA" }, claimant_pub: "AA" })],
  ["signed sync", (t) => t.changes(0, 0)],
];

test("a stored base that is not a whole http(s) address sends nothing, for a setup, a pairing and a signed request, on a desktop and a phone (#388 review)", async () => {
  for (const isMobile of [false, true]) {
    for (const [base, kind] of MALFORMED) {
      for (const [name, call] of ROUTES) {
        const { t, sent, logs, secret } = transport(base, isMobile);
        const outcome = await call(t).then(() => null, (error) => error);
        assert.deepEqual(sent, [], `${JSON.stringify(base)} ${name} on ${isMobile ? "a phone" : "a desktop"}: a request left the device`);
        assert.equal(secret.reads, 0, `${JSON.stringify(base)} ${name}: the device secret was read for a request refused before it`);
        assert.equal(outcome?.code, `${kind}_server_url`, `${JSON.stringify(base)} ${name}: ${outcome?.message}`);
        assert.equal(outcome.detail, kind === "insecure" ? INSECURE_SERVER_URL : MALFORMED_SERVER_URL);
        assert.deepEqual(logs, [`http decision=refused reason=${kind}_server_url`], logs.join(" | "));
      }
    }
  }
});

test("a whole https address, and loopback HTTP on a desktop, are still sent for every route; loopback HTTP on a phone is not", async () => {
  const LOOPS = ["http://localhost", "http://localhost:8080", "http://127.0.0.1", "http://127.0.0.1:8080", "http://[::1]", "http://[::1]:8080", "HTTP://LOCALHOST:8080"];
  for (const [name, call] of ROUTES) {
    for (const [base, isMobile] of [...LOOPS.map((url) => [url, false]), ...SECURE.flatMap((url) => [[url, false], [url, true]])]) {
      const { t, sent } = transport(base, isMobile);
      await call(t).catch(() => {});
      assert.equal(sent.length, 1, `${base} ${name} on ${isMobile ? "a phone" : "a desktop"} was not sent`);
      assert.equal(new URL(sent[0]).host, new URL(base).host, sent[0]);
    }
    for (const base of LOOPS) {
      const { t, sent } = transport(base, true);
      await assert.rejects(call(t), (error) => error.code === "insecure_server_url");
      assert.deepEqual(sent, [], `${base} ${name} on a phone`);
    }
  }
});

test("for every base a table of schemes, slashes and hosts makes, a request is either refused or goes over https or desktop loopback to the host the base names", async () => {
  const schemes = ["http:", "HTTP:", "https:", "hTtPs:", ""];
  const separators = ["", "/", "//", "///", "\\\\", "/\\\\", "\\\\/", " //"];
  const hosts = ["", " ", "lan.example.test", "localhost:8080", ":8080", "@lan.example.test", "127.0.0.1", "[::1]", "lan.example.test ", "v1"];
  let refused = 0, sentTotal = 0;
  for (const isMobile of [false, true]) {
    for (const scheme of schemes) for (const separator of separators) for (const host of hosts) {
      const base = scheme + separator + host;
      for (const [name, call] of ROUTES) {
        const { t, sent } = transport(base, isMobile);
        await call(t).catch(() => {});
        if (sent.length === 0) { refused++; continue; }
        sentTotal++;
        // DISPATCHED: so the base was a whole address, and the URL sent goes where it says.
        const label = `${JSON.stringify(base)} ${name} on ${isMobile ? "a phone" : "a desktop"} went to ${sent[0]}`;
        const parsed = (url) => { try { return new URL(url); } catch { return null; } };
        const named = parsed(base.replace(/\/+$/, ""));
        assert.ok(named !== null, `${label}, from a base that is not a whole address`);
        const went = new URL(sent[0]);
        assert.equal(went.origin, named.origin, label);
        assert.ok(went.protocol === "https:" || (!isMobile && ["localhost", "127.0.0.1", "[::1]"].includes(went.hostname)), label);
      }
    }
  }
  // Not vacuous, and pinned: 400 bases x 3 routes x 2 platforms, of which
  // these many were refused and these many went to a whole address.
  assert.deepEqual({ refused, sent: sentTotal }, { refused: 1770, sent: 630 });
});

test("the adapter itself refuses plain HTTP that leaves this computer, and what does not parse, whoever built the URL", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(url); return new Response("{}", { status: 200 }); };
  const call = (url, isMobile) => fetchHttp({ url, method: "POST", headers: {}, body: "{}", throw: false }, isMobile);
  for (const [url, isMobile] of [
    ["http:/v1/setup", false], ["http:/v1/setup", true], ["http://lan.example.test/v1/setup", false], ["http://localhost:8080/v1/setup", true],
    ["HTTP://lan.example.test/v1/setup", false], ["//lan.example.test/v1/setup", false], ["http://:8080/v1/setup", false],
  ]) {
    await assert.rejects(call(url, isMobile), TypeError, url);
    assert.deepEqual(fetched, [], `${url} on ${isMobile ? "a phone" : "a desktop"} reached fetch`);
  }
  for (const [url, isMobile] of [["https://sync.example.test/v1/setup", true], ["https://sync.example.test/v1/setup", false], ["http://localhost:8080/v1/setup", false]]) {
    await call(url, isMobile);
    assert.equal(fetched.at(-1), url);
  }
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

test("a refused address is said in the same words wherever a refusal is worded: the status, and a setup or pairing", () => {
  const { ApiError } = require("../build/transport.js");
  const { refusalStatus } = require("../build/sync/engine.js");
  const { refusalFor } = require("../build/pairing.js");
  for (const [code, text] of [["insecure_server_url", INSECURE_SERVER_URL], ["malformed_server_url", MALFORMED_SERVER_URL]]) {
    assert.deepEqual(refusalStatus(new ApiError(0, code, text)), { kind: "error", code: "server_url", message: text }, code);
    assert.equal(refusalFor(code), text, code);
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
  const requests = [], platforms = [];
  box.require(join(box.home, "build/fetchHttp.js")).fetchHttp = async (request, isMobile) => {
    requests.push(request.url);
    platforms.push(isMobile);
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
  instance.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: { on: () => ({}), getLeavesOfType: () => [], getActiveViewOfType: () => null, onLayoutReady: (listed) => listed() } };
  instance.manifest = { version: "1.1.13" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  t.after(() => instance.onunload());
  const { State } = box.require(join(box.home, "build/state.js")), c = box.require(join(box.home, "build/crypto.js"));
  const admitted = await State.open(instance, false, instance.app.secretStorage);
  await admitted.stageEnrollment2(KEYS.vrk, "pair");
  await admitted.adoptSuite2({ root: KEYS.vrk, generation: (await c.domainMapIds(await c.deriveDomainMapKey(c.unhex(KEYS.vrk)))).fileId,
    deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, purpose: "pair" });
  return { obsidian, instance, requests, platforms, bar, logs };
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

test("a paired device that loads an address that is not a whole http(s) address says so once, asks for it again, and sends nothing (#388 review)", async (t) => {
  for (const url of ["http://", "https:", "//lan.example.test"]) {
    const p = await plugin(t, url);
    await p.instance.onload();
    await p.instance.restartEngine();
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(p.requests, [], `${url}: a request left the device`);
    assert.ok(p.logs.includes("state decision=refused reason=malformed_server_url"), p.logs.join(" | "));
    assert.ok(p.logs.includes("http decision=refused reason=malformed_server_url"), "the transport did not refuse it");
    const said = p.obsidian.notices.filter((text) => text.includes("not a complete web address"));
    assert.deepEqual(said, [`obsync: t${MALFORMED_SERVER_URL.slice(1)}`], p.obsidian.notices.join(" | "));
    assert.match(MALFORMED_SERVER_URL, /Enter your server's https address again/);
    assert.equal(p.instance.statusText(), `error — ${MALFORMED_SERVER_URL}`);
  }
});

test("the plugin hands the adapter the platform it runs on, so the last hop judges a phone as a phone", async (t) => {
  for (const mobile of [false, true]) {
    const p = await plugin(t, "https://sync.example.test");
    const platform = p.obsidian.Platform.isMobile;
    p.obsidian.Platform.isMobile = mobile;
    t.after(() => { p.obsidian.Platform.isMobile = platform; });
    await p.instance.onload();
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(p.platforms.length > 0, `nothing reached the adapter: ${p.logs.join(" | ")}`);
    assert.ok(p.platforms.every((isMobile) => isMobile === mobile), `${mobile ? "a phone" : "a desktop"}: ${JSON.stringify(p.platforms)}`);
  }
});

test("a device with no Server URL yet loads without either notice: an empty address is not configured, not refused", async (t) => {
  const p = await plugin(t, "");
  await p.instance.onload();
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(!p.obsidian.notices.some((text) => text.includes("Server URL is")), p.obsidian.notices.join(" | "));
  assert.ok(!p.logs.some((line) => /state decision=refused reason=(malformed|insecure)_server_url/.test(line)), p.logs.join(" | "));
  assert.deepEqual(p.requests, []);
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
