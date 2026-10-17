import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const moduleUrl=process.env.OBSYNC_NATIVE_READINESS_MODULE??new URL('./native-readiness.mjs',import.meta.url).href;
const {assertActiveRestart,assertPendingRestart,pendingDeadline}=await import(moduleUrl);
const expected={generationHash:'a'.repeat(64),credentialHash:'b'.repeat(64)};
const good=()=>({paired:true,phase:'active',suite:2,status:'idle',dialogCount:0,rotationPending:false,
  generationHash:expected.generationHash,credentialHash:expected.credentialHash,candidateDesktopCustodyPresent:true,nativeEncryptionAvailable:true,idleObservedAtEpochMs:Date.now()});
test('automatic idle requires unchanged enrollment and no startup prompt',()=>{
  assert.equal(assertActiveRestart(good(),expected),true);
  for(const [field,value] of Object.entries({paired:false,phase:'prepared',suite:1,status:'syncing',dialogCount:1,
    rotationPending:true,generationHash:'c'.repeat(64),credentialHash:'c'.repeat(64),candidateDesktopCustodyPresent:false,nativeEncryptionAvailable:false,idleObservedAtEpochMs:undefined})){
    assert.throws(()=>assertActiveRestart({...good(),[field]:value},expected),field);
  }
});
test('pending readiness requires exact checkpoint, enrollment, stopped engine and actual launch bound',()=>{
  const expectedPending={...expected,phase:'prepared',checkpointFingerprint:'c'.repeat(64),launchStartedAtEpochMs:1000};
  const pending={...good(),phase:'prepared',rotationPending:true,checkpointFingerprint:expectedPending.checkpointFingerprint,engineState:'STOPPED',readyObservedAtEpochMs:1500};
  assert.equal(assertPendingRestart(pending,expectedPending),true);
  assert.equal(assertPendingRestart({...pending,phase:'commit_unknown',engineState:'ABSENT'},{...expectedPending,phase:'commit_unknown'}),true);
  for(const [field,value] of Object.entries({phase:'active',paired:false,suite:1,rotationPending:false,
    engineState:'RUNNING',checkpointFingerprint:'d'.repeat(64),generationHash:'d'.repeat(64),credentialHash:'d'.repeat(64),
    candidateDesktopCustodyPresent:false,nativeEncryptionAvailable:false,readyObservedAtEpochMs:121001})){
    assert.throws(()=>assertPendingRestart({...pending,[field]:value},expectedPending),field);
  }
  assert.throws(()=>assertPendingRestart({...pending,readyObservedAtEpochMs:999},expectedPending));
  assert.throws(()=>assertPendingRestart(pending,{...expectedPending,launchStartedAtEpochMs:undefined}));
});
test('pending deadline cannot restart a new120s budget after delayed invocation',()=>{
  assert.equal(pendingDeadline(1000,120999),121000);
  assert.throws(()=>pendingDeadline(1000,121001));assert.throws(()=>pendingDeadline(1000,999));
  assert.throws(()=>pendingDeadline(NaN,1000));assert.throws(()=>pendingDeadline(true,1000));
});
test('missing actual launch receipt refuses before any owned runtime lookup',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(moduleUrl),'/unused-owned-run','/unused-source','prepared-restart',expected.generationHash,expected.credentialHash],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);const proof=JSON.parse(result.stdout.trim());
  assert.equal(proof.firstFailure,'pending startup launch receipt invalid');assert.equal(proof.failureClass,'UNCLASSIFIED');
});

test('a hung owned CDP connection cannot extend the actual launch deadline',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'obsync-pending-deadline-')));
  try{
    writeFileSync(join(dir,'native-readiness.mjs'),readFileSync(fileURLToPath(moduleUrl)));
    writeFileSync(join(dir,'desktop-guard.mjs'),`export const boundManifest=()=>({source_head:'a'.repeat(40),secrets:'/synthetic-private',run:'/synthetic-run'});export const privateRead=()=>JSON.stringify({phase:'prepared',fingerprint:'c'.repeat(64)});`);
    writeFileSync(join(dir,'cdp.mjs'),`export const connect=()=>new Promise(()=>{});export const sleep=ms=>new Promise(r=>setTimeout(r,ms));`);
    // Start the synthetic epoch at the helper's first clock read, so host child
    // startup scheduling cannot consume this test's remaining500ms. Time then
    // advances with a real monotonic clock and the hung connection remains real.
    writeFileSync(join(dir,'clock.mjs'),`let first;Date.now=()=>{const current=performance.now();first??=current;return 120500+Math.floor(current-first);};`);
    const started=Date.now(),launch=1000;
    const result=spawnSync(process.execPath,['--import',join(dir,'clock.mjs'),join(dir,'native-readiness.mjs'),'/unused','/unused','prepared-restart',expected.generationHash,expected.credentialHash,String(launch)],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);const proof=JSON.parse(result.stdout.trim());
    assert.equal(proof.firstFailure,'pending native startup deadline');assert.equal(proof.stage,'connect-owned-vault');
    assert.ok(Date.now()-started<3000,'must refuse before a CDP default deadline');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
