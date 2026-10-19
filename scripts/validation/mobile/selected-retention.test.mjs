// Offline persisted snapshot controls, never native acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,realpathSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {digest} from './desktop-guard.mjs';
const {retainSelectedSnapshot,unchangedQuiet}=await import(process.env.OBSYNC_SELECTED_RETENTION_MODULE??'./selected-desktop.mjs');
const source=readFileSync(process.env.OBSYNC_SELECTED_RETENTION_MODULE??new URL('./selected-desktop.mjs',import.meta.url),'utf8');
const hex=(c,n=64)=>c.repeat(n);
const snapshot=folder=>({schema:1,sourceHead:hex('a',40),generation:hex('b',32),folder,notes:['One.md','Two.md'].map((suffix,i)=>({suffix,fileId:hex(String(i+1),32),versionId:hex(String(i+3)),sha256:hex(String(i+5))})),records:[1,2,9].map(i=>({fileId:hex(String(i),32),heads:[hex(String(i===9?9:i+2))],versions:[{id:hex(String(i===9?9:i+2)),parents:[],deleted:false}]}))});
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'obsync-selected-retained-')));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'evidence'),{mode:0o700});return root;}
test('retained snapshots preserve exact independently replayable ancestry inputs',t=>{
 const run=fixture(t);
 for(const label of ['original','down','up','quiet-down','quiet-up']){
  const input=snapshot(['down','quiet-down'].includes(label)?'team docs':'Team docs'),entry=retainSelectedSnapshot(run,label,input),raw=readFileSync(join(run,entry.path));
  assert.equal(entry.bytes,raw.length);assert.equal(entry.sha256,digest(raw));assert.deepEqual(JSON.parse(raw),input);unchangedQuiet(input,JSON.parse(raw));
  assert.throws(()=>retainSelectedSnapshot(run,label,input));
 }
});
test('empty, altered, wrong-source and malformed selected snapshots cannot be retained',t=>{
 const run=fixture(t);
 for(const alter of [s=>s.notes=[],s=>s.records=[],s=>s.sourceHead='wrong',s=>s.notes[0].sha256='bad',s=>s.records[0].versions=[],s=>s.notes[0].versionId='bad']){
  const input=snapshot('Team docs');alter(input);assert.throws(()=>retainSelectedSnapshot(run,'original',input));
 }
 assert.throws(()=>retainSelectedSnapshot(run,'unknown',snapshot('Team docs')));
});
test('actual quiet loop retains its last validated snapshot after the original300s window',async t=>{
 const run=fixture(t),start=source.indexOf("    const folder=command==='watch-down'"),end=source.indexOf('\n  const receipt=',start);assert.ok(start>0&&end>start);
 const body=source.slice(start,end).replace(/\n  }\s*$/,'');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const command of ['watch-down','watch-up']){
  let now=0,polls=0;const entries=[],input=snapshot(command==='watch-down'?'team docs':'Team docs');
  const execute=new AsyncFunction('command','state','privateRead','snapshot','unchangedQuiet','sleep','performance','retainSelectedSnapshot','retainedSnapshots','c','join',`let watchElapsed;${body};return watchElapsed;`);
  const elapsed=await execute(command,{run,secrets:'unused'},()=>JSON.stringify(input),async()=>{polls++;return structuredClone(input);},unchangedQuiet,async ms=>{now+=ms;},{now:()=>now},retainSelectedSnapshot,entries,{consoleSummary:{windowStartedAtEpochMs:1,windowErrors:0,windowExceptions:0,incomingManifestScopeRefusals:0}},join);
  assert.equal(elapsed,300000);assert.equal(polls,11);assert.equal(entries.length,1);assert.equal(entries[0].label,command==='watch-down'?'quiet-down':'quiet-up');assert.deepEqual(JSON.parse(readFileSync(join(run,entries[0].path))),input);
 }
});
