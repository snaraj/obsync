// Run only INSIDE the bounded container created by load277.py.
import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, cpSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadavg } from 'node:os';

const read = (...paths) => { for (const p of paths) { try { return readFileSync(p, 'utf8').trim(); } catch {} } throw Error('cgroup accounting missing'); };
const cpu = read('/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
const period = cpu.includes(' ') ? +cpu.split(' ')[1] : +read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
const quota = +cpu.split(' ')[0];
const memory = +read('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes');
if (process.version !== 'v26.10.0' || quota / period !== 4 || memory !== 8 * 1024 ** 3) throw Error('expected Node 26.10.0, 4 CPU quota, 8 GiB memory');
// Full-suite bundle tests rebuild dist; native filesystem tests need this
// Linux container's filesystem, not a macOS case-insensitive bind mount.
const sourceFiles = JSON.parse(readFileSync('/evidence/source-files.json', 'utf8'));
for (const path of sourceFiles) {
  if (path.startsWith('/') || path.split('/').some(p => p === '..' || p === '') || !lstatSync('/source/' + path).isFile()) throw Error('invalid source inventory');
  const target = '/scratch/source/' + path;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync('/source/' + path, target);
}
cpSync('/source/plugin/build', '/scratch/source/plugin/build', { recursive: true });
mkdirSync('/scratch/source/plugin/node_modules', { recursive: true });
cpSync('/source/plugin/node_modules/typescript', '/scratch/source/plugin/node_modules/typescript', { recursive: true });
mkdirSync('/scratch/tmp');
const suiteEnv = { ...process.env, TMPDIR: '/scratch/tmp', TMP: '/scratch/tmp', TEMP: '/scratch/tmp' };
// Verify the observed build/filesystem boundary failures before adding load.
const preflightLog = openSync('/evidence/harness-preflight.tap', 'wx', 0o600);
const preflight = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
  'test/api-compatibility.test.mjs', 'test/bundle.test.mjs', 'test/nativehost.test.mjs', 'test/realfs-case.test.mjs'],
  { cwd: '/scratch/source/plugin', env: suiteEnv, stdio: ['ignore', preflightLog, preflightLog], timeout: 120000 });
closeSync(preflightLog);
writeFileSync('/evidence/harness-preflight.json', JSON.stringify({ exit: preflight.status, signal: preflight.signal }) + '\n');
if (preflight.status !== 0) throw Error('harness build/filesystem preflight failed; full campaign not started');
const results = [];
const targets = [
  ['android-recase', 'an iPhone with a DIFFERENT note at the new spelling still answers occupied, keeps both, and the same-name rule applies'],
  ['sync-now', "Sync now reads a same-size, same-date rewrite of a file of exactly 8 MiB and not of a larger one; Verify all files reads both"],
];
async function run(label, args, stress) {
  const workers = [];
  if (stress) {
    for (let i = 0; i < 40; i++) workers.push(new Worker('const {parentPort}=require("node:worker_threads"); parentPort.postMessage("ready"); let n=1; while(true) n=(n*1664525+1013904223)>>>0;', { eval: true }));
    await Promise.all(workers.map(w => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); })));
  }
  const start = Date.now(), log = `/evidence/${label}.tap`;
  const fd = openSync(log, 'wx', 0o600);
  const record = { label, started: new Date(start).toISOString(), load: loadavg(), workers: workers.length, cpuQuota: quota, cpuPeriod: period, memoryBytes: memory };
  try {
    const child = spawn(process.execPath, args, { cwd: '/scratch/source/plugin', stdio: ['ignore', fd, fd], env: suiteEnv, detached: true });
    // This is a run deadline, not a larger test timeout or a retry.
    const timer = setTimeout(() => { record.timeout = true; process.kill(-child.pid, 'SIGKILL'); }, 15 * 60 * 1000);
    record.exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    const text = readFileSync(log, 'utf8');
    record.passedTests = +(text.match(/^# pass ([0-9]+)$/m)?.[1] ?? 0);
    record.result = record.exit === 0 && record.passedTests > 0 && !record.timeout ? 'PASS' : 'FAIL';
  } finally {
    closeSync(fd);
    await Promise.all(workers.map(w => w.terminate()));
    record.durationMs = Date.now() - start;
    results.push(record);
    writeFileSync('/evidence/results.json', JSON.stringify(results, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(record));
  }
}
for (const [file, title] of targets) {
  const pattern = '^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  for (let i = 1; i <= 20; i++) await run(`${file}-${i}`, ['--test', '--test-reporter=tap', '--test-name-pattern=' + pattern, `test/${file}.test.mjs`], false);
}
for (let i = 1; i <= 5; i++) await run(`suite-${i}`, ['test/run.mjs', '--test-reporter=tap'], true);
const residue = readdirSync('/scratch/tmp').filter(name => name !== 'node-compile-cache');
writeFileSync('/evidence/scratch.json', JSON.stringify({ entries: residue.length }) + '\n');
process.exitCode = results.length === 45 && results.every(r => r.result === 'PASS') && residue.length === 0 ? 0 : 1;
