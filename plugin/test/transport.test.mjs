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
const { ApiError, Transport, parseMultipart, routeFor } = require("../build/transport.js");
const c = require("../build/crypto.js");

const DEVICE_ID = "aabbccddeeff00112233445566778899";
const DEVICE_SECRET_HEX = "0f".repeat(32);
const SERVER = "https://sync.example.invalid";
const PAIRING_ID = "00".repeat(16);
const FILE_ID = "44".repeat(16);
const SID = "55".repeat(32);
const INFO = { name: "n", platform: "linux", app_version: "0.1.0" };
const VERSION_POST = {
  version_id: "11".repeat(32),
  parents: [],
  sids: [],
  bytes: 0,
  domain_id: "66".repeat(16),
  manifest_ct: "AAAA",
  manifest_nonce: "33".repeat(12),
  deleted: false,
};

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

test("heartbeat and device policy updates use the server's v1 fields without changing name-only updates", async () => {
  const { transport, sent } = harness([{ status: 204 }, { status: 200, text: "{}" }, { status: 200, text: "{}" }]);
  const policy = { perFileMaxBytes: 536870912, totalBudgetBytes: 53687091200 };
  const wire = { per_file_max_bytes: 536870912, total_budget_bytes: 53687091200 };
  assert.equal((await transport.heartbeat("0.1.15", policy)).outcome, "ok");
  assert.equal((await transport.patchDevice(DEVICE_ID, { name: "Tablet", policy })).outcome, "ok");
  assert.equal((await transport.patchDevice(DEVICE_ID, { name: "Desktop" })).outcome, "ok");
  assert.deepEqual(sent.map((request) => JSON.parse(request.body)), [
    { app_version: "0.1.15", policy: wire }, { name: "Tablet", policy: wire }, { name: "Desktop" },
  ]);
  for (const request of sent) {
    assert.equal(request.headers["X-Obsync-Sig"], expectedSignature(request, request.method,
      request.url.slice(SERVER.length), request.body));
  }
});

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
  assert.equal(ack.outcome, "ok", "a version post that was answered is not lost");
  assert.deepEqual(ack.value.heads, []);

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
    { status: 201, text: JSON.stringify({ account_id: "a", device_id: DEVICE_ID, device_secret: DEVICE_SECRET_HEX }) },
    { status: 201, text: JSON.stringify({ device_id: DEVICE_ID, device_secret: DEVICE_SECRET_HEX }) },
    { status: 200, text: JSON.stringify({ version: "0.1.0", bundle_sha256: "", styles_sha256: "" }) },
    { status: 200, text: JSON.stringify({ devices: [] }) },
  ]);
  const enrolled = await transport.setup("token", "account", {
    name: "first-device",
    platform: "linux",
    app_version: "0.1.0",
  });
  assert.equal(enrolled.outcome, "ok");
  assert.equal(enrolled.value.device_id, DEVICE_ID, "setup enrols the first device");
  assert.equal(enrolled.value.device_secret, DEVICE_SECRET_HEX);
  assert.deepEqual(JSON.parse(sent[0].body), {
    setup_token: "token",
    account_name: "account",
    device: { name: "first-device", platform: "linux", app_version: "0.1.0" },
  });
  await transport.pairingClaim("00".repeat(16), "11".repeat(32), { name: "n", platform: "linux", app_version: "0.1.0" });
  await transport.pluginManifest();
  await transport.devices();

  for (const request of sent.slice(0, 3)) {
    assert.equal("X-Obsync-Sig" in request.headers, false, request.url);
    assert.equal("X-Obsync-Device" in request.headers, false, request.url);
  }
  assert.equal("X-Obsync-Sig" in sent[3].headers, true, "/v1/devices is signed");
  assert.deepEqual(
    sent.map((request) => request.url.replace(SERVER, "")),
    ["/v1/setup", `/v1/pairing/${"00".repeat(16)}/claim`, "/v1/plugin/manifest", "/v1/devices"],
    "the manifest is the only plugin endpoint this client has: code is never fetched",
  );
  assert.equal(typeof transport.pluginBundle, "undefined", "there is no bundle client to call");
  assert.equal(typeof transport.pluginStyles, "undefined", "there is no stylesheet client to call");
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

