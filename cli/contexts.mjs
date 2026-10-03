import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliError, closed, refuse } from './errors.mjs';
import { macosDirectory } from './private-path.mjs';

const POSIX = ['darwin', 'linux'].includes(process.platform);
const MAX_STATE = 131072;
const MAX_CONTEXTS = 64;
const MAX_RECEIPTS = 64;
const PLAN_MS = 300000;
const TABLE = 'CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL) STRICT';
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const HEX = /^[a-f0-9]{64}$/;
const PLAN_KEYS = ['schema_version', 'id', 'operation', 'parameters', 'revision',
  'config_digest', 'config_target', 'created_at', 'expires_at', 'digest'];
const bytes = value => Buffer.from(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ schema_version: 1, revision: 0, current: null, contexts: [], receipts: [] });

export function contextName(value) {
  refuse(typeof value === 'string' && NAME.test(value), 'invalid_name',
    'Context names use 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter.');
  return value;
}

export function contextInput(value, normalize = false) {
  closed(value, ['name', 'origin', 'expected_instance'], ['name', 'origin']);
  contextName(value.name);
  refuse(typeof value.origin === 'string' && value.origin.length <= 512,
    'invalid_origin', 'Expected a canonical HTTPS origin.');
  const parts = /^https:\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([1-9][0-9]{0,4}))?\/?$/.exec(value.origin);
  refuse(parts && parts[0] === value.origin && (!parts[2] || Number(parts[2]) <= 65535),
    'invalid_origin', 'Use an HTTPS origin with an ASCII host and canonical port; credentials, paths and parser repairs refuse.');
  const host = parts[1].toLowerCase();
  refuse(host.startsWith('[') || (host.length <= 253 && host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))),
  'invalid_origin', 'DNS hosts require nonempty ASCII labels with only internal hyphens and no trailing dot.');
  const origin = `https://${host}${parts[2] && parts[2] !== '443' ? `:${parts[2]}` : ''}`;
  let url;
  try { url = new URL(origin); } catch { throw new CliError('invalid_origin', 'Expected a canonical HTTPS origin.'); }
  // Only input host case, :443 and one final slash may normalize. Stored and
  // signed fields must already match; URL repairs of numeric hosts never pass.
  refuse(url.origin === origin && (normalize === true || value.origin === origin),
    'invalid_origin', 'The origin or numeric IP spelling is not canonical.');
  const expected = value.expected_instance ?? null;
  refuse(expected === null || (typeof expected === 'string' && HEX.test(expected)),
    'invalid_instance', 'The expected instance must be a 64-character lowercase hex fingerprint or null.');
  return { name: value.name, origin, expected_instance: expected };
}

function validateState(value) {
  closed(value, ['schema_version', 'revision', 'current', 'contexts', 'receipts']);
  refuse(value.schema_version === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Array.isArray(value.contexts) && value.contexts.length <= MAX_CONTEXTS &&
    Array.isArray(value.receipts) && value.receipts.length <= MAX_RECEIPTS,
  'invalid_config', 'The configuration version, revision or collection bounds are invalid.');
  value.contexts = value.contexts.map(entry => contextInput(entry));
  refuse(new Set(value.contexts.map(c => c.name)).size === value.contexts.length &&
    (value.current === null || value.contexts.some(c => c.name === value.current)),
  'invalid_config', 'Context names must be unique and the selected context must exist.');
  for (const receipt of value.receipts) {
    closed(receipt, ['id', 'digest', 'expires_at', 'revision', 'operation', 'name', 'current']);
    refuse(/^[a-f0-9]{32}$/.test(receipt.id) && HEX.test(receipt.digest) &&
      Number.isSafeInteger(receipt.expires_at) && Number.isSafeInteger(receipt.revision) &&
      receipt.revision > 0 && receipt.revision <= value.revision &&
      ['context.add', 'context.use', 'context.remove'].includes(receipt.operation) &&
      typeof receipt.name === 'string' && NAME.test(receipt.name) &&
      (receipt.current === null || (typeof receipt.current === 'string' && NAME.test(receipt.current))),
    'invalid_config', 'An operation receipt is invalid.');
  }
  refuse(new Set(value.receipts.map(r => r.id)).size === value.receipts.length,
    'invalid_config', 'Operation receipt IDs must be unique.');
  return value;
}

