// Hosted-only real process driver. Public Windows commands remain closed until
// the candidate native journey and durability evidence pass review.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Contexts } from '../dist/cli/contexts.mjs';
import { installWindows, uninstallWindows } from '../dist/cli/install-windows.mjs';

const [phase, root, trustPath, trustDigest] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const source = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const { WindowsFiles } = createRequire(import.meta.url)('../dist/cli/shared/windowsFiles.js');
const files = await WindowsFiles.fromReceipt(trustPath, trustDigest);
const store = new Contexts(join(root, 'config'), files);
const planPath = join(root, 'plan.json');
const digest = createHash('sha256').update(await readFile(join(source, 'package-manifest.json'))).digest('hex');
const options = { source, prefix: join(root, 'installed'), digest, trustPath, trustDigest };
if (phase === 'context') {
  const held = await store.database(true);
  try { await assert.rejects(files.flush(store.file), /^Error: windows_files_refused/); }
  finally { held.close(); }
  await files.flush(store.file);
  const mutation = new Contexts(store.directory, files);
  const plan = await mutation.plan('context.add', { name: 'fixture', origin: 'https://example.invalid' });
  await writeFile(planPath, JSON.stringify(plan));
  assert.equal((await mutation.apply(plan, plan.digest)).revision, 1);
} else if (phase === 'context-replay') {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal((await store.apply(plan, plan.digest)).replayed, true);
  assert.equal((await store.read()).contexts.length, 1);
} else if (phase === 'kill-context') {
  const database = await store.database(true);
  database.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');
  const state = store.readDatabase(database);
  state.current = 'fixture';
  database.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
  process.kill(process.pid, 'SIGKILL');
} else if (phase === 'recover-context') {
  await store.recover();
  const state = await store.read();
  assert.equal(state.current, null);
  assert.equal(state.revision, 1);
} else if (phase === 'install') {
  await installWindows(options);
} else if (phase === 'uninstall') {
  await uninstallWindows(options);
} else throw Error('Unknown native phase.');
console.log(JSON.stringify({ event: 'windows_cli_journey', phase, result: 'pass', manifest_sha256: digest }));
