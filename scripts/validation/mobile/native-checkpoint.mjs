// Bounded read-only native histories/heads + independent synthetic disk bytes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundManifest, owned, privateRead, privateSave, digest } from './desktop-guard.mjs';
import { connect } from './cdp.mjs';
import { candidateCrypto } from './ciphertext-oracle.mjs';

export class CheckpointFailure extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const requireProof = (condition, reason) => { if (!condition) throw new CheckpointFailure(reason); };
const id = (value, size = 32) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function checkpointRecords(files) {
  requireProof(Array.isArray(files) && files.length >= 3 && files.length <= 64, 'file_inventory_bound');
  const records = files.map(file => {
    requireProof(id(file?.file_id) && Array.isArray(file.heads) && file.heads.length > 0 && file.heads.length <= 128 &&
      Array.isArray(file.versions) && file.versions.length > 0 && file.versions.length <= 128 && JSON.stringify(file).length <= 1048576, 'file_history_bound');
    const heads = [...file.heads].sort(), versions = file.versions.map(v => v.version_id).sort();
    requireProof(heads.every(v => id(v, 64)) && versions.every(v => id(v, 64)) &&
      new Set(heads).size === heads.length && new Set(versions).size === versions.length && heads.every(v => versions.includes(v)), 'file_history_identity');
    return { fileId: file.file_id, heads, versions };
  }).sort((a, b) => a.fileId.localeCompare(b.fileId));
  requireProof(new Set(records.map(r => r.fileId)).size === records.length, 'file_inventory_duplicate');
  return records;
}
export function inventoryHeads(records) {
  return records.flatMap(r => r.heads.map(head => [r.fileId, head])).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}
export function inventoryHash(heads) { return digest(heads.map(row => `${JSON.stringify(row)}\n`).join('')); }
export function assertCheckpointSame(prior, current, scope = 'all') {
  requireProof(prior.sourceHead === current.sourceHead && prior.generation === current.generation && equal(prior.notes, current.notes) && equal(prior.disk, current.disk), 'note_identity_bytes_generation_changed');
  const select = value => scope === 'all' ? value.records : value.records.filter(r => prior.notes.some(note => note.fileId === r.fileId));
  requireProof(equal(select(prior), select(current)), 'histories_or_heads_changed');
  requireProof(equal(prior.rotation, current.rotation) && equal(prior.destinations, current.destinations) && equal(prior.rotationStatus, current.rotationStatus), 'rotation_binding_changed');
}
export function assertFrozenInventory(draft, current, status, inventory) {
  requireProof(draft?.schema === 1 && draft.phase === 'draft' && draft.sourceHead === current.sourceHead && draft.generation === current.generation &&
    equal(draft.rotation?.intent, current.rotation?.intent) && draft.rotation?.coordinator === current.rotation?.coordinator && draft.rotation?.fromSuite === current.rotation?.fromSuite &&
    equal(draft.notes, current.notes) && equal(draft.disk, current.disk), 'draft_inventory_binding');
  requireProof(['ABSENT', 'STOPPED'].includes(current.engineState), 'pending_engine_not_stopped');
  const intent = current.rotation.intent, prepared = current.rotation.prepared;
  requireProof(intent?.current_map === current.generation && id(intent.previous_map) && intent.previous_map !== intent.current_map &&
    id(intent.operation) && id(current.rotation.coordinator) && intent.target !== current.rotation.coordinator, 'rotation_operation_binding');
  const heads = inventoryHeads(draft.records), count = heads.length;
  requireProof(count >= 3 && count <= 64 * 128 && new Set(draft.records.map(r => r.fileId)).size === draft.records.length &&
    draft.records.some(r => r.fileId === intent.previous_map) && equal(inventory, heads), 'frozen_inventory_incomplete');
  requireProof(equal(status.intent, intent) && status.coordinator === current.rotation.coordinator && status.committed === false &&
    Number.isSafeInteger(prepared?.cutoff) && prepared.cutoff >= 0 && status.cutoff === prepared.cutoff &&
    status.inventory_heads === count && prepared.inventoryHeads === count && status.inventory_hash === inventoryHash(heads) &&
    prepared.inventoryHash === status.inventory_hash, 'prepared_receipt_binding');
  const old = current.records.filter(r => draft.records.some(d => d.fileId === r.fileId));
  requireProof(equal(old, draft.records), 'frozen_source_histories_changed');
  if (current.phase === 'prepared') {
    requireProof(equal(current.records, draft.records) && status.catalog_pages === 0 && status.catalog_heads === 0 && status.catalog_last === null &&
      status.catalog_hash === digest('') && current.rotation.commit === null, 'prepared_inventory_changed');
  } else {
    requireProof(current.phase === 'commit_unknown', 'pending_phase_refused');
    const commit = current.rotation.commit;
    requireProof(status.catalog_heads === count && status.catalog_pages === Math.ceil(count / 256) && equal(status.catalog_last, heads.at(-1)) &&
      id(status.catalog_hash, 64) && commit?.catalogPages === status.catalog_pages && commit.catalogHash === status.catalog_hash, 'catalog_receipt_binding');
  }
}
export function assertDestinations(draft, current, destinations) {
  requireProof(Array.isArray(destinations) && destinations.length === draft.records.length &&
    equal(destinations.map(row => row[0]), draft.records.map(row => row.fileId)) && destinations.every(row => row.length === 2 && id(row[1])) &&
    new Set(destinations.map(row => row[1])).size === destinations.length &&
    destinations.every(row => !draft.records.some(old => old.fileId === row[1])) &&
    destinations.some(row => row[0] === draft.rotation.intent.previous_map && row[1] === draft.generation), 'destination_inventory_binding');
  if (current.phase === 'commit_unknown') {
    const expected = [...draft.records.map(r => r.fileId), ...destinations.map(row => row[1])].sort();
    requireProof(equal(current.records.map(r => r.fileId), expected), 'destination_inventory_incomplete');
    for (const [oldId, newId] of destinations) {
      const old = draft.records.find(r => r.fileId === oldId), next = current.records.find(r => r.fileId === newId);
      requireProof(next.heads.length === old.heads.length && equal(next.heads, next.versions), 'destination_history_incomplete');
    }
  }
}