function privateEntry(stat, directory = false) {
  refuse(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()),
    'unsafe_config', 'Configuration entries must be real directories or regular files, without links.', 4);
  refuse(directory || stat.nlink === 1, 'unsafe_config', 'Configuration files must have exactly one link.', 4);
  if (POSIX) refuse(stat.uid === process.getuid() && (stat.mode & 0o777) === (directory ? 0o700 : 0o600) &&
    (directory || stat.nlink === 1), 'unsafe_config',
  'Configuration requires an owned 0700 directory and owned 0600 files without hard links.', 4);
}

async function statOrMissing(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (['EACCES', 'EPERM'].includes(error.code)) throw new CliError('unsafe_config',
      'Configuration metadata cannot be inspected with the required custody.', 4);
    throw error;
  }
}

export class Contexts {
  constructor(directory, windows = null) {
    refuse(typeof directory === 'string' && isAbsolute(directory) && directory.length <= 4096,
      'invalid_config_path', 'The configuration directory must be an explicit absolute path.');
    this.directory = resolve(directory);
    this.windows = windows;
    refuse(this.directory !== parse(this.directory).root, 'invalid_config_path',
      'The filesystem root cannot be the configuration directory.');
    this.file = join(this.directory, 'contexts.db');
    this.target = hash(this.directory);
    this.deadline = performance.now() + 5000;
  }

