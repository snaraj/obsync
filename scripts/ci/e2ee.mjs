// Real plugin crypto/transport/engine against the real server. Only the
// Obsidian filesystem/secret-store boundary and periodic timers are faked.
// This is required regression evidence, not native-device acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { buildNeedles, readCapture, scan, startRecorder, uniqueJson } from "./observer.mjs";
import { FakeHost, FakeTimers, fakeState } from "../../plugin/test/fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../../plugin/build/transport.js");
const { SyncEngine } = require("../../plugin/build/sync/engine.js");
const c = require("../../plugin/build/crypto.js");
const pairing = require("../../plugin/build/pairing.js");
const pull = require("../../plugin/build/sync/pull.js");
const { accountRecovery } = require("../../plugin/build/accountRecovery.js");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obsync-e2ee-")));
const started = Date.now(), live = new Set(), devices = [], flows = new Set(), controls = new Set();
let server, recorder, logs = "", sent = 0, received = 0, mutation = null;
const budget = 120000;
const deadline = setTimeout(() => {
  // Bound a hung fixture without leaving its child serving after CI exits.
  server?.kill("SIGKILL");
  console.error("e2ee decision=fail reason=deadline budget_ms=120000");
  process.exitCode = 1;
  for (const req of live) req.destroy(new Error("fixture_deadline"));
}, budget);
const binary = path.resolve("target/debug/obsyncd");
const version = JSON.parse(fs.readFileSync("manifest.json", "utf8")).version;
const secret = c.hex(pairing.newVaultKey());
const marker = "SENTINEL-obsync-E2EE-note-corpus-2026";
const filename = "SENTINEL-private-folder/秘密-SENTINEL-private-note.md";
const vaultName = "SENTINEL-private-vault-name";
const spec = { text: { note: marker, filename, folder: "SENTINEL-private-folder", vault: vaultName }, hex: { vrk: secret } };
const ok = (sent) => { assert.equal(sent.outcome, "ok", "request must have a definite result"); return sent.value; };
const phase = (name) => console.log(`e2ee phase=${name} elapsed_ms=${Date.now() - started}`);

async function request(input) {
  sent++;
  return new Promise((resolve, reject) => {
    const req = http.request(input.url, { method: input.method, headers: input.headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (bytes) => chunks.push(bytes));
      res.on("error", reject);
      res.on("end", () => {
        received++;
        let bytes = Buffer.concat(chunks);
        if (mutation) bytes = mutation(input, res, bytes);
        resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString("utf8"), arrayBuffer: Uint8Array.from(bytes).buffer });
      });
    });
    live.add(req);
    req.on("close", () => live.delete(req));
    req.on("error", () => reject(new Error("fixture_http")));
    req.setTimeout(10000, () => req.destroy(new Error("fixture_http_timeout")));
    req.end(input.body === undefined ? undefined : typeof input.body === "string" ? input.body : Buffer.from(input.body));
  });
}

async function readback(probe, message) {
  // syncNow drains local work; the independent incoming feed may still be
  // applying a response. Judge bytes on the recipient within a fixed budget.
  const deadline = Date.now() + 5000;
  while (!(await probe()) && Date.now() < deadline) await delay(10);
  assert.ok(await probe(), message);
}

async function device(name) {
  const { state, reload } = await fakeState();
  state.data.deviceId = null;
  state.data.deviceSecret = null;
  state.data.vrk = null;
  state.data.serverUrl = `http://127.0.0.1:${recorder.port}`;
  const host = new FakeHost({ deviceName: name });
  host.clock = Date.now();
  const transport = new Transport({ request, serverUrl: () => state.data.serverUrl,
    device: () => state.data.deviceId ? { id: state.data.deviceId, secret: c.unhex(state.data.deviceSecret) } : null,
    edgeHeaders: () => [], maxAttempts: 1, log: (line) => host.logs.push(line) });
  const engine = new SyncEngine({ state, transport, host, timers: new FakeTimers() });
  const d = { state, host, transport, engine, reload };
  devices.push(d);
  return d;
}

function credential(d, value) {
  d.state.data.deviceId = value.device_id;
  d.state.data.deviceSecret = value.device_secret;
}

