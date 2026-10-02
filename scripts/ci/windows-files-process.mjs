// Actual Windows child-process acceptance for the shared primitive. The trusted
// PowerShell driver owns the synthetic fixture and supplies its OS executable.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, link, symlink, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [phase, root, receipt, digest] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.match(phase, /^(prepare|publish)$/);
const { WindowsFiles } = createRequire(import.meta.url)('../../plugin/build/windowsFiles.js');
if (phase === 'prepare') {
  const raw = await readFile(receipt);
  assert.equal(createHash('sha256').update(raw).digest('hex'), digest);
  const trust = JSON.parse(raw), shell = trust.powershell.path;
  const source = createRequire(import.meta.url)('../../plugin/build/windowsHelperData.js').source;
  const system = shell.slice(0, -'\\WindowsPowerShell\\v1.0\\powershell.exe'.length);
  const input = JSON.stringify({ v: 1, op: 'inspect', path: root, destination: '' });
  let traced = source.replace(/^#.*\r?\n/gm, '');
  for (const [index, at] of ['Set-StrictMode', '  Inspect-Parents $Executable', '  $Characters =', '  $Request = ConvertFrom-Json', '  $Names =', '  Exact-Path $Request.path'].entries()) {
    assert.ok(traced.includes(at));
    traced = traced.replace(at, `[Console]::Out.WriteLine('${index + 1}');\n${at}`);
  }
  for (const [name, code] of [
    ['startup', "[Console]::Out.WriteLine('probe')"],
    ['stdin', "$r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096);[Console]::Out.WriteLine($r.ReadToEnd().Length)"],
    ['json', "[Console]::Out.WriteLine((ConvertFrom-Json '{\"v\":1}').v)"],
    ['trace', traced],
    ['helper', source],
  ]) {
    const started = performance.now();
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024, windowsHide: true,
      cwd: system, env: { SystemRoot: system.slice(0, -'\\System32'.length), PSModulePath: `${system}\\WindowsPowerShell\\v1.0\\Modules` },
    });
    console.log(JSON.stringify({ event: 'native_launch_probe', name, status: result.status, signal: result.signal,
      error: result.error?.code, stdout_bytes: result.stdout?.length, stderr_bytes: result.stderr?.length,
      checkpoints: name === 'trace' ? (result.stdout?.match(/^[1-6]\r?$/gm) ?? []).map(x => x.trim()) : undefined,
      duration_ms: Math.round(performance.now() - started) }));
  }
}
const files = await WindowsFiles.fromReceipt(receipt, digest);
const stage = join(root, 'stage'), destination = join(root, 'complete');
if (phase === 'prepare') {
  await files.mkdir(stage);
  const sentinel = join(stage, 'sentinel.txt');
  await files.create(sentinel);
  await writeFile(sentinel, 'synthetic private custody sentinel\n');
  await files.flush(sentinel);
  await files.inspect(sentinel);
  await assert.rejects(files.mkdir(stage));
  for (const bad of [sentinel + ':alternate', root + '\\trailing.', root + '\\CON', root + '\\..\\escape']) {
    await assert.rejects(files.create(bad));
  }
  const hard = join(stage, 'hard.txt');
  await link(sentinel, hard);
  await assert.rejects(files.inspect(hard));
  await assert.rejects(files.publish(stage, destination));
  await rm(hard);
  const outside = join(root, 'outside');
  await files.mkdir(outside);
  const junction = join(stage, 'junction');
  await symlink(outside, junction, 'junction');
  await assert.rejects(files.inspect(junction));
  await assert.rejects(files.publish(stage, destination));
  await rm(junction);
  await files.mkdir(destination);
  await assert.rejects(files.publish(stage, destination));
  await rm(destination, { recursive: true });
  // Descendants inherit the private root ACL at creation. Native OS readback
  // must still prove that effective ACL instead of trusting an inheritance bit.
  const inherited = join(root, 'inherited');
  await mkdir(inherited);
  await files.inspect(inherited);
  const identity = await lstat(stage, { bigint: true });
  const record = join(root, 'identity.json');
  await files.create(record);
  await writeFile(record, JSON.stringify({ dev: String(identity.dev), ino: String(identity.ino) }));
  await files.flush(record);
} else {
  const expected = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
  await files.publish(stage, destination);
  await assert.rejects(lstat(stage), { code: 'ENOENT' });
  const actual = await lstat(destination, { bigint: true });
  assert.deepEqual({ dev: String(actual.dev), ino: String(actual.ino) }, expected);
  assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), 'synthetic private custody sentinel\n');
  await files.inspect(join(destination, 'sentinel.txt'));
}
console.log(JSON.stringify({ event: 'windows_files_process', phase, result: 'pass' }));
