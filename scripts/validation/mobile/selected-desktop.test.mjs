import test from 'node:test';
import assert from 'node:assert/strict';
import {preservedRename,unchangedQuiet} from './selected-desktop.mjs';
const hex=(character,size=64)=>character.repeat(size);
const before=()=>({sourceHead:hex('a',40),generation:hex('b',32),folder:'Team docs',notes:[
  {suffix:'One.md',fileId:hex('1',32),versionId:hex('3'),sha256:hex('5')},
  {suffix:'Two.md',fileId:hex('2',32),versionId:hex('4'),sha256:hex('6')}],
  records:[{fileId:hex('1',32),heads:[hex('3')],versions:[{id:hex('3'),parents:[],deleted:false}]},
    {fileId:hex('2',32),heads:[hex('4')],versions:[{id:hex('4'),parents:[],deleted:false}]},
    {fileId:hex('d',32),heads:[hex('d')],versions:[{id:hex('d'),parents:[],deleted:false}]},
    {fileId:hex('e',32),heads:[hex('e')],versions:[{id:hex('e'),parents:[],deleted:true}]}]});
function rename(input=before(),folder='team docs',characters=['7','8']){
  const value=structuredClone(input);value.folder=folder;
  for(const [i,note] of value.notes.entries()){
    const previous=note.versionId;note.versionId=hex(characters[i]);
    const record=value.records.find(r=>r.fileId===note.fileId);record.heads=[note.versionId];
    record.versions.push({id:note.versionId,parents:[previous],deleted:false});record.versions.sort((a,b)=>a.id.localeCompare(b.id));
  }
  return value;
}
test('each rename may publish a new path manifest preserving identity, bytes and ancestry',()=>{
  const original=before(),down=rename(original),up=rename(down,'Team docs',['9','a']);
  assert.doesNotThrow(()=>preservedRename(original,down));assert.doesNotThrow(()=>preservedRename(down,up));
  assert.notEqual(original.notes[0].versionId,down.notes[0].versionId);
});
test('rename rejects lost history, detached heads, tombstones and changed bytes/identities',()=>{
  for(const alter of [s=>s.records[0].versions.shift(),s=>s.records[0].versions.at(-1).parents=[],
    s=>s.records[0].versions.at(-1).deleted=true,s=>s.records[0].versions.push({id:hex('c'),parents:[],deleted:false}),
    s=>s.notes[0].sha256=hex('0'),s=>s.notes[0].fileId=hex('0',32),s=>s.generation=hex('0',32),
    s=>s.sourceHead=hex('0',40),s=>s.records[0].heads.push(hex('3'))]){
    const after=rename();alter(after);assert.throws(()=>preservedRename(before(),after));
  }
  const changedPrior=rename();changedPrior.records[0].versions[0].parents=[hex('9')];
  changedPrior.records[0].versions.push({id:hex('9'),parents:[],deleted:false});
  assert.throws(()=>preservedRename(before(),changedPrior));
  const missingPublication=before();missingPublication.folder='team docs';
  assert.throws(()=>preservedRename(before(),missingPublication));
});
test('return rename must preserve the first rename version, not only original history',()=>{
  const down=rename(),up=rename(down,'Team docs',['9','a']);
  up.records[0].versions=up.records[0].versions.filter(v=>v.id!==hex('7'));
  up.records[0].versions.find(v=>v.id===hex('9')).parents=[hex('3')];
  assert.throws(()=>preservedRename(down,up));
});
test('quiet requires exact heads and histories for notes and current/retired folders',()=>{
  const baseline=rename();assert.doesNotThrow(()=>unchangedQuiet(baseline,structuredClone(baseline)));
  const extraNote=rename(baseline,baseline.folder,['9','a']);
  assert.doesNotThrow(()=>preservedRename(baseline,extraNote));
  assert.throws(()=>unchangedQuiet(baseline,extraNote));
  for(const index of [2,3]){
    const changed=structuredClone(baseline);changed.records[index].versions.push({id:hex('f'),parents:[changed.records[index].heads[0]],deleted:true});
    assert.throws(()=>unchangedQuiet(baseline,changed));
  }
  for(const alter of [s=>s.notes[0].sha256=hex('0'),s=>s.folder='Other',s=>s.generation=hex('0',32)]){
    const changed=structuredClone(baseline);alter(changed);assert.throws(()=>unchangedQuiet(baseline,changed));
  }
});
test('equal incomplete, cyclic or tombstoned snapshots never prove quiet',()=>{
  for(const alter of [s=>s.records=[],s=>s.notes=[],s=>s.notes.pop(),s=>s.notes[1].fileId=s.notes[0].fileId,
    s=>s.records.push(s.records[0]),s=>s.notes[0].suffix='Unknown.md',s=>s.records[0].heads=[],
    s=>s.records[0].versions[0].parents=[s.records[0].versions[0].id],s=>s.records[0].versions[0].deleted=true]){
    const snapshot=before();alter(snapshot);assert.throws(()=>unchangedQuiet(snapshot,structuredClone(snapshot)));
  }
});