async function startServer() {
  const env = { PATH: process.env.PATH, OBSYNC_LISTEN: "127.0.0.1:0", OBSYNC_EDGE: "none",
    OBSYNC_BLOBS_DIR: path.join(root, "blobs"), OBSYNC_JOURNAL_DIR: path.join(root, "journal"),
    OBSYNC_BLOBS_CAPACITY: "4GiB", OBSYNC_JOURNAL_CAPACITY: "4GiB",
    OBSYNC_DASHBOARD_DIR: path.resolve("dashboard"), OBSYNC_PLUGIN_DIR: path.resolve("plugin/dist") };
  server = spawn(binary, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.on("error", () => {});
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { logs += data; });
  for (let i = 0; i < 200; i++) {
    const port = /event=serve_start[^\n]*addr=127\.0\.0\.1:(\d+)/.exec(logs)?.[1];
    if (port) return Number(port);
    assert.equal(server.exitCode, null, "fixture server exited before readiness");
    await delay(25);
  }
  throw new Error("fixture_start_timeout");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  const kill = setTimeout(() => server.kill("SIGKILL"), 5000);
  const [code] = await exited;
  clearTimeout(kill);
  assert.equal(code, 0, "fixture must flush and stop cleanly");
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), "fixture inventory contains a link");
    return entry.isDirectory() ? files(file) : [file];
  });
}

function assertNoNeedles(bytes, needles, surface) {
  const view = bytes.toString("latin1");
  // Partial recovery words need structural/value context (traffic scanner).
  // Opaque storage/log bytes are checked for the full phrase and other secrets.
  for (const needle of needles.filter((entry) => entry.word === undefined)) assert.ok(![...needle.forms, ...needle.raws].some((value) => view.includes(value)), `unexpected ${needle.label} on ${surface}`);
}

async function positiveControl(name) {
  const key = c.hex(pairing.newVaultKey()), plaintext = "SENTINEL-recorder-positive-control";
  const needles = buildNeedles({ text: { control: plaintext }, hex: { control: key } });
  const responder = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.setHeader("Content-Length", Buffer.byteLength(plaintext + key)); res.end(plaintext + key); });
  });
  responder.listen(0, "127.0.0.1"); await once(responder, "listening");
  const capture = path.join(root, name);
  const relay = await startRecorder({ listen: "127.0.0.1:0", upstream: `127.0.0.1:${responder.address().port}`, out: capture });
  const before = [sent, received];
  try {
    await request({ url: `http://127.0.0.1:${relay.port}/v1/setup`, method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recovery_proof: key, device_secret: plaintext }) });
  } finally {
    await relay.close(); await new Promise((resolve) => responder.close(resolve));
  }
  assert.equal(sent - before[0], 1); assert.equal(received - before[1], 1);
  sent = before[0]; received = before[1];
  const report = scan(readCapture(capture), needles);
  assert.deepEqual(report.errors, [], "control must have complete parseable evidence");
  assert.equal(report.decision, "fail", "scanner must detect deliberately leaked secrets");
  for (const label of ["text:control", "key:control"]) {
    for (const where of ["request", "response"]) assert.ok(report.hits.some((hit) => hit.label === label && hit.where === where), `control ${label} ${where}`);
  }
  for (const surface of ["server_storage", "server_logs", "client_diagnostics"]) {
    assert.throws(() => assertNoNeedles(Buffer.from(plaintext + key), needles, surface));
  }
  controls.add(name);
}

function credentialNeedles(credentials) {
  const hex = { setup: credentials.setup, proof: credentials.proof, enroll: credentials.enroll };
  for (const [i, value] of [...credentials.devices.values()].entries()) hex[`device_${i}`] = value;
  return buildNeedles({ hex });
}

