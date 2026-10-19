// Offline parser/scanner controls, not native acceptance or secret-store mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { digest } from './desktop-guard.mjs';
const { sourceOpaqueScanner, verifiedTraffic, assertMetadata, plantedTrafficControl, opaqueControl, syntheticNotePath, backupInventory, recoveryBackupNeedles, requireNativeTraffic, ScanFailure } = await import(process.env.OBSYNC_CONFIDENTIALITY_SCANNER_MODULE ?? './native-confidentiality-scan.mjs');
const source = process.env.OBSYNC_ORACLE_SOURCE;
assert.ok(source, 'declare the clean candidate with OBSYNC_ORACLE_SOURCE');
const observer = await import(pathToFileURL(join(source, 'scripts/ci/observer.mjs')));
const opaque = sourceOpaqueScanner(source), rootHex = 'ab'.repeat(32), notePath = 'Synthetic-private-note.md';
const needles = observer.buildNeedles({ hex: { vrk: rootHex }, text: { path_0: notePath } });
test('all exercised recovery roots are scanned without substituting the refused unrelated root', () => {
  const paths = ['old', 'new', 'unrelated'].map(k => `private/desktop/phone-${k}-recovery-backup.txt`);
  assert.deepEqual(backupInventory(paths), paths);
  for (const wrong of [paths.slice(0,2), [paths[0], paths[2], paths[1]], [...paths, paths[0]], [paths[0], paths[1], paths[1]], null])
    assert.throws(() => backupInventory(wrong), { code: 'complete_backup_inventory' });
});
test('selected-folder synthetic paths remain bounded and relative',()=>{
  for(const path of ['Root.md','Team docs/One.md','Team docs renamed/Two.md','Outside/Sentinel.md','Original (restored-'+'ab'.repeat(16)+').md'])assert.equal(syntheticNotePath(path),true);
  for(const path of ['/One.md','../One.md','Team/../One.md','Team//One.md','A/B/C/D/E.md','Original (restored-x).md','Original (copy).md','One.md\n','C:\\One.md',null])assert.equal(syntheticNotePath(path),false);
});
function fixture(t, value = {}) {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'obsync-confidentiality-'))); chmodSync(run, 0o700);
  t.after(() => rmSync(run, { recursive: true, force: true }));
  mkdirSync(join(run, 'evidence'), { mode: 0o700 }); mkdirSync(join(run, 'private'), { mode: 0o700 }); mkdirSync(join(run, 'private/traffic'), { mode: 0o700 });
  const body = JSON.stringify(value);
  const up = Buffer.from('POST /v1/files/' + 'cd'.repeat(16) + '/versions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  const down = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
  const files = { 'c1.up': up, 'c1.down': down,
    'index.jsonl': Buffer.from(JSON.stringify({ n: 1, up: up.length, down: down.length, upstreamEnded: true }) + '\n'),
    'complete.json': Buffer.from(JSON.stringify({ version: 1, connections: 1, errors: [] })) };
  const manifest = { schema: 1, files: {} };
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(run, 'private/traffic', name), bytes, { mode: 0o600 });
    manifest.files[name] = { sha256: digest(bytes), bytes: bytes.length };
  }
  return { run, manifest };
}
test('existing observer accepts complete bounded sealed traffic and detects planted HTTP clone', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  assert.equal(observer.scan(traffic.connections, needles).decision, 'pass');
  assert.equal(plantedTrafficControl(run, traffic, observer, needles, rootHex, notePath), true);
  assert.throws(() => plantedTrafficControl(run, traffic, { ...observer, scan: () => ({ decision: 'pass', errors: [], hits: [] }) }, needles, rootHex, notePath),
    { code: 'planted_traffic_not_detected' });
  assert.deepEqual(verifiedTraffic(run, manifest, observer).files.map(f => digest(f.bytes)), traffic.files.map(f => digest(f.bytes)));
});
test('missing, altered, empty and over-budget traffic refuse', t => {
  const { run, manifest } = fixture(t);
  const wrong = structuredClone(manifest); wrong.files['c1.up'].sha256 = '00'.repeat(32);
  assert.throws(() => verifiedTraffic(run, wrong, observer), { code: 'capture_file_hash' });
  assert.throws(() => verifiedTraffic(run, manifest, observer, { files: 0, bytes: 64 * 1024 * 1024 }), { code: 'file_budget_or_empty' });
  writeFileSync(join(run, 'private/traffic/c1.up'), '');
  assert.throws(() => verifiedTraffic(run, manifest, observer), { code: 'file_budget_or_empty' });
  rmSync(join(run, 'private/traffic/complete.json'));
  assert.throws(() => verifiedTraffic(run, manifest, observer), { code: 'capture_inventory' });
});
test('parse failures and empty needle sets cannot produce PASS', t => {
  const { run, manifest } = fixture(t);
  const broken = Buffer.from('unparseable HTTP');
  writeFileSync(join(run, 'private/traffic/c1.up'), broken);
  manifest.files['c1.up'] = { sha256: digest(broken), bytes: broken.length };
  assert.throws(() => verifiedTraffic(run, manifest, observer), { code: 'capture_parse_or_empty' });
  const empty = []; empty.errors = [];
  assert.equal(observer.scan(empty, needles).decision, 'fail');
  assert.equal(observer.scan([{ raw: {}, requests: [], responses: [] }], []).decision, 'fail');
});
test('unchanged e2ee opaque scanner detects copied storage/log secrets and kills a disabled control', t => {
  const { run } = fixture(t), original = Buffer.from('opaque baseline');
  assert.doesNotThrow(() => opaque.scan(original, needles, 'synthetic_storage'));
  for (const surface of ['server_storage_copy', 'server_log_copy']) assert.equal(opaqueControl(run, original, opaque.scan, needles, rootHex, surface), true);
  assert.throws(() => opaqueControl(run, original, () => {}, needles, rootHex, 'disabled'), { code: 'planted_opaque_not_detected' });
});
test('metadata permits local paths, refuses known content keys and forbidden credential schema', () => {
  const keyNeedles = needles.filter(n => n.label.startsWith('key:'));
  const value = { storageVersion: 2, sealPin: { suite: 2 }, credentialRevision: 1, files: { [notePath]: {} } };
  const bytes = value => Buffer.from(JSON.stringify(value));
  assert.doesNotThrow(() => assertMetadata(bytes(value), keyNeedles, observer, opaque.scan));
  assert.throws(() => assertMetadata(bytes({ ...value, hidden: rootHex }), keyNeedles, observer, opaque.scan), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertMetadata(bytes({ ...value, deviceSecret: 'synthetic forbidden field' }), keyNeedles, observer, opaque.scan), { code: 'metadata_secret_schema' });
  assert.throws(() => assertMetadata(Buffer.from('{"storageVersion":2,"storageVersion":2}'), keyNeedles, observer, opaque.scan));
});

