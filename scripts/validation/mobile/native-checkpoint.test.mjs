// Finite checkpoint controls only; none of these fixtures is native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { checkpointRecords, inventoryHeads, inventoryHash, assertCheckpointSame, assertFrozenInventory, assertDestinations, deriveCheckpointDestinations, readNativeCheckpoint } from './native-checkpoint.mjs';
import { digest } from './desktop-guard.mjs';
const hex = (c, size=32) => c.repeat(size);
function fixture() {
  const files=['1','2','3'].map(c=>({file_id:hex(c),heads:[hex(c,64)],versions:[{version_id:hex(c,64)}]}));
  const records=checkpointRecords(files),intent={operation:hex('a'),previous_map:hex('1'),current_map:hex('4'),target:hex('b'),recovery_verifier:hex('c',64),seal_suite:2};
  const draft={schema:1,sourceHead:hex('a',40),phase:'draft',generation:hex('4'),rotation:{intent,coordinator:hex('d'),fromSuite:2,prepared:null,commit:null},notes:[{path:'One.md',fileId:hex('2'),versionId:hex('2',64)},{path:'Two.md',fileId:hex('3'),versionId:hex('3',64)}],disk:[{path:'One.md',sha256:hex('e',64)},{path:'Two.md',sha256:hex('f',64)}],records,engineState:'ABSENT'};
  const inventory=inventoryHeads(records),receipt={cutoff:42,inventoryHash:inventoryHash(inventory),inventoryHeads:inventory.length};
  const current={...structuredClone(draft),phase:'prepared',rotation:{...structuredClone(draft.rotation),prepared:receipt}};
  const status={intent:structuredClone(intent),coordinator:hex('d'),cutoff:42,inventory_hash:receipt.inventoryHash,inventory_heads:3,catalog_pages:0,catalog_heads:0,catalog_last:null,catalog_hash:digest(''),committed:false,resume_id:null};
  const destinations=[[hex('1'),hex('4')],[hex('2'),hex('5')],[hex('3'),hex('6')]];
  return {files,draft,current,status,inventory,destinations};
}
test('prepared inventory binds every source file/head, map, operation and durable receipt while stopped',()=>{
  const f=fixture();assert.doesNotThrow(()=>assertFrozenInventory(f.draft,f.current,f.status,f.inventory));assert.doesNotThrow(()=>assertDestinations(f.draft,f.current,f.destinations));
  for(const alter of [f=>f.inventory.pop(),f=>f.inventory.push(f.inventory[0]),f=>f.inventory[0][1]=hex('9',64),f=>f.draft.records.pop(),f=>f.draft.records[0].fileId=hex('9'),
    f=>f.current.rotation.intent.operation=hex('9'),f=>f.current.rotation.coordinator=hex('9'),f=>f.current.generation=hex('9'),f=>f.current.notes[0].fileId=hex('9'),f=>f.current.disk[0].sha256=hex('9',64),
    f=>f.status.cutoff++,f=>f.status.inventory_heads--,f=>f.status.inventory_hash=hex('9',64),f=>f.current.rotation.prepared.inventoryHash=hex('9',64),f=>f.status.intent.operation=hex('9'),
    f=>f.status.coordinator=hex('9'),f=>f.status.committed=true,f=>f.current.records[0].versions.push(hex('9',64)),f=>f.current.engineState='RUNNING',f=>f.current.engineState='UNKNOWN']){
    const changed=fixture();alter(changed);assert.throws(()=>assertFrozenInventory(changed.draft,changed.current,changed.status,changed.inventory));
  }
});
function seededFixture(){
  const f=fixture();f.current.phase='commit_unknown';f.status.catalog_pages=1;f.status.catalog_heads=3;f.status.catalog_last=f.inventory.at(-1);f.status.catalog_hash=hex('7',64);f.current.rotation.commit={catalogPages:1,catalogHash:hex('7',64)};
  f.current.records.push(...f.destinations.map(([,id])=>({fileId:id,heads:[id+id],versions:[id+id]})));return f;
}
test('commit_unknown requires complete deterministic destination union and exact durable catalog commitment',()=>{
  const f=seededFixture();assert.doesNotThrow(()=>assertFrozenInventory(f.draft,f.current,f.status,f.inventory));assert.doesNotThrow(()=>assertDestinations(f.draft,f.current,f.destinations));
  for(const alter of [f=>f.current.records[0].versions.push(hex('9',64)),f=>f.current.records.pop(),f=>f.current.records.push({fileId:hex('9'),heads:[hex('9',64)],versions:[hex('9',64)]}),f=>f.destinations.pop(),f=>f.destinations[0][1]=hex('2'),f=>f.destinations[1][1]=hex('4'),f=>f.destinations[0][1]=hex('9'),f=>f.current.records.at(-1).versions.push(hex('9',64)),f=>f.current.records.at(-1).heads=[],f=>f.status.catalog_heads--,f=>f.status.catalog_pages++,f=>f.status.catalog_last=f.inventory[0],f=>f.status.catalog_hash=hex('9',64),f=>f.current.rotation.commit.catalogPages++]){
    const changed=seededFixture();alter(changed);assert.throws(()=>{assertFrozenInventory(changed.draft,changed.current,changed.status,changed.inventory);assertDestinations(changed.draft,changed.current,changed.destinations);});
  }
});
test('restart comparison rejects changed histories, note IDs, bytes, generation, operation, inventory and destinations',()=>{
  const f=seededFixture();f.current.rotationStatus=f.status;f.current.destinations=f.destinations;
  assert.doesNotThrow(()=>assertCheckpointSame(f.current,structuredClone(f.current)));
  for(const alter of [s=>s.records.pop(),s=>s.records[0].heads=[hex('9',64)],s=>s.records[0].versions.push(hex('9',64)),s=>s.notes[0].versionId=hex('9',64),s=>s.notes[0].fileId=hex('9'),s=>s.disk[0].sha256=hex('9',64),s=>s.generation=hex('9'),s=>s.sourceHead=hex('9',40),s=>s.rotation.intent.operation=hex('9'),s=>s.rotationStatus.cutoff++,s=>s.destinations.pop()]){
    const current=structuredClone(f.current);alter(current);assert.throws(()=>assertCheckpointSame(f.current,current));
  }
});
test('bounded records reject duplicate/missing IDs, malformed heads and truncated histories',()=>{
  for(const alter of [a=>a.pop(),a=>a.push(a[0]),a=>a[0].file_id='wrong',a=>a[0].heads=[],a=>a[0].heads.push(a[0].heads[0]),a=>a[0].versions=[],a=>a[0].versions[0].version_id=hex('9',64)]){
    const f=fixture();alter(f.files);assert.throws(()=>checkpointRecords(f.files));
  }
});
function nativeFixture(){
  const f=fixture();let listCalls=0,getCalls=0;
  const p={state:{paired:true,data:{serverUrl:'owned',deviceId:f.current.rotation.coordinator},custody2:()=>({suite:2,phase:'prepared',generation:f.current.generation,rotation:{intent:{operation:f.current.rotation.intent.operation,oldGeneration:f.current.rotation.intent.previous_map,newGeneration:f.current.rotation.intent.current_map,targetDeviceId:f.current.rotation.intent.target,recoveryVerifier:f.current.rotation.intent.recovery_verifier},fromSuite:2,prepared:f.current.rotation.prepared,commit:null}}),fileByPath:path=>f.current.notes.find(n=>n.path===path)},engine:null,currentStatus:()=>({kind:'error'}),transport:{async listFiles(){listCalls++;throw Object.assign(Error('do not output'),{code:'rotation_pending',status:409});},async getFile(id){getCalls++;return f.files.find(file=>file.file_id===id);},async rotationStatus(){return f.status;},async rotationInventory(){return {heads:f.inventory};}}};
  return {...f,p,app:{plugins:{plugins:{'obsync-private-sync':p}}},P:{url:'owned',pending:true,notes:f.current.notes,ids:f.files.map(file=>file.file_id)},counts:()=>({listCalls,getCalls})};
}
test('actual pending native read uses only permitted exact-ID reads and keeps safe API refusal diagnostics',async()=>{
  const f=nativeFixture();const value=await readNativeCheckpoint(f.app,f.P);assert.equal(value.ok,true);assert.deepEqual(f.counts(),{listCalls:0,getCalls:3});
  f.p.transport.getFile=async()=>{throw Object.assign(Error('private exception must never escape'),{code:'rotation_pending',status:409});};
  const refused=await readNativeCheckpoint(f.app,f.P);assert.deepEqual(refused,{ok:false,stage:'file_histories',reason:'api_refused',apiCode:'rotation_pending',apiStatus:409});assert.equal(JSON.stringify(refused).includes('private'),false);
  f.p.transport.rotationStatus=async()=>{throw Object.assign(Error('private'),{code:'unknown secret-bearing value',status:700});};
  assert.deepEqual(await readNativeCheckpoint(f.app,f.P),{ok:false,stage:'rotation_status',reason:'native_contract_refused',apiCode:null,apiStatus:null});
});
test('actual full rotation wiring pins draft before prepare, binds prepared checkpoint and refuses a running held engine',()=>{
  const source=readFileSync(new URL('../mobile-full.py',import.meta.url),'utf8');
  const first=source.indexOf("    desk('stage-strong-key-rotation'"),last=source.indexOf("    desk('close-committed-rotation-dialog'",first);
  assert.ok(first>0&&last>first);const block=source.slice(first,last).split('\n').map(line=>line.startsWith('    ')?line.slice(4):line).join('\n');
  const run=(code,running=false)=>spawnSync('python3',['-B','-c',`
from pathlib import Path
desktop=Path('/synthetic-owned-fixture')
c={'sourceHead':'fixture-head'}
def pending_journal(*args): return {}
def assert_pending_journal(*args): pass
def save(*args): pass
phase='active'
pinned=False
running=${running?'True':'False'}
def require(condition, reason):
    if not condition: raise RuntimeError(reason)
def desk(stage, command):
    global phase
    phase={'rotate-stage':'draft','prepare':'prepared','seed':'commit_unknown','commit':'active'}.get(command, phase)
def restart_desktop(label, expected):
    require(phase==expected, 'restart phase mismatch')
def native(stage, file, label, *previous, results):
    global pinned
    if label=='rotation-draft':
        require(phase=='draft', 'ordinary listing is forbidden after prepare')
        pinned=True
    else:
        require(pinned, 'complete draft inventory missing')
        if label=='prepared-before': require(previous==('rotation-draft',), 'draft comparison missing')
    return {'engineState':'RUNNING' if running and label!='rotation-draft' else 'ABSENT'}
${code}
`],{encoding:'utf8'});
  assert.equal(run(block).status,0);
  const missing=block.split('\n').filter(line=>!line.includes("native('rotation-draft-complete-inventory'")).join('\n');assert.notEqual(run(missing).status,0);
  assert.notEqual(run(block.replace("'prepared-before', 'rotation-draft'","'prepared-before'")).status,0);
  assert.notEqual(run(block,true).status,0);
});

