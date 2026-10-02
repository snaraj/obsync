// Actual Windows child-process acceptance for the shared primitive. The trusted
// PowerShell driver owns the synthetic fixture and supplies its OS executable.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, link, symlink, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

const [phase, root, receipt, digest] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.match(phase, /^(prepare|publish)$/);
const { WindowsFiles } = createRequire(import.meta.url)('../../plugin/build/windowsFiles.js');
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
