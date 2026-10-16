// Offline exact folder-index diagnostic controls. No Android/native actions.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {waitFolderIndex} from '../android-journey.mjs';
import {scriptJson} from './cdp.mjs';
const source=readFileSync(new URL('../android-journey.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function fixture(){
 let clock=0,folder=null,files=[],ids={},markdownReads=0;const pauses=[];
 const app={vault:{getAbstractFileByPath:()=>folder,getMarkdownFiles:()=>{markdownReads++;return files;}},plugins:{plugins:{'obsync-private-sync':{state:{fileByPath:path=>ids[path]===undefined?undefined:{fileId:ids[path]}}}}}};
 return {app,now:()=>clock,pause:async ms=>{pauses.push(ms);clock+=ms;},set(value){({folder,files=[],ids={}}=value);},get pauses(){return pauses;},get markdownReads(){return markdownReads;}};
}
const files=[{path:'Team docs/One.md'},{path:'Team docs/Two.md'}],valid=Object.fromEntries(files.map((f,i)=>[f.path,String(i+1).repeat(32)]));
test('absent folder remains absent for exactly original100polls/10s with no descendant reads',async()=>{
 const f=fixture(),r=await waitFolderIndex(f.app,'Team docs',f.pause,f.now);
 assert.equal(r.ready,false);assert.equal(r.polls,100);assert.equal(r.elapsedMs,10000);assert.equal(r.deadlineMs,10000);assert.equal(f.markdownReads,0);assert.equal(f.pauses.length,100);assert.ok(f.pauses.every(ms=>ms===100));
 assert.deepEqual(r.first,{folderPresent:false,childrenArray:false,descendantCount:null,missingOrInvalidIdentityCount:null});assert.deepEqual(r.last,r.first);
 const invalid=fixture();invalid.set({folder:{children:{}},files,ids:valid});const noChildren=await waitFolderIndex(invalid.app,'Team docs',invalid.pause,invalid.now);assert.equal(noChildren.ready,false);assert.equal(noChildren.last.folderPresent,true);assert.equal(noChildren.last.childrenArray,false);assert.equal(invalid.markdownReads,0);
});
test('present folder with missing or malformed identities reports exact safe counts and cannot pass',async()=>{
 const f=fixture();f.set({folder:{children:[]},files,ids:{[files[0].path]:'A'.repeat(32)}});const r=await waitFolderIndex(f.app,'Team docs',f.pause,f.now);
 assert.equal(r.ready,false);assert.equal(r.polls,100);assert.equal(r.elapsedMs,10000);assert.equal(r.last.folderPresent,true);assert.equal(r.last.childrenArray,true);assert.equal(r.last.descendantCount,2);assert.equal(r.last.missingOrInvalidIdentityCount,2);
 assert.equal(r.rows,undefined);assert.ok(!JSON.stringify(r).includes('Team docs'));assert.ok(!JSON.stringify(r).includes('AAAA'));
});
test('ordinary index convergence returns original rows after100ms polls with first/last facts',async()=>{
 const f=fixture();let reads=0;f.app.vault.getAbstractFileByPath=()=>{reads++;if(reads===1)return null;if(reads===2)return {children:null};return {children:[]};};
 f.app.vault.getMarkdownFiles=()=>files;f.app.plugins.plugins['obsync-private-sync'].state.fileByPath=path=>reads<4?undefined:{fileId:valid[path]};
 const r=await waitFolderIndex(f.app,'Team docs',f.pause,f.now);assert.equal(r.ready,true);assert.equal(r.polls,4);assert.equal(r.elapsedMs,300);assert.equal(r.first.folderPresent,false);assert.equal(r.last.missingOrInvalidIdentityCount,0);assert.deepEqual(r.rows,files.map(f=>({path:f.path,id:valid[f.path]})));
});
test('32descendant bound is unchanged and empty native folder keeps the original predicate',async()=>{
 const f=fixture();f.set({folder:{children:[]},files:Array.from({length:33},(_,i)=>({path:'Team docs/'+i+'.md'}))});const over=await waitFolderIndex(f.app,'Team docs',f.pause,f.now);assert.equal(over.boundExceeded,true);assert.equal(over.ready,false);assert.equal(over.polls,1);assert.equal(over.elapsedMs,0);assert.equal(over.last.descendantCount,33);assert.equal(f.pauses.length,0);
 f.set({folder:{children:[]}});const empty=await waitFolderIndex(f.app,'Team docs',f.pause,f.now);assert.equal(empty.ready,true);assert.deepEqual(empty.rows,[]);assert.equal(empty.polls,1);
});
const begin=source.indexOf('      const observed=await evaluate(`return await (${waitFolderIndex.toString()})(app,P.folder);`'),end=source.indexOf("      device('shell','test','-d'",begin);assert.ok(begin>0&&end>begin);
const host=source.slice(begin,end);
const executeHost=new AsyncFunction('evaluate','folder','waitFolderIndex',`let folderIndexReadiness;try{${host};return {files,folderIndexReadiness};}catch(error){return {reason:error.message,folderIndexReadiness};}`);
function renderer(app,f){
 const start=source.indexOf('  async function evaluate(body, params = {}, requireVault = true,budgetMs=30000) {'),end=source.indexOf('\n  async function connect(',start);assert.ok(start>0&&end>start);
 const fn=new Function('send','scriptJson','ownedVault','input','safeExceptionMessage','readFileSync','moduleUrl',source.slice(start,end).replaceAll('import.meta.url','moduleUrl')+';return evaluate;');
 return fn(async(method,params,budget)=>{assert.equal(method,'Runtime.evaluate');assert.equal(params.timeout,25000);assert.equal(budget,30000);new Function(params.expression);const value=await new AsyncFunction('app','window','Date','setTimeout','return '+params.expression)(app,{app},{now:f.now},(callback,ms)=>{f.pause(ms);callback();});return {result:{result:{value}}};},scriptJson,()=>'/synthetic',{},()=>{throw Error('unexpected renderer failure');},readFileSync,import.meta.url);
}
test('actual serialized helper compiles through actual Android CDP prelude and host preserves deadline failure facts',async()=>{
 const f=fixture();f.app.vault.adapter={basePath:'/synthetic'};const result=await executeHost(renderer(f.app,f),'Team docs',waitFolderIndex);
 assert.equal(result.reason,'native folder index deadline');assert.equal(result.folderIndexReadiness.ready,false);assert.equal(result.folderIndexReadiness.polls,100);assert.equal(result.folderIndexReadiness.elapsedMs,10000);assert.equal(result.folderIndexReadiness.first.folderPresent,false);assert.equal(Object.hasOwn(result.folderIndexReadiness,'rows'),false);
});
test('actual host bound failure and success retain facts without raw rows in diagnostics',async()=>{
 const f=fixture();f.app.vault.adapter={basePath:'/synthetic'};f.set({folder:{children:[]},files,ids:valid});const good=await executeHost(renderer(f.app,f),'Team docs',waitFolderIndex);assert.deepEqual(good.files,files.map(f=>({path:f.path,id:valid[f.path]})));assert.equal(good.folderIndexReadiness.ready,true);assert.equal(JSON.stringify(good.folderIndexReadiness).includes('Team docs'),false);
 f.set({folder:{children:[]},files:Array.from({length:33},(_,i)=>({path:'Team docs/'+i+'.md'}))});const over=await executeHost(renderer(f.app,f),'Team docs',waitFolderIndex);assert.equal(over.reason,'bounded synthetic folder required');assert.equal(over.folderIndexReadiness.boundExceeded,true);
});
test('actual PASS and FAIL receipt objects retain only safe folder observation facts',()=>{
 const facts={ready:false,first:{folderPresent:false},last:{folderPresent:true,childrenArray:true,descendantCount:2,missingOrInvalidIdentityCount:2},polls:100,elapsedMs:10000,deadlineMs:10000};
 const pass=/receipt\(\{result:'PASS',folder,descendants:rows.length,independentAdbBytes:true[^\n]+\}\);/.exec(source)?.[0];assert.ok(pass);
 let result;new Function('receipt','folder','rows','input','folderIndexReadiness',pass)(r=>result=r,'Team docs',[{},{}],{},facts);assert.equal(result.folderIndexReadiness,facts);
 const fail=/receipt\(\{ result: 'FAIL',stage,failureClass:[^\n]+\}\);/.exec(source)?.[0];assert.ok(fail);
 const fields=['stage','nativeObservations','startupReadiness','enableReadiness','communityTrustReadiness','pointerReadiness','pointerWitness','controlReadiness','serverUrlReadiness','pairingReadiness','scopeSaveReadiness','knownNotesIndexReadiness','persistedNoteReadback','noteReadiness','replacementReadiness','installReadbacks','folderIndexReadiness'];
 new Function('receipt','error','generated','externalFailure',...fields,fail)(r=>result=r,Error('native folder index deadline'),new Set(['native folder index deadline']),()=>({}),...fields.map(n=>n==='folderIndexReadiness'?facts:undefined));assert.equal(result.folderIndexReadiness,facts);assert.equal(result.reason,'native folder index deadline');
});
