// Offline parser/scanner controls, not native acceptance or secret-store mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { digest } from './desktop-guard.mjs';
const { sourceOpaqueScanner, verifiedTraffic, assertMetadata, plantedTrafficControl, opaqueControl, syntheticNotePath, backupInventory } = await import(process.env.OBSYNC_CONFIDENTIALITY_SCANNER_MODULE ?? './native-confidentiality-scan.mjs');
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
function fixture(t) {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'obsync-confidentiality-'))); chmodSync(run, 0o700);
  t.after(() => rmSync(run, { recursive: true, force: true }));
  mkdirSync(join(run, 'private'), { mode: 0o700 }); mkdirSync(join(run, 'private/traffic'), { mode: 0o700 });
  const up = Buffer.from('POST /v1/files/' + 'cd'.repeat(16) + '/versions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
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
