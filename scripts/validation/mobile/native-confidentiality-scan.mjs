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
export function recoveryBackupNeedles(observer, roots, backups, c) {
  need(roots.length === 3 && backups.length === 3, 'complete_backup_needles');
  return roots.flatMap((root, i) => {
    need(/^obsync-recovery-v2(?: [a-z]+){24}$/.test(backups[i]), 'canonical_backup');
    return observer.buildNeedles({ hex: { vrk: c.hex(root) }, phrase: backups[i],
      text: { mnemonic: backups[i].slice('obsync-recovery-v2 '.length) } })
      .map(needle => needle.label === 'text:mnemonic' ? { ...needle, label: 'recovery:mnemonic' } : needle);
  });
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
  needles.push(...recoveryBackupNeedles(observer, roots, backups, c));
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
    rootHex: c.hex(roots[0]), notePath: notes[0].path, counts: { notes: notes.length, backups: backups.length, canonicalMnemonics: needles.filter(n => n.label === 'recovery:mnemonic').length, nativeCaptures: captures.length,
      pairingCodes: codes.length, metadataExports: metadata.length, contentNeedles: needles.length } };
}
// A failure receipt is a projection, never a copy of scanner-controlled strings.
const ERROR_CODES = new Set(['capture_inventory', 'capture_receipt', 'capture_termination', 'capture_incomplete', 'capture_empty',
  'capture_byte_count', 'capture_exchange_count', 'capture_read', 'capture_unverified', 'needles_empty', 'needles_invalid',
  'scan_budget', 'scan_decode_budget', 'public_template_source', 'http_ambiguous_length', 'http_body_truncated', 'http_bodyless_framing',
  'http_chunk_header', 'http_chunk_size', 'http_chunk_trailer', 'http_chunk_truncated', 'http_content_encoding',
  'http_content_length', 'http_decompression', 'http_duplicate_framing', 'http_header', 'http_header_reserved',
  'http_header_truncated', 'http_json', 'http_json_duplicate', 'http_start_line', 'http_target_encoding', 'http_transfer_encoding']);