// --- idempotency: the table, the fresh signature, the lost outcome --------

/**
 * The client's own plumbing. Everything else on the prototype emits a route
 * the server sees and must therefore appear in `CALLS` below, which is what
 * stops a new endpoint from arriving unclassified.
 */
const INTERNAL = ["constructor", "backoffMs", "prepare", "attempt", "settle", "call", "send", "json", "once", "readOnce"];
const READ_CONTROL = { check() {}, wait: (work) => work };

/** Every route-emitting method, arguments that make it emit, and its verdict. */
const CALLS = [
  ["setup", ["token", "account", INFO], false],
  ["account", [], true],
  ["pairingCreate", [], false],
  ["pairingClaim", [PAIRING_ID, "11".repeat(32), INFO], false],
  ["pairingStatus", [PAIRING_ID], true],
  ["pairingApprove", [PAIRING_ID, "AAAA", "33".repeat(12)], false],
  ["pairingReject", [PAIRING_ID], false],
  ["pairingEnvelope", [PAIRING_ID], false],
  ["devices", [], true],
  ["patchDevice", [DEVICE_ID, { name: "n" }], false],
  ["revokeDevice", [DEVICE_ID], false],
  ["heartbeat", ["0.1.0", { perFileMaxBytes: 0, totalBudgetBytes: 0 }], false],
  ["missingChunks", [[SID]], true],
  ["putChunk", [SID, Uint8Array.from([1, 2, 3])], true],
  ["getChunk", [SID], true],
  ["getChunks", [[SID]], true],
  ["postVersion", [FILE_ID, VERSION_POST], false],
  ["getFile", [FILE_ID], true],
  ["changes", [7, 0], true],
  ["historyChanges", [7, READ_CONTROL], true, true],
  ["historyVersion", [FILE_ID, SID, READ_CONTROL], true, true],
  ["dashboardLoginLink", [], false],
  ["pluginManifest", [], true],
];

/** One fake that answers every method: each reads only the fields it needs. */
function always(status, text) {
  const sent = [];
  const transport = new Transport({
    request: async (request) => {
      sent.push(request);
      return {
        status,
        headers: { "content-type": 'multipart/mixed; boundary="b"' },
        text,
        arrayBuffer: new ArrayBuffer(0),
      };
    },
    serverUrl: () => SERVER,
    device: () => ({ id: DEVICE_ID, secret: Uint8Array.from(Buffer.from(DEVICE_SECRET_HEX, "hex")) }),
    edgeHeaders: () => [],
    now: () => 1757200000000,
    sleep: async () => undefined,
    maxAttempts: 2,
  });
  return { transport, sent };
}

test("every route this client emits is classified, and sent as its verdict says", async () => {
  assert.deepEqual(
    CALLS.map(([name]) => name).sort(),
    Object.getOwnPropertyNames(Transport.prototype)
      .filter((name) => !INTERNAL.includes(name))
      .sort(),
    "a method that reaches the server must state the route it emits",
  );

  for (const [name, args, idempotent, manual] of CALLS) {
    const answered = always(200, '{"missing":[],"devices":[],"versions":[],"heads":[],"changes":[]}');
    await answered.transport[name](...args);
    assert.ok(answered.sent.length > 0, `${name} sent nothing`);
    for (const request of answered.sent) {
      const target = request.url.replace(SERVER, "");
      const route = routeFor(request.method, target);
      assert.ok(route, `${name}: ${request.method} ${target} is in no ROUTES entry`);
      assert.equal(route.idempotent, idempotent, `${name}: ${request.method} ${target}`);
    }

    // The table is a claim about behaviour, so drive the behaviour: nothing
    // settles, and the send either retries or reports its one attempt lost.
    const unsettled = always(503, "");
    const result = await unsettled.transport[name](...args).catch((error) => error);
    if (manual) {
      assert.equal(unsettled.sent.length, 1, `${name}: manual read requires an explicit retry`);
      assert.equal(result.code, "unreachable");
    } else if (idempotent) {
      assert.ok(unsettled.sent.length > 1, `${name}: a repeatable route is retried`);
      assert.equal(result.code, "unreachable", `${name}: and gives up saying so`);
    } else {
      assert.equal(unsettled.sent.length, 1, `${name}: sent at most once per signature`);
      assert.equal(result.outcome, "lost", `${name}: an unanswered send is lost, not thrown`);
    }
  }
});

