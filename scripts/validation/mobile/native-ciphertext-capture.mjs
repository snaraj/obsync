// Read only an explicit synthetic note and its current map through the native
// authorized peer. No engine/state/store/transport replacement or mutation.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundManifest, owned, privateRead, privateSave, digest } from './desktop-guard.mjs';
import { connect } from './cdp.mjs';
import { candidateCrypto, manifestFor, openCapture, OracleFailure, canonicalVersion, assertCurrentHeadProof } from './ciphertext-oracle.mjs';
import { retainCapture } from './ciphertext-retention.mjs';

// Only absent publication facts or normal syncing may wait. Invalid present facts
// refuse immediately, without authenticated reads or any action on the engine.
export function captureReadiness(app, P) {
  try {
    const p = app?.plugins?.plugins?.['obsync-private-sync'], pin = p?.state?.custody2(), context = p?.engine?.contextValue;
    const local = p?.state?.fileByPath(P.path), status = p?.currentStatus()?.kind;
    const observation = {
      paired: p?.state?.paired === true, activeSuite2: pin?.phase === 'active' && pin.suite === 2 && !pin.rotation,
      serverMatches: p?.state?.data?.serverUrl === P.url, contextPresent: !!context,
      generationMatches: pin?.generation === P.mapFileId && context?.generation === pin?.generation,
      mapMatches: context?.mapFileId === P.mapFileId, idle: status === 'idle',
      statusPermitsPublication: status === 'idle' || status === 'syncing', identityPresent: local !== undefined,
      identityValid: !!local && /^[a-f0-9]{32}$/.test(local.fileId) && /^[a-f0-9]{64}$/.test(local.versionId),
    };
    const valid = observation.paired && observation.activeSuite2 && observation.serverMatches && observation.contextPresent && observation.generationMatches && observation.mapMatches;
    if (!valid) return { ok: false, ready: false, reason: 'native_generation_or_map_refused', observation };
    if (observation.identityPresent && !observation.identityValid) return { ok: false, ready: false, reason: 'malformed_native_identity', observation };
    if (!observation.statusPermitsPublication) return { ok: false, ready: false, reason: 'native_status_refused', observation };
    return { ok: true, ready: observation.idle && observation.identityValid, reason: null, observation };
  } catch { return { ok: false, ready: false, reason: 'native_readiness_contract_refused', observation: null }; }
}
export class CaptureFailure extends Error {
  constructor(stage, reason) { super(reason); this.stage = stage; this.reason = reason; }
}
export async function withinDeadline(work, deadline, now, failure) {
  const remaining = deadline - now();
  if (remaining <= 0) throw failure();
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), remaining); })]);
    if (now() >= deadline) throw failure();
    return result;
  } finally { clearTimeout(timer); }
}
export async function captureHeadsWhenReady(client, params, { deadline, now = () => Date.now(), pause = ms => new Promise(r => setTimeout(r, ms)), onObservation = () => {}, onReady = () => {} }) {
  const started = now(), end = Math.min(deadline, started + 30000), diagnostic = { polls: 0, elapsedMs: 0, budgetMs: end - started, initial: null, final: null };
  const failure = () => new CaptureFailure('await_native_publication', 'publication_readiness_deadline');
  const report = () => { diagnostic.elapsedMs = now() - started; onObservation(structuredClone(diagnostic)); };
  while (now() < end) {
    let value;
    try { value = await withinDeadline(() => client.evaluate(`return (${captureReadiness.toString()})(app, P);`, params), end, now, failure); }
    catch (error) { report(); if (error instanceof CaptureFailure) throw error; throw new CaptureFailure('await_native_publication', 'native_readiness_observation_refused'); }
    diagnostic.polls++; diagnostic.initial ??= value.observation; diagnostic.final = value.observation; report();
    if (!value.ok) throw new CaptureFailure('await_native_publication', value.reason);
    if (value.ready) { onReady(); return { native: await readNativeHeads(client, params), readiness: diagnostic }; }
    await pause(Math.min(100, Math.max(0, end - now())));
  }
  report(); throw failure();
}
export async function readNativeHeads(client, params) {
  let result;
  try { result = await client.evaluate(`
    let stage = 'native_active_context';
    try {
    const canonicalVersion=(${canonicalVersion.toString()});
    const witness=async file=>{if(file.versions.length>128||JSON.stringify(file).length>1048576)throw Error('bounded head history required');const record=file.versions.find(v=>v.version_id===file.heads[0]);if(!record)throw Error('head record absent');const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalVersion(record)));return {fileId:file.file_id,domainId:file.domain_id,heads:[...file.heads],recordSha256:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};};
    const p=app.plugins.plugins['obsync-private-sync'],pin=p?.state?.custody2(),context=p?.engine?.contextValue;
    if(!p?.state?.paired||p.state.data.serverUrl!==P.url||pin?.phase!=='active'||pin.suite!==2||pin.rotation||p.currentStatus().kind!=='idle'||
      !context||context.generation!==pin.generation||context.mapFileId!==P.mapFileId)throw Error('active native generation required');
    stage = 'native_local_identity';
    const local=p.state.fileByPath(P.path);
    if(!local||!/^[a-f0-9]{32}$/.test(local.fileId)||!/^[a-f0-9]{64}$/.test(local.versionId))throw Error('known native record absent');
    const before=JSON.stringify([pin.generation,local.fileId,local.versionId,local.sha256]);
    stage = 'native_note_version';
    const note=await p.transport.getVersion(local.fileId,local.versionId,{interactive:true});
    if(note.version_id!==local.versionId||note.deleted||note.bytes!==P.bytes||note.seal_suite!==2||note.sids.length!==1||JSON.stringify(note).length>65536)throw Error('bounded known native version required');
    stage = 'native_note_current_head';
    const noteFile=await p.transport.getFile(local.fileId,{interactive:true}),noteHead=await witness(noteFile);
    if(noteHead.fileId!==local.fileId||noteHead.domainId!==context.domainId||noteHead.heads.length!==1||noteHead.heads[0]!==local.versionId||canonicalVersion(noteFile.versions.find(v=>v.version_id===local.versionId))!==canonicalVersion(note))throw Error('known native note is not sole current head');
    stage = 'native_map_current_head';
    const file=await p.transport.getFile(context.mapFileId,{interactive:true});
    if(file.file_id!==context.mapFileId||file.heads.length!==1||file.versions.length>16||JSON.stringify(file).length>1048576)throw Error('bounded current native map required');
    const map=file.versions.find(v=>v.version_id===file.heads[0]);
    if(!map||map.deleted||map.bytes!==0||map.seal_suite!==2||map.sids.length!==0)throw Error('current native map version required');
    const mapHead=await witness(file);
    stage = 'native_before_stability';
    const after=JSON.stringify([p.state.custody2()?.generation,p.state.fileByPath(P.path)?.fileId,p.state.fileByPath(P.path)?.versionId,p.state.fileByPath(P.path)?.sha256]);
    if(before!==after||p.state.custody2()?.phase!=='active'||p.currentStatus().kind!=='idle')throw Error('native record changed during capture');
    return {ok:true,value:{headsBefore:{generation:pin.generation,observedAt:new Date().toISOString(),note:noteHead,map:mapHead},note:{...note,file_id:local.fileId,domain_id:context.domainId,generation:pin.generation},
      map:{...map,file_id:file.file_id,domain_id:file.domain_id,generation:pin.generation}}};
    } catch { return {ok:false,stage}; }
  `, params); } catch { throw new CaptureFailure('native_before_heads', 'native_evaluation_refused'); }
  if (!result?.ok) throw new CaptureFailure(result?.stage ?? 'native_active_context', 'native_contract_or_transport_refused');
  return result.value;
}
export async function readNativeCiphertext(client, params) {
  let result;
  try { result = await client.evaluate(`
    let stage = 'native_cipher_context';
    try {
    const canonicalVersion=(${canonicalVersion.toString()});
    const witness=async file=>{if(file.versions.length>128||JSON.stringify(file).length>1048576)throw Error('bounded head history required');const record=file.versions.find(v=>v.version_id===file.heads[0]);if(!record)throw Error('head record absent');const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalVersion(record)));return {fileId:file.file_id,domainId:file.domain_id,heads:[...file.heads],recordSha256:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('')};};
    const p=app.plugins.plugins['obsync-private-sync'],local=p?.state?.fileByPath(P.path),pin=p?.state?.custody2();
    if(!p?.state?.paired||pin?.phase!=='active'||pin.generation!==P.generation||local?.fileId!==P.fileId||local?.versionId!==P.versionId||p.currentStatus().kind!=='idle')throw Error('native capture changed');
    stage = 'native_cipher_chunk';
    const bytes=await p.transport.getChunk(P.sid,undefined,{interactive:true});
    if(bytes.length<16||bytes.length>P.maxBytes)throw Error('bounded known native chunk required');
    stage = 'native_after_current_heads';
    const noteHead=await witness(await p.transport.getFile(P.fileId,{interactive:true})),mapHead=await witness(await p.transport.getFile(P.mapFileId,{interactive:true}));
    if(JSON.stringify(noteHead)!==JSON.stringify(P.before.note)||JSON.stringify(mapHead)!==JSON.stringify(P.before.map))throw Error('native note or map current head changed');
    stage = 'native_after_stability';
    if(p.state.custody2()?.generation!==P.generation||p.state.fileByPath(P.path)?.versionId!==P.versionId)throw Error('native chunk capture changed');
    return {ok:true,value:{ciphertext:Array.from(bytes),headsAfter:{generation:pin.generation,observedAt:new Date().toISOString(),note:noteHead,map:mapHead}}};
    } catch { return {ok:false,stage}; }
  `, params); } catch { throw new CaptureFailure('native_ciphertext_and_after_heads', 'native_evaluation_refused'); }
  if (!result?.ok) throw new CaptureFailure(result?.stage ?? 'native_cipher_context', 'native_contract_or_transport_refused');
  return result.value;
}
export async function main(argv = process.argv.slice(2)) {
const [runArg, label, ...args] = argv, options = {};
const started = Date.now(), deadline = started + 180000;
let client, state, readiness = null, stage = 'arguments';
const bounded = async (next, work) => { stage = next; return withinDeadline(work, deadline, () => Date.now(), () => new CaptureFailure(stage, 'capture_deadline')); };
try {
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !['source', 'note-label', 'backup'].includes(key) || options[key] || !args[i + 1]) throw Error('arguments');
    options[key] = args[i + 1];
  }
  if (!/^[a-z][a-z0-9-]{0,32}$/.test(label) || !/^[a-z][a-z0-9-]{0,32}$/.test(options['note-label']) ||
      !options.source || !['old', 'new'].includes(options.backup)) throw Error('arguments');
  stage = 'owned_source_binding';
  state = boundManifest(resolve(runArg), options.source);
  const output = join(state.secrets, `ciphertext-${label}.json`);
  if (existsSync(output)) throw Error('capture label already used');
  stage = 'synthetic_expectation';
  const expectationPath = join(state.secrets, `note-${options['note-label']}.json`);
  if (owned(expectationPath).size > 32768) throw Error('synthetic expectation budget');
  const expected = JSON.parse(privateRead(expectationPath));
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(expected.path) || typeof expected.text !== 'string' ||
      !expected.text.startsWith('# ') || Buffer.byteLength(expected.text) < 1 || Buffer.byteLength(expected.text) > 16384 || digest(expected.text) !== expected.sha256) throw Error('bounded synthetic expectation');
  const disk = join(state.devices.A.vault, expected.path); owned(disk, false, false);
  if (readFileSync(disk, 'utf8') !== expected.text) throw Error('ordinary note disk mismatch');
  stage = 'candidate_crypto_binding';
  const api = candidateCrypto(options.source, state.source_head, state.artifacts['plugin/main.js']);
  const root = await bounded('recovery_backup_derivation', () => api.backup.parseRecoveryBackup(privateRead(join(state.secrets, `phone-${options.backup}-recovery-backup.txt`))));
  const mapKeys = await bounded('expected_map_derivation', () => api.dm.domainMapKeys(root));
  client = await bounded('connect_native_peer', () => connect(state, 'A'));
  const native = await bounded('await_native_publication', async () => (await captureHeadsWhenReady(client, { path: expected.path, bytes: Buffer.byteLength(expected.text), mapFileId: mapKeys.fileId }, { deadline, onObservation: value => { readiness = value; }, onReady: () => { stage = 'native_before_heads'; } })).native);
  const capture = { schema: 1, origin: 'native-authenticated-read', sourceHead: state.source_head,
    bundleSha256: state.artifacts['plugin/main.js'], decoderHash: api.decoderHash, capturedAt: new Date().toISOString(),
    expected, expectationSha256: digest(readFileSync(expectationPath)), ordinaryNoteDiskMatches: true,
    note: native.note, map: native.map, chunks: [], headProof:{schema:1,sourceHead:state.source_head,bundleSha256:state.artifacts['plugin/main.js'],before:native.headsBefore} };
  const decoded = await bounded('detached_manifest_open', () => manifestFor(api, root, capture));
  const captured = await bounded('native_ciphertext_and_after_heads', () => readNativeCiphertext(client, { path: expected.path, generation: native.note.generation, fileId: native.note.file_id, versionId: native.note.version_id,
    sid: decoded.chunk.sid, maxBytes: Buffer.byteLength(expected.text) + 16, mapFileId:native.map.file_id,before:native.headsBefore }));
  capture.headProof.after=captured.headsAfter;
  stage = 'current_head_proof';
  const headProofSha256=assertCurrentHeadProof(capture,state.source_head,state.artifacts['plugin/main.js']);
  capture.chunks.push({ sid: decoded.chunk.sid, cid: decoded.chunk.cid, ciphertext: Buffer.from(captured.ciphertext).toString('base64') });
  const opened = await bounded('detached_ciphertext_open', () => openCapture(api, root, capture));
  stage = 'final_independent_disk';
  owned(disk, false, false);
  if (readFileSync(disk, 'utf8') !== expected.text) throw Error('ordinary note disk changed');
  if (Date.now() >= deadline) throw new CaptureFailure(stage, 'capture_deadline');
  stage = 'retain_closed_capture';
  privateSave(output, JSON.stringify(capture));
  const captureSha256 = digest(readFileSync(output));
  const retainedCapture = retainCapture(state.run, capture, label, { sourceHead: state.source_head,
    bundleSha256: state.artifacts['plugin/main.js'], decoderHash: api.decoderHash, sourceCaptureSha256: captureSha256 });
  const receipt = { schema: 1, sourceHead: state.source_head, origin: 'native-authenticated-read', result: 'CAPTURED',
    readiness, captureBudgetMs: 180000, elapsedMs: Date.now() - started,
    action: { method: 'authenticated-read-only', actor: 'retained-desktop' }, capturedAt: capture.capturedAt,
    physicalPhone: 'NOT_RUN', captureSha256, retainedCapture, decoderHash: api.decoderHash,
    ciphertextHashes: [digest(api.c.unbase64(capture.map.manifest_ct)), digest(api.c.unbase64(capture.note.manifest_ct)), ...capture.chunks.map(c => digest(Buffer.from(c.ciphertext, 'base64')))],
    generationHash: opened.generationHash, plaintextSha256: opened.sha256, bytes: opened.bytes, chunkCount: capture.chunks.length,
    ordinaryNoteDiskMatches: true, currentKeyOpensCapturedBytes: true,currentHeadsBeforeAndAfter:true,headProofSha256 };
  if (Date.now() >= deadline) throw new CaptureFailure(stage, 'capture_deadline');
  stage = 'write_capture_receipt';
  writeFileSync(join(state.run, 'evidence', `native-ciphertext-capture-${label}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(receipt));
} catch (error) {
  const receipt = { result: 'FAIL', origin: 'native-authenticated-read', sourceHead: state?.source_head ?? null,
    firstFailure: error instanceof OracleFailure ? error.code : 'owned_capture_refused',
    stage: error instanceof CaptureFailure ? error.stage : stage, reason: error instanceof CaptureFailure ? error.reason : error instanceof OracleFailure ? 'detached_oracle_refused' : 'capture_contract_or_transport_refused',
    readiness, captureBudgetMs: 180000, elapsedMs: Date.now() - started };
  if (state && /^[a-z][a-z0-9-]{0,32}$/.test(label)) {
    const receiptPath = join(state.run, 'evidence', `native-ciphertext-capture-${label}.json`);
    if (!existsSync(receiptPath)) writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(receipt));
  process.exitCode = 1;
} finally { client?.close(); }

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
