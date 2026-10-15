// Fixed, task-owned paths only. Nothing here discovers profiles, vaults or secrets.
import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function owned(path, directory = false, privateMode = true) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      stat.uid !== process.getuid() || (privateMode && (stat.mode & 0o077)) || realpathSync(path) !== resolve(path)) {
    throw Error('owned path custody refused');
  }
  return stat;
}
export function privateRead(path) {
  owned(path);
  return readFileSync(path, 'utf8').trim();
}
export function privateSave(path, value) {
  owned(join(path, '..'), true);
  writeFileSync(path, value + '\n', { mode: 0o600, flag: 'wx' });
  if (privateRead(path) !== value) throw Error('private file readback refused');
}
export function contained(root, path) {
  const part = relative(root, path);
  if (!part || part === '..' || part.startsWith('../') || isAbsolute(part)) throw Error('foreign owned path');
  return path;
}
function boundTransport(state, source, url) {
  if (Number(url.port) === state.server_port) return;
  const binding = JSON.parse(privateRead(join(state.run, 'private/tls-binding.json')));
  if (binding.schema !== 1 || binding.bind !== '127.0.0.1' || binding.upstreamPort !== state.server_port ||
      binding.recorderPort !== Number(url.port) || !Number.isInteger(binding.tlsPort) || binding.tlsPort < 1024 || binding.tlsPort > 65535 ||
      !Number.isInteger(binding.pid) || binding.pid <= 1 || typeof binding.identity !== 'string' ||
      !Array.isArray(binding.argv) || binding.argv.length !== 6 || binding.argv[2] !== state.run ||
      binding.argv[3] !== join(source, 'scripts/ci/observer.mjs') ||
      binding.argv[4] !== String(state.server_port) || binding.argv[5] !== String(binding.tlsPort) ||
      !binding.argv[1].endsWith('/scripts/validation/mobile-tls.mjs') || !/^[a-f0-9]{64}$/.test(binding.scriptSha256)) {
    throw Error('task transport binding refused');
  }
  owned(binding.argv[1], false, false);
  if (digest(readFileSync(binding.argv[1])) !== binding.scriptSha256) throw Error('task transport script changed');
  const identity = execFileSync('ps', ['-p', String(binding.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim();
  if (identity !== binding.identity || !identity.endsWith(binding.argv.join(' '))) throw Error('task transport identity changed');
  for (const port of [binding.recorderPort, binding.tlsPort]) {
    const listeners = execFileSync('lsof', ['-nP', '-a', '-p', String(binding.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
      .split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    if (listeners.length !== 1 || listeners[0] !== `127.0.0.1:${port}`) throw Error('task transport listener changed');
  }
}
export function boundManifest(run, source) {
  run = resolve(run); source = resolve(source);
  owned(run, true);
  for (const name of ['private', 'runtime', 'evidence']) owned(join(run, name), true);
  const state = JSON.parse(privateRead(join(run, 'lab.json')));
  if (state.format !== 1 || state.run !== run || state.stopped || state.source_dirty !== false ||
      !/^[a-f0-9]{40}$/.test(state.source_head)) throw Error('invalid or dirty candidate lab');
  const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (realpathSync(source) !== source || git(['rev-parse', 'HEAD']) !== state.source_head || git(['status', '--porcelain'])) {
    throw Error('source is dirty or differs from candidate');
  }
  const device = state.devices?.A, server = state.processes?.server, app = state.processes?.A;
  if (!device || device.android || device.vault !== join(run, 'runtime/A/Lab-A') || device.userdata !== join(run, 'runtime/A/userdata') ||
      !Number.isInteger(device.port) || device.port < 1024 || device.port > 65535 ||
      !Array.isArray(app?.argv) || app.argv.length !== 4 || !app.argv[0].endsWith('/Obsidian.app/Contents/MacOS/Obsidian') ||
      !app?.argv?.includes(`--user-data-dir=${device.userdata}`) ||
      !app.argv.includes(`--remote-debugging-port=${device.port}`) ||
      !app.argv.includes('--remote-debugging-address=127.0.0.1') ||
      JSON.stringify(server?.argv) !== JSON.stringify([join(run, 'runtime/build/obsyncd'), 'serve'])) throw Error('unowned desktop or server');
  owned(device.vault, true, false); owned(device.userdata, true, false);
  const url = new URL(state.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(state.server_port) ||
      !Number.isInteger(Number(url.port)) || Number(url.port) < 1024 || Number(url.port) > 65535 || state.server_port < 1024 || state.server_port > 65535 ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('desktop lab must use its loopback endpoint');
  }
  boundTransport(state, source, url);
  for (const record of [app, server]) {
    if (!Number.isInteger(record.pid) || record.pid <= 1 || typeof record.identity !== 'string' || !record.identity) throw Error('invalid process identity');
    const actual = execFileSync('ps', ['-p', String(record.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim();
    if (actual !== record.identity || !actual.endsWith(record.argv.join(' '))) throw Error('owned process identity changed');
  }
  const artifacts = ['obsyncd', 'plugin/main.js', 'plugin/manifest.json', 'plugin/styles.css'];
  for (const name of artifacts) {
    const expected = state.artifacts?.[name], built = join(run, 'runtime/build', name);
    owned(built, false, false);
    if (!/^[a-f0-9]{64}$/.test(expected) || digest(readFileSync(built)) !== expected) throw Error('candidate artifact changed');
    if (name.startsWith('plugin/')) {
      for (const path of [join(device.vault, '.obsidian/plugins/obsync-private-sync', name.slice(7)), join(source, 'plugin/dist', name.slice(7))]) {
        owned(path, false, false);
        if (digest(readFileSync(path)) !== expected) throw Error('installed or source plugin differs from candidate');
      }
    }
  }
  const secrets = join(run, 'private/desktop');
  try { mkdirSync(secrets, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  owned(secrets, true);
  return { ...state, secrets };
}

// A text file alone is insufficient: bind the witness to the current owned app.
export function assertAndroidObservation(observation, creator, invitationMs, appPid, now = Date.now()) {
  const timestamp = typeof observation?.observedAt === 'string' ? Date.parse(observation.observedAt) : observation?.observedAt;
  if (!observation || Object.keys(observation).sort().join(',') !== 'appPid,code,observedAt' ||
      !/^[0-9]{3} [0-9]{3}$/.test(observation.code) || !Array.isArray(creator) || creator.length !== 1 || creator[0] !== observation.code ||
      !Number.isInteger(appPid) || appPid <= 1 || observation.appPid !== appPid || !Number.isFinite(timestamp) ||
      !Number.isFinite(invitationMs) || !Number.isFinite(now) || invitationMs > now + 2000 ||
      timestamp < invitationMs || timestamp > now + 2000 || now - timestamp > 60000 || now - invitationMs > 600000) {
    throw Error('independent Android comparison refused');
  }
  return observation.code;
}
