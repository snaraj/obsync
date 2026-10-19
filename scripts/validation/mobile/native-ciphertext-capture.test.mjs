// Finite offline publication and oracle controls; none is native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureReadiness, captureHeadsWhenReady, readNativeHeads, readNativeCiphertext, withinDeadline, CaptureFailure } from './native-ciphertext-capture.mjs';
const hex=(c,n=32)=>c.repeat(n), AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
function fixture(){
 const pin={phase:'active',suite:2,generation:hex('1'),rotation:null},context={generation:hex('1'),mapFileId:hex('1'),domainId:hex('2')};
 const local={fileId:hex('3'),versionId:hex('4',64),sha256:hex('5',64)};
 const note={version_id:local.versionId,deleted:false,bytes:20,seal_suite:2,sids:[hex('6',64)],parents:[],manifest_ct:'synthetic-note'};
 const map={version_id:hex('7',64),deleted:false,bytes:0,seal_suite:2,sids:[],parents:[],manifest_ct:'synthetic-map'};
 const files={ [local.fileId]:{file_id:local.fileId,domain_id:context.domainId,heads:[local.versionId],versions:[note]},[context.mapFileId]:{file_id:context.mapFileId,domain_id:hex('8'),heads:[map.version_id],versions:[map]} };
 const f={pin,context,local,note,map,files,status:'idle',record:local,calls:[],tick:0,observations:[],afterGet:null};
 const p={state:{paired:true,data:{serverUrl:'owned'},custody2:()=>pin,fileByPath:()=>f.record},engine:{contextValue:context},currentStatus:()=>({kind:f.status}),transport:{
  async getVersion(){f.calls.push('version');return structuredClone(note);},
  async getFile(id){f.calls.push('file');const value=structuredClone(files[id]);f.afterGet?.(id);return value;},
  async getChunk(){f.calls.push('chunk');return new Uint8Array(36);}
 }};
 f.p=p;f.app={plugins:{plugins:{'obsync-private-sync':p}}};f.params={path:'Known.md',bytes:20,mapFileId:context.mapFileId,url:'owned'};
 f.client={evaluate:(body,params)=>new AsyncFunction('app','P',body)(f.app,params)};
 f.options={deadline:180000,now:()=>f.tick,pause:async ms=>{f.tick+=ms;},onObservation:value=>f.observations.push(value)};
 return f;
}
const stage=(expected,reason)=>e=>e instanceof CaptureFailure&&e.stage===expected&&(!reason||e.reason===reason);
test('actual capture waits for missing identity and syncing before any authenticated read, then retains both current-head reads',async()=>{
 const f=fixture();f.record=undefined;f.status='syncing';let polls=0;
 f.options.pause=async ms=>{assert.deepEqual(f.calls,[]);f.tick+=ms;if(++polls===1)f.record=f.local;else f.status='idle';};
 const result=await captureHeadsWhenReady(f.client,f.params,f.options);
 assert.equal(result.readiness.polls,3);assert.equal(result.readiness.budgetMs,30000);assert.equal(result.readiness.initial.identityPresent,false);assert.equal(result.readiness.final.identityValid,true);
 assert.deepEqual(f.calls,['version','file','file']);
 const captured=await readNativeCiphertext(f.client,{...f.params,generation:f.pin.generation,fileId:f.local.fileId,versionId:f.local.versionId,sid:f.note.sids[0],maxBytes:36,before:result.native.headsBefore});
 assert.equal(captured.ciphertext.length,36);assert.deepEqual(captured.headsAfter.note,result.native.headsBefore.note);assert.deepEqual(captured.headsAfter.map,result.native.headsBefore.map);assert.deepEqual(f.calls,['version','file','file','chunk','file','file']);
});
test('wrong generation/map, malformed present identity and product errors refuse immediately rather than wait',async()=>{
 for(const alter of [f=>f.pin.generation=hex('9'),f=>f.context.generation=hex('9'),f=>f.context.mapFileId=hex('9'),f=>f.p.state.paired=false,f=>f.pin.phase='prepared',f=>f.pin.suite=1,f=>f.pin.rotation={},f=>f.p.state.data.serverUrl='other',f=>f.p.engine.contextValue=null,
  f=>f.record=null,f=>f.local.fileId='bad',f=>f.local.versionId='bad',f=>f.status='error',f=>f.status='offline',f=>f.status='paused',f=>f.status='unknown']){
  const f=fixture();alter(f);const observed=captureReadiness(f.app,f.params);assert.equal(observed.ok,false);assert.ok(['native_generation_or_map_refused','malformed_native_identity','native_status_refused'].includes(observed.reason));f.options.pause=async()=>assert.fail('invalid present facts must not wait');
  await assert.rejects(captureHeadsWhenReady(f.client,f.params,f.options),e=>stage('await_native_publication',observed.reason)(e));assert.deepEqual(f.calls,[]);assert.equal(f.observations.length,1);
 }
});
test('unchanged original30s observation cap, remaining phase budget, and late ready results cannot reset or overrun',async()=>{
 for(const budget of [30000,250]){
  const f=fixture();f.record=undefined;f.options.deadline=budget===30000?180000:budget;
  await assert.rejects(captureHeadsWhenReady(f.client,f.params,f.options),stage('await_native_publication','publication_readiness_deadline'));
  assert.equal(f.tick,budget);assert.equal(f.observations.at(-1).budgetMs,budget);assert.deepEqual(f.calls,[]);
 }
 const late=fixture();late.client.evaluate=async()=>{late.tick=30001;return {ok:true,ready:true,observation:{idle:true}};};
 await assert.rejects(captureHeadsWhenReady(late.client,late.params,late.options),stage('await_native_publication','publication_readiness_deadline'));assert.deepEqual(late.calls,[]);
 let clock=0;await assert.rejects(withinDeadline(async()=>{clock=180001;return 'late';},180000,()=>clock,()=>new CaptureFailure('native_before_heads','capture_deadline')),stage('native_before_heads','capture_deadline'));
});
test('hung or refused native observations use the same cap and retain no raw exception',async()=>{
 const f=fixture();const start=Date.now();
 await assert.rejects(captureHeadsWhenReady({evaluate:async()=>{await new Promise(r=>setTimeout(r,30));return {ok:true,ready:true,observation:{idle:true}};}},f.params,{deadline:start+10}),stage('await_native_publication','publication_readiness_deadline'));assert.ok(Date.now()-start<1000);
 await assert.rejects(withinDeadline(()=>new Promise(()=>{}),Date.now()+10,()=>Date.now(),()=>new CaptureFailure('await_native_publication','publication_readiness_deadline')),stage('await_native_publication','publication_readiness_deadline'));
 await assert.rejects(captureHeadsWhenReady({evaluate:async()=>{throw Error('private exception must not escape');}},f.params,f.options),e=>stage('await_native_publication','native_readiness_observation_refused')(e)&&!JSON.stringify(e).includes('private'));
});
test('ready observation never skips sole-head and unchanged record/map/ciphertext guards',async()=>{
 for(const [alter,expected] of [
  [f=>f.note.bytes++, 'native_note_version'],[f=>f.note.deleted=true,'native_note_version'],[f=>f.note.sids.push(hex('9',64)),'native_note_version'],
  [f=>f.files[f.local.fileId].heads.push(hex('9',64)),'native_note_current_head'],
  [f=>f.files[f.local.fileId].domain_id=hex('9'),'native_note_current_head'],
  [f=>f.files[f.context.mapFileId].heads.push(hex('9',64)),'native_map_current_head'],
  [f=>f.map.deleted=true,'native_map_current_head'],[f=>f.map.bytes++,'native_map_current_head'],
  [f=>f.afterGet=()=>{f.local.sha256=hex('9',64);},'native_before_stability']]){
  const f=fixture();alter(f);await assert.rejects(captureHeadsWhenReady(f.client,f.params,f.options),stage(expected));
 }
 for(const [alter,expected] of [
  [f=>f.status='syncing','native_cipher_context'],[f=>f.p.transport.getChunk=async()=>new Uint8Array(15),'native_cipher_chunk'],
  [f=>f.files[f.local.fileId].heads=[hex('9',64)],'native_after_current_heads'],
  [f=>f.files[f.context.mapFileId].versions[0].manifest_ct='changed','native_after_current_heads'],
  [f=>f.afterGet=()=>{f.local.versionId=hex('9',64);},'native_after_stability']]){
  const f=fixture();const before=await readNativeHeads(f.client,f.params);const params={...f.params,generation:f.pin.generation,fileId:f.local.fileId,versionId:f.local.versionId,sid:f.note.sids[0],maxBytes:36,before:before.headsBefore};alter(f);
  await assert.rejects(readNativeCiphertext(f.client,params),stage(expected));
 }
 const f=fixture();f.p.transport.getVersion=async()=>{throw Error('secret-bearing native transport error');};
 await assert.rejects(captureHeadsWhenReady(f.client,f.params,f.options),e=>stage('native_note_version','native_contract_or_transport_refused')(e)&&!JSON.stringify(e).includes('secret'));
});
test('production push awaiting acknowledgement reproduces valid disk bytes without local publication identity',async()=>{
 const source=resolve(process.env.OBSYNC_ORACLE_SOURCE??fileURLToPath(new URL('../../../..',import.meta.url)));
 const {rig}=await import(pathToFileURL(join(source,'plugin/test/fake.mjs')));
 const require=createRequire(pathToFileURL(join(source,'plugin/package.json'))),{pushFile}=require('./build/sync/push.js');
 const r=await rig(),path='Known.md',text='# Synthetic publication\n\nKnown bytes.\n';r.host.seed(path,text,2000);
 let release,posted;const held=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{posted=resolve;});
 const original=r.transport.postVersion.bind(r.transport);
 r.transport.postVersion=async(...args)=>{const ack=await original(...args);posted();await held;return ack;};
 const publishing=pushFile(r.context,path);await arrived;
 assert.equal(r.host.text(path),text);assert.equal(r.state.fileByPath(path),undefined);
 let status='syncing',reads=0;
 // rig's virtual sleep resolves immediately; the finite fake backend uses its
 // ordinary transport path rather than its interactive wall-clock race.
 const lengths={getVersion:2,getFile:1,getChunk:1};
 for(const key of Object.keys(lengths)){const original=r.transport[key].bind(r.transport);r.transport[key]=(...args)=>{reads++;return original(...args.slice(0,lengths[key]));};}
 const app={plugins:{plugins:{'obsync-private-sync':{state:r.state,engine:{contextValue:r.context},transport:r.transport,currentStatus:()=>({kind:status})}}}};
 const params={path,bytes:Buffer.byteLength(text),mapFileId:r.context.mapFileId,url:r.state.data.serverUrl};
 assert.equal(captureReadiness(app,params).ready,false);
 const client={evaluate:(body,params)=>new AsyncFunction('app','P',body)(app,params)};
 // The old single-shot capture refuses this supported publication interval.
 await assert.rejects(readNativeHeads(client,params),stage('native_active_context'));assert.equal(reads,0);
 let tick=0;
 try{
  const result=await captureHeadsWhenReady(client,params,{deadline:180000,now:()=>tick,pause:async ms=>{assert.equal(reads,0);tick+=ms;release();await publishing;status='idle';}});
  assert.equal(result.readiness.polls,2);assert.equal(result.native.note.file_id,r.state.fileByPath(path).fileId);assert.ok(reads>0);
 }finally{release();await publishing;}
});
test('actual CLI keeps readiness, detached decrypt, independent disk and current-head proof admission wired',()=>{
 const code=readFileSync(new URL('./native-ciphertext-capture.mjs',import.meta.url),'utf8');
 const main=code.slice(code.indexOf('export async function main('));
 assert.ok(main.indexOf('captureHeadsWhenReady(client,')<main.indexOf("bounded('detached_manifest_open'"));
 for(const text of ['assertCurrentHeadProof(capture,','openCapture(api, root, capture)','readNativeCiphertext(client,','readFileSync(disk, \'utf8\') !== expected.text','retainCapture(state.run, capture,','currentHeadsBeforeAndAfter:true,headProofSha256'])assert.ok(main.includes(text));
});
