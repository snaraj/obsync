import test from 'node:test';
import assert from 'node:assert/strict';
const {slotShape,validateExpectations,activeRecovery,recoveryChooserTarget,recoveryChooserFacts,initializedRecoveryChooser}=await import(process.env.OBSYNC_RECOVERY_GUARD_MODULE??new URL('./recovery-guard.mjs',import.meta.url).href);
const run='/private/tmp/owned-recovery';
function fixture(){return {format:1,run,source_dirty:false,source_head:'a'.repeat(40),expiresAtEpoch:Date.now()/1000+60,
  devices:{B:{vault:run+'/runtime/B/Lab-B',userdata:run+'/runtime/B/userdata',port:29345}},
  processes:{B:{argv:['/official/Obsidian.app/Contents/MacOS/Obsidian','--user-data-dir='+run+'/runtime/B/userdata','--remote-debugging-port=29345','--remote-debugging-address=127.0.0.1']}}};}
test('fixed B/C slot and exact isolated profile/loopback argv',()=>{
  assert.equal(slotShape(fixture(),run,'B').port,29345);
  for(const mutate of [s=>s.source_dirty=true,s=>s.expiresAtEpoch=0,s=>s.devices.B.vault=run+'/runtime/A/Lab-A',s=>s.devices.B.android=true,s=>s.processes.B.argv[3]='--remote-debugging-address=0.0.0.0',s=>s.processes.B.argv.push('--disable-web-security')]){
    const state=fixture();mutate(state);assert.throws(()=>slotShape(state,run,'B'));
  }
  assert.throws(()=>slotShape(fixture(),run,'A'));assert.throws(()=>slotShape(fixture(),run,'C'));
  const d=fixture();d.devices.D={...d.devices.B,vault:run+'/runtime/D/Lab-D',userdata:run+'/runtime/D/userdata'};d.processes.D={argv:[d.processes.B.argv[0],'--user-data-dir='+run+'/runtime/D/userdata',d.processes.B.argv[2],d.processes.B.argv[3]]};
  assert.equal(slotShape(d,run,'D').port,29345);assert.throws(()=>slotShape(d,run,'E'));
});
test('recovery success requires observed suite2 and current retained witnesses cannot duplicate',()=>{
  const active={paired:true,enrolling:false,phase:'active',suite:2,recoveryNotice:true};
  assert.equal(activeRecovery(active),true);
  for(const change of [{suite:1},{paired:false},{enrolling:true},{phase:'enrollment'},{recoveryNotice:false}])assert.equal(activeRecovery({...active,...change}),false);
  const expected={schema:1,sourceHead:'a'.repeat(40),generationHash:'b'.repeat(64),notes:[{path:'Phone-before.md',sha256:'c'.repeat(64),generation:'retained'},{path:'Phone-after.md',sha256:'d'.repeat(64),generation:'current'}]};
  validateExpectations(expected,'a'.repeat(40));
  for(const mutate of [e=>e.notes[1].path=e.notes[0].path,e=>e.notes[1].sha256=e.notes[0].sha256,e=>e.notes[1].generation='retained',e=>e.sourceHead='b'.repeat(40)]){
    const copy=structuredClone(expected);mutate(copy);assert.throws(()=>validateExpectations(copy,'a'.repeat(40)));
  }
});

