// Run only after independent publisher verification, using the trusted pinned Node.
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FILES, RUNTIME, regular, sha256, verifyPackage, inventory } from './package-files.mjs';
import { CliError, closed, refuse } from './errors.mjs';

const started = Date.now();
const mode = process.argv[2];
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const options = {};
const paths = ['cli', 'cli/shared'];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function missing(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(path, private_ = false) {
  refuse(isAbsolute(path) && resolve(path) === path && path !== parse(path).root,
    'install_path', 'Use a canonical absolute installation directory.', 4);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/')) {
    current = join(current, part);
    const stat = await lstat(current);
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000);
    refuse(stat.isDirectory() && !stat.isSymbolicLink() &&
      (stat.uid === 0 || stat.uid === process.getuid()) && (!(stat.mode & 0o022) || stickyRoot),
    'install_path', 'Installation ancestors must be protected directories without links.', 4);
    if (private_ && current === path) refuse(stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
      'install_path', 'Installation directories must be owned and mode 0700.', 4);
  }
}
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function privateFile(file, executable = false) {
  const stat = await lstat(file);
  refuse(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() &&
    (stat.mode & 0o777) === (executable ? 0o700 : 0o600), 'install_path', 'Installation files must be private owned regular files.', 4);
}
async function durable(file, bytes, executable = false) {
  const previous = await missing(file);
  if (previous) {
    await privateFile(file, executable);
    const existing = await regular(file);
    // Resume a killed copy only when every existing byte is the expected prefix.
    refuse(existing.length <= bytes.length && bytes.subarray(0, existing.length).equals(existing),
      'install_conflict', 'An existing installation file differs; it was left unchanged.', 5);
    if (existing.equals(bytes)) return;
  }
  const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW |
    (previous ? constants.O_TRUNC : constants.O_CREAT | constants.O_EXCL), executable ? 0o700 : 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function launcher(prefix, record) {
  const checksum = process.platform === 'darwin' ? '/usr/bin/shasum -a 256' : '/usr/bin/sha256sum';
  // Paths are quoted shell literals; caller arguments are forwarded as data only.
  return Buffer.from(`#!/bin/sh\nset -eu\nstarted=$(/bin/date +%s)\n` +
    `fail() { elapsed=$(( ($(/bin/date +%s) - started) * 1000 )); printf '{"schema_version":1,"event":"cli_launch_refused","decision":"exit","reason":"runtime_or_bootstrap_integrity","duration_ms":%s,"budget_bytes":268435456}\\n' "$elapsed" >&2; exit 4; }\n` +
    `check() { result=$(/usr/bin/env -i PATH=/usr/bin:/bin ${checksum} "$1"); [ "\${result%% *}" = "$2" ]; }\n` +
    `check ${quote(record.runtime_path)} ${quote(record.runtime_executable_sha256)} || fail\n` +
    `check ${quote(join(prefix, 'cli/launch.mjs'))} ${quote(record.launch_sha256)} || fail\n` +
    `exec /usr/bin/env -i HOME=${quote(record.home)} PATH=/usr/bin:/bin ${quote(record.runtime_path)} ` +
    `${quote(join(prefix, 'cli/launch.mjs'))} ${quote(record.manifest_sha256)} "$@"\n`);
}
async function runtimeExecutableDigest(path) {
  await directory(dirname(path));
  const stat = await lstat(path);
  refuse(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o022) &&
    [0, process.getuid()].includes(stat.uid), 'runtime_path', 'The trusted runtime must have protected ancestors and ownership.', 4);
  return sha256(await regular(path, 268435456));
}
async function recordFor(prefix, manifest) {
  return { schema_version: 1, prefix, manifest_sha256: options['manifest-sha256'],
    runtime_path: process.execPath, runtime_executable_sha256: await runtimeExecutableDigest(process.execPath),
    launch_sha256: manifest.files.find(item => item.name === 'cli/launch.mjs').sha256, home: homedir() };
}
async function inspectInstall(prefix, digest, checkRuntime = true) {
  await directory(prefix, true);
  for (const path of paths) await directory(join(prefix, path), true);
  const manifest = await verifyPackage(prefix, digest, ['obsync', 'install-record.json']);
  for (const name of [...FILES, 'package-manifest.json', 'obsync', 'install-record.json']) await privateFile(join(prefix, name), name === 'obsync');
  const record = JSON.parse(await regular(join(prefix, 'install-record.json'), 16384));
  closed(record, ['schema_version', 'prefix', 'manifest_sha256', 'runtime_path', 'runtime_executable_sha256', 'launch_sha256', 'home']);
  refuse(record.schema_version === 1 && record.prefix === prefix && record.manifest_sha256 === digest &&
    record.launch_sha256 === manifest.files.find(item => item.name === 'cli/launch.mjs').sha256 &&
    /^[a-f0-9]{64}$/.test(record.runtime_executable_sha256) && isAbsolute(record.runtime_path) && isAbsolute(record.home),
  'install_conflict', 'The installation receipt is invalid.', 4);
  refuse((await regular(join(prefix, 'obsync'), 16384)).equals(launcher(prefix, record)),
    'install_conflict', 'The launcher differs from its receipt.', 4);
  if (checkRuntime) refuse(await runtimeExecutableDigest(record.runtime_path) === record.runtime_executable_sha256,
    'runtime_path', 'The installed runtime differs from its verified receipt.', 4);
  return manifest;
}
async function uninstall(prefix, digest) {
  const manifest = await verifyPackage(source, digest);
  const removing = `${prefix}.removing`;
  if (await missing(prefix)) {
    refuse(!await missing(removing), 'install_conflict', 'A prior removal needs completion first.', 5);
    await inspectInstall(prefix, digest, false);
    await rename(prefix, removing);
    await syncDirectory(dirname(prefix));
  }
  if (!await missing(removing)) return;
  await directory(removing, true);
  const remaining = await inventory(removing);
  const allowed = [...FILES, 'obsync', 'package-manifest.json', 'install-record.json'];
  refuse(remaining.every(name => allowed.includes(name)), 'install_conflict', 'Removal has unknown contents; nothing further was deleted.', 5);
  // The receipt is deleted last. An absent receipt allows only empty directories.
  if (remaining.length) {
    const record = JSON.parse(await regular(join(removing, 'install-record.json'), 16384));
    closed(record, ['schema_version', 'prefix', 'manifest_sha256', 'runtime_path', 'runtime_executable_sha256', 'launch_sha256', 'home']);
    refuse(record.schema_version === 1 && record.prefix === prefix && record.manifest_sha256 === digest &&
      record.launch_sha256 === manifest.files.find(item => item.name === 'cli/launch.mjs').sha256 &&
      /^[a-f0-9]{64}$/.test(record.runtime_executable_sha256) && isAbsolute(record.runtime_path) && isAbsolute(record.home),
    'install_conflict', 'The removal receipt is invalid.', 4);
    for (const name of remaining) {
      await privateFile(join(removing, name), name === 'obsync');
      const expected = name === 'install-record.json' ? null : name === 'obsync' ? sha256(launcher(prefix, record)) :
        name === 'package-manifest.json' ? digest : manifest.files.find(item => item.name === name).sha256;
      if (expected) refuse(sha256(await regular(join(removing, name))) === expected,
        'install_conflict', 'Removal inventory differs; nothing further was deleted.', 4);
    }
    for (const name of allowed.filter(name => remaining.includes(name))) await unlink(join(removing, name));
  }
  for (const name of [...paths].reverse()) {
    if (await missing(join(removing, name))) {
      await directory(join(removing, name), true);
      await rmdir(join(removing, name));
    }
  }
  await rmdir(removing);
  await syncDirectory(dirname(prefix));
}
try {
  refuse(process.version === `v${RUNTIME}` && !process.env.NODE_OPTIONS && process.execArgv.length === 0,
    'unsupported_runtime', 'Use trusted Node 26.10.0 with a clean runtime environment.', 6);
  refuse(['darwin', 'linux'].includes(process.platform), 'unsupported_platform',
    'Persistent installation requires native private-file and durability support on this platform.', 6);
  refuse(['install', 'uninstall'].includes(mode), 'invalid_input', 'Use install or uninstall with --prefix and --manifest-sha256.');
  for (let i = 3; i < process.argv.length; i += 2) {
    const name = process.argv[i].slice(2);
    refuse(['prefix', 'manifest-sha256'].includes(name) && !Object.hasOwn(options, name) &&
      typeof process.argv[i + 1] === 'string' && process.argv[i + 1].length <= 4096,
    'invalid_input', 'Unknown, repeated or missing installer option.');
    options[name] = process.argv[i + 1];
  }
  const prefix = options.prefix;
  refuse(typeof prefix === 'string' && isAbsolute(prefix) && resolve(prefix) === prefix &&
    !/[\r\n\0]/.test(prefix) && prefix !== source && !source.startsWith(`${prefix}/`) && !prefix.startsWith(`${source}/`),
  'install_path', 'Choose a separate canonical absolute installation directory.', 4);
  await directory(dirname(prefix));
  const digest = options['manifest-sha256'];
  if (mode === 'uninstall') {
    await uninstall(prefix, digest);
  } else {
    const manifest = await verifyPackage(source, digest);
    const record = await recordFor(prefix, manifest);
    if (await missing(prefix)) await inspectInstall(prefix, digest);
    else {
      const pending = `${prefix}.pending`;
      try { await mkdir(pending, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await directory(pending, true);
      const allowed = [...FILES, 'package-manifest.json', 'obsync', 'install-record.json'];
      const existing = await inventory(pending);
      refuse(existing.every(name => allowed.includes(name)) &&
        (existing.length === 0 || existing.includes('package-manifest.json')),
      'install_conflict', 'The pending directory has unknown contents.', 5);
      const raw = await regular(join(source, 'package-manifest.json'), 16384);
      if (existing.length > 1) refuse((await regular(join(pending, 'package-manifest.json'), 16384)).equals(raw),
        'install_conflict', 'The pending files lack an exact package binding.', 5);
      await durable(join(pending, 'package-manifest.json'), raw);
      for (const name of paths) {
        try { await mkdir(join(pending, name), { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await directory(join(pending, name), true);
      }
      for (const name of FILES) await durable(join(pending, name), await regular(join(source, name)));
      await durable(join(pending, 'install-record.json'), Buffer.from(`${JSON.stringify(record)}\n`));
      await durable(join(pending, 'obsync'), launcher(prefix, record), true);
      await verifyPackage(pending, digest, ['obsync', 'install-record.json']);
      for (const name of [...paths].reverse()) await syncDirectory(join(pending, name));
      await syncDirectory(pending);
      await rename(pending, prefix);
      await syncDirectory(dirname(prefix));
      await inspectInstall(prefix, digest);
    }
  }
  console.log(JSON.stringify({ schema_version: 1, operation: `cli.${mode}`, state: 'satisfied',
    manifest_sha256: digest, duration_ms: Date.now() - started, configuration_changed: false }));
} catch (error) {
  console.log(JSON.stringify({ schema_version: 1, operation: `cli.${mode ?? 'install'}`, state: 'needs_action',
    error: { code: error instanceof CliError ? error.code : 'local_io', message: error instanceof CliError ? error.message :
      'Installation did not complete. The previous installation is retained; retry the exact verified package and directory.' },
    duration_ms: Date.now() - started }));
  process.exitCode = error instanceof CliError ? error.exit : 9;
}
