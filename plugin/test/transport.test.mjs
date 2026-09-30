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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { ApiError, HISTORY_RESPONSE_BYTES, Transport, lostMessage, parseMultipart, routeFor } = require("../build/transport.js");
const c = require("../build/crypto.js");
const { loadDomainMap } = require("../build/domainmap.js");

const DEVICE_ID = "aabbccddeeff00112233445566778899";
const DEVICE_SECRET_HEX = "0f".repeat(32);
const SERVER = "https://sync.example.invalid";
const PAIRING_ID = "00".repeat(16);
const FILE_ID = "44".repeat(16);
const SID = "55".repeat(32);
const VERSION_ID = "66".repeat(32);
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
      let next = queue.shift();
      if (next === undefined) throw new Error("the fake server ran out of responses");
      // A response the TEST decides the timing of: a function is awaited, so
      // a request can be left in flight for as long as the test needs the
      // server to be busy.
      if (typeof next === "function") next = await next();
      if (next instanceof Error) throw next;
      return {
        status: next.status,
        headers: next.headers ?? {},
        text: next.text ?? "",
        arrayBuffer: next.body ?? new ArrayBuffer(0),
      };
    },
    serverUrl: () => options.address?.() ?? options.serverUrl ?? SERVER,
    device: () =>
      options.unpaired ? null : { id: DEVICE_ID, secret: Uint8Array.from(Buffer.from(DEVICE_SECRET_HEX, "hex")) },
    edgeHeaders: () => options.edgeHeaders ?? [],
    now: options.now ?? (() => 1757200000000),
    sleep: options.sleep ?? (async (ms) => void slept.push(ms)),
    random: () => 0.5,
    maxAttempts: options.maxAttempts ?? 3,
    log: (line) => logged.push(line),
    reachable: options.reachable,
    timers: options.timers,
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