  async directoryReady(create = false) {
    if (create) refuse(POSIX || (process.platform === 'win32' && this.windows), 'unsupported_platform',
      'Persistent context writes require a validated native ownership and durability path.', 6);
    const root = parse(this.directory).root;
    let current = root;
    await macosDirectory(root);
    for (const part of this.directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      let stat = await statOrMissing(current);
      if (!stat && !create) return false;
      if (!stat) {
        refuse(current === this.directory, 'config_parent_missing',
          'The selected configuration parent must already exist.', 4);
        try {
          if (this.windows) await this.windows.mkdir(current);
          else await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        stat = await lstat(current);
      }
      refuse(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_config',
        'A configuration parent is not a real directory; links are refused.', 4);
      await macosDirectory(current);
      if (current === this.directory) {
        privateEntry(stat, true);
        if (this.windows) await this.windows.inspect(current);
      }
      else if (POSIX) {
        const writable = stat.mode & 0o022;
        const rootSticky = stat.uid === 0 && (stat.mode & 0o1000);
        refuse((stat.uid === 0 || stat.uid === process.getuid()) && (!writable || rootSticky),
          'unsafe_config', 'A configuration parent can be replaced by another user.', 4);
      }
    }
    if (create && POSIX) {
      // Retry this sync even when an interrupted first use left the leaf present.
      const parent = await open(dirname(this.directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return true;
  }

  async database(write = false) {
    if (!await this.directoryReady(write)) return null;
    let before = await statOrMissing(this.file);
    if (!before && !write) return null;
    if (!before) {
      try {
        const created = await open(this.file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await created.sync(); } finally { await created.close(); }
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      before = await lstat(this.file);
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const entry = await statOrMissing(this.file + suffix);
      if (entry) {
        privateEntry(entry);
        refuse(entry.size <= 524288, 'invalid_config', 'Configuration storage exceeds its byte budget.');
        if (this.windows) await this.windows.inspect(this.file + suffix);
      }
    }
    const database = new DatabaseSync(this.file, { readOnly: !write, timeout: 1000,
      allowExtension: false, defensive: true,
      limits: { length: MAX_STATE + 1024, sqlLength: 1024, column: 8, attach: 0, triggerDepth: 0 } });
    try {
      const actual = await lstat(this.file);
      privateEntry(actual);
      refuse(actual.ino === before.ino && actual.dev === before.dev,
        'unsafe_config', 'Configuration changed during open.', 4);
      database.exec('PRAGMA trusted_schema=OFF');
      refuse(database.prepare('PRAGMA journal_mode').get().journal_mode === 'delete',
        'invalid_config', 'Only the expected rollback-journal format is supported.');
      if (write) database.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA max_page_count=128');
      return database;
    } catch (error) { database.close(); throw error; }
  }

  readDatabase(database) {
    const tables = database.prepare('SELECT type, name, sql FROM sqlite_schema').all();
    if (tables.length === 0) return empty();
    refuse(tables.length === 1 && tables[0].type === 'table' && tables[0].name === 'state' && tables[0].sql === TABLE,
      'invalid_config', 'The configuration database schema is not recognized.');
    const rows = database.prepare('SELECT id, json FROM state LIMIT 2').all();
    refuse(rows.length === 1 && rows[0].id === 1 && typeof rows[0].json === 'string' && Buffer.byteLength(rows[0].json) <= MAX_STATE,
      'invalid_config', 'The configuration database must contain one bounded state record.');
    try { return validateState(JSON.parse(rows[0].json)); } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('invalid_config', 'Configuration is not valid bounded JSON.');
    }
  }

  async read() {
    let database;
    try {
      database = await this.database();
      return database ? this.readDatabase(database) : empty();
    } catch (error) {
      if (error.errcode === 776) throw new CliError('recovery_required',
        'Read-only access cannot recover the interrupted local transaction.', 10,
        'Run context recover against this exact configuration directory, then read its committed state.');
      throw error;
    } finally { database?.close(); }
  }

  async plan(operation, parameters) {
    parameters = operation === 'context.add' ? contextInput(parameters, true) : { name: contextName(parameters.name) };
    const state = await this.read();
    this.next(state, operation, parameters);
    const plan = { schema_version: 1, id: randomBytes(16).toString('hex'), operation,
      parameters, revision: state.revision, config_digest: hash(bytes(state)),
      config_target: this.target, created_at: Date.now(), expires_at: 0 };
    plan.expires_at = plan.created_at + PLAN_MS;
    return { ...plan, digest: hash(bytes(plan)) };
  }

  next(state, operation, parameters) {
    const result = structuredClone(state);
    const index = result.contexts.findIndex(c => c.name === parameters.name);
    if (operation === 'context.add') {
      refuse(index === -1, 'context_exists', 'That context exists; a context cannot be silently retargeted.', 5);
      refuse(result.contexts.length < MAX_CONTEXTS, 'context_capacity', 'The local context capacity is 64.', 9);
      result.contexts.push(parameters);
      result.contexts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } else {
      refuse(index !== -1, 'context_missing', 'The named context does not exist.', 6);
      if (operation === 'context.use') result.current = parameters.name;
      else {
        result.contexts.splice(index, 1);
        if (result.current === parameters.name) result.current = null;
      }
    }
    return result;
  }

  async apply(plan, expectedDigest) {
    closed(plan, PLAN_KEYS);
    refuse(plan.schema_version === 1 && /^[a-f0-9]{32}$/.test(plan.id) &&
      ['context.add', 'context.use', 'context.remove'].includes(plan.operation) &&
      Number.isSafeInteger(plan.revision) && plan.revision >= 0 && HEX.test(plan.config_digest) &&
      plan.config_target === this.target && HEX.test(plan.digest), 'invalid_plan',
    'The plan version, identity, revision or exact configuration target is invalid.');
    const parameters = plan.operation === 'context.add' ? contextInput(plan.parameters) :
      (closed(plan.parameters, ['name']), { name: contextName(plan.parameters.name) });
    const unsigned = { schema_version: 1, id: plan.id, operation: plan.operation,
      parameters, revision: plan.revision, config_digest: plan.config_digest,
      config_target: plan.config_target, created_at: plan.created_at, expires_at: plan.expires_at };
    refuse(plan.digest === expectedDigest && hash(bytes(unsigned)) === plan.digest,
      'digest_mismatch', 'The expected digest does not match this exact plan.', 5);
    refuse(Number.isSafeInteger(plan.created_at) && Number.isSafeInteger(plan.expires_at) &&
      plan.created_at <= Date.now() && plan.expires_at === plan.created_at + PLAN_MS && Date.now() < plan.expires_at,
    'plan_expired', 'The plan is expired or has an invalid absolute lifetime; create a fresh plan.', 5);
    const database = await this.database(true);
    let committing = false;
    try {
      database.exec('BEGIN IMMEDIATE');
      const state = this.readDatabase(database);
      const receipt = state.receipts.find(r => r.id === plan.id);
      if (receipt) {
        refuse(receipt.digest === plan.digest, 'digest_mismatch', 'The operation ID already binds a different plan.', 5);
        database.exec('COMMIT');
        await this.syncDirectory(database);
        return { ...receipt, replayed: true };
      }
      refuse(state.revision === plan.revision && hash(bytes(state)) === plan.config_digest,
        'revision_conflict', 'Configuration changed after this plan; read it and create a new plan.', 5);
      const next = this.next(state, plan.operation, parameters);
      next.receipts = next.receipts.filter(r => r.expires_at > Date.now());
      refuse(next.receipts.length < MAX_RECEIPTS, 'operation_capacity', 'Unexpired context receipts fill the bounded capacity; retry after they expire.', 9);
      refuse(next.revision < Number.MAX_SAFE_INTEGER, 'revision_conflict', 'The configuration revision cannot advance.', 5);
      next.revision++;
      const result = { id: plan.id, digest: plan.digest, expires_at: plan.expires_at,
        revision: next.revision, operation: plan.operation, name: parameters.name, current: next.current };
      next.receipts.push(result);
      const data = bytes(next);
      refuse(data.length <= MAX_STATE, 'operation_capacity', 'Configuration exceeds its byte budget.', 9);
      database.exec(TABLE.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
      database.prepare('INSERT OR REPLACE INTO state (id, json) VALUES (1, ?)').run(data.toString('utf8'));
      refuse(Date.now() < plan.expires_at, 'plan_expired', 'The plan expired before publication; create a fresh plan.', 5);
      refuse(performance.now() < this.deadline, 'deadline_exceeded', 'The local operation deadline elapsed before commit; the transaction was not applied.', 7);
      committing = true;
      database.exec('COMMIT');
      await this.syncDirectory(database);
      return { ...result, replayed: false };
    } catch (error) {
      if (database.isOpen && database.isTransaction) database.exec('ROLLBACK');
      if (committing) throw new CliError('write_unknown', 'Configuration commit was attempted but durable completion could not be confirmed.', 7,
        'Retry this same unexpired plan to read its receipt; do not create another mutation.');
      if (error.errcode === 5) throw new CliError('config_busy', 'Another configuration transaction is active; retry this same plan.', 5);
      throw error;
    } finally { if (database.isOpen) database.close(); }
  }

  async syncDirectory(database) {
    if (this.windows) {
      // SQLite's Windows VFS owns transaction locking, journal recovery and
      // synchronous=FULL durability. This checks custody and flushes the exact
      // database; it is not a substitute Windows directory-fsync primitive.
      // Release SQLite's handle after commit before the helper opens this
      // exact file with FileShare.None. An open reader/writer must still refuse.
      database.close();
      await this.windows.flush(this.file);
      return;
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async inspect() {
    const state = await this.read();
    return { state, exists: await statOrMissing(this.file) !== null };
  }

  async recover() {
    refuse(await statOrMissing(this.file), 'context_missing', 'There is no local configuration to recover.', 6);
    const database = await this.database(true);
    try {
      database.exec('BEGIN IMMEDIATE');
      const state = this.readDatabase(database);
      database.exec('COMMIT');
      await this.syncDirectory(database);
      return { revision: state.revision, contexts: state.contexts.length, current: state.current };
    } finally { if (database.isOpen) database.close(); }
  }
}
