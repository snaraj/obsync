import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const source = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist/cli');
const entry = join(source, 'obsync.mjs');
const fixtures = await realpath(tmpdir());
const persistence = { skip: !['darwin', 'linux'].includes(process.platform) };

async function fixture(t) {
  const root = await mkdtemp(join(fixtures, 'obsync-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'configuration');
  const run = async (args, options = {}) => {
    const { configDir = config, ...spawnOptions } = options;
    const child = spawn(process.execPath, [entry, '--config-dir', configDir, ...args], {
      cwd: root, env: { PATH: dirname(process.execPath), HOME: root, NO_COLOR: '1' }, ...spawnOptions,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code, signal] = await new Promise(resolve => child.on('close', (...result) => resolve(result)));
    assert.equal(signal, null, stderr);
    assert.equal(stderr, '', stderr);
    assert.ok(Buffer.byteLength(stdout) <= 65536);
    const value = args.includes('human') ? null : JSON.parse(stdout);
    if (value) {
      assert.equal(value.schema_version, 1);
      assert.equal(value.verification.server_contacted, false);
      assert.equal(value.target.verified_instance, null);
      assert.ok(Number.isInteger(value.duration_ms));
      assert.equal(new Date(value.observed_at).toISOString(), value.observed_at);
      assert.equal(value.error?.exit_code ?? 0, code);
    }
    return { code, value, stdout };
  };
  const input = async value => {
    const path = join(root, `input-${Math.random().toString(16).slice(2)}.json`);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return `@${path}`;
  };
  const plan = async name => {
    const result = await run(['context', 'add', '--input', await input({ name, origin: 'https://example.invalid' })]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.value.state, 'planned');
    return result.value.data.plan;
  };
  const apply = async planned => run(['context', 'apply', '--input', await input(planned), '--expect-digest', planned.digest]);
  return { root, config, run, input, plan, apply };
}

test('cold discovery, schemas and deferred refusals are offline and leave no configuration', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'contexts.json'), 'not a config');
  for (const args of [['--help'], ['--version'], ['cli', 'search', 'context'], ['schema', 'context.add'], ['capabilities'], ['doctor'], ['agent', 'instructions']]) {
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stdout);
  }
  assert.equal((await f.run(['setup', '--non-interactive'])).code, 6);
  assert.equal((await f.run(['server', 'get'])).code, 6);
  assert.equal((await f.run(['--made-up'])).code, 2);
  assert.equal((await f.run(['schema', 'absent'])).code, 2);
  assert.deepEqual(await readdir(f.root), ['contexts.json']);
});

test('actual context input admits only the shared canonical origin grammar', async t => {
  const f = await fixture(t);
  const plan = async origin => f.run(['context', 'add', '--input', await f.input({ name: 'local', origin })]);
  for (const [input, expected] of [
    ['https://EXAMPLE.com:443/', 'https://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://127.0.0.1', 'https://127.0.0.1'], ['https://[::1]', 'https://[::1]'],
    ['https://[2001:DB8::1]:8443/', 'https://[2001:db8::1]:8443'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
  ]) {
    const result = await plan(input);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.value.data.plan.parameters.origin, expected);
  }
  for (const origin of [
    'https://example.com.', 'https://127.1', 'https://0177.0.0.1', 'https://0x7f000001',
    'https://example.com:0443', 'https://example.com:0', 'https://example.com:65536',
    'https://[0:0:0:0:0:0:0:1]', 'https://[fe80::1%25eth0]', 'https://%65xample.com',
    'https://example..com', 'https://-example.com', 'https://example-.com', 'https://under_score.com',
    `https://${'a'.repeat(64)}.com`, `https://${Array(4).fill('a'.repeat(63)).join('.')}`,
    'https://bücher.example', 'https://user:password@example.com', 'https://example.com?x=1',
    'https://example.com#fragment', 'https://example.com/path', 'https://example.com//',
    'https://example.com\\path', 'https://example.com\n', ' https://example.com', 'HTTPS://example.com',
  ]) {
    const result = await plan(origin);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(result.value.error.code, 'invalid_origin');
  }
  await assert.rejects(lstat(f.config), { code: 'ENOENT' });
});

