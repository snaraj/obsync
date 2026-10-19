// Actual driver controls with finite offline DOM/CDP fixtures, never native acceptance.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {pointerTarget,pointerObservation,pointerWitnessMatches,scopeSaveObservation,waitScopeSave,waitPointerReadiness} from '../android-journey.mjs';
const source=readFileSync(new URL('../android-journey.mjs',import.meta.url),'utf8'),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const begin=source.indexOf('      const scopeSaveStarted=Date.now()'),end=source.indexOf("    } else if (command === 'status')",begin);assert.ok(begin>0&&end>begin);
const clickStart=source.indexOf('  async function trustedPointerClick('),clickEnd=source.indexOf('  async function readyNativeStartup()',clickStart);assert.ok(clickStart>0&&clickEnd>clickStart);
const scopeDom=/const scopeDom=`([^`]+)`;/.exec(source)?.[1];assert.ok(scopeDom);
const execute=new AsyncFunction('evaluate','send','input','pointerTarget','pointerObservation','pointerWitnessMatches','scopeSaveObservation','waitScopeSave','Date','scopeDom','waitPointerReadiness',`let scopeSaveReadiness,pointerWitness,pointerReadiness,stage;const receipts=[];const receipt=r=>receipts.push(r);${source.slice(clickStart,clickEnd)};try{${source.slice(begin,end)};return {result:'PASS',scopeSaveReadiness,pointerWitness,pointerReadiness,receipts};}catch(error){return {result:'FAIL',reason:error.message,scopeSaveReadiness,pointerWitness,pointerReadiness,stage};}`);
async function scenario(mode='good'){
 const model={now:0,press:0,release:0,click:0,policyAt:Infinity,pointerReads:0,scrolls:0},listeners=new Map();let document;
 const visible={getClientRects:()=>[{}],getBoundingClientRect:()=>({x:0,y:0,width:100,height:30})};
 const row=name=>({...visible,querySelector:s=>s==='.setting-item-name'?{textContent:name}:s==='textarea'?textarea:null,querySelectorAll:s=>s==='button'?[name==='Save on this device'?local:foreign]:[]});
 const textarea={value:mode==='wrongdraft'?'wrong':'Team docs'},selected=row('Selected folders'),saveRow=row('Save on this device'),foreignRow=row('Save to server');
 const button=(name,owner,x)=>({textContent:name,disabled:false,isConnected:true,ownerDocument:null,getClientRects:()=>[{}],getBoundingClientRect(){if(owner===saveRow){model.pointerReads++;if(mode==='never-stable')x=Math.floor(model.now/100)%2?20:80;if(mode==='moved'&&model.now>=500)x=80;if(mode==='motion')x=model.now<400?20:model.now<600?100:160;}return {x,y:20,width:100,height:40};},scrollIntoView(){model.scrolls++;},contains:()=>false,closest:s=>s==='.setting-item'?owner:null});
 const local=button('Save',saveRow,20),foreign=button('Save',foreignRow,160);
 const confirmButtons=['Cancel','Save anyway'].map(textContent=>({...visible,textContent}));
 document={defaultView:{innerWidth:400,innerHeight:800},querySelectorAll(selector){
  if(selector==='.setting-item')return [selected,saveRow,foreignRow];
  if(selector==='.modal.mod-settings .setting-item button')return mode==='foreign-only'?[foreign]:[local,foreign];
  if(selector==='.modal:not(.mod-settings)')return mode==='confirmation'?[{...visible,querySelectorAll:()=>confirmButtons}]:[];
  if(selector==='.notice')return mode==='refusal'?[{...visible,textContent:'That selection cannot be saved: each line must be a folder inside this vault, such as Notes or Projects/2026. Folders whose names start with a dot are hidden and never synced.'}]:[];
  throw Error('unexpected fixture selector');
 },elementFromPoint:()=>mode==='occluded'?foreign:local,addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener:(type,listener)=>{assert.equal(listeners.get(type),listener);listeners.delete(type);}};
 local.ownerDocument=foreign.ownerDocument=document;
 const state={get syncFolders(){return model.now>=model.policyAt?['Team docs']:undefined;}},app={vault:{getAbstractFileByPath:()=>mode==='confirmation'?null:{children:[]}},plugins:{plugins:{'obsync-private-sync':{state:{data:state},changingScope:false}}}};
 const window={obsyncJourneyScopeInput:true};document.defaultView.app=app;
 const virtualDate={now:()=>model.now},virtualTimeout=(f,ms)=>{model.now+=ms;f();};const evaluate=async(body,P={},requireVault=true,budget=30000)=>{assert.ok(budget>0&&budget<=30000);assert.ok(model.now+budget<=30000,'all Save reads share original30s');model.now+=100;if(model.now>30000)throw Error('fixture budget exceeded');new Function(`return (async()=>{${body}})()`);return new AsyncFunction('app','document','window','P','Date','setTimeout',body)(app,document,window,P,virtualDate,virtualTimeout);};
 const send=async(method,p,budget)=>{assert.equal(method,'Input.dispatchMouseEvent');assert.ok(budget>0&&model.now+budget<=30000);model.now+=100;const target=mode==='wrongtarget'?foreign:local,event={isTrusted:mode!=='untrusted',target,composedPath:()=>[target]};
  if(p.type==='mousePressed'){model.press++;listeners.get('mousedown')?.(event);}
  else{model.release++;listeners.get('mouseup')?.(event);model.click++;listeners.get('click')?.(event);if(!['unchanged','confirmation','refusal'].includes(mode))model.policyAt=mode==='late'?30100:model.now;}
 };
 const wait=(read,_pause,_now,budget,deadline)=>waitScopeSave(read,async ms=>{model.now+=ms;},()=>model.now,budget,deadline);
 const result=await execute(evaluate,send,{folders:['Team docs']},pointerTarget,pointerObservation,pointerWitnessMatches,scopeSaveObservation,wait,{now:()=>model.now},scopeDom,waitPointerReadiness);
 return {...result,model};
}
test('actual Save uses one trusted row-scoped click and the same30s for action and policy',async()=>{
 const r=await scenario();assert.equal(r.result,'PASS');assert.equal(r.model.scrolls,1);assert.equal(r.pointerReadiness.requiredStableMs,200);assert.ok(r.pointerReadiness.observedStableMs>=200);assert.deepEqual([r.model.press,r.model.release,r.model.click],[1,1,1]);assert.ok(r.scopeSaveReadiness.elapsedMs<30000);assert.equal(r.scopeSaveReadiness.after.policyMatches,true);assert.equal(r.scopeSaveReadiness.before.renderedDraftMatches,true);assert.equal(r.pointerWitness.click.expectedTargetMatched,true);assert.equal(r.receipts[0].pointerWitness,r.pointerWitness);
});
test('moved or foreign-row target cannot dispatch a Save; wrong target and untrusted events refuse even with adopted policy',async()=>{
 for(const mode of ['moved','foreign-only','wrongtarget','untrusted']){const r=await scenario(mode);assert.equal(r.result,'FAIL',mode);assert.match(r.reason,/moved|absent or ambiguous|trusted click not delivered/);assert.ok(r.model.click<=1);if(['moved','foreign-only'].includes(mode))assert.equal(r.model.click,0);}
});
test('actual one click cannot rescue unchanged or late policy and never resets the originalSave budget',async()=>{
 for(const mode of ['unchanged','late']){const r=await scenario(mode);assert.equal(r.result,'FAIL',mode);assert.equal(r.reason,'saved selected scope deadline');assert.equal(r.model.click,1);assert.equal(r.scopeSaveReadiness.deadlineMs,30000);assert.equal(r.scopeSaveReadiness.ready,false);assert.equal(r.scopeSaveReadiness.elapsedMs,30000);}
});
test('safe failure facts distinguish missing-folder confirmation, known refusal and mismatched public draft',async()=>{
 const confirm=await scenario('confirmation');assert.equal(confirm.result,'FAIL');assert.equal(confirm.scopeSaveReadiness.before.exactFolderPresent,false);assert.equal(confirm.scopeSaveReadiness.after.knownConfirmationModalVisible,true);
 const refusal=await scenario('refusal');assert.equal(refusal.scopeSaveReadiness.after.knownRefusalVisible,true);
 const draft=await scenario('wrongdraft');assert.equal(draft.result,'FAIL');assert.equal(draft.model.click,0);assert.equal(draft.scopeSaveReadiness.before.renderedDraftMatches,false);
 for(const r of [confirm,refusal,draft]){const facts=JSON.stringify(r.scopeSaveReadiness);assert.equal(facts.includes('Team docs'),false);assert.equal(facts.includes('That selection'),false);}
});
test('original absolute scope deadline refuses policy returned just after its final read budget',async()=>{
 let clock=29900;const r=await waitScopeSave(async budget=>{assert.equal(budget,100);clock=30001;return {changingScope:false,policyMatches:true};},async ms=>{clock+=ms;},()=>clock,30000,30000);assert.equal(r.ready,false);assert.equal(r.polls,1);
});

test('actual serialized settling resets for motion and final witness recheck never scrolls again',async()=>{
 const r=await scenario('motion');assert.equal(r.result,'PASS');assert.equal(r.model.scrolls,1);assert.equal(r.pointerReadiness.coordinateChanges,2);assert.ok(r.pointerReadiness.observedStableMs>=200);assert.equal(r.pointerReadiness.x,210);assert.equal(r.pointerReadiness.polls,7);assert.equal(r.model.click,1);assert.ok(r.scopeSaveReadiness.elapsedMs>=1000);
});
test('permanent occlusion or motion exhausts finite observation without dispatching',async()=>{
 for(const mode of ['occluded','never-stable']){const r=await scenario(mode);assert.equal(r.result,'FAIL');assert.equal(r.reason,'ordinary scope Save pointer readiness deadline');assert.equal(r.pointerReadiness.ready,false);assert.equal(r.model.click,0);assert.equal(r.model.scrolls,1);assert.ok(r.scopeSaveReadiness.elapsedMs<=30000);}
});
