import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const {recoveryRefusal,refusedRecovery,validateExpectations,activeRecovery,recoveryRefusalFacts,visibleRecoveryRefusal,recoveryReadbackExport}=await import(process.env.OBSYNC_RECOVERY_GUARD_MODULE??new URL('./recovery-guard.mjs',import.meta.url).href);
const source=readFileSync(process.env.OBSYNC_RECOVERY_SOURCE??new URL('./recovery.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const cdpSource=readFileSync(new URL('./cdp.mjs',import.meta.url),'utf8');
const preludeStart=cdpSource.indexOf('    const prelude = `'),preludeEnd=cdpSource.indexOf('    const answer = await send',preludeStart);
const prelude=new Function('params','device','state','scriptJson','checkVault',cdpSource.slice(preludeStart,preludeEnd)+';return prelude;')({}, {vault:'/owned'}, {run:'/owned',url:'http://127.0.0.1:1'},JSON.stringify,true);
const domSource=source.slice(source.indexOf('const dom=`'),source.indexOf('async function ui('));
const dom=new Function(domSource+';return dom;')();

const setupSource=source.slice(source.indexOf('async function setup(action) {'),source.indexOf('\ntry {',source.indexOf('async function setup(action) {')));
assert.ok(setupSource.startsWith('async function setup(action) {'));
const diskSource=source.slice(source.indexOf('function negativeDiskSnapshot(notes) {'),source.indexOf('\nasync function setup(action)',source.indexOf('function negativeDiskSnapshot(notes) {')));
const runSetup=new AsyncFunction('action','ui','settings','privateRead','privateFingerprint','negativeDiskSnapshot','recoveryRefusal','refusedRecovery','validateExpectations','activeRecovery','c','sleep','performance','state','record','recoveryRefusalFacts','visibleRecoveryRefusal',`let stage,failureReason,negativeReadiness;${setupSource};try{await setup(action);return {result:'PASS'};}catch{return {result:'FAIL',stage,firstFailure:failureReason,negativeReadiness};}`);
const diskSnapshot=new Function('state','slot','join','lstatSync','existsSync','realpathSync','process','createHash','readFileSync',diskSource+';return negativeDiskSnapshot;');
const expected={schema:1,sourceHead:'a'.repeat(40),generationHash:'b'.repeat(64),notes:[{path:'Phone-before.md',sha256:'c'.repeat(64),generation:'retained'},{path:'Phone-after.md',sha256:'d'.repeat(64),generation:'current'}]};
const fallback="The server refused this step, so nothing changed. Try again; if it repeats, obsync's log names the reason.";
async function scenario(action='setup-refuse-old',mode='refused'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'obsync-recovery-refusal-'))),vault=join(root,'vault');
  mkdirSync(join(vault,'.obsidian/plugins/obsync-private-sync'),{recursive:true});
  const metadata=join(vault,'.obsidian/plugins/obsync-private-sync/data.json');writeFileSync(metadata,'{"staged":true}\n');
  const state={source_head:expected.sourceHead,devices:{B:{vault}}};
  const snapshot=diskSnapshot(state,'B',join,lstatSync,existsSync,realpathSync,process,createHash,readFileSync);
  const model={now:0,submitted:0,pin:{phase:'enrollment',suite:2},credentialId:null,credentialSecret:null,paired:false,engine:null,enrolling:false,indexed:false,localFile:false,notice:'',recent:'',modalOpen:false,statusCommands:0,fingerprint:'before'};
  const c={consoleSummary:{reasons:{}}},receipts=[];
  const p={state:{get paired(){return model.paired;},data:{get deviceId(){return model.credentialId;},get deviceSecret(){return model.credentialSecret;}},custody2:()=>model.pin,stagedEnrollment2:()=>({purpose:'recover'}),fileByPath:()=>model.indexed?{fileId:'synthetic'}:undefined},get engine(){return model.engine;},get enrolling(){return model.enrolling;}};
  const app={setting:{close(){}},commands:{executeCommandById(id){assert.equal(id,'obsync-private-sync:recent');model.statusCommands++;model.modalOpen=true;return true;}},vault:{getAbstractFileByPath:()=>model.localFile?{}:null}};
  function press(){
    model.submitted++;const reason=mode==='arbitrary-error'?'no_server':action==='setup-wrong-token'?'bad_setup_token':'generation_mismatch';
    c.consoleSummary.reasons[reason]=1;model.notice=action==='setup-wrong-token'?recoveryRefusal(action).notice:fallback;model.recent=model.notice;
    if(action==='setup-correct'){model.paired=true;model.pin.phase='active';model.notice="Recovered this vault's enrollment. Starting encrypted sync.";model.recent=model.notice;}
    if(mode==='folded'||mode==='private-recent-only'||mode==='absent-recent')model.notice='More—see Recent';
    if(mode==='wrong-recent')model.recent='A different event';if(mode==='absent-recent'||mode==='private-recent-only')model.recent='';
    if(mode==='positive-unpaired')model.paired=false;if(mode==='positive-phase')model.pin.phase='enrollment';if(mode==='positive-enrolling')model.enrolling=true;
    if(mode==='wrong-visible'){model.notice='This backup does not match the vault';model.recent=model.notice;}
    if(mode==='adopted')model.paired=true;
    if(mode==='credential-id')model.credentialId='adopted';if(mode==='credential-secret')model.credentialSecret='adopted';
    if(mode==='active')model.pin.phase='active';if(mode==='engine')model.engine={started:true};if(mode==='enrolling')model.enrolling=true;
    if(mode==='custody-write')model.fingerprint='changed';if(mode==='metadata-write')writeFileSync(metadata,'{"adopted":true}');
    if(mode==='disk-content')writeFileSync(join(vault,expected.notes[0].path),'materialized');
    if(mode==='index-content')model.indexed=true;if(mode==='vault-content')model.localFile=true;
  }
  const visible=e=>!!e&&e.visible!==false;
  const modal={querySelector:selector=>selector==='.modal-title'?{textContent:'Recent sync activity'}:null,querySelectorAll:selector=>selector==='h3'?[{textContent:'Recent'}]:selector==='.setting-item-name'&&model.recent?[{textContent:model.recent}]:[],parentElement:{querySelector:()=>({click(){model.modalOpen=false;}})}};
  const dialogs=()=>model.modalOpen?[modal]:[];
  const pause=async ms=>{model.now+=ms;};
  const wait=async(read,_stage,budget)=>{const end=model.now+budget;do{const value=read();if(value)return value;await pause(Math.min(100,end-model.now));}while(model.now<end);throw Error('owned UI readiness deadline');};
  const ui=async(body,P={})=>{new Function('return(async()=>{'+prelude+dom+body+'})()');return new AsyncFunction('p','P','notice','app','fillOwned','settingRow','pane','press','dialogs','visible','wait',body)(p,P,text=>model.notice.includes(text),app,()=>{},()=>({querySelector:()=>({})}),()=>({}),press,dialogs,visible,wait);};
  try{
    const result=await runSetup(action,ui,async()=>{},path=>path.includes('expectations')?JSON.stringify(expected):'f'.repeat(64),async()=>model.fingerprint,snapshot,recoveryRefusal,refusedRecovery,validateExpectations,activeRecovery,c,pause,{now:()=>model.now},state,r=>receipts.push(r),recoveryRefusalFacts,visibleRecoveryRefusal);
    assert.equal(model.submitted,1,'ordinary negative setup submitted once');assert.ok(model.now<=(action==='setup-correct'?60000:45000),'original shared deadline');
    return {result,receipts,model};
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('valid old and unrelated roots require exact generation refusal, visible fallback, no adoption/storage/content',async()=>{
  for(const action of ['setup-refuse-old','setup-refuse-wrong','setup-wrong-token']){
    const {result,receipts}=await scenario(action);assert.equal(result.result,'PASS');const receipt=receipts[0];
    assert.equal(receipt.expectedRefusal,action==='setup-wrong-token'?'bad_setup_token':'generation_mismatch');
    for(const fact of ['visibleRefusal','noCredentialAdopted','noActiveEnrollment','noContentMaterialized','persistedMetadataUnchanged','localCustodyUnchanged'])assert.equal(receipt[fact],true,fact);
    assert.equal(receipt.serverAccountUnchanged,'INDEPENDENT_PARENT_READ_REQUIRED');assert.equal(receipt.visibleRefusalSource,'RECENT_UI');assert.equal(receipt.negativeReadiness.budgetMs,45000);assert.equal(receipt.negativeReadiness.after.visibleRefusal,true);
  }
});
test('exact reason and actual mapped notice are both required; arbitrary refusal cannot pass',async()=>{
  for(const action of ['setup-refuse-old','setup-refuse-wrong'])for(const mode of ['arbitrary-error','wrong-visible']){
    const {result,receipts}=await scenario(action,mode);assert.equal(result.result,'FAIL');assert.equal(receipts.length,0);
    assert.equal(result.firstFailure,mode==='arbitrary-error'?'expected_authenticated_refusal_absent':'negative_recovery_visible_recent_absent');
  }
});
test('a refused status cannot hide credentials, activation, running engine, persisted writes or recovered content',async()=>{
  for(const mode of ['adopted','credential-id','credential-secret','active','engine','enrolling','custody-write','metadata-write','disk-content','index-content','vault-content']){
    const {result,receipts}=await scenario('setup-refuse-old',mode);assert.equal(result.result,'FAIL',mode);assert.equal(receipts.length,0,mode);
    assert.equal(result.stage,'setup-negative-after',mode);assert.equal(result.firstFailure,'negative_recovery_state_or_content_changed',mode);
  }
});
test('folded negative toast requires ordinary durable visible Recent and closes that owned modal before next action',async()=>{
  for(const action of ['setup-refuse-old','setup-refuse-wrong','setup-wrong-token']){const {result,receipts,model}=await scenario(action,'folded');assert.equal(result.result,'PASS');assert.equal(model.submitted,1);assert.equal(model.statusCommands,1);assert.equal(model.modalOpen,false);assert.equal(receipts[0].negativeReadiness.initial.visibleRefusal,false);assert.equal(receipts[0].negativeReadiness.after.visibleRefusal,true);}
  for(const mode of ['wrong-recent','absent-recent','private-recent-only']){const {result,model,receipts}=await scenario('setup-wrong-token',mode);assert.equal(result.result,'FAIL',mode);assert.equal(receipts.length,0);assert.equal(model.now,45000);assert.equal(model.submitted,1);}
});
test('folded positive recovery notice still requires every active predicate and visible Recent within original60s',async()=>{
  const {result,model,receipts}=await scenario('setup-correct','folded');assert.equal(result.result,'PASS');assert.equal(model.statusCommands,1);assert.equal(model.modalOpen,false);assert.equal(receipts[0].visibleRecoveryNoticeSource,'RECENT_UI');assert.equal(receipts[0].activeReadiness.budgetMs,60000);
  for(const mode of ['wrong-recent','absent-recent','private-recent-only','positive-unpaired','positive-phase','positive-enrolling']){const {result,model,receipts}=await scenario('setup-correct',mode);assert.equal(result.result,'FAIL',mode);assert.equal(receipts.length,0);assert.equal(model.submitted,1);assert.equal(model.now,60000);}
});
test('visible Recent guard binds the owned visible status modal and exact rendered notice, never private recent data',()=>{
 const element=text=>({textContent:text}),notice=recoveryRefusal('setup-wrong-token').notice,modal={querySelector:()=>element('Recent sync activity'),querySelectorAll:q=>q==='h3'?[element('Recent')]:[element(notice)]};const visible=e=>e.hidden!==true;
 assert.equal(visibleRecoveryRefusal([modal],notice,visible),true);assert.equal(visibleRecoveryRefusal([modal,modal],notice,visible),false);assert.equal(visibleRecoveryRefusal([],notice,visible),false);assert.equal(visibleRecoveryRefusal([{...modal,querySelector:()=>element('Sync status')}],notice,visible),false);assert.equal(visibleRecoveryRefusal([{...modal,querySelectorAll:()=>[{textContent:notice,hidden:true}]}],notice,visible),false);assert.equal(visibleRecoveryRefusal([{...modal,hidden:true}],notice,visible),false);assert.equal(visibleRecoveryRefusal([modal],notice+' extra',visible),false);
 const privateOnly={...modal,recent:()=>[notice],querySelectorAll:()=>[]};assert.equal(visibleRecoveryRefusal([privateOnly],notice,visible),false);
 const unsafe={enrolling:'private',paired:'private',deviceIdAbsent:'private',deviceSecretAbsent:'private',phase:'private',suite:'private',purpose:'private',engineStopped:'private',visibleRefusal:'private',contentAbsent:'private'};assert.equal(Object.values(recoveryRefusalFacts(unsafe)).every(v=>v===false),true);assert.equal(JSON.stringify(recoveryRefusalFacts(unsafe)).includes('private'),false);
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
  assert.ok(pairing.includes(JSON.stringify(recoveryRefusal('setup-wrong-token').notice)));assert.ok(pairing.includes(JSON.stringify(fallback)));assert.equal(recoveryRefusal('setup-refuse-old').notice,fallback);assert.equal(recoveryRefusal('setup-refuse-wrong').notice,fallback);
  assert.throws(()=>recoveryRefusal('setup-correct'));
  const main=readFileSync(new URL('plugin/src/main.ts',base),'utf8');assert.match(main,/code === "bad_recovery_proof" \|\| code === "recovery_mismatch"/);assert.match(main,/: refusalText\(error\)/);
  assert.match(source,/record\(\{result:'FAIL',stage,firstFailure:failureReason/);assert.doesNotMatch(source,/Preserve the fixture/);
});

test('actual C readback exports measured raw buffers and source mapping before comparison, retaining missing/mismatched failures',async()=>{
  const start=source.indexOf("      await ui(`if(!p.state.paired||p.state.custody2()?.phase!=='active')"),end=source.indexOf("    } else if(command==='quit')",start);assert.ok(start>0&&end>start);
  const run=new AsyncFunction('ui','privateRead','validateExpectations','state','slot','recoveryReadbackExport','join','Date','existsSync','lstatSync','realpathSync','process','readFileSync','sleep','record',source.slice(start,end));
  for(const mode of ['exact','wrong','missing','late-correct']){
    const root=realpathSync(mkdtempSync(join(tmpdir(),'obsync-C-byte-export-')));mkdirSync(join(root,'evidence'));const vault=join(root,'vault');mkdirSync(vault);
    const bodies=[Buffer.from([0,65,0xff,13,10]),Buffer.from('CURRENT exact synthetic bytes\n')],notes=bodies.map((b,index)=>({path:index?'After.md':'Before.md',sha256:createHash('sha256').update(b).digest('hex'),generation:index?'current':'retained'}));
    const expectations={schema:1,sourceHead:expected.sourceHead,generationHash:expected.generationHash,notes};
    if(mode!=='missing')for(const [index,note] of notes.entries())writeFileSync(join(vault,note.path),mode==='wrong'&&index===0?Buffer.from('WRONG ORIGINAL BYTES'):bodies[index]);
    let clock=0;const records=[],state={run:root,source_head:expected.sourceHead,devices:{C:{vault}}};
    const read=path=>{assert.ok(existsSync(join(root,'evidence/recovery-C-readback/expectations.json')),'source mapping must precede first byte read');const bytes=readFileSync(path);if(mode==='late-correct'&&clock===0&&path.endsWith('Before.md'))return Buffer.from('earlier bytes');return bytes;};
    try{
      const promise=run(async()=>true,()=>JSON.stringify(expectations),validateExpectations,state,'C',recoveryReadbackExport,join,{now:()=>clock},existsSync,lstatSync,realpathSync,process,read,async ms=>{clock+=ms;},r=>records.push(r));
      if(mode==='exact'||mode==='late-correct')await assert.doesNotReject(promise);else await assert.rejects(promise,/recovered disk bytes did not match/);
      const directory=join(root,'evidence/recovery-C-readback');assert.ok(existsSync(join(directory,'expectations.json')),'retained expectation manifest required');assert.ok(existsSync(join(directory,'result.json')),'retained partial or complete result required');const manifestBytes=readFileSync(join(directory,'expectations.json')),manifest=JSON.parse(manifestBytes),result=JSON.parse(readFileSync(join(directory,'result.json')));
      assert.deepEqual(manifest,expectations);assert.equal(result.sourceHead,expected.sourceHead);assert.equal(result.expectationsSha256,createHash('sha256').update(manifestBytes).digest('hex'));assert.equal(result.expectedCount,2);
      if(mode==='exact'||mode==='late-correct'){
        assert.equal(result.result,'PASS');assert.equal(result.exportedCount,2);assert.equal(records[0].independentlyReadRecoveredNotes,2);
        for(const [index,row] of result.exports.entries()){assert.ok(existsSync(join(root,row.path)),'actual exported byte file required');assert.deepEqual(readFileSync(join(root,row.path)),bodies[index]);assert.equal(row.expectedSha256,notes[index].sha256);assert.equal(row.actualSha256,notes[index].sha256);assert.equal(row.bytes,bodies[index].length);assert.equal(row.generation,notes[index].generation);assert.equal(row.exactHashMatched,true);assert.equal(lstatSync(join(root,row.path)).mode&0o077,0);}
      }else{assert.equal(result.result,'FAIL');assert.equal(records.length,0);assert.equal(clock,60000);assert.equal(result.exportedCount,mode==='missing'?0:1);if(mode==='wrong'){const row=result.exports[0];assert.ok(existsSync(join(root,row.path)),'actual mismatched byte file required');assert.equal(row.exactHashMatched,false);assert.notEqual(row.actualSha256,row.expectedSha256);assert.deepEqual(readFileSync(join(root,row.path)),Buffer.from('WRONG ORIGINAL BYTES'));assert.equal(row.bytes,20);}}
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('fixed recovery exporter refuses incomplete PASS, changed prior bytes, oversized input and reused destination',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'obsync-C-export-guard-')));mkdirSync(join(root,'evidence'));
 try{
   const exporter=recoveryReadbackExport(root,expected.sourceHead,expected);assert.throws(()=>recoveryReadbackExport(root,expected.sourceHead,expected));
   assert.throws(()=>exporter.observe(0,'not Buffer'),/bounded ordered/);assert.throws(()=>exporter.observe(0,Buffer.alloc(65537)),/bounded ordered/);assert.throws(()=>exporter.observe(1,Buffer.from('out of order')),/bounded ordered/);
   exporter.observe(0,Buffer.from('ACTUAL WRONG SYNTHETIC'));
   writeFileSync(join(root,'evidence/recovery-C-readback/0-desktop.bin'),'changed outside exporter');assert.throws(()=>exporter.observe(0,Buffer.from('next')),/export changed/);
   assert.throws(()=>exporter.finish(true),/complete matching/);assert.ok(existsSync(join(root,'evidence/recovery-C-readback/result.json')),'failed result must persist');assert.equal(JSON.parse(readFileSync(join(root,'evidence/recovery-C-readback/result.json'))).result,'FAIL');assert.throws(()=>exporter.finish(false),/already finished/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
