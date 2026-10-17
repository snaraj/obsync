// Retain only the three already validated synthetic ciphertext samples. No keys,
// backups, credentials, HTTP, logs or server directories are read by this helper.
import { createHash } from 'node:crypto';
import { lstatSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw Error('ciphertext_retention_' + code); };
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const exact = (value, fields) => need(value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields.split(' ').sort()), 'fields');
const time = value => need(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)), 'time');
function ciphertext(value, max) {
  need(typeof value === 'string' && value.length >= 24 && value.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'ciphertext');
  const bytes = Buffer.from(value, 'base64');
  need(bytes.length >= 16 && bytes.toString('base64') === value, 'ciphertext'); return bytes;
}
function record(value, map, size) {
  exact(value, 'version_id parents sids bytes device_id ts deleted manifest_ct seal_suite file_id domain_id generation');
  need(['file_id', 'domain_id', 'generation', 'device_id'].every(key => hex(value[key], 32)) && hex(value.version_id, 64), 'record_ids');
  for (const [key, max] of [['parents', 64], ['sids', map ? 0 : 1]]) need(Array.isArray(value[key]) && value[key].length <= max &&
    value[key].every(id => hex(id, 64)) && new Set(value[key]).size === value[key].length, 'record_inventory');
  need(value.sids.length === (map ? 0 : 1) && value.bytes === (map ? 0 : size) && value.deleted === false && value.seal_suite === 2 &&
    Number.isSafeInteger(value.ts) && value.ts >= 0, 'record_shape');
  ciphertext(value.manifest_ct, 131072);
}
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function witness(value, capture) {
  exact(value, 'generation observedAt note map'); time(value.observedAt);
  need(value.generation === capture.note.generation, 'head_generation');
  for (const kind of ['note', 'map']) {
    const view = value[kind], record = capture[kind]; exact(view, 'fileId domainId heads recordSha256');
    const clean = Object.fromEntries(Object.entries(record).filter(([key]) => !['file_id', 'domain_id', 'generation'].includes(key)));
    need(view.fileId === record.file_id && view.domainId === record.domain_id && Array.isArray(view.heads) && view.heads.length === 1 &&
      view.heads[0] === record.version_id && view.recordSha256 === hash(JSON.stringify(sorted(clean))), 'head_record');
  }
}
export function retainedBytes(capture, label, binding) {
  need(['before', 'access', 'rotated'].includes(label), 'label');
  exact(binding, 'sourceHead bundleSha256 decoderHash sourceCaptureSha256');
  need(hex(binding.sourceHead, 40) && ['bundleSha256', 'decoderHash', 'sourceCaptureSha256'].every(key => hex(binding[key], 64)), 'binding');
  exact(capture, 'schema origin sourceHead bundleSha256 decoderHash capturedAt expected expectationSha256 ordinaryNoteDiskMatches note map chunks headProof');
  need(capture.schema === 1 && capture.origin === 'native-authenticated-read' && capture.ordinaryNoteDiskMatches === true &&
    ['sourceHead', 'bundleSha256', 'decoderHash'].every(key => capture[key] === binding[key]) && hex(capture.expectationSha256, 64), 'provenance');
  time(capture.capturedAt); exact(capture.expected, 'path text sha256');
  const noteLabel = {before: 'core-desktop', access: 'access-desktop', rotated: 'rotated-desktop'}[label];
  need(typeof capture.expected.path === 'string' && new RegExp(`^Phone-${noteLabel}-[0-9]{13}\\.md$`).test(capture.expected.path), 'synthetic_path');
  const name = capture.expected.path.slice(0, -3), text = `# ${name}\n\nSynthetic native desktop sentinel.\n`;
  need(capture.expected.text === text && capture.expected.sha256 === hash(text), 'synthetic_text');
  const size = Buffer.byteLength(text); record(capture.note, false, size); record(capture.map, true, size);
  need(capture.map.file_id === capture.map.generation && capture.note.generation === capture.map.generation &&
    capture.note.file_id !== capture.map.file_id, 'generation');
  need(Array.isArray(capture.chunks) && capture.chunks.length === 1, 'chunks');
  const chunk = capture.chunks[0]; exact(chunk, 'sid cid ciphertext');
  const bytes = ciphertext(chunk.ciphertext, 32768);
  need(hex(chunk.cid, 64) && bytes.length === size + 16 && hash(bytes) === chunk.sid && chunk.sid === capture.note.sids[0], 'chunk_binding');
  const proof = capture.headProof; exact(proof, 'schema sourceHead bundleSha256 before after');
  need(proof.schema === 1 && proof.sourceHead === binding.sourceHead && proof.bundleSha256 === binding.bundleSha256, 'head_provenance');
  witness(proof.before, capture); witness(proof.after, capture);
  const [before, at, after] = [proof.before.observedAt, capture.capturedAt, proof.after.observedAt].map(Date.parse);
  need(before <= at && at <= after && after - before <= 120000, 'head_interval');
  const output = Buffer.from(JSON.stringify(capture) + '\n');
  need(output.length <= 524288 && hash(output) === binding.sourceCaptureSha256, 'source_bytes');
  return output;
}
export function retainCapture(run, capture, label, binding) {
  const bytes = retainedBytes(capture, label, binding), evidence = join(resolve(run), 'evidence'), stat = lstatSync(evidence);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'directory');
  const path = `evidence/native-ciphertext-${label}.json`;
  writeFileSync(join(resolve(run), path), bytes, {mode: 0o600, flag: 'wx'});
  return {path, sha256: hash(bytes), bytes: bytes.length, sourceCaptureSha256: binding.sourceCaptureSha256,
    representation: 'exact-validated-synthetic-capture', rawHttpIncluded: false, keysIncluded: false};
}