test('actual CLI processes plan, commit, replay, select and remove one association', persistence, async t => {
  const f = await fixture(t);
  const planned = await f.plan('personal');
  await assert.rejects(lstat(f.config), { code: 'ENOENT' });
  const first = await f.apply(planned);
  assert.equal(first.code, 0, first.stdout);
  assert.equal(first.value.data.revision, 1);
  assert.equal(first.value.data.replayed, false);
  const again = await f.apply(planned);
  assert.equal(again.code, 0, again.stdout);
  assert.equal(again.value.data.replayed, true);
  assert.equal(again.value.data.revision, 1);
  assert.equal((await lstat(f.config)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.config, 'contexts.db'))).mode & 0o777, 0o600);
  const selected = await f.run(['context', 'use', 'personal']);
  assert.equal((await f.apply(selected.value.data.plan)).code, 0);
  const get = await f.run(['context', 'get']);
  assert.equal(get.value.target.context, 'personal');
  assert.equal(get.value.data.context.origin, 'https://example.invalid');
  const prior = await readFile(join(f.config, 'contexts.db'));
  assert.equal((await f.run(['doctor'])).value.data.repairs, 'none');
  assert.deepEqual(await readFile(join(f.config, 'contexts.db')), prior);
  const removed = await f.run(['context', 'remove', 'personal']);
  assert.equal((await f.apply(removed.value.data.plan)).code, 0);
  assert.deepEqual((await f.run(['context', 'list'])).value.data.items, []);
  assert.deepEqual(await readdir(f.config), ['contexts.db']);
});

test('changed, stale, expired and cross-target plans refuse without changing configuration', persistence, async t => {
  const f = await fixture(t);
  const first = await f.plan('first');
  const stale = await f.plan('second');
  assert.equal((await f.apply(first)).code, 0);
  const prior = await readFile(join(f.config, 'contexts.db'));
  assert.equal((await f.apply(stale)).value.error.code, 'revision_conflict');
  const changed = { ...first, parameters: { ...first.parameters, origin: 'https://other.invalid' } };
  assert.equal((await f.apply(changed)).value.error.code, 'digest_mismatch');
  const expired = { ...first, created_at: Date.now() - 300001, expires_at: Date.now() - 1 };
  delete expired.digest;
  expired.expires_at = expired.created_at + 300000;
  expired.digest = createHash('sha256').update(JSON.stringify(expired)).digest('hex');
  assert.equal((await f.apply(expired)).value.error.code, 'plan_expired');
  const cross = await f.run(['context', 'apply', '--input', await f.input(first), '--expect-digest', first.digest], { configDir: join(f.root, 'other') });
  assert.equal(cross.code, 2);
  assert.equal(cross.value.error.code, 'invalid_plan');
  await assert.rejects(lstat(join(f.root, 'other')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.config, 'contexts.db')), prior);
  assert.deepEqual(await readdir(f.config), ['contexts.db']);
});

test('closed inputs and protected paths refuse with inert errors', persistence, async t => {
  const f = await fixture(t);
  const secretSentinel = 'DO_NOT_PRINT_SENTINEL';
  const unknown = await f.run(['context', 'add', '--input', await f.input({ name: 'local', origin: 'https://example.invalid', token: secretSentinel })]);
  assert.equal(unknown.code, 2);
  assert.ok(!unknown.stdout.includes(secretSentinel));
  for (const origin of ['http://example.invalid', 'https://example.invalid/path', 'https://user:password@example.invalid', 'https://example.invalid?query=1']) {
    assert.equal((await f.run(['context', 'add', '--input', await f.input({ name: 'local', origin })])).code, 2);
  }
  await mkdir(join(f.root, 'unrelated'), { mode: 0o700 });
  await writeFile(join(f.root, 'unrelated', 'keep'), 'sentinel');
  await symlink(join(f.root, 'unrelated'), f.config);
  assert.equal((await f.run(['doctor'])).value.error.code, 'unsafe_config');
  assert.equal(await readFile(join(f.root, 'unrelated', 'keep'), 'utf8'), 'sentinel');
  assert.deepEqual(await readdir(join(f.root, 'unrelated')), ['keep']);
  await rm(f.config);
  await mkdir(f.config, { mode: 0o700 });
  await chmod(f.config, 0o755);
  assert.equal((await f.run(['context', 'list'])).value.error.code, 'unsafe_config');
});

