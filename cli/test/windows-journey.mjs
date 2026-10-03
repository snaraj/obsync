// Hosted-only driver: product calls use the public installer and installed CLI.
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, readdir, mkdir, rm, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Contexts } from '../dist/cli/contexts.mjs';

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
if (phase === 'interrupt-mkdir') {
  const target = join(root, 'creation'), companion = target + '.obsync-create';
  const before = (await readdir(root)).sort();
  const originalSpawn = files.spawn;
  let helper, observed, stopped;
  files.spawn = { spawn(...args) {
    helper = originalSpawn.spawn(...args);
    stopped = new Promise(resolve => helper.once('close', resolve));
    return helper;
  } };
  const result = files.mkdir(target).then(() => ({ ok: true }), error => ({ error }));
  try {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline && (!helper || helper.exitCode === null)) {
      const staged = await missing(companion);
      if (staged && !await missing(target)) {
        observed = staged;
        assert.equal(helper.kill('SIGKILL'), true);
        break;
      }
      await delay(1);
    }
  } finally {
    files.spawn = originalSpawn;
    if (!observed && helper) helper.kill('SIGKILL');
    if (stopped) await stopped;
  }
  assert.ok(observed, 'Did not observe the actual helper before directory publication.');
  assert.ok((await result).error, 'Killed helper must refuse completion.');
  assert.deepEqual((await readdir(root)).sort(), [...before, 'creation.obsync-create'].sort());
  assert.deepEqual(await readdir(companion), []);
  await files.inspect(companion);
  await files.mkdir(target);
  const published = await lstat(target, { bigint: true });
  assert.equal(published.ino, observed.ino);
  assert.equal(published.dev, observed.dev);
  assert.equal(await missing(companion), null);
  await files.inspect(target);
  await rmdir(target);
  await mkdir(companion);
  await writeFile(join(companion, 'sentinel'), 'preserve this synthetic collision');
  await assert.rejects(files.mkdir(target), /stage_not_empty/);
  assert.equal(await missing(target), null);
  assert.deepEqual(await readdir(companion), ['sentinel']);
  assert.equal(await readFile(join(companion, 'sentinel'), 'utf8'), 'preserve this synthetic collision');
  await rm(join(companion, 'sentinel'));
  await rmdir(companion);
  assert.deepEqual((await readdir(root)).sort(), before);
} else if (phase === 'lease') {
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
} else if (phase === 'public-context') {
  const trust = JSON.parse(await readFile(trustPath, 'utf8'));
  const config = join(root, 'public-config'), input = join(root, 'public-input.json');
  const invoke = async args => {
    const value = await child(trust.powershell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      join(options.prefix, 'obsync.ps1'), ...args, '--config-dir', config]).done;
    assert.equal(value.code, 0, value.stdout);
    return JSON.parse(value.stdout);
  };
  await writeFile(input, JSON.stringify({ name: 'example', origin: 'https://example.invalid' }));
  const plan = (await invoke(['context', 'add', '--input', '@' + input])).data.plan;
  await writeFile(input, JSON.stringify(plan));
  const applied = await invoke(['context', 'apply', '--input', '@' + input, '--expect-digest', plan.digest]);
  assert.equal(applied.data.revision, 1);
  assert.equal((await invoke(['context', 'get', 'example'])).data.context.origin, 'https://example.invalid');
  assert.equal((await invoke(['context', 'apply', '--input', '@' + input, '--expect-digest', plan.digest])).data.replayed, true);
  const doctor = await invoke(['doctor']);
  assert.equal(doctor.data.configuration.persistence_supported, true);
  assert.equal(doctor.verification.server_contacted, false);
  assert.ok((await invoke(['capabilities'])).data.implemented.includes('context.apply'));
} else if (phase === 'startup') {
  const trust = JSON.parse(await readFile(trustPath, 'utf8'));
  const invoke = async args => {
    const start = performance.now();
    const value = await child(trust.powershell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      join(options.prefix, 'obsync.ps1'), ...args, '--config-dir', join(root, 'startup-config')]).done;
    assert.equal(value.code, 0, value.stdout);
    JSON.parse(value.stdout);
    return Math.round((performance.now() - start) * 1000) / 1000;
  };
  for (const [name, args] of [['help', ['help']], ['schema', ['schema', 'context.add']], ['search', ['cli', 'search', 'context']]]) {
    const first = await invoke(args);
    console.log(JSON.stringify({ event: 'windows_startup_probe', command: name, duration_ms: first, budget_ms: 1000 }));
    assert.ok(first <= 1000, 'Installed cold process exceeded P01.');
    const samples = [];
    for (let index = 0; index < 35; index++) samples.push(await invoke(args));
    const p95 = samples.slice(5).sort((a, b) => a - b)[28];
    console.log(JSON.stringify({ event: 'windows_startup_measurement', command: name, samples_ms: samples, warm_p95_ms: p95, budget_ms: 250 }));
    assert.ok(p95 <= 250 && Math.max(...samples.slice(0, 5)) <= 1000, 'Installed process exceeded P01.');
  }
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
} else if (phase === 'install' || phase === 'uninstall') {
  // Import the public entry in this process so interruption kills the actual
  // installer, not a wrapper that could leave its writer running.
  process.argv = [process.execPath, join(source, 'cli/install.mjs'), phase,
    '--prefix', options.prefix, '--manifest-sha256', digest,
    '--windows-trust', trustPath, '--windows-trust-sha256', trustDigest];
  await import('../dist/cli/install.mjs');
  assert.equal(process.exitCode ?? 0, 0);
} else throw Error('Unknown native phase.');
console.log(JSON.stringify({ event: 'windows_cli_journey', phase, result: 'pass', manifest_sha256: digest }));
