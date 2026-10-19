// Passive native desktop startup: no setup, pairing or Sync-now controls.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {boundManifest,privateRead} from './desktop-guard.mjs';
import {connect,sleep} from './cdp.mjs';

export function assertActiveRestart(value,expected){
  if(!/^[a-f0-9]{64}$/.test(expected.generationHash??'')||!/^[a-f0-9]{64}$/.test(expected.credentialHash??'')||
    value?.paired!==true||value?.phase!=='active'||value?.suite!==2||value?.status!=='idle'||value?.dialogCount!==0||
    value?.rotationPending!==false||value?.generationHash!==expected.generationHash||value?.credentialHash!==expected.credentialHash||
    value?.candidateDesktopCustodyPresent!==true||value?.nativeEncryptionAvailable!==true||
    !Number.isFinite(value?.idleObservedAtEpochMs))throw Error('active native restart evidence incomplete');
  return true;
}
export function pendingDeadline(launch,now){
  if(!Number.isSafeInteger(launch)||launch<=0||!Number.isFinite(now)||now<launch||now>launch+120000)throw Error('pending startup launch receipt invalid');
  return launch+120000;
}
export function assertPendingRestart(value,expected){
  if(!['prepared','commit_unknown'].includes(expected.phase)||!['generationHash','credentialHash','checkpointFingerprint'].every(key=>/^[a-f0-9]{64}$/.test(expected[key]??''))||
    value?.paired!==true||value?.phase!==expected.phase||value?.suite!==2||value?.rotationPending!==true||
    value?.generationHash!==expected.generationHash||value?.credentialHash!==expected.credentialHash||
    value?.checkpointFingerprint!==expected.checkpointFingerprint||!['ABSENT','STOPPED'].includes(value?.engineState)||
    value?.candidateDesktopCustodyPresent!==true||value?.nativeEncryptionAvailable!==true||
    !Number.isSafeInteger(value?.readyObservedAtEpochMs)||value.readyObservedAtEpochMs>pendingDeadline(expected.launchStartedAtEpochMs,value.readyObservedAtEpochMs))throw Error('pending native restart evidence incomplete');
  return true;
}
async function main(){
  const [run,source,label,generationHash,credentialHash,launchArg,...extra]=process.argv.slice(2);let c,state,deadlineTimer,stage='arguments';
  const fail=error=>{const known=new Set(['finite startup label','hashed enrollment expectations','pending startup launch receipt invalid','pending checkpoint witness invalid','active native restart evidence incomplete','pending native restart evidence incomplete','pending native startup deadline','automatic native idle deadline']);console.log(JSON.stringify({result:'FAIL',sourceHead:state?.source_head,stage,firstFailure:known.has(error.message)?error.message:'owned passive startup read refused',failureClass:'UNCLASSIFIED',detail:'Passive owned startup or unchanged enrollment evidence refused.'}));process.exitCode=1;};
  try{
    if(!['active-restart','prepared-restart','commit-unknown-restart'].includes(label)||extra.length)throw Error('finite startup label');
    const expected={generationHash,credentialHash};
    if(!/^[a-f0-9]{64}$/.test(generationHash??'')||!/^[a-f0-9]{64}$/.test(credentialHash??''))throw Error('hashed enrollment expectations');
    const pending=label!=='active-restart',start=Date.now();let end=start+90000,result;
    if(pending){
      expected.phase=label==='prepared-restart'?'prepared':'commit_unknown';expected.launchStartedAtEpochMs=Number(launchArg);
      end=Math.min(end,pendingDeadline(expected.launchStartedAtEpochMs,start));
      // A stuck CDP connection/read must not extend the original launch budget.
      deadlineTimer=setTimeout(()=>{fail(Error('pending native startup deadline'));process.exit(1);},Math.max(0,end-Date.now()));
      stage='owned-pending-checkpoint';state=boundManifest(run,source);
      const checkpoint=JSON.parse(privateRead(join(state.secrets,`phone-transition-${expected.phase}-checkpoint.json`)));
      if(checkpoint.phase!==expected.phase||!/^[a-f0-9]{64}$/.test(checkpoint.fingerprint??''))throw Error('pending checkpoint witness invalid');
      expected.checkpointFingerprint=checkpoint.fingerprint;
    }else if(launchArg!==undefined)throw Error('finite startup label');
    while(Date.now()<end){
      stage='owned-source';
      state=boundManifest(run,source);
      try{
        stage='connect-owned-vault';
        c=await connect(state,'A');
        stage='read-passive-startup';
        const value=await c.evaluate(`const p=window.app?.plugins?.plugins?.['obsync-private-sync'];if(!p?.state||p.state.data.serverUrl!==P.url)return null;
          const pin=p.state.custody2(),s=p.currentStatus();if(!p.state.paired||pin?.suite!==2||pin.phase!==P.phase||(!P.pending&&s.kind!=='idle'))return null;
          const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
          const r=pin.rotation,checkpointFingerprint=P.pending&&r?await hash(JSON.stringify([pin.generation,p.state.data.vrk,r.intent,r.newRoot,r.fromSuite,r.prepared,r.commit])):null;
          return {paired:p.state.paired,phase:pin.phase,suite:pin.suite,status:s.kind,rotationPending:!!pin.rotation,
          dialogCount:[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(e=>!!e.getClientRects().length).length,
          generationHash:await hash(pin.generation),credentialHash:await hash(JSON.stringify([p.state.data.deviceId,p.state.data.deviceSecret])),
          candidateDesktopCustodyPresent:p.state.secrets!==app.secretStorage&&typeof p.state.secrets?.desktopCustody?.assertAvailable==='function',
          nativeEncryptionAvailable:app.secretStorage.adapter?.safeStorage?.isEncryptionAvailable()===true,
          ...(P.pending?{checkpointFingerprint,engineState:p.engine===null?'ABSENT':p.engine?.started===false?'STOPPED':p.engine?.started===true?'RUNNING':'UNKNOWN',readyObservedAtEpochMs:Date.now()}:{idleObservedAtEpochMs:Date.now()})};`,{pending,phase:pending?expected.phase:'active'});
        if(value){stage='validate-passive-readiness';(pending?assertPendingRestart:assertActiveRestart)(value,expected);result=value;break;}
      }catch(error){
        // Readiness is bounded. Once an active idle document is observed, a
        // changed credential/generation or setup prompt is a terminal failure.
        if(['active native restart evidence incomplete','pending native restart evidence incomplete','pending startup launch receipt invalid'].includes(error.message))throw error;
      }finally{c?.close();c=null;}
      await sleep(100);
    }
    if(!result)throw Error(pending?'pending native startup deadline':'automatic native idle deadline');
    const receipt={schema:1,result:'PASS',sourceHead:state.source_head,...result,passiveReadinessWaitMs:Date.now()-start,
      ...(pending?{pendingCheckpointMatches:true,launchStartedAtEpochMs:expected.launchStartedAtEpochMs,launchToReadyMs:result.readyObservedAtEpochMs-expected.launchStartedAtEpochMs}:{}),
      setupOrPairingAction:false,syncNowPressed:false,secretStoreWrites:0,physicalPhone:'NOT_RUN'};
    writeFileSync(join(state.run,'evidence','native-readiness-'+label+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify(receipt));
  }catch(error){fail(error);}
  finally{clearTimeout(deadlineTimer);c?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
