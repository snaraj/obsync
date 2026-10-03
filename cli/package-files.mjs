import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { closed, refuse } from './errors.mjs';

export const RUNTIME = '26.10.0';
export const SHARED = ['chunker', 'crypto', 'domainmap', 'export', 'exportDesktop', 'manifest', 'pairing', 'transport', 'vaultPath', 'windowsExport', 'windowsFiles', 'windowsHelperData', 'wordlist'];
export const FILES = ['LICENSE', 'VERSION', 'cli/README.md', 'cli/catalog.mjs', 'cli/contexts.mjs',
  'cli/errors.mjs', 'cli/export-open.mjs', 'cli/install.mjs', 'cli/install-windows.mjs', 'cli/launch.mjs', 'cli/obsync.mjs', 'cli/windows-files.ps1',
  'cli/package-files.mjs', 'cli/package.json', 'cli/reference.mjs', 'cli/shared/package.json',
  ...SHARED.map(name => `cli/shared/${name}.js`)].sort();
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_PACKAGE = 4 * 1024 * 1024;

export async function regular(file, max = MAX_PACKAGE) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    refuse(stat.isFile() && stat.nlink === 1 && stat.size <= max, 'package_integrity', 'Package file type or size is invalid.', 4);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    refuse(length === stat.size, 'package_integrity', 'Package file changed during read.', 4);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export async function inventory(root, prefix = '') {
  const names = [];
  for (const name of await readdir(join(root, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(root, relative));
    refuse(!stat.isSymbolicLink(), 'package_integrity', 'Package links are refused.', 4);
    if (stat.isDirectory()) {
      refuse(['cli', 'cli/shared'].includes(relative), 'package_integrity', 'Unexpected package directory.', 4);
      names.push(...await inventory(root, relative));
    } else names.push(relative);
  }
  return names.sort();
}

export async function verifyPackage(root, expected, extra = []) {
  refuse(/^[a-f0-9]{64}$/.test(expected), 'package_integrity', 'An independently verified package manifest digest is required.', 4);
  const raw = await regular(join(root, 'package-manifest.json'), 16384);
  refuse(sha256(raw) === expected, 'package_integrity', 'Package manifest digest differs from the verified artifact.', 4);
  const manifest = JSON.parse(raw);
  closed(manifest, ['schema_version', 'version', 'runtime', 'source_sha', 'source_digest', 'candidate', 'files']);
  refuse(manifest.schema_version === 1 && manifest.runtime === RUNTIME &&
    /^\d+\.\d+\.\d+$/.test(manifest.version) && /^[a-f0-9]{40}$/.test(manifest.source_sha) &&
    /^[a-f0-9]{64}$/.test(manifest.source_digest) && typeof manifest.candidate === 'boolean' &&
    Array.isArray(manifest.files) && manifest.files.length === FILES.length,
  'package_integrity', 'Package manifest metadata is invalid.', 4);
  refuse(JSON.stringify(await inventory(root)) === JSON.stringify([...FILES, 'package-manifest.json', ...extra].sort()),
    'package_integrity', 'The package has missing or unexpected files.', 4);
  let total = 0;
  for (let index = 0; index < FILES.length; index++) {
    const item = manifest.files[index];
    closed(item, ['name', 'size', 'sha256']);
    refuse(item.name === FILES[index] && Number.isSafeInteger(item.size) && item.size > 0 &&
      item.size <= MAX_PACKAGE && /^[a-f0-9]{64}$/.test(item.sha256),
    'package_integrity', 'Package inventory is invalid.', 4);
    const bytes = await regular(join(root, item.name));
    total += bytes.length;
    refuse(total <= MAX_PACKAGE && bytes.length === item.size && sha256(bytes) === item.sha256,
      'package_integrity', 'Package content differs from the verified artifact.', 4);
  }
  refuse((await regular(join(root, 'VERSION'), 64)).toString().trim() === manifest.version,
    'package_integrity', 'Package version differs from its manifest.', 4);
  return manifest;
}
