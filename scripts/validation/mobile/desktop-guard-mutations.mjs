// Offline assertion controls only; no native app, server or secret-store access.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('./desktop-guard.mjs', import.meta.url), 'utf8');
const test = fileURLToPath(new URL('./desktop-guard.test.mjs', import.meta.url));
const mutations = [
  ['sas-mismatch', 'creator[0] !== observation.code', 'false'],
  ['sas-duplicate', 'creator.length !== 1', 'creator.length < 1'],
  ['observation-stale', 'now - timestamp > 60000', 'false'],
  ['observation-before-invitation', 'timestamp < invitationMs', 'false'],
  ['observation-future', 'timestamp > now + 2000', 'false'],
  ['invitation-expired', 'now - invitationMs > 600000', 'false'],
  ['app-process-binding', 'observation.appPid !== appPid', 'false'],
  ['private-mode', '(privateMode && (stat.mode & 0o077))', 'false'],
  ['single-link', 'stat.nlink !== 1', 'false'],
  ['private-exclusive-write', "flag: 'wx'", "flag: 'w'"],
];
const scratch = mkdtempSync(join(tmpdir(), 'obsync-desktop-mutants-'));
try {
  for (const [name, before, after] of mutations) {
    if (source.split(before).length !== 2) throw Error(`mutation target changed: ${name}`);
    const path = join(scratch, name + '.mjs');
    writeFileSync(path, source.replace(before, after));
    const run = spawnSync(process.execPath, ['--test', test], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, OBSYNC_DESKTOP_GUARD_MODULE: pathToFileURL(path).href } });
    if (run.status === 0 || !`${run.stdout}${run.stderr}`.includes('AssertionError')) throw Error(`mutation survived or lacked assertion failure: ${name}`);
    console.log(`${name}: KILLED`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