function credentialScan(conns, credentials) {
  const counts = { setup_token: 0, recovery_proof: 0, enroll_token: 0, device_secret: 0 };
  const errors = [...conns.errors];
  const content = conns.map((conn) => {
    const redact = (message, request, route) => {
      const text = message.body.toString("utf8");
      let parsed;
      try { parsed = uniqueJson(text); } catch (error) {
        if (error.message === "http_json_duplicate") errors.push(error.message);
        return message;
      }
      const { value: body, fields } = parsed, spans = [];
      const allow = (field, expected) => {
        const span = fields.find((entry) => entry.name === field && entry.value === expected);
        if (typeof expected === "string" && span) { spans.push(span); counts[field]++; }
      };
      if (request && route === "POST /v1/setup") {
        allow("setup_token", credentials.setup);
        allow("recovery_proof", credentials.proof);
      }
      if (request && route === `POST /v1/pairing/${credentials.pairing}/claim`) allow("enroll_token", credentials.enroll);
      if (!request && route === "POST /v1/pairing" && /^HTTP\/1\.[01] 201 /.test(message.head.line)) allow("enroll_token", credentials.enroll);
      if (!request && /^HTTP\/1\.[01] 20[01] /.test(message.head.line) &&
        ["POST /v1/setup", `POST /v1/pairing/${credentials.pairing}/claim`].includes(route)) {
        allow("device_secret", credentials.devices.get(body?.device_id));
      }
      if (!spans.length) return message;
      // Exact byte spans only. Refuse exception-bearing compressed/chunked
      // bodies rather than discarding framing or encoded bytes to redact them.
      if (!Number.isInteger(message.plainBodyOffset) || !message.wire) {
        errors.push("credential_wire_unsupported"); return message;
      }
      let wire = Buffer.from(message.wire), bytes = Buffer.from(message.body);
      for (const span of spans.sort((a, b) => b.start - a.start)) {
        const start = Buffer.byteLength(text.slice(0, span.start)), end = Buffer.byteLength(text.slice(0, span.end));
        const replacement = Buffer.from('"<expected-authentication-credential>"');
        bytes = Buffer.concat([bytes.subarray(0, start), replacement, bytes.subarray(end)]);
        wire = Buffer.concat([wire.subarray(0, message.plainBodyOffset + start), replacement, wire.subarray(message.plainBodyOffset + end)]);
      }
      return { ...message, body: bytes, wire };
    };
    const route = (i) => conn.requests[i]?.head.line.split(" ").slice(0, 2).join(" ");
    let responseIndex = 0;
    const requests = conn.requests.map((m, i) => redact(m, true, route(i)));
    const responses = conn.responses.map((m) => redact(m, false, route(m.informational ? responseIndex : responseIndex++)));
    return { requests, responses, raw: {
      request: Buffer.concat(requests.map((m) => m.wire)), response: Buffer.concat(responses.map((m) => m.wire)) } };
  });
  content.errors = errors;
  return { report: scan(content, credentialNeedles(credentials)), counts };
}