// Exercise the real CLI open branch with only synthetic owned-target observations.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const openSource=readFileSync(process.env.OBSYNC_RECOVERY_SOURCE??new URL('./recovery.mjs',import.meta.url),'utf8');
const openErrors=openSource.slice(openSource.indexOf('function openErrorClass('),openSource.indexOf("try {\n  if(command==='open')"));
const realOpenBody=openSource.slice(openSource.indexOf("try {\n  if(command==='open')"));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const chooserPage={id:'owned-chooser',url:'app://obsidian.md/starter.html'};
async function runOpen(options={}) {
  let now=0,id=0,dispatches=0,targetCalls=0,connectCalls=0,closed=0,uiCalls=0;
  const timers=new Map(),receipts=[],selected=[],exits=[],sleeps=[],p={exitCode:0,exit(code){exits.push(code);throw Error('synthetic terminal exit');}};
  const advance=(ms,fire=true)=>{now+=ms;if(fire)for(const [key,timer] of [...timers])if(timer.at<=now){timers.delete(key);timer.callback();}};
  const allPages=options.pages??[[chooserPage]],allFacts=options.facts??[{documentReady:true,inner:1,ipc:true}];
  const targets=async()=>{targetCalls++;if(options.targetError)throw Error(options.targetError);if(options.lateTargets)advance(45001,false);return allPages[Math.min(targetCalls-1,allPages.length-1)];};
  const connect=async(_state,_slot,chooser,targetId)=>{
    connectCalls++;if(options.connectError)throw Error(options.connectError);if(chooser)selected.push(targetId);
    let observed;
    return {close(){closed++;},async evaluate(body){
      if(chooser){
        if(options.evaluateError)throw Error(options.evaluateError);
        const dispatch=body.includes("sendSync('vault-open'");
        if(!dispatch)observed=allFacts[Math.min(selected.length-1,allFacts.length-1)];
        if(!dispatch&&options.missingFacts)return {};
        if(!dispatch&&options.lateChooser)advance(45001,false);
        const location={href:dispatch&&options.changedAtDispatch?'app://obsidian.md/index.html':observed.url??chooserPage.url};
        const document={readyState:observed.documentReady?'complete':'loading',querySelectorAll:()=>Array.from({length:observed.inner})};
        const require=()=>({ipcRenderer:{sendSync:observed.ipc?()=>{dispatches++;return false;}:undefined}});
        const result=await new AsyncFunction('location','document','require','P',body)(location,document,require,{vault:'/synthetic/owned/D'});
        if(dispatch&&options.navigationAfterDispatch)throw Error('CDP disconnected');
        return result;
      }
      if(options.latePlugin)advance(45001,false);
      return {pluginReady:true,trustChoiceObserved:false,trustClickObserved:false};
    }};
  };
  const record=value=>{if(options.writeError||options.failWriter&&value.result==='FAIL')throw Error('synthetic writer failure or EEXIST');receipts.push(structuredClone(value));if(options.lateRecord&&value.result==='READY')advance(45001,false);};
  const sleep=async ms=>{sleeps.push(ms);if(options.watchdog)advance(45000);else advance(ms);};
  const ui=async()=>{uiCalls++;if(options.lateFinal&&uiCalls===2)advance(45001,false);return true;};
  let error;
  try{await new AsyncFunction('command','state','slot','targets','connect','sleep','performance','setTimeout','clearTimeout','process','record','ui','settings','createHash','recoveryChooserTarget','recoveryChooserFacts','initializedRecoveryChooser',
    `let c,stage='open',failureReason='owned_recovery_step_refused',negativeReadiness,openReadiness,openDeadlineTimer,openStartedAt;${openErrors}${realOpenBody}`)(
      'open',{},'D',targets,connect,sleep,{now:()=>now},(callback,ms)=>{timers.set(++id,{at:now+ms,callback});return id;},key=>timers.delete(key),p,record,ui,async()=>{},createHash,recoveryChooserTarget,recoveryChooserFacts,initializedRecoveryChooser);
  }catch(caught){error=caught;}
  return {receipts,dispatches,targetCalls,connectCalls,selected,closed,sleeps,exits,exitCode:p.exitCode,error,timersRemaining:timers.size,now,uiCalls};
}
test('exact owned initialized chooser precedes the one actual existing dispatch',async()=>{
  const r=await runOpen({pages:[[{id:'blank',url:'about:blank'}],[chooserPage],[{id:'foreign',url:'app://obsidian.md/index.html'},chooserPage]],facts:[{documentReady:false,inner:0,ipc:true},{documentReady:true,inner:1,ipc:true}]});
  assert.equal(r.receipts.at(-1).result,'READY');assert.equal(r.dispatches,1);assert.deepEqual(r.selected,['owned-chooser','owned-chooser']);assert.deepEqual(r.sleeps,[200,200]);assert.equal(r.timersRemaining,0);
  const f=r.receipts.at(-1).openReadiness;assert.ok(f,'successful opening requires retained readiness evidence');assert.equal(f.elapsedMs,400);assert.equal(f.initializedChooserObserved,true);assert.equal(f.dispatchAttempts,1);assert.equal(f.chooserPolls,3);assert.equal(f.chooserTargetIdSha256,createHash('sha256').update('owned-chooser').digest('hex'));assert.equal(f.detachedCheckCompleted,true);assert.equal(f.settingsCheckCompleted,true);assert.equal(f.serverUrlCheckCompleted,true);assert.equal(JSON.stringify(r.receipts.at(-1)).includes('owned-chooser'),false);assert.equal(JSON.stringify(r.receipts.at(-1)).includes('app://'),false);
});
test('foreign, ambiguous, changed, malformed or missing chooser identity never dispatches',async()=>{
  for(const options of [{pages:[[{id:'foreign',url:'app://obsidian.md/index.html'}]]},{pages:[[chooserPage,{...chooserPage,id:'other'}]]},{facts:[{documentReady:true,inner:1,ipc:true,url:'about:blank'}]},{missingFacts:true},{changedAtDispatch:true}]){
    const r=await runOpen(options);assert.equal(r.dispatches,0);assert.equal(r.receipts.at(-1).result,'FAIL');assert.equal(r.timersRemaining,0);
  }
  const ready={exactUrl:true,documentReady:true,starterInnerCount:1,callableIpc:true};assert.equal(initializedRecoveryChooser(ready),true);
  for(const key of Object.keys(ready)){const missing={...ready};delete missing[key];assert.throws(()=>initializedRecoveryChooser(missing));}
  for(const change of [{exactUrl:false},{documentReady:false},{starterInnerCount:0},{callableIpc:false}])assert.equal(initializedRecoveryChooser({...ready,...change}),false);
  assert.throws(()=>initializedRecoveryChooser({...ready,secret:'sentinel'}));assert.throws(()=>recoveryChooserTarget([{url:chooserPage.url}]));
});
test('failed pre-dispatch HTTP, WebSocket or evaluation is terminal without retry',async()=>{
  for(const options of [{targetError:'network refused'},{connectError:'CDP connection failed'},{evaluateError:'CDP deadline'}]){
    const r=await runOpen(options);assert.equal(r.receipts.at(-1).result,'FAIL');assert.equal(r.dispatches,0);assert.equal(r.targetCalls,1);assert.ok(r.connectCalls<=1);assert.equal(r.sleeps.length,0);assert.equal(r.timersRemaining,0);
  }
});
test('expired or late chooser, plugin or final evaluation cannot produce late READY',async()=>{
  for(const key of ['lateTargets','lateChooser','latePlugin','lateFinal']){
    const r=await runOpen({[key]:true});assert.equal(r.receipts.at(-1).result,'FAIL',key);assert.equal(r.exitCode,1,key);assert.equal(r.receipts.some(x=>x.result==='READY'),false,key);assert.equal(r.timersRemaining,0,key);assert.ok(r.dispatches<=1,key);assert.ok(r.receipts.at(-1).openReadiness.elapsedMs>=45000,key);if(key==='lateTargets')assert.equal(r.connectCalls,0);if(key==='lateChooser')assert.equal(r.dispatches,0);if(key==='latePlugin')assert.equal(r.uiCalls,0);
  }
});
test('watchdog refuses once even if its diagnostic writer fails; no READY survives',async()=>{
  for(const writeError of [false,true]){
    const r=await runOpen({pages:[[]],watchdog:true,writeError});assert.deepEqual(r.exits,[1]);assert.equal(r.dispatches,0);assert.equal(r.receipts.some(x=>x.result==='READY'),false);assert.equal(r.timersRemaining,0);
    if(writeError)assert.ok(r.error);else {assert.equal(r.receipts[0].stage,'open-deadline');assert.equal(r.receipts[0].openReadiness.elapsedMs,45000);}
  }
});
test('synchronous READY receipt I/O overrun is final FAIL and nonzero, never admitted',async()=>{
  const r=await runOpen({lateRecord:true});assert.equal(r.receipts.at(-1).result,'FAIL');assert.equal(r.exitCode,1);assert.equal(r.timersRemaining,0);assert.ok(r.receipts.at(-1).openReadiness.elapsedMs>=45000);
  const collision=await runOpen({lateRecord:true,failWriter:true});assert.ok(collision.error,'failed FAIL receipt must remain an uncaught nonzero CLI error');assert.equal(collision.timersRemaining,0);
});
test('existing dispatch navigation replacement remains allowed, never redispatched',async()=>{
  const r=await runOpen({navigationAfterDispatch:true});assert.equal(r.receipts.at(-1).result,'READY');assert.equal(r.receipts.at(-1).openReadiness.initialDispatch,'REFUSED_OR_TARGET_REPLACED');assert.equal(r.dispatches,1);assert.equal(r.timersRemaining,0);
  assert.equal((openSource.match(/ipcRenderer\.sendSync\('vault-open',P\.vault,false\)/g)??[]).length,1);
  for(const exact of ["p.state.data.deviceSecret!==null","p.state.custody2()!==null","p.state.data.vrk!==null","fresh detached vault required","await settings();","p.state.data.serverUrl===P.url","Trust author and enable plugins","if(!trusted)throw Error('fresh owned vault/plugin not ready')"])assert.ok(openSource.includes(exact),exact);
});