test("custom request headers ride on every request", async () => {
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

test("an edge header never replaces obsync's own, and one the platform would drop is refused by name, unsent (#183)", async () => {
  // Saved before 1.1.4 validated the box: a `Content-Type` or `X-Obsync-*`
  // line replaced obsync's own header, and `-H "X-Id` was dropped by the
  // desktop request layer without a word (S69).
  for (const header of [
    { name: "Content-Type", value: "text/plain" }, { name: "x-obsync-device", value: "99".repeat(16) },
    { name: "X-OBSYNC-SIG", value: "forged" }, { name: "host", value: "elsewhere.invalid" }, { name: "Content-Length", value: "0" },
    { name: '-H "X-Id', value: 'abc"' }, { name: "X-Id", value: "“abc”" }, { name: "X-Id", value: "a\nb" }, { name: "", value: "VALUE SENTINEL" },
  ]) {
    const { transport, sent, logged } = harness([{ status: 200, text: "{}" }], {
      edgeHeaders: [{ name: "X-Service-Id", value: "id-value" }, header],
    });
    await assert.rejects(() => transport.postVersion(FILE_ID, VERSION_POST), (error) => {
      assert.equal(error.message, `The custom request header "${header.name}" cannot be sent as written, so obsync sent nothing. Correct it in obsync's settings, under Custom request headers.`);
      assert.equal(error.message.includes(header.value), false, "a value can be a service token and is never shown");
      return true;
    }, JSON.stringify(header));
    assert.equal(sent.length, 0, `${JSON.stringify(header)} reached the network`);
    assert.ok(logged.includes(`http /v1/files/${FILE_ID}/versions decision=refused reason=edge_header`), logged.join("\n"));
  }
  const { transport, sent } = harness([{ status: 200, text: "{}" }], {
    edgeHeaders: [{ name: "X-Service-Id", value: "id\tvalue !~" }],
  });
  await transport.postVersion(FILE_ID, VERSION_POST);
  assert.equal(sent[0].headers["Content-Type"], "application/json");
  assert.equal(sent[0].headers["X-Obsync-Device"], DEVICE_ID);
  assert.equal(sent[0].headers["X-Service-Id"], "id\tvalue !~", "a tab, a space and punctuation are plain header text");
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

test("an answer without obsync's shape is its own refusal: something in front of the server gave it (#155)", async () => {
  // A proxy's page, a JSON body that is not obsync's, a bare status, and a
  // sign-in page answered with 200: none of them is obsync speaking.
  for (const answer of [
    { status: 403, text: "<html>denied SENTINEL</html>" },
    { status: 401, text: JSON.stringify({ message: "not obsync's shape" }) },
    { status: 400, text: "" },
    { status: 200, text: "<html>sign in first</html>" },
  ]) {
    const { transport, sent, logged } = harness([answer]);
    await assert.rejects(() => transport.account(), (error) => {
      assert.ok(error instanceof ApiError, JSON.stringify(answer));
      assert.equal(error.status, answer.status);
      assert.equal(error.code, "not_obsync", JSON.stringify(answer));
      return true;
    });
    assert.equal(sent.length, 1, "answered, so never retried");
    if (answer.status >= 400) assert.ok(logged.some((line) => line.includes("decision=refused code=not_obsync")), logged.join("|"));
  }
  // obsync's own shape keeps its own code, detail or not.
  const { transport } = harness([{ status: 403, text: JSON.stringify({ error: "device_revoked" }) }]);
  await assert.rejects(() => transport.account(), (error) => error.code === "device_revoked" && error.detail === "");
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
    Buffer.from(`--${boundary}\r\nX-Obsync-Sid: ${"11".repeat(32)}\r\nContent-Length: ${first.length}\r\n\r\n`),
    first,
    Buffer.from(`\r\n--${boundary}\r\nX-Obsync-Sid: ${"22".repeat(32)}\r\nX-Obsync-Missing: 1\r\nContent-Length: 0\r\n\r\n`),
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

test("controlled chunk reads accept the existing tag and reject one extra ciphertext byte", async () => {
  const maximum = 8 * 1024 * 1024 + 16;
  const body = new Uint8Array(maximum).fill(81);
  const { transport, sent } = harness([
    { status: 200, body: body.buffer },
    { status: 200, body: new ArrayBuffer(maximum + 1) },
  ]);
  const control = { check() {}, wait: (work) => work };
  assert.deepEqual(await transport.getChunk(SID, control), body);
  await assert.rejects(transport.getChunk(SID, control), (error) => error.code === "response_too_large");
  assert.equal(sent.length, 2, "the refused read was not retried");
});

test("a batched part that is not the chunk asked for is refused by name, never matched by position (#202)", async () => {
  const [a, b, c] = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  const answer = (named) => {
    const document = Buffer.concat([
      ...named.map((sid) => Buffer.from(`--b\r\nX-Obsync-Sid: ${sid}\r\nContent-Length: 1\r\n\r\nx\r\n`)),
      Buffer.from("--b--\r\n"),
    ]);
    return { status: 200, headers: { "content-type": "multipart/mixed; boundary=b" }, body: document.buffer.slice(document.byteOffset, document.byteOffset + document.byteLength) };
  };
  // Swapped, dropped, and one the request never named.
  for (const [named, part] of [[[b, a, c], 0], [[a, c], 1], [[a, b, "44".repeat(32)], 2], [[a, b, c, a], 3]]) {
    const { transport, sent, logged } = harness([answer(named)]);
    await assert.rejects(transport.getChunks([a, b, c]), (error) => error instanceof ApiError && error.code === "part_mismatch", named.join(","));
    assert.equal(sent.length, 1, "an answered batch is not retried");
    assert.ok(logged.some((line) => line === `http POST /v1/chunks/get decision=refused reason=part_mismatch part=${part} parts=${named.length} asked=3`), logged.join("|"));
  }
  const { transport } = harness([answer([a, b, c])]);
  assert.equal((await transport.getChunks([a, b, c])).length, 3, "the parts in the order asked are accepted");
});

test("an answer larger than its route can be is refused before it is parsed or kept (#202)", async () => {
  const { JSON_ANSWER_MAX, METADATA_ANSWER_MAX } = require("../build/transport.js");
  const text = (length) => `{"x":"${"y".repeat(length - 8)}"}`;
  const refused = async (call, answer, budget) => {
    const { transport, sent, logged } = harness([answer]);
    await assert.rejects(call(transport), (error) => error instanceof ApiError && error.code === "response_too_large");
    assert.equal(sent.length, 1, "an answered request is not retried");
    assert.ok(logged.some((line) => line.includes("decision=refused reason=too_large") && line.endsWith(`budget=${budget}`)), logged.join("|"));
  };
  const accepted = async (call, answer) => {
    const { transport } = harness([answer]);
    await call(transport);
  };
  // The small answers, repeatable and not.
  await refused((t) => t.account(), { status: 200, text: text(JSON_ANSWER_MAX + 1) }, JSON_ANSWER_MAX);
  await refused((t) => t.devices(), { status: 200, text: text(JSON_ANSWER_MAX + 1) }, JSON_ANSWER_MAX);
  await refused((t) => t.postVersion(FILE_ID, VERSION_POST), { status: 201, text: text(JSON_ANSWER_MAX + 1) }, JSON_ANSWER_MAX);
  await accepted((t) => t.account(), { status: 200, text: text(JSON_ANSWER_MAX) });
  // A file's record is allowed what the server can send (review of
  // 7e1294d): the reviewer's sixty retained versions of a 4,000-chunk file
  // render as 67,953,622 characters, past the 64 MiB this used to refuse.
  await accepted((t) => t.getFile(FILE_ID), { status: 200, text: text(67_953_622) });
  // Past the server's own bound (`FILE_RECORD_MAX`, stated here as the
  // protocol states it) it is refused; only the length is read.
  const record = 450 * 1024 * 1024;
  await refused((t) => t.getFile(FILE_ID), { status: 200, text: { length: record + 1 } }, record);
  // One version and a listing page keep the smaller bound.
  await accepted((t) => t.getVersion(FILE_ID, VERSION_ID), { status: 200, text: text(JSON_ANSWER_MAX + 1) });
  await refused((t) => t.getVersion(FILE_ID, VERSION_ID), { status: 200, text: text(METADATA_ANSWER_MAX + 1) }, METADATA_ANSWER_MAX);
  // A chunk is its ciphertext ceiling, measured in bytes.
  const maximum = 8 * 1024 * 1024 + 16;
  await accepted((t) => t.getChunk(SID), { status: 200, body: new ArrayBuffer(maximum) });
  await refused((t) => t.getChunk(SID), { status: 200, body: new ArrayBuffer(maximum + 1) }, maximum);
  const batch = 2 * (maximum + 1024) + 1024;
  await refused((t) => t.getChunks([SID, SID]), { status: 200, headers: { "content-type": "multipart/mixed; boundary=b" }, body: new ArrayBuffer(batch + 1) }, batch);
  // The feed page is bounded by its records until the server caps it by bytes.
  await accepted((t) => t.changes(0, 0), { status: 200, text: JSON.stringify({ seq: 0, head_seq: 0, changes: [], pad: "y".repeat(JSON_ANSWER_MAX) }) });
});

test("the plugin accepts exactly the file record the server never passes (review of 7e1294d)", (t) => {
  const { FILE_ANSWER_MAX } = require("../build/transport.js");
  const source = new URL("../../crates/obsyncd/src/api/mod.rs", import.meta.url);
  // The image's plugin stage copies plugin/ alone; the gate and the desktop
  // matrix run from the whole checkout, where this always runs.
  if (!existsSync(source)) return t.skip("the server's source is not beside this plugin");
  const rust = readFileSync(source, "utf8");
  const stated = /pub const FILE_RECORD_MAX: u64 = ([0-9 *_]+);/.exec(rust);
  assert.ok(stated, "the server states FILE_RECORD_MAX");
  const server = stated[1].split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
  assert.equal(FILE_ANSWER_MAX, server);
});

/** Deadline timers the test fires by hand, recording the deadline each attempt was given. */
function deadlines() {
  const armed = new Map();
  let next = 1;
  return {
    set(fn, ms) { const handle = next++; armed.set(handle, { fn, ms }); return handle; },
    clear(handle) { armed.delete(handle); },
    /** Every deadline armed and not yet cleared, in milliseconds. */
    pending: () => [...armed.values()].map((entry) => entry.ms),
    /** The one deadline armed passes. */
    expire() {
      assert.equal(armed.size, 1, `exactly one attempt is waiting, not ${armed.size}`);
      const [[handle, entry]] = [...armed];
      armed.delete(handle);
      entry.fn();
    },
  };
}

test("an attempt nothing answers within its deadline is unanswered: retried and re-signed, or lost; its late answer is dropped (#195)", async () => {
  const hangs = () => { let answer; const pending = new Promise((resolve) => { answer = resolve; }); return { pending, answer: (value) => answer(value) }; };
  const first = hangs();
  const timers = deadlines();
  const heard = [];
  const { transport, sent, logged } = harness([() => first.pending, DEVICES], { timers, reachable: (answered) => heard.push(answered) });
  const read = transport.devices();
  await turns(() => timers.pending().length === 1);
  assert.deepEqual(timers.pending(), [30000], "a read waits ATTEMPT_MS");
  const reading = watch(read);
  timers.expire();
  await turns(() => reading.settled);
  assert.deepEqual(await read, { devices: [] });
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].headers["X-Obsync-Nonce"], sent[1].headers["X-Obsync-Nonce"], "the retry is signed afresh");
  assert.ok(logged.some((line) => line === "http GET /v1/devices timeout budget_ms=30000 decision=retry attempt=1 backoff_ms=750"), logged.join("|"));
  first.answer({ status: 200, text: JSON.stringify({ devices: ["LATE"] }) });
  await turns();
  assert.deepEqual(heard, [false, true], "the late answer is neither returned nor reported");
  assert.deepEqual(timers.pending(), [], "a settled attempt leaves no deadline armed");

  // A route that must not be repeated reports the silence as lost.
  const once = hangs();
  const onceTimers = deadlines();
  const posting = harness([() => once.pending], { timers: onceTimers });
  const post = posting.transport.postVersion(FILE_ID, VERSION_POST);
  await turns(() => onceTimers.pending().length === 1);
  const posted = watch(post);
  onceTimers.expire();
  await turns(() => posted.settled);
  const lost = await post;
  assert.equal(lost.outcome, "lost");
  assert.equal(lost.reason, "timeout budget_ms=30000");
  assert.equal(posting.sent.length, 1);
});

test("each attempt's deadline fits its route: a long poll its wait, a transfer its bytes (#195)", async () => {
  const given = async (call, answer) => {
    const timers = deadlines();
    let seen = null;
    const { transport } = harness([async () => { await new Promise((resolve) => setImmediate(resolve)); seen = timers.pending(); return answer; }], { timers });
    await call(transport);
    return seen;
  };
  const page = { status: 200, text: JSON.stringify({ seq: 0, head_seq: 0, changes: [] }) };
  assert.deepEqual(await given((t) => t.changes(0, 55), page), [70000], "the 55 s wait and 15 s of grace");
  assert.deepEqual(await given((t) => t.changes(0, 0), page), [30000], "a quick read is a read");
  assert.deepEqual(await given((t) => t.account(), { status: 200, text: "{}" }), [30000]);
  const body = new Uint8Array(1024 * 1024);
  assert.deepEqual(await given((t) => t.putChunk(SID, body), { status: 201 }), [30000 + 65536], "a MiB up at the slowest rate");
  const chunk = 8 * 1024 * 1024 + 16;
  assert.deepEqual(await given((t) => t.getChunk(SID), { status: 200, body: new ArrayBuffer(1) }), [30000 + Math.ceil(chunk / 16)]);
});

test("a feed page over its ceiling is asked again smaller from the same cursor; only one entry over it is a refusal (#202)", async () => {
  const { CHANGES_ANSWER_MAX } = require("../build/transport.js");
  const huge = { status: 200, text: `{"pad":"${"y".repeat(CHANGES_ANSWER_MAX)}"}` };
  const page = { status: 200, text: JSON.stringify({ seq: 9, head_seq: 12, changes: [] }) };
  const { transport, sent, logged } = harness([huge, page]);
  assert.deepEqual(await transport.changes(7, 0), { seq: 9, head_seq: 12, changes: [] });
  assert.deepEqual(sent.map((request) => request.url.replace(SERVER, "")), ["/v1/changes?since=7&wait=0&limit=1000", "/v1/changes?since=7&wait=0&limit=500"]);
  assert.ok(logged.includes("http GET /v1/changes?since=7&wait=0&limit=1000 decision=refused reason=over_cap retry limit=500"), logged.join("|"));
  // One entry over the ceiling cannot be asked for any smaller.
  const single = harness([huge, huge]);
  await assert.rejects(single.transport.changes(7, 0, 2), (error) => error.code === "response_too_large");
  assert.deepEqual(single.sent.map((request) => /limit=(\d+)/.exec(request.url)[1]), ["2", "1"]);
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
const INTERNAL = [
  "constructor", "backoffMs", "prepare", "attempt", "settle", "call", "send", "json", "once", "readOnce",
  // The chunk uploader: `putChunk` is the only one of these that emits, and
  // `uploadChunk` emits it. The rest schedule, measure or report.
  "uploadChunk", "fits", "admit", "release", "landed", "uploadStats",
  // Plus the manual-read slot accounting, which reaches no route at all: it
  // says whether a history operation holds the one outstanding manual read,
  // so the repair tick can yield to it instead of colliding (issue #103).
  "manualBusy", "openManual", "closeManual",
  // And the retry machinery: the address read per attempt, the patience a
  // call is given, the pause `wake` ends early (issues #134, #182, #186).
  "base", "budget", "until", "pause", "ended", "nap", "wake", "retryAt",
  // And the ceiling an answer is measured against (#202).
  "capped",
  // And the deadline each attempt is abandoned by (#195).
  "timed",
  // And the signing handle a leave drops (#197), which reaches no route.
  "forgetDevice",
];
const READ_CONTROL = { check() {}, wait: (work) => work };

/** Every route-emitting method, arguments that make it emit, and its verdict. */
const CALLS = [
  ["setup", ["token", "account", INFO], false],
  ["account", [], true],
  ["registerRecovery", ["11".repeat(32)], false],
  ["pairingCreate", [], false],
  ["pairingClaim", [PAIRING_ID, "11".repeat(32), INFO], false],
  ["pairingStatus", [PAIRING_ID], true],
  ["pairingApprove", [PAIRING_ID, "AAAA", "33".repeat(12)], false],
  ["pairingReject", [PAIRING_ID], false],
  ["pairingEnvelope", [PAIRING_ID], false],
  ["devices", [], true],
  ["patchDevice", [DEVICE_ID, { name: "n" }], false],
  ["revokeDevice", [DEVICE_ID], false],
  ["archiveDevice", [DEVICE_ID], false],
  ["heartbeat", ["0.1.0", { perFileMaxBytes: 0, totalBudgetBytes: 0 }], false],
  ["missingChunks", [[SID]], true],
  ["putChunk", [SID, Uint8Array.from([1, 2, 3])], true],
  ["getChunk", [SID], true],
  ["getChunks", [[SID]], true],
  ["postVersion", [FILE_ID, VERSION_POST], false],
  ["getFile", [FILE_ID], true],
  ["getVersion", [FILE_ID, SID], true],
  ["listFiles", [FILE_ID], true],
  ["changes", [7, 0], true],
  ["historyChanges", [7, READ_CONTROL], true, true],
  ["historyVersion", [FILE_ID, SID, READ_CONTROL], true, true],
  ["dashboardLoginLink", [], false],
  ["pluginManifest", [], true],
];

/** One fake that answers every method: each reads only the fields it needs. */
function always(status, text) {
  const sent = [];
  // One part naming the one sid `CALLS` asks for, so the batch reader accepts it.
  const part = Buffer.from(`--b\r\nX-Obsync-Sid: ${SID}\r\nX-Obsync-Missing: 1\r\nContent-Length: 0\r\n\r\n\r\n--b--\r\n`);
  const transport = new Transport({
    request: async (request) => {
      sent.push(request);
      return {
        status,
        headers: { "content-type": 'multipart/mixed; boundary="b"' },
        text,
        arrayBuffer: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
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

test("a manual read refusal names its reason, and budget_bytes only for the size one", async () => {
  // busy: the slot is already held, so nothing is sent and nothing is
  // measured against a byte budget (issue #103).
  //
  // THE SLOT IS TAKEN ASYNCHRONOUSLY, so this waits for it. `readOnce` signs
  // its request before it claims `manualRead`, and two reads issued in the
  // same turn therefore RACE for the slot: the refusal landed on whichever
  // one lost, so this assertion read the fake server's "ran out of responses"
  // where it expected the collision. That is how it failed once in 25
  // mutation runs, under a mutant it has nothing to do with, and a flake in a
  // mutation matrix is a kill nobody can trust (review round 2, finding 7).
  // The first read now holds the slot until this test releases it, and the
  // second is issued only once the transport says the slot is held.
  let release;
  // The latch is made BEFORE the request that waits on it: the slot is
  // claimed for a request that has not been sent yet, so a hold created
  // inside the fake server could be released before it exists.
  const hold = new Promise((resolve) => { release = resolve; });
  const held = harness([async () => { await hold; return { status: 200, text: "{}" }; }]);
  const first = held.transport.historyChanges(0, READ_CONTROL);
  for (let turn = 0; turn < 1000 && !held.transport.manualBusy; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(held.transport.manualBusy, "the first read never took the slot, so nothing could collide with it");
  const collided = await held.transport.historyVersion(FILE_ID, "11".repeat(32), READ_CONTROL)
    .catch((error) => error);
  release();
  await first.catch(() => undefined);
  assert.equal(collided.name, "HistoryBusyError");
  const busy = held.logged.filter((line) => line.startsWith("history_http decision=refused reason=busy"));
  assert.equal(busy.length, 1, held.logged.join(" | "));
  assert.equal(busy[0].includes("budget_bytes"), false, "budget_bytes belongs to the size refusal alone");
  assert.match(busy[0], /duration_ms=\d+$/);

  // too_large: a response past the budget, which IS measured against it.
  const big = harness([{ status: 200, text: "x".repeat(HISTORY_RESPONSE_BYTES + 1) }]);
  await big.transport.historyChanges(0, READ_CONTROL).catch(() => undefined);
  assert.match(
    big.logged.find((line) => line.startsWith("history_http decision=refused")),
    new RegExp(`^history_http decision=refused reason=too_large budget_bytes=${HISTORY_RESPONSE_BYTES} duration_ms=\\d+$`),
  );

  // cancelled: the operation was stopped before the read could settle.
  const stopped = harness([{ status: 200, text: "{}" }]);
  const cancel = { check() { const error = new Error("stopped"); error.name = "HistoryCancelled"; throw error; }, wait: (work) => work };
  await stopped.transport.historyChanges(0, cancel).catch(() => undefined);
  assert.match(
    stopped.logged.find((line) => line.startsWith("history_http decision=refused")),
    /^history_http decision=refused reason=cancelled duration_ms=\d+$/,
  );
  assert.equal(stopped.sent.length, 0, "a cancelled read never reaches the network");
});

test("every attempt says whether the server answered it, and decides nothing", async () => {
  // Nothing answers, then a terminator with no server behind it, then the
  // server: three attempts, three reports, and the call returns as before.
  const heard = [];
  const { transport, sent } = harness(
    [new Error("connection refused SENTINEL"), { status: 503 }, { status: 200, text: JSON.stringify({ devices: [] }) }],
    { reachable: (answered) => heard.push(answered) },
  );
  assert.deepEqual(await transport.devices(), { devices: [] });
  assert.deepEqual(heard, [false, false, true]);
  assert.equal(sent.length, 3);

  // A refusal IS an answer: the server is there, and it said no.
  const refused = [];
  const { transport: strict } = harness(
    [{ status: 401, text: JSON.stringify({ error: "bad_signature", detail: "SENTINEL" }) }],
    { reachable: (answered) => refused.push(answered) },
  );
  await assert.rejects(strict.devices(), (error) => error.code === "bad_signature");
  assert.deepEqual(refused, [true]);
});

test("a connection refused on the only attempt says nothing was sent and names the port; anything else stays unknown", () => {
  const refused = lostMessage("creating the account", { outcome: "lost", attempts: 1, reason: "network=net::ERR_CONNECTION_REFUSED" });
  assert.match(refused, /^creating the account: nothing answers at this address and port \(network=net::ERR_CONNECTION_REFUSED\), so nothing was sent\./);
  assert.match(refused, /port included/);
  assert.match(lostMessage("x", { outcome: "lost", attempts: 1, reason: "network=connect ECONNREFUSED 127.0.0.1:443" }), /nothing was sent/);
  // A timeout may have delivered the request; a refusal after an earlier attempt proves nothing about that one.
  for (const lost of [
    { outcome: "lost", attempts: 1, reason: "network=net::ERR_CONNECTION_TIMED_OUT" },
    { outcome: "lost", attempts: 2, reason: "network=net::ERR_CONNECTION_REFUSED" },
  ]) assert.match(lostMessage("x", lost), /cannot say whether it happened/, JSON.stringify(lost));
});

// --- patience: wake, the address per attempt, budgets, refusals ------------

/**
 * Let the transport's continuations run until `ready()` holds, for as long as a
 * wall clock allows, never a number of turns (issue #231): the transport signs
 * with WebCrypto, which answers on the threadpool, and a loaded machine gets
 * there in more turns, not never. `ready()` is still asked after every turn,
 * because some states it waits for last only until the next one.
 */
async function turns(ready = () => true) {
  const started = Date.now();
  while (!ready() && Date.now() - started < 10_000) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ready(), `the transport never reached the state the test waits for (waited ${Date.now() - started} ms)`);
}

/**
 * Virtual time: every pause waits until the test moves the clock past it, so
 * a backoff, a wake and an interactive budget are all decided by the test.
 */
function clock() {
  let now = 1757200000000;
  const timers = [];
  return {
    now: () => now,
    sleep: (ms) => new Promise((resolve) => timers.push({ at: now + ms, ms, resolve })),
    /** The pauses asked for so far, in milliseconds. */
    asked: () => timers.map((timer) => timer.ms),
    async advance(ms) {
      now += ms;
      for (const timer of timers) if (timer.at <= now) timer.resolve();
      for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const REFUSED_AT_CONNECT = () => new Error("net::ERR_CONNECTION_REFUSED");

/**
 * Whether a call has settled yet. A wait on a call a mutant never lets settle
 * must end in an assertion, not in a test the runner cancels as hung.
 */
function watch(promise) {
  const seen = { settled: false };
  promise.then(() => { seen.settled = true; }, () => { seen.settled = true; });
  return seen;
}
const DEVICES = { status: 200, text: JSON.stringify({ devices: [] }) };

test("wake retries a request asleep in its backoff at once, once per request however many events arrive (#134)", async () => {
  const time = clock();
  const { transport, sent, logged } = harness([REFUSED_AT_CONNECT(), REFUSED_AT_CONNECT(), DEVICES], { maxAttempts: 8, sleep: time.sleep, now: time.now });
  transport.wake("online");
  assert.equal(logged.some((line) => line.includes("decision=woken")), false, "nothing asleep, nothing woken, nothing said");
  const call = transport.devices();
  await turns(() => time.asked().length === 1);
  assert.equal(sent.length, 1);
  assert.equal(transport.retryAt(), time.now() + 750, "when the pause ends by itself, for Show sync status");
  // A storm: three events in one turn are one early attempt, not three.
  transport.wake("online");
  transport.wake("online");
  transport.wake("online");
  await turns(() => time.asked().length === 2);
  assert.equal(sent.length, 2);
  assert.deepEqual(logged.filter((line) => line.startsWith("http decision=woken")), ["http decision=woken reason=online requests=1"]);
  // The early attempt counted: the next pause is the next step, not the first again.
  assert.deepEqual(time.asked(), [750, 1500]);
  transport.wake("foreground");
  assert.deepEqual(await call, { devices: [] });
  assert.equal(sent.length, 3);
  assert.equal(transport.retryAt(), null, "nothing is asleep any more");
});

test("without a wake the pause runs out by itself, exactly as long as before", async () => {
  const time = clock();
  const { transport, sent } = harness([REFUSED_AT_CONNECT(), DEVICES], { maxAttempts: 8, sleep: time.sleep, now: time.now });
  const call = transport.devices();
  await turns(() => time.asked().length === 1);
  await time.advance(749);
  assert.equal(sent.length, 1, "not a millisecond early");
  await time.advance(1);
  assert.deepEqual(await call, { devices: [] });
  assert.equal(sent.length, 2);
});

test("every attempt goes to the address that stands when it is sent, signed over the path alone (#186)", async () => {
  const time = clock();
  let address = "https://old.example.invalid";
  const { transport, sent } = harness([REFUSED_AT_CONNECT(), DEVICES], { maxAttempts: 8, sleep: time.sleep, now: time.now, address: () => address });
  const call = transport.devices();
  await turns(() => time.asked().length === 1);
  address = "https://new.example.invalid";
  transport.wake("address");
  await call;
  assert.deepEqual(sent.map((request) => request.url), ["https://old.example.invalid/v1/devices", "https://new.example.invalid/v1/devices"]);
  assert.equal(sent[1].headers["X-Obsync-Sig"], expectedSignature(sent[1], "GET", "/v1/devices", Buffer.alloc(0)));
});

test("a chunk upload asleep in its backoff goes on at the new address, asking first whether the body landed (#186)", async () => {
  const time = clock();
  let address = "https://old.example.invalid";
  const { transport, sent } = harness(
    [REFUSED_AT_CONNECT(), { status: 200, text: JSON.stringify({ missing: [SID] }) }, { status: 201 }],
    { maxAttempts: 8, sleep: time.sleep, now: time.now, address: () => address },
  );
  const upload = transport.putChunk(SID, Uint8Array.from([1, 2, 3]));
  await turns(() => time.asked().length === 1);
  address = "https://new.example.invalid";
  transport.wake("address");
  await upload;
  assert.deepEqual(sent.map((request) => `${request.method} ${request.url}`), [
    `PUT https://old.example.invalid/v1/chunks/${SID}`,
    "POST https://new.example.invalid/v1/chunks/exists",
    `PUT https://new.example.invalid/v1/chunks/${SID}`,
  ]);
});

test("a full server's 507 is its refusal on the first answer; 500, 502, 503 and 504 are still absence (#155)", async () => {
  // `storage_full`: the disk itself had no room, whatever the watermark saw (#291).
  for (const code of ["volume_full", "journal_full", "quota_exceeded", "storage_full"]) {
    const heard = [];
    const { transport, sent, slept } = harness(
      [{ status: 507, text: JSON.stringify({ error: code, detail: "free space is below the watermark" }) }],
      { reachable: (answered) => heard.push(answered) },
    );
    await assert.rejects(transport.putChunk(SID, Uint8Array.from([1])), (error) => error.status === 507 && error.code === code);
    assert.equal(sent.length, 1, `${code}: answered once, never retried as if the server were gone`);
    assert.deepEqual(slept, []);
    assert.deepEqual(heard, [true], "a full server is a server that answered");
  }
  for (const status of [500, 502, 503, 504]) {
    const { transport, sent } = harness([{ status }, { status }, { status }]);
    await assert.rejects(transport.account(), (error) => error.code === "unreachable" && error.status === status);
    assert.equal(sent.length, 3, `${status} is retried`);
  }
});

test("a pressed button's call answers within its budget: two attempts, then unreachable, and the background keeps its eight (#182)", async () => {
  const time = clock();
  const off = () => Array.from({ length: 8 }, REFUSED_AT_CONNECT);
  const pressed = harness(off(), { maxAttempts: 8, sleep: time.sleep, now: time.now });
  const call = pressed.transport.account({ interactive: true });
  const seen = watch(call);
  await turns(() => time.asked().includes(750));
  await time.advance(750);
  await turns(() => seen.settled);
  await assert.rejects(call, (error) => error.code === "unreachable" && error.status === 0);
  assert.equal(pressed.sent.length, 2);
  assert.ok(pressed.logged.some((line) => /decision=gave_up attempts=2 budget_ms=10000 duration_ms=750$/.test(line)), pressed.logged.join("|"));

  const background = harness(off(), { maxAttempts: 8 });
  await assert.rejects(background.transport.account(), (error) => error.code === "unreachable");
  assert.equal(background.sent.length, 8);
});

test("a pressed button's call that nothing answers ends at the budget; the late answer is discarded (#182)", async () => {
  const time = clock();
  let answer;
  const heard = [];
  const { transport, logged } = harness([() => new Promise((resolve) => { answer = resolve; })], {
    maxAttempts: 8, sleep: time.sleep, now: time.now, reachable: (answered) => heard.push(answered),
  });
  let settled = false;
  const check = transport.devices({ interactive: true });
  void check.catch(() => undefined).finally(() => { settled = true; });
  await turns(() => answer !== undefined);
  await time.advance(9999);
  assert.equal(settled, false, "not before the budget");
  await time.advance(1);
  await turns(() => settled);
  await assert.rejects(check, (error) => error.code === "unreachable" && /10 s/.test(error.detail));
  assert.ok(logged.some((line) => /^http GET \/v1\/devices decision=gave_up reason=deadline attempts=1 budget_ms=10000 duration_ms=10000$/.test(line)), logged.join("|"));
  answer(DEVICES);
  await turns(() => heard.length === 1);
  assert.deepEqual(heard, [true], "the late answer still says the server is there");
});

test("a signal ends a sleeping retry at once and abandons an attempt in flight, one line each (#157, #182)", async () => {
  const time = clock();
  const sleeping = harness([REFUSED_AT_CONNECT(), DEVICES], { maxAttempts: 8, sleep: time.sleep, now: time.now });
  const stop = new AbortController();
  const call = sleeping.transport.devices({ signal: stop.signal });
  await turns(() => time.asked().length === 1);
  const seen = watch(call);
  stop.abort();
  await turns(() => seen.settled);
  await assert.rejects(call, (error) => error instanceof ApiError && error.status === 0 && error.code === "cancelled");
  assert.equal(sleeping.sent.length, 1, "nothing more was sent");
  assert.equal(sleeping.transport.retryAt(), null, "and nothing is left asleep");
  assert.ok(sleeping.logged.some((line) => /^http GET \/v1\/devices decision=cancelled phase=sleeping attempts=1 duration_ms=\d+$/.test(line)), sleeping.logged.join("|"));

  let answer;
  const flying = harness([() => new Promise((resolve) => { answer = resolve; })]);
  const leave = new AbortController();
  const read = flying.transport.devices({ signal: leave.signal });
  await turns(() => answer !== undefined);
  const reading = watch(read);
  leave.abort();
  await turns(() => reading.settled);
  await assert.rejects(read, (error) => error.code === "cancelled");
  answer(DEVICES);
  assert.ok(flying.logged.some((line) => /^http GET \/v1\/devices decision=cancelled phase=in_flight attempts=1 duration_ms=\d+$/.test(line)), flying.logged.join("|"));

  const ended = new AbortController();
  ended.abort();
  const early = harness([DEVICES]);
  await assert.rejects(early.transport.devices({ signal: ended.signal }), (error) => error.code === "cancelled");
  await assert.rejects(early.transport.putChunk(SID, Uint8Array.from([1]), { signal: ended.signal }), (error) => error.code === "cancelled");
  assert.equal(early.sent.length, 0, "an ended call sends nothing");
});

/** Every key WebCrypto imports while `work` runs, by algorithm. */
async function imported(work) {
  const subtle = globalThis.crypto.subtle;
  const importKey = subtle.importKey;
  const made = [];
  subtle.importKey = async (...args) => {
    const key = await importKey.apply(subtle, args);
    made.push(key.algorithm.name);
    return key;
  };
  try { await work(); } finally { delete subtle.importKey; }
  return made;
}

test("requests sign with a handle imported once per device id; a new id or a leave takes a new one (#197)", async () => {
  const { FakeServer, DEVICE_B, SECRET_B } = await import("./fake.mjs");
  const server = new FakeServer();
  const credential = (id, secretHex) => ({ id, secret: Uint8Array.from(Buffer.from(secretHex, "hex")) });
  let current = credential(DEVICE_ID, DEVICE_SECRET_HEX);
  const transport = new Transport({
    request: server.request, serverUrl: () => SERVER, device: () => current, edgeHeaders: () => [],
    now: () => 1757200000000, sleep: async () => undefined, maxAttempts: 2,
  });
  const signing = await imported(async () => {
    for (let i = 0; i < 3; i++) await transport.devices();
  });
  assert.deepEqual(signing, ["HMAC"], "three signed requests, one import of the device secret");
  // A re-pair is a new device id with its own secret.
  server.addDevice(DEVICE_B, SECRET_B, "iPhone");
  current = credential(DEVICE_B, SECRET_B);
  await transport.devices();
  // A leave drops the handle. Only a test can then hand the SAME id another
  // secret, and only a dropped handle signs for it.
  transport.forgetDevice();
  server.secrets.set(DEVICE_B, Buffer.from("5d".repeat(32), "hex"));
  current = credential(DEVICE_B, "5d".repeat(32));
  await transport.devices();
  assert.equal(server.requests.filter((request) => request.target === "/v1/devices").length, 5);
});

test("a chunk PUT signs the sid as its body digest only for the body encryptChunk made (#197)", async () => {
  const { FakeServer } = await import("./fake.mjs");
  const server = new FakeServer();
  const transport = new Transport({
    request: server.request, serverUrl: () => SERVER,
    device: () => ({ id: DEVICE_ID, secret: Uint8Array.from(Buffer.from(DEVICE_SECRET_HEX, "hex")) }),
    edgeHeaders: () => [], now: () => 1757200000000, sleep: async () => undefined, maxAttempts: 2,
  });
  const domainKey = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
  const one = await c.encryptChunk(domainKey, c.utf8("FIRST CHUNK SENTINEL\n"));
  const two = await c.encryptChunk(domainKey, c.utf8("SECOND CHUNK SENTINEL\n"));
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest;
  const hashed = [];
  subtle.digest = async (algorithm, data) => { hashed.push(data.byteLength); return digest.call(subtle, algorithm, data); };
  try {
    await transport.putChunk(one.sid, one.ciphertext);
    assert.equal(hashed.filter((length) => length === one.ciphertext.length).length, 0, "the sealed body was not hashed again");
    const copy = Uint8Array.from(two.ciphertext);
    await transport.putChunk(two.sid, copy);
    assert.equal(hashed.filter((length) => length === copy.length).length, 1, "a body encryptChunk did not make is hashed");
  } finally { delete subtle.digest; }
  assert.ok(server.chunks.has(one.sid) && server.chunks.has(two.sid), "both landed, each under a valid signature");
  // A sid that is NOT this body's hash: the signature still covers the body
  // really sent, so the server can refuse the pair for what it is.
  const three = await c.encryptChunk(domainKey, c.utf8("THIRD CHUNK SENTINEL\n"));
  await assert.rejects(transport.putChunk(one.sid, three.ciphertext), (error) => error.code === "sid_mismatch");
});

/**
 * AN EXPECTED ANSWER IS NOT A WARNING (the #240 validation run's sweep). A
 * first setup's read of a domain map that does not exist yet, and a new
 * device's poll while approval is pending, were each logged as a refusal at
 * warning level in every healthy setup and pairing. The caller names the one
 * code it reads as an answer; that code, and only that code on that call, is
 * logged as `decision=expected`, which the log sink sends at debug. The error
 * is still thrown, and every other refusal of the same call is still a
 * warning.
 */
test("a refusal the caller expects is logged as expected, and nothing else is", async () => {
  const refused = (status, code) => ({ status, text: JSON.stringify({ error: code, detail: "" }) });
  const h = harness([
    refused(404, "unknown_file"), refused(404, "unknown_file"), refused(404, "route_not_found"),
    refused(409, "not_approved"), refused(410, "envelope_consumed"),
  ]);
  await assert.rejects(h.transport.getFile(FILE_ID, { expected: "unknown_file" }), (error) => error.code === "unknown_file");
  await assert.rejects(h.transport.getFile(FILE_ID), (error) => error.code === "unknown_file");
  await assert.rejects(h.transport.getFile(FILE_ID, { expected: "unknown_file" }), (error) => error.code === "route_not_found");
  await assert.rejects(h.transport.pairingEnvelope(PAIRING_ID), (error) => error.code === "not_approved");
  await assert.rejects(h.transport.pairingEnvelope(PAIRING_ID), (error) => error.code === "envelope_consumed");
  assert.deepEqual(h.logged.map((line) => /decision=(\w+) code=(\w+)/.exec(line)?.slice(1).join(" ")), [
    "expected unknown_file", "refused unknown_file", "refused route_not_found", "expected not_approved", "refused envelope_consumed",
  ]);

  // And the sink sends each at the level its decision names.
  const box = sandbox();
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const said = [];
  const { warn, debug } = console;
  console.warn = (line) => said.push(["warn", line]);
  console.debug = (line) => said.push(["debug", line]);
  try {
    for (const line of h.logged) Plugin.prototype.log.call({}, line);
  } finally {
    Object.assign(console, { warn, debug });
    rmSync(box.home, { recursive: true, force: true });
  }
  assert.deepEqual(said.map(([level]) => level), ["debug", "warn", "warn", "debug", "warn"]);

  // The domain map's own read is the caller that expects `unknown_file`.
  const map = harness([refused(404, "unknown_file")]);
  assert.equal(await loadDomainMap(map.transport, { fileId: FILE_ID, key: new Uint8Array(32) }), null);
  assert.match(map.logged[0], / status=404 decision=expected code=unknown_file /);
});