test('pagination is bounded and rejects a stale cursor; JSONL and human output remain usable', persistence, async t => {
  const f = await fixture(t);
  const page = await f.run(['cli', 'search', 'context', '--limit', '2']);
  assert.equal(page.value.data.items.length, 2);
  assert.equal(page.value.pagination.truncated, true);
  const next = await f.run(['cli', 'search', 'context', '--limit', '2', '--cursor', page.value.pagination.next_cursor]);
  assert.equal(next.value.data.items.length, 2);
  assert.notEqual(next.value.data.items[0].operation, page.value.data.items[0].operation);
  assert.equal((await f.run(['cli', 'search', 'doctor', '--cursor', page.value.pagination.next_cursor])).code, 5);
  assert.equal((await f.run(['capabilities', '--output', 'jsonl'])).stdout.split('\n').filter(Boolean).length, 1);
  assert.match((await f.run(['version', '--output', 'human'])).stdout, /^cli.version: completed\n/);
});

test('a killed CLI store process before commit recovers without an orphan lock or partial state', persistence, async t => {
  const f = await fixture(t);
  assert.equal((await f.apply(await f.plan('first'))).code, 0);
  const liveModule = pathToFileURL(join(source, 'contexts.mjs')).href;
  const seed = spawn(process.execPath, ['--input-type=module', '-e', `import { Contexts } from ${JSON.stringify(liveModule)}; const store = new Contexts(${JSON.stringify(f.config)}); for (let i=0;i<20;i++) { const plan = await store.plan('context.add', {name:'fixture'+i,origin:'https://example.invalid'}); await store.apply(plan,plan.digest); }`], { stdio: 'pipe' });
  assert.equal(await new Promise(resolve => seed.on('close', resolve)), 0);
  const next = await f.plan('second');
  const committed = await readFile(join(f.config, 'contexts.db'));
  const copy = join(f.root, 'fault');
  await mkdir(copy, { mode: 0o700 });
  await copyFile(join(source, 'errors.mjs'), join(copy, 'errors.mjs'));
  const original = await readFile(join(source, 'contexts.mjs'), 'utf8');
  const needle = "      committing = true;\n      database.exec('COMMIT');";
  assert.equal(original.split(needle).length, 2);
  await writeFile(join(copy, 'contexts.mjs'), original
    .replace("from './private-path.mjs'", `from ${JSON.stringify(pathToFileURL(join(source, 'private-path.mjs')).href)}`)
    .replace("database.exec('BEGIN IMMEDIATE');", "database.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE');")
    .replace(needle, "      process.kill(process.pid, 'SIGKILL');\n" + needle));
  const module = pathToFileURL(join(copy, 'contexts.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { Contexts } from ${JSON.stringify(module)}; await new Contexts(${JSON.stringify(f.config)}).apply(${JSON.stringify(next)}, ${JSON.stringify(next.digest)});`], { stdio: 'pipe' });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL');
  assert.notDeepEqual(await readFile(join(f.config, 'contexts.db')), committed,
    'The fault must spill uncommitted pages, otherwise it does not exercise rollback recovery.');
  const interrupted = await readFile(join(f.config, 'contexts.db'));
  const journal = await readFile(join(f.config, 'contexts.db-journal'));
  const diagnosed = await f.run(['doctor']);
  assert.equal(diagnosed.code, 10, 'Read-only doctor must name the explicit recovery action.');
  assert.equal(diagnosed.value.error.code, 'recovery_required');
  assert.deepEqual(await readFile(join(f.config, 'contexts.db')), interrupted);
  assert.deepEqual(await readFile(join(f.config, 'contexts.db-journal')), journal);
  const restored = await f.run(['context', 'recover']);
  assert.equal(restored.code, 0, restored.stdout);
  assert.equal(restored.value.data.revision, 21);
  assert.deepEqual(await readFile(join(f.config, 'contexts.db')), committed);
  const recovered = await f.apply(next);
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(recovered.value.data.revision, 22);
  assert.equal(recovered.value.data.replayed, false);
  const names = (await f.run(['context', 'list'])).value.data.items.map(item => item.name);
  assert.equal(names.length, 22);
  assert.ok(names.includes('first') && names.includes('second'));
  assert.deepEqual(await readdir(f.config), ['contexts.db']);
});

test('concurrent actual processes commit one effect and reject a stale competing plan', persistence, async t => {
  const f = await fixture(t);
  const one = await f.plan('one');
  const copies = await Promise.all([f.apply(one), f.apply(one)]);
  assert.deepEqual(copies.map(result => result.code), [0, 0], JSON.stringify(copies));
  assert.deepEqual(copies.map(result => result.value.data.replayed).sort(), [false, true]);
  const two = await f.plan('two');
  const three = await f.plan('three');
  const rivals = await Promise.all([f.apply(two), f.apply(three)]);
  assert.deepEqual(rivals.map(result => result.code).sort(), [0, 5], JSON.stringify(rivals));
  assert.equal(rivals.find(result => result.code === 5).value.error.code, 'revision_conflict');
  assert.equal((await f.run(['context', 'list'])).value.data.items.length, 2);
});

test('a killed process after commit is reconciled by a fresh CLI without applying again', persistence, async t => {
  const f = await fixture(t);
  const planned = await f.plan('personal');
  const module = pathToFileURL(join(source, 'contexts.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { Contexts } from ${JSON.stringify(module)}; await new Contexts(${JSON.stringify(f.config)}).apply(${JSON.stringify(planned)}, ${JSON.stringify(planned.digest)}); process.kill(process.pid, 'SIGKILL');`], { stdio: 'pipe' });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL');
  const recovered = await f.apply(planned);
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(recovered.value.data.replayed, true);
  assert.equal(recovered.value.data.revision, 1);
  assert.equal((await f.run(['context', 'list'])).value.data.items.length, 1);
});


test('first-use context refuses an unflushed parent entry and preserves committed state', persistence, async t => {
  const f = await fixture(t), planned = await f.plan('first');
  const input = await f.input(planned), driver = join(f.root, 'parent-sync-fault.mjs');
  await writeFile(driver, `
    import { open } from 'node:fs/promises';
    import { constants } from 'node:fs';
    const parent = await open(${JSON.stringify(f.root)}, constants.O_RDONLY | constants.O_DIRECTORY);
    const identity = await parent.stat(), prototype = Object.getPrototypeOf(parent), sync = prototype.sync;
    prototype.sync = async function () {
      const stat = await this.stat();
      if (stat.dev === identity.dev && stat.ino === identity.ino) throw Error('synthetic parent sync failure');
      return sync.call(this);
    };
    await parent.close();
    const { main } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    process.argv = [process.execPath, ${JSON.stringify(entry)}, '--config-dir', ${JSON.stringify(f.config)},
      'context', 'apply', '--input', ${JSON.stringify(input)}, '--expect-digest', ${JSON.stringify(planned.digest)}];
    await main();
  `, { mode: 0o600 });
  const result = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 9, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'local_io_failed');
  // A failed first sync may leave the leaf present: retry must still flush its parent.
  const retry = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 15000 });
  assert.equal(retry.status, 9, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).error.code, 'local_io_failed');
  await assert.rejects(lstat(join(f.config, 'contexts.db')), { code: 'ENOENT' });
  const before = await f.run(['context', 'list']);
  assert.equal(before.code, 0, before.stdout);
  assert.deepEqual(before.value.data.items, []);
  assert.equal((await f.apply(planned)).code, 0);
  assert.equal((await f.run(['context', 'get', 'first'])).value.data.context.name, 'first');
});

test('macOS ACL grants and unreadable ACL metadata refuse before local effects', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const parent = join(f.root, 'selected'), config = join(parent, 'configuration');
  await mkdir(parent, { mode: 0o700 });
  const sentinel = join(parent, 'sentinel');
  await writeFile(sentinel, 'retain', { mode: 0o600 });
  const changeAcl = (...args) => {
    const result = spawnSync('/bin/chmod', [...args, parent], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    for (const acl of ['everyone allow read', 'everyone deny readsecurity']) {
      changeAcl('-N'); changeAcl('+a#', '0', acl);
      const result = await f.run(['context', 'add', '--input', await f.input({ name: 'first', origin: 'https://example.invalid' })], { configDir: config });
      assert.equal(result.code, 4, result.stdout);
      assert.equal(result.value.error.code, 'unsafe_config');
      assert.equal(await readFile(sentinel, 'utf8'), 'retain');
      await assert.rejects(lstat(config), { code: 'ENOENT' });
    }
  } finally { changeAcl('-N'); }
  assert.equal((await f.run(['doctor'], { configDir: config })).code, 0);
});
