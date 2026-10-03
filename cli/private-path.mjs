// The approved reader accepts only a held directory; no file or permission mutation.
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CliError } from './errors.mjs';

let reader;
const verified = new Map();
export async function macosDirectory(path) {
  if (process.platform !== 'darwin') return;
  try {
    const stat = await lstat(path, { bigint: true });
    const identity = [stat.dev, stat.ino, stat.uid, stat.mode, stat.ctimeNs].join(':');
    if (verified.get(path) === identity) return;
    const { MacosAcl } = createRequire(import.meta.url)('./shared/macosAcl.js');
    reader ??= new MacosAcl();
    const checked = await reader.inspect(path, stat);
    verified.set(path, [checked.dev, checked.ino, checked.uid, checked.mode, checked.ctimeNs].join(':'));
  } catch {
    throw new CliError('unsafe_config', 'The directory ACL or native read could not establish protected custody.', 4);
  }
}
