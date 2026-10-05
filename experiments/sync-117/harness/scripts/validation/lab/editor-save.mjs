#!/usr/bin/env node
// Never-merge experiment: public editor save after 300 ms, then normal encrypted sync.
// A buffer is never substituted for a disk read or marked durable by this harness.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connect, manifest, sleep } from './cdp.mjs';
const [run] = process.argv.slice(2), state = manifest(run);
const clients = {A:await connect(state,'A'),B:await connect(state,'B')};
const result={result:'RUNNING',kind:'public-editor-save-300ms',physicalPhone:'NOT_RUN',cases:[],limits:['Normal disk publication and receiver editing holds remain enabled.','This measures an earlier public save, not direct publication of an unsaved buffer.']};
const save=()=>writeFileSync(join(run,'evidence/editor-save.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
async function until(fn,label,ms=60000){const end=Date.now()+ms;do{if(await fn())return;await sleep(50);}while(Date.now()<end);throw Error(label+' deadline');}
async function exact(path,text){for(const n of ['A','B']){try{if(readFileSync(join(state.devices[n].vault,path),'utf8')!==text)return false;}catch{return false;}
 if(!await clients[n].evaluate(`const p=app.plugins.plugins['obsync-private-sync'];return app.workspace.getMostRecentLeaf()?.view?.file?.path===P.path && app.workspace.getMostRecentLeaf()?.view?.editor?.getValue()===P.text && p.currentStatus().kind==='idle';`,{text,path}))return false;}return true;}
async function mode(enabled){
 const answers=await Promise.allSettled(Object.values(clients).map(c=>c.evaluate(`
 if(window.__earlySave){const old=window.__earlySave;
  app.workspace.offref(old.ref);document.removeEventListener('beforeinput',old.input,true);document.removeEventListener('compositionstart',old.begin,true);document.removeEventListener('compositionend',old.end,true);
  for(const t of old.timers.values())clearTimeout(t);
  try{await old.active;}catch{old.failed=true;}finally{delete window.__earlySave;}
  if(old.failed)return {failed:true};
 }
 if(!P.enabled)return {removed:true};
 const s={timers:new Map(),active:Promise.resolve(),events:[],composing:false,seq:0,lastInput:0,failed:false,ref:null};window.__earlySave=s;
 s.begin=()=>{s.composing=true;};s.end=()=>{s.composing=false;};s.input=e=>{if(e.isTrusted){s.seq++;s.lastInput=Date.now();}};
 document.addEventListener('beforeinput',s.input,true);document.addEventListener('compositionstart',s.begin,true);document.addEventListener('compositionend',s.end,true);
 s.ref=app.workspace.on('editor-change',(editor,view)=>{
  if(s.seq===0 || !/^editor-lab-[0-9]+-(baseline|early)\\.md$/.test(view?.file?.path??'') || typeof view.save!=='function')return;
  const path=view.file.path,generation=s.seq;clearTimeout(s.timers.get(path));
  s.timers.set(path,setTimeout(()=>{s.timers.delete(path);const text=editor.getValue();
   s.active=s.active.then(async()=>{if(s.composing || generation!==s.seq || view.file?.path!==path || editor.getValue()!==text)return;
    const bufferDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(s.composing || generation!==s.seq || view.file?.path!==path || editor.getValue()!==text)return;
    const started=Date.now();await view.save();s.events.push({path,generation,lastInput:s.lastInput,started,finished:Date.now(),bufferDigest});
   }).catch(()=>{s.failed=true;});
  },300));
 });return {installed:true};`,{enabled})));
 if(answers.some(x=>x.status==='rejected'||x.value?.failed))throw Error('public save or hook cleanup failed');
}
try{
 for(let trial=0;trial<40;trial++)for(const arm of (Math.floor(trial/2)%2?['early','baseline']:['baseline','early'])){
  await mode(false);const path=`editor-lab-${trial}-${arm}.md`,base='A: \nB: \n';
  await clients.A.evaluate(`if(app.vault.getAbstractFileByPath(P.path))throw Error('fresh path required');await app.vault.create(P.path,P.base);return true;`,{path,base});
  for(const n of ['A','B'])await clients[n].evaluate(`const f=await wait(()=>app.vault.getAbstractFileByPath(P.path),'note',60000);await app.workspace.getLeaf(false).openFile(f,{state:{mode:'source'}});await wait(()=>app.workspace.getMostRecentLeaf()?.view?.editor?.getValue()===P.base,'editor',60000);const e=app.workspace.getMostRecentLeaf().view.editor;e.focus();e.setCursor({line:P.line,ch:3});return true;`,{path,base,line:n==='A'?0:1});
  await until(()=>exact(path,base),'initial bytes');await mode(arm==='early');
  const both=trial>=20,writer=trial%2?'B':'A',actors=both?['A','B']:[writer],seq={A:'ABCD',B:'abcd'};
  const row={trial,arm,kind:both?'overlap':writer+'-to-peer',started:Date.now()};result.cases.push(row);save();
  const inputEnds=await Promise.all(actors.map(async n=>{let last;for(let i=0;i<seq[n].length;i++){await clients[n].insertText(seq[n][i]);last=Date.now();if(i+1<seq[n].length)await sleep(100);}return last;}));row.inputEnded=Math.max(...inputEnds);
  const expected=`A: ${actors.includes('A')?seq.A:''}\nB: ${actors.includes('B')?seq.B:''}\n`;
  row.localDiskAfterInputMs={};await until(async()=>{for(const n of actors){const own=`A: ${n==='A'?seq.A:''}\nB: ${n==='B'?seq.B:''}\n`;if(row.localDiskAfterInputMs[n]===undefined && readFileSync(join(state.devices[n].vault,path),'utf8')===own)row.localDiskAfterInputMs[n]=Date.now()-row.inputEnded;}return exact(path,expected);},'editor and disk convergence');row.convergenceAfterInputMs=Date.now()-row.inputEnded;
  row.sha256=createHash('sha256').update(expected).digest('hex');row.independentDiskAndEditor=true;
  row.saveEvents={};for(const n of ['A','B']){row.saveEvents[n]=await clients[n].evaluate(`return window.__earlySave?.events??[];`);
   if(readdirSync(state.devices[n].vault).some(x=>x.startsWith(path.slice(0,-3)+' ')))throw Error('conflict copy');}
  if(arm==='early'&&!actors.every(n=>row.saveEvents[n].some(x=>x.path===path && x.generation===seq[n].length && x.bufferDigest===createHash('sha256').update(`A: ${n==='A'?seq.A:''}\nB: ${n==='B'?seq.B:''}\n`).digest('hex'))))throw Error('public save hook did not execute');
  if(trial===0||trial===39)for(const n of ['A','B'])await clients[n].screenshot(`editor-save-${trial}-${arm}-${n}`);
  for(const n of actors)row.localDiskAfterInputMs[n]??=null;row.localDiskPollingMs=50;row.result='PASS';save();
 }
 result.result='SCENARIO_PASS';result.teardown='REQUIRED_PARENT_RECEIPT';save();
}catch(e){result.result='FAIL';result.reason=e.message;save();throw e;}finally{try{await mode(false);result.hooksRemoved=true;}catch{result.result='FAIL';result.cleanupFailure=true;}finally{for(const c of Object.values(clients))c.close();save();}}
if(result.result!=='SCENARIO_PASS')throw Error('experiment failed; inspect reduced receipt');
console.log(JSON.stringify({result:result.result,cases:result.cases.length,teardown:'PENDING_PARENT'}));
