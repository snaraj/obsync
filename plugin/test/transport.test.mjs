/**
 * The wire client: that every device call is signed over exactly what it
 * sends, that the three unauthenticated endpoints are the only unsigned
 * ones, that refusals are decisions and 5xx/network failures are retries,
 * and that the batched chunk reader survives ciphertext containing its own
 * multipart boundary.
 *
 * `node:crypto` verifies the signatures independently of the plugin's
 * WebCrypto path.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ApiError, Transport, parseMultipart } = require("../build/transport.js");
const c = require("../build/crypto.js");

const DEVICE_ID = "aabbccddeeff00112233445566778899";
const DEVICE_SECRET_HEX = "0f".repeat(32);
const SERVER = "https://sync.example.invalid";

function harness(responses, options = {}) {
  const sent = [];
  const queue = [...responses];
  const transport = new Transport({
    request: async (request) => {
      sent.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error("the fake server ran out of responses");
      if (next instanceof Error) throw next;
      return {
        status: next.status,
        headers: next.headers ?? {},
        text: next.text ?? "",
        arrayBuffer: next.body ?? new ArrayBuffer(0),
      };
    },
    serverUrl: () => options.serverUrl ?? SERVER,
    device: () =>
      options.unpaired ? null : { id: DEVICE_ID, secret: Uint8Array.from(Buffer.from(DEVICE_SECRET_HEX, "hex")) },
    edgeHeaders: () => options.edgeHeaders ?? [],
    now: () => 1757200000000,
    sleep: async (ms) => void slept.push(ms),
    random: () => 0.5,
    maxAttempts: options.maxAttempts ?? 3,
    log: (line) => logged.push(line),
  });
  const slept = [];
  const logged = [];
  return { transport, sent, slept, logged };
}

function expectedSignature(request, method, target, body) {
  const preimage = [
    "obsync/v1",
    method,
    target,
    request.headers["X-Obsync-Ts"],
    request.headers["X-Obsync-Nonce"],
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  return createHmac("sha256", Buffer.from(DEVICE_SECRET_HEX, "hex")).update(preimage).digest("hex");
}

test("a device call is signed over its method, target and body", async () => {
  const { transport, sent } = harness([{ status: 201, text: JSON.stringify({ seq: 9, heads: [], conflicted: false }) }]);
  const version = {
    version_id: "11".repeat(32),
    parents: [],
    sids: ["22".repeat(32)],
    bytes: 3,
    manifest_ct: "AAAA",
    manifest_nonce: "33".repeat(12),
    deleted: false,
  };
  const ack = await transport.postVersion("00".repeat(16), version);
  assert.equal(ack.seq, 9);

  const request = sent[0];
  const target = `/v1/files/${"00".repeat(16)}/versions`;
  assert.equal(request.url, SERVER + target);
  assert.equal(request.method, "POST");
  assert.equal(request.throw, false);
  assert.equal(request.headers["X-Obsync-Device"], DEVICE_ID);
  assert.equal(request.headers["X-Obsync-Ts"], "1757200000");
  assert.equal(/^[0-9a-f]{32}$/.test(request.headers["X-Obsync-Nonce"]), true, "16 random bytes as hex");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.body, JSON.stringify(version), "the signed bytes are the sent bytes");
  assert.equal(request.headers["X-Obsync-Sig"], expectedSignature(request, "POST", target, request.body));
});

test("the signature covers the query string and the exact chunk body", async () => {
  const { transport, sent } = harness([
    { status: 200, text: JSON.stringify({ seq: 4, head_seq: 4, changes: [] }) },
    { status: 201 },
  ]);
  await transport.changes(7, 900);
  const target = "/v1/changes?since=7&wait=55&limit=1000";
  assert.equal(sent[0].url, SERVER + target, "wait is clamped to the 55 s ceiling");
  assert.equal(sent[0].headers["X-Obsync-Sig"], expectedSignature(sent[0], "GET", target, Buffer.alloc(0)));

  const ciphertext = Uint8Array.from({ length: 64 }, (_, i) => i);
  const sid = createHash("sha256").update(ciphertext).digest("hex");
  await transport.putChunk(sid, ciphertext);
  assert.equal(sent[1].headers["Content-Type"], "application/octet-stream");
  assert.deepEqual(new Uint8Array(sent[1].body), ciphertext);
  assert.equal(
    sent[1].headers["X-Obsync-Sig"],
    expectedSignature(sent[1], "PUT", `/v1/chunks/${sid}`, Buffer.from(ciphertext)),
  );
});

test("only the three unauthenticated endpoints go unsigned", async () => {
  const { transport, sent } = harness([
    { status: 201, text: "{}" },
    { status: 201, text: JSON.stringify({ device_id: DEVICE_ID, device_secret: DEVICE_SECRET_HEX }) },
    { status: 200, text: JSON.stringify({ version: "0.1.0", bundle_sha256: "", styles_sha256: "" }) },
    { status: 200, text: "bundle" },
    { status: 200, text: "css" },
    { status: 200, text: JSON.stringify({ devices: [] }) },
  ]);
  await transport.setup("token", "account");
  await transport.pairingClaim("00".repeat(16), "11".repeat(32), { name: "n", platform: "linux", app_version: "0.1.0" });
  await transport.pluginManifest();
  await transport.pluginBundle();
  await transport.pluginStyles();
  await transport.devices();

  for (const request of sent.slice(0, 5)) {
    assert.equal("X-Obsync-Sig" in request.headers, false, request.url);
    assert.equal("X-Obsync-Device" in request.headers, false, request.url);
  }
  assert.equal("X-Obsync-Sig" in sent[5].headers, true, "/v1/devices is signed");
});

test("an unpaired device cannot make a signed call at all", async () => {
  const { transport, sent } = harness([{ status: 200, text: "{}" }], { unpaired: true });
  await assert.rejects(() => transport.account(), /not_paired/);
  assert.equal(sent.length, 0, "nothing was sent unsigned");
});

test("a missing server URL refuses before it reaches the network", async () => {
  const { transport, sent } = harness([], { serverUrl: "" });
  await assert.rejects(() => transport.account(), /no_server_url/);
  assert.equal(sent.length, 0);
});

test("edge service-token headers ride on every request", async () => {
  const { transport, sent } = harness([{ status: 200, text: "{}" }], {
    edgeHeaders: [
      { name: "X-Service-Id", value: "id-value" },
      { name: "X-Service-Secret", value: "secret-value" },
    ],
  });
  await transport.account();
  assert.equal(sent[0].headers["X-Service-Id"], "id-value");
  assert.equal(sent[0].headers["X-Service-Secret"], "secret-value");
});

test("a 4xx is a decision: it is reported and never retried", async () => {
  const { transport, sent, logged } = harness([
    { status: 409, text: JSON.stringify({ error: "missing_chunks", detail: "2 chunks are absent" }) },
  ]);
  await assert.rejects(
    () => transport.postVersion("00".repeat(16), { version_id: "", parents: [], sids: [], bytes: 0, manifest_ct: "", manifest_nonce: "", deleted: false }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "missing_chunks");
      assert.equal(error.detail, "2 chunks are absent");
      return true;
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(logged.some((line) => line.includes("decision=refused") && line.includes("code=missing_chunks")), true);
});

test("a non-JSON refusal from an edge is still reported, not swallowed", async () => {
  const { transport } = harness([{ status: 403, text: "<html>denied</html>" }]);
  await assert.rejects(() => transport.account(), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, "error");
    assert.ok(error.detail.includes("denied"));
    return true;
  });
});

test("5xx and network failures retry with capped, jittered backoff", async () => {
  const { transport, sent, slept } = harness([
    { status: 503, text: "" },
    new Error("network is unreachable"),
    { status: 200, text: JSON.stringify({ account_id: "a", name: "n", used_bytes: 0, quota_bytes: 0, device_count: 1 }) },
  ]);
  const account = await transport.account();
  assert.equal(account.account_id, "a");
  assert.equal(sent.length, 3);
  assert.deepEqual(slept, [750, 1500], "1 s then 2 s, half fixed and half jittered");

  assert.equal(transport.backoffMs(1), 750);
  assert.equal(transport.backoffMs(2), 1500);
  assert.equal(transport.backoffMs(20), 45000, "capped at 60 s before jitter");
  const jittered = new Transport({
    request: async () => ({ status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }),
    serverUrl: () => SERVER,
    device: () => null,
    edgeHeaders: () => [],
    random: () => 0,
  });
  assert.equal(jittered.backoffMs(1), 500, "the fixed half is always present");
  assert.equal(jittered.backoffMs(99), 30000);
});

test("retries give up after maxAttempts and say so", async () => {
  const { transport, sent, logged } = harness([{ status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(() => transport.account(), /unreachable/);
  assert.equal(sent.length, 3);
  assert.equal(logged.some((line) => line.includes("decision=gave_up")), true);
});

test("existence checks are batched at the protocol's ceiling", async () => {
  const sids = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(64, "0"));
  const { transport, sent } = harness([
    { status: 200, text: JSON.stringify({ missing: [sids[0]] }) },
    { status: 200, text: JSON.stringify({ missing: [sids[4999]] }) },
  ]);
  const missing = await transport.missingChunks(sids);
  assert.equal(sent.length, 2, "4096 per request");
  assert.equal(JSON.parse(sent[0].body).sids.length, 4096);
  assert.equal(JSON.parse(sent[1].body).sids.length, 904);
  assert.deepEqual(missing, [sids[0], sids[4999]]);
});

test("the multipart reader uses Content-Length, not the boundary bytes", () => {
  const boundary = "obsyncpart";
  // A body that contains the boundary marker, as ciphertext eventually will.
  const trap = Buffer.concat([Buffer.from("--obsyncpart\r\n"), Buffer.from([0x00, 0xff, 0x10])]);
  const document = Buffer.concat([
    Buffer.from(`--${boundary}\r\nX-Obsync-Sid: ${"11".repeat(32)}\r\nContent-Length: ${trap.length}\r\n\r\n`),
    trap,
    Buffer.from(`\r\n--${boundary}\r\nX-Obsync-Sid: ${"22".repeat(32)}\r\nX-Obsync-Missing: 1\r\nContent-Length: 0\r\n\r\n`),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parts = parseMultipart(new Uint8Array(document), boundary);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].sid, "11".repeat(32));
  assert.equal(parts[0].missing, false);
  assert.deepEqual(Buffer.from(parts[0].body), trap);
  assert.equal(parts[1].missing, true);
  assert.equal(parts[1].body.length, 0);
});

test("a batched chunk fetch maps parts back to nulls for missing sids", async () => {
  const boundary = "b0undary";
  const first = Buffer.from([1, 2, 3, 4]);
  const document = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Length: ${first.length}\r\n\r\n`),
    first,
    Buffer.from(`\r\n--${boundary}\r\nX-Obsync-Missing: 1\r\nContent-Length: 0\r\n\r\n`),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const { transport } = harness([
    {
      status: 200,
      headers: { "content-type": `multipart/mixed; boundary="${boundary}"` },
      body: document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength),
    },
  ]);
  const bodies = await transport.getChunks(["11".repeat(32), "22".repeat(32)]);
  assert.deepEqual(Buffer.from(bodies[0]), first);
  assert.equal(bodies[1], null);
});

test("a multipart response without a boundary is refused", async () => {
  const { transport } = harness([{ status: 200, headers: { "content-type": "application/json" }, text: "{}" }]);
  await assert.rejects(() => transport.getChunks(["11".repeat(32)]), /bad_multipart/);
});

test("the change feed walks forward and stops when told", async () => {
  const { transport } = harness([
    { status: 200, text: JSON.stringify({ seq: 3, head_seq: 5, changes: [{ seq: 3 }] }) },
    { status: 200, text: JSON.stringify({ seq: 5, head_seq: 5, changes: [{ seq: 5 }] }) },
  ]);
  const seen = [];
  let rounds = 0;
  for await (const page of transport.changeFeed(0, () => rounds < 2)) {
    rounds++;
    seen.push(page.seq);
  }
  assert.deepEqual(seen, [3, 5]);
});

test("body hashing is the protocol's, including the empty body", async () => {
  assert.equal(
    await c.bodyHash(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
