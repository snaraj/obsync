// One authoritative source, embedded into main.js and the CLI shared package.
// Build input only: no runtime script discovery or installed CLI prerequisite.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function windowsHelperModule() {
  const bytes = await readFile(new URL('../cli/windows-files.ps1', import.meta.url));
  if (bytes.length > 12080 || bytes.some(byte => byte > 127)) throw Error('Windows helper source budget.');
  const source = bytes.toString('ascii');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return `"use strict";\nexports.source=${JSON.stringify(source)};\nexports.sha256=${JSON.stringify(sha256)};\n`;
}