export async function deriveCheckpointDestinations(api, draft, files, inventory, oldRoot, newRoot) {
  const oldMap = await api.dm.domainMapKeys(oldRoot), newMap = await api.dm.domainMapKeys(newRoot);
  requireProof(oldMap.fileId === draft.rotation.intent.previous_map && newMap.fileId === draft.generation, 'backup_generation_binding');
  const sourceFiles = files.filter(file => draft.records.some(record => record.fileId === file.file_id));
  requireProof(equal(sourceFiles.map(f => f.file_id).sort(), draft.records.map(r => r.fileId)), 'plan_source_inventory');
  const byId = new Map(sourceFiles.map(file => [file.file_id, file]));
  const read = id => { const file = byId.get(id); requireProof(!!file, 'plan_unknown_file'); return file; };
  const prohibited = async () => { throw new CheckpointFailure('plan_nonmetadata_operation'); };
  const plan = await api.reseal.planRotationReseal({ getFile: async id => read(id), getVersion: async (id, version) => { const found = read(id).versions.find(v => v.version_id === version); requireProof(!!found, 'plan_unknown_version'); return found; }, getChunk: prohibited, putChunk: prohibited },
    { suite: draft.rotation.fromSuite, root: oldRoot, generation: oldMap.fileId }, { root: newRoot, generation: newMap.fileId }, inventory);
  return draft.records.map(record => [record.fileId, plan.destination(record.fileId)]);
}

