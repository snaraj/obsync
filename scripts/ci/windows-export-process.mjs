// Native process acceptance for the shared app adapter; only synthetic fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const [phase, root, receipt, digest] = process.argv.slice(2);
assert.equal(process.platform, 'win32'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
const require = createRequire(import.meta.url), c = require('../../plugin/build/crypto.js');
const { WindowsFiles } = require('../../plugin/build/windowsFiles.js');
const { DesktopExports } = require('../../plugin/build/exportDesktop.js');
const files = await WindowsFiles.fromReceipt(receipt, digest);
const vault = join(root, 'export-vault'), archive = join(root, 'copy.obsync');
const desktop = new DesktopExports(vault, 'config-private', files);
const key = new Uint8Array(32).fill(21), data = new Uint8Array(8 * 1024 * 1024 + 19).fill(42);
const stat = async path => { try { return await lstat(path, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function child(executable, args) {
  const process = spawn(executable, args, { env: { GITHUB_ACTIONS: 'true', SystemRoot: globalThis.process.env.SystemRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', size = 0;
  const timer = setTimeout(() => process.kill('SIGKILL'), 90000);
  for (const stream of [process.stdout, process.stderr]) stream.on('data', bytes => { size += bytes.length; if (size > 16384) process.kill('SIGKILL'); else if (stream === process.stdout) output += bytes; });
  const done = new Promise((resolve, reject) => {
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  return { process, done };
}
if (phase === 'open') {
  await desktop.open(archive, join(root, 'recovered-open'), key, false, () => {});
} else {
  assert.equal(phase, 'all');
  // Execute exactly the public bootstrap command in the independently supplied
  // OS shell. Its generated receipt is verified before importing its path.
  const command = join(root, 'trusted-setup.ps1');
  await writeFile(command, await WindowsFiles.setupCommand('8a'.repeat(16)), { flag: 'wx' });
  const trusted = JSON.parse(await readFile(receipt, 'utf8'));
  const setup = await child(trusted.powershell.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', command]).done;
  assert.equal(setup.code, 0, 'Actual trusted setup command failed.');
  const binding = JSON.parse(setup.output);
  await WindowsFiles.fromReceipt(binding.path, binding.digest);
  await assert.rejects(WindowsFiles.fromReceipt(binding.path, '00'.repeat(32)));
  await files.mkdir(vault); await files.mkdir(join(vault, 'config-private'));
  await writeFile(join(vault, 'Note.md'), 'synthetic local note\r\n');
  await writeFile(join(vault, 'config-private', 'private.json'), 'excluded synthetic config');
  const domain = 'd1'.repeat(16), fileId = '01'.repeat(16);
  const dk = await c.deriveDomainKey(key, domain), mk = await c.deriveManifestKey(dk, domain);
  const chunks = new Map(), parts = [];
  for (let at = 0; at < data.length; at += 8 * 1024 * 1024) {
    const plain = data.slice(at, at + 8 * 1024 * 1024), sealed = await c.encryptChunk(dk, plain);
    chunks.set(sealed.sid, sealed.ciphertext); parts.push({ sid: sealed.sid, cid: c.hex(sealed.cid), len: plain.length });
  }
  const sids = parts.map(part => part.sid), manifest = { v: 1, path: 'Files/sentinel.bin', domain, mtime: 1, size: data.length, chunks: parts, deleted: false, sha256: '' };
  const sealed = await c.encryptManifest(mk, fileId, await c.contentVersionId(fileId, [], sids), JSON.stringify(manifest));
  const version = { version_id: await c.versionId(fileId, [], sealed.ciphertext, sids), parents: [], sids, bytes: data.length, manifest_ct: c.base64(sealed.ciphertext), manifest_nonce: c.hex(sealed.nonce), deleted: false };
  const index = { v: 1, source: 'device', scope: 'current', snapshot: 1, files: [{ file_id: fileId, domain_id: domain, heads: [version.version_id], versions: [version] }] };
  await desktop.encrypted(archive, index, key, async sid => chunks.get(sid), () => {});
  const archiveIdentity = await stat(archive);
  await assert.rejects(desktop.encrypted(archive, index, new Uint8Array(32).fill(22), async sid => chunks.get(sid), () => {}));
  assert.equal((await stat(archive)).ino, archiveIdentity.ino);
  assert.equal((await readFile(archive)).includes(Buffer.from(manifest.path)), false);
  const opened = join(root, 'opened-export');
  assert.deepEqual(await desktop.open(archive, opened, key, false, () => {}), { files: 1, bytes: data.length });
  assert.deepEqual(new Uint8Array(await readFile(join(opened, manifest.path))), data);
  const before = await stat(opened);
  await desktop.open(archive, opened, key, false, () => {});
  assert.equal((await stat(opened)).ino, before.ino);
  const local = await desktop.local(() => {}), plain = join(root, 'plain-export');
  assert.deepEqual(local.map(file => file.path), ['Note.md']);
  await desktop.plain(plain, local, () => {});
  assert.equal(await readFile(join(plain, 'Note.md'), 'utf8'), 'synthetic local note\r\n');
  await assert.rejects(desktop.plain(join(vault, 'inside'), local, () => {}));
  await writeFile(join(root, 'unrelated'), 'keep');
  await assert.rejects(desktop.plain(join(root, 'unrelated'), local, () => {}));
  assert.equal(await readFile(join(root, 'unrelated'), 'utf8'), 'keep');
  const target = join(root, 'recovered-open');
  const journal = join(root, `.obsync-export-state-${c.hex(await c.sha256(c.utf8(target.toUpperCase())))}`);
  const interrupted = child(process.execPath, [fileURLToPath(import.meta.url), 'open', root, receipt, digest]);
  let observed = false;
  try {
    const until = Date.now() + 60000;
    while (Date.now() < until && interrupted.process.exitCode === null) {
      if (await stat(join(journal, 'record.json'))) {
        const record = JSON.parse(await readFile(join(journal, 'record.json'), 'utf8'));
        if (await stat(join(record.stage, 'Files', 'sentinel.bin'))) { observed = interrupted.process.kill('SIGKILL'); break; }
      }
      await delay(2);
    }
  } finally { if (!observed) interrupted.process.kill('SIGKILL'); }
  assert.notEqual((await interrupted.done).code, 0); assert.equal(observed, true, 'Actual partial export boundary was not observed.');
  assert.equal(await stat(target), null);
  const recovered = await child(process.execPath, [fileURLToPath(import.meta.url), 'open', root, receipt, digest]).done;
  assert.equal(recovered.code, 0, 'Fresh interrupted export recovery failed.');
  assert.deepEqual(new Uint8Array(await readFile(join(target, manifest.path))), data);
}
console.log(JSON.stringify({ event: 'windows_export_process', phase, result: 'pass' }));
