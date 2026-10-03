// Native candidate used by the hosted journey. Public installer stays closed
// until that journey and the Windows durability contract have passed review.
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FILES, RUNTIME, regular, sha256, verifyPackage, inventory } from './package-files.mjs';
import { closed, refuse } from './errors.mjs';

const require = createRequire(import.meta.url);
const ps = value => `'${value.replaceAll("'", "''")}'`;
const directories = ['cli', 'cli/shared'];
const extras = ['obsync.ps1', 'install-record.json'];
const receiptKeys = ['schema_version', 'prefix', 'manifest_sha256', 'runtime_path', 'runtime_executable_sha256',
  'launch_sha256', 'trust_path', 'trust_sha256', 'powershell_path'];
const missing = async path => { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

function launcher(record) {
  const receipt = Buffer.from(`${JSON.stringify(record)}\n`);
  return Buffer.from(`$ErrorActionPreference='Stop'\n` +
    `$PSModuleAutoLoadingPreference='None'\n` +
    `function Assert-LaunchHash([string]$p,[string]$h){$f=[IO.File]::OpenRead($p);$s=[Security.Cryptography.SHA256]::Create();try{$v=[BitConverter]::ToString($s.ComputeHash($f)).Replace('-','').ToLowerInvariant()}finally{$f.Dispose();$s.Dispose()};if($v -cne $h){throw 'integrity'}}\n` +
    String.raw`function Quote-LaunchArgument([string]$s){'"'+[regex]::Replace([regex]::Replace($s,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}` + '\n' +
    `try {$step='shell'\n` +
    `if([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine ${ps(record.powershell_path)}){throw 'trusted OS PowerShell required'}\n` +
    `$step='receipt';Assert-LaunchHash ${ps(join(record.prefix, 'install-record.json'))} ${ps(sha256(receipt))}\n` +
    `$step='trust';Assert-LaunchHash ${ps(record.trust_path)} ${ps(record.trust_sha256)}\n` +
    `$step='runtime';Assert-LaunchHash ${ps(record.runtime_path)} ${ps(record.runtime_executable_sha256)}\n` +
    `$step='bootstrap';Assert-LaunchHash ${ps(join(record.prefix, 'cli/launch.mjs'))} ${ps(record.launch_sha256)}\n` +
    `$p=[Diagnostics.ProcessStartInfo]::new();$p.FileName=${ps(record.runtime_path)};$p.UseShellExecute=$false\n` +
    `$p.EnvironmentVariables.Clear();$p.EnvironmentVariables['SystemRoot']=[IO.Directory]::GetParent([Environment]::SystemDirectory).FullName\n` +
    `$a=@(${ps(join(record.prefix, 'cli/launch.mjs'))},${ps(record.manifest_sha256)},${ps(sha256(receipt))})+$args\n` +
    `$step='arguments';$p.Arguments=($a|ForEach-Object{if($_.Length -gt 8192 -or $_ -match '[\x00\r\n]'){throw 'argument'};Quote-LaunchArgument $_}) -join ' '\n` +
    `$step='start';$c=[Diagnostics.Process]::Start($p);$c.WaitForExit();exit $c.ExitCode\n` +
    `} catch {[Console]::Error.WriteLine('{"schema_version":1,"event":"cli_launch_refused","reason":"runtime_or_bootstrap_integrity","stage":"'+$step+'","exception":"'+$_.Exception.GetType().Name+'"}');exit 4}\n`);
}

async function durable(path, bytes) {
  const before = await missing(path);
  if (before) {
    refuse(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'install_conflict', 'A pending member has an invalid identity.', 4);
    const actual = await regular(path);
    refuse(actual.length <= bytes.length && bytes.subarray(0, actual.length).equals(actual),
      'install_conflict', 'The pending installation differs from the exact package.', 5);
    if (actual.equals(bytes)) return;
  }
  // The previously proven private root supplies each new entry's DACL at
  // creation. The helper reads every actual ACL before bulk publication.
  const handle = await open(path, constants.O_WRONLY | (before ? constants.O_TRUNC : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const stat = await handle.stat();
    refuse(stat.isFile() && stat.nlink === 1 && (!before || (stat.dev === before.dev && stat.ino === before.ino)),
      'install_conflict', 'A pending member changed while opening.', 4);
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); }
}

async function inspect(prefix, digest, files) {
  await files.inspect(prefix);
  const manifest = await verifyPackage(prefix, digest, extras);
  const record = JSON.parse(await regular(join(prefix, 'install-record.json'), 8192));
  closed(record, receiptKeys);
  refuse(record.schema_version === 1 && record.prefix === prefix && record.manifest_sha256 === digest &&
    record.launch_sha256 === manifest.files.find(item => item.name === 'cli/launch.mjs').sha256 &&
    /^[a-f0-9]{64}$/.test(record.trust_sha256) && /^[a-f0-9]{64}$/.test(record.runtime_executable_sha256) &&
    isAbsolute(record.runtime_path) && isAbsolute(record.trust_path) && isAbsolute(record.powershell_path),
  'install_conflict', 'The exact installation receipt is invalid.', 4);
  refuse((await regular(join(prefix, 'obsync.ps1'))).equals(launcher(record)), 'install_conflict', 'The native launcher differs.', 4);
  return { manifest, record };
}

export async function installWindows({ source, prefix, digest, trustPath, trustDigest }) {
  refuse(process.platform === 'win32' && process.version === `v${RUNTIME}` && !process.env.NODE_OPTIONS && process.execArgv.length === 0,
    'unsupported_runtime', 'Use the exact trusted Windows runtime without preloads.', 6);
  refuse(isAbsolute(prefix) && resolve(prefix) === prefix && prefix !== source &&
    !prefix.startsWith(source + '\\') && !source.startsWith(prefix + '\\'), 'install_path', 'Choose a separate immutable installation path.', 4);
  const { WindowsFiles } = require('./shared/windowsFiles.js');
  const files = await WindowsFiles.fromReceipt(trustPath, trustDigest);
  const manifest = await verifyPackage(source, digest);
  const trust = JSON.parse(await regular(trustPath, 8192));
  await files.inspect(process.execPath);
  const record = { schema_version: 1, prefix, manifest_sha256: digest, runtime_path: process.execPath,
    runtime_executable_sha256: sha256(await regular(process.execPath, 268435456)),
    launch_sha256: manifest.files.find(item => item.name === 'cli/launch.mjs').sha256,
    trust_path: trustPath, trust_sha256: trustDigest, powershell_path: trust.powershell.path };
  if (await missing(prefix)) {
    const installed = await inspect(prefix, digest, files);
    refuse(JSON.stringify(installed.record) === JSON.stringify(record), 'install_conflict', 'Existing installation has a different binding.', 5);
    return;
  }
  const pending = `${prefix}.pending`;
  if (!await missing(pending)) await files.mkdir(pending);
  await files.inspect(pending);
  const existing = await inventory(pending), allowed = [...FILES, 'package-manifest.json', ...extras];
  refuse(existing.every(name => allowed.includes(name)) && (existing.length === 0 || existing.includes('package-manifest.json')),
    'install_conflict', 'The pending directory has unknown contents.', 5);
  const raw = await regular(join(source, 'package-manifest.json'), 16384);
  if (existing.length > 1) refuse((await regular(join(pending, 'package-manifest.json'), 16384)).equals(raw),
    'install_conflict', 'Pending contents belong to a different package.', 5);
  await durable(join(pending, 'package-manifest.json'), raw);
  for (const name of directories) {
    const path = join(pending, name);
    if (!await missing(path)) await mkdir(path);
    const stat = await lstat(path);
    refuse(stat.isDirectory() && !stat.isSymbolicLink(), 'install_conflict', 'A package directory is invalid.', 4);
  }
  for (const name of FILES) await durable(join(pending, name), await regular(join(source, name)));
  await durable(join(pending, 'obsync.ps1'), launcher(record));
  await verifyPackage(pending, digest, existing.includes('install-record.json') ? extras : ['obsync.ps1']);
  // The receipt is last. No launcher can accept partial code after interruption.
  await durable(join(pending, 'install-record.json'), Buffer.from(`${JSON.stringify(record)}\n`));
  await verifyPackage(pending, digest, extras);
  await files.publish(pending, prefix);
  await inspect(prefix, digest, files);
}

export async function uninstallWindows({ source, prefix, digest, trustPath, trustDigest }) {
  const { WindowsFiles } = require('./shared/windowsFiles.js');
  const files = await WindowsFiles.fromReceipt(trustPath, trustDigest);
  const manifest = await verifyPackage(source, digest);
  const removing = `${prefix}.removing`;
  if (await missing(prefix)) {
    refuse(!await missing(removing), 'install_conflict', 'Complete the prior removal first.', 5);
    await inspect(prefix, digest, files);
    await files.publish(prefix, removing);
  }
  if (!await missing(removing)) return;
  await files.inspect(removing);
  const remaining = await inventory(removing), allowed = [...FILES, 'package-manifest.json', 'obsync.ps1', 'install-record.json'];
  refuse(remaining.every(name => allowed.includes(name)), 'install_conflict', 'Removal has unknown contents.', 5);
  if (remaining.length) {
    const record = JSON.parse(await regular(join(removing, 'install-record.json'), 8192));
    closed(record, receiptKeys);
    refuse(record.prefix === prefix && record.manifest_sha256 === digest, 'install_conflict', 'Removal receipt differs.', 5);
    for (const name of remaining) {
      const expected = name === 'install-record.json' ? null : name === 'obsync.ps1' ? sha256(launcher(record)) :
        name === 'package-manifest.json' ? digest : manifest.files.find(item => item.name === name).sha256;
      if (expected) refuse(sha256(await regular(join(removing, name))) === expected, 'install_conflict', 'Removal member differs.', 5);
    }
    for (const name of allowed.filter(name => remaining.includes(name))) await unlink(join(removing, name));
  }
  for (const name of [...directories].reverse()) if (await missing(join(removing, name))) await rmdir(join(removing, name));
  await rmdir(removing);
}