// Serialized into the manifest-bound main vault. It exports no keys/credentials.
export async function readNativeCheckpoint(app, P) {
  let stage = 'native_state';
  try {
    const p = app.plugins.plugins['obsync-private-sync'];
    if (!p?.state?.paired || p.state.data.serverUrl !== P.url || p.state.custody2()?.suite !== 2) throw Error('refused');
    const describe = () => {
      const pin = p.state.custody2(), r = pin.rotation;
      const notes = P.notes.map(note => { const record = p.state.fileByPath(note.path); if (!/^[a-f0-9]{32}$/.test(record?.fileId ?? '') || !/^[a-f0-9]{64}$/.test(record.versionId ?? '')) throw Error('refused'); return { path: note.path, fileId: record.fileId, versionId: record.versionId }; });
      return { generation: pin.generation, phase: pin.phase, notes,
        engineState: p.engine === null ? 'ABSENT' : p.engine?.started === false ? 'STOPPED' : p.engine?.started === true ? 'RUNNING' : 'UNKNOWN',
        rotation: r ? { intent: { operation: r.intent.operation, previous_map: r.intent.oldGeneration, current_map: r.intent.newGeneration, target: r.intent.targetDeviceId, recovery_verifier: r.intent.recoveryVerifier, seal_suite: 2 },
          coordinator: p.state.data.deviceId, fromSuite: r.fromSuite, prepared: r.prepared, commit: r.commit } : null };
    };
    const before = describe();
    if (!['active', 'draft', 'prepared', 'commit_unknown'].includes(before.phase)) throw Error('refused');
    const pending = ['prepared', 'commit_unknown'].includes(before.phase);
    if (pending !== P.pending) throw Error('refused');
    let ids = P.ids, rotationStatus = null, inventory = null, listed = null;
    if (pending) {
      stage = 'rotation_status';
      rotationStatus = await p.transport.rotationStatus(before.rotation.intent, before.rotation.coordinator);
      if (rotationStatus.inventory_heads < 3 || rotationStatus.inventory_heads > 64 * 128) throw Error('refused');
      inventory = [];
      stage = 'rotation_inventory';
      for (let page = 0; page < Math.ceil(rotationStatus.inventory_heads / 256); page++) inventory.push(...(await p.transport.rotationInventory(rotationStatus, page)).heads);
    } else {
      stage = 'complete_inventory';
      const page = await p.transport.listFiles(null, { interactive: true });
      if (page.next !== null || page.files.length < before.notes.length + 1 || page.files.length > 64) throw Error('refused');
      listed = page.files; ids = page.files.map(row => row.file_id);
    }
    stage = 'file_histories';
    if (!Array.isArray(ids) || ids.length < 3 || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) throw Error('refused');
    const files = [];
    for (const id of ids) {
      const file = await p.transport.getFile(id, { interactive: true });
      if (file.file_id !== id || !Array.isArray(file.versions) || file.versions.length > 128 || JSON.stringify(file).length > 1048576) throw Error('refused');
      if (listed && JSON.stringify([...listed.find(row => row.file_id === id).heads].sort()) !== JSON.stringify([...file.heads].sort())) throw Error('refused');
      files.push(file);
    }
    stage = 'stable_native_state';
    if (JSON.stringify(before) !== JSON.stringify(describe())) throw Error('refused');
    return { ok: true, ...before, status: p.currentStatus().kind, files, rotationStatus, inventory };
  } catch (error) {
    const apiCode = ['rotation_pending', 'device_revoked', 'generation_mismatch', 'not_paired', 'unknown_file', 'grant_changed'].includes(error?.code) ? error.code : null;
    return { ok: false, stage, reason: apiCode ? 'api_refused' : 'native_contract_refused', apiCode,
      apiStatus: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : null };
  }
}