test('exact bundled production destination plan authenticates all frozen metadata without chunks or publication', {skip:!process.env.OBSYNC_ORACLE_SOURCE}, async()=>{
  const {candidateCrypto}=await import('./ciphertext-oracle.mjs'),source=process.env.OBSYNC_ORACLE_SOURCE;
  const head=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const bundleHash=digest(readFileSync(join(source,'plugin/dist/main.js'))),api=candidateCrypto(source,head,bundleHash,true),{c,dm,seal}=api;
  assert.notEqual(api.decoderHash,candidateCrypto(source,head,bundleHash).decoderHash,'rotation dependency closure must be separately byte-bound');
  const oldRoot=new Uint8Array(32).fill(11),newRoot=new Uint8Array(32).fill(22),domainId='33'.repeat(16),oldMap=await dm.domainMapKeys(oldRoot),newMap=await dm.domainMapKeys(newRoot);
  const domain=await c.deriveDomainKey(oldRoot,domainId),manifestKey=await c.deriveManifestKey(domain,domainId);
  const file=async(kind,key,id,domain,plaintext,sids=[])=>{
    const ct=await seal.sealRecord(key,kind,{generation:oldMap.fileId,domainId:domain,fileId:id,parents:[],sids},c.utf8(JSON.stringify(plaintext)));
    const version={device_id:hex('7'),ts:1,version_id:await c.versionId(id,[],ct,sids),parents:[],sids,bytes:0,deleted:false,seal_suite:2,manifest_ct:c.base64(ct)};
    return {file_id:id,domain_id:domain,heads:[version.version_id],versions:[version]};
  };
  const files=[await file(2,oldMap.key,oldMap.fileId,oldMap.domainId,dm.defaultDomainMap(domainId))];
  const chunk=await seal.encryptChunk2(domain,{generation:oldMap.fileId,domainId},c.utf8(''));
  for(const [i,name]of ['One.md','Two.md'].entries())files.push(await file(1,manifestKey,hex(String(i+4)),domainId,{v:1,path:name,domain:domainId,mtime:1,size:0,sha256:digest(''),chunks:[{sid:chunk.sid,cid:c.hex(chunk.cid),len:0}],deleted:false},[chunk.sid]));
  const records=checkpointRecords(files),inventory=inventoryHeads(records),draft={records,generation:newMap.fileId,rotation:{fromSuite:2,intent:{previous_map:oldMap.fileId}}};
  const destinations=await deriveCheckpointDestinations(api,draft,files,inventory,oldRoot,newRoot);
  assert.equal(destinations.length,3);assert.equal(new Set(destinations.map(row=>row[1])).size,3);assert.ok(destinations.some(([old,next])=>old===oldMap.fileId&&next===newMap.fileId));
  await assert.rejects(deriveCheckpointDestinations(api,draft,files.slice(1),inventory,oldRoot,newRoot),/plan_source_inventory/);
  await assert.rejects(deriveCheckpointDestinations(api,draft,files,inventory,oldRoot,new Uint8Array(32).fill(23)),/backup_generation_binding/);
  const corrupt=structuredClone(files);corrupt[1].versions[0].manifest_ct=c.base64(new Uint8Array(64));
  await assert.rejects(deriveCheckpointDestinations(api,draft,corrupt,inventory,oldRoot,newRoot));
});