test('all three complete backups retain roots, full text, derived keys and canonical mnemonics on every secret surface', async t => {
  const { candidateCrypto } = await import(pathToFileURL(join(source, 'scripts/validation/mobile/ciphertext-oracle.mjs')));
  const { execFileSync } = await import('node:child_process');
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const api = candidateCrypto(source, head, digest(readFileSync(join(source, 'plugin/dist/main.js'))));
  const roots = [0, 255, 128].map(byte => new Uint8Array(32).fill(byte));
  const backups = await Promise.all(roots.map(root => api.backup.encodeRecoveryBackup(root)));
  const all = recoveryBackupNeedles(observer, roots, backups, api.c);
  for (const label of ['key:vrk', 'key:derived:domain-map', 'recovery:phrase']) assert.equal(all.filter(n => n.label === label).length, 3);
  assert.equal(all.filter(n => n.label === 'recovery:mnemonic').length, 3);
  assert.ok(backups[1].split(' ').slice(1).every(word => word.length < 7), 'short-word vector isolates missing canonical coverage');
  for (const [i, backup] of backups.entries()) {
    assert.deepEqual(await api.backup.parseRecoveryBackup(backup), roots[i]);
    const mnemonic = backup.split(' ').slice(1).join(' '), { run, manifest } = fixture(t, { synthetic: mnemonic });
    const report = observer.scan(verifiedTraffic(run, manifest, observer).connections, all);
    assert.equal(report.decision, 'fail'); assert.deepEqual(report.errors, []);
    assert.ok(report.hits.some(h => h.label === 'recovery:mnemonic'));
    for (const surface of ['server_storage', 'server_log']) assert.throws(() => opaque.scan(Buffer.from(mnemonic), all, surface), { code: 'ERR_ASSERTION' });
    const metadata = { storageVersion: 2, sealPin: { suite: 2 }, credentialRevision: 1, synthetic: mnemonic };
    assert.throws(() => assertMetadata(Buffer.from(JSON.stringify(metadata)), all.filter(n => !n.label.startsWith('text:')), observer, opaque.scan), { code: 'ERR_ASSERTION' });
  }
  assert.throws(() => recoveryBackupNeedles(observer, roots.slice(0, 2), backups, api.c), { code: 'complete_backup_needles' });
  assert.throws(() => recoveryBackupNeedles(observer, roots, [backups[0].slice('obsync-recovery-v2 '.length), ...backups.slice(1)], api.c), { code: 'canonical_backup' });
});

