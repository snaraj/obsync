// Detached controls: remove each crypto assertion and require a test assertion.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('./ciphertext-oracle.mjs', import.meta.url), 'utf8');
const test = fileURLToPath(new URL('./ciphertext-oracle.test.mjs', import.meta.url));
const mutations = [
  ['old-map-rejection', "await rejected(() => seal.openRecord(oldMap.key, 2, recordContext(map), packet(api, map)), 'old_key_map_unexpected_open');", ''],
  ['old-manifest-rejection', "await rejected(() => seal.openRecord(manifest, 1, recordContext(note), packet(api, note)), 'old_key_manifest_unexpected_open');", ''],
  ['old-chunk-rejection', 'for (const chunk of capture.chunks) await rejected', 'for (const chunk of []) await rejected'],
  ['exact-plaintext-bytes', "check(Buffer.from(plaintext).equals(Buffer.from(capture.expected.text)) && digest(plaintext) === capture.expected.sha256, 'plaintext_bytes');", ''],
  ['fresh-native-content', "check(access.note.version_id !== baseline.note.version_id", 'check(true || access.note.version_id !== baseline.note.version_id'],
  ['installed-decoder-binding', "check(bundle.split(wrapped).length === 2, 'decoder_not_in_installed_bundle');", ''],
  ['current-head-oracle-call', "assertHeadProofReceipt(capture, receipt, lab.source_head, lab.artifacts['plugin/main.js']);", ''],
  ['current-head-source', 'proof.sourceHead === sourceHead && proof.bundleSha256 === bundleSha256', 'true'],
  ['current-head-observation-interval', "check(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2] && times[2] - times[0] <= 120000, 'current_heads_observation_interval');", ''],
  ['current-head-generation', "check(witness?.generation === capture.note?.generation && witness.generation === capture.map?.generation, 'current_heads_generation');", ''],
  ['current-head-record-binding', "observed?.fileId === record.file_id && observed.domainId === record.domain_id", 'true'],
  ['current-head-membership', "check(Array.isArray(observed.heads) && observed.heads.length === 1 && observed.heads[0] === record.version_id, 'captured_version_not_current_head');", ''],
  ['current-head-record-hash', "check(observed.recordSha256 === digest(canonicalVersion(record)), 'current_head_record_changed');", ''],
  ['current-head-receipt', "check(receipt?.sourceHead === sourceHead && receipt.currentHeadsBeforeAndAfter === true && receipt.headProofSha256 === proofHash,\n    'current_heads_receipt_binding');", ''],
];
const scratch = mkdtempSync(join(tmpdir(), 'obsync-ciphertext-mutants-'));
try {
  for (const [name, before, after] of mutations) {
    if (source.split(before).length !== 2) throw Error(`mutation target changed: ${name}`);
    const path = join(scratch, name + '.mjs');
    writeFileSync(path, source.replace(before, after).replace("'./desktop-guard.mjs'", JSON.stringify(new URL('./desktop-guard.mjs', import.meta.url).href)));
    const run = spawnSync(process.execPath, ['--test', test], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, OBSYNC_CIPHERTEXT_ORACLE_MODULE: pathToFileURL(path).href } });
    if (run.status === 0 || !`${run.stdout}${run.stderr}`.includes('AssertionError')) throw Error(`mutation survived or lacked assertion failure: ${name}`);
    console.log(`${name}: KILLED`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