const errorCode = value => ERROR_CODES.has(value) ? value : 'UNKNOWN';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function hitClass(hit) {
  const label = typeof hit?.label === 'string' ? hit.label : '', indexes = [];
  let labelClass = 'UNKNOWN', match;
  if (label === 'recovery:phrase') labelClass = 'RECOVERY_PHRASE';
  else if (label === 'recovery:mnemonic') labelClass = 'RECOVERY_MNEMONIC';
  else if (label.startsWith('recovery:word:')) {
    labelClass = 'RECOVERY_WORD';
    if ((match = /^recovery:word:([0-9]{1,4})$/.exec(label)) && +match[1] <= 4095) indexes.push(+match[1]);
  } else if ((match = /^(text:(path|note)_|pairing:code:)([0-9]{1,4})$/.exec(label)) && +match[3] <= 4095) {
    labelClass = match[1] === 'pairing:code:' ? 'PAIRING_CODE' : match[2] === 'path' ? 'NOTE_PATH' : 'NOTE_TEXT'; indexes.push(+match[3]);
  } else if (['key:vrk', 'key:derived:domain-map', 'key:derived:domain', 'key:derived:manifest'].includes(label)) labelClass = 'CONTENT_KEY';
  else if ((match = /^key:(domain|manifest|map_siv|manifest_siv|chunk_id|chunk_base|chunk_siv)_([0-9]{1,4})(?:_([0-9]{1,4}))?$/.exec(label)) &&
    match.slice(2).every(value => value === undefined || +value <= 4095)) {
    labelClass = 'CONTENT_KEY'; indexes.push(...match.slice(2).filter(value => value !== undefined).map(Number));
  }
  return { labelClass, indexes, direction: hit?.where === 'request' ? 'REQUEST' : hit?.where === 'response' ? 'RESPONSE' : 'UNKNOWN' };
}
function redactedFindings(report, hitLimit = 128) {
  const hits = Array.isArray(report?.hits) ? report.hits : [], errors = Array.isArray(report?.errors) ? report.errors : [];
  return { hitsPresent: hits.length > 0, errorsPresent: errors.length > 0, unexpectedHits: hits.length, parseErrors: errors.length,
    hitDetails: hits.slice(0, hitLimit).map(hitClass), hitDetailsOmitted: Math.max(0, hits.length - hitLimit),
    errorCodes: errors.slice(0, 64).map(errorCode), errorDetailsOmitted: Math.max(0, errors.length - 64),
    structuralExceptions: Array.isArray(report?.skipped) ? report.skipped.length : null };
}
function messageDiagnostics(observer, traffic, needles, deadline) {
  const connections = traffic.connections, totalMessages = connections.reduce((n, c) => n + c.requests.length + c.responses.length, 0);
  const result = { method: 'FAILURE_ONLY_MESSAGE_RESCAN', primaryHitOrigin: 'NOT_RECONSTRUCTED', status: 'COMPLETE', totalMessages, messagesInspected: 0,
    matchingMessages: 0, matchingMessagesOmitted: 0, messagesNotInspected: totalMessages, rows: [] };
  outer: for (const [connectionIndex, connection] of connections.entries()) {
    for (const [direction, messages] of [['request', connection.requests], ['response', connection.responses]]) {
      for (const [messageIndex, message] of messages.entries()) {
        if (Date.now() >= deadline) { result.status = 'TIME_BUDGET'; break outer; }
        if (result.messagesInspected >= 4096) { result.status = 'MESSAGE_CAP'; break outer; }
        const pairedRequestIndex = direction === 'response' && /^HTTP\/1\.[01] [2-5][0-9]{2}(?: |$)/.test(message.head?.line ?? '') ?
          connection.responses.slice(0, messageIndex).filter(m => /^HTTP\/1\.[01] [2-5][0-9]{2}(?: |$)/.test(m.head?.line ?? '')).length : null;
        const pairedRequest = pairedRequestIndex === null ? undefined : connection.requests[pairedRequestIndex];
        const isolated = [{ raw: Buffer.isBuffer(message.wire) ? { [direction]: message.wire } : {},
          requests: direction === 'request' ? [message] : pairedRequest ? [pairedRequest] : [], responses: direction === 'response' ? [message] : [] }];
        isolated.errors = [];
        let report;
        try { report = observer.scan(isolated, needles); }
        catch { result.status = 'SCANNER_ERROR'; break outer; }
        if (Date.now() >= deadline) { result.status = 'TIME_BUDGET'; break outer; }
        if (!report || !Array.isArray(report.errors) || !Array.isArray(report.hits)) { result.status = 'SCANNER_ERROR'; break outer; }
        result.messagesInspected++;
        if (report.decision === 'pass' && report.errors.length === 0 && report.hits.length === 0) continue;
        result.matchingMessages++;
        if (result.rows.length >= 32) continue;
        const content = message.head?.['content-type'], type = typeof content === 'string' ? content.split(';', 1)[0].trim().toLowerCase() : '';
        const status = direction === 'response' ? /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/.exec(message.head?.line ?? '') : null;
        result.rows.push({ connectionIndex, messageIndex, direction: direction.toUpperCase(),
          pairedRequestIndex: pairedRequest ? pairedRequestIndex : null, findingsScope: direction === 'response' ? 'EXCHANGE_CANDIDATE' : 'MESSAGE_CANDIDATE',
          messageAttribution: 'NOT_RECONSTRUCTED',
          status: status ? +status[1] : null, bodyBytes: Buffer.isBuffer(message.body) ? message.body.length : null,
          contentType: !content ? 'ABSENT' : type === 'application/json' ? 'JSON' : type === 'application/octet-stream' ? 'BINARY' :
            ['text/plain', 'text/html'].includes(type) ? 'TEXT' : 'OTHER', ...redactedFindings(report, 8) });
      }
    }
  }
  result.messagesNotInspected = totalMessages - result.messagesInspected;
  result.matchingMessagesOmitted = result.matchingMessages - result.rows.length;
  result.localization = result.matchingMessages > 0 ? 'MESSAGE_MATCHES' : 'NOT_LOCALIZED';
  return result;
}
export function requireNativeTraffic(run, report, binding, traffic, needles, observer, deadline) {
  if (report?.decision === 'pass' && Array.isArray(report.errors) && report.errors.length === 0 && Array.isArray(report.hits) && report.hits.length === 0) return;
  const findings = redactedFindings(report), failure = new ScanFailure('native_traffic_leak_or_parse');
  failure.failureClass = findings.hitsPresent ? 'CONFIDENTIALITY_SCAN_FAILURE' : findings.errorsPresent &&
    Array.isArray(report.errors) && report.errors.length <= 64 && report.errors.every(code => ERROR_CODES.has(code)) ? 'EVIDENCE_PARSE_FAILURE' : 'UNCLASSIFIED';
  failure.failureEvidence = { status: 'WRITE_FAILED' };
  try {
    const hash = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value) ? value : null;
    const receipt = { schema: 1, result: 'FAIL', origin: 'native-confidentiality-failure', firstFailure: failure.code,
      failureClass: failure.failureClass, sourceHead: hash(binding.sourceHead, 40), bundleSha256: hash(binding.bundleSha256, 64),
      observerSha256: hash(binding.observerSha256, 64), captureManifestSha256: hash(binding.captureManifestSha256, 64),
      scannerSha256: digest(readFileSync(fileURLToPath(import.meta.url))), ...findings,
      trafficConnections: count(traffic.connections.length), trafficRequests: count(traffic.connections.reduce((n, c) => n + c.requests.length, 0)),
      trafficBytes: count(traffic.bytes), messageDiagnostics: messageDiagnostics(observer, traffic, needles, deadline) };
    const path = join(run, 'evidence/native-confidentiality-failure.json'); owned(join(run, 'evidence'), true);
    const bytes = JSON.stringify(receipt, null, 2) + '\n'; writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    owned(path); need(readFileSync(path, 'utf8') === bytes, 'failure_evidence_readback');
    failure.failureEvidence = { status: 'RECORDED', path: 'evidence/native-confidentiality-failure.json', sha256: digest(bytes) };
  } catch { /* The original scan refusal is never replaced by a diagnostic failure. */ }
  throw failure;
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
  requireNativeTraffic(run, report, { sourceHead: lab.source_head, bundleSha256: lab.artifacts['plugin/main.js'], observerSha256, captureManifestSha256 }, traffic, secrets.needles, observer, started + 60000); budget();
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
    firstFailure: error instanceof ScanFailure ? error.code : 'native_confidentiality_refused',
    ...(error instanceof ScanFailure && error.code === 'native_traffic_leak_or_parse' ? { failureClass: error.failureClass, failureEvidence: error.failureEvidence } : {}) })); process.exitCode = 1; }
}
