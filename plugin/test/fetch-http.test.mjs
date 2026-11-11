/** Fetch adapter bytes/options and real loopback redirect counters; Node is not browser CORS proof. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
const require = createRequire(import.meta.url);
const { fetchHttp } = require("../build/fetchHttp.js");
const { Transport } = require("../build/transport.js");

const headers = { "Content-Type": "application/json", Authorization: "Bearer SYNTHETIC_AUTH", "X-Obsync-Device": "11".repeat(16), "X-Obsync-Sig": "22".repeat(32), "X-Service-Id": "SYNTHETIC_ID", "X-Service-Secret": "SYNTHETIC_EDGE", "X-Access-Id": "SYNTHETIC_ACCESS", "CF-Access-Client-Id": "SYNTHETIC_CF_ID", "CF-Access-Client-Secret": "SYNTHETIC_CF_SECRET" };
const request = (body) => ({ url: "https://fixture.example.invalid/v1/setup", method: "POST", headers, ...(body === undefined ? {} : { body }), throw: false });

test("adapter pins redirect/CORS/ambient-credential/cache policy and preserves JSON and binary bodies", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const sent = [], received = new Uint8Array([0, 255, 128, 10, 65]);
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options });
    return { status: 403, headers: new Headers({ "Content-Type": "application/octet-stream" }), arrayBuffer: async () => { reads++; return received.buffer; } };
  };
  const json = '{"sentinel":"café\\nJSON"}';
  for (const body of [json, new Uint8Array([0, 128, 255]).buffer, undefined]) {
    const found = await fetchHttp(request(body), false);
    assert.equal(found.status, 403, "a refusal remains data for Transport");
    assert.equal(found.headers["content-type"], "application/octet-stream");
    assert.equal(found.arrayBuffer, received.buffer);
    assert.equal(found.text, new TextDecoder().decode(received));
    const call = sent.at(-1);
    assert.equal(call.url, request(body).url);
    assert.deepEqual(call.options, { method: "POST", headers, ...(body === undefined ? {} : { body }), redirect: "error", credentials: "omit", mode: "cors", cache: "no-store", referrerPolicy: "no-referrer" });
    assert.equal(Object.hasOwn(call.options, "body"), body !== undefined);
  }
  assert.equal(reads, 3, "one buffered read supplies both views per answer");
});

test("fetch and body failures propagate unchanged without inventing a redirect reason or falling back", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const refused = new TypeError("Failed to fetch");
  globalThis.fetch = async () => { throw refused; };
  await assert.rejects(fetchHttp(request("SYNTHETIC"), false), error => error === refused);
  const broken = new TypeError("synthetic body interrupted");
  globalThis.fetch = async () => ({ status: 200, arrayBuffer: async () => { throw broken; }, headers: new Headers() });
  await assert.rejects(fetchHttp(request(), false), error => error === broken);
});

async function listening(t, answer) {
  const server = createServer(answer);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("real Node fetch refuses five cross-origin and same-origin redirects before a destination request", async t => {
  const body = Buffer.from('{"synthetic":"JSON and credential body café"}');
  const seen = []; let destinations = 0;
  const destination = await listening(t, (req, res) => { destinations++; res.end("destination"); });
  let source;
  source = await listening(t, (req, res) => {
    const chunks = []; req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/destination") { destinations++; res.end("destination"); return; }
      const [, status, where] = req.url.split("/");
      if (status === "200") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.from([0, 255, 128, 13, 10])); }
      else { res.writeHead(Number(status), { Location: where === "same" ? source + "/destination" : destination + "/destination" }); res.end(); }
    });
  });
  for (const status of [301, 302, 303, 307, 308]) for (const where of ["same", "cross"]) {
    const before = seen.length;
    await assert.rejects(fetchHttp({ ...request(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)), url: `${source}/${status}/${where}` }, false), TypeError);
    assert.equal(seen.length, before + 1, "one original request, no Location request");
    assert.equal(destinations, 0, `${status} ${where}: destination received nothing`);
    assert.equal(seen.at(-1).method, "POST");
    assert.deepEqual(seen.at(-1).body, body);
    for (const [name, value] of Object.entries(headers)) assert.equal(seen.at(-1).headers[name.toLowerCase()], value);
  }
  for (const body of ['{"synthetic":"JSON café\\nline"}', new Uint8Array([0, 255, 128]).buffer]) {
    const contentType = typeof body === "string" ? "application/json" : "application/octet-stream";
    const response = await fetchHttp({ ...request(body), headers: { ...headers, "Content-Type": contentType }, url: `${source}/200/control` }, false);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(response.arrayBuffer), Buffer.from([0, 255, 128, 13, 10]));
    assert.deepEqual(seen.at(-1).body, Buffer.from(body));
    assert.equal(seen.at(-1).headers["content-type"], contentType);
  }
  assert.equal(destinations, 0);
});

test("adapter failures retain bounded freshly signed retries and setup one-shot lost ambiguity", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const sent = [];
  globalThis.fetch = async (url, options) => { sent.push({ url, options }); throw new TypeError("Failed to fetch"); };
  const transport = new Transport({ request: (call) => fetchHttp(call, false), serverUrl: () => "https://fixture.example.invalid", device: () => ({ id: "11".repeat(16), secret: new Uint8Array(32) }), edgeHeaders: () => [], log() {}, maxAttempts: 2, sleep: async () => {} });
  await assert.rejects(transport.account(), error => error.code === "unreachable");
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].options.headers["X-Obsync-Nonce"], sent[1].options.headers["X-Obsync-Nonce"]);
  const before = sent.length;
  const outcome = await transport.setup("22".repeat(32), "Synthetic", { name: "Test", platform: "linux", app_version: "test" });
  assert.equal(outcome.outcome, "lost");
  assert.equal(sent.length, before + 1);
  assert.deepEqual(JSON.parse(sent.at(-1).options.body), { setup_token: "22".repeat(32), account_name: "Synthetic", device: { name: "Test", platform: "linux", app_version: "test" } });
  assert.ok(!outcome.reason.includes("redirect"), "generic fetch failure is not a redirect diagnosis");
});


test("legacy invalid or credential-bearing URLs refuse before fetch with value-free diagnostics", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const sent = [], marker = "SYNTHETIC_URL_SECRET";
  globalThis.fetch = async (url, options) => {
    sent.push({ url, options });
    return new Response("{}", { status: 200 });
  };
  const ADAPTER = "obsync refused the server URL; use HTTPS, or plain HTTP only to this computer, without URL credentials.";
  for (const base of [
    `https://fixture-user:${marker}@fixture.example.invalid`,
    // Loopback, so the plain-HTTP half of the rule passes it and its credentials are what it refuses.
    `http://${marker}@127.0.0.1:8888`,
    `https://:${marker}@fixture.example.invalid`,
    `javascript:${marker}`, `data:text/plain,${marker}`,
    `http://[${marker}`, `${marker} invalid URL`,
  ]) {
    // The transport refuses it as not a whole address, before a signature or this adapter (`addressRefusal`).
    const rows = [];
    const transport = new Transport({ request: (call) => fetchHttp(call, false), serverUrl: () => base, device: () => ({ id: "11".repeat(16), secret: new Uint8Array(32) }), edgeHeaders: () => [], log: row => rows.push(row), maxAttempts: 1 });
    await assert.rejects(transport.account(), error => {
      assert.equal(error.status, 0);
      assert.equal(error.code, "malformed_server_url");
      assert.ok(!error.message.includes(marker) && !error.detail.includes(marker));
      return true;
    });
    // Nothing was sent, so a setup is refused outright rather than counted as lost.
    await assert.rejects(transport.setup("22".repeat(32), "Synthetic", { name: "Test", platform: "linux", app_version: "test" }), error => error.code === "malformed_server_url");
    assert.deepEqual(rows, ["http decision=refused reason=malformed_server_url", "http decision=refused reason=malformed_server_url"]);
    // And the adapter, handed the same address by a caller that skipped the transport, refuses it too.
    await assert.rejects(fetchHttp({ ...request("{}"), url: `${base}/v1/setup` }, false), error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, ADAPTER);
      return true;
    });
    assert.equal(sent.length, 0, "the fetch surface received no invalid URL");
  }
  // Plain HTTP across the network is the transport's own refusal, before this adapter or a signature (`insecureServerUrl`).
  {
    const rows = [];
    const transport = new Transport({ request: (call) => fetchHttp(call, false), serverUrl: () => `http://${marker}@fixture.example.invalid`, device: () => ({ id: "11".repeat(16), secret: new Uint8Array(32) }), edgeHeaders: () => [], log: row => rows.push(row), maxAttempts: 1 });
    await assert.rejects(transport.account(), error => error.code === "insecure_server_url" && !error.message.includes(marker) && !error.detail.includes(marker));
    await assert.rejects(transport.setup("22".repeat(32), "Synthetic", { name: "Test", platform: "linux", app_version: "test" }), error => error.code === "insecure_server_url");
    assert.deepEqual(rows, ["http decision=refused reason=insecure_server_url", "http decision=refused reason=insecure_server_url"]);
    assert.equal(sent.length, 0);
  }
  // Validate without rewriting the URL or its query/path/body bytes.
  for (const url of ["https://fixture.example.invalid/base/path?query=unchanged", "http://127.0.0.1:8888/base?query=unchanged"]) {
    const body = '{"synthetic":"exact bytes"}';
    await fetchHttp({ ...request(body), url }, false);
    assert.equal(sent.at(-1).url, url);
    assert.equal(sent.at(-1).options.body, body);
  }
  const transport = new Transport({ request: (call) => fetchHttp(call, false), serverUrl: () => "https://fixture.example.invalid/base?query=unchanged", device: () => ({ id: "11".repeat(16), secret: new Uint8Array(32) }), edgeHeaders: () => [], log() {}, maxAttempts: 1 });
  await transport.account();
  assert.equal(sent.at(-1).url, "https://fixture.example.invalid/base?query=unchanged/v1/account");
});
