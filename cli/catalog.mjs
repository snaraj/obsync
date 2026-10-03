// The dispatcher, discovery and future MCP adapter consume these same records.
const object = (properties = {}, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const name = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const CONTEXT_INPUT = object({
  name,
  origin: { type: 'string', format: 'uri', maxLength: 512, description: 'HTTPS ASCII DNS, canonical IPv4 or bracketed IPv6 origin. Only host case, :443 and one final slash may normalize on input.' },
  expected_instance: { ...digest, type: ['string', 'null'] },
}, ['name', 'origin']);
export const PLAN_INPUT = object({
  schema_version: { const: 1 },
  id: { type: 'string', pattern: '^[a-f0-9]{32}$' },
  operation: { enum: ['context.add', 'context.use', 'context.remove'] },
  parameters: { oneOf: [CONTEXT_INPUT, object({ name })] },
  revision: { type: 'integer', minimum: 0 },
  config_digest: digest, config_target: digest,
  created_at: { type: 'integer', minimum: 0, description: 'Unix milliseconds.' },
  expires_at: { type: 'integer', minimum: 0, description: 'Unix milliseconds; exactly five minutes after creation.' },
  digest,
});
const output = object({
  schema_version: { const: 1 }, operation: { type: ['string', 'null'] },
  target: object({ context: { type: ['string', 'null'] }, origin: { type: ['string', 'null'] },
    expected_instance: { type: ['string', 'null'] }, verified_instance: { type: 'null' } }),
  state: { enum: ['completed', 'planned', 'refused', 'failed', 'partial', 'unknown'] },
  data: { type: ['object', 'null'] }, error: { type: ['object', 'null'] },
  warnings: { type: 'array', items: { type: 'string' } },
  next_actions: { type: 'array', items: { type: 'string' } },
  operation_id: { type: ['string', 'null'] }, observed_at: { type: 'string', format: 'date-time' },
  duration_ms: { type: 'integer', minimum: 0 },
  verification: object({ level: { const: 'local' }, server_contacted: { const: false } }),
  pagination: { type: ['object', 'null'] },
});

function operation(id, command, summary, input = object(), extra = {}) {
  return {
    operation: id, command, summary, schema_version: 1, input_schema: input,
    output_schema: output, execution_scope: 'local', effect: 'read',
    availability: 'implemented', server_capability: null, server_scopes: [],
    target: 'Explicit local configuration only; no verified server identity.',
    secret_fields: [], repeatability: 'Read-only; safe to repeat.',
    deadline_ms: 5000, cancellation: 'Deadline checked before a new effect and response; an OS filesystem call cannot be interrupted.',
    output_limit_bytes: 65536, input_limit_bytes: 16384,
    completion: 'The requested local result was read or calculated.',
    verification: 'No network, native application or server claim.',
    errors: ['invalid_input', 'unsupported_runtime', 'output_limit'],
    examples: [`obsync ${command}`], ...extra,
  };
}

export const CATALOG = [
  operation('cli.help', 'help', 'List implemented commands and global options.'),
  operation('cli.version', 'version', 'Read the installed product and schema versions.'),
  operation('cli.search', 'cli search QUERY', 'Find operations in this offline catalog.', object({ query: { type: 'string', maxLength: 256 } }), { examples: ['obsync cli search context'] }),
  operation('schema', 'schema OPERATION', 'Read the exact operation contract.', object({ operation: { type: 'string', maxLength: 64 } }), { examples: ['obsync schema context.add'] }),
  operation('capabilities', 'capabilities', 'List locally implemented operations; no server intersection is claimed.'),
  operation('context.list', 'context list', 'Read the named local contexts.'),
  operation('context.get', 'context get [NAME]', 'Read one explicit or selected local context.', object({ name }, [])),
  operation('context.add', 'context add --input @ABSOLUTE_FILE', 'Plan adding a new named HTTPS target.', CONTEXT_INPUT, { effect: 'read', examples: ['obsync context add --input @/absolute/context.json'], completion: 'A five-minute plan was returned; configuration is unchanged.' }),
  operation('context.use', 'context use NAME', 'Plan selecting an existing local context.', object({ name }), { examples: ['obsync context use personal'], completion: 'A five-minute plan was returned; configuration is unchanged.' }),
  operation('context.remove', 'context remove NAME', 'Plan removing only a local association.', object({ name }), { examples: ['obsync context remove personal'], completion: 'A five-minute plan was returned; no credential, server or vault is removed.' }),
  operation('context.apply', 'context apply --input @ABSOLUTE_PLAN --expect-digest DIGEST', 'Apply one exact, unexpired context plan against its original revision.', object({ plan: PLAN_INPUT, expect_digest: digest }), {
    effect: 'configure', repeatability: 'An identical unexpired plan reads its durable receipt; changed or expired plans refuse.',
    completion: 'Configuration and operation receipt committed in one SQLite transaction with full synchronization.',
    verification: 'Read back in a new CLI process; no server identity is verified.',
    errors: ['invalid_input', 'digest_mismatch', 'revision_conflict', 'plan_expired', 'unsafe_config', 'config_busy', 'operation_capacity', 'unsupported_platform', 'write_unknown'],
    examples: ['obsync context apply --input @/absolute/plan.json --expect-digest DIGEST'],
  }),
  operation('context.recover', 'context recover', 'Recover an interrupted local SQLite transaction to its last committed state.', object(), {
    effect: 'maintenance', repeatability: 'Recovery never applies a new context plan.',
    completion: 'The exact local database recovered and its committed revision was read.',
    examples: ['obsync context recover'],
  }),
  operation('doctor', 'doctor', 'Read the runtime and exact selected configuration; perform no repairs or network probes.'),
  operation('agent.instructions', 'agent instructions', 'Read concise instructions for this installed slice.'),

];

export const UNSUPPORTED = {
  export: 'Export and offline opening are deferred; this package contains no vault decryption capability.',
  auth: 'Management authentication is not implemented in this offline slice.',
  server: 'Authenticated server operations are not implemented in this offline slice.',
  setup: 'Native setup is not implemented in this offline slice.',
  obsidian: 'Native Obsidian operations are not implemented in this offline slice.',
  devices: 'Device operations are not implemented in this offline slice.',
  storage: 'Storage and deployment operations are deferred.',
  backup: 'Full backup and restore are deferred.',
  sync: 'Native sync verification is not implemented in this offline slice.',
  logs: 'Server log access is not implemented in this offline slice.',
  audit: 'Server audit access is not implemented in this offline slice.',
  mcp: 'The MCP adapter is not implemented in this offline slice.',
  plans: 'Only local context plans are available, through context apply.',
  operations: 'Only local context receipts are available, through repeated context apply.',
};

export function summary(entry, nativeWindows = false) {
  return { operation: entry.operation, command: entry.command, summary: entry.summary,
    effect: entry.effect, availability: available(entry, nativeWindows) ? entry.availability : 'unsupported_platform', schema: `obsync schema ${entry.operation}` };
}

export function available(entry, nativeWindows = false) {
  return !['context.apply', 'context.recover'].includes(entry.operation) || ['darwin', 'linux'].includes(process.platform) || nativeWindows;
}
