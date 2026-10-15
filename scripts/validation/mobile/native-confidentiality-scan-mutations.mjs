import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('./native-confidentiality-scan.mjs', import.meta.url), 'utf8');
const test = fileURLToPath(new URL('./native-confidentiality-scan.test.mjs', import.meta.url));
const mutations = [
  ['complete-backup-inventory', "need(Array.isArray(paths) && JSON.stringify(paths) === JSON.stringify(expected), 'complete_backup_inventory');", ''],
  ['sealed-file-hash', 'declared.sha256 === digest(bytes)', 'true'],
  ['nonempty-input', '(allowEmpty || stat.size > 0)', 'true'],
  ['aggregate-budget', '(counter.bytes += stat.size) <= MAX', 'true'],
  ['verified-http-parse', 'need(connections.length > 0', 'need(true || connections.length > 0'],
  ['http-positive-control', "need(report.decision === 'fail'", "need(true || report.decision === 'fail'"],
  ['opaque-positive-control', "need(detected, 'planted_opaque_not_detected');", ''],
  ['metadata-secret-scan', "opaque(bytes, needles, 'android_metadata');", ''],
];
const scratch = mkdtempSync(join(tmpdir(), 'obsync-confidentiality-mutants-'));
try {
  for (const [name, before, after] of mutations) {
    if (source.split(before).length !== 2) throw Error(`mutation target changed: ${name}`);
    const path = join(scratch, name + '.mjs');
    let changed = source.replace(before, after);
    for (const dependency of ['desktop-guard.mjs', 'ciphertext-oracle.mjs']) changed = changed.replace(`'./${dependency}'`, JSON.stringify(new URL('./' + dependency, import.meta.url).href));
    writeFileSync(path, changed);
    const run = spawnSync(process.execPath, ['--test', test], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, OBSYNC_CONFIDENTIALITY_SCANNER_MODULE: pathToFileURL(path).href } });
    if (run.status === 0 || !`${run.stdout}${run.stderr}`.includes('AssertionError')) throw Error(`mutation survived or lacked assertion failure: ${name}`);
    console.log(`${name}: KILLED`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