const binding = { sourceHead: 'a'.repeat(40), bundleSha256: 'b'.repeat(64), observerSha256: 'c'.repeat(64), captureManifestSha256: 'd'.repeat(64) };
const scannerPath = new URL(process.env.OBSYNC_CONFIDENTIALITY_SCANNER_MODULE ?? './native-confidentiality-scan.mjs', import.meta.url);
function rejection(run, report, traffic, scan = observer, deadline = Date.now() + 60000) {
  try { requireNativeTraffic(run, report, binding, traffic, needles, scan, deadline); }
  catch (error) { assert.equal(error.code, 'native_traffic_leak_or_parse'); return error; }
  assert.fail('a native traffic refusal became PASS');
}
const failurePath = run => join(run, 'evidence/native-confidentiality-failure.json');
test('changed public-template source retains its closed failure code', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  const error = rejection(run, { decision: 'fail', errors: ['public_template_source'], hits: [] }, traffic);
  assert.equal(error.failureClass, 'EVIDENCE_PARSE_FAILURE');
  assert.deepEqual(JSON.parse(readFileSync(failurePath(run))).errorCodes, ['public_template_source']);
});
test('native report failure is recorded before throwing without secret labels, values, routes or errors', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  const secret = 'SYNTHETIC-PRIVATE-WORD', route = '/SYNTHETIC-PRIVATE-ROUTE', arbitrary = 'SYNTHETIC-PRIVATE-ERROR';
  const report = { decision: 'fail', errors: ['http_json', arbitrary], hits: [
    { label: 'recovery:word:' + secret, where: 'request', value: secret }, { label: 'recovery:word:7', where: 'response' },
    { label: 'key:chunk_siv_2_3', where: route }, { label: 'text:path_4', where: 'request' }, { label: secret, where: secret }, { label: 'recovery:mnemonic', where: 'response' }],
    skipped: ['recovery:word:' + secret], visible: { routes: [route], agent: secret } };
  const error = rejection(run, report, traffic); assert.equal(error.failureEvidence.status, 'RECORDED');
  const text = readFileSync(failurePath(run), 'utf8'), row = JSON.parse(text);
  assert.equal(error.failureClass, 'CONFIDENTIALITY_SCAN_FAILURE'); assert.equal(error.failureEvidence.status, 'RECORDED');
  assert.equal(error.failureEvidence.sha256, digest(text)); assert.equal(row.result, 'FAIL');
  assert.equal(row.sourceHead, binding.sourceHead); assert.equal(row.bundleSha256, binding.bundleSha256);
  assert.equal(row.observerSha256, binding.observerSha256); assert.equal(row.captureManifestSha256, binding.captureManifestSha256);
  assert.equal(row.scannerSha256, digest(readFileSync(scannerPath))); assert.equal(lstatSync(failurePath(run)).mode & 0o777, 0o600);
  assert.deepEqual(row.hitDetails, [
    { labelClass: 'RECOVERY_WORD', indexes: [], direction: 'REQUEST' }, { labelClass: 'RECOVERY_WORD', indexes: [7], direction: 'RESPONSE' },
    { labelClass: 'CONTENT_KEY', indexes: [2, 3], direction: 'UNKNOWN' }, { labelClass: 'NOTE_PATH', indexes: [4], direction: 'REQUEST' },
    { labelClass: 'UNKNOWN', indexes: [], direction: 'UNKNOWN' }, { labelClass: 'RECOVERY_MNEMONIC', indexes: [], direction: 'RESPONSE' }]);
  assert.deepEqual(row.errorCodes, ['http_json', 'UNKNOWN']); assert.equal(row.unexpectedHits, 6); assert.equal(row.parseErrors, 2);
  for (const forbidden of [secret, route, arbitrary, 'recovery:word:', 'visible', 'routes', 'value']) assert.ok(!text.includes(forbidden), forbidden);
});
test('failure-only message rescan retains numeric facts for empty JSON response without changing primary refusal', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  traffic.connections[0].responses[0].head.line = 'HTTP/1.1 409 Conflict';
  traffic.connections[0].responses[0].body = Buffer.alloc(0);
  const report = observer.scan(traffic.connections, needles); assert.equal(report.decision, 'fail');
  const before = JSON.stringify(report), error = rejection(run, report, traffic), row = JSON.parse(readFileSync(failurePath(run)));
  assert.equal(error.failureClass, 'EVIDENCE_PARSE_FAILURE'); assert.equal(JSON.stringify(report), before);
  assert.ok(row.messageDiagnostics);
  assert.equal(row.messageDiagnostics.method, 'FAILURE_ONLY_MESSAGE_RESCAN'); assert.equal(row.messageDiagnostics.primaryHitOrigin, 'NOT_RECONSTRUCTED');
  assert.equal(row.messageDiagnostics.messagesInspected, 2); assert.equal(row.messageDiagnostics.messagesNotInspected, 0);
  assert.equal(row.messageDiagnostics.rows.length, 1);
  assert.deepEqual(Object.fromEntries(['connectionIndex','messageIndex','direction','status','bodyBytes','contentType'].map(k => [k,row.messageDiagnostics.rows[0][k]])),
    { connectionIndex: 0, messageIndex: 0, direction: 'RESPONSE', status: 409, bodyBytes: 0, contentType: 'JSON' });
  assert.deepEqual(row.messageDiagnostics.rows[0].errorCodes, ['http_json']);
});
test('failure diagnostics are bounded and budget-limited, and incomplete localization cannot pass', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  const report = { decision: 'fail', errors: Array(100).fill('http_json'), hits: Array(300).fill({ label: 'key:vrk', where: 'request' }) };
  let calls = 0; const counted = { scan: (...args) => { calls++; return observer.scan(...args); } };
  const error = rejection(run, report, traffic, counted, 0), row = JSON.parse(readFileSync(failurePath(run)));
  assert.equal(calls, 0, 'no diagnostic decode begins after the remaining budget expired');
  assert.equal(error.failureClass, 'CONFIDENTIALITY_SCAN_FAILURE'); assert.equal(row.hitDetails.length, 128); assert.equal(row.hitDetailsOmitted, 172);
  assert.equal(row.errorCodes.length, 64); assert.equal(row.errorDetailsOmitted, 36); assert.equal(row.messageDiagnostics.status, 'TIME_BUDGET');
  assert.equal(row.messageDiagnostics.messagesInspected, 0); assert.equal(row.messageDiagnostics.messagesNotInspected, 2); assert.equal(row.result, 'FAIL');
});
test('failure-only rescans cap retained message rows with explicit omissions and never substitute their decision', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  traffic.connections[0].requests = Array(40).fill(traffic.connections[0].requests[0]);
  const diagnostic = { scan: () => ({ decision: 'fail', errors: ['http_json'], hits: [], skipped: [] }) };
  rejection(run, { decision: 'fail', errors: [], hits: [{ label: 'key:vrk', where: 'request' }] }, traffic, diagnostic);
  const row = JSON.parse(readFileSync(failurePath(run))); assert.equal(row.result, 'FAIL');
  assert.equal(row.messageDiagnostics.rows.length, 32); assert.equal(row.messageDiagnostics.matchingMessages, 41);
  assert.equal(row.messageDiagnostics.matchingMessagesOmitted, 9); assert.equal(row.messageDiagnostics.messagesNotInspected, 0);
});
test('missing, existing and failed diagnostic evidence never replaces the original scan failure', t => {
  for (const kind of ['missing', 'existing']) {
    const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
    if (kind === 'missing') rmSync(join(run, 'evidence'), { recursive: true });
    else writeFileSync(failurePath(run), 'existing-owned-evidence', { mode: 0o600 });
    const error = rejection(run, { decision: 'fail', errors: ['arbitrary untrusted exception'], hits: [] }, traffic);
    assert.equal(error.failureClass, 'UNCLASSIFIED'); assert.deepEqual(error.failureEvidence, { status: 'WRITE_FAILED' });
    assert.equal(existsSync(join(run, 'private/scan-result.json')), false);
    if (kind === 'existing') assert.equal(readFileSync(failurePath(run), 'utf8'), 'existing-owned-evidence');
  }
});
test('actual main traffic block cannot omit the refusal guard or turn failed/missing evidence into success', t => {
  const code = readFileSync(scannerPath, 'utf8'), block = /  const report = observer.scan\(traffic.connections, secrets.needles\);\n([\s\S]*?)\n  const stored =/.exec(code);
  assert.ok(block, 'actual main traffic block is available');
  const actual = Function('observer','traffic','secrets','run','lab','observerSha256','captureManifestSha256','requireNativeTraffic','started','budget', block[0].slice(0, block[0].lastIndexOf('\n  const stored =')));
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  const scan = { scan: () => ({ decision: 'fail', errors: [], hits: [{ label: 'recovery:phrase', where: 'request' }] }) };
  assert.throws(() => actual(scan, traffic, { needles }, run, { source_head: binding.sourceHead, artifacts: { 'plugin/main.js': binding.bundleSha256 } }, binding.observerSha256,
    binding.captureManifestSha256, requireNativeTraffic, Date.now(), () => {}), { code: 'native_traffic_leak_or_parse' });
  assert.equal(JSON.parse(readFileSync(failurePath(run))).result, 'FAIL');
  assert.doesNotThrow(() => requireNativeTraffic(run, { decision: 'pass', errors: [], hits: [] }, binding, traffic, needles, observer, Date.now() + 60000));
});
test('failure-only diagnostics cap inspections and label aggregate-only findings NOT_LOCALIZED', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  traffic.connections[0].requests = Array(4097).fill(traffic.connections[0].requests[0]);
  const diagnostic = { scan: () => ({ decision: 'pass', errors: [], hits: [], skipped: [] }) };
  rejection(run, { decision: 'fail', errors: [], hits: [{ label: 'key:vrk', where: 'request' }] }, traffic, diagnostic);
  const row = JSON.parse(readFileSync(failurePath(run))); assert.equal(row.result, 'FAIL');
  assert.equal(row.messageDiagnostics.status, 'MESSAGE_CAP'); assert.equal(row.messageDiagnostics.messagesInspected, 4096);
  assert.equal(row.messageDiagnostics.messagesNotInspected, 2); assert.equal(row.messageDiagnostics.localization, 'NOT_LOCALIZED');
});
test('secondary diagnostic exception is closed and cannot replace a known-hit failure', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer), secret = 'SYNTHETIC-ERROR-PRIVATE';
  const diagnostic = { scan: () => { throw new Error(secret); } };
  const error = rejection(run, { decision: 'fail', errors: [], hits: [{ label: 'key:vrk', where: 'request' }] }, traffic, diagnostic);
  assert.equal(error.failureEvidence.status, 'RECORDED');
  const text = readFileSync(failurePath(run), 'utf8'), row = JSON.parse(text); assert.ok(!text.includes(secret));
  assert.equal(row.result, 'FAIL'); assert.equal(row.failureClass, 'CONFIDENTIALITY_SCAN_FAILURE'); assert.equal(row.messageDiagnostics.status, 'SCANNER_ERROR');
});
test('actual CLI catch keeps exit one and classified failure even when diagnostic evidence cannot be saved', async t => {
  const code = readFileSync(scannerPath, 'utf8'), start = code.lastIndexOf('  try { await main(); } catch (error)');
  assert.ok(start >= 0); const block = code.slice(start, code.lastIndexOf('\n}'));
  const actual = new (Object.getPrototypeOf(async function(){}).constructor)('main','ScanFailure','console','process',block);
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer); rmSync(join(run, 'evidence'), { recursive: true });
  const error = rejection(run, { decision: 'fail', errors: ['http_json'], hits: [] }, traffic), printed = [], state = {};
  await actual(async()=>{throw error;},ScanFailure,{log:value=>printed.push(JSON.parse(value))},state);
  assert.equal(state.exitCode, 1); assert.equal(printed.length, 1); assert.equal(printed[0].result, 'FAIL');
  assert.equal(printed[0].firstFailure, 'native_traffic_leak_or_parse'); assert.equal(printed[0].failureClass, 'EVIDENCE_PARSE_FAILURE');
  assert.deepEqual(printed[0].failureEvidence, { status: 'WRITE_FAILED' });
});
test('late diagnostic return cannot claim completed inspection inside the original remaining budget', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer);
  const realNow = Date.now; let now = 9; Date.now = () => now; t.after(() => { Date.now = realNow; });
  const diagnostic = { scan: () => { now = 11; return { decision: 'pass', errors: [], hits: [] }; } };
  rejection(run, { decision: 'fail', errors: ['http_json'], hits: [] }, traffic, diagnostic, 10);
  const row = JSON.parse(readFileSync(failurePath(run))); assert.equal(row.result, 'FAIL');
  assert.equal(row.messageDiagnostics.status, 'TIME_BUDGET'); assert.equal(row.messageDiagnostics.messagesInspected, 0);
  assert.equal(row.messageDiagnostics.messagesNotInspected, 2);
});
test('diagnostic provenance and message projection cannot copy arbitrary binding, target or header strings', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer), secret = 'SYNTHETIC-PRIVATE-IDENTIFIER';
  const badBinding = Object.fromEntries(Object.keys(binding).map(k => [k, secret])); badBinding.extra = secret;
  const message = traffic.connections[0].requests[0]; message.head.line = 'POST /' + secret + ' HTTP/1.1'; message.head['content-type'] = secret;
  const report = { decision: 'fail', errors: ['http_json'], hits: [] }, diagnostic = { scan: () => report };
  assert.throws(() => requireNativeTraffic(run, report, badBinding, traffic, needles, diagnostic, Date.now() + 60000), { code: 'native_traffic_leak_or_parse' });
  const text = readFileSync(failurePath(run), 'utf8'), row = JSON.parse(text); assert.ok(!text.includes(secret));
  for (const key of Object.keys(binding)) assert.equal(row[key], null);
  assert.equal(row.messageDiagnostics.rows[0].contentType, 'OTHER');
});

