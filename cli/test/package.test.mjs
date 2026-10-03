import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../package-files.mjs';

const packageRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const entry = join(packageRoot, 'cli/obsync.mjs'), installer = join(packageRoot, 'cli/install.mjs');
const posix = ['darwin', 'linux'].includes(process.platform);
const digest = sha256(await readFile(join(packageRoot, 'package-manifest.json')));
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'obsync-cli-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function run(binary, args, options = {}) {
  const child = spawn(binary, args, { env: { HOME: tmpdir(), PATH: dirname(process.execPath) },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await new Promise(resolve => child.on('close', (...result) => resolve(result)));
  return { code, signal, stdout, stderr };
}
async function install(prefix, operation = 'install', executable = installer) {
  let runtime = process.execPath;
  if (posix) {
    // The developer's package-manager ancestor can be group-writable. Do not relax the
    // runtime guard for tests: use an exact private copy of the already trusted executable.
    runtime = join(dirname(prefix), 'trusted-node');
    try { await copyFile(process.execPath, runtime, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await chmod(runtime, 0o700);
    if (process.platform === 'darwin') {
      const library = join(dirname(process.execPath), '../lib/libnode.147.dylib');
      try { await copyFile(library, join(dirname(prefix), 'libnode.147.dylib'), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
      catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  return run(runtime, [executable, operation, '--prefix', prefix, '--manifest-sha256', digest]);
}

test('installed launcher scrubs runtime preload, detects changed code, and confines uninstall', { skip: !posix }, async t => {
  const root = await fixture(t), prefix = join(root, 'installation'), context = join(root, 'context-sentinel');
  await writeFile(context, 'keep');
  const installed = await install(prefix);
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  assert.equal((await install(prefix)).code, 0);
  const preload = join(root, 'preload.mjs'), marker = join(root, 'unexpected');
  await writeFile(preload, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
  const launched = await run(join(prefix, 'obsync'), ['--version'], { env: { NODE_OPTIONS: `--import=${preload}`, HOME: root } });
  assert.equal(launched.code, 0, launched.stderr);
  assert.ok(JSON.parse(launched.stdout).data.version);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  const runtime = join(root, 'trusted-node'), saved = join(root, 'saved-node');
  await rename(runtime, saved);
  await writeFile(runtime, 'changed executable', { mode: 0o700 });
  const refusedRuntime = await run(saved, [installer, 'install', '--prefix', prefix, '--manifest-sha256', digest]);
  assert.equal(refusedRuntime.code, 4, refusedRuntime.stdout);
  await rm(runtime);
  await rename(saved, runtime);
  const changed = join(prefix, 'cli/catalog.mjs'), original = await readFile(changed);
  await writeFile(changed, Buffer.concat([original, Buffer.from('\n// changed\n')]));
  assert.equal((await run(join(prefix, 'obsync'), ['--version'])).code, 4);
  assert.equal((await install(prefix, 'uninstall')).code, 4);
  assert.equal(await readFile(context, 'utf8'), 'keep');
  await writeFile(changed, original);
  await writeFile(join(prefix, 'unknown'), 'do not remove');
  assert.equal((await install(prefix, 'uninstall')).code, 4);
  await rm(join(prefix, 'unknown'));
  assert.equal((await install(prefix, 'uninstall')).code, 0);
  assert.equal(await readFile(context, 'utf8'), 'keep');
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  const unbound = `${prefix}.pending`;
  await mkdir(unbound, { mode: 0o700 });
  await writeFile(join(unbound, 'LICENSE'), 'keep', { mode: 0o600 });
  assert.equal((await install(prefix)).code, 5);
  assert.equal(await readFile(join(unbound, 'LICENSE'), 'utf8'), 'keep');
  await assert.rejects(lstat(join(unbound, 'package-manifest.json')), { code: 'ENOENT' });
});

test('killed installer resumes exact pending bytes and interrupted removal retains no authority', { skip: !posix }, async t => {
  const root = await fixture(t), prefix = join(root, 'installation');
  // Inject only in the already trusted driver, before its first payload copy.
  const original = await readFile(installer, 'utf8');
  const injected = original.replace("for (const name of FILES) await durable", "process.kill(process.pid, 'SIGKILL');\n      for (const name of FILES) await durable");
  // Only the fault driver is copied outside the repo; the package verifier still reads exact bytes.
  const faultDriver = join(root, 'fault.mjs');
  const code = injected.replace("from './package-files.mjs'", `from ${JSON.stringify(new URL('../dist/cli/package-files.mjs', import.meta.url).href)}`)
    .replace("from './errors.mjs'", `from ${JSON.stringify(new URL('../dist/cli/errors.mjs', import.meta.url).href)}`)
    .replace("from './private-path.mjs'", `from ${JSON.stringify(new URL('../dist/cli/private-path.mjs', import.meta.url).href)}`)
    .replace('const source = dirname(dirname(fileURLToPath(import.meta.url)));', `const source = ${JSON.stringify(packageRoot)};`);
  await writeFile(faultDriver, code);
  const killed = await install(prefix, 'install', faultDriver);
  assert.equal(killed.signal, 'SIGKILL');
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  assert.equal((await install(prefix)).code, 0);
  const removing = original.replace('for (const name of allowed.filter', "process.kill(process.pid, 'SIGKILL');\n    for (const name of allowed.filter");
  await writeFile(faultDriver, removing.replace("from './package-files.mjs'", `from ${JSON.stringify(new URL('../dist/cli/package-files.mjs', import.meta.url).href)}`)
    .replace("from './errors.mjs'", `from ${JSON.stringify(new URL('../dist/cli/errors.mjs', import.meta.url).href)}`)
    .replace("from './private-path.mjs'", `from ${JSON.stringify(new URL('../dist/cli/private-path.mjs', import.meta.url).href)}`)
    .replace('const source = dirname(dirname(fileURLToPath(import.meta.url)));', `const source = ${JSON.stringify(packageRoot)};`));
  assert.equal((await install(prefix, 'uninstall', faultDriver)).signal, 'SIGKILL');
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  assert.equal((await install(prefix, 'uninstall')).code, 0);
  await assert.rejects(lstat(`${prefix}.removing`), { code: 'ENOENT' });
});

test('deferred export reports unsupported without creating configuration', async t => {
  const root = await fixture(t), config = join(root, 'config');
  const before = await readdir(root);
  const result = await run(process.execPath, [entry, 'export', 'open', '--config-dir', config]);
  assert.equal(result.code, 6);
  assert.equal(JSON.parse(result.stdout).error.code, 'unsupported_capability');
  assert.deepEqual(await readdir(root), before);
  assert.equal((await run(process.execPath, [entry, 'export', 'open', '--phrase-fd', '3'])).code, 2);
  const capabilities = JSON.parse((await run(process.execPath, [entry, 'capabilities'])).stdout);
  assert.ok(!capabilities.data.implemented.some(name => name.startsWith('export')));
  assert.ok(capabilities.data.unsupported.export);
});

test('Windows installation requires explicit native trust and export remains unsupported', { skip: posix }, async () => {
  assert.equal((await install(join(tmpdir(), 'unsupported-obsync'))).code, 6);
  assert.equal((await run(process.execPath, [entry, 'export', 'open'])).code, 6);
});
