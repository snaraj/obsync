// Synthetic detached crypto controls only. No native-device result is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const moduleUrl = process.env.OBSYNC_CIPHERTEXT_ORACLE_MODULE ?? new URL('./ciphertext-oracle.mjs', import.meta.url).href;
const { assertBundledModule, candidateCrypto, openCapture, rejectCurrentWithOld, detachedControls, verifyNativeSet, canonicalVersion, assertCurrentHeadProof, assertHeadProofReceipt } = await import(moduleUrl);
import { digest } from './desktop-guard.mjs';
const source = process.env.OBSYNC_ORACLE_SOURCE;
assert.ok(source, 'declare the clean built candidate with OBSYNC_ORACLE_SOURCE');
const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const api = candidateCrypto(source, head, digest(readFileSync(join(source, 'plugin/dist/main.js'))));
const { c, seal, dm } = api;
const oldRoot = new Uint8Array(32).fill(11), currentRoot = new Uint8Array(32).fill(22), domainId = '33'.repeat(16);
async function fixture(root, text, when, fileId) {
  const mapKeys = await dm.domainMapKeys(root), domain = await c.deriveDomainKey(root, domainId);
  const manifestKey = await c.deriveManifestKey(domain, domainId), chunk = await seal.encryptChunk2(domain,
    { generation: mapKeys.fileId, domainId }, c.utf8(text));
  const expected = { path: 'Synthetic-control.md', text, sha256: digest(text) };
  async function record(kind, key, file, domain, parents, sids, bytes, plaintext) {
    const ct = await seal.sealRecord(key, kind, { generation: mapKeys.fileId, domainId: domain, fileId: file, parents, sids }, c.utf8(JSON.stringify(plaintext)));
    return { generation: mapKeys.fileId, domain_id: domain, file_id: file, parents, sids, bytes, deleted: false,
      version_id: await c.versionId(file, parents, ct, sids), seal_suite: 2, manifest_ct: c.base64(ct) };
  }
  return { origin: 'detached-synthetic-test', capturedAt: new Date(when).toISOString(), expected,
    map: await record(2, mapKeys.key, mapKeys.fileId, mapKeys.domainId, [], [], 0, dm.defaultDomainMap(domainId)),
    note: await record(1, manifestKey, fileId, domainId, [], [chunk.sid], Buffer.byteLength(text),
      { v: 1, path: expected.path, domain: domainId, mtime: when, size: Buffer.byteLength(text), sha256: expected.sha256,
        chunks: [{ sid: chunk.sid, cid: c.hex(chunk.cid), len: Buffer.byteLength(text) }], deleted: false }),
    chunks: [{ sid: chunk.sid, cid: c.hex(chunk.cid), ciphertext: c.base64(chunk.ciphertext) }] };
}
const baseline = await fixture(oldRoot, '# Synthetic before block\n', 1_800_000_000_000, '44'.repeat(16));
const access = await fixture(oldRoot, '# Synthetic after access-only block\n', 1_800_000_001_000, '55'.repeat(16));
const current = await fixture(currentRoot, '# Synthetic after rotation\n', 1_800_000_002_000, '66'.repeat(16));
const bundleSha256=digest(readFileSync(join(source,'plugin/dist/main.js')));
function claimedHeadControl(input){
  // Deliberately manufactured detached provenance inputs, never native evidence.
  const capture={...structuredClone(input),schema:1,origin:'native-authenticated-read',sourceHead:head,bundleSha256,decoderHash:api.decoderHash,ordinaryNoteDiskMatches:true};
  const witness=()=>({observedAt:capture.capturedAt,generation:capture.note.generation,...Object.fromEntries(['note','map'].map(kind=>{
    const record=capture[kind];return [kind,{fileId:record.file_id,domainId:record.domain_id,heads:[record.version_id],recordSha256:digest(canonicalVersion(record))}];
  }))});
  capture.headProof={schema:1,sourceHead:head,bundleSha256,before:witness(),after:witness()};return capture;
}
test('head proof rejects stale/conflicted note or map heads, omitted rereads and changed records',()=>{
  const good=claimedHeadControl(current);
  assert.doesNotThrow(()=>assertCurrentHeadProof(good,head,bundleSha256));
  for(const alter of [s=>s.headProof.before.note.heads=['0'.repeat(64)],s=>s.headProof.after.note.heads.push('0'.repeat(64)),
    s=>s.headProof.after.map.heads=['0'.repeat(64)],s=>delete s.headProof.after,
    s=>s.headProof.after.note.recordSha256='0'.repeat(64),s=>s.headProof.after.map.fileId='0'.repeat(32),
    s=>s.headProof.bundleSha256='0'.repeat(64),s=>s.headProof.sourceHead='0'.repeat(40),
    s=>s.headProof.after.generation='0'.repeat(32),s=>s.headProof.after.observedAt=new Date(Date.parse(s.capturedAt)-1).toISOString(),
    s=>s.headProof.after.observedAt=new Date(Date.parse(s.capturedAt)+120001).toISOString()]){
    const changed=structuredClone(good);alter(changed);
    assert.throws(()=>assertCurrentHeadProof(changed,head,bundleSha256));
  }
});
test('head proof receipt is bound independently to proof fields',()=>{
  const capture=claimedHeadControl(current),receipt={sourceHead:head,currentHeadsBeforeAndAfter:true,headProofSha256:digest(JSON.stringify(capture.headProof))};
  assert.doesNotThrow(()=>assertHeadProofReceipt(capture,receipt,head,bundleSha256));
  for(const value of [{...receipt,currentHeadsBeforeAndAfter:false},{...receipt,headProofSha256:'0'.repeat(64)}]){
    assert.throws(()=>assertHeadProofReceipt(capture,value,head,bundleSha256));
  }
});
test('canonical ciphertext metadata ignores only added capture context and sorts fields',()=>{
  assert.equal(canonicalVersion({file_id:'context',domain_id:'context',generation:'context',z:2,a:{z:3,a:1},parents:['b','a']}),
    '{"a":{"a":1,"z":3},"parents":["b","a"],"z":2}');
});
test('actual detached CLI rejects forged current-head claims even when native crypto bytes open',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'obsync-head-proof-control-')));
  const write=(path,value)=>writeFileSync(path,JSON.stringify(value)+'\n',{mode:0o600});
  try{
    mkdirSync(join(root,'private'),{mode:0o700});mkdirSync(join(root,'private/desktop'),{mode:0o700});mkdirSync(join(root,'evidence'),{mode:0o700});
    write(join(root,'lab.json'),{format:1,run:root,source_dirty:false,source_head:head,artifacts:{'plugin/main.js':bundleSha256}});
    writeFileSync(join(root,'private/desktop/phone-old-recovery-backup.txt'),await api.backup.encodeRecoveryBackup(oldRoot),{mode:0o600});
    writeFileSync(join(root,'private/desktop/phone-new-recovery-backup.txt'),await api.backup.encodeRecoveryBackup(currentRoot),{mode:0o600});
    const labels=['before','access','rotated'];
    for(const alter of [null,'stale-before','stale-after','receipt-unverified']){
      for(const [index,input] of [baseline,access,current].entries()){
        const capture=claimedHeadControl(input);
        if(index===2&&alter==='stale-before')capture.headProof.before.note.heads=['0'.repeat(64)];
        if(index===2&&alter==='stale-after')capture.headProof.after.map.heads=['0'.repeat(64)];
        const path=join(root,'private/desktop',`ciphertext-${labels[index]}.json`);write(path,capture);
        write(join(root,'evidence',`native-ciphertext-capture-${labels[index]}.json`),{
          origin:'native-authenticated-read',result:'CAPTURED',sourceHead:head,decoderHash:api.decoderHash,captureSha256:digest(readFileSync(path)),
          currentHeadsBeforeAndAfter:alter!=='receipt-unverified',headProofSha256:digest(JSON.stringify(capture.headProof))});
      }
      const run=spawnSync(process.execPath,[fileURLToPath(moduleUrl),root,'--source',source,'--baseline','before','--access-only','access','--current','rotated'],{encoding:'utf8',timeout:15000});
      if(alter===null)assert.equal(run.status,0,'complete manufactured detached control must open known crypto bytes: '+run.stdout.trim());
      else assert.notEqual(run.status,0,`forged ${alter} claim must refuse independently of crypto success`);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('pure decoder closure is byte-bound to candidate bundle', () => assert.match(api.decoderHash, /^[a-f0-9]{64}$/));
test('changed or duplicate decoder bytes refuse bundle provenance', () => {
  const wrapped = '__modules["./example"] = function (module, exports, require) {\nexports.test=true;\n};\n';
  assert.doesNotThrow(() => assertBundledModule(wrapped, './example', 'exports.test=true;\n'));
  assert.throws(() => assertBundledModule(wrapped, './example', 'exports.test=false;\n'), { code: 'decoder_not_in_installed_bundle' });
  assert.throws(() => assertBundledModule(wrapped + wrapped, './example', 'exports.test=true;\n'), { code: 'decoder_not_in_installed_bundle' });
});
test('old key opens old and later same-generation synthetic ciphertext', async () => {
  assert.equal((await openCapture(api, oldRoot, baseline)).sha256, baseline.expected.sha256);
  assert.equal((await openCapture(api, oldRoot, access)).sha256, access.expected.sha256);
});
test('current key opens every captured material; old root rejects actual bytes supplied directly', async () => {
  assert.equal((await openCapture(api, currentRoot, current)).sha256, current.expected.sha256);
  assert.deepEqual(await rejectCurrentWithOld(api, oldRoot, current), { map: 'REJECT', manifest: 'REJECT', chunks: 1 });
});
test('complete synthetic sequence validates distinct generations and fresh content', async () => {
  const proof = await verifyNativeSet(api, oldRoot, currentRoot, baseline, access, current);
  assert.equal(proof.oldKeyAccessOnlyNewCiphertext, 'OPEN'); assert.equal(proof.oldKeyCurrentChunk, 'REJECT');
});
test('substituting current key into old slot fails the old-key assertion', async () => {
  await assert.rejects(rejectCurrentWithOld(api, currentRoot, current), { code: 'old_key_map_unexpected_open' });
});
test('tamper, wrong-context and substituted-key controls all detect failure', async () => {
  assert.deepEqual(await detachedControls(api, currentRoot, current), {
    tamperRejected: true, wrongContextRejected: true, substitutedCurrentKeyKilledOldKeyAssertion: true });
});
test('manifest and chunk unexpected-success assertions are independently observable', async () => {
  const oldManifestKey = await c.deriveManifestKey(await c.deriveDomainKey(oldRoot, domainId), domainId);
  const originalOpen = seal.openRecord;
  try {
    seal.openRecord = async (key, kind, ...args) => kind === 1 && c.bytesEqual(key, oldManifestKey) ? new Uint8Array() : originalOpen(key, kind, ...args);
    await assert.rejects(rejectCurrentWithOld(api, oldRoot, current), { code: 'old_key_manifest_unexpected_open' });
  } finally { seal.openRecord = originalOpen; }
  const originalChunk = seal.decryptChunk2;
  try {
    seal.decryptChunk2 = async () => new Uint8Array();
    await assert.rejects(rejectCurrentWithOld(api, oldRoot, current), { code: 'old_key_chunk_unexpected_open' });
  } finally { seal.decryptChunk2 = originalChunk; }
});
test('repeated content cannot serve as the access-only new-ciphertext control', async () => {
  await assert.rejects(verifyNativeSet(api, oldRoot, currentRoot, baseline, baseline, current), { code: 'fresh_native_ciphertext' });
});
test('missing chunk, wrong expected bytes and changed generation refuse positive proof', async () => {
  const empty = structuredClone(current); empty.chunks = [];
  await assert.rejects(openCapture(api, currentRoot, empty), { code: 'captured_chunk_binding' });
  const wrong = structuredClone(current); wrong.expected.text += 'changed';
  await assert.rejects(openCapture(api, currentRoot, wrong), { code: 'synthetic_expectation' });
  const generation = structuredClone(current); generation.note.generation = '77'.repeat(16);
  await assert.rejects(openCapture(api, currentRoot, generation), { code: 'generation_binding' });
});
test('a successful decoder returning wrong plaintext cannot satisfy the byte oracle', async () => {
  const original = seal.decryptChunk2;
  try {
    seal.decryptChunk2 = async () => c.utf8('wrong plaintext');
    await assert.rejects(openCapture(api, currentRoot, current), { code: 'plaintext_bytes' });
  } finally { seal.decryptChunk2 = original; }
});
