// Real plugin crypto/transport/engine against the real server. Only the
// Obsidian filesystem/secret-store boundary and periodic timers are faked.
// The initial root and isolated ordinary/legacy rotation-root draws are synthetic
// vectors; request nonces and operation IDs retain native entropy.
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
const dm = require("../../plugin/build/domainmap.js");
const history = require("../../plugin/build/sync/history.js");
const { publishPause } = require("../../plugin/build/sync/pause.js");
const { enroll2 } = require("../../plugin/build/enrollment2.js");
const backup = require("../../plugin/build/recoveryBackup.js");
const seal2 = require("../../plugin/build/seal2.js");
const { recoverLegacyUpgrade } = require("../../plugin/build/legacyUpgrade.js");
const { RotationClient } = require("../../plugin/build/rotationClient.js");
const { aesSivDecrypt } = require("../../plugin/build/aesSiv.js");
const { accountRecovery } = require("../../plugin/build/accountRecovery.js");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obsync-e2ee-")));
const started = Date.now(), live = new Set(), devices = [], flows = new Set(), controls = new Set();
let aRotationOperation = null;
let server, recorder, logs = "", sent = 0, received = 0, mutation = null, failure;
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
// Explicit synthetic vector: random recovery words can coincide with this
// fixture's ordinary clear vocabulary and make its per-word scan flaky.
// Pairing secrets/nonces and every production derivation still run normally.
const secret = c.hex(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
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
  const { state, reload } = await fakeState(false, false);
  state.data.deviceId = null;
  state.data.deviceSecret = null;
  state.data.vrk = null;
  state.data.serverUrl = `http://127.0.0.1:${recorder.port}`;
  await state.save();
  const host = new FakeHost({ deviceName: name });
  host.clock = Date.now();
  const transport = new Transport({ request, serverUrl: () => state.data.serverUrl,
    device: () => state.data.deviceId ? { id: state.data.deviceId, secret: c.unhex(state.data.deviceSecret) } : null,
    edgeHeaders: () => [], sleep: delay, maxAttempts: 1, log: (line) => host.logs.push(line) });
  const engine = new SyncEngine({ state, transport, host, timers: new FakeTimers() });
  const d = { state, host, transport, engine, reload };
  devices.push(d);
  return d;
}

async function sivKey(base, context) {
  return c.hkdf(base, c.utf8("obsync/seal-v2/siv"), await c.sha256(context), 64);
}

async function chunkKeyInventory(domainKey, scope, cid) {
  const scopeBytes = c.concat(c.unhex(scope.generation), c.unhex(scope.domainId));
  const idKey = await c.hkdf(domainKey, c.utf8("obsync/seal-v2/chunk-id"), scopeBytes, 32);
  const base = await c.hkdf(domainKey, c.utf8("obsync/seal-v2/chunk-base"), scopeBytes, 32);
  const context = seal2.chunkContext(scope, cid);
  return { idKey, base, key: await sivKey(base, context), context };
}