try {
  phase("start");
  await positiveControl("control-before");
  const port = await startServer();
  const capture = path.join(root, "capture");
  recorder = await startRecorder({ listen: "127.0.0.1:0", upstream: `127.0.0.1:${port}`, out: capture });
  const a = await device("QA A"), b = await device("QA B");
  a.state.data.vrk = secret;
  const token = fs.readFileSync(path.join(root, "journal/v1/setup-token"), "utf8").trim();
  const recovery = await accountRecovery(secret);
  spec.phrase = (await pairing.recoveryPhrase(c.unhex(secret))).join(" ");
  assert.equal(c.hex(await pairing.entropyFromPhrase(pairing.normalisePhrase(spec.phrase))), secret);
  credential(a, ok(await a.transport.setup(token, "QA account", { name: "QA A", platform: "linux", app_version: version }, { verifier: recovery.verifier })));
  flows.add("setup");
  const invitation = ok(await a.transport.pairingCreate());
  const creator = await pairing.newPairingKeyExchange(), claimant = await pairing.newPairingKeyExchange();
  const ps = pairing.newPairingSecret();
  const commitment = await pairing.pairingCommitment(invitation.pairing_id, creator.publicKey);
  const code = pairing.encodePairingCode(invitation.pairing_id, invitation.enroll_token, ps, commitment);
  spec.codes = [code]; spec.hex.pairing_secret = c.hex(ps);
  const vaultDetailsKey = await c.hkdf(ps, c.utf8("obsync/v1/pair-vault"), c.utf8(invitation.pairing_id), 32);
  spec.hex.pairing_vault_details = c.hex(vaultDetailsKey);
  const vault = await pairing.sealPairingVault(ps, invitation.pairing_id, { name: vaultName, notes: 0 });
  credential(b, ok(await b.transport.pairingClaim(invitation.pairing_id, invitation.enroll_token,
    { name: "QA B", platform: "linux", app_version: version, claimant_pub: claimant.publicKey, vault })));
  const claimed = await a.transport.pairingStatus(invitation.pairing_id);
  assert.equal(claimed.claimant.claimant_pub, claimant.publicKey);
  const vaultHandle = await crypto.subtle.importKey("raw", vaultDetailsKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const vaultPlain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: c.unhex(claimed.claimant.vault.nonce),
    additionalData: c.utf8(invitation.pairing_id), tagLength: 128 }, vaultHandle, c.unbase64(claimed.claimant.vault.envelope));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(vaultPlain)), { name: vaultName, notes: 0 },
    "inventoried vault-details key must open the actual paired vault details");
  await a.transport.pairingReveal(invitation.pairing_id, creator.publicKey);
  let revealed;
  await assert.rejects(b.transport.pairingEnvelope(invitation.pairing_id), (error) => {
    revealed = error.fields.creator_pub; return error.code === "not_approved";
  });
  assert.ok(await pairing.keptCommitment(commitment, invitation.pairing_id, revealed));
  assert.equal(await pairing.matchCodeV2(ps, invitation.pairing_id, claimant.publicKey, revealed),
    await pairing.matchCodeV2(ps, invitation.pairing_id, claimed.claimant.claimant_pub, creator.publicKey));
  const impostor = await pairing.newPairingKeyExchange();
  assert.equal(await pairing.keptCommitment(commitment, invitation.pairing_id, impostor.publicKey), false);
  const envelopeKey = await c.derivePairingV2Key(creator.pair, await c.importPairingPublicKey(pairing.checkedPublicKey(claimant.publicKey)), ps, invitation.pairing_id);
  spec.hex.pairing_envelope = c.hex(envelopeKey);
  const envelope = await pairing.sealEnvelopeV2(creator, claimed.claimant.claimant_pub, ps, invitation.pairing_id, { vrk: secret });
  ok(await a.transport.pairingApprove(invitation.pairing_id, envelope.envelope, envelope.nonce));
  const collected = ok(await b.transport.pairingEnvelope(invitation.pairing_id));
  const handle = await crypto.subtle.importKey("raw", envelopeKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const envelopePlain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: c.unhex(collected.nonce),
    additionalData: c.concat(c.utf8(invitation.pairing_id), pairing.checkedPublicKey(claimant.publicKey), pairing.checkedPublicKey(creator.publicKey)), tagLength: 128 },
    handle, c.unbase64(collected.envelope));
  assert.equal(JSON.parse(new TextDecoder().decode(envelopePlain)).vrk, secret, "inventoried envelope key must open the actual envelope");
  const opened = await pairing.openEnvelopeV2(claimant, collected.creator_pub, ps, invitation.pairing_id, collected.envelope, collected.nonce);
  assert.ok(opened.vrk === secret, "paired client received the device-held key");
  b.state.data.vrk = opened.vrk;
  assert.ok(b.state.data.vrk === secret, "recipient must keep the key delivered by pairing before sync");
  flows.add("pairing");
  await a.engine.start(); await b.engine.start();
  phase("sync");
  a.host.seed(filename, marker + "\n", Date.now());
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(() => b.host.text(filename) === marker + "\n", "recipient content readback");
  flows.add("create");
  a.host.seed(filename, marker + "\nSENTINEL-private-edit\n", Date.now() + 1);
  spec.text.edit = "SENTINEL-private-edit";
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(() => b.host.text(filename) === a.host.text(filename), "edited recipient content readback");
  flows.add("edit");
  const attachment = randomFillSync(new Uint8Array(700000));
  const binaryMarker = c.utf8("SENTINEL-private-binary-attachment");
  attachment.set(binaryMarker, 300000);
  spec.text.attachment = "SENTINEL-private-binary-attachment";
  a.host.seed("SENTINEL-private-folder/data.bin", attachment, Date.now() + 2);
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(async () => (await b.host.stat("SENTINEL-private-folder/data.bin")) !== null && Buffer.from(await b.host.read("SENTINEL-private-folder/data.bin")).equals(Buffer.from(attachment)), "binary recipient readback");
  flows.add("attachment");
  const renamed = "SENTINEL-private-folder/SENTINEL-renamed-note.md";
  spec.text.renamed = renamed;
  assert.equal(await a.host.move(filename, renamed), "moved"); a.engine.renamed(filename, renamed);
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(() => b.host.text(renamed) === a.host.text(renamed), "renamed recipient readback");
  assert.equal(await b.host.stat(filename), null);
  flows.add("rename");
  const recovered = await device("QA recovered");
  // Recovery begins with possession of the user's root key, unlike pairing.
  recovered.state.data.vrk = secret;
  const recoveredSetup = ok(await recovered.transport.setup(token, "QA account",
    { name: "QA recovered", platform: "linux", app_version: version }, recovery));
  assert.equal(recoveredSetup.recovered, true);
  credential(recovered, recoveredSetup);
  await recovered.engine.start(); await recovered.engine.syncNow();
  await readback(() => recovered.host.text(renamed) === a.host.text(renamed), "recovery retains client-side content decryption");
  flows.add("recovery");
  const revokedContext = b.engine.contextValue;
  await b.engine.stopAndWait();
  ok(await a.transport.revokeDevice(b.state.data.deviceId));
  await assert.rejects(b.transport.changes(0, 0), (error) => error.code === "device_revoked");
  const future = "SENTINEL-after-revocation.md";
  spec.text.future = future; spec.text.futureContent = "SENTINEL-written-after-revocation";
  a.host.seed(future, spec.text.futureContent, Date.now() + 3);
  await a.engine.syncNow();
  const context = a.engine.contextValue;
  spec.hex.domain = c.hex(context.domainKey); spec.hex.manifest = c.hex(context.manifestKey);
  spec.domainId = context.domainId;
  // Inventory actual chunk keys from authenticated manifests, never from server guesses.
  const page = await a.transport.changes(0, 0);
  let chunks = 0, original, oldRecord, futureRecord;
  for (const record of page.changes.filter((record) => record.file_id !== context.mapFileId)) {
    const manifest = await pull.decodeRecordManifest(context, record);
    if (manifest.path === filename && !manifest.deleted && !original) { original = manifest; oldRecord = record; }
    if (manifest.path === future) futureRecord = record;
    for (const chunk of manifest.chunks || []) {
      spec.hex[`chunk_${chunks++}`] = c.hex(await c.hkdf(context.domainKey, c.utf8("obsync/v1/chunk"), c.unhex(chunk.cid), 32));
    }
  }
  assert.ok(chunks >= 3, "chunk-key inventory must cover real writes");
  assert.ok(futureRecord, "a new version was written after revocation");
  // Pin the PRESENT LIMITATION, never call this cryptographic revocation.
  // Model a compromised server supplying ciphertext by using A's transport
  // with only the keys B retained before it was revoked.
  const retained = { ...revokedContext, transport: a.transport, signal: new AbortController().signal };
  const futureManifest = await pull.decodeRecordManifest(retained, futureRecord);
  assert.ok(new TextDecoder().decode(await pull.assembleBytes(retained, futureManifest)) === spec.text.futureContent,
    "access-only revocation leaves retained content keys usable");
  flows.add("revocation-access-only");
  assert.ok(original && oldRecord, "original history version must exist");
  assert.ok(new TextDecoder().decode(await pull.assembleBytes(context, original)) === marker + "\n", "history readback decrypts original bytes");
  flows.add("history");
  // Exercise the production receive path with hostile bytes at the HTTP
  // adapter boundary. The raw recording remains the real server's bytes.
  let tampered = 0;
  mutation = (input, _res, bytes) => {
    if (new URL(input.url).pathname.startsWith("/v1/chunks/")) {
      tampered++; const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;
    }
    return bytes;
  };
  await assert.rejects(pull.assembleBytes(context, original));
  assert.ok(tampered > 0, "negative case must reach a real chunk response");
  mutation = null;
  assert.ok(new TextDecoder().decode(await pull.assembleBytes(context, original)) === marker + "\n", "honest history remains readable after refusal");
  const altered = structuredClone(oldRecord);
  const ct = Buffer.from(altered.manifest_ct, "base64"); ct[ct.length - 1] ^= 1; altered.manifest_ct = ct.toString("base64");
  await assert.rejects(pull.decodeRecordManifest(context, altered));
  await assert.rejects(pull.decodeRecordManifest(context, { ...oldRecord, file_id: "0".repeat(32) }));
  await assert.rejects(pull.decodeRecordManifest({ ...context, manifestKey: pairing.newVaultKey() }, oldRecord));
  flows.add("tamper-refusal");
  for (const d of devices) await d.engine.stopAndWait();
  await stopServer();
  await recorder.close(); recorder = null;
  await positiveControl("control-after");
  const needles = buildNeedles(spec), conns = readCapture(capture), report = scan(conns, needles);
  for (const label of ["text:note", "text:filename", "text:folder", "text:vault", "text:attachment", "text:edit", "text:futureContent",
    "key:vrk", "key:derived:domain-map", "key:domain", "key:manifest", "key:pairing_secret", "key:pairing_envelope", "key:pairing_vault_details", "recovery:phrase", "pairing:code:0"]) {
    assert.ok(needles.some((needle) => needle.label === label), `required needle absent: ${label}`);
  }
  assert.equal(report.decision, "pass", `traffic scan: ${JSON.stringify(report.errors)} ${report.hits.map((h) => h.label)}`);
  const requests = conns.reduce((n, conn) => n + conn.requests.length, 0);
  assert.equal(requests, sent, "every client request reached capture");
  assert.equal(received, sent, "every request has a response");
  const credentials = { setup: token, proof: recovery.proof, enroll: invitation.enroll_token, pairing: invitation.pairing_id,
    devices: new Map(devices.map((d) => [d.state.data.deviceId, d.state.data.deviceSecret])) };
  const auth = credentialScan(conns, credentials);
  assert.equal(auth.report.decision, "pass", `credential sink scan: ${JSON.stringify({ errors: auth.report.errors, hits: auth.report.hits })}`);
  assert.deepEqual(auth.counts, { setup_token: 2, recovery_proof: 1, enroll_token: 2, device_secret: 3 });
  const wrongSink = conns.map((conn) => ({ ...conn,
    requests: conn.requests.map((request) => ({ ...request, head: { ...request.head } })) }));
  wrongSink.errors = conns.errors;
  wrongSink[0].requests[0].head.raw += `\r\nX-Control: ${recovery.proof}`;
  const wrong = credentialScan(wrongSink, credentials).report;
  assert.deepEqual(wrong.errors, []);
  assert.equal(wrong.decision, "fail", "a valid proof in an unrelated header must fail");
  assert.ok(wrong.hits.some((hit) => hit.label === "key:proof" && hit.where === "request"));
  // Duplicate members must not erase the earlier credential before scanning.
  const setupConn = conns.find((conn) => conn.requests[0]?.head.line.startsWith("POST /v1/setup "));
  for (const field of ['"debug"', '"de\\u0062ug"']) {
    const original = setupConn.responses[0];
    const addition = `"debug":"${recovery.proof}",${field}:null,`;
    const body = Buffer.concat([original.body.subarray(0, 1), Buffer.from(addition), original.body.subarray(1)]);
    const poisoned = { ...original, body, wire: Buffer.concat([original.wire.subarray(0, original.plainBodyOffset), body]) };
    const duplicate = [{ ...setupConn, responses: [poisoned] }]; duplicate.errors = [];
    const denied = credentialScan(duplicate, credentials).report;
    assert.equal(denied.decision, "fail", "duplicate credential fields must fail");
    assert.ok(denied.hits.some((hit) => hit.label === "key:proof"));
    assert.ok(denied.errors.includes("http_json_duplicate"));
  }
  const diagnosticNeedles = [...needles, ...credentialNeedles(credentials)];
  for (const credential of credentialNeedles(credentials)) {
    for (const surface of ["server_logs", "client_diagnostics"]) {
      assert.throws(() => assertNoNeedles(Buffer.from(credential.raws[0], "latin1"), diagnosticNeedles, surface),
        /unexpected key:/, "diagnostic credential positive control");
    }
  }
  const stored = [...files(path.join(root, "blobs")), ...files(path.join(root, "journal"))];
  assert.ok(stored.length > 3, "server storage was exercised");
  for (const file of stored) assertNoNeedles(fs.readFileSync(file), needles, "server_storage");
  assertNoNeedles(Buffer.from(logs), diagnosticNeedles, "server_logs");
  for (const d of devices) assertNoNeedles(Buffer.from(d.host.logs.join("\n")), diagnosticNeedles, "client_diagnostics");
  assert.deepEqual([...flows].sort(), ["attachment", "create", "edit", "history", "pairing", "recovery", "rename", "revocation-access-only", "setup", "tamper-refusal"]);
  assert.deepEqual([...controls].sort(), ["control-after", "control-before"]);
  assert.ok(Date.now() - started < budget, "fixture exceeded wall-clock budget");
  console.log(`e2ee decision=pass flows=${flows.size} controls=${controls.size} requests=${requests} storage_files=${stored.length} needles=${needles.length} duration_ms=${Date.now() - started} budget_ms=${budget}`);
} finally {
  clearTimeout(deadline);
  for (const req of live) req.destroy();
  await Promise.allSettled(devices.map((d) => d.engine.stopAndWait()));
  try { await stopServer(); } finally {
    try { if (recorder) await recorder.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
