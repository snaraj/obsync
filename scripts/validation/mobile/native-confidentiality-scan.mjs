// Closed native capture + fixed task-owned server files, using candidate scanners.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { owned, privateRead, digest } from './desktop-guard.mjs';
import { candidateCrypto, openCapture, recordContext } from './ciphertext-oracle.mjs';
const MAX = 64 * 1024 * 1024, FILES = 4096;
export class ScanFailure extends Error { constructor(code) { super(code); this.code = code; } }
const need = (ok, code) => { if (!ok) throw new ScanFailure(code); };
const json = path => { need(owned(path).size <= 1048576, 'json_budget'); return JSON.parse(privateRead(path)); };
export function syntheticNotePath(value) {
  if (typeof value !== 'string' || value.length > 240) return false;
  const parts=value.split('/');
  return parts.length<=4 && parts.slice(0,-1).every(p=>/^[A-Za-z0-9][A-Za-z0-9 -]{0,60}$/.test(p)) &&
    /^[A-Za-z0-9][A-Za-z0-9 -]{0,100}(?: \(restored-[a-f0-9]{32}\))?\.md$/.test(parts.at(-1));
}
export function backupInventory(paths) {
  const expected = ['old', 'new', 'unrelated'].map(kind => `private/desktop/phone-${kind}-recovery-backup.txt`);
  need(Array.isArray(paths) && JSON.stringify(paths) === JSON.stringify(expected), 'complete_backup_inventory');
  return paths;
}
export function sourceOpaqueScanner(source) {
  const file = readFileSync(join(source, 'scripts/ci/e2ee.mjs'), 'utf8');
  const snippet = /function assertNoNeedles\(bytes, needles, surface\) \{[\s\S]*?\n\}/.exec(file)?.[0];
  need(snippet && snippet.includes('entry.word === undefined') && snippet.includes('needle.forms, ...needle.raws'), 'opaque_scanner_source');
  return { scan: Function('assert', `return (${snippet});`)(assert), sha256: digest(snippet) };
}
function boundedFile(path, counter, privateMode = false, allowEmpty = false) {
  const stat = owned(path, false, privateMode);
  need((allowEmpty || stat.size > 0) && ++counter.files <= FILES && (counter.bytes += stat.size) <= MAX, 'file_budget_or_empty');
  const bytes = readFileSync(path), after = owned(path, false, privateMode);
  need(bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ino === stat.ino, 'input_changed');
  return bytes;
}
function tree(root, counter, depth = 0) {
  owned(root, true, false); need(depth <= 12, 'directory_budget');
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    need(!entry.isSymbolicLink(), 'linked_server_file');
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...tree(path, counter, depth + 1));
    else { need(entry.isFile(), 'special_server_file'); found.push({ path, bytes: boundedFile(path, counter, false, true) }); }
  }
  return found;
}
export function verifiedTraffic(run, manifest, observer, counter = { files: 0, bytes: 0 }) {
  const root = join(run, 'private/traffic'); owned(root, true);
  need(manifest.schema === 1 && manifest.files && typeof manifest.files === 'object', 'capture_manifest');
  const names = Object.keys(manifest.files).sort();
  need(names.length >= 4 && names.length <= FILES && names.every(name => /^(c[1-9][0-9]*\.(up|down)|index\.jsonl|complete\.json)$/.test(name)) &&
    JSON.stringify(names) === JSON.stringify(readdirSync(root).sort()), 'capture_inventory');
  const files = names.map(name => {
    const bytes = boundedFile(join(root, name), counter, true), declared = manifest.files[name];
    need(declared && declared.bytes === bytes.length && declared.sha256 === digest(bytes), 'capture_file_hash');
    return { name, bytes };
  });
  const connections = observer.readCapture(root);
  need(connections.length > 0 && connections.errors.length === 0 && connections.every(c => c.requests.length > 0 && c.responses.length > 0), 'capture_parse_or_empty');
  return { files, connections, bytes: files.reduce((n, f) => n + f.bytes.length, 0) };
}
export function assertMetadata(bytes, needles, observer, opaque) {
  need(bytes.length > 0 && bytes.length <= 1048576, 'metadata_budget_or_empty');
  const metadata = observer.uniqueJson(bytes.toString('utf8')).value;
  need(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.storageVersion === 2 &&
    metadata.sealPin?.suite === 2 && Number.isSafeInteger(metadata.credentialRevision) && metadata.credentialRevision > 0 &&
    ['vrk', 'deviceSecret', 'edgeHeaders', 'custody', 'enrollment', 'rotation', 'history', 'newRoot', 'root'].every(key => !Object.hasOwn(metadata, key)), 'metadata_secret_schema');
  opaque(bytes, needles, 'android_metadata');
}
export function plantedTrafficControl(run, traffic, observer, needles, rootHex, notePath) {
  const scratch = mkdtempSync(join(run, 'private/confidentiality-control-'));
  try {
    for (const file of traffic.files) writeFileSync(join(scratch, file.name), file.bytes, { mode: 0o600, flag: 'wx' });
    const first = traffic.files.find(f => /^c[1-9][0-9]*\.up$/.test(f.name)); need(first, 'control_request_missing');
    const boundary = first.bytes.indexOf('\r\n\r\n'); need(boundary >= 0, 'control_header_missing');
    const poisoned = Buffer.concat([first.bytes.subarray(0, boundary), Buffer.from(`\r\nX-Obsync-Control: ${rootHex} ${notePath}`), first.bytes.subarray(boundary)]);
    writeFileSync(join(scratch, first.name), poisoned, { mode: 0o600 });
    const rows = privateRead(join(scratch, 'index.jsonl')).split('\n').map(line => JSON.parse(line));
    const n = Number(first.name.slice(1, first.name.indexOf('.'))), row = rows.find(row => row.n === n); need(row, 'control_index_missing');
    row.up = poisoned.length;
    writeFileSync(join(scratch, 'index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    const cloned = observer.readCapture(scratch); need(cloned.errors.length === 0 && cloned.length === traffic.connections.length, 'control_parse');
    const report = observer.scan(cloned, needles);
    need(report.decision === 'fail' && report.errors.length === 0 && report.hits.some(h => h.label === 'key:vrk') &&
      report.hits.some(h => h.label === 'text:path_0'), 'planted_traffic_not_detected');
    return true;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export function opaqueControl(run, original, opaque, needles, rootHex, surface) {
  const scratch = mkdtempSync(join(run, 'private/confidentiality-control-'));
  try {
    const path = join(scratch, 'copy');
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n' + rootHex + '\n')]), { mode: 0o600, flag: 'wx' });
    let detected = false;
    try { opaque(readFileSync(path), needles, surface); } catch (error) { if (error.code === 'ERR_ASSERTION' && error.message.startsWith('unexpected key:')) detected = true; else throw error; }
    need(detected, 'planted_opaque_not_detected'); return true;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
async function inventory(api, observer, run, inputs) {
  const paths = (name, regex, min) => {
    const list = inputs[name]; need(Array.isArray(list) && list.length >= min && list.length <= 128 && new Set(list).size === list.length && list.every(p => typeof p === 'string' && regex.test(p)), `inputs_${name}`);
    return list.map(path => join(run, path));
  };
  const notes = paths('notes', /^private\/desktop\/note-[a-z][a-z0-9-]{0,32}\.json$/, 3).map(json);
  const expectedNotes = readdirSync(join(run, 'private/desktop')).filter(name => /^note-[a-z][a-z0-9-]{0,32}\.json$/.test(name)).sort();
  need(JSON.stringify(expectedNotes) === JSON.stringify(inputs.notes.map(p => p.slice('private/desktop/'.length)).sort()), 'note_inventory_incomplete');
  backupInventory(inputs.backups);
  const backups = paths('backups', /^private\/desktop\/phone-(old|new|unrelated)-recovery-backup\.txt$/, 3).map(privateRead);
  const captures = paths('nativeCaptures', /^private\/desktop\/ciphertext-[a-z][a-z0-9-]{0,32}\.json$/, 3).map(json);
  const expectedCaptures = readdirSync(join(run, 'private/desktop')).filter(name => /^ciphertext-[a-z][a-z0-9-]{0,32}\.json$/.test(name)).sort();
  need(JSON.stringify(expectedCaptures) === JSON.stringify(inputs.nativeCaptures.map(p => p.slice('private/desktop/'.length)).sort()), 'ciphertext_inventory_incomplete');
  const codes = paths('pairingCodes', /^private\/desktop\/(?:[a-z][a-z0-9-]{0,64}\/)?[a-z0-9-]*pair-code\.txt$/, 1).map(privateRead);
  need(codes.every(code => /^[A-Z2-7]{128}$/.test(code)), 'pairing_code_shape');
  const metadata = paths('androidMetadata', /^private\/(?:android-metadata-[a-z][a-z0-9-]{0,64}\.json|android-custody-[a-z][a-z0-9-]{0,64}\/metadata\.json)$/, 1);
  // Raw API credential export was not authorized. Never read a witness file or
  // recover that value indirectly from the capture; content-key proof is separate.
  need(!Object.hasOwn(inputs, 'apiCredentialWitnesses'), 'raw_api_witness_not_authorized');
  const roots = await Promise.all(backups.map(backup => api.backup.parseRecoveryBackup(backup)));
  need(roots.every((root, i) => roots.slice(i + 1).every(other => !api.c.bytesEqual(root, other))), 'backup_roots_not_distinct');
  const text = {}, hex = {}, { c, seal, dm } = api;
  for (const [i, note] of notes.entries()) {
    need(note && syntheticNotePath(note.path) && typeof note.text === 'string' && note.text.startsWith('# ') &&
      Buffer.byteLength(note.text) > 0 && Buffer.byteLength(note.text) <= 16384 && digest(note.text) === note.sha256, 'note_expectation');
    text[`path_${i}`] = note.path; text[`note_${i}`] = note.text;
  }
  let needles = observer.buildNeedles({ text, codes });
  const rootMaps = await Promise.all(roots.map(root => dm.domainMapKeys(root)));
  for (const [i, root] of roots.entries()) needles.push(...observer.buildNeedles({ hex: { vrk: c.hex(root) }, phrase: backups[i] }));
  const siv = async (base, context) => c.hkdf(base, c.utf8('obsync/seal-v2/siv'), await c.sha256(context), 64);
  const usedRoots = new Set();
  for (const [i, capture] of captures.entries()) {
    need(capture.origin === 'native-authenticated-read' && capture.sourceHead === inputs.sourceHead && capture.decoderHash === api.decoderHash &&
      notes.some(note => note.path === capture.expected.path && note.sha256 === capture.expected.sha256), 'capture_provenance');
    // The unrelated root is a refused recovery control. It must be scanned as
    // known secret material, but cannot stand in for either real generation.
    const rootIndex = rootMaps.findIndex(map => map.fileId === capture.note.generation); need(rootIndex === 0 || rootIndex === 1, 'capture_root_missing');
    usedRoots.add(rootIndex);
    const root = roots[rootIndex], map = rootMaps[rootIndex]; await openCapture(api, root, capture);
    const domain = await c.deriveDomainKey(root, capture.note.domain_id), manifest = await c.deriveManifestKey(domain, capture.note.domain_id);
    hex[`domain_${i}`] = c.hex(domain); hex[`manifest_${i}`] = c.hex(manifest);
    hex[`map_siv_${i}`] = c.hex(await siv(map.key, seal.recordContext(2, recordContext(capture.map))));
    hex[`manifest_siv_${i}`] = c.hex(await siv(manifest, seal.recordContext(1, recordContext(capture.note))));
    for (const [j, chunk] of capture.chunks.entries()) {
      const scope = { generation: capture.note.generation, domainId: capture.note.domain_id };
      const scopeBytes = c.concat(c.unhex(scope.generation), c.unhex(scope.domainId));
      const base = await c.hkdf(domain, c.utf8('obsync/seal-v2/chunk-base'), scopeBytes, 32);
      hex[`chunk_id_${i}_${j}`] = c.hex(await c.hkdf(domain, c.utf8('obsync/seal-v2/chunk-id'), scopeBytes, 32));
      hex[`chunk_base_${i}_${j}`] = c.hex(base);
      hex[`chunk_siv_${i}_${j}`] = c.hex(await siv(base, seal.chunkContext(scope, c.unhex(chunk.cid))));
    }
  }
  need(usedRoots.size === 2, 'native_root_coverage_incomplete');
  needles.push(...observer.buildNeedles({ hex }));
  const metadataNeedles = needles.filter(n => !n.label.startsWith('text:'));
  need(needles.length > 10 && metadataNeedles.length > 5 && needles.some(n => n.label === 'key:vrk') && needles.some(n => n.label === 'key:derived:domain-map'), 'needle_inventory_empty');
  return { needles, metadataNeedles, diagnosticNeedles: needles, metadata,
    rootHex: c.hex(roots[0]), notePath: notes[0].path, counts: { notes: notes.length, backups: backups.length, nativeCaptures: captures.length,
      pairingCodes: codes.length, metadataExports: metadata.length, contentNeedles: needles.length } };
}
async function main() {
  const [runArg, flag, sourceArg, ...rest] = process.argv.slice(2), run = resolve(runArg), source = resolve(sourceArg);
  need(flag === '--source' && rest.length === 0, 'arguments');
  owned(run, true); for (const part of ['private', 'evidence', 'private/desktop']) owned(join(run, part), true);
  const started = Date.now(), budget = () => need(Date.now() - started <= 60000, 'scan_time_budget');
  const lab = json(join(run, 'lab.json')), inputs = json(join(run, 'private/confidentiality-inputs.json'));
  need(lab.format === 1 && lab.run === run && lab.source_dirty === false && inputs.schema === 1 && inputs.sourceHead === lab.source_head, 'run_source_binding');
  const api = candidateCrypto(source, lab.source_head, lab.artifacts['plugin/main.js']);
  const observerPath = join(source, 'scripts/ci/observer.mjs'), observerSha256 = digest(readFileSync(observerPath));
  const observer = await import(pathToFileURL(observerPath)), opaque = sourceOpaqueScanner(source);
  const manifestPath = join(run, 'evidence/traffic-manifest.json'), manifest = json(manifestPath), captureManifestSha256 = digest(readFileSync(manifestPath));
  need(manifest.sourceHead === lab.source_head && manifest.observerSha256 === observerSha256, 'observer_capture_binding');
  const counter = { files: 0, bytes: 0 }, traffic = verifiedTraffic(run, manifest, observer, counter); budget();
  const secrets = await inventory(api, observer, run, inputs); budget();
  const report = observer.scan(traffic.connections, secrets.needles);
  need(report.decision === 'pass' && report.errors.length === 0 && report.hits.length === 0, 'native_traffic_leak_or_parse'); budget();
  const stored = [...tree(join(run, 'runtime/server/blobs'), counter), ...tree(join(run, 'runtime/server/journal'), counter)];
  need(stored.length > 3 && stored.some(file => file.bytes.length > 0), 'server_storage_unexercised');
  for (const file of stored) { opaque.scan(file.bytes, secrets.diagnosticNeedles, 'server_storage'); budget(); }
  let log;
  try { need(owned(join(run, 'private/server.log')).size > 0, 'server_logs_unknown'); }
  catch { throw new ScanFailure('server_logs_unknown'); }
  log = boundedFile(join(run, 'private/server.log'), counter, true); opaque.scan(log, secrets.diagnosticNeedles, 'server_log');
  for (const path of secrets.metadata) { const bytes = boundedFile(path, counter, true); assertMetadata(bytes, secrets.metadataNeedles, observer, opaque.scan); budget(); }
  const controls = {
    parseableClonedHttpLeakDetected: plantedTrafficControl(run, traffic, observer, secrets.needles, secrets.rootHex, secrets.notePath),
    copiedServerStorageLeakDetected: opaqueControl(run, stored[0].bytes, opaque.scan, secrets.diagnosticNeedles, secrets.rootHex, 'server_storage_copy'),
    copiedServerLogLeakDetected: opaqueControl(run, log, opaque.scan, secrets.diagnosticNeedles, secrets.rootHex, 'server_log_copy'),
  }; budget();
  // Controls never rewrite native bytes; verify the sealed capture inventory again.
  verifiedTraffic(run, manifest, observer); budget();
  const afterCounter = { files: 0, bytes: 0 };
  const afterStored = [...tree(join(run, 'runtime/server/blobs'), afterCounter), ...tree(join(run, 'runtime/server/journal'), afterCounter)];
  need(JSON.stringify(afterStored.map(f => [f.path, digest(f.bytes)])) === JSON.stringify(stored.map(f => [f.path, digest(f.bytes)])) &&
    digest(boundedFile(join(run, 'private/server.log'), afterCounter, true)) === digest(log), 'server_snapshot_changed'); budget();
  const at = new Date().toISOString(), receipts = ['evidence/native-confidentiality.json', 'evidence/native-confidentiality-controls.json'];
  const common = { schema: 1, result: 'PASS', sourceHead: lab.source_head, observerSha256, captureManifestSha256, opaqueScannerSha256: opaque.sha256, at, physicalPhone: 'NOT_RUN' };
  writeFileSync(join(run, receipts[0]), JSON.stringify({ ...common, origin: 'native-confidentiality', ...secrets.counts,
    trafficConnections: traffic.connections.length, trafficRequests: traffic.connections.reduce((n, c) => n + c.requests.length, 0), trafficBytes: traffic.bytes,
    serverStorageFiles: stored.length, serverLogBytes: log.length, scannedBytes: counter.bytes, scannedFiles: counter.files,
    unexpectedHits: 0, parseErrors: 0, knownRootDerivedKeyCoverageOnly: true, pairingEphemeralKeyInventory: 'NOT_AVAILABLE',
    rawApiCredentialValueScan: 'NOT_MEASURED', apiCredentialTrafficSinks: 'NOT_ASSESSED', androidOsEncryptedStorage: 'NOT_MEASURED', durationMs: Date.now() - started, budgetMs: 60000 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(run, receipts[1]), JSON.stringify({ ...common, origin: 'detached-scanner-controls', baselinePassed: true, ...controls, nativeCaptureUnchanged: true, serverSnapshotUnchanged: true, scratchCleanup: 'VERIFIED' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const result = { schema: 1, result: 'PASS', sourceHead: lab.source_head, observerSha256, captureManifestSha256, receipts };
  writeFileSync(join(run, 'private/scan-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.log(JSON.stringify({ schema: 1, result: 'FAIL',
    coverage: error instanceof ScanFailure && error.code === 'server_logs_unknown' ? 'UNKNOWN' : 'FAILED',
    firstFailure: error instanceof ScanFailure ? error.code : 'native_confidentiality_refused' })); process.exitCode = 1; }
}