async function startServer(directory = root) {
  let launchLogs = "";
  const env = { PATH: process.env.PATH, OBSYNC_LISTEN: "127.0.0.1:0", OBSYNC_EDGE: "none",
    OBSYNC_BLOBS_DIR: path.join(directory, "blobs"), OBSYNC_JOURNAL_DIR: path.join(directory, "journal"),
    OBSYNC_BLOBS_CAPACITY: "4GiB", OBSYNC_JOURNAL_CAPACITY: "4GiB",
    OBSYNC_DASHBOARD_DIR: path.resolve("dashboard"), OBSYNC_PLUGIN_DIR: path.resolve("plugin/dist") };
  server = spawn(binary, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.on("error", () => {});
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { logs += data; launchLogs += data; });
  for (let i = 0; i < 200; i++) {
    const port = /event=serve_start[^\n]*addr=127\.0\.0\.1:(\d+)/.exec(launchLogs)?.[1];
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
  assert.equal(sent - before[0], 1, "positive-control request count"); assert.equal(received - before[1], 1, "positive-control response count");
  sent = before[0]; received = before[1];
  const report = scan(readCapture(capture), needles);
  assert.deepEqual(report.errors, [], "control must have complete parseable evidence");
  assert.equal(report.decision, "fail", "scanner must detect deliberately leaked secrets");
  for (const label of ["text:control", "key:control"]) {
    for (const where of ["request", "response"]) assert.ok(report.hits.some((hit) => hit.label === label && hit.where === where), `control ${label} ${where}`);
  }
  for (const surface of ["server_storage", "server_logs", "client_diagnostics"]) {
    assert.throws(() => assertNoNeedles(Buffer.from(plaintext + key), needles, surface), undefined, "storage/log scanner positive control");
  }
  controls.add(name);
}

function credentialNeedles(credentials) {
  const hex = { setup: credentials.setup, proof: credentials.proof, nextProof: credentials.proofs.at(-1) };
  if (credentials.enroll !== undefined) hex.enroll = credentials.enroll;
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
      if (request && ["POST /v1/setup", "POST /v1/rotation/prepare", `POST /v1/rotation/${credentials.operation ?? aRotationOperation}/commit`].includes(route)) {
        allow("setup_token", credentials.setup);
        if (route === "POST /v1/setup") for (const proof of credentials.proofs) allow("recovery_proof", proof);
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

// Closed clear-field inventory for the ciphertext-bearing read routes this
// fixture exercises. This does not claim inventory of every production API.
function ciphertextFields(route, body) {
  const fields = (value, names) => assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "ciphertext response clear-field allowlist");
  const version = "version_id parents sids bytes manifest_ct seal_suite device_id ts deleted";
  if (route === "/v1/changes") {
    fields(body, "seq head_seq changes");
    for (const row of body.changes) fields(row, `seq file_id domain_id ${version} heads conflicted`);
  } else if (/^\/v1\/files\/[0-9a-f]{32}\/versions\/[0-9a-f]{64}$/.test(route)) {
    fields(body, version);
  } else if (/^\/v1\/files\/[0-9a-f]{32}$/.test(route)) {
    fields(body, "file_id domain_id heads conflicted versions");
    for (const row of body.versions) fields(row, version);
  } else return false;
  return true;
}

function recipientSnapshot(d) {
  return { files: [...d.host.files].map(([name, file]) => [name, Buffer.from(file.bytes).toString("hex"), file.mtime]),
    folders: [...d.host.explicitFolders], records: structuredClone(d.state.data.files),
    folderRecords: structuredClone(d.state.data.folders), paused: structuredClone(d.state.data.paused) };
}

async function legacyUpgradeFlow() {
  phase("legacy-upgrade");
  const directory = path.join(root, "legacy"), capture = path.join(root, "legacy-capture");
  const before = [sent, received], publicName = "QA-L", sourcePath = "SENTINEL-legacy-source.md";
  const oldRoot = c.hex(Uint8Array.from({ length: 32 }, (_, i) => 0xa1 + i));
  const port = await startServer(directory);
  recorder = await startRecorder({ listen: "127.0.0.1:0", upstream: `127.0.0.1:${port}`, out: capture });
  const old = await device("QA-L"), upgraded = await device("QA-U");
  const token = fs.readFileSync(path.join(directory, "journal/v1/setup-token"), "utf8").trim();
  const recovery = await accountRecovery(oldRoot);
  const credential = ok(await old.transport.setup(token, publicName,
    { name: "QA-L", platform: "linux", app_version: version }, { verifier: recovery.verifier }));
  const oldTransport = old.transport.withCredential(credential, () => {});
  const mapKeys = await dm.domainMapKeys(c.unhex(oldRoot)), domainId = "33".repeat(16), fileId = "44".repeat(16);
  const domainKey = await c.deriveDomainKey(c.unhex(oldRoot), domainId), manifestKey = await c.deriveManifestKey(domainKey, domainId);
  const legacySpec = { text: { source: sourcePath, content: marker }, hex: { vrk: oldRoot, domain: c.hex(domainKey), manifest: c.hex(manifestKey), map: c.hex(mapKeys.key) } };
  // A synthetic released-format source fixture; live legacy sync never starts.
  async function legacyPost(file, domain, key, entry, sids = [], bytes = 0) {
    const sealed = await c.encryptManifest(key, file, await c.contentVersionId(file, [], sids), JSON.stringify(entry));
    const id = await c.versionId(file, [], sealed.ciphertext, sids);
    ok(await oldTransport.postVersion(file, { version_id: id, parents: [], sids, bytes, domain_id: domain,
      manifest_ct: c.base64(sealed.ciphertext), manifest_nonce: c.hex(sealed.nonce), deleted: false }));
  }
  await legacyPost(mapKeys.fileId, mapKeys.domainId, mapKeys.key, dm.defaultDomainMap(domainId));
  const plaintext = c.utf8(marker), chunk = await c.encryptChunk(domainKey, plaintext);
  legacySpec.hex.chunk = c.hex(await c.hkdf(domainKey, c.utf8("obsync/v1/chunk"), chunk.cid, 32));
  await oldTransport.putChunk(chunk.sid, chunk.ciphertext);
  await legacyPost(fileId, domainId, manifestKey, { v: 1, path: sourcePath, domain: domainId,
    size: plaintext.length, mtime: 1200, chunks: [{ cid: c.hex(chunk.cid), sid: chunk.sid, len: plaintext.length }],
    sha256: c.hex(await c.sha256(plaintext)), deleted: false }, [chunk.sid], plaintext.length);
  legacySpec.phrase = (await pairing.recoveryPhrase(c.unhex(oldRoot))).join(" ");
  // Same fixture boundary as ordinary rotation: replace only its fresh root,
  // with both engines stopped. All authentication and operation entropy is native.
  const fixtureRoot = await c.sha256(c.utf8("obsync/e2ee/legacy-upgrade-fixture-independent-root/v2"));
  const nativeEntropy = c.randomBytes, entropyCalls = [];
  c.randomBytes = length => {
    entropyCalls.push(length);
    return length === 32 ? new Uint8Array(fixtureRoot) : nativeEntropy(length);
  };
  try {
    await recoverLegacyUpgrade({ state: upgraded.state, transport: upgraded.transport, token, backup: legacySpec.phrase,
      profile: { name: "QA-U", platform: "linux", app_version: version }, assertCurrent: () => {} });
  } finally { c.randomBytes = nativeEntropy; }
  assert.deepEqual(entropyCalls, [16, 16, 16, 16, 32, 16], "legacy fixture entropy call shape");
  assert.notEqual(c.hex(fixtureRoot), oldRoot, "legacy fixture root is independent of its old vector");
  assert.equal(upgraded.state.custody2().phase, "draft", "legacy recovery stages only a stopped fresh-root upgrade");
  assert.equal(upgraded.state.custody2().rotation.fromSuite, 1, "legacy recovery authenticates its old source suite");
  const operation = upgraded.state.custody2().rotation.intent.operation;
  const client = new RotationClient(upgraded.state, upgraded.transport, () => {}, () => upgraded.engine.stopAndWait());
  const nextRoot = upgraded.state.custody2().rotation.newRoot, nextBackup = await backup.encodeRecoveryBackup(c.unhex(nextRoot));
  legacySpec.hex.current_root = nextRoot;
  await client.prepare(token, nextBackup); await client.seed();
  const restarted = await upgraded.reload();
  const transport = new Transport({ request, serverUrl: () => restarted.data.serverUrl,
    device: () => ({ id: restarted.data.deviceId, secret: c.unhex(restarted.data.deviceSecret) }),
    edgeHeaders: () => [], sleep: delay, maxAttempts: 1, log: line => upgraded.host.logs.push(line) });
  await new RotationClient(restarted, transport, () => {}, async () => {}).commit(token, nextBackup);
  const account = await transport.account();
  assert.equal(account.seal_suite, 2, "legacy upgrade activates suite2 authority");
  assert.notEqual(account.generation, mapKeys.fileId, "legacy upgrade creates a fresh generation");
  upgraded.state = restarted; upgraded.transport = transport;
  upgraded.engine = new SyncEngine({ state: restarted, transport, host: upgraded.host, timers: new FakeTimers() });
  await upgraded.engine.start(); await upgraded.engine.syncNow();
  await readback(() => upgraded.host.text(sourcePath) === marker, "real legacy recovery-upgrade preserves authenticated source bytes");
  const context = upgraded.engine.contextValue, nextMap = await dm.domainMapKeys(c.unhex(nextRoot)), feed = await transport.changes(0, 0);
  legacySpec.hex.current_map = c.hex(nextMap.key); legacySpec.hex.current_domain = c.hex(context.domainKey); legacySpec.hex.current_manifest = c.hex(context.manifestKey);
  assert.ok(feed.changes.every(row => row.seal_suite === 2 && !Object.hasOwn(row, "manifest_nonce")), "upgraded current feed contains only suite2 packets");
  assert.ok(feed.changes.every(row => row.file_id !== fileId && row.file_id !== mapKeys.fileId), "legacy heads remain outside current feed");
  for (const row of feed.changes) {
    const map = row.file_id === nextMap.fileId;
    const aad = seal2.recordContext(map ? 2 : 1, { generation: context.generation, domainId: row.domain_id, fileId: row.file_id, parents: row.parents, sids: row.sids });
    const key = await sivKey(map ? nextMap.key : context.manifestKey, aad);
    legacySpec.hex[`current_record_${row.seq}`] = c.hex(key);
    await aesSivDecrypt(key, c.unbase64(row.manifest_ct), [aad]);
    if (map) continue;
    const manifest = await pull.decodeRecordManifest(context, row);
    for (const item of manifest.chunks) {
      const inventory = await chunkKeyInventory(context.domainKey, { generation: context.generation, domainId: context.domainId }, c.unhex(item.cid));
      legacySpec.hex.current_chunk = c.hex(inventory.key); legacySpec.hex.current_chunk_base = c.hex(inventory.base); legacySpec.hex.current_chunk_id = c.hex(inventory.idKey);
      await aesSivDecrypt(inventory.key, await transport.getChunk(item.sid), [inventory.context]);
    }
  }
  await upgraded.engine.stopAndWait(); await stopServer(); await recorder.close(); recorder = null;
  const needles = [...buildNeedles(legacySpec), ...buildNeedles({ phrase: nextBackup })], conns = readCapture(capture);
  assert.equal(scan(conns, needles).decision, "pass", "legacy upgrade traffic scanner");
  assert.equal(conns.reduce((n, conn) => n + conn.requests.length, 0), sent - before[0], "every legacy upgrade request reached capture");
  assert.equal(received - before[1], sent - before[0], "every legacy upgrade request has a response");
  const credentials = { setup: token, proof: recovery.proof, proofs: [recovery.proof], operation,
    devices: new Map([[credential.device_id, credential.device_secret], [restarted.data.deviceId, restarted.data.deviceSecret]]) };
  const auth = credentialScan(conns, credentials);
  assert.equal(auth.report.decision, "pass", "legacy upgrade credential sink scanner");
  assert.deepEqual(auth.counts, { setup_token: 4, recovery_proof: 1, enroll_token: 0, device_secret: 2 });
  const diagnostics = [...needles, ...credentialNeedles(credentials)];
  for (const file of [...files(path.join(directory, "blobs")), ...files(path.join(directory, "journal"))]) assertNoNeedles(fs.readFileSync(file), needles, "legacy_server_storage");
  assertNoNeedles(Buffer.from(logs), diagnostics, "legacy_server_logs");
  for (const d of [old, upgraded]) assertNoNeedles(Buffer.from(d.host.logs.join("\n")), diagnostics, "legacy_client_diagnostics");
  console.log(`e2ee legacy=pass requests=${sent - before[0]} storage_files=${files(path.join(directory, "blobs")).length + files(path.join(directory, "journal")).length} needles=${needles.length}`);
  flows.add("legacy-recovery-upgrade");
}

try {
  phase("start");
  await positiveControl("control-before");
  const port = await startServer();
  const capture = path.join(root, "capture");
  recorder = await startRecorder({ listen: "127.0.0.1:0", upstream: `127.0.0.1:${port}`, out: capture });
  const a = await device("QA A"), b = await device("QA B");
  const token = fs.readFileSync(path.join(root, "journal/v1/setup-token"), "utf8").trim();
  const recovery = await accountRecovery(secret);
  spec.phrase = await backup.encodeRecoveryBackup(c.unhex(secret));
  assert.equal(c.hex(await backup.parseRecoveryBackup(spec.phrase)), secret);
  await a.state.stageEnrollment2(secret, "new");
  await enroll2(a.state, a.transport, token, "QA account", { name: "QA A", platform: "linux", app_version: version }, () => {});
  await a.engine.start();
  const generation = (await dm.domainMapKeys(c.unhex(secret))).fileId;
  flows.add("setup");
  const invitation = ok(await a.transport.pairingCreate2());
  const creator = await pairing.newPairingKeyExchange(), claimant = await pairing.newPairingKeyExchange();
  const ps = pairing.newPairingSecret();
  const commitment = await pairing.pairingCommitment(invitation.pairing_id, creator.publicKey);
  const code = pairing.encodePairingCode(invitation.pairing_id, invitation.enroll_token, ps, commitment);
  spec.codes = [code]; spec.hex.pairing_secret = c.hex(ps);
  const vaultDetailsKey = await c.hkdf(ps, c.utf8("obsync/v1/pair-vault"), c.utf8(invitation.pairing_id), 32);
  spec.hex.pairing_vault_details = c.hex(vaultDetailsKey);
  const vaultContext = seal2.pairingContext(5, { pairingId: invitation.pairing_id });
  const vaultSivKey = await sivKey(vaultDetailsKey, vaultContext);
  spec.hex.pairing_vault_siv = c.hex(vaultSivKey);
  const vault = await pairing.sealPairingVault2(ps, invitation.pairing_id, { name: vaultName, notes: 0 });
  const claimedCredential = ok(await b.transport.pairingClaim2(invitation.pairing_id, invitation.enroll_token,
    { name: "QA B", platform: "linux", app_version: version, claimant_pub: claimant.publicKey, vault }));
  const claimantTransport = b.transport.withCredential(claimedCredential, () => {});
  const claimed = await a.transport.pairingStatus(invitation.pairing_id);
  assert.equal(claimed.claimant.claimant_pub, claimant.publicKey);
  assert.equal(claimed.claimant.vault.seal_suite, 2);
  assert.equal(Object.hasOwn(claimed.claimant.vault, "nonce"), false);
  assert.deepEqual(await pairing.openPairingVault2(ps, invitation.pairing_id, claimed.claimant.vault), { name: vaultName, notes: 0 },
    "inventoried vault-details key must open the actual paired vault details");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await aesSivDecrypt(vaultSivKey,
    c.unbase64(claimed.claimant.vault.envelope), [vaultContext]))), { name: vaultName, notes: 0 },
    "inventoried vault SIV key must open actual ciphertext");
  await a.transport.pairingReveal(invitation.pairing_id, creator.publicKey);
  let revealed;
  await assert.rejects(claimantTransport.pairingEnvelope(invitation.pairing_id), (error) => {
    revealed = error.fields.creator_pub; return error.code === "not_approved";
  });
  assert.ok(await pairing.keptCommitment(commitment, invitation.pairing_id, revealed));
  assert.equal(await pairing.matchCodeV2(ps, invitation.pairing_id, claimant.publicKey, revealed),
    await pairing.matchCodeV2(ps, invitation.pairing_id, claimed.claimant.claimant_pub, creator.publicKey));
  const impostor = await pairing.newPairingKeyExchange();
  assert.equal(await pairing.keptCommitment(commitment, invitation.pairing_id, impostor.publicKey), false);
  const envelopeKey = await c.derivePairingV2Key(creator.pair, await c.importPairingPublicKey(pairing.checkedPublicKey(claimant.publicKey)), ps, invitation.pairing_id);
  spec.hex.pairing_envelope = c.hex(envelopeKey);
  const envelopeContext = seal2.pairingContext(4, { pairingId: invitation.pairing_id,
    claimantPublic: pairing.checkedPublicKey(claimant.publicKey), creatorPublic: pairing.checkedPublicKey(creator.publicKey) });
  const envelopeSivKey = await sivKey(envelopeKey, envelopeContext);
  spec.hex.pairing_envelope_siv = c.hex(envelopeSivKey);
  const envelope = await pairing.sealEnvelope2(creator, claimed.claimant.claimant_pub, ps, invitation.pairing_id, { v: 2, vrk: secret, generation });
  ok(await a.transport.pairingApprove2(invitation.pairing_id, envelope));
  const collected = ok(await claimantTransport.pairingEnvelope(invitation.pairing_id));
  assert.equal(collected.seal_suite, 2);
  assert.equal(Object.hasOwn(collected, "nonce"), false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await aesSivDecrypt(envelopeSivKey,
    c.unbase64(collected.envelope), [envelopeContext]))), { v: 2, vrk: secret, generation },
    "inventoried envelope SIV key must open actual ciphertext");
  const opened = await pairing.openEnvelope2(claimant, collected.creator_pub, ps, invitation.pairing_id, collected);
  assert.ok(opened.vrk === secret, "paired client received the device-held key");
  assert.equal(opened.generation, generation, "pairing root must bind the locally derived generation");
  await b.state.stageEnrollment2(opened.vrk, "pair");
  assert.ok(await dm.loadDomainMap(claimantTransport, await dm.domainMapKeys(c.unhex(opened.vrk))) !== null,
    "paired client must authenticate an existing map before adoption");
  await b.state.adoptSuite2({ root: opened.vrk, generation: opened.generation,
    deviceId: claimedCredential.device_id, deviceSecret: claimedCredential.device_secret, purpose: "pair" });
  assert.ok((await b.reload()).data.vrk === secret, "recipient must keep the key delivered by pairing before sync");
  flows.add("pairing");
  await b.engine.start();
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
  const movedFolder = "SENTINEL-moved-folder", movedNote = `${movedFolder}/SENTINEL-renamed-note.md`;
  spec.text.movedFolder = movedFolder; spec.text.movedNote = movedNote;
  await a.host.createFolder("SENTINEL-private-folder/SENTINEL-empty-folder");
  a.engine.folderCreated("SENTINEL-private-folder/SENTINEL-empty-folder");
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(async () => (await b.host.listFolders()).includes("SENTINEL-private-folder/SENTINEL-empty-folder"), "empty folder readback");
  assert.equal(await a.host.moveFolder("SENTINEL-private-folder", movedFolder), "moved");
  a.engine.renamedFolder("SENTINEL-private-folder", movedFolder);
  a.engine.folderRenamed("SENTINEL-private-folder", movedFolder);
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(async () => b.host.text(movedNote) === a.host.text(movedNote) &&
    (await b.host.listFolders()).includes(`${movedFolder}/SENTINEL-empty-folder`), "folder move content and empty-folder readback");
  assert.equal(await b.host.stat(renamed), null);
  assert.ok(!(await b.host.listFolders()).includes("SENTINEL-private-folder"));
  flows.add("folder-move");
  const deletePath = "SENTINEL-delete-restore.md", deleteText = "SENTINEL-deleted-private-content";
  spec.text.deletePath = deletePath; spec.text.deleteText = deleteText;
  a.host.seed(deletePath, deleteText, Date.now() + 3);
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(() => b.host.text(deletePath) === deleteText, "pre-delete readback");
  const deleteRecord = a.state.fileByPath(deletePath);
  assert.ok(deleteRecord, "deletion must have an uploaded content version");
  await a.host.trash(deletePath); a.engine.deleted(deletePath);
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(async () => await b.host.stat(deletePath) === null, "deleted recipient readback");
  flows.add("delete");
  const browser = new history.HistoryBrowser(a.engine.contextValue, new history.HistoryOperation(), { newestFirst: false });
  const entries = (await browser.next()).entries;
  const selected = entries.find((entry) => entry.fileId === deleteRecord.fileId && !entry.deleted);
  assert.ok(selected, "real history must retain deleted content");
  assert.ok(entries.some((entry) => entry.fileId === deleteRecord.fileId && entry.deleted), "real history must show the tombstone");
  const restored = await history.restoreCopy(browser, selected);
  spec.text.restoredPath = restored.path;
  assert.equal(a.host.text(restored.path), deleteText, "restored-copy local byte readback");
  await a.engine.syncNow(); await b.engine.syncNow();
  await readback(() => b.host.text(restored.path) === deleteText, "restored-copy recipient readback");
  assert.notEqual(a.state.fileByPath(restored.path).fileId, deleteRecord.fileId, "restoration must use a fresh identity");
  assert.equal(await b.host.stat(deletePath), null, "restoration must not resurrect the deleted original");
  flows.add("restore-copy");
  const pauseTarget = a.state.fileByPath(movedNote).fileId;
  await publishPause(a.engine.contextValue, pauseTarget, movedNote, true);
  // Sync now itself resumes holds; observe the ordinary incoming feed first.
  await readback(() => b.state.data.paused[pauseTarget] !== undefined, "encrypted pause applied");
  assert.equal(b.host.text(movedNote), a.host.text(movedNote), "pause preserves saved bytes");
  // The remote hold must still exist when explicit resume is exercised.
  // Publishing a peer's unpause first lets the feed satisfy this assertion.
  await b.engine.resume(pauseTarget);
  assert.equal(b.state.data.paused[pauseTarget], undefined, "explicit resume clears the hold");
  await publishPause(a.engine.contextValue, pauseTarget, movedNote, false);
  flows.add("pause-control");
  const recovered = await device("QA recovered");
  // Recovery begins with possession of the user's root key, unlike pairing.
  await recovered.state.stageEnrollment2(c.hex(await backup.parseRecoveryBackup(spec.phrase)), "recover");
  const recoveredSetup = await enroll2(recovered.state, recovered.transport, token, "QA account",
    { name: "QA recovered", platform: "linux", app_version: version }, () => {});
  assert.equal(recoveredSetup.recovered, true);
  await recovered.engine.start(); await recovered.engine.syncNow();
  await readback(() => recovered.host.text(movedNote) === a.host.text(movedNote), "recovery retains client-side content decryption");
  flows.add("recovery");
  const receiveContext = { ...recovered.engine.contextValue, signal: new AbortController().signal };
  await recovered.engine.stopAndWait();
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
  for (const record of page.changes) {
    const map = record.file_id === context.mapFileId;
    const recordContext = seal2.recordContext(map ? 2 : 1, { generation, domainId: record.domain_id,
      fileId: record.file_id, parents: record.parents, sids: record.sids });
    const base = map ? (await dm.domainMapKeys(c.unhex(secret))).key : context.manifestKey;
    const key = await sivKey(base, recordContext);
    spec.hex[`record_siv_${record.seq}`] = c.hex(key);
    await aesSivDecrypt(key, c.unbase64(record.manifest_ct), [recordContext]);
    if (map) continue;
    const manifest = await pull.decodeRecordManifest(context, record);
    if (manifest.path === filename && !manifest.deleted && !original) { original = manifest; oldRecord = record; }
    if (manifest.path === future) futureRecord = record;
    for (const chunk of manifest.chunks || []) {
      const inventory = await chunkKeyInventory(context.domainKey, { generation, domainId: context.domainId }, c.unhex(chunk.cid));
      spec.hex[`chunk_id_${chunks}`] = c.hex(inventory.idKey);
      spec.hex[`chunk_base_${chunks}`] = c.hex(inventory.base);
      spec.hex[`chunk_${chunks++}`] = c.hex(inventory.key);
      await aesSivDecrypt(inventory.key, await a.transport.getChunk(chunk.sid), [inventory.context]);
    }
  }
  assert.ok(chunks >= 3, "chunk-key inventory must cover real writes");
  assert.ok(futureRecord, "a new version was written after revocation");
  // The real recipient engine's receive entry, with only its periodic feed
  // stopped so the hostile adapter cannot race an honest delivery. Record
  // bytes come from the real HTTP response and all writes use production pull.
  const beforeReceive = recipientSnapshot(recovered);
  for (const attack of ["manifest", "parents", "chunk"]) {
    phase(`hostile-${attack}`);
    let injected = 0;
    mutation = (input, _res, bytes) => {
      if (input.headers["X-Obsync-Device"] !== recovered.state.data.deviceId) return bytes;
      const route = new URL(input.url).pathname;
      if (attack === "chunk" && route.startsWith("/v1/chunks/")) {
        injected++; const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;
      }
      if (attack !== "chunk" && route === "/v1/changes") {
        const body = JSON.parse(bytes);
        const row = body.changes.find((entry) => entry.version_id === futureRecord.version_id);
        assert.ok(row, "hostile response must contain the target version");
        injected++;
        if (attack === "parents") row.parents = ["0".repeat(64)];
        else { const changed = Buffer.from(row.manifest_ct, "base64"); changed[changed.length - 1] ^= 1; row.manifest_ct = changed.toString("base64"); }
        return Buffer.from(JSON.stringify(body));
      }
      return bytes;
    };
    try {
      const response = await recovered.transport.changes(0, 0);
      const hostile = response.changes.find((entry) => entry.version_id === futureRecord.version_id);
      let outcome;
      await assert.doesNotReject(async () => { outcome = await recovered.engine.receive(receiveContext, hostile); }, `hostile ${attack} must be a per-record refusal`);
      assert.equal(outcome, attack === "chunk" ? null : "refused", `hostile ${attack} must not be applied by the recipient`);
      if (attack === "chunk") {
        assert.deepEqual(recovered.state.data.parked[futureRecord.file_id], { path: future, reason: "chunk_authentication" }, "chunk corruption must remain retryable");
        assert.ok(recovered.host.logs.some((line) => line.includes("decision=parked reason=chunk_authentication")), "chunk parking must be visible");
      }
      assert.ok(injected > 0, `hostile ${attack} must reach an actual response`);
      assert.deepEqual(recipientSnapshot(recovered), beforeReceive, `hostile ${attack} must not change saved bytes or sync records`);
      assert.equal(receiveContext.staged?.size ?? 0, 0, "refused data must not remain staged for reuse");
    } finally { mutation = null; }
  }
  // Keep the real parking mark: ordinary startup/retry must recover it.
  await recovered.engine.start(); await recovered.engine.syncNow();
  await readback(() => recovered.host.text(future) === spec.text.futureContent &&
    recovered.state.data.parked[futureRecord.file_id] === undefined, "honest retry must deliver previously damaged bytes and clear parking");
  flows.add("hostile-receive");
  // Exercise the public feed as well: a damaged record is parked, never
  // applied, and does not stop an unrelated following record from arriving.
  const badPath = "SENTINEL-feed-corruption.md", siblingPath = "SENTINEL-feed-sibling.md";
  spec.text.badPath = badPath; spec.text.badText = "SENTINEL-feed-corrupt-content";
  spec.text.siblingPath = siblingPath; spec.text.siblingText = "SENTINEL-feed-sibling-content";
  const badChunk = await seal2.encryptChunk2(context.domainKey, { generation, domainId: context.domainId }, c.utf8(spec.text.badText)), badSid = badChunk.sid;
  let corruptions = 0;
  mutation = (input, _res, bytes) => {
    if (input.headers["X-Obsync-Device"] !== recovered.state.data.deviceId || !new URL(input.url).pathname.startsWith("/v1/chunks/")) return bytes;
    // Damage only the corrupt note's chunk. The sibling must receive honest
    // bytes, or this would merely test a second damaged version.
    if (new URL(input.url).pathname !== `/v1/chunks/${badSid}`) return bytes;
    corruptions++; const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;
  };
  const logsBeforeFeed = recovered.host.logs.length;
  try {
    a.host.seed(badPath, spec.text.badText, Date.now() + 10); await a.engine.syncNow();
    a.host.seed(siblingPath, spec.text.siblingText, Date.now() + 11); await a.engine.syncNow();
    await readback(() => recovered.host.text(siblingPath) === spec.text.siblingText, "valid sibling must pass the corrupted feed record");
    const feed = await a.transport.changes(0, 0);
    const badRecord = feed.changes.find((row) => row.file_id === a.state.fileByPath(badPath).fileId);
    const siblingRecord = feed.changes.find((row) => row.file_id === a.state.fileByPath(siblingPath).fileId);
    assert.ok(badRecord && siblingRecord && badRecord.seq < siblingRecord.seq, "corrupted feed record must precede its honest sibling");
    for (const [label, record] of [["feed_bad_chunk", badRecord], ["feed_sibling_chunk", siblingRecord]]) {
      const manifest = await pull.decodeRecordManifest(context, record);
      const inventory = await chunkKeyInventory(context.domainKey, { generation, domainId: context.domainId }, c.unhex(manifest.chunks[0].cid));
      spec.hex[label] = c.hex(inventory.key);
      spec.hex[`${label}_base`] = c.hex(inventory.base);
      spec.hex[`${label}_id`] = c.hex(inventory.idKey);
    }
    assert.ok(corruptions > 0, "public feed must receive a damaged real chunk response");
    assert.equal(await recovered.host.stat(badPath), null, "corrupted public-feed bytes must not be applied");
    assert.equal(recovered.state.fileByPath(badPath), undefined, "corrupted public-feed record must not be retained as applied");
    assert.ok(recovered.state.data.lastSeq >= siblingRecord.seq, "feed cursor must advance past the valid sibling");
    assert.deepEqual(recovered.state.data.parked[badRecord.file_id], { path: badPath, reason: "chunk_authentication" }, "damaged public-feed record must remain parked for retry");
    await readback(async () => (await recovered.reload()).data.parked[badRecord.file_id]?.reason === "chunk_authentication", "public-feed parking must persist for restart recovery");
    assert.ok(recovered.host.logs.slice(logsBeforeFeed).some((line) => line.includes("decision=parked reason=chunk_authentication")), "public-feed chunk parking must be visible");
  } finally { mutation = null; }
  const badFileId = a.state.fileByPath(badPath).fileId;
  await recovered.engine.syncNow();
  await readback(() => recovered.host.text(badPath) === spec.text.badText &&
    recovered.state.data.parked[badFileId] === undefined, "honest public-feed retry must recover damaged bytes and clear parking");
  assert.equal(recovered.host.text(siblingPath), spec.text.siblingText, "honest retry must preserve sibling bytes");
  assert.equal((await recovered.reload()).data.parked[badFileId], undefined, "successful public-feed retry must durably clear parking");
  await recovered.engine.stopAndWait();
  flows.add("hostile-feed-progress");
  const mapKeys = await dm.domainMapKeys(c.unhex(secret));
  const honestMap = await dm.loadDomainMap(recovered.transport, mapKeys);
  assert.equal(dm.soleDomain(honestMap), context.domainId, "real encrypted domain-map readback");
  for (const attack of ["ciphertext", "fork"]) {
    let injected = 0;
    mutation = (input, _res, bytes) => {
      if (new URL(input.url).pathname !== `/v1/files/${mapKeys.fileId}`) return bytes;
      const body = JSON.parse(bytes); injected++;
      if (attack === "fork") body.heads.push("0".repeat(64));
      else { const changed = Buffer.from(body.versions[0].manifest_ct, "base64"); changed[changed.length - 1] ^= 1; body.versions[0].manifest_ct = changed.toString("base64"); }
      return Buffer.from(JSON.stringify(body));
    };
    const beforeMap = recipientSnapshot(recovered);
    try {
      await assert.rejects(dm.loadDomainMap(recovered.transport, mapKeys), /domain map refused/, `hostile map ${attack} must be refused`);
      assert.ok(injected > 0, "hostile map must reach a real response");
      assert.deepEqual(recipientSnapshot(recovered), beforeMap, "hostile map must leave saved state untouched");
    } finally { mutation = null; }
    assert.deepEqual(await dm.loadDomainMap(recovered.transport, mapKeys), honestMap, "honest domain map after refusal");
  }
  flows.add("domain-map-refusal");
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
  // Give API-only credentials even the decrypted chunk id; they still cannot
  // derive content keys or authenticate a real manifest/chunk ciphertext.
  const originalChunk = original.chunks[0], originalCiphertext = await a.transport.getChunk(originalChunk.sid);
  for (const apiSecret of [recovered.state.data.deviceSecret, recovery.proof]) {
    const wrongDomain = await c.deriveDomainKey(c.unhex(apiSecret), context.domainId);
    const wrongManifest = await c.deriveManifestKey(wrongDomain, context.domainId);
    await assert.rejects(pull.decodeRecordManifest({ ...context, manifestKey: wrongManifest }, oldRecord), undefined, "API-only credentials cannot decrypt manifests");
    await assert.rejects(seal2.decryptChunk2(wrongDomain, { generation, domainId: context.domainId }, c.unhex(originalChunk.cid), originalCiphertext), undefined, "API-only credentials cannot decrypt chunks");
  }
  assert.equal(new TextDecoder().decode(await seal2.decryptChunk2(context.domainKey, { generation, domainId: context.domainId }, c.unhex(originalChunk.cid), originalCiphertext)), marker + "\n", "actual content key still decrypts after API-only refusals");
  flows.add("api-only-no-decryption");
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
  const originalMapFile = await a.transport.getFile(mapKeys.fileId);
  const mapA = { v: 1, domains: [{ id: c.hex(c.randomBytes(16)), paths: [""] }] };
  const mapB = { v: 1, domains: [{ id: c.hex(c.randomBytes(16)), paths: [""] }] };
  await dm.saveDomainMap(a.transport, mapKeys, mapA, originalMapFile.heads);
  await dm.saveDomainMap(a.transport, mapKeys, mapB, originalMapFile.heads);
  const fork = await a.transport.getFile(mapKeys.fileId);
  assert.equal(fork.heads.length, 2, "real divergent encrypted maps must leave two heads");
  await assert.rejects(dm.loadDomainMap(a.transport, mapKeys), /domain map refused: conflicted/);
  // LIMITATION: an authentic older map plus a falsely presented sole head is
  // decryptable. AEAD supplies authenticity, not universal server freshness.
  let replayed = 0;
  mutation = (input, _res, bytes) => {
    if (new URL(input.url).pathname !== `/v1/files/${mapKeys.fileId}`) return bytes;
    replayed++; return Buffer.from(JSON.stringify(originalMapFile));
  };
  try {
    let replay;
    await assert.doesNotReject(async () => { replay = await dm.loadDomainMap(recovered.transport, mapKeys); }, "authentic old map remains readable under a server replay");
    assert.deepEqual(replay, honestMap, "replayed map must be the original authentic content");
    assert.ok(replayed > 0, "rollback limitation must exercise the real response boundary");
  } finally { mutation = null; }
  await assert.rejects(dm.loadDomainMap(a.transport, mapKeys), /domain map refused: conflicted/, "honest fork is still refused after replay");
  flows.add("domain-map-rollback-limit");
  await dm.saveDomainMap(a.transport, mapKeys, honestMap, fork.heads);
  phase("rotation");
  const client = new RotationClient(a.state, a.transport, () => {}, () => a.engine.stopAndWait());
  // Independent fixed synthetic root avoids accidental recovery-word overlap
  // with public fixture names/errors. Actual native start is a separate probe.
  // All device engines were stopped above. Request nonces and operation IDs
  // remain native: replace ONLY the single root draw and restore immediately.
  const fixtureRoot = await c.sha256(c.utf8("obsync/e2ee/rotation-fixture-independent-root/v2"));
  const nativeEntropy = c.randomBytes, entropyCalls = [];
  c.randomBytes = length => {
    entropyCalls.push(length);
    return length === 32 ? new Uint8Array(fixtureRoot) : nativeEntropy(length);
  };
  try { await client.start(b.state.data.deviceId); }
  finally { c.randomBytes = nativeEntropy; }
  assert.deepEqual(entropyCalls, [16, 16, 16, 32, 16], "rotation fixture entropy call shape");
  assert.notEqual(c.hex(fixtureRoot), secret, "fixture rotation root is independent of the old vector");
  aRotationOperation = a.state.custody2().rotation.intent.operation;
  const nextRoot = a.state.custody2().rotation.newRoot;
  const nextBackup = await backup.encodeRecoveryBackup(c.unhex(nextRoot));
  spec.hex.rotated_root = nextRoot;
  spec.text.rotated_backup = nextBackup;
  await client.prepare(token, nextBackup);
  await client.seed();
  assert.equal(a.state.custody2().phase, "commit_unknown", "real reseed must persist commit receipt");
  const restartedState = await a.reload();
  const restartedTransport = new Transport({ request, serverUrl: () => restartedState.data.serverUrl,
    device: () => ({ id: restartedState.data.deviceId, secret: c.unhex(restartedState.data.deviceSecret) }),
    edgeHeaders: () => [], sleep: delay, maxAttempts: 1 });
  const restartedClient = new RotationClient(restartedState, restartedTransport, () => {}, async () => {});
  await restartedClient.commit(token, nextBackup);
  assert.equal(restartedState.custody2().history.root, secret, "cutover retains the old root for explicit history only");
  assert.equal(restartedState.data.vrk, nextRoot, "real commit adopts only the new root");
  assert.deepEqual(restartedState.data.files, {}, "cutover resets old catalog before rediscovery");
  a.state = restartedState; a.transport = restartedTransport;
  a.engine = new SyncEngine({ state: restartedState, transport: restartedTransport, host: a.host, timers: new FakeTimers() });
  await a.engine.start(); await a.engine.syncNow();
  const beforeEdit = a.host.text(movedNote);
  assert.equal(beforeEdit.includes(marker), true, "cutover preserves same-path original bytes");
  const rotatedText = beforeEdit + "\nSENTINEL-post-rotation-edit";
  spec.text.rotated_edit = "SENTINEL-post-rotation-edit";
  a.host.seed(movedNote, rotatedText, Date.now() + 100);
  await a.engine.syncNow();
  const currentContext = a.engine.contextValue;
  const currentFeed = await a.transport.changes(0, 0);
  spec.hex.rotated_domain = c.hex(currentContext.domainKey);
  spec.hex.rotated_manifest = c.hex(currentContext.manifestKey);
  const nextMapKeys = await dm.domainMapKeys(c.unhex(nextRoot));
  spec.hex.rotated_map = c.hex(nextMapKeys.key);
  for (const row of currentFeed.changes) {
    const map = row.file_id === nextMapKeys.fileId;
    const recordContext = seal2.recordContext(map ? 2 : 1, { generation: currentContext.generation,
      domainId: row.domain_id, fileId: row.file_id, parents: row.parents, sids: row.sids });
    const key = await sivKey(map ? nextMapKeys.key : currentContext.manifestKey, recordContext);
    spec.hex[`rotated_record_siv_${row.seq}`] = c.hex(key);
    await aesSivDecrypt(key, c.unbase64(row.manifest_ct), [recordContext]);
    if (map) continue;
    const manifest = await pull.decodeRecordManifest(currentContext, row);
    for (const [index, chunk] of (manifest.chunks ?? []).entries()) {
      const inventory = await chunkKeyInventory(currentContext.domainKey,
        { generation: currentContext.generation, domainId: currentContext.domainId }, c.unhex(chunk.cid));
      spec.hex[`rotated_chunk_${row.seq}_${index}`] = c.hex(inventory.key);
      spec.hex[`rotated_chunk_base_${row.seq}_${index}`] = c.hex(inventory.base);
      spec.hex[`rotated_chunk_id_${row.seq}_${index}`] = c.hex(inventory.idKey);
      await aesSivDecrypt(inventory.key, await a.transport.getChunk(chunk.sid), [inventory.context]);
    }
  }
  const currentRecord = currentFeed.changes.filter(row => row.file_id === a.state.fileByPath(movedNote).fileId).at(-1);
  assert.ok(currentRecord, "same-path post-cutover write must reach new generation");
  const currentManifest = await pull.decodeRecordManifest(currentContext, currentRecord);
  assert.equal(new TextDecoder().decode(await pull.assembleBytes(currentContext, currentManifest)), rotatedText,
    "new generation authenticates post-cutover same-path content");
  const removedDomainKey = await c.deriveDomainKey(c.unhex(secret), currentContext.domainId);
  const removedManifestKey = await c.deriveManifestKey(removedDomainKey, currentContext.domainId);
  await assert.rejects(seal2.openRecord(removedManifestKey, 1, { generation: currentContext.generation,
    domainId: currentContext.domainId, fileId: currentRecord.file_id, parents: currentRecord.parents, sids: currentRecord.sids },
    c.unbase64(currentRecord.manifest_ct)), undefined, "removed device old root cannot decrypt new-generation manifest");
  const currentChunk = currentManifest.chunks[0];
  const ciphertext = await a.transport.getChunk(currentChunk.sid);
  await assert.rejects(seal2.decryptChunk2(removedDomainKey,
    { generation: currentContext.generation, domainId: currentContext.domainId }, c.unhex(currentChunk.cid), ciphertext), undefined,
    "removed device old root cannot decrypt new-generation chunk even with its ID");
  await assert.rejects(recovered.transport.changes(0, 0), error => error.code === "device_revoked",
    "cutover retires other old device credentials");
  const fresh = await device("QA rotated recovery");
  await fresh.state.stageEnrollment2(nextRoot, "recover");
  const nextRecovery = await accountRecovery(nextRoot);
  await enroll2(fresh.state, fresh.transport, token, "QA account", { name: "QA rotated recovery", platform: "linux", app_version: version }, () => {});
  await fresh.engine.start(); await fresh.engine.syncNow();
  await readback(() => fresh.host.text(movedNote) === rotatedText, "new backup recovery reads post-cutover same path");
  await assert.rejects(fresh.transport.setup2(token, "QA account", { name: "QA old backup", platform: "linux", app_version: version },
    { ...recovery, generation, recoverOnly: true }), error => error.code === "generation_mismatch",
    "old backup cannot enroll into the new generation");
  await a.engine.stopAndWait(); await fresh.engine.stopAndWait();
  flows.add("rotation-future-no-decryption");
  await stopServer();
  await recorder.close(); recorder = null;
  await positiveControl("control-after");
  const originalNeedles = buildNeedles(spec), rotatedNeedles = buildNeedles({ phrase: nextBackup });
  assert.ok(originalNeedles.some(needle => needle.label === "recovery:phrase"), "required needle absent: recovery:phrase");
  assert.ok(rotatedNeedles.some(needle => needle.label === "recovery:phrase"), "required rotated recovery phrase needle");
  const needles = [...originalNeedles, ...rotatedNeedles], conns = readCapture(capture), report = scan(conns, needles);
  for (const label of ["text:note", "text:filename", "text:folder", "text:vault", "text:attachment", "text:edit", "text:futureContent",
    "key:vrk", "key:derived:domain-map", "key:domain", "key:manifest", "key:feed_bad_chunk", "key:feed_sibling_chunk", "key:pairing_secret", "key:pairing_envelope", "key:pairing_vault_details", "key:pairing_envelope_siv", "key:pairing_vault_siv", "key:rotated_root", "key:rotated_domain", "key:rotated_manifest", "key:rotated_map", "recovery:phrase", "pairing:code:0"]) {
    assert.ok(needles.some((needle) => needle.label === label), `required needle absent: ${label}`);
  }
  assert.equal(report.decision, "pass", `traffic scan: ${JSON.stringify(report.errors)} ${report.hits.map((h) => h.label)}`);
  const requests = conns.reduce((n, conn) => n + conn.requests.length, 0);
  assert.equal(requests, sent, "every client request reached capture");
  assert.equal(received, sent, "every request has a response");
  const inventoried = new Set();
  for (const conn of conns) {
    const req = conn.requests[0], response = conn.responses.find((message) => !message.informational);
    const [method, target] = req.head.line.split(" "), route = target.split("?")[0];
    if (method === "GET" && (route === "/v1/changes" || /^\/v1\/files\/[0-9a-f]{32}(?:\/versions\/[0-9a-f]{64})?$/.test(route)) &&
      /^HTTP\/1\.[01] 200 /.test(response.head.line) && ciphertextFields(route, uniqueJson(response.body.toString("utf8")).value)) {
      inventoried.add(route === "/v1/changes" ? "changes" : route.includes("/versions/") ? "version" : "file");
    }
  }
  assert.deepEqual([...inventoried].sort(), ["changes", "file", "version"], "clear-field inventory must exercise all three read routes");
  assert.throws(() => ciphertextFields("/v1/changes", { seq: 0, head_seq: 0, changes: [], debug: "SENTINEL-unlisted-field" }), /clear-field allowlist/, "clear-field allowlist negative control");
  const credentials = { setup: token, proof: recovery.proof, proofs: [recovery.proof, nextRecovery.proof], enroll: invitation.enroll_token, pairing: invitation.pairing_id,
    devices: new Map(devices.map((d) => [d.state.data.deviceId, d.state.data.deviceSecret])) };
  const auth = credentialScan(conns, credentials);
  assert.equal(auth.report.decision, "pass", `credential sink scan: ${JSON.stringify({ errors: auth.report.errors, hits: auth.report.hits })}`);
  assert.deepEqual(auth.counts, { setup_token: 6, recovery_proof: 4, enroll_token: 2, device_secret: 4 });
  const wrongSink = conns.map((conn) => ({ ...conn,
    requests: conn.requests.map((request) => ({ ...request, head: { ...request.head } })) }));
  wrongSink.errors = conns.errors;
  wrongSink[0].requests[0].head.raw += `\r\nX-Control: ${recovery.proof}`;
  const wrong = credentialScan(wrongSink, credentials).report;
  assert.deepEqual(wrong.errors, []);
  assert.equal(wrong.decision, "fail", "a valid proof in an unrelated header must fail");
  assert.ok(wrong.hits.some((hit) => hit.label === "key:proof" && hit.where === "request"));
  for (const route of ["POST /v1/rotation/prepare", `POST /v1/rotation/${aRotationOperation}/commit`]) {
    const ownerConn = conns.find(conn => conn.requests[0]?.head.line.startsWith(`${route} `));
    assert.ok(ownerConn, "rotation credential control must use an actual request");
    const original = ownerConn.requests[0];
    const body = Buffer.concat([original.body.subarray(0, 1), Buffer.from(`"recovery_proof":"${recovery.proof}",`), original.body.subarray(1)]);
    const poisoned = { ...original, body, wire: Buffer.concat([original.wire.subarray(0, original.plainBodyOffset), body]) };
    const wrongOwnerSink = [{ ...ownerConn, requests: [poisoned] }]; wrongOwnerSink.errors = [];
    const refused = credentialScan(wrongOwnerSink, credentials).report;
    assert.deepEqual(refused.errors, [], "owner credential control must retain parseable evidence");
    assert.equal(refused.decision, "fail", "a recovery proof in an owner rotation request must fail");
    assert.ok(refused.hits.some(hit => hit.label === "key:proof" && hit.where === "request"), "owner rotation must retain the unexpected proof hit");
  }
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
    assert.ok(denied.hits.some((hit) => hit.label === "key:proof"), "duplicate credential fields must retain the leaked proof hit");
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
  await legacyUpgradeFlow();
  assert.deepEqual([...flows].sort(), ["api-only-no-decryption", "attachment", "create", "delete", "domain-map-refusal", "domain-map-rollback-limit", "edit", "folder-move", "history", "hostile-feed-progress", "hostile-receive", "legacy-recovery-upgrade", "pairing", "pause-control", "recovery", "rename", "restore-copy", "revocation-access-only", "rotation-future-no-decryption", "setup", "tamper-refusal"], "required runtime flows");
  assert.deepEqual([...controls].sort(), ["control-after", "control-before"], "required scanner positive controls");
  assert.ok(Date.now() - started < budget, "fixture exceeded wall-clock budget");
  console.log(`e2ee decision=pass flows=${flows.size} controls=${controls.size} requests=${sent} main_requests=${requests} storage_files=${stored.length} needles=${needles.length} duration_ms=${Date.now() - started} budget_ms=${budget}`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  clearTimeout(deadline);
  for (const req of live) req.destroy();
  await Promise.allSettled(devices.map((d) => d.engine.stopAndWait()));
  try {
    try { await stopServer(); } finally {
      if (recorder) await recorder.close();
    }
  } catch (error) {
    // An aborted fixture may truncate its relay. Keep that shutdown failure
    // visible without replacing the behavior assertion that aborted it.
    if (failure === undefined) throw error;
    console.error("e2ee cleanup=fail reason=shutdown_failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
