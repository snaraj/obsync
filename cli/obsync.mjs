#!/usr/bin/env node
// Source entry point. The release launcher/provenance gate is separate.
import { readFile, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { CATALOG, UNSUPPORTED, available, summary } from './catalog.mjs';
import { Contexts, contextName } from './contexts.mjs';
import { CliError, closed, refuse, readBounded } from './errors.mjs';

const started = performance.now();
const TARGET = { context: null, origin: null, expected_instance: null, verified_instance: null };
let operation = null;
let format = 'json';
let tty = Boolean(process.stdout.isTTY);
let target = { ...TARGET };
let deadlineMs = 5000;
const takeTarget = context => { target = context ? { ...TARGET, context: context.name,
  origin: context.origin, expected_instance: context.expected_instance } : { ...TARGET }; };
const version = (await readFile(new URL('../VERSION', import.meta.url), 'utf8')).trim();
const options = Object.create(null);
const arguments_ = [];

function parseArguments() {
  const flags = new Set(['help', 'version', 'non-interactive', 'plaintext', 'allow-server-origin']);
  const values = new Set(['output', 'config-dir', 'context', 'input', 'expect-digest', 'limit', 'cursor',
    'archive', 'destination', 'vault-root', 'phrase-fd']);
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    refuse(Buffer.byteLength(argument) <= 8192, 'invalid_input', 'An argument exceeds its byte budget.');
    if (!argument.startsWith('--')) {
      refuse(!argument.startsWith('-'), 'invalid_input', 'Unknown option; inspect help.');
      arguments_.push(argument);
      continue;
    }
    const key = argument.slice(2);
    refuse(!Object.hasOwn(options, key), 'invalid_input', 'Options may appear only once.');
    refuse(flags.has(key) || values.has(key), 'invalid_input', 'Unknown option; inspect help.');
    if (flags.has(key)) options[key] = true;
    else {
      refuse(index + 1 < process.argv.length && !process.argv[index + 1].startsWith('--'),
        'invalid_input', 'The option needs a value.');
      options[key] = process.argv[++index];
    }
  }
  if (Object.hasOwn(options, 'output')) {
    refuse(['json', 'jsonl', 'human'].includes(options.output), 'invalid_input', 'Output must be json, jsonl or human.');
    format = options.output;
  }
  if (options['non-interactive']) tty = false;
  refuse(arguments_.length <= 8, 'invalid_input', 'Too many command arguments.');
}

function optionsFor(allowed = []) {
  const common = ['output', 'non-interactive', 'config-dir'];
  refuse(Object.keys(options).every(key => [...common, ...allowed].includes(key)),
    'invalid_input', 'An option does not apply to this operation; inspect its schema.');
}

function exact(count) {
  refuse(arguments_.length === count, 'invalid_input', 'Unexpected or missing command arguments; inspect the operation schema.');
}

async function input() {
  refuse(typeof options.input === 'string' && options.input.startsWith('@') && isAbsolute(options.input.slice(1)),
    'invalid_input', 'Input must name one explicit absolute JSON file, using --input @/absolute/file.json.');
  const file = options.input.slice(1);
  const before = await lstat(file);
  refuse(before.isFile() && !before.isSymbolicLink() && before.size <= 16384,
    'invalid_input', 'Input must be a regular non-link file of at most 16384 bytes.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    refuse(actual.isFile() && actual.ino === before.ino && actual.dev === before.dev && actual.size <= 16384,
      'invalid_input', 'Input changed during open or exceeds its byte budget.');
    const raw = await readBounded(handle, 16384);
    try { return JSON.parse(raw); } catch { throw new CliError('invalid_input', 'Input is not valid JSON.'); }
  } finally { await handle.close(); }
}

function paginate(items, revision) {
  let limit = 50;
  if (options.limit !== undefined) {
    refuse(/^[1-9][0-9]{0,2}$/.test(options.limit), 'invalid_input', 'Limit must be an integer from 1 to 500.');
    limit = Number(options.limit);
    refuse(limit <= 500, 'invalid_input', 'Limit must be an integer from 1 to 500.');
  }
  let offset = 0;
  if (options.cursor !== undefined) {
    refuse(/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor), 'invalid_cursor', 'The cursor is invalid.');
    let cursor;
    try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); }
    catch { throw new CliError('invalid_cursor', 'The cursor is invalid.'); }
    closed(cursor, ['offset', 'revision']);
    refuse(cursor.revision === revision && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= items.length,
      'invalid_cursor', 'The cursor belongs to another result or an earlier revision.', 5);
    offset = cursor.offset;
  }
  const page = items.slice(offset, offset + limit);
  const more = offset + page.length < items.length;
  return { data: { items: page }, pagination: { limit, returned: page.length, truncated: more,
    next_cursor: more ? Buffer.from(JSON.stringify({ offset: offset + page.length, revision })).toString('base64url') : null } };
}

