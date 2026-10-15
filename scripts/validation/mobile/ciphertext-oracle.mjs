// Detached reads only: candidate crypto receives privately captured native bytes.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { owned, privateRead, digest } from './desktop-guard.mjs';

export class OracleFailure extends Error { constructor(code) { super(code); this.code = code; } }
const check = (value, code) => { if (!value) throw new OracleFailure(code); };
const id = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size * 2}}$`).test(value);
// Serializable into the owned renderer; hashes ciphertext version metadata only.
export function canonicalVersion(record) {
  const clean = Object.fromEntries(Object.entries(record).filter(([key]) => !['file_id', 'domain_id', 'generation'].includes(key)));
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(clean));
}
export function assertCurrentHeadProof(capture, sourceHead, bundleSha256) {
  const proof = capture?.headProof;
  check(proof?.schema === 1 && id(sourceHead, 20) && id(bundleSha256, 32) && capture.sourceHead === sourceHead && capture.bundleSha256 === bundleSha256 &&
    proof.sourceHead === sourceHead && proof.bundleSha256 === bundleSha256, 'current_heads_source_binding');
  const times = [proof.before?.observedAt, capture.capturedAt, proof.after?.observedAt].map(Date.parse);
  check(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2] && times[2] - times[0] <= 120000, 'current_heads_observation_interval');
  for (const witness of [proof.before, proof.after]) {
    check(witness?.generation === capture.note?.generation && witness.generation === capture.map?.generation, 'current_heads_generation');
    for (const kind of ['note', 'map']) {
      const observed = witness[kind], record = capture[kind];
      check(id(record?.file_id, 16) && id(record.domain_id, 16) && id(record.version_id, 32) &&
        observed?.fileId === record.file_id && observed.domainId === record.domain_id, 'current_heads_record_binding');
      check(Array.isArray(observed.heads) && observed.heads.length === 1 && observed.heads[0] === record.version_id, 'captured_version_not_current_head');
      check(observed.recordSha256 === digest(canonicalVersion(record)), 'current_head_record_changed');
    }
  }
  return digest(JSON.stringify(proof));
}
export function assertHeadProofReceipt(capture, receipt, sourceHead, bundleSha256) {
  const proofHash = assertCurrentHeadProof(capture, sourceHead, bundleSha256);
  check(receipt?.sourceHead === sourceHead && receipt.currentHeadsBeforeAndAfter === true && receipt.headProofSha256 === proofHash,
    'current_heads_receipt_binding');
  return proofHash;
}
export function assertBundledModule(bundle, name, code) {
  const wrapped = `__modules[${JSON.stringify(name)}] = function (module, exports, require) {\n${code}};\n`;
  check(bundle.split(wrapped).length === 2, 'decoder_not_in_installed_bundle');
}
export function candidateCrypto(source, head, bundleSha256) {
  source = resolve(source);
  const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  check(realpathSync(source) === source && git(['rev-parse', 'HEAD']) === head && !git(['status', '--porcelain']), 'source_binding');
  const bundlePath = join(source, 'plugin/dist/main.js'); owned(bundlePath, false, false);
  const bundle = readFileSync(bundlePath, 'utf8');
  check(id(bundleSha256, 32) && digest(bundle) === bundleSha256, 'bundle_binding');
  const build = join(source, 'plugin/build'), seen = new Set(), hashes = {};
  function bind(name) {
    if (seen.has(name)) return;
    check(/^\.\/[A-Za-z0-9/_-]+$/.test(name) && !name.includes('..'), 'module_name');
    seen.add(name);
    const path = join(build, name.slice(2) + '.js'); owned(path, false, false);
    const code = readFileSync(path, 'utf8'); assertBundledModule(bundle, name, code);
    hashes[name] = digest(code);
    for (const match of code.matchAll(/\brequire\("([^"\n]+)"\)/g)) {
      check(match[1].startsWith('.'), 'decoder_external_dependency');
      const dependency = relative(build, resolve(dirname(path), match[1])).split('\\').join('/');
      bind('./' + dependency);
    }
  }
  for (const name of ['./crypto', './seal2', './recoveryBackup', './domainmap', './sealWire']) bind(name);
  const require = createRequire(pathToFileURL(join(build, 'crypto.js')));
  return { c: require('./crypto.js'), seal: require('./seal2.js'), backup: require('./recoveryBackup.js'),
    dm: require('./domainmap.js'), wire: require('./sealWire.js'), decoderHash: digest(JSON.stringify(hashes)) };
}
export function recordContext(record) {
  return { generation: record.generation, domainId: record.domain_id, fileId: record.file_id, parents: record.parents, sids: record.sids };
}
function packet(api, record) {
  check(id(record?.generation, 16) && id(record.file_id, 16) && id(record.domain_id, 16) && id(record.version_id, 32), 'record_context');
  check(Array.isArray(record.parents) && record.parents.length <= 64 && record.parents.every(p => id(p, 32)) &&
    new Set(record.parents).size === record.parents.length && Array.isArray(record.sids) && record.sids.length <= 1 && record.sids.every(s => id(s, 32)), 'record_inventory');
  return api.wire.readManifestSeal2(record);
}
export async function manifestFor(api, root, capture) {
  const { c, seal } = api, record = capture.note, ct = packet(api, record);
  const domain = await c.deriveDomainKey(root, record.domain_id), key = await c.deriveManifestKey(domain, record.domain_id);
  check(await c.versionId(record.file_id, record.parents, ct, record.sids) === record.version_id, 'manifest_version_hash');
  const plain = await seal.openRecord(key, 1, recordContext(record), ct);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  const expected = capture.expected;
  check(expected && /^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(expected.path) && typeof expected.text === 'string' &&
    expected.text.startsWith('# ') && Buffer.byteLength(expected.text) > 0 && Buffer.byteLength(expected.text) <= 16384 && digest(expected.text) === expected.sha256, 'synthetic_expectation');
  check(manifest.v === 1 && manifest.deleted === false && record.deleted === false && manifest.path === expected.path &&
    manifest.domain === record.domain_id && manifest.sha256 === expected.sha256 && manifest.size === Buffer.byteLength(expected.text) &&
    record.bytes === manifest.size && Array.isArray(manifest.chunks) && manifest.chunks.length === 1 && record.sids.length === 1, 'manifest_binding');
  const chunk = manifest.chunks[0];
  check(id(chunk.cid, 32) && chunk.sid === record.sids[0] && chunk.len === manifest.size, 'manifest_chunk_binding');
  return { manifest, domain, chunk };
}
export async function openCapture(api, root, capture) {
  const { c, dm, seal } = api, map = capture.map, note = capture.note;
  const keys = await dm.domainMapKeys(root), mapCt = packet(api, map);
  check(keys.fileId === map.file_id && keys.fileId === map.generation && keys.domainId === map.domain_id &&
    note.generation === map.generation && map.sids.length === 0 && map.bytes === 0 && map.deleted === false, 'generation_binding');
  check(await c.versionId(map.file_id, map.parents, mapCt, map.sids) === map.version_id, 'map_version_hash');
  const decoded = dm.parseDomainMap(new TextDecoder('utf-8', { fatal: true }).decode(await seal.openRecord(keys.key, 2, recordContext(map), mapCt)));
  check(dm.domainFor(decoded, capture.expected.path) === note.domain_id, 'map_note_binding');
  const opened = await manifestFor(api, root, capture), saved = capture.chunks;
  check(Array.isArray(saved) && saved.length === 1 && saved[0].sid === opened.chunk.sid && saved[0].cid === opened.chunk.cid, 'captured_chunk_binding');
  check(typeof saved[0].ciphertext === 'string' && saved[0].ciphertext.length <= 22000, 'chunk_ciphertext_budget');
  const ciphertext = c.unbase64(saved[0].ciphertext);
  check(c.base64(ciphertext) === saved[0].ciphertext && digest(ciphertext) === saved[0].sid, 'chunk_ciphertext_hash');
  const plaintext = await seal.decryptChunk2(opened.domain, { generation: note.generation, domainId: note.domain_id }, c.unhex(opened.chunk.cid), ciphertext);
  check(Buffer.from(plaintext).equals(Buffer.from(capture.expected.text)) && digest(plaintext) === capture.expected.sha256, 'plaintext_bytes');
  return { bytes: plaintext.length, sha256: digest(plaintext), generationHash: digest(note.generation) };
}
async function rejected(action, code) {
  try { await action(); } catch { return true; }
  throw new OracleFailure(code);
}
export async function rejectCurrentWithOld(api, oldRoot, capture) {
  const { c, dm, seal } = api, note = capture.note, map = capture.map;
  // Do not reject a root-derived generation mismatch before attempting crypto:
  // this models a colluding server delivering exact current ciphertext/context.
  const oldMap = await dm.domainMapKeys(oldRoot), domain = await c.deriveDomainKey(oldRoot, note.domain_id);
  const manifest = await c.deriveManifestKey(domain, note.domain_id);
  await rejected(() => seal.openRecord(oldMap.key, 2, recordContext(map), packet(api, map)), 'old_key_map_unexpected_open');
  await rejected(() => seal.openRecord(manifest, 1, recordContext(note), packet(api, note)), 'old_key_manifest_unexpected_open');
  for (const chunk of capture.chunks) await rejected(() => seal.decryptChunk2(domain,
    { generation: note.generation, domainId: note.domain_id }, c.unhex(chunk.cid), c.unbase64(chunk.ciphertext)), 'old_key_chunk_unexpected_open');
  return { map: 'REJECT', manifest: 'REJECT', chunks: capture.chunks.length };
}
export async function detachedControls(api, root, capture) {
  const { c, dm, seal } = api, note = capture.note, map = capture.map;
  const mapKey = (await dm.domainMapKeys(root)).key, domain = await c.deriveDomainKey(root, note.domain_id), manifest = await c.deriveManifestKey(domain, note.domain_id);
  const flipId = value => (value[0] === '0' ? '1' : '0') + value.slice(1);
  const flip = bytes => { const changed = new Uint8Array(bytes); changed[changed.length - 1] ^= 1; return changed; };
  for (const [record, key, kind] of [[map, mapKey, 2], [note, manifest, 1]]) {
    await rejected(() => seal.openRecord(key, kind, recordContext(record), flip(packet(api, record))), 'tamper_record_unexpected_open');
    const context = recordContext(record); context.domainId = flipId(context.domainId);
    await rejected(() => seal.openRecord(key, kind, context, packet(api, record)), 'wrong_context_record_unexpected_open');
  }
  for (const chunk of capture.chunks) {
    const scope = { generation: note.generation, domainId: note.domain_id }, ct = c.unbase64(chunk.ciphertext), cid = c.unhex(chunk.cid);
    await rejected(() => seal.decryptChunk2(domain, scope, cid, flip(ct)), 'tamper_chunk_unexpected_open');
    await rejected(() => seal.decryptChunk2(domain, { ...scope, domainId: flipId(scope.domainId) }, cid, ct), 'wrong_context_chunk_unexpected_open');
  }
  let killed = false;
  try { await rejectCurrentWithOld(api, root, capture); }
  catch (error) { if (error instanceof OracleFailure && error.code === 'old_key_map_unexpected_open') killed = true; else throw error; }
  check(killed, 'old_slot_current_control_survived');
  return { tamperRejected: true, wrongContextRejected: true, substitutedCurrentKeyKilledOldKeyAssertion: true };
}
export async function verifyNativeSet(api, oldRoot, currentRoot, baseline, access, current) {
  check(!api.c.bytesEqual(oldRoot, currentRoot), 'roots_not_distinct');
  const old = await openCapture(api, oldRoot, baseline), later = await openCapture(api, oldRoot, access), next = await openCapture(api, currentRoot, current);
  check(baseline.note.generation === access.note.generation && baseline.note.generation !== current.note.generation, 'generation_transition');
  check(access.note.version_id !== baseline.note.version_id && access.expected.sha256 !== baseline.expected.sha256 &&
    Date.parse(access.capturedAt) > Date.parse(baseline.capturedAt) && Date.parse(current.capturedAt) > Date.parse(access.capturedAt), 'fresh_native_ciphertext');
  const refused = await rejectCurrentWithOld(api, oldRoot, current);
  return { oldKeyOldCiphertext: 'OPEN', oldKeyAccessOnlyNewCiphertext: 'OPEN', currentKeyCurrentCiphertext: 'OPEN',
    oldKeyCurrentMap: refused.map, oldKeyCurrentManifest: refused.manifest, oldKeyCurrentChunk: 'REJECT',
    chunkCount: refused.chunks, beforeGenerationHash: old.generationHash, afterGenerationHash: next.generationHash,
    plaintextHashes: [old.sha256, later.sha256, next.sha256] };
}

async function main() {
  const [runArg, ...args] = process.argv.slice(2), run = resolve(runArg), options = {};
  for (let i = 0; i < args.length; i += 2) { const key = args[i]?.slice(2); check(args[i]?.startsWith('--') && ['source', 'baseline', 'access-only', 'current'].includes(key) && !options[key] && args[i + 1], 'arguments'); options[key] = args[i + 1]; }
  check(options.source && ['baseline', 'access-only', 'current'].every(key => /^[a-z][a-z0-9-]{0,32}$/.test(options[key])), 'arguments');
  owned(run, true); owned(join(run, 'private'), true); owned(join(run, 'private/desktop'), true); owned(join(run, 'evidence'), true);
  const json = path => { check(owned(path).size <= 1048576, 'private_json_budget'); return JSON.parse(privateRead(path)); };
  const lab = json(join(run, 'lab.json'));
  check(lab.format === 1 && lab.run === run && lab.source_dirty === false, 'capture_lab_binding');
  const api = candidateCrypto(options.source, lab.source_head, lab.artifacts['plugin/main.js']);
  const labels = ['baseline', 'access-only', 'current'].map(key => options[key]);
  const captures = labels.map(label => json(join(run, 'private/desktop', `ciphertext-${label}.json`)));
  for (const [index, capture] of captures.entries()) {
    const receipt = json(join(run, 'evidence', `native-ciphertext-capture-${labels[index]}.json`));
    check(capture.schema === 1 && capture.origin === 'native-authenticated-read' && capture.sourceHead === lab.source_head &&
      capture.bundleSha256 === lab.artifacts['plugin/main.js'] && capture.decoderHash === api.decoderHash && capture.ordinaryNoteDiskMatches === true &&
      receipt.origin === 'native-authenticated-read' && receipt.result === 'CAPTURED' && receipt.sourceHead === lab.source_head &&
      receipt.decoderHash === api.decoderHash && receipt.captureSha256 === digest(readFileSync(join(run, 'private/desktop', `ciphertext-${labels[index]}.json`))), 'native_provenance');
    assertHeadProofReceipt(capture, receipt, lab.source_head, lab.artifacts['plugin/main.js']);
  }
  const oldRoot = await api.backup.parseRecoveryBackup(privateRead(join(run, 'private/desktop/phone-old-recovery-backup.txt')));
  const currentRoot = await api.backup.parseRecoveryBackup(privateRead(join(run, 'private/desktop/phone-new-recovery-backup.txt')));
  const proofs = await verifyNativeSet(api, oldRoot, currentRoot, ...captures), controls = await detachedControls(api, currentRoot, captures[2]);
  const at = Date.now(), base = { schema: 1, sourceHead: lab.source_head, decoderHash: api.decoderHash, physicalPhone: 'NOT_RUN', at: new Date(at).toISOString(),
    captureHashes: labels.map(label => digest(readFileSync(join(run, 'private/desktop', `ciphertext-${label}.json`)))),
    currentHeadsBeforeAndAfter: true, headProofHashes: captures.map(capture => digest(JSON.stringify(capture.headProof))) };
  for (const receipt of [{ ...base, origin: 'native-ciphertext-detached-crypto', result: 'PASS', ...proofs },
    { ...base, origin: 'detached-negative-controls', result: 'PASS', baselinePassed: true, ...controls }]) {
    writeFileSync(join(run, 'evidence', `${receipt.origin}-${at}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(receipt));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.log(JSON.stringify({ result: 'FAIL', origin: 'detached-crypto', firstFailure: error instanceof OracleFailure ? error.code : 'capture_or_crypto_refused' })); process.exitCode = 1; }
}