test('response diagnostics preserve actual request pairing through informational responses without primary attribution', t => {
  const { run, manifest } = fixture(t), traffic = verifiedTraffic(run, manifest, observer), conn = traffic.connections[0];
  const first = conn.requests[0], second = { ...first, head: { ...first.head, line: 'POST /v1/setup HTTP/1.1' } };
  conn.requests = [first, second];
  const original = conn.responses[0];
  conn.responses = [{ ...original, head: { ...original.head, line: 'HTTP/1.1 100 Continue' } }, original,
    { ...original, head: { ...original.head, line: 'HTTP/1.1 409 Conflict' } }];
  let sawPair = false;
  const diagnostic = { scan: list => {
    const response = list[0].responses[0];
    if (response === conn.responses[2]) { assert.equal(list[0].requests[0], second); sawPair = true;
      return { decision: 'fail', errors: ['http_json'], hits: [{ label: 'recovery:word:synthetic', where: 'request' }] }; }
    return { decision: 'pass', errors: [], hits: [] };
  } };
  const report = { decision: 'fail', errors: ['http_json'], hits: [] };
  rejection(run, report, traffic, diagnostic);
  assert.equal(sawPair, true);
  const receipt = JSON.parse(readFileSync(failurePath(run))), row = receipt.messageDiagnostics.rows[0];
  assert.equal(receipt.unexpectedHits, 0); assert.equal(row.pairedRequestIndex, 1);
  assert.equal(row.findingsScope, 'EXCHANGE_CANDIDATE'); assert.equal(row.messageAttribution, 'NOT_RECONSTRUCTED');
  assert.equal(row.hitDetails[0].direction, 'REQUEST'); assert.equal(row.messageIndex, 2);
});
