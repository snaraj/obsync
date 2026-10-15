import test from 'node:test';
import assert from 'node:assert/strict';
import {slotShape,validateExpectations,activeRecovery} from './recovery-guard.mjs';
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