test("a target no entry matches is a refusal, never a default", () => {
  assert.equal(routeFor("DELETE", `/v1/devices/${DEVICE_ID}`), null);
  assert.equal(routeFor("POST", "/v1/files"), null);
  assert.equal(routeFor("GET", `/v1/chunks/${DEVICE_ID}`), null, "a sid is 32 bytes, not 16");
});

test("an idempotent retry is signed afresh, so a nonce-spending server accepts it", async () => {
  const spent = new Set();
  const sent = [];
  let clock = 1757200000000;
  const transport = new Transport({
    request: async (request) => {
      sent.push(request);
      clock += 61000; // as much time as a backoff really takes
      const nonce = request.headers["X-Obsync-Nonce"];
      if (spent.has(nonce)) {
        return {
          status: 401,
          headers: {},
          text: JSON.stringify({ error: "replayed_nonce", detail: "seen within 600 s" }),
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      spent.add(nonce);
      return sent.length === 1
        ? { status: 503, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }
        : { status: 200, headers: {}, text: JSON.stringify({ account_id: "a" }), arrayBuffer: new ArrayBuffer(0) };
    },
    serverUrl: () => SERVER,
    device: () => ({ id: DEVICE_ID, secret: Uint8Array.from(Buffer.from(DEVICE_SECRET_HEX, "hex")) }),
    edgeHeaders: () => [],
    now: () => clock,
    sleep: async () => undefined,
    maxAttempts: 3,
  });

  const account = await transport.account();
  assert.equal(account.account_id, "a", "the retry was served, not refused as a replay");
  assert.equal(sent.length, 2);
  assert.equal(spent.size, 2, "each attempt spent a nonce of its own");
  assert.notEqual(sent[0].headers["X-Obsync-Nonce"], sent[1].headers["X-Obsync-Nonce"]);
  assert.notEqual(sent[0].headers["X-Obsync-Ts"], sent[1].headers["X-Obsync-Ts"], "and a timestamp inside the window");
  assert.notEqual(sent[0].headers["X-Obsync-Sig"], sent[1].headers["X-Obsync-Sig"]);
});

test("a request that must not be repeated is sent once and comes back lost", async () => {
  for (const failure of [new Error("socket hang up"), { status: 503, text: "" }]) {
    const { transport, sent, slept, logged } = harness([failure, { status: 204 }]);
    const lost = await transport.pairingApprove(PAIRING_ID, "AAAA", "33".repeat(12));
    assert.equal(lost.outcome, "lost");
    assert.equal(lost.attempts, 1, "at most once per signature");
    assert.match(lost.reason, failure instanceof Error ? /network=socket hang up/ : /status=503/);
    assert.equal(sent.length, 1, "the second response was never asked for");
    assert.deepEqual(slept, [], "no backoff is spent on something that will not be sent again");
    assert.ok(logged.some((line) => line.includes("decision=lost") && line.includes("attempts=1")));
  }
});

test("a lost outcome is data: neither a thrown failure nor an acknowledgement", async () => {
  const { transport } = harness([new Error("connection reset by peer")]);
  const lost = await transport.postVersion(FILE_ID, VERSION_POST);
  assert.equal(lost.outcome, "lost", "it resolved rather than threw");
  assert.equal("value" in lost, false, "there is nothing to mistake for an ack");
});

test("replayed_nonce stays a refusal, and this client never provokes one", async () => {
  const { transport, sent } = harness([
    { status: 401, text: JSON.stringify({ error: "replayed_nonce", detail: "seen within 600 s" }) },
  ]);
  await assert.rejects(
    () => transport.account(),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "replayed_nonce");
      return true;
    },
  );
  assert.equal(sent.length, 1, "a 401 is a decision, not a retry");
});

test("body hashing is the protocol's, including the empty body", async () => {
  assert.equal(
    await c.bodyHash(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