const instructions = [
  'Run help, cli search QUERY, schema OPERATION and capabilities before an unfamiliar operation.',
  'This slice works offline. A configured origin or expected fingerprint is not a verified server identity.',
  'Use explicit named contexts. Context add/use/remove return plans and do not write configuration.',
  'Save the returned data.plan to an explicit file, then context apply --input @ABSOLUTE_PLAN --expect-digest DIGEST.',
  'Plans bind the local configuration directory, current revision, full configuration digest and five-minute lifetime.',
  'If an apply response is lost, retry that same unexpired plan; its durable receipt prevents a second effect.',
  'After an interrupted transaction, context recover restores only the last committed local state; doctor never repairs it.',
  'Do not put credentials, setup tokens, recovery words, vault keys or plugin state in context files or arguments.',
  'Unsupported operations return exit 6. No flag grants server authority, starts a browser or supplies consent.',
];

async function run() {
  parseArguments();
  refuse(process.version === 'v26.10.0', 'unsupported_runtime', 'This candidate requires Node 26.10.0.', 6);
  refuse(!process.env.NODE_OPTIONS && process.execArgv.length === 0, 'unsupported_runtime',
    'Runtime preload/options are unsupported; use the trusted launcher with a clean runtime environment.', 6);
  if (options.version) { optionsFor(['version']); exact(0); operation = 'cli.version'; }
  else if (options.help || arguments_.length === 0) {
    optionsFor(['help']); operation = 'cli.help';
  }
  else if (arguments_[0] === 'cli' && arguments_[1] === 'search') operation = 'cli.search';
  else if (arguments_[0] === 'context') operation = `context.${arguments_[1] ?? ''}`;
  else if (arguments_[0] === 'export' && arguments_[1] === 'open') operation = 'export.open';
  else if (arguments_[0] === 'agent' && arguments_[1] === 'instructions') operation = 'agent.instructions';
  else operation = arguments_[0] === 'help' ? 'cli.help' : arguments_[0] === 'version' ? 'cli.version' : arguments_[0];
  const entry = CATALOG.find(item => item.operation === operation);
  if (!entry) {
    if (Object.hasOwn(UNSUPPORTED, arguments_[0])) throw new CliError('unsupported_capability', UNSUPPORTED[arguments_[0]], 6,
      'Use capabilities to inspect this installed slice.');
    throw new CliError('unknown_operation', 'Unknown operation; use cli search or help.');
  }
  refuse(available(entry), 'unsupported_platform', 'This operation requires native private-file and durability support unavailable on this platform; inspect capabilities.', 6);
  const store = new Contexts(options['config-dir'] ?? join(homedir(), '.obsync'));
  const catalogRevision = createHash('sha256').update(JSON.stringify(CATALOG)).digest('hex');
  switch (operation) {
    case 'cli.help':
      optionsFor(['help']);
      refuse(arguments_.length <= 1, 'invalid_input', 'Use schema OPERATION for operation help.');
      return { data: { version, commands: CATALOG.map(summary), global_options: {
        '--output': 'json (default), jsonl or human', '--non-interactive': 'Never prompt or open a browser.',
        '--config-dir': 'Exact absolute directory; default ~/.obsync. No current-directory configuration is loaded.',
      }, unsupported_families: Object.keys(UNSUPPORTED) } };
    case 'cli.version': optionsFor(['version']); if (!options.version) exact(1);
      return { data: { version, schema_version: 1, runtime: process.version } };
    case 'cli.search': {
      optionsFor(['limit', 'cursor']); exact(3);
      refuse(arguments_[2].length <= 256, 'invalid_input', 'Search is bounded to 256 characters.');
      const terms = arguments_[2].toLowerCase().split(/\s+/).filter(Boolean);
      const found = CATALOG.filter(item => terms.every(term => `${item.operation} ${item.summary}`.toLowerCase().includes(term))).map(summary);
      return paginate(found, `${catalogRevision}:${arguments_[2]}`);
    }
    case 'schema': {
      optionsFor(); exact(2);
      const schema = CATALOG.find(item => item.operation === arguments_[1]);
      refuse(schema, 'unknown_operation', 'No schema exists for this operation.');
      return { data: { ...schema, platform_available: available(schema) } };
    }
    case 'capabilities': optionsFor(); exact(1);
      return { data: { source: 'local_catalog', server_intersection: 'not_run',
        implemented: CATALOG.filter(available).map(item => item.operation),
        unsupported: { ...UNSUPPORTED, ...Object.fromEntries(CATALOG.filter(entry => !available(entry)).map(entry =>
          [entry.operation, 'Native ownership and durability support is unavailable.'])) } } };
    case 'context.list': {
      optionsFor(['limit', 'cursor']); exact(2);
      const state = await store.read();
      return { ...paginate(state.contexts, `${store.target}:${state.revision}`), warnings: state.current === null ? ['No current context is selected.'] : [] };
    }
    case 'context.get': {
      optionsFor(['context']); refuse(arguments_.length === 2 || arguments_.length === 3, 'invalid_input', 'Supply one name or select a current context.');
      refuse(!(arguments_[2] && options.context), 'invalid_input', 'Choose a single explicit context.');
      const state = await store.read();
      const selected = arguments_[2] ?? options.context ?? state.current;
      refuse(selected !== null, 'context_missing', 'No context is selected; name one explicitly.', 6);
      contextName(selected);
      const context = state.contexts.find(c => c.name === selected);
      refuse(context, 'context_missing', 'The named context does not exist.', 6);
      takeTarget(context);
      return { data: { context, current: state.current === selected, revision: state.revision } };
    }
    case 'context.add': case 'context.use': case 'context.remove': {
      optionsFor(operation === 'context.add' ? ['input'] : []);
      exact(operation === 'context.add' ? 2 : 3);
      const parameters = operation === 'context.add' ? await input() : { name: arguments_[2] };
      const plan = await store.plan(operation, parameters);
      if (operation === 'context.add') takeTarget(plan.parameters);
      return { data: { plan }, state: 'planned', operation_id: plan.id,
        next_actions: ['Save data.plan to a file and apply its exact digest before expiry.'] };
    }
    case 'context.apply': {
      optionsFor(['input', 'expect-digest']); exact(2);
      refuse(typeof options['expect-digest'] === 'string' && /^[a-f0-9]{64}$/.test(options['expect-digest']),
        'invalid_input', 'Supply --expect-digest with the exact planned digest.');
      const result = await store.apply(await input(), options['expect-digest']);
      return { data: result, operation_id: result.id };
    }
    case 'context.recover': optionsFor(); exact(2); return { data: await store.recover() };
    case 'doctor': {
      optionsFor(['context']); exact(1);
      const inspected = await store.inspect();
      const name = options.context ?? inspected.state.current;
      if (name !== null) {
        contextName(name);
        const context = inspected.state.contexts.find(c => c.name === name);
        refuse(context, 'context_missing', 'The named context does not exist.', 6);
        takeTarget(context);
      }
      return { data: { runtime: { version: process.version, required: 'v26.10.0', platform: process.platform, architecture: process.arch },
        configuration: { present: inspected.exists, revision: inspected.state.revision, contexts: inspected.state.contexts.length,
          current: inspected.state.current, persistence_supported: ['darwin', 'linux'].includes(process.platform) },
        network: 'not_run', native_application: 'not_run', repairs: 'none' } };
    }
    case 'agent.instructions': optionsFor(); exact(2); return { data: { instructions } };
    case 'export.open': {
      optionsFor(['archive', 'destination', 'vault-root', 'phrase-fd', 'plaintext', 'allow-server-origin']); exact(2);
      deadlineMs = entry.deadline_ms;
      const { openExport } = await import('./export-open.mjs');
      return { data: await openExport(options) };
    }
    default: throw new CliError('unknown_operation', 'No handler exists for this catalog entry.');
  }
}

