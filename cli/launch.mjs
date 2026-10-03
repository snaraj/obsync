// The native launcher verifies this file and the pinned runtime before execution.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

try {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const rootIdentity = await lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw Error();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const expected = process.argv[2];
  const raw = await readFile(join(root, 'package-manifest.json'));
  if (raw.length > 16384 || !/^[a-f0-9]{64}$/.test(expected) || digest(raw) !== expected) throw Error();
  const manifest = JSON.parse(raw);
  const windows = process.platform === 'win32';
  let record;
  if (windows) {
    const rawRecord = await readFile(join(root, 'install-record.json'));
    if (rawRecord.length > 8192 || !/^[a-f0-9]{64}$/.test(process.argv[3]) || digest(rawRecord) !== process.argv[3]) throw Error();
    record = JSON.parse(rawRecord);
    if (record.prefix !== root || record.manifest_sha256 !== expected || record.schema_version !== 1) throw Error();
  }
  if (!Array.isArray(manifest.files) || manifest.files.length > 64) throw Error();
  let total = 0;
  for (const item of manifest.files) {
    if (typeof item.name !== 'string' || !/^[A-Za-z0-9_/.-]+$/.test(item.name) ||
      item.name.startsWith('/') || item.name.split('/').some(part => !part || part === '.' || part === '..')) throw Error();
    const file = join(root, item.name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (!windows && (stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600)) || stat.size !== item.size || (total += stat.size) > 4194304) throw Error();
    if (digest(await readFile(file)) !== item.sha256) throw Error();
  }
  // No package code is imported until all bytes match the verified manifest.
  const { verifyPackage } = await import('./package-files.mjs');
  await verifyPackage(root, expected, [windows ? 'obsync.ps1' : 'obsync', 'install-record.json']);
  const { macosDirectory } = await import('./private-path.mjs');
  await macosDirectory(root);
  let files = null;
  if (windows) {
    const { WindowsFiles } = createRequire(import.meta.url)('./shared/windowsFiles.js');
    // The fixed installed launcher performs native ACL and runtime checks before
    // Node starts. Internal JS invocation is outside that trusted entry boundary.
    files = await WindowsFiles.fromInstalledLauncher(root, rootIdentity, record.trust_path, record.trust_sha256);
  }
  const { main } = await import('./obsync.mjs');
  process.argv = [process.execPath, join(root, 'cli/obsync.mjs'), ...process.argv.slice(windows ? 4 : 3)];
  await main(files);
} catch {
  process.stderr.write('{"schema_version":1,"event":"cli_launch_refused","decision":"exit","reason":"package_integrity","budget_bytes":4194304}\n');
  process.exitCode = 4;
}
