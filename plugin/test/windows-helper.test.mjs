import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

test('shipped plugin embeds the exact single Windows helper source and digest', async () => {
  const original = await readFile(new URL('../../cli/windows-files.ps1', import.meta.url));
  const helper = createRequire(import.meta.url)('../build/windowsHelperData.js');
  const bundle = await readFile(new URL('../dist/main.js', import.meta.url), 'utf8');
  assert.deepEqual(Buffer.from(helper.source, 'ascii'), original);
  assert.equal(helper.sha256, createHash('sha256').update(original).digest('hex'));
  assert.ok(bundle.includes(`exports.source=${JSON.stringify(helper.source)};`));
  assert.ok(bundle.includes(`exports.sha256=${JSON.stringify(helper.sha256)};`));
  // Windows' 32,767-character process command limit includes the executable
  // path, fixed switches and encoded source. Input paths stay on stdin.
  assert.ok(Buffer.from(helper.source, 'utf16le').toString('base64').length + 512 < 32767);
});
