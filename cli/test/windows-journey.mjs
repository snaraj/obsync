// Hosted-only real process driver. Public Windows commands remain closed until
// the candidate native journey and durability evidence pass review.
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
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
const missing = async path => { try { return await lstat(path, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

function child(executable, args) {
  const process = spawn(executable, args, { env: { GITHUB_ACTIONS: 'true', SystemRoot: globalThis.process.env.SystemRoot },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0, stdout = '';
  const timer = setTimeout(() => process.kill('SIGKILL'), 60000);
  for (const stream of [process.stdout, process.stderr]) stream.on('data', data => {
    bytes += data.length;
    if (bytes > 16384) process.kill('SIGKILL');
    if (stream === process.stdout && bytes <= 16384) stdout += data.toString('utf8');
  });
  const done = new Promise((resolve, reject) => {
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, bytes }); });
  });
  return { process, done };
}

async function runPhase(name) {
  const result = await child(process.execPath, [fileURLToPath(import.meta.url), name, root, trustPath, trustDigest]).done;
  assert.equal(result.code, 0, `Fresh native ${name} failed.`);
  assert.ok(result.bytes <= 16384);
}
if (phase === 'lease') {
  await files.create(join(root, 'lease'));
  const held = child(process.execPath, [fileURLToPath(import.meta.url), 'hold-lease', root, trustPath, trustDigest]);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native lease readiness deadline.')), 15000);
      let output = '';
      held.process.stdout.on('data', data => { output += data.toString('utf8'); if (output.includes('"lease":"held"')) { clearTimeout(timer); resolve(); } });
      held.process.once('close', () => { clearTimeout(timer); reject(Error('Native lease holder closed before readiness.')); });
    });
    await assert.rejects(files.locked(join(root, 'lease'), () => {}, async () => assert.fail('Concurrent writer entered.')));
  } finally { held.process.kill('SIGKILL'); await held.done; }
  await runPhase('recover-lease');
} else if (phase === 'hold-lease') {
  await files.locked(join(root, 'lease'), () => {}, async alive => {
    console.log(JSON.stringify({ event: 'windows_cli_journey', lease: 'held' }));
    for (;;) { alive(); await delay(50); }
  });
} else if (phase === 'recover-lease') {
  await files.locked(join(root, 'lease'), () => {}, async alive => { alive(); });
} else if (phase === 'context') {
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
} else if (phase === 'interrupt-install') {
  const pending = options.prefix + '.pending';
  const trust = JSON.parse(await readFile(trustPath, 'utf8'));
  for (const boundary of ['private-stage', 'completion-receipt', 'published']) {
    assert.equal(await missing(options.prefix), null);
    assert.equal(await missing(pending), null);
    const operation = child(process.execPath, [fileURLToPath(import.meta.url), 'install', root, trustPath, trustDigest]);
    const deadline = performance.now() + 45000;
    let observed;
    try {
      while (performance.now() < deadline && operation.process.exitCode === null && operation.process.signalCode === null) {
        const staged = await missing(pending), published = await missing(options.prefix);
        const receipt = staged && await missing(join(pending, 'install-record.json'));
        if (boundary === 'private-stage' ? staged && !receipt && !published :
          boundary === 'completion-receipt' ? staged && receipt && !published : published) {
          observed = published || staged;
          assert.equal(operation.process.kill('SIGKILL'), true);
          break;
        }
        await delay(2);
      }
    } finally { if (!observed) operation.process.kill('SIGKILL'); }
    const killed = await operation.done;
    assert.ok(observed, `Did not observe installer boundary: ${boundary}.`);
    assert.notEqual(killed.code, 0, 'Installer completed before the actual process kill.');
    if (boundary === 'private-stage') {
      assert.equal(await missing(options.prefix), null);
      assert.equal(await missing(join(pending, 'install-record.json')), null);
    }
    // A pending launcher is bound to the final prefix, so even a complete
    // staged package cannot launch before publication. A missing file also
    // makes this actual native invocation fail closed.
    if (!await missing(options.prefix)) {
      const refused = await child(trust.powershell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        join(pending, 'obsync.ps1'), '--version']).done;
      assert.notEqual(refused.code, 0);
    }
    await runPhase('install');
    const installed = await missing(options.prefix);
    assert.equal(installed.ino, observed.ino, 'Recovery must preserve the exact installation directory.');
    assert.equal(installed.dev, observed.dev);
    assert.equal(await missing(pending), null);
    const launched = await child(trust.powershell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      join(options.prefix, 'obsync.ps1'), '--version']).done;
    assert.equal(launched.code, 0);
    assert.match(launched.stdout, /"version":"[0-9]+\.[0-9]+\.[0-9]+"/);
    await runPhase('uninstall');
    assert.equal(await missing(options.prefix), null);
    assert.equal(await missing(options.prefix + '.removing'), null);
    console.log(JSON.stringify({ event: 'windows_installer_interruption', boundary, result: 'pass' }));
  }
} else if (phase === 'install') {
  await installWindows(options);
} else if (phase === 'uninstall') {
  await uninstallWindows(options);
} else throw Error('Unknown native phase.');
console.log(JSON.stringify({ event: 'windows_cli_journey', phase, result: 'pass', manifest_sha256: digest }));