async function main() {
  const [run, source, label, previous, scope = 'all'] = process.argv.slice(2);
  let c, state, stage = 'arguments', diagnostic = null;
  try {
    requireProof(/^[a-z][a-z0-9-]{0,48}$/.test(label ?? '') && (!previous || /^[a-z][a-z0-9-]{0,48}$/.test(previous)) && ['all', 'notes'].includes(scope), 'finite_arguments');
    stage = 'owned_source'; state = boundManifest(run, source);
    const expected = JSON.parse(privateRead(join(state.run, 'private/full-fixtures.json')));
    requireProof(Array.isArray(expected) && expected.length >= 2 && expected.length <= 32, 'fixture_bound');
    const disk = () => expected.map(note => {
      requireProof(/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(note.path ?? '') && typeof note.text === 'string' && Buffer.byteLength(note.text) <= 16384, 'fixture_shape');
      const path = join(state.devices.A.vault, note.path); owned(path, false, false);
      requireProof(readFileSync(path, 'utf8') === note.text, 'independent_disk_bytes'); return { path: note.path, sha256: digest(note.text) };
    });
    stage = 'independent_disk_before'; const bytes = disk();
    const checkpoint = name => JSON.parse(privateRead(join(state.secrets, `checkpoint-${name}.json`)));
    stage = 'connect_native'; c = await connect(state, 'A');
    const phase = await c.evaluate(`return app.plugins.plugins['obsync-private-sync']?.state?.custody2()?.phase;`);
    const pending = ['prepared', 'commit_unknown'].includes(phase);
    const draft = pending ? checkpoint('rotation-draft') : null;
    const seeded = phase === 'commit_unknown' ? checkpoint('prepared-before') : null;
    if (pending) {
      stage = 'pinned_inventory';
      requireProof(draft.sourceHead === state.source_head && draft.phase === 'draft', 'draft_inventory_binding');
      if (seeded) { assertFrozenInventory(draft, seeded, seeded.rotationStatus, inventoryHeads(draft.records)); assertDestinations(draft, seeded, seeded.destinations); }
    }
    const ids = pending ? [...draft.records.map(r => r.fileId), ...(seeded ? seeded.destinations.map(row => row[1]) : [])].sort() : null;
    stage = 'native_read';
    const value = await c.evaluate(`return await (${readNativeCheckpoint.toString()})(app,P);`, { notes: expected, pending, ids });
    if (!value?.ok) { diagnostic = value; throw new CheckpointFailure('native_read_refused'); }
    const { files, ok, inventory, rotationStatus, ...snapshot } = value;
    const current = { schema: 1, sourceHead: state.source_head, capturedAt: new Date().toISOString(), ...snapshot, records: checkpointRecords(files), disk: bytes };
    if (pending) {
      stage = 'frozen_inventory'; assertFrozenInventory(draft, current, rotationStatus, inventory);
      stage = 'destination_plan';
      const api = candidateCrypto(source, state.source_head, state.artifacts['plugin/main.js'], true);
      const oldRoot = await api.backup.parseRecoveryBackup(privateRead(join(state.secrets, 'phone-old-recovery-backup.txt')));
      const newRoot = await api.backup.parseRecoveryBackup(privateRead(join(state.secrets, 'phone-new-recovery-backup.txt')));
      current.destinations = await deriveCheckpointDestinations(api, draft, files, inventory, oldRoot, newRoot);
      assertDestinations(draft, current, current.destinations);
      if (seeded) requireProof(equal(seeded.destinations, current.destinations), 'destination_plan_changed');
      current.rotationStatus = rotationStatus;
      current.decoderHash = api.decoderHash;
    }
    stage = 'prior_checkpoint';
    if (previous) {
      const prior = checkpoint(previous);
      if (prior.phase === 'draft' && pending) assertCheckpointSame({ ...prior, rotation: current.rotation, rotationStatus: current.rotationStatus, destinations: current.destinations }, current, scope);
      else assertCheckpointSame(prior, current, scope);
    }
    stage = 'independent_disk_after'; requireProof(equal(bytes, disk()), 'independent_disk_changed');
    stage = 'save_checkpoint'; const path = join(state.secrets, `checkpoint-${label}.json`);
    requireProof(!existsSync(path), 'checkpoint_label_used'); privateSave(path, JSON.stringify(current));
    const receipt = { schema: 1, result: previous ? 'PASS' : 'OBSERVED', sourceHead: state.source_head, label, scope,
      independentDiskMatches: true, fileCount: current.records.length, noteCount: current.notes.length, phase: current.phase, status: current.status, engineState: current.engineState,
      historiesAndHeadsUnchanged: previous ? true : 'NOT_COMPARED', frozenRotationInventory: pending, completeDestinationInventory: current.phase === 'commit_unknown',
      checkpointSha256: digest(readFileSync(path)), generationHash: digest(current.generation), physicalPhone: 'NOT_RUN' };
    writeFileSync(join(state.run, 'evidence', `native-checkpoint-${label}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const receipt = { schema: 1, result: 'FAIL', phase: 'native-checkpoint', stage,
      firstFailure: error instanceof CheckpointFailure ? error.reason : 'owned_checkpoint_refused', diagnostic };
    if (state && /^[a-z][a-z0-9-]{0,48}$/.test(label ?? '')) writeFileSync(join(state.run, 'evidence', `native-checkpoint-${label}-failure.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(receipt)); process.exitCode = 1;
  } finally { c?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
