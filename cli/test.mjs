// The first measured passing-test floor; skips cannot satisfy it.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('./test/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort().map(name => directory + name);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files],
  { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
const floor = process.platform === 'win32' ? 2 : 12;
const passed = Number(/^# pass (\d+)$/m.exec(result.stdout ?? '')?.[1] ?? 0);
if (result.status !== 0 || passed < floor) {
  process.stderr.write(`CLI test gate refused: passed=${passed} required=${floor}\n`);
  process.exitCode = 1;
}