function envelope(result = {}, error = null) {
  return { schema_version: 1, operation, target, state: error ? (error.exit === 7 ? 'unknown' : error.exit === 9 ? 'failed' : 'refused') : (result.state ?? 'completed'),
    data: error ? null : (result.data ?? {}), error: error ? { code: error.code, message: error.message, exit_code: error.exit } : null,
    warnings: result.warnings ?? [], next_actions: error?.action ? [error.action] : (result.next_actions ?? []),
    operation_id: result.operation_id ?? null, observed_at: new Date().toISOString(),
    duration_ms: Math.max(0, Math.round(performance.now() - started)), verification: { level: 'local', server_contacted: false },
    pagination: result.pagination ?? null };
}

function emit(value) {
  let text = JSON.stringify(value, null, format === 'json' && tty ? 2 : 0);
  if (Buffer.byteLength(text) + 1 > 65536) {
    value = envelope({}, new CliError('output_limit', 'The result exceeds 65536 bytes; request a smaller page.', 2));
    text = JSON.stringify(value); process.exitCode = 2;
  }
  if (format === 'human') {
    // Human output is also inert text: no ANSI escapes, remote instructions or shell snippets.
    text = value.error ? `${value.error.code}: ${value.error.message}` : `${value.operation}: ${value.state}\n${JSON.stringify(value.data, null, 2)}`;
    if (value.next_actions.length) text += `\n${value.next_actions.join('\n')}`;
  }
  if (Buffer.byteLength(text) + 1 > 65536) {
    text = JSON.stringify(envelope({}, new CliError('output_limit', 'The rendered result exceeds 65536 bytes; request a smaller page.', 2)));
    process.exitCode = 2;
  }
  process.stdout.write(`${text}\n`);
}

process.stdout.on('error', () => { process.exitCode = 9; });
try {
  const result = await run();
  refuse(performance.now() - started <= deadlineMs, 'deadline_exceeded',
    'The command exceeded its deadline; inspect any operation receipt or explicit destination before repeating a mutation.', 7);
  emit(envelope(result));
}
catch (error) {
  const refusal = error instanceof CliError ? error : new CliError('local_io_failed',
    'The explicit local input or configuration could not be accessed; check its existence and permissions.', 9);
  process.exitCode = refusal.exit;
  emit(envelope({}, refusal));
}
