import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const {recoveryRefusal,refusedRecovery,validateExpectations,activeRecovery}=await import(process.env.OBSYNC_RECOVERY_GUARD_MODULE??new URL('./recovery-guard.mjs',import.meta.url).href);
const source=readFileSync(process.env.OBSYNC_RECOVERY_SOURCE??new URL('./recovery.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const setupSource=source.slice(source.indexOf('async function setup(action) {'),source.indexOf('\ntry {',source.indexOf('async function setup(action) {')));
assert.ok(setupSource.startsWith('async function setup(action) {'));
const diskSource=source.slice(source.indexOf('function negativeDiskSnapshot(notes) {'),source.indexOf('\nasync function setup(action)',source.indexOf('function negativeDiskSnapshot(notes) {')));
const runSetup=new AsyncFunction('action','ui','settings','privateRead','privateFingerprint','negativeDiskSnapshot','recoveryRefusal','refusedRecovery','validateExpectations','activeRecovery','c','sleep','Date','state','record',`let stage,failureReason;${setupSource};try{await setup(action);return {result:'PASS'};}catch{return {result:'FAIL',stage,firstFailure:failureReason};}`);
const diskSnapshot=new Function('state','slot','join','lstatSync','existsSync','realpathSync','process','createHash','readFileSync',diskSource+';return negativeDiskSnapshot;');
const expected={schema:1,sourceHead:'a'.repeat(40),generationHash:'b'.repeat(64),notes:[{path:'Phone-before.md',sha256:'c'.repeat(64),generation:'retained'},{path:'Phone-after.md',sha256:'d'.repeat(64),generation:'current'}]};
const fallback="The server refused this step, so nothing changed. Try again; if it repeats, obsync's log names the reason.";
async function scenario(action='setup-refuse-old',mode='refused'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'obsync-recovery-refusal-'))),vault=join(root,'vault');
  mkdirSync(join(vault,'.obsidian/plugins/obsync-private-sync'),{recursive:true});
  const metadata=join(vault,'.obsidian/plugins/obsync-private-sync/data.json');writeFileSync(metadata,'{"staged":true}\n');
  const state={source_head:expected.sourceHead,devices:{B:{vault}}};
  const snapshot=diskSnapshot(state,'B',join,lstatSync,existsSync,realpathSync,process,createHash,readFileSync);
  const model={now:0,submitted:0,pin:{phase:'enrollment',suite:2},credentialId:null,credentialSecret:null,paired:false,engine:null,enrolling:false,indexed:false,localFile:false,notice:'',fingerprint:'before'};
  const c={consoleSummary:{reasons:{}}},receipts=[];
  const p={state:{get paired(){return model.paired;},data:{get deviceId(){return model.credentialId;},get deviceSecret(){return model.credentialSecret;}},custody2:()=>model.pin,stagedEnrollment2:()=>({purpose:'recover'}),fileByPath:()=>model.indexed?{fileId:'synthetic'}:undefined},get engine(){return model.engine;},get enrolling(){return model.enrolling;}};
  const app={vault:{getAbstractFileByPath:()=>model.localFile?{}:null}};
  function press(){
    model.submitted++;const reason=mode==='arbitrary-error'?'no_server':action==='setup-wrong-token'?'bad_setup_token':'generation_mismatch';
    c.consoleSummary.reasons[reason]=1;model.notice=action==='setup-wrong-token'?'Check the setup token':fallback;
    if(mode==='wrong-visible')model.notice='This backup does not match the vault';
    if(mode==='adopted')model.paired=true;
    if(mode==='credential-id')model.credentialId='adopted';if(mode==='credential-secret')model.credentialSecret='adopted';
    if(mode==='active')model.pin.phase='active';if(mode==='engine')model.engine={started:true};if(mode==='enrolling')model.enrolling=true;
    if(mode==='custody-write')model.fingerprint='changed';if(mode==='metadata-write')writeFileSync(metadata,'{"adopted":true}');
    if(mode==='disk-content')writeFileSync(join(vault,expected.notes[0].path),'materialized');
    if(mode==='index-content')model.indexed=true;if(mode==='vault-content')model.localFile=true;
  }
  const ui=async(body,P={})=>new AsyncFunction('p','P','notice','app','fillOwned','settingRow','pane','press',body)(p,P,text=>model.notice.includes(text),app,()=>{},()=>({querySelector:()=>({})}),()=>({}),press);
  try{
    const result=await runSetup(action,ui,async()=>{},path=>path.includes('expectations')?JSON.stringify(expected):'f'.repeat(64),async()=>model.fingerprint,snapshot,recoveryRefusal,refusedRecovery,validateExpectations,activeRecovery,c,async ms=>{model.now+=ms;},{now:()=>model.now},state,r=>receipts.push(r));
    assert.equal(model.submitted,1,'ordinary negative setup submitted once');assert.ok(model.now<=45000,'original refusal deadline');
    return {result,receipts,model};
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('valid old and unrelated roots require exact generation refusal, visible fallback, no adoption/storage/content',async()=>{
  for(const action of ['setup-refuse-old','setup-refuse-wrong','setup-wrong-token']){
    const {result,receipts}=await scenario(action);assert.equal(result.result,'PASS');const receipt=receipts[0];
    assert.equal(receipt.expectedRefusal,action==='setup-wrong-token'?'bad_setup_token':'generation_mismatch');
    for(const fact of ['visibleRefusal','noCredentialAdopted','noActiveEnrollment','noContentMaterialized','persistedMetadataUnchanged','localCustodyUnchanged'])assert.equal(receipt[fact],true,fact);
    assert.equal(receipt.serverAccountUnchanged,'INDEPENDENT_PARENT_READ_REQUIRED');
  }
});
test('exact reason and actual mapped notice are both required; arbitrary refusal cannot pass',async()=>{
  for(const action of ['setup-refuse-old','setup-refuse-wrong'])for(const mode of ['arbitrary-error','wrong-visible']){
    const {result,receipts}=await scenario(action,mode);assert.equal(result.result,'FAIL');assert.equal(receipts.length,0);
    assert.equal(result.firstFailure,mode==='arbitrary-error'?'expected_authenticated_refusal_absent':'negative_recovery_state_or_content_changed');
  }
});
test('a refused status cannot hide credentials, activation, running engine, persisted writes or recovered content',async()=>{
  for(const mode of ['adopted','credential-id','credential-secret','active','engine','enrolling','custody-write','metadata-write','disk-content','index-content','vault-content']){
    const {result,receipts}=await scenario('setup-refuse-old',mode);assert.equal(result.result,'FAIL',mode);assert.equal(receipts.length,0,mode);
    assert.equal(result.stage,'setup-negative-after',mode);assert.equal(result.firstFailure,'negative_recovery_state_or_content_changed',mode);
  }
});
test('source contract binds root-derived generation before server proof and uses actual UI fallback',()=>{
  const base=new URL('../../../',import.meta.url);
  const storage=readFileSync(new URL('crates/obsyncd/src/storage/mod.rs',base),'utf8');
  const setup=storage.slice(storage.indexOf('pub fn setup_enrolment('),storage.indexOf('let mut armed_at',storage.indexOf('pub fn setup_enrolment(')));
  assert.ok(setup.indexOf('"generation_mismatch"')<setup.indexOf('StoreError::BadRecoveryProof'));
  const enrollment=readFileSync(new URL('plugin/src/enrollment2.ts',base),'utf8');assert.match(enrollment,/generation: staged\.generation/);
  const custody=readFileSync(new URL('plugin/src/state.ts',base),'utf8');assert.match(custody,/async stageEnrollment2[\s\S]*?const derived = await generation\(root\)/);
  const pairing=readFileSync(new URL('plugin/src/pairing.ts',base),'utf8');
  assert.doesNotMatch(pairing.slice(pairing.indexOf('const REFUSALS'),pairing.indexOf('export function refusalFor')),/generation_mismatch:/);
  assert.ok(pairing.includes(JSON.stringify(fallback)));assert.equal(recoveryRefusal('setup-refuse-old').notice,fallback);assert.equal(recoveryRefusal('setup-refuse-wrong').notice,fallback);
  assert.throws(()=>recoveryRefusal('setup-correct'));
  const main=readFileSync(new URL('plugin/src/main.ts',base),'utf8');assert.match(main,/code === "bad_recovery_proof" \|\| code === "recovery_mismatch"/);assert.match(main,/: refusalText\(error\)/);
  assert.match(source,/record\(\{result:'FAIL',stage,firstFailure:failureReason/);assert.doesNotMatch(source,/Preserve the fixture/);
});
