// Build tooling only. Runtime uses no compiler, package manager or network.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, SHARED, RUNTIME, regular, sha256, verifyPackage } from './package-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let plugin = join(root, 'plugin'), releaseSource;
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] === '--plugin-root' && process.argv[i + 1]) plugin = resolve(process.argv[i + 1]);
  else if (process.argv[i] === '--release-source' && /^[a-f0-9]{40}$/.test(process.argv[i + 1])) releaseSource = process.argv[i + 1];
  else throw Error('Unknown build option.');
}
if (process.version !== `v${RUNTIME}`) throw Error('The pinned Node runtime is required.');
const git = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const head = git(['rev-parse', 'HEAD']);
if (releaseSource && head.status === 0 && head.stdout.trim() !== releaseSource) throw Error('Release source mismatch.');
const source = releaseSource ?? head.stdout.trim();
if (!/^[a-f0-9]{40}$/.test(source)) throw Error('A source commit is required.');
const candidate = !releaseSource;
if (!candidate && plugin !== join(root, 'plugin')) throw Error('Release builds use only their own shared source.');
const package_ = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
const compiler = JSON.parse(await readFile(join(plugin, 'node_modules/typescript/package.json'), 'utf8'));
if (package_.engines.node !== RUNTIME || package_.devDependencies.typescript !== compiler.version) throw Error('Compiler pin mismatch.');
const temporary = await mkdtemp(join(tmpdir(), 'obsync-cli-build-'));
const output = join(root, 'cli/dist');
try {
  const compiled = spawnSync(process.execPath, [join(plugin, 'node_modules/typescript/bin/tsc'),
    '--project', join(plugin, 'tsconfig.json'), '--outDir', temporary], { stdio: 'inherit' });
  if (compiled.status !== 0) throw Error('Shared compiler failed.');
  const { windowsHelperModule } = await import(pathToFileURL(join(plugin, 'windows-helper.mjs')).href);
  await writeFile(join(temporary, 'windowsHelperData.js'), await windowsHelperModule());
  const content = new Map();
  for (const name of FILES) {
    const bytes = name === 'cli/shared/package.json' ? Buffer.from('{"type":"commonjs"}\n') :
      await regular(name.startsWith('cli/shared/') ? join(temporary, name.slice(11)) :
        name === 'cli/windows-files.ps1' ? join(plugin, '..', name) : join(root, name));
    content.set(name, bytes);
  }
  const sources = [...content].map(([name, bytes]) => [name, sha256(bytes)]);
  for (const name of [...SHARED.filter(name => name !== 'windowsHelperData').map(name => `src/${name}.ts`), 'windows-helper.mjs', 'package-lock.json', 'tsconfig.json']) {
    sources.push([`plugin/${name}`, sha256(await regular(join(plugin, name)))]);
  }
  const manifest = { schema_version: 1, version: (await regular(join(root, 'VERSION'), 64)).toString().trim(),
    runtime: RUNTIME, source_sha: source, source_digest: sha256(JSON.stringify(sources.sort())), candidate,
    files: [...content].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) })) };
  // This is one fixed ignored build output, never a user-selected deletion target.
  await rm(output, { recursive: true, force: true });
  for (const [name, bytes] of content) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), bytes);
  }
  const raw = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(output, 'package-manifest.json'), raw);
  await verifyPackage(output, sha256(raw));
  console.log(JSON.stringify({ event: 'cli_package_built', candidate, source_sha: source, manifest_sha256: sha256(raw), files: FILES.length }));
} finally { await rm(temporary, { recursive: true, force: true }); }
