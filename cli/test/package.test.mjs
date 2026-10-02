import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sha256 } from '../package-files.mjs';

const packageRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const entry = join(packageRoot, 'cli/obsync.mjs'), installer = join(packageRoot, 'cli/install.mjs');
const require = createRequire(import.meta.url);
const posix = ['darwin', 'linux'].includes(process.platform);
const digest = sha256(await readFile(join(packageRoot, 'package-manifest.json')));
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'obsync-cli-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function run(binary, args, options = {}) {
  const { phrase, holdPhrase = false, ...extra } = options;
  const child = spawn(binary, args, { env: { HOME: tmpdir(), PATH: dirname(process.execPath) },
    stdio: ['ignore', 'pipe', 'pipe', ...(phrase || holdPhrase ? ['pipe'] : [])], timeout: 15000, ...extra });
  if (phrase) { if (holdPhrase) child.stdio[3].write(phrase); else child.stdio[3].end(phrase); }
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
  const code = injected.replace("from './package-files.mjs'", `from ${JSON.stringify(new URL('../package-files.mjs', import.meta.url).href)}`)
    .replace("from './errors.mjs'", `from ${JSON.stringify(new URL('../errors.mjs', import.meta.url).href)}`)
    .replace('const source = dirname(dirname(fileURLToPath(import.meta.url)));', `const source = ${JSON.stringify(packageRoot)};`);
  await writeFile(faultDriver, code);
  const killed = await install(prefix, 'install', faultDriver);
  assert.equal(killed.signal, 'SIGKILL');
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  assert.equal((await install(prefix)).code, 0);
  const removing = original.replace('for (const name of allowed.filter', "process.kill(process.pid, 'SIGKILL');\n    for (const name of allowed.filter");
  await writeFile(faultDriver, removing.replace("from './package-files.mjs'", `from ${JSON.stringify(new URL('../package-files.mjs', import.meta.url).href)}`)
    .replace("from './errors.mjs'", `from ${JSON.stringify(new URL('../errors.mjs', import.meta.url).href)}`)
    .replace('const source = dirname(dirname(fileURLToPath(import.meta.url)));', `const source = ${JSON.stringify(packageRoot)};`));
  assert.equal((await install(prefix, 'uninstall', faultDriver)).signal, 'SIGKILL');
  await assert.rejects(lstat(prefix), { code: 'ENOENT' });
  assert.equal((await install(prefix, 'uninstall')).code, 0);
  await assert.rejects(lstat(`${prefix}.removing`), { code: 'ENOENT' });
});

test('shared device export opens through actual CLI secret pipe; wrong key and server origin refuse', { skip: !posix }, async t => {
  const root = await fixture(t), vault = join(root, 'vault');
  await mkdir(vault, { mode: 0o700 });
  const c = require(join(packageRoot, 'cli/shared/crypto.js'));
  const p = require(join(packageRoot, 'cli/shared/pairing.js'));
  const { DesktopExports } = require(join(packageRoot, 'cli/shared/exportDesktop.js'));
  const key = new Uint8Array(32).fill(21), domain = 'd1'.repeat(16), fileId = '01'.repeat(16), plain = Buffer.from('independent plaintext readback\r\n');
  const dk = await c.deriveDomainKey(key, domain), mk = await c.deriveManifestKey(dk, domain);
  const chunk = await c.encryptChunk(dk, plain), sids = [chunk.sid];
  const sealed = await c.encryptManifest(mk, fileId, await c.contentVersionId(fileId, [], sids), JSON.stringify({
    v: 1, path: 'Notes/sentinel.md', domain, mtime: 1, size: plain.length, deleted: false,
    chunks: [{ sid: chunk.sid, cid: c.hex(chunk.cid), len: plain.length }], sha256: sha256(plain),
  }));
  const version = { version_id: await c.versionId(fileId, [], sealed.ciphertext, sids), parents: [], sids,
    bytes: plain.length, manifest_ct: c.base64(sealed.ciphertext), manifest_nonce: c.hex(sealed.nonce), deleted: false };
  const index = { v: 1, source: 'device', scope: 'current', snapshot: 1,
    files: [{ file_id: fileId, domain_id: domain, heads: [version.version_id], versions: [version] }] };
  const archive = join(root, 'encrypted.obsync');
  await new DesktopExports(vault).encrypted(archive, index, key, async () => chunk.ciphertext, () => {});
  const words = (await p.recoveryPhrase(key)).join(' ');
  const args = destination => [entry, 'export', 'open', '--archive', archive, '--destination', destination,
    '--vault-root', vault, '--phrase-fd', '3', '--plaintext'];
  const output = join(root, 'opened');
  const result = await run(process.execPath, args(output), { phrase: words });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(await readFile(join(output, 'Notes/sentinel.md')), plain);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.ok(!result.stdout.includes(words) && !result.stderr.includes(words));
  const denied = join(root, 'denied');
  const wrong = await run(process.execPath, args(denied), { phrase: (await p.recoveryPhrase(new Uint8Array(32).fill(22))).join(' ') });
  assert.equal(wrong.code, 8, wrong.stdout);
  await assert.rejects(lstat(denied), { code: 'ENOENT' });
  // Server framing keeps ciphertext but has an explicit zero inventory authenticator.
  index.source = 'server';
  const server = join(root, 'server.obsync');
  const { EXPORT_MAGIC } = require(join(packageRoot, 'cli/shared/export.js'));
  const sourceBytes = await readFile(archive), offset = EXPORT_MAGIC.length + 4;
  const raw = Buffer.from(JSON.stringify(index));
  assert.equal(raw.length, sourceBytes.readUInt32BE(EXPORT_MAGIC.length));
  raw.copy(sourceBytes, offset);
  Buffer.from(sha256(raw), 'hex').copy(sourceBytes, offset + raw.length);
  sourceBytes.fill(0, offset + raw.length + 32, offset + raw.length + 64);
  await writeFile(server, sourceBytes, { mode: 0o600 });
  const serverArgs = args(denied); serverArgs[serverArgs.indexOf(archive)] = server;
  assert.equal((await run(process.execPath, serverArgs, { phrase: words })).code, 8);
  assert.equal((await run(process.execPath, [...serverArgs, '--allow-server-origin'], { phrase: words })).code, 0);
  assert.deepEqual(await readFile(join(denied, 'Notes/sentinel.md')), plain);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.obsync-export-')));
  const stalled = join(root, 'stalled');
  const timedOut = await run(process.execPath, args(stalled), { phrase: words, holdPhrase: true });
  assert.equal(timedOut.code, 7, timedOut.stdout + timedOut.stderr);
  assert.equal(JSON.parse(timedOut.stdout).error.code, 'phrase_deadline');
  await assert.rejects(lstat(stalled), { code: 'ENOENT' });
});

test('Windows capability refuses persistent installer and plaintext before accepting recovery material', { skip: posix }, async () => {
  assert.equal((await install(join(tmpdir(), 'unsupported-obsync'))).code, 6);
  assert.equal((await run(process.execPath, [entry, 'export', 'open'])).code, 6);
});
